// Pins the loader's actual contract via an injected importer
// (_setImporterForTest), not Node's inability to resolve an absolute
// browser specifier: (1) a failed import surfaces as EngineLoadError with
// the underlying error attached as `cause`; (2) a failure is not cached —
// the next call re-imports, cache-busted with ?retry=N; (3) a success IS
// cached — one import serves every caller.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  loadMediabunny,
  EngineLoadError,
  _resetLoaderForTest,
  _setImporterForTest,
} from '../../mediabunny-loader.js';

const BARE_URL = '/vendor/mediabunny/mediabunny.min.mjs';

beforeEach(() => {
  _resetLoaderForTest();
});

afterEach(() => {
  _setImporterForTest(null);
});

test('a failed load rejects with EngineLoadError and keeps the cause', async () => {
  const calls = [];
  _setImporterForTest((url) => { calls.push(url); return Promise.reject(new Error('boom')); });

  await assert.rejects(loadMediabunny(), (e) => {
    assert.ok(e instanceof EngineLoadError);
    assert.equal(e.name, 'EngineLoadError');
    assert.equal(e.message, 'engine_load_failed');
    assert.equal(e.cause?.message, 'boom');
    return true;
  });

  assert.deepEqual(calls, [BARE_URL]);
});

test('a failed load is not cached: the next call re-imports with a cache-busting specifier', async () => {
  const calls = [];
  _setImporterForTest((url) => { calls.push(url); return Promise.reject(new Error('boom')); });

  await loadMediabunny().catch(() => {});
  await loadMediabunny().catch(() => {});

  assert.deepEqual(calls, [BARE_URL, `${BARE_URL}?retry=1`]);
});

test('a successful load is cached: one import serves every caller', async () => {
  const fakeModule = { fake: true };
  const calls = [];
  _setImporterForTest((url) => { calls.push(url); return Promise.resolve(fakeModule); });

  const [first, second] = await Promise.all([loadMediabunny(), loadMediabunny()]);

  assert.equal(first, fakeModule);
  assert.equal(second, fakeModule);
  assert.deepEqual(calls, [BARE_URL]);
});
