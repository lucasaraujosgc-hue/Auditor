import React, { useState, useEffect } from 'react';
import { db, type Transaction, type Account } from '../../lib/db';
import { Button } from '../../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../../components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../components/ui/table';
import { AccountCombobox } from '../../components/ui/account-combobox';
import { Badge } from '../../components/ui/badge';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../../components/ui/tooltip';
import { Download, Trash2, AlertCircle, Sparkles, CheckCircle2, Info } from 'lucide-react';
import { format, parseISO } from 'date-fns';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { reconcileTransactionsWithAI } from '../../lib/ai';
import { AIChat } from '../../components/AIChat';

export default function LancamentosTab({ companyId }: { companyId: number }) {
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [isReconciling, setIsReconciling] = useState(false);
  const [selectedPeriod, setSelectedPeriod] = useState<string>('');

  useEffect(() => {
    loadData();
  }, [companyId]);

  const loadData = async () => {
    const allTransactions = await db.transactions.where('companyId').equals(companyId).toArray();
    // Sort by date ascending
    allTransactions.sort((a, b) => a.date.localeCompare(b.date));
    setTransactions(allTransactions);

    const allAccounts = await db.accounts.where('companyId').equals(companyId).toArray();
    setAccounts(allAccounts.filter(a => a.type === 'A'));
  };

  const handleUpdateTransaction = async (id: number, field: 'debitAccount' | 'creditAccount', value: string) => {
    await db.transactions.update(id, { [field]: value, reconciled: true });
    loadData();
  };

  const handleDeleteAll = async () => {
    if (confirm('Tem certeza que deseja apagar todos os lançamentos desta empresa?')) {
      await db.transactions.where('companyId').equals(companyId).delete();
      loadData();
    }
  };

  const handleAIReconciliation = async () => {
    setIsReconciling(true);
    try {
      await reconcileTransactionsWithAI(companyId, selectedPeriod);
      await loadData();
      alert('Conciliação via IA concluída. Revise as sugestões.');
    } catch (error) {
      alert('Erro ao realizar conciliação via IA.');
    } finally {
      setIsReconciling(false);
    }
  };

  const exportToTXT = () => {
    const filteredTransactions = transactions.filter(t => selectedPeriod ? t.date.startsWith(selectedPeriod) : true);
    if (filteredTransactions.length === 0) return;

    let txtContent = '';
    let lastDate = '';

    filteredTransactions.forEach((t) => {
      const dateObj = parseISO(t.date);
      const formattedDate = format(dateObj, 'dd/MM/yyyy');
      
      // Inicia Lote is 1 for the first transaction of a date, empty otherwise
      const iniciaLote = formattedDate !== lastDate ? '1' : '';
      lastDate = formattedDate;

      // Format amount: 100.50 -> 100,50. 100.00 -> 100
      let formattedAmount = t.amount.toFixed(2).replace('.', ',');
      if (formattedAmount.endsWith(',00')) {
        formattedAmount = formattedAmount.replace(',00', '');
      }

      // Format: Data;ContaDebito;ContaCredito;Valor;CodHistorico;Historico;IniciaLote;MatrizFilial;;
      const line = [
        formattedDate,
        t.debitAccount || '',
        t.creditAccount || '',
        formattedAmount,
        '', // Cod. Histórico (empty based on image)
        t.description.replace(/;/g, ','),
        iniciaLote,
        '1', // Código Matriz/Filial
        '', // Empty trailing field 1
        ''  // Empty trailing field 2
      ].join(';');

      txtContent += line + '\n';
    });

    const blob = new Blob([txtContent], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `lancamentos_${companyId}_${format(new Date(), 'yyyyMMdd')}.txt`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const filteredTransactions = transactions.filter(t => selectedPeriod ? t.date.startsWith(selectedPeriod) : true);
  const unmappedCount = filteredTransactions.filter(t => !t.debitAccount || !t.creditAccount).length;
  const unreconciledCount = filteredTransactions.filter(t => !t.reconciled).length;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
          <div>
            <CardTitle>Lançamentos Processados ({filteredTransactions.length})</CardTitle>
            <CardDescription>
              Revise os vínculos contábeis e exporte o arquivo TXT.
            </CardDescription>
          </div>
          <div className="flex flex-wrap items-center gap-4">
            <div className="flex items-center gap-2">
              <Label htmlFor="periodo" className="text-sm font-medium text-gray-700 whitespace-nowrap">Período:</Label>
              <Input 
                id="periodo"
                type="month" 
                value={selectedPeriod} 
                onChange={e => setSelectedPeriod(e.target.value)} 
                className="w-40"
              />
            </div>
            {filteredTransactions.length > 0 && (
              <Button variant="destructive" onClick={handleDeleteAll} className="gap-2">
                <Trash2 className="w-4 h-4" />
                Limpar Lançamentos
              </Button>
            )}
            {unreconciledCount > 0 && (
              <Button 
                onClick={handleAIReconciliation} 
                disabled={isReconciling}
                className="gap-2 bg-purple-600 hover:bg-purple-700"
              >
                <Sparkles className="w-4 h-4" />
                {isReconciling ? 'Processando IA...' : 'Reprocessar Não Conciliados'}
              </Button>
            )}
            <Button 
              onClick={exportToTXT} 
              disabled={filteredTransactions.length === 0 || unmappedCount > 0}
              className="gap-2 bg-virgula-green hover:bg-emerald-600 text-white"
            >
              <Download className="w-4 h-4" />
              Exportar TXT
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {unmappedCount > 0 && (
            <div className="mb-6 p-4 bg-amber-50 text-amber-800 rounded-md flex items-center gap-2 border border-amber-200">
              <AlertCircle className="w-5 h-5 text-amber-600" />
              Existem {unmappedCount} lançamentos sem conta de débito ou crédito. Preencha-os antes de exportar.
            </div>
          )}

          {filteredTransactions.length > 0 ? (
            <div className="rounded-md border overflow-hidden">
              <Table>
                <TableHeader className="bg-gray-50">
                  <TableRow>
                    <TableHead className="w-24">Data</TableHead>
                    <TableHead>Histórico (OFX)</TableHead>
                    <TableHead className="w-32 text-right">Valor (R$)</TableHead>
                    <TableHead className="w-48">Conta Débito</TableHead>
                    <TableHead className="w-48">Conta Crédito</TableHead>
                    <TableHead className="w-24 text-center">Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredTransactions.map((t) => (
                    <TableRow key={t.id} className={(!t.debitAccount || !t.creditAccount) ? 'bg-amber-50/50' : ''}>
                      <TableCell className="font-medium">
                        {format(parseISO(t.date), 'dd/MM/yyyy')}
                      </TableCell>
                      <TableCell className="text-sm text-gray-600">
                        <div className="flex items-center gap-2">
                          {t.description}
                          {t.aiReason && (
                            <TooltipProvider>
                              <Tooltip>
                                <TooltipTrigger>
                                  <Info className="w-4 h-4 text-purple-500" />
                                </TooltipTrigger>
                                <TooltipContent className="max-w-xs">
                                  <p className="font-semibold mb-1">Análise da IA:</p>
                                  <p>{t.aiReason}</p>
                                  {t.suggestedNewAccount && (
                                    <p className="mt-2 text-amber-500">
                                      <strong>Sugestão de nova conta:</strong> {t.suggestedNewAccount}
                                    </p>
                                  )}
                                </TooltipContent>
                              </Tooltip>
                            </TooltipProvider>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="text-right font-mono">
                        {t.amount.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}
                      </TableCell>
                      <TableCell>
                        <AccountCombobox
                          accounts={accounts}
                          value={t.debitAccount || ''}
                          onChange={(v) => handleUpdateTransaction(t.id!, 'debitAccount', v)}
                          placeholder="Selecione..."
                          className={!t.debitAccount ? 'border-amber-300 bg-amber-50' : ''}
                        />
                      </TableCell>
                      <TableCell>
                        <AccountCombobox
                          accounts={accounts}
                          value={t.creditAccount || ''}
                          onChange={(v) => handleUpdateTransaction(t.id!, 'creditAccount', v)}
                          placeholder="Selecione..."
                          className={!t.creditAccount ? 'border-amber-300 bg-amber-50' : ''}
                        />
                      </TableCell>
                      <TableCell className="text-center">
                        {t.reconciled ? (
                          <Badge variant="outline" className="bg-virgula-green/10 text-emerald-700 border-virgula-green/20">
                            <CheckCircle2 className="w-3 h-3 mr-1" /> OK
                          </Badge>
                        ) : t.aiSuggestion ? (
                          <div className="flex flex-col items-center gap-1">
                            <Badge variant="outline" className="bg-purple-50 text-purple-700 border-purple-200">
                              <Sparkles className="w-3 h-3 mr-1" /> IA
                            </Badge>
                            {(t.debitAccount || t.creditAccount) && (
                              <Button 
                                variant="ghost" 
                                size="sm" 
                                className="h-6 text-xs px-2 text-virgula-green hover:text-emerald-700 hover:bg-virgula-green/10"
                                onClick={() => handleUpdateTransaction(t.id!, t.debitAccount ? 'debitAccount' : 'creditAccount', t.debitAccount || t.creditAccount || '')}
                              >
                                Confirmar
                              </Button>
                            )}
                          </div>
                        ) : (
                          <Badge variant="outline" className="bg-gray-50 text-gray-500">
                            Pendente
                          </Badge>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          ) : (
            <div className="text-center py-12 text-gray-500 border-2 border-dashed rounded-lg bg-gray-50">
              Nenhum lançamento importado. Vá para a aba "Importar OFX" para começar.
            </div>
          )}
        </CardContent>
      </Card>

      {/* AI Assistant Chat */}
      <AIChat 
        companyId={companyId} 
        unmappedTransactions={transactions.filter(t => !t.debitAccount || !t.creditAccount)} 
        accounts={accounts}
        onUpdate={loadData}
      />
    </div>
  );
}
