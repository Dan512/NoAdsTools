// shared/tests/unit/tools.test.js — the platform tool manifest is the single
// source of truth for the topbar dropdown, footer crosslinks, and (Plan C)
// the homepage grid + publish list. These tests pin its invariants.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { TOOLS, CATEGORIES, liveTools, toolBySlug, toolsByCategory } =
  await import('../../tools.js');

const STATUSES = new Set(['live', 'planned']);
const CAT_IDS = new Set(CATEGORIES.map(c => c.id));

test('every tool has the required string fields', () => {
  for (const tl of TOOLS) {
    for (const field of ['slug', 'title', 'blurb', 'category', 'status']) {
      assert.equal(typeof tl[field], 'string', `${tl.slug}.${field} must be a string`);
      assert.ok(tl[field].length > 0, `${tl.slug}.${field} must be non-empty`);
    }
    assert.ok(STATUSES.has(tl.status), `${tl.slug}.status must be live|planned`);
    assert.ok(CAT_IDS.has(tl.category), `${tl.slug}.category must be a known category`);
    assert.match(tl.slug, /^[a-z0-9]+(-[a-z0-9]+)*$/, `${tl.slug} must be a clean slug`);
  }
});

test('slugs are unique', () => {
  const slugs = TOOLS.map(t => t.slug);
  assert.equal(new Set(slugs).size, slugs.length);
});

test('photo-editor is present and live', () => {
  const ed = toolBySlug('photo-editor');
  assert.ok(ed);
  assert.equal(ed.status, 'live');
  assert.equal(ed.category, 'image');
});

test('liveTools returns only status:live tools', () => {
  const live = liveTools();
  assert.ok(live.length >= 1);
  assert.ok(live.every(t => t.status === 'live'));
  assert.ok(live.some(t => t.slug === 'photo-editor'));
});

test('toolBySlug returns null for an unknown slug', () => {
  assert.equal(toolBySlug('does-not-exist'), null);
});

test('toolsByCategory filters by category id', () => {
  const image = toolsByCategory('image');
  assert.ok(image.every(t => t.category === 'image'));
  assert.ok(image.some(t => t.slug === 'photo-editor'));
});
