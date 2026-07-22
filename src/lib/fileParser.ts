import * as XLSX from 'xlsx';
import Papa from 'papaparse';
import * as pdfjsLib from 'pdfjs-dist';

// Configura o worker do PDF.js
pdfjsLib.GlobalWorkerOptions.workerSrc = `//cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version}/pdf.worker.min.mjs`;

export async function parseFileToData(file: File): Promise<any[]> {
  const extension = file.name.split('.').pop()?.toLowerCase();

  if (extension === 'pdf') {
    return parsePdf(file);
  } else if (extension === 'csv' || extension === 'txt') {
    return parseCsvOrTxt(file);
  } else if (extension === 'xlsx' || extension === 'xls') {
    return parseXlsx(file);
  } else {
    throw new Error('Formato de arquivo não suportado');
  }
}

async function parseXlsx(file: File): Promise<any[]> {
  const data = await file.arrayBuffer();
  const workbook = XLSX.read(data, { type: 'array' });
  const firstSheetName = workbook.SheetNames[0];
  const worksheet = workbook.Sheets[firstSheetName];
  return XLSX.utils.sheet_to_json(worksheet);
}

function parseCsvOrTxt(file: File): Promise<any[]> {
  return new Promise((resolve, reject) => {
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: (results) => {
        resolve(results.data);
      },
      error: (error) => {
        reject(error);
      }
    });
  });
}

async function parsePdf(file: File): Promise<any[]> {
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  const lines: any[] = [];

  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const textContent = await page.getTextContent();
    let currentY = -1;
    let currentRow: { str: string; x: number }[] = [];

    const flushRow = () => {
      if (currentRow.length === 0) return;
      // Itens de um mesmo PDF nem sempre chegam no fluxo de texto na ordem
      // visual da esquerda para a direita (alguns geradores de relatório
      // desenham colunas numéricas fora de ordem). Ordenar por X garante que
      // a ordem das colunas bata com a ordem visual/impressa da tabela.
      const sorted = [...currentRow].sort((a, b) => a.x - b.x);
      const values = sorted.map(t => t.str).filter(s => s.trim() !== '');
      if (values.length > 0) lines.push(values);
    };

    for (const item of textContent.items as any[]) {
      if (currentY !== item.transform[5] && currentRow.length > 0) {
        flushRow();
        currentRow = [];
      }
      currentRow.push({ str: item.str, x: item.transform[4] });
      currentY = item.transform[5];
    }
    flushRow();
  }

  return lines;
}