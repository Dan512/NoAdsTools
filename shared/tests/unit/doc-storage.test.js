// shared/tests/unit/doc-storage.test.js — the generic id-keyed document store
// used by resume-builder and cover-letter-generator. The store object and the
// migrate function are both injected, so this is pure and Node-testable.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { makeDocStorage } = await import('../../doc-storage.js');

function stubStore(failOnSet = false) {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { if (failOnSet) throw new Error('quota'); m.set(k, String(v)); },
    removeItem: (k) => m.delete(k),
    _map: m,
  };
}

const identity = (raw) => raw;
const S = makeDocStorage('noadstools:letter:', identity);

test('keys are namespaced by the prefix', () => {
  assert.equal(S.INDEX_KEY, 'noadstools:letter:index');
  assert.equal(S.keyFor('c_1'), 'noadstools:letter:c_1');
});

test('save/load round-trip and index entry', () => {
  const store = stubStore();
  assert.equal(S.saveDoc(store, { id: 'c_1', name: 'Acme', v: 2 }).ok, true);
  assert.equal(S.loadDoc(store, 'c_1').v, 2);
  assert.deepEqual(S.loadIndex(store).map(e => e.id), ['c_1']);
});

test('two prefixes never collide', () => {
  const store = stubStore();
  const A = makeDocStorage('noadstools:resume:', identity);
  const B = makeDocStorage('noadstools:letter:', identity);
  A.saveDoc(store, { id: 'x', name: 'R' });
  B.saveDoc(store, { id: 'x', name: 'L' });
  assert.equal(A.loadDoc(store, 'x').name, 'R');
  assert.equal(B.loadDoc(store, 'x').name, 'L');
  assert.equal(A.loadIndex(store).length, 1);
  assert.equal(B.loadIndex(store).length, 1);
});

test('migrate is applied on load', () => {
  const store = stubStore();
  const M = makeDocStorage('noadstools:letter:', (raw) => ({ ...raw, migrated: true }));
  M.saveDoc(store, { id: 'c_1', name: 'x' });
  assert.equal(M.loadDoc(store, 'c_1').migrated, true);
});

test('blocked store: saveDoc reports ok:false and nothing throws', () => {
  const store = stubStore(true);
  assert.equal(S.saveDoc(store, { id: 'c_1', name: 'x' }).ok, false);
  assert.doesNotThrow(() => S.removeDoc(store, 'c_1'));
  assert.doesNotThrow(() => S.clearAll(store));
});

test('corrupt JSON degrades to empty, never throws', () => {
  const store = stubStore();
  store.setItem('noadstools:letter:index', '{not json');
  assert.deepEqual(S.loadIndex(store), []);
  store.setItem('noadstools:letter:c_9', '{not json');
  assert.equal(S.loadDoc(store, 'c_9'), null);
});

test('removeDoc prunes the record and the index; clearAll empties both', () => {
  const store = stubStore();
  S.saveDoc(store, { id: 'a', name: 'A' });
  S.saveDoc(store, { id: 'b', name: 'B' });
  S.removeDoc(store, 'a');
  assert.deepEqual(S.loadIndex(store).map(e => e.id), ['b']);
  assert.equal(S.loadDoc(store, 'a'), null);
  S.clearAll(store);
  assert.deepEqual(S.loadIndex(store), []);
  assert.equal(store._map.size, 0);
});
