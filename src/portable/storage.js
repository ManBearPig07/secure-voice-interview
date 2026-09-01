const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const KEY = /^(?:state|(?:audio|draft):[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/u;
const fail = () => { throw new Error('RA_PORTABLE_STORAGE_INVALID'); };
const request = (value) => new Promise((resolve, reject) => {
  value.addEventListener('success', () => resolve(value.result), { once: true });
  value.addEventListener('error', () => reject(value.error ?? new Error('RA_PORTABLE_STORAGE_INVALID')), { once: true });
});
const completed = (transaction) => new Promise((resolve, reject) => {
  transaction.addEventListener('complete', resolve, { once: true });
  transaction.addEventListener('abort', () => reject(transaction.error ?? new Error('RA_PORTABLE_STORAGE_INVALID')), { once: true });
  transaction.addEventListener('error', () => reject(transaction.error ?? new Error('RA_PORTABLE_STORAGE_INVALID')), { once: true });
});

export const openPortableStore = async (releaseId, indexedDBRef = globalThis.indexedDB) => {
  if (!UUID.test(releaseId) || !indexedDBRef?.open) fail();
  const opened = indexedDBRef.open(`reflexact-van-portable-${releaseId}`, 1);
  opened.addEventListener('upgradeneeded', () => {
    if (!opened.result.objectStoreNames.contains('sealed')) opened.result.createObjectStore('sealed');
  }, { once: true });
  const database = await request(opened);
  const read = async (key) => {
    if (!KEY.test(key)) fail();
    const tx = database.transaction('sealed', 'readonly');
    const done = completed(tx);
    const value = await request(tx.objectStore('sealed').get(key));
    await done;
    return value ?? null;
  };
  const commit = async ({ puts = [], deletes = [] } = {}) => {
    if (!Array.isArray(puts) || !Array.isArray(deletes) || puts.length + deletes.length < 1
      || new Set(puts.map(({ key }) => key)).size !== puts.length
      || new Set(deletes).size !== deletes.length
      || puts.some(({ key, value }) => !KEY.test(key) || !value || typeof value !== 'object')
      || deletes.some((key) => typeof key !== 'string' || !KEY.test(key))
      || puts.some(({ key }) => deletes.includes(key))) fail();
    const tx = database.transaction('sealed', 'readwrite');
    const done = completed(tx);
    const sealed = tx.objectStore('sealed');
    for (const { key, value } of puts) sealed.put(structuredClone(value), key);
    for (const key of deletes) sealed.delete(key);
    await done;
  };
  const putMany = async (records) => commit({ puts: records });
  const entries = async () => {
    const tx = database.transaction('sealed', 'readonly');
    const done = completed(tx);
    const store = tx.objectStore('sealed');
    const keys = await request(store.getAllKeys());
    const values = await request(store.getAll());
    await done;
    return keys.map((key, index) => ({ key, envelope: values[index] })).sort((a, b) => a.key.localeCompare(b.key));
  };
  const clear = async () => {
    const tx = database.transaction('sealed', 'readwrite');
    const done = completed(tx);
    tx.objectStore('sealed').clear();
    await done;
  };
  return Object.freeze({ read, putMany, commit, entries, clear, close: () => database.close() });
};
