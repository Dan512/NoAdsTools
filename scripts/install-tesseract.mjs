#!/usr/bin/env node
// scripts/install-tesseract.mjs — fetch the Tesseract.js OCR engine
// (Apache-2.0) into js/vendor/tesseract/. Mirror of install-blazeface.mjs /
// install-bgremove.mjs's pattern: one-time fetch + SHA-256 verification,
// then the files live in the repo and the site loads them locally at
// runtime (no third-party CDN at user-visit time).
//
// What this script does, end-to-end:
//   1. Downloads tesseract.js@7.0.0 + tesseract.js-core@7.0.0 tarballs
//      from registry.npmjs.org, verifying the npm-published SHA-512
//      `integrity` of each tarball before unpacking.
//   2. Extracts the published JS + WASM artifacts.
//   3. Fetches eng.traineddata from the tessdata_fast GitHub repo, gzip-
//      compresses it locally (Tesseract's loader expects .traineddata.gz),
//      and stages it under lang/.
//   4. Copies the curated file set into js/vendor/tesseract/ and verifies
//      each one against the pinned SHA-256s below.
//
// The script is idempotent: if all vendored files already match their
// pinned hashes, nothing is re-downloaded.
//
// First-run note: if any PINNED entry is the placeholder string `TBD`,
// the script writes the file anyway, prints the computed SHA-256, and
// exits 0. Copy the printed value into the PINNED dictionary below and
// re-run to confirm hashes are stable.
//
// Run: `node scripts/install-tesseract.mjs`
// Optional: `--clean-tmp` to remove .tmp-vendor/ when done.
import { readFile, writeFile, mkdir, rm, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { existsSync } from 'node:fs';

// ----- Configuration -------------------------------------------------------
const TESSERACT_JS_VERSION   = '7.0.0';
const TESSERACT_CORE_VERSION = '7.0.0';
// tessdata_fast HEAD on 2024-08-01 — pinned for reproducibility. Bump only
// if upstream releases a meaningful improvement to eng.traineddata, and
// re-run the install + re-pin the file hashes below.
const ENG_TRAINEDDATA_COMMIT = '87416418657359cb625c412a48b6e1d6d41c29bd';
const ENG_TRAINEDDATA_URL    =
  `https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/${ENG_TRAINEDDATA_COMMIT}/eng.traineddata`;

const TARBALLS = {
  'tesseract.js':      {
    url:       `https://registry.npmjs.org/tesseract.js/-/tesseract.js-${TESSERACT_JS_VERSION}.tgz`,
    // Published integrity from registry.npmjs.org — captured 2026-05-22.
    integrity: 'sha512-exPBkd+z+wM1BuMkx/Bjv43OeLBxhL5kKWsz/9JY+DXcXdiBjiAch0V49QR3oAJqCaL5qURE0vx9Eo+G5YE7mA==',
  },
  'tesseract.js-core': {
    url:       `https://registry.npmjs.org/tesseract.js-core/-/tesseract.js-core-${TESSERACT_CORE_VERSION}.tgz`,
    integrity: 'sha512-WnNH518NzmbSq9zgTPeoF8c+xmilS8rFIl1YKbk/ptuuc7p6cLNELNuPAzcmsYw450ca6bLa8j3t0VAtq435Vw==',
  },
};

// Files we vendor from each tarball (relative to package/ inside the tgz).
// tesseract.js ships its dist/ — we need the browser bundle + worker harness.
// tesseract.js-core ships all 12 WASM variants (plain/simd/relaxedsimd ×
// LSTM/non-LSTM × .wasm/.wasm.js) — vendoring all of them is ~12 MB total
// and lets Tesseract.js auto-pick the fastest your browser supports
// without us having to feature-detect.
const TESSERACT_JS_FILES = [
  'dist/tesseract.min.js',
  'dist/worker.min.js',
];

// We collect all .wasm + .wasm.js files emitted by tesseract.js-core into
// js/vendor/tesseract/core/.
//
// Pinned SHA-256 hashes for the FILES WE COMMIT to js/vendor/tesseract/.
// Bump alongside TESSERACT_*_VERSION. Use `TBD` on first run; copy printed
// hashes here after the script writes them once.
const PINNED = {
  'tesseract.min.js':                                '000c27d9cd0def655f77b36c72a389c0ab13793aa31cb4d7aab56d09c0afbc7e',
  'worker.min.js':                                   '576b7df7e3393e137e51849357c9adb53fe7ac1bb69bfa06cf3d61520f182c6d',
  'lang/eng.traineddata.gz':                         'b130d16b69e3888bc099133991a50a5b50e1da0e3ff6ca31a5496fab0fb386c3',
  'core/tesseract-core-lstm.wasm':                   '66b17df6e20c5329a17ffa9c202a47eaa3e32500b253d4c7f38e7f2bc01457c3',
  'core/tesseract-core-lstm.wasm.js':                'eef5f8b2f8e20e150680b20adaec4a60babafee3adbe8a94583c81fee46e8680',
  'core/tesseract-core-simd-lstm.wasm':              '34e8d50cac216427d86bf397d610fdd9f49492539bbcdfbfccc4eda20c810bea',
  'core/tesseract-core-simd-lstm.wasm.js':           'c58b46a4c796c0b8afccf77591d5b875b6896b45d402bbce8caa6f5362447b38',
  'core/tesseract-core-relaxedsimd-lstm.wasm':       '7985c92d4c64e7267d24cadffe1b2a1da6bf8aa55fdcaf953fe94fe122a24545',
  'core/tesseract-core-relaxedsimd-lstm.wasm.js':    '861a536cf9ef8e63cb644d57bab39c388f37f7d6b6f60024b741c5f6b39a59b3',
};

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR_DIR   = path.join(PROJECT_ROOT, 'js', 'vendor', 'tesseract');
const TMP_DIR      = path.join(PROJECT_ROOT, '.tmp-vendor');

// ----- Helpers -------------------------------------------------------------

async function sha256(filepath) {
  const bytes = await readFile(filepath);
  return createHash('sha256').update(bytes).digest('hex');
}

function sha512Base64(bytes) {
  return createHash('sha512').update(bytes).digest('base64');
}

async function fetchVerified(name, { url, integrity }) {
  console.log(`Downloading ${name} from ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${name} fetch failed: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  // Verify the npm-published integrity (sha512-...) before we trust the
  // tarball contents. This is the chain of custody for the install: npm
  // publishes the hash, we pin it, we verify on download.
  const expectedAlgo = integrity.split('-')[0];
  if (expectedAlgo !== 'sha512') {
    throw new Error(`${name}: unsupported integrity algo "${expectedAlgo}"`);
  }
  const expectedB64 = integrity.slice('sha512-'.length);
  const actualB64   = sha512Base64(buf);
  if (actualB64 !== expectedB64) {
    throw new Error(
      `${name} integrity mismatch:\n  expected sha512-${expectedB64}\n  actual   sha512-${actualB64}`
    );
  }
  console.log(`  → ${(buf.length / 1048576).toFixed(2)} MB (integrity OK)`);
  return buf;
}

async function extractTarball(name, buf) {
  // Use system tar (gzip-aware: -xzf). Available on every modern dev host —
  // bsdtar/Win10+, GNU tar/macOS, Linux. Same dependency profile as
  // install-blazeface.mjs's `unzip`.
  await mkdir(TMP_DIR, { recursive: true });
  const extractDir = path.join(TMP_DIR, name);
  await rm(extractDir, { recursive: true, force: true });
  await mkdir(extractDir, { recursive: true });
  // Stage the tarball INSIDE the extract dir so we can run tar with a
  // relative path. On Windows GNU tar, a path that begins with `C:` (the
  // drive letter) is misinterpreted as a host:path remote spec; using a
  // relative archive name avoids the issue entirely.
  const tarName = `${name}.tgz`;
  const tarPath = path.join(extractDir, tarName);
  await writeFile(tarPath, buf);
  console.log(`Extracting ${name} → ${extractDir}/`);
  // -xzf on .tgz; --strip-components=1 to drop the top-level "package/" dir.
  execSync(`tar -xzf "${tarName}" --strip-components=1`, { cwd: extractDir, stdio: 'inherit' });
  // Drop the now-extracted tarball from inside the dir so subsequent file
  // walks don't see it.
  await rm(tarPath, { force: true });
  return extractDir;
}

// ----- Steps ---------------------------------------------------------------

async function vendorTesseractJs() {
  const buf = await fetchVerified('tesseract.js', TARBALLS['tesseract.js']);
  const extractDir = await extractTarball('tesseract.js', buf);
  await mkdir(VENDOR_DIR, { recursive: true });
  for (const rel of TESSERACT_JS_FILES) {
    const src = path.join(extractDir, rel);
    const dst = path.join(VENDOR_DIR, path.basename(rel));
    await copyFile(src, dst);
    console.log(`  → ${path.relative(PROJECT_ROOT, dst).replace(/\\/g, '/')}`);
  }
}

async function vendorTesseractCore() {
  const buf = await fetchVerified('tesseract.js-core', TARBALLS['tesseract.js-core']);
  const extractDir = await extractTarball('tesseract.js-core', buf);
  const coreOut = path.join(VENDOR_DIR, 'core');
  await mkdir(coreOut, { recursive: true });
  // tesseract.js-core@7 ships 12 WASM variants:
  //   tesseract-core{,-simd,-relaxedsimd}{,-lstm}.wasm + matching .wasm.js
  //
  // The plain (non-`-lstm`) variants bundle BOTH legacy Tesseract 3.x
  // integer-only code paths AND the LSTM model — ~600 KB larger each. We
  // only ever use LSTM mode (modern Tesseract 5+ default; we don't expose
  // legacy in the UI), so the LSTM-only variants are the right pick. This
  // saves ~24 MB of vendored disk vs vendoring all 12.
  const { readdir } = await import('node:fs/promises');
  const entries = await readdir(extractDir);
  const wantPattern = /-lstm\.wasm(\.js)?$/;
  for (const entry of entries) {
    if (!wantPattern.test(entry)) continue;
    const src = path.join(extractDir, entry);
    const dst = path.join(coreOut, entry);
    await copyFile(src, dst);
    const hash = await sha256(dst);
    // Add a PINNED entry on the fly so verify() considers it.
    PINNED[`core/${entry}`] = PINNED[`core/${entry}`] || 'TBD';
    console.log(`  → js/vendor/tesseract/core/${entry}  [sha256: ${hash.slice(0, 12)}…]`);
  }
}

async function vendorEnglishLanguageData() {
  console.log(`Downloading eng.traineddata from ${ENG_TRAINEDDATA_URL}`);
  const res = await fetch(ENG_TRAINEDDATA_URL);
  if (!res.ok) throw new Error(`eng.traineddata fetch failed: HTTP ${res.status}`);
  const raw = Buffer.from(await res.arrayBuffer());
  console.log(`  → ${(raw.length / 1048576).toFixed(2)} MB raw`);
  // Tesseract.js's loader expects .traineddata.gz when gzip:true (default).
  const gz = gzipSync(raw, { level: 9 });
  console.log(`  → ${(gz.length / 1048576).toFixed(2)} MB gzipped`);
  const langDir = path.join(VENDOR_DIR, 'lang');
  await mkdir(langDir, { recursive: true });
  const dst = path.join(langDir, 'eng.traineddata.gz');
  await writeFile(dst, gz);
  console.log(`  → js/vendor/tesseract/lang/eng.traineddata.gz`);
}

async function verify() {
  let failed = 0;
  let tbd = 0;
  const computed = {};
  for (const [name, expected] of Object.entries(PINNED)) {
    const filepath = path.join(VENDOR_DIR, name);
    if (!existsSync(filepath)) {
      console.error(`  ✗ ${name} missing — install incomplete`);
      failed++;
      continue;
    }
    const got = await sha256(filepath);
    computed[name] = got;
    if (expected === 'TBD') {
      console.log(`  ⚠ ${name} not yet pinned — computed sha256: ${got}`);
      tbd++;
    } else if (got === expected) {
      console.log(`  ✓ ${name} matches pinned SHA-256`);
    } else {
      console.error(`  ✗ ${name} hash mismatch`);
      console.error(`    expected: ${expected}`);
      console.error(`    actual:   ${got}`);
      failed++;
    }
  }
  if (failed > 0) {
    throw new Error(`${failed} file(s) failed SHA verification — bundle may have been tampered with or upstream changed without a version bump`);
  }
  if (tbd > 0) {
    console.log('');
    console.log(`${tbd} file(s) were not pinned. Copy these hashes into PINNED in scripts/install-tesseract.mjs and re-run to confirm:`);
    console.log('');
    for (const [name, got] of Object.entries(computed)) {
      if (PINNED[name] === 'TBD') {
        console.log(`  '${name}': '${got}',`);
      }
    }
  }
}

async function allHashesMatch() {
  // Only useful when nothing is TBD.
  for (const expected of Object.values(PINNED)) {
    if (expected === 'TBD') return false;
  }
  for (const [name, expected] of Object.entries(PINNED)) {
    const filepath = path.join(VENDOR_DIR, name);
    if (!existsSync(filepath)) return false;
    const got = await sha256(filepath);
    if (got !== expected) return false;
  }
  return true;
}

// ----- Main ---------------------------------------------------------------

async function main() {
  if (await allHashesMatch()) {
    console.log('All vendored files already match pinned SHA-256s. Nothing to do.');
    return;
  }
  console.log(`--- Installing Tesseract.js v${TESSERACT_JS_VERSION} + core v${TESSERACT_CORE_VERSION} ---`);
  await vendorTesseractJs();
  await vendorTesseractCore();
  await vendorEnglishLanguageData();
  console.log('--- Verifying ---');
  await verify();

  if (process.argv.includes('--clean-tmp')) {
    await rm(TMP_DIR, { recursive: true, force: true });
    console.log('Cleaned .tmp-vendor/');
  }
  console.log('All done.');
}

main().catch(err => {
  console.error('Install failed:', err);
  process.exit(1);
});
