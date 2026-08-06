// cover-letter-generator/tests/unit/template.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLetter } from '../../js/model.js';
import { render } from '../../js/template.js';

function filled() {
  const l = createLetter();
  l.sender = { fullName: 'Ada Lovelace', email: 'ada@example.com', phone: '555-1', location: 'London' };
  l.recipient = { name: 'Charles Babbage', title: 'Head of Engines', company: 'Babbage & Co', address: '1 Analytical Way' };
  l.dateLine = '4 August 2026';
  l.salutation = 'Dear Mr Babbage,';
  l.body = 'I am writing about the Analyst role.\n\nI wrote the first program.';
  l.closing = 'Sincerely,';
  l.signature = 'Ada Lovelace';
  return l;
}

test('renders every block', () => {
  const html = render(filled());
  for (const s of ['Ada Lovelace', 'ada@example.com', 'Charles Babbage', 'Head of Engines',
    'Babbage &amp; Co', '1 Analytical Way', '4 August 2026', 'Dear Mr Babbage,',
    'I am writing about the Analyst role.', 'I wrote the first program.', 'Sincerely,']) {
    assert.ok(html.includes(s), `missing: ${s}`);
  }
});

test('body becomes one <p> per paragraph', () => {
  const html = render(filled());
  assert.equal((html.match(/<p class="cl-para">/g) || []).length, 2);
});

test('signature falls back to the sender name when blank', () => {
  const l = filled();
  l.signature = '';
  assert.ok(render(l).includes('Ada Lovelace'));
});

test('empty blocks are omitted, not rendered blank', () => {
  const l = createLetter();
  l.sender.fullName = 'Ada';
  const html = render(l);
  assert.ok(!html.includes('cl-recipient'));
  assert.ok(!html.includes('cl-date'));
});

test('every user field is escaped', () => {
  const l = filled();
  const xss = '<script>alert(1)</script>';
  l.sender.fullName = xss; l.recipient.company = xss; l.body = xss; l.salutation = xss; l.closing = xss;
  const html = render(l);
  assert.ok(!html.includes('<script>'), 'raw script tag leaked');
  assert.ok(html.includes('&lt;script&gt;'));
});

test('deterministic output', () => {
  const l = filled();
  assert.equal(render(l), render(l));
});
