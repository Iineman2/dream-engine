// IndexedDB persistence: one JSON state document plus audio blobs.
// Everything lives in this browser profile on this device.

const DB_NAME = 'dream-engine';
const DB_VERSION = 1;
let dbPromise = null;

function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
        if (!db.objectStoreNames.contains('blobs')) db.createObjectStore('blobs');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function run(store, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const os = tx.objectStore(store);
    let result;
    const req = fn(os);
    if (req) req.onsuccess = () => { result = req.result; };
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export const loadState = () => run('kv', 'readonly', (os) => os.get('state'));
export const saveState = (state) => run('kv', 'readwrite', (os) => os.put(structuredClone(state), 'state'));
export const putBlob = (id, blob) => run('blobs', 'readwrite', (os) => os.put(blob, id));
export const getBlob = (id) => (id ? run('blobs', 'readonly', (os) => os.get(id)) : Promise.resolve(null));
export const deleteBlob = (id) => run('blobs', 'readwrite', (os) => os.delete(id));
export const blobKeys = () => run('blobs', 'readonly', (os) => os.getAllKeys());

export async function clearAll() {
  await run('kv', 'readwrite', (os) => os.clear());
  await run('blobs', 'readwrite', (os) => os.clear());
}

export async function requestPersistence() {
  try {
    if (navigator.storage?.persisted && (await navigator.storage.persisted())) return true;
    return (await navigator.storage?.persist?.()) || false;
  } catch {
    return false;
  }
}
