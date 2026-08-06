// resume-builder/tests/unit/storage.test.js — store is INJECTED so Node tests
// run against a stub; the browser passes window.localStorage.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createResume, _resetIdsForTest } from '../../js/model.js';
import { INDEX_KEY, keyFor, loadIndex, loadResume, saveResume, clearAll, removeResume } from '../../js/storage.js';

function stubStore(failOnSet = false) {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { if (failOnSet) throw new Error('quota'); m.set(k, String(v)); },
    removeItem: (k) => m.delete(k),
    _map: m,
  };
}

beforeEach(() => _resetIdsForTest());

test('saveResume writes the resume + index entry; loadResume round-trips', () => {
  const store = stubStore();
  const r = createResume();
  r.basics.fullName = 'Ada';
  const out = saveResume(store, r);
  assert.equal(out.ok, true);
  assert.equal(loadResume(store, r.id).basics.fullName, 'Ada');
  const idx = loadIndex(store);
  assert.equal(idx.length, 1);
  assert.equal(idx[0].id, r.id);
  assert.equal(idx[0].name, r.name);
});

test('quota/blocked store reports ok:false, never throws', () => {
  const out = saveResume(stubStore(true), createResume());
  assert.equal(out.ok, false);
});

test('corrupt index / corrupt resume JSON degrade to empty, never throw', () => {
  const store = stubStore();
  store.setItem(INDEX_KEY, '{not json');
  assert.deepEqual(loadIndex(store), []);
  store.setItem(keyFor('r_x'), '{not json');
  assert.equal(loadResume(store, 'r_x'), null);
});

test('loadResume migrates stored partial data', () => {
  const store = stubStore();
  store.setItem(INDEX_KEY, JSON.stringify([{ id: 'r_old', name: 'Old', updated: '' }]));
  store.setItem(keyFor('r_old'), JSON.stringify({ schemaVersion: 1, id: 'r_old', basics: { fullName: 'Ada' } }));
  const r = loadResume(store, 'r_old');
  assert.equal(r.basics.fullName, 'Ada');
  assert.ok(Array.isArray(r.sections));
});

test('clearAll removes the index and every listed resume', () => {
  const store = stubStore();
  const r = createResume();
  saveResume(store, r);
  clearAll(store);
  assert.deepEqual(loadIndex(store), []);
  assert.equal(loadResume(store, r.id), null);
  assert.equal(store._map.size, 0);
});

// --- Phase 3: deleting ONE resume out of several ------------------------------

test('removeResume deletes the resume and its index entry, leaving others intact', () => {
  const store = stubStore();
  const a = createResume();
  a.basics.fullName = 'Ada';
  const b = createResume();
  b.basics.fullName = 'Grace';
  saveResume(store, a);
  saveResume(store, b);
  assert.equal(loadIndex(store).length, 2);

  removeResume(store, a.id);
  const idx = loadIndex(store);
  assert.deepEqual(idx.map(e => e.id), [b.id]);
  assert.equal(loadResume(store, a.id), null);
  assert.equal(loadResume(store, b.id).basics.fullName, 'Grace');
});

test('removeResume on an unknown id is a no-op and never throws', () => {
  const store = stubStore();
  const a = createResume();
  saveResume(store, a);
  removeResume(store, 'r_nope');
  assert.deepEqual(loadIndex(store).map(e => e.id), [a.id]);
});

test('removeResume survives a throwing store', () => {
  const store = stubStore();
  const a = createResume();
  saveResume(store, a);
  store.removeItem = () => { throw new Error('blocked'); };
  assert.doesNotThrow(() => removeResume(store, a.id));
});
