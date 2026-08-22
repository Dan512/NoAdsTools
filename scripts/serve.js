// scripts/serve.js — tiny static file server for local dev. Not deployed.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';

const PORT = Number(process.env.PORT) || 4173;
const ROOT = process.cwd();
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
    res.setHeader('Content-Type', TYPES[extname(target).toLowerCase()] || 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-store');
    res.end(body);
  } catch {
    res.statusCode = 404; res.end('not found');
  }
}).listen(PORT, () => console.log(`http://localhost:${PORT}`));
