import React, { useState, useEffect } from 'react';
import { db, type Account, type Rule, type Transaction } from '../../lib/db';
import { Button } from '../../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../../components/ui/card';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { AccountCombobox } from '../../components/ui/account-combobox';
import { Upload, FileText, CheckCircle2 } from 'lucide-react';
import { reconcileTransactionsWithAI } from '../../lib/ai';

// Simple OFX Parser
function parseOFX(ofxString: string) {
  const transactions = [];
  const trnRegex = /<STMTTRN>([\s\S]*?)<\/STMTTRN>/g;
  let match;
  while ((match = trnRegex.exec(ofxString)) !== null) {
    const trnBlock = match[1];
    const typeMatch = trnBlock.match(/<TRNTYPE>(.*?)(?:\r|\n|<)/);
    const dateMatch = trnBlock.match(/<DTPOSTED>(.*?)(?:\r|\n|<)/);
    const amtMatch = trnBlock.match(/<TRNAMT>(.*?)(?:\r|\n|<)/);
    const memoMatch = trnBlock.match(/<MEMO>(.*?)(?:\r|\n|<)/);
    
    if (dateMatch && amtMatch) {
      transactions.push({
        type: typeMatch ? typeMatch[1].trim() : '',
        date: dateMatch[1].trim().substring(0, 8), // YYYYMMDD
        amount: parseFloat(amtMatch[1].trim()),
        memo: memoMatch ? memoMatch[1].trim() : '',
      });
    }
  }
  return transactions;
}

export default function ImportarOFXTab({ companyId, onImportSuccess }: { companyId: number, onImportSuccess?: () => void }) {
  const [loading, setLoading] = useState(false);
  const [bankAccountCode, setBankAccountCode] = useState('');
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [rules, setRules] = useState<Rule[]>([]);
  const [successMsg, setSuccessMsg] = useState('');

  useEffect(() => {
    loadData();
  }, [companyId]);

  const loadData = async () => {
    const allAccounts = await db.accounts.where('companyId').equals(companyId).toArray();
    const allRules = await db.rules.where('companyId').equals(companyId).toArray();
    setAccounts(allAccounts.filter(a => a.type === 'A'));
    setRules(allRules);
  };

  const applyRules = (memo: string, amount: number) => {
    const memoUpper = memo.toUpperCase();
    const isDebit = amount < 0; // Money leaving bank
    
    // Find matching rule
    const matchingRule = rules.find(r => 
      memoUpper.includes(r.keyword.toUpperCase()) && 
      ((isDebit && r.type === 'D') || (!isDebit && r.type === 'C'))
    );

    return matchingRule?.accountCode || '';
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!bankAccountCode) {
      alert('Por favor, selecione a conta contábil do banco antes de importar.');
      if (e.target) e.target.value = '';
      return;
    }

    const file = e.target.files?.[0];
    if (!file) return;

    setLoading(true);
    setSuccessMsg('');

    try {
      const text = await file.text();
      const parsedTransactions = parseOFX(text);
      
      if (parsedTransactions.length === 0) {
        alert('Nenhum lançamento encontrado no arquivo OFX.');
        return;
      }

      const newTransactions: Transaction[] = parsedTransactions.map(t => {
        // Format date from YYYYMMDD to YYYY-MM-DD
        const dateStr = `${t.date.substring(0, 4)}-${t.date.substring(4, 6)}-${t.date.substring(6, 8)}`;
        const mappedAccount = applyRules(t.memo, t.amount);
        
        // If money leaves bank (amount < 0): Credit Bank, Debit Expense
        // If money enters bank (amount > 0): Debit Bank, Credit Revenue
        const isDebit = t.amount < 0;
        
        return {
          companyId,
          date: dateStr,
          amount: Math.abs(t.amount),
          description: t.memo,
          bankAccountCode: bankAccountCode,
          debitAccount: isDebit ? mappedAccount : bankAccountCode,
          creditAccount: isDebit ? bankAccountCode : mappedAccount,
          reconciled: !!mappedAccount // Se encontrou conta, considera conciliado pela regra
        };
      });

      await db.transactions.bulkAdd(newTransactions);
      setSuccessMsg(`Arquivo processado com sucesso! ${newTransactions.length} lançamentos importados. Iniciando conciliação via IA...`);
      
      try {
        await reconcileTransactionsWithAI(companyId);
        setSuccessMsg(`Arquivo processado e conciliação via IA concluída! Vá para a aba "Lançamentos" para revisar.`);
      } catch (aiError) {
        console.error('Erro na conciliação via IA:', aiError);
        setSuccessMsg(`Arquivo processado, mas houve um erro na conciliação via IA.`);
      }

      if (onImportSuccess) {
        setTimeout(() => {
          onImportSuccess();
        }, 1500);
      }
      
    } catch (error) {
      console.error('Erro ao importar OFX:', error);
      alert('Erro ao processar o arquivo OFX.');
    } finally {
      setLoading(false);
      if (e.target) e.target.value = '';
    }
  };

  return (
    <div className="space-y-6 max-w-2xl">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <FileText className="w-5 h-5 text-virgula-green" />
            Importar Extrato OFX
          </CardTitle>
          <CardDescription>
            Selecione a conta contábil correspondente ao banco e faça o upload do arquivo OFX. 
            O sistema aplicará as regras de vínculo automaticamente.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="space-y-2">
            <Label htmlFor="bankAccount">Conta Contábil do Banco</Label>
            <AccountCombobox
              accounts={accounts}
              value={bankAccountCode}
              onChange={setBankAccountCode}
              placeholder="Selecione a conta do banco"
            />
            <p className="text-xs text-gray-500">
              Esta conta será usada como contrapartida para todos os lançamentos deste extrato.
            </p>
          </div>

          <div className="pt-4 border-t">
            <div className="relative inline-block">
              <input
                type="file"
                accept=".ofx"
                onChange={handleFileUpload}
                className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                disabled={loading || !bankAccountCode}
              />
              <Button disabled={loading || !bankAccountCode} className="gap-2 bg-virgula-green hover:bg-emerald-600 text-white">
                <Upload className="w-4 h-4" />
                {loading ? 'Processando...' : 'Selecionar Arquivo OFX'}
              </Button>
            </div>
          </div>

          {successMsg && (
            <div className="p-4 bg-virgula-green/10 text-emerald-800 rounded-md flex items-center gap-2 border border-virgula-green/20">
              <CheckCircle2 className="w-5 h-5 text-virgula-green" />
              {successMsg}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
