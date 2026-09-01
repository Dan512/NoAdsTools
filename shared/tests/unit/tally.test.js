// shared/tests/unit/tally.test.js — the anonymous counter's decision core.
//
// Everything here is invisible when it breaks: an over-counting beacon looks
// exactly like traffic, and an under-counting one looks like a quiet week. So
// the rules that shape the numbers get asserted rather than trusted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  planBeacon, refDomain, localDay, isCountedHost, readOptOut, setOptOut,
  DAMP_MS, SITE, KEYS,
} from '../../tally.js';

const NOW = 1_756_700_000_000; // fixed: the plan must not read the clock itself

function env(over = {}) {
  return {
    hostname: SITE,
    path: '/merge-pdf/',
    now: NOW,
    today: '2026-09-01',
    referrer: '',
    pwa: false,
    skip: false,
    storageOk: true,
    recentRaw: null,
    lastDay: null,
    ...over,
  };
}

test('a first visit sends the five documented fields and nothing else', () => {
  const plan = planBeacon(env());
  assert.deepEqual(Object.keys(plan.payload).sort(),
    ['path', 'pwa', 'ref', 'site', 'unique']);
  assert.deepEqual(plan.payload,
    { site: SITE, path: '/merge-pdf/', ref: '', pwa: false, unique: true });
});

test('only this site counts — a fork or a local copy stays silent', () => {
  for (const hostname of ['localhost', '127.0.0.1', 'noadstools.com.evil.test',
    'noadsweather.com', 'preview.pages.dev']) {
    assert.equal(planBeacon(env({ hostname })), null, hostname);
  }
  assert.ok(planBeacon(env({ hostname: `www.${SITE}` })));
  assert.ok(isCountedHost(SITE) && isCountedHost(`www.${SITE}`));
});

test('the opt-out flag suppresses everything', () => {
  assert.equal(planBeacon(env({ skip: true })), null);
});

test('a reload inside the half-hour window is not a second view', () => {
  const first = planBeacon(env());
  assert.ok(first);
  const again = planBeacon(env({ recentRaw: first.writes.recent, now: NOW + 60_000 }));
  assert.equal(again, null);
});

test('the same path counts again once the window has passed', () => {
  const first = planBeacon(env());
  const later = planBeacon(env({ recentRaw: first.writes.recent, now: NOW + DAMP_MS + 1 }));
  assert.ok(later, 'a visit after the window is a new view');
  assert.deepEqual(Object.keys(JSON.parse(later.writes.recent)), ['/merge-pdf/'],
    'the aged-out entry is pruned rather than accumulating');
});

test('dampening is per path, so browsing to a second tool still counts', () => {
  const first = planBeacon(env());
  const other = planBeacon(env({ recentRaw: first.writes.recent, path: '/split-pdf/' }));
  assert.ok(other);
  assert.deepEqual(Object.keys(JSON.parse(other.writes.recent)).sort(),
    ['/merge-pdf/', '/split-pdf/']);
});

test('a corrupt or hostile recent value degrades to "count it"', () => {
  for (const recentRaw of ['not json', '[]', 'null', '{"/merge-pdf/":"soon"}',
    '{"/merge-pdf/":{}}', '3']) {
    assert.ok(planBeacon(env({ recentRaw })), `recentRaw=${recentRaw}`);
  }
});

test('unique is once per local day, and the day is only written when it flips', () => {
  const fresh = planBeacon(env({ lastDay: '2026-08-31' }));
  assert.equal(fresh.payload.unique, true);
  assert.equal(fresh.writes.day, '2026-09-01');

  const sameDay = planBeacon(env({ lastDay: '2026-09-01', path: '/split-pdf/' }));
  assert.equal(sameDay.payload.unique, false);
  assert.equal(sameDay.writes.day, null, 'no pointless write on a repeat visit');
});

test('unreadable storage counts the view but never claims a unique', () => {
  // Private mode: there is no way to tell a returning visitor from a new one,
  // and guessing would inflate the one number people read as a headcount.
  const plan = planBeacon(env({ storageOk: false, lastDay: null }));
  assert.ok(plan);
  assert.equal(plan.payload.unique, false);
});

test('the referrer is reduced to a bare domain, or nothing', () => {
  assert.equal(refDomain('https://www.google.com/search?q=merge+pdf+private', SITE),
    'www.google.com', 'the query — which is the searcher\'s own words — is dropped');
  assert.equal(refDomain(`https://${SITE}/pdf-tools/`, SITE), '',
    'moving between our own pages is not a referral');
  assert.equal(refDomain('', SITE), '');
  assert.equal(refDomain('not a url', SITE), '');
  assert.equal(refDomain(null, SITE), '');
});

test('pwa is a boolean, never whatever matchMedia handed over', () => {
  assert.equal(planBeacon(env({ pwa: 1 })).payload.pwa, true);
  assert.equal(planBeacon(env({ pwa: undefined })).payload.pwa, false);
});

test('localDay uses the local calendar, not UTC', () => {
  // 2026-01-01T00:30 local is still 2025-12-31 in UTC for anyone west of it.
  assert.equal(localDay(new Date(2026, 0, 1, 0, 30)), '2026-01-01');
  assert.equal(localDay(new Date(2026, 8, 9, 23, 59)), '2026-09-09');
});

test('the storage keys are the ones /privacy names', () => {
  // tests/browser/tally.spec.js checks the privacy page lists exactly these.
  assert.deepEqual(KEYS,
    { skip: 'tallySkip', recent: 'tallyRecent', day: 'lastTallyDay' });
});

// --- the opt-out, as the checkbox on /privacy drives it ---------------------

function fakeStore(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    keys: () => [...map.keys()].sort(),
  };
}

const throwingStore = {
  getItem() { throw new Error('storage disabled'); },
  setItem() { throw new Error('storage disabled'); },
  removeItem() { throw new Error('storage disabled'); },
};

test('a fresh browser reads as available and counted', () => {
  assert.deepEqual(readOptOut(fakeStore()), { available: true, skipped: false });
});

test('opting out sets the flag and clears what the counter had stored', () => {
  // An opt-out that left its own records behind would be a poor one.
  const store = fakeStore({
    [KEYS.recent]: '{"/merge-pdf/":1}', [KEYS.day]: '2026-09-01',
    'noadstools_lang': 'en',
  });
  assert.equal(setOptOut(store, true), true);
  assert.deepEqual(store.keys(), ['noadstools_lang', KEYS.skip].sort(),
    'the language preference is not ours to delete');
  assert.deepEqual(readOptOut(store), { available: true, skipped: true });
});

test('opting back in removes the flag rather than storing a falsey value', () => {
  // planBeacon only ever tests for '1', and absence is the real default.
  const store = fakeStore({ [KEYS.skip]: '1' });
  assert.equal(setOptOut(store, false), true);
  assert.deepEqual(store.keys(), []);
  assert.equal(planBeacon(env({ skip: readOptOut(store).skipped })).payload.path, '/merge-pdf/');
});

test('the flag actually stops the beacon', () => {
  const store = fakeStore();
  setOptOut(store, true);
  assert.equal(planBeacon(env({ skip: readOptOut(store).skipped })), null);
});

test('blocked storage reports itself instead of pretending', () => {
  // The control has to say "cannot be saved", which is not the same as "off".
  for (const store of [throwingStore, null, undefined]) {
    assert.deepEqual(readOptOut(store), { available: false, skipped: false });
    assert.equal(setOptOut(store, true), false);
  }
});
