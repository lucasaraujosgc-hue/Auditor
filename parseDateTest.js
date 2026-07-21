function parseDate(val) {
  if (!val) return '';
  const str = String(val).trim();
  
  // Excel serial date (e.g., 45688)
  if (/^\d{5}$/.test(str)) {
    const excelEpoch = new Date(1899, 11, 30); // December 30, 1899
    const parsedDate = new Date(excelEpoch.getTime() + parseInt(str, 10) * 86400000);
    const dd = String(parsedDate.getDate()).padStart(2, '0');
    const mm = String(parsedDate.getMonth() + 1).padStart(2, '0');
    const yyyy = parsedDate.getFullYear();
    return `${dd}/${mm}/${yyyy}`;
  }
  
  // ISO Date (YYYY-MM-DD) or already formatted DD/MM/YYYY
  return str;
}

console.log(parseDate("45688"));
console.log(parseDate("31/01/2025"));
console.log(parseDate("2025-01-31"));
