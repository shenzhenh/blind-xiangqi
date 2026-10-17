# 验收报告 · 盲棋象棋 Blind Xiangqi

- 规格：`spec.md` **v1.11**（v1.6 Home/吃子记录；v1.7 联机；v1.8 手机 H5；v1.9 Python 后端 + AI；v1.10 分工/视角/圆标；v1.11 简化记录/无蓝闪/首页人机居中）
- 交付：规则引擎 + 圆形棋子/320ms 翻面 + 无确认交互 + **v1.9 PIMC/静止搜索/风险 AI** + 开始界面 + 常驻吃子记录 + 手机 Web 布局 + **v1.11 两组圆标吃子记录 / 金色提示 / 人机主 CTA**
- 运行环境：Node.js v24；前端零依赖；UI 测试用 jsdom 30；真实浏览器走查用 Edge headless + CDP
- 结论：**PvE/同屏前端本地运行；PvP 后端权威。JS 105 条 + Python PvP 74 条 = 179 条全绿**
- **架构**：服务器根 `/` 就是人机/同屏前端（自带 engine+AI）；联机 PvP 在 `/pvp/`。`/local/` 仅兼容重定向。
- **v1.10 体验修复**：PvP 黑方视角翻转、吃子记录圆形棋子、PvP Canvas `pointer-events:auto` + `pointerup` 触控。
- **v1.11 体验修复**：简化吃子分组、去蓝闪、PvP「行棋中」/RTT 反馈、PvE 内联深色首屏与 Canvas 防重置、首页难度按钮、顶部 AI 状态固定槽位。

> 范围声明：
> - **人机对战全部在前端**（`src/engine.js` + `src/ai.js`）；后端不提供 AI。
> - **只有联机 PvP 用后端**：Python 裁判 + PublicState/legal 表 + WebSocket 房间。
> - 时钟、观战、完整重连 token 尚未实现。
> - AI-1 只跑了子集；AI-2 / AI-3 未跑，不能声称达到 §12.5.4 的全部硬指标。

## 1. 交付清单

| 层 | 文件 | 状态 |
|---|---|---|
| 规则引擎（纯函数 + Game 封装） | `src/engine.js` | ✅ |
| PublicState / Belief 池 / 世界采样 | `src/engine.js` | ✅ |
| 视觉几何与时间轴（纯函数） | `src/visual.js` | ✅ |
| 诚实 / 全知 AI（PIMC + 静止搜索 + 风险） | `src/ai.js` | ✅ |
| Home / Canvas / 吃子记录 / 存档 / PvE 控制 | `src/ui.js` + `src/styles.css` + `index.html` | ✅ |
| 规则验收测试 | `tests/engine.test.cjs` | ✅ 54/54 |
| AI / PublicState 测试 | `tests/ai.test.cjs` | ✅ 13/13 |
| Python PvP 引擎 | `server/engine.py` + `server/tests/test_engine.py` | ✅ 66/66 |
| Python PvP API + H5 | `server/app.py` + `web/` + `server/tests/test_api.py` | ✅ 6/6 |
| Python PvP WebSocket | `server/tests/test_ws.py` | ✅ 2/2 |
| 视觉量取测试 | `tests/visual.test.cjs` | ✅ 6/6 |
| UI 集成测试 | `tests/ui.test.cjs` | ✅ 32/32 |
| M-1 自对弈基线 | `scripts/selfplay.mjs` / `results/selfplay.json` | ✅ |
| 离线渲染预览 | `scripts/render-preview.cjs` / `shots/*.png` | ✅ |

## 2. 测试结果

```text
node tests/engine.test.cjs    ℹ tests 54  ℹ pass 54  ℹ fail 0
node tests/ai.test.cjs        ℹ tests 13  ℹ pass 13  ℹ fail 0
node tests/visual.test.cjs    ℹ tests  6  ℹ pass  6  ℹ fail 0
node tests/ui.test.cjs        ℹ tests 32  ℹ pass 32  ℹ fail 0
```

Python PvP：

```text
python -m unittest discover -s server/tests -v
Ran 74 tests ... OK   (66 engine + 6 API/static + 2 websocket)
```

真实浏览器走查（Edge headless + CDP）：

| 视口 | 结果 |
|---|---|
| 1440×920 | Home → 人机对战；右侧 Feed 常驻；棋盘 661×726；无异常 |
| 1024×800 | 右侧栏 + Feed 第一块；棋盘 552×606 |
| 768×800 | 侧栏收起；棋盘下 48px Strip 常驻；棋盘 512×562；`scrollHeight=800` |
| 390×844 | 底部 sheet 断点；Strip 常驻；棋盘 368×404；无横向溢出 |
| 375×667 | 棋盘 353×387 + Strip + 底栏全部在视口内；`scrollHeight=667` |

真实点击流程：Home「人机对战」→ 棋盘 → 落子 → AI 应手；无 console 异常。

### 2.1 规则测试（54）

| 组 | 覆盖 |
|---|---|
| 开局 | T-01 ~ T-05（32 枚、30 暗、1000 seed、同 seed 复现、10000 次洗牌） |
| 暗子走法 | T-06 ~ T-12（车/仕/相/马/炮/兵） |
| 翻面 | T-13 ~ T-15 |
| 吃子 / 误伤 | T-16 ~ T-23 |
| 区域约束 | T-24 ~ T-29 |
| 边界 | T-30 ~ T-34 |
| 终局 | T-35 ~ T-39 |
| 信息安全 | T-40 ~ T-42 |
| 操作权 / 将军基准 | T-48 ~ T-56 |
| 附加 | attacksSquare 与 pseudoMoves 随机一致性、mirror/fair、perSide、strictCheck |

### 2.2 AI 测试（13）

| 用例 | 覆盖 |
|---|---|
| T-60 | `PublicState` 不含暗子 `kind/side`；`assertPublicState` 对泄露抛错 |
| Belief | 池随翻面/被吃收缩；`sampleWorld` 多重集合与池一致 |
| T-69 | 固定 seed + 局面 → 决策可复现 |
| T-70 / T-71 | 三档难度预算内返回合法着法；极端预算降级仍合法 |
| T-72 | oracle 使用真实世界并标记 |
| T-73 | AI 伪思考停顿（UI 量取） |
| T-74 | AI 执红 / 执黑均可 |
| T-75 | 30 局 × 30 手连续对战，每步合法、单步耗时不失控 |
| **T-99（子集）** | normal/hard 不放过白吃的车；**完整 40 题未跑** |
| **T-102** | `Game` 构造 / `chooseFromPublic` 对 `qdepth=0` 抛错 |
| 提示 | `suggestMove` 不改变对局 |

### 2.3 视觉测试（6）

| 用例 | 覆盖 |
|---|---|
| T-61 | 圆形；D=0.86c；H=0.10D；明暗同一几何 |
| T-62 | 暗子顶面无「?」（UI 启动断言） |
| T-63 | 走子 80/180/60，总 320ms |
| T-64 | 翻面 320ms；scaleY 1→0.10→1；overshoot ≈1.06；高光 |
| T-65 / T-76 | 90ms 边缘态；scaleY 不低于 H/D；5a/5c 单调 |
| T-66 | reduced-motion 120ms 交叉淡入 |
| T-67 | 两连音 0/90ms、70/120ms，总 ≤220ms |
| T-68 | 被动揭示走同一翻面（逐帧预览） |

### 2.4 UI 集成测试（32）

| 用例 | 覆盖 |
|---|---|
| 启动 | 32 枚、16 可操作、Canvas 绘制、暗子顶面无「?」 |
| T-77 | 冷启动 HOME；`getContext` 调用数 0；点击开始后才初始化 |
| T-78 | 人机对战 400ms 转场；无白屏 |
| T-79 | 配置写入 localStorage；摘要更新 |
| T-80 | 未完成对局继续；轮次/着法恢复 |
| T-81 | 无存档时「继续上局」隐藏（非禁用） |
| T-82 | 首访规则自动弹一次；关闭后记住 |
| T-83 | Home 唯一实心主按钮 |
| T-84 | 1024 / 768 / 390 三断点吃子记录常驻（真实浏览器截图/量取） |
| T-85 | 吃子记录按红/黑吃子方分组，只显示被吃子圆标 + 数量 |
| T-86 | 误伤不在可见面板展开；aria-live 播报仍含误伤 |
| T-87 | 375×667 无页面滚动 |
| T-88 | 最多 40 条；面板内部滚动 |
| T-89 | 空态「尚无吃子」 |
| T-90 | `aria-live` 完整播报 |
| T-91 | 无「展开/查看全部」开关（代码审查） |
| M-1 | 0.55×cell 最近交叉点吸附 |
| T-43 ~ T-47 / T-52 / T-57 ~ T-59 | 选中、无确认、键盘、结算、翻面送将、可操作态 |
| T-72 / T-73 / T-74 | oracle 角标、AI 停顿、AI 执红/黑 |
| AI 回归 | 玩家吃掉暗子（820ms 动画）后 AI 继续落子 |

## 3. v1.6 / v1.8 / v1.9 实现要点

### 3.1 开始界面

- `index.html` 中 Home 与 Game 同页；`.app.home-active` 隐藏顶栏/棋盘/底栏。
- `init()` 只构建 Home、a11y 网格、规则与 live region；**不 `newGame`、不 `layout`、不 `getContext`**。
- 点击「人机对战」：`startGame()` 清除旧存档 → `newGame()` → 400ms 展开；转场结束再 `layout()`，避免 `transform: scale(.94)` 期间的临时尺寸把棋盘算小。
- 配置摘要打开底部 `#homeConfigDialog`；写 `localStorage`；首访规则在 Home 上自动弹。
- 「继续上局」只在 `bx.save.v1` 有效、状态 PLAYING 且至少 1 手时出现；恢复用 seed + 着法重放。

### 3.2 常驻吃子记录

- 桌面 `<CaptureFeed>` 是右侧栏第一块；≤1023 用棋盘下 `<CaptureStrip>`，48px，任何断点都不需要点「记录」。
- 数据源：`state.history.filter(e => e.captured)`，append-only；不单独存储第二份记录。
- 每条含：手数、攻方兵种、`⚔`、被吃方兵种、`·暗`、`⚠误伤`、`将军`；标题/长按显示坐标。
- 最新在上；220ms 推入 + 2s 琥珀高亮；误伤 3px 红色左边条。
- 最多渲染 40 条；空态「尚无吃子」；`aria-live="polite"` 播报完整句子。
- 子力差按已揭示被吃子价值累计（红吃黑为正）。

### 3.3 响应式与移动端

- ≥1024：棋盘 + 右侧栏，Feed 第一块。
- 768–1023：单列，侧栏变抽屉，Strip 常驻棋盘下。
- <768：侧栏变底部 sheet，Strip 仍常驻。
- 375×667：棋盘 353×387、Strip 48、底栏 111；`scrollHeight 667`，无纵向滚动。
- M-1：`snapPoint()` 取最近交叉点，距离 ≤0.55×cell 才落子；触屏由 `board-frame` 的 `pointerup` 处理，a11y 按钮保留键盘焦点。
- M-2：移动端按钮/选择器 ≥44px。
- M-3：`env(safe-area-inset-*)`。
- M-4：`visibilitychange` 回前台重算布局并续跑 AI。
- M-6：`touch-action: manipulation`；M-11 `100dvh`；M-12 `overscroll-behavior:none` + 棋盘 `touch-action:none`；M-13 `-webkit-touch-callout:none` + 屏蔽 contextmenu。

### 3.4 存档

```json
{ "v": 1, "seed": "...", "config": {...},
  "moves": [{"from":{"file":1,"rank":1},"to":{"file":1,"rank":2}}],
  "mode": "pve", "difficulty": "normal", "honesty": "honest",
  "humanSide": "RED", "aiSide": "BLACK", "hintsLeft": 3,
  "elapsedMs": 12345, "status": "PLAYING" }
```

- 只落盘 **seed + 着法**，不含暗子的 `kind/side`；恢复时重放。
- 每步后保存；终局/认输/求和/新局/悔到 0 手清除。
- 恢复：按 `config` 重建游戏 → 逐手 `game.move()` → 重建 snapshots → 若轮到 AI 则 `maybeAI()`。

### 3.5 AI v1.9 搜索

| 项 | 实现 |
|---|---|
| F-1 静止搜索 | 所有难度 qdepth ≥2；depth0 进入只搜吃子（被将时搜全部应将）的 quiesce；`easy/normal/hard` q=2/4/6 |
| F-2 风险 | normal `mean − 0.6σ`；hard `CVaR20`；easy 纯均值，无随机噪声 |
| F-3 共同世界 | 全部候选共用 K 个 `sampleWorld`；K=8/32/96 |
| F-4 最坏筛查 | `safeFilter` 剔除某个世界会丢车级子力的候选；三档都启用 |
| F-7 期望价值 | 未翻面棋子用 `hiddenNet`（信念池期望）计入评估；走法排序对暗子目标不读身份 |
| 难度 | easy d1/q2；normal d2/q4；hard d3/q6 迭代加深；hard 超时保留上一层结果 |
| T-102 | `Game` 构造和 `chooseFromPublic` 对 `qdepth=0` 抛错 |

实测（初始局面，单线程）：easy ≈30ms、normal ≈100ms、hard ≤1000ms；hard 视局面到 depth2–3，超时保留上一层结果。

### 3.6 前后端分工（最新）

- **PvE / 同屏（前端）**：服务器根 `/` 直接返回 `index.html`，本地加载 `engine.js` + `ai.js`，离线也可；`/local/` 兼容重定向到 `/`。
- **PvP（后端）**：
  - `server/engine.py` 纯 Python 裁判，与 `src/engine.js` 差分校验；
  - `server/app.py` 提供 `/api/*` + `WS /ws` 房间；
  - `web/` 只加载 `app.js` + CSS，不加载 engine/ai；`/src/engine.js`、`/src/ai.js` 返回 404；
  - `/src/engine.js`、`/src/ai.js` 供根 PvE 首页使用；PvP `/pvp/` 页面自身不加载它们。
- 真实 Edge：
  - `/` 首页无 PvE/hotseat 按钮，资源不含 engine/ai；
  - `/` 人机落子后本地 AI 应手，`2 半手`、无 console 异常；
  - 两个 `/` 客户端建房/加入/落子同步，`ply=1 / turn=BLACK`。
- `server/tests/`：74 条（66 引擎 + 6 API/静态 + 2 WS）。
- **未完成**：时钟、观战、完整重连 token、房间 TTL。

## 4. M-1 自对弈基线（v1.5 同口径，规则未变）

1000 局随机 + 1000 局材料贪心（不含 PIMC）：

| 指标 | 随机 | 材料贪心 |
|---|---|---|
| 红胜 / 黑胜 / 和 | 28.5% / 27.4% / 9.4% | 31.4% / 30.8% / 37.8% |
| 打满 400 半步 | 34.7% | 0% |
| 平均手数 | 263.9 半步 | 134.5 半步 |
| **翻面率** | 8.4% | 12.4% |
| **误伤率** | 19.5% | 29.6% |
| 翻面送将率 | 0.3% | 0.3% |
| seed 方差（100 × 5） | 0.164 | — |

结论：

1. 误伤机制成立（贪心 29.6%，接近 30% 阈值）。
2. 翻面率偏低（8–12%），是 §16.7 的真实风险，建议用变体规则而非改 D3。
3. 翻面送将 <1%，L3 的 `flip=false` 有效。
4. 贪心出现大量困毙（418/1000）：全局混洗下，一方可能全在对手半场而无表观可动子；这是规则后果。

## 5. 与 spec 的偏差 / 已知限制

1. **前后端分工**：PvE/同屏全部前端本地；只有联机 PvP 走后端。**时钟、观战、完整重连 token 尚未实现**。
2. **在线联机未实现**：§18 的服务端权威、房间码、WSS、重连、时钟、观战、反作弊是 M4 设计；Home 的「联机对战」是明确占位。
3. **PWA / Capacitor 未打包**：§19 是方案；本版只做 Web 移动端布局与离线可玩。Service Worker / manifest 未加入。
4. **首屏 JS ≤150KB 未满足**：Home 延迟了 Canvas/Game 初始化，但 engine/ai/ui 仍同步加载；需后续拆包。
5. **PIMC 是“筛选 + 深搜”混合**；hard 预算 1000ms，视局面到 depth2–3，超时会保留上一层结果。
6. **AI 在主线程**，未放入 Worker；hard 思考时 UI 停顿约 1s。
7. **AI-1 只跑子集；AI-2 送子率 / AI-3 强度排序未跑**，不能声称达到 §12.5.4 全部硬指标。
8. **存档只存 seed + 着法**，本地可重建布局；不防本地逆向，适合休闲。
9. **`attackHidden.confirm='always'`** 引擎配置保留，UI 未暴露；默认严格 `none`。
10. **计时器 / 中文记谱 / 棋谱导入导出**未实现；顶栏只显示总用时。
11. **T-32 / T-51 合成局面**：标准几何下暗子无法攻击九宫内的将帅（0 例枚举）。
12. **`evaluateStatus` 只评估轮到走棋的一方**；**`balance='fair'` 按双方半场强子数差 ≤2 实现**。
13. **T-94 长按标记菜单 / T-95-T-96 在线 resync 与弱网重连**未完成。

## 6. 建议的下一步

1. **PvP 收尾**：时钟、观战、完整重连 token/宽限托管、房间 TTL。
2. **前端 PvE**：继续补强 JS AI（AI-2 200 局送子率、AI-3 三档秩序、AI-1 40 题）。
3. **联机**：WSS、断线宽限托管、观战延迟。
4. **PWA / 手机**：manifest + Service Worker；T-94 长按标记菜单、T-95/T-96 resync/重连。
5. **体积**：Home 首屏代码分割到 ≤150KB。
