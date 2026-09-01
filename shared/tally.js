// shared/tally.js — NoAds Tally: the anonymous page-view counter.
//
// The whole transmission is five fields:
//   { site, path, ref, pwa, unique }
// No cookies, no identifier of any kind, no fingerprint. The server stores no
// IP address and no user agent. Every rate-limiting and uniqueness decision is
// made HERE, in the visitor's own browser, out of their own localStorage, so
// the endpoint can see that *a* page was loaded and never who loaded it.
//
// /privacy publishes this exact payload and the three localStorage keys.
// RULE: any change to what is sent, or to the keys below, requires updating
// that copy in the SAME commit — tests/browser/tally.spec.js compares the two
// and fails if they drift.
//
// The service is shared with noadsweather.com; its source lives in that repo
// under tally/. A site only counts once its hostname is added to ALLOWED_HOSTS
// and ALLOWED_SITES there and the service is redeployed.
//
// Why planBeacon() is pure: the interesting behaviour is the half-hour
// dampening, the "first visit today" flag and the opt-out, and all three are
// invisible when they go wrong — an over-counting beacon looks exactly like
// traffic. So the decision is a plain function over a plain object, unit-tested
// under `node --test`, and sendTally() below is the only part that touches the
// world.
export const TALLY_URL = 'https://tally-15838356607.us-central1.run.app/';
export const SITE = 'noadstools.com';

// A digital-signage screen reloading every ~10 seconds inflated NoAdsWeather's
// raw loads about 18x. A "view" is therefore a distinct half-hour visit to a
// path from one browser, not a page load.
export const DAMP_MS = 30 * 60 * 1000;

export const KEYS = {
  skip: 'tallySkip',       // set to '1' by hand to exclude a device forever
  recent: 'tallyRecent',   // { path: timestamp } inside the dampening window
  day: 'lastTallyDay',     // local YYYY-MM-DD of the last counted visit
};

export function isCountedHost(hostname) {
  return hostname === SITE || hostname === `www.${SITE}`;
}

/** Referrer domain only, and only when it is somewhere else. Never a path. */
export function refDomain(referrer, hostname) {
  try {
    if (!referrer) return '';
    const host = new URL(referrer).hostname;
    return host && host !== hostname ? host : '';
  } catch {
    return '';
  }
}

/** Local calendar day. Deliberately not toISOString(), which is UTC. */
export function localDay(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

// Drops entries that have aged out, and anything that is not a timestamp: the
// value is attacker-writable in the sense that any script or the user can put
// junk there, and a corrupt entry must not wedge counting forever.
function pruneRecent(raw, now) {
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch { /* absent or corrupt */ }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const kept = {};
  for (const [path, at] of Object.entries(parsed)) {
    if (typeof at === 'number' && now - at <= DAMP_MS) kept[path] = at;
  }
  return kept;
}

/**
 * Decide whether this page load counts, and what to send.
 *
 * @param {object} env
 * @param {string} env.hostname   location.hostname
 * @param {string} env.path       location.pathname
 * @param {number} env.now        Date.now()
 * @param {string} env.today      local YYYY-MM-DD
 * @param {string} env.referrer   document.referrer
 * @param {boolean} env.pwa       running standalone / from the home screen
 * @param {boolean} env.skip      the opt-out flag is set on this device
 * @param {boolean} env.storageOk localStorage is readable
 * @param {?string} env.recentRaw raw KEYS.recent value
 * @param {?string} env.lastDay   raw KEYS.day value
 * @returns {?{payload: object, writes: {recent: string, day: ?string}}}
 *   null when this load must not be counted.
 */
export function planBeacon(env) {
  if (!isCountedHost(env.hostname)) return null;
  if (env.skip) return null;

  const recent = pruneRecent(env.recentRaw, env.now);
  if (recent[env.path]) return null; // already counted within the window
  recent[env.path] = env.now;

  // Without readable storage there is no way to tell a returning visitor from
  // a new one, so the load counts as a view but never as a unique. Guessing
  // "unique" here would inflate the only number people read as a headcount.
  const unique = env.storageOk === true && env.lastDay !== env.today;

  return {
    payload: {
      site: SITE,
      path: env.path,
      ref: refDomain(env.referrer, env.hostname),
      pwa: !!env.pwa,
      unique,
    },
    writes: {
      recent: JSON.stringify(recent),
      day: unique ? env.today : null,
    },
  };
}

/**
 * Read the opt-out as a pair, because "off" and "cannot be saved" are
 * different answers and the control on /privacy has to say which it is.
 * @param {?Storage} store
 * @returns {{available: boolean, skipped: boolean}}
 */
export function readOptOut(store) {
  try {
    if (!store) return { available: false, skipped: false };
    return { available: true, skipped: store.getItem(KEYS.skip) === '1' };
  } catch {
    return { available: false, skipped: false };
  }
}

/**
 * Set or clear the opt-out. Opting out also deletes the two dates the counter
 * had kept, so switching it off leaves nothing of it behind in the browser —
 * an opt-out that left its own records would be a poor one.
 * Opting back in REMOVES the flag rather than storing '0': absence is the
 * default state, and planBeacon only ever tests for '1'.
 * @returns {boolean} whether the choice could actually be stored
 */
export function setOptOut(store, skipped) {
  try {
    if (!store) return false;
    if (skipped) {
      store.setItem(KEYS.skip, '1');
      store.removeItem(KEYS.recent);
      store.removeItem(KEYS.day);
    } else {
      store.removeItem(KEYS.skip);
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * The impure half: read the browser, apply the plan, post it once.
 * Every storage access is individually guarded — in private mode reads and
 * writes throw, and the load should still count (just without dampening).
 */
export function sendTally(win = window) {
  const store = (() => {
    try { return win.localStorage; } catch { return null; }
  })();
  const read = (key) => {
    try { return store ? store.getItem(key) : null; } catch { return null; }
  };
  const write = (key, value) => {
    try { if (store) store.setItem(key, value); } catch { /* private mode */ }
  };

  // One probing read decides whether "first visit today" can be trusted:
  // Safari in private mode and storage-blocked embeds throw on getItem.
  let storageOk = false;
  let lastDay = null;
  try {
    if (store) { lastDay = store.getItem(KEYS.day); storageOk = true; }
  } catch { /* unreadable: count the view, never the unique */ }

  const plan = planBeacon({
    hostname: win.location.hostname,
    path: win.location.pathname,
    now: Date.now(),
    today: localDay(new Date()),
    referrer: win.document.referrer,
    pwa: (typeof win.matchMedia === 'function'
      && win.matchMedia('(display-mode: standalone)').matches)
      || win.navigator.standalone === true,
    skip: read(KEYS.skip) === '1',
    storageOk,
    recentRaw: read(KEYS.recent),
    lastDay,
  });
  if (!plan) return false;

  write(KEYS.recent, plan.writes.recent);
  if (plan.writes.day) write(KEYS.day, plan.writes.day);

  try {
    win.navigator.sendBeacon(TALLY_URL, JSON.stringify(plan.payload));
  } catch { /* blocked or offline: a lost tally is not worth an error */ }
  return true;
}

// Auto-run on load, but only in a browser that is actually serving the site.
// `location` is undefined under `node --test`, so importing this module for
// its pure half never fires a beacon.
if (typeof window !== 'undefined' && typeof location !== 'undefined'
  && isCountedHost(location.hostname) && typeof navigator?.sendBeacon === 'function') {
  // Chrome speculatively renders omnibox predictions. Counting those would
  // mean counting pages nobody ever looked at.
  if (document.prerendering) {
    document.addEventListener('prerenderingchange', () => sendTally(), { once: true });
  } else {
    sendTally();
  }
}
