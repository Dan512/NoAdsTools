// qr-code-generator/tests/unit/qr.test.js — the pure core: WiFi payload
// escaping matrix, vendored-qrcodegen determinism, and SVG render shape.
// Run: node --test qr-code-generator/tests/unit/qr.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildWifiPayload, renderToSvg } from '../../js/qr.js';
import qrcodegen from '../../../vendor/qrcodegen/qrcodegen.js';

// ---- buildWifiPayload -------------------------------------------------

test('WiFi: plain WPA network with password', () => {
  const p = buildWifiPayload({ ssid: 'MyNetwork', password: 'hunter22', encryption: 'WPA', hidden: false });
  assert.equal(p, 'WIFI:T:WPA;S:MyNetwork;P:hunter22;;');
});

test('WiFi: WEP encryption passes through as T:WEP', () => {
  const p = buildWifiPayload({ ssid: 'OldRouter', password: 'abc', encryption: 'WEP' });
  assert.equal(p, 'WIFI:T:WEP;S:OldRouter;P:abc;;');
});

test('WiFi: every special character is escaped in SSID and password', () => {
  const specials = 'a\\b;c,d"e:f';
  const p = buildWifiPayload({ ssid: specials, password: specials, encryption: 'WPA' });
  const escaped = 'a\\\\b\\;c\\,d\\"e\\:f';
  assert.equal(p, `WIFI:T:WPA;S:${escaped};P:${escaped};;`);
});

test('WiFi: backslash is escaped first (no double-escaping of its own escape)', () => {
  // A single backslash must become exactly two, not four.
  const p = buildWifiPayload({ ssid: 'a\\b', encryption: 'None' });
  assert.equal(p, 'WIFI:T:nopass;S:a\\\\b;;');
});

test('WiFi: hidden network appends H:true', () => {
  const p = buildWifiPayload({ ssid: 'Attic', password: 'pw', encryption: 'WPA', hidden: true });
  assert.equal(p, 'WIFI:T:WPA;S:Attic;P:pw;H:true;;');
});

test('WiFi: hidden=false emits no H: field', () => {
  const p = buildWifiPayload({ ssid: 'Attic', password: 'pw', encryption: 'WPA', hidden: false });
  assert.ok(!p.includes('H:'));
});

test('WiFi: None encryption maps to nopass and omits P: even if a password lingers', () => {
  const p = buildWifiPayload({ ssid: 'CafeOpen', password: 'stale-value', encryption: 'None' });
  assert.equal(p, 'WIFI:T:nopass;S:CafeOpen;;');
});

test('WiFi: empty password with WPA omits the P: field', () => {
  const p = buildWifiPayload({ ssid: 'X', password: '', encryption: 'WPA' });
  assert.equal(p, 'WIFI:T:WPA;S:X;;');
});

test('WiFi: empty/missing SSID returns null', () => {
  assert.equal(buildWifiPayload({ ssid: '', password: 'pw', encryption: 'WPA' }), null);
  assert.equal(buildWifiPayload({ password: 'pw' }), null);
  assert.equal(buildWifiPayload(), null);
});

// ---- vendored qrcodegen: determinism + sanity --------------------------

const { QrCode } = qrcodegen;

function gridOf(qr) {
  let s = '';
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) s += qr.getModule(x, y) ? '1' : '0';
  }
  return s;
}

test('qrcodegen: same input produces the same module grid (deterministic)', () => {
  const a = QrCode.encodeText('https://noadstools.com/', QrCode.Ecc.MEDIUM);
  const b = QrCode.encodeText('https://noadstools.com/', QrCode.Ecc.MEDIUM);
  assert.equal(a.size, b.size);
  assert.equal(gridOf(a), gridOf(b));
});

test('qrcodegen: grid size is sane (21..177, size = 17 + 4*version)', () => {
  const qr = QrCode.encodeText('hello', QrCode.Ecc.MEDIUM);
  assert.ok(qr.size >= 21 && qr.size <= 177);
  assert.equal((qr.size - 17) % 4, 0);
  assert.equal(qr.size, 17 + 4 * qr.version);
  const dark = gridOf(qr).split('1').length - 1;
  assert.ok(dark > 0 && dark < qr.size * qr.size, 'grid is neither blank nor solid');
});

test('qrcodegen: all four ECC levels encode the WiFi payload', () => {
  const payload = buildWifiPayload({ ssid: 'MyNetwork', password: 'hunter22' });
  for (const ecc of [QrCode.Ecc.LOW, QrCode.Ecc.MEDIUM, QrCode.Ecc.QUARTILE, QrCode.Ecc.HIGH]) {
    const qr = QrCode.encodeText(payload, ecc);
    assert.ok(qr.size >= 21);
  }
});

// ---- renderToSvg --------------------------------------------------------

test('renderToSvg: viewBox covers size + 2×quiet zone; default border is 4', () => {
  const qr = QrCode.encodeText('hello', QrCode.Ecc.MEDIUM);
  const svg = renderToSvg(qr);
  const total = qr.size + 8;
  assert.ok(svg.startsWith('<svg'));
  assert.ok(svg.includes(`viewBox="0 0 ${total} ${total}"`));
});

test('renderToSvg: one path cell per dark module', () => {
  const qr = QrCode.encodeText('hello', QrCode.Ecc.MEDIUM);
  const svg = renderToSvg(qr);
  const dark = gridOf(qr).split('1').length - 1;
  const cells = svg.match(/h1v1h-1z/g) ?? [];
  assert.equal(cells.length, dark);
});

test('renderToSvg: every module lands inside the quiet zone bounds', () => {
  const qr = QrCode.encodeText('hello', QrCode.Ecc.MEDIUM);
  const border = 4;
  const svg = renderToSvg(qr, border);
  const coords = [...svg.matchAll(/M(\d+),(\d+)/g)];
  assert.ok(coords.length > 0);
  for (const [, x, y] of coords) {
    assert.ok(Number(x) >= border && Number(x) < border + qr.size);
    assert.ok(Number(y) >= border && Number(y) < border + qr.size);
  }
});

test('renderToSvg: honors a custom quiet-zone width', () => {
  const qr = QrCode.encodeText('hello', QrCode.Ecc.MEDIUM);
  const svg = renderToSvg(qr, 2);
  assert.ok(svg.includes(`viewBox="0 0 ${qr.size + 4} ${qr.size + 4}"`));
});

test('renderToSvg: the payload text is never embedded in the SVG', () => {
  const secret = 'SUPERSECRETPASSWORD';
  const payload = buildWifiPayload({ ssid: 'net', password: secret });
  const qr = QrCode.encodeText(payload, QrCode.Ecc.MEDIUM);
  const svg = renderToSvg(qr);
  assert.ok(!svg.includes(secret));
  assert.ok(!svg.includes('WIFI:'));
  // Nothing but the fixed markup vocabulary: no <script>, no user text.
  assert.ok(/^<svg [^>]*><rect [^>]*\/><path d="[Mhvz0-9, -]*" fill="#000000"\/><\/svg>$/.test(svg));
});
