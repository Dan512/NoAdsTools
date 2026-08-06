// resume-builder/tests/unit/model.test.js — pure model: create/add/move/remove/migrate.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  SCHEMA_VERSION, createResume, blankItem, addItem, removeItem, moveItem,
  addSection, removeSection, moveSection, moveItemTo, moveSectionTo,
  migrate, _resetIdsForTest, genResumeId,
} from '../../js/model.js';
import { render } from '../../js/templates/classic.js';

beforeEach(() => _resetIdsForTest());

test('createResume: schemaVersion, id, template, and 3 starter sections in order', () => {
  const r = createResume();
  assert.equal(r.schemaVersion, SCHEMA_VERSION);
  assert.ok(r.id.startsWith('r_'));
  assert.equal(r.template, 'classic');
  assert.equal(r.options.paper, 'letter');
  assert.deepEqual(r.sections.map(s => s.type), ['experience', 'education', 'skills']);
  assert.ok(r.sections.every(s => s.items.length === 1)); // one blank starter item each
});

test('blankItem: one shape per type, unknown type throws', () => {
  assert.ok('role' in blankItem('experience'));
  assert.ok('degree' in blankItem('education'));
  assert.ok('text' in blankItem('skills'));
  assert.ok('heading' in blankItem('custom'));
  assert.throws(() => blankItem('nope'));
});

test('addItem appends to the right section and returns the new item', () => {
  const r = createResume();
  const sec = r.sections[0];
  const item = addItem(r, sec.id);
  assert.equal(sec.items.length, 2);
  assert.equal(sec.items[1], item);
});

test('removeItem removes by id; unknown ids are no-ops', () => {
  const r = createResume();
  const sec = r.sections[0];
  const item = addItem(r, sec.id);
  removeItem(r, sec.id, item.id);
  assert.equal(sec.items.length, 1);
  removeItem(r, 'nope', 'nope'); // must not throw
});

test('moveItem clamps at both ends', () => {
  const r = createResume();
  const sec = r.sections[0];
  const b = addItem(r, sec.id);
  const [a] = sec.items;
  moveItem(r, sec.id, a.id, -1);                 // clamp top
  assert.deepEqual(sec.items.map(i => i.id), [a.id, b.id]);
  moveItem(r, sec.id, a.id, +1);
  assert.deepEqual(sec.items.map(i => i.id), [b.id, a.id]);
  moveItem(r, sec.id, a.id, +1);                 // clamp bottom
  assert.deepEqual(sec.items.map(i => i.id), [b.id, a.id]);
});

test('addSection: custom gets default title "Projects" and one blank item', () => {
  const r = createResume();
  const s = addSection(r, 'custom');
  assert.equal(r.sections[3], s);
  assert.equal(s.title, 'Projects');
  assert.equal(s.items.length, 1);
});

test('removeSection + moveSection (clamped)', () => {
  const r = createResume();
  const [exp, edu, skl] = r.sections;
  moveSection(r, skl.id, -1);
  assert.deepEqual(r.sections.map(s => s.id), [exp.id, skl.id, edu.id]);
  moveSection(r, exp.id, -1); // clamp
  assert.equal(r.sections[0].id, exp.id);
  removeSection(r, skl.id);
  assert.deepEqual(r.sections.map(s => s.id), [exp.id, edu.id]);
});

test('migrate: fills missing fields on an old/partial object, keeps data', () => {
  const out = migrate({ schemaVersion: 1, basics: { fullName: 'Ada' } });
  assert.equal(out.basics.fullName, 'Ada');
  assert.equal(out.basics.email, '');
  assert.ok(Array.isArray(out.sections));
  assert.equal(out.options.paper, 'letter');
  assert.ok(out.id); // assigned if missing
});

// A crafted/corrupt .json can carry any JSON value in any field. migrate() is
// the ONE normalization boundary: every hostile shape below must migrate
// without throwing AND produce a resume that classic.js's render() can render
// without throwing. If either throws, a bad import (or a future format drift)
// would persist a resume that crashes on every load.
test('migrate: hostile field types never crash migrate() or render()', () => {
  const hostileCases = [
    { schemaVersion: 1, basics: { links: [null] } },
    { schemaVersion: 1, basics: { links: [{ label: 42 }] } },
    { schemaVersion: 1, basics: { email: 42 } },
    { schemaVersion: 1, sections: [{ type: 'experience', items: [{ role: 42 }] }] },
    { schemaVersion: 1, sections: [{ type: 'experience', items: [{ bullets: 'x' }] }] },
    { schemaVersion: 1, sections: [{ type: 'experience', items: [{ bullets: [42] }] }] },
    { schemaVersion: 1, sections: [{ type: 'skills', items: [{ text: 42 }] }] },
    { schemaVersion: 1, sections: [{ type: 'custom', items: [{ meta: [] }] }] },
  ];
  for (const raw of hostileCases) {
    let resume;
    assert.doesNotThrow(() => { resume = migrate(raw); }, `migrate threw on ${JSON.stringify(raw)}`);
    assert.doesNotThrow(() => render(resume), `render threw on ${JSON.stringify(raw)}`);
  }
});

// --- Phase 2: arbitrary-index moves (drag needs them; ▲▼ only step ±1) -------

test('moveItemTo: moves to an arbitrary index, clamping out-of-range', () => {
  const r = createResume();
  const sec = r.sections[0];
  const b = addItem(r, sec.id);
  const c = addItem(r, sec.id);
  const [a] = sec.items;
  moveItemTo(r, sec.id, a.id, 2);
  assert.deepEqual(sec.items.map(i => i.id), [b.id, c.id, a.id]);
  moveItemTo(r, sec.id, a.id, -5);                 // clamp low
  assert.deepEqual(sec.items.map(i => i.id), [a.id, b.id, c.id]);
  moveItemTo(r, sec.id, a.id, 99);                 // clamp high
  assert.deepEqual(sec.items.map(i => i.id), [b.id, c.id, a.id]);
  moveItemTo(r, 'nope', a.id, 0);                  // unknown section = no-op
  moveItemTo(r, sec.id, 'nope', 0);                // unknown item = no-op
  assert.deepEqual(sec.items.map(i => i.id), [b.id, c.id, a.id]);
});

test('moveSectionTo: moves to an arbitrary index, clamping out-of-range', () => {
  const r = createResume();
  const [exp, edu, skl] = r.sections;
  moveSectionTo(r, exp.id, 2);
  assert.deepEqual(r.sections.map(s => s.id), [edu.id, skl.id, exp.id]);
  moveSectionTo(r, exp.id, -5);
  assert.deepEqual(r.sections.map(s => s.id), [exp.id, edu.id, skl.id]);
  moveSectionTo(r, exp.id, 99);
  assert.deepEqual(r.sections.map(s => s.id), [edu.id, skl.id, exp.id]);
  moveSectionTo(r, 'nope', 0);                     // unknown = no-op
  assert.deepEqual(r.sections.map(s => s.id), [edu.id, skl.id, exp.id]);
});

// --- Phase 3: fresh resume ids (Duplicate must not reuse the original's key) --

test('genResumeId returns distinct r_-prefixed ids', () => {
  const a = genResumeId();
  const b = genResumeId();
  assert.match(a, /^r_/);
  assert.match(b, /^r_/);
  assert.notEqual(a, b);
});
