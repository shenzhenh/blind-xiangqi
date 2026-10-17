# Python 后端（只服务 PvP）

按最新架构要求：**人机对战 / 同屏双人全部在前端本地运行；只有联机 PvP 使用后端。**

- `server/engine.py`：纯 Python 3.12 规则裁判，语义与 `src/engine.js` 对齐。
  - `PublicState` 暗子只有 `origin_kind` / `origin_side`，不含真实身份。
  - `Game`：`move / undo / resign / agree_draw / public_state / oracle_world / to_json / export_text`。
- `server/app.py`：FastAPI + WebSocket 房间。
  - `GET /api/health`
  - `POST /api/games` / `GET /api/games/{id}` / `POST .../move`（HTTP 保留）
  - `WS /ws`：建房 / 加入 / 落子 / 幂等 `seq` / `resync` / 认输 / `opp.joined` / `opp.left` / `end.truth`
- `web/`：纯 PvP 零引擎 H5（`/`），只加载 `app.js` + CSS，合法着法来自 `PublicState.legal_moves`。
- `index.html` + `src/`：**服务器根 `/` 的本地 PvE / 同屏前端**，客户端自带 `engine.js` + `ai.js`。
  - 根页面 `/` 直接加载本地 PvE；`/src/*` 为它提供 engine/AI；
  - PvP 页面 `/pvp/` 自身不加载 engine/AI；`/local/` 仅兼容重定向到 `/`。
- `tests/`：74 条（66 引擎 + 6 API/静态安全 + 2 WebSocket）。

## 运行

```powershell
C:\Users\98293\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe -m pip install -r server/requirements.txt
C:\Users\98293\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe -m server.serve
```

`server.serve` 默认绑定 `0.0.0.0`，启动时会打印：

```text
PvE: http://192.168.x.x:8000/
PvP: http://192.168.x.x:8000/pvp/
```

- 同一台电脑可用 `127.0.0.1`；手机/另一台电脑必须用 **局域网 IPv4**（例如 `192.168.1.102`），不能用 `127.0.0.1`。
- 只在本机用：`python -m server.serve --host 127.0.0.1`。
- 手机打不开：Windows 防火墙需允许 Python/8000（专用网络）；确认同一 Wi‑Fi，访客 Wi‑Fi 可能隔离客户端。
- 公网部署需 HTTPS/WSS + 鉴权（Caddy/Nginx/Cloudflare Tunnel 等），当前开发服务器不要直接暴露公网。

- API 文档：<http://127.0.0.1:8000/docs>（把 `127.0.0.1` 换成局域网 IP 即可给其他机器看）。
- 页面：`/` 直接是人机首页（本地 engine/AI、同页开局）、`/pvp/` 旧 PvP 首页；`/local/` 兼容重定向到 `/`。
- `/src/*` 对本地 PvE 开放；PvP 页面自身只加载 `/app.js` + CSS，不请求 engine/AI。

## 临时公网联机（Cloudflare Tunnel，推荐）

```powershell
# 终端 1：只绑本机
python -m server.serve --host 127.0.0.1

# 终端 2：先安装 cloudflared
cloudflared tunnel --url http://127.0.0.1:8000 --no-autoupdate --protocol http2 --edge-ip-version 4
```

- 会输出 `https://xxxx.trycloudflare.com`；H5 自动用 `wss://`。
- 不需要 Cloudflare 账号；但快速隧道**无 uptime 保证**，进程关闭即失效，地址随机。
- 某些网络下 QUIC DNS 解析失败，因此使用 `--protocol http2 --edge-ip-version 4`；若仍失败，检查 DNS/代理。
- **当前开发服务器无鉴权、CORS `*`**：只把链接发给可信朋友，不要公开发布。

## 临时公网联机（localhost.run，备用）

不想买云服务器时，也可用 SSH 反向隧道：

```powershell
# 终端 1：只绑本机，避免局域网直接暴露
python -m server.serve --host 127.0.0.1

# 终端 2：localhost.run 会输出一个 https://xxxx.lhr.life 地址
ssh -R 80:127.0.0.1:8000 -o StrictHostKeyChecking=no -o ServerAliveInterval=30 -T nokey@localhost.run
```

- 必须用 `127.0.0.1`，不要用 `localhost`（Windows 可能优先解析到 IPv6，导致隧道 502）。
- HTTPS 地址可直接给外网朋友；H5 会自动用 `wss://` 连接 WebSocket。
- 免费隧道地址随机、会过期；SSH 会话关闭即断开。
- 没有账号/固定域名；需要稳定地址用 Cloudflare Tunnel 或自己的云服务器。
- **当前开发服务器无鉴权、CORS `*`**：只把链接发给可信朋友，不要公开发布，也不要传输敏感信息。

测试：

```powershell
python -m unittest discover -s server/tests -v   # 74/74
```

## 尚未实现

- 时钟、观战、完整重连 token / 宽限托管、房间 TTL。
- 当前 API 是开发切片，CORS `*`、无鉴权，公网前必须收紧。
- 后端不提供 AI；PvE 走前端 `src/ai.js`。
