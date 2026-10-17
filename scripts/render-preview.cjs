#!/usr/bin/env node
/**
 * 离线渲染预览：用 jsdom + node-canvas 真实执行 ui.js 的 Canvas 绘制，
 * 导出棋盘 PNG，便于没有浏览器时检查视觉效果。
 *
 * 用法：node scripts/render-preview.cjs
 * 产出：shots/board-start.png / board-mid.png / board-check.png
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { createCanvas } = require('@napi-rs/canvas');

const ROOT = path.resolve(__dirname, '..');
const SHOTS = path.join(ROOT, 'shots');
fs.mkdirSync(SHOTS, { recursive: true });

async function boot() {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const dom = new JSDOM(html, {
    url: 'file:///' + path.join(ROOT, 'index.html').replace(/\\/g, '/'),
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const w = dom.window;
  w.__BX_TEST__ = true;
  w.Element.prototype.getBoundingClientRect = () => ({
    width: 960, height: 860, top: 0, left: 0, right: 960, bottom: 860, x: 0, y: 0,
    toJSON() { return this; },
  });

  const canvases = new Map();
  w.HTMLCanvasElement.prototype.getContext = function () {
    if (canvases.has(this)) return canvases.get(this).ctx;
    const el = this;
    const canvas = createCanvas(760, 840);
    const ctx2d = canvas.getContext('2d');
    const ctx = new Proxy(ctx2d, {
      get(t, key) {
        if (key === 'canvas') return el;
        const value = t[key];
        return typeof value === 'function' ? value.bind(t) : value;
      },
      set(t, key, value) { t[key] = value; return true; },
    });
    // 把 jsdom 元素的 width/height 写入真实画布
    let w0 = 0;
    let h0 = 0;
    Object.defineProperty(el, 'width', {
      configurable: true,
      get: () => w0,
      set: (v) => { w0 = v; if (v > 0) canvas.width = v; },
    });
    Object.defineProperty(el, 'height', {
      configurable: true,
      get: () => h0,
      set: (v) => { h0 = v; if (v > 0) canvas.height = v; },
    });
    canvases.set(el, { canvas, ctx });
    return ctx;
  };

  w.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  const store = new Map([['bx.rulesSeen.v1', '1']]);
  store.set('bx.settings.v1', JSON.stringify({
    mode: 'hotseat', side: 'red', difficulty: 'normal', honesty: 'honest',
    balance: 'none', strict: false, undo: false, sound: false,
  }));
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
    if (!proto.close) proto.close = function () { if (this.open) { this.open = false; this.dispatchEvent(new w.Event('close')); } };
  }
  w.confirm = () => true;

  for (const file of ['src/engine.js', 'src/visual.js', 'src/ai.js', 'src/ui.js']) {
    w.eval(fs.readFileSync(path.join(ROOT, file), 'utf8'));
  }
  await new Promise((r) => setTimeout(r, 150));
  w.__bx.closeDialogs();
  return { dom, w, bx: w.__bx, canvases };
}

function save(env, name) {
  const el = env.w.document.getElementById('board');
  const entry = env.canvases.get(el);
  if (!entry) throw new Error('canvas not found');
  const buf = entry.canvas.toBuffer('image/png');
  fs.writeFileSync(path.join(SHOTS, name), buf);
  console.log('wrote', name, entry.canvas.width + 'x' + entry.canvas.height, buf.length + 'B');
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const env = await boot();
  const bx = env.bx;

  // 1) 开局：30 枚暗子 + 双方将帅
  bx.newGame({ seed: 'preview-start' });
  bx.closeDialogs();
  await wait(120);
  save(env, 'board-start.png');

  // 2) 中局：随机走 14 手，选中一枚暗子（展示落点/上一步）
  bx.newGame({ seed: 'preview-mid' });
  bx.closeDialogs();
  for (let i = 0; i < 14; i++) {
    const v = bx.view;
    const ids = Object.keys(v.movesById).filter((id) => v.movesById[id].length);
    if (!ids.length) break;
    const id = ids[Math.floor(Math.random() * ids.length)];
    const piece = v.pieces.find((p) => p.id === Number(id));
    const list = v.movesById[id];
    const mv = list[Math.floor(Math.random() * list.length)];
    bx.move({ file: piece.file, rank: piece.rank }, mv.to);
    bx.skipAnim();
  }
  // 选中一枚仍有落点的暗子
  const v = bx.view;
  const cand = v.pieces.filter((p) => !p.faceUp && v.operableIds.includes(p.id) && (v.movesById[p.id] || []).length);
  if (cand.length) bx.clickCell(cand[0].file, cand[0].rank);
  await wait(120);
  save(env, 'board-mid.png');

  // 3) 将军局面：被将、选中可挡将的明子
  bx.setPosition({
    turn: 'RED',
    pieces: [
      { side: 'RED', kind: 'K', file: 5, rank: 1 },
      { side: 'BLACK', kind: 'K', file: 5, rank: 10 },
      { side: 'BLACK', kind: 'R', file: 5, rank: 8 },
      { side: 'BLACK', kind: 'C', file: 2, rank: 8 },
      { side: 'BLACK', kind: 'H', file: 7, rank: 3 },
      { side: 'BLACK', kind: 'P', file: 3, rank: 5 },
      { side: 'RED', kind: 'R', file: 1, rank: 5 },
      { side: 'RED', kind: 'C', file: 8, rank: 4 },
      { side: 'RED', kind: 'H', file: 2, rank: 2 },
      { side: 'RED', kind: 'A', file: 4, rank: 2 },
      { side: 'BLACK', kind: 'R', file: 9, rank: 1 },
      { side: 'RED', kind: 'P', file: 4, rank: 1, faceUp: false },
      { side: 'BLACK', kind: 'P', file: 7, rank: 7, faceUp: false },
      { side: 'RED', kind: 'C', file: 2, rank: 3, faceUp: false },
      { side: 'BLACK', kind: 'E', file: 3, rank: 10, faceUp: false },
      { side: 'RED', kind: 'E', file: 3, rank: 1, faceUp: false },
    ],
  });
  bx.closeDialogs();
  bx.clickCell(1, 5); // 选中红车，展示可挡将的落点
  await wait(120);
  save(env, 'board-check.png');

  // 4) 翻面逐帧：暗子走到 (1,3)，0 / 80 / 170 / 260 / 320 / 410 / 560 / 640ms
  bx.setPosition({
    turn: 'RED',
    pieces: [
      { side: 'RED', kind: 'R', file: 1, rank: 1, faceUp: false },
    ],
  });
  bx.closeDialogs();
  bx.move({ file: 1, rank: 1 }, { file: 1, rank: 3 });
  for (const t of [0, 80, 170, 260, 320, 410, 560, 600, 640]) {
    bx.renderAnimAt(t);
    save(env, `flip-${String(t).padStart(3, '0')}.png`);
  }

  // 5) 被动揭示：暗子吃暗子，被吃子也走翻面动效
  bx.setPosition({
    turn: 'RED',
    pieces: [
      { side: 'RED', kind: 'R', file: 1, rank: 1, faceUp: false },
      { side: 'BLACK', kind: 'P', file: 1, rank: 7, faceUp: false },
    ],
  });
  bx.closeDialogs();
  bx.move({ file: 1, rank: 1 }, { file: 1, rank: 7 });
  bx.renderAnimAt(500);
  save(env, 'capture-flip-500.png');

  console.log('预览完成：shots/board-*.png + flip-*.png');
  env.dom.window.close();
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
