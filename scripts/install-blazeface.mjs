#!/usr/bin/env node
// scripts/install-blazeface.mjs — fetch the Qualcomm AI Hub Models
// MediaPipe Face Detection ONNX export (Apache-2.0) into
// js/vendor/blazeface/. Mirror of install-bgremove.mjs's pattern: one-time
// fetch + SHA-256 verification, then the files live in the repo and the
// site loads them locally at runtime (no third-party CDN at user-visit
// time).
//
// What this script does, end-to-end:
//   1. Downloads the float-precision ONNX bundle (.zip) from Qualcomm's
//      public S3 release bucket for the configured QAI_VERSION.
//   2. Unzips into a scratch directory.
//   3. Copies face_detector.onnx + face_detector.data + metadata.json into
//      js/vendor/blazeface/ — we DON'T vendor the bundled
//      face_landmark_detector files (we only need bboxes to draw redact
//      rectangles; landmarks would be ~2.4 MB of dead weight).
//   4. Verifies each vendored file against pinned SHA-256 hashes. If you
//      bump QAI_VERSION, also update the hashes below + the .notice file.
//
// The script is idempotent: if all vendored files already match their
// pinned hashes, nothing is re-downloaded.
//
// Run: `node scripts/install-blazeface.mjs`
// Optional: `--clean-tmp` to remove .tmp-vendor/ when done.
import { readFile, writeFile, mkdir, rm, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { existsSync } from 'node:fs';

// ----- Configuration -------------------------------------------------------
const QAI_VERSION = '0.54.0';
const BUNDLE_URL =
  `https://qaihub-public-assets.s3.us-west-2.amazonaws.com/qai-hub-models/` +
  `models/mediapipe_face/releases/v${QAI_VERSION}/mediapipe_face-onnx-float.zip`;

// Pinned SHA-256 hashes for the FILES WE COMMIT to js/vendor/blazeface/.
// Computed from the v0.54.0 bundle. Bump alongside QAI_VERSION.
const PINNED = {
  'face_detector.onnx':
    '7455604fc33f56a5f90b9489ef0fc30d8d8921c23b03ac1c74b95c9a2eb47108',
  'face_detector.data':
    '990a8bec20de1515437cafdae3f5debbc6961ae3e2e6e9f78522853c036d618c',
};

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR_DIR   = path.join(PROJECT_ROOT, 'js', 'vendor', 'blazeface');
const TMP_DIR      = path.join(PROJECT_ROOT, '.tmp-vendor');
const ZIP_NAME     = `mediapipe_face-onnx-float.zip`;
const EXTRACT_NAME = `mediapipe_face-onnx-float`;

// ----- Helpers -------------------------------------------------------------

async function sha256(filepath) {
  const bytes = await readFile(filepath);
  return createHash('sha256').update(bytes).digest('hex');
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

async function downloadBundle() {
  await mkdir(TMP_DIR, { recursive: true });
  const zipPath = path.join(TMP_DIR, ZIP_NAME);
  // Skip the download if the zip is already present (saves bandwidth on
  // re-runs); we re-extract regardless.
  if (existsSync(zipPath)) {
    console.log(`Skipping download — ${ZIP_NAME} already in .tmp-vendor/`);
    return zipPath;
  }
  console.log(`Downloading ${BUNDLE_URL}`);
  const res = await fetch(BUNDLE_URL);
  if (!res.ok) throw new Error(`Bundle fetch failed: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  await writeFile(zipPath, buf);
  console.log(`  → ${ZIP_NAME} (${(buf.length / 1048576).toFixed(2)} MB)`);
  return zipPath;
}

function unzip(zipPath) {
  // Use the system unzip. macOS/Linux ship it by default; Windows Git Bash
  // includes it. If the install fails because unzip isn't available, the
  // user can extract manually and re-run with the files already in place.
  console.log(`Extracting → ${TMP_DIR}/${EXTRACT_NAME}/`);
  execSync(`unzip -q -o "${ZIP_NAME}"`, { cwd: TMP_DIR, stdio: 'inherit' });
}

async function vendorFiles() {
  await mkdir(VENDOR_DIR, { recursive: true });
  const extractedDir = path.join(TMP_DIR, EXTRACT_NAME);
  for (const name of Object.keys(PINNED)) {
    const src = path.join(extractedDir, name);
    const dst = path.join(VENDOR_DIR, name);
    await copyFile(src, dst);
    console.log(`  → ${path.relative(PROJECT_ROOT, dst).replace(/\\/g, '/')}`);
  }
  // metadata.json isn't load-time critical but useful for re-vendoring;
  // we rename to qualcomm-metadata.json so its provenance is obvious next
  // to the .notice file.
  await copyFile(
    path.join(extractedDir, 'metadata.json'),
    path.join(VENDOR_DIR, 'qualcomm-metadata.json'),
  );
  console.log(`  → js/vendor/blazeface/qualcomm-metadata.json (provenance)`);
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
    throw new Error(`${failed} file(s) failed SHA verification — bundle may have been tampered with or upstream changed without a version bump`);
  }
}

// ----- Main ---------------------------------------------------------------

async function main() {
  if (await allHashesMatch()) {
    console.log('All vendored files already match pinned SHA-256s. Nothing to do.');
    return;
  }
  console.log(`--- Installing Qualcomm MediaPipe-Face-Detection v${QAI_VERSION} ---`);
  const zipPath = await downloadBundle();
  unzip(zipPath);
  await vendorFiles();
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
