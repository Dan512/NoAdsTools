// tests/browser/csp.spec.js — the Content-Security-Policy.
//
// scripts/serve.js replays ./_headers locally, so these run against the same
// policy Cloudflare will send. That is the point: a CSP that only exists in
// production cannot be tested, and "works locally, breaks on the mirror" is
// this project's recurring failure mode.
import { test, expect } from '@playwright/test';
import { liveTools } from '../../shared/tools.js';
import { TALLY_URL } from '../../shared/tally.js';

const TALLY_ORIGIN = new URL(TALLY_URL).origin;

const DOCS = ['/', '/privacy', '/image-tools/', '/pdf-tools/', '/document-tools/',
  ...liveTools().map((t) => `/${t.slug}/`)];

async function csp(request, url) {
  const res = await request.get(url);
  expect(res.status(), `${url} should be served`).toBe(200);
  return res.headers()['content-security-policy'] || '';
}

for (const url of DOCS) {
  test(`${url} is served with a CSP that enforces no-upload`, async ({ request }) => {
    const p = await csp(request, url);
    expect(p, `${url} has no CSP header (a new tool needs a rule in _headers)`).toBeTruthy();

    // The directive that makes the site's headline claim browser-enforced.
    // blob:/data: are local-only schemes and cannot reach the network. The
    // counter endpoint is the single remote origin, and it may only receive
    // the five fields /privacy publishes.
    expect(p).toContain(`connect-src 'self' blob: data: ${TALLY_ORIGIN}`);

    // No remote script origins, no framing, no form posts anywhere.
    expect(p).toContain("default-src 'self'");
    expect(p).toContain("frame-ancestors 'none'");
    expect(p).toContain("form-action 'none'");
    expect(p).toContain("object-src 'none'");
  });
}

test("only photo-editor may use 'unsafe-eval'", async ({ request }) => {
  // Its vendored background-removal bundle compiles kernels with new Function.
  // Nothing else should need it, and it must not leak site-wide.
  const offenders = [];
  for (const url of DOCS) {
    const p = await csp(request, url);
    if (p.includes("'unsafe-eval'") && url !== '/photo-editor/') offenders.push(url);
  }
  expect(offenders, "'unsafe-eval' escaped beyond photo-editor").toEqual([]);

  expect(await csp(request, '/photo-editor/'),
    'photo-editor needs unsafe-eval or background removal breaks')
    .toContain("'unsafe-eval'");
});

test('the counter endpoint is the only remote origin any policy allows', async ({ request }) => {
  // This is the test that keeps "your files never leave your device" true. A
  // second remote host in connect-src — or any remote host in script-src,
  // img-src or frame-src — is how that claim would quietly stop holding.
  for (const url of DOCS) {
    const p = await csp(request, url);
    const remotes = [...new Set((p.match(/https?:\/\/[^\s;]+/g) || []))];
    expect(remotes, `${url} allows an unexpected remote origin`).toEqual([TALLY_ORIGIN]);

    const connect = p.split(';').map((d) => d.trim()).find((d) => d.startsWith('connect-src'));
    expect(connect, `${url} allows the counter somewhere other than connect-src`)
      .toContain(TALLY_ORIGIN);
  }
});

test('pages send an Origin the counter can check', async ({ request }) => {
  // Under Referrer-Policy: no-referrer, Firefox and WebKit send "Origin: null"
  // on a sendBeacon POST and the counter rejects it — which would have dropped
  // every Safari and Firefox visit while Chrome kept counting. Cross-origin
  // requests still leak the bare origin only, never a path.
  for (const url of ['/', '/privacy', '/merge-pdf/']) {
    const res = await request.get(url);
    expect(res.headers()['referrer-policy'], `${url} referrer policy`)
      .toBe('strict-origin-when-cross-origin');
  }
});

test('Cloudflare rules do not overlap, or the policies would intersect', async ({ request }) => {
  // Two matching rules mean two CSP headers, and browsers enforce the
  // intersection: a catch-all /* would silently re-block what the
  // photo-editor rule allows. Exactly one policy must come back.
  const res = await request.get('/photo-editor/');
  const raw = res.headersArray().filter((h) => /^content-security-policy$/i.test(h.name));
  expect(raw.length, 'expected exactly one CSP header').toBe(1);
  expect(raw[0].value.split('script-src').length - 1, 'one script-src directive').toBe(1);
});

test('_headers is not stale relative to the tool manifest', async () => {
  // Adding a tool without re-running the generator would ship it with no CSP.
  const { buildHeaders } = await import('../../scripts/gen-headers.mjs');
  const { readFileSync } = await import('node:fs');
  const onDisk = readFileSync('_headers', 'utf8').replace(/\r\n/g, '\n');
  expect(onDisk, 'run: node scripts/gen-headers.mjs').toBe(buildHeaders());
});
