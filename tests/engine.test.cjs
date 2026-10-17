/**
 * 盲棋象棋 · 可执行验收测试
 * 把 spec.md §13 的表格翻译成断言；编号与 spec 一致（T-xx）。
 * 运行：node --test tests/
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const BX = require('../src/engine.js');

/* ---------- 工具 ---------- */

const S = (side, kind, file, rank, faceUp = true) => ({ side, kind, file, rank, faceUp });
const HIDDEN = (side, kind, file, rank) => ({ side, kind, file, rank, faceUp: false });

function pos(pieces, turn = 'RED', config) {
  return new BX.Game({ position: { pieces, turn, config }, config });
}

function coords(list) {
  return list.map((m) => BX.coord(m.to || m)).sort();
}

function movesOf(g, file, rank) {
  return coords(g.legalMovesFrom(file, rank));
}

function movesForSide(g, file, rank, side) {
  return coords(BX.legalMovesFor(g.state, g.pieceAt(file, rank), side));
}

function tryMove(g, from, to) {
  return g.move({ file: from[0], rank: from[1] }, { file: to[0], rank: to[1] });
}

function doMove(g, from, to) {
  const res = tryMove(g, from, to);
  assert.equal(res.ok, true, `expected legal move ${from}->${to}, got ${res.code}`);
  return res.event;
}

function pieceList(g) {
  return g.uiState().pieces;
}

/** 标准双王 + 中路人肉挡将子（做需要双王的测试时使用） */
function kings() {
  return [
    S('RED', 'K', 5, 1),
    S('BLACK', 'K', 5, 10),
    S('BLACK', 'P', 5, 6),
  ];
}

/* =====================================================================
 * 开局（T-01 ~ T-05）
 * ===================================================================== */

test('T-01 开局：32 枚棋子，将帅明牌在原位', () => {
  const g = new BX.Game({ seed: 't01' });
  const ps = pieceList(g);
  assert.equal(ps.length, 32);
  const redK = g.pieceAt(5, 1);
  const blackK = g.pieceAt(5, 10);
  assert.equal(redK.kind, 'K');
  assert.equal(redK.side, 'RED');
  assert.equal(redK.faceUp, true);
  assert.equal(blackK.kind, 'K');
  assert.equal(blackK.side, 'BLACK');
  assert.equal(blackK.faceUp, true);
});

test('T-02 开局：其余 30 枚全暗且恰好占据 30 个原位置格', () => {
  const g = new BX.Game({ seed: 't02' });
  const hidden = pieceList(g).filter((p) => !p.faceUp);
  assert.equal(hidden.length, 30);
  const keys = new Set(hidden.map((p) => BX.ORIGIN_KIND[p.rank][p.file] !== null && BX.ORIGIN_KIND[p.rank][p.file] !== 'K'));
  assert.deepEqual([...keys], [true]);
  const occupied = hidden.map((p) => p.file + ',' + p.rank);
  assert.equal(new Set(occupied).size, 30);
});

test('T-03 1000 个 seed 开局均无将军、无照面', () => {
  for (let i = 0; i < 1000; i++) {
    const g = new BX.Game({ seed: 'inv-' + i });
    assert.equal(g.isInCheck('RED'), false, 'red check seed ' + i);
    assert.equal(g.isInCheck('BLACK'), false, 'black check seed ' + i);
    assert.equal(BX.generalsFaceToFace(g.state), false, 'face seed ' + i);
  }
});

test('T-04 同 seed 两次 setup 布局完全一致（可复现）', () => {
  const a = new BX.Game({ seed: 'repro-42' });
  const b = new BX.Game({ seed: 'repro-42' });
  assert.equal(a.getPositionKey(), b.getPositionKey());
  assert.deepEqual(a.uiState().pieces, b.uiState().pieces);
});

test('T-05 全局混洗：红子落在黑方半场的比例约 50%', () => {
  let redOnBlackHalf = 0;
  let totalRed = 0;
  const N = 10000;
  for (let i = 0; i < N; i++) {
    const g = new BX.Game({ seed: 'mix-' + i });
    for (const p of g.pieces) {
      if (p.side !== 'RED') continue;
      totalRed++;
      if (p.at.rank >= 6) redOnBlackHalf++;
    }
  }
  const ratio = redOnBlackHalf / totalRed;
  assert.ok(ratio > 0.44 && ratio < 0.56, 'ratio=' + ratio);
});

/* =====================================================================
 * 暗子走法（T-06 ~ T-12）
 * ===================================================================== */

test('T-06 暗子在 (1,1)（原点 R/红）：直线走、遇子即止', () => {
  const g = pos([HIDDEN('RED', 'R', 1, 1)]);
  const all = movesOf(g, 1, 1);
  assert.equal(all.length, 17); // file 1 上 9 格 + rank 1 上 8 格
  assert.ok(all.includes('f1r10'));
  assert.ok(all.includes('f9r1'));

  const g2 = pos([HIDDEN('RED', 'R', 1, 1), S('BLACK', 'C', 1, 4)]);
  const stops = movesOf(g2, 1, 1);
  assert.ok(stops.includes('f1r4'), '可吃第一个被占格');
  assert.ok(!stops.includes('f1r5'), '不可越过阻挡');
});

test('T-07 暗仕（红仕位）只能到 (5,2)，不得出宫', () => {
  const g = pos([HIDDEN('RED', 'A', 4, 1)]);
  assert.deepEqual(movesOf(g, 4, 1), ['f5r2']);
});

test('T-08 暗相（红相位）只能到 (1,3)/(5,3)，且受象眼与河界限制', () => {
  const g = pos([HIDDEN('RED', 'E', 3, 1)]);
  assert.deepEqual(movesOf(g, 3, 1), ['f1r3', 'f5r3']);

  const blocked = pos([HIDDEN('RED', 'E', 3, 1), S('BLACK', 'P', 2, 2)]);
  assert.deepEqual(movesOf(blocked, 3, 1), ['f5r3']);
});

test('T-09 暗马（红马位）：三个落点，马腿被占则对应方向失效', () => {
  const g = pos([HIDDEN('RED', 'H', 2, 1)]);
  assert.deepEqual(movesOf(g, 2, 1), ['f1r3', 'f3r3', 'f4r2']);

  const legBlocked = pos([HIDDEN('RED', 'H', 2, 1), S('RED', 'P', 2, 2)]);
  assert.deepEqual(movesOf(legBlocked, 2, 1), ['f4r2']);
});

test('T-10 暗炮（红炮位）：走同车，吃需恰好一个炮架', () => {
  const g = pos([
    HIDDEN('RED', 'C', 2, 3),
    S('BLACK', 'P', 2, 5), // 炮架
    S('BLACK', 'R', 2, 8), // 目标
  ]);
  const moves = movesOf(g, 2, 3);
  assert.ok(moves.includes('f2r8'), '隔一子可吃');
  assert.ok(!moves.includes('f2r5'), '炮架本身不可吃');
  assert.ok(moves.includes('f2r4'));

  const noScreen = pos([HIDDEN('RED', 'C', 2, 3), S('BLACK', 'R', 2, 8)]);
  assert.ok(!movesOf(noScreen, 2, 3).includes('f2r8'), '无炮架不能吃');

  const twoScreens = pos([
    HIDDEN('RED', 'C', 2, 3),
    S('BLACK', 'P', 2, 5),
    S('BLACK', 'P', 2, 6),
    S('BLACK', 'R', 2, 8),
  ]);
  assert.ok(!movesOf(twoScreens, 2, 3).includes('f2r8'), '两个炮架不能吃');
});

test('T-11 暗兵（红兵位 (5,4)）只能向前一格，不能横走/后退', () => {
  const g = pos([HIDDEN('RED', 'P', 5, 4)]);
  assert.deepEqual(movesOf(g, 5, 4), ['f5r5']);
});

test('T-12 暗兵（黑卒位 (5,7)）朝红方走 (5,6)，与真实阵营无关', () => {
  const g = pos([HIDDEN('RED', 'P', 5, 7)], 'BLACK'); // 真实属红，表观属黑
  assert.deepEqual(movesOf(g, 5, 7), ['f5r6']);
  assert.equal(g.pieceAt(5, 7).side, 'RED');
  assert.equal(BX.apparentSide(g.pieceAt(5, 7)), 'BLACK');
});

/* =====================================================================
 * 翻面（T-13 ~ T-15）
 * ===================================================================== */

test('T-13 暗子走一步：目标格翻面，事件记录真实身份', () => {
  const g = pos([HIDDEN('RED', 'R', 1, 1)]);
  const ev = doMove(g, [1, 1], [1, 3]);
  assert.equal(g.pieceAt(1, 3).faceUp, true);
  assert.deepEqual(ev.revealed, { kind: 'R', side: 'RED' });
  assert.equal(ev.moverWasFaceUp, false);
});

test('T-14 暗子吃子：移动 + 吃子 + 翻面同时发生', () => {
  const g = pos([HIDDEN('RED', 'R', 1, 1), S('BLACK', 'P', 1, 4)]);
  const ev = doMove(g, [1, 1], [1, 4]);
  assert.equal(ev.captured.kind, 'P');
  assert.equal(ev.captured.wasFaceUp, true);
  assert.equal(g.pieceAt(1, 4).faceUp, true);
  assert.equal(g.pieceAt(1, 1), null);
});

test('T-15 暗子被攻击/被将军不会自动翻面', () => {
  const g = pos([
    ...kings(),
    HIDDEN('RED', 'R', 1, 1),
    S('BLACK', 'R', 1, 5),
    HIDDEN('RED', 'H', 9, 1),
  ]);
  // 黑车攻击 (1,1) 的暗子；红方走别的子（(9,1) 是后备车）
  doMove(g, [9, 1], [9, 2]);
  assert.equal(g.pieceAt(1, 1).faceUp, false);
  const view = pieceList(g).find((p) => p.file === 1 && p.rank === 1);
  assert.equal(view.kind, undefined);
  assert.equal(view.side, undefined);
});

/* =====================================================================
 * 吃子与误伤（T-16 ~ T-23）
 * ===================================================================== */

test('T-16 明子攻击表观同侧的暗子：合法；真实同阵营则 friendlyFire', () => {
  const friendly = pos([S('RED', 'R', 1, 1), HIDDEN('RED', 'P', 1, 4)]);
  const ev = doMove(friendly, [1, 1], [1, 4]);
  assert.equal(ev.captured.friendlyFire, true);
  assert.equal(ev.captured.kind, 'P');

  const enemy = pos([S('RED', 'R', 1, 1), HIDDEN('BLACK', 'P', 1, 4)]);
  const ev2 = doMove(enemy, [1, 1], [1, 4]);
  assert.equal(ev2.captured.friendlyFire, false);
});

test('T-17 明子不能吃己方明子', () => {
  const g = pos([S('RED', 'R', 1, 1), S('RED', 'P', 1, 4)]);
  const res = tryMove(g, [1, 1], [1, 4]);
  assert.equal(res.ok, false);
  assert.equal(res.code, 'OWN_PIECE');
});

test('T-18 红半场暗子攻击红半场暗子：非法（表观同侧）', () => {
  const g = pos([HIDDEN('RED', 'R', 1, 1), HIDDEN('BLACK', 'P', 1, 4)]);
  // 目标真实属黑，但表观属红 → 暗子视为友军
  const res = tryMove(g, [1, 1], [1, 4]);
  assert.equal(res.ok, false);
  assert.equal(res.code, 'APPARENT_ALLY');
  assert.ok(!movesOf(g, 1, 1).includes('f1r4'));
});

test('T-19 红半场暗子攻击黑半场暗子：合法', () => {
  const g = pos([HIDDEN('RED', 'R', 1, 1), HIDDEN('RED', 'P', 1, 7)]);
  assert.ok(movesOf(g, 1, 1).includes('f1r7'));
  const ev = doMove(g, [1, 1], [1, 7]);
  assert.equal(ev.captured.wasFaceUp, false);
  assert.equal(g.pieceAt(1, 1), null);
});

test('T-20 红半场暗子攻击已翻面的红车：非法', () => {
  const g = pos([HIDDEN('RED', 'R', 1, 1), S('RED', 'R', 1, 4)]);
  const res = tryMove(g, [1, 1], [1, 4]);
  assert.equal(res.ok, false);
  assert.equal(res.code, 'APPARENT_ALLY');
});

test('T-21 红半场暗子攻击已翻面的黑车：合法', () => {
  const g = pos([HIDDEN('RED', 'R', 1, 1), S('BLACK', 'R', 1, 4)]);
  assert.ok(movesOf(g, 1, 1).includes('f1r4'));
});

test('T-22 同一位置的两枚暗子（真实红/真实黑）攻击判定完全一致', () => {
  const variants = [];
  for (const side of ['RED', 'BLACK']) {
    for (const kind of ['A', 'E', 'H', 'R', 'C', 'P']) {
      const g = pos([
        HIDDEN(side, kind, 1, 1),
        S('RED', 'R', 5, 5),
        S('BLACK', 'R', 5, 6),
        HIDDEN('RED', 'P', 1, 7),
        HIDDEN('BLACK', 'P', 3, 7),
      ]);
      const rejected = [];
      for (let f = 1; f <= 9; f++) {
        for (let r = 1; r <= 10; r++) {
          if (f === 1 && r === 1) continue;
          if (!tryMove(g, [1, 1], [f, r]).ok) rejected.push(BX.coord({ file: f, rank: r }));
        }
      }
      variants.push(rejected.sort().join(','));
    }
  }
  assert.equal(new Set(variants).size, 1, '被拒绝的落点集合随真实身份变化 → 泄露');
});

test('T-23 暗子互吃且真实同阵营：合法执行并标 friendlyFire（F-3）', () => {
  const g = pos([HIDDEN('RED', 'R', 1, 1), HIDDEN('RED', 'P', 1, 7)]);
  const ev = doMove(g, [1, 1], [1, 7]);
  assert.equal(ev.captured.friendlyFire, true);
  assert.equal(ev.captured.side, 'RED');
});

/* =====================================================================
 * 区域约束 D4（T-24 ~ T-29）
 * ===================================================================== */

test('T-24 暗仕锁九宫：红仕位只能 (5,2)', () => {
  const g = pos([HIDDEN('RED', 'A', 4, 1)]);
  assert.deepEqual(movesOf(g, 4, 1), ['f5r2']);
});

test('T-25 暗相不过河：红相位只能 (1,3)/(5,3)', () => {
  const g = pos([HIDDEN('RED', 'E', 3, 1)]);
  assert.deepEqual(movesOf(g, 3, 1), ['f1r3', 'f5r3']);
});

test('T-26 车位暗子走到 (1,9) 翻出红仕：此后全盘斜走一格', () => {
  const g = pos([HIDDEN('RED', 'A', 1, 1)]);
  doMove(g, [1, 1], [1, 9]);
  const p = g.pieceAt(1, 9);
  assert.equal(p.kind, 'A');
  assert.equal(p.side, 'RED');
  assert.equal(p.faceUp, true);
  assert.deepEqual(movesForSide(g, 1, 9, 'RED'), ['f2r10', 'f2r8']);
});

test('T-27 车位暗子走到 (1,7) 翻出红相：可过河走田字', () => {
  const g = pos([HIDDEN('RED', 'E', 1, 1)]);
  doMove(g, [1, 1], [1, 7]);
  const p = g.pieceAt(1, 7);
  assert.equal(p.kind, 'E');
  assert.deepEqual(movesForSide(g, 1, 7, 'RED'), ['f3r5', 'f3r9']);
});

test('T-28 将帅始终只能走九宫', () => {
  const g = pos([S('RED', 'K', 5, 1), S('BLACK', 'K', 5, 10), S('BLACK', 'P', 5, 6)]);
  assert.deepEqual(movesOf(g, 5, 1), ['f4r1', 'f5r2', 'f6r1']);

  const corner = pos([S('RED', 'K', 4, 3), S('BLACK', 'K', 5, 10), S('BLACK', 'P', 5, 6)]);
  assert.deepEqual(movesOf(corner, 4, 3), ['f4r2', 'f5r3']);
});

test('T-29 明子兵未过河不能横走，过河后可横走', () => {
  const home = pos([S('RED', 'P', 4, 4)]);
  assert.deepEqual(movesOf(home, 4, 4), ['f4r5']);

  const crossed = pos([S('RED', 'P', 4, 6)]);
  assert.deepEqual(movesOf(crossed, 4, 6), ['f3r6', 'f4r7', 'f5r6']);
});

/* =====================================================================
 * 规则边界（T-30 ~ T-34）
 * ===================================================================== */

test('T-30 走后两将照面：该着法被拒绝', () => {
  const g = pos([S('RED', 'K', 5, 1), S('BLACK', 'K', 5, 10), S('RED', 'R', 5, 5)]);
  const res = tryMove(g, [5, 5], [4, 5]);
  assert.equal(res.ok, false);
  assert.equal(res.code, 'FACE_TO_FACE');

  // 仍在同列（(5,4)）则保持阻挡，合法
  assert.equal(tryMove(g, [5, 5], [5, 4]).ok, true);
});

test('T-31 走后己方将帅被攻击：该着法被拒绝（送将）', () => {
  const g = pos([S('RED', 'K', 5, 1), S('RED', 'R', 3, 1), S('BLACK', 'R', 1, 1)]);
  const res = tryMove(g, [3, 1], [3, 2]);
  assert.equal(res.ok, false);
  assert.equal(res.code, 'SEND_CHECK');

  // 沿 rank 1 移动、继续挡住黑车则合法
  assert.equal(tryMove(g, [3, 1], [4, 1]).ok, true);
});

test('T-32 暗子按原点兵种攻击将帅 → 被将军（表观阵营基准，合成局面）', () => {
  // 说明：合法对局中暗子只落在原位置格，而原位置格在几何上无法攻击九宫内的将帅；
  // 这里刻意把红帅放在九宫之外，用来单独验证 isInCheck 的 apparentSide 基准。
  const g = pos([S('RED', 'K', 1, 3), HIDDEN('BLACK', 'R', 1, 10)]);
  assert.equal(g.isInCheck('RED'), true);

  const blocked = pos([S('RED', 'K', 1, 3), HIDDEN('BLACK', 'R', 1, 10), S('BLACK', 'P', 1, 6)]);
  assert.equal(blocked.isInCheck('RED'), false);
});

test('T-33 黑卒位暗子走到 (3,6) 翻出红兵：方向反转为 rank+1', () => {
  const g = pos([HIDDEN('RED', 'P', 3, 7)], 'BLACK');
  doMove(g, [3, 7], [3, 6]);
  const p = g.pieceAt(3, 6);
  assert.equal(p.side, 'RED');
  // 轮到红方（黑走完），红兵已过河：可前进 + 横走
  assert.equal(g.turn, 'RED');
  assert.deepEqual(movesOf(g, 3, 6), ['f2r6', 'f3r7', 'f4r6']);
  assert.ok(!movesOf(g, 3, 6).includes('f3r5'), '红兵永不后退');
});

test('T-34 老兵到底线且被堵：无着法但不判负', () => {
  const g = pos([
    S('RED', 'K', 5, 1),
    S('BLACK', 'K', 5, 10),
    S('BLACK', 'P', 5, 6),
    S('RED', 'P', 5, 10),
    S('RED', 'R', 4, 10), // 己方子堵住横走（若为敌方则可被吃，不再是“无着法”）
    S('RED', 'R', 6, 10),
  ]);
  assert.deepEqual(movesOf(g, 5, 10), []);
  const res = BX.evaluateStatus(g.state);
  assert.equal(res.status, 'PLAYING');
});

/* =====================================================================
 * 终局（T-35 ~ T-39）
 * ===================================================================== */

test('T-35 被将且无合法着法 → 将死判负', () => {
  const g = pos([
    S('RED', 'K', 5, 1),
    S('BLACK', 'K', 5, 10),
    S('BLACK', 'R', 5, 3),
    S('BLACK', 'R', 1, 1),
    S('BLACK', 'R', 6, 10),
  ]);
  assert.equal(g.isInCheck('RED'), true);
  const res = BX.evaluateStatus(g.state);
  assert.equal(res.status, 'BLACK_WIN');
  assert.equal(res.reason, 'CHECKMATE');
});

test('T-36 未被将但无合法着法 → 困毙判负', () => {
  const g = pos([
    S('RED', 'K', 5, 1),
    S('BLACK', 'K', 5, 10),
    S('BLACK', 'R', 4, 3),
    S('BLACK', 'R', 6, 3),
    S('BLACK', 'R', 1, 2),
    S('BLACK', 'P', 5, 5),
  ]);
  assert.equal(g.isInCheck('RED'), false);
  const res = BX.evaluateStatus(g.state);
  assert.equal(res.status, 'BLACK_WIN');
  assert.equal(res.reason, 'STALEMATE');
});

test('T-37 三次重复且其间每步都在将军 → 长将判负', () => {
  const g = pos(
    [
      S('RED', 'K', 5, 1),
      S('BLACK', 'K', 5, 10),
      S('BLACK', 'P', 5, 6),
      S('BLACK', 'R', 5, 3),
    ],
    'RED'
  );
  assert.equal(g.isInCheck('RED'), true);
  const cycle = [
    [[5, 1], [4, 1]],
    [[5, 3], [4, 3]],
    [[4, 1], [5, 1]],
    [[4, 3], [5, 3]],
  ];
  for (let round = 0; round < 2; round++) {
    for (const [from, to] of cycle) doMove(g, from, to);
  }
  assert.equal(g.status, 'RED_WIN');
  assert.equal(g.drawReason, 'PERPETUAL_CHECK');
});

test('T-38 三次重复但非长将 → 和棋', () => {
  const g = pos(
    [
      S('RED', 'K', 5, 1),
      S('BLACK', 'K', 5, 10),
      S('BLACK', 'P', 5, 5),
    ],
    'RED'
  );
  const cycle = [
    [[5, 1], [4, 1]],
    [[5, 10], [6, 10]],
    [[4, 1], [5, 1]],
    [[6, 10], [5, 10]],
  ];
  for (let round = 0; round < 2; round++) {
    for (const [from, to] of cycle) doMove(g, from, to);
  }
  assert.equal(g.status, 'DRAW');
  assert.equal(g.drawReason, 'REPETITION');
});

test('T-39 连续 120 半步无吃子 → 和棋（用 4 半步配置验证）', () => {
  const g = pos(
    [
      S('RED', 'K', 5, 1),
      S('BLACK', 'K', 5, 10),
      S('BLACK', 'P', 5, 5),
    ],
    'RED',
    { draw: { noCapturePlies: 4, repetition: 99 } }
  );
  doMove(g, [5, 1], [4, 1]);
  doMove(g, [5, 10], [6, 10]);
  doMove(g, [4, 1], [5, 1]);
  doMove(g, [6, 10], [5, 10]);
  assert.equal(g.status, 'DRAW');
  assert.equal(g.drawReason, 'NO_CAPTURE');
});

/* =====================================================================
 * 信息安全（T-40 ~ T-42）
 * ===================================================================== */

test('T-40 下行视图不含暗子的 kind/side', () => {
  const g = new BX.Game({ seed: 'sec-1' });
  const view = g.uiState();
  for (const p of view.pieces) {
    if (p.faceUp) continue;
    assert.equal('kind' in p, false);
    assert.equal('side' in p, false);
  }
  const json = JSON.stringify(view);
  // 开局只应有 2 处 kind（双方将帅）
  assert.equal((json.match(/"kind"/g) || []).length, 2);
  const full = JSON.stringify(g.toJSON());
  assert.equal((full.match(/"kind"/g) || []).length, 0);
});

test('T-41 canCapture 的暗子分支只读 apparentSide（行为验证）', () => {
  const redMover = { side: 'BLACK', kind: 'R', faceUp: false, at: { file: 1, rank: 1 } };
  const targets = [
    { side: 'RED', kind: 'P', faceUp: false, at: { file: 1, rank: 7 } }, // 表观黑 → 可打
    { side: 'BLACK', kind: 'P', faceUp: false, at: { file: 1, rank: 4 } }, // 表观红 → 不可打
  ];
  assert.equal(BX.canCapture(redMover, targets[0]), true);
  assert.equal(BX.canCapture(redMover, targets[1]), false);
});

test('T-42 非法着法错误码不携带隐藏身份', () => {
  const g = pos([HIDDEN('RED', 'R', 1, 1), HIDDEN('BLACK', 'P', 1, 4)]);
  const res = tryMove(g, [1, 1], [1, 4]);
  const text = JSON.stringify(res);
  assert.equal(res.code, 'APPARENT_ALLY');
  assert.ok(!/RED|BLACK|红|黑/.test(text), '错误对象不得暴露真实阵营');
});

/* =====================================================================
 * 操作权与将军基准（T-48 ~ T-56）
 * ===================================================================== */

test('T-48 红方回合：只有红方半场的 15 枚暗子可操作', () => {
  const g = new BX.Game({ seed: 'op-1' });
  const view = g.uiState();
  const hidden = view.pieces.filter((p) => !p.faceUp);
  const operableHidden = hidden.filter((p) => g.canOperate(g.pieceAt(p.file, p.rank)));
  assert.equal(operableHidden.length, 15);
  for (const p of hidden) {
    const can = g.canOperate(g.pieceAt(p.file, p.rank));
    assert.equal(can, p.rank <= 5, `(${p.file},${p.rank})`);
  }
  assert.equal(view.operableIds.length, 16); // 15 暗子 + 红帅
});

test('T-49 红方原点格上的“真黑”暗子，红方必须能操作', () => {
  const g = pos([HIDDEN('BLACK', 'R', 1, 1), S('RED', 'K', 5, 1), S('BLACK', 'K', 5, 10), S('BLACK', 'P', 5, 6)]);
  assert.equal(g.canOperate(g.pieceAt(1, 1)), true);
  assert.ok(movesOf(g, 1, 1).length > 0);
});

test('T-50 黑方原点格上的“真红”暗子，红方不得操作', () => {
  const g = pos([HIDDEN('RED', 'R', 1, 10), S('RED', 'K', 5, 1), S('BLACK', 'K', 5, 10), S('BLACK', 'P', 5, 6)]);
  assert.equal(g.canOperate(g.pieceAt(1, 10)), false);
  assert.deepEqual(movesOf(g, 1, 10), []);
});

test('T-51 黑方原点格上的真红暗子按表观阵营计入对红帅的威胁', () => {
  // 合成局面：红帅在九宫之外，仅用于验证 apparentSide 基准
  const g = pos([S('RED', 'K', 1, 3), HIDDEN('RED', 'R', 1, 10)]);
  assert.equal(BX.apparentSide(g.pieceAt(1, 10)), 'BLACK');
  assert.equal(g.isInCheck('RED'), true);
});

test('T-52 翻面送将：红方走暗子翻出黑车照帅，该着法必须合法', () => {
  const g = pos([
    S('RED', 'K', 5, 1),
    S('BLACK', 'K', 5, 10),
    S('BLACK', 'P', 5, 7),
    HIDDEN('BLACK', 'R', 2, 3), // 真身为黑车，表观为红炮
  ]);
  const res = tryMove(g, [2, 3], [5, 3]);
  assert.equal(res.ok, true, '不得因翻面后送将而拒绝');
  assert.deepEqual(res.event.revealed, { kind: 'R', side: 'BLACK' });
  assert.equal(g.isInCheck('RED'), true);
  assert.equal(g.status, 'PLAYING');
  assert.equal(g.turn, 'BLACK');
});

test('T-53 S-1：黑方不能直接吃掉红帅', () => {
  const g = pos(
    [
      S('RED', 'K', 5, 1),
      S('BLACK', 'K', 5, 10),
      S('BLACK', 'R', 5, 2),
    ],
    'BLACK'
  );
  const res = tryMove(g, [5, 2], [5, 1]);
  assert.equal(res.ok, false);
  assert.equal(res.code, 'GENERAL_SHIELD');
  assert.ok(!movesOf(g, 5, 2).includes('f5r1'));
});

test('T-54 S-2：被将军方的所有合法着法都必须解除将军', () => {
  const g = pos([
    S('RED', 'K', 5, 1),
    S('BLACK', 'K', 5, 10),
    S('BLACK', 'R', 5, 3),
    S('BLACK', 'P', 5, 7),
    S('RED', 'R', 1, 2),
  ]);
  assert.equal(g.isInCheck('RED'), true);
  const moves = g.allLegalMoves('RED');
  assert.ok(moves.length > 0);
  for (const mv of moves) {
    const next = BX.applyMoveRaw(g.state, mv.from, mv.to, false);
    assert.equal(BX.isInCheck(next, 'RED'), false, 'legal move leaves check: ' + BX.coord(mv.from) + '->' + BX.coord(mv.to));
  }
  assert.ok(moves.some((mv) => BX.coord(mv.to) === 'f5r2'), '应有挡将的着法');
});

test('T-55 穷举探测：被拒绝的落点集合不随暗子真实身份变化', () => {
  const variants = [];
  for (const side of ['RED', 'BLACK']) {
    for (const kind of ['A', 'E', 'H', 'R', 'C', 'P']) {
      const g = pos([
        HIDDEN(side, kind, 1, 1),
        S('RED', 'K', 5, 1),
        S('BLACK', 'K', 5, 10),
        S('BLACK', 'P', 5, 6),
        S('RED', 'R', 5, 5),
        HIDDEN('BLACK', 'P', 1, 7),
      ]);
      const rejected = [];
      for (let f = 1; f <= 9; f++) {
        for (let r = 1; r <= 10; r++) {
          if (f === 1 && r === 1) continue;
          if (!tryMove(g, [1, 1], [f, r]).ok) rejected.push(BX.coord({ file: f, rank: r }));
        }
      }
      variants.push(rejected.sort().join(','));
    }
  }
  assert.equal(new Set(variants).size, 1);
});

test('T-56 代码审计基准：L0/L2/L3 全部按公开信息（行为验证）', () => {
  // L0：真黑暗子在红方原点格可操作
  const l0 = pos([HIDDEN('BLACK', 'R', 1, 1), S('RED', 'K', 5, 1), S('BLACK', 'K', 5, 10), S('BLACK', 'P', 5, 6)]);
  assert.equal(l0.canOperate(l0.pieceAt(1, 1)), true);

  // L3：flip=false —— T-52 的局面必须合法（若按翻面后判定则会被拒）
  const l3 = pos([
    S('RED', 'K', 5, 1), S('BLACK', 'K', 5, 10), S('BLACK', 'P', 5, 7), HIDDEN('BLACK', 'R', 2, 3),
  ]);
  assert.equal(tryMove(l3, [2, 3], [5, 3]).ok, true);

  // isInCheck：表观基准（合成局面）
  const check = pos([S('RED', 'K', 1, 3), HIDDEN('RED', 'R', 1, 10)]);
  assert.equal(check.isInCheck('RED'), true);
});

/* =====================================================================
 * 附加：攻击判定与走法生成的一致性
 * ===================================================================== */

test('攻击判定 attacksSquare 与 pseudoMoves 完全一致（随机对局抽样）', () => {
  let checked = 0;
  for (let gameIndex = 0; gameIndex < 6; gameIndex++) {
    const g = new BX.Game({ seed: 'consistency-' + gameIndex });
    for (let round = 0; round < 25 && g.status === 'PLAYING'; round++) {
      const st = g.state;
      for (const p of st.pieces) {
        if (!BX.isAlive(st, p)) continue;
        const pseudo = BX.pseudoMoves(st, p).map((s) => s.file + ',' + s.rank);
        const set = new Set(pseudo);
        for (let f = 1; f <= 9; f++) {
          for (let r = 1; r <= 10; r++) {
            if (f === p.at.file && r === p.at.rank) continue;
            if (st.grid[r][f] == null) continue; // 只比较“占位目标”（攻击 = 可吃）
            const attacked = BX.attacksSquare(st, p, { file: f, rank: r });
            assert.equal(attacked, set.has(f + ',' + r), `mismatch ${BX.coord(p.at)} kind=${p.kind} -> ${BX.coord({ file: f, rank: r })}`);
            checked++;
          }
        }
      }
      const v = g.uiState();
      const ids = Object.keys(v.movesById).filter((id) => v.movesById[id].length);
      if (!ids.length) break;
      const id = ids[Math.floor(Math.random() * ids.length)];
      const piece = g.pieces.find((x) => x.id === Number(id));
      const list = v.movesById[id];
      const mv = list[Math.floor(Math.random() * list.length)];
      const res = g.move({ file: piece.at.file, rank: piece.at.rank }, mv.to);
      assert.equal(res.ok, true);
    }
  }
  assert.ok(checked > 10000);
});

test('平衡模式：mirror 完全对称，fair 强子数差 ≤ 2', () => {
  const mirror = new BX.Game({ seed: 'mirror-1', config: { shuffle: { balance: 'mirror' } } });
  for (const p of mirror.pieces) {
    if (p.kind === 'K') continue;
    const m = mirror.pieceAt(10 - p.at.file, 11 - p.at.rank);
    assert.ok(m, '镜像格应有子');
    assert.equal(m.kind, p.kind);
    assert.notEqual(m.side, p.side);
  }

  for (let i = 0; i < 40; i++) {
    const g = new BX.Game({ seed: 'fair-' + i, config: { shuffle: { balance: 'fair' } } });
    let red = 0;
    let black = 0;
    for (const p of g.pieces) {
      if (!['R', 'H', 'C'].includes(p.kind)) continue;
      if (p.at.rank <= 5) red++; else black++;
    }
    assert.ok(Math.abs(red - black) <= 2, `fair imbalance ${red}/${black}`);
  }
});

test('配置：perSide 摆法只在本方半场；strictCheck 拒绝翻面送将', () => {
  const perSide = new BX.Game({ seed: 'per-side', config: { shuffle: { scope: 'perSide' } } });
  for (const p of perSide.pieces) {
    if (p.kind === 'K') continue;
    assert.equal(BX.ORIGIN_SIDE(p.at), p.side, 'perSide 应各归半场');
  }

  const strict = new BX.Game({
    position: {
      pieces: [
        S('RED', 'K', 5, 1), S('BLACK', 'K', 5, 10), S('BLACK', 'P', 5, 7), HIDDEN('BLACK', 'R', 2, 3),
      ],
      turn: 'RED',
      config: { strictCheck: true },
    },
  });
  const res = strict.move({ file: 2, rank: 3 }, { file: 5, rank: 3 });
  assert.equal(res.ok, false);
  assert.equal(res.code, 'SEND_CHECK');
});
