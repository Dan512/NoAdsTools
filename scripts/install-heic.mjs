#!/usr/bin/env node
// scripts/install-heic.mjs — vendors libheif-js (LGPL-3.0) into BOTH of the
// repo's vendored copies: vendor/libheif/ and photo-editor/js/vendor/heic/.
//
// Why two destinations: the decoder is carried twice, byte-for-byte identical,
// because two different loaders fetch it from two different absolute URLs —
//
//   vendor/libheif/               → shared/heic-loader.js (no-modal variant),
//                                   consumers: /heic-to-jpg/, /find-duplicate-photos/
//   photo-editor/js/vendor/heic/  → photo-editor/js/vendor/heic-loader.js
//                                   (first-use consent-modal variant) and
//                                   photo-editor/js/workers/heicWorker.js
//
// Each loader hardcodes its own URL prefix, so neither copy can be dropped
// without repointing its loader; deduping them is a later platform task (see
// vendor/libheif/LICENSE.md). Feeding only one destination would let a
// LIBHEIF_VERSION bump silently strand the other on the old bytes, so this
// script writes both and keeps them in lockstep.
//
// We pick the SPLIT wasm variant from the upstream package — `libheif-wasm/libheif.js`
// (~81 KB JS glue) + `libheif-wasm/libheif.wasm` (~1.03 MB compiled wasm) — rather
// than the all-in-one `libheif-bundle.mjs` (~1.46 MB with the wasm base64-inlined).
// The split version is leaner because the wasm bytes stream as native binary
// instead of decoding a base64 string at boot.
//
// What this script does:
//   1. `npm pack libheif-js@<VERSION>` into .tmp-vendor/.
//   2. Extract and copy the three files we ship into EACH destination:
//        - libheif-wasm/libheif.js   → <dest>/libheif.js
//        - libheif-wasm/libheif.wasm → <dest>/libheif.wasm
//        - libheif/LICENSE           → <dest>/LICENSE
//   3. If anything changed, print the re-vendoring checklist (see below).
//   4. (Optional) clean .tmp-vendor with --clean-tmp.
//
// Provenance docs are hand-written here and deliberately NOT generated:
// `vendor/libheif/LICENSE.md` and `photo-editor/js/vendor/heic/.notice`. (The
// sibling scripts/install-mediabunny.mjs generates its LICENSE.md; these two
// carry a per-file source table, the LGPL-3.0/AGPL-3.0 compatibility note and
// runtime-discipline prose that a generator would flatten.) Step 3's checklist
// is the reminder to hand-update them on a version bump.
//
// Idempotent: re-running is a no-op if the vendored files already match the
// tarball's bytes. Run with `node scripts/install-heic.mjs`.
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const LIBHEIF_VERSION = '1.19.8';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP_DIR      = path.join(PROJECT_ROOT, '.tmp-vendor');

// Every vendored copy the tarball feeds. `label` is display-only; `dir` is the
// destination on disk. Keep these in sync with the loaders listed in the
// header comment — a new copy here means a new loader somewhere.
const DESTS = [
  { label: 'vendor/libheif',              dir: path.join(PROJECT_ROOT, 'vendor', 'libheif') },
  { label: 'photo-editor/js/vendor/heic', dir: path.join(PROJECT_ROOT, 'photo-editor', 'js', 'vendor', 'heic') },
];

// Files we copy from the tarball into each destination.
//   src: relative to extracted `package/` directory.
//   dst: relative to a destination dir.
const COPY_PLAN = [
  { src: 'libheif-wasm/libheif.js',   dst: 'libheif.js' },
  { src: 'libheif-wasm/libheif.wasm', dst: 'libheif.wasm' },
  { src: 'libheif/LICENSE',           dst: 'LICENSE' },
];

async function fileHash(p) {
  if (!existsSync(p)) return null;
  return createHash('sha256').update(await readFile(p)).digest('hex');
}

async function main() {
  console.log(`--- libheif-js v${LIBHEIF_VERSION} ---`);
  await mkdir(TMP_DIR, { recursive: true });

  // 1. Pack.
  console.log(`npm pack libheif-js@${LIBHEIF_VERSION}…`);
  execSync(`npm pack libheif-js@${LIBHEIF_VERSION}`, { cwd: TMP_DIR, stdio: 'inherit' });
  const tarball = `libheif-js-${LIBHEIF_VERSION}.tgz`;

  // 2. Extract.
  console.log('Extracting tarball…');
  execSync(`tar -xzf ${tarball}`, { cwd: TMP_DIR, stdio: 'inherit' });

  // 3. Read each source file once, then fan out to every destination with
  //    sha256 idempotency per file.
  const sources = [];
  for (const { src, dst } of COPY_PLAN) {
    const srcPath = path.join(TMP_DIR, 'package', src);
    if (!existsSync(srcPath)) throw new Error(`Missing in tarball: ${src}`);
    const bytes = await readFile(srcPath);
    sources.push({ src, dst, bytes, sha: createHash('sha256').update(bytes).digest('hex') });
  }

  let copied = 0;
  let skipped = 0;
  for (const dest of DESTS) {
    console.log(`\n${dest.label}/`);
    await mkdir(dest.dir, { recursive: true });
    for (const { dst, bytes, sha } of sources) {
      const dstPath = path.join(dest.dir, dst);
      if (await fileHash(dstPath) === sha) {
        skipped++;
        console.log(`  skip  ${dst} (sha matches)`);
        continue;
      }
      await writeFile(dstPath, bytes);
      copied++;
      console.log(`  write ${dst} (${(bytes.length / 1024).toFixed(1)} KB)`);
    }
  }
  console.log(`\nCopy: ${copied} written, ${skipped} skipped across ${DESTS.length} destinations`);

  // 4. Provenance is hand-maintained — print what a human has to go update.
  if (copied > 0) {
    console.log(`
sha256 of the vendored bytes:`);
    for (const { dst, sha } of sources) console.log(`  ${dst.padEnd(13)} ${sha}`);
    console.log(`
Bytes changed — the hand-written provenance docs are NOT auto-updated. Still to do:
  1. Bump VENDOR_HASH in photo-editor/js/vendor/heic-loader.js so previously
     consented users are re-prompted (the download size may have changed).
  2. Update the version/size/sha lines in:
       - vendor/libheif/LICENSE.md
       - photo-editor/js/vendor/heic/.notice
       - THIRD-PARTY.md
       - privacy.html
       - the heicConsentBody i18n string (if the wasm grew)`);
  } else {
    console.log('Everything already up to date — no provenance changes needed.');
  }

  if (process.argv.includes('--clean-tmp')) {
    await rm(TMP_DIR, { recursive: true, force: true });
    console.log('Cleaned .tmp-vendor/');
  }
  console.log('All done.');
}

main().catch(err => {
  console.error('install-heic failed:', err);
  process.exit(1);
});
