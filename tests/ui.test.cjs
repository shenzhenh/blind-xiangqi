/**
 * 盲棋象棋 · 前端集成测试（jsdom，v1.5）
 *
 * 覆盖 T-43 ~ T-47、T-52、T-57 ~ T-59、T-72、T-73 与日常交互冒烟。
 * 默认用“同屏双人”环境做确定性交互测试；PvE 相关用例单独启动独立页面。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const ROOT = path.resolve(__dirname, '..');

function makeCtx(rec) {
  const gradient = { addColorStop() {} };
  const target = {
    canvas: null,
    createLinearGradient: () => gradient,
    createRadialGradient: () => gradient,
    measureText: (t) => ({ width: String(t).length * 8 }),
    getLineDash: () => [],
    setLineDash() {},
  };
  return new Proxy(target, {
    get(t, key) {
      if (key in t) return t[key];
      return (...args) => {
        rec.calls++;
        if (key === 'fillText') rec.texts.push(String(args[0]));
      };
    },
    set(t, key, value) { t[key] = value; return true; },
  });
}

async function boot(settings) {
  const options = settings || {};
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const rec = { calls: 0, texts: [], contexts: 0 };
  const dom = new JSDOM(html, {
    url: 'file:///' + path.join(ROOT, 'index.html').replace(/\\/g, '/'),
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const w = dom.window;
  w.__BX_TEST__ = true;

  w.Element.prototype.getBoundingClientRect = function () {
    return { width: 960, height: 860, top: 0, left: 0, right: 960, bottom: 860, x: 0, y: 0, toJSON() { return this; } };
  };
  const ctxs = new WeakMap();
  w.HTMLCanvasElement.prototype.getContext = function () {
    if (!ctxs.has(this)) { rec.contexts++; ctxs.set(this, makeCtx(rec)); }
    return ctxs.get(this);
  };
  w.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  if (!w.requestAnimationFrame) {
    w.requestAnimationFrame = (cb) => w.setTimeout(() => cb(w.performance.now()), 16);
    w.cancelAnimationFrame = (id) => w.clearTimeout(id);
  }

  const store = new Map();
  if (options.rulesSeen !== false) store.set('bx.rulesSeen.v1', '1');
  store.set('bx.settings.v1', JSON.stringify(Object.assign({
    mode: 'hotseat', side: 'red', difficulty: 'normal', honesty: 'honest',
    balance: 'none', strict: false, undo: false, sound: false,
  }, options, {})));
  Object.defineProperty(w, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
      clear: () => store.clear(),
      key: (i) => Array.from(store.keys())[i] || null,
      get length() { return store.size; },
    },
  });

  const proto = w.HTMLDialogElement && w.HTMLDialogElement.prototype;
  if (proto) {
    if (!proto.showModal) proto.showModal = function () { this.open = true; };
    if (!proto.close) {
      proto.close = function () {
        if (!this.open) return;
        this.open = false;
        this.dispatchEvent(new w.Event('close'));
      };
    }
  }
  w.confirm = () => true;
  try {
    Object.defineProperty(w.navigator, 'clipboard', {
      configurable: true,
      value: { writeText: () => Promise.resolve() },
    });
  } catch (err) { /* ignore */ }
  w.document.execCommand = () => true;

  const errors = [];
  w.addEventListener('error', (ev) => errors.push(String(ev.message || ev.error)));
  w.onerror = (msg) => { errors.push(String(msg)); };

  for (const file of ['src/engine.js', 'src/visual.js', 'src/ai.js', 'src/ui.js']) {
    w.eval(fs.readFileSync(path.join(ROOT, file), 'utf8'));
  }

  await new Promise((resolve) => w.setTimeout(resolve, 120));
  if (!w.__bx) throw new Error('UI 未暴露测试钩子');
  w.__bx.closeDialogs();
  if (!options.home) {
    w.__bx.startGame({ seed: 'ui-boot-seed' });
    await new Promise((resolve) => w.setTimeout(resolve, 60));
    w.__bx.closeDialogs();
  }
  return { dom, w, bx: w.__bx, rec, errors, store };
}

const wait = (w, ms) => new Promise((resolve) => w.setTimeout(resolve, ms));
async function waitFor(w, fn, timeout) {
  const end = Date.now() + (timeout || 3000);
  while (Date.now() < end) {
    if (fn()) return true;
    await wait(w, 25);
  }
  return false;
}

let env = null;
test.before(async () => { env = await boot(); });
test.after(() => { if (env) env.dom.window.close(); });

function view() { return env.bx.view; }
function pieceAt(file, rank) {
  return view().pieces.find((p) => p.file === file && p.rank === rank) || null;
}
function resetPosition(pieces, turn) {
  env.bx.setPosition({ pieces, turn: turn || 'RED' });
  env.bx.skipAnim();
}
function pickHiddenOperable() {
  const v = view();
  return v.pieces.find((p) => !p.faceUp && v.operableIds.includes(p.id) && (v.movesById[p.id] || []).length > 0);
}
function anyHumanMove(bx) {
  const v = bx.view;
  const ids = Object.keys(v.movesById).filter((id) => v.movesById[id].length);
  const id = ids[0];
  const p = v.pieces.find((x) => x.id === Number(id));
  const mv = v.movesById[id][0];
  return { from: { file: p.file, rank: p.rank }, to: mv.to };
}

/* =====================================================================
 * 启动 / 几何 / 默认模式
 * ===================================================================== */

test('UI 启动：32 枚、16 可操作、Canvas 有绘制、暗子顶面不出现「?」', async () => {
  env.bx.newGame({ seed: 'ui-boot' });
  await wait(env.w, 80);
  const v = view();
  assert.equal(v.pieces.length, 32);
  assert.equal(v.operableIds.length, 16);
  assert.equal(v.pieces.filter((p) => !p.faceUp).length, 30);
  assert.equal(env.errors.length, 0, env.errors.join('\n'));
  assert.ok(env.rec.calls > 0);
  // T-62：未选中的暗子顶面只能是浮雕纹样，不得绘制「?」
  assert.equal(env.rec.texts.includes('?'), false);
  assert.ok(env.rec.texts.includes('帅'));
  for (const p of v.pieces) {
    if (p.faceUp) continue;
    assert.equal('kind' in p, false);
    assert.equal('side' in p, false);
  }
});

test('T-61 几何：明暗同一圆形，D=0.86c、H=0.10D', () => {
  const g = env.bx.VIS.geometry(60);
  assert.equal(g.shape, 'circle');
  assert.equal(g.D, 60 * 0.86);
  assert.equal(g.H, g.D * 0.10);
  assert.equal(env.bx.VIS.PIECE.diameterRatio, 0.86);
});

test('T-59 底部栏没有「确认」按钮，也没有确认对话框', () => {
  const text = env.w.document.querySelector('.bottombar').textContent;
  assert.equal(/确认/.test(text), false);
  assert.equal(env.w.document.getElementById('confirmDialog'), null);
  assert.equal(env.w.document.getElementById('confirmOk'), null);
});

test('默认模式为人机对战，玩家执红，AI 角标为「AI 不偷看」', async () => {
  const pve = await boot({ mode: 'pve', side: 'red', difficulty: 'easy' });
  try {
    const bx = pve.bx;
    bx.newGame({ seed: 'default-pve' });
    await wait(pve.w, 60);
    assert.equal(bx.state().aiSide, 'BLACK');
    assert.equal(bx.state().humanSide, 'RED');
    assert.match(pve.w.document.getElementById('modeBadge').textContent, /人机/);
    const badge = pve.w.document.getElementById('aiBadge');
    assert.equal(badge.hidden, false);
    assert.equal(badge.textContent, 'AI 不偷看');
    assert.ok(badge.classList.contains('honest'));
  } finally {
    pve.dom.window.close();
  }
});

test('T-77 冷启动只进开始界面，且不初始化 Canvas', async () => {
  const home = await boot({ home: true });
  try {
    assert.equal(home.bx.phase(), 'HOME');
    assert.equal(home.bx.game, null);
    assert.equal(home.rec.contexts, 0, '冷启动不应 getContext');
    assert.equal(home.w.document.getElementById('homeScreen').hidden, false);
    assert.ok(home.bx.E.app.classList.contains('home-active'));

    home.w.document.getElementById('startBtn').click();
    await wait(home.w, 120);
    assert.equal(home.bx.phase(), 'PLAYING');
    assert.ok(home.rec.contexts >= 1, '开始对局后才初始化 Canvas');
    assert.equal(home.bx.view.pieces.length, 32);
    assert.equal(home.bx.E.app.classList.contains('home-active'), false);
  } finally {
    home.dom.window.close();
  }
});

test('T-83 开始界面只有一个实心主按钮', async () => {
  const home = await boot({ home: true });
  try {
    const doc = home.w.document;
    assert.equal(doc.querySelectorAll('#homeScreen .home-start').length, 1);
    assert.equal(doc.querySelectorAll('#homeScreen .btn.primary').length, 0);
    assert.equal(doc.getElementById('startBtn').className, 'home-start');
    assert.equal(doc.getElementById('homeScreen').querySelectorAll('button').length >= 6, true);
  } finally {
    home.dom.window.close();
  }
});

test('T-78 开始对局转场：400ms 后进入棋盘，无白屏', async () => {
  const home = await boot({ home: true });
  try {
    home.w.document.getElementById('startBtn').click();
    assert.ok(home.bx.E.app.classList.contains('game-entering'));
    assert.equal(home.bx.phase(), 'PLAYING');
    await wait(home.w, 520);
    assert.equal(home.bx.E.app.classList.contains('game-entering'), false);
    assert.ok(home.bx.view.pieces.length === 32);
  } finally {
    home.dom.window.close();
  }
});

test('T-79 首页配置写入 localStorage，并更新摘要', async () => {
  const home = await boot({ home: true, mode: 'pve' });
  try {
    home.w.document.getElementById('homeConfigBtn').click();
    const diff = home.w.document.getElementById('homeDifficultyInput');
    diff.value = 'hard';
    diff.dispatchEvent(new home.w.Event('change', { bubbles: true }));
    home.w.document.getElementById('homeConfigDone').click();
    const saved = JSON.parse(home.store.get('bx.settings.v1'));
    assert.equal(saved.difficulty, 'hard');
    assert.match(home.w.document.getElementById('homeConfigSummary').textContent, /高手/);
  } finally {
    home.dom.window.close();
  }
});

test('T-81 无存档时「继续上局」不出现（不是禁用态）', async () => {
  const home = await boot({ home: true });
  try {
    const btn = home.w.document.getElementById('homeContinueBtn');
    assert.equal(btn.hidden, true);
    assert.equal(home.w.document.getElementById('homeScreen').textContent.includes('继续上局'), false);
  } finally {
    home.dom.window.close();
  }
});

test('T-80 未完成对局可继续：恢复到轮次与着法记录', async () => {
  const home = await boot({ home: true });
  try {
    home.w.document.getElementById('startBtn').click();
    await wait(home.w, 100);
    const move = anyHumanMove(home.bx);
    home.bx.move(move.from, move.to);
    home.bx.skipAnim();
    assert.equal(home.bx.view.ply, 1);
    assert.ok(home.bx.hasSave(), '第一步后应写入未完成存档');

    home.bx.showHome();
    const cont = home.w.document.getElementById('homeContinueBtn');
    assert.equal(cont.hidden, false);
    assert.match(cont.textContent, /第 1 手/);
    cont.click();
    await wait(home.w, 120);
    assert.equal(home.bx.phase(), 'PLAYING');
    assert.equal(home.bx.view.ply, 1);
    assert.equal(home.bx.view.history.length, 1);
  } finally {
    home.dom.window.close();
  }
});

test('T-85 / T-86 / T-89 / T-90 吃子记录：揭示、误伤、空态与播报', async () => {
  const e = await boot({ home: true });
  try {
    e.w.document.getElementById('startBtn').click();
    await wait(e.w, 80);
    assert.match(e.w.document.getElementById('captureFeed').textContent, /尚无吃子/);
    assert.match(e.w.document.getElementById('captureStrip').textContent, /尚无吃子/);

    e.bx.setPosition({
      turn: 'RED',
      pieces: [
        { side: 'RED', kind: 'K', file: 4, rank: 1 },
        { side: 'BLACK', kind: 'K', file: 5, rank: 10 },
        { side: 'RED', kind: 'R', file: 1, rank: 1 },
        { side: 'RED', kind: 'P', file: 1, rank: 7, faceUp: false },
      ],
    });
    e.bx.clickCell(1, 1);
    e.bx.clickCell(1, 7); // 明车吃表观黑、真实红的暗兵 → 误伤
    await wait(e.w, 50);
    const group = e.w.document.querySelector('#captureFeed .capture-group');
    assert.ok(group, '吃子记录应出现');
    assert.match(group.textContent, /红方吃子/);
    assert.equal(group.querySelectorAll('.capture-piece').length, 1);
    assert.equal(group.querySelector('.capture-piece').textContent, '兵');
    assert.match(e.w.document.getElementById('captureStrip').textContent, /红吃/);
    await wait(e.w, 60);
    assert.match(e.w.document.getElementById('captureLive').textContent, /第 1 手/);
    assert.match(e.w.document.getElementById('captureLive').textContent, /误伤/);
  } finally {
    e.dom.window.close();
  }
});

test('T-88 吃子记录最多渲染 40 个圆标，面板内部滚动', async () => {
  const e = await boot({ home: true });
  try {
    e.w.document.getElementById('startBtn').click();
    await wait(e.w, 80);
    const old = e.bx.S.view;
    const fake = Array.from({ length: 45 }, (_, i) => ({
      ply: i + 1,
      side: i % 2 ? 'BLACK' : 'RED',
      moverId: 1,
      from: { file: 1, rank: 1 },
      to: { file: 1, rank: 2 },
      notation: 'f1r1→f1r2',
      captured: { id: 2, side: 'RED', kind: 'P', wasFaceUp: false, revealed: true },
      check: { RED: false, BLACK: false },
    }));
    e.bx.S.view = Object.assign({}, old, { history: fake });
    e.bx.renderCapture();
    assert.equal(e.w.document.querySelectorAll('#captureFeed .capture-piece').length, 40);
    assert.equal(e.w.document.querySelectorAll('#captureFeed .capture-group').length, 2);
    e.bx.S.view = old;
    e.bx.renderCapture();
  } finally {
    e.dom.window.close();
  }
});

test('T-82 首次访问自动弹一次规则，关闭后记住', async () => {
  const e = await boot({ home: true, rulesSeen: false });
  try {
    await wait(e.w, 420);
    assert.equal(e.w.document.getElementById('rulesDialog').open, true);
    for (let i = 0; i < 4; i++) e.w.document.getElementById('rulesNext').click();
    e.w.document.getElementById('rulesNext').click();
    assert.equal(e.store.get('bx.rulesSeen.v1'), '1');
  } finally {
    e.dom.window.close();
  }
});

test('M-1 触屏落点吸附：0.55×cell 内吸附，超出不误落', async () => {
  const M = env.bx.S.M;
  assert.ok(M && M.cell > 0);
  const center = env.bx.snapPoint(M.x(3), M.y(4));
  assert.ok(center);
  assert.equal(center.file, 3);
  assert.equal(center.rank, 4);
  const near = env.bx.snapPoint(M.x(3) + M.cell * 0.3, M.y(4) - M.cell * 0.2);
  assert.ok(near);
  assert.equal(near.file, 3);
  assert.equal(near.rank, 4);
  const far = env.bx.snapPoint(M.x(3) + M.cell * 0.5, M.y(4) - M.cell * 0.5);
  assert.equal(far, null);
});

/* =====================================================================
 * 选中 / 落点 / 取消确认
 * ===================================================================== */

test('T-43 选中暗子：落点只依据 moveSpec，不翻面、不暴露身份', async () => {
  env.bx.newGame({ seed: 'ui-t43' });
  const p = pickHiddenOperable();
  assert.ok(p);
  env.bx.clickCell(p.file, p.rank);
  const st = env.bx.state();
  assert.equal(st.selectedId, p.id);
  assert.equal(st.legalCount, view().movesById[p.id].length);
  assert.ok(st.legalCount > 0);
  assert.equal(pieceAt(p.file, p.rank).faceUp, false);
  assert.match(pieceAt(p.file, p.rank) ? st.hintText : '', /暗子/);
  env.bx.clickCell(p.file, p.rank);
  assert.equal(env.bx.state().selectedId, null);
});

test('T-44 / T-58 攻击暗子：无弹窗直接落子；琥珀色问号环是唯一风险提示', async () => {
  resetPosition([
    { side: 'RED', kind: 'R', file: 1, rank: 1 },
    { side: 'BLACK', kind: 'P', file: 1, rank: 7, faceUp: false },
  ]);
  env.rec.texts.length = 0;
  env.bx.clickCell(1, 1);
  assert.ok(env.bx.legalKeys().includes('1,7'));
  await wait(env.w, 40);
  // 选中阶段：暗子落点应绘制问号环（唯一风险提示）
  assert.ok(env.rec.texts.includes('?'), '缺少琥珀色问号环');
  env.bx.clickCell(1, 7);
  assert.equal(view().ply, 1, '点击暗子目标应立即落子');
  assert.equal(env.w.document.getElementById('confirmDialog'), null);
  assert.equal(pieceAt(1, 7).faceUp, true);
  assert.equal(pieceAt(1, 1), null);
});

test('T-45 同屏双人切换回合不出现隐私屏障', async () => {
  env.bx.newGame({ seed: 'ui-t45' });
  assert.equal(env.w.document.querySelectorAll('.privacy-screen, [data-privacy], .turn-screen').length, 0);
  const p = pickHiddenOperable();
  const mv = view().movesById[p.id].find((m) => !m.capture);
  env.bx.clickCell(p.file, p.rank);
  env.bx.clickCell(mv.to.file, mv.to.rank);
  env.bx.skipAnim();
  assert.equal(view().turn, 'BLACK');
  assert.equal(env.w.document.querySelectorAll('.privacy-screen, [data-privacy], .turn-screen').length, 0);
});

test('T-46 键盘全流程：方向键 + 回车，两步完成、无确认', async () => {
  resetPosition([{ side: 'RED', kind: 'R', file: 1, rank: 1, faceUp: false }]);
  const { w } = env;
  env.bx.focusCell(1, 1);
  const active = w.document.activeElement;
  assert.equal(active.dataset.file, '1');
  active.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  assert.equal(env.bx.state().selectedId, view().pieces[0].id);
  const key = (k) => w.document.activeElement.dispatchEvent(
    new w.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })
  );
  key('ArrowUp');
  assert.equal(w.document.activeElement.dataset.rank, '2');
  key('Enter');
  env.bx.skipAnim();
  assert.equal(view().ply, 1);
  assert.equal(pieceAt(1, 2).faceUp, true);
});

test('T-57 可操作视觉态：operableIds 覆盖全部表观本方棋子', async () => {
  env.bx.newGame({ seed: 'ui-t57' });
  const v = view();
  const expected = v.pieces.filter((p) => (p.faceUp ? p.side : (p.rank <= 5 ? 'RED' : 'BLACK')) === v.turn).map((p) => p.id);
  assert.deepEqual(new Set(v.operableIds), new Set(expected));
  assert.equal(v.operableIds.length, 16);
  assert.equal(env.w.document.getElementById('aiBadge').hidden, true, '同屏模式不应显示 AI 角标');
});

test('T-52 翻面送将：翻出黑车照帅，界面提示红方被将军且对局继续', async () => {
  resetPosition([
    { side: 'RED', kind: 'K', file: 5, rank: 1 },
    { side: 'BLACK', kind: 'K', file: 5, rank: 10 },
    { side: 'BLACK', kind: 'P', file: 5, rank: 7 },
    { side: 'BLACK', kind: 'R', file: 2, rank: 3, faceUp: false },
  ]);
  env.bx.clickCell(2, 3);
  env.bx.clickCell(5, 3);
  env.bx.skipAnim();
  await wait(env.w, 20);
  assert.equal(view().ply, 1);
  assert.equal(view().inCheck.RED, true);
  assert.equal(view().status, 'PLAYING');
  const pill = env.w.document.getElementById('checkPill');
  assert.equal(pill.hidden, false);
  assert.match(pill.textContent, /红方被将军/);
});

/* =====================================================================
 * 结算 / 回放 / 悔棋 / 规则 / 标记
 * ===================================================================== */

test('T-47 结算面板解密全部 32 枚', async () => {
  env.bx.newGame({ seed: 'ui-t47' });
  env.w.document.getElementById('resignBtn').click();
  await wait(env.w, 30);
  const dlg = env.w.document.getElementById('resultDialog');
  assert.equal(dlg.open, true);
  assert.equal(dlg.querySelectorAll('.reveal-piece').length, 32);
  assert.match(dlg.textContent, /黑方胜/);
  assert.match(dlg.textContent, /认输/);
  env.bx.closeDialogs();
});

test('走子记录：点击进入回放，返回恢复当前局面', async () => {
  env.bx.newGame({ seed: 'ui-log' });
  const p = pickHiddenOperable();
  const mv = view().movesById[p.id].find((m) => !m.capture);
  env.bx.clickCell(p.file, p.rank);
  env.bx.clickCell(mv.to.file, mv.to.rank);
  env.bx.skipAnim();
  await wait(env.w, 20);
  const items = env.w.document.querySelectorAll('#logList .log-item');
  assert.equal(items.length, 1);
  items[0].click();
  assert.equal(env.bx.state().replayPly, 1);
  env.w.document.getElementById('replayClose').click();
  assert.equal(env.bx.state().replayPly, null);
});

test('悔棋：开启后可回退一手', async () => {
  env.store.set('bx.settings.v1', JSON.stringify({
    mode: 'hotseat', side: 'red', difficulty: 'normal', honesty: 'honest',
    balance: 'none', strict: false, undo: true, sound: false,
  }));
  env.bx.newGame({ seed: 'ui-undo' });
  const p = pickHiddenOperable();
  const mv = view().movesById[p.id].find((m) => !m.capture);
  env.bx.clickCell(p.file, p.rank);
  env.bx.clickCell(mv.to.file, mv.to.rank);
  env.bx.skipAnim();
  assert.equal(view().ply, 1);
  env.w.document.getElementById('undoBtn').click();
  assert.equal(view().ply, 0);
  assert.equal(view().pieces.length, 32);
  env.store.set('bx.settings.v1', JSON.stringify({
    mode: 'hotseat', side: 'red', difficulty: 'normal', honesty: 'honest',
    balance: 'none', strict: false, undo: false, sound: false,
  }));
});

test('新局对话框：模式 / 执方 / 难度 / 诚实度 / seed 生效', async () => {
  env.w.document.getElementById('newBtn').click();
  assert.equal(env.w.document.getElementById('newDialog').open, true);
  env.w.document.getElementById('modeInput').value = 'hotseat';
  env.w.document.getElementById('seedInput').value = 'ui-seed-42';
  env.w.document.getElementById('newStart').click();
  assert.equal(env.bx.game.seed, 'ui-seed-42');
  assert.equal(env.w.document.getElementById('newDialog').open, false);
  assert.match(env.w.document.getElementById('seedText').textContent, /ui-seed-42/);
});

test('规则面板：5 屏可翻页，关闭后标记已读', async () => {
  env.w.document.getElementById('rulesBtn').click();
  const dlg = env.w.document.getElementById('rulesDialog');
  assert.equal(dlg.open, true);
  for (let i = 0; i < 4; i++) env.w.document.getElementById('rulesNext').click();
  assert.equal(env.w.document.getElementById('rulesNext').textContent, '开始对弈');
  assert.equal(env.w.document.querySelectorAll('#rulesDots i.on').length, 1);
  env.w.document.getElementById('rulesNext').click();
  assert.equal(dlg.open, false);
});

test('标记模式：暗子循环标记，再点清除', async () => {
  env.bx.newGame({ seed: 'ui-mark' });
  const p = view().pieces.find((x) => !x.faceUp);
  env.w.document.getElementById('markBtn').click();
  assert.equal(env.bx.state().marking, true);
  env.bx.clickCell(p.file, p.rank);
  assert.equal(env.bx.S.marks.get(p.id), '?');
  for (let i = 0; i < 6; i++) env.bx.clickCell(p.file, p.rank);
  assert.equal(env.bx.S.marks.has(p.id), false);
  env.w.document.getElementById('markBtn').click();
  assert.equal(env.bx.state().marking, false);
});

/* =====================================================================
 * 人机（PvE）
 * ===================================================================== */

test('T-72 oracle 模式：红色「AI 会偷看」角标', async () => {
  const pve = await boot({ mode: 'pve', honesty: 'oracle', difficulty: 'easy' });
  try {
    pve.bx.newGame({ seed: 'oracle-ui' });
    await wait(pve.w, 60);
    const badge = pve.w.document.getElementById('aiBadge');
    assert.equal(badge.textContent, 'AI 会偷看');
    assert.ok(badge.classList.contains('oracle'));
  } finally {
    pve.dom.window.close();
  }
});

test('T-73 / T-74 人机：AI 执黑，伪思考停顿后走出合法着法', async () => {
  const pve = await boot({ mode: 'pve', side: 'red', difficulty: 'easy', honesty: 'honest' });
  try {
    const bx = pve.bx;
    bx.newGame({ seed: 'pve-timing' });
    await wait(pve.w, 40);
    const human = anyHumanMove(bx);
    const t0 = Date.now();
    bx.move(human.from, human.to);
    bx.skipAnim();
    const moved = await waitFor(pve.w, () => bx.view.ply >= 2, 4000);
    const elapsed = Date.now() - t0;
    assert.equal(moved, true, 'AI 未在预算内落子');
    assert.ok(elapsed >= 180, 'AI 不应瞬落：' + elapsed + 'ms');
    assert.equal(bx.view.turn, 'RED');
    const last = bx.view.history[bx.view.history.length - 1];
    assert.equal(last.side, 'BLACK');
    // T-71：AI 着法已由引擎合法执行
    assert.equal(pve.errors.length, 0);
  } finally {
    pve.dom.window.close();
  }
});

test('人机回归：玩家吃掉暗子后，AI 不会因为 820ms 动画尾段被跳过', async () => {
  const pve = await boot({ mode: 'pve', side: 'red', difficulty: 'easy', honesty: 'honest' });
  try {
    const bx = pve.bx;
    bx.setPosition({
      turn: 'RED',
      aiSide: 'BLACK',
      humanSide: 'RED',
      pieces: [
        { side: 'RED', kind: 'K', file: 4, rank: 1 },
        { side: 'BLACK', kind: 'K', file: 5, rank: 10 },
        { side: 'RED', kind: 'R', file: 1, rank: 1 },
        { side: 'BLACK', kind: 'P', file: 1, rank: 7, faceUp: false },
        { side: 'BLACK', kind: 'P', file: 3, rank: 7, faceUp: false },
      ],
    });
    bx.closeDialogs();
    bx.clickCell(1, 1);
    bx.clickCell(1, 7); // 吃暗子：move 320 + 被动翻面 320+160 → 820ms 动画
    assert.equal(bx.view.ply, 1);
    const moved = await waitFor(pve.w, () => bx.view.ply >= 2, 5000);
    assert.equal(moved, true, 'AI 在吃暗子的长动画后没有落子');
    assert.equal(bx.view.history.length, 2);
    assert.equal(bx.view.history[1].side, 'BLACK');
    assert.equal(pve.errors.length, 0);
  } finally {
    pve.dom.window.close();
  }
});

test('AI 执红：玩家执黑时 AI 先手', async () => {
  const pve = await boot({ mode: 'pve', side: 'black', difficulty: 'easy', honesty: 'honest' });
  try {
    const bx = pve.bx;
    bx.newGame({ seed: 'pve-red' });
    const moved = await waitFor(pve.w, () => bx.view.ply >= 1, 4000);
    assert.equal(moved, true, 'AI 红方未先手落子');
    assert.equal(bx.view.turn, 'BLACK');
    assert.equal(bx.state().humanSide, 'BLACK');
    assert.equal(bx.state().aiSide, 'RED');
  } finally {
    pve.dom.window.close();
  }
});

test('提示：玩家回合可用 3 次，显示建议着法', async () => {
  const pve = await boot({ mode: 'pve', side: 'red', difficulty: 'easy', honesty: 'honest' });
  try {
    const bx = pve.bx;
    bx.newGame({ seed: 'pve-hint' });
    const btn = pve.w.document.getElementById('hintBtn');
    assert.equal(bx.state().hintsLeft, 3);
    btn.click();
    await wait(pve.w, 30);
    assert.equal(bx.state().hintsLeft, 2);
    assert.ok(bx.state().hintMove);
    assert.match(bx.state().hintText, /提示/);
    assert.equal(env.errors.length, 0);
  } finally {
    pve.dom.window.close();
  }
});

test('连续 30 手随机走子（同屏）：无异常，日志与手数一致', async () => {
  env.store.set('bx.settings.v1', JSON.stringify({
    mode: 'hotseat', side: 'red', difficulty: 'normal', honesty: 'honest',
    balance: 'none', strict: false, undo: false, sound: false,
  }));
  env.bx.newGame({ seed: 'ui-many' });
  let moves = 0;
  for (let i = 0; i < 30; i++) {
    const v = view();
    if (v.status !== 'PLAYING') break;
    const candidates = [];
    for (const id of Object.keys(v.movesById)) {
      for (const m of v.movesById[id]) candidates.push({ id: Number(id), m });
    }
    if (!candidates.length) break;
    const pick = candidates[Math.floor(Math.random() * candidates.length)];
    const piece = v.pieces.find((x) => x.id === pick.id);
    env.bx.move({ file: piece.file, rank: piece.rank }, pick.m.to);
    env.bx.skipAnim();
    moves++;
  }
  await wait(env.w, 30);
  assert.ok(moves >= 10);
  assert.equal(view().ply, moves);
  assert.equal(env.w.document.querySelectorAll('#logList .log-item').length, moves);
  assert.equal(env.errors.length, 0, env.errors.join('\n'));
});
