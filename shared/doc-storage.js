// shared/doc-storage.js — generic localStorage persistence for id-keyed
// documents, shared by resume-builder and cover-letter-generator.
//
// Both the storage object and the migrate function are INJECTED: Node tests
// pass a stub store, the browser passes window.localStorage, and each tool
// passes its own migrate so this module stays free of any document schema.
// Every read is try/catch'd and validated — a corrupt value degrades to
// "nothing saved" rather than crashing the tool.

/**
 * @param {string} prefix e.g. 'noadstools:resume:' (must end with ':')
 * @param {(raw:object)=>object} migrate normalises a loaded document
 */
export function makeDocStorage(prefix, migrate) {
  const INDEX_KEY = `${prefix}index`;
  const keyFor = (id) => `${prefix}${id}`;

  function loadIndex(store) {
    try {
      const raw = JSON.parse(store.getItem(INDEX_KEY) || '[]');
      if (!Array.isArray(raw)) return [];
      return raw.filter(x => x && typeof x === 'object' && typeof x.id === 'string');
    } catch {
      return [];
    }
  }

  function loadDoc(store, id) {
    try {
      const raw = JSON.parse(store.getItem(keyFor(id)) || 'null');
      if (!raw || typeof raw !== 'object') return null;
      return migrate(raw);
    } catch {
      return null;
    }
  }

  /** @returns {{ok:boolean}} ok:false = quota/blocked (caller shows the honest banner). */
  function saveDoc(store, doc) {
    try {
      const index = loadIndex(store).filter(x => x.id !== doc.id);
      index.unshift({ id: doc.id, name: doc.name, updated: new Date().toISOString() });
      store.setItem(keyFor(doc.id), JSON.stringify(doc));
      store.setItem(INDEX_KEY, JSON.stringify(index));
      return { ok: true };
    } catch {
      return { ok: false };
    }
  }

  /** Delete one document and its index entry. Unknown ids are a no-op; a
   *  blocked store never throws (the caller shows the honest banner). */
  function removeDoc(store, id) {
    try { store.removeItem(keyFor(id)); } catch { /* keep going — index still needs pruning */ }
    try {
      store.setItem(INDEX_KEY, JSON.stringify(loadIndex(store).filter(e => e.id !== id)));
    } catch { /* blocked store: nothing more we can do */ }
  }

  function clearAll(store) {
    for (const entry of loadIndex(store)) {
      try { store.removeItem(keyFor(entry.id)); } catch { /* keep clearing */ }
    }
    try { store.removeItem(INDEX_KEY); } catch { /* done */ }
  }

  return { INDEX_KEY, keyFor, loadIndex, loadDoc, saveDoc, removeDoc, clearAll };
}
