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
    if (rowStr.includes('conta') || rowStr.includes('código') || rowStr.includes('descrição') || rowStr.includes('saldo') || (rowStr.includes('debitar') && rowStr.includes('creditar'))) {
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
    let contrapartida = '';

    if (isObject) {
       // Try matching keys
       const keys = Object.keys(row);
       
       let isDoubleEntryRow = false;
       for (const key of keys) {
           const k = key.toLowerCase();
           if (k === 'debitar' || k === 'creditar') {
               isDoubleEntryRow = true;
               break;
           }
       }

       if (isDoubleEntryRow) {
           let debitarCode = '';
           let creditarCode = '';
           let valAmount = 0;
           
           for (const key of keys) {
               const k = key.toLowerCase();
               const val = row[key];
               if (k === 'debitar') debitarCode = String(val);
               else if (k === 'creditar') creditarCode = String(val);
               else if (k === 'valor') valAmount = parseAmount(val);
               else if (k === 'histórico' || k === 'historico') history = String(val);
               else if (k === 'data') date = parseDate(val);
           }

           if (debitarCode && debitarCode.trim()) {
               entries.push({
                   companyId, period, source,
                   accountCode: debitarCode.trim(), accountDescription: '',
                   previousBalance: 0, debit: valAmount, credit: 0, currentBalance: 0,
                   date: date.trim(), history: history.trim(),
                   contrapartidaAccountCode: creditarCode.trim()
               });
           }
           if (creditarCode && creditarCode.trim()) {
               entries.push({
                   companyId, period, source,
                   accountCode: creditarCode.trim(), accountDescription: '',
                   previousBalance: 0, debit: 0, credit: valAmount, currentBalance: 0,
                   date: date.trim(), history: history.trim(),
                   contrapartidaAccountCode: debitarCode.trim()
               });
           }
           continue; // Skip the rest for this row
       }

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
         else if (k.includes('data')) date = parseDate(val);
         else if (k.includes('histórico') || k.includes('historico')) history = String(val);
         else if (k.includes('cta.c.part') || k.includes('contra')) contrapartida = String(val);
       }
       
       // Apply context if no explicit account code found
       if (!accountCode && currentContextAccountCode && source === 'razao' && date && history) {
           accountCode = currentContextAccountCode;
           accountDescription = currentContextAccountDesc;
       }
       
    } else if (Array.isArray(row)) {
       // Fallback positional
       if (source === 'balancete') {
         const cleanRow = row.map((v: any) => String(v ?? '').trim()).filter((v: string) => v !== '');

         const CODE_RE = /^\d+$/;
         const CLASS_RE = /^\d+(\.\d+)*$/;
         const MONEY_RE = /^-?\d{1,3}(\.\d{3})*,\d{2}[DC]?$/i;

         // Linhas de recapitulação ("TOTAL ATIVO", "TOTAL PASSIVO...") ficam em
         // uma linha própria, geralmente logo ABAIXO da linha de dados que elas
         // rotulam (que repete o código de uma conta sintética já lançada antes
         // — ex: "1" para ATIVO). Detectamos olhando a linha seguinte.
         const nextRawClean = Array.isArray(rawData[i + 1])
           ? (rawData[i + 1] as any[]).map((v: any) => String(v ?? '').trim()).filter((v: string) => v !== '')
           : [];
         const isFollowedByTotalLabel = nextRawClean.length > 0 &&
           nextRawClean.every((v: string) => v.toUpperCase() === 'TOTAL' || v.toUpperCase().startsWith('TOTAL '));
         const isTotalRecapRow = isFollowedByTotalLabel ||
           cleanRow.some((v: string) => v.toUpperCase() === 'TOTAL' || v.toUpperCase().startsWith('TOTAL '));

         // Detecção por conteúdo: Código (inteiro) + Classificação (numérica/hierárquica)
         // seguidos de até 4 valores monetários — em vez de confiar em posição fixa.
         // Necessário porque alguns geradores de balancete em PDF não desenham as
         // colunas na ordem visual da esquerda para a direita, e a descrição da
         // conta costuma aparecer numa linha própria, separada da linha de dados.
         if (!isTotalRecapRow && cleanRow.length >= 2 && CODE_RE.test(cleanRow[0]) && CLASS_RE.test(cleanRow[1])) {
           const rest = cleanRow.slice(2);
           const moneyTokens = rest.filter((v: string) => MONEY_RE.test(v));
           const textTokens = rest.filter((v: string) => !MONEY_RE.test(v));

           let description = textTokens.join(' ').trim();
           if (!description) {
             // A descrição normalmente vem na linha seguinte (rótulo isolado,
             // sem código/classificação e sem valores monetários).
             const nextIsAnotherDataRow = nextRawClean.length >= 2 && CODE_RE.test(nextRawClean[0]) && CLASS_RE.test(nextRawClean[1]);
             const nextHasMoney = nextRawClean.some((v: string) => MONEY_RE.test(v));
             if (nextRawClean.length > 0 && !nextIsAnotherDataRow && !nextHasMoney) {
               description = nextRawClean.join(' ').trim();
             }
           }

           accountCode = cleanRow[0];
           accountDescription = description;
           previousBalance = parseAmount(moneyTokens[0]);
           debit = parseAmount(moneyTokens[1]);
           credit = parseAmount(moneyTokens[2]);
           currentBalance = parseAmount(moneyTokens[3]);
         } else if (!isTotalRecapRow) {
           // Formato antigo (posicional), mantido para planilhas/CSVs onde as
           // colunas já vêm na ordem correta.
           if (row.length >= 7 && String(row[3]).match(/[\d.,]+[DC]?/i)) {
               // Formato: Código | Classificação | Descrição | Saldo Ant | Débito | Crédito | Saldo Atual
               accountCode = String(row[0] || '').trim();
               accountDescription = String(row[2] || '').trim();
               previousBalance = parseAmount(row[3]);
               debit = parseAmount(row[4]);
               credit = parseAmount(row[5]);
               currentBalance = parseAmount(row[6]);
           } else {
               accountCode = String(row[0] || '');
               accountDescription = String(row[1] || '');
               previousBalance = parseAmount(row[2]);
               debit = parseAmount(row[3]);
               credit = parseAmount(row[4]);
               currentBalance = parseAmount(row[5]);
           }
         }

         // Linhas só de texto (rótulos de grupo como "ATIVO", "CAIXA", que aparecem
         // soltas em sua própria linha) não têm um código de conta numérico de
         // verdade — sem essa validação, o rótulo inteiro vira "accountCode" por
         // engano e gera contas fantasmas. Código de balancete é sempre numérico.
         // Exige também pelo menos 2 tokens (evita capturar números soltos do
         // cabeçalho repetido em cada página, como o CNPJ "0001").
         if (!CODE_RE.test(accountCode) || cleanRow.length < 2) {
           accountCode = '';
         }
       } else {
         // Razão
         // PDF structure: Data | Histórico | Cta.C.Part | Débito | Crédito | Saldo
         if (row.length >= 6) {
             date = parseDate(row[0] || '');
             history = String(row[1] || '');
             contrapartida = String(row[2] || '');
             debit = parseAmount(row[3]);
             credit = parseAmount(row[4]);
             currentBalance = parseAmount(row[5]);
             accountCode = currentContextAccountCode;
             accountDescription = currentContextAccountDesc;
         } else {
             date = parseDate(row[0] || '');
             accountCode = String(row[1] || '');
             accountDescription = String(row[2] || '');
             history = String(row[3] || '');
             debit = parseAmount(row[4]);
             credit = parseAmount(row[5]);
             currentBalance = parseAmount(row[6]);
         }
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
        history: history.trim(),
        contrapartidaAccountCode: contrapartida.trim()
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

export function parseDate(val: any): string {
  if (!val) return '';
  const str = String(val).trim();
  
  // Excel serial date (e.g., 45688)
  if (/^\d{5}$/.test(str)) {
    const excelEpoch = new Date(1899, 11, 30); // December 30, 1899
    const parsedDate = new Date(excelEpoch.getTime() + parseInt(str, 10) * 86400000);
    const dd = String(parsedDate.getDate()).padStart(2, '0');
    const mm = String(parsedDate.getMonth() + 1).padStart(2, '0');
    const yyyy = parsedDate.getFullYear();
    return `${dd}/${mm}/${yyyy}`;
  }
  
  // ISO Date (YYYY-MM-DD) or already formatted DD/MM/YYYY
  return str;
}

// =============================================================================
// Agrupamento de contas (compartilhado entre runDeterministicAudit e runBalanceteAudit)
// =============================================================================

/**
 * Deriva o "grupo contábil" de uma conta a partir da sua classificação (prefixo
 * do plano de contas, padrão SPED) e, quando necessário, de sua descrição —
 * usado para identificar Provisões, que podem estar em qualquer subnível do
 * Passivo e não seguem um prefixo padronizado de forma confiável.
 */
export function getAccountGroup(classification: string, description?: string): string {
  const cls = (classification || '').trim();
  const desc = (description || '').toLowerCase();

  // Provisões (férias, 13º, contingências) — identificadas pelo nome primeiro,
  // pois o prefixo de classificação varia muito entre planos de contas.
  if (cls.startsWith('2.') && /provis/.test(desc)) return 'Provisão';

  if (cls.startsWith('1.1.1')) return 'Ativo Financeiro';
  if (cls.startsWith('1.1.')) return 'Ativo Operacional';
  if (cls.startsWith('1.')) return 'Ativo Não Circulante';

  if (cls.startsWith('2.1.')) return 'Passivo Circulante';
  if (cls.startsWith('2.3.') || cls.startsWith('2.9.')) return 'Patrimônio Líquido';
  if (cls.startsWith('2.')) return 'Passivo Não Circulante';

  if (cls.startsWith('3.1.') || (cls.startsWith('3.') && !cls.match(/^3\.[2-9]/))) return 'Receita';
  if (cls.startsWith('3.2.') || cls.startsWith('4.1.')) return 'Custo';
  if (cls.startsWith('3.') || cls.startsWith('4.')) return 'Despesa';

  return 'Outro';
}

/** Grupos cuja natureza contábil normal é devedora. */
export const DEBTOR_NATURE_GROUPS = new Set([
  'Ativo Financeiro', 'Ativo Operacional', 'Ativo Não Circulante', 'Custo', 'Despesa'
]);

/** Grupos cuja natureza contábil normal é credora. */
export const CREDITOR_NATURE_GROUPS = new Set([
  'Passivo Circulante', 'Passivo Não Circulante', 'Patrimônio Líquido', 'Receita', 'Provisão'
]);

/**
 * Calcula o "saldo com sinal de natureza" de um lançamento de balancete: um
 * valor positivo indica que a conta está no lado esperado (devedora ou
 * credora, conforme seu grupo contábil); um valor negativo indica inversão de
 * saldo. Contas redutoras (ex: Depreciação Acumulada, que reside no Ativo mas
 * tem natureza credora) devem ser calculadas com `forceCreditorNature = true`.
 */
export function computeNaturalBalance(
  entry: Pick<LedgerEntry, 'previousBalance' | 'debit' | 'credit'>,
  group: string,
  forceCreditorNature = false
): number {
  const isDebtor = !forceCreditorNature && DEBTOR_NATURE_GROUPS.has(group);
  return isDebtor
    ? entry.previousBalance + entry.debit - entry.credit
    : entry.previousBalance + entry.credit - entry.debit;
}

/** Distância de Levenshtein simples — usada para detectar contas com nomes quase idênticos. */
function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[m][n];
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
    accountGroups.set(a.code, getAccountGroup(a.classification, a.description));
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
  
  // Mapa auxiliar para saber se um código de lançamento pertence a uma conta
  // sintética (agrupadora) — usado para excluir sintéticas da análise de
  // "lançamentos errados", já que elas não deveriam receber lançamento
  // próprio e a IA não deve tentar caçar contrapartida para elas.
  const accountTypeByCode = new Map(accounts.map(a => [a.code, a.type]));
  const isAnalyticCode = (code: string) => accountTypeByCode.get(code) !== 'S';

  // 1 & 2. Reconstruct daily balance & Check negative intra-month (For Physical Accounts)
  // 3. Block entry detection (For ANALYTIC Accounts only — sintéticas não recebem lançamento próprio)
  for (const acc of accounts.filter(a => a.type !== 'S')) {
    const accEntries = razaoEntries
      .filter(e => e.accountCode === acc.code)
      .sort((a, b) => (a.date || '').localeCompare(b.date || ''));
      
    if (accEntries.length === 0) continue;
    
    if (acc.isPhysicalAccount || accountGroups.get(acc.code) === 'Ativo Financeiro') {
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
          category: 'Saldo Negativo em Caixa/Bancos',
          accountsInvolved: [acc.code],
          description: `A conta ${acc.code} (${acc.description}) ficou com saldo negativo de R$ ${lowestBalance.toFixed(2)} na data ${lowestDate}. Contas de disponibilidades (caixa/bancos) não devem ficar credoras.`,
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
               
               const relatedEntries = razaoEntries.filter(e =>
                 relatedGroups.includes(accountGroups.get(e.accountCode) || '') && isAnalyticCode(e.accountCode)
               );
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
      
      // 0. Try direct match via contrapartidaAccountCode
      if (source.contrapartidaAccountCode && source.contrapartidaAccountCode !== '0') {
        const directMatch = allTargets.find(t =>
          !globalMatchedIds.has(t.id as number) &&
          t.accountCode === source.contrapartidaAccountCode &&
          Math.abs((source.credit || source.debit) - (t.debit || t.credit)) <= 0.01 &&
          (!source.date || !t.date || source.date === t.date)
        );
        if (directMatch) {
            matchedSourceIds.add(source.id);
            globalMatchedIds.add(source.id);
            globalMatchedIds.add(directMatch.id as number);
            
            // Validate if contrapartida is the expected one
            if (!expectedTargetCodes.has(directMatch.accountCode)) {
                findings.push({
                   companyId: source.companyId,
                   period: source.period,
                   severity: 'moderate',
                   category: 'Lançamento em Conta Errada',
                   accountsInvolved: [source.accountCode, directMatch.accountCode],
                   description: `Lançamento originado em ${sourceName} (${source.accountCode}) aponta para contrapartida ${directMatch.accountCode} (${directMatch.accountDescription}). Esperado: grupo ${targetName}.`,
                   historyExtract: `Origem: ${source.history}\nDestino Encontrado: ${directMatch.history}`,
                   relatedEntryIds: [source.id, directMatch.id as number],
                   resolved: false
                });
            }
            continue;
        }
      }

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
     const sourceCodes = new Set(accounts.filter(a => a.type !== 'S' && accountGroups.get(a.code) === chain.sourceGroup).map(a => a.code));
     const targetCodes = new Set(accounts.filter(a => a.type !== 'S' && chain.targetGroups.includes(accountGroups.get(a.code) || '')).map(a => a.code));
     
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
  
  // Inverted Balances Check (Analytical)
  for (const entry of balanceteEntries) {
     const group = accountGroups.get(entry.accountCode) || 'Outro';
     if (group === 'Outro') continue;
     
     const naturalBalance = computeNaturalBalance(entry, group);
     if (naturalBalance < -0.01) {
         findings.push({
             companyId,
             period,
             severity: group === 'Ativo Financeiro' ? 'critical' : 'moderate',
             category: 'Saldo Invertido no Balancete',
             accountsInvolved: [entry.accountCode],
             description: `A conta ${entry.accountCode} (${entry.accountDescription}) encerrou o período com saldo invertido (contra a sua natureza contábil do grupo ${group}). Verifique lançamentos que negativaram a conta.`,
             resolved: false
         });
     }
  }

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
  
  // 8. Batimento Balancete x Razão (pega erro de importação/parsing antes de
  // qualquer heurística cara — só é possível aqui, pois é o único motor que
  // carrega as duas fontes ao mesmo tempo).
  const razaoTotalsByAccount = new Map<string, { debit: number; credit: number }>();
  for (const e of razaoEntries) {
    const t = razaoTotalsByAccount.get(e.accountCode) || { debit: 0, credit: 0 };
    t.debit += e.debit;
    t.credit += e.credit;
    razaoTotalsByAccount.set(e.accountCode, t);
  }
  const BATIMENTO_TOLERANCE = 0.05;
  for (const be of balanceteEntries) {
    const razaoTotals = razaoTotalsByAccount.get(be.accountCode);
    if (!razaoTotals) continue; // conta sem lançamentos no razão neste período — nada a bater aqui
    const diffDebit = Math.abs(razaoTotals.debit - be.debit);
    const diffCredit = Math.abs(razaoTotals.credit - be.credit);
    if (diffDebit > BATIMENTO_TOLERANCE || diffCredit > BATIMENTO_TOLERANCE) {
      findings.push({
        companyId,
        period,
        severity: 'critical',
        category: 'Divergência Balancete x Razão',
        accountsInvolved: [be.accountCode],
        description: `A conta ${be.accountCode} (${be.accountDescription}) tem no Balancete D=R$ ${be.debit.toFixed(2)} / C=R$ ${be.credit.toFixed(2)}, mas a soma dos lançamentos do Razão para o período é D=R$ ${razaoTotals.debit.toFixed(2)} / C=R$ ${razaoTotals.credit.toFixed(2)}. Possível erro de importação ou de parsing de um dos dois arquivos.`,
        resolved: false
      });
    }
  }

  return { findings, unmatchedPool };
}

// =============================================================================
// Auditoria de Balancete (independente, sem IA, sem depender do Razão)
// =============================================================================
//
// Roda inteiramente em cima de ledgerEntries.source === 'balancete'. É rápida
// e gratuita (nenhuma chamada de IA), então pode ser executada sempre que um
// balancete for importado — mesmo que o usuário ainda não tenha subido o Razão.
//
export async function runBalanceteAudit(companyId: number, period: string): Promise<AuditFinding[]> {
  const findings: AuditFinding[] = [];
  const TOL = 0.05; // tolerância de centavos para arredondamento

  const accounts = await db.accounts.where('companyId').equals(companyId).toArray();
  const accountByCode = new Map(accounts.map(a => [a.code, a]));

  const balancete = await db.ledgerEntries
    .where('companyId').equals(companyId)
    .and(e => e.period === period && e.source === 'balancete')
    .toArray();

  if (balancete.length === 0) return findings;

  const groupOf = (code: string): string => {
    const acc = accountByCode.get(code);
    return getAccountGroup(acc?.classification || '', acc?.description);
  };

  const isDepreciacaoAcumulada = (desc: string) => /deprecia[cç][aã]o.*acumul|acumul.*deprecia/i.test(desc);

  const naturalOf = (e: LedgerEntry): number => {
    const group = groupOf(e.accountCode);
    const forceCred = isDepreciacaoAcumulada(e.accountDescription || '');
    return computeNaturalBalance(e, group, forceCred);
  };

  const push = (finding: Omit<AuditFinding, 'companyId' | 'period' | 'resolved'>) => {
    findings.push({ companyId, period, resolved: false, ...finding });
  };

  // ---------------------------------------------------------------------
  // 1. Fechamento contábil / integridade estrutural
  // ---------------------------------------------------------------------

  let totalAtivo = 0, totalPassivoPL = 0, totalReceita = 0, totalCusto = 0, totalDespesa = 0, totalPL = 0;
  let resultadoEntry: LedgerEntry | undefined;

  for (const e of balancete) {
    const group = groupOf(e.accountCode);
    const acc = accountByCode.get(e.accountCode);
    const natural = naturalOf(e);

    // Evita dupla contagem: soma apenas contas analíticas ('A') quando o
    // cadastro informar o tipo; contas sem cadastro são somadas por padrão.
    const countsInAggregate = !acc || acc.type !== 'S';

    if (countsInAggregate) {
      if (group === 'Ativo Financeiro' || group === 'Ativo Operacional' || group === 'Ativo Não Circulante') totalAtivo += natural;
      if (group === 'Passivo Circulante' || group === 'Passivo Não Circulante' || group === 'Patrimônio Líquido' || group === 'Provisão') totalPassivoPL += natural;
      if (group === 'Receita') totalReceita += natural;
      if (group === 'Custo') totalCusto += natural;
      if (group === 'Despesa') totalDespesa += natural;
      if (group === 'Patrimônio Líquido') totalPL += natural;
    }

    if (/resultado\s+do\s+exerc[ií]cio|lucro[s]?\/?preju[ií]zo|preju[ií]zo[s]?\/?lucro/i.test(e.accountDescription || '')) {
      resultadoEntry = e;
    }
  }

  // 1.1 Ativo ≠ Passivo + PL
  if (totalAtivo !== 0 || totalPassivoPL !== 0) {
    const diff = totalAtivo - totalPassivoPL;
    if (Math.abs(diff) > Math.max(TOL, Math.abs(totalAtivo) * 0.001)) {
      push({
        severity: 'critical',
        category: 'Balancete Não Fecha (Ativo ≠ Passivo + PL)',
        accountsInvolved: [],
        description: `O total do Ativo (R$ ${totalAtivo.toFixed(2)}) não bate com Passivo + Patrimônio Líquido (R$ ${totalPassivoPL.toFixed(2)}). Diferença de R$ ${diff.toFixed(2)}. O balancete está estruturalmente desbalanceado.`,
      });
    }
  }

  // 1.2 Resultado do balancete ≠ Receita − Custo − Despesa apurado
  if (resultadoEntry) {
    const resultadoBalancete = naturalOf(resultadoEntry);
    const resultadoApurado = totalReceita - totalCusto - totalDespesa;
    if (Math.abs(resultadoBalancete - resultadoApurado) > Math.max(TOL, Math.abs(resultadoApurado) * 0.01)) {
      push({
        severity: 'critical',
        category: 'Resultado do Balancete Diverge do Apurado',
        accountsInvolved: [resultadoEntry.accountCode],
        description: `O resultado lançado no balancete (${resultadoEntry.accountCode} - R$ ${resultadoBalancete.toFixed(2)}) não bate com Receita − Custo − Despesa apurado a partir das contas de resultado (R$ ${resultadoApurado.toFixed(2)}).`,
      });
    }
  }

  // 1.3 Soma das contas analíticas ≠ saldo da conta sintética "pai"
  const syntheticAccounts = accounts.filter(a => a.type === 'S' && a.classification);
  for (const parent of syntheticAccounts) {
    const parentEntry = balancete.find(e => e.accountCode === parent.code);
    if (!parentEntry) continue;

    const childrenEntries = balancete.filter(e => {
      if (e.accountCode === parent.code) return false;
      const childAcc = accountByCode.get(e.accountCode);
      const childCls = childAcc?.classification || '';
      return childCls.startsWith(parent.classification + '.') || childCls.startsWith(parent.classification);
    });

    if (childrenEntries.length === 0) continue;

    // Considera apenas filhos diretos (evita somar "netos" quando já existe
    // uma sintética intermediária entre o pai e a conta filha).
    const directChildren = childrenEntries.filter(e => {
      const childAcc = accountByCode.get(e.accountCode);
      if (!childAcc) return true;
      const intermediary = syntheticAccounts.find(s =>
        s.code !== parent.code &&
        s.classification.startsWith(parent.classification + '.') &&
        childAcc.classification.startsWith(s.classification + '.')
      );
      return !intermediary;
    });

    const sumChildren = directChildren.reduce((sum, e) => sum + e.currentBalance, 0);
    if (Math.abs(sumChildren - parentEntry.currentBalance) > Math.max(TOL, Math.abs(parentEntry.currentBalance) * 0.005)) {
      push({
        severity: 'moderate',
        category: 'Soma das Analíticas Diverge da Sintética',
        accountsInvolved: [parent.code, ...directChildren.map(c => c.accountCode)],
        description: `A soma das contas analíticas de ${parent.code} (${parent.description}) totaliza R$ ${sumChildren.toFixed(2)}, mas a conta sintética está com saldo de R$ ${parentEntry.currentBalance.toFixed(2)}. Diferença de R$ ${(sumChildren - parentEntry.currentBalance).toFixed(2)} — possível erro na geração do balancete.`,
      });
    }
  }

  // 1.4 Saldo anterior + Débito − Crédito ≠ Saldo atual (erro de digitação/importação)
  // Testa as duas convenções de sinal possíveis (D-C e C-D), pois o arquivo de
  // origem pode representar saldo credor com sinal positivo ou negativo.
  for (const e of balancete) {
    const computedDC = e.previousBalance + e.debit - e.credit;
    const computedCD = e.previousBalance + e.credit - e.debit;
    const tolLine = Math.max(TOL, Math.abs(e.currentBalance) * 0.001);
    const okDC = Math.abs(computedDC - e.currentBalance) <= tolLine;
    const okCD = Math.abs(computedCD - e.currentBalance) <= tolLine;
    if (!okDC && !okCD) {
      push({
        severity: 'critical',
        category: 'Linha de Balancete Inconsistente',
        accountsInvolved: [e.accountCode],
        description: `Na conta ${e.accountCode} (${e.accountDescription}), Saldo Anterior (R$ ${e.previousBalance.toFixed(2)}) + Débito (R$ ${e.debit.toFixed(2)}) − Crédito (R$ ${e.credit.toFixed(2)}) não confere com o Saldo Atual informado (R$ ${e.currentBalance.toFixed(2)}). Provável erro de digitação ou de importação do arquivo.`,
      });
    }
  }

  // 1.5 PL negativo (patrimônio líquido a descoberto)
  if (totalPL < -TOL) {
    push({
      severity: 'critical',
      category: 'Patrimônio Líquido a Descoberto',
      accountsInvolved: [],
      description: `O Patrimônio Líquido total está negativo em R$ ${totalPL.toFixed(2)}. Isso indica passivo a descoberto e é um sinal de possível insolvência técnica.`,
    });
  }

  // ---------------------------------------------------------------------
  // 2. Natureza de saldo invertida (checagens categorizadas)
  // ---------------------------------------------------------------------
  for (const e of balancete) {
    const group = groupOf(e.accountCode);
    const desc = (e.accountDescription || '').toLowerCase();
    const acc = accountByCode.get(e.accountCode);
    const natural = naturalOf(e);

    if (Math.abs(natural) <= TOL) continue; // conta zerada, nada a dizer

    // Depreciação acumulada: natureza forçada credora — saldo devedor é o alerta
    if (isDepreciacaoAcumulada(e.accountDescription || '')) {
      if (natural < -TOL) {
        push({
          severity: 'critical',
          category: 'Depreciação Acumulada com Saldo Devedor',
          accountsInvolved: [e.accountCode],
          description: `A conta ${e.accountCode} (${e.accountDescription}) é redutora do Ativo Imobilizado e deveria ter sempre saldo credor. Está com saldo devedor de R$ ${Math.abs(natural).toFixed(2)}.`,
        });
      }
      continue;
    }

    if ((group === 'Ativo Financeiro' || acc?.isPhysicalAccount) && natural < -TOL) {
      push({
        severity: 'critical',
        category: 'Caixa/Banco com Saldo Negativo',
        accountsInvolved: [e.accountCode],
        description: `A conta ${e.accountCode} (${e.accountDescription}) de Caixa/Banco está negativa em R$ ${Math.abs(natural).toFixed(2)} no balancete.`,
      });
      continue;
    }

    if (group === 'Ativo Operacional' && /estoqu/.test(desc) && natural < -TOL) {
      push({
        severity: 'critical',
        category: 'Estoque com Saldo Negativo',
        accountsInvolved: [e.accountCode],
        description: `A conta de estoque ${e.accountCode} (${e.accountDescription}) está negativa em R$ ${Math.abs(natural).toFixed(2)}. Estoque não pode ser negativo.`,
      });
      continue;
    }

    if ((group === 'Ativo Operacional' || group === 'Ativo Não Circulante' || group === 'Ativo Financeiro') && /adiantamento.*fornecedor|fornecedor.*adiantamento/.test(desc) && natural < -TOL) {
      push({
        severity: 'moderate',
        category: 'Adiantamento a Fornecedor com Saldo Credor',
        accountsInvolved: [e.accountCode],
        description: `A conta ${e.accountCode} (${e.accountDescription}) de adiantamento a fornecedor está com saldo credor de R$ ${Math.abs(natural).toFixed(2)}, o que é atípico para essa natureza de conta.`,
      });
      continue;
    }

    if ((group === 'Ativo Operacional' || group === 'Ativo Não Circulante') && /cliente/.test(desc) && natural < -TOL) {
      push({
        severity: 'moderate',
        category: 'Cliente com Saldo Credor',
        accountsInvolved: [e.accountCode],
        description: `A conta de cliente ${e.accountCode} (${e.accountDescription}) está com saldo credor de R$ ${Math.abs(natural).toFixed(2)} — o cliente aparece devendo "ao contrário". Verifique se houve pagamento em duplicidade ou lançamento invertido.`,
      });
      continue;
    }

    if (group === 'Receita' && natural < -TOL) {
      push({
        severity: 'moderate',
        category: 'Receita com Saldo Negativo (Estorno Indevido)',
        accountsInvolved: [e.accountCode],
        description: `A conta de receita ${e.accountCode} (${e.accountDescription}) está com saldo negativo de R$ ${Math.abs(natural).toFixed(2)}, sugerindo estornos maiores que a própria receita reconhecida no período.`,
      });
      continue;
    }

    if ((group === 'Passivo Circulante' || group === 'Passivo Não Circulante') && /fornecedor/.test(desc) && natural < -TOL) {
      push({
        severity: 'moderate',
        category: 'Fornecedor com Saldo Devedor',
        accountsInvolved: [e.accountCode],
        description: `A conta de fornecedor ${e.accountCode} (${e.accountDescription}) está com saldo devedor de R$ ${Math.abs(natural).toFixed(2)}. Verifique se não é um adiantamento que deveria estar em outra conta.`,
      });
      continue;
    }

    if ((group === 'Passivo Circulante' || group === 'Passivo Não Circulante') && /imposto|tribut|recolher|icms|iss\b|pis\b|cofins|irpj|csll|inss|fgts/.test(desc) && natural < -TOL) {
      push({
        severity: 'moderate',
        category: 'Imposto a Recolher com Saldo Devedor',
        accountsInvolved: [e.accountCode],
        description: `A conta de imposto/obrigação ${e.accountCode} (${e.accountDescription}) está com saldo devedor de R$ ${Math.abs(natural).toFixed(2)}, o que é incomum para uma conta de obrigação a recolher.`,
      });
      continue;
    }

    if (group === 'Despesa' && natural < -TOL) {
      push({
        severity: 'moderate',
        category: 'Despesa com Saldo Credor',
        accountsInvolved: [e.accountCode],
        description: `A conta de despesa ${e.accountCode} (${e.accountDescription}) está com saldo credor de R$ ${Math.abs(natural).toFixed(2)} — o estorno superou o lançamento original da despesa no período.`,
      });
      continue;
    }
  }

  // ---------------------------------------------------------------------
  // 3. Indicadores financeiros impossíveis
  // ---------------------------------------------------------------------
  if (totalReceita > TOL) {
    if (totalCusto > totalReceita) {
      push({
        severity: 'critical',
        category: 'CMV Maior que a Receita Bruta',
        accountsInvolved: [],
        description: `O Custo (CMV) do período (R$ ${totalCusto.toFixed(2)}) é maior que a Receita Bruta (R$ ${totalReceita.toFixed(2)}), resultando em margem bruta negativa impossível de sustentar. Verifique lançamentos de custo.`,
      });
    }
    if (totalDespesa > totalReceita) {
      push({
        severity: 'moderate',
        category: 'Despesas Maiores que a Receita Total',
        accountsInvolved: [],
        description: `As despesas administrativas/comerciais do período (R$ ${totalDespesa.toFixed(2)}) superam a receita total (R$ ${totalReceita.toFixed(2)}). Pode ser normal pontualmente, mas é insustentável se recorrente — cruze com os meses anteriores.`,
      });
    }
    const margemLiquida = (totalReceita - totalCusto - totalDespesa) / totalReceita;
    if (Math.abs(margemLiquida) > 1) {
      push({
        severity: 'observation',
        category: 'Margem Líquida Fora do Intervalo Esperado',
        accountsInvolved: [],
        description: `A margem líquida apurada é de ${(margemLiquida * 100).toFixed(0)}%, fora do intervalo -100% a 100%. Confira se há reversões de provisão ou lançamentos atípicos concentrados no período.`,
      });
    }
  }

  // Giro de estoque absurdo
  const estoqueEntries = balancete.filter(e => /estoqu/.test((e.accountDescription || '').toLowerCase()));
  if (estoqueEntries.length > 0) {
    const estoqueFinal = estoqueEntries.reduce((sum, e) => sum + naturalOf(e), 0);
    if (estoqueFinal <= TOL && totalCusto > 1000) {
      push({
        severity: 'observation',
        category: 'Giro de Estoque Atípico',
        accountsInvolved: estoqueEntries.map(e => e.accountCode),
        description: `O estoque final está praticamente zerado (R$ ${estoqueFinal.toFixed(2)}), mas o CMV do período é de R$ ${totalCusto.toFixed(2)}. Confirme se todo o estoque foi mesmo vendido ou se há erro de baixa.`,
      });
    } else if (estoqueFinal > 1000 && totalCusto <= TOL && totalReceita > TOL) {
      push({
        severity: 'observation',
        category: 'Giro de Estoque Atípico',
        accountsInvolved: estoqueEntries.map(e => e.accountCode),
        description: `Há receita no período (R$ ${totalReceita.toFixed(2)}) e estoque de R$ ${estoqueFinal.toFixed(2)}, mas nenhum CMV foi lançado. Verifique se a baixa do estoque/custo está faltando.`,
      });
    }
  }

  // ---------------------------------------------------------------------
  // 4. Qualidade de cadastro / plano de contas
  // ---------------------------------------------------------------------

  // Sintética recebendo lançamento direto
  for (const e of balancete) {
    const acc = accountByCode.get(e.accountCode);
    if (acc?.type === 'S' && (Math.abs(e.debit) > TOL || Math.abs(e.credit) > TOL)) {
      push({
        severity: 'critical',
        category: 'Conta Sintética com Lançamento Direto',
        accountsInvolved: [e.accountCode],
        description: `A conta ${e.accountCode} (${e.accountDescription}) é sintética (agrupadora) mas recebeu movimentação direta no período (D=R$ ${e.debit.toFixed(2)} / C=R$ ${e.credit.toFixed(2)}). Contas sintéticas não deveriam ter lançamento próprio — apenas somar as analíticas.`,
      });
    }
  }

  // Conta sem classificação reconhecida
  const unmappedCodesSeen = new Set<string>();
  for (const e of balancete) {
    const group = groupOf(e.accountCode);
    if (group === 'Outro' && !unmappedCodesSeen.has(e.accountCode) && Math.abs(e.currentBalance) > TOL) {
      unmappedCodesSeen.add(e.accountCode);
      push({
        severity: 'observation',
        category: 'Conta Fora do Agrupamento Padrão',
        accountsInvolved: [e.accountCode],
        description: `A conta ${e.accountCode} (${e.accountDescription}) não se encaixou em nenhum grupo contábil reconhecido (Ativo/Passivo/PL/Receita/Custo/Despesa/Provisão). Verifique a classificação cadastrada — o plano de contas pode estar mal mapeado.`,
      });
    }
  }

  // Possível duplicidade de cadastro (nomes muito parecidos, saldos pequenos)
  const smallBalanceAccounts = balancete.filter(e => Math.abs(e.currentBalance) < 500 && (e.accountDescription || '').trim().length > 4);
  for (let i = 0; i < smallBalanceAccounts.length; i++) {
    for (let j = i + 1; j < smallBalanceAccounts.length; j++) {
      const a = smallBalanceAccounts[i];
      const b = smallBalanceAccounts[j];
      if (a.accountCode === b.accountCode) continue;
      const da = (a.accountDescription || '').trim().toUpperCase();
      const dbDesc = (b.accountDescription || '').trim().toUpperCase();
      if (!da || !dbDesc || da === dbDesc) continue;
      const dist = levenshtein(da, dbDesc);
      const maxLen = Math.max(da.length, dbDesc.length);
      if (maxLen > 0 && dist / maxLen <= 0.2 && dist <= 4) {
        push({
          severity: 'observation',
          category: 'Possível Duplicidade de Cadastro de Conta',
          accountsInvolved: [a.accountCode, b.accountCode],
          description: `As contas ${a.accountCode} ("${a.accountDescription}") e ${b.accountCode} ("${b.accountDescription}") têm nomes muito parecidos e saldos pequenos (R$ ${a.currentBalance.toFixed(2)} e R$ ${b.currentBalance.toFixed(2)}). Pode ser cadastro duplicado no plano de contas.`,
        });
      }
    }
  }

  // ---------------------------------------------------------------------
  // 5. Comparação entre períodos (requer balancetes anteriores)
  // ---------------------------------------------------------------------
  const allBalanceteEntries = await db.ledgerEntries
    .where('companyId').equals(companyId)
    .and(e => e.source === 'balancete')
    .toArray();

  const allPeriods = Array.from(new Set(allBalanceteEntries.map(e => e.period))).sort();
  const currentIdx = allPeriods.indexOf(period);

  if (currentIdx > 0) {
    const prevPeriod = allPeriods[currentIdx - 1];
    const prevBalancete = allBalanceteEntries.filter(e => e.period === prevPeriod);
    const prevByCode = new Map(prevBalancete.map(e => [e.accountCode, e]));
    const currByCode = new Map(balancete.map(e => [e.accountCode, e]));

    // Conta que some de um mês para o outro sem baixa aparente
    for (const [code, prevEntry] of prevByCode) {
      if (Math.abs(prevEntry.currentBalance) > TOL && !currByCode.has(code)) {
        push({
          severity: 'moderate',
          category: 'Conta Desapareceu do Balancete',
          accountsInvolved: [code],
          description: `A conta ${code} (${prevEntry.accountDescription}) tinha saldo de R$ ${prevEntry.currentBalance.toFixed(2)} em ${prevPeriod} e não aparece no balancete de ${period}, sem evidência de baixa. Verifique se foi zerada corretamente ou se há erro de geração do balancete.`,
        });
      }
    }

    // Conta nova com saldo alto sem saldo anterior
    for (const [code, currEntry] of currByCode) {
      if (!prevByCode.has(code) && Math.abs(currEntry.previousBalance) <= TOL && Math.abs(currEntry.currentBalance) > Math.max(1000, Math.abs(totalAtivo) * 0.02)) {
        push({
          severity: 'observation',
          category: 'Conta Nova com Saldo Alto',
          accountsInvolved: [code],
          description: `A conta ${code} (${currEntry.accountDescription}) aparece pela primeira vez em ${period} já com saldo de R$ ${currEntry.currentBalance.toFixed(2)}, sem saldo em ${prevPeriod}. Confirme se o saldo de abertura foi migrado corretamente.`,
        });
      }
    }

    // Provisão baixada sem lançamento compatível
    for (const [code, currEntry] of currByCode) {
      const group = groupOf(code);
      if (group !== 'Provisão') continue;
      const prevEntry = prevByCode.get(code);
      if (!prevEntry) continue;
      const drop = prevEntry.currentBalance - currEntry.currentBalance;
      if (drop > Math.max(TOL, prevEntry.currentBalance * 0.05) && Math.abs(drop - currEntry.debit) > Math.max(TOL, drop * 0.1)) {
        push({
          severity: 'moderate',
          category: 'Provisão Baixada sem Lançamento Compatível',
          accountsInvolved: [code],
          description: `A provisão ${code} (${currEntry.accountDescription}) caiu de R$ ${prevEntry.currentBalance.toFixed(2)} para R$ ${currEntry.currentBalance.toFixed(2)}, uma baixa de R$ ${drop.toFixed(2)}, mas o débito lançado na conta no período foi de apenas R$ ${currEntry.debit.toFixed(2)}. Verifique se a baixa está corretamente lançada.`,
        });
      }
    }
  }

  // Conta congelada (mesmo saldo por 3+ meses) e variação estatística atípica
  if (currentIdx >= 2) {
    const lastPeriods = allPeriods.slice(Math.max(0, currentIdx - 5), currentIdx + 1); // até 6 últimos períodos
    const historyByCode = new Map<string, { period: string; balance: number; desc: string }[]>();
    for (const p of lastPeriods) {
      const entriesP = allBalanceteEntries.filter(e => e.period === p);
      for (const e of entriesP) {
        const arr = historyByCode.get(e.accountCode) || [];
        arr.push({ period: p, balance: e.currentBalance, desc: e.accountDescription });
        historyByCode.set(e.accountCode, arr);
      }
    }

    const transitCodesFlagged = new Set<string>();

    for (const [code, hist] of historyByCode) {
      if (hist.length < 3) continue;
      const lastN = hist.slice(-3);
      if (lastN[lastN.length - 1].period !== period) continue; // só avalia se o período atual está na ponta

      // Conta congelada
      const allEqual = lastN.every(h => Math.abs(h.balance - lastN[0].balance) <= TOL);
      if (allEqual && Math.abs(lastN[0].balance) > TOL) {
        push({
          severity: 'observation',
          category: 'Conta com Saldo Congelado',
          accountsInvolved: [code],
          description: `A conta ${code} (${lastN[0].desc}) está com o mesmo saldo (R$ ${lastN[0].balance.toFixed(2)}) há ${lastN.length} meses seguidos (${lastN.map(h => h.period).join(', ')}). Pode ser uma conta esquecida/sem movimentação que deveria ser revisada.`,
        });
      }

      // Variação estatística atípica (desvio padrão) quando há histórico suficiente
      if (hist.length >= 4) {
        const priorValues = hist.slice(0, -1).map(h => h.balance);
        const mean = priorValues.reduce((s, v) => s + v, 0) / priorValues.length;
        const variance = priorValues.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / priorValues.length;
        const stddev = Math.sqrt(variance);
        const current = hist[hist.length - 1].balance;
        if (stddev > TOL) {
          const z = Math.abs(current - mean) / stddev;
          if (z > 2.5 && Math.abs(current - mean) > 500) {
            push({
              severity: 'observation',
              category: 'Variação Estatística Atípica',
              accountsInvolved: [code],
              description: `A conta ${code} (${hist[hist.length - 1].desc}) está em R$ ${current.toFixed(2)}, muito fora do padrão histórico dos últimos meses (média de R$ ${mean.toFixed(2)}, desvio padrão de R$ ${stddev.toFixed(2)}). Desvio de ${z.toFixed(1)}x o normal.`,
            });
          }
        }
      }

      // Conta transitória antiga (adiantamentos, valores a classificar, etc.) com saldo > 0 há muito tempo
      const desc = (lastN[lastN.length - 1].desc || '').toLowerCase();
      if (!transitCodesFlagged.has(code) && /a classificar|transit[óo]ri|adiantamento|transfer[êe]ncia entre contas|conta corrente entre/.test(desc)) {
        const monthsWithBalance = hist.filter(h => Math.abs(h.balance) > TOL).length;
        if (monthsWithBalance >= 3 && Math.abs(hist[hist.length - 1].balance) > TOL) {
          transitCodesFlagged.add(code);
          push({
            severity: 'moderate',
            category: 'Conta Transitória com Saldo Antigo',
            accountsInvolved: [code],
            description: `A conta transitória ${code} (${lastN[lastN.length - 1].desc}) mantém saldo (atualmente R$ ${hist[hist.length - 1].balance.toFixed(2)}) há pelo menos ${monthsWithBalance} dos últimos ${hist.length} meses. Contas de passagem não deveriam acumular saldo por tanto tempo — verifique se há lançamentos pendentes de classificação.`,
          });
        }
      }
    }
  }

  // ---------------------------------------------------------------------
  // 6. Encargos trabalhistas — checagem best-effort (sem dados de folha)
  // ---------------------------------------------------------------------
  const folhaMovimento = balancete
    .filter(e => groupOf(e.accountCode) === 'Despesa' && /sal[aá]rio|folha|pessoal|ordenado/.test((e.accountDescription || '').toLowerCase()))
    .reduce((sum, e) => sum + e.debit, 0);

  if (folhaMovimento > TOL) {
    const encargosMovimento = balancete
      .filter(e => (groupOf(e.accountCode) === 'Passivo Circulante' || groupOf(e.accountCode) === 'Passivo Não Circulante') && /inss|fgts/.test((e.accountDescription || '').toLowerCase()))
      .reduce((sum, e) => sum + e.credit, 0);

    if (encargosMovimento <= TOL) {
      push({
        severity: 'observation',
        category: 'Possível Ausência de Provisionamento de Encargos',
        accountsInvolved: [],
        description: `Foram identificadas despesas de folha/salários no período (R$ ${folhaMovimento.toFixed(2)}), mas nenhuma movimentação a crédito em contas de INSS/FGTS a recolher. Confirme se os encargos trabalhistas estão sendo provisionados corretamente.`,
      });
    }
  }

  return findings;
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

Dê atenção especial às contas analíticas de resultado e à conciliação com as contas de disponibilidade (bancos). Quando identificar que um lançamento em conta de resultado (Custo/Despesa/Receita) tem um número de Nota Fiscal (NF) e o parear com um lançamento de pagamento/recebimento no banco cujo histórico está genérico, a sua sugestão de ajuste deve recomendar explicitamente a alteração do histórico da conta banco para incluir o número da respectiva Nota Fiscal.

Lançamentos Origem:
${JSON.stringify(sources.map(e => ({ id: e.id, data: e.date, conta: e.accountCode, historico: e.history, valor: e.debit || e.credit })), null, 2)}

Lançamentos Destino Esperado:
${JSON.stringify(targets.map(e => ({ id: e.id, data: e.date, conta: e.accountCode, historico: e.history, valor: e.debit || e.credit })), null, 2)}

Retorne um JSON com a seguinte estrutura:
{
  "matchedPairs": [
    { "entryIdA": 123, "entryIdB": 456, "confidence": "alta"|"media"|"baixa", "reasoning": "string", "suggestedBankHistoryAdjustment": "novo histórico sugerido com a NF para a conta banco" }
  ],
  "stillUnmatched": [
    { 
      "entryId": 123, 
      "reason": "motivo pelo qual não encontrou par",
      "suggestedAdjustment": {
        "debitAccountCode": "código analítico da conta débito",
        "creditAccountCode": "código analítico da conta crédito",
        "amount": 100.00,
        "history": "histórico sugerido detalhado",
        "reason": "motivo do ajuste e indicação de onde debitar/creditar"
      }
    }
  ]
}
Nota: "stillUnmatched" deve conter os IDs da Origem que NÃO conseguiram par.
      `;
      
      try {
          const response = await ai.models.generateContent({
             model: 'gemini-3.0-flash',
             contents: prompt,
             config: { responseMimeType: 'application/json', temperature: 0.1 }
          });
          
          if (response.text) {
             const data = JSON.parse(response.text);
             
             if (data.matchedPairs) {
                 for (const pair of data.matchedPairs) {
                     const src = sources.find(s => s.id === pair.entryIdA);
                     const tgt = targets.find(t => t.id === pair.entryIdB);
                     
                     if (pair.confidence === 'baixa') {
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
                     
                     if (pair.suggestedBankHistoryAdjustment && src && tgt) {
                          aiFindings.push({
                               companyId,
                               period,
                               severity: 'observation',
                               category: 'Sugestão de Ajuste de Histórico (NF)',
                               accountsInvolved: [src.accountCode, tgt.accountCode],
                               description: `A IA encontrou o par correspondente e sugere detalhar o histórico na conta banco (disponibilidade) com o número da Nota Fiscal.\nMotivo: ${pair.reasoning}\nSugestão de Histórico Banco: ${pair.suggestedBankHistoryAdjustment}`,
                               historyExtract: `Origem: ${src.history}\nDestino (Banco): ${tgt.history}`,
                               relatedEntryIds: [src.id as number, tgt.id as number],
                               resolved: false
                          });
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
5. Inconsistências ou falta de lançamentos relacionados ao CMV (Custo da Mercadoria Vendida) ou contas de Resultado.
6. Saldo de contas de disponibilidades (Caixa/Bancos, grupo 1.1.1) ficando negativo.

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