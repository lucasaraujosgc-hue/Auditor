import { GoogleGenAI, Type } from '@google/genai';
import { db, type Transaction, type Account, type Company } from './db';

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

export async function reconcileTransactionsWithAI(companyId: number, period?: string) {
  try {
    const company = await db.companies.get(companyId);
    if (!company) throw new Error('Company not found');

    const accounts = await db.accounts.where('companyId').equals(companyId).toArray();
    const analyticalAccounts = accounts.filter(a => a.type === 'A');

    // Get unreconciled transactions
    let transactions = await db.transactions
      .where('companyId').equals(companyId)
      .filter(t => !t.reconciled)
      .toArray();

    if (period) {
      transactions = transactions.filter(t => t.date.startsWith(period));
    }

    if (transactions.length === 0) return 0;

    // We process in batches to avoid token limits
    const BATCH_SIZE = 20;
    let reconciledCount = 0;

    for (let i = 0; i < transactions.length; i += BATCH_SIZE) {
      const batch = transactions.slice(i, i + BATCH_SIZE);
      
      const prompt = `
        Você é um contador especialista. Preciso que você faça a conciliação bancária (vínculo contábil) para os seguintes lançamentos bancários de uma empresa.
        
        Informações da Empresa:
        Nome: ${company.name}
        Descrição/Ramo de atuação: ${company.description || 'Não informado'}

        Plano de Contas Analíticas Disponível (Código - Descrição):
        ${analyticalAccounts.map(a => `${a.code} - ${a.description}`).join('\n')}

        Lançamentos a conciliar:
        ${JSON.stringify(batch.map(t => ({
          id: t.id,
          data: t.date,
          valor: t.amount,
          historico: t.description,
          isSaida: t.amount < 0 || (t.debitAccount === undefined && t.creditAccount === t.bankAccountCode), // Se creditou o banco, é saída
          contaBanco: t.bankAccountCode
        })), null, 2)}

        Para cada lançamento, identifique a conta contábil correta para a contrapartida.
        Se for uma SAÍDA de dinheiro (pagamento, tarifa), o banco é creditado e você deve sugerir a conta de DÉBITO (despesa, fornecedor).
        Se for uma ENTRADA de dinheiro (recebimento), o banco é debitado e você deve sugerir a conta de CRÉDITO (receita, cliente).

        Se não encontrar uma conta exata no plano de contas, sugira o nome de uma nova conta que deveria ser criada e explique o motivo.
      `;

      const response = await ai.models.generateContent({
        model: 'gemini-3-flash-preview',
        contents: prompt,
        config: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                transactionId: { type: Type.INTEGER },
                suggestedAccountCode: { type: Type.STRING, description: "Código da conta sugerida, se encontrada" },
                reason: { type: Type.STRING, description: "Motivo da escolha ou por que não encontrou" },
                suggestedNewAccountName: { type: Type.STRING, description: "Nome sugerido para nova conta, se não encontrou no plano" }
              },
              required: ["transactionId", "reason"]
            }
          }
        }
      });

      const resultText = response.text;
      if (resultText) {
        const suggestions = JSON.parse(resultText);
        
        for (const suggestion of suggestions) {
          const t = batch.find(tx => tx.id === suggestion.transactionId);
          if (t && t.id) {
            const isDebit = t.creditAccount === t.bankAccountCode; // Money left bank
            
            const updates: Partial<Transaction> = {
              aiSuggestion: true,
              aiReason: suggestion.reason,
              suggestedNewAccount: suggestion.suggestedNewAccountName
            };

            if (suggestion.suggestedAccountCode) {
              if (isDebit) {
                updates.debitAccount = suggestion.suggestedAccountCode;
              } else {
                updates.creditAccount = suggestion.suggestedAccountCode;
              }
              // Mark as reconciled if an account was found by the AI
              updates.reconciled = true; 
            } else {
              updates.reconciled = false;
            }

            await db.transactions.update(t.id, updates);
            reconciledCount++;
          }
        }
      }
    }

    return reconciledCount;
  } catch (error) {
    console.error("Erro na conciliação via IA:", error);
    throw error;
  }
}
