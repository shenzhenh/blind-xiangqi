/**
 * 盲棋象棋 · 视觉规格测试（v1.5 §11.5 / T-61 ~ T-68 / T-76）
 * 量取几何、走子时序、翻面四段与音效参数。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const V = require('../src/visual.js');

test('T-61 明暗同几何：圆形、同直径、同厚度', () => {
  for (const cell of [24, 40, 60, 78]) {
    const g = V.geometry(cell);
    assert.equal(g.shape, 'circle');
    assert.ok(Math.abs(g.D - 0.86 * cell) < 1e-9);
    assert.ok(Math.abs(g.H - 0.10 * g.D) < 1e-9);
    assert.ok(Math.abs(g.R - g.D / 2) < 1e-9);
  }
  // 几何函数不区分明暗；暗子不得使用方块
  assert.equal(V.geometry(60).shape, 'circle');
  assert.equal(V.PIECE.diameterRatio, 0.86);
  assert.equal(V.PIECE.thicknessRatio, 0.10);
});

test('T-63 走子时序：抬起 80 / 平移 180 / 落地 60，总 320ms', () => {
  assert.equal(V.TIMINGS.move, 320);
  assert.equal(V.TIMINGS.lift, 80);
  assert.equal(V.TIMINGS.translate, 180);
  assert.equal(V.TIMINGS.land, 60);
  const p0 = V.moveTransform(0);
  const p40 = V.moveTransform(40);
  const p100 = V.moveTransform(100);
  const p200 = V.moveTransform(200);
  const p260 = V.moveTransform(260);
  const p290 = V.moveTransform(290);
  const p400 = V.moveTransform(400);
  assert.equal(p0.travel, 0);
  assert.ok(p40.lift < 0 && p40.travel === 0);
  assert.equal(p100.phase, 'translate');
  assert.ok(p100.travel > 0 && p100.travel < 1);
  assert.ok(p200.travel > 0 && p200.travel < 1);
  assert.equal(p260.travel, 1);
  assert.equal(p290.phase, 'land');
  assert.ok(p290.lift > -6 && p290.lift < 0);
  assert.equal(p400.phase, 'done');
  assert.equal(p400.lift, 0);
});

test('T-64 翻面总长 320ms，scaleY 1→0.10→1，overshoot ≈1.06，含高光', () => {
  assert.equal(V.TIMINGS.flip, 320);
  const at0 = V.flipTransform(0, 60);
  const at90 = V.flipTransform(90, 60);
  const at240 = V.flipTransform(240, 60);
  const at320 = V.flipTransform(320, 60);
  assert.ok(Math.abs(at0.scaleY - 1) < 1e-9);
  assert.ok(Math.abs(at90.scaleY - 0.10) < 1e-6, '90ms 必须到 H/D=0.10');
  assert.ok(Math.abs(at240.scaleY - 1) < 1e-6);
  assert.ok(at320.shine >= 0);
  let max = 0;
  let min = 1;
  let maxShine = 0;
  for (let t = 0; t <= 320; t++) {
    const f = V.flipTransform(t, 60);
    max = Math.max(max, f.scaleY);
    min = Math.min(min, f.scaleY);
    maxShine = Math.max(maxShine, f.shine);
  }
  assert.ok(max > 1.04 && max < 1.07);
  assert.ok(Math.abs(min - 0.10) < 1e-6);
  assert.ok(maxShine > 0.3 && maxShine < 0.36);
});

test('T-65 / T-76 边缘态：scaleY < 0.35 时标记为侧壁，且不低于 0.10', () => {
  const edge = V.flipTransform(90, 60);
  assert.equal(edge.rim, true);
  assert.ok(edge.scaleY <= 0.35);
  assert.ok(edge.scaleY >= 0.10);
  // 0–90ms 逐渐露出侧壁，90–240ms 收回；无 0 缩放
  for (let t = 0; t <= 320; t += 5) {
    const f = V.flipTransform(t, 60);
    assert.ok(f.scaleY >= 0.0999, 'scaleY 不得压到 0 @' + t);
  }
  // 慢放帧序列应保持单调下降到 90ms，再上升到 240ms
  let prev = 1;
  for (let t = 0; t <= 90; t += 5) {
    const f = V.flipTransform(t, 60);
    assert.ok(f.scaleY <= prev + 1e-9);
    prev = f.scaleY;
  }
});

test('T-66 / 无障碍：reduced-motion 降级为 120ms 交叉淡入，不瞬间切换', () => {
  assert.equal(V.TIMINGS.reducedFlip, 120);
  const a = V.flipTransform(0, 60, { reduced: true });
  const b = V.flipTransform(60, 60, { reduced: true });
  const c = V.flipTransform(120, 60, { reduced: true });
  assert.equal(a.crossfade, true);
  assert.equal(b.progress, 0.5);
  assert.equal(c.progress, 1);
  assert.equal(c.scaleY, 1);
});

test('T-67 翻面两连音：总长 ≤220ms，参数低于落子', () => {
  assert.ok(V.AUDIO.flipTotal <= V.AUDIO.maxTotal);
  assert.ok(V.AUDIO.maxTotal <= 220);
  assert.deepEqual(V.AUDIO.flipClicks, [0, 90]);
  assert.deepEqual(V.AUDIO.flipDurations, [70, 120]);
  assert.ok(V.AUDIO.gainBelowMoveDb > 0);
});
