import React, { useState, useEffect } from 'react';
import { db, type AuditFinding, type LedgerEntry, type Account } from '../../lib/db';
import { parseFileToData } from '../../lib/fileParser';
import { parseLedgerData, runDeterministicAudit, runAIAudit, runFullAIAudit } from '../../lib/auditEngine';
import { Button } from '../../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../../components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../components/ui/select';
import { Upload, Play, ShieldAlert, Sparkles, CheckCircle2, ChevronDown, ChevronUp, FileText, Download } from 'lucide-react';

export default function AuditoriaMensalTab({ companyId }: { companyId: number }) {
  const [period, setPeriod] = useState<string>('');
  const [periods, setPeriods] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [progressText, setProgressText] = useState('');
  const [findings, setFindings] = useState<AuditFinding[]>([]);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [relatedEntries, setRelatedEntries] = useState<LedgerEntry[]>([]);

  useEffect(() => {
    loadPeriods();
  }, [companyId]);

  useEffect(() => {
    if (period) {
      loadFindings();
    }
  }, [period]);

  const loadPeriods = async () => {
    const entries = await db.ledgerEntries.where('companyId').equals(companyId).toArray();
    const uniquePeriods = Array.from(new Set(entries.map(e => e.period))).sort().reverse();
    setPeriods(uniquePeriods);
    if (uniquePeriods.length > 0 && !period) {
      setPeriod(uniquePeriods[0]);
    }
  };

  const loadFindings = async () => {
    const data = await db.auditFindings
      .where('companyId').equals(companyId)
      .and(f => f.period === period)
      .toArray();
    setFindings(data);
  };

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>, source: 'balancete' | 'razao') => {
    const file = e.target.files?.[0];
    if (!file || !period) return;
    
    setLoading(true);
    setProgressText(`Importando ${source}...`);
    try {
      const rawData = await parseFileToData(file);
      const entries = await parseLedgerData(companyId, period, source, rawData);
      
      if (entries.length > 0) {
        // Clear existing for same period and source
        await db.ledgerEntries
          .where('companyId').equals(companyId)
          .and(en => en.period === period && en.source === source)
          .delete();
          
        await db.ledgerEntries.bulkAdd(entries);
        alert(`${entries.length} lançamentos de ${source} importados.`);
        loadPeriods();
      } else {
        alert('Nenhum dado reconhecido no arquivo.');
      }
    } catch (error) {
      console.error(error);
      alert(`Erro ao importar ${source}.`);
    } finally {
      setLoading(false);
      setProgressText('');
      if (e.target) e.target.value = '';
    }
  };

  const handleRunAudit = async () => {
    if (!period) return;
    setLoading(true);
    try {
      setProgressText('Executando motor determinístico...');
      // Clear old findings
      await db.auditFindings
        .where('companyId').equals(companyId)
        .and(f => f.period === period && !f.category.startsWith('Varredura Completa'))
        .delete();
        
      const { findings: deterministicFindings, unmatchedPool } = await runDeterministicAudit(companyId, period);
      if (deterministicFindings.length > 0) {
        await db.auditFindings.bulkAdd(deterministicFindings);
      }
      
      setProgressText('Enviando pendências para análise da IA...');
      const aiFindings = await runAIAudit(companyId, period, unmatchedPool, setProgressText);
      if (aiFindings.length > 0) {
        await db.auditFindings.bulkAdd(aiFindings);
      }
      
      await loadFindings();
      alert('Auditoria concluída com sucesso!');
    } catch (error) {
      console.error(error);
      alert('Erro ao executar auditoria.');
    } finally {
      setLoading(false);
      setProgressText('');
    }
  };

  const handleFullAiScan = async () => {
    if (!period) return;
    setLoading(true);
    try {
      setProgressText('Iniciando varredura completa...');
      // Clear old full scan findings
      await db.auditFindings
        .where('companyId').equals(companyId)
        .and(f => f.period === period && f.category.startsWith('Varredura Completa'))
        .delete();
        
      const fullScanFindings = await runFullAIAudit(companyId, period, setProgressText);
      if (fullScanFindings.length > 0) {
        await db.auditFindings.bulkAdd(fullScanFindings);
      }
      await loadFindings();
      alert('Varredura completa concluída!');
    } catch (error) {
      console.error(error);
      alert('Erro ao executar varredura completa.');
    } finally {
      setLoading(false);
      setProgressText('');
    }
  };

  const markResolved = async (id: number, resolved: boolean) => {
    await db.auditFindings.update(id, { resolved });
    await loadFindings();
  };
  
  const handleExpand = async (finding: AuditFinding) => {
    if (expandedId === finding.id) {
       setExpandedId(null);
       setRelatedEntries([]);
    } else {
       setExpandedId(finding.id as number);
       if (finding.relatedEntryIds && finding.relatedEntryIds.length > 0) {
          const entries = await db.ledgerEntries.where('id').anyOf(finding.relatedEntryIds).toArray();
          setRelatedEntries(entries);
       } else {
          setRelatedEntries([]);
       }
    }
  };

  const handleExportReport = () => {
    let report = `Relatório de Auditoria - ${period}\n\n`;
    
    report += `Críticos (${criticalFindings.length})\n`;
    criticalFindings.forEach(f => {
        report += `- [${f.resolved ? 'x' : ' '}] ${f.category}: ${f.description}\n`;
        if (f.suggestedAdjustment) {
            report += `  Sugestão: D ${f.suggestedAdjustment.debitAccountCode} | C ${f.suggestedAdjustment.creditAccountCode} | R$ ${f.suggestedAdjustment.amount.toFixed(2)}\n`;
        }
    });

    report += `\nModerados (${moderateFindings.length})\n`;
    moderateFindings.forEach(f => {
        report += `- [${f.resolved ? 'x' : ' '}] ${f.category}: ${f.description}\n`;
    });

    report += `\nObservações (${otherFindings.length})\n`;
    otherFindings.forEach(f => {
        report += `- [${f.resolved ? 'x' : ' '}] ${f.category}: ${f.description}\n`;
    });

    const blob = new Blob([report], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `auditoria_${period}.txt`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const renderFindingCard = (finding: AuditFinding) => {
    const isExpanded = expandedId === finding.id;
    const isCritical = finding.severity === 'critical';
    const isModerate = finding.severity === 'moderate';
    
    let borderColor = 'border-gray-200';
    let icon = <ShieldAlert className="w-5 h-5 text-gray-400" />;
    
    if (isCritical) {
      borderColor = 'border-red-500';
      icon = <ShieldAlert className="w-5 h-5 text-red-500" />;
    } else if (isModerate) {
      borderColor = 'border-amber-500';
      icon = <ShieldAlert className="w-5 h-5 text-amber-500" />;
    }
    
    if (finding.suggestedAdjustment) {
      icon = <Sparkles className="w-5 h-5 text-purple-600" />;
      borderColor = 'border-purple-300';
    }

    return (
      <Card key={finding.id} className={`mb-4 ${borderColor} ${finding.resolved ? 'opacity-60 bg-gray-50' : ''}`}>
        <div 
          className="p-4 flex items-start justify-between cursor-pointer hover:bg-gray-50/50 transition-colors"
          onClick={() => handleExpand(finding)}
        >
          <div className="flex gap-4 items-start">
            <div className="mt-1">{icon}</div>
            <div>
              <h4 className="font-semibold text-gray-900 flex items-center gap-2">
                {finding.category}
                {finding.resolved && <span className="text-xs bg-gray-200 text-gray-600 px-2 py-0.5 rounded-full">Revisado</span>}
              </h4>
              <p className="text-sm text-gray-600 mt-1">{finding.description}</p>
              {finding.accountsInvolved.length > 0 && (
                <div className="flex gap-2 mt-2">
                  {finding.accountsInvolved.map(acc => (
                    <span key={acc} className="text-xs bg-gray-100 border px-2 py-1 rounded text-gray-600 font-mono">
                      {acc}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>
          <div className="flex items-center gap-4">
            <Button
              variant={finding.resolved ? "outline" : "default"}
              size="sm"
              onClick={(e) => {
                e.stopPropagation();
                markResolved(finding.id as number, !finding.resolved);
              }}
              className={finding.resolved ? "" : "bg-virgula-green hover:bg-emerald-600"}
            >
              <CheckCircle2 className="w-4 h-4 mr-2" />
              {finding.resolved ? 'Desmarcar' : 'Marcar Revisado'}
            </Button>
            {isExpanded ? <ChevronUp className="w-5 h-5 text-gray-400" /> : <ChevronDown className="w-5 h-5 text-gray-400" />}
          </div>
        </div>
        
        {isExpanded && (
          <div className="px-4 pb-4 pt-2 border-t border-gray-100 bg-gray-50">
            {relatedEntries.length > 1 ? (
              <div className="mb-4">
                <h5 className="text-xs font-semibold text-gray-500 uppercase mb-2">Lançamentos Envolvidos</h5>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {relatedEntries.map((re, idx) => (
                    <div key={re.id} className="bg-white p-3 rounded border text-sm">
                      <div className="font-semibold mb-1 text-gray-800">Lançamento {idx === 0 ? 'A (Origem)' : 'B (Destino)'}</div>
                      <div className="grid grid-cols-2 gap-x-2 text-xs">
                        <span className="text-gray-500">Conta:</span> <span className="font-mono">{re.accountCode}</span>
                        <span className="text-gray-500">Data:</span> <span>{re.date}</span>
                        <span className="text-gray-500">Valor:</span> <span>R$ {Math.max(re.debit, re.credit).toFixed(2)}</span>
                      </div>
                      <div className="mt-2 text-gray-700 font-mono text-xs p-2 bg-gray-50 rounded">
                        {re.history}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : finding.historyExtract && (
              <div className="mb-4">
                <h5 className="text-xs font-semibold text-gray-500 uppercase mb-2">Trecho do Histórico Analisado</h5>
                <div className="bg-white p-3 rounded border text-sm font-mono text-gray-700 whitespace-pre-wrap">
                  {finding.historyExtract}
                </div>
              </div>
            )}
            
            {finding.suggestedAdjustment && (
              <div className="bg-purple-50 border border-purple-100 rounded p-4">
                <h5 className="text-sm font-semibold text-purple-900 mb-3 flex items-center gap-2">
                  <Sparkles className="w-4 h-4" />
                  Sugestão de Lançamento de Ajuste (IA)
                </h5>
                <div className="grid grid-cols-2 gap-4 text-sm">
                  <div><span className="text-gray-500">Débito:</span> <span className="font-mono">{finding.suggestedAdjustment.debitAccountCode}</span></div>
                  <div><span className="text-gray-500">Crédito:</span> <span className="font-mono">{finding.suggestedAdjustment.creditAccountCode}</span></div>
                  <div><span className="text-gray-500">Valor:</span> R$ {finding.suggestedAdjustment.amount.toFixed(2)}</div>
                  <div className="col-span-2"><span className="text-gray-500">Histórico Sugerido:</span> {finding.suggestedAdjustment.history}</div>
                  <div className="col-span-2"><span className="text-gray-500">Motivo:</span> {finding.suggestedAdjustment.reason}</div>
                </div>
              </div>
            )}
          </div>
        )}
      </Card>
    );
  };

  const criticalFindings = findings.filter(f => f.severity === 'critical');
  const moderateFindings = findings.filter(f => f.severity === 'moderate');
  const otherFindings = findings.filter(f => f.severity === 'observation');
  const aiSuggestions = findings.filter(f => f.suggestedAdjustment);

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <FileText className="w-5 h-5 text-virgula-green" />
            Auditoria Mensal
          </CardTitle>
          <CardDescription>
            Importe o Balancete e Razão do mês para cruzar informações e identificar anomalias na escrituração.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col md:flex-row gap-6 mb-6">
            <div className="flex-1 space-y-2">
              <label className="text-sm font-medium">Período de Análise</label>
              <div className="flex gap-2">
                <input 
                  type="month" 
                  value={period} 
                  onChange={e => setPeriod(e.target.value)}
                  className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                />
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-4 border-t pt-6">
            <div className="relative">
              <input
                type="file"
                accept=".xlsx, .xls, .csv, .txt, .pdf"
                onChange={(e) => handleUpload(e, 'balancete')}
                className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                disabled={loading || !period}
              />
              <Button disabled={loading || !period} variant="outline" className="gap-2">
                <Upload className="w-4 h-4" />
                Importar Balancete
              </Button>
            </div>

            <div className="relative">
              <input
                type="file"
                accept=".xlsx, .xls, .csv, .txt, .pdf"
                onChange={(e) => handleUpload(e, 'razao')}
                className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                disabled={loading || !period}
              />
              <Button disabled={loading || !period} variant="outline" className="gap-2">
                <Upload className="w-4 h-4" />
                Importar Razão
              </Button>
            </div>

            <div className="ml-auto flex items-center gap-3">
              <div className="flex flex-col items-center">
                <Button 
                  onClick={handleFullAiScan} 
                  disabled={loading || !period} 
                  variant="outline"
                  className="gap-2 border-purple-200 text-purple-700 hover:bg-purple-50 hover:text-purple-800"
                >
                  {loading ? (
                    <div className="w-4 h-4 border-2 border-purple-600 border-t-transparent rounded-full animate-spin" />
                  ) : (
                    <Sparkles className="w-4 h-4" />
                  )}
                  Varredura Completa por IA
                </Button>
                <span className="text-[10px] text-gray-400 mt-1">Lento (varre 100% dos lançamentos)</span>
              </div>

              <Button 
                onClick={handleRunAudit} 
                disabled={loading || !period} 
                className="gap-2 bg-virgula-green hover:bg-emerald-600 text-white"
              >
                {loading ? (
                  <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                ) : (
                  <Play className="w-4 h-4" />
                )}
                Rodar Auditoria
              </Button>
            </div>
          </div>
          
          {progressText && (
            <div className="mt-4 text-sm text-center text-gray-500 animate-pulse">
              {progressText}
            </div>
          )}
        </CardContent>
      </Card>

      {findings.length > 0 && (
        <div className="space-y-6">
          <div className="flex justify-between items-center">
            <h3 className="text-lg font-semibold text-gray-900">Resultados da Auditoria ({period})</h3>
            <Button variant="outline" size="sm" onClick={handleExportReport} className="gap-2">
              <Download className="w-4 h-4" />
              Exportar Relatório
            </Button>
          </div>

          {criticalFindings.length > 0 && (
            <div>
              <h4 className="text-red-600 font-medium mb-3 flex items-center gap-2">
                <ShieldAlert className="w-4 h-4" />
                Críticos ({criticalFindings.length})
              </h4>
              {criticalFindings.map(renderFindingCard)}
            </div>
          )}

          {moderateFindings.length > 0 && (
            <div>
              <h4 className="text-amber-600 font-medium mb-3 flex items-center gap-2">
                <ShieldAlert className="w-4 h-4" />
                Moderados ({moderateFindings.length})
              </h4>
              {moderateFindings.map(renderFindingCard)}
            </div>
          )}

          {otherFindings.length > 0 && (
            <div>
              <h4 className="text-gray-600 font-medium mb-3">Observações ({otherFindings.length})</h4>
              {otherFindings.map(renderFindingCard)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

