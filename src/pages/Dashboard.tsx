import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { db, type Company } from '../lib/db';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Textarea } from '../components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '../components/ui/dialog';
import { Building2, Plus, ArrowRight } from 'lucide-react';

const formatCNPJ = (value: string) => {
  let v = value.replace(/\D/g, '');
  if (v.length > 14) v = v.substring(0, 14);
  
  v = v.replace(/^(\d{2})(\d)/, '$1.$2');
  v = v.replace(/^(\d{2})\.(\d{3})(\d)/, '$1.$2.$3');
  v = v.replace(/\.(\d{3})(\d)/, '.$1/$2');
  v = v.replace(/(\d{4})(\d)/, '$1-$2');
  
  return v;
};

export default function Dashboard() {
  const [companies, setCompanies] = useState<Company[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [newCompany, setNewCompany] = useState({ name: '', cnpj: '', description: '' });

  useEffect(() => {
    loadCompanies();
  }, []);

  const loadCompanies = async () => {
    const all = await db.companies.toArray();
    setCompanies(all);
  };

  const handleAddCompany = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newCompany.name || !newCompany.cnpj) return;

    await db.companies.add(newCompany);
    setNewCompany({ name: '', cnpj: '', description: '' });
    setIsOpen(false);
    loadCompanies();
  };

  return (
    <div className="p-8 max-w-6xl mx-auto">
      <div className="flex justify-between items-center mb-8">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">Empresas Clientes</h1>
          <p className="text-gray-500 mt-1">Gerencie suas empresas e importações contábeis</p>
        </div>

        <Dialog open={isOpen} onOpenChange={setIsOpen}>
          <DialogTrigger asChild>
            <Button className="gap-2 bg-virgula-green hover:bg-emerald-600 text-white">
              <Plus className="w-4 h-4" />
              Nova Empresa
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Cadastrar Nova Empresa</DialogTitle>
            </DialogHeader>
            <form onSubmit={handleAddCompany} className="space-y-4 mt-4">
              <div className="space-y-2">
                <Label htmlFor="name">Razão Social / Nome</Label>
                <Input
                  id="name"
                  value={newCompany.name}
                  onChange={(e) => setNewCompany({ ...newCompany, name: e.target.value })}
                  placeholder="Ex: Empresa Exemplo LTDA"
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="cnpj">CNPJ</Label>
                <Input
                  id="cnpj"
                  value={newCompany.cnpj}
                  onChange={(e) => setNewCompany({ ...newCompany, cnpj: formatCNPJ(e.target.value) })}
                  placeholder="XX.XXX.XXX/XXXX-XX"
                  maxLength={18}
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="description">Descrição (Para IA)</Label>
                <Textarea
                  id="description"
                  value={newCompany.description}
                  onChange={(e) => setNewCompany({ ...newCompany, description: e.target.value })}
                  placeholder="Descreva o ramo de atuação e particularidades da empresa para ajudar a IA na conciliação..."
                  rows={3}
                />
              </div>
              <div className="flex justify-end pt-4">
                <Button type="submit" className="bg-virgula-green hover:bg-emerald-600 text-white">Salvar Empresa</Button>
              </div>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      {companies.length === 0 ? (
        <Card className="border-dashed border-2 bg-gray-50">
          <CardContent className="flex flex-col items-center justify-center py-16 text-center">
            <div className="w-16 h-16 bg-virgula-card text-virgula-green rounded-full flex items-center justify-center mb-4 shadow-[0_0_20px_rgba(16,185,129,0.25)]">
              <Building2 className="w-8 h-8" />
            </div>
            <h3 className="text-xl font-semibold text-gray-900 mb-2">Nenhuma empresa cadastrada</h3>
            <p className="text-gray-500 max-w-sm mb-6">
              Comece cadastrando sua primeira empresa cliente para importar o plano de contas e os extratos OFX.
            </p>
            <Button onClick={() => setIsOpen(true)} className="bg-virgula-green hover:bg-emerald-600 text-white">Cadastrar Empresa</Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
          {companies.map((company) => (
            <Card key={company.id} className="hover:shadow-md transition-shadow">
              <CardHeader className="pb-4">
                <CardTitle className="text-lg flex items-center gap-2">
                  <Building2 className="w-5 h-5 text-gray-400" />
                  {company.name}
                </CardTitle>
                <p className="text-sm text-gray-500 font-mono">{company.cnpj}</p>
              </CardHeader>
              <CardContent>
                <Link to={`/company/${company.id}`}>
                  <Button variant="outline" className="w-full gap-2 hover:bg-virgula-green/10 hover:text-virgula-green hover:border-virgula-green transition-colors">
                    Acessar Painel
                    <ArrowRight className="w-4 h-4" />
                  </Button>
                </Link>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
