import { db, type LedgerEntry, type AuditFinding, type Account } from './db';
import { GoogleGenAI } from '@google/genai';

export async function parseLedgerData(
  companyId: number,
  period: string,
  source: 'balancete' | 'razao',
  rawData: any[]
): Promise<LedgerEntry[]> {
  const entries: LedgerEntry[] = [];
  
  if (rawData.length === 0) return entries;
  
  // A simple heuristic for column mapping
  let headerRow = -1;
  for (let i = 0; i < Math.min(20, rawData.length); i++) {
    const row = rawData[i];
    const rowStr = JSON.stringify(row).toLowerCase();
    if (rowStr.includes('conta') || rowStr.includes('código') || rowStr.includes('descrição') || rowStr.includes('saldo')) {
      headerRow = i;
      break;
    }
  }

  const isObject = !Array.isArray(rawData[0]) && typeof rawData[0] === 'object';
  
  for (let i = headerRow + 1; i < rawData.length; i++) {
    const row = rawData[i];
    let accountCode = '';
    let accountDescription = '';
    let previousBalance = 0;
    let debit = 0;
    let credit = 0;
    let currentBalance = 0;
    let date = '';
    let history = '';

    if (isObject) {
       // Try matching keys
       const keys = Object.keys(row);
       for (const key of keys) {
         const k = key.toLowerCase();
         const val = row[key];
         if (k.includes('conta') || k.includes('cód')) accountCode = String(val);
         else if (k.includes('desc') || k.includes('nome')) accountDescription = String(val);
         else if (k.includes('anterior') || k.includes('inicial')) previousBalance = parseAmount(val);
         else if (k.includes('débito') || k.includes('debito') || (k === 'd' || k === 'deb')) debit = parseAmount(val);
         else if (k.includes('crédito') || k.includes('credito') || (k === 'c' || k === 'cred')) credit = parseAmount(val);
         else if (k.includes('atual') || k.includes('final')) currentBalance = parseAmount(val);
         else if (k.includes('data')) date = String(val);
         else if (k.includes('histórico') || k.includes('historico')) history = String(val);
       }
    } else if (Array.isArray(row)) {
       // Fallback positional
       // Typical Balancete: Code | Desc | Prev | Debit | Credit | Current
       // Typical Razão: Date | Code | Desc | History | Debit | Credit | Balance
       if (source === 'balancete') {
         accountCode = String(row[0] || '');
         accountDescription = String(row[1] || '');
         previousBalance = parseAmount(row[2]);
         debit = parseAmount(row[3]);
         credit = parseAmount(row[4]);
         currentBalance = parseAmount(row[5]);
       } else {
         date = String(row[0] || '');
         accountCode = String(row[1] || '');
         accountDescription = String(row[2] || '');
         history = String(row[3] || '');
         debit = parseAmount(row[4]);
         credit = parseAmount(row[5]);
         currentBalance = parseAmount(row[6]);
       }
    }
    
    // Clean and validate
    if (accountCode && accountCode.trim().length > 0) {
      entries.push({
        companyId,
        period,
        source,
        accountCode: accountCode.trim(),
        accountDescription: accountDescription.trim(),
        previousBalance,
        debit,
        credit,
        currentBalance,
        date: date.trim(),
        history: history.trim()
      });
    }
  }

  return entries;
}

function parseAmount(val: any): number {
  if (!val) return 0;
  if (typeof val === 'number') return val;
  const str = String(val).replace(/[^0-9,-]/g, '').replace(',', '.');
  const num = parseFloat(str);
  return isNaN(num) ? 0 : num;
}

const extractKeys = (history: string) => {
  const keys: string[] = [];
  if (!history) return keys;
  
  // NF
  const nfMatch = history.match(/(?:NF|NOTA FISCAL)[-\s]*(\d+)/i);
  if (nfMatch) keys.push(`NF-${nfMatch[1]}`);
  
  // Sequence of numbers > 5 digits
  const numMatch = history.match(/\b\d{5,}\b/g);
  if (numMatch) keys.push(...numMatch);
  
  // Uppercase sequences (names)
  const nameMatch = history.match(/\b[A-Z]{3,}(?:\s+[A-Z]{3,})*\b/g);
  if (nameMatch) {
    keys.push(...nameMatch.filter(n => n.length > 5));
  }
  
  return keys;
};

export async function runDeterministicAudit(companyId: number, period: string): Promise<{ findings: AuditFinding[], unmatchedPool: any }> {
  const findings: AuditFinding[] = [];
  
  // Load data
  const accounts = await db.accounts.where('companyId').equals(companyId).toArray();
  const physicalAccounts = accounts.filter(a => a.isPhysicalAccount);
  
  const entries = await db.ledgerEntries
    .where('companyId').equals(companyId)
    .and(e => e.period === period)
    .toArray();
    
  const razaoEntries = entries.filter(e => e.source === 'razao');
  
  // 1 & 2. Reconstruct daily balance & Check negative intra-month
  for (const acc of physicalAccounts) {
    const accEntries = razaoEntries
      .filter(e => e.accountCode === acc.code)
      .sort((a, b) => (a.date || '').localeCompare(b.date || ''));
      
    if (accEntries.length === 0) continue;
    
    let runningBalance = accEntries[0].previousBalance || 0;
    let lowestBalance = runningBalance;
    let lowestDate = '';
    
    for (const entry of accEntries) {
      runningBalance += (entry.debit - entry.credit);
      if (runningBalance < lowestBalance) {
        lowestBalance = runningBalance;
        lowestDate = entry.date || '';
      }
    }
    
    if (lowestBalance < 0) {
      findings.push({
        companyId,
        period,
        severity: 'critical',
        category: 'Saldo Negativo em Conta Física',
        accountsInvolved: [acc.code],
        description: `A conta ${acc.code} (${acc.description}) ficou com saldo negativo de R$ ${lowestBalance.toFixed(2)} na data ${lowestDate}. Contas físicas não podem negativar.`,
        resolved: false
      });
    }
    
    // 3. Block entry detection (Cross-reference single large entry with sum of related opposite entries)
    if (accEntries.length > 1) {
       const debits = accEntries.filter(e => e.debit > 0);
       const credits = accEntries.filter(e => e.credit > 0);
       
       const checkBlock = (singles: LedgerEntry[], multiples: LedgerEntry[], isDebitSingle: boolean) => {
           if (singles.length === 1 && multiples.length > 1) {
               const single = singles[0];
               const singleAmount = isDebitSingle ? single.debit : single.credit;
               const sumOpposite = multiples.reduce((sum, e) => sum + (isDebitSingle ? e.credit : e.debit), 0);
               
               if (sumOpposite > 0 && Math.abs(singleAmount - sumOpposite) / sumOpposite <= 0.02) {
                   // Related accounts check
                   const relatedEntries = razaoEntries.filter(e => e.accountCode.startsWith('1.1') && e.accountCode !== acc.code);
                   const sumRelated = relatedEntries.reduce((sum, e) => sum + (isDebitSingle ? e.credit : e.debit), 0);
                   
                   // Se bate internamente ou com conta relacionada
                   if (Math.abs(singleAmount - sumRelated) / sumRelated <= 0.02 || true) { // Always flag internal imbalance blocks
                       findings.push({
                         companyId,
                         period,
                         severity: 'moderate',
                         category: 'Lançamento em Bloco Retroativo',
                         accountsInvolved: [acc.code],
                         description: `Identificado um único lançamento consolidado grande no mês para a conta ${acc.code} (${acc.description}) que bate com a soma de dezenas de contrapartidas. Valor: R$ ${singleAmount.toFixed(2)}.`,
                         historyExtract: single.history,
                         relatedEntryIds: [single.id as number, ...multiples.map(e => e.id as number)],
                         resolved: false
                       });
                   }
               }
           }
       };
       checkBlock(debits, credits, true);
       checkBlock(credits, debits, false);
    }
  }

  // Chain categorization
  const receitaCodes = new Set(accounts.filter(a => a.classification.startsWith('3.')).map(a => a.code));
  const clienteCodes = new Set(accounts.filter(a => a.description.toLowerCase().includes('cliente') && a.classification.startsWith('1.')).map(a => a.code));
  const caixaCodes = new Set(accounts.filter(a => a.description.toLowerCase().includes('caixa') && a.classification.startsWith('1.1.')).map(a => a.code));
  const bancoCodes = new Set(accounts.filter(a => a.description.toLowerCase().includes('banco') && a.classification.startsWith('1.1.')).map(a => a.code));
  
  const entriesReceita = razaoEntries.filter(e => receitaCodes.has(e.accountCode));
  const entriesCliente = razaoEntries.filter(e => clienteCodes.has(e.accountCode));
  const entriesCaixa = razaoEntries.filter(e => caixaCodes.has(e.accountCode));
  const entriesBanco = razaoEntries.filter(e => bancoCodes.has(e.accountCode));

  const matchEntries = (
    sources: LedgerEntry[], 
    targets: LedgerEntry[], 
    allEntries: LedgerEntry[], 
    expectedTargetCodes: Set<string>,
    sourceName: string,
    targetName: string
  ) => {
    const matchedSourceIds = new Set<number>();
    const matchedTargetIds = new Set<number>();
    
    for (const source of sources) {
      if (!source.id) continue;
      const keys = extractKeys(source.history || '');
      
      // 1. Try to find in expected targets
      const targetMatch = targets.find(t => {
        if (!t.id || matchedTargetIds.has(t.id)) return false;
        if (Math.abs((source.credit || source.debit) - (t.debit || t.credit)) > 0.01) return false;
        
        const tKeys = extractKeys(t.history || '');
        if (keys.length > 0 && keys.some(k => tKeys.includes(k))) return true;
        
        if (source.date && t.date) {
           const ds = new Date(source.date).getTime();
           const dt = new Date(t.date).getTime();
           if (Math.abs(ds - dt) <= 5 * 24 * 3600 * 1000) return true;
        }
        return false;
      });
      
      if (targetMatch) {
        matchedSourceIds.add(source.id);
        matchedTargetIds.add(targetMatch.id as number);
        continue;
      }
      
      // 2. Try to find in WRONG targets
      const wrongMatch = allEntries.find(t => {
        if (!t.id || matchedTargetIds.has(t.id) || t.accountCode === source.accountCode) return false;
        if (expectedTargetCodes.has(t.accountCode)) return false;
        
        if (Math.abs((source.credit || source.debit) - (t.debit || t.credit)) > 0.01) return false;
        
        const tKeys = extractKeys(t.history || '');
        if (keys.length > 0 && keys.some(k => tKeys.includes(k))) return true;
        
        if (source.date && t.date && source.date === t.date) return true;
        
        return false;
      });
      
      if (wrongMatch) {
        matchedSourceIds.add(source.id);
        matchedTargetIds.add(wrongMatch.id as number);
        findings.push({
           companyId: source.companyId,
           period: source.period,
           severity: 'moderate',
           category: 'Lançamento em Conta Errada',
           accountsInvolved: [source.accountCode, wrongMatch.accountCode],
           description: `Lançamento originado em ${sourceName} possui contrapartida registrada na conta incorreta ${wrongMatch.accountCode} (${wrongMatch.accountDescription}). Esperado: grupo ${targetName}.`,
           historyExtract: `Origem: ${source.history}\nDestino Encontrado: ${wrongMatch.history}`,
           relatedEntryIds: [source.id, wrongMatch.id as number],
           resolved: false
        });
      }
    }
    
    return { 
      matchedTargetIds,
      unmatchedSources: sources.filter(s => s.id && !matchedSourceIds.has(s.id)),
      unmatchedTargets: targets.filter(t => t.id && !matchedTargetIds.has(t.id))
    };
  };

  const expectedClienteCodes = clienteCodes;
  const expectedCaixaBancoCodes = new Set([...caixaCodes, ...bancoCodes]);
  const expectedBancoCodes = bancoCodes;

  const res1 = matchEntries(entriesReceita.filter(e => e.credit > 0), entriesCliente.filter(e => e.debit > 0), razaoEntries.filter(e => e.debit > 0), expectedClienteCodes, 'Receita', 'Clientes a Receber');
  const res2 = matchEntries(entriesCliente.filter(e => e.credit > 0), [...entriesCaixa.filter(e => e.debit > 0), ...entriesBanco.filter(e => e.debit > 0)], razaoEntries.filter(e => e.debit > 0), expectedCaixaBancoCodes, 'Clientes a Receber', 'Caixa ou Banco');
  const res3 = matchEntries(entriesCaixa.filter(e => e.credit > 0), entriesBanco.filter(e => e.debit > 0), razaoEntries.filter(e => e.debit > 0), expectedBancoCodes, 'Caixa', 'Banco');

  const unmatchedPool = {
      receitaCliente: { sources: res1.unmatchedSources, targets: res1.unmatchedTargets },
      clienteCaixaBanco: { sources: res2.unmatchedSources, targets: res2.unmatchedTargets },
      caixaBanco: { sources: res3.unmatchedSources, targets: res3.unmatchedTargets }
  };

  // 6. Pente fino Resultado x Realização Financeira
  const balanceteEntries = entries.filter(e => e.source === 'balancete');
  const totalReceita = balanceteEntries.filter(e => e.accountCode.startsWith('3.')).reduce((acc, e) => acc + e.credit - e.debit, 0);
  
  const totalCaixaBancoIn = razaoEntries
    .filter(e => e.debit > 0 && (caixaCodes.has(e.accountCode) || bancoCodes.has(e.accountCode)))
    .reduce((acc, e) => acc + e.debit, 0);
    
  if (totalReceita > 0 && totalCaixaBancoIn < totalReceita * 0.1) {
    findings.push({
      companyId,
      period,
      severity: 'observation',
      category: 'Divergência Resultado x Realização',
      accountsInvolved: [],
      description: `A receita reconhecida no período foi de R$ ${totalReceita.toFixed(2)}, mas as entradas identificadas em Caixa/Bancos somam apenas R$ ${totalCaixaBancoIn.toFixed(2)}. Verifique o regime de caixa.`,
      resolved: false
    });
  }
  
  // 7. Comparação mês a mês
  const allPeriods = Array.from(new Set(
    (await db.ledgerEntries.where('companyId').equals(companyId).toArray()).map(e => e.period)
  )).sort();
  
  const currentIdx = allPeriods.indexOf(period);
  if (currentIdx > 0) {
    const prevPeriod = allPeriods[currentIdx - 1];
    const prevBalancete = await db.ledgerEntries
      .where('companyId').equals(companyId)
      .and(e => e.period === prevPeriod && e.source === 'balancete')
      .toArray();
      
    for (const curr of balanceteEntries) {
      const prev = prevBalancete.find(p => p.accountCode === curr.accountCode);
      if (prev && prev.currentBalance > 1000) {
        const diff = Math.abs(curr.currentBalance - prev.currentBalance) / prev.currentBalance;
        if (diff > 0.5) { // Variação maior que 50%
           findings.push({
             companyId,
             period,
             severity: 'observation',
             category: 'Variação Atípica de Saldo',
             accountsInvolved: [curr.accountCode],
             description: `A conta ${curr.accountCode} (${curr.accountDescription}) variou ${(diff * 100).toFixed(0)}% em relação ao mês anterior (de R$ ${prev.currentBalance.toFixed(2)} para R$ ${curr.currentBalance.toFixed(2)}).`,
             resolved: false
           });
        }
      }
    }
  }
  
  return { findings, unmatchedPool };
}

export async function runAIAudit(
  companyId: number, 
  period: string, 
  unmatchedPool: any, 
  onProgress?: (msg: string) => void
): Promise<AuditFinding[]> {
  const apiKey = process.env.GEMINI_API_KEY;
  const aiFindings: AuditFinding[] = [];
  
  const generateMissingFinding = (source: LedgerEntry, expectedSide: string): AuditFinding => ({
     companyId,
     period,
     severity: 'moderate',
     category: 'Lançamento Faltante',
     accountsInvolved: [source.accountCode],
     description: `Lançamento de R$ ${(source.debit || source.credit).toFixed(2)} na conta ${source.accountCode} (${source.accountDescription}) não encontrou contrapartida em ${expectedSide}.`,
     historyExtract: source.history,
     relatedEntryIds: [source.id as number],
     resolved: false
  });

  if (!apiKey) {
     for (const src of unmatchedPool.receitaCliente.sources) aiFindings.push(generateMissingFinding(src, 'Clientes a Receber'));
     for (const src of unmatchedPool.clienteCaixaBanco.sources) aiFindings.push(generateMissingFinding(src, 'Caixa ou Banco'));
     for (const src of unmatchedPool.caixaBanco.sources) aiFindings.push(generateMissingFinding(src, 'Banco'));
     return aiFindings;
  }
  
  const ai = new GoogleGenAI({ apiKey });
  
  const processChain = async (chainName: string, sources: LedgerEntry[], targets: LedgerEntry[], expectedTargetName: string) => {
      if (sources.length === 0) return;
      if (targets.length === 0) {
          for (const src of sources) aiFindings.push(generateMissingFinding(src, expectedTargetName));
          return;
      }
      
      onProgress?.(`Analisando elo: ${chainName} (${sources.length} pendências)...`);
      
      const prompt = `
Você é um contador sênior brasileiro, especialista em Lucro Presumido e regras do SPED.
Temos uma lista de lançamentos de Origem (sem contrapartida) e uma lista de lançamentos de Destino Esperado (também sem contrapartida).
Tente parear os lançamentos da Origem com o Destino Esperado, mesmo que os históricos tenham palavras diferentes (ex: "venda balcão" e "depósito dinheiro"), usando seu julgamento textual, valores compatíveis e datas próximas.

Lançamentos Origem:
${JSON.stringify(sources.map(e => ({ id: e.id, data: e.date, conta: e.accountCode, historico: e.history, valor: e.debit || e.credit })), null, 2)}

Lançamentos Destino Esperado:
${JSON.stringify(targets.map(e => ({ id: e.id, data: e.date, conta: e.accountCode, historico: e.history, valor: e.debit || e.credit })), null, 2)}

Retorne um JSON com a seguinte estrutura:
{
  "matchedPairs": [
    { "entryIdA": 123, "entryIdB": 456, "confidence": "alta"|"media"|"baixa", "reasoning": "string" }
  ],
  "stillUnmatched": [
    { 
      "entryId": 123, 
      "reason": "motivo pelo qual não encontrou par",
      "suggestedAdjustment": {
        "debitAccountCode": "código da conta débito",
        "creditAccountCode": "código da conta crédito",
        "amount": 100.00,
        "history": "histórico sugerido",
        "reason": "motivo do ajuste"
      }
    }
  ]
}
Nota: "stillUnmatched" deve conter os IDs da Origem que NÃO conseguiram par.
      `;
      
      try {
          const response = await ai.models.generateContent({
             model: 'gemini-2.5-flash',
             contents: prompt,
             config: { responseMimeType: 'application/json', temperature: 0.1 }
          });
          
          if (response.text) {
             const data = JSON.parse(response.text);
             
             if (data.matchedPairs) {
                 for (const pair of data.matchedPairs) {
                     if (pair.confidence === 'baixa') {
                         const src = sources.find(s => s.id === pair.entryIdA);
                         const tgt = targets.find(t => t.id === pair.entryIdB);
                         if (src && tgt) {
                             aiFindings.push({
                                 companyId,
                                 period,
                                 severity: 'observation',
                                 category: 'Pareamento por IA de Baixa Confiança',
                                 accountsInvolved: [src.accountCode, tgt.accountCode],
                                 description: `A IA pareou estes lançamentos com baixa confiança: ${pair.reasoning}`,
                                 historyExtract: `Origem: ${src.history}\nDestino: ${tgt.history}`,
                                 relatedEntryIds: [src.id as number, tgt.id as number],
                                 resolved: false
                             });
                         }
                     }
                 }
             }
             
             if (data.stillUnmatched) {
                 for (const un of data.stillUnmatched) {
                     const src = sources.find(s => s.id === un.entryId);
                     if (src) {
                         aiFindings.push({
                             companyId,
                             period,
                             severity: 'moderate',
                             category: 'Lançamento Faltante',
                             accountsInvolved: [src.accountCode],
                             description: `Lançamento sem contrapartida. Pareamento IA falhou: ${un.reason}`,
                             historyExtract: src.history,
                             suggestedAdjustment: un.suggestedAdjustment,
                             relatedEntryIds: [src.id as number],
                             resolved: false
                         });
                     }
                 }
             }
          }
      } catch (e) {
          console.error("Erro na IA para a cadeia", chainName, e);
          for (const src of sources) aiFindings.push(generateMissingFinding(src, expectedTargetName));
      }
  };

  await processChain('Receita → Clientes', unmatchedPool.receitaCliente.sources, unmatchedPool.receitaCliente.targets, 'Clientes a Receber');
  await processChain('Clientes → Caixa/Banco', unmatchedPool.clienteCaixaBanco.sources, unmatchedPool.clienteCaixaBanco.targets, 'Caixa ou Banco');
  await processChain('Caixa → Banco', unmatchedPool.caixaBanco.sources, unmatchedPool.caixaBanco.targets, 'Banco');
  
  return aiFindings;
}

