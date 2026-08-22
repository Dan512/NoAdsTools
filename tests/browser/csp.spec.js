// tests/browser/csp.spec.js — the Content-Security-Policy.
//
// scripts/serve.js replays ./_headers locally, so these run against the same
// policy Cloudflare will send. That is the point: a CSP that only exists in
// production cannot be tested, and "works locally, breaks on the mirror" is
// this project's recurring failure mode.
import { test, expect } from '@playwright/test';
import { liveTools } from '../../shared/tools.js';

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
    // blob:/data: are local-only schemes and cannot reach the network.
    expect(p).toContain("connect-src 'self' blob: data:");

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
