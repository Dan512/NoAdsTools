// cover-letter-generator/tests/unit/model.test.js
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { SCHEMA_VERSION, createLetter, migrate, genLetterId, paragraphsOf, _resetIdsForTest }
  from '../../js/model.js';

beforeEach(() => _resetIdsForTest());

test('createLetter has the full shape with sensible defaults', () => {
  const l = createLetter();
  assert.equal(l.schemaVersion, SCHEMA_VERSION);
  assert.match(l.id, /^c_/);
  assert.equal(l.options.paper, 'letter');
  assert.equal(l.salutation, 'Dear Hiring Manager,');
  assert.equal(l.closing, 'Sincerely,');
  for (const k of ['fullName', 'email', 'phone', 'location']) assert.equal(l.sender[k], '');
  for (const k of ['name', 'title', 'company', 'address']) assert.equal(l.recipient[k], '');
  assert.equal(l.body, '');
});

test('paragraphsOf splits on blank lines and drops empties', () => {
  assert.deepEqual(paragraphsOf('a\n\nb'), ['a', 'b']);
  assert.deepEqual(paragraphsOf('a\n\n\n\nb\n'), ['a', 'b']);
  assert.deepEqual(paragraphsOf('   '), []);
  assert.deepEqual(paragraphsOf(''), []);
  assert.deepEqual(paragraphsOf(undefined), []);
  // a single newline is a soft wrap inside one paragraph, not a new paragraph
  assert.deepEqual(paragraphsOf('a\nb'), ['a\nb']);
});

test('migrate fills missing fields and coerces hostile types without throwing', () => {
  const out = migrate({ schemaVersion: 1, sender: { fullName: 'Ada' } });
  assert.equal(out.sender.fullName, 'Ada');
  assert.equal(out.sender.email, '');
  assert.equal(out.recipient.company, '');
  assert.ok(out.id);
  for (const hostile of [
    { schemaVersion: 1, sender: 42 },
    { schemaVersion: 1, sender: { fullName: {} } },
    { schemaVersion: 1, recipient: [] },
    { schemaVersion: 1, body: 99 },
    { schemaVersion: 1, options: 'a4' },
    { schemaVersion: 1, salutation: null },
  ]) {
    assert.doesNotThrow(() => migrate(hostile));
    const m = migrate(hostile);
    assert.equal(typeof m.body, 'string');
    assert.equal(typeof m.sender.fullName, 'string');
  }
});

test('genLetterId returns distinct c_-prefixed ids', () => {
  assert.notEqual(genLetterId(), genLetterId());
  assert.match(genLetterId(), /^c_/);
});
