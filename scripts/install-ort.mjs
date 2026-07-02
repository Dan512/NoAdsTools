#!/usr/bin/env node
// scripts/install-ort.mjs — fetch the ONNX Runtime Web WASM kernels that
// our two vendored bundles (ort.bundle.min.mjs, ort.webgpu.bundle.min.mjs)
// load at runtime. Same SHA-pinned vendoring pattern as install-blazeface
// and install-tesseract.
//
// What this script does:
//   1. Downloads onnxruntime-web@1.21.0 tarball from registry.npmjs.org
//      and verifies its npm-published SHA-512 integrity.
//   2. Extracts the four WASM-loader files our bundles reference:
//        ort-wasm-simd-threaded.jsep.wasm    (WebGPU + threading variant)
//        ort-wasm-simd-threaded.jsep.mjs     (its companion loader JS)
//        ort-wasm-simd-threaded.wasm         (threading-only variant)
//        ort-wasm-simd-threaded.mjs          (its companion loader JS)
//   3. Copies them into js/vendor/onnxruntime-web/.
//   4. Verifies each against pinned SHA-256 hashes.
//
// The .mjs bundle files themselves (ort.bundle.min.mjs and
// ort.webgpu.bundle.min.mjs) were vendored manually earlier and are
// already in git — this script ONLY refreshes the WASM kernel files
// that those bundles fetch at runtime.
//
// Why we vendor the threaded variants even though GitHub Pages can't set
// COOP/COEP headers (which threading needs): ORT's loader gracefully
// falls back to single-threaded mode within the same WASM file when
// SharedArrayBuffer isn't available. So one threaded WASM file works in
// both COOP/COEP-isolated AND plain hosting setups.
//
// Run: `node scripts/install-ort.mjs`
// Optional: `--clean-tmp` to remove .tmp-vendor/ when done.
import { readFile, writeFile, mkdir, rm, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { existsSync } from 'node:fs';

// ----- Configuration -------------------------------------------------------
const ORT_VERSION = '1.21.0';
const TARBALL = {
  url:       `https://registry.npmjs.org/onnxruntime-web/-/onnxruntime-web-${ORT_VERSION}.tgz`,
  // Published integrity from registry.npmjs.org — captured 2026-05-22.
  integrity: 'sha512-adzOe+7uI7lKz6pQNbAsLMQd2Fq5Jhmoxd8LZjJr8m3KvbFyiYyRxRiC57/XXD+jb18voppjeGAjoZmskXG+7A==',
};

const PINNED = {
  'ort-wasm-simd-threaded.jsep.wasm': '0663b902fb3937883a34375926bdfe3e1c86cd4c99cbc04c06a7cdf46c78bdde',
  'ort-wasm-simd-threaded.jsep.mjs':  'b69c8812bf2d8356dd248fef0abb35e22d1f05f9c593ca34d4b942f35ea93592',
  'ort-wasm-simd-threaded.wasm':      '06b3f98e5aa2fffec1e3ac57a48bf1073828c6624e14d210750bc596c2e35d65',
  'ort-wasm-simd-threaded.mjs':       'e9ba2350c370278fc90108f1514fb9ce6a4051341ab977b5b0dca7eca9e78dfa',
};

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR_DIR   = path.join(PROJECT_ROOT, 'js', 'vendor', 'onnxruntime-web');
const TMP_DIR      = path.join(PROJECT_ROOT, '.tmp-vendor');

// ----- Helpers -------------------------------------------------------------

async function sha256(filepath) {
  const bytes = await readFile(filepath);
  return createHash('sha256').update(bytes).digest('hex');
}

function sha512Base64(bytes) {
  return createHash('sha512').update(bytes).digest('base64');
}

async function allHashesMatch() {
  for (const [name, expected] of Object.entries(PINNED)) {
    const filepath = path.join(VENDOR_DIR, name);
    if (!existsSync(filepath)) return false;
    const got = await sha256(filepath);
    if (got !== expected) return false;
  }
  return true;
}

// ----- Steps ---------------------------------------------------------------

async function downloadAndExtract() {
  await mkdir(TMP_DIR, { recursive: true });
  console.log(`Downloading ${TARBALL.url}`);
  const res = await fetch(TARBALL.url);
  if (!res.ok) throw new Error(`tarball fetch failed: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());

  // Verify npm-published integrity (sha512) before trusting tarball contents.
  const expectedB64 = TARBALL.integrity.slice('sha512-'.length);
  const actualB64   = sha512Base64(buf);
  if (actualB64 !== expectedB64) {
    throw new Error(`tarball integrity mismatch:\n  expected sha512-${expectedB64}\n  actual   sha512-${actualB64}`);
  }
  console.log(`  → ${(buf.length / 1048576).toFixed(2)} MB (integrity OK)`);

  // Stage the tarball INSIDE the extract dir + extract with a relative path.
  // On Windows GNU tar, a path starting with `C:` is misinterpreted as a
  // remote-host spec; relative paths sidestep that.
  const extractDir = path.join(TMP_DIR, 'ort-pkg');
  await rm(extractDir, { recursive: true, force: true });
  await mkdir(extractDir, { recursive: true });
  const tarName = 'ort.tgz';
  const tarPath = path.join(extractDir, tarName);
  await writeFile(tarPath, buf);
  console.log(`Extracting → ${extractDir}/`);
  execSync(`tar -xzf "${tarName}" --strip-components=1`, { cwd: extractDir, stdio: 'inherit' });
  await rm(tarPath, { force: true });
  return extractDir;
}

async function vendorFiles(extractDir) {
  await mkdir(VENDOR_DIR, { recursive: true });
  for (const name of Object.keys(PINNED)) {
    const src = path.join(extractDir, 'dist', name);
    const dst = path.join(VENDOR_DIR, name);
    await copyFile(src, dst);
    console.log(`  → ${path.relative(PROJECT_ROOT, dst).replace(/\\/g, '/')}`);
  }
}

async function verify() {
  let failed = 0;
  for (const [name, expected] of Object.entries(PINNED)) {
    const filepath = path.join(VENDOR_DIR, name);
    const got = await sha256(filepath);
    if (got === expected) {
      console.log(`  ✓ ${name} matches pinned SHA-256`);
    } else {
      console.error(`  ✗ ${name} hash mismatch`);
      console.error(`    expected: ${expected}`);
      console.error(`    actual:   ${got}`);
      failed++;
    }
  }
  if (failed > 0) {
    throw new Error(`${failed} file(s) failed SHA verification — tarball changed without a version bump?`);
  }
}

// ----- Main ---------------------------------------------------------------

async function main() {
  if (await allHashesMatch()) {
    console.log('All vendored files already match pinned SHA-256s. Nothing to do.');
    return;
  }
  console.log(`--- Installing ONNX Runtime Web v${ORT_VERSION} WASM kernels ---`);
  const extractDir = await downloadAndExtract();
  await vendorFiles(extractDir);
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
