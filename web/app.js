/*!
 * Route-A H5 client (M1 slice).
 * The browser NEVER loads engine.js/ai.js: all rules and legal moves come from
 * the Python server. This file only renders PublicState and posts moves.
 */
(() => {
  'use strict';

  const NAMES = {
    RED: { K: '帅', A: '仕', E: '相', H: '马', R: '车', C: '炮', P: '兵' },
    BLACK: { K: '将', A: '士', E: '象', H: '马', R: '车', C: '炮', P: '卒' },
  };
  const SIDE_NAME = { RED: '红方', BLACK: '黑方' };
  const SIDE_CHAR = { RED: '红', BLACK: '黑' };
  const DIFF_LABEL = { easy: '入门', normal: '进阶', hard: '高手' };
  const SETTINGS_KEY = 'bx.settings.v1';
  const $ = (sel) => document.querySelector(sel);

  const E = {
    app: $('#app'), home: $('#homeScreen'),
    healthBtn: $('#healthBtn'), healthBtn2: $('#healthBtn2'),
    healthText: $('#healthText'),
    topbar: $('#topbar'), stage: $('#stage'), bottombar: $('#bottombar'),
    pane: $('#boardPane'), canvas: $('#board'), toast: $('#toast'),
    turnDot: $('#turnDot'), turnText: $('#turnText'), plyText: $('#plyText'),
    redUp: $('#redUp'), blackUp: $('#blackUp'),
    redHidden: $('#redHidden'), blackHidden: $('#blackHidden'),
    redLost: $('#redLost'), blackLost: $('#blackLost'),
    metaText: $('#metaText'), seedText: $('#seedText'), countText: $('#countText'),
    netStatus: $('#netStatus'),
    captureFeed: $('#captureFeed'), captureStrip: $('#captureStrip'),
    logList: $('#logList'), hintbar: $('#hintbar'), roomText: $('#roomText'),
    newBtn: $('#newBtn'), newBtn2: $('#newBtn2'), resignBtn: $('#resignBtn'),
    onlineBtn: $('#onlineBtn'), onlineDialog: $('#onlineDialog'), onlineClose: $('#onlineClose'),
    pveBtn: $('#pveBtn'),
    difficultyBtn: $('#difficultyBtn'), difficultySummary: $('#difficultySummary'),
    difficultyDialog: $('#difficultyDialog'), difficultyClose: $('#difficultyClose'),
    createRoomBtn: $('#createRoomBtn'), joinRoomBtn: $('#joinRoomBtn'),
    roomInput: $('#roomInput'), onlineStatus: $('#onlineStatus'),
    modeBadge: $('#modeBadge'),
  };

  const S = {
    gameId: null,
    pub: null,
    selected: null,
    legal: new Map(),      // "f,r" -> [{to,capture}]
    busy: false,
    anim: null,
    cell: 40,
    margin: 46,
    w: 0,
    h: 0,
    dpr: 1,
    toastTimer: 0,
    ws: null,
    online: false,
    mode: 'online',
    mySide: null,
    flip: false,
    room: null,
    seq: 0,
    pendingAt: 0,
    netTimer: 0,
    netHideTimer: 0,
  };

  const ctx = E.canvas.getContext('2d');

  async function api(path, opts) {
    const res = await fetch(path, Object.assign({ headers: { 'Content-Type': 'application/json' } }, opts || {}));
    let data = null;
    try { data = await res.json(); } catch (err) { data = null; }
    if (!res.ok) throw new Error((data && data.detail) || ('HTTP ' + res.status));
    return data;
  }

  function toast(text, bad) {
    E.toast.textContent = text;
    E.toast.classList.add('show');
    E.toast.classList.toggle('bad', !!bad);
    clearTimeout(S.toastTimer);
    S.toastTimer = setTimeout(() => E.toast.classList.remove('show'), 1800);
  }

  function setNet(text, cls, hideMs) {
    if (!E.netStatus) return;
    clearTimeout(S.netHideTimer);
    if (!text) {
      E.netStatus.hidden = true;
      E.netStatus.textContent = '';
      E.netStatus.className = 'net-pill';
      return;
    }
    E.netStatus.hidden = false;
    E.netStatus.textContent = text;
    E.netStatus.className = 'net-pill' + (cls ? ' ' + cls : '');
    if (hideMs) {
      S.netHideTimer = setTimeout(() => setNet('', '', 0), hideMs);
    }
  }

  function clearPendingMove() {
    clearTimeout(S.netTimer);
    S.netTimer = 0;
    S.pendingAt = 0;
    S.busy = false;
  }

  function readSettings() {
    try {
      const raw = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
      return raw && typeof raw === 'object' ? raw : {};
    } catch (err) {
      return {};
    }
  }

  function currentDifficulty() {
    const d = readSettings().difficulty;
    return DIFF_LABEL[d] ? d : 'normal';
  }

  function updateDifficulty() {
    if (!E.difficultySummary) return;
    const d = currentDifficulty();
    E.difficultySummary.textContent = '人机 · ' + DIFF_LABEL[d];
    document.querySelectorAll('.difficulty-option').forEach((el) => {
      el.classList.toggle('selected', el.dataset.difficulty === d);
    });
  }

  function saveDifficulty(d) {
    if (!DIFF_LABEL[d]) return;
    const s = Object.assign({}, readSettings(), { difficulty: d, mode: 'pve' });
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch (err) { /* ignore */ }
    updateDifficulty();
  }

  async function health() {
    try {
      const data = await api('/api/health');
      E.healthText.textContent = `服务正常 · ${data.games} 局`;
      E.healthText.classList.remove('web-error');
    } catch (err) {
      E.healthText.textContent = '服务不可用';
      E.healthText.classList.add('web-error');
    }
  }

  /* ------------------------------------------------------------- online WS */
  function leaveRoom() {
    clearPendingMove();
    setNet('');
    closeOnline();
    S.pub = null;
    S.selected = null;
    S.anim = null;
    S.busy = false;
    S.room = null;
    S.mySide = null;
    S.flip = false;
    E.roomText.textContent = '';
    E.app.classList.add('home-active');
    E.home.hidden = false;
    E.topbar.hidden = true;
    E.stage.hidden = true;
    E.bottombar.hidden = true;
  }

  function wsUrl() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return proto + '//' + location.host + '/ws';
  }

  function openOnline() {
    if (!E.onlineDialog.open) E.onlineDialog.showModal();
    E.onlineStatus.textContent = '未连接';
  }

  function setOnlineStatus(text, bad) {
    E.onlineStatus.textContent = text;
    E.onlineStatus.classList.toggle('web-error', !!bad);
  }

  function closeOnline() {
    if (S.ws) {
      try { S.ws.close(); } catch (err) { /* ignore */ }
      S.ws = null;
    }
    S.online = false;
    if (S.room) E.roomText.textContent = '';
  }

  function connectRoom(mode) {
    closeOnline();
    const code = (E.roomInput.value || '').trim().toUpperCase();
    if (mode === 'join' && code.length !== 6) { setOnlineStatus('请输入 6 位房间码', true); return; }
    const ws = new WebSocket(wsUrl());
    S.ws = ws;
    ws.onopen = () => {
      setOnlineStatus(mode === 'create' ? '创建中…' : '加入中…');
      if (mode === 'create') ws.send(JSON.stringify({ t: 'create' }));
      else ws.send(JSON.stringify({ t: 'join', room: code }));
    };
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (err) { return; }
      handleWs(msg);
    };
    ws.onerror = () => setOnlineStatus('连接失败', true);
    ws.onclose = () => {
      if (S.online) {
        setOnlineStatus('连接已断开', true);
        toast('联机连接已断开', true);
      }
    };
  }

  function handleWs(msg) {
    if (msg.t === 'sync') {
      S.online = true;
      S.mySide = msg.you;
      S.flip = msg.you === 'BLACK';
      S.room = msg.room;
      S.pub = msg.public;
      S.seq = msg.public.ply;
      S.selected = null;
      S.anim = null;
      S.busy = false;
      clearTimeout(S.netTimer);
      S.pendingAt = 0;
      setNet('');
      E.modeBadge.textContent = '联机房间 · 服务器权威';
      groupLegal();
      if (E.onlineDialog.open) E.onlineDialog.close();
      showGame();
      render();
      E.roomText.textContent = '房间 ' + msg.room + ' · 你执' + (msg.you === 'RED' ? '红' : '黑');
      setOnlineStatus('房间 ' + msg.room + ' · 你执' + (msg.you === 'RED' ? '红' : '黑'));
      toast('已进入房间 ' + msg.room);
      setTimeout(() => {
        if (S.ws && S.ws.readyState === WebSocket.OPEN) {
          S.ws.send(JSON.stringify({ t: 'ping', ts: Date.now() }));
        }
      }, 400);
      return;
    }
    if (msg.t === 'opp.joined') {
      setOnlineStatus('对手已加入 · 开始对局');
      toast('对手已加入');
      return;
    }
    if (msg.t === 'opp.left') {
      toast('对手已离开，等待重连…', true);
      return;
    }
    if (msg.t === 'moveOk') {
      const rtt = S.pendingAt ? Math.round(performance.now() - S.pendingAt) : 0;
      clearPendingMove();
      if (rtt) setNet(rtt > 800 ? `网络较慢 ${rtt}ms` : `已同步 ${rtt}ms`, rtt > 800 ? 'bad' : 'ok', 1600);
      else setNet('');
      S.pub = msg.public;
      S.seq = msg.ply;
      groupLegal();
      S.anim = {
        event: msg.event,
        start: performance.now(),
        flip: !!msg.event.revealed,
        duration: msg.event.revealed ? 660 : 320,
      };
      S.busy = true;
      render();
      return;
    }
    if (msg.t === 'moveErr') {
      clearPendingMove();
      setNet(msg.code === 'ILLEGAL' ? '落子被拒绝' : '未同步', 'bad', 1800);
      const text = msg.code === 'STALE' ? '该着法已处理'
        : msg.code === 'NOT_YOUR_TURN' ? '还没轮到你'
        : '服务器拒绝该着法';
      toast(text, true);
      render();
      return;
    }
    if (msg.t === 'end') {
      clearPendingMove();
      setNet('');
      S.pub = msg.public;
      S.busy = false;
      S.anim = null;
      groupLegal();
      render();
      toast(msg.status === 'RED_WIN' ? '红方胜' : msg.status === 'BLACK_WIN' ? '黑方胜' : '和棋');
      return;
    }
    if (msg.t === 'error') {
      setOnlineStatus(msg.code + (msg.message ? ' · ' + msg.message : ''), true);
      toast(msg.code, true);
      S.busy = false;
      return;
    }
    if (msg.t === 'pong') {
      if (msg.ts) {
        const rtt = Math.max(0, Date.now() - Number(msg.ts));
        if (!S.busy) setNet(rtt > 800 ? `网络较慢 ${rtt}ms` : `延迟 ${rtt}ms`, rtt > 800 ? 'bad' : 'ok', 2500);
      }
      return;
    }
  }

  function showGame() {
    E.app.classList.remove('home-active');
    E.home.hidden = true;
    E.topbar.hidden = false;
    E.stage.hidden = false;
    E.bottombar.hidden = false;
    requestAnimationFrame(layout);
  }

  function groupLegal() {
    S.legal.clear();
    for (const mv of (S.pub && S.pub.legal_moves) || []) {
      const key = mv.from.file + ',' + mv.from.rank;
      if (!S.legal.has(key)) S.legal.set(key, []);
      S.legal.get(key).push(mv);
    }
  }

  /* ---------------------------------------------------------------- layout */
  function layout() {
    if (!S.pub) return;
    const rect = E.pane.getBoundingClientRect();
    const availW = Math.max(240, rect.width - 6);
    const mobile = window.matchMedia && window.matchMedia('(max-width: 1023px)').matches;
    const availH = Math.max(260, rect.height - 36 - (mobile ? 54 : 0));
    let cell = Math.min(availW / 10.3, availH / 11.3, 76);
    cell = Math.max(22, cell);
    S.cell = cell;
    S.margin = cell * 1.15;
    S.w = 8 * cell + S.margin * 2;
    S.h = 9 * cell + S.margin * 2;
    S.dpr = Math.min(window.devicePixelRatio || 1, 2);
    E.canvas.style.width = S.w + 'px';
    E.canvas.style.height = S.h + 'px';
    E.canvas.width = Math.round(S.w * S.dpr);
    E.canvas.height = Math.round(S.h * S.dpr);
    ctx.setTransform(S.dpr, 0, 0, S.dpr, 0, 0);
    render();
  }

  const X = (f) => S.margin + (f - 1) * S.cell;
  const Y = (r) => S.margin + (10 - r) * S.cell;
  // 黑方视角：逻辑坐标绕棋盘中心旋转 180°，只改绘制/命中映射，不改规则。
  const SX = (f) => X(S.flip ? 10 - f : f);
  const SY = (r) => Y(S.flip ? 11 - r : r);

  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  /* ---------------------------------------------------------------- canvas */
  function drawBoard() {
    ctx.clearRect(0, 0, S.w, S.h);
    const grd = ctx.createLinearGradient(0, 0, S.w, S.h);
    grd.addColorStop(0, '#e8d2ae');
    grd.addColorStop(0.5, '#e3cba5');
    grd.addColorStop(1, '#dcc299');
    ctx.fillStyle = grd;
    roundRect(0, 0, S.w, S.h, 16);
    ctx.fill();
    ctx.strokeStyle = 'rgba(80,55,30,0.45)';
    ctx.lineWidth = 1;
    roundRect(0.5, 0.5, S.w - 1, S.h - 1, 16);
    ctx.stroke();

    ctx.strokeStyle = 'rgba(120,86,48,0.72)';
    ctx.lineWidth = Math.max(1, S.cell * 0.022);
    const left = X(1), right = X(9), top = Y(10), bottom = Y(1);
    for (let r = 1; r <= 10; r++) {
      ctx.beginPath(); ctx.moveTo(left, Y(r)); ctx.lineTo(right, Y(r)); ctx.stroke();
    }
    for (let f = 1; f <= 9; f++) {
      if (f === 1 || f === 9) {
        ctx.beginPath(); ctx.moveTo(X(f), top); ctx.lineTo(X(f), bottom); ctx.stroke();
      } else {
        ctx.beginPath(); ctx.moveTo(X(f), top); ctx.lineTo(X(f), Y(6)); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(X(f), Y(5)); ctx.lineTo(X(f), bottom); ctx.stroke();
      }
    }
    // palace
    ctx.beginPath();
    ctx.moveTo(X(4), Y(10)); ctx.lineTo(X(6), Y(8));
    ctx.moveTo(X(6), Y(10)); ctx.lineTo(X(4), Y(8));
    ctx.moveTo(X(4), Y(3)); ctx.lineTo(X(6), Y(1));
    ctx.moveTo(X(6), Y(3)); ctx.lineTo(X(4), Y(1));
    ctx.stroke();

    ctx.fillStyle = 'rgba(130,96,55,0.55)';
    ctx.font = `${Math.max(11, S.cell * 0.34)}px "STKaiti","KaiTi","Songti SC",serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText('楚 河', SX(3), (Y(6) + Y(5)) / 2);
    ctx.fillText('漢 界', SX(7), (Y(6) + Y(5)) / 2);

    ctx.fillStyle = 'rgba(120,84,45,0.8)';
    ctx.font = `${Math.max(8, S.cell * 0.19)}px "Segoe UI",sans-serif`;
    for (let f = 1; f <= 9; f++) {
      ctx.fillText(String(f), SX(f), S.margin * 0.42);
      ctx.fillText(String(f), SX(f), S.h - S.margin * 0.42);
    }
    for (let r = 1; r <= 10; r++) {
      ctx.fillText(String(r), S.margin * 0.42, SY(r));
      ctx.fillText(String(r), S.w - S.margin * 0.42, SY(r));
    }
  }

  function pieceFace(p, front) {
    if (front) return { kind: p.kind, side: p.side };
    return { kind: p.origin_kind, side: p.origin_side };
  }

  function drawPiece(p, x, y, opts) {
    const o = opts || {};
    const D = S.cell * 0.86;
    const R = D / 2;
    const H = D * 0.10;
    const front = !!o.front;
    const face = pieceFace(p, front);
    const sy = o.scaleY == null ? 1 : o.scaleY;

    ctx.save();
    ctx.globalAlpha = o.alpha == null ? 1 : o.alpha;
    ctx.translate(x, y + H / 2);
    ctx.scale(1, sy);
    ctx.translate(-x, -(y + H / 2));

    ctx.fillStyle = 'rgba(0,0,0,0.22)';
    ctx.beginPath();
    ctx.ellipse(x, y + H + H * 0.18, R * 1.02, R * 0.22, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.beginPath();
    ctx.rect(x - R, y, D, H);
    ctx.ellipse(x, y + H, R, R, 0, 0, Math.PI * 2);
    ctx.fillStyle = front ? '#c9b596' : '#3a2b21';
    ctx.fill();

    ctx.beginPath();
    ctx.ellipse(x, y, R, R, 0, 0, Math.PI * 2);
    ctx.fillStyle = front ? '#fff6e7' : '#5c4634';
    ctx.fill();
    ctx.strokeStyle = front ? 'rgba(110,74,36,0.8)' : 'rgba(230,205,170,0.25)';
    ctx.lineWidth = 1;
    ctx.stroke();

    if (front) {
      ctx.beginPath();
      ctx.arc(x, y, R * 0.82, 0, Math.PI * 2);
      ctx.strokeStyle = face.side === 'RED' ? 'rgba(168,45,35,0.72)' : 'rgba(40,48,55,0.7)';
      ctx.lineWidth = Math.max(1, S.cell * 0.026);
      ctx.stroke();
      ctx.fillStyle = face.side === 'RED' ? '#b23a2c' : '#222a31';
      ctx.font = `600 ${Math.max(12, S.cell * 0.48)}px "STKaiti","KaiTi","Songti SC",serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(NAMES[face.side][face.kind], x, y + 1);
    } else {
      // 暗子：同心车削纹 + 中心菱形，禁止任何文字/“?”
      ctx.strokeStyle = 'rgba(232,208,174,0.30)';
      ctx.lineWidth = Math.max(1, S.cell * 0.025);
      for (const rr of [0.20, 0.34, 0.48]) {
        ctx.beginPath();
        ctx.arc(x, y, R * rr, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.moveTo(x, y - R * 0.14);
      ctx.lineTo(x + R * 0.14, y);
      ctx.lineTo(x, y + R * 0.14);
      ctx.lineTo(x - R * 0.14, y);
      ctx.closePath();
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawOverlayTarget(mv) {
    const x = SX(mv.to.file), y = SY(mv.to.rank);
    if (mv.capture && mv.capture.face_up) {
      ctx.beginPath(); ctx.arc(x, y, S.cell * 0.47, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(239,68,68,0.85)'; ctx.lineWidth = 2; ctx.stroke();
    } else if (mv.capture) {
      ctx.beginPath(); ctx.arc(x, y, S.cell * 0.46, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(245,158,11,0.95)'; ctx.lineWidth = 2; ctx.stroke();
      ctx.fillStyle = 'rgba(245,158,11,0.95)';
      ctx.font = `700 ${Math.max(10, S.cell * 0.28)}px "Segoe UI",sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('?', x, y + 1);
    } else {
      ctx.beginPath(); ctx.arc(x, y, Math.max(3, S.cell * 0.10), 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(230,201,143,0.85)'; ctx.fill();
    }
  }

  function drawPieces(t) {
    let skipId = null;
    if (S.anim) skipId = S.anim.event.mover_id;
    for (const p of S.pub.pieces) {
      if (p.id === skipId) continue;
      drawPiece(p, SX(p.file), SY(p.rank), { front: p.face_up });
    }

    if (S.anim) {
      const el = Math.max(0, t - S.anim.start);
      const from = S.anim.event.from, to = S.anim.event.to;
      let f = 1, sy = 1, lift = 0;
      if (el < 80) { f = 0; lift = -6 * (el / 80); }
      else if (el < 260) {
        f = (el - 80) / 180;
        f = f < 0.5 ? 4 * f * f * f : 1 - Math.pow(-2 * f + 2, 3) / 2;
        lift = -6;
      } else if (el < 320) {
        f = 1; lift = -6 * (1 - (el - 260) / 60);
      } else {
        f = 1; lift = 0;
      }
      const x = SX(from.file) + (SX(to.file) - SX(from.file)) * f;
      const y = SY(from.rank) + (SY(to.rank) - SY(from.rank)) * f + lift;
      let front = !!S.anim.event.mover_was_face_up;
      if (S.anim.flip) {
        if (el >= 410) front = !!S.anim.event.revealed;
        if (el > 320 && el < 410) sy = 1 - (el - 320) / 90 * 0.9;
        else if (el >= 410 && el < 640) sy = 0.1 + (el - 410) / 230 * 0.9;
      }
      const p = S.pub.pieces.find((q) => q.id === skipId) || {
        face_up: !!S.anim.event.revealed,
        kind: S.anim.event.revealed && S.anim.event.revealed.kind,
        side: S.anim.event.revealed && S.anim.event.revealed.side,
        origin_kind: null,
        origin_side: null,
      };
      drawPiece(p, x, y, { front, scaleY: sy });
    }
  }

  function draw() {
    if (!S.pub) return;
    drawBoard();
    // last move rings
    const last = S.pub.history[S.pub.history.length - 1];
    if (last) {
      for (const sq of [last.from, last.to]) {
        ctx.beginPath();
        ctx.arc(SX(sq.file), SY(sq.rank), S.cell * 0.48, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(230,201,143,0.38)';
        ctx.lineWidth = 2;
        ctx.stroke();
      }
    }
    drawPieces(performance.now());
    if (S.selected) {
      const x = SX(S.selected.file), y = SY(S.selected.rank);
      ctx.beginPath(); ctx.arc(x, y, S.cell * 0.47, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(230,201,143,0.95)'; ctx.lineWidth = 2.5; ctx.stroke();
    }
    const list = S.selected ? S.legal.get(S.selected.file + ',' + S.selected.rank) || [] : [];
    for (const mv of list) drawOverlayTarget(mv);
  }

  function render() {
    if (!S.pub) return;
    draw();
    renderTop();
    renderSide();
    renderCapture();
    updateHint();
    if (S.anim && !S.anim.loop) {
      S.anim.loop = true;
      requestAnimationFrame(stepAnim);
    }
  }

  function updateHint() {
    if (!S.pub) return;
    if (S.pub.status !== 'PLAYING') { E.hintbar.textContent = '对局结束'; return; }
    if (S.busy) { E.hintbar.textContent = '行棋中… 等待服务器确认'; return; }
    E.hintbar.textContent = S.pub.turn === S.mySide ? '轮到你 · 点击棋子' : '等待对手落子…';
  }

  function stepAnim() {
    if (!S.anim) return;
    const t = performance.now();
    draw();
    if (t - S.anim.start >= S.anim.duration) {
      S.anim = null;
      S.busy = false;
      render();
      return;
    }
    requestAnimationFrame(stepAnim);
  }

  function renderTop() {
    const p = S.pub;
    E.turnDot.classList.toggle('black', p.turn === 'BLACK');
    if (p.status === 'PLAYING') {
      E.turnText.textContent = `${SIDE_NAME[p.turn]}行棋`;
      E.plyText.textContent = `第 ${p.ply + 1} 手`;
    } else {
      const win = p.status === 'RED_WIN' ? '红方胜' : p.status === 'BLACK_WIN' ? '黑方胜' : '和棋';
      E.turnText.textContent = win;
      E.plyText.textContent = `${p.ply} 手`;
    }
  }

  function renderSide() {
    const pieces = S.pub.pieces;
    const up = pieces.filter((p) => p.face_up);
    E.redUp.textContent = String(up.filter((p) => p.side === 'RED').length);
    E.blackUp.textContent = String(up.filter((p) => p.side === 'BLACK').length);
    E.redHidden.textContent = String(pieces.filter((p) => !p.face_up && p.rank <= 5).length);
    E.blackHidden.textContent = String(pieces.filter((p) => !p.face_up && p.rank >= 6).length);
    const caps = S.pub.history.filter((h) => h.captured);
    E.redLost.textContent = String(caps.filter((c) => c.captured.side === 'RED').length);
    E.blackLost.textContent = String(caps.filter((c) => c.captured.side === 'BLACK').length);
    E.metaText.textContent = '服务器权威 · PublicState';
    E.seedText.textContent = 'seed ' + S.pub.seed;
    E.countText.textContent = `${S.pub.ply} 手`;
    E.logList.textContent = '';
    if (!S.pub.history.length) {
      const d = document.createElement('div'); d.className = 'log-empty'; d.textContent = '尚无着法'; E.logList.appendChild(d);
    } else {
      for (const ev of S.pub.history) {
        const row = document.createElement('div');
        row.className = 'log-item';
        row.innerHTML = `<span class="ply">${ev.ply}</span><span class="body"><span class="who ${ev.side === 'RED' ? 'red' : 'black'}">${SIDE_CHAR[ev.side]}</span><span class="coord">${coord(ev.from)}→${coord(ev.to)}</span></span>`;
        E.logList.appendChild(row);
      }
    }
  }

  function coord(sq) { return `f${sq.file}r${sq.rank}`; }

  function captureCoin(kind, side, hidden) {
    const el = document.createElement('span');
    el.className = 'capture-coin ' + (hidden ? 'hidden' : (side === 'RED' ? 'red' : 'black'));
    if (!hidden && kind) el.textContent = NAMES[side][kind];
    el.setAttribute('aria-hidden', 'true');
    return el;
  }

  function captureGroup(side, items) {
    const group = document.createElement('div');
    group.className = 'capture-group ' + (side === 'RED' ? 'red' : 'black');
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
    for (const ev of items) {
      const cap = ev.captured;
      coins.appendChild(captureCoin(cap.kind, cap.side, !cap.kind || !cap.side));
    }
    group.append(head, coins);
    return group;
  }

  function renderCapture() {
    E.captureFeed.textContent = '';
    E.captureStrip.textContent = '';
    const caps = S.pub.history.filter((h) => h.captured).slice(-40).reverse();
    if (!caps.length) {
      const d = document.createElement('div'); d.className = 'capture-empty'; d.textContent = '尚无吃子';
      E.captureFeed.appendChild(d);
      const s = document.createElement('span'); s.className = 'capture-empty'; s.textContent = '尚无吃子'; E.captureStrip.appendChild(s);
      E.captureFeed.setAttribute('aria-label', '尚无吃子');
      return;
    }
    const groups = { RED: [], BLACK: [] };
    for (const ev of caps) groups[ev.side].push(ev);
    const summary = [];
    for (const side of ['RED', 'BLACK']) {
      if (!groups[side].length) continue;
      summary.push(`${SIDE_NAME[side]}吃掉 ${groups[side].length} 枚`);
      E.captureFeed.appendChild(captureGroup(side, groups[side]));
      const strip = document.createElement('div');
      strip.className = 'capture-strip-group';
      const label = document.createElement('span');
      label.className = 'capture-group-label';
      label.textContent = side === 'RED' ? '红吃' : '黑吃';
      strip.appendChild(label);
      for (const ev of groups[side]) {
        const cap = ev.captured;
        strip.appendChild(captureCoin(cap.kind, cap.side, !cap.kind || !cap.side));
      }
      E.captureStrip.appendChild(strip);
    }
    E.captureFeed.setAttribute('aria-label', summary.join('；'));
  }

  /* ---------------------------------------------------------------- input */
  function nearest(ev) {
    const rect = E.canvas.getBoundingClientRect();
    const x = ev.clientX - rect.left;
    const y = ev.clientY - rect.top;
    const screenFile = Math.round((x - S.margin) / S.cell) + 1;
    const screenRank = 10 - Math.round((y - S.margin) / S.cell);
    if (screenFile < 1 || screenFile > 9 || screenRank < 1 || screenRank > 10) return null;
    const file = S.flip ? 10 - screenFile : screenFile;
    const rank = S.flip ? 11 - screenRank : screenRank;
    const px = SX(file), py = SY(rank);
    if (Math.hypot(x - px, y - py) > S.cell * 0.55) return null;
    return { file, rank };
  }

  async function onClick(ev) {
    if (!S.pub || S.busy || S.anim || S.pub.status !== 'PLAYING') return;
    if (S.pub.turn !== S.mySide) { toast('等待对手落子'); return; }
    const sq = nearest(ev);
    if (!sq) return;
    const key = sq.file + ',' + sq.rank;
    if (S.selected) {
      if (S.selected.file === sq.file && S.selected.rank === sq.rank) {
        S.selected = null;
        render();
        return;
      }
      const list = S.legal.get(S.selected.file + ',' + S.selected.rank) || [];
      const mv = list.find((m) => m.to.file === sq.file && m.to.rank === sq.rank);
      if (mv) { await doMove(S.selected, sq); return; }
    }
    if (S.legal.has(key)) { S.selected = sq; render(); return; }
    S.selected = null;
    const p = S.pub.pieces.find((q) => q.file === sq.file && q.rank === sq.rank);
    if (p) {
      if (!p.face_up && p.origin_side !== S.pub.turn) {
        toast('这枚暗子表观属于对方，本回合不能操作');
      } else if (p.face_up && p.side !== S.pub.turn) {
        toast('这不是本回合方的棋子');
      } else {
        toast('该子当前没有合法着法');
      }
    }
    render();
  }

  function doMove(from, to) {
    S.busy = true;
    S.selected = null;
    S.pendingAt = performance.now();
    setNet('行棋中…', 'busy');
    clearTimeout(S.netTimer);
    S.netTimer = setTimeout(() => {
      if (!S.busy) return;
      S.busy = false;
      setNet('网络超时，请重试', 'bad');
      toast('服务器响应超时；可点「离开」后重新加入', true);
      render();
    }, 8000);
    render();
    const seq = ++S.seq;
    S.ws.send(JSON.stringify({ t: 'move', seq, from, to }));
  }

  function resign() {
    if (!S.pub || S.pub.status !== 'PLAYING') return;
    if (!window.confirm(`${SIDE_NAME[S.mySide]}认输？`)) return;
    S.ws.send(JSON.stringify({ t: 'resign' }));
  }

  E.newBtn.addEventListener('click', leaveRoom);
  E.newBtn2.addEventListener('click', leaveRoom);
  E.resignBtn.addEventListener('click', resign);
  E.healthBtn.addEventListener('click', health);
  E.healthBtn2.addEventListener('click', health);
  E.pveBtn.addEventListener('click', () => location.assign('/'));
  if (E.difficultyBtn) {
    E.difficultyBtn.addEventListener('click', () => {
      updateDifficulty();
      if (!E.difficultyDialog.open) E.difficultyDialog.showModal();
    });
    E.difficultyClose.addEventListener('click', () => E.difficultyDialog.close());
    document.querySelectorAll('.difficulty-option').forEach((el) => {
      el.addEventListener('click', () => {
        saveDifficulty(el.dataset.difficulty);
        E.difficultyDialog.close();
      });
    });
  }
  E.onlineBtn.addEventListener('click', () => {
    if (location.pathname.replace(/\/$/, '') === '/pvp') openOnline();
    else location.assign('/pvp/');
  });
  E.onlineClose.addEventListener('click', () => E.onlineDialog.close());
  E.createRoomBtn.addEventListener('click', () => connectRoom('create'));
  E.joinRoomBtn.addEventListener('click', () => connectRoom('join'));
  let touchClickAt = 0;
  E.canvas.addEventListener('pointerup', (ev) => {
    if (ev.pointerType !== 'touch') return;
    touchClickAt = Date.now();
    onClick(ev);
  });
  E.canvas.addEventListener('click', (ev) => {
    if (Date.now() - touchClickAt < 500) return;
    onClick(ev);
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && S.ws && S.ws.readyState === WebSocket.OPEN && S.online) {
      S.ws.send(JSON.stringify({ t: 'resync', lastPly: S.pub ? S.pub.ply : 0 }));
    }
  });
  window.addEventListener('resize', () => { if (S.pub) layout(); });
  updateDifficulty();
  health();
})();
