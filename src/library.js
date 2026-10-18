// Remembers imported games and their analysis in the browser (IndexedDB), so
// a large library doesn't need re-analysing on every visit.

const DB = 'chessions';
const STORE = 'games';

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'key' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

let dbPromise = null;
const db = () => (dbPromise ||= open());

function tx(mode, fn) {
  return db().then(
    (d) =>
      new Promise((resolve, reject) => {
        const t = d.transaction(STORE, mode);
        const result = fn(t.objectStore(STORE));
        t.oncomplete = () => resolve(result && 'result' in result ? result.result : undefined);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      }),
  );
}

export const library = {
  async all() {
    try {
      return (await tx('readonly', (s) => s.getAll())) || [];
    } catch {
      return [];
    }
  },
  async put(records) {
    try {
      await tx('readwrite', (s) => records.forEach((r) => s.put(r)));
      return true;
    } catch {
      return false;
    }
  },
  async remove(keys) {
    try {
      await tx('readwrite', (s) => keys.forEach((k) => s.delete(k)));
    } catch { /* storage unavailable */ }
  },
  async clear() {
    try {
      await tx('readwrite', (s) => s.clear());
    } catch { /* storage unavailable */ }
  },
};
