import React, { useState, useRef, useEffect } from 'react';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { Sparkles, X, Send, Bot, User, Loader2 } from 'lucide-react';
import { db, type Transaction, type Account, type Rule } from '../lib/db';
import { GoogleGenAI, Type } from '@google/genai';

interface AIChatProps {
  companyId: number;
  unmappedTransactions: Transaction[];
  accounts: Account[];
  onUpdate: () => void;
}

interface Message {
  id: string;
  role: 'user' | 'ai';
  content: string;
}

export function AIChat({ companyId, unmappedTransactions, accounts, onUpdate }: AIChatProps) {
  const [isOpen, setIsOpen] = useState(unmappedTransactions.length > 0);
  const [hasAutoOpened, setHasAutoOpened] = useState(false);

  useEffect(() => {
    if (unmappedTransactions.length > 0 && !hasAutoOpened) {
      setIsOpen(true);
      setHasAutoOpened(true);
    }
  }, [unmappedTransactions.length, hasAutoOpened]);
  const [messages, setMessages] = useState<Message[]>([
    {
      id: '1',
      role: 'ai',
      content: 'Olá! Eu sou o assistente de conciliação. Me explique o que são os lançamentos não mapeados e eu farei os vínculos e criarei as regras para você. Ex: "Pgto de luz é conta de energia elétrica, debita em despesas com energia e credita no banco".'
    }
  ]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, isOpen]);

  const handleSend = async () => {
    if (!input.trim() || isLoading) return;

    const userMessage = input.trim();
    setInput('');
    setMessages(prev => [...prev, { id: Date.now().toString(), role: 'user', content: userMessage }]);
    setIsLoading(true);

    try {
      const apiKey = process.env.GEMINI_API_KEY;
      if (!apiKey) {
        throw new Error('Chave da API do Gemini não configurada.');
      }

      const ai = new GoogleGenAI({ apiKey });

      // Prepare context
      const txContext = unmappedTransactions.map(t => 
        `ID: ${t.id} | Data: ${t.date} | Histórico: ${t.description} | Valor: ${t.amount} | Tipo: ${t.type}`
      ).join('\n');

      const accContext = accounts.map(a => 
        `Código: ${a.code} | Classificação: ${a.classification} | Descrição: ${a.description}`
      ).join('\n');

      const prompt = `
Você é um assistente contábil especialista. O usuário está explicando como mapear lançamentos bancários (OFX) para contas contábeis.
Baseado na explicação do usuário, você deve identificar quais lançamentos não mapeados correspondem à explicação e sugerir a conta de débito e crédito, além de criar uma regra para o futuro.

Explicação do usuário: "${userMessage}"

Lançamentos não mapeados disponíveis:
${txContext}

Plano de Contas disponível (use o Código da conta):
${accContext}

Retorne um JSON com as ações a serem tomadas. O JSON deve seguir este schema:
{
  "actions": [
    {
      "transactionIds": [1, 2], // IDs dos lançamentos a serem atualizados
      "debitAccount": "código da conta de débito (ex: 123)",
      "creditAccount": "código da conta de crédito (ex: 456)",
      "ruleKeyword": "PALAVRA CHAVE PARA REGRA FUTURA (ex: ENERGIA)",
      "ruleType": "D ou C (D para saída de dinheiro/pagamento, C para entrada/recebimento)",
      "ruleAccountCode": "código da conta de contrapartida (a conta que não é o banco)",
      "explanation": "Breve explicação do que foi feito para mostrar ao usuário"
    }
  ],
  "reply": "Mensagem amigável para responder ao usuário confirmando o que foi feito ou pedindo mais detalhes se não encontrou."
}
`;

      const response = await ai.models.generateContent({
        model: 'gemini-3-flash-preview',
        contents: prompt,
        config: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              actions: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    transactionIds: { type: Type.ARRAY, items: { type: Type.NUMBER } },
                    debitAccount: { type: Type.STRING },
                    creditAccount: { type: Type.STRING },
                    ruleKeyword: { type: Type.STRING },
                    ruleType: { type: Type.STRING },
                    ruleAccountCode: { type: Type.STRING },
                    explanation: { type: Type.STRING }
                  },
                  required: ['transactionIds', 'debitAccount', 'creditAccount', 'ruleKeyword', 'ruleType', 'ruleAccountCode', 'explanation']
                }
              },
              reply: { type: Type.STRING }
            },
            required: ['actions', 'reply']
          }
        }
      });

      let resultText = response.text;
      if (!resultText) throw new Error('Resposta vazia da IA');
      
      // Remove markdown formatting if present
      resultText = resultText.replace(/```json/g, '').replace(/```/g, '').trim();

      const result = JSON.parse(resultText);

      // Apply actions
      let updatedCount = 0;
      let rulesCreated = 0;

      if (result.actions && result.actions.length > 0) {
        for (const action of result.actions) {
          // Update transactions
          for (const txId of action.transactionIds) {
            await db.transactions.update(txId, {
              debitAccount: action.debitAccount,
              creditAccount: action.creditAccount,
              reconciled: true,
              aiSuggestion: true,
              aiReason: action.explanation
            });
            updatedCount++;
          }

          // Create rule
          if (action.ruleKeyword && action.ruleAccountCode && action.ruleType) {
            await db.rules.add({
              companyId,
              keyword: action.ruleKeyword,
              accountCode: action.ruleAccountCode,
              type: action.ruleType as 'D' | 'C'
            });
            rulesCreated++;
          }
        }
      }

      setMessages(prev => [...prev, { 
        id: Date.now().toString(), 
        role: 'ai', 
        content: result.reply + (updatedCount > 0 ? `\n\n✅ ${updatedCount} lançamento(s) atualizado(s) e ${rulesCreated} regra(s) criada(s).` : '')
      }]);

      if (updatedCount > 0) {
        onUpdate();
      }

    } catch (error) {
      console.error('Erro na IA:', error);
      setMessages(prev => [...prev, { 
        id: Date.now().toString(), 
        role: 'ai', 
        content: 'Desculpe, ocorreu um erro ao processar sua solicitação. Tente novamente.' 
      }]);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <>
      {/* Floating Button */}
      {!isOpen && (
        <Button
          onClick={() => setIsOpen(true)}
          className="fixed bottom-6 right-6 h-14 w-14 rounded-full shadow-lg bg-virgula-green hover:bg-emerald-600 text-white flex items-center justify-center z-50 transition-transform hover:scale-105"
        >
          <Sparkles className="w-6 h-6" />
          {unmappedTransactions.length > 0 && (
            <span className="absolute -top-2 -right-2 bg-red-500 text-white text-xs font-bold w-6 h-6 rounded-full flex items-center justify-center border-2 border-white">
              {unmappedTransactions.length}
            </span>
          )}
        </Button>
      )}

      {/* Chat Window */}
      {isOpen && (
        <Card className="fixed bottom-6 right-6 w-96 h-[500px] shadow-2xl flex flex-col z-50 border-virgula-green/20 overflow-hidden animate-in slide-in-from-bottom-5">
          <CardHeader className="bg-virgula-card text-white py-3 px-4 flex flex-row items-center justify-between rounded-t-xl border-b-0 space-y-0">
            <div className="flex items-center gap-2">
              <Sparkles className="w-5 h-5 text-virgula-green" />
              <CardTitle className="text-base font-medium">Assistente IA</CardTitle>
            </div>
            <Button variant="ghost" size="icon" onClick={() => setIsOpen(false)} className="text-gray-300 hover:text-white hover:bg-white/10 h-8 w-8">
              <X className="w-4 h-4" />
            </Button>
          </CardHeader>
          
          <CardContent className="flex-1 p-0 flex flex-col bg-gray-50 overflow-hidden">
            {/* Messages Area */}
            <div className="flex-1 overflow-y-auto p-4 space-y-4">
              {messages.map((msg) => (
                <div key={msg.id} className={`flex gap-3 ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                  {msg.role === 'ai' && (
                    <div className="w-8 h-8 rounded-full bg-virgula-green/20 flex items-center justify-center shrink-0">
                      <Bot className="w-4 h-4 text-emerald-700" />
                    </div>
                  )}
                  <div className={`px-4 py-2 rounded-2xl max-w-[80%] text-sm ${
                    msg.role === 'user' 
                      ? 'bg-virgula-green text-white rounded-tr-sm' 
                      : 'bg-white border border-gray-200 text-gray-700 rounded-tl-sm shadow-sm whitespace-pre-wrap'
                  }`}>
                    {msg.content}
                  </div>
                  {msg.role === 'user' && (
                    <div className="w-8 h-8 rounded-full bg-gray-200 flex items-center justify-center shrink-0">
                      <User className="w-4 h-4 text-gray-500" />
                    </div>
                  )}
                </div>
              ))}
              {isLoading && (
                <div className="flex gap-3 justify-start">
                  <div className="w-8 h-8 rounded-full bg-virgula-green/20 flex items-center justify-center shrink-0">
                    <Bot className="w-4 h-4 text-emerald-700" />
                  </div>
                  <div className="px-4 py-3 rounded-2xl bg-white border border-gray-200 rounded-tl-sm shadow-sm flex items-center gap-2">
                    <Loader2 className="w-4 h-4 animate-spin text-virgula-green" />
                    <span className="text-sm text-gray-500">Processando...</span>
                  </div>
                </div>
              )}
              <div ref={messagesEndRef} />
            </div>

            {/* Input Area */}
            <div className="p-3 bg-white border-t border-gray-200">
              <form 
                onSubmit={(e) => { e.preventDefault(); handleSend(); }}
                className="flex items-center gap-2"
              >
                <Input
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  placeholder="Explique o lançamento..."
                  className="flex-1 focus-visible:ring-virgula-green"
                  disabled={isLoading || unmappedTransactions.length === 0}
                />
                <Button 
                  type="submit" 
                  size="icon" 
                  disabled={!input.trim() || isLoading || unmappedTransactions.length === 0}
                  className="bg-virgula-green hover:bg-emerald-600 text-white shrink-0"
                >
                  <Send className="w-4 h-4" />
                </Button>
              </form>
              {unmappedTransactions.length === 0 && (
                <p className="text-xs text-center text-gray-500 mt-2">
                  Todos os lançamentos já estão mapeados!
                </p>
              )}
            </div>
          </CardContent>
        </Card>
      )}
    </>
  );
}
