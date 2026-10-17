#!/usr/bin/env node
/**
 * M-1 数值验证：盲棋象棋自对弈基线
 *
 * 用法：
 *   node scripts/selfplay.mjs --games=1000 --quick
 *   node scripts/selfplay.mjs --games=1000
 *
 * 产出：results/selfplay.json + 控制台摘要
 * 关心的三个数（spec §16.5）：翻面率 / 误伤率 / 胜率方差
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const BX = require('../src/engine.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    return m ? [m[1], m[2] === undefined ? true : m[2]] : [a, true];
  })
);
const GAMES = Number(args.games || 1000);
const QUICK = !!args.quick;
const MAX_PLY = 400;

const rand = BX.mulberry32;
function rngFor(str) {
  return rand(BX.hashSeed(str));
}

/** 从公开视图收集合法着法（不读取隐藏身份） */
function collectMoves(view) {
  const byId = new Map(view.pieces.map((p) => [p.id, p]));
  const out = [];
  for (const id of Object.keys(view.movesById || {})) {
    const piece = byId.get(Number(id));
    if (!piece) continue;
    for (const mv of view.movesById[id]) {
      out.push({
        from: { file: piece.file, rank: piece.rank },
        to: mv.to,
        capture: mv.capture || null,
        piece,
      });
    }
  }
  return out;
}

/** M-1 基线用的材料贪心：只看公开信息，不做 PIMC（PIMC 另由 tests/ai.test.cjs 覆盖） */
function greedyMove(list, rng) {
  let best = -Infinity;
  let pool = [];
  for (const m of list) {
    let score = 0;
    if (m.capture) {
      score += m.capture.faceUp ? (BX.VALUES[m.capture.kind] || 1) : 0.5;
    }
    if (!m.piece.faceUp) score += 0.1;
    if (score > best + 1e-9) {
      best = score;
      pool = [m];
    } else if (Math.abs(score - best) < 1e-9) {
      pool.push(m);
    }
  }
  return pool[Math.floor(rng() * pool.length)];
}

function playout(gameSeed, mode, playSeed) {
  const g = new BX.Game({ seed: gameSeed });
  const rng = rngFor(playSeed);
  let turnCount = 0;
  let operableSum = 0;
  let legalSum = 0;
  let moves = 0;
  const start = Date.now();

  while (g.status === 'PLAYING' && g.ply < MAX_PLY) {
    const view = g.uiState();
    const list = collectMoves(view);
    if (!list.length) break; // 不应发生；evaluateStatus 会先判负
    operableSum += view.operableIds.length;
    legalSum += list.length;
    turnCount++;
    const chosen = mode === 'random'
      ? list[Math.floor(rng() * list.length)]
      : greedyMove(list, rng);
    if (!chosen) break;
    const res = g.move(chosen.from, chosen.to);
    if (!res.ok) throw new Error(`illegal self-play move: ${res.code} ${JSON.stringify(chosen)}`);
    moves++;
  }

  const st = g.stats;
  return {
    seed: gameSeed,
    mode,
    status: g.status,
    reason: g.drawReason,
    ply: g.ply,
    moves,
    flips: st.flips,
    hiddenMoves: st.hiddenMoves,
    captures: st.captures,
    friendlyFire: st.friendlyFire,
    selfChecks: st.selfChecks,
    checks: st.checks,
    avgOperable: turnCount ? operableSum / turnCount : 0,
    avgLegal: turnCount ? legalSum / turnCount : 0,
    ms: Date.now() - start,
    redScore: g.status === 'RED_WIN' ? 1 : g.status === 'BLACK_WIN' ? 0 : 0.5,
  };
}

function mean(xs) {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}
function sd(xs) {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
}
function pct(x) {
  return Math.round(x * 1000) / 10;
}

function summarize(runs) {
  const n = runs.length;
  const plies = runs.map((r) => r.ply);
  const flips = runs.reduce((a, r) => a + r.flips, 0);
  const moves = runs.reduce((a, r) => a + r.moves, 0);
  const captures = runs.reduce((a, r) => a + r.captures, 0);
  const ff = runs.reduce((a, r) => a + r.friendlyFire, 0);
  const selfChecks = runs.reduce((a, r) => a + r.selfChecks, 0);
  const reasons = {};
  for (const r of runs) {
    const key = r.status === 'PLAYING' ? 'PLY_LIMIT' : r.reason || 'UNKNOWN';
    reasons[key] = (reasons[key] || 0) + 1;
  }
  const wins = {
    RED: runs.filter((r) => r.status === 'RED_WIN').length,
    BLACK: runs.filter((r) => r.status === 'BLACK_WIN').length,
    DRAW: runs.filter((r) => r.status === 'DRAW').length,
    UNFINISHED: runs.filter((r) => r.status === 'PLAYING').length,
  };
  const redScores = runs.map((r) => r.redScore);
  return {
    games: n,
    redWinRate: wins.RED / n,
    blackWinRate: wins.BLACK / n,
    drawRate: wins.DRAW / n,
    unfinishedRate: wins.UNFINISHED / n,
    redScore: mean(redScores),
    redScoreSE: sd(redScores) / Math.sqrt(n),
    avgPly: mean(plies),
    medianPly: plies.slice().sort((a, b) => a - b)[Math.floor(n / 2)],
    avgMovesPerGame: mean(runs.map((r) => r.moves)),
    flipsPerGame: flips / n,
    hiddenMoveRate: moves ? flips / moves : 0, // 每步中“翻暗子”的比例
    capturesPerGame: captures / n,
    friendlyFirePerGame: ff / n,
    friendlyFireRate: captures ? ff / captures : 0,
    selfChecksPerGame: selfChecks / n,
    selfCheckRate: moves ? selfChecks / moves : 0,
    checksPerGame: runs.reduce((a, r) => a + r.checks, 0) / n,
    avgOperable: mean(runs.map((r) => r.avgOperable)),
    avgLegalMoves: mean(runs.map((r) => r.avgLegal)),
    avgMsPerGame: mean(runs.map((r) => r.ms)),
    reasons,
  };
}

function seedVariance(mode, seeds, playoutsPerSeed) {
  const perSeed = [];
  for (const seed of seeds) {
    const scores = [];
    for (let i = 0; i < playoutsPerSeed; i++) {
      const r = playout(seed, mode, seed + ':' + i);
      scores.push(r.redScore);
    }
    perSeed.push({ seed, redScore: mean(scores), scores });
  }
  const means = perSeed.map((p) => p.redScore);
  return {
    seeds: seeds.length,
    playoutsPerSeed,
    meanRedScore: mean(means),
    sdAcrossSeeds: sd(means),
    minSeedScore: Math.min(...means),
    maxSeedScore: Math.max(...means),
    samples: perSeed.slice(0, 5),
  };
}

function main() {
  const t0 = Date.now();
  const seeds = Array.from({ length: GAMES }, (_, i) => 'sp-' + i);
  const randomRuns = [];
  const greedyRuns = [];

  console.log(`[M-1] 随机自对弈 ${GAMES} 局…`);
  for (let i = 0; i < GAMES; i++) {
    randomRuns.push(playout(seeds[i], 'random', 'r:' + i));
    if ((i + 1) % 100 === 0) process.stdout.write(`\r  random ${i + 1}/${GAMES}  `);
  }
  process.stdout.write('\n');

  console.log(`[M-1] 材料贪心自对弈 ${GAMES} 局…`);
  for (let i = 0; i < GAMES; i++) {
    greedyRuns.push(playout(seeds[i], 'greedy', 'g:' + i));
    if ((i + 1) % 50 === 0) process.stdout.write(`\r  greedy ${i + 1}/${GAMES}  `);
  }
  process.stdout.write('\n');

  const varianceSeeds = Array.from({ length: QUICK ? 20 : 100 }, (_, i) => 'var-' + i);
  console.log(`[M-1] seed 方差采样 ${varianceSeeds.length} × ${QUICK ? 3 : 5} 局…`);
  const variance = seedVariance('random', varianceSeeds, QUICK ? 3 : 5);

  const report = {
    generatedAt: new Date().toISOString(),
    specVersion: 'v1.4',
    games: GAMES,
    maxPly: MAX_PLY,
    random: summarize(randomRuns),
    greedy: summarize(greedyRuns),
    seedVariance: variance,
    elapsedMs: Date.now() - t0,
  };

  fs.mkdirSync(path.join(ROOT, 'results'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'results', 'selfplay.json'), JSON.stringify(report, null, 2));

  const lines = [];
  const table = (title, s) => {
    lines.push(`\n== ${title} ==`);
    lines.push(`对局数        ${s.games}`);
    lines.push(`红胜/黑胜/和  ${pct(s.redWinRate)}% / ${pct(s.blackWinRate)}% / ${pct(s.drawRate)}%  (红分 ${s.redScore.toFixed(3)} ± ${s.redScoreSE.toFixed(3)})`);
    lines.push(`平均手数      ${s.avgPly.toFixed(1)} 半步（中位 ${s.medianPly}）`);
    lines.push(`翻面率        ${pct(s.hiddenMoveRate)}% 的着法在翻暗子（每局 ${s.flipsPerGame.toFixed(1)} 次）`);
    lines.push(`误伤率        ${pct(s.friendlyFireRate)}% 的吃子是误伤（每局 ${s.friendlyFirePerGame.toFixed(2)} 次）`);
    lines.push(`翻面送将率    ${pct(s.selfCheckRate)}% 的着法走出后自己立即被将（每局 ${s.selfChecksPerGame.toFixed(2)} 次）`);
    lines.push(`平均可选子    ${s.avgOperable.toFixed(2)} 个 / 回合，合法着法 ${s.avgLegalMoves.toFixed(1)} 个`);
    lines.push(`每局耗时      ${s.avgMsPerGame.toFixed(1)} ms`);
    lines.push(`结束原因      ${Object.entries(s.reasons).map(([k, v]) => `${k}:${v}`).join('  ')}`);
  };
  table('随机自对弈', report.random);
  table('材料贪心自对弈（基线，不含 PIMC）', report.greedy);

  lines.push('\n== seed 方差（随机走子，同 seed 多局）==');
  lines.push(`平均红分 ${variance.meanRedScore.toFixed(3)}，跨 seed 标准差 ${variance.sdAcrossSeeds.toFixed(3)}，区间 [${variance.minSeedScore.toFixed(2)}, ${variance.maxSeedScore.toFixed(2)}]`);

  lines.push('\n== 结论 ==');
  const g = report.greedy;
  if (g.friendlyFireRate > 0.3) lines.push('⚠ 误伤率 > 30%：随机性可能压过策略（§16.5）。');
  else lines.push('✅ 误伤率处在可用区间（< 30%），"用子力换情报"成立。');
  if (g.selfCheckRate > 0.15) lines.push('⚠ 翻面送将 > 15%：玩家可能趋于保守，节奏有塌陷风险（§15.8）。');
  else lines.push('✅ 翻面送将比例可接受，暗子不会变成"不敢动"的摆设。');
  if (g.hiddenMoveRate < 0.3) lines.push('⚠ 翻面率偏低：玩家在回避核心机制。');
  else lines.push('✅ 翻面率健康，核心机制被频繁触发。');
  if (variance.sdAcrossSeeds > 0.25) lines.push('⚠ seed 间胜率方差偏大：洗牌运气可能盖过技术。');
  else lines.push('✅ seed 间方差可控，发牌运气不是决定性因素。');

  const text = lines.join('\n');
  console.log('\n' + text);
  fs.writeFileSync(path.join(ROOT, 'results', 'selfplay.txt'), text + '\n');
  console.log(`\n已写入 results/selfplay.json（${report.elapsedMs} ms）`);
}

main();
