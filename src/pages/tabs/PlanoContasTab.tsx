import React, { useState, useEffect } from 'react';
import { db, type Account } from '../../lib/db';
import { Button } from '../../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../../components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../components/ui/table';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '../../components/ui/dialog';
import { Upload, FileSpreadsheet, Trash2, Plus, Edit2, ShieldAlert } from 'lucide-react';
import * as XLSX from 'xlsx';
import { formatClassification } from '../../lib/utils';
import { Checkbox } from '../../components/ui/checkbox';
import { parseFileToData } from '../../lib/fileParser';

export default function PlanoContasTab({ companyId }: { companyId: number }) {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(false);
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [editingAccount, setEditingAccount] = useState<Account | null>(null);
  const [formData, setFormData] = useState({ code: '', description: '', classification: '', type: 'A' as 'S' | 'A', isPhysicalAccount: false });

  useEffect(() => {
    loadAccounts();
  }, [companyId]);

  const loadAccounts = async () => {
    const all = await db.accounts.where('companyId').equals(companyId).toArray();
    // Sort by classification
    all.sort((a, b) => a.classification.localeCompare(b.classification));
    setAccounts(all);
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setLoading(true);
    try {
      const rows = await parseFileToData(file);
      
      const newAccounts: Account[] = [];
      const isObjectRow = rows.length > 0 && !Array.isArray(rows[0]) && typeof rows[0] === 'object';
      
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        
        // Handle array of arrays (XLSX, PDF lines) or array of objects (CSV with header)
        let code, desc, classif, type;
        if (isObjectRow) {
           const values = Object.values(row);
           if (values.length >= 4) {
             [code, desc, classif, type] = values;
           }
        } else if (Array.isArray(row) && row.length >= 4) {
           // Skip header if it looks like one
           if (i === 0 && String(row[0]).toLowerCase().includes('código')) continue;
           [code, desc, classif, type] = row;
        }

        if (code && classif) {
          newAccounts.push({
            companyId,
            code: String(code).trim(),
            description: String(desc).trim(),
            classification: formatClassification(String(classif)),
            type: String(type).trim().toUpperCase() === 'S' ? 'S' : 'A',
            isPhysicalAccount: false // Default to false on import, user can edit later
          });
        }
      }

      if (newAccounts.length > 0) {
        await db.accounts.where('companyId').equals(companyId).delete();
        await db.accounts.bulkAdd(newAccounts);
        await loadAccounts();
        alert(`Importado com sucesso: ${newAccounts.length} contas.`);
      } else {
        alert('Nenhuma conta encontrada no arquivo. Verifique as colunas.');
      }
    } catch (error) {
      console.error('Erro ao importar:', error);
      alert('Erro ao importar o arquivo.');
    } finally {
      setLoading(false);
      if (e.target) e.target.value = '';
    }
  };

  const clearAccounts = async () => {
    if (confirm('Tem certeza que deseja apagar todo o plano de contas desta empresa?')) {
      await db.accounts.where('companyId').equals(companyId).delete();
      await loadAccounts();
    }
  };

  const handleDeleteAccount = async (id?: number) => {
    if (!id) return;
    if (confirm('Deseja excluir esta conta?')) {
      await db.accounts.delete(id);
      await loadAccounts();
    }
  };

  const handleSaveAccount = async (e: React.FormEvent) => {
    e.preventDefault();
    const dataToSave = {
      ...formData,
      classification: formatClassification(formData.classification)
    };
    
    if (editingAccount?.id) {
      await db.accounts.update(editingAccount.id, dataToSave);
    } else {
      await db.accounts.add({ ...dataToSave, companyId });
    }
    setIsDialogOpen(false);
    setEditingAccount(null);
    setFormData({ code: '', description: '', classification: '', type: 'A', isPhysicalAccount: false });
    await loadAccounts();
  };

  const openEditDialog = (acc: Account) => {
    setEditingAccount(acc);
    setFormData({
      code: acc.code,
      description: acc.description,
      classification: acc.classification,
      type: acc.type,
      isPhysicalAccount: acc.isPhysicalAccount || false
    });
    setIsDialogOpen(true);
  };

  const openNewDialog = () => {
    setEditingAccount(null);
    setFormData({ code: '', description: '', classification: '', type: 'A', isPhysicalAccount: false });
    setIsDialogOpen(true);
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <FileSpreadsheet className="w-5 h-5 text-virgula-green" />
            Gerenciar Plano de Contas
          </CardTitle>
          <CardDescription>
            Faça o upload de uma planilha Excel (.xlsx) ou adicione contas manualmente.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap items-center gap-4">
            <div className="relative">
              <input
                type="file"
                accept=".xlsx, .xls, .csv, .txt, .pdf"
                onChange={handleFileUpload}
                className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                disabled={loading}
              />
              <Button disabled={loading} className="gap-2 bg-virgula-green hover:bg-emerald-600 text-white">
                <Upload className="w-4 h-4" />
                {loading ? 'Processando...' : 'Importar Arquivo'}
              </Button>
            </div>
            
            <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
              <DialogTrigger asChild>
                <Button onClick={openNewDialog} variant="outline" className="gap-2">
                  <Plus className="w-4 h-4" />
                  Nova Conta
                </Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>{editingAccount ? 'Editar Conta' : 'Nova Conta'}</DialogTitle>
                </DialogHeader>
                <form onSubmit={handleSaveAccount} className="space-y-4 mt-4">
                  <div className="space-y-2">
                    <Label>Código</Label>
                    <Input value={formData.code} onChange={e => setFormData({...formData, code: e.target.value})} required />
                  </div>
                  <div className="space-y-2">
                    <Label>Classificação (ex: 1.1.1.01.001)</Label>
                    <Input 
                      value={formData.classification} 
                      onChange={e => setFormData({...formData, classification: formatClassification(e.target.value)})} 
                      required 
                    />
                  </div>
                  <div className="space-y-2">
                    <Label>Descrição</Label>
                    <Input value={formData.description} onChange={e => setFormData({...formData, description: e.target.value})} required />
                  </div>
                  <div className="space-y-2">
                    <Label>Tipo</Label>
                    <Select value={formData.type} onValueChange={(v: 'S'|'A') => setFormData({...formData, type: v})}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="S">Sintética</SelectItem>
                        <SelectItem value="A">Analítica</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="flex items-center space-x-2 pt-2">
                    <Checkbox 
                      id="isPhysicalAccount" 
                      checked={formData.isPhysicalAccount} 
                      onCheckedChange={(checked) => setFormData({...formData, isPhysicalAccount: !!checked})}
                    />
                    <Label htmlFor="isPhysicalAccount" className="font-normal cursor-pointer">
                      Conta física (não pode negativar, ex: Caixa)
                    </Label>
                  </div>
                  <div className="flex justify-end pt-4">
                    <Button type="submit">Salvar</Button>
                  </div>
                </form>
              </DialogContent>
            </Dialog>

            {accounts.length > 0 && (
              <Button variant="destructive" onClick={clearAccounts} className="gap-2 ml-auto">
                <Trash2 className="w-4 h-4" />
                Limpar Plano
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {accounts.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Contas Cadastradas ({accounts.length})</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="rounded-md border overflow-hidden">
              <Table>
                <TableHeader className="bg-gray-50">
                  <TableRow>
                    <TableHead>Código</TableHead>
                    <TableHead>Classificação</TableHead>
                    <TableHead>Descrição</TableHead>
                    <TableHead>Tipo</TableHead>
                    <TableHead className="text-right">Ações</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {accounts.slice(0, 100).map((acc) => (
                    <TableRow key={acc.id}>
                      <TableCell className="font-mono">{acc.code}</TableCell>
                      <TableCell className="font-mono text-gray-500">{acc.classification}</TableCell>
                      <TableCell>{acc.description}</TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <span className={`px-2 py-1 rounded-full text-xs font-medium ${acc.type === 'S' ? 'bg-virgula-card text-white' : 'bg-virgula-green/20 text-emerald-800'}`}>
                            {acc.type === 'S' ? 'Sintética' : 'Analítica'}
                          </span>
                          {acc.isPhysicalAccount && (
                            <span title="Conta Física (Não pode negativar)" className="text-amber-500">
                              <ShieldAlert className="w-4 h-4" />
                            </span>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="text-right">
                        <Button variant="ghost" size="icon" onClick={() => openEditDialog(acc)}>
                          <Edit2 className="w-4 h-4" />
                        </Button>
                        <Button variant="ghost" size="icon" onClick={() => handleDeleteAccount(acc.id)} className="text-red-500 hover:text-red-700">
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {accounts.length > 100 && (
                <div className="p-4 text-center text-sm text-gray-500 bg-gray-50 border-t">
                  Mostrando as primeiras 100 contas de {accounts.length}.
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      ) : (
        <div className="text-center py-12 text-gray-500 border-2 border-dashed rounded-lg bg-gray-50">
          Nenhum plano de contas importado para esta empresa.
        </div>
      )}
    </div>
  );
}
