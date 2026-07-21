import React, { useState, useEffect } from 'react';
import { BrowserRouter as Router, Routes, Route, Link } from 'react-router-dom';
import { Home, LogOut, Calculator } from 'lucide-react';
import Dashboard from './pages/Dashboard';
import CompanyDetails from './pages/CompanyDetails';
import Login from './pages/Login';
import { restoreFromBackup } from './lib/backup';

export default function App() {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isInitializing, setIsInitializing] = useState(true);

  useEffect(() => {
    const initApp = async () => {
      const isLogged = localStorage.getItem('isLogged') === 'true' || sessionStorage.getItem('isLogged') === 'true';
      if (isLogged) {
        setIsAuthenticated(true);
      }
      
      // Auto-restore from server on startup to ensure persistence across deploys
      try {
        await restoreFromBackup();
        console.log('Auto-restored from backup server.');
      } catch (e) {
        console.error('Failed to auto-restore:', e);
      } finally {
        setIsInitializing(false);
      }
    };
    
    initApp();
  }, []);

  const handleLogin = (remember: boolean) => {
    setIsAuthenticated(true);
    if (remember) {
      localStorage.setItem('isLogged', 'true');
    } else {
      sessionStorage.setItem('isLogged', 'true');
    }
  };

  const handleLogout = () => {
    setIsAuthenticated(false);
    localStorage.removeItem('isLogged');
    sessionStorage.removeItem('isLogged');
  };

  if (isInitializing) {
    return (
      <div className="flex h-screen items-center justify-center bg-gray-100">
        <div className="flex flex-col items-center space-y-4">
          <div className="w-12 h-12 border-4 border-virgula-green border-t-transparent rounded-full animate-spin"></div>
          <p className="text-gray-600 font-medium">Sincronizando banco de dados...</p>
        </div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Login onLogin={handleLogin} />;
  }

  return (
    <Router>
      <div className="flex h-screen bg-gray-100">
        {/* Sidebar */}
        <aside className="w-64 bg-white border-r border-gray-200 flex flex-col">
          <div className="p-6 border-b border-gray-200 flex items-center justify-center">
            <div className="flex items-center space-x-3">
              <div className="w-10 h-10 bg-virgula-card rounded-xl border border-white/10 flex items-center justify-center text-virgula-green shadow-[0_0_15px_rgba(16,185,129,0.25)]">
                <Calculator className="w-6 h-6" strokeWidth={2.5} />
              </div>
              <div className="flex flex-col justify-center">
                <span className="text-2xl font-bold text-slate-900 tracking-tight leading-none mb-0.5">Vírgula</span>
                <span className="text-xs font-semibold text-virgula-green tracking-widest leading-none uppercase">Contábil</span>
              </div>
            </div>
          </div>
          <nav className="flex-1 p-4 space-y-2">
            <Link
              to="/"
              className="flex items-center gap-3 px-4 py-3 text-gray-700 rounded-lg hover:bg-virgula-green/10 hover:text-virgula-green transition-colors"
            >
              <Home className="w-5 h-5" />
              Empresas
            </Link>
          </nav>
          <div className="p-4 border-t border-gray-200">
            <button
              onClick={handleLogout}
              className="flex items-center gap-3 px-4 py-3 text-red-600 rounded-lg hover:bg-red-50 w-full transition-colors"
            >
              <LogOut className="w-5 h-5" />
              Sair
            </button>
          </div>
        </aside>

        {/* Main Content */}
        <main className="flex-1 overflow-auto">
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/company/:id" element={<CompanyDetails />} />
          </Routes>
        </main>
      </div>
    </Router>
  );
}
