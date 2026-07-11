import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scaleForDpi, outName, estPx, clampScaleForCanvas } from '../../js/render-opts.js';

const near = (a,b)=>Math.abs(a-b)<1e-6;
test('scaleForDpi = dpi/72', () => {
  assert.ok(near(scaleForDpi(72),1)); assert.ok(near(scaleForDpi(144),2)); assert.ok(near(scaleForDpi(300),300/72));
});
test('outName maps format to extension', () => {
  assert.equal(outName('doc',1,'jpg'),'doc-p1.jpg');
  assert.equal(outName('doc',12,'png'),'doc-p12.png');
});
test('estPx rounds page-points × scale', () => {
  assert.deepEqual(estPx(612,792,2),{w:1224,h:1584});
});
test('clampScaleForCanvas reduces scale so the longest side fits maxDim, flags it', () => {
  // 612pt × scale 10 = 6120 px > 4096 → clamp
  const r = clampScaleForCanvas(10, 612, 792, 4096);
  assert.ok(r.scale < 10 && r.clamped === true);
  assert.ok(Math.max(792*r.scale, 612*r.scale) <= 4096 + 1);
  // within limit → unchanged
  assert.deepEqual(clampScaleForCanvas(2, 612, 792, 4096), { scale: 2, clamped: false });
});
