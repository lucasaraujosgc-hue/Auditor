import { db } from './db';

export let isRestoring = false;

export async function syncToBackup() {
  if (isRestoring) return true;
  
  try {
    const companies = await db.companies.toArray();
    const accounts = await db.accounts.toArray();
    const rules = await db.rules.toArray();
    const transactions = await db.transactions.toArray();

    const data = {
      companies,
      accounts,
      rules,
      transactions,
      timestamp: new Date().toISOString()
    };

    const response = await fetch('/api/backup', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(data),
    });

    if (!response.ok) {
      throw new Error('Failed to save backup');
    }
    
    return true;
  } catch (error) {
    console.error('Error syncing to backup:', error);
    return false;
  }
}

export async function restoreFromBackup() {
  try {
    isRestoring = true;
    const response = await fetch('/api/backup');
    if (!response.ok) return false;
    
    const data = await response.json();
    if (!data) return false; // No backup exists yet

    // Clear existing data
    await db.companies.clear();
    await db.accounts.clear();
    await db.rules.clear();
    await db.transactions.clear();

    // Restore data
    if (data.companies?.length) await db.companies.bulkAdd(data.companies);
    if (data.accounts?.length) await db.accounts.bulkAdd(data.accounts);
    if (data.rules?.length) await db.rules.bulkAdd(data.rules);
    if (data.transactions?.length) await db.transactions.bulkAdd(data.transactions);

    return true;
  } catch (error) {
    console.error('Error restoring from backup:', error);
    return false;
  } finally {
    isRestoring = false;
  }
}
