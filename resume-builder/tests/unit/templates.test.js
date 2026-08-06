// resume-builder/tests/unit/templates.test.js — templates are PURE string
// renderers; every user field must come out escaped.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createResume, addSection, _resetIdsForTest } from '../../js/model.js';
import { render } from '../../js/templates/classic.js';
import { TEMPLATES } from '../../js/templates/registry.js';

beforeEach(() => _resetIdsForTest());

function filled() {
  const r = createResume();
  r.basics = { fullName: 'Ada Lovelace', headline: 'Analyst', email: 'ada@example.com',
    phone: '555-1', location: 'London', links: [{ id: 'l1', label: 'Site', url: 'https://ada.dev' }] };
  r.summary = 'First programmer.';
  const [exp, edu, skl] = r.sections;
  Object.assign(exp.items[0], { role: 'Senior Analyst', org: 'Babbage & Co', location: 'London',
    start: '1842', end: '', current: true, bullets: ['Wrote the first program.', 'Notes on the Analytical Engine.'] });
  Object.assign(edu.items[0], { degree: 'Mathematics', school: 'Home tutoring', start: '1830', end: '1840', note: 'De Morgan' });
  skl.items[0].text = 'Mathematics';
  const custom = addSection(r, 'custom');
  Object.assign(custom.items[0], { heading: 'Analytical Engine notes', sub: 'Translation + notes', meta: '1843', bullets: ['Note G.'] });
  return r;
}

test('renders every section type + basics + summary', () => {
  const html = render(filled());
  for (const s of ['Ada Lovelace', 'Analyst', 'ada@example.com', 'First programmer.',
    'Senior Analyst', 'Babbage &amp; Co', 'Wrote the first program.', 'Mathematics',
    'Home tutoring', 'Analytical Engine notes', 'Note G.', 'Experience', 'Education', 'Skills', 'Projects']) {
    assert.ok(html.includes(s), `missing: ${s}`);
  }
  assert.ok(html.includes('present'), 'current:true renders as present');
});

test('empty sections are omitted entirely', () => {
  const r = createResume(); // all items blank
  r.basics.fullName = 'Ada';
  const html = render(r);
  assert.ok(!html.includes('Experience'));
  assert.ok(!html.includes('Education'));
  assert.ok(!html.includes('Skills'));
});

test('every user field is escaped', () => {
  const r = filled();
  const xss = '<script>alert(1)</script>';
  r.basics.fullName = xss; r.summary = xss;
  r.sections[0].title = xss; r.sections[0].items[0].role = xss; r.sections[0].items[0].bullets = [xss];
  const html = render(r);
  assert.ok(!html.includes('<script>'), 'raw script tag leaked');
  assert.ok(html.includes('&lt;script&gt;'));
});

test('deterministic output', () => {
  const r = filled();
  assert.equal(render(r), render(r));
});

test('registry integrity', () => {
  assert.ok(TEMPLATES.classic);
  assert.equal(typeof TEMPLATES.classic.render, 'function');
  assert.equal(typeof TEMPLATES.classic.label, 'string');
  assert.equal(TEMPLATES.classic.atsSafe, true);
});
