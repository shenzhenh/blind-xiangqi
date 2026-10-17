#!/usr/bin/env node
/**
 * 本地静态服务器（仅用于浏览器打开游戏，非游戏运行依赖）
 *   node scripts/serve.mjs [port]
 * 默认 http://127.0.0.1:8080
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.argv[2] || 8080);
const HOST = '127.0.0.1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

const server = http.createServer((req, res) => {
  try {
    const url = new URL(req.url, `http://${HOST}`);
    let pathname = decodeURIComponent(url.pathname);
    if (pathname.endsWith('/')) pathname += 'index.html';
    const file = path.resolve(ROOT, '.' + pathname);
    if (!file.startsWith(ROOT + path.sep) && file !== ROOT) {
      res.writeHead(403).end('forbidden');
      return;
    }
    fs.stat(file, (err, stat) => {
      if (err || !stat.isFile()) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('404');
        return;
      }
      res.writeHead(200, {
        'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'cache-control': 'no-cache',
      });
      fs.createReadStream(file).pipe(res);
    });
  } catch (err) {
    res.writeHead(400).end('bad request');
  }
});

server.listen(PORT, HOST, () => {
  console.log(`盲棋象棋 → http://${HOST}:${PORT}/`);
});
