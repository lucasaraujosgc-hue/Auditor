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
    let currentRow: string[] = [];
    
    for (const item of textContent.items as any[]) {
      if (currentY !== item.transform[5] && currentRow.length > 0) {
        lines.push(currentRow);
        currentRow = [];
        currentY = item.transform[5];
      }
      currentRow.push(item.str);
    }
    if (currentRow.length > 0) {
      lines.push(currentRow);
    }
  }

  return lines;
}
