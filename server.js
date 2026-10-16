#!/usr/bin/env node
/* ============================================================
 * 妆造教学 · 本地服务 + DeepSeek API 代理
 * ------------------------------------------------------------
 *  作用一：把本目录作为静态网站托管（比 file:// 更稳定）
 *  作用二：把浏览器发来的 /v1/chat/completions 请求转发到
 *          DeepSeek 官方接口，并补上 CORS 响应头，
 *          从而绕开浏览器跨域限制。
 *
 *  用法：  node server.js        （或双击 start.bat）
 *  然后浏览器打开：http://127.0.0.1:8787
 *
 *  API Key 有两种提供方式（任选其一）：
 *   1) 在网页「设置」里填写（保存在浏览器本地，随请求转发）
 *   2) 启动前设置环境变量 DEEPSEEK_API_KEY，无需在网页填写
 * ============================================================ */
'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const PORT = Number(process.env.PORT || 8787);
const ROOT = __dirname;
const API_HOST = 'api.deepseek.com';
const ENV_KEY = process.env.DEEPSEEK_API_KEY || '';
const MAX_BODY = 64 * 1024 * 1024;      // 单请求上限 64MB（base64 图片可能较大）
const UPSTREAM_TIMEOUT = 180000;        // 上游超时 180s

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8'
};

function log() {
  const args = Array.prototype.slice.call(arguments);
  console.log('[' + new Date().toLocaleTimeString('zh-CN') + '] ' + args.join(' '));
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type, x-requested-with');
  res.setHeader('Access-Control-Max-Age', '86400');
}

/* ---------------- 静态文件 ---------------- */
function serveStatic(pathname, res) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.normalize(path.join(ROOT, rel));

  // 防目录穿越
  if (filePath !== ROOT && !filePath.startsWith(ROOT + path.sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('403 Forbidden');
    return;
  }

  fs.readFile(filePath, function (err, data) {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found: ' + rel);
      return;
    }
    const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    // 本地开发：禁止缓存，避免改了代码浏览器还在跑旧版本
    res.writeHead(200, {
      'Content-Type': type,
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0'
    });
    res.end(data);
  });
}

/* ---------------- DeepSeek 代理 ---------------- */
function handleProxy(req, res, pathname) {
  const chunks = [];
  let size = 0;
  let tooBig = false;

  req.on('data', function (c) {
    size += c.length;
    if (size > MAX_BODY) {
      tooBig = true;
      res.writeHead(413, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: { message: '请求体过大（超过 ' + Math.round(MAX_BODY / 1048576) + 'MB），请压缩图片后再试。' } }));
      req.destroy();
      return;
    }
    chunks.push(c);
  });

  req.on('end', function () {
    if (tooBig) return;

    const body = Buffer.concat(chunks);

    // 优先使用浏览器传来的 Key，其次使用环境变量
    let auth = req.headers['authorization'];
    let keySource = '浏览器设置';
    if (!auth && ENV_KEY) {
      auth = 'Bearer ' + ENV_KEY;
      keySource = '环境变量 DEEPSEEK_API_KEY';
    }

    const headers = {
      'Content-Type': req.headers['content-type'] || 'application/json',
      'Content-Length': body.length
    };
    if (auth) headers['Authorization'] = auth;

    // /v1/chat/completions -> /chat/completions
    const upstreamPath = pathname.replace(/^\/v1(?=\/)/, '') || '/chat/completions';

    log('→ 转发 ' + upstreamPath + '  ' + Math.round(body.length / 1024) + 'KB  Key来源: ' + (auth ? keySource : '无（未配置）'));

    const preq = https.request({
      hostname: API_HOST,
      port: 443,
      path: upstreamPath,
      method: 'POST',
      headers: headers
    }, function (pres) {
      log('← 上游返回 HTTP ' + pres.statusCode);
      res.writeHead(pres.statusCode, {
        'Content-Type': pres.headers['content-type'] || 'application/json; charset=utf-8'
      });
      pres.pipe(res);
    });

    preq.setTimeout(UPSTREAM_TIMEOUT, function () {
      preq.destroy(new Error('上游响应超时（' + (UPSTREAM_TIMEOUT / 1000) + 's）'));
    });

    preq.on('error', function (e) {
      log('✗ 转发失败: ' + e.message);
      if (res.headersSent) { res.end(); return; }
      res.writeHead(502, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: { message: '代理转发到 DeepSeek 失败：' + e.message } }));
    });

    preq.write(body);
    preq.end();
  });
}

/* ---------------- 全网找同款（本地版） ----------------
 * 与 functions/api/search.js 保持同一套逻辑：
 *   ① B 站视频搜索（无需 Key，国内可用，对化妆教程最有用）
 *   ② Bing 官方 API（设了 BING_SEARCH_KEY 才启用，最稳）
 *   ③ DuckDuckGo HTML（无需 Key 的通用兜底；注意国内不可达）
 * 本地开发想把网页源跑通就配 BING_SEARCH_KEY：
 *    set BING_SEARCH_KEY=xxxx && node server.js
 */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36';
let biliCookie = '';
let biliCookieAt = 0;

function decodeEntities(s) {
  return String(s || '')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&#x27;/gi, "'")
    .replace(/&#(\d+);/g, function (m, d) { return String.fromCharCode(parseInt(d, 10)); })
    .replace(/&#x([0-9a-f]+);/gi, function (m, h) { return String.fromCharCode(parseInt(h, 16)); })
    .replace(/\s+/g, ' ').trim();
}

function playText(n) {
  const v = Number(n) || 0;
  if (v >= 100000000) return (v / 100000000).toFixed(1).replace(/\.0$/, '') + '亿';
  if (v >= 10000) return (v / 10000).toFixed(1).replace(/\.0$/, '') + '万';
  return String(v);
}

/* ① B 站：先拿 buvid3 cookie（缓存 30 分钟），再查 all/v2 */
async function getBiliCookie() {
  if (biliCookie && Date.now() - biliCookieAt < 30 * 60 * 1000) return biliCookie;
  try {
    const r = await fetch('https://www.bilibili.com/', { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10000) });
    const raw = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
    const c = raw.map(function (x) { return String(x).split(';')[0]; }).join('; ');
    if (c) { biliCookie = c; biliCookieAt = Date.now(); }
  } catch (e) { /* 拿不到就用空 cookie 试 */ }
  return biliCookie;
}

async function viaBiliLocal(q, n) {
  const cookie = await getBiliCookie();
  const url = 'https://api.bilibili.com/x/web-interface/search/all/v2?page=1&keyword=' + encodeURIComponent(q);
  const r = await fetch(url, {
    headers: { 'User-Agent': UA, 'Referer': 'https://search.bilibili.com/', 'Cookie': cookie, 'Accept': 'application/json, text/plain, */*' },
    signal: AbortSignal.timeout(10000)
  });
  if (!r.ok) throw new Error('bili ' + r.status);
  const j = await r.json();
  if (j.code !== 0) throw new Error('bili code ' + j.code);
  const groups = (j.data && j.data.result) || [];
  let vids = [];
  groups.forEach(function (g) { if (g.result_type === 'video') vids = g.data || []; });
  return vids.slice(0, n).map(function (v) {
    return {
      src: 'bilibili',
      title: decodeEntities(v.title),
      url: 'https://www.bilibili.com/video/' + v.bvid + '/',
      snippet: decodeEntities(v.description || ''),
      meta: '▶ ' + playText(v.play) + ' 播放' + (v.duration ? ' · ' + v.duration : '') +
        (v.author ? ' · ' + decodeEntities(v.author) : '')
    };
  });
}

async function viaBingLocal(q, n, key) {
  const url = 'https://api.bing.microsoft.com/v7.0/search?q=' + encodeURIComponent(q) +
    '&count=' + n + '&mkt=zh-CN&setLang=zh';
  const r = await fetch(url, { headers: { 'Ocp-Apim-Subscription-Key': key }, signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error('Bing ' + r.status);
  const j = await r.json();
  return ((j.webPages && j.webPages.value) || []).map(function (it) {
    return { src: 'web', title: decodeEntities(it.name), url: it.url, snippet: decodeEntities(it.snippet), meta: '' };
  });
}

async function viaDDGLocal(q, n) {
  const r = await fetch('https://html.duckduckgo.com/html/', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': UA,
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8'
    },
    body: 'q=' + encodeURIComponent(q) + '&kl=cn-zh',
    signal: AbortSignal.timeout(8000)     // DDG 国内不可达，别让它拖满整个请求
  });
  if (!r.ok) throw new Error('DDG ' + r.status);
  const html = await r.text();
  const out = [], snips = [];
  let m;
  const reS = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
  while ((m = reS.exec(html))) snips.push(decodeEntities(m[1]));
  const reL = /<a[^>]+class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let i = 0;
  while ((m = reL.exec(html)) && out.length < n) {
    let href = m[1];
    const u = href.match(/[?&]uddg=([^&]+)/);
    if (u) { try { href = decodeURIComponent(u[1]); } catch (e) {} }
    if (href.indexOf('//') === 0) href = 'https:' + href;
    const title = decodeEntities(m[2]);
    if (title && href) out.push({ src: 'web', title: title, url: href, snippet: snips[i] || '', meta: '' });
    i++;
  }
  return out;
}

/* 带预算的并发：每个源各自跑，最慢也别超过 budgetMs；
 * 到点就返回已经完成的那些，不因某个慢源拖累整个请求。 */
async function raceAll(jobs, budgetMs) {
  const out = [];
  const tracked = jobs.map(function (p) {
    return p.then(function (r) { out.push(r); return r; });
  });
  await Promise.race([
    Promise.all(tracked),
    new Promise(function (res) { setTimeout(res, budgetMs); })
  ]);
  return out;
}

async function handleSearch(req, res) {
  const u = new URL(req.url, 'http://127.0.0.1');
  const q = (u.searchParams.get('q') || '').trim().slice(0, 120);
  const n = Math.min(10, Math.max(3, parseInt(u.searchParams.get('n') || '6', 10) || 6));
  const src = (u.searchParams.get('src') || 'auto').toLowerCase();
  const send = function (obj) {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(obj));
  };
  if (!q) { send({ error: { message: '缺少 q 参数' } }); return; }

  const key = process.env.BING_SEARCH_KEY || '';
  const force = (process.env.SEARCH_PROVIDER || '').toLowerCase();
  const errors = [];
  const jobs = [];

  const wantBili = src === 'bili' || (src !== 'web' && force !== 'force-ddg' && force !== 'force-bing');
  if (wantBili) {
    jobs.push(viaBiliLocal(q, n).catch(function (e) { errors.push('bili: ' + e.message); return []; }));
  }
  const wantWeb = src === 'web' || src !== 'bili';
  if (wantWeb) {
    const useBing = force === 'force-bing' || (!force && !!key);
    jobs.push((useBing ? viaBingLocal(q, n, key) : viaDDGLocal(q, n))
      .catch(function (e) { errors.push((useBing ? 'bing: ' : 'ddg: ') + e.message); return []; }));
  }

  const lists = await raceAll(jobs, 6000);
  let results = [];
  lists.forEach(function (l) { results = results.concat(l); });
  results.sort(function (a, b) { return (a.src === 'bilibili' ? 0 : 1) - (b.src === 'bilibili' ? 0 : 1); });
  results = results.slice(0, n);

  send({
    query: q,
    providers: results.length ? Array.from(new Set(results.map(function (x) { return x.src; }))) : [],
    results: results,
    error: results.length ? null : { message: '搜索源暂时不可用（' + errors.join('; ') + '），请用页面上的直达搜索链接。' }
  });
}

/* ---------------- 服务器 ---------------- */
const server = http.createServer(function (req, res) {
  setCors(res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const pathname = decodeURIComponent((req.url || '/').split('?')[0]);

  if (pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      ok: true,
      service: 'makeup-studio-local-proxy',
      upstream: 'https://' + API_HOST,
      keyFromEnv: !!ENV_KEY
    }));
    return;
  }

  if (pathname === '/v1/chat/completions' || pathname === '/chat/completions' ||
      pathname === '/v1/models' || pathname === '/models') {
    handleProxy(req, res, pathname);
    return;
  }

  /* 全网找同款：本地也走一遍，逻辑与 Cloudflare Function 保持一致 */
  if (pathname === '/api/search') {
    handleSearch(req, res);
    return;
  }

  serveStatic(pathname, res);
});

server.on('error', function (e) {
  if (e.code === 'EADDRINUSE') {
    console.error('\n✗ 端口 ' + PORT + ' 已被占用。');
    console.error('  可能本地服务已经在运行了，先关掉旧的窗口，或换个端口：');
    console.error('    set PORT=8899 && node server.js\n');
  } else {
    console.error('\n✗ 服务启动失败：' + e.message + '\n');
  }
  process.exit(1);
});

/* 自动打开默认浏览器（设 NO_OPEN=1 可禁用） */
function openBrowser(url) {
  if (process.env.NO_OPEN) return;
  try {
    if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch (e) { /* 打开失败时用户可手动访问 */ }
}

server.listen(PORT, '127.0.0.1', function () {
  const url = 'http://127.0.0.1:' + PORT;
  console.log('');
  console.log('  ╭──────────────────────────────────────────────╮');
  console.log('  │   妆 · 妆造教学  本地服务已启动               │');
  console.log('  ╰──────────────────────────────────────────────╯');
  console.log('');
  console.log('  网页地址：  ' + url);
  console.log('  接口代理：  ' + url + '/v1  →  https://' + API_HOST);
  console.log('  健康检查：  ' + url + '/health');
  console.log('');
  console.log('  API Key ：  ' + (ENV_KEY
    ? '已从环境变量 DEEPSEEK_API_KEY 读取（网页里可不填）'
    : '未设置环境变量；请在网页「设置」里填写 API Key'));
  console.log('');
  console.log('  用法：浏览器打开上面的网页地址 → 左侧「设置」→ 选择');
  console.log('        「DeepSeek 本地代理」→ 填 API Key → 点「测试连接」');
  console.log('');
  console.log('  按 Ctrl + C 停止服务。');
  console.log('');

  openBrowser(url);
});
