import React, { useState } from 'react';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Label } from '../components/ui/label';
import { Checkbox } from '../components/ui/checkbox';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../components/ui/card';
import { Calculator } from 'lucide-react';

interface LoginProps {
  onLogin: (remember: boolean) => void;
}

export default function Login({ onLogin }: LoginProps) {
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const envPassword = import.meta.env.VITE_APP_PASSWORD || 'admin';
    
    if (password === envPassword) {
      onLogin(remember);
    } else {
      setError('Senha incorreta');
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-100 p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <div className="flex justify-center mb-6">
            <div className="flex items-center space-x-4 scale-125">
              <div className="w-12 h-12 bg-virgula-card rounded-xl border border-white/10 flex items-center justify-center text-virgula-green shadow-[0_0_20px_rgba(16,185,129,0.25)]">
                <Calculator className="w-8 h-8" strokeWidth={2.5} />
              </div>
              <div className="flex flex-col justify-center text-left">
                <span className="text-3xl font-bold text-slate-900 tracking-tight leading-none mb-0.5">Vírgula</span>
                <span className="text-base font-semibold text-virgula-green tracking-widest leading-none uppercase">Contábil</span>
              </div>
            </div>
          </div>
          <CardDescription>Digite a senha para acessar o sistema</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="password">Senha</Label>
              <Input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
              {error && <p className="text-sm text-red-500">{error}</p>}
            </div>
            <div className="flex items-center space-x-2">
              <Checkbox 
                id="remember" 
                checked={remember}
                onCheckedChange={(checked) => setRemember(checked as boolean)}
              />
              <Label htmlFor="remember" className="text-sm font-normal cursor-pointer">
                Permanecer conectado
              </Label>
            </div>
            <Button type="submit" className="w-full bg-virgula-green hover:bg-emerald-600 text-white">
              Entrar
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
