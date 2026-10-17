/*!
 * 盲棋象棋 Blind Xiangqi — 前端交互层
 *
 * 约定（spec §11.1）：界面只消费 Game.uiState() —— 暗子的 kind/side
 * 根本不存在于这个视图里；所有渲染与合法性提示都只依赖公开信息。
 */
(function () {
  'use strict';

  const BX = window.BlindXiangqi;
  const AI = window.BlindAI;
  const VIS = window.BXVisual;

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  const sqKey = (s) => s.file + ',' + s.rank;
  const SQ = (file, rank) => ({ file, rank });
  const NAMES = BX.NAMES;
  const SIDE_CHAR = BX.SIDE_CHAR;
  const SIDE_NAME = BX.SIDE_NAME;
  const ORIGIN_KIND = BX.ORIGIN_KIND;
  const ORIGIN_SIDE = BX.ORIGIN_SIDE;
  const UI_FONT = '"Segoe UI", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif';
  const SERIF = '"Songti SC", "STSong", "SimSun", serif';
  const KAITI = '"STKaiti", "KaiTi", "Kaiti SC", "SimSun", serif';

  const SETTINGS_KEY = 'bx.settings.v1';
  const RULES_KEY = 'bx.rulesSeen.v1';
  const SAVE_KEY = 'bx.save.v1';
  const TEST_MODE = window.__BX_TEST__ === true;

  /* =====================================================================
   * 元素
   * ===================================================================== */
  const E = {
    canvas: $('#board'),
    frame: $('#boardFrame'),
    pane: $('#boardPane'),
    a11y: $('#a11yGrid'),
    hintbar: $('#hintbar'),
    toast: $('#toast'),
    turnDot: $('#turnDot'),
    turnText: $('#turnText'),
    plyText: $('#plyText'),
    clockText: $('#clockText'),
    checkPill: $('#checkPill'),
    redUp: $('#redUp'),
    blackUp: $('#blackUp'),
    redHidden: $('#redHidden'),
    blackHidden: $('#blackHidden'),
    redLost: $('#redLost'),
    blackLost: $('#blackLost'),
    redTray: $('#redTray'),
    blackTray: $('#blackTray'),
    modeText: $('#modeText'),
    seedText: $('#seedText'),
    logList: $('#logList'),
    countText: $('#countText'),
    recordHint: $('#recordHint'),
    newBtn: $('#newBtn'),
    homeBtn: $('#homeBtn'),
    undoBtn: $('#undoBtn'),
    resignBtn: $('#resignBtn'),
    drawBtn: $('#drawBtn'),
    markBtn: $('#markBtn'),
    panelBtn: $('#panelBtn'),
    soundBtn: $('#soundBtn'),
    helpBtn: $('#helpBtn'),
    rulesBtn: $('#rulesBtn'),
    sidePanel: $('#sidePanel'),
    modeBadge: $('#modeBadge'),
    aiBadge: $('#aiBadge'),
    aiThinking: $('#aiThinking'),
    resultDialog: $('#resultDialog'),
    resultTitle: $('#resultTitle'),
    resultReason: $('#resultReason'),
    resultSub: $('#resultSub'),
    resultStats: $('#resultStats'),
    revealGrid: $('#revealGrid'),
    copyBtn: $('#copyBtn'),
    closeResult: $('#closeResult'),
    againBtn: $('#againBtn'),
    newDialog: $('#newDialog'),
    seedInput: $('#seedInput'),
    balanceSelect: $('#balanceSelect'),
    modeInput: $('#modeInput'),
    sideInput: $('#sideInput'),
    difficultyInput: $('#difficultyInput'),
    honestyInput: $('#honestyInput'),
    strictToggle: $('#strictToggle'),
    undoToggle: $('#undoToggle'),
    newCancel: $('#newCancel'),
    newStart: $('#newStart'),
    modeSelect: $('#modeSelect'),
    difficultySelect: $('#difficultySelect'),
    hintBtn: $('#hintBtn'),
    rulesDialog: $('#rulesDialog'),
    rulesBody: $('#rulesBody'),
    rulesDots: $('#rulesDots'),
    rulesPrev: $('#rulesPrev'),
    rulesNext: $('#rulesNext'),
    replayBar: $('#replayBar'),
    replayText: $('#replayText'),
    replayPrev: $('#replayPrev'),
    replayNext: $('#replayNext'),
    replayClose: $('#replayClose'),
    app: $('#app'),
    home: $('#homeScreen'),
    startBtn: $('#startBtn'),
    homeConfigBtn: $('#homeConfigBtn'),
    homeConfigSummary: $('#homeConfigSummary'),
    homeHotseatBtn: $('#homeHotseatBtn'),
    homeOnlineBtn: $('#homeOnlineBtn'),
    homeContinueBtn: $('#homeContinueBtn'),
    homeRulesBtn: $('#homeRulesBtn'),
    homeAboutBtn: $('#homeAboutBtn'),
    homeConfigDialog: $('#homeConfigDialog'),
    homeModeInput: $('#homeModeInput'),
    homeDifficultyInput: $('#homeDifficultyInput'),
    homeSideInput: $('#homeSideInput'),
    homeConfigDone: $('#homeConfigDone'),
    aboutDialog: $('#aboutDialog'),
    aboutClose: $('#aboutClose'),
    onlineDialog: $('#onlineDialog'),
    onlineClose: $('#onlineClose'),
    homeFromResult: $('#homeFromResult'),
    captureFeed: $('#captureFeed'),
    captureStrip: $('#captureStrip'),
  };

  /* Canvas 2D 上下文延迟到真正进入对局时创建（spec §11.2：冷启动不初始化 Canvas） */
  let ctx = null;
  function ensureCtx() {
    if (!ctx && E.canvas) ctx = E.canvas.getContext('2d');
    return ctx;
  }

  /* =====================================================================
   * 状态
   * ===================================================================== */
  const S = {
    phase: 'HOME',
    game: null,
    view: null,
    selectedId: null,
    legalByKey: new Map(),
    hover: null,
    focus: { file: 5, rank: 1 },
    cellFocused: false,
    anim: null,
    marks: new Map(),
    marking: false,
    snapshots: [],
    replayPly: null,
    aiSide: null,
    humanSide: null,
    aiThinking: false,
    aiTimer: 0,
    resultTimer: 0,
    hintsLeft: 3,
    hintMove: null,
    lastAI: null,
    settings: loadSettings(),
    resultShown: false,
    startTime: 0,
    endTime: 0,
    capturePly: null,
    captureLive: null,
    pendingStart: null,
    busy: false,
    dialogOpen: false,
    M: { cell: 40, margin: 32, w: 380, h: 430 },
    flip: false,
    grain: [],
    cells: new Map(),
    lastAction: 0,
    frameHandle: 0,
    rulesIndex: 0,
    announce: null,
  };

  function loadSettings() {
    const defaults = {
      mode: 'pve',
      side: 'red',
      difficulty: 'normal',
      honesty: 'honest',
      balance: 'none',
      strict: false,
      undo: false,
      sound: true,
    };
    try {
      return Object.assign(defaults, JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}'));
    } catch (err) {
      return defaults;
    }
  }
  function saveSettings() {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(S.settings)); } catch (err) { /* ignore */ }
  }

  /* 未完成对局：只保存 seed + 着法，重放即可恢复，不落盘任何暗子身份 */
  function clearSave() {
    try { localStorage.removeItem(SAVE_KEY); } catch (err) { /* ignore */ }
  }

  function readSave() {
    try {
      const raw = localStorage.getItem(SAVE_KEY);
      if (!raw) return null;
      const data = JSON.parse(raw);
      if (!data || data.v !== 1 || !data.seed || !Array.isArray(data.moves)) return null;
      if (!data.moves.length || data.status !== 'PLAYING') return null;
      return data;
    } catch (err) {
      return null;
    }
  }

  function hasSave() {
    return !!readSave();
  }

  function saveGame() {
    if (!S.game || !S.view || S.view.status !== 'PLAYING') return;
    if (!S.view.ply) return;
    const data = {
      v: 1,
      seed: S.game.seed,
      config: S.game.config,
      moves: S.view.history.map((ev) => ({ from: ev.from, to: ev.to })),
      mode: S.settings.mode,
      difficulty: S.settings.difficulty,
      honesty: S.settings.honesty,
      side: S.settings.side,
      humanSide: S.humanSide,
      aiSide: S.aiSide,
      hintsLeft: S.hintsLeft,
      elapsedMs: Math.max(0, Date.now() - S.startTime),
      status: S.view.status,
      savedAt: Date.now(),
    };
    try { localStorage.setItem(SAVE_KEY, JSON.stringify(data)); } catch (err) { /* ignore */ }
  }

  function diffLabel(v) {
    return { easy: '入门', normal: '进阶', hard: '高手' }[v] || '进阶';
  }

  function updateHome() {
    const s = S.settings;
    const side = s.side === 'black' ? '执黑' : s.side === 'random' ? '随机执方' : '执红';
    E.homeConfigSummary.textContent = s.mode === 'hotseat'
      ? '同屏双人'
      : `人机 · ${diffLabel(s.difficulty)}`;
    E.homeConfigBtn.title = s.mode === 'hotseat'
      ? '同屏双人 · 点击修改配置'
      : `人机 · ${diffLabel(s.difficulty)} · ${side} · 点击修改配置`;
    const save = readSave();
    E.homeContinueBtn.hidden = !save;
    if (save) {
      const turn = save.moves.length % 2 === 0 ? '红方' : '黑方';
      E.homeContinueBtn.textContent = `继续上局 · 第 ${save.moves.length} 手 · ${turn}行棋`;
    }
    if (E.homeModeInput) E.homeModeInput.value = s.mode;
    if (E.homeDifficultyInput) {
      E.homeDifficultyInput.value = s.difficulty;
      E.homeDifficultyInput.disabled = s.mode === 'hotseat';
    }
    if (E.homeSideInput) E.homeSideInput.value = s.side;
  }

  function showHome() {
    clearTimeout(S.aiTimer);
    clearTimeout(S.resultTimer);
    S.aiThinking = false;
    S.phase = 'HOME';
    S.game = null;
    S.view = null;
    S.anim = null;
    S.card = null;
    S.selectedId = null;
    S.legalByKey.clear();
    S.replayPly = null;
    S.capturePly = null;
    S.settings = loadSettings();
    closeDialog(E.resultDialog);
    closeDialog(E.newDialog);
    E.app.classList.add('home-active');
    updateHome();
  }

  function openHomeConfig() {
    S.settings = loadSettings();
    if (E.homeModeInput) E.homeModeInput.value = S.settings.mode;
    if (E.homeDifficultyInput) {
      E.homeDifficultyInput.value = S.settings.difficulty;
      E.homeDifficultyInput.disabled = S.settings.mode === 'hotseat';
    }
    if (E.homeSideInput) E.homeSideInput.value = S.settings.side;
    if (!E.homeConfigDialog.open) E.homeConfigDialog.showModal();
  }

  function applyHomeConfig() {
    S.settings.mode = E.homeModeInput.value === 'hotseat' ? 'hotseat' : 'pve';
    S.settings.difficulty = E.homeDifficultyInput.value;
    S.settings.side = E.homeSideInput.value;
    saveSettings();
    updateHome();
  }

  function restoreSavedGame() {
    const save = readSave();
    if (!save) { updateHome(); return; }
    try {
      S.settings = Object.assign({}, loadSettings(), {
        mode: save.mode || 'pve',
        difficulty: save.difficulty || 'normal',
        honesty: save.honesty || 'honest',
        side: save.side || 'red',
      });
      saveSettings();
      const game = new BX.Game({ seed: save.seed, config: save.config });
      const snapshots = [game.uiState()];
      for (const mv of save.moves) {
        const res = game.move(mv.from, mv.to);
        if (!res.ok) throw new Error(res.code || 'BAD_SAVE');
        snapshots[game.ply] = game.uiState();
      }
      S.game = game;
      S.view = game.uiState();
      S.snapshots = snapshots;
      S.phase = 'PLAYING';
      S.humanSide = save.humanSide || (S.settings.side === 'black' ? 'BLACK' : 'RED');
      S.aiSide = save.aiSide !== undefined
        ? save.aiSide
        : (S.settings.mode === 'pve' ? (S.humanSide === 'RED' ? 'BLACK' : 'RED') : null);
      S.flip = !!S.aiSide && S.humanSide === 'BLACK';
      S.hintsLeft = Number.isFinite(save.hintsLeft) ? save.hintsLeft : 3;
      S.startTime = Date.now() - Math.max(0, Number(save.elapsedMs) || 0);
      S.endTime = 0;
      S.selectedId = null;
      S.legalByKey.clear();
      S.anim = null;
      S.card = null;
      S.marks.clear();
      S.replayPly = null;
      S.resultShown = false;
      S.aiThinking = false;
      S.hintMove = null;
      S.capturePly = null;
      S.grain = makeGrain(game.seed);
      E.app.classList.remove('home-active');
      hideReplay();
      closeDialog(E.resultDialog);
      refresh();
      layout();
      maybeAI();
      S.announce('已继续上次对局');
      return true;
    } catch (err) {
      clearSave();
      showHome();
      return false;
    }
  }

  const Sound = (function () {
    let ac = null;
    let noiseBuf = null;

    function ensure() {
      if (!ac) {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return null;
        ac = new Ctx();
      }
      if (ac.state === 'suspended') ac.resume();
      return ac;
    }
    function noise() {
      if (!noiseBuf) {
        const len = Math.floor(ac.sampleRate * 0.4);
        noiseBuf = ac.createBuffer(1, len, ac.sampleRate);
        const data = noiseBuf.getChannelData(0);
        for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
      }
      const src = ac.createBufferSource();
      src.buffer = noiseBuf;
      return src;
    }
    function tone(freq, dur, type, gain, when, slideTo) {
      if (!ac) return;
      const osc = ac.createOscillator();
      const g = ac.createGain();
      osc.type = type || 'sine';
      osc.frequency.setValueAtTime(freq, when);
      if (slideTo) osc.frequency.exponentialRampToValueAtTime(slideTo, when + dur);
      g.gain.setValueAtTime(0.0001, when);
      g.gain.exponentialRampToValueAtTime(gain, when + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
      osc.connect(g).connect(ac.destination);
      osc.start(when);
      osc.stop(when + dur + 0.02);
    }
    function burst(dur, gain, freq, when) {
      if (!ac) return;
      const src = noise();
      const filter = ac.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.value = freq || 1200;
      filter.Q.value = 0.9;
      const g = ac.createGain();
      g.gain.setValueAtTime(gain, when);
      g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
      src.connect(filter).connect(g).connect(ac.destination);
      src.start(when);
      src.stop(when + dur + 0.02);
    }

    function play(name) {
      if (!S.settings.sound) return;
      try {
        const c = ensure();
        if (!c) return;
        const t = c.currentTime + 0.01;
        if (name === 'move' || name === 'land') {
          // 落子：木头落在棋盘上的一记短促干响
          burst(0.045, 0.055, 1400, t);
          tone(150, 0.07, 'sine', 0.07, t);
        } else if (name === 'flip') {
          // §11.5.2 木质两连音：提起 90ms + 落定 120ms，总长 ≤220ms，音量低于落子
          const clicks = VIS.AUDIO.flipClicks;
          const durs = VIS.AUDIO.flipDurations;
          burst(0.05, 0.028, 1900, t + clicks[0] / 1000);
          tone(320, durs[0] / 1000, 'triangle', 0.022, t + clicks[0] / 1000, 260);
          burst(0.06, 0.03, 1200, t + clicks[1] / 1000);
          tone(180, durs[1] / 1000, 'sine', 0.03, t + clicks[1] / 1000, 140);
        } else if (name === 'capture') {
          tone(92, 0.2, 'sine', 0.12, t);
          burst(0.14, 0.08, 700, t);
        } else if (name === 'check') {
          tone(880, 0.5, 'sine', 0.05, t);
          tone(1174.7, 0.5, 'sine', 0.035, t + 0.02);
        } else if (name === 'illegal') {
          tone(120, 0.12, 'sawtooth', 0.035, t, 90);
        } else if (name === 'end') {
          [523.25, 659.25, 783.99].forEach((f, i) => tone(f, 1.2, 'sine', 0.05, t + i * 0.06));
        } else if (name === 'select') {
          tone(660, 0.05, 'sine', 0.02, t);
        }
      } catch (err) { /* ignore */ }
    }
    return { play, unlock: ensure };
  })();

  /* =====================================================================
   * 初始化
   * ===================================================================== */
  function init() {
    buildA11yGrid();
    buildRules();

    const live = document.createElement('div');
    live.id = 'live';
    live.className = 'sr-only';
    live.setAttribute('role', 'status');
    live.setAttribute('aria-live', 'polite');
    document.body.appendChild(live);
    S.announce = (text) => { live.textContent = ''; setTimeout(() => { live.textContent = text; }, 30); };
    const capLive = document.createElement('div');
    capLive.id = 'captureLive';
    capLive.className = 'sr-only';
    capLive.setAttribute('role', 'status');
    capLive.setAttribute('aria-live', 'polite');
    document.body.appendChild(capLive);
    S.captureLive = capLive;

    bindUI();
    bindTouchSnap();
    let autoStart = false;
    try {
      const q = new URLSearchParams(location.search);
      autoStart = q.get('autostart') === '1';
      if (autoStart) {
        history.replaceState(null, '', location.pathname);
      }
    } catch (err) { /* file:// 或旧浏览器不支持 URLSearchParams 时忽略 */ }
    if (!autoStart) showHome();
    // 从服务器首页「人机对战」直接进入：跳过本地 Home，直接开局。
    if (autoStart) {
      S.settings = loadSettings();
      S.settings.mode = 'pve';
      saveSettings();
      setTimeout(() => startGame({ seed: BX.randomSeed(), skipEnter: true }), 0);
    }
    setInterval(tickClock, 500);
    new ResizeObserver(() => { if (S.game) { layout(); requestDraw(); } }).observe(E.pane);
    window.addEventListener('resize', () => { if (S.game) { layout(); requestDraw(); } });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible' || !S.game) return;
      layout();
      requestDraw();
      maybeAI();
    });

    if (!hasSeenRules()) {
      setTimeout(() => showRules(true), 350);
    }

    if (TEST_MODE) {
      window.__bx = testHooks();
    }
  }

  /* =====================================================================
   * 棋盘网格（键盘 / 无障碍）
   * ===================================================================== */
  function buildA11yGrid() {
    const frag = document.createDocumentFragment();
    for (let rank = 1; rank <= 10; rank++) {
      for (let file = 1; file <= 9; file++) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.dataset.file = String(file);
        btn.dataset.rank = String(rank);
        btn.tabIndex = file === 5 && rank === 1 ? 0 : -1;
        btn.setAttribute('aria-label', `第${rank}行第${file}列，空`);
        btn.addEventListener('click', () => onCellClick(SQ(file, rank)));
        btn.addEventListener('mouseenter', () => { S.hover = SQ(file, rank); requestDraw(); });
        btn.addEventListener('mouseleave', () => { S.hover = null; requestDraw(); });
        btn.addEventListener('focus', () => {
          S.focus = SQ(file, rank);
          S.cellFocused = true;
          setRoving(file, rank);
          requestDraw();
        });
        btn.addEventListener('blur', () => { S.cellFocused = false; requestDraw(); });
        btn.addEventListener('contextmenu', (ev) => {
          ev.preventDefault();
          if (S.replayPly !== null) return;
          const p = pieceBySquare(file, rank);
          if (p && !p.faceUp) { cycleMark(p.id); requestDraw(); }
        });
        S.cells.set(sqKey({ file, rank }), btn);
        frag.appendChild(btn);
      }
    }
    E.a11y.appendChild(frag);

    E.a11y.addEventListener('keydown', (ev) => {
      const target = ev.target.closest && ev.target.closest('button[data-file]');
      if (!target) return;
      const file = Number(target.dataset.file);
      const rank = Number(target.dataset.rank);
      const deltas = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] };
      if (deltas[ev.key]) {
        ev.preventDefault();
        const [df, dr] = deltas[ev.key];
        focusCell(clamp(file + df, 1, 9), clamp(rank + dr, 1, 10));
      } else if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        onCellClick(SQ(file, rank));
      } else if (ev.key === 'Escape') {
        ev.preventDefault();
        escapeAction();
      }
    });
  }

  function setRoving(file, rank) {
    S.cells.forEach((btn) => { btn.tabIndex = -1; });
    const b = S.cells.get(file + ',' + rank);
    if (b) b.tabIndex = 0;
  }

  function focusCell(file, rank) {
    const b = S.cells.get(file + ',' + rank);
    if (b) { b.focus(); S.focus = SQ(file, rank); requestDraw(); }
  }

  function escapeAction() {
    if (S.replayPly !== null) { exitReplay(); return; }
    if (S.selectedId !== null) { deselect(); return; }
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  }

  /* =====================================================================
   * 布局
   * ===================================================================== */
  function layout() {
    if (!S.game || !E.canvas) return;
    ensureCtx();
    if (!ctx) return;
    const rect = E.pane.getBoundingClientRect();
    const availW = Math.max(240, rect.width - 6);
    const replayExtra = E.replayBar.hidden ? 0 : 38;
    const mobileStrip = (window.matchMedia && window.matchMedia('(max-width: 1023px)').matches)
      || (!window.matchMedia && window.innerWidth < 1024);
    const stripExtra = mobileStrip ? 54 : 0;
    const availH = Math.max(260, rect.height - 36 - replayExtra - stripExtra);
    let cell = Math.min(availW / 10.3, availH / 11.3, 76);
    cell = Math.max(22, cell);
    const margin = cell * 1.15;
    const w = 8 * cell + margin * 2;
    const h = 9 * cell + margin * 2;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const canvasChanged = !S.M
      || Math.abs(cell - S.M.cell) > 0.01
      || Math.abs(w - S.M.w) > 0.01
      || Math.abs(h - S.M.h) > 0.01
      || E.canvas.width !== Math.round(w * dpr)
      || E.canvas.height !== Math.round(h * dpr);

    S.M = {
      cell, margin, w, h,
      x: (f) => margin + ((S.flip ? 10 - f : f) - 1) * cell,
      y: (r) => margin + ((S.flip ? r - 1 : 10 - r)) * cell,
    };

    if (canvasChanged) {
      E.canvas.style.width = w + 'px';
      E.canvas.style.height = h + 'px';
      E.canvas.width = Math.round(w * dpr);
      E.canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    S.cells.forEach((btn, key) => {
      const [f, r] = key.split(',').map(Number);
      btn.style.left = S.M.x(f) + 'px';
      btn.style.top = S.M.y(r) + 'px';
      btn.style.width = cell + 'px';
      btn.style.height = cell + 'px';
    });
    requestDraw();
  }

  const X = (file) => S.M.margin + ((S.flip ? 10 - file : file) - 1) * S.M.cell;
  const Y = (rank) => S.M.margin + ((S.flip ? rank - 1 : 10 - rank)) * S.M.cell;

  function hasSeenRules() {
    try { return !!localStorage.getItem(RULES_KEY); } catch (err) { return false; }
  }
  function markRulesSeen() {
    try { localStorage.setItem(RULES_KEY, '1'); } catch (err) { /* ignore */ }
  }

  /* =====================================================================
   * 对局生命周期
   * ===================================================================== */
  function makeConfig(settings) {
    return {
      shuffle: { balance: settings.balance },
      strictCheck: !!settings.strict,
      undo: !!settings.undo,
      mode: settings.mode,
      attackHidden: { confirm: 'none' },
      ai: {
        side: settings.side,
        difficulty: settings.difficulty,
        honesty: settings.honesty,
        hintPerGame: 3,
      },
    };
  }

  function startGame(opts) {
    const options = opts || {};
    if (!hasSeenRules() && !options.skipRules) {
      S.pendingStart = options;
      showRules(true);
      return;
    }
    clearSave();
    S.phase = 'PLAYING';
    E.app.classList.remove('home-active');
    if (!options.skipEnter) E.app.classList.add('game-entering');
    newGame(Object.assign({}, options, { silent: options.silent !== false }));
    document.documentElement.classList.remove('autostart-pending');
    clearTimeout(S.enterTimer);
    if (options.skipEnter) {
      E.app.classList.remove('game-entering');
      layout();
      requestDraw();
      return;
    }
    S.enterTimer = setTimeout(() => {
      E.app.classList.remove('game-entering');
      layout();
      requestDraw();
    }, 450);
  }

  function newGame(opts) {
    const options = opts || {};
    clearTimeout(S.aiTimer);
    clearTimeout(S.resultTimer);
    S.settings = loadSettings();
    const config = makeConfig(S.settings);
    S.phase = 'PLAYING';
    E.app.classList.remove('home-active');
    clearSave();
    S.game = new BX.Game({ seed: options.seed || BX.randomSeed(), config });
    S.aiSide = null;
    S.humanSide = null;
    if (S.settings.mode === 'pve') {
      let chosen = S.settings.side;
      if (chosen === 'random') {
        const r = BX.mulberry32(BX.hashSeed(S.game.seed + ':side'))();
        chosen = r < 0.5 ? 'red' : 'black';
      }
      S.humanSide = chosen === 'black' ? 'BLACK' : 'RED';
      S.aiSide = S.humanSide === 'RED' ? 'BLACK' : 'RED';
      S.flip = S.humanSide === 'BLACK';
    } else {
      S.flip = false;
    }
    S.selectedId = null;
    S.legalByKey.clear();
    S.anim = null;
    S.card = null;
    S.marks.clear();
    S.marking = false;
    S.replayPly = null;
    S.resultShown = false;
    S.startTime = Date.now();
    S.endTime = 0;
    S.busy = false;
    S.aiThinking = false;
    S.hintsLeft = Math.max(0, Number(config.ai.hintPerGame) || 3);
    S.hintMove = null;
    S.capturePly = null;
    S.lastAI = null;
    S.view = S.game.uiState();
    S.snapshots = [S.view];
    S.grain = makeGrain(S.game.seed);
    hideReplay();
    closeDialog(E.resultDialog);
    E.markBtn.classList.remove('toggle-on');
    E.markBtn.setAttribute('aria-pressed', 'false');
    refresh();
    layout();
    S.announce(S.aiSide === 'RED' ? '新对局开始，AI 执红先行' : '新对局开始，红方先行');
    if (!options.silent) Sound.play('select');
    if (!hasSeenRules()) {
      // 首访规则弹窗会稍后出现；先等它关闭，避免 AI 在弹窗后面落子
      clearTimeout(S.aiTimer);
      S.aiTimer = setTimeout(maybeAI, 450);
    } else {
      maybeAI();
    }
  }

  function makeGrain(seed) {
    const rnd = BX.mulberry32(BX.hashSeed(seed + ':grain'));
    const out = [];
    for (let i = 0; i < 30; i++) {
      out.push({
        y: rnd(),
        amp: 3 + rnd() * 12,
        phase: rnd() * Math.PI * 2,
        freq: 1.2 + rnd() * 2.4,
        alpha: 0.010 + rnd() * 0.028,
        width: 0.5 + rnd() * 1.1,
      });
    }
    return out;
  }

  /* =====================================================================
   * 视图 / DOM 刷新
   * ===================================================================== */
  function activeView() {
    if (S.replayPly !== null && S.snapshots[S.replayPly]) return S.snapshots[S.replayPly];
    return S.view;
  }

  function refresh() {
    if (!S.game) return;
    S.view = S.game.uiState();
    if (S.snapshots.length > S.game.ply + 1) S.snapshots.length = S.game.ply + 1;
    S.snapshots[S.game.ply] = S.view;
    renderTop();
    renderSide();
    renderButtons();
    renderA11y();
    updateHint();
    requestDraw();
  }

  function renderTop() {
    const v = S.view;
    const humanTurn = !S.aiSide || v.turn === S.humanSide;
    E.turnDot.classList.toggle('black', v.turn === 'BLACK');
    if (v.status !== 'PLAYING') {
      E.turnText.textContent = '对局结束';
    } else {
      E.turnText.textContent = `${SIDE_NAME[v.turn]}行棋${S.aiSide ? (humanTurn ? ' · 你' : ' · AI') : ''}`;
    }
    E.plyText.textContent = `第 ${v.ply + 1} 手`;
    const checks = [];
    if (v.inCheck.RED) checks.push('红方被将军');
    if (v.inCheck.BLACK) checks.push('黑方被将军');
    if (checks.length && v.status === 'PLAYING') {
      E.checkPill.textContent = checks.join(' · ');
      E.checkPill.hidden = false;
    } else {
      E.checkPill.hidden = true;
    }

    // 模式 / 诚实度角标（§12.8）
    const diffLabel = { easy: '入门', normal: '进阶', hard: '高手' }[S.settings.difficulty] || '进阶';
    if (S.aiSide) {
      E.modeBadge.textContent = `人机 · ${diffLabel}`;
      E.aiBadge.hidden = false;
      const oracle = S.settings.honesty === 'oracle';
      E.aiBadge.textContent = oracle ? 'AI 会偷看' : 'AI 不偷看';
      E.aiBadge.className = 'ai-badge ' + (oracle ? 'oracle' : 'honest');
      E.aiBadge.title = oracle ? '全知陪练：本局不计分' : '诚实 AI：只读取公开信息';
    } else {
      E.modeBadge.textContent = '同屏双人';
      E.aiBadge.hidden = true;
    }
    E.aiThinking.hidden = !S.aiThinking;
    tickClock();
  }

  function renderSide() {
    const v = S.view;
    const up = v.pieces.filter((p) => p.faceUp);
    const hidden = v.pieces.filter((p) => !p.faceUp);
    E.redUp.textContent = String(up.filter((p) => p.side === 'RED').length);
    E.blackUp.textContent = String(up.filter((p) => p.side === 'BLACK').length);
    E.redHidden.textContent = String(hidden.filter((p) => p.rank <= 5).length);
    E.blackHidden.textContent = String(hidden.filter((p) => p.rank >= 6).length);

    const caps = v.captures;
    E.redLost.textContent = String(caps.filter((c) => c.revealed && c.side === 'RED').length);
    E.blackLost.textContent = String(caps.filter((c) => c.revealed && c.side === 'BLACK').length);

    fillTray(E.redTray, caps.filter((c) => c.side === 'RED'), '—');
    fillTray(E.blackTray, caps.filter((c) => c.side === 'BLACK'), '—');

    E.modeText.textContent = S.aiSide
      ? `人机 · ${S.settings.difficulty === 'easy' ? '入门' : S.settings.difficulty === 'hard' ? '高手' : '进阶'} · 你执${S.humanSide === 'RED' ? '红' : '黑'} · AI ${S.settings.honesty === 'oracle' ? '会偷看' : '不偷看'}`
      : '同屏双人' + (S.game.config.shuffle.balance !== 'none' ? ' · 平衡 ' + S.game.config.shuffle.balance : '');
    E.seedText.textContent = 'seed ' + S.game.seed;
    E.countText.textContent = `${v.ply} 半手`;

    renderLog();
    renderCapture();
  }

  function captureItems(v) {
    const byId = new Map(v.pieces.map((p) => [p.id, p]));
    const items = [];
    for (const ev of v.history) {
      if (!ev.captured) continue;
      const cap = ev.captured;
      const mover = byId.get(ev.moverId);
      const atkKind = (mover && mover.kind) || (ev.revealed && ev.revealed.kind) || null;
      const check = ev.check && ev.check[ev.side === 'RED' ? 'BLACK' : 'RED'];
      items.push({
        ply: ev.ply,
        side: ev.side,
        atkKind,
        cap,
        wasHidden: !cap.wasFaceUp,
        ff: !!cap.friendlyFire,
        check: !!check,
        notation: `${BX.coord(ev.from)}→${BX.coord(ev.to)}`,
      });
    }
    return items.reverse();
  }

  function captureSentence(it) {
    const atk = it.atkKind ? `${SIDE_NAME[it.side]}${NAMES[it.side][it.atkKind]}` : `${SIDE_NAME[it.side]}暗子`;
    const victim = it.cap.revealed
      ? `${SIDE_NAME[it.cap.side]}${NAMES[it.cap.side][it.cap.kind]}`
      : '一枚暗子';
    return `第 ${it.ply} 手，${atk}吃掉${victim}${it.wasHidden ? '（原为暗子）' : ''}${it.ff ? '，误伤' : ''}${it.check ? '，将军' : ''}`;
  }

  function capturePart(it) {
    const frag = document.createDocumentFragment();
    const atk = document.createElement('span');
    atk.className = 'capture-piece ' + (it.side === 'RED' ? 'red' : 'black') + (it.atkKind ? '' : ' hidden');
    atk.textContent = it.atkKind ? NAMES[it.side][it.atkKind] : '暗子';
    const arrow = document.createElement('span');
    arrow.className = 'capture-arrow';
    arrow.textContent = '⚔';
    const victim = document.createElement('span');
    victim.className = 'capture-piece ' + (it.cap.revealed ? (it.cap.side === 'RED' ? 'red' : 'black') : 'hidden');
    victim.textContent = it.cap.revealed ? NAMES[it.cap.side][it.cap.kind] : '暗子';
    frag.append(atk, arrow, victim);
    if (it.wasHidden) frag.appendChild(tagEl('·暗', 'capture-hidden-tag'));
    if (it.ff) frag.appendChild(tagEl('⚠误伤', 'capture-tag capture-ff-tag'));
    if (it.check) frag.appendChild(tagEl('将军', 'capture-tag capture-check-tag'));
    return frag;
  }

  function tagEl(text, cls) {
    const s = document.createElement('span');
    s.className = cls || 'capture-tag';
    s.textContent = text;
    return s;
  }

  function captureVictimCoin(cap) {
    const el = document.createElement('span');
    const revealed = !!cap.revealed && !!cap.kind && !!cap.side;
    el.className = 'capture-piece ' + (revealed ? (cap.side === 'RED' ? 'red' : 'black') : 'hidden');
    el.textContent = revealed ? NAMES[cap.side][cap.kind] : '暗子';
    el.setAttribute('aria-hidden', 'true');
    return el;
  }

  function captureGroup(side, items, isNew) {
    const group = document.createElement('div');
    group.className = 'capture-group' + (side === 'RED' ? ' red' : ' black') + (isNew ? ' new' : '');
    const head = document.createElement('div');
    head.className = 'capture-group-head';
    const title = document.createElement('span');
    title.textContent = side === 'RED' ? '红方吃子' : '黑方吃子';
    const count = document.createElement('span');
    count.className = 'capture-group-count';
    count.textContent = String(items.length);
    head.append(title, count);
    const coins = document.createElement('div');
    coins.className = 'capture-coins';
    for (const it of items) coins.appendChild(captureVictimCoin(it.cap));
    group.append(head, coins);
    return group;
  }

  function renderCapture() {
    if (!E.captureFeed || !E.captureStrip || !S.view) return;
    const all = captureItems(S.view);
    const items = all.slice(0, 40);
    const latest = items.length ? items[0] : null;
    const isNew = latest && latest.ply !== S.capturePly;
    if (isNew) {
      S.capturePly = latest.ply;
      if (S.captureLive) {
        S.captureLive.textContent = '';
        setTimeout(() => { S.captureLive.textContent = captureSentence(latest); }, 30);
      }
    }

    E.captureFeed.textContent = '';
    E.captureStrip.textContent = '';
    if (!items.length) {
      const d = document.createElement('div');
      d.className = 'capture-empty';
      d.textContent = '尚无吃子';
      E.captureFeed.appendChild(d);
      const s = document.createElement('span');
      s.className = 'capture-empty';
      s.textContent = '尚无吃子';
      E.captureStrip.appendChild(s);
      return;
    }

    const groups = { RED: [], BLACK: [] };
    for (const it of items) groups[it.side].push(it);
    for (const side of ['RED', 'BLACK']) {
      if (groups[side].length) E.captureFeed.appendChild(captureGroup(side, groups[side], isNew));
    }
    for (const side of ['RED', 'BLACK']) {
      if (!groups[side].length) continue;
      const strip = document.createElement('div');
      strip.className = 'capture-strip-group';
      const label = document.createElement('span');
      label.className = 'capture-group-label';
      label.textContent = side === 'RED' ? '红吃' : '黑吃';
      strip.appendChild(label);
      for (const it of groups[side]) strip.appendChild(captureVictimCoin(it.cap));
      E.captureStrip.appendChild(strip);
    }
    if (isNew) {
      setTimeout(() => {
        E.captureFeed.querySelectorAll('.capture-group.new').forEach((el) => el.classList.remove('new'));
      }, 2000);
    }
  }

  function fillTray(container, caps, emptyText) {
    container.textContent = '';
    if (!caps.length) {
      const s = document.createElement('span');
      s.className = 'tray-empty';
      s.textContent = emptyText;
      container.appendChild(s);
      return;
    }
    for (const c of caps) {
      const chip = document.createElement('span');
      chip.className = 'chip captured' + (c.revealed && c.side === 'BLACK' ? ' black' : '') + (c.revealed ? '' : ' hidden-chip');
      chip.textContent = c.revealed ? NAMES[c.side][c.kind] : '?';
      chip.title = c.revealed
        ? `${SIDE_NAME[c.side]}${NAMES[c.side][c.kind]}${c.wasFaceUp ? '' : '（暗子被吃）'}${c.friendlyFire ? ' · 误伤' : ''}`
        : '未知（被吃时未揭示）';
      if (c.friendlyFire) {
        const dot = document.createElement('span');
        dot.className = 'ff-dot';
        chip.appendChild(dot);
      }
      container.appendChild(chip);
    }
  }

  function renderLog() {
    const v = S.view;
    const nearBottom = E.logList.scrollHeight - E.logList.scrollTop - E.logList.clientHeight < 40;
    E.logList.textContent = '';
    if (!v.history.length) {
      const empty = document.createElement('div');
      empty.className = 'log-empty';
      empty.textContent = '尚无着法。点击红方半场的暗子开始。';
      E.logList.appendChild(empty);
      return;
    }
    const last = v.history[v.history.length - 1];
    for (const ev of v.history) {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'log-item';
      item.dataset.ply = String(ev.ply);
      if (S.replayPly === ev.ply) item.classList.add('active');

      const ply = document.createElement('span');
      ply.className = 'ply';
      ply.textContent = String(ev.ply);

      const body = document.createElement('span');
      body.className = 'body';
      const who = document.createElement('span');
      who.className = 'who ' + (ev.side === 'RED' ? 'red' : 'black');
      who.textContent = SIDE_CHAR[ev.side];
      const coord = document.createElement('span');
      coord.className = 'coord';
      coord.textContent = `${BX.coord(ev.from)}→${BX.coord(ev.to)}`;
      body.append(who, coord);

      if (ev.revealed) {
        body.appendChild(tag(`翻${SIDE_CHAR[ev.revealed.side]}${NAMES[ev.revealed.side][ev.revealed.kind]}`, 'flip'));
      }
      if (ev.captured) {
        const cc = ev.captured;
        const text = cc.revealed
          ? `吃${SIDE_CHAR[cc.side]}${NAMES[cc.side][cc.kind]}${cc.wasFaceUp ? '' : '·暗'}`
          : '吃暗子';
        body.appendChild(tag(text, 'capture'));
        if (cc.friendlyFire) body.appendChild(tag('误伤', 'ff'));
      }
      if (ev.check && ev.check[ev.side === 'RED' ? 'BLACK' : 'RED']) {
        const mate = ev === last && v.status !== 'PLAYING' && v.drawReason === 'CHECKMATE';
        body.appendChild(tag(mate ? '将死' : '将军', mate ? 'mate' : 'check'));
      }
      item.append(ply, body);
      item.addEventListener('click', () => enterReplay(ev.ply));
      E.logList.appendChild(item);
    }
    if (nearBottom || S.replayPly === null) E.logList.scrollTop = E.logList.scrollHeight;
  }

  function tag(text, cls) {
    const s = document.createElement('span');
    s.className = 'tag ' + (cls || '');
    s.textContent = text;
    return s;
  }

  function renderButtons() {
    const v = S.view;
    const over = v.status !== 'PLAYING';
    const humanTurn = !S.aiSide || v.turn === S.humanSide;
    E.undoBtn.hidden = !S.game.config.undo;
    E.undoBtn.disabled = over || v.ply === 0 || S.aiThinking;
    E.resignBtn.disabled = over;
    E.drawBtn.disabled = over || S.aiThinking;
    E.markBtn.classList.toggle('toggle-on', S.marking);
    E.markBtn.setAttribute('aria-pressed', S.marking ? 'true' : 'false');
    E.soundBtn.setAttribute('aria-pressed', S.settings.sound ? 'true' : 'false');
    E.soundBtn.classList.toggle('toggle-on', S.settings.sound);
    E.soundBtn.textContent = S.settings.sound ? '音效 开' : '音效 关';
    E.hintBtn.textContent = `提示 ${S.hintsLeft}`;
    E.hintBtn.disabled = over || !humanTurn || S.aiThinking || !S.aiSide || S.hintsLeft <= 0;
    E.hintBtn.classList.toggle('toggle-on', !!S.hintMove);
    E.modeSelect.value = S.aiSide ? 'pve' : 'hotseat';
    E.difficultySelect.value = S.settings.difficulty;
    E.difficultySelect.disabled = !S.aiSide || S.aiThinking;
    E.modeSelect.disabled = S.aiThinking;
  }

  function renderA11y() {
    const v = activeView();
    const legalTargets = new Set();
    if (S.selectedId !== null && S.replayPly === null) {
      S.legalByKey.forEach((mv, key) => legalTargets.add(key));
    }
    const operable = new Set(v.operableIds || []);
    for (let rank = 1; rank <= 10; rank++) {
      for (let file = 1; file <= 9; file++) {
        const btn = S.cells.get(file + ',' + rank);
        if (!btn) continue;
        const p = v.pieces.find((q) => q.file === file && q.rank === rank);
        let label = `第${rank}行第${file}列，`;
        if (!p) label += '空';
        else if (p.faceUp) label += `${SIDE_NAME[p.side]}${NAMES[p.side][p.kind]}${p.isGeneral ? '，将帅' : ''}`;
        else {
          const os = ORIGIN_SIDE({ rank });
          const ok = ORIGIN_KIND[rank][file];
          label += `未翻面棋子，本格原为${ok ? SIDE_NAME[os] + NAMES[os][ok] : '空位'}`;
        }
        if (p && operable.has(p.id)) label += '，可操作';
        if (legalTargets.has(file + ',' + rank)) label += '，可落子';
        btn.setAttribute('aria-label', label);
      }
    }
  }

  function updateHint() {
    const v = S.view;
    let text = '';
    if (S.replayPly !== null) {
      text = `回放中 · 第 ${S.replayPly} 手`;
    } else if (v.status !== 'PLAYING') {
      text = `<b>${BX.resultText(v.status, v.drawReason)}</b>`;
    } else if (S.aiThinking) {
      text = '<b>AI 思考中…</b> 棋盘输入已锁定';
    } else if (S.aiSide === v.turn) {
      text = '等待 AI 落子…';
    } else if (S.hintMove) {
      text = `提示：<b>${BX.coord(S.hintMove.from)} → ${BX.coord(S.hintMove.to)}</b> · 剩余 ${S.hintsLeft} 次`;
    } else if (v.inCheck[v.turn]) {
      text = `<span class="warn">${SIDE_NAME[v.turn]}被将军</span>，本回合必须应将`;
    } else if (S.selectedId !== null) {
      const p = v.pieces.find((q) => q.id === S.selectedId);
      if (p) {
        const n = S.legalByKey.size;
        let desc;
        if (p.faceUp) desc = `<b>${SIDE_NAME[p.side]}${NAMES[p.side][p.kind]}</b>`;
        else {
          const os = ORIGIN_SIDE({ rank: p.rank });
          const ok = ORIGIN_KIND[p.rank][p.file];
          desc = `暗子 · 本格原为 <b>${ok ? SIDE_NAME[os] + NAMES[os][ok] : '空位'}</b>`;
        }
        text = `${desc} · ${n ? n + ' 个落点' : '<span class="warn">此处无路可走</span>'}`;
      }
    } else if (S.marking) {
      text = '标记模式：点击暗子循环标记（右键也可），标记只存在本地';
    } else {
      const n = (v.operableIds || []).length;
      text = `点击${SIDE_NAME[v.turn]}可操作的棋子（${n} 枚）· 暗子按所在位置的原兵种行走`;
    }
    E.hintbar.innerHTML = text;
  }

  /* =====================================================================
   * 交互
   * ===================================================================== */
  function canOperateLocal(p) {
    return S.view.operableIds.includes(p.id);
  }
  function pieceBySquare(file, rank) {
    const v = activeView();
    return v.pieces.find((p) => p.file === file && p.rank === rank) || null;
  }
  function pieceByIdLocal(id) {
    return S.view.pieces.find((p) => p.id === id) || null;
  }

  function onCellClick(sq) {
    if (E.resultDialog.open || E.newDialog.open || E.rulesDialog.open) return;
    if (S.replayPly !== null) return;
    if (S.anim || S.busy || S.aiThinking) return;
    if (S.view.status !== 'PLAYING') return;

    const p = pieceBySquare(sq.file, sq.rank);

    if (S.marking) {
      if (p && !p.faceUp) { cycleMark(p.id); requestDraw(); return; }
      if (p) toast('只有未翻面的暗子可以标记');
      return;
    }

    if (S.aiSide === S.view.turn) { toast('等待 AI 落子'); return; }

    if (S.selectedId !== null) {
      const sel = pieceByIdLocal(S.selectedId);
      if (!sel) { deselect(); return; }
      if (sel.file === sq.file && sel.rank === sq.rank) { deselect(); return; }
      if (S.legalByKey.has(sqKey(sq))) { attemptMove(sel, sq); return; }
      if (p && canOperateLocal(p)) { selectPiece(p); return; }
      if (p) reject(p.faceUp ? '这不是你的棋子' : '这枚暗子的表观归属不是本回合方');
      else reject('该棋子不能走到这里');
      return;
    }

    if (!p) return;
    if (!canOperateLocal(p)) {
      reject(p.faceUp ? '这不是你的棋子' : '这枚暗子表观属于对方半场，本回合不能操作');
      return;
    }
    selectPiece(p);
  }

  function selectPiece(p) {
    S.selectedId = p.id;
    S.legalByKey.clear();
    const moves = (S.view.movesById || {})[p.id] || [];
    for (const mv of moves) S.legalByKey.set(sqKey(mv.to), mv);
    Sound.play('select');
    if (!moves.length) toast('该子在此处无路可走');
    updateHint();
    renderA11y();
    requestDraw();
    const label2 = p.faceUp
      ? `${SIDE_NAME[p.side]}${NAMES[p.side][p.kind]}`
      : (() => {
          const os = ORIGIN_SIDE({ rank: p.rank });
          const ok = ORIGIN_KIND[p.rank][p.file];
          return `暗子（本格原为${ok ? SIDE_NAME[os] + NAMES[os][ok] : '空位'}）`;
        })();
    S.announce(`${label2}，${moves.length} 个合法落点`);
  }

  function deselect() {
    S.selectedId = null;
    S.legalByKey.clear();
    updateHint();
    renderA11y();
    requestDraw();
  }

  function attemptMove(sel, to) {
    // §11.4 / D11：攻击暗子不做任何弹窗，点击即落子
    commitMove(SQ(sel.file, sel.rank), SQ(to.file, to.rank));
  }

  function closeDialog(dlg) {
    if (dlg && dlg.open) dlg.close();
  }

  function commitMove(from, to, opts) {
    if (S.anim) return false;
    const res = S.game.move(from, to);
    if (!res.ok) {
      reject(messageFor(res.code));
      return false;
    }
    S.selectedId = null;
    S.legalByKey.clear();
    S.hintMove = null;

    S.view = S.game.uiState();
    S.snapshots[S.game.ply] = S.view;
    // 只把公开事件交给渲染层：暗子的 kind/side 不会进入这条路径
    const ev = S.view.history[S.view.history.length - 1];

    if (ev.revealed) S.marks.delete(ev.moverId);
    if (ev.captured) S.marks.delete(ev.captured.id);

    startAnimation(ev);
    refresh();
    if (S.view.status === 'PLAYING') saveGame();
    else clearSave();

    const side = ev.side;
    const opp = side === 'RED' ? 'BLACK' : 'RED';
    const moveMs = VIS.TIMINGS.move;
    setTimeout(() => Sound.play('land'), moveMs - VIS.TIMINGS.land);
    setTimeout(() => {
      if (ev.captured) Sound.play('capture');
    }, moveMs - VIS.TIMINGS.land);
    if (ev.revealed) setTimeout(() => Sound.play('flip'), moveMs);
    if (ev.check[opp]) setTimeout(() => Sound.play('check'), moveMs + 340);
    if (ev.captured && ev.captured.friendlyFire && ev.captured.kind) {
      const who = S.aiSide && ev.side === S.aiSide ? 'AI ' : '';
      setTimeout(() => toast(`${who}误伤！这是己方的${NAMES[ev.captured.side][ev.captured.kind]}`), moveMs + 80);
    }

    afterMove(ev);
    return true;
  }

  function afterMove(ev) {
    const v = S.view;
    const animMs = animDuration(S.anim) || (VIS.TIMINGS.move + (ev.revealed ? VIS.TIMINGS.flip : 0));
    if (v.status !== 'PLAYING') {
      clearSave();
      S.endTime = Date.now();
      Sound.play('end');
      clearTimeout(S.resultTimer);
      S.resultTimer = setTimeout(() => {
        if (S.view.status === 'PLAYING') return;
        S.anim = null;
        showResult();
      }, animMs + 360);
      return;
    }
    S.busy = false;
    clearTimeout(S.aiTimer);
    // 用真实动画时长（被动揭示会多 320+160ms），避免 AI 在动画尚未结束时被跳过
    S.aiTimer = setTimeout(maybeAI, animMs + 140);
  }

  function maybeAI() {
    if (!S.aiSide || !S.game) return;
    if (S.view.status !== 'PLAYING' || S.view.turn !== S.aiSide) return;
    if (S.replayPly !== null) return;
    if (S.anim) {
      // rAF 可能被后台标签页节流；这里主动重试，而不是永久跳过 AI 回合
      clearTimeout(S.aiTimer);
      S.aiTimer = setTimeout(maybeAI, 250);
      return;
    }
    if (E.resultDialog.open || E.newDialog.open || E.rulesDialog.open) return;
    if (S.aiThinking) return;
    S.aiThinking = true;
    renderTop();
    renderButtons();
    updateHint();

    S.aiTimer = setTimeout(() => {
      if (!S.game || S.view.turn !== S.aiSide || S.view.status !== 'PLAYING') {
        S.aiThinking = false;
        renderTop(); renderButtons(); updateHint();
        return;
      }
      if (S.replayPly !== null || S.anim) {
        S.aiThinking = false;
        renderTop(); renderButtons(); updateHint();
        S.aiTimer = setTimeout(maybeAI, 350);
        return;
      }
      if (E.rulesDialog.open || E.newDialog.open) {
        S.aiThinking = false;
        renderTop(); renderButtons(); updateHint();
        S.aiTimer = setTimeout(maybeAI, 300);
        return;
      }
      const t0 = (performance && performance.now) ? performance.now() : Date.now();
      let move = null;
      try {
        move = AI.chooseMove(S.game, {
          difficulty: S.settings.difficulty,
          honesty: S.settings.honesty,
        });
      } catch (err) {
        if (window.console && console.warn) console.warn('AI search failed, fallback', err);
      }
      const elapsed = ((performance && performance.now) ? performance.now() : Date.now()) - t0;
      S.lastAI = AI.last;
      if (!move) move = randomLegalMove();
      const delayCfg = (S.game.config.ai && S.game.config.ai.fakeDelayMs) || [200, 600];
      const lo = Number(delayCfg[0]) || 200;
      const hi = Number(delayCfg[1]) || 600;
      const jitter = Math.random() * 160 - 80;
      const total = clamp(Math.min(hi, lo + elapsed) + jitter, lo, hi + 80);
      const remain = Math.max(0, total - elapsed);
      S.aiTimer = setTimeout(() => {
        if (!S.game || S.view.turn !== S.aiSide || S.view.status !== 'PLAYING') {
          S.aiThinking = false;
          renderTop(); renderButtons(); updateHint();
          return;
        }
        if (S.replayPly !== null || S.anim) {
          // 动画还没结束：重试，不要丢掉这一步
          S.aiThinking = false;
          renderTop(); renderButtons(); updateHint();
          S.aiTimer = setTimeout(maybeAI, 250);
          return;
        }
        S.aiThinking = false;
        renderTop(); renderButtons();
        if (!move) { updateHint(); return; }
        const ok = commitMove(move.from, move.to, { byAI: true });
        if (!ok) {
          S.aiThinking = false;
          renderTop(); renderButtons(); updateHint();
          S.aiTimer = setTimeout(maybeAI, 250);
        }
      }, remain);
    }, 30);
  }

  function randomLegalMove() {
    const v = S.view;
    const ids = Object.keys(v.movesById || {}).filter((id) => v.movesById[id].length);
    if (!ids.length) return null;
    const id = Number(ids[Math.floor(Math.random() * ids.length)]);
    const p = v.pieces.find((x) => x.id === id);
    const list = v.movesById[id];
    const mv = list[Math.floor(Math.random() * list.length)];
    return { from: SQ(p.file, p.rank), to: SQ(mv.to.file, mv.to.rank) };
  }

  function messageFor(code) {
    const messages = {
      NO_PIECE: '这里没有棋子',
      NOT_YOUR_PIECE: '这不是本回合能操作的棋子',
      OUT_OF_BOARD: '目标在棋盘之外',
      SAME_SQUARE: '原地不动不算走子',
      GENERAL_SHIELD: '将帅不可被直接吃掉',
      GEOMETRY: '该棋子不能走到这里',
      OWN_PIECE: '不能攻击己方棋子',
      APPARENT_ALLY: '暗子不会攻击它以为的友军',
      SEND_CHECK: '该着法会使己方将帅被将军',
      FACE_TO_FACE: '该着法会使双方将帅照面',
      GAME_OVER: '对局已经结束',
    };
    return messages[code] || '该着法不合法';
  }

  function reject(message) {
    toast(message);
    Sound.play('illegal');
    S.announce(message);
    E.frame.classList.remove('shake');
    void E.frame.offsetWidth;
    E.frame.classList.add('shake');
  }

  function toast(text) {
    E.toast.textContent = text;
    E.toast.classList.add('show');
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => E.toast.classList.remove('show'), 2200);
  }

  function cycleMark(id) {
    const keys = [null, '?', '我', '敌', '1', '2', '3'];
    const cur = S.marks.get(id) || null;
    const next = keys[(keys.indexOf(cur) + 1) % keys.length];
    if (next) S.marks.set(id, next);
    else S.marks.delete(id);
    if (next) toast(`已标记「${next}」`);
    else toast('已清除标记');
  }

  /* =====================================================================
   * 动画
   * ===================================================================== */
  function startAnimation(ev) {
    const now = performance.now();
    const reduced = VIS.prefersReducedMotion();
    S.anim = {
      start: now,
      from: ev.from,
      to: ev.to,
      moverId: ev.moverId,
      wasFaceUp: ev.moverWasFaceUp,
      revealed: ev.revealed || null,
      captured: ev.captured || null,
      check: ev.check || null,
      reduced,
      flipDur: reduced ? VIS.TIMINGS.reducedFlip : VIS.TIMINGS.flip,
    };
    const lines = [];
    if (ev.captured) {
      lines.push(
        ev.captured.revealed
          ? `吃 ${SIDE_CHAR[ev.captured.side]}${NAMES[ev.captured.side][ev.captured.kind]}${ev.captured.friendlyFire ? ' · 误伤' : ''}`
          : '吃 暗子'
      );
    }
    if (ev.revealed) lines.push(`翻出 ${SIDE_CHAR[ev.revealed.side]}${NAMES[ev.revealed.side][ev.revealed.kind]}`);
    const cardStart = now + VIS.TIMINGS.move + (ev.revealed ? S.anim.flipDur : 0) + 80;
    S.card = lines.length
      ? { start: cardStart, x: X(ev.to.file), y: Y(ev.to.rank), lines, dur: VIS.TIMINGS.card }
      : null;
    requestDraw();
  }

  function animDuration(a) {
    if (!a) return 0;
    const flip = a.revealed ? a.flipDur : 0;
    const capturedExtra = a.captured && !a.captured.wasFaceUp && a.captured.revealed
      ? VIS.TIMINGS.flip + 160
      : VIS.TIMINGS.capture;
    return VIS.TIMINGS.move + Math.max(flip, capturedExtra) + 20;
  }

  /* =====================================================================
   * 绘制
   * ===================================================================== */
  function requestDraw() {
    if (!S.game || !ctx) return;
    if (S.frameHandle) return;
    S.frameHandle = requestAnimationFrame(frame);
  }

  function frame(now) {
    S.frameHandle = 0;
    draw(now);
    const v = activeView();
    const pulsing = v && (v.inCheck.RED || v.inCheck.BLACK);
    if (S.anim || S.card || pulsing) requestDraw();
  }

  function draw(now) {
    if (!S.game || !ctx) return;
    const { w, h } = S.M;
    ctx.clearRect(0, 0, w, h);
    if (S.anim && now - S.anim.start > animDuration(S.anim) + 40) S.anim = null;
    drawFrame();
    drawRiverBand();
    drawGrid();
    drawCoords();
    drawRiver();

    const v = activeView();
    drawCheckGlow(v, now);
    drawLastMove(v);
    drawPieces(v, now);
    if (S.replayPly === null) drawHints(v);
    drawAnim(now);
    drawCheckRing(v, now);
    drawHover();
    drawFocus();
    drawCard(now);
  }

  function roundRect(x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }

  function drawFrame() {
    const { w, h, cell, margin } = S.M;
    const outer = ctx.createLinearGradient(0, 0, w, h);
    outer.addColorStop(0, '#33251b');
    outer.addColorStop(0.5, '#241a14');
    outer.addColorStop(1, '#1a120e');
    roundRect(0.5, 0.5, w - 1, h - 1, 16);
    ctx.fillStyle = outer;
    ctx.fill();
    ctx.strokeStyle = 'rgba(201,168,106,0.22)';
    ctx.lineWidth = 1;
    ctx.stroke();

    const inset = 9;
    const wood = ctx.createLinearGradient(0, inset, 0, h - inset);
    wood.addColorStop(0, '#f0ddbd');
    wood.addColorStop(0.45, '#e8d2ae');
    wood.addColorStop(0.75, '#e2c9a1');
    wood.addColorStop(1, '#d8bd93');
    roundRect(inset, inset, w - inset * 2, h - inset * 2, 9);
    ctx.fillStyle = wood;
    ctx.fill();

    // 木纹
    ctx.save();
    roundRect(inset, inset, w - inset * 2, h - inset * 2, 9);
    ctx.clip();
    for (const g of S.grain) {
      ctx.beginPath();
      const baseY = inset + g.y * (h - inset * 2);
      for (let px = inset; px <= w - inset; px += 8) {
        const yy = baseY + Math.sin(px * 0.011 * g.freq + g.phase) * g.amp;
        if (px === inset) ctx.moveTo(px, yy);
        else ctx.lineTo(px, yy);
      }
      ctx.strokeStyle = `rgba(104,66,30,${g.alpha})`;
      ctx.lineWidth = g.width;
      ctx.stroke();
    }
    // 边缘暗角
    const vign = ctx.createRadialGradient(w / 2, h / 2, cell * 2.2, w / 2, h / 2, Math.max(w, h) * 0.78);
    vign.addColorStop(0, 'rgba(90,55,20,0)');
    vign.addColorStop(1, 'rgba(74,44,16,0.22)');
    ctx.fillStyle = vign;
    ctx.fillRect(inset, inset, w - inset * 2, h - inset * 2);
    ctx.restore();

    // 内框双线
    const x1 = margin;
    const y1 = margin;
    const x2 = w - margin;
    const y2 = h - margin;
    ctx.strokeStyle = 'rgba(105,72,38,0.55)';
    ctx.lineWidth = 1.2;
    ctx.strokeRect(x1 - 6, y1 - 6, x2 - x1 + 12, y2 - y1 + 12);
    ctx.strokeStyle = 'rgba(105,72,38,0.32)';
    ctx.lineWidth = 1;
    ctx.strokeRect(x1 - 3, y1 - 3, x2 - x1 + 6, y2 - y1 + 6);
  }

  function drawRiverBand() {
    const top = Y(6);
    const bottom = Y(5);
    const band = ctx.createLinearGradient(0, top, 0, bottom);
    band.addColorStop(0, 'rgba(150,110,62,0)');
    band.addColorStop(0.5, 'rgba(150,110,62,0.05)');
    band.addColorStop(1, 'rgba(150,110,62,0)');
    ctx.fillStyle = band;
    ctx.fillRect(X(1), top, X(9) - X(1), bottom - top);
  }

  function drawGrid() {
    const { cell } = S.M;
    const x1 = X(1), x9 = X(9), y10 = Y(10), y1 = Y(1);
    const line = 'rgba(122,89,52,0.78)';
    ctx.strokeStyle = line;
    ctx.lineWidth = Math.max(1, cell * 0.018);
    ctx.beginPath();
    for (let r = 1; r <= 10; r++) {
      ctx.moveTo(x1, Y(r));
      ctx.lineTo(x9, Y(r));
    }
    for (let f = 1; f <= 9; f++) {
      if (f === 1 || f === 9) {
        ctx.moveTo(X(f), y10);
        ctx.lineTo(X(f), y1);
      } else {
        ctx.moveTo(X(f), y10);
        ctx.lineTo(X(f), Y(6));
        ctx.moveTo(X(f), Y(5));
        ctx.lineTo(X(f), y1);
      }
    }
    ctx.stroke();

    // 九宫
    ctx.strokeStyle = 'rgba(122,89,52,0.62)';
    ctx.lineWidth = Math.max(1, cell * 0.016);
    for (const rankBase of [1, 8]) {
      ctx.beginPath();
      ctx.moveTo(X(4), Y(rankBase));
      ctx.lineTo(X(6), Y(rankBase + 2));
      ctx.moveTo(X(6), Y(rankBase));
      ctx.lineTo(X(4), Y(rankBase + 2));
      ctx.stroke();
    }

    // 炮位 / 兵位标记
    ctx.strokeStyle = 'rgba(122,89,52,0.55)';
    ctx.lineWidth = Math.max(1, cell * 0.014);
    const points = [];
    for (const r of [3, 8]) for (const f of [2, 8]) points.push([f, r]);
    for (const r of [4, 7]) for (const f of [1, 3, 5, 7, 9]) points.push([f, r]);
    const d = cell * 0.11;
    const len = cell * 0.09;
    for (const [f, r] of points) {
      const cx = X(f);
      const cy = Y(r);
      ctx.beginPath();
      if (f !== 1) {
        ctx.moveTo(cx - d, cy - d); ctx.lineTo(cx - d - len, cy - d);
        ctx.moveTo(cx - d, cy + d); ctx.lineTo(cx - d - len, cy + d);
      }
      if (f !== 9) {
        ctx.moveTo(cx + d, cy - d); ctx.lineTo(cx + d + len, cy - d);
        ctx.moveTo(cx + d, cy + d); ctx.lineTo(cx + d + len, cy + d);
      }
      if (r !== 1) {
        ctx.moveTo(cx - d, cy + d); ctx.lineTo(cx - d, cy + d + len);
        ctx.moveTo(cx + d, cy + d); ctx.lineTo(cx + d, cy + d + len);
      }
      if (r !== 10) {
        ctx.moveTo(cx - d, cy - d); ctx.lineTo(cx - d, cy - d - len);
        ctx.moveTo(cx + d, cy - d); ctx.lineTo(cx + d, cy - d - len);
      }
      ctx.stroke();
    }
  }

  function drawCoords() {
    const { cell, margin } = S.M;
    const size = Math.max(9, cell * 0.2);
    const off = cell * 0.62;
    ctx.font = `${size}px ${UI_FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(96,66,36,0.78)';
    for (let f = 1; f <= 9; f++) {
      const x = X(f);
      ctx.fillText(String(f), x, Y(1) + off);
      ctx.fillText(String(f), x, Y(10) - off);
    }
    ctx.fillStyle = 'rgba(96,66,36,0.58)';
    for (let r = 1; r <= 10; r++) {
      const y = Y(r);
      ctx.fillText(String(r), X(1) - off, y);
      ctx.fillText(String(r), X(9) + off, y);
    }
  }

  function drawRiver() {
    const { cell } = S.M;
    const midY = (Y(5) + Y(6)) / 2 + cell * 0.02;
    const size = cell * 0.42;
    ctx.font = `${size}px ${SERIF}`;
    ctx.fillStyle = 'rgba(112,76,42,0.4)';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const gap = size * 0.95;
    const drawPair = (chars, cx) => {
      chars.forEach((ch, i) => ctx.fillText(ch, cx + (i - (chars.length - 1) / 2) * gap, midY));
    };
    const left = X(1) + (X(9) - X(1)) * 0.24;
    const right = X(1) + (X(9) - X(1)) * 0.76;
    drawPair(['楚', '河'], left);
    drawPair(['漢', '界'], right);
  }

  function drawLastMove(v) {
    if (!v || !v.lastMove) return;
    const { cell } = S.M;
    for (const s of [v.lastMove.from, v.lastMove.to]) {
      ctx.beginPath();
      ctx.arc(X(s.file), Y(s.rank), cell * 0.47, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(230,201,143,0.07)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(230,201,143,0.38)';
      ctx.lineWidth = 1.4;
      ctx.stroke();
    }
  }

  function drawPieces(v, now) {
    if (!v) return;
    const animId = S.anim ? S.anim.moverId : null;
    const operable = new Set(v.operableIds || []);
    const breath = 0.02 + 0.02 * (0.5 + 0.5 * Math.sin(now / 1500)); // 3s 周期，≤4%
    for (const p of v.pieces) {
      if (p.id === animId) continue;
      const x = X(p.file);
      const y = Y(p.rank);
      const selected = p.id === S.selectedId;
      const hovered = S.hover && S.hover.file === p.file && S.hover.rank === p.rank;
      const lift = selected ? -4 : hovered ? -2 : 0;
      const moves = v.movesById ? v.movesById[p.id] : null;
      drawPiece(p, x, y, lift, {
        selected,
        operable: operable.has(p.id),
        breathing: operable.has(p.id) ? breath : 0,
        noMoves: operable.has(p.id) && !!moves && moves.length === 0,
        mark: S.marks.get(p.id) || null,
      });
    }
  }

  function cellOf() { return S.M.cell; }

  function drawPiece(p, x, y, lift, opts) {
    const o = opts || {};
    const size = cellOf();
    const cy = y + lift;
    ctx.save();
    drawPieceVisual(p.faceUp ? 'front' : 'back', p, x, cy, size, {});

    // 无着法：灰度 40% 观感（用灰色罩层近似）+ 右下角小叉；不改形状
    if (o.noMoves) {
      ctx.beginPath();
      ctx.arc(x, cy, size * 0.43, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(122,116,106,0.36)';
      ctx.fill();
    }

    // 可操作棋子：极轻的呼吸高光（不区分真实阵营）
    if (o.breathing) {
      ctx.beginPath();
      ctx.arc(x, cy, size * 0.43, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(255,248,236,${o.breathing})`;
      ctx.fill();
    }

    if (o.selected) {
      ctx.beginPath();
      ctx.arc(x, cy, size * 0.475, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(230,201,143,0.98)';
      ctx.lineWidth = 2.4;
      ctx.shadowColor = 'rgba(230,201,143,0.9)';
      ctx.shadowBlur = 18;
      ctx.stroke();
      ctx.shadowBlur = 0;
    }

    if (o.noMoves) {
      const cx = x + size * 0.28;
      const cyy = cy + size * 0.28;
      const d = size * 0.085;
      ctx.strokeStyle = 'rgba(220,212,198,0.9)';
      ctx.lineWidth = Math.max(1.2, size * 0.026);
      ctx.beginPath();
      ctx.moveTo(cx - d, cyy - d); ctx.lineTo(cx + d, cyy + d);
      ctx.moveTo(cx + d, cyy - d); ctx.lineTo(cx - d, cyy + d);
      ctx.stroke();
    }

    if (o.mark) drawMark(x, cy, size, o.mark);
    ctx.restore();
  }

  /**
   * 明暗共用同一几何：圆形 + 侧壁 + 顶面（§11.5.1 / D9）
   * face = 'front' | 'back'
   */
  function drawPieceVisual(face, piece, x, y, size, opts) {
    const o = opts || {};
    const g = VIS.geometry(size);
    const { D, H, R } = g;
    const shadowScale = o.shadowScale == null ? 1 : o.shadowScale;
    const shadowAlpha = o.shadowAlpha == null ? g.shadowAlpha : o.shadowAlpha;
    const isFront = face === 'front';
    const isRed = piece && piece.side === 'RED';

    // 投影（椭圆，偏移 0.18H；用径向渐变代替 filter blur，跨渲染栈更稳）
    ctx.save();
    const sy = y + H + g.shadowOffsetY + 1;
    const sgrad = ctx.createRadialGradient(x, sy, R * 0.2, x, sy, R * 1.18 * shadowScale);
    sgrad.addColorStop(0, `rgba(0,0,0,${shadowAlpha})`);
    sgrad.addColorStop(0.72, `rgba(0,0,0,${shadowAlpha * 0.72})`);
    sgrad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.beginPath();
    ctx.ellipse(x, sy, R * 1.12 * shadowScale, R * 1.02 * shadowScale, 0, 0, Math.PI * 2);
    ctx.fillStyle = sgrad;
    ctx.fill();
    ctx.restore();

    // 侧壁（圆柱体的下缘）
    const sideHidden = '#3a2b21';
    const sideFront = isRed ? '#c9b596' : '#c9b9a0';
    const sideColor = isFront ? sideFront : sideHidden;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x - R, y, D, H);
    ctx.ellipse(x, y + H, R, R, 0, 0, Math.PI * 2);
    ctx.fillStyle = sideColor;
    ctx.fill();
    // 侧壁上下收边
    ctx.strokeStyle = 'rgba(0,0,0,0.26)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x - R, y + 0.5);
    ctx.lineTo(x + R, y + 0.5);
    ctx.stroke();
    // 侧壁木纹
    ctx.strokeStyle = isFront ? 'rgba(90,60,30,0.14)' : 'rgba(236,212,178,0.06)';
    ctx.beginPath();
    ctx.moveTo(x - R + 2, y + H * 0.42);
    ctx.lineTo(x + R - 2, y + H * 0.42);
    ctx.moveTo(x - R + 3, y + H * 0.72);
    ctx.lineTo(x + R - 3, y + H * 0.72);
    ctx.stroke();
    ctx.beginPath();
    ctx.ellipse(x, y + H, R, R, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();

    // 顶面
    ctx.save();
    ctx.beginPath();
    ctx.ellipse(x, y, R, R, 0, 0, Math.PI * 2);
    if (isFront) {
      const grad = ctx.createRadialGradient(x - R * 0.35, y - R * 0.4, R * 0.1, x, y, R * 1.05);
      grad.addColorStop(0, '#fffdf7');
      grad.addColorStop(0.55, '#fbf1de');
      grad.addColorStop(1, '#eddcc0');
      ctx.fillStyle = grad;
    } else {
      const grad = ctx.createRadialGradient(x - R * 0.3, y - R * 0.35, R * 0.08, x, y, R * 1.05);
      grad.addColorStop(0, '#6b523d');
      grad.addColorStop(0.5, '#4a3b2f');
      grad.addColorStop(1, '#33251c');
      ctx.fillStyle = grad;
    }
    ctx.fill();
    ctx.strokeStyle = isFront ? 'rgba(132,99,62,0.85)' : 'rgba(236,212,178,0.24)';
    ctx.lineWidth = Math.max(1.1, size * 0.026);
    ctx.stroke();
    ctx.clip();

    if (isFront) drawFrontTop(piece, x, y, R, size, isRed);
    else drawHiddenTop(x, y, R, size);

    if (o.shine) {
      // 15° 白色高光横扫顶面
      const shineGrad = ctx.createLinearGradient(x - R, y - R * 0.27, x + R, y + R * 0.27);
      shineGrad.addColorStop(0, 'rgba(255,255,255,0)');
      shineGrad.addColorStop(0.48, `rgba(255,255,255,${o.shine})`);
      shineGrad.addColorStop(0.56, `rgba(255,255,255,${o.shine * 0.8})`);
      shineGrad.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = shineGrad;
      ctx.fillRect(x - R, y - R, R * 2, R * 2);
    }
    ctx.restore();
  }

  function drawFrontTop(piece, x, y, R, size, isRed) {
    // 双圈：外圈朱红/墨黑，内圈细线
    ctx.beginPath();
    ctx.arc(x, y, R * 0.82, 0, Math.PI * 2);
    ctx.strokeStyle = isRed ? 'rgba(178,58,44,0.55)' : 'rgba(31,41,51,0.55)';
    ctx.lineWidth = Math.max(1, size * 0.018);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x, y, R * 0.74, 0, Math.PI * 2);
    ctx.strokeStyle = isRed ? 'rgba(178,58,44,0.22)' : 'rgba(31,41,51,0.22)';
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.font = `600 ${size * 0.48}px ${KAITI}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = isRed ? '#b23a2c' : '#1f2933';
    ctx.fillText(NAMES[piece.side][piece.kind], x, y + size * 0.012);
  }

  function drawHiddenTop(x, y, R, size) {
    // 同心车削纹（低对比）
    ctx.strokeStyle = 'rgba(232,212,180,0.085)';
    ctx.lineWidth = Math.max(0.8, size * 0.011);
    for (const k of [0.3, 0.5, 0.7, 0.87]) {
      ctx.beginPath();
      ctx.arc(x, y, R * k, 0, Math.PI * 2);
      ctx.stroke();
    }

    // 中央浮雕纹样：四向云雷纹 + 中心菱形（禁止「?」字符）
    ctx.save();
    ctx.translate(x, y);
    const unit = R * 0.34;
    const drawCurl = (dx, dy) => {
      // 暗刻
      ctx.strokeStyle = 'rgba(16,10,7,0.5)';
      ctx.lineWidth = Math.max(1.1, size * 0.018);
      ctx.beginPath();
      ctx.arc(dx, dy, unit * 0.55, Math.PI * 0.12, Math.PI * 0.88, false);
      ctx.arc(dx, dy, unit * 0.55, Math.PI * 1.12, Math.PI * 1.88, false);
      ctx.stroke();
      // 亮刻（同形偏移，形成浮雕）
      ctx.strokeStyle = 'rgba(232,208,174,0.16)';
      ctx.lineWidth = Math.max(0.9, size * 0.014);
      ctx.beginPath();
      ctx.arc(dx, dy + 1, unit * 0.55, Math.PI * 0.12, Math.PI * 0.88, false);
      ctx.arc(dx, dy + 1, unit * 0.55, Math.PI * 1.12, Math.PI * 1.88, false);
      ctx.stroke();
    };
    drawCurl(-unit * 0.52, 0);
    drawCurl(unit * 0.52, 0);
    drawCurl(0, -unit * 0.52);
    drawCurl(0, unit * 0.52);

    // 中心菱形
    const d = R * 0.11;
    ctx.beginPath();
    ctx.moveTo(0, -d);
    ctx.lineTo(d, 0);
    ctx.lineTo(0, d);
    ctx.lineTo(-d, 0);
    ctx.closePath();
    ctx.strokeStyle = 'rgba(16,10,7,0.5)';
    ctx.lineWidth = Math.max(1, size * 0.016);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, -d + 1);
    ctx.lineTo(d, 1);
    ctx.lineTo(0, d + 1);
    ctx.lineTo(-d, 1);
    ctx.closePath();
    ctx.strokeStyle = 'rgba(232,208,174,0.14)';
    ctx.stroke();
    ctx.restore();
  }

  function drawMark(x, y, size, mark) {
    const bx = x + size * 0.28;
    const by = y - size * 0.28;
    const r = size * 0.16;
    const colors = { '?': '#e0b061', '我': '#6ea8dc', '敌': '#e2604c' };
    ctx.save();
    ctx.beginPath();
    ctx.arc(bx, by, r, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(20,15,12,0.92)';
    ctx.fill();
    ctx.strokeStyle = colors[mark] || 'rgba(200,180,150,0.65)';
    ctx.lineWidth = 1.2;
    ctx.stroke();
    ctx.fillStyle = colors[mark] || '#cfc0a8';
    ctx.font = `600 ${size * 0.19}px ${UI_FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(mark, bx, by + 0.5);
    ctx.restore();
  }

  function drawHints(v) {
    if (!v) return;
    const { cell } = S.M;
    if (S.selectedId !== null) {
      for (const mv of S.legalByKey.values()) {
        const x = X(mv.to.file);
        const y = Y(mv.to.rank);
        if (!mv.capture) {
          ctx.beginPath();
          ctx.arc(x, y, Math.max(3, cell * 0.085), 0, Math.PI * 2);
          ctx.fillStyle = 'rgba(230,201,143,0.95)';
          ctx.shadowColor = 'rgba(230,201,143,0.75)';
          ctx.shadowBlur = 8;
          ctx.fill();
          ctx.shadowBlur = 0;
        } else if (mv.capture.faceUp) {
          ctx.beginPath();
          ctx.arc(x, y, cell * 0.45, 0, Math.PI * 2);
          ctx.strokeStyle = 'rgba(239,68,68,0.95)';
          ctx.lineWidth = 2.6;
          ctx.shadowColor = 'rgba(239,68,68,0.6)';
          ctx.shadowBlur = 10;
          ctx.stroke();
          ctx.shadowBlur = 0;
        } else {
          drawHiddenTargetRing(x, y, cell, true);
        }
      }
    }
    // 提示着法：金色虚线环 + 起点/终点连线
    if (S.hintMove && S.selectedId === null) {
      const fx = X(S.hintMove.from.file), fy = Y(S.hintMove.from.rank);
      const tx = X(S.hintMove.to.file), ty = Y(S.hintMove.to.rank);
      ctx.save();
      ctx.strokeStyle = 'rgba(230,201,143,0.85)';
      ctx.lineWidth = 1.6;
      ctx.setLineDash([5, 5]);
      ctx.beginPath();
      ctx.arc(fx, fy, cell * 0.46, 0, Math.PI * 2);
      ctx.arc(tx, ty, cell * 0.46, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(fx, fy);
      ctx.lineTo(tx, ty);
      ctx.strokeStyle = 'rgba(230,201,143,0.35)';
      ctx.lineWidth = 1.2;
      ctx.stroke();
      ctx.restore();
    }
  }

  function drawHiddenTargetRing(x, y, cell, withQuestion) {
    // §11.4 / T-58：暗子落点 = 琥珀色问号环（取消弹窗后的唯一风险提示）
    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, cell * 0.46, 0, Math.PI * 2);
    ctx.strokeStyle = 'rgba(245,158,11,0.98)';
    ctx.lineWidth = 2.6;
    ctx.shadowColor = 'rgba(245,158,11,0.55)';
    ctx.shadowBlur = 8;
    ctx.stroke();
    ctx.shadowBlur = 0;
    if (withQuestion) {
      const bx = x + cell * 0.32;
      const by = y - cell * 0.32;
      ctx.beginPath();
      ctx.arc(bx, by, cell * 0.115, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(18,13,10,0.92)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(245,158,11,0.95)';
      ctx.lineWidth = 1;
      ctx.stroke();
      ctx.fillStyle = '#f5b33c';
      ctx.font = `700 ${cell * 0.17}px ${SERIF}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('?', bx, by + 0.5);
    }
    ctx.restore();
  }

  function drawCheckGlow(v, now) {
    if (!v) return;
    const sides = ['RED', 'BLACK'].filter((s) => v.inCheck[s]);
    if (!sides.length) return;
    const pulse = 0.55 + 0.45 * Math.sin(now / 600); // 1200ms 周期
    for (const side of sides) {
      const g = v.pieces.find((p) => p.isGeneral && p.side === side);
      if (!g) continue;
      const x = X(g.file);
      const y = Y(g.rank);
      const rad = S.M.cell * 1.02;
      const grad = ctx.createRadialGradient(x, y, S.M.cell * 0.18, x, y, rad);
      grad.addColorStop(0, `rgba(220,38,38,${0.5 * pulse})`);
      grad.addColorStop(0.55, `rgba(220,38,38,${0.2 * pulse})`);
      grad.addColorStop(1, 'rgba(220,38,38,0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(x, y, rad, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function drawCheckRing(v, now) {
    if (!v) return;
    const pulse = 0.5 + 0.5 * Math.sin(now / 600);
    for (const side of ['RED', 'BLACK']) {
      if (!v.inCheck[side]) continue;
      const g = v.pieces.find((p) => p.isGeneral && p.side === side);
      if (!g) continue;
      const x = X(g.file);
      const y = Y(g.rank);
      ctx.beginPath();
      ctx.arc(x, y, S.M.cell * 0.47, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(255,120,100,${0.5 + 0.4 * pulse})`;
      ctx.lineWidth = 3;
      ctx.stroke();
      for (const at of (v.checkerSquares && v.checkerSquares[side]) || []) {
        ctx.beginPath();
        ctx.arc(X(at.file), Y(at.rank), S.M.cell * 0.46, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(255,120,100,${0.32 + 0.28 * pulse})`;
        ctx.lineWidth = 1.4;
        ctx.setLineDash([3, 4]);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }
  }

  function drawHover() {
    if (!S.hover || S.anim) return;
    const { cell } = S.M;
    ctx.beginPath();
    ctx.arc(X(S.hover.file), Y(S.hover.rank), cell * 0.45, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,244,220,0.05)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,244,220,0.14)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  function drawFocus() {
    if (!S.cellFocused) return;
    const { cell } = S.M;
    roundRect(X(S.focus.file) - cell * 0.47, Y(S.focus.rank) - cell * 0.47, cell * 0.94, cell * 0.94, cell * 0.18);
    ctx.strokeStyle = 'rgba(255,246,226,0.5)';
    ctx.lineWidth = 1.6;
    ctx.setLineDash([5, 4]);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  function drawAnim(now) {
    const a = S.anim;
    if (!a) return;
    const cell = cellOf();
    const t = now - a.start;
    const tx = X(a.to.file);
    const ty = Y(a.to.rank);
    const fx = X(a.from.file);
    const fy = Y(a.from.rank);
    const pNow = S.view.pieces.find((p) => p.id === a.moverId) || null;

    if (a.captured) drawCapturedGhost(a, t, cell, tx, ty);

    if (t < VIS.TIMINGS.move) {
      const m = VIS.moveTransform(t);
      const x = lerp(fx, tx, m.travel);
      const y = lerp(fy, ty, m.travel);
      drawPieceVisual(a.wasFaceUp ? 'front' : 'back', pNow, x, y + m.lift, cell, {
        shadowScale: m.shadowScale,
        shadowAlpha: m.shadowAlpha,
      });
    } else {
      const ft = t - VIS.TIMINGS.move;
      if (a.revealed) {
        drawFlip(a, pNow, tx, ty, cell, ft);
      } else {
        drawPieceVisual(a.wasFaceUp ? 'front' : 'back', pNow, tx, ty, cell, {});
      }
    }
  }

  function drawFlip(a, pNow, x, y, cell, ft) {
    const f = VIS.flipTransform(ft, cell, { reduced: a.reduced });
    if (f.crossfade) {
      // prefers-reduced-motion：120ms 交叉淡入，保持同一枚棋子的几何
      ctx.save();
      ctx.globalAlpha = 1 - f.progress;
      drawPieceVisual('back', pNow, x, y, cell, {});
      ctx.globalAlpha = f.progress;
      drawPieceVisual('front', pNow, x, y, cell, {});
      ctx.restore();
      return;
    }
    const showFront = f.progress >= 90 / VIS.TIMINGS.flip;
    if (f.rim) {
      drawRimBar(x, y + f.lift, VIS.geometry(cell), f.scaleY, pNow && pNow.side === 'RED' ? '#c9b596' : '#c9b9a0', !showFront);
      return;
    }
    const G = VIS.geometry(cell);
    ctx.save();
    ctx.translate(x, y + G.H / 2);
    ctx.scale(1, f.scaleY);
    ctx.translate(-x, -(y + G.H / 2));
    drawPieceVisual(showFront ? 'front' : 'back', pNow, x, y + f.lift, cell, { shine: f.shine });
    ctx.restore();
  }

  function drawRimBar(x, y, g, scaleY, frontSideColor, backFace) {
    const h = Math.max(2, g.D * scaleY);
    const r = h / 2;
    roundRect(x - g.R, y - r, g.D, h, r);
    ctx.fillStyle = backFace ? '#3a2b21' : frontSideColor || '#c9b596';
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.35)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x - g.R + 1.5, y - r + 1);
    ctx.lineTo(x + g.R - 1.5, y - r + 1);
    ctx.moveTo(x - g.R + 1.5, y + r - 1);
    ctx.lineTo(x + g.R - 1.5, y + r - 1);
    ctx.strokeStyle = backFace ? 'rgba(236,212,178,0.18)' : 'rgba(90,60,30,0.28)';
    ctx.stroke();
  }

  function drawCapturedGhost(a, t, cell, tx, ty) {
    const c = a.captured;
    if (!c) return;
    const start = VIS.TIMINGS.move - VIS.TIMINGS.land;
    const ct = t - start;
    if (ct < 0) return;
    const ox = tx + cell * 0.42;
    const oy = ty - cell * 0.24;
    if (c.revealed && !c.wasFaceUp) {
      // 被动揭示：走同一套 320ms 翻面，然后淡出
      const f = VIS.flipTransform(ct, cell, { reduced: a.reduced });
      const fadeStart = a.reduced ? VIS.TIMINGS.reducedFlip : VIS.TIMINGS.flip;
      const alpha = ct <= fadeStart ? 1 : Math.max(0, 1 - (ct - fadeStart) / 160);
      if (alpha <= 0) return;
      ctx.save();
      ctx.globalAlpha = alpha;
      if (f.crossfade) {
        ctx.globalAlpha = alpha * (1 - f.progress);
        drawPieceVisual('back', c, ox, oy, cell, {});
        ctx.globalAlpha = alpha * f.progress;
        drawPieceVisual('front', c, ox, oy, cell, {});
      } else if (f.rim) {
        const showFront = f.progress >= 90 / VIS.TIMINGS.flip;
        drawRimBar(ox, oy + f.lift, VIS.geometry(cell), f.scaleY, c.side === 'RED' ? '#c9b596' : '#c9b9a0', !showFront);
      } else {
        const G = VIS.geometry(cell);
        ctx.translate(ox, oy + G.H / 2);
        ctx.scale(1, f.scaleY);
        ctx.translate(-ox, -(oy + G.H / 2));
        drawPieceVisual(f.progress >= 90 / VIS.TIMINGS.flip ? 'front' : 'back', c, ox, oy + f.lift, cell, { shine: f.shine });
      }
      ctx.restore();
    } else {
      const k = clamp(ct / VIS.TIMINGS.capture, 0, 1);
      ctx.save();
      ctx.globalAlpha = 1 - k;
      ctx.translate(ox, oy);
      const sc = 1 - 0.42 * k;
      ctx.scale(sc, sc);
      ctx.translate(-ox, -oy);
      drawPieceVisual(c.revealed ? 'front' : 'back', c, ox, oy, cell, {});
      ctx.restore();
    }
  }

  function drawCard(now) {
    const c = S.card;
    if (!c) return;
    const age = now - c.start;
    if (age < 0) return;
    if (age > c.dur) { S.card = null; return; }
    const { cell } = S.M;
    const alpha = age < 620 ? 1 : Math.max(0, 1 - (age - 620) / 380);
    const lift = Math.min(24, age * 0.05);
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.font = `600 ${Math.max(11, cell * 0.23)}px ${UI_FONT}`;
    const widths = c.lines.map((s) => ctx.measureText(s).width);
    const w = Math.max(...widths) + cell * 0.55;
    const h = c.lines.length * cell * 0.32 + cell * 0.24;
    const bx = clamp(c.x - w / 2, 6, S.M.w - w - 6);
    const by = Math.max(6, c.y - cell * 0.95 - lift - h);
    roundRect(bx, by, w, h, 9);
    ctx.fillStyle = 'rgba(18,13,10,0.92)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(201,168,106,0.45)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    c.lines.forEach((line, i) => {
      ctx.fillStyle = line.includes('误伤') ? '#ff9c88' : '#f0e3cd';
      ctx.fillText(line, bx + w / 2, by + cell * 0.12 + (i + 0.5) * cell * 0.32);
    });
    ctx.restore();
  }

  /* =====================================================================
   * 结算
   * ===================================================================== */
  function showResult() {
    if (S.resultShown) return;
    if (S.view.status === 'PLAYING') return;
    S.resultShown = true;
    S.anim = null;
    S.card = null;
    const v = S.view;
    const draw = v.status === 'DRAW';
    const win = v.status === 'RED_WIN' ? 'RED' : v.status === 'BLACK_WIN' ? 'BLACK' : null;
    const lose = win ? (win === 'RED' ? 'BLACK' : 'RED') : null;

    E.resultTitle.textContent = draw ? '和棋' : `${SIDE_NAME[win]}胜`;
    let reason = BX.REASON_TEXT[v.drawReason] || '';
    if (!draw) {
      if (v.drawReason === 'CHECKMATE') reason = `${SIDE_NAME[lose]}被将死`;
      else if (v.drawReason === 'STALEMATE') reason = `${SIDE_NAME[lose]}无子可动（困毙）`;
      else if (v.drawReason === 'RESIGN') reason = `${SIDE_NAME[lose]}认输`;
      else if (v.drawReason === 'PERPETUAL_CHECK') reason = `${SIDE_NAME[lose]}长将判负`;
    }
    E.resultReason.textContent = reason;
    const ms = Math.max(0, S.endTime - S.startTime);
    const aiNote = S.aiSide
      ? (S.settings.honesty === 'oracle' ? ' · 练习局（AI 全知，不计分）' : ' · 人机 · AI 不偷看')
      : ' · 同屏双人';
    E.resultSub.textContent = `seed ${S.game.seed} · ${v.ply} 半步 · 用时 ${formatTime(ms)}${aiNote}`;

    E.resultStats.textContent = '';
    const reveal = S.game.finalReveal();
    let redLoss = 0;
    let blackLoss = 0;
    for (const p of reveal) {
      if (p.alive) continue;
      if (p.side === 'RED') redLoss += BX.VALUES[p.kind] || 0;
      else blackLoss += BX.VALUES[p.kind] || 0;
    }
    const stats = [
      ['手数', String(v.ply)],
      ['翻面', String(v.stats.flips)],
      ['误伤', String(v.stats.friendlyFire)],
      ['吃子', String(v.stats.captures)],
      ['红方损失', redLoss.toFixed(1)],
      ['黑方损失', blackLoss.toFixed(1)],
    ];
    for (const [label, value] of stats) {
      const box = document.createElement('div');
      box.className = 'stat';
      box.textContent = label;
      const b = document.createElement('b');
      b.textContent = value;
      box.appendChild(b);
      E.resultStats.appendChild(box);
    }

    E.revealGrid.textContent = '';
    const order = { K: 0, R: 1, C: 2, H: 3, A: 4, E: 5, P: 6 };
    for (const side of ['RED', 'BLACK']) {
      const col = document.createElement('div');
      col.className = 'reveal-col';
      const h = document.createElement('h4');
      h.textContent = `${SIDE_NAME[side]} · 16 枚`;
      col.appendChild(h);
      const wrap = document.createElement('div');
      wrap.className = 'pieces';
      const list = reveal
        .filter((p) => p.side === side)
        .sort((a, b) => (order[a.kind] - order[b.kind]) || (a.id - b.id));
      for (const p of list) {
        const item = document.createElement('span');
        item.className = 'reveal-piece' + (p.alive ? '' : ' dead');
        const chip = document.createElement('span');
        chip.className = 'chip' + (p.side === 'BLACK' ? ' black' : '');
        chip.textContent = NAMES[p.side][p.kind];
        const label = document.createElement('span');
        label.textContent = NAMES[p.side][p.kind];
        const why = document.createElement('span');
        why.className = 'why';
        why.textContent = p.alive ? (p.faceUp ? '明' : '未翻') : '被吃';
        item.append(chip, label, why);
        wrap.appendChild(item);
      }
      col.appendChild(wrap);
      E.revealGrid.appendChild(col);
    }

    if (!E.resultDialog.open) E.resultDialog.showModal();
    S.announce(BX.resultText(v.status, v.drawReason));
  }

  /* =====================================================================
   * 回放
   * ===================================================================== */
  function enterReplay(ply) {
    const target = clamp(ply, 0, S.game.ply);
    S.replayPly = target;
    S.anim = null;
    S.card = null;
    S.selectedId = null;
    S.legalByKey.clear();
    E.replayBar.hidden = false;
    E.replayText.textContent = `回放 · 第 ${target} / ${S.game.ply} 手`;
    E.replayPrev.disabled = target <= 0;
    E.replayNext.disabled = target >= S.game.ply;
    layout();
    renderA11y();
    updateHint();
    renderLog();
    requestDraw();
  }

  function exitReplay() {
    S.replayPly = null;
    hideReplay();
    layout();
    renderA11y();
    updateHint();
    renderLog();
    requestDraw();
    maybeAI();
  }

  function hideReplay() {
    E.replayBar.hidden = true;
  }

  function stepReplay(delta) {
    if (S.replayPly === null) return;
    const next = clamp(S.replayPly + delta, 0, S.game.ply);
    if (next === S.replayPly) return;
    S.replayPly = next;
    E.replayText.textContent = `回放 · 第 ${next} / ${S.game.ply} 手`;
    E.replayPrev.disabled = next <= 0;
    E.replayNext.disabled = next >= S.game.ply;
    renderA11y();
    updateHint();
    renderLog();
    requestDraw();
  }

  /* =====================================================================
   * 规则
   * ===================================================================== */
  const RULES = [
    {
      title: '双方都看不见自己的棋',
      body: `
        <p>标准 9×10 中国象棋棋盘、32 枚棋子。开局只有<b class="k">帅 / 将</b>明牌，其余 <b class="k">30 枚红黑混合洗牌</b>、背面朝上，谁都不知道每一枚是谁。</p>
        <p>双方看到的信息<b class="k">完全相同</b>——同屏热座不需要隐私屏障；人机模式里，AI 也只读公开信息。</p>
        <div class="demo">
          <div><b>?</b>暗子（无阵营色）</div>
          <div><b>帅</b>明牌将帅</div>
          <div><b>?</b>可能是敌，也可能是友</div>
        </div>`,
    },
    {
      title: '暗子 = 它所在位置的棋子',
      body: `
        <p>一枚暗子「以为」自己是这个格子原本的那个兵种：<b class="k">走法、方向、九宫、河界、敌我观</b>全部照搬，没有任何例外。</p>
        <p>所以红车被洗到黑方半场后，翻面之前会按<b class="k">黑车</b>的方式行动，也按黑方的方式分辨敌我。</p>
        <ul>
          <li>车位的暗子可以直线冲；兵位的暗子只走一格。</li>
          <li>仕位的暗子锁九宫；相位的暗子不过河。</li>
          <li>原点归属只看格子：<b class="k">rank 1–5 属红，6–10 属黑</b>。</li>
        </ul>`,
    },
    {
      title: '翻面即解放',
      body: `
        <p>暗子第一次移动（含吃子）后，在落点立即翻面，此后按<b class="k">真实兵种</b>行动。</p>
        <p>翻面后摆脱棋盘的旧规矩：<b class="k">仕可以出宫、象可以过河</b>。</p>
        <p>两个例外始终保留：帅 / 将仍然锁在九宫；兵 / 卒仍然「过河才能横走、永不后退」。</p>
        <div class="demo">
          <div><b>仕</b>可出宫，全盘斜走</div>
          <div><b>象</b>可过河，田字仍需象眼</div>
          <div><b>兵</b>过河才可横走</div>
        </div>`,
    },
    {
      title: '敌我只看表观阵营',
      body: `
        <p>每个棋子的<b class="k">表观阵营</b>都公开：明子看真实颜色，暗子看所在半场。</p>
        <ul>
          <li>暗子只攻击<b class="k">表观对侧</b>的棋子；它不会打「自己以为的友军」。</li>
          <li>明子可以攻击<b class="k">任何暗子</b>，包括表观同侧的暗子——那可能是自己人。</li>
          <li>误伤按真实阵营结算：约 <b class="k">50%</b> 的概率打到自己人。</li>
        </ul>
        <p>被吃掉的暗子会翻面揭示身份——这是你获取隐藏信息的<b class="k">唯一渠道</b>。</p>`,
    },
    {
      title: '回合、将军与胜负',
      body: `
        <p>每个回合，你只能操作<b class="k">表观属于自己</b>的棋子：红方回合可动红方半场的暗子与红方明子。</p>
        <ul>
          <li>将死或困毙对方即胜；长将判负。</li>
          <li>三次重复局面、连续 120 半步无吃子为和棋。</li>
          <li>将帅永远不可被直接吃掉，胜负只由将死 / 困毙判定。</li>
        </ul>
        <p><b class="k">攻击暗子没有确认弹窗</b>：选中时目标格会显示琥珀色问号环，点下去就直接落子。键盘可用方向键移动、回车选中或落子、Esc 取消，全程同样没有确认步骤。</p>
        <p>人机模式默认开启：AI 只读取公开信息（「AI 不偷看」）；「全知」档会读取暗子身份，顶栏会标红且不计分。玩家每局可用 3 次提示。</p>`,
    },
  ];

  function buildRules() {
    E.rulesDots.textContent = '';
    RULES.forEach((_, i) => {
      const dot = document.createElement('i');
      if (i === 0) dot.className = 'on';
      E.rulesDots.appendChild(dot);
    });
    showRulesPage(0);
  }

  function showRulesPage(index) {
    S.rulesIndex = clamp(index, 0, RULES.length - 1);
    const page = RULES[S.rulesIndex];
    E.rulesBody.innerHTML = `<div class="rules-page"><h3>${page.title}</h3>${page.body}</div>`;
    $$('#rulesDots i').forEach((dot, i) => dot.classList.toggle('on', i === S.rulesIndex));
    E.rulesPrev.disabled = S.rulesIndex === 0;
    E.rulesNext.textContent = S.rulesIndex === RULES.length - 1 ? '开始对弈' : '下一页';
  }

  function showRules(first) {
    showRulesPage(0);
    if (!E.rulesDialog.open) E.rulesDialog.showModal();
    if (first) E.rulesNext.dataset.first = '1';
    else delete E.rulesNext.dataset.first;
  }

  /* =====================================================================
   * 事件绑定
   * ===================================================================== */
  function snapPoint(x, y, M) {
    if (!M || !M.cell) return null;
    const screenFile = clamp(Math.round((x - M.margin) / M.cell) + 1, 1, 9);
    const screenRank = clamp(10 - Math.round((y - M.margin) / M.cell), 1, 10);
    const file = S.flip ? 10 - screenFile : screenFile;
    const rank = S.flip ? 11 - screenRank : screenRank;
    const px = M.x(file);
    const py = M.y(rank);
    if (Math.hypot(x - px, y - py) > M.cell * 0.55) return null;
    return SQ(file, rank);
  }

  function bindTouchSnap() {
    E.frame.addEventListener('contextmenu', (ev) => ev.preventDefault());
    if (!window.matchMedia || !window.matchMedia('(pointer: coarse)').matches) return;
    E.frame.addEventListener('pointerup', (ev) => {
      if (!S.game || S.phase !== 'PLAYING' || S.anim || S.aiThinking) return;
      if (ev.pointerType === 'mouse') return;
      const rect = E.canvas.getBoundingClientRect();
      const x = ev.clientX - rect.left;
      const y = ev.clientY - rect.top;
      const sq = snapPoint(x, y, S.M);
      if (!sq) return;
      ev.preventDefault();
      onCellClick(sq);
    }, { passive: false });
  }

  function bindUI() {
    E.startBtn.addEventListener('click', () => {
      S.settings.mode = 'pve';
      saveSettings();
      startGame({ seed: BX.randomSeed() });
    });
    E.homeConfigBtn.addEventListener('click', openHomeConfig);
    E.homeModeInput.addEventListener('change', () => {
      applyHomeConfig();
      E.homeDifficultyInput.disabled = E.homeModeInput.value === 'hotseat';
    });
    E.homeDifficultyInput.addEventListener('change', applyHomeConfig);
    E.homeSideInput.addEventListener('change', applyHomeConfig);
    E.homeConfigDone.addEventListener('click', () => {
      applyHomeConfig();
      closeDialog(E.homeConfigDialog);
    });
    E.homeHotseatBtn.addEventListener('click', () => {
      S.settings.mode = 'hotseat';
      saveSettings();
      startGame({ seed: BX.randomSeed() });
    });
    E.homeOnlineBtn.addEventListener('click', () => {
      if (location.protocol === 'file:') {
        toast('联机对战需要先启动服务器版');
        return;
      }
      location.assign('/pvp/');
    });
    E.onlineClose.addEventListener('click', () => closeDialog(E.onlineDialog));
    E.homeContinueBtn.addEventListener('click', () => {
      if (!restoreSavedGame()) toast('存档无法恢复，请开始新局');
    });
    E.homeRulesBtn.addEventListener('click', () => showRules(false));
    E.homeAboutBtn.addEventListener('click', () => {
      if (!E.aboutDialog.open) E.aboutDialog.showModal();
    });
    E.aboutClose.addEventListener('click', () => closeDialog(E.aboutDialog));
    E.homeFromResult.addEventListener('click', () => {
      clearSave();
      closeDialog(E.resultDialog);
      showHome();
    });
    E.newBtn.addEventListener('click', openNewDialog);
    E.homeBtn.addEventListener('click', () => {
      // 根页面本身就是人机首页：直接切回 Home，不做整页导航，避免白屏。
      showHome();
      if (location.protocol !== 'file:' && location.pathname !== '/') {
        try { history.replaceState(null, '', '/'); } catch (err) { /* ignore */ }
      }
    });
    E.newCancel.addEventListener('click', () => closeDialog(E.newDialog));
    E.newStart.addEventListener('click', startNewFromDialog);
    E.seedInput.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') { ev.preventDefault(); startNewFromDialog(); }
    });
    E.newDialog.addEventListener('cancel', (ev) => { ev.preventDefault(); closeDialog(E.newDialog); });

    E.undoBtn.addEventListener('click', () => {
      if (!S.game.config.undo) return;
      if (S.anim) return;
      const res = S.game.undo();
      if (!res.ok) { toast('没有可悔的棋'); return; }
      S.selectedId = null;
      S.legalByKey.clear();
      S.anim = null;
      S.card = null;
      S.resultShown = false;
      S.replayPly = null;
      S.endTime = 0;
      hideReplay();
      S.snapshots.length = S.game.ply + 1;
      refresh();
      if (S.game.ply > 0) saveGame(); else clearSave();
      toast('已悔棋（此模式可能泄露暗子身份）');
      if (E.resultDialog.open) closeDialog(E.resultDialog);
    });

    E.resignBtn.addEventListener('click', () => {
      if (S.view.status !== 'PLAYING') return;
      const loser = S.aiSide ? S.humanSide : S.view.turn;
      if (!window.confirm(`${SIDE_NAME[loser]}认输？`)) return;
      clearTimeout(S.aiTimer);
      S.aiThinking = false;
      S.game.resign(loser);
      S.endTime = Date.now();
      clearSave();
      refresh();
      showResult();
    });

    E.drawBtn.addEventListener('click', () => {
      if (S.view.status !== 'PLAYING') return;
      if (!window.confirm('提议和棋？')) return;
      clearTimeout(S.aiTimer);
      S.aiThinking = false;
      S.game.agreeDraw();
      S.endTime = Date.now();
      clearSave();
      refresh();
      showResult();
    });

    E.markBtn.addEventListener('click', () => {
      S.marking = !S.marking;
      renderButtons();
      updateHint();
      if (S.marking) toast('标记模式：点击暗子循环 ? → 我 → 敌 → 数字');
    });

    E.hintBtn.addEventListener('click', () => {
      if (!S.aiSide || S.aiThinking || S.hintsLeft <= 0) return;
      if (S.view.status !== 'PLAYING' || S.view.turn !== S.humanSide) return;
      const move = AI.suggestMove(S.game, { difficulty: S.settings.difficulty, thinkMs: 250 });
      if (!move) { toast('当前没有可提示的着法'); return; }
      S.hintsLeft--;
      S.hintMove = move;
      S.selectedId = null;
      S.legalByKey.clear();
      renderButtons();
      updateHint();
      requestDraw();
      toast(`提示：${BX.coord(move.from)} → ${BX.coord(move.to)}`);
      S.announce(`建议着法 ${BX.coord(move.from)} 到 ${BX.coord(move.to)}`);
    });

    E.modeSelect.addEventListener('change', () => {
      const mode = E.modeSelect.value === 'hotseat' ? 'hotseat' : 'pve';
      S.settings.mode = mode;
      saveSettings();
      newGame({ seed: BX.randomSeed() });
      toast(mode === 'pve' ? '已切换人机对战' : '已切换同屏双人');
    });

    E.difficultySelect.addEventListener('change', () => {
      S.settings.difficulty = E.difficultySelect.value;
      saveSettings();
      renderTop();
      renderButtons();
      toast(`AI 难度：${{ easy: '入门', normal: '进阶', hard: '高手' }[S.settings.difficulty]}`);
    });

    E.soundBtn.addEventListener('click', () => {
      S.settings.sound = !S.settings.sound;
      saveSettings();
      renderButtons();
      if (S.settings.sound) Sound.play('select');
    });

    E.panelBtn.addEventListener('click', () => E.sidePanel.classList.toggle('open'));

    E.helpBtn.addEventListener('click', () => showRules(false));
    E.rulesBtn.addEventListener('click', () => showRules(false));
    E.rulesPrev.addEventListener('click', () => showRulesPage(S.rulesIndex - 1));
    E.rulesNext.addEventListener('click', () => {
      if (S.rulesIndex === RULES.length - 1) {
        closeDialog(E.rulesDialog);
      } else {
        showRulesPage(S.rulesIndex + 1);
      }
    });
    E.rulesDialog.addEventListener('close', () => {
      markRulesSeen();
      if (S.pendingStart) {
        const pending = S.pendingStart;
        S.pendingStart = null;
        setTimeout(() => startGame(Object.assign({}, pending, { skipRules: true })), 0);
        return;
      }
      setTimeout(maybeAI, 200);
    });

    E.againBtn.addEventListener('click', () => {
      closeDialog(E.resultDialog);
      newGame({ seed: BX.randomSeed() });
    });
    E.closeResult.addEventListener('click', () => closeDialog(E.resultDialog));
    E.resultDialog.addEventListener('cancel', (ev) => { ev.preventDefault(); closeDialog(E.resultDialog); });
    E.copyBtn.addEventListener('click', async () => {
      const text = S.game.exportText();
      try {
        await navigator.clipboard.writeText(text);
        toast('战报已复制到剪贴板');
      } catch (err) {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); toast('战报已复制'); } catch (e2) { toast('复制失败，请手动选择'); }
        document.body.removeChild(ta);
      }
    });

    E.replayPrev.addEventListener('click', () => stepReplay(-1));
    E.replayNext.addEventListener('click', () => stepReplay(1));
    E.replayClose.addEventListener('click', exitReplay);

    E.captureFeed.addEventListener('keydown', (ev) => {
      if (ev.key !== 'ArrowDown' && ev.key !== 'ArrowUp') return;
      const rows = Array.from(E.captureFeed.querySelectorAll('.capture-row'));
      const i = rows.indexOf(document.activeElement);
      if (i < 0) return;
      ev.preventDefault();
      const next = rows[clamp(i + (ev.key === 'ArrowDown' ? 1 : -1), 0, rows.length - 1)];
      if (next) next.focus();
    });

    E.logList.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') exitReplay();
    });

    document.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') {
        if (E.resultDialog.open) return;
        if (E.rulesDialog.open) return;
        if (E.newDialog.open) return;
        if (E.sidePanel.classList.contains('open')) { E.sidePanel.classList.remove('open'); return; }
        if (S.replayPly !== null) { exitReplay(); return; }
        if (S.selectedId !== null) deselect();
      }
      if (S.replayPly !== null && (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight')) {
        const active = document.activeElement;
        if (active && active.closest && active.closest('#a11yGrid')) return;
        ev.preventDefault();
        stepReplay(ev.key === 'ArrowLeft' ? -1 : 1);
      }
    });

    document.addEventListener('pointerdown', () => Sound.unlock(), { once: true });
    document.addEventListener('keydown', () => Sound.unlock(), { once: true });
  }

  function openNewDialog() {
    E.seedInput.value = '';
    E.balanceSelect.value = S.settings.balance;
    E.modeInput.value = S.settings.mode;
    E.sideInput.value = S.settings.side;
    E.difficultyInput.value = S.settings.difficulty;
    E.honestyInput.value = S.settings.honesty;
    E.strictToggle.checked = !!S.settings.strict;
    E.undoToggle.checked = !!S.settings.undo;
    if (!E.newDialog.open) E.newDialog.showModal();
  }

  function startNewFromDialog() {
    S.settings.balance = E.balanceSelect.value;
    S.settings.mode = E.modeInput.value;
    S.settings.side = E.sideInput.value;
    S.settings.difficulty = E.difficultyInput.value;
    S.settings.honesty = E.honestyInput.value;
    S.settings.strict = E.strictToggle.checked;
    S.settings.undo = E.undoToggle.checked;
    saveSettings();
    const seed = E.seedInput.value.trim() || BX.randomSeed();
    closeDialog(E.newDialog);
    newGame({ seed });
    toast('新对局 · seed ' + seed);
  }

  /* =====================================================================
   * 其他
   * ===================================================================== */
  function tickClock() {
    if (!S.game) return;
    const end = S.endTime || Date.now();
    const ms = Math.max(0, end - S.startTime);
    E.clockText.textContent = formatTime(ms);
  }

  function formatTime(ms) {
    const total = Math.floor(ms / 1000);
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  /* =====================================================================
   * 测试钩子（仅当页面在加载 ui.js 前设置 window.__BX_TEST__ = true 时暴露；
   * 不提供 URL 开关，避免玩家用 query 参数打开全知视角）
   * ===================================================================== */
  function testHooks() {
    return {
      BX,
      AI,
      VIS,
      S,
      E,
      get game() { return S.game; },
      get view() { return S.view; },
      phase: () => S.phase,
      startGame,
      showHome,
      restoreSavedGame,
      saveGame,
      clearSave,
      hasSave,
      newGame,
      clickCell: (file, rank) => onCellClick(SQ(file, rank)),
      select: (file, rank) => { const p = pieceBySquare(file, rank); if (p) selectPiece(p); },
      move: (from, to) => commitMove(SQ(from.file, from.rank), SQ(to.file, to.rank)),
      legalKeys: () => Array.from(S.legalByKey.keys()),
      state: () => S.view ? ({
        phase: S.phase,
        selectedId: S.selectedId,
        legalCount: S.legalByKey.size,
        resultOpen: E.resultDialog.open,
        replayPly: S.replayPly,
        animating: !!S.anim,
        marking: S.marking,
        aiSide: S.aiSide,
        humanSide: S.humanSide,
        aiThinking: S.aiThinking,
        hintsLeft: S.hintsLeft,
        hintMove: S.hintMove,
        status: S.view.status,
        ply: S.view.ply,
        hintText: E.hintbar.textContent,
      }) : { phase: 'HOME', aiSide: S.aiSide, humanSide: S.humanSide, status: 'HOME', ply: 0 },
      captureRows: () => captureItems(S.view || { pieces: [], history: [] }),
      renderCapture: () => renderCapture(),
      snapPoint: (x, y) => snapPoint(x, y, S.M),
      setPosition: (def) => {
        clearTimeout(S.aiTimer);
        clearTimeout(S.resultTimer);
        S.phase = 'PLAYING';
        E.app.classList.remove('home-active');
        S.game = new BX.Game({ position: def, config: def.config || {} });
        S.aiSide = def.aiSide || null;
        S.humanSide = def.humanSide || null;
        S.flip = !!S.aiSide && S.humanSide === 'BLACK';
        S.selectedId = null;
        S.legalByKey.clear();
        S.anim = null;
        S.card = null;
        S.marks.clear();
        S.replayPly = null;
        S.capturePly = null;
        S.resultShown = false;
        S.aiThinking = false;
        S.hintMove = null;
        S.hintsLeft = 3;
        S.startTime = Date.now();
        S.endTime = 0;
        S.view = S.game.uiState();
        S.snapshots = [S.view];
        S.grain = makeGrain(S.game.seed);
        hideReplay();
        closeDialog(E.resultDialog);
        refresh();
        layout();
        if (S.aiSide && S.view.turn === S.aiSide) setTimeout(maybeAI, 80);
      },
      skipAnim: () => {
        S.anim = null;
        if (S.view && S.view.status !== 'PLAYING' && !S.resultShown) showResult();
        requestDraw();
      },
      /** 把当前动画定格在 elapsed 毫秒处并立即重绘（离线预览 / 视觉测试） */
      renderAnimAt: (elapsed) => {
        if (!S.anim) return false;
        S.anim.start = performance.now() - elapsed;
        S.card = null;
        draw(performance.now());
        return true;
      },
      showResult,
      closeDialogs: () => {
        closeDialog(E.resultDialog);
        closeDialog(E.rulesDialog);
        closeDialog(E.newDialog);
        closeDialog(E.homeConfigDialog);
        closeDialog(E.aboutDialog);
        closeDialog(E.onlineDialog);
      },
      focusCell,
      layout,
      requestDraw,
      wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      announce: (t) => S.announce && S.announce(t),
    };
  }

  /* 启动 */
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
