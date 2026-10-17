/**
 * 盲棋象棋 · AI / PublicState / PIMC 测试（v1.5 §12 / T-60, T-69 ~ T-74）
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const BX = require('../src/engine.js');
const AI = require('../src/ai.js');

function newGame(seed) {
  return new BX.Game({ seed: seed || 'ai-test' });
}

function assertLegalMove(game, move) {
  assert.ok(move, 'AI returned no move');
  const res = BX.checkMove(game.state, move.from, move.to);
  assert.equal(res.ok, true, `AI move illegal: ${BX.coord(move.from)}→${BX.coord(move.to)} (${res.code})`);
}

function playRandom(game, plies) {
  for (let i = 0; i < plies && game.status === 'PLAYING'; i++) {
    const moves = game.allLegalMoves();
    if (!moves.length) break;
    const mv = moves[Math.floor(Math.random() * moves.length)];
    game.move(mv.from, mv.to);
  }
}

/* =====================================================================
 * PublicState / Belief
 * ===================================================================== */

test('T-60 PublicState 不含暗子的 kind/side，且信念池与暗子数一致', () => {
  const game = newGame('pub-1');
  const pub = game.publicState();
  assert.equal(pub.pieces.length, 32);
  assert.equal(pub.hiddenCount, 30);
  for (const p of pub.pieces) {
    if (p.faceUp) continue;
    assert.equal(Object.prototype.hasOwnProperty.call(p, 'kind'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(p, 'side'), false);
    assert.ok(p.originKind);
    assert.ok(p.originSide);
  }
  assert.equal(pub.pool.length, 30);
  assert.equal(pub.pool.length, pub.hiddenCount);
  // 合法着法中，暗子目标的 capture 也不携带身份
  for (const mv of pub.legalMoves) {
    if (mv.capture && !mv.capture.faceUp) {
      assert.equal(Object.prototype.hasOwnProperty.call(mv.capture, 'kind'), false);
      assert.equal(Object.prototype.hasOwnProperty.call(mv.capture, 'side'), false);
    }
  }
});

test('信念池随翻面/被吃收缩，保持无放回抽样一致性', () => {
  const game = newGame('pub-2');
  playRandom(game, 24);
  const pub = game.publicState();
  assert.equal(pub.pool.length, pub.hiddenCount);
  assert.ok(pub.hiddenCount < 30);
});

test('sampleWorld：把暗子赋成池中的身份，且不改变可见信息', () => {
  const game = newGame('sample-1');
  const pub = game.publicState();
  const rng = BX.mulberry32(BX.hashSeed('sample-seed'));
  const world = BX.sampleWorld(pub, rng);
  assert.equal(world.pieces.filter((p) => !p.faceUp).length, pub.hiddenCount);
  assert.equal(world.pieces.filter((p) => p.faceUp).length, 2);
  // 暗子在世界上有身份（供搜索），但位置/翻面状态与公开状态一致
  for (const wp of world.pieces) {
    const pp = pub.pieces.find((p) => p.id === wp.id);
    assert.ok(pp);
    assert.equal(wp.at.file, pp.file);
    assert.equal(wp.at.rank, pp.rank);
    assert.equal(wp.faceUp, pp.faceUp);
  }
  // 抽样多重集合 = 池
  const poolCounts = new Map();
  for (const x of pub.pool) {
    const k = x.side + x.kind;
    poolCounts.set(k, (poolCounts.get(k) || 0) + 1);
  }
  for (const wp of world.pieces) {
    if (wp.faceUp) continue;
    const k = wp.side + wp.kind;
    assert.ok(poolCounts.get(k) > 0, 'sampled identity not in pool: ' + k);
    poolCounts.set(k, poolCounts.get(k) - 1);
  }
  for (const v of poolCounts.values()) assert.equal(v, 0);
});

test('assertPublicState：发现暗子带 kind/side 时抛错', () => {
  const game = newGame('leak');
  const pub = game.publicState();
  pub.pieces.find((p) => !p.faceUp).kind = 'R';
  assert.throws(() => AI.assertPublicState(pub), /leaks hidden identity/);
});

/* =====================================================================
 * 决策 / 可复现 / 合法性 / 降级
 * ===================================================================== */

test('T-69 固定 seed + 固定局面：AI 决策可复现', () => {
  const game = newGame('repro-ai');
  playRandom(game, 6);
  const pub = game.publicState();
  const opts = { seed: 'fixed-1', deterministic: true, sampleCount: 6, depth: 1, thinkMs: 999999 };
  const a = AI.chooseFromPublic(pub, opts);
  const b = AI.chooseFromPublic(pub, opts);
  assert.deepEqual(a, b);
  assertLegalMove(game, a);
});

test('T-70 / T-71 三档难度：在预算内返回合法着法', () => {
  const game = newGame('diff-ai');
  playRandom(game, 8);
  for (const difficulty of ['easy', 'normal', 'hard']) {
    const t0 = Date.now();
    const move = AI.chooseMove(game, { difficulty });
    const ms = Date.now() - t0;
    assertLegalMove(game, move);
    assert.ok(ms < 3000, `${difficulty} took ${ms}ms`);
    assert.equal(AI.last.difficulty, difficulty);
    assert.equal(AI.last.honesty, 'honest');
  }
});

test('极端预算：仍必须返回合法着法（可降级为随机）', () => {
  const game = newGame('budget-ai');
  const move = AI.chooseMove(game, { difficulty: 'hard', thinkMs: 0 });
  assertLegalMove(game, move);
});

test('T-72 oracle：使用真实世界并标记 honesty=oracle', () => {
  const game = newGame('oracle-ai');
  const move = AI.chooseMove(game, { honesty: 'oracle', difficulty: 'easy', thinkMs: 100 });
  assertLegalMove(game, move);
  assert.equal(AI.last.honesty, 'oracle');
  // oracle world 里暗子带真实身份
  const world = game.oracleWorld();
  const hidden = world.pieces.find((p) => !p.faceUp);
  assert.ok(hidden && hidden.kind && hidden.side);
});

test('T-74 AI 执红 / 执黑都能给出合法着法', () => {
  const red = new BX.Game({ seed: 'side-red' });
  assert.equal(red.turn, 'RED');
  assertLegalMove(red, AI.chooseMove(red, { difficulty: 'easy', thinkMs: 50 }));

  const black = new BX.Game({ seed: 'side-black' });
  const mv = black.allLegalMoves('RED')[0];
  black.move(mv.from, mv.to);
  assert.equal(black.turn, 'BLACK');
  assertLegalMove(black, AI.chooseMove(black, { difficulty: 'easy', thinkMs: 50 }));
});

test('提示不改变对局状态，且返回合法着法', () => {
  const game = newGame('hint-ai');
  const before = game.getPositionKey();
  const move = AI.suggestMove(game);
  assertLegalMove(game, move);
  assert.equal(game.getPositionKey(), before);
});

test('T-102 ai.qdepth = 0 必须拒绝启动', () => {
  assert.throws(() => new BX.Game({ config: { ai: { qdepth: 0 } } }), /qdepth/);
  const game = newGame('q0');
  assert.throws(() => AI.chooseFromPublic(game.publicState(), { qdepth: 0 }), /qdepth/);
});

test('T-99（子集）AI 不放过白吃的车', () => {
  const game = new BX.Game({
    config: {},
    position: {
      turn: 'RED',
      pieces: [
        { side: 'RED', kind: 'K', file: 4, rank: 1 },
        { side: 'BLACK', kind: 'K', file: 5, rank: 10 },
        { side: 'RED', kind: 'R', file: 1, rank: 1 },
        { side: 'BLACK', kind: 'R', file: 1, rank: 8 },
      ],
    },
  });
  for (const difficulty of ['normal', 'hard']) {
    const move = AI.chooseFromPublic(game.publicState(), { difficulty, seed: 'capture-' + difficulty, thinkMs: 1500, deterministic: true });
    assertLegalMove(game, move);
    assert.deepEqual(move.from, { file: 1, rank: 1 });
    assert.deepEqual(move.to, { file: 1, rank: 8 });
  }
});

test('T-75 AI 连续 30 局（每局 30 手）：每步合法、耗时无失控', () => {
  let maxMs = 0;
  for (let g = 0; g < 30; g++) {
    const game = newGame('soak-ai-' + g);
    let plies = 0;
    while (game.status === 'PLAYING' && plies < 30) {
      const difficulty = ['easy', 'normal', 'hard'][plies % 3];
      const t0 = Date.now();
      const move = AI.chooseMove(game, { difficulty, thinkMs: 8, seed: 'p' + plies + '-g' + g });
      maxMs = Math.max(maxMs, Date.now() - t0);
      assertLegalMove(game, move);
      game.move(move.from, move.to);
      plies++;
    }
    assert.ok(plies > 0);
  }
  assert.ok(maxMs < 1000, '单步耗时失控: ' + maxMs + 'ms');
});
