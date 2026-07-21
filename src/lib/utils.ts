import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatClassification(value: string | number): string {
  const str = String(value).replace(/\D/g, '');
  if (!str) return '';
  const padded = str.padEnd(8, '0');
  return `${padded.substring(0,1)}.${padded.substring(1,2)}.${padded.substring(2,3)}.${padded.substring(3,5)}.${padded.substring(5,8)}`;
}
