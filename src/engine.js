/*!
 * 盲棋象棋 Blind Xiangqi — 规则引擎
 * 严格依据 spec.md v1.4 实现。
 *
 * 关键约定（与 spec 对应）：
 *   §4.4 moveSpec      —— 暗子按“所在格的默认棋子”行动；明子仕/象解锁九宫与河界
 *   §6.0 操作权        —— 只能操作 apparentSide === turn 的棋子（绝不读暗子的真实 side）
 *   §6.5 攻击矩阵      —— 暗子按 apparentSide 判敌我；明子可打任何暗子；明子不可打己方明子
 *   §7.2 L3 送将       —— 前瞻模拟必须 flip=false，否则可被逐格探测破解暗子身份
 *   S-1 / S-2          —— 将帅永不可被吃；被将军方必须应将，无解即负
 *
 * 本文件是纯函数式规则核心 + 轻量 Game 封装，可同时在浏览器（window.BlindXiangqi）
 * 与 Node（require）中使用，便于共享给测试、自对弈脚本与前端。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BlindXiangqi = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* =======================================================================
   * 0. 常量
   * ===================================================================== */

  const SIDES = ['RED', 'BLACK'];
  const KINDS = ['K', 'A', 'E', 'H', 'R', 'C', 'P'];

  /** 棋子汉字（§4.1） */
  const NAMES = {
    RED: { K: '帅', A: '仕', E: '相', H: '马', R: '车', C: '炮', P: '兵' },
    BLACK: { K: '将', A: '士', E: '象', H: '马', R: '车', C: '炮', P: '卒' },
  };

  /** 子力价值（仅用于 UI 结算与 AI 估值，不参与规则） */
  const VALUES = { K: 1000, R: 9, C: 4.5, H: 4, A: 2, E: 2, P: 1 };

  const SIDE_NAME = { RED: '红方', BLACK: '黑方' };
  const SIDE_CHAR = { RED: '红', BLACK: '黑' };

  /** §3.5 区域常量 */
  const PALACE = {
    RED: { fileMin: 4, fileMax: 6, rankMin: 1, rankMax: 3 },
    BLACK: { fileMin: 4, fileMax: 6, rankMin: 8, rankMax: 10 },
  };
  const OWN_HALF = { RED: [1, 5], BLACK: [6, 10] };
  const FORWARD = { RED: +1, BLACK: -1 };
  const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  /** 马：[df, dr, 马腿相对 file, 马腿相对 rank]（§10.2） */
  const KNIGHT_OFFSETS = [
    [1, 2, 0, 1], [-1, 2, 0, 1],
    [1, -2, 0, -1], [-1, -2, 0, -1],
    [2, 1, 1, 0], [2, -1, 1, 0],
    [-2, 1, -1, 0], [-2, -1, -1, 0],
  ];

  /** §3.3 原点兵种矩阵：ORIGIN_KIND[rank][file]，非原点格为 null */
  const ORIGIN_KIND = (function buildOriginKindMatrix() {
    const m = Array.from({ length: 11 }, () => Array(10).fill(null));
    const back = ['R', 'H', 'E', 'A', 'K', 'A', 'E', 'H', 'R'];
    back.forEach((k, i) => { m[1][i + 1] = k; m[10][i + 1] = k; });
    [3, 8].forEach((r) => { m[r][2] = 'C'; m[r][8] = 'C'; });
    [4, 7].forEach((r) => { [1, 3, 5, 7, 9].forEach((f) => { m[r][f] = 'P'; }); });
    return m;
  })();

  /** §3.4 原点归属：rank 1–5 属红，6–10 属黑 */
  const ORIGIN_SIDE = (sq) => (sq.rank <= 5 ? 'RED' : 'BLACK');

  /** 30 个非将帅原位置格，顺序固定（rank 升序、file 升序），便于复现 */
  const ORIGIN_SQUARES = (function buildOriginSquares() {
    const out = [];
    for (let rank = 1; rank <= 10; rank++) {
      for (let file = 1; file <= 9; file++) {
        const kind = ORIGIN_KIND[rank][file];
        if (kind && kind !== 'K') out.push({ file, rank });
      }
    }
    return out;
  })();
  const ORIGIN_KEYS = new Set(ORIGIN_SQUARES.map((s) => s.file + ',' + s.rank));

  /** 32 枚棋子的稳定 ID：红 1–16，黑 17–32（将帅固定 1 / 17） */
  const PIECE_DEFS = (function buildPieceDefs() {
    const defs = [];
    let id = 1;
    for (const side of SIDES) {
      defs.push({ id: id++, side, kind: 'K' });
      for (const [kind, n] of [['A', 2], ['E', 2], ['H', 2], ['R', 2], ['C', 2], ['P', 5]]) {
        for (let i = 0; i < n; i++) defs.push({ id: id++, side, kind });
      }
    }
    return defs;
  })();
  const POOL_DEFS = PIECE_DEFS.filter((d) => d.kind !== 'K'); // 30 枚
  const KING_DEF = { RED: PIECE_DEFS.find((d) => d.side === 'RED' && d.kind === 'K'),
                     BLACK: PIECE_DEFS.find((d) => d.side === 'BLACK' && d.kind === 'K') };

  /* =======================================================================
   * 1. 默认配置（§12）
   * ===================================================================== */

  const DEFAULT_CONFIG = {
    shuffle: { scope: 'global', balance: 'none' },
    visibility: 'none',
    hidden: { regionLimited: true },
    revealed: { regionLimits: 'free', kingBoundToPalace: true },
    friendlyFire: 'allow',
    attackHidden: { confirm: 'none' },
    revealOnCapture: true,
    showLegalMoves: true,
    showCheck: true,
    highlightCheckAttacker: true,
    undo: false,
    strictCheck: false,
    draw: { repetition: 3, perpetualCheck: 'lose', noCapturePlies: 120 },
    timer: { mode: 'none' },
    notation: 'coord',
    // v1.5：默认人机对战（PvE）
    mode: 'pve',
    ai: {
      side: 'red',          // 玩家执方：red / black / random
      difficulty: 'normal', // easy / normal / hard
      honesty: 'honest',    // honest / oracle
      thinkMs: 250,
      fakeDelayMs: [200, 600],
      sampleCount: 32,
      qdepth: 4,
      riskLambda: 0.6,
      riskMode: 'mean',
      worstCaseScreen: true,
      consistentWorlds: false,
      seed: null,
      hintPerGame: 3,
    },
  };

  function mergeConfig(user) {
    const out = {};
    for (const key of Object.keys(DEFAULT_CONFIG)) {
      const base = DEFAULT_CONFIG[key];
      const given = user == null ? undefined : user[key];
      if (base && typeof base === 'object' && !Array.isArray(base)) {
        out[key] = Object.assign({}, base, given && typeof given === 'object' ? given : {});
      } else {
        out[key] = given === undefined ? base : given;
      }
    }
    // 允许传入未列出的自定义键（测试用）
    if (user) for (const k of Object.keys(user)) if (!(k in out)) out[k] = user[k];
    const q = Number(out.ai && out.ai.qdepth);
    if (!Number.isFinite(q) || q <= 0) {
      throw new Error('AI: ai.qdepth must be > 0 (quiescence is mandatory)');
    }
    out.ai.qdepth = q;
    return out;
  }

  /* =======================================================================
   * 2. 基础工具
   * ===================================================================== */

  const onBoard = (s) => !!s && s.file >= 1 && s.file <= 9 && s.rank >= 1 && s.rank <= 10;
  const sameSq = (a, b) => !!a && !!b && a.file === b.file && a.rank === b.rank;
  const other = (s) => (s === 'RED' ? 'BLACK' : 'RED');
  const inPalace = (s, side) => {
    const p = PALACE[side];
    return s.file >= p.fileMin && s.file <= p.fileMax && s.rank >= p.rankMin && s.rank <= p.rankMax;
  };
  const inOwnHalf = (s, side) => s.rank >= OWN_HALF[side][0] && s.rank <= OWN_HALF[side][1];
  const crossedRiver = (s, side) => (side === 'RED' ? s.rank >= 6 : s.rank <= 5);
  const sq = (file, rank) => ({ file, rank });
  const coord = (s) => 'f' + s.file + 'r' + s.rank;
  const sameFileRank = (a, b) => a.file === b.file || a.rank === b.rank;

  function sign(n) { return n > 0 ? 1 : n < 0 ? -1 : 0; }

  /* =======================================================================
   * 3. 随机与洗牌（§5.2）
   * ===================================================================== */

  function hashSeed(str) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < String(str).length; i++) {
      h ^= String(str).charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }

  function mulberry32(a) {
    let x = a >>> 0;
    return function () {
      x = (x + 0x6D2B79F5) | 0;
      let t = Math.imul(x ^ (x >>> 15), 1 | x);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** Fisher–Yates 无偏洗牌（禁止 sort(random-0.5)） */
  function shuffle(arr, rand) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      const tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
    }
    return arr;
  }

  function randomSeed() {
    return (
      Date.now().toString(36) +
      '-' +
      Math.random().toString(36).slice(2, 8)
    );
  }

  /* =======================================================================
   * 4. 局面基础查询
   * ===================================================================== */

  function emptyState(config, seed) {
    return {
      config: config || mergeConfig(),
      seed: seed || randomSeed(),
      layoutSeed: seed || null,
      pieces: [],
      grid: Array.from({ length: 11 }, () => Array(10).fill(null)),
      turn: 'RED',
      ply: 0,
      status: 'PLAYING',
      drawReason: null,
      inCheck: { RED: false, BLACK: false },
      history: [],
      positionCounts: new Map(),
      pliesSinceCapture: 0,
      stats: {
        flips: 0,
        captures: 0,
        friendlyFire: 0,
        hiddenMoves: 0,
        checks: 0,
        selfChecks: 0,
      },
    };
  }

  function pieceAt(state, s) {
    if (!onBoard(s)) return null;
    const id = state.grid[s.rank][s.file];
    if (id == null) return null;
    return state.pieces.find((p) => p.id === id) || null;
  }

  function isAlive(state, p) {
    return !!p && !!state.grid[p.at.rank] && state.grid[p.at.rank][p.at.file] === p.id;
  }

  function alivePieces(state) {
    return state.pieces.filter((p) => isAlive(state, p));
  }

  function generalSquare(state, side) {
    for (const p of state.pieces) {
      if (p.kind === 'K' && p.side === side && isAlive(state, p)) return { file: p.at.file, rank: p.at.rank };
    }
    return null;
  }

  function pieceById(state, id) {
    return state.pieces.find((p) => p.id === id) || null;
  }

  /* =======================================================================
   * 5. moveSpec / apparentSide（§4.4 —— 整套规则的心脏）
   * ===================================================================== */

  function moveSpec(p, config) {
    const cfg = config || DEFAULT_CONFIG;
    if (p.faceUp) {
      let regionLimited = p.kind === 'K' || p.kind === 'P'; // 帅将锁宫；兵保留过河规则
      if (cfg.revealed.regionLimits === 'classic' && (p.kind === 'A' || p.kind === 'E')) regionLimited = true;
      if (p.kind === 'K' && !cfg.revealed.kingBoundToPalace) regionLimited = false;
      return { kind: p.kind, side: p.side, regionLimited };
    }
    // 暗子 = 该格默认棋子：兵种、方向、九宫、河界全部照搬
    const originKind = ORIGIN_KIND[p.at.rank] ? ORIGIN_KIND[p.at.rank][p.at.file] : null;
    return {
      kind: originKind || 'P', // 理论上暗子只可能停在原位置格（§6.2）；兜底避免崩溃
      side: ORIGIN_SIDE(p.at),
      regionLimited: !!cfg.hidden.regionLimited,
    };
  }

  /** 表观阵营：敌我判定的唯一依据，且完全公开 */
  function apparentSide(p) {
    return p.faceUp ? p.side : ORIGIN_SIDE(p.at);
  }

  /** §6.0 操作权：按表观阵营，绝不读暗子的真实 side */
  function canOperate(p, turn) {
    return !!p && apparentSide(p) === turn;
  }

  /* =======================================================================
   * 6. 走法生成（§10.3）
   * ===================================================================== */

  /** 返回 L1 可达格（含可吃目标，未做目标许可与终局安全） */
  function pseudoMoves(state, p) {
    const cfg = state.config;
    const { kind, side, regionLimited } = moveSpec(p, cfg);
    const at = p.at;
    const out = [];
    const occ = (s) => pieceAt(state, s);

    switch (kind) {
      case 'K':
        for (const [df, dr] of DIRS) {
          const s = sq(at.file + df, at.rank + dr);
          if (!onBoard(s)) continue;
          if (regionLimited && !inPalace(s, side)) continue;
          out.push(s);
        }
        break;

      case 'A':
        for (const [df, dr] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
          const s = sq(at.file + df, at.rank + dr);
          if (!onBoard(s)) continue;
          if (regionLimited && !inPalace(s, side)) continue;
          out.push(s);
        }
        break;

      case 'E':
        for (const [df, dr] of [[2, 2], [2, -2], [-2, 2], [-2, -2]]) {
          const s = sq(at.file + df, at.rank + dr);
          if (!onBoard(s)) continue;
          if (regionLimited && !inOwnHalf(s, side)) continue; // 象不过河（暗子）
          if (occ(sq(at.file + df / 2, at.rank + dr / 2))) continue; // 塞象眼
          out.push(s);
        }
        break;

      case 'H':
        for (const [df, dr, lf, lr] of KNIGHT_OFFSETS) {
          const s = sq(at.file + df, at.rank + dr);
          if (!onBoard(s)) continue;
          if (occ(sq(at.file + lf, at.rank + lr))) continue; // 马腿
          out.push(s);
        }
        break;

      case 'R':
        for (const [df, dr] of DIRS) {
          let s = sq(at.file + df, at.rank + dr);
          while (onBoard(s)) {
            out.push(s);
            if (occ(s)) break; // 被挡即停（含第一个被占格）
            s = sq(s.file + df, s.rank + dr);
          }
        }
        break;

      case 'C': {
        for (const [df, dr] of DIRS) {
          const step = (s) => sq(s.file + df, s.rank + dr);
          let s = step(at);
          // ① 无炮架段：直线走子，遇子即止
          while (onBoard(s) && !occ(s)) { out.push(s); s = step(s); }
          if (!onBoard(s)) continue;
          // ② 跨过炮架
          s = step(s);
          // ③ 炮架之后的第一个棋子 = 吃子目标
          while (onBoard(s) && !occ(s)) s = step(s);
          if (onBoard(s)) out.push(s);
        }
        break;
      }

      case 'P': {
        const f = FORWARD[side];
        const fwd = sq(at.file, at.rank + f);
        if (onBoard(fwd)) out.push(fwd);
        if (crossedRiver(at, side)) {
          // 过河后（按 spec.side 判定）可横走一格
          for (const df of [-1, 1]) {
            const s = sq(at.file + df, at.rank);
            if (onBoard(s)) out.push(s);
          }
        }
        break;
      }
    }
    return out;
  }

  /**
   * 单点攻击判定：p 是否攻击 target（与 pseudoMoves 语义一致，O(1) 级）。
   * 仅供将军判定与威胁分析使用，独立实现以避免数组分配。
   */
  function attacksSquare(state, p, target) {
    if (!p || !onBoard(target)) return false;
    const { kind, side, regionLimited } = moveSpec(p, state.config);
    const at = p.at;
    const df = target.file - at.file;
    const dr = target.rank - at.rank;

    switch (kind) {
      case 'K':
        return Math.abs(df) + Math.abs(dr) === 1 && (!regionLimited || inPalace(target, side));
      case 'A':
        return Math.abs(df) === 1 && Math.abs(dr) === 1 && (!regionLimited || inPalace(target, side));
      case 'E':
        if (Math.abs(df) !== 2 || Math.abs(dr) !== 2) return false;
        if (regionLimited && !inOwnHalf(target, side)) return false;
        return !pieceAt(state, sq(at.file + df / 2, at.rank + dr / 2));
      case 'H': {
        const absF = Math.abs(df), absR = Math.abs(dr);
        if (!((absF === 1 && absR === 2) || (absF === 2 && absR === 1))) return false;
        const lf = absF === 2 ? sign(df) : 0;
        const lr = absR === 2 ? sign(dr) : 0;
        return !pieceAt(state, sq(at.file + lf, at.rank + lr));
      }
      case 'R':
        return lineAttacks(state, at, target, 0);
      case 'C':
        return lineAttacks(state, at, target, 1);
      case 'P': {
        if (df === 0 && dr === FORWARD[side]) return true;
        if (dr === 0 && Math.abs(df) === 1 && crossedRiver(at, side)) return true;
        return false;
      }
    }
    return false;
  }

  /** 同线攻击：路径上恰有 screensNeeded 枚棋子（车=0，炮=1） */
  function lineAttacks(state, from, to, screensNeeded) {
    if (from.file !== to.file && from.rank !== to.rank) return false;
    const df = sign(to.file - from.file);
    const dr = sign(to.rank - from.rank);
    let f = from.file + df, r = from.rank + dr;
    let screens = 0;
    while (f !== to.file || r !== to.rank) {
      if (state.grid[r][f] != null) screens++;
      if (screens > screensNeeded) return false;
      f += df; r += dr;
    }
    return screens === screensNeeded;
  }

  /** §6.5 攻击矩阵（S-1：将帅永不可被直接吃掉） */
  function canCapture(mover, target) {
    if (!target) return false;
    if (target.faceUp && target.kind === 'K') return false; // S-1
    if (mover.faceUp) {
      // 明子：可打任何暗子（可能误伤）；对明子按真实阵营判敌我
      return !target.faceUp || target.side !== mover.side;
    }
    // 暗子：一律按表观阵营判敌我（绝不读真实 side）
    return apparentSide(mover) !== apparentSide(target);
  }

  /* =======================================================================
   * 7. 模拟与终局安全（make / unmake，避免深拷贝）
   * ===================================================================== */

  function simulate(state, p, to, flip) {
    const from = p.at;
    const target = pieceAt(state, to);
    const undo = { p, from: { file: from.file, rank: from.rank }, to: { file: to.file, rank: to.rank }, target, faceUp: p.faceUp };
    state.grid[from.rank][from.file] = null;
    state.grid[to.rank][to.file] = p.id;
    p.at = { file: to.file, rank: to.rank };
    if (flip && !p.faceUp) p.faceUp = true;
    return undo;
  }

  function unsimulate(state, undo) {
    const p = undo.p;
    p.at = undo.from;
    p.faceUp = undo.faceUp;
    state.grid[undo.to.rank][undo.to.file] = undo.target ? undo.target.id : null;
    state.grid[undo.from.rank][undo.from.file] = p.id;
  }

  /** §7.4 将军：基准是 apparentSide */
  function isInCheck(state, side) {
    const gs = generalSquare(state, side);
    if (!gs) return false;
    for (const p of state.pieces) {
      if (!isAlive(state, p)) continue;
      if (apparentSide(p) === side) continue;
      if (attacksSquare(state, p, gs)) return true;
    }
    return false;
  }

  /** §7.3 照面（暗子算阻挡） */
  function generalsFaceToFace(state) {
    const a = generalSquare(state, 'RED');
    const b = generalSquare(state, 'BLACK');
    if (!a || !b || a.file !== b.file) return false;
    const lo = Math.min(a.rank, b.rank);
    const hi = Math.max(a.rank, b.rank);
    for (let r = lo + 1; r < hi; r++) {
      if (state.grid[r][a.file] != null) return false;
    }
    return true;
  }

  function recomputeCheck(state) {
    state.inCheck.RED = isInCheck(state, 'RED');
    state.inCheck.BLACK = isInCheck(state, 'BLACK');
  }

  /* =======================================================================
   * 8. 合法性（§7）
   * ===================================================================== */

  /** 返回 p 在 side 回合的全部合法着法（含公开的吃子目标信息） */
  function legalMovesFor(state, p, side) {
    if (!p || !isAlive(state, p)) return [];
    if (apparentSide(p) !== side) return [];
    const cfg = state.config;
    const out = [];
    for (const to of pseudoMoves(state, p)) {
      const target = pieceAt(state, to);
      if (target && target.id === p.id) continue;
      if (target && target.faceUp && target.kind === 'K') continue; // S-1
      if (target && !canCapture(p, target)) continue;
      const undo = simulate(state, p, to, !!cfg.strictCheck);
      const ok = !isInCheck(state, side) && !generalsFaceToFace(state);
      unsimulate(state, undo);
      if (!ok) continue;
      out.push({
        to: { file: to.file, rank: to.rank },
        capture: target
          ? {
              id: target.id,
              faceUp: target.faceUp,
              kind: target.faceUp ? target.kind : undefined,
              side: target.faceUp ? target.side : undefined,
            }
          : null,
      });
    }
    return out;
  }

  function hasAnyLegalMove(state, side) {
    const cfg = state.config;
    for (const p of state.pieces) {
      if (!isAlive(state, p) || apparentSide(p) !== side) continue;
      for (const to of pseudoMoves(state, p)) {
        const target = pieceAt(state, to);
        if (target && target.faceUp && target.kind === 'K') continue;
        if (target && !canCapture(p, target)) continue;
        const undo = simulate(state, p, to, !!cfg.strictCheck);
        const ok = !isInCheck(state, side) && !generalsFaceToFace(state);
        unsimulate(state, undo);
        if (ok) return true;
      }
    }
    return false;
  }

  function allLegalMoves(state, side) {
    const out = [];
    for (const p of state.pieces) {
      if (!isAlive(state, p) || apparentSide(p) !== side) continue;
      const from = { file: p.at.file, rank: p.at.rank };
      for (const mv of legalMovesFor(state, p, side)) out.push({ from, to: mv.to, capture: mv.capture, pieceId: p.id });
    }
    return out;
  }

  /**
   * 详细校验（UI 提示用），返回 code 便于做“不泄露”的文案。
   * code: NO_PIECE | NOT_YOUR_PIECE | OUT_OF_BOARD | SAME_SQUARE | GENERAL_SHIELD
   *     | GEOMETRY | OWN_PIECE | APPARENT_ALLY | SEND_CHECK | FACE_TO_FACE
   */
  function checkMove(state, from, to) {
    if (!onBoard(from) || !onBoard(to)) return { ok: false, code: 'OUT_OF_BOARD' };
    if (sameSq(from, to)) return { ok: false, code: 'SAME_SQUARE' };
    const mover = pieceAt(state, from);
    if (!mover) return { ok: false, code: 'NO_PIECE' };
    if (apparentSide(mover) !== state.turn) return { ok: false, code: 'NOT_YOUR_PIECE' };
    const target = pieceAt(state, to);
    if (target && target.faceUp && target.kind === 'K') return { ok: false, code: 'GENERAL_SHIELD' };
    if (!pseudoMoves(state, mover).some((s) => sameSq(s, to))) return { ok: false, code: 'GEOMETRY' };
    if (target && !canCapture(mover, target)) {
      // 暗子的判定基准是表观阵营 → 提示“友军”；明子才是“己方棋子”
      return { ok: false, code: mover.faceUp ? 'OWN_PIECE' : 'APPARENT_ALLY' };
    }
    const undo = simulate(state, mover, to, !!state.config.strictCheck);
    const checked = isInCheck(state, state.turn);
    if (checked) { unsimulate(state, undo); return { ok: false, code: 'SEND_CHECK' }; }
    const faced = generalsFaceToFace(state);
    if (faced) { unsimulate(state, undo); return { ok: false, code: 'FACE_TO_FACE' }; }
    unsimulate(state, undo);
    return { ok: true, mover, target };
  }

  /* =======================================================================
   * 9. 执行着法（§10.5）
   * ===================================================================== */

  function moveNotation(ev) {
    return coord(ev.from) + '→' + coord(ev.to);
  }

  function applyMove(state, from, to) {
    const mover = pieceAt(state, from);
    const target = pieceAt(state, to);
    if (!mover) throw new Error('applyMove: no piece at ' + coord(from));

    const ev = {
      ply: state.ply + 1,
      side: state.turn,
      from: { file: from.file, rank: from.rank },
      to: { file: to.file, rank: to.rank },
      moverId: mover.id,
      moverWasFaceUp: mover.faceUp,
      captured: null,
      revealed: null,
    };

    if (target) {
      state.grid[target.at.rank][target.at.file] = null;
      ev.captured = {
        id: target.id,
        kind: target.kind,
        side: target.side,
        wasFaceUp: target.faceUp,
        friendlyFire: target.side === mover.side, // 误伤按真实阵营结算（§6.4 / D6）
      };
      state.stats.captures++;
      if (ev.captured.friendlyFire) state.stats.friendlyFire++;
      state.pliesSinceCapture = 0;
    } else {
      state.pliesSinceCapture++;
    }

    // 移动
    state.grid[from.rank][from.file] = null;
    mover.at = { file: to.file, rank: to.rank };
    state.grid[to.rank][to.file] = mover.id;

    // 翻面（在目标格）。翻面可能改变 apparentSide → 必须重算将军
    if (!mover.faceUp) {
      mover.faceUp = true;
      ev.revealed = { kind: mover.kind, side: mover.side };
      state.stats.flips++;
      state.stats.hiddenMoves++;
    }

    state.ply = ev.ply;
    state.turn = other(state.turn);
    recomputeCheck(state);
    ev.check = { RED: state.inCheck.RED, BLACK: state.inCheck.BLACK };
    if (ev.check[other(ev.side)]) state.stats.checks++;
    if (ev.check[ev.side]) state.stats.selfChecks++;
    ev.notation = moveNotation(ev);

    state.history.push(ev);
    recordPosition(state);
    evaluateStatus(state);
    return ev;
  }

  /** 纯函数前瞻：深拷贝后执行“删除目标 + 移动 + 可选翻面”，不切换回合 */
  function cloneState(state) {
    const pieces = state.pieces.map((p) => ({
      id: p.id, side: p.side, kind: p.kind, faceUp: p.faceUp,
      at: { file: p.at.file, rank: p.at.rank },
    }));
    const grid = Array.from({ length: 11 }, () => Array(10).fill(null));
    for (const p of state.pieces) {
      if (state.grid[p.at.rank][p.at.file] === p.id) grid[p.at.rank][p.at.file] = p.id;
    }
    return {
      config: state.config,
      seed: state.seed,
      layoutSeed: state.layoutSeed,
      pieces,
      grid,
      turn: state.turn,
      ply: state.ply,
      status: state.status,
      drawReason: state.drawReason,
      inCheck: { RED: state.inCheck.RED, BLACK: state.inCheck.BLACK },
      history: state.history.slice(),
      positionCounts: new Map(Array.from(state.positionCounts, ([k, v]) => [k, v.slice()])),
      pliesSinceCapture: state.pliesSinceCapture,
      stats: Object.assign({}, state.stats),
    };
  }

  function applyMoveRaw(state, from, to, flip) {
    const next = cloneState(state);
    const p = pieceAt(next, from);
    if (!p) throw new Error('applyMoveRaw: no piece');
    simulate(next, p, to, !!flip);
    recomputeCheck(next);
    return next;
  }

  /* =======================================================================
   * 10. 局面重复与终局（§7.6 / §9）
   * ===================================================================== */

  function positionKey(state) {
    const parts = alivePieces(state)
      .map((p) => p.at.rank + '' + p.at.file + ':' + p.side + p.kind + ':' + (p.faceUp ? 1 : 0))
      .sort();
    return state.turn + '|' + parts.join(',');
  }

  function recordPosition(state) {
    const key = positionKey(state);
    const arr = state.positionCounts.get(key) || [];
    arr.push(state.ply);
    state.positionCounts.set(key, arr);
    return key;
  }

  /** §9.3 长将：第三次出现时，期间该方每一步都在将军 → 该方判负 */
  function perpetualCheckLoser(state, key) {
    if (state.config.draw.perpetualCheck !== 'lose') return null;
    const occ = state.positionCounts.get(key);
    if (!occ || occ.length < state.config.draw.repetition) return null;
    const first = occ[0];
    const lastSide = other(state.turn);
    const eventos = state.history.filter((e) => e.ply > first && e.side === lastSide);
    if (!eventos.length) return null;
    const allCheck = eventos.every((e) => e.check && e.check[other(lastSide)]);
    return allCheck ? lastSide : null;
  }

  function setStatus(state, status, reason) {
    state.status = status;
    state.drawReason = reason || null;
    return { status, reason: reason || null };
  }

  function evaluateStatus(state) {
    const side = state.turn;
    // 只有轮到走棋的一方才可能被将死/困毙
    if (!hasAnyLegalMove(state, side)) {
      const mate = isInCheck(state, side);
      return setStatus(state, side === 'RED' ? 'BLACK_WIN' : 'RED_WIN', mate ? 'CHECKMATE' : 'STALEMATE');
    }
    const key = positionKey(state);
    const loser = perpetualCheckLoser(state, key);
    if (loser) {
      return setStatus(state, loser === 'RED' ? 'BLACK_WIN' : 'RED_WIN', 'PERPETUAL_CHECK');
    }
    const occ = state.positionCounts.get(key);
    if (occ && occ.length >= state.config.draw.repetition) return setStatus(state, 'DRAW', 'REPETITION');
    if (state.pliesSinceCapture >= state.config.draw.noCapturePlies) return setStatus(state, 'DRAW', 'NO_CAPTURE');
    return setStatus(state, 'PLAYING', null);
  }

  const REASON_TEXT = {
    CHECKMATE: '将死',
    STALEMATE: '困毙',
    RESIGN: '认输',
    TIMEOUT: '超时',
    PERPETUAL_CHECK: '长将判负',
    REPETITION: '三次重复局面',
    NO_CAPTURE: '自然限着（120 半步无吃子）',
    AGREEMENT: '双方同意和棋',
  };

  function resultText(status, reason) {
    if (status === 'DRAW') return '和棋 · ' + (REASON_TEXT[reason] || '');
    if (status === 'RED_WIN' || status === 'BLACK_WIN') {
      const win = status === 'RED_WIN' ? '红方' : '黑方';
      const lose = status === 'RED_WIN' ? '黑方' : '红方';
      const why = reason === 'PERPETUAL_CHECK' ? '长将判负'
        : reason === 'RESIGN' ? '认输'
        : reason === 'TIMEOUT' ? '超时'
        : reason === 'CHECKMATE' ? '被将死'
        : reason === 'STALEMATE' ? '无子可动（困毙）'
        : (REASON_TEXT[reason] || '');
      return win + '胜 · ' + lose + why;
    }
    return '对局进行中';
  }

  /* =======================================================================
   * 11. 开局与洗牌（§5）
   * ===================================================================== */

  /** 生成 30 枚棋子的落位（含平衡模式） */
  function buildAssignment(rand, cfg) {
    const scope = cfg.shuffle.scope;
    const balance = cfg.shuffle.balance;
    const redDefs = POOL_DEFS.filter((d) => d.side === 'RED');
    const blackDefs = POOL_DEFS.filter((d) => d.side === 'BLACK');
    const redSquares = ORIGIN_SQUARES.filter((s) => ORIGIN_SIDE(s) === 'RED');
    const blackSquares = ORIGIN_SQUARES.filter((s) => ORIGIN_SIDE(s) === 'BLACK');
    const out = [];

    if (scope === 'perSide') {
      // 复古变体：各 15 枚摆自己半场（等同揭棋摆法）
      const r = shuffle(redDefs.slice(), rand);
      const b = shuffle(blackDefs.slice(), rand);
      redSquares.forEach((s, i) => out.push({ def: r[i], sq: s }));
      blackSquares.forEach((s, i) => out.push({ def: b[i], sq: s }));
      return out;
    }

    if (balance === 'mirror') {
      // 只洗红方，黑方按中心对称复制（绝对公平）
      const r = shuffle(redDefs.slice(), rand);
      const byKind = new Map();
      for (const d of blackDefs) {
        if (!byKind.has(d.kind)) byKind.set(d.kind, []);
        byKind.get(d.kind).push(d);
      }
      redSquares.forEach((s, i) => {
        const red = r[i];
        out.push({ def: red, sq: s });
        const queue = byKind.get(red.kind);
        out.push({ def: queue.pop(), sq: { file: 10 - s.file, rank: 11 - s.rank } });
      });
      return out;
    }

    // 默认 D1：30 枚全局混合洗牌
    const all = shuffle(POOL_DEFS.slice(), rand);
    ORIGIN_SQUARES.forEach((s, i) => out.push({ def: all[i], sq: s }));
    return out;
  }

  /** fair 模式：双方各自“开局可操作到的强子（R/H/C）数量”差不超过 2 */
  function assignmentIsFair(assignment) {
    let redStrong = 0;
    let blackStrong = 0;
    for (const { def, sq } of assignment) {
      if (def.kind !== 'R' && def.kind !== 'H' && def.kind !== 'C') continue;
      if (ORIGIN_SIDE(sq) === 'RED') redStrong++;
      else blackStrong++;
    }
    return Math.abs(redStrong - blackStrong) <= 2;
  }

  function placeAssignment(state, assignment) {
    state.pieces = [];
    state.grid = Array.from({ length: 11 }, () => Array(10).fill(null));
    for (const { def, sq } of assignment) {
      const piece = { id: def.id, side: def.side, kind: def.kind, faceUp: false, at: { file: sq.file, rank: sq.rank } };
      state.pieces.push(piece);
      state.grid[sq.rank][sq.file] = piece.id;
    }
    for (const side of SIDES) {
      const def = KING_DEF[side];
      const at = side === 'RED' ? { file: 5, rank: 1 } : { file: 5, rank: 10 };
      const king = { id: def.id, side, kind: 'K', faceUp: true, at };
      state.pieces.push(king);
      state.grid[at.rank][at.file] = king.id;
    }
  }

  function resetForSetup(state) {
    state.pieces = [];
    state.grid = Array.from({ length: 11 }, () => Array(10).fill(null));
    state.turn = 'RED';
    state.ply = 0;
    state.status = 'PLAYING';
    state.drawReason = null;
    state.inCheck = { RED: false, BLACK: false };
    state.history = [];
    state.positionCounts = new Map();
    state.pliesSinceCapture = 0;
    state.stats = { flips: 0, captures: 0, friendlyFire: 0, hiddenMoves: 0, checks: 0, selfChecks: 0 };
  }

  /** §5.3 开局不变量 */
  function verifySetup(state) {
    const alive = alivePieces(state);
    if (alive.length !== 32) return 'INV-1: piece count';
    const hidden = alive.filter((p) => !p.faceUp);
    if (hidden.length !== 30) return 'INV-1: hidden count';
    if (!hidden.every((p) => ORIGIN_KEYS.has(p.at.file + ',' + p.at.rank))) return 'INV-1: hidden off origin';
    if (isInCheck(state, 'RED') || isInCheck(state, 'BLACK')) return 'INV-2: check at setup';
    if (generalsFaceToFace(state)) return 'INV-3: face to face';
    // §8.8 暗子在原位置格必有走法
    for (const p of hidden) {
      if (pseudoMoves(state, p).length === 0) return 'INV-4: hidden immobilized';
    }
    return null;
  }

  function setupState(state) {
    resetForSetup(state);
    const cfg = state.config;
    let lastError = null;
    for (let attempt = 0; attempt < 300; attempt++) {
      const useSeed = attempt === 0 ? String(state.seed) : state.seed + '#' + attempt;
      const rand = mulberry32(hashSeed(useSeed));
      const assignment = buildAssignment(rand, cfg);
      if (cfg.shuffle.balance === 'fair' && !assignmentIsFair(assignment)) continue;
      resetForSetup(state);
      placeAssignment(state, assignment);
      state.layoutSeed = useSeed;
      const err = verifySetup(state);
      if (err) { lastError = err; continue; }
      recordPosition(state);
      evaluateStatus(state);
      return state;
    }
    throw new Error('setup failed after 300 attempts: ' + lastError);
  }

  /* =======================================================================
   * 12. 公开视图（UI 唯一可用的数据通道）
   * ===================================================================== */

  function publicCaptured(cap, config) {
    if (!cap) return null;
    // 误伤必须“疼得明白”：即使关闭 revealOnCapture，也揭示误伤目标
    const revealed = cap.wasFaceUp || config.revealOnCapture || cap.friendlyFire;
    const out = {
      id: cap.id,
      wasFaceUp: cap.wasFaceUp,
      friendlyFire: cap.friendlyFire,
      hiddenWhenCaptured: !cap.wasFaceUp,
      revealed,
    };
    // 未揭示的暗子：绝不下发 kind/side（连键都不出现，便于抓包审计）
    if (revealed) { out.kind = cap.kind; out.side = cap.side; }
    return out;
  }

  function publicEvent(ev, config) {
    return {
      ply: ev.ply,
      side: ev.side,
      from: { file: ev.from.file, rank: ev.from.rank },
      to: { file: ev.to.file, rank: ev.to.rank },
      notation: ev.notation,
      moverId: ev.moverId,
      moverWasFaceUp: ev.moverWasFaceUp,
      revealed: ev.revealed ? { kind: ev.revealed.kind, side: ev.revealed.side } : null,
      captured: publicCaptured(ev.captured, config),
      check: { RED: !!(ev.check && ev.check.RED), BLACK: !!(ev.check && ev.check.BLACK) },
    };
  }

  function buildUiState(state) {
    const alive = alivePieces(state);
    const pieces = alive.map((p) => {
      const base = {
        id: p.id,
        file: p.at.file,
        rank: p.at.rank,
        faceUp: p.faceUp,
        isGeneral: p.kind === 'K',
      };
      if (p.faceUp) { base.kind = p.kind; base.side = p.side; }
      return base;
    });
    const operableIds = [];
    const movesById = {};
    if (state.status === 'PLAYING') {
      for (const p of alive) {
        if (apparentSide(p) !== state.turn) continue;
        operableIds.push(p.id);
        movesById[p.id] = legalMovesFor(state, p, state.turn);
      }
    }
    const checkerSquares = { RED: [], BLACK: [] };
    for (const side of SIDES) {
      if (!state.inCheck[side]) continue;
      const gs = generalSquare(state, side);
      if (!gs) continue;
      for (const p of alive) {
        if (apparentSide(p) === side) continue;
        if (attacksSquare(state, p, gs)) checkerSquares[side].push({ file: p.at.file, rank: p.at.rank });
      }
    }
    const last = state.history[state.history.length - 1] || null;
    const recentCaptures = [];
    for (const ev of state.history) {
      if (!ev.captured) continue;
      const c = publicCaptured(ev.captured, state.config);
      recentCaptures.push(Object.assign(c, {
        bySide: ev.side,
        ply: ev.ply,
        at: { file: ev.to.file, rank: ev.to.rank },
      }));
    }
    return {
      seed: state.seed,
      layoutSeed: state.layoutSeed,
      ply: state.ply,
      turn: state.turn,
      status: state.status,
      drawReason: state.drawReason,
      inCheck: { RED: state.inCheck.RED, BLACK: state.inCheck.BLACK },
      checkerSquares,
      pieces,
      operableIds,
      movesById,
      lastMove: last ? { from: last.from, to: last.to, ply: last.ply, side: last.side } : null,
      history: state.history.map((e) => publicEvent(e, state.config)),
      captures: recentCaptures,
      stats: Object.assign({}, state.stats),
      config: JSON.parse(JSON.stringify(state.config)),
      canUndo: !!state.config.undo && state.history.length > 0,
      result: state.status === 'PLAYING' ? null : resultText(state.status, state.drawReason),
      resultReason: state.drawReason,
    };
  }

  /* =======================================================================
   * 12b. 公开状态 / 信念池 / 采样世界（v1.5 §12）
   * ===================================================================== */

  /** 非将帅棋子的初始数量（公开信息，用于推导信念池） */
  const INITIAL_PIECE_COUNTS = { A: 2, E: 2, H: 2, R: 2, C: 2, P: 5 };
  const POOL_KIND_ORDER = ['A', 'E', 'H', 'R', 'C', 'P'];

  /**
   * 当前仍未揭示的棋子多重集合。
   * 只依赖公开信息：从初始 30 枚里扣掉“已翻面”与“已被揭示的被吃子”。
   * 全局混洗下，剩下的身份对 AI 而言就是无放回抽样池（§12.3）。
   */
  function publicPool(state) {
    const counts = {
      RED: Object.assign({}, INITIAL_PIECE_COUNTS),
      BLACK: Object.assign({}, INITIAL_PIECE_COUNTS),
    };
    for (const p of state.pieces) {
      if (p.kind === 'K') continue;
      let known = p.faceUp;
      if (!known && !isAlive(state, p)) {
        const ev = state.history.find((e) => e.captured && e.captured.id === p.id);
        if (ev) known = ev.captured.wasFaceUp || state.config.revealOnCapture || ev.captured.friendlyFire;
      }
      if (!known) continue;
      if (!counts[p.side] || counts[p.side][p.kind] === undefined) continue;
      counts[p.side][p.kind] = Math.max(0, counts[p.side][p.kind] - 1);
    }
    const pool = [];
    for (const side of SIDES) {
      for (const kind of POOL_KIND_ORDER) {
        for (let i = 0; i < counts[side][kind]; i++) pool.push({ side, kind });
      }
    }
    return pool;
  }

  /**
   * AI 唯一可见的输入（§12.2 / T-60）。
   * 暗子只有 originKind / originSide，绝无真实 kind / side。
   */
  function buildPublicState(state) {
    const alive = alivePieces(state);
    const pieces = alive.map((p) => {
      const base = {
        id: p.id,
        file: p.at.file,
        rank: p.at.rank,
        faceUp: p.faceUp,
        isGeneral: p.kind === 'K',
      };
      if (p.faceUp) {
        base.kind = p.kind;
        base.side = p.side;
      } else {
        base.originKind = ORIGIN_KIND[p.at.rank][p.at.file];
        base.originSide = ORIGIN_SIDE(p.at);
      }
      return base;
    });
    const legalMoves = state.status === 'PLAYING'
      ? allLegalMoves(state, state.turn).map((mv) => {
          let capture = null;
          if (mv.capture) {
            capture = { id: mv.capture.id, faceUp: mv.capture.faceUp, hidden: !mv.capture.faceUp };
            if (mv.capture.faceUp) {
              capture.kind = mv.capture.kind;
              capture.side = mv.capture.side;
            }
          }
          return {
            from: { file: mv.from.file, rank: mv.from.rank },
            to: { file: mv.to.file, rank: mv.to.rank },
            pieceId: mv.pieceId,
            capture,
          };
        })
      : [];
    const ui = buildUiState(state);
    return {
      seed: state.seed,
      layoutSeed: state.layoutSeed,
      ply: state.ply,
      turn: state.turn,
      status: state.status,
      drawReason: state.drawReason,
      inCheck: { RED: state.inCheck.RED, BLACK: state.inCheck.BLACK },
      pieces,
      hiddenCount: pieces.filter((p) => !p.faceUp).length,
      hiddenSquares: pieces.filter((p) => !p.faceUp).map((p) => ({ id: p.id, file: p.file, rank: p.rank })),
      legalMoves,
      pool: publicPool(state),
      history: ui.history,
      stats: ui.stats,
      config: JSON.parse(JSON.stringify(state.config)),
      kings: {
        RED: generalSquare(state, 'RED'),
        BLACK: generalSquare(state, 'BLACK'),
      },
    };
  }

  /** 从一个公开状态 + 信念池，抽一个“完整世界”（暗子被赋上抽样身份） */
  function sampleWorld(publicState, rng) {
    const hidden = publicState.pieces.filter((p) => !p.faceUp).slice().sort((a, b) => a.id - b.id);
    const pool = publicState.pool.slice();
    if (pool.length < hidden.length) {
      throw new Error('belief pool smaller than hidden count');
    }
    shuffle(pool, rng); // 无放回均匀抽样
    const assigned = new Map();
    hidden.forEach((h, i) => assigned.set(h.id, pool[i]));
    const pieces = publicState.pieces.map((p) => {
      if (p.faceUp) {
        return { id: p.id, side: p.side, kind: p.kind, faceUp: true, file: p.file, rank: p.rank };
      }
      const a = assigned.get(p.id);
      return { id: p.id, side: a.side, kind: a.kind, faceUp: false, file: p.file, rank: p.rank };
    });
    const world = createPosition({
      pieces,
      turn: publicState.turn,
      config: publicState.config,
      seed: publicState.seed,
    });
    world.ply = publicState.ply;
    return world;
  }

  /** 仅 oracle 模式：用真实身份构建世界（AI 会看到隐藏信息，UI 必须标红） */
  function buildOracleWorld(state) {
    const pieces = alivePieces(state).map((p) => ({
      id: p.id,
      side: p.side,
      kind: p.kind,
      faceUp: p.faceUp,
      file: p.at.file,
      rank: p.at.rank,
    }));
    const world = createPosition({ pieces, turn: state.turn, config: state.config, seed: state.seed });
    world.ply = state.ply;
    return world;
  }

  /* =======================================================================
   * 13. Game 封装
   * ===================================================================== */

  class Game {
    constructor(opts) {
      const options = opts || {};
      const position = options.position || null;
      this.config = mergeConfig(options.config || (position && position.config));
      const qdepth = Number(this.config.ai && this.config.ai.qdepth);
      if (!Number.isFinite(qdepth) || qdepth <= 0) {
        throw new Error('AI: ai.qdepth must be > 0 (quiescence is mandatory)');
      }
      this.config.ai.qdepth = qdepth;
      this.seed = String(options.seed || (position && position.seed) || randomSeed());
      this._snapshots = [];
      if (position) {
        this.state = createPosition(Object.assign({}, position, { config: this.config, seed: this.seed }));
      } else {
        this.state = emptyState(this.config, this.seed);
        setupState(this.state);
      }
    }

    static fromPosition(position) {
      return new Game({ position, seed: position.seed || 'position', config: position.config });
    }

    /* --- 查询 --- */

    get turn() { return this.state.turn; }
    get ply() { return this.state.ply; }
    get status() { return this.state.status; }
    get drawReason() { return this.state.drawReason; }
    get inCheck() { return this.state.inCheck; }
    get pieces() { return this.state.pieces; }
    get history() { return this.state.history; }
    get stats() { return this.state.stats; }

    pieceAt(a, b) {
      const s = typeof a === 'object' ? a : { file: a, rank: b };
      return pieceAt(this.state, s);
    }

    canOperate(p) {
      return canOperate(p, this.state.turn);
    }

    legalMovesFrom(a, b) {
      const s = typeof a === 'object' ? a : { file: a, rank: b };
      const p = pieceAt(this.state, s);
      if (!p) return [];
      return legalMovesFor(this.state, p, this.state.turn);
    }

    allLegalMoves(side) {
      return allLegalMoves(this.state, side || this.state.turn);
    }

    isInCheck(side) {
      return isInCheck(this.state, side);
    }

    /* --- 操作 --- */

    move(from, to) {
      if (this.state.status !== 'PLAYING') return { ok: false, code: 'GAME_OVER', message: '对局已结束' };
      const res = checkMove(this.state, from, to);
      if (!res.ok) return res;
      this._snapshots.push(cloneState(this.state));
      if (this._snapshots.length > 400) this._snapshots.shift();
      const event = applyMove(this.state, from, to);
      return { ok: true, event };
    }

    undo() {
      if (!this.config.undo) return { ok: false, code: 'UNDO_DISABLED' };
      const prev = this._snapshots.pop();
      if (!prev) return { ok: false, code: 'NO_HISTORY' };
      this.state = prev;
      return { ok: true };
    }

    resign(side) {
      if (this.state.status !== 'PLAYING') return { ok: false, code: 'GAME_OVER' };
      const loser = side || this.state.turn;
      this.state.status = loser === 'RED' ? 'BLACK_WIN' : 'RED_WIN';
      this.state.drawReason = 'RESIGN';
      return { ok: true };
    }

    agreeDraw() {
      if (this.state.status !== 'PLAYING') return { ok: false, code: 'GAME_OVER' };
      this.state.status = 'DRAW';
      this.state.drawReason = 'AGREEMENT';
      return { ok: true };
    }

    /* --- 视图 --- */

    uiState() {
      return buildUiState(this.state);
    }

    /** AI 唯一可见的输入（§12.2）；不含暗子的 kind/side */
    publicState() {
      return buildPublicState(this.state);
    }

    /** 当前未知棋子的公开多重集合（§12.3） */
    publicPool() {
      return publicPool(this.state);
    }

    /** 仅 honesty = oracle 使用；返回带真实身份的独立世界 */
    oracleWorld() {
      return buildOracleWorld(this.state);
    }

    /** 终局解密：只在终局后可用，返回全部 32 枚的真实身份（§9.4） */
    finalReveal() {
      if (this.state.status === 'PLAYING') throw new Error('finalReveal only after game over');
      return this.state.pieces.map((p) => {
        const alive = isAlive(this.state, p);
        const captured = this.state.history.find((e) => e.captured && e.captured.id === p.id) || null;
        return {
          id: p.id,
          side: p.side,
          kind: p.kind,
          faceUp: p.faceUp,
          alive,
          at: { file: p.at.file, rank: p.at.rank },
          capturedBy: captured ? captured.side : null,
          capturedPly: captured ? captured.ply : null,
        };
      });
    }

    /**
     * 面向 AI / 复盘的安全前瞻：用 flip=false 模拟（只看公开信息）。
     * 返回落点被多少“表观敌方”攻击、以及该子移动后是否自将。
     */
    previewPublic(from, to) {
      const st = this.state;
      const p = pieceAt(st, from);
      if (!p) return null;
      const undo = simulate(st, p, to, false);
      const enemies = alivePieces(st).filter((q) => apparentSide(q) !== apparentSide(p) && attacksSquare(st, q, to));
      const selfCheck = isInCheck(st, st.turn);
      const faced = generalsFaceToFace(st);
      // 明子的身份是公开的，所以“这步是否将军”可由公开信息算出；
      // 暗子翻面后会变成什么未知，因此不给结论（诚实 AI 不偷看）。
      const givesCheck = p.faceUp ? isInCheck(st, other(p.side)) : null;
      unsimulate(st, undo);
      return {
        attackers: enemies.map((q) => ({ id: q.id, file: q.at.file, rank: q.at.rank })),
        selfCheck,
        faced,
        givesCheck,
      };
    }

    getPositionKey() {
      return positionKey(this.state);
    }

    toJSON() {
      const view = this.uiState();
      return {
        game: 'blind-xiangqi',
        version: 1,
        seed: this.seed,
        turn: view.turn,
        ply: view.ply,
        status: view.status,
        drawReason: view.drawReason,
        config: view.config,
        history: view.history,
      };
    }

    /** 战报文本：seed + 着法（坐标记谱） */
    exportText() {
      const lines = [];
      lines.push('盲棋象棋 Blind Xiangqi · 战报');
      lines.push('seed: ' + this.seed);
      lines.push('结果: ' + resultText(this.state.status, this.state.drawReason));
      lines.push('手数: ' + this.state.ply + ' 半步');
      lines.push('---');
      for (const ev of this.state.history) {
        const tags = [];
        if (ev.revealed) tags.push('翻' + SIDE_CHAR[ev.revealed.side] + NAMES[ev.revealed.side][ev.revealed.kind]);
        if (ev.captured) {
          const c = ev.captured;
          const revealed = c.wasFaceUp || this.state.config.revealOnCapture || c.friendlyFire;
          tags.push(revealed ? '吃' + SIDE_CHAR[c.side] + NAMES[c.side][c.kind] + (c.wasFaceUp ? '' : '·暗') : '吃暗子');
          if (c.friendlyFire) tags.push('误伤');
        }
        if (ev.check && ev.check[other(ev.side)]) tags.push('将');
        lines.push(
          String(ev.ply).padStart(3, ' ') + '. ' + SIDE_CHAR[ev.side] + ' ' + ev.notation +
          (tags.length ? '  ' + tags.join(' ') : '')
        );
      }
      return lines.join('\n');
    }
  }

  /* =======================================================================
   * 14. 局面构造（测试 / 场景 / 教学）
   * ===================================================================== */

  function createPosition(opts) {
    const options = opts || {};
    const state = emptyState(mergeConfig(options.config), options.seed || 'position');
    state.pieces = [];
    state.grid = Array.from({ length: 11 }, () => Array(10).fill(null));
    let nextId = 1000;
    for (const spec of options.pieces || []) {
      const id = spec.id != null ? spec.id : nextId++;
      const p = {
        id,
        side: spec.side,
        kind: spec.kind,
        faceUp: spec.faceUp !== false,
        at: { file: spec.file, rank: spec.rank },
      };
      state.pieces.push(p);
      state.grid[p.at.rank][p.at.file] = id;
    }
    state.turn = options.turn || 'RED';
    state.ply = 0;
    state.status = 'PLAYING';
    state.drawReason = null;
    state.pliesSinceCapture = 0;
    state.positionCounts = new Map();
    state.history = [];
    recomputeCheck(state);
    recordPosition(state);
    return state;
  }

  /* =======================================================================
   * 15. 导出
   * ===================================================================== */

  return {
    SIDES,
    KINDS,
    NAMES,
    VALUES,
    SIDE_NAME,
    SIDE_CHAR,
    ORIGIN_KIND,
    ORIGIN_SQUARES,
    ORIGIN_SIDE,
    PALACE,
    OWN_HALF,
    FORWARD,
    DEFAULT_CONFIG,
    REASON_TEXT,
    mergeConfig,
    Game,
    createPosition,
    // 纯函数
    moveSpec,
    apparentSide,
    canOperate,
    pseudoMoves,
    attacksSquare,
    canCapture,
    legalMovesFor,
    hasAnyLegalMove,
    allLegalMoves,
    checkMove,
    applyMove,
    applyMoveRaw,
    cloneState,
    simulate,
    unsimulate,
    recomputeCheck,
    isInCheck,
    generalsFaceToFace,
    generalSquare,
    positionKey,
    evaluateStatus,
    resultText,
    publicEvent,
    publicPool,
    buildPublicState,
    sampleWorld,
    buildOracleWorld,
    INITIAL_PIECE_COUNTS,
    // 工具
    onBoard,
    sameSq,
    other,
    inPalace,
    inOwnHalf,
    crossedRiver,
    coord,
    pieceAt,
    isAlive,
    alivePieces,
    mulberry32,
    hashSeed,
    randomSeed,
    setupState,
    verifySetup,
  };
});
