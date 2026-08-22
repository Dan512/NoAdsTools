// scripts/serve.js — tiny static file server for local dev. Not deployed.
//
// It also replays the production response headers from ./_headers (the
// Content-Security-Policy in particular). A CSP that exists only in production
// is untestable, and the one bug class this project keeps hitting is "works
// locally, breaks on the deployed mirror". Serving the real policy here means
// the Playwright suite fails on a CSP violation instead of a user finding it.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { readFileSync, existsSync } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';

const PORT = Number(process.env.PORT) || 4173;
const ROOT = process.cwd();

// Minimal Cloudflare _headers parser: "/pattern" lines followed by indented
// "Name: value" lines. Supports a trailing /* wildcard, which is all we use.
function loadHeaderRules() {
  const f = join(ROOT, '_headers');
  if (!existsSync(f)) return [];
  const rules = [];
  let current = null;
  for (const raw of readFileSync(f, 'utf8').split(/\r?\n/)) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    if (!/^\s/.test(raw)) {
      current = { pattern: raw.trim(), headers: [] };
      rules.push(current);
    } else if (current) {
      const i = raw.indexOf(':');
      if (i > 0) current.headers.push([raw.slice(0, i).trim(), raw.slice(i + 1).trim()]);
    }
  }
  return rules;
}
const HEADER_RULES = loadHeaderRules();

function matchesRule(pattern, pathname) {
  if (pattern.endsWith('/*')) return pathname.startsWith(pattern.slice(0, -1));
  if (pattern === '/*') return true;
  return pattern === pathname;
}
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.mjs':  'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2':'font/woff2',
  '.wasm': 'application/wasm',
  '.onnx': 'application/octet-stream',
  '.txt':  'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    let path = decodeURIComponent(url.pathname);
    if (path.endsWith('/')) path += 'index.html';
    const safe = normalize(join(ROOT, path));
    if (!safe.startsWith(ROOT + sep) && safe !== ROOT) {
      res.statusCode = 403; res.end('forbidden'); return;
    }
    // Production serves extensionless URLs: a request for /privacy is answered
    // by privacy.html, and a request for /privacy.html 301s to it. Mirror the
    // serving
    // half here so local dev and the tests exercise the same URLs the live
    // site does. Without this, /privacy 404s locally while working in prod,
    // which is the same dev/prod divergence class that hid the pdf.js 404.
    let target = safe;
    let s;
    try {
      s = await stat(target);
    } catch {
      if (extname(target)) throw new Error('not found');
      target = safe + '.html';
      s = await stat(target);
    }
    if (s.isDirectory()) { res.statusCode = 301; res.setHeader('Location', path + '/'); res.end(); return; }
    const body = await readFile(target);
    for (const rule of HEADER_RULES) {
      if (!matchesRule(rule.pattern, path)) continue;
      for (const [name, value] of rule.headers) res.setHeader(name, value);
    }
    res.setHeader('Content-Type', TYPES[extname(target).toLowerCase()] || 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-store');
    res.end(body);
  } catch {
    res.statusCode = 404; res.end('not found');
  }
}).listen(PORT, () => console.log(`http://localhost:${PORT}`));
