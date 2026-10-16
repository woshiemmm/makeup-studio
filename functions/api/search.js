/* ============================================================
 * Cloudflare Pages Function —— /api/search
 * ------------------------------------------------------------
 * 「全网找同款」的服务端。由服务端去抓，浏览器不面对跨域。
 *
 * 三个数据源，按「对化妆教学有没有用」排序：
 *
 *   ① B 站视频搜索（默认首选，无需任何 Key）
 *      返回真实视频：标题 + BV 号 + 播放量 + 时长 + UP 主。
 *      对化妆教程来说这比通用网页结果有用得多。
 *      注意：B 站接口现在要 buvid3 cookie，所以先访问一次首页拿 cookie
 *      并缓存起来（每个实例缓存 30 分钟），不要每个请求都去拿。
 *
 *   ② Bing 官方 API（可选，最稳）
 *      在 Cloudflare Pages 里设机密 BING_SEARCH_KEY 即启用。
 *
 *   ③ DuckDuckGo HTML（无需 Key 的通用网页兜底）
 *      境外可用。注意 DDG 在国内不可达，所以国内自测时会失败 ——
 *      线上 Worker 跑在境外没问题，本地想测就配 BING_SEARCH_KEY。
 *
 * 环境变量：
 *   BING_SEARCH_KEY   选填，配了就用 Bing 官方 API
 *   SEARCH_PROVIDER   选填，force-bing / force-ddg / force-bili
 *   ACCESS_CODE       设了就要求带 x-access-code 请求头
 *   ALLOWED_ORIGIN    允许的跨域来源，默认 *
 * ============================================================ */

const WINDOW_MS = 60 * 1000;
const MAX_PER_WINDOW = 30;
const memoryHits = new Map();

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36';

/* B 站 cookie 缓存（每个 isolate 一份，30 分钟） */
let biliCookie = '';
let biliCookieAt = 0;

function corsHeaders(env) {
  return {
    'Access-Control-Allow-Origin': (env && env.ALLOWED_ORIGIN) || '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type, x-access-code',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
}

function jsonResponse(obj, status, env) {
  return new Response(JSON.stringify(obj), {
    status: status,
    headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, corsHeaders(env))
  });
}

function memoryRateLimit(ip) {
  const now = Date.now();
  const rec = memoryHits.get(ip);
  if (!rec || now > rec.reset) { memoryHits.set(ip, { count: 1, reset: now + WINDOW_MS }); return true; }
  if (rec.count >= MAX_PER_WINDOW) return false;
  rec.count++;
  return true;
}

function decodeEntities(s) {
  return String(s || '')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&#x27;/gi, "'")
    .replace(/&#(\d+);/g, function (m, d) { return String.fromCharCode(parseInt(d, 10)); })
    .replace(/&#x([0-9a-f]+);/gi, function (m, h) { return String.fromCharCode(parseInt(h, 16)); })
    .replace(/\s+/g, ' ')
    .trim();
}

function playText(n) {
  const v = Number(n) || 0;
  if (v >= 100000000) return (v / 100000000).toFixed(1).replace(/\.0$/, '') + '亿';
  if (v >= 10000) return (v / 10000).toFixed(1).replace(/\.0$/, '') + '万';
  return String(v);
}

/* ---------- ① B 站视频搜索 ---------- */
async function getBiliCookie() {
  if (biliCookie && Date.now() - biliCookieAt < 30 * 60 * 1000) return biliCookie;
  try {
    const r = await fetch('https://www.bilibili.com/', { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(10000) });
    const raw = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
    const c = raw.map(function (x) { return String(x).split(';')[0]; }).join('; ');
    if (c) { biliCookie = c; biliCookieAt = Date.now(); }
  } catch (e) { /* 拿不到就用空 cookie 试，有些节点不需要 */ }
  return biliCookie;
}

async function viaBili(q, n) {
  const cookie = await getBiliCookie();
  const url = 'https://api.bilibili.com/x/web-interface/search/all/v2?page=1&keyword=' + encodeURIComponent(q);
  const r = await fetch(url, {
    headers: {
      'User-Agent': UA,
      'Referer': 'https://search.bilibili.com/',
      'Cookie': cookie,
      'Accept': 'application/json, text/plain, */*'
    },
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
      meta: '▶ ' + playText(v.play) + ' 播放' +
        (v.duration ? ' · ' + v.duration : '') +
        (v.author ? ' · ' + decodeEntities(v.author) : '')
    };
  });
}

/* ---------- ② Bing 官方 API ---------- */
async function viaBing(q, n, env) {
  const url = 'https://api.bing.microsoft.com/v7.0/search?q=' + encodeURIComponent(q) +
    '&count=' + n + '&mkt=zh-CN&setLang=zh';
  const r = await fetch(url, { headers: { 'Ocp-Apim-Subscription-Key': env.BING_SEARCH_KEY }, signal: AbortSignal.timeout(10000) });
  if (!r.ok) throw new Error('Bing ' + r.status);
  const j = await r.json();
  return ((j.webPages && j.webPages.value) || []).map(function (it) {
    return { src: 'web', title: decodeEntities(it.name), url: it.url, snippet: decodeEntities(it.snippet), meta: '' };
  });
}

/* ---------- ③ DuckDuckGo HTML（无 Key） ---------- */
async function viaDDG(q, n) {
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
    if (u) { try { href = decodeURIComponent(u[1]); } catch (e) { /* 保持原样 */ } }
    if (href.indexOf('//') === 0) href = 'https:' + href;
    const title = decodeEntities(m[2]);
    if (title && href) out.push({ src: 'web', title: title, url: href, snippet: snips[i] || '', meta: '' });
    i++;
  }
  return out;
}

export async function onRequestOptions(context) {
  return new Response(null, { status: 204, headers: corsHeaders(context.env) });
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

export async function onRequestGet(context) {
  const { request, env } = context;

  if (env.ACCESS_CODE) {
    const got = request.headers.get('x-access-code') || '';
    if (got !== env.ACCESS_CODE) {
      return jsonResponse({ error: { code: 'ACCESS_CODE', message: '访问口令不正确' } }, 403, env);
    }
  }

  const url = new URL(request.url);
  const q = (url.searchParams.get('q') || '').trim().slice(0, 120);
  const n = Math.min(10, Math.max(3, parseInt(url.searchParams.get('n') || '6', 10) || 6));
  const src = (url.searchParams.get('src') || 'auto').toLowerCase();
  if (!q) return jsonResponse({ error: { message: '缺少 q 参数' } }, 400, env);

  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  if (!memoryRateLimit(ip)) {
    return jsonResponse({ error: { message: '请求太频繁，稍后再试' } }, 429, env);
  }

  const force = (env.SEARCH_PROVIDER || '').toLowerCase();
  const errors = [];
  const jobs = [];

  /* B 站：默认参与（国内也能用，且对化妆教程最有用） */
  const wantBili = src === 'bili' || (src !== 'web' && force !== 'force-ddg' && force !== 'force-bing');
  if (wantBili) {
    jobs.push(viaBili(q, n).catch(function (e) { errors.push('bili: ' + e.message); return []; }));
  }

  /* 网页：Bing 官方优先，否则 DDG */
  const wantWeb = src === 'web' || src !== 'bili';
  if (wantWeb) {
    const useBing = force === 'force-bing' || (!force && !!env.BING_SEARCH_KEY);
    jobs.push((useBing ? viaBing(q, n, env) : viaDDG(q, n))
      .catch(function (e) { errors.push((useBing ? 'bing: ' : 'ddg: ') + e.message); return []; }));
  }

  const lists = await raceAll(jobs, 6000);
  let results = [];
  lists.forEach(function (l) { results = results.concat(l); });

  /* B 站视频排前面 */
  results.sort(function (a, b) { return (a.src === 'bilibili' ? 0 : 1) - (b.src === 'bilibili' ? 0 : 1); });
  results = results.slice(0, n);

  return jsonResponse({
    query: q,
    providers: results.length
      ? Array.from(new Set(results.map(function (x) { return x.src; })))
      : [],
    results: results,
    error: results.length ? null : { message: '搜索源暂时不可用（' + errors.join('; ') + '），请用页面上的直达搜索链接。' }
  }, 200, env);
}
