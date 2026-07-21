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
  
  let currentContextAccountCode = '';
  let currentContextAccountDesc = '';

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
       
       // Detect Context Row (Razão exported format where account is on its own line)
       let isContextRow = false;
       for (const key of keys) {
           const val = String(row[key] || '');
           if (val.trim().toLowerCase() === 'conta:') {
               isContextRow = true;
               break;
           }
       }
       
       if (isContextRow) {
           // Extract code and desc from this row
           const vals = Object.values(row).map(v => String(v || '').trim()).filter(v => v !== '' && v.toLowerCase() !== 'conta:');
           if (vals.length >= 2) {
               currentContextAccountCode = vals[0].length < vals[1].length && vals[0].match(/[\d.]/) ? vals[1] : vals[0]; // Heuristic for code
               currentContextAccountDesc = vals.length > 1 ? vals[vals.length - 1] : '';
               
               // Better heuristic if we know typical structure
               // "5", "1.1.1.01.001", "CAIXA GERAL"
               const possibleCode = vals.find(v => v.match(/^[\d.]+$/) && v.includes('.'));
               if (possibleCode) {
                   currentContextAccountCode = possibleCode;
                   const codeIdx = vals.indexOf(possibleCode);
                   currentContextAccountDesc = vals.slice(codeIdx + 1).join(' ');
               }
           }
           continue; // Skip processing this as a transaction
       }

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
       
       // Apply context if no explicit account code found
       if (!accountCode && currentContextAccountCode && source === 'razao' && date && history) {
           accountCode = currentContextAccountCode;
           accountDescription = currentContextAccountDesc;
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
  
  const entries = await db.ledgerEntries
    .where('companyId').equals(companyId)
    .and(e => e.period === period)
    .toArray();
    
  const razaoEntries = entries.filter(e => e.source === 'razao');

  // Dynamic Account Grouping based on Classification (SPED / standard prefix logic)
  const accountGroups = new Map<string, string>();
  accounts.forEach(a => {
    const cls = a.classification;
    let group = 'Outro';
    if (cls.startsWith('1.1.1')) group = 'Ativo Financeiro';
    else if (cls.startsWith('1.1.')) group = 'Ativo Operacional';
    else if (cls.startsWith('2.1.')) group = 'Passivo Circulante';
    else if (cls.startsWith('3.1.') || (cls.startsWith('3.') && !cls.match(/^3\.[2-9]/))) group = 'Receita';
    else if (cls.startsWith('3.2.') || cls.startsWith('4.1.')) group = 'Custo';
    else if (cls.startsWith('3.') || cls.startsWith('4.')) group = 'Despesa';
    accountGroups.set(a.code, group);
  });

  const getExpectedCounterpartGroups = (group: string | undefined): string[] => {
    switch (group) {
        case 'Receita': return ['Ativo Operacional', 'Ativo Financeiro'];
        case 'Custo': 
        case 'Despesa': return ['Passivo Circulante', 'Ativo Operacional', 'Ativo Financeiro'];
        case 'Ativo Operacional': return ['Ativo Financeiro', 'Receita', 'Passivo Circulante'];
        case 'Passivo Circulante': return ['Ativo Financeiro', 'Custo', 'Despesa', 'Ativo Operacional'];
        case 'Ativo Financeiro': return ['Ativo Financeiro', 'Ativo Operacional', 'Passivo Circulante'];
        default: return [];
    }
  };
  
  // 1 & 2. Reconstruct daily balance & Check negative intra-month (For Physical Accounts)
  // 3. Block entry detection (For ALL Accounts)
  for (const acc of accounts) {
    const accEntries = razaoEntries
      .filter(e => e.accountCode === acc.code)
      .sort((a, b) => (a.date || '').localeCompare(b.date || ''));
      
    if (accEntries.length === 0) continue;
    
    if (acc.isPhysicalAccount) {
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
    }
    
    // Block entry detection (Cross-reference single entry with sum of related expected opposite entries)
    if (accEntries.length > 1) {
       const debits = accEntries.filter(e => e.debit > 0);
       const credits = accEntries.filter(e => e.credit > 0);
       
       const checkBlock = (singles: LedgerEntry[], multiples: LedgerEntry[], isDebitSingle: boolean) => {
           if (singles.length === 1 && multiples.length > 1) {
               const single = singles[0];
               const singleAmount = isDebitSingle ? single.debit : single.credit;
               
               const myGroup = accountGroups.get(acc.code);
               const relatedGroups = getExpectedCounterpartGroups(myGroup);
               
               const relatedEntries = razaoEntries.filter(e => relatedGroups.includes(accountGroups.get(e.accountCode) || ''));
               const sumRelated = relatedEntries.reduce((sum, e) => sum + (isDebitSingle ? e.credit : e.debit), 0);
               
               if (sumRelated > 0 && Math.abs(singleAmount - sumRelated) / sumRelated <= 0.02) {
                   findings.push({
                     companyId,
                     period,
                     severity: 'moderate',
                     category: 'Lançamento em Bloco Retroativo',
                     accountsInvolved: [acc.code],
                     description: `Identificado um único lançamento consolidado grande no mês para a conta ${acc.code} (${acc.description}) que bate com a soma de dezenas de contrapartidas em contas relacionadas (${relatedGroups.join(', ')}). Valor: R$ ${singleAmount.toFixed(2)}.`,
                     historyExtract: single.history,
                     relatedEntryIds: [single.id as number, ...multiples.map(e => e.id as number)],
                     resolved: false
                   });
               }
           }
       };
       checkBlock(debits, credits, true);
       checkBlock(credits, debits, false);
    }
  }

  // 4. Chain categorization and matching
  const globalMatchedIds = new Set<number>();
  
  const matchEntries = (
    sources: LedgerEntry[], 
    targets: LedgerEntry[], 
    allTargets: LedgerEntry[], 
    expectedTargetCodes: Set<string>,
    sourceName: string,
    targetName: string
  ) => {
    const matchedSourceIds = new Set<number>();
    
    for (const source of sources) {
      if (!source.id || globalMatchedIds.has(source.id)) continue;
      const keys = extractKeys(source.history || '');
      
      // 1. Try to find in expected targets
      const targetMatch = targets.find(t => {
        if (!t.id || globalMatchedIds.has(t.id)) return false;
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
        globalMatchedIds.add(source.id);
        globalMatchedIds.add(targetMatch.id as number);
        continue;
      }
      
      // 2. Try to find in WRONG targets
      const wrongMatch = allTargets.find(t => {
        if (!t.id || globalMatchedIds.has(t.id) || t.accountCode === source.accountCode) return false;
        if (expectedTargetCodes.has(t.accountCode)) return false;
        
        if (Math.abs((source.credit || source.debit) - (t.debit || t.credit)) > 0.01) return false;
        
        const tKeys = extractKeys(t.history || '');
        if (keys.length > 0 && keys.some(k => tKeys.includes(k))) return true;
        
        if (source.date && t.date && source.date === t.date) return true;
        
        return false;
      });
      
      if (wrongMatch) {
        matchedSourceIds.add(source.id);
        globalMatchedIds.add(source.id);
        globalMatchedIds.add(wrongMatch.id as number);
        findings.push({
           companyId: source.companyId,
           period: source.period,
           severity: 'moderate',
           category: 'Lançamento em Conta Errada',
           accountsInvolved: [source.accountCode, wrongMatch.accountCode],
           description: `Lançamento originado em ${sourceName} (${source.accountCode}) possui contrapartida registrada na conta incorreta ${wrongMatch.accountCode} (${wrongMatch.accountDescription}). Esperado: grupo ${targetName}.`,
           historyExtract: `Origem: ${source.history}\nDestino Encontrado: ${wrongMatch.history}`,
           relatedEntryIds: [source.id, wrongMatch.id as number],
           resolved: false
        });
      }
    }
    
    return { 
      unmatchedSources: sources.filter(s => s.id && !matchedSourceIds.has(s.id) && !globalMatchedIds.has(s.id)),
    };
  };

  const chains = [
    { name: 'Receita', sourceGroup: 'Receita', targetGroups: ['Ativo Operacional', 'Ativo Financeiro'], sourceNature: 'credit' },
    { name: 'Custo', sourceGroup: 'Custo', targetGroups: ['Passivo Circulante', 'Ativo Operacional', 'Ativo Financeiro'], sourceNature: 'debit' },
    { name: 'Despesa', sourceGroup: 'Despesa', targetGroups: ['Passivo Circulante', 'Ativo Financeiro'], sourceNature: 'debit' },
    { name: 'Ativo Operacional (Baixa)', sourceGroup: 'Ativo Operacional', targetGroups: ['Ativo Financeiro'], sourceNature: 'credit' },
    { name: 'Passivo Circulante (Pagamento)', sourceGroup: 'Passivo Circulante', targetGroups: ['Ativo Financeiro'], sourceNature: 'debit' }
  ];

  const unmatchedPool: any[] = [];

  for (const chain of chains) {
     const sourceCodes = new Set(accounts.filter(a => accountGroups.get(a.code) === chain.sourceGroup).map(a => a.code));
     const targetCodes = new Set(accounts.filter(a => chain.targetGroups.includes(accountGroups.get(a.code) || '')).map(a => a.code));
     
     const sources = razaoEntries.filter(e => sourceCodes.has(e.accountCode) && (chain.sourceNature === 'credit' ? e.credit > 0 : e.debit > 0));
     const allTargets = razaoEntries.filter(e => chain.sourceNature === 'credit' ? e.debit > 0 : e.credit > 0);
     const expectedTargets = allTargets.filter(e => targetCodes.has(e.accountCode));
     
     const res = matchEntries(
         sources,
         expectedTargets,
         allTargets,
         targetCodes,
         chain.sourceGroup,
         chain.targetGroups.join(' ou ')
     );
     
     unmatchedPool.push({
         chainName: chain.name,
         sources: res.unmatchedSources,
         targets: expectedTargets.filter(t => !globalMatchedIds.has(t.id as number)),
         expectedTargetName: chain.targetGroups.join(' ou ')
     });
  }

  // 6. Pente fino Resultado x Realização Financeira
  const balanceteEntries = entries.filter(e => e.source === 'balancete');
  const totalReceita = balanceteEntries.filter(e => accountGroups.get(e.accountCode) === 'Receita').reduce((acc, e) => acc + e.credit - e.debit, 0);
  
  const totalCaixaBancoIn = razaoEntries
    .filter(e => e.debit > 0 && accountGroups.get(e.accountCode) === 'Ativo Financeiro')
    .reduce((acc, e) => acc + e.debit, 0);
    
  if (totalReceita > 0 && totalCaixaBancoIn < totalReceita * 0.1) {
    findings.push({
      companyId,
      period,
      severity: 'observation',
      category: 'Divergência Resultado x Realização',
      accountsInvolved: [],
      description: `A receita reconhecida no período foi de R$ ${totalReceita.toFixed(2)}, mas as entradas identificadas no Ativo Financeiro (Caixa/Bancos) somam apenas R$ ${totalCaixaBancoIn.toFixed(2)}. Verifique o regime de caixa.`,
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
  unmatchedPool: any[], 
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
     for (const pool of unmatchedPool) {
       for (const src of pool.sources) aiFindings.push(generateMissingFinding(src, pool.expectedTargetName));
     }
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

  for (const pool of unmatchedPool) {
     await processChain(pool.chainName, pool.sources, pool.targets, pool.expectedTargetName);
  }
  
  return aiFindings;
}

export async function runFullAIAudit(
  companyId: number, 
  period: string, 
  onProgress?: (msg: string) => void
): Promise<AuditFinding[]> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    alert("API Key do Gemini não configurada.");
    return [];
  }
  
  const aiFindings: AuditFinding[] = [];
  const ai = new GoogleGenAI({ apiKey });
  
  const accounts = await db.accounts.where('companyId').equals(companyId).toArray();
  const entries = await db.ledgerEntries
    .where('companyId').equals(companyId)
    .and(e => e.period === period && e.source === 'razao')
    .toArray();
    
  const BATCH_SIZE = 200;
  
  for (let i = 0; i < entries.length; i += BATCH_SIZE) {
      const batch = entries.slice(i, i + BATCH_SIZE);
      onProgress?.(`Varredura Completa: Analisando lote ${Math.floor(i/BATCH_SIZE) + 1} de ${Math.ceil(entries.length/BATCH_SIZE)}...`);
      
      const prompt = `
Você é um auditor contábil experiente.
Temos o seguinte plano de contas (reduzido):
${JSON.stringify(accounts.map(a => ({ code: a.code, name: a.description, class: a.classification })), null, 2)}

E o seguinte lote de lançamentos do Razão:
${JSON.stringify(batch.map(e => ({ id: e.id, data: e.date, conta: e.accountCode, historico: e.history, debito: e.debit, credito: e.credit })), null, 2)}

Sua tarefa é fazer uma varredura completa e identificar inconsistências, tais como:
1. Lançamento em conta incompatível com o histórico descrito.
2. Ausência aparente de contrapartida lógica (considerando as informações do histórico).
3. Valor incoerente ou atípico.
4. Lançamento que deveria existir em outra conta e não existe.

Retorne um JSON com os achados:
{
  "findings": [
    {
      "severity": "critical" | "moderate" | "observation",
      "category": "Título da inconsistência",
      "accountsInvolved": ["código da conta"],
      "description": "Explicação detalhada do problema",
      "historyExtract": "Trecho do histórico",
      "entryId": 123
    }
  ]
}
      `;
      
      try {
          const response = await ai.models.generateContent({
             model: 'gemini-2.5-flash',
             contents: prompt,
             config: { responseMimeType: 'application/json', temperature: 0.1 }
          });
          
          if (response.text) {
             const data = JSON.parse(response.text);
             if (data.findings) {
                 for (const f of data.findings) {
                     const entry = batch.find(e => e.id === f.entryId);
                     aiFindings.push({
                         companyId,
                         period,
                         severity: f.severity || 'observation',
                         category: `Varredura Completa: ${f.category}`,
                         accountsInvolved: f.accountsInvolved || (entry ? [entry.accountCode] : []),
                         description: f.description,
                         historyExtract: f.historyExtract || (entry ? entry.history : undefined),
                         relatedEntryIds: entry ? [entry.id as number] : [],
                         resolved: false
                     });
                 }
             }
          }
      } catch (e) {
          console.error("Erro na IA Full Scan lote", i, e);
      }
  }
  
  return aiFindings;
}


