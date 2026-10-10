/* ============================================================
 * Cloudflare Pages Function —— /api/chat/completions
 * ------------------------------------------------------------
 * 作用：把前端的请求转发到 DeepSeek，API Key 只存在服务端环境变量里，
 *       绝不会出现在网页源码中。
 *
 * 需要在 Cloudflare Pages 项目里配置的环境变量与机密：
 *
 *   DEEPSEEK_API_KEY   必填。你的 DeepSeek API Key（设为「机密」）
 *   ACCESS_CODE        强烈建议填写。访问口令，防止陌生人盗刷你的额度
 *   ALLOWED_MODELS     选填。允许的模型，逗号分隔，默认 deepseek-flash
 *   ALLOWED_ORIGIN     选填。允许的跨域来源，默认 * ；建议填你的域名
 *   RATE_LIMIT_KV      选填。绑定一个 KV 命名空间后启用分布式限流
 *
 * 注意：Pages Functions 必须放在项目根目录的 /functions 下，
 *       不能放进静态输出目录（如 dist/）。
 * ============================================================ */

const UPSTREAM = 'https://api.deepseek.com/chat/completions';
const MAX_BODY = 32 * 1024 * 1024;   // 32MB，足够 base64 图片
const WINDOW_MS = 60 * 1000;         // 限流窗口：1 分钟
const MAX_PER_WINDOW = 20;           // 每个 IP 每窗口最多 20 次

/* 单隔离实例内的内存限流（尽力而为，重启即失效） */
const memoryHits = new Map();

function corsHeaders(env) {
  return {
    'Access-Control-Allow-Origin': (env && env.ALLOWED_ORIGIN) || '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type, x-access-code, authorization',
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

function fail(message, status, env) {
  return jsonResponse({ error: { message: message } }, status, env);
}

/* KV 限流：绑定了 RATE_LIMIT_KV 才生效 */
async function kvRateLimit(env, ip) {
  if (!env.RATE_LIMIT_KV) return null;
  const key = 'rl:' + ip;
  const raw = await env.RATE_LIMIT_KV.get(key);
  const count = raw ? parseInt(raw, 10) : 0;
  if (count >= MAX_PER_WINDOW) return false;
  // 首次写入时设置过期时间
  await env.RATE_LIMIT_KV.put(key, String(count + 1), { expirationTtl: Math.ceil(WINDOW_MS / 1000) });
  return true;
}

/* 内存限流：无需任何绑定，作为第一道防线 */
function memoryRateLimit(ip) {
  const now = Date.now();
  const rec = memoryHits.get(ip);
  if (!rec || now > rec.reset) {
    memoryHits.set(ip, { count: 1, reset: now + WINDOW_MS });
    return true;
  }
  if (rec.count >= MAX_PER_WINDOW) return false;
  rec.count++;
  return true;
}

export async function onRequestOptions(context) {
  return new Response(null, { status: 204, headers: corsHeaders(context.env) });
}

export async function onRequestPost(context) {
  const env = context.env || {};
  const request = context.request;

  /* 1. 服务端 Key 校验 */
  if (!env.DEEPSEEK_API_KEY) {
    return fail('服务端未配置 DEEPSEEK_API_KEY，请在 Cloudflare Pages 的「环境变量」中添加。', 500, env);
  }

  /* 2. 访问口令（用 403 + 机器可读的 code，方便前端静默回退到演示模式） */
  if (env.ACCESS_CODE) {
    const given = request.headers.get('x-access-code') || '';
    if (given !== env.ACCESS_CODE) {
      return jsonResponse({
        error: {
          code: 'ACCESS_CODE',
          message: '本站 AI 功能需要访问口令。请在「设置 → 访问口令」中填写。'
        }
      }, 403, env);
    }
  }

  /* 3. 限流 */
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  const kvOk = await kvRateLimit(env, ip);
  if (kvOk === false) {
    return fail('请求过于频繁，请稍后再试（每分钟上限 ' + MAX_PER_WINDOW + ' 次）。', 429, env);
  }
  if (kvOk === null && !memoryRateLimit(ip)) {
    return fail('请求过于频繁，请稍后再试（每分钟上限 ' + MAX_PER_WINDOW + ' 次）。', 429, env);
  }

  /* 4. 读取并校验请求体 */
  let raw;
  try {
    raw = await request.text();
  } catch (e) {
    return fail('读取请求体失败。', 400, env);
  }

  if (raw.length > MAX_BODY) {
    return fail('请求体过大（超过 ' + Math.round(MAX_BODY / 1048576) + 'MB），请压缩图片后再试。', 413, env);
  }

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (e) {
    return fail('请求体不是合法的 JSON。', 400, env);
  }

  /* 5. 模型白名单，防止被拿去调用贵的模型 */
  const allowed = String(env.ALLOWED_MODELS || 'deepseek-flash')
    .split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  if (!payload.model || allowed.indexOf(payload.model) === -1) {
    payload.model = allowed[0];
  }

  /* 6. 转发到 DeepSeek（始终使用服务端 Key，忽略前端传来的授权头） */
  let upstream;
  try {
    upstream = await fetch(UPSTREAM, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + env.DEEPSEEK_API_KEY
      },
      body: JSON.stringify(payload)
    });
  } catch (e) {
    return fail('转发到 DeepSeek 失败：' + (e && e.message ? e.message : e), 502, env);
  }

  const text = await upstream.text();
  return new Response(text, {
    status: upstream.status,
    headers: Object.assign({
      'Content-Type': upstream.headers.get('content-type') || 'application/json; charset=utf-8'
    }, corsHeaders(env))
  });
}

/* 其他方法统一拒绝 */
export async function onRequest(context) {
  if (context.request.method === 'OPTIONS') return onRequestOptions(context);
  if (context.request.method === 'POST') return onRequestPost(context);
  return fail('仅支持 POST 请求。', 405, context.env || {});
}
