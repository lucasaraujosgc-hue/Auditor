import Dexie, { type Table } from 'dexie';
import 'dexie-observable';

export interface Company {
  id?: number;
  name: string;
  cnpj: string;
  description?: string; // Informações sobre a empresa para a IA
}

export interface Account {
  id?: number;
  companyId: number;
  code: string;
  description: string;
  classification: string;
  type: 'S' | 'A';
  isPhysicalAccount?: boolean; // Conta física que não pode negativar (ex: Caixa)
}

export interface Rule {
  id?: number;
  companyId: number;
  keyword: string;
  accountCode: string;
  type: 'D' | 'C'; // Debit or Credit
}

export interface Transaction {
  id?: number;
  companyId: number;
  date: string; // YYYY-MM-DD
  amount: number;
  description: string;
  debitAccount?: string;
  creditAccount?: string;
  bankAccountCode?: string; // The bank account code used for this import
  reconciled?: boolean; // Se foi conciliado manualmente ou por regra
  aiSuggestion?: boolean; // Se a conta foi sugerida pela IA
  aiReason?: string; // Motivo da IA
  suggestedNewAccount?: string; // Sugestão de nova conta a criar
}

export interface LedgerEntry {
  id?: number;
  companyId: number;
  period: string; // YYYY-MM
  accountCode: string;
  accountDescription: string;
  previousBalance: number;
  debit: number;
  credit: number;
  currentBalance: number;
  date?: string; // YYYY-MM-DD (para lançamentos do Razão)
  history?: string; // Histórico do lançamento
  contrapartidaAccountCode?: string; // Cta.C.Part.
  source: 'balancete' | 'razao';
}

export interface AuditFinding {
  id?: number;
  companyId: number;
  period: string; // YYYY-MM
  severity: 'critical' | 'moderate' | 'observation';
  category: string;
  accountsInvolved: string[];
  description: string;
  historyExtract?: string;
  suggestedAdjustment?: {
    debitAccountCode: string;
    creditAccountCode: string;
    amount: number;
    history: string;
    reason: string;
  };
  resolved: boolean;
  relatedEntryIds?: number[];
}

export class AppDatabase extends Dexie {
  companies!: Table<Company>;
  accounts!: Table<Account>;
  rules!: Table<Rule>;
  transactions!: Table<Transaction>;
  ledgerEntries!: Table<LedgerEntry>;
  auditFindings!: Table<AuditFinding>;

  constructor() {
    super('ContabilDB');
    this.version(3).stores({
      companies: '++id, name, cnpj',
      accounts: '++id, companyId, code, classification',
      rules: '++id, companyId, keyword',
      transactions: '++id, companyId, date, reconciled',
      ledgerEntries: '++id, companyId, period, accountCode, source, date',
      auditFindings: '++id, companyId, period, severity, resolved'
    });
  }
}

export const db = new AppDatabase();

// Auto-sync logic
let syncTimeout: any = null;
db.on('changes', function (changes) {
  // Only sync if there are actual changes
  if (changes.length > 0) {
    if (syncTimeout) clearTimeout(syncTimeout);
    syncTimeout = setTimeout(async () => {
      try {
        const { syncToBackup } = await import('./backup');
        await syncToBackup();
        console.log('Auto-synced to backup server.');
      } catch (e) {
        console.error('Failed to auto-sync:', e);
      }
    }, 2000); // debounce 2 seconds
  }
});
