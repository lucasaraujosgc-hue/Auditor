function parseAmount(val) {
  if (!val) return 0;
  if (typeof val === 'number') return val;
  const strVal = String(val).toUpperCase();
  const isCredit = strVal.endsWith('C');
  const isDebit = strVal.endsWith('D');
  const str = strVal.replace(/[^0-9,-]/g, '').replace(',', '.');
  const num = parseFloat(str);
  if (isNaN(num)) return 0;
  // If it has C or D, we can apply a sign convention.
  // Let's say D is positive, C is negative.
  if (isCredit) return -num;
  if (isDebit) return num;
  return num;
}
console.log(parseAmount("14.412,65C"));
console.log(parseAmount("57.680,27D"));
console.log(parseAmount("158.634,05"));
