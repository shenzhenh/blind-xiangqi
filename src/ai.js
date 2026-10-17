/*!
 * 盲棋象棋 · AI（v1.9 §12.5）
 *
 * 设计要点：
 *   - honest 模式只接收 PublicState（暗子没有 kind/side）；
 *   - 信念池无放回抽样 → PIMC，所有候选共用同一批世界（F-3）；
 *   - 带静止搜索（F-1），对未翻面棋子用期望价值而不是采样真值（F-7）；
 *   - 风险调整：normal = mean − 0.6σ，hard = CVaR20（F-2）；
 *   - 最坏情况筛查：不允许主动走进必亏交换（F-4）；
 *   - 难度靠削搜索深度/世界数，而不是加随机噪声；
 *   - 超预算返回当前最优；一步未完成返回随机合法着法。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./engine.js'));
  } else {
    root.BlindAI = factory(root.BlindXiangqi);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (BX) {
  'use strict';

  const VAL = { K: 100000, P: 100, A: 200, E: 200, H: 400, C: 450, R: 900 };
  const MATE = 1000000;
  const INF = 1 << 30;
  const TIMEUP = { timeUp: true };
  const LAMBDA = 0.6;
  const SCREEN_GAP = 650;
  const CVAR_TAIL = 0.2;

  const DIFFICULTY = {
    easy:   { samples: 8,  depth: 1, qdepth: 2, budget: 40,   risk: 'mean',    topN: 8, deepSamples: 2 },
    normal: { samples: 32, depth: 2, qdepth: 4, budget: 300,  risk: 'meanVar', topN: 8, deepSamples: 8 },
    hard:   { samples: 96, depth: 3, qdepth: 6, budget: 1000, risk: 'cvar20',  topN: 8, deepSamples: 6 },
  };

  const now = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());
  const moveKey = (from, to) => from.file + ',' + from.rank + '-' + to.file + ',' + to.rank;
  const AIStats = { last: null };

  function assertPublicState(pub) {
    if (!pub || !Array.isArray(pub.pieces) || !Array.isArray(pub.pool)) {
      throw new Error('AI: invalid PublicState');
    }
    for (const p of pub.pieces) {
      if (p.faceUp) continue;
      if (Object.prototype.hasOwnProperty.call(p, 'kind') || Object.prototype.hasOwnProperty.call(p, 'side')) {
        throw new Error('AI: PublicState leaks hidden identity for piece ' + p.id);
      }
    }
  }

  /** F-7：一个暗子格对所有剩余未知身份的条件期望净价值 */
  function expectedHiddenNet(pub, side) {
    const pool = pub.pool || [];
    if (!pool.length) return 0;
    let sum = 0;
    for (const x of pool) {
      const v = VAL[x.kind] || 0;
      sum += x.side === side ? v : -v;
    }
    return sum / pool.length;
  }

  function pawnAdvance(rank, side) {
    return side === 'RED' ? rank - 1 : 10 - rank;
  }

  function evaluate(world, side, ctx) {
    const c = ctx || { oracle: true };
    const opp = BX.other(side);
    let material = 0;
    let mobilitySide = 0;
    let mobilityOpp = 0;
    let posScore = 0;
    const hiddenNet = c.oracle ? 0 : (c.hiddenNet || 0);

    for (const p of world.pieces) {
      if (!BX.isAlive(world, p)) continue;
      const revealed = c.oracle || p.faceUp;
      const effSide = revealed ? p.side : BX.apparentSide(p);
      const sign = effSide === side ? 1 : -1;
      if (revealed) material += sign * (VAL[p.kind] || 0);
      else material += hiddenNet;

      const mob = BX.pseudoMoves(world, p).length;
      if (effSide === side) mobilitySide += mob;
      else mobilityOpp += mob;

      let kind = p.kind;
      if (!revealed) {
        const row = BX.ORIGIN_KIND[p.at.rank];
        kind = row ? row[p.at.file] : null;
      }
      if (kind === 'P') posScore += sign * pawnAdvance(p.at.rank, effSide) * 6;
      if (kind === 'H' || kind === 'C' || kind === 'R') {
        posScore += sign * (4 - Math.abs(p.at.file - 5)) * 2;
      }
    }

    let score = material + (mobilitySide - mobilityOpp) * 3 + posScore;
    if (world.inCheck[side]) score -= 320;
    if (world.inCheck[opp]) score += 220;
    return score;
  }

  /** 只用于走法排序；暗子目标不得读取采样身份（A-1/F-7） */
  function orderMoves(world, moves, ctx) {
    const oracle = ctx && ctx.oracle;
    const decorated = moves.map((mv) => {
      const target = BX.pieceAt(world, mv.to);
      let score = 0;
      if (target) score = (oracle || target.faceUp) ? (VAL[target.kind] || 0) : 1;
      return { mv, score };
    });
    decorated.sort((a, b) => b.score - a.score || moveKey(a.mv.from, a.mv.to).localeCompare(moveKey(b.mv.from, b.mv.to)));
    return decorated.map((d) => d.mv);
  }

  function applySearch(world, mv) {
    const p = BX.pieceAt(world, mv.from);
    if (!p) return null;
    const target = BX.pieceAt(world, mv.to);
    const undo = BX.simulate(world, p, mv.to, true);
    world.turn = BX.other(world.turn);
    BX.recomputeCheck(world);
    return { undo, target };
  }

  function undoSearch(world, applied) {
    if (!applied) return;
    world.turn = BX.other(world.turn);
    BX.unsimulate(world, applied.undo);
    BX.recomputeCheck(world);
  }

  function timeCheck(ctx) {
    ctx.nodes++;
    if (!ctx.deterministic && (ctx.nodes & 127) === 0 && now() > ctx.deadline) throw TIMEUP;
  }

  /** F-1：只在吃子上继续，局面安静或 qdepth 耗尽后评估 */
  function quiesce(world, alpha, beta, qdepth, ctx) {
    timeCheck(ctx);
    const side = world.turn;
    const inCheck = !!world.inCheck[side];
    const stand = evaluate(world, side, ctx);
    let best = inCheck ? -INF : stand;
    if (!inCheck) {
      if (stand >= beta) return stand;
      if (stand > alpha) alpha = stand;
    }
    if (qdepth <= 0) return inCheck ? stand : best;

    const moves = BX.allLegalMoves(world, side);
    if (!moves.length) return -MATE + (ctx.maxDepth - qdepth) * 10;
    const candidates = inCheck ? moves : moves.filter((mv) => !!BX.pieceAt(world, mv.to));
    if (!candidates.length) return inCheck ? stand : best;

    for (const mv of orderMoves(world, candidates, ctx)) {
      const applied = applySearch(world, mv);
      let score;
      try {
        score = -quiesce(world, -beta, -alpha, qdepth - 1, ctx);
      } finally {
        undoSearch(world, applied);
      }
      if (score > best) best = score;
      if (score > alpha) alpha = score;
      if (alpha >= beta) break;
    }
    return best;
  }

  function negamax(world, depth, alpha, beta, ctx) {
    timeCheck(ctx);
    const side = world.turn;
    const moves = BX.allLegalMoves(world, side);
    if (!moves.length) return -MATE + (ctx.maxDepth - depth) * 10;
    if (depth <= 0) return quiesce(world, alpha, beta, ctx.qdepth, ctx);

    let best = -INF;
    for (const mv of orderMoves(world, moves, ctx)) {
      const applied = applySearch(world, mv);
      let score;
      try {
        score = -negamax(world, depth - 1, -beta, -alpha, ctx);
      } finally {
        undoSearch(world, applied);
      }
      if (score > best) best = score;
      if (score > alpha) alpha = score;
      if (alpha >= beta) break;
    }
    return best;
  }

  function newAgg(moves) {
    const agg = new Map();
    for (const mv of moves) agg.set(moveKey(mv.from, mv.to), { mv, scores: [] });
    return agg;
  }

  /** 阶段 1：全部根着法 × K 个世界，静态 + 期望价值 */
  function screenMoves(pub, worlds, ctx) {
    const aiSide = pub.turn;
    const agg = newAgg(pub.legalMoves);
    for (const world of worlds) {
      for (const mv of pub.legalMoves) {
        const item = agg.get(moveKey(mv.from, mv.to));
        const applied = applySearch(world, mv);
        if (!applied) continue;
        let score;
        try {
          score = evaluate(world, aiSide, ctx);
        } finally {
          undoSearch(world, applied);
        }
        item.scores.push(score);
        if (!ctx.deterministic && now() > ctx.deadline) throw TIMEUP;
      }
    }
    return agg;
  }

  /** 阶段 2：候选着法 × 少量世界，带静止搜索的 negamax */
  function deepenMoves(pub, worlds, candidates, depth, ctx) {
    const agg = newAgg(candidates);
    for (const world of worlds) {
      for (const mv of candidates) {
        const item = agg.get(moveKey(mv.from, mv.to));
        const applied = applySearch(world, mv);
        if (!applied) continue;
        let score;
        try {
          // depth 含根着法；根已执行，剩余 depth-1 层
          score = -negamax(world, Math.max(0, depth - 1), -INF, INF, ctx);
        } finally {
          undoSearch(world, applied);
        }
        item.scores.push(score);
        if (!ctx.deterministic && now() > ctx.deadline) throw TIMEUP;
      }
    }
    return agg;
  }

  function stats(scores) {
    if (!scores.length) return { mean: 0, sd: 0, min: 0, cvar: 0, n: 0 };
    const n = scores.length;
    const mean = scores.reduce((a, b) => a + b, 0) / n;
    let variance = 0;
    for (const s of scores) variance += (s - mean) * (s - mean);
    const sd = Math.sqrt(variance / Math.max(1, n - 1));
    const min = Math.min(...scores);
    const sorted = scores.slice().sort((a, b) => a - b);
    const k = Math.max(1, Math.ceil(n * CVAR_TAIL));
    const cvar = sorted.slice(0, k).reduce((a, b) => a + b, 0) / k;
    return { mean, sd, min, cvar, n };
  }

  function aggregate(agg, riskMode, lambda) {
    if (!agg) return [];
    const items = [];
    for (const raw of agg.values()) {
      if (!raw.scores.length) continue;
      const s = stats(raw.scores);
      let risk;
      if (riskMode === 'cvar20') risk = s.cvar;
      else if (riskMode === 'meanVar') risk = s.mean - (lambda == null ? LAMBDA : lambda) * s.sd;
      else risk = s.mean;
      items.push({
        mv: raw.mv,
        scores: raw.scores,
        mean: s.mean,
        sd: s.sd,
        min: s.min,
        cvar: s.cvar,
        risk,
      });
    }
    return items;
  }

  /** F-4：均值/风险再好，只要某个世界会丢一个车级子力，就不选 */
  function safeFilter(items, enabled) {
    if (!items.length || enabled === false) return items;
    const safe = items.filter((x) => x.min >= -SCREEN_GAP);
    return safe.length ? safe : items;
  }

  function sortByRisk(items) {
    return items.slice().sort((a, b) => b.risk - a.risk || moveKey(a.mv.from, a.mv.to).localeCompare(moveKey(b.mv.from, b.mv.to)));
  }

  function pickFinal(screenAgg, deepAgg, riskMode, lambda, useWorst) {
    const screenItems = aggregate(screenAgg, riskMode, lambda);
    const deepItems = aggregate(deepAgg, riskMode, lambda);
    const deepMap = new Map(deepItems.map((x) => [moveKey(x.mv.from, x.mv.to), x]));
    const merged = screenItems.map((item) => {
      const d = deepMap.get(moveKey(item.mv.from, item.mv.to));
      return d || item;
    });
    if (!merged.length) return null;
    return sortByRisk(safeFilter(merged, useWorst))[0].mv;
  }

  function randomLegal(pub, rng) {
    const moves = (pub && pub.legalMoves) || [];
    if (!moves.length) return null;
    return moves[Math.floor(rng() * moves.length)];
  }

  function toResult(best) {
    if (!best) return null;
    return {
      from: { file: best.from.file, rank: best.from.rank },
      to: { file: best.to.file, rank: best.to.rank },
      pieceId: best.pieceId,
    };
  }

  function chooseFromPublic(pub, opts) {
    const options = opts || {};
    assertPublicState(pub);
    if (pub.status !== 'PLAYING' || !pub.legalMoves.length) return null;

    const difficulty = options.difficulty || pub.config.ai.difficulty || 'normal';
    const spec = DIFFICULTY[difficulty] || DIFFICULTY.normal;
    const aiCfg = pub.config.ai || {};
    const samples = Math.max(1, options.sampleCount || spec.samples);
    const maxDepth = Math.max(1, options.depth || spec.depth);
    const requestedQ = options.qdepth == null ? spec.qdepth : options.qdepth;
    if (!Number.isFinite(requestedQ) || requestedQ <= 0) {
      throw new Error('AI: qdepth must be > 0 (quiescence is mandatory)');
    }
    const qdepth = requestedQ;
    const budget = options.thinkMs == null ? spec.budget : options.thinkMs;
    const riskMode = difficulty === 'hard'
      ? 'cvar20'
      : (options.riskMode || spec.risk);
    const riskLambda = options.riskLambda == null
      ? (Number.isFinite(aiCfg.riskLambda) ? aiCfg.riskLambda : LAMBDA)
      : options.riskLambda;
    const useWorst = options.worstCaseScreen == null
      ? aiCfg.worstCaseScreen !== false
      : !!options.worstCaseScreen;
    if (riskMode !== 'mean' && riskMode !== 'meanVar' && riskMode !== 'cvar20') {
      throw new Error('AI: invalid riskMode ' + riskMode);
    }
    const seed = String(
      options.seed != null
        ? options.seed
        : (pub.config.ai && pub.config.ai.seed) ||
          (pub.seed + ':' + pub.ply + ':' + pub.turn + ':' + difficulty)
    );
    const rng = BX.mulberry32(BX.hashSeed(seed));
    const start = now();
    const ctx = {
      nodes: 0,
      deadline: start + budget,
      deterministic: !!options.deterministic,
      maxDepth,
      qdepth,
      pub,
      oracle: false,
      hiddenNet: expectedHiddenNet(pub, pub.turn),
    };

    // F-3：所有候选共用同一批世界
    const worlds = [];
    for (let i = 0; i < samples; i++) worlds.push(BX.sampleWorld(pub, rng));

    let screenAgg = null;
    let deepAgg = null;
    let timeUp = false;
    let reachedDepth = 0;

    try {
      screenAgg = screenMoves(pub, worlds, ctx);
      const screenItems = safeFilter(sortByRisk(aggregate(screenAgg, riskMode, riskLambda)), useWorst);
      const candidates = screenItems.slice(0, Math.min(spec.topN, screenItems.length)).map((x) => x.mv);
      const deepWorlds = worlds.slice(0, Math.min(worlds.length, spec.deepSamples || worlds.length));

      if (candidates.length) {
        if (difficulty === 'hard' && !options.deterministic) {
          // 迭代加深：超时保留上一层完整结果
          for (let d = 1; d <= maxDepth; d++) {
            if (now() > ctx.deadline - 40) break;
            try {
              const agg = deepenMoves(pub, deepWorlds, candidates, d, ctx);
              deepAgg = agg;
              reachedDepth = d;
            } catch (err) {
              if (err !== TIMEUP) throw err;
              timeUp = true;
              break;
            }
          }
        } else {
          deepAgg = deepenMoves(pub, deepWorlds, candidates, maxDepth, ctx);
          reachedDepth = maxDepth;
        }
      }
    } catch (err) {
      if (err !== TIMEUP) throw err;
      timeUp = true;
    }

    let best = pickFinal(screenAgg, deepAgg, riskMode, riskLambda, useWorst);
    if (!best) best = randomLegal(pub, rng);

    AIStats.last = {
      difficulty,
      honesty: 'honest',
      samples: worlds.length,
      depth: reachedDepth,
      qdepth: ctx.qdepth,
      risk: riskMode,
      ms: Math.round(now() - start),
      nodes: ctx.nodes,
      timeUp,
      fallback: !screenAgg || !best,
      seed,
    };
    return toResult(best);
  }

  function chooseFromTruth(world, pub, opts) {
    const options = opts || {};
    const difficulty = options.difficulty || pub.config.ai.difficulty || 'normal';
    const spec = DIFFICULTY[difficulty] || DIFFICULTY.normal;
    const aiCfg = pub.config.ai || {};
    const maxDepth = Math.max(1, options.depth || spec.depth);
    const requestedQ = options.qdepth == null ? spec.qdepth : options.qdepth;
    if (!Number.isFinite(requestedQ) || requestedQ <= 0) {
      throw new Error('AI: qdepth must be > 0 (quiescence is mandatory)');
    }
    const qdepth = requestedQ;
    const budget = options.thinkMs == null ? spec.budget : options.thinkMs;
    const riskMode = difficulty === 'hard'
      ? 'cvar20'
      : (options.riskMode || spec.risk);
    const riskLambda = options.riskLambda == null
      ? (Number.isFinite(aiCfg.riskLambda) ? aiCfg.riskLambda : LAMBDA)
      : options.riskLambda;
    const useWorst = options.worstCaseScreen == null
      ? aiCfg.worstCaseScreen !== false
      : !!options.worstCaseScreen;
    const seed = String(options.seed != null ? options.seed : world.seed);
    const rng = BX.mulberry32(BX.hashSeed(seed));
    const start = now();
    const ctx = {
      nodes: 0,
      deadline: start + budget,
      deterministic: !!options.deterministic,
      maxDepth,
      qdepth,
      pub,
      oracle: true,
      hiddenNet: 0,
    };
    let best = null;
    let timeUp = false;
    try {
      const agg = deepenMoves(pub, [world], pub.legalMoves, maxDepth, ctx);
      best = pickFinal(agg, null, riskMode, riskLambda, useWorst);
    } catch (err) {
      if (err !== TIMEUP) throw err;
      timeUp = true;
    }
    if (!best) best = randomLegal(pub, rng);
    AIStats.last = {
      difficulty,
      honesty: 'oracle',
      samples: 1,
      depth: maxDepth,
      qdepth,
      risk: riskMode,
      ms: Math.round(now() - start),
      nodes: ctx.nodes,
      timeUp,
      fallback: !best,
    };
    return toResult(best);
  }

  function chooseMove(game, opts) {
    const options = opts || {};
    const honesty = options.honesty || game.config.ai.honesty || 'honest';
    const pub = game.publicState();
    if (honesty === 'oracle') {
      return chooseFromTruth(game.oracleWorld(), pub, options);
    }
    return chooseFromPublic(pub, options);
  }

  function suggestMove(game, opts) {
    return chooseFromPublic(game.publicState(), Object.assign({ difficulty: 'normal', thinkMs: 300 }, opts || {}));
  }

  return {
    chooseMove,
    chooseFromPublic,
    chooseFromTruth,
    suggestMove,
    assertPublicState,
    evaluate,
    DIFFICULTY,
    get last() { return AIStats.last; },
  };
});
