// Basic IndexedDB wrapper for client-side persistence.
// Stores:
//  – transactions: key = txHash, value = full transaction object plus derived fields
//  – prices: key = date string 'YYYY-MM-DD', value = { price }
//  – meta: misc key/value pairs

const DB_NAME = 'nimiq-tax-db';
const DB_VERSION = 2;

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onerror = () => reject(req.error);
    req.onupgradeneeded = (e) => {
      const db = req.result;
      if (!db.objectStoreNames.contains('transactions')) {
        db.createObjectStore('transactions', { keyPath: 'hash' });
      }
      if (!db.objectStoreNames.contains('prices')) {
        db.createObjectStore('prices', { keyPath: 'date' });
      }
      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta');
      }
      if (!db.objectStoreNames.contains('realized')) {
        db.createObjectStore('realized', { keyPath: 'txHash' });
      }
      if (!db.objectStoreNames.contains('gains')) {
        db.createObjectStore('gains', { keyPath: 'year' });
      }
    };
    req.onsuccess = () => resolve(req.result);
  });
  return dbPromise;
}

async function withStore(storeName, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const store = tx.objectStore(storeName);
    const res = fn(store, tx);
    tx.onerror = () => reject(tx.error);
    tx.oncomplete = () => {
      if (res && typeof res.result !== 'undefined') resolve(res.result);
      else resolve(res);
    };
  });
}

// Transaction helpers -------------------------------------------------------
export async function saveTransactions(txs) {
  await withStore('transactions', 'readwrite', (store) => {
    for (const tx of txs) {
      const copy = { ...tx };
      if (!copy.hash) copy.hash = copy.transactionHash;
      if (!copy.timestamp && copy.__timestamp) copy.timestamp = copy.__timestamp;
      store.put(copy);
    }
  });
}

export async function getAllTransactions() {
  return withStore('transactions', 'readonly', (store) => store.getAll());
}

export async function getTransactionsForAddresses(addressSet) {
  const all = await getAllTransactions();
  return all.filter(tx => addressSet.has((tx.sender || '').toLowerCase()) || addressSet.has((tx.recipient || '').toLowerCase()));
}

// Price helpers -------------------------------------------------------------
export async function savePrices(priceMap) {
  // priceMap: { dateStr => price }
  await withStore('prices', 'readwrite', (store) => {
    for (const [date, price] of Object.entries(priceMap)) {
      store.put({ date, price });
    }
  });
}

export async function getPrice(dateStr) {
  return withStore('prices', 'readonly', (store) => store.get(dateStr)).then(r => r?.price);
}

// Realized gains helpers ----------------------------------------------------
export async function saveRealized(rows) {
  await withStore('realized', 'readwrite', (store) => {
    for (const row of rows) store.put(row);
  });
}

export async function getRealized() {
  return withStore('realized', 'readonly', (store) => store.getAll());
}

export async function saveGainsSummary(summaryArr) {
  await withStore('gains', 'readwrite', (store) => {
    for (const g of summaryArr) store.put(g);
  });
}

export async function getGainsSummary() {
  return withStore('gains', 'readonly', (store) => store.getAll());
}

// Meta helpers --------------------------------------------------------------
export async function setMeta(key, value) {
  await withStore('meta', 'readwrite', (store) => store.put(value, key));
}

export async function getMeta(key) {
  return withStore('meta', 'readonly', (store) => store.get(key));
} 