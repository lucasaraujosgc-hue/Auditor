import { db, type LedgerEntry, type AuditFinding, type Account } from './db';
import { GoogleGenAI, Type, Schema } from '@google/genai';

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

export async function runDeterministicAudit(companyId: number, period: string): Promise<AuditFinding[]> {
  const findings: AuditFinding[] = [];
  
  // Load data
  const accounts = await db.accounts.where('companyId').equals(companyId).toArray();
  const physicalAccounts = accounts.filter(a => a.isPhysicalAccount);
  const physicalAccountCodes = physicalAccounts.map(a => a.code);
  
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
    
    // Attempt to find initial balance from balancete or first entry
    let runningBalance = accEntries[0].previousBalance || 0;
    
    let lowestBalance = runningBalance;
    let lowestDate = '';
    
    for (const entry of accEntries) {
      // Assuming Caixa is Debit nature (Active)
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
    
    // 3. Block entry detection
    if (accEntries.length === 1 && Math.abs(accEntries[0].debit - accEntries[0].credit) > 1000) {
       findings.push({
         companyId,
         period,
         severity: 'moderate',
         category: 'Lançamento em Bloco',
         accountsInvolved: [acc.code],
         description: `Identificado um único lançamento grande no mês para a conta ${acc.code} (${acc.description}). Valor: R$ ${Math.abs(accEntries[0].debit - accEntries[0].credit).toFixed(2)}.`,
         historyExtract: accEntries[0].history,
         relatedEntryIds: [accEntries[0].id as number],
         resolved: false
       });
    }
  }

  // 4. Extração de chaves do histórico e Cruzamento (NF / Cliente)
  const extractKey = (history: string) => {
    const nfMatch = history.match(/(?:NF|NOTA FISCAL)[-\s]*(\d+)/i);
    if (nfMatch) return `NF-${nfMatch[1]}`;
    return null;
  };
  
  const receitaEntries = razaoEntries.filter(e => e.accountCode.startsWith('3.'));
  const clienteEntries = razaoEntries.filter(e => e.accountDescription.toLowerCase().includes('cliente') && e.accountCode.startsWith('1.'));
  
  for (const receita of receitaEntries) {
    if (!receita.history) continue;
    const key = extractKey(receita.history);
    if (key) {
      // Procura contrapartida em clientes
      const match = clienteEntries.find(c => 
        c.history && extractKey(c.history) === key && 
        Math.abs(c.debit - receita.credit) < 0.01 // Receita é crédito, Cliente é débito
      );
      
      if (!match) {
        findings.push({
          companyId,
          period,
          severity: 'moderate',
          category: 'Possível Lançamento Faltante ou em Conta Errada',
          accountsInvolved: [receita.accountCode],
          description: `Receita reconhecida com chave ${key}, mas não foi encontrada a contrapartida esperada em Clientes a Receber pelo mesmo valor (R$ ${receita.credit.toFixed(2)}).`,
          historyExtract: receita.history,
          resolved: false
        });
      }
    }
  }

  // 6. Pente fino Resultado x Realização Financeira
  const balanceteEntries = entries.filter(e => e.source === 'balancete');
  const totalReceita = balanceteEntries.filter(e => e.accountCode.startsWith('3.')).reduce((acc, e) => acc + e.credit - e.debit, 0);
  
  const totalCaixaBancoIn = razaoEntries
    .filter(e => {
       const desc = e.accountDescription.toLowerCase();
       return (desc.includes('caixa') || desc.includes('banco')) && e.accountCode.startsWith('1.');
    })
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
  
  // 7. Comparação mês a mês (se houver período anterior)
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
  
  return findings;
}

export async function runAIAudit(companyId: number, period: string, deterministicFindings: AuditFinding[]): Promise<AuditFinding[]> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return [];
  
  const ai = new GoogleGenAI({ apiKey });
  
  const entries = await db.ledgerEntries
    .where('companyId').equals(companyId)
    .and(e => e.period === period && e.source === 'razao')
    .toArray();
    
  if (entries.length === 0) return [];
  
  // Only send a subset (e.g. large entries or entries lacking match) to avoid token limit
  const subset = entries.filter(e => e.debit > 1000 || e.credit > 1000).slice(0, 50); 
  
  if (subset.length === 0) return [];
  
  const prompt = `
Você é um contador sênior brasileiro, especialista em Lucro Presumido e regras do SPED.
Analise os seguintes lançamentos contábeis extraídos do Razão. Identifique possíveis anomalias,
falta de contrapartidas lógicas, ou erros de classificação com base no histórico.

Lançamentos:
${JSON.stringify(subset.map(e => ({ id: e.id, data: e.date, conta: e.accountCode, historico: e.history, debito: e.debit, credito: e.credit })), null, 2)}

Retorne um JSON com os achados (findings). Estrutura:
{
  "findings": [
    {
      "severity": "critical" | "moderate" | "observation",
      "category": "string",
      "accountsInvolved": ["string"],
      "description": "string justificando o problema",
      "historyExtract": "trecho relevante",
      "suggestedAdjustment": {
        "debitAccountCode": "string",
        "creditAccountCode": "string",
        "amount": 0,
        "history": "string",
        "reason": "string"
      }
    }
  ]
}
  `;

  try {
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
        temperature: 0.2
      }
    });

    if (response.text) {
      const data = JSON.parse(response.text);
      if (data.findings && Array.isArray(data.findings)) {
         return data.findings.map((f: any) => ({
           companyId,
           period,
           severity: f.severity,
           category: f.category,
           accountsInvolved: f.accountsInvolved || [],
           description: f.description,
           historyExtract: f.historyExtract,
           suggestedAdjustment: f.suggestedAdjustment,
           resolved: false
         }));
      }
    }
  } catch (e) {
    console.error("AI Audit error", e);
  }
  
  return [];
}
