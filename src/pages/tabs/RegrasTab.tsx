import React, { useState, useEffect } from 'react';
import { db, type Rule, type Account } from '../../lib/db';
import { Button } from '../../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../../components/ui/card';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../components/ui/table';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../components/ui/select';
import { AccountCombobox } from '../../components/ui/account-combobox';
import { Plus, Trash2, Search } from 'lucide-react';

export default function RegrasTab({ companyId }: { companyId: number }) {
  const [rules, setRules] = useState<Rule[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [newRule, setNewRule] = useState({ keyword: '', accountCode: '', type: 'D' as 'D' | 'C' });
  const [searchTerm, setSearchTerm] = useState('');

  useEffect(() => {
    loadData();
  }, [companyId]);

  const loadData = async () => {
    const allRules = await db.rules.where('companyId').equals(companyId).toArray();
    const allAccounts = await db.accounts.where('companyId').equals(companyId).toArray();
    setRules(allRules);
    setAccounts(allAccounts.filter(a => a.type === 'A')); // Only analytical accounts usually receive entries
  };

  const handleAddRule = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newRule.keyword || !newRule.accountCode) return;

    await db.rules.add({
      companyId,
      keyword: newRule.keyword,
      accountCode: newRule.accountCode,
      type: newRule.type,
    });
    setNewRule({ keyword: '', accountCode: '', type: 'D' });
    loadData();
  };

  const handleDeleteRule = async (id?: number) => {
    if (id) {
      await db.rules.delete(id);
      loadData();
    }
  };

  const filteredRules = rules.filter(r => 
    r.keyword.toLowerCase().includes(searchTerm.toLowerCase()) || 
    r.accountCode.includes(searchTerm)
  );

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Adicionar Vínculo Contábil</CardTitle>
          <CardDescription>
            Defina palavras-chave que aparecem no histórico do extrato OFX para associar automaticamente a uma conta contábil.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleAddRule} className="grid grid-cols-1 md:grid-cols-4 gap-4 items-end">
            <div className="space-y-2">
              <Label htmlFor="keyword">Palavra-chave (Ex: Banco do Brasil)</Label>
              <Input
                id="keyword"
                value={newRule.keyword}
                onChange={(e) => setNewRule({ ...newRule, keyword: e.target.value })}
                placeholder="Texto do histórico"
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="type">Tipo de Lançamento</Label>
              <Select value={newRule.type} onValueChange={(v: 'D' | 'C') => setNewRule({ ...newRule, type: v })}>
                <SelectTrigger>
                  <SelectValue placeholder="Selecione o tipo" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="D">Débito (Saída)</SelectItem>
                  <SelectItem value="C">Crédito (Entrada)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="account">Conta Contábil</Label>
              <AccountCombobox
                accounts={accounts}
                value={newRule.accountCode}
                onChange={(v) => setNewRule({ ...newRule, accountCode: v })}
                placeholder="Selecione a conta"
              />
            </div>
            <Button type="submit" className="gap-2">
              <Plus className="w-4 h-4" />
              Adicionar Regra
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>Regras Cadastradas ({rules.length})</CardTitle>
          <div className="relative w-64">
            <Search className="absolute left-2 top-2.5 h-4 w-4 text-gray-500" />
            <Input
              placeholder="Buscar regra..."
              className="pl-8"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
            />
          </div>
        </CardHeader>
        <CardContent>
          {rules.length > 0 ? (
            <div className="rounded-md border overflow-hidden">
              <Table>
                <TableHeader className="bg-gray-50">
                  <TableRow>
                    <TableHead>Palavra-chave</TableHead>
                    <TableHead>Tipo</TableHead>
                    <TableHead>Conta Contábil</TableHead>
                    <TableHead className="w-24 text-right">Ações</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredRules.map((rule) => {
                    const acc = accounts.find(a => a.code === rule.accountCode);
                    return (
                      <TableRow key={rule.id}>
                        <TableCell className="font-medium">{rule.keyword}</TableCell>
                        <TableCell>
                          <span className={`px-2 py-1 rounded-full text-xs font-medium ${rule.type === 'D' ? 'bg-red-100 text-red-800' : 'bg-virgula-green/20 text-emerald-800'}`}>
                            {rule.type === 'D' ? 'Débito' : 'Crédito'}
                          </span>
                        </TableCell>
                        <TableCell>
                          <span className="font-mono text-gray-500 mr-2">{rule.accountCode}</span>
                          {acc?.description || 'Conta não encontrada'}
                        </TableCell>
                        <TableCell className="text-right">
                          <Button variant="ghost" size="icon" onClick={() => handleDeleteRule(rule.id)} className="text-red-500 hover:text-red-700 hover:bg-red-50">
                            <Trash2 className="w-4 h-4" />
                          </Button>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          ) : (
            <div className="text-center py-8 text-gray-500">
              Nenhuma regra cadastrada.
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
