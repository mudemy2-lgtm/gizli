// IndexedDB saklama katmanı: yalnızca klasör kayıtları (şifreli anahtar, tuz, vb.).
const DB_NAME = 'gizli';
const STORE = 'folders';

function open() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: 'id' });
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

export function idbStore() {
  let dbp = null;
  const db = () => dbp || (dbp = open());
  const tx = (mode, fn) => db().then(d => new Promise((res, rej) => {
    const t = d.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => res(req ? req.result : undefined);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error || new Error('işlem iptal edildi'));
  }));
  return {
    get: id => tx('readonly', s => s.get(id)),
    put: rec => tx('readwrite', s => s.put(rec)),
    delete: id => tx('readwrite', s => s.delete(id))
  };
}
