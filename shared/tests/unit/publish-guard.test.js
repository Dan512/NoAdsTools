// shared/tests/unit/publish-guard.test.js — the publish gitignore guard.
//
// The deploy ships whatever `git add` stages in the public mirror, so a
// .gitignore rule that matches a COPIED file silently drops it from production.
// A bare `build/` rule once did exactly that to the vendored pdf.js engine
// (vendor/pdfjs/legacy/build/pdf.min.mjs) → 404 → every PDF read as "corrupt".
// gitignoredPublishedPaths predicts that class of drop so publish fails loudly.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { gitignoredPublishedPaths, PUBLIC_GITIGNORE } = await import('../../../scripts/publish.mjs');

const ENGINE = [
  'vendor/pdfjs/legacy/build/pdf.min.mjs',
  'vendor/pdfjs/legacy/build/pdf.worker.min.mjs',
];

test('REGRESSION: the shipped PUBLIC_GITIGNORE does not exclude the vendored pdf.js engine', () => {
  assert.deepEqual(gitignoredPublishedPaths(PUBLIC_GITIGNORE, ENGINE), []);
});

test('a bare `build/` rule WOULD swallow the nested vendored engine (the original bug)', () => {
  const bad = 'node_modules/\nbuild/\n*.log\n';
  assert.deepEqual(gitignoredPublishedPaths(bad, ENGINE), ENGINE);
});

test('an anchored `/build/` ignores a ROOT build dir but never a nested vendored one', () => {
  const gi = '/build/\n';
  assert.deepEqual(
    gitignoredPublishedPaths(gi, ['build/output.js', 'vendor/pdfjs/legacy/build/pdf.min.mjs']),
    ['build/output.js'],
  );
});

test('no-slash file globs match a basename at any depth; unrelated files pass', () => {
  const gi = '*.log\n*.bak\n.DS_Store\n';
  const paths = ['a/b/x.log', 'deep/dir/y.bak', 'nested/.DS_Store', 'vendor/pdfjs/legacy/build/pdf.min.mjs', 'shared/i18n.js'];
  assert.deepEqual(gitignoredPublishedPaths(gi, paths), ['a/b/x.log', 'deep/dir/y.bak', 'nested/.DS_Store']);
});

test('rooted path rules (with a slash) match only from the mirror root', () => {
  const gi = 'playwright/.cache/\n.vscode/settings.json\n';
  const paths = [
    'playwright/.cache/thing',        // ignored (rooted dir)
    'tool/playwright/.cache/thing',   // NOT ignored (not at root)
    '.vscode/settings.json',          // ignored (rooted file)
    'sub/.vscode/settings.json',      // NOT ignored
  ];
  assert.deepEqual(gitignoredPublishedPaths(gi, paths), ['playwright/.cache/thing', '.vscode/settings.json']);
});

test('negation (last match wins) un-ignores a rescued file', () => {
  const gi = '*.example\n!keep.example\n';
  assert.deepEqual(gitignoredPublishedPaths(gi, ['drop.example', 'keep.example']), ['drop.example']);
});

test('Windows backslash paths are normalised before matching', () => {
  const bad = 'build/\n';
  assert.deepEqual(
    gitignoredPublishedPaths(bad, ['vendor\\pdfjs\\legacy\\build\\pdf.min.mjs']),
    ['vendor/pdfjs/legacy/build/pdf.min.mjs'],
  );
});

test('a negation cannot re-include a file under an excluded directory (git hierarchy)', () => {
  const gi = '.cache/\n.env.*\n!.env.example\n';
  // .cache/.env.example: the parent .cache/ is excluded → git drops it and the
  // !.env.example negation cannot rescue it. tool/.env.example: no excluded
  // ancestor → the negation DOES rescue it (git keeps it).
  assert.deepEqual(
    gitignoredPublishedPaths(gi, ['.cache/.env.example', 'tool/.env.example', 'vendor/x/.cache/.env.example']),
    ['.cache/.env.example', 'vendor/x/.cache/.env.example'],
  );
});

test('a dir-only rule ignores directory CONTENTS but not a FILE of the same name', () => {
  assert.deepEqual(gitignoredPublishedPaths('/build/\n', ['build']), []);          // root file `build` kept
  assert.deepEqual(gitignoredPublishedPaths('build/\n', ['build']), []);           // unanchored, same
  assert.deepEqual(gitignoredPublishedPaths('build/\n', ['build/x.js']), ['build/x.js']); // contents dropped
});

test('a realistic published file set is fully clean under the shipped gitignore', () => {
  const realish = [
    'index.html', 'home.css', 'home.js', 'sitemap.xml', 'LICENSE', 'README.md',
    'shared/i18n.js', 'shared/pdfjs-loader.js', 'shared/pdf-engine-error.js',
    'vendor/pdfjs/legacy/build/pdf.min.mjs',
    'vendor/pdfjs/legacy/build/pdf.worker.min.mjs',
    'vendor/pdfjs/cmaps/78-EUC-H.bcmap',
    'vendor/pdfjs/standard_fonts/FoxitFixed.pfb',
    'vendor/tesseract/worker.min.js',
    'pdf-to-text/index.html', 'pdf-to-text/js/main.js',
  ];
  assert.deepEqual(gitignoredPublishedPaths(PUBLIC_GITIGNORE, realish), []);
});
