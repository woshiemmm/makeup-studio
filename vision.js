/* ============================================================
 * vision.js — 妆容识别 / 肤质分析 / AI 接口 / 配图 SVG 渲染
 * 全部挂在 window.VISION 命名空间下，供 app.js 调用
 * ============================================================ */
window.VISION = (function () {
  'use strict';

  /* ============ 配置（localStorage 持久化） ============ */
  const CONFIG_KEY = 'makeup_ai_config_v3';
  const PROXY_BASE = 'http://127.0.0.1:8787/v1';
  const SITE_API = '/api';
  const PROVIDERS = {
    cloudflare: { base: SITE_API, model: 'deepseek-flash', type: 'openai', label: '本站服务器（Cloudflare 代理）', noKey: true },
    'deepseek-local': { base: PROXY_BASE, model: 'deepseek-flash', type: 'openai', label: 'DeepSeek 本地代理' },
    deepseek: { base: 'https://api.deepseek.com', model: 'deepseek-flash', type: 'openai', label: 'DeepSeek 官方 API（直连）' },
    openai: { base: 'https://api.openai.com/v1', model: 'gpt-4o-mini', type: 'openai', label: 'OpenAI' },
    qwen: { base: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-vl-max', type: 'openai', label: '通义千问 DashScope' },
    gemini: { base: '', model: 'gemini-1.5-flash', type: 'gemini', label: 'Google Gemini' },
    custom: { base: 'https://api.deepseek.com', model: 'deepseek-flash', type: 'openai', label: '自定义 OpenAI 兼容接口' }
  };

  /* 判断当前是否运行在「本机」环境（file:// 或 localhost） */
  function isLocalEnv() {
    try {
      if (typeof location === 'undefined') return true;
      if (location.protocol === 'file:') return true;
      const h = location.hostname;
      return h === '' || h === 'localhost' || h === '127.0.0.1' || h === '0.0.0.0';
    } catch (e) { return true; }
  }

  /* 本地版默认走本地代理；公网版默认走本站 Cloudflare 代理 */
  function defaultConfig() {
    const key = isLocalEnv() ? 'deepseek-local' : 'cloudflare';
    const d = PROVIDERS[key];
    return {
      mode: 'auto', provider: key, key: '', accessCode: '', base: d.base, model: d.model,
      detail: 'high',        // 'low' = 512×512 低精度，更省 token
      maxImageSize: 1024,    // 上传前缩放的最大边长
      maxTokens: 3000,       // 输出上限。妆容还原要返回「逐处拆解 + 分步教学」的 JSON，
                             // 800 那种老默认值会直接把它截断，所以默认给足
      cache: true            // 同一张图不重复请求
    };
  }
  function loadConfig() {
    try {
      const raw = localStorage.getItem(CONFIG_KEY);
      if (raw) {
        const cfg = Object.assign(defaultConfig(), JSON.parse(raw));
        /* 一次性迁移：老默认值是 800，而妆容还原要返回「逐处拆解 + 分步教学」的 JSON，
         * 800 会被直接截断。这个值已经确定太小，自动抬到 3000，避免用户莫名看到半截结果。 */
        if (!cfg.maxTokens || cfg.maxTokens < 3000) {
          cfg.maxTokens = 3000;
          saveConfig(cfg);
        }
        return cfg;
      }
    } catch (e) { /* ignore */ }
    return defaultConfig();
  }
  function saveConfig(cfg) {
    try { localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg)); } catch (e) { /* ignore */ }
  }

  /* ============ 图片读取 ============ */
  function fileToDataURL(file) {
    return new Promise(function (resolve, reject) {
      const r = new FileReader();
      r.onload = function () { resolve(r.result); };
      r.onerror = reject;
      r.readAsDataURL(file);
    });
  }

  /* 发送给 API 前先缩放：模型内部反正会缩到 ~1300px，原图直传纯属浪费带宽与时间 */
  function prepareForAPI(img, maxSize, quality) {
    try {
      const w = img.naturalWidth || img.width || 0;
      const h = img.naturalHeight || img.height || 0;
      if (!w || !h) return img.src || '';
      const limit = maxSize || 1024;
      // 已经足够小就不动它
      if (Math.max(w, h) <= limit) return img.src || '';
      const scale = limit / Math.max(w, h);
      const cw = Math.max(1, Math.round(w * scale));
      const ch = Math.max(1, Math.round(h * scale));
      const canvas = document.createElement('canvas');
      canvas.width = cw;
      canvas.height = ch;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, cw, ch);
      return canvas.toDataURL('image/jpeg', quality || 0.85);
    } catch (e) {
      return img.src || '';
    }
  }

  /* 结果缓存：同一张图不重复调用 API */
  const cache = new Map();
  const CACHE_MAX = 30;

  function hashString(s) {
    s = String(s == null ? '' : s);
    /* 逐字符哈希，不做抽样。
     * 以前是「每 97 个字符取一个」，两个问题：
     *   ① 短字符串只会取到第一个字符 → 不同图片算同一个键
     *   ② 长 data URL 里差异落在采样点之间也会碰撞
     * 缓存键一旦撞上，就会把别人的识别结果展示给当前用户。
     * 逐字符走一遍 4 万字符不到 1ms，这点开销换正确性是值得的。 */
    let h = 5381;
    for (let i = 0; i < s.length; i++) {
      h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    }
    return (h >>> 0).toString(36) + '_' + s.length;
  }
  function cacheGet(k) { return cache.has(k) ? cache.get(k) : null; }
  function cacheSet(k, v) {
    if (cache.size >= CACHE_MAX) {
      const first = cache.keys().next().value;
      cache.delete(first);
    }
    cache.set(k, v);
  }

  /* 把图片压成小巧的 JPEG dataURL，便于存进浏览器本地存储 */
  function compressImage(img, maxSize, quality) {
    try {
      const w = img.naturalWidth || img.width || 0;
      const h = img.naturalHeight || img.height || 0;
      if (!w || !h) return img.src || '';
      const limit = maxSize || 420;
      const scale = Math.min(1, limit / Math.max(w, h));
      const cw = Math.max(1, Math.round(w * scale));
      const ch = Math.max(1, Math.round(h * scale));
      const canvas = document.createElement('canvas');
      canvas.width = cw;
      canvas.height = ch;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';           // JPEG 无透明通道，先铺白底
      ctx.fillRect(0, 0, cw, ch);
      ctx.drawImage(img, 0, 0, cw, ch);
      return canvas.toDataURL('image/jpeg', quality || 0.72);
    } catch (e) {
      return img.src || '';
    }
  }

  /* ============ 颜色分析（演示模式核心） ============ */
  function analyzeColors(img) {
    const size = 48;
    const canvas = document.createElement('canvas');
    canvas.width = size; canvas.height = size;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;                       // 极端情况下浏览器不给 2D 上下文
    try { ctx.drawImage(img, 0, 0, size, size); }
    catch (e) { return null; }                   // 图片没加载完 / 跨域污染
    let data;
    try { data = ctx.getImageData(0, 0, size, size).data; }
    catch (e) { return null; }

    let r = 0, g = 0, b = 0, n = 0;
    let maxR = 0, maxG = 0, maxB = 0, sumSat = 0, sumVal = 0;
    const buckets = { red: 0, orange: 0, yellow: 0, green: 0, blue: 0, purple: 0, pink: 0, neutral: 0, dark: 0 };

    for (let i = 0; i < data.length; i += 4) {
      const pr = data[i], pg = data[i + 1], pb = data[i + 2];
      r += pr; g += pg; b += pb; n++;
      maxR = Math.max(maxR, pr); maxG = Math.max(maxG, pg); maxB = Math.max(maxB, pb);

      // RGB -> HSV
      const rn = pr / 255, gn = pg / 255, bn = pb / 255;
      const mx = Math.max(rn, gn, bn), mn = Math.min(rn, gn, bn);
      const d = mx - mn;
      const v = mx;
      const s = mx === 0 ? 0 : d / mx;
      let h = 0;
      if (d !== 0) {
        if (mx === rn) h = ((gn - bn) / d) % 6;
        else if (mx === gn) h = (bn - rn) / d + 2;
        else h = (rn - gn) / d + 4;
        h *= 60; if (h < 0) h += 360;
      }
      sumSat += s; sumVal += v;

      // 分桶
      const lum = (pr + pg + pb) / 3;
      if (lum < 50) { buckets.dark++; continue; }
      if (s < 0.14) { buckets.neutral++; continue; }
      if (h < 15 || h >= 345) buckets.red++;
      else if (h < 45) buckets.orange++;
      else if (h < 70) buckets.yellow++;
      else if (h < 165) buckets.green++;
      else if (h < 250) buckets.blue++;
      else if (h < 300) buckets.purple++;
      else if (h < 345) buckets.pink++;
    }

    const avg = { r: r / n, g: g / n, b: b / n };
    const avgSat = sumSat / n, avgVal = sumVal / n;
    const brightness = (avg.r + avg.g + avg.b) / 3;

    // 主色调
    let dominant = 'neutral', top = 0;
    for (const k in buckets) if (buckets[k] > top) { top = buckets[k]; dominant = k; }

    const warm = buckets.red + buckets.orange + buckets.pink + buckets.yellow;
    const cool = buckets.blue + buckets.purple + buckets.green;
    const warmRatio = warm / Math.max(1, warm + cool);

    return { avg, brightness, avgSat, avgVal, buckets, dominant, warmRatio, topCount: top };
  }

  /* ============ 颜色 → 妆容匹配（演示模式） ============ */
  /* ============ 颜色 → 妆容匹配 ============
   * 这里不写死分数表 —— 每个妆容的特征直接由它自己的调色板推导出来。
   * 好处：新增妆容（男妆 / cos 妆 / 以后再加的）会自动进入识别范围，
   *       不会出现「识别永远认不出某几类」的问题。
   */

  function hexHSV(hex) {
    let h = String(hex || '#888888').replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    const r = parseInt(h.slice(0, 2), 16) / 255 || 0;
    const g = parseInt(h.slice(2, 4), 16) / 255 || 0;
    const b = parseInt(h.slice(4, 6), 16) / 255 || 0;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    let hue = 0;
    if (d !== 0) {
      if (mx === r) hue = ((g - b) / d) % 6;
      else if (mx === g) hue = (b - r) / d + 2;
      else hue = (r - g) / d + 4;
      hue *= 60; if (hue < 0) hue += 360;
    }
    return { h: hue, s: mx === 0 ? 0 : d / mx, v: mx };
  }

  /* 分桶规则必须和 analyzeColors 完全一致，否则两边对不上 */
  function bucketOfRGB(pr, pg, pb) {
    const lum = (pr + pg + pb) / 3;
    if (lum < 50) return 'dark';
    const rn = pr / 255, gn = pg / 255, bn = pb / 255;
    const mx = Math.max(rn, gn, bn), mn = Math.min(rn, gn, bn), d = mx - mn;
    const s = mx === 0 ? 0 : d / mx;
    if (s < 0.14) return 'neutral';
    let h = 0;
    if (d !== 0) {
      if (mx === rn) h = ((gn - bn) / d) % 6;
      else if (mx === gn) h = (bn - rn) / d + 2;
      else h = (rn - gn) / d + 4;
      h *= 60; if (h < 0) h += 360;
    }
    if (h < 15 || h >= 345) return 'red';
    if (h < 45) return 'orange';
    if (h < 70) return 'yellow';
    if (h < 165) return 'green';
    if (h < 250) return 'blue';
    if (h < 300) return 'purple';
    if (h < 345) return 'pink';
    return 'neutral';
  }

  /* 妆容签名：调色板各色落在哪些桶 + 整体明度 / 饱和度 */
  const _sigCache = {};
  function lookSignature(look) {
    if (_sigCache[look.id]) return _sigCache[look.id];
    const w = {};
    let lum = 0, sat = 0;
    const pal = look.palette || [];
    pal.forEach(function (c) {
      const hsv = hexHSV(c);
      const rgb = hexToRgb(c);
      w[bucketOfRGB(rgb.r, rgb.g, rgb.b)] = (w[bucketOfRGB(rgb.r, rgb.g, rgb.b)] || 0) + 1;
      lum += (rgb.r + rgb.g + rgb.b) / 3;
      sat += hsv.s;
    });
    const n = Math.max(1, pal.length);
    const sig = { w: w, lum: lum / n, sat: sat / n, sig: look.palette && look.palette[0] };
    _sigCache[look.id] = sig;
    return sig;
  }

  /* 有些妆容调色板天然接近（比如各种粉调），靠一点点显式微调拉开差距。
   * lum: 期望明度偏移（正=更亮）；sat: 期望饱和度偏移；bias: 直接加减分。 */
  const RECO_NUDGE = {
    natural:   { lum: 10, sat: -0.05, bias: 4 },   // 裸妆：最亮最淡
    daily:     { lum: 2, bias: 2 },
    sweet:     { sat: 0.05, bias: 3 },             // 粉调最饱和的甜妆
    korean:    { lum: 14, sat: -0.02, bias: 3 },   // 水光妆：最亮
    japanese:  { lum: 8, bias: 2 },
    western:   { lum: 5, sat: -0.02, bias: 2 },    // 欧美深邃：暖棕但偏亮
    smokey:    { lum: -30, sat: 0.02, bias: 6 },   // 烟熏：暗色权重加成
    maillard:  { lum: -8, sat: 0.03, bias: 3 },    // 美拉德：同是暖棕，但更深更浓
    chinese:   { sat: 0.06, bias: 3 },             // 正红
    mens_base: { lum: 6, sat: -0.08, bias: 3 },    // 男妆整体低饱和
    mens_bone: { lum: -4, sat: -0.04, bias: 2 },
    mens_eye:  { lum: 4, sat: -0.06, bias: 2 },
    cos_anime: { sat: 0.08, bias: 4 },             // 二次元：高饱和
    cos_guofeng: { sat: 0.03, bias: 2 },
    cos_idol:  { sat: 0.10, bias: 4 },             // 舞台：饱和度最高
    cos_shonen: { lum: 8, sat: -0.07, bias: 3 },   // 少年感：接近男妆但更干净
    cos_dark:  { lum: -34, sat: -0.02, bias: 7 }   // 暗黑：最暗
  };

  function matchLookByColor(analysis) {
    if (!analysis) return null;
    const looks = (typeof window !== 'undefined' && window.MAKEUP_DATA && window.MAKEUP_DATA.looks) || [];
    if (!looks.length) return null;

    const b = analysis.buckets;
    const total = Math.max(1, Object.keys(b).reduce(function (a, k) { return a + b[k]; }, 0));
    const ratio = function (k) { return (b[k] || 0) / total; };
    const imgLum = (analysis.avg.r + analysis.avg.g + analysis.avg.b) / 3;

    const scored = looks.map(function (look) {
      const sg = lookSignature(look);
      const nd = RECO_NUDGE[look.id] || {};
      let wSum = 0, hit = 0;
      for (const k in sg.w) { hit += sg.w[k] * ratio(k); wSum += sg.w[k]; }
      hit = wSum ? hit / wSum : 0;

      // ① 签名色命中（图上有没有这款妆的代表色）
      let score = hit * 100 * 0.56;

      // ② 明度贴合（暗妆 / 亮妆分得开）
      const wantLum = sg.lum + (nd.lum || 0);
      const lumFit = Math.max(0, 1 - Math.abs(imgLum - wantLum) / 105);
      score += lumFit * 100 * 0.26;

      // ③ 饱和贴合（裸妆 vs 舞台妆）
      const wantSat = Math.max(0, sg.sat + (nd.sat || 0));
      const satFit = Math.max(0, 1 - Math.abs(analysis.avgSat - wantSat) / 0.5);
      score += satFit * 100 * 0.18;

      // ④ 暗色妆容额外看 dark 占比
      const darkW = (sg.w.dark || 0) / Math.max(1, wSum);
      if (darkW > 0) score += ratio('dark') * 55 * darkW;

      // ⑤ 中性色占比对裸妆 / 男妆有加成
      if (sg.w.neutral) score += ratio('neutral') * 22 * (sg.w.neutral / Math.max(1, wSum));

      /* ⑥ 反向惩罚：图上明显存在的色，这款妆的签名里却没有 → 说明不像。
       *    没有这条的话，「签名只有橙色」的妆容会把任何橙色偏多的图都抢走。 */
      let miss = 0;
      for (const k in b) {
        const rr = ratio(k);
        if (rr > 0.08 && !sg.w[k]) miss += rr;
      }
      score -= miss * 100 * 0.30;

      score += (nd.bias || 0);
      return { lookId: look.id, score: score };
    });

    scored.sort(function (a, b2) { return b2.score - a.score; });
    const best = scored[0];
    const second = scored[1];
    if (!best) return null;

    // 置信度：不光看绝对分，也看和第二名的差距
    const gap = best.score - (second ? second.score : 0);
    const confidence = Math.min(0.96, Math.max(0.40,
      0.34 + best.score / 220 + Math.min(0.22, gap / 90)));

    return {
      lookId: best.lookId,
      confidence: confidence,
      reason: describeColors(analysis),
      analysis: analysis,
      ranked: scored.slice(0, 4)
    };
  }

  function describeColors(analysis) {
    const map = { red: '正红/酒红', orange: '橘橙/古铜', yellow: '金黄', green: '绿色调', blue: '蓝紫色调', purple: '紫色调', pink: '粉色/玫瑰', neutral: '低饱和自然色', dark: '深色/暗调' };
    const warmCool = analysis.warmRatio > 0.6 ? '暖调' : (analysis.warmRatio < 0.4 ? '冷调' : '中性调');
    const brightDesc = analysis.brightness > 180 ? '明亮' : (analysis.brightness < 90 ? '偏暗' : '中等亮度');
    return '主色调为「' + (map[analysis.dominant] || analysis.dominant) + '」，整体呈' + warmCool + '、' + brightDesc + '，饱和度' + (analysis.avgSat > 0.45 ? '较高' : (analysis.avgSat > 0.2 ? '适中' : '偏低')) + '。';
  }

  /* ============ 肤质分析（演示模式规则引擎） ============ */
  /* ============ 从照片推断肤质倾向（仅作参考，不能替代自测） ============
   * 说明：照片的明暗受拍摄光线影响很大，所以这里只给「倾向」和「依据」，
   * 不下确定结论。真正可靠的判断还是要靠洗脸测试法。
   */
  function inferSkinFromImage(a) {
    if (!a || !a.buckets) return null;
    const b = a.buckets;
    const total = Math.max(1, Object.values(b).reduce(function (x, y) { return x + y; }, 0));
    const redShare = (b.red + b.pink) / total;
    const bright = a.brightness;
    const sat = a.avgSat;

    const signals = [];
    const score = { oily: 0, dry: 0, combo: 0, normal: 0, sensitive: 0 };

    // ① 红色调占比 → 泛红 / 敏感倾向
    if (redShare > 0.38) {
      score.sensitive += 3;
      signals.push('照片中红色调占 ' + Math.round(redShare * 100) + '%，明显偏高，可能有泛红或红血丝倾向');
    } else if (redShare > 0.25) {
      score.sensitive += 1.5;
      signals.push('照片中红色调占 ' + Math.round(redShare * 100) + '%，略偏多，可能有轻度泛红');
    } else {
      signals.push('照片中红色调占 ' + Math.round(redShare * 100) + '%，属于正常范围，泛红迹象不明显');
    }

    // ② 整体亮度 → 高光反射（偏油）或暗沉（偏干）
    if (bright > 195) {
      score.oily += 3; score.combo += 1;
      signals.push('照片整体很亮（亮度 ' + Math.round(bright) + '），高光反射明显，皮肤可能偏油亮');
    } else if (bright > 172) {
      score.oily += 1.5; score.combo += 1.5; score.normal += 1;
      signals.push('照片亮度中等偏高（' + Math.round(bright) + '），可能有自然光泽，油水平衡尚可');
    } else if (bright < 108) {
      score.dry += 3; score.normal -= 1;
      signals.push('照片整体偏暗（亮度 ' + Math.round(bright) + '），可能偏干或存在暗沉（也受拍摄光线影响）');
    } else if (bright < 138) {
      score.dry += 1.5; score.combo += 1;
      signals.push('照片亮度中等偏低（' + Math.round(bright) + '），皮肤光泽度一般');
    } else {
      score.normal += 2; score.combo += 1;
      signals.push('照片亮度适中（' + Math.round(bright) + '），肤感看起来比较均衡');
    }

    // ③ 饱和度 → 暗沉缺水
    if (sat < 0.15) {
      score.dry += 2;
      signals.push('照片色彩偏灰（饱和度 ' + sat.toFixed(2) + '），可能缺水或暗沉');
    } else if (sat > 0.42) {
      score.sensitive += 1;
      signals.push('照片色彩饱和度偏高（' + sat.toFixed(2) + '），可能与泛红叠加有关');
    } else {
      signals.push('照片色彩饱和度正常（' + sat.toFixed(2) + '）');
    }

    // 选出得分最高的倾向
    let guess = 'normal', top = -99;
    ['oily', 'dry', 'combo', 'normal', 'sensitive'].forEach(function (k) {
      if (score[k] > top) { top = score[k]; guess = k; }
    });

    // 置信度：看第一名和第二名的差距
    const sorted = Object.keys(score).map(function (k) { return score[k]; }).sort(function (x, y) { return y - x; });
    const gap = (sorted[0] || 0) - (sorted[1] || 0);
    const confidence = gap >= 2.5 ? '较明显' : (gap >= 1 ? '一般' : '不明显');

    return {
      guess: guess,
      score: score,
      confidence: confidence,
      signals: signals,
      caveat: '照片推断只能作为参考 —— 拍摄光线、妆容、滤镜都会影响结果。最可靠的还是上面的「洗脸测试法」，建议实测一次再和照片结论对照。'
    };
  }

  /* ============ 问卷完整性检查 ============ */
  const QUIZ_LABELS = {
    skinType: '肤质类型', undertone: '肤色基调', depth: '肤色深浅',
    concerns: '肌肤困扰', sensitive: '是否敏感', climate: '当前气候'
  };

  function checkQuizCompleteness(answers) {
    const a = answers || {};
    const missing = [];
    Object.keys(QUIZ_LABELS).forEach(function (k) {
      const v = a[k];
      const empty = (v === undefined || v === null || v === '' ||
        (Array.isArray(v) && v.length === 0));
      if (empty) missing.push(QUIZ_LABELS[k]);
    });
    // 选了「不确定」不算缺失，但需要标记出来单独说明
    const unsure = [];
    if (a.skinType === 'unknown') unsure.push('肤质类型（你选了不确定，我们会用照片推断 + 提供自测方法）');
    if (a.undertone === 'unsure') unsure.push('肤色基调');
    if (a.depth === 'unsure') unsure.push('肤色深浅');
    return { missing: missing, unsure: unsure, complete: missing.length === 0 };
  }

  function analyzeSkinByRules(answers, faceAnalysis) {
    const R = window.MAKEUP_DATA.skinRules;
    const a = answers || {};

    // ① 照片推断（无论用户是否填了肤质都算，用来做交叉验证）
    const infer = inferSkinFromImage(faceAnalysis);

    // ② 确定最终肤质：用户说了就以用户为准；选「不确定」或没填就用照片推断
    let skinTypeId = a.skinType;
    let inferred = false;
    if (!skinTypeId || skinTypeId === 'unknown') {
      skinTypeId = (infer && infer.guess) || 'normal';
      inferred = true;
    }

    // ③ 问卷完整性
    const completeness = checkQuizCompleteness(a);

    const out = {
      skinType: R.skinType[skinTypeId] || R.skinType.normal,
      skinTypeId: skinTypeId,
      inferred: inferred,                 // 肤质是否来自照片推断
      infer: infer,                       // 照片推断的完整结果
      completeness: completeness,         // 缺失项
      undertone: R.undertone[a.undertone] || '',
      depth: R.depth[a.depth] || '',
      concerns: (a.concerns || []).map(function (c) { return R.concerns[c]; }).filter(Boolean),
      sensitive: R.sensitive[a.sensitive] || '',
      climate: R.climate[a.climate] || '',
      image: null
    };

    // ④ 图片明暗/泛红做补充（沿用原有逻辑，并补充与照片推断的对照）
    if (faceAnalysis) {
      const extra = [];
      if (faceAnalysis.brightness < 105) extra.push('照片整体偏暗，可能存在肤色暗沉，建议妆前用提亮妆前/紫色隔离提气色。');
      if (faceAnalysis.brightness > 200) extra.push('照片整体偏亮，肤感通透，妆容可保持清透光泽。');
      if (faceAnalysis.buckets.red + faceAnalysis.buckets.pink > 0) {
        const redShare = (faceAnalysis.buckets.red + faceAnalysis.buckets.pink) / Math.max(1, Object.values(faceAnalysis.buckets).reduce(function (x, y) { return x + y; }, 0));
        if (redShare > 0.4) extra.push('照片红色调明显，若有泛红/红血丝，可用绿色妆前或绿色遮瑕局部中和。');
      }
      if (faceAnalysis.avgSat < 0.18) extra.push('照片色彩偏灰，皮肤可能显暗沉，建议加强补水与提亮。');

      // 照片推断与用户自述不一致时，明确提示
      if (!inferred && infer && infer.guess !== skinTypeId && infer.confidence !== '不明显') {
        const nameOf = { oily: '油性', dry: '干性', combo: '混合', normal: '中性', sensitive: '敏感' };
        extra.push('⚠️ 注意：你自述是「' + nameOf[skinTypeId] + '」，但照片观感更接近「' + nameOf[infer.guess] +
          '」。建议用下面的「洗脸测试法」实测一次 —— 如果两者不符，以实测为准。');
      }
      out.image = extra;
    }
    return out;
  }

  /* ============ AI 接口调用 ============ */
  // Key 存在服务端的供应商（如 Cloudflare 代理）不需要浏览器提供 Key
  function hasApi(cfg) {
    if (!cfg || !cfg.model) return false;
    const p = PROVIDERS[cfg.provider];
    if (p && p.noKey) return true;
    return !!cfg.key;
  }
  function isLocalProxy(cfg) { return !!(cfg && cfg.provider === 'deepseek-local'); }
  function needsBrowserKey(cfg) {
    const p = PROVIDERS[cfg && cfg.provider];
    return !(p && p.noKey);
  }

  function authHeaders(cfg) {
    const h = { 'Content-Type': 'application/json' };
    if (cfg.key) h['Authorization'] = 'Bearer ' + cfg.key;
    if (cfg.accessCode) h['x-access-code'] = cfg.accessCode;
    return h;
  }

  async function safeText(res) {
    try { return (await res.text()).slice(0, 300); } catch (e) { return ''; }
  }

  function apiBase(cfg) {
    const provider = PROVIDERS[cfg.provider] || PROVIDERS.custom;
    return (cfg.base || provider.base || '').replace(/\/+$/, '');
  }

  // 统一的 POST：把网络 / CORS / 鉴权失败翻译成可操作的中文提示
  async function postJSON(url, headers, body) {
    let res;
    try {
      res = await fetch(url, { method: 'POST', headers: headers, body: JSON.stringify(body) });
    } catch (e) {
      const raw = (e && e.message) ? e.message : String(e);
      let hint;
      if (/^\/api\//.test(url) || /\/api\/chat\/completions$/.test(url)) {
        hint = '本站 API 代理不可用。请确认已把 functions 目录一起部署到 Cloudflare Pages（Functions 不支持控制台拖拽上传，需用 Git 集成或 Wrangler）。';
      } else if (/127\.0\.0\.1|localhost/.test(url)) {
        hint = '本地代理未启动。请先双击 start.bat 启动本地服务（默认 http://127.0.0.1:8787），再重试。';
      } else {
        hint = '可能是网络不可达（DeepSeek 官方接口支持浏览器直连，通常不是跨域问题），或 API Key 无效。若所在网络受限，可改用「本站服务器」或「DeepSeek 本地代理」。';
      }
      throw new Error('无法连接接口：' + hint + '［' + raw + '］');
    }
    const text = await res.text();
    if (!res.ok) {
      let msg = text, code = '';
      try {
        const j = JSON.parse(text);
        if (j && j.error) {
          msg = j.error.message || j.error;
          code = j.error.code || '';
        }
      } catch (e2) { /* 保留原始文本 */ }
      const tip = res.status === 401 ? '（API Key 无效或未填写）'
        : res.status === 402 ? '（账户余额不足）'
        : res.status === 429 ? '（请求过于频繁，请稍后重试）'
        : res.status === 404 ? '（接口地址或模型名不正确）' : '';
      const err = new Error('接口返回 HTTP ' + res.status + tip + '：' + String(msg).slice(0, 300));
      err.code = code;
      err.status = res.status;
      throw err;
    }
    try { return JSON.parse(text); }
    catch (e3) { throw new Error('接口未返回合法 JSON：' + String(text).slice(0, 200)); }
  }

  async function callVisionAPI(imageDataURL, prompt, cfg, opts) {
    if (!cfg) cfg = loadConfig();
    opts = opts || {};
    const provider = PROVIDERS[cfg.provider] || PROVIDERS.custom;
    const maxOut = opts.maxTokens || cfg.maxTokens || 3000;

    if (provider.type === 'gemini') {
      const url = 'https://generativelanguage.googleapis.com/v1beta/models/' +
        encodeURIComponent(cfg.model) + ':generateContent?key=' + encodeURIComponent(cfg.key);
      const mime = (imageDataURL.match(/^data:([^;]+);/) || [])[1] || 'image/jpeg';
      const json = await postJSON(url, { 'Content-Type': 'application/json' }, {
        contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: mime, data: imageDataURL.split(',')[1] } }] }],
        generationConfig: { maxOutputTokens: maxOut, temperature: 0.3 }
      });
      try {
        return {
          text: json.candidates[0].content.parts.map(function (p) { return p.text || ''; }).join('\n'),
          usage: json.usageMetadata || null
        };
      } catch (e) { throw new Error('Gemini 返回格式异常'); }
    }

    // OpenAI 兼容协议：DeepSeek / OpenAI / 通义千问 / 本地代理 / 本站代理 均走这里
    const imgPayload = { url: imageDataURL };
    if (cfg.detail === 'low') imgPayload.detail = 'low';   // 低精度：缩到 512×512，更省 token

    const json = await postJSON(apiBase(cfg) + '/chat/completions', authHeaders(cfg), {
      model: cfg.model,
      messages: [{ role: 'user', content: [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: imgPayload }
      ]}],
      max_tokens: maxOut, temperature: 0.3
    });
    try {
      return {
        text: json.choices[0].message.content,
        usage: json.usage || null
      };
    } catch (e) { throw new Error('接口返回格式异常，请确认模型支持图片输入（DeepSeek 请使用 deepseek-flash）。'); }
  }

  /* ============ 连接测试（设置页用） ============ */
  /* 生成一张纯红色圆点的测试图，用来验证模型是否真的「看得见」 */
  function makeTestImage() {
    try {
      const c = document.createElement('canvas');
      c.width = 96; c.height = 96;
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, 96, 96);
      ctx.fillStyle = '#e0334f';
      ctx.beginPath();
      ctx.arc(48, 48, 32, 0, Math.PI * 2);
      ctx.fill();
      return c.toDataURL('image/png');
    } catch (e) { return ''; }
  }

  async function testConnection(cfg) {
    if (!cfg) cfg = loadConfig();
    const provider = PROVIDERS[cfg.provider] || PROVIDERS.custom;
    const started = Date.now();

    if (provider.type === 'gemini') {
      const url = 'https://generativelanguage.googleapis.com/v1beta/models/' +
        encodeURIComponent(cfg.model) + ':generateContent?key=' + encodeURIComponent(cfg.key);
      const json = await postJSON(url, { 'Content-Type': 'application/json' }, { contents: [{ parts: [{ text: 'ping' }] }] });
      const ok = !!(json.candidates && json.candidates[0]);
      return { ok: ok, ms: Date.now() - started, detail: ok ? 'Gemini 响应正常' : 'Gemini 返回结构异常' };
    }

    // 带上测试图，顺带验证「图片输入」是否被支持
    const testImg = makeTestImage();
    const messages = testImg ? [{
      role: 'user',
      content: [
        { type: 'text', text: '这张图里主要是什么颜色？只回答颜色名称，不要解释。' },
        { type: 'image_url', image_url: { url: testImg } }
      ]
    }] : [{ role: 'user', content: '请回复：连接成功' }];

    const json = await postJSON(apiBase(cfg) + '/chat/completions', authHeaders(cfg),
      { model: cfg.model, messages: messages, max_tokens: 64 });

    const msg = (json.choices && json.choices[0] && json.choices[0].message) || {};
    const reply = String(msg.content || '').trim();
    const usage = json.usage ? ('，消耗 ' + (json.usage.total_tokens || '?') + ' tokens') : '';
    const visionOk = testImg ? /红|red|红红/i.test(reply) : false;

    let detail;
    if (testImg && visionOk) {
      detail = '连接正常，且图片识别可用 ✅（模型认出测试图是' + reply.slice(0, 8) + '）';
    } else if (testImg && reply) {
      detail = '连接正常，但图片识别可能有问题（模型回答「' + reply.slice(0, 20) +
        '」，未识别出红色）。请确认模型是 deepseek-flash 这类支持图片的模型。';
    } else if (testImg) {
      detail = '连接正常（模型已响应，但未返回文字内容，可能是思考型模型的正常表现）';
    } else {
      detail = '连接正常' + (reply ? '，模型回复：「' + reply.slice(0, 20) + '」' : '');
    }

    return { ok: true, visionOk: visionOk, visionTested: !!testImg, ms: Date.now() - started, detail: detail + usage };
  }

  /* ============ 妆容识别（整合 API + 演示） ============ */
  // 返回 { mode: 'api'|'demo', lookId, confidence, reason, apiText, analysis }
  /* ============================================================
   * 妆容还原：把一张图拆解到「能照着复刻」的程度
   * ------------------------------------------------------------
   * 和以前最大的区别：不再只是「判断属于哪一类」，
   * 而是逐处给出颜色、位置、形状、质地、层次，并据此生成
   * 一套只属于这张图的跟练步骤。
   * ============================================================ */

  /* 扫描出从 start 开始的第一个「括号配平」的 JSON 片段 */
  function scanBalanced(s, start) {
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < s.length; i++) {
      const c = s[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}') {
        depth--;
        if (depth === 0) return s.slice(start, i + 1);
      }
    }
    return null;   // 没找到配平点 —— 说明被截断了
  }

  /* 抢救被 max_tokens 截断的半截 JSON。
   * 做法：先按括号栈补上收尾，再从末尾往前逐段回退，直到能 parse 为止。
   * 这样即使模型话没说完，前面的字段也还能用上，不至于整块界面空白。 */
  function repairTruncated(frag) {
    const closeAll = function (str) {
      let inStr = false, esc = false;
      const stack = [];
      for (let i = 0; i < str.length; i++) {
        const c = str[i];
        if (inStr) {
          if (esc) esc = false;
          else if (c === '\\') esc = true;
          else if (c === '"') inStr = false;
          continue;
        }
        if (c === '"') inStr = true;
        else if (c === '{') stack.push('}');
        else if (c === '[') stack.push(']');
        else if (c === '}' || c === ']') stack.pop();
      }
      let out = str;
      if (inStr) out += '"';                       // 停在半个字符串里
      if (/:\s*$/.test(out)) out += 'null';        // 停在 "key": 后面
      else if (/,\s*$/.test(out)) out = out.replace(/,\s*$/, '');
      while (stack.length) out += stack.pop();
      return out;
    };

    let s = frag.trim();
    for (let attempt = 0; attempt < 14 && s.length > 20; attempt++) {
      const t = closeAll(s);
      try {
        const v = JSON.parse(t);
        if (v && typeof v === 'object') return v;
      } catch (e) { /* 继续回退 */ }
      /* 回退到上一个逗号或左括号，砍掉不完整的尾巴 */
      let cut = s.lastIndexOf(',');
      const cut2 = Math.max(s.lastIndexOf('{'), s.lastIndexOf('['));
      if (cut2 > cut) cut = cut2;                  // 让 cut 取更靠后的那个
      if (cut <= 0) break;
      s = s.slice(0, cut);
    }
    return null;
  }

  /* 从模型回复里抠 JSON：容忍 ```json 包裹、前后废话、字符串里的括号，
   * 以及「被截断」的半截 JSON。返回 { data, repaired }。 */
  function parseModelJSON(text) {
    if (!text) return { data: null, repaired: false };
    let s = String(text).trim();
    const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) s = fence[1].trim();
    s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');

    try { return { data: JSON.parse(s), repaired: false }; } catch (e) { /* 继续 */ }

    const start = s.indexOf('{');
    if (start < 0) return { data: null, repaired: false };

    const balanced = scanBalanced(s, start);
    if (balanced) {
      try { return { data: JSON.parse(balanced), repaired: false }; } catch (e) { /* 继续 */ }
    }
    const fixed = repairTruncated(s.slice(start));
    if (fixed) return { data: fixed, repaired: true };
    return { data: null, repaired: false };
  }

  /* 兼容旧调用点 */
  function extractJSON(text) { return parseModelJSON(text).data; }

  function str(v, def) { return (typeof v === 'string' && v.trim()) ? v.trim() : (def || ''); }
  function arr(v) { return Array.isArray(v) ? v : []; }

  /* 把模型给的还原结果规整成固定结构，缺字段也不会让界面崩 */
  function normalizeRestore(raw, analysis) {
    if (!raw) return null;
    const o = raw.restore || raw;
    const rgbOf = function (x) {
      const m = String(x || '').match(/#?([0-9a-fA-F]{6})/);
      return m ? '#' + m[1].toLowerCase() : '';
    };
    const shadows = arr(o.eye && o.eye.shadows).map(function (s) {
      return {
        color: str(s.color, '未说明'),
        hex: rgbOf(s.hex),
        where: str(s.where),
        texture: str(s.texture)
      };
    }).slice(0, 5);

    return {
      styleName: str(o.styleName, '未命名妆容'),
      summary: str(o.summary),
      vibe: str(o.vibe),
      skin: {
        finish: str(o.skin && o.skin.finish), coverage: str(o.skin && o.skin.coverage),
        shade: str(o.skin && o.skin.shade), detail: str(o.skin && o.skin.detail)
      },
      brow: {
        shape: str(o.brow && o.brow.shape), thickness: str(o.brow && o.brow.thickness),
        color: str(o.brow && o.brow.color), detail: str(o.brow && o.brow.detail)
      },
      eye: {
        shadows: shadows,
        liner: str(o.eye && o.eye.liner),
        lashes: str(o.eye && o.eye.lashes),
        extra: str(o.eye && o.eye.extra)
      },
      cheek: {
        color: str(o.cheek && o.cheek.color), hex: rgbOf(o.cheek && o.cheek.hex),
        where: str(o.cheek && o.cheek.where), how: str(o.cheek && o.cheek.how)
      },
      contour: str(o.contour),
      lip: {
        color: str(o.lip && o.lip.color), hex: rgbOf(o.lip && o.lip.hex),
        texture: str(o.lip && o.lip.texture), shape: str(o.lip && o.lip.shape)
      },
      /* 图上真实采样到的像素色（本地算的，不是模型猜的） */
      sampled: analysis ? sampledSwatches(analysis) : []
    };
  }

  /* 从像素分析里挑几个代表性颜色，作为「实际采样」和模型描述互相印证 */
  function sampledSwatches(a) {
    if (!a || !a.buckets) return [];
    const name = { red: '红', orange: '橘', yellow: '黄', green: '绿', blue: '蓝', purple: '紫', pink: '粉', neutral: '中性', dark: '暗' };
    const total = Math.max(1, Object.keys(a.buckets).reduce(function (s, k) { return s + a.buckets[k]; }, 0));
    return Object.keys(a.buckets)
      .filter(function (k) { return a.buckets[k] / total > 0.04; })
      .sort(function (x, y) { return a.buckets[y] - a.buckets[x]; })
      .slice(0, 5)
      .map(function (k) { return { name: name[k] || k, percent: Math.round(a.buckets[k] / total * 100) }; });
  }

  /* 模型给的步骤 → 按站点既有的阶段顺序规整 */
  function normalizeSteps(raw) {
    const stages = (typeof window !== 'undefined' && window.MAKEUP_DATA && window.MAKEUP_DATA.stages) || [];
    const order = stages.map(function (s) { return s.id; });
    const byId = {};
    stages.forEach(function (s) { byId[s.id] = s; });

    return arr(raw).map(function (s) {
      const id = str(s.stage);
      if (order.indexOf(id) < 0) return null;
      const items = arr(s.items).map(function (it) {
        return { name: str(it.name, '要点'), desc: str(it.desc), tip: str(it.tip) };
      }).filter(function (it) { return it.desc; }).slice(0, 6);
      if (!items.length) return null;
      const meta = byId[id] || { title: id, icon: '•' };
      return {
        stage: id, title: meta.title, icon: meta.icon,
        intro: str(s.intro), items: items
      };
    }).filter(Boolean).sort(function (a, b) {
      return order.indexOf(a.stage) - order.indexOf(b.stage);
    });
  }

  /* 搜索词：模型给的不够就用还原结果自己拼，保证「全网找同款」永远有词可用 */
  function normalizeQueries(raw, restore) {
    let q = arr(raw).map(function (x) { return str(x); }).filter(Boolean);
    if (q.length < 3 && restore) {
      const bits = [];
      if (restore.eye && restore.eye.shadows[0] && restore.eye.shadows[0].color) {
        bits.push(restore.eye.shadows[0].color + '眼影');
      }
      if (restore.lip && restore.lip.color) bits.push(restore.lip.color + '唇');
      if (restore.brow && restore.brow.shape) bits.push(restore.brow.shape);
      if (restore.skin && restore.skin.finish) bits.push(restore.skin.finish + '底妆');
      q = q.concat([
        [restore.styleName, '妆容 教程'].join(' '),
        bits.join(' ') || (restore.styleName + ' 画法'),
        restore.vibe ? (restore.vibe + ' 妆 教程') : (restore.styleName + ' 复刻')
      ]);
    }
    const out = [];
    q.forEach(function (x) { if (x && out.indexOf(x) < 0) out.push(x); });
    return out.slice(0, 5);
  }

  /* 没有 API Key 时：只能给配色层面的近似，把话说清楚 */
  function demoRestore(demo, analysis) {
    const looks = (typeof window !== 'undefined' && window.MAKEUP_DATA && window.MAKEUP_DATA.looks) || [];
    const look = demo ? looks.find(function (l) { return l.id === demo.lookId; }) : null;
    const sw = sampledSwatches(analysis || {});
    const swTxt = sw.map(function (s) { return s.name + ' ' + s.percent + '%'; }).join('、');
    return {
      approx: true,
      styleName: (look ? look.name : '未识别') + '（配色近似）',
      summary: '演示模式只能用像素配色做粗判，给不出「逐处颜色与位置」。' +
        '这张图采样到的色调占比是：' + (swTxt || '无') + '。要真正做到照着复刻，请到「设置」填 API Key。',
      vibe: look ? look.occasion : '',
      skin: { finish: '', coverage: '', shade: '', detail: '' },
      brow: { shape: '', thickness: '', color: '', detail: '' },
      eye: { shadows: [], liner: '', lashes: '', extra: '' },
      cheek: { color: '', hex: '', where: '', how: '' },
      contour: '',
      lip: { color: '', hex: '', texture: '', shape: '' },
      sampled: sw
    };
  }

  async function recognizeLook(img, cfg) {
    if (!cfg) cfg = loadConfig();
    const analysis = analyzeColors(img);
    const demo = matchLookByColor(analysis);

    const useApi = cfg.mode === 'api' || (cfg.mode === 'auto' && hasApi(cfg));
    if (useApi) {
      // 同一张图 + 同样配置 → 直接用缓存，不重复花钱
      const cacheKey = 'rec2|' + cfg.model + '|' + (cfg.detail || 'hi') + '|' + (cfg.maxImageSize || 1024) + '|' + hashString(img.src);
      if (cfg.cache !== false) {
        const hit = cacheGet(cacheKey);
        if (hit) return Object.assign({}, hit, { cached: true });
      }

      /* 候选妆容从数据里动态取，新增妆容自动进入识别范围 */
      const allLooks = (typeof window !== 'undefined' && window.MAKEUP_DATA && window.MAKEUP_DATA.looks) || [];
      const stages = (typeof window !== 'undefined' && window.MAKEUP_DATA && window.MAKEUP_DATA.stages) || [];
      const groupName = { female: '女妆', male: '男妆', cos: 'cos/舞台' };
      const idList = allLooks.map(function (l) {
        return l.id + '(' + l.name + '·' + (groupName[l.group] || '女妆') + ')';
      }).join('、');
      const stageList = stages.map(function (s) { return s.id + '(' + s.title + ')'; }).join('、');

      const prompt =
        '你是一位资深化妆师。请**逐处**拆解这张妆容照片，目标是让别人拿着你的描述能画出**一模一样**的妆，' +
        '而不是判断它属于哪一类。\n\n' +
        '要求：\n' +
        '· 颜色要具体到「什么色 + 大致色值 + 深浅」，不要只写「棕色眼影」\n' +
        '· 位置要具体到面部解剖位置（眼窝/双眼皮褶内/睫毛根部/眼尾三角区/颧骨下方/唇峰…）\n' +
        '· 形状要具体（上扬多少度、拉长多少、眉峰在哪个位置、唇形是内收还是外扩）\n' +
        '· 质地要写（哑光/微珠光/闪片/水光/雾面）\n' +
        '· 层次要写（打底→加深→提亮，分别用什么、范围到哪）\n' +
        '· 分不清的地方就写「看不清」，不要编\n\n' +
        '**只输出一个 JSON 对象，不要任何解释文字、不要 markdown 代码块。** 结构如下：\n' +
        '{\n' +
        '  "styleName": "给这个妆起一个具体的名字（如「冷调玫瑰咬唇 + 微上挑眼线」）",\n' +
        '  "summary": "一句话概括这张图的妆容特征",\n' +
        '  "vibe": "风格归属：年代/流派/像什么风格（如 90 年代港风、日系清透、千禧 Y2K）",\n' +
        '  "skin": { "finish": "妆效（水光/哑光/半哑光/奶油肌）", "coverage": "遮瑕度（薄/中/高）", "shade": "底色倾向（冷调偏白/暖调自然…）", "detail": "底妆具体做法" },\n' +
        '  "brow": { "shape": "眉形", "thickness": "粗细", "color": "颜色", "detail": "画法与要点" },\n' +
        '  "eye": {\n' +
        '    "shadows": [ { "color": "颜色名", "hex": "#rrggbb", "where": "涂在哪里", "texture": "质地" } ],\n' +
        '    "liner": "眼线：形状/走向/粗细/眼尾拉长多少/是否画下眼线",\n' +
        '    "lashes": "睫毛：卷翘度、浓密度、是否假睫毛",\n' +
        '    "extra": "卧蚕、眼头提亮、下眼影、双眼皮贴等"\n' +
        '  },\n' +
        '  "cheek": { "color": "颜色名", "hex": "#rrggbb", "where": "打在哪个位置", "how": "手法与浓淡" },\n' +
        '  "contour": "修容与高光：打在哪、强度如何、有没有做鼻影/下颌线",\n' +
        '  "lip": { "color": "颜色名", "hex": "#rrggbb", "texture": "质地", "shape": "唇形怎么画（是否缩小/外扩/咬唇/晕染）" },\n' +
        '  "queries": ["3~5 个用于在网上搜同款教程的中文关键词，要具体，如「冷调玫瑰 咬唇妆 教程」"],\n' +
        '  "steps": [\n' +
        '    { "stage": "阶段id", "intro": "这一步针对这张图要做什么",\n' +
        '      "items": [ { "name": "要点名", "desc": "具体怎么做（越具体越好）", "tip": "可选的小贴士" } ] }\n' +
        '  ]\n' +
        '}\n\n' +
        'steps 的 stage 只能从这些里选：' + stageList + '。' +
        '至少给 5 个阶段，每个阶段 2~5 个 items。\n\n' +
        '另外：如果你能判断，请在 JSON 之外最开头单独加一行 \nLOOK=<id>\n，' +
        'id 从下面这个最接近的预设列表里选（只为给出一个可参考的现成教学，不影响上面的还原描述）：' + idList + '\n' +
        '重要：不要默认选女妆。男妆（底妆薄、哑光、修容重、眉毛直线条、无假睫毛）和 cos 妆（眼妆夸张、假睫毛、高遮瑕）都要认真考虑。';
      try {
        // 先缩放再上传：模型内部反正会缩，原图直传纯属浪费
        const sent = prepareForAPI(img, cfg.maxImageSize || 1024, 0.85);
        /* 妆容还原的输出很长（逐处拆解 + 分步教学），最少给 3000；
         * 用户在设置里调得更大就听用户的。 */
        const outTokens = Math.max(3000, cfg.maxTokens || 0);
        const resp = await callVisionAPI(sent, prompt, cfg, { maxTokens: outTokens });
        const text = resp.text;
        const parsedInfo = parseModelJSON(text);
        const parsed = parsedInfo.data;
        const restore = normalizeRestore(parsed, analysis);
        const steps = normalizeSteps(parsed && parsed.steps);

        // lookId：优先用 LOOK= 那行，其次在正文里找 id
        let lookId = null;
        const lookLine = String(text).match(/LOOK\s*=\s*([a-z_]+)/i);
        if (lookLine) lookId = lookLine[1].toLowerCase();
        if (!lookId || !allLooks.some(function (l) { return l.id === lookId; })) {
          lookId = null;
          const prefer = demo && demo.ranked ? demo.ranked.map(function (r) { return r.lookId; }) : [];
          const ids = prefer.concat(allLooks.map(function (l) { return l.id; })
            .filter(function (id) { return prefer.indexOf(id) < 0; }));
          for (const id of ids) {
            const re = new RegExp('(^|[^a-z_])' + id + '([^a-z_]|$)', 'i');
            if (re.test(text)) { lookId = id; break; }
          }
        }

        const out = {
          mode: 'api',
          lookId: lookId || (demo ? demo.lookId : 'natural'),
          confidence: restore && !restore.approx ? 0.92 : (lookId ? 0.8 : (demo ? demo.confidence : 0.6)),
          reason: demo ? demo.reason : '',
          apiText: text,
          analysis: analysis,
          ranked: demo ? demo.ranked : null,
          restore: restore,
          steps: steps,
          queries: normalizeQueries(parsed && parsed.queries, restore),
          partial: parsedInfo.repaired,   // 模型输出被截断过，界面要给提示
          usage: resp.usage, sentBytes: sent ? Math.round(sent.length * 0.75) : 0
        };
        if (cfg.cache !== false) cacheSet(cacheKey, out);
        return out;
      } catch (e) {
        // 接口失败时退回本地颜色分析，保证功能不中断
        if (demo) {
          const needCode = e.code === 'ACCESS_CODE';
          return {
            mode: 'demo', lookId: demo.lookId, confidence: demo.confidence,
            reason: demo.reason, apiText: '', analysis: analysis,
            ranked: demo.ranked,
            restore: demoRestore(demo, analysis),
            steps: demoSteps(demo.lookId),
            queries: demoQueries(demo.lookId),
            error: needCode ? '' : e.message, needCode: needCode
          };
        }
        throw e;
      }
    }

    if (demo) {
      return {
        mode: 'demo', lookId: demo.lookId, confidence: demo.confidence,
        reason: demo.reason, apiText: '', analysis: analysis, ranked: demo.ranked,
        restore: demoRestore(demo, analysis),
        steps: demoSteps(demo.lookId),
        queries: demoQueries(demo.lookId)
      };
    }
    return {
      mode: 'demo', lookId: 'natural', confidence: 0.5,
      reason: '无法读取图片像素，已回退到默认推荐。', apiText: '', analysis: null,
      restore: null, steps: [], queries: []
    };
  }

  /* 演示模式：把预设妆容的定制建议当步骤，让用户至少有一套可跟的东西 */
  function demoSteps(lookId) {
    const looks = (typeof window !== 'undefined' && window.MAKEUP_DATA && window.MAKEUP_DATA.looks) || [];
    const stages = (typeof window !== 'undefined' && window.MAKEUP_DATA && window.MAKEUP_DATA.stages) || [];
    const look = looks.find(function (l) { return l.id === lookId; });
    if (!look) return [];
    return stages.map(function (s) {
      const tw = (look.tweaks || {})[s.id];
      if (!tw) return null;
      const items = [];
      if (tw.intro) items.push({ name: '总原则', desc: tw.intro, tip: '' });
      (tw.notes || []).forEach(function (n, i) {
        items.push({ name: '要点 ' + (i + 1), desc: n, tip: '' });
      });
      if (!items.length) return null;
      return { stage: s.id, title: s.title, icon: s.icon, intro: tw.intro || '', items: items };
    }).filter(Boolean);
  }

  function demoQueries(lookId) {
    const looks = (typeof window !== 'undefined' && window.MAKEUP_DATA && window.MAKEUP_DATA.looks) || [];
    const look = looks.find(function (l) { return l.id === lookId; });
    if (!look) return [];
    return [look.name + ' 教程', look.name + ' 详细步骤', look.en, look.name + ' 画法'];
  }


  /* ============ 肤质分析（整合 API + 演示） ============ */
  async function analyzeSkin(faceImg, answers, cfg) {
    if (!cfg) cfg = loadConfig();
    const faceAnalysis = analyzeColors(faceImg);
    const demo = analyzeSkinByRules(answers, faceAnalysis);

    const useApi = cfg.mode === 'api' || (cfg.mode === 'auto' && hasApi(cfg));
    if (useApi) {
      const labelMap = { skinType: '肤质', undertone: '肤色基调', depth: '肤色深浅', concerns: '肌肤困扰', sensitive: '是否敏感', climate: '当前气候' };
      const valMap = { unknown: '不确定（请用照片推断）', unsure: '不确定', no: '不会', yes: '经常', sometimes: '偶尔' };
      let q = '';
      for (const k in answers) {
        let v = Array.isArray(answers[k]) ? answers[k].join('、') : answers[k];
        if (v && valMap[v]) v = valMap[v];
        if (v) q += (labelMap[k] || k) + '：' + v + '\n';
      }
      if (!q.trim()) q = '（用户没有填写任何问卷信息，请完全依据照片分析，并明确指出信息不足会影响结论准确性）\n';
      const typeName = { oily: '油性', dry: '干性', combo: '混合', normal: '中性', sensitive: '敏感' };
      const photoHint = (demo.infer && demo.infer.guess)
        ? (typeName[demo.infer.guess] + '，把握度：' + demo.infer.confidence)
        : '';
      const prompt =
        '请根据这张脸部照片和以下用户自述，分析其皮肤状态。\n\n' +
        '要求：\n' +
        '· 如果用户自述与照片观感不一致，请明确指出，说明你以哪个为准、理由是什么\n' +
        '· 如果用户信息缺失或选了「不确定」，请说明这会影响哪些结论、需要补充什么\n' +
        '· 护肤建议要落到具体成分方向，不要只写「注意保湿」这类空话\n' +
        '· 语气面向化妆初学者，通俗、可执行\n\n' +
        '请按以下结构用中文回答：\n' +
        '1. 肤质判断（必须写明判断依据：照片里观察到了什么 + 用户自述了什么）\n' +
        '2. 皮肤特征与可能存在的问题\n' +
        '3. 晨间护肤流程（分步，每步说明目的）\n' +
        '4. 夜间护肤流程（分步）\n' +
        '5. 需要避开的成分或产品类型\n' +
        '6. 底妆建议（妆前、粉底、遮瑕、定妆）\n' +
        '7. 选色建议（粉底色号基调 / 腮红 / 口红）\n' +
        '8. 遮瑕重点与手法\n' +
        '9. 妆后护肤与卸妆建议\n' +
        '10. 其他提醒（换季、作息、就医建议等）\n\n' +
        '用户自述：\n' + q +
        (photoHint ? '\n（补充：从照片像素分析得到的倾向是「' + photoHint + '」，仅供你交叉验证，不一定要采纳）\n' : '');
      const cacheKey = 'skin|' + cfg.model + '|' + (cfg.detail || 'hi') + '|' +
        (cfg.maxImageSize || 1024) + '|' + hashString(faceImg.src) + '|' + JSON.stringify(answers);
      if (cfg.cache !== false) {
        const hit = cacheGet(cacheKey);
        if (hit) return Object.assign({}, hit, { cached: true });
      }
      try {
        const sent = prepareForAPI(faceImg, cfg.maxImageSize || 1024, 0.85);
        const resp = await callVisionAPI(sent, prompt, cfg);
        const out = { mode: 'api', demo: demo, apiText: resp.text, analysis: faceAnalysis, usage: resp.usage };
        if (cfg.cache !== false) cacheSet(cacheKey, out);
        return out;
      } catch (e) {
        const needCode = e.code === 'ACCESS_CODE';
        return {
          mode: 'demo', demo: demo, apiText: '', analysis: faceAnalysis,
          error: needCode ? '' : e.message, needCode: needCode
        };
      }
    }
    return { mode: 'demo', demo: demo, apiText: '', analysis: faceAnalysis };
  }

  /* ============ 妆容推荐（肤质档案 + 照片分析 → 适合画什么） ============
   * 打分维度：肤色基调 / 肤色深浅 / 肤质 / 肌肤困扰 / 敏感度 / 环境 + 照片明暗
   * 每项 0–3 分，2 = 中性；>2 加分，<2 减分。冲突项单独扣分。
   */
  const LOOK_FIT = {
    natural: {
      name: '清透裸妆', note: '步骤最少、产品最薄，对皮肤负担最小',
      undertone: { cool: 2, warm: 2, neutral: 3 },
      depth: { fair: 3, light: 3, medium: 2, deep: 1 },
      skin: { oily: 2, dry: 2, combo: 3, normal: 3, sensitive: 3 },
      good: { acne: 3, redness: 2, pore: 1, fineLine: 1 },
      bad: {}
    },
    daily: {
      name: '日常通勤妆', note: '大地色系最百搭，持妆方案成熟',
      undertone: { cool: 2, warm: 3, neutral: 3 },
      depth: { fair: 2, light: 3, medium: 3, deep: 2 },
      skin: { oily: 3, dry: 2, combo: 3, normal: 3, sensitive: 2 },
      good: { acne: 3, darkCircle: 2, pore: 2, dull: 2 },
      bad: {}
    },
    sweet: {
      name: '甜美约会妆', note: '粉调柔美，显气色',
      undertone: { cool: 3, warm: 2, neutral: 2 },
      depth: { fair: 3, light: 3, medium: 2, deep: 1 },
      skin: { oily: 1, dry: 2, combo: 2, normal: 3, sensitive: 2 },
      good: { dull: 2, darkCircle: 1 },
      bad: { redness: 2 }
    },
    korean: {
      name: '韩系水光妆', note: '水光底妆能弱化干纹、显通透',
      undertone: { cool: 3, warm: 1, neutral: 2 },
      depth: { fair: 3, light: 3, medium: 2, deep: 1 },
      skin: { oily: 0, dry: 3, combo: 2, normal: 3, sensitive: 2 },
      good: { fineLine: 3, dull: 2, pore: 1 },
      bad: { acne: 1 }
    },
    japanese: {
      name: '日系元气妆', note: '蜜桃橘调最能提气色',
      undertone: { cool: 1, warm: 3, neutral: 2 },
      depth: { fair: 2, light: 3, medium: 3, deep: 2 },
      skin: { oily: 2, dry: 2, combo: 2, normal: 3, sensitive: 2 },
      good: { dull: 3, darkCircle: 2 },
      bad: { redness: 1 }
    },
    western: {
      name: '欧美深邃妆', note: '高遮瑕哑光 + 古铜修容，轮廓感强',
      undertone: { cool: 2, warm: 3, neutral: 2 },
      depth: { fair: 1, light: 2, medium: 3, deep: 3 },
      skin: { oily: 3, dry: 1, combo: 2, normal: 2, sensitive: 1 },
      good: { pore: 2, darkCircle: 2 },
      bad: { fineLine: 2, acne: 1 }
    },
    smokey: {
      name: '晚宴烟熏妆', note: '哑光高持妆，但用到的产品最多',
      undertone: { cool: 2, warm: 2, neutral: 3 },
      depth: { fair: 1, light: 2, medium: 3, deep: 3 },
      skin: { oily: 3, dry: 0, combo: 2, normal: 2, sensitive: 0 },
      good: {},
      bad: { fineLine: 2, acne: 2, redness: 1 }
    },
    chinese: {
      name: '中式古典妆', note: '朱红唇妆是点睛，但红调对泛红肌不友好',
      undertone: { cool: 2, warm: 3, neutral: 3 },
      depth: { fair: 2, light: 3, medium: 3, deep: 3 },
      skin: { oily: 2, dry: 1, combo: 2, normal: 3, sensitive: 1 },
      good: { darkCircle: 1 },
      bad: { redness: 3 }
    },

    /* ---- 男妆 ---- */
    mens_base: {
      name: '男生清透底妆', note: '只匀肤色、遮瑕疵，妆感最轻，任何肤质都能上手',
      undertone: { cool: 3, warm: 3, neutral: 3 },
      depth: { fair: 2, light: 3, medium: 3, deep: 3 },
      skin: { oily: 3, dry: 2, combo: 3, normal: 3, sensitive: 3 },
      good: { acne: 3, redness: 3, darkCircle: 2, dull: 2, pore: 2 },
      bad: {}
    },
    mens_bone: {
      name: '男生立体骨相妆', note: '靠修容塑形，油皮友好；干皮需先做好保湿否则会显脏',
      undertone: { cool: 3, warm: 2, neutral: 3 },
      depth: { fair: 1, light: 2, medium: 3, deep: 3 },
      skin: { oily: 3, dry: 1, combo: 3, normal: 3, sensitive: 1 },
      good: { dull: 2, pore: 2 },
      bad: { fineLine: 2, redness: 2 }
    },
    mens_eye: {
      name: '男生眉眼精神妆', note: '只做眉毛与眼周，不碰底妆，最省事',
      undertone: { cool: 3, warm: 3, neutral: 3 },
      depth: { fair: 2, light: 3, medium: 3, deep: 3 },
      skin: { oily: 3, dry: 3, combo: 3, normal: 3, sensitive: 3 },
      good: { darkCircle: 3, dull: 2, fineLine: 1 },
      bad: {}
    },

    /* ---- cos 妆 ---- */
    cos_anime: {
      name: '二次元动漫妆', note: '高遮瑕、强眼妆，对油皮和毛孔友好，但敏感肌要慎用闪片',
      undertone: { cool: 3, warm: 2, neutral: 2 },
      depth: { fair: 3, light: 3, medium: 2, deep: 1 },
      skin: { oily: 3, dry: 2, combo: 3, normal: 3, sensitive: 1 },
      good: { acne: 3, pore: 3, darkCircle: 3, dull: 2, redness: 2 },
      bad: { fineLine: 2 }
    },
    cos_guofeng: {
      name: '古风 cos 妆', note: '瓷白底妆与胭脂红腮红，对泛红肌和深肤色不太友好',
      undertone: { cool: 2, warm: 3, neutral: 3 },
      depth: { fair: 3, light: 3, medium: 2, deep: 1 },
      skin: { oily: 2, dry: 1, combo: 2, normal: 3, sensitive: 1 },
      good: { darkCircle: 1 },
      bad: { redness: 3, acne: 1 }
    },
    cos_idol: {
      name: '舞台爱豆妆', note: '为舞台灯设计，显色与闪片拉满；日常会偏浓',
      undertone: { cool: 3, warm: 3, neutral: 3 },
      depth: { fair: 2, light: 3, medium: 3, deep: 3 },
      skin: { oily: 3, dry: 1, combo: 3, normal: 3, sensitive: 1 },
      good: { acne: 3, darkCircle: 3, dull: 3, pore: 2 },
      bad: { fineLine: 2, redness: 2 }
    },
    cos_shonen: {
      name: '少年感 cos 妆', note: '妆感克制、哑光干净，男生出男角色的通用底子；油皮友好',
      undertone: { cool: 3, warm: 3, neutral: 3 },
      depth: { fair: 2, light: 3, medium: 3, deep: 3 },
      skin: { oily: 3, dry: 2, combo: 3, normal: 3, sensitive: 3 },
      good: { acne: 3, redness: 3, darkCircle: 2, pore: 2 },
      bad: {}
    },
    cos_dark: {
      name: '暗黑反派妆', note: '全脸冷调哑光、唇色深；敏感肌用深色唇膏要谨慎',
      undertone: { cool: 3, warm: 1, neutral: 2 },
      depth: { fair: 3, light: 3, medium: 2, deep: 1 },
      skin: { oily: 3, dry: 1, combo: 2, normal: 3, sensitive: 1 },
      good: { acne: 3, darkCircle: 3, pore: 3, dull: 2 },
      bad: { fineLine: 3, redness: 2 }
    },

    /* ---- 新增妆容 ---- */
    "vintage_hk": {
      "name": "港风复古妆",
      "note": "五官量感偏大、肤色健康的人最出彩；眉毛稀疏或唇形很薄的人需要先把眉形和唇线补齐，否则撑不起浓眉红唇的反差。",
      "undertone": {
        "cool": 2,
        "warm": 3,
        "neutral": 3
      },
      "depth": {
        "fair": 2,
        "light": 3,
        "medium": 3,
        "deep": 3
      },
      "skin": {
        "oily": 2,
        "dry": 2,
        "combo": 3,
        "normal": 3,
        "sensitive": 2
      },
      "good": {
        "dull": 3,
        "darkCircle": 2
      },
      "bad": {
        "fineLine": 2,
        "pore": 2
      }
    },

    "thai": {
      "name": "泰妆",
      "note": "骨相清晰、五官浓的人最能撑住这款妆；脸型偏圆或五官较平的人要把修容面积缩小三成，否则容易显脏。",
      "undertone": {
        "cool": 2,
        "warm": 3,
        "neutral": 3
      },
      "depth": {
        "fair": 2,
        "light": 3,
        "medium": 3,
        "deep": 3
      },
      "skin": {
        "oily": 3,
        "dry": 2,
        "combo": 3,
        "normal": 3,
        "sensitive": 2
      },
      "good": {
        "darkCircle": 3,
        "dull": 2,
        "pore": 2
      },
      "bad": {
        "fineLine": 2
      }
    },

    "french": {
      "name": "法式优雅妆",
      "note": "皮肤底子好、五官干净的人最省力；痘印和泛红明显时要把遮瑕做局部加强，否则不遮瑕会变成没画好。",
      "undertone": {
        "cool": 3,
        "warm": 2,
        "neutral": 3
      },
      "depth": {
        "fair": 3,
        "light": 3,
        "medium": 2,
        "deep": 2
      },
      "skin": {
        "oily": 3,
        "dry": 2,
        "combo": 3,
        "normal": 3,
        "sensitive": 2
      },
      "good": {
        "dull": 2,
        "pore": 1
      },
      "bad": {
        "acne": 2,
        "redness": 2
      }
    },

    "abg": {
      "name": "亚裔辣妹妆",
      "note": "面部骨相清晰、能接受深色修容的人效果最好；脸小或五官柔和的人把修容和唇形量感各减三成会更协调。",
      "undertone": {
        "cool": 2,
        "warm": 3,
        "neutral": 3
      },
      "depth": {
        "fair": 1,
        "light": 2,
        "medium": 3,
        "deep": 3
      },
      "skin": {
        "oily": 3,
        "dry": 1,
        "combo": 3,
        "normal": 2,
        "sensitive": 2
      },
      "good": {
        "darkCircle": 3,
        "dull": 2,
        "pore": 2,
        "redness": 2
      },
      "bad": {
        "fineLine": 2
      }
    },

    "pure_desire": {
      "name": "纯欲妆",
      "note": "适合五官柔和、皮肤较细腻的人；油皮和毛孔明显的人要先做控油和毛孔修饰，水光底会把这两点放大。",
      "undertone": {
        "cool": 3,
        "warm": 3,
        "neutral": 3
      },
      "depth": {
        "fair": 3,
        "light": 3,
        "medium": 2,
        "deep": 2
      },
      "skin": {
        "oily": 1,
        "dry": 3,
        "combo": 2,
        "normal": 3,
        "sensitive": 3
      },
      "good": {
        "dull": 2
      },
      "bad": {
        "acne": 2,
        "pore": 2,
        "redness": 2,
        "fineLine": 1
      }
    },

    "white_water": {
      "name": "白开水妆",
      "note": "皮肤状态稳定、肤色均匀的人最适合；正处在爆痘或严重泛红期时会明显遮不住，建议先修护再画。",
      "undertone": {
        "cool": 3,
        "warm": 3,
        "neutral": 3
      },
      "depth": {
        "fair": 3,
        "light": 3,
        "medium": 2,
        "deep": 2
      },
      "skin": {
        "oily": 2,
        "dry": 3,
        "combo": 3,
        "normal": 3,
        "sensitive": 3
      },
      "good": {
        "darkCircle": 3,
        "acne": 2,
        "redness": 2
      },
      "bad": {
        "dull": 2,
        "fineLine": 1
      }
    },

    "milk_tea": {
      "name": "奶茶妆",
      "note": "几乎没有门槛的日常妆，冷暖肤色都能用，只要底妆别选太白的色号。",
      "undertone": {
        "cool": 2,
        "warm": 3,
        "neutral": 3
      },
      "depth": {
        "fair": 2,
        "light": 3,
        "medium": 3,
        "deep": 3
      },
      "skin": {
        "oily": 2,
        "dry": 2,
        "combo": 3,
        "normal": 3,
        "sensitive": 2
      },
      "good": {
        "dull": 2,
        "darkCircle": 2
      },
      "bad": {
        "fineLine": 2
      }
    },

    "y2k": {
      "name": "Y2K 千禧妆",
      "note": "适合五官立体、能驾驭高对比冷色的人；肤色偏冷或中性最好，偏黄要加重腮红和唇色补血色。",
      "undertone": {
        "cool": 3,
        "warm": 1,
        "neutral": 2
      },
      "depth": {
        "fair": 3,
        "light": 3,
        "medium": 2,
        "deep": 2
      },
      "skin": {
        "oily": 2,
        "dry": 1,
        "combo": 2,
        "normal": 3,
        "sensitive": 1
      },
      "good": {},
      "bad": {
        "fineLine": 2,
        "pore": 2
      }
    },

    "barbie": {
      "name": "芭比妆",
      "note": "适合喜欢高调甜系风格、能接受底妆偏白的人；肤色偏黄建议挑带暖调的粉，避免发紫发灰。",
      "undertone": {
        "cool": 3,
        "warm": 2,
        "neutral": 3
      },
      "depth": {
        "fair": 3,
        "light": 3,
        "medium": 2,
        "deep": 1
      },
      "skin": {
        "oily": 2,
        "dry": 2,
        "combo": 3,
        "normal": 3,
        "sensitive": 2
      },
      "good": {
        "dull": 2,
        "darkCircle": 2
      },
      "bad": {
        "redness": 2,
        "acne": 2
      }
    },

    "maillard": {
      "name": "美拉德妆",
      "note": "秋冬和暖调底色的最佳搭档；肤色偏冷可以选偏红一点的棕，避免整张脸发黄发土。",
      "undertone": {
        "cool": 1,
        "warm": 3,
        "neutral": 3
      },
      "depth": {
        "fair": 2,
        "light": 3,
        "medium": 3,
        "deep": 3
      },
      "skin": {
        "oily": 2,
        "dry": 3,
        "combo": 3,
        "normal": 3,
        "sensitive": 2
      },
      "good": {
        "dull": 3
      },
      "bad": {
        "fineLine": 3
      }
    },

    "peach": {
      "name": "蜜桃妆",
      "note": "适合肤色偏暖、气色容易显疲惫的人；冷白皮也能用，但腮红要挑偏粉的蜜桃色。",
      "undertone": {
        "cool": 2,
        "warm": 3,
        "neutral": 3
      },
      "depth": {
        "fair": 2,
        "light": 3,
        "medium": 3,
        "deep": 2
      },
      "skin": {
        "oily": 2,
        "dry": 3,
        "combo": 3,
        "normal": 3,
        "sensitive": 2
      },
      "good": {
        "dull": 3,
        "darkCircle": 2
      },
      "bad": {
        "acne": 2
      }
    },

    "sakura": {
      "name": "樱花妆",
      "note": "适合肤色偏白清透、喜欢甜系淡妆的人；肤色偏深建议把粉色选深一档，否则容易发灰。",
      "undertone": {
        "cool": 3,
        "warm": 1,
        "neutral": 3
      },
      "depth": {
        "fair": 3,
        "light": 3,
        "medium": 2,
        "deep": 1
      },
      "skin": {
        "oily": 2,
        "dry": 3,
        "combo": 3,
        "normal": 3,
        "sensitive": 3
      },
      "good": {
        "dull": 2,
        "darkCircle": 2
      },
      "bad": {
        "redness": 2
      }
    },

    "bridal": {
      "name": "新娘妆",
      "note": "适合愿意提前试妆、能接受妆感比日常浓一档的准新娘；敏感肌和大面积痘肌要预留更多遮瑕与定妆时间",
      "undertone": {
        "cool": 3,
        "warm": 3,
        "neutral": 3
      },
      "depth": {
        "fair": 3,
        "light": 3,
        "medium": 3,
        "deep": 2
      },
      "skin": {
        "oily": 3,
        "dry": 2,
        "combo": 3,
        "normal": 3,
        "sensitive": 1
      },
      "good": {
        "acne": 3,
        "darkCircle": 3,
        "dull": 2
      },
      "bad": {
        "fineLine": 3,
        "pore": 1
      }
    },

    "photo_id": {
      "name": "证件照妆",
      "note": "几乎适合所有肤色和肤质，尤其适合需要频繁办证件的上班族；难点不在技术，而在克制",
      "undertone": {
        "cool": 3,
        "warm": 3,
        "neutral": 3
      },
      "depth": {
        "fair": 3,
        "light": 3,
        "medium": 3,
        "deep": 2
      },
      "skin": {
        "oily": 3,
        "dry": 2,
        "combo": 3,
        "normal": 3,
        "sensitive": 2
      },
      "good": {
        "darkCircle": 3,
        "dull": 2,
        "redness": 2
      },
      "bad": {
        "fineLine": 2
      }
    },

    "party": {
      "name": "夜店蹦迪妆",
      "note": "适合油皮、混油皮和敢于尝试浓妆的人；干皮要先做好保湿，否则闪片和亮片胶容易卡在起皮处",
      "undertone": {
        "cool": 3,
        "warm": 3,
        "neutral": 3
      },
      "depth": {
        "fair": 3,
        "light": 3,
        "medium": 3,
        "deep": 3
      },
      "skin": {
        "oily": 3,
        "dry": 1,
        "combo": 3,
        "normal": 3,
        "sensitive": 1
      },
      "good": {
        "dull": 3,
        "darkCircle": 2
      },
      "bad": {
        "pore": 2,
        "fineLine": 2
      }
    },

    "graduation": {
      "name": "毕业照妆",
      "note": "几乎适合所有人，尤其是第一次拍正式照片的学生党；技术门槛低，重点全在克制的浓度上",
      "undertone": {
        "cool": 3,
        "warm": 3,
        "neutral": 3
      },
      "depth": {
        "fair": 3,
        "light": 3,
        "medium": 3,
        "deep": 2
      },
      "skin": {
        "oily": 2,
        "dry": 2,
        "combo": 3,
        "normal": 3,
        "sensitive": 2
      },
      "good": {
        "dull": 3,
        "darkCircle": 2
      },
      "bad": {
        "acne": 2,
        "pore": 2
      }
    },

    "tang": {
      "name": "唐风妆造",
      "note": "适合面部留白较多、五官偏平、不怕浓妆的人，也适合想拍唐风写真的汉服爱好者；面部泛红明显的人要先压红再上胭脂",
      "undertone": {
        "cool": 2,
        "warm": 3,
        "neutral": 3
      },
      "depth": {
        "fair": 3,
        "light": 3,
        "medium": 3,
        "deep": 2
      },
      "skin": {
        "oily": 2,
        "dry": 2,
        "combo": 3,
        "normal": 3,
        "sensitive": 1
      },
      "good": {
        "dull": 3,
        "darkCircle": 2
      },
      "bad": {
        "redness": 3,
        "acne": 2
      }
    },

    "song": {
      "name": "宋制清雅妆",
      "note": "适合五官秀气、气质偏安静的人，也适合想拍宋制写真的汉服爱好者；肤色较深的人要靠提亮和素净配色做整体协调",
      "undertone": {
        "cool": 3,
        "warm": 2,
        "neutral": 3
      },
      "depth": {
        "fair": 3,
        "light": 3,
        "medium": 2,
        "deep": 1
      },
      "skin": {
        "oily": 3,
        "dry": 2,
        "combo": 3,
        "normal": 3,
        "sensitive": 2
      },
      "good": {
        "dull": 2,
        "redness": 2
      },
      "bad": {
        "acne": 3,
        "pore": 3
      }
    },

    "opera": {
      "name": "戏曲妆",
      "note": "适合愿意花四十分钟以上做完整造型、并且有舞台或拍摄场合的人；日常通勤完全不合适。",
      "undertone": {
        "cool": 3,
        "warm": 2,
        "neutral": 3
      },
      "depth": {
        "fair": 3,
        "light": 3,
        "medium": 3,
        "deep": 2
      },
      "skin": {
        "oily": 3,
        "dry": 2,
        "combo": 3,
        "normal": 3,
        "sensitive": 1
      },
      "good": {
        "redness": 3,
        "darkCircle": 3,
        "dull": 3
      },
      "bad": {
        "acne": 1,
        "pore": 1,
        "fineLine": 1
      }
    },

    "mens_work": {
      "name": "男生职场妆",
      "note": "适合需要在职场里显得精神、又不想被看出化妆的男生；皮肤大面积爆痘时先控痘再上妆。",
      "undertone": {
        "cool": 3,
        "warm": 3,
        "neutral": 3
      },
      "depth": {
        "fair": 3,
        "light": 3,
        "medium": 3,
        "deep": 3
      },
      "skin": {
        "oily": 3,
        "dry": 2,
        "combo": 3,
        "normal": 3,
        "sensitive": 3
      },
      "good": {
        "acne": 3,
        "redness": 3,
        "darkCircle": 3,
        "dull": 2
      },
      "bad": {}
    },

    "mens_wedding": {
      "name": "男生婚礼妆",
      "note": "适合婚礼当天要拍照超过八小时的新郎；如果流程里会频繁擦汗，全套必须换防水系列。",
      "undertone": {
        "cool": 3,
        "warm": 3,
        "neutral": 3
      },
      "depth": {
        "fair": 3,
        "light": 3,
        "medium": 3,
        "deep": 3
      },
      "skin": {
        "oily": 3,
        "dry": 2,
        "combo": 3,
        "normal": 3,
        "sensitive": 2
      },
      "good": {
        "redness": 3,
        "darkCircle": 3,
        "dull": 3,
        "acne": 2
      },
      "bad": {
        "fineLine": 1
      }
    },

    "cos_vampire": {
      "name": "吸血鬼妆",
      "note": "适合本身肤色偏白或愿意用白色调色液压白的人；肤色偏深时必须靠调色液，否则苍白效果出不来。",
      "undertone": {
        "cool": 3,
        "warm": 1,
        "neutral": 2
      },
      "depth": {
        "fair": 3,
        "light": 3,
        "medium": 2,
        "deep": 1
      },
      "skin": {
        "oily": 3,
        "dry": 2,
        "combo": 3,
        "normal": 3,
        "sensitive": 3
      },
      "good": {
        "darkCircle": 3,
        "dull": 3,
        "redness": 3,
        "pore": 2
      },
      "bad": {
        "fineLine": 1
      }
    },

    "cos_elf": {
      "name": "精灵异族妆",
      "note": "适合愿意用闪片和高光、能接受夸张妆感的人；对闪片或化妆胶水过敏的请先做小面积测试。",
      "undertone": {
        "cool": 3,
        "warm": 3,
        "neutral": 3
      },
      "depth": {
        "fair": 3,
        "light": 3,
        "medium": 3,
        "deep": 2
      },
      "skin": {
        "oily": 2,
        "dry": 3,
        "combo": 2,
        "normal": 3,
        "sensitive": 2
      },
      "good": {
        "dull": 3,
        "darkCircle": 3,
        "fineLine": 2
      },
      "bad": {
        "acne": 1,
        "pore": 1
      }
    },

    "cos_mecha": {
      "name": "机甲科幻妆",
      "note": "适合喜欢线条和金属质感、五官偏立体的人；脸部骨骼不明显时，几何修容要画得比常规更明确。",
      "undertone": {
        "cool": 3,
        "warm": 1,
        "neutral": 2
      },
      "depth": {
        "fair": 3,
        "light": 3,
        "medium": 3,
        "deep": 2
      },
      "skin": {
        "oily": 3,
        "dry": 2,
        "combo": 3,
        "normal": 3,
        "sensitive": 2
      },
      "good": {
        "pore": 3,
        "acne": 2,
        "redness": 2,
        "dull": 2
      },
      "bad": {
        "fineLine": 1
      }
    }
  };

  const UNDERTONE_TXT = {
    cool: '冷调肤色，适合玫粉 / 梅子这类冷调色系',
    warm: '暖调肤色，适合珊瑚 / 橘棕 / 砖红这类暖调色系',
    neutral: '中性调肤色，冷暖色系都能驾驭'
  };
  const SKIN_TXT = {
    oily: '油性肌，建议走哑光持妆路线',
    dry: '干性肌，建议走水润光泽路线',
    combo: '混合肌，可以分区处理（T 区控油、两颊保湿）',
    normal: '中性肌，妆效选择很自由',
    sensitive: '敏感肌，建议精简步骤、用温和产品'
  };
  const CONCERN_TXT = {
    acne: '痘痘 / 痘印：轻薄透气的底妆不容易闷痘',
    darkCircle: '黑眼圈：底妆遮瑕到位的妆容更遮得住',
    pore: '毛孔粗大：哑光底妆对毛孔更友好',
    fineLine: '细纹 / 干纹：水润光泽的妆效能弱化纹路',
    dull: '暗沉发黄：明亮的暖色调能有效提气色',
    redness: '泛红 / 红血丝：需要避开过红过暖的色系'
  };

  function recommendLooks(answers, faceAnalysis) {
    const st = (answers && answers.skinType) || 'normal';
    const ut = (answers && answers.undertone) || 'neutral';
    const dp = (answers && answers.depth) || 'medium';
    const concerns = (answers && answers.concerns) || [];
    const sens = (answers && answers.sensitive) || 'no';
    const clim = (answers && answers.climate) || 'normal';

    const out = [];
    Object.keys(LOOK_FIT).forEach(function (id) {
      const f = LOOK_FIT[id];
      let score = 50;
      const pros = [];
      const cons = [];

      // 肤色基调
      const us = f.undertone[ut] != null ? f.undertone[ut] : 2;
      score += (us - 2) * 7;
      if (us >= 3) pros.push(UNDERTONE_TXT[ut] + '，和这个妆容的色系很协调');
      if (us <= 1) cons.push(UNDERTONE_TXT[ut] + '，这个妆容的色系偏得比较远');

      // 肤色深浅
      const ds = f.depth[dp] != null ? f.depth[dp] : 2;
      score += (ds - 2) * 5;
      if (ds <= 1) cons.push('这个妆容对肤色深浅的适配度一般，可能需要调整色号');

      // 肤质
      const ss = f.skin[st] != null ? f.skin[st] : 2;
      score += (ss - 2) * 8;
      if (ss >= 3) pros.push(SKIN_TXT[st] + '，这个妆容的妆效正好合适');
      if (ss <= 1) cons.push(SKIN_TXT[st] + '，这个妆容的妆效可能不太合适');

      // 肌肤困扰
      concerns.forEach(function (c) {
        if (f.good[c]) {
          score += f.good[c] * 3;
          if (f.good[c] >= 2) pros.push(CONCERN_TXT[c]);
        }
        if (f.bad[c]) {
          score -= f.bad[c] * 5;
          cons.push(CONCERN_TXT[c] + '，这个妆容要特别注意');
        }
      });

      // 敏感肌
      if (sens === 'yes') {
        if (st === 'sensitive' || ss >= 3) { score += 4; pros.push('敏感肌友好：步骤少、产品少'); }
        if (ss <= 1) { score -= 5; cons.push('敏感肌 + 大量眼妆产品，刺激风险较高'); }
      } else if (sens === 'sometimes' && ss <= 1) {
        score -= 2;
      }

      // 环境
      if (clim === 'humid' && st === 'oily' && ss >= 3) { score += 2; pros.push('潮湿环境 + 油皮，这个妆容的持妆方案更稳'); }
      if (clim === 'dry' && ss >= 3 && (id === 'korean' || id === 'natural')) { score += 2; pros.push('干燥环境下这个妆容更不容易卡粉'); }

      // 照片分析补充
      if (faceAnalysis) {
        if (faceAnalysis.brightness < 105 && f.good.dull) {
          score += 3;
          pros.push('照片显示肤色偏暗，这个妆容的提亮色系能帮上忙');
        }
        if (faceAnalysis.brightness > 200 && (id === 'smokey' || id === 'western')) {
          score -= 1;
        }
      }

      out.push({
        lookId: id,
        name: f.name,
        note: f.note,
        score: Math.max(10, Math.min(98, Math.round(score))),
        pros: pros.filter(Boolean).slice(0, 4),
        cons: cons.filter(Boolean).slice(0, 3)
      });
    });

    out.sort(function (a, b) { return b.score - a.score; });
    return out;
  }

  /* ============ 配图 SVG 渲染 ============ */
  function hexToRgb(hex) {
    const h = (hex || '#e2557f').replace('#', '');
    const full = h.length === 3 ? h.split('').map(function (c) { return c + c; }).join('') : h;
    const num = parseInt(full, 16);
    return { r: (num >> 16) & 255, g: (num >> 8) & 255, b: num & 255 };
  }
  function rgba(hex, a) { const c = hexToRgb(hex); return 'rgba(' + c.r + ',' + c.g + ',' + c.b + ',' + a + ')'; }
  /* 按倍率加深/提亮一个颜色，factor > 1 变亮，< 1 变暗 */
  function rgbshade(hex, factor) {
    const c = hexToRgb(hex);
    const f = (factor == null ? 1 : factor);
    const cl = function (v) { return Math.max(0, Math.min(255, Math.round(v * f))); };
    return 'rgb(' + cl(c.r) + ',' + cl(c.g) + ',' + cl(c.b) + ')';
  }
  function escapeXmlText(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }

  /* 阶段顺序 → 用于「累积进度」渲染：脸会随着步骤推进逐渐上妆 */
  const STAGE_ORDER = ['prep', 'base', 'brow', 'eye', 'cheek', 'lip', 'finish', 'after'];
  const ZONE = {
    prep:   { x: 108, y: 74, w: 204, h: 272, label: '全脸 · 清洁 → 保湿 → 防晒 → 妆前乳' },
    base:   { x: 112, y: 80, w: 196, h: 252, label: '全脸 · 粉底 → 遮瑕 → 定妆' },
    brow:   { x: 130, y: 142, w: 160, h: 38, label: '眉部 · 眉头浅 / 眉峰 / 眉尾' },
    eye:    { x: 128, y: 176, w: 164, h: 58, label: '眼部 · 打底 → 晕染 → 眼线 → 睫毛' },
    cheek:  { x: 114, y: 216, w: 192, h: 62, label: '面颊 · 修容 / 腮红 / 高光' },
    lip:    { x: 166, y: 260, w: 88, h: 50, label: '唇部 · 打底 → 勾勒 → 上色' },
    finish: { x: 106, y: 72, w: 208, h: 276, label: '全脸 · 定妆喷雾 + 整体检查' },
    after:  { x: 106, y: 72, w: 208, h: 276, label: '全脸 · 卸妆 → 清洁 → 舒缓补水' }
  };

  function stageFeatures(stageId) {
    if (stageId === 'full') return { base: 1, brow: 1, eye: 1, cheek: 1, lip: 1, glow: 1 };
    if (stageId === 'bare') return {};
    if (stageId === 'after') return { clean: 1, glow: 1 };   // 妆后护肤：卸干净、水润
    const i = STAGE_ORDER.indexOf(stageId);
    if (i < 0) return {};
    return { base: i >= 1, brow: i >= 2, eye: i >= 3, cheek: i >= 4, lip: i >= 5, glow: i >= 6 };
  }

  let svgCounter = 0;

  /* 主配图：写实度更高的脸部示意，支持累积进度与区域标注 */
  function renderFaceSVG(stageId, palette, opts) {
    const p = (palette && palette.length ? palette : ['#e2557f', '#c4456c', '#f08aa8', '#d9a95c']);
    const c1 = p[0], c2 = p[1] || p[0], c3 = p[2] || p[0];
    const f = stageFeatures(stageId);
    const uid = 's' + (++svgCounter);
    const showZone = !(opts && opts.noZone) && !!ZONE[stageId];

    // 肤色层次
    const skin = '#fcdfcd', skinMid = '#f7ceb8', skinDeep = '#e7ae94', line = '#96706a';
    const s = [];

    s.push('<svg viewBox="0 0 420 420" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="妆容步骤配图">');
    s.push('<defs>');
    s.push('<linearGradient id="bg' + uid + '" x1="0" y1="0" x2="1" y2="1">'
      + '<stop offset="0" stop-color="' + rgba(c3, 0.42) + '"/>'
      + '<stop offset="1" stop-color="' + rgba(c1, 0.20) + '"/></linearGradient>');
    s.push('<radialGradient id="skin' + uid + '" cx="0.5" cy="0.40" r="0.74">'
      + '<stop offset="0" stop-color="' + skin + '"/>'
      + '<stop offset="0.70" stop-color="' + skinMid + '"/>'
      + '<stop offset="1" stop-color="' + skinDeep + '"/></radialGradient>');
    s.push('<radialGradient id="iris' + uid + '" cx="0.5" cy="0.36" r="0.66">'
      + '<stop offset="0" stop-color="#9a7250"/>'
      + '<stop offset="0.62" stop-color="#5f4230"/>'
      + '<stop offset="1" stop-color="#33231a"/></radialGradient>');
    s.push('<linearGradient id="lipg' + uid + '" x1="0" y1="0" x2="0.3" y2="1">'
      + '<stop offset="0" stop-color="' + rgbshade(c1, 1.10) + '"/>'
      + '<stop offset="1" stop-color="' + rgbshade(c2, 0.90) + '"/></linearGradient>');
    /* 腮红：中心浓、边缘完全透明 —— 才是「晕开」而不是一块色斑 */
    s.push('<radialGradient id="blush' + uid + '" cx="0.5" cy="0.5" r="0.5">'
      + '<stop offset="0" stop-color="' + rgba(c1, 0.52) + '"/>'
      + '<stop offset="0.5" stop-color="' + rgba(c1, 0.26) + '"/>'
      + '<stop offset="1" stop-color="' + rgba(c1, 0) + '"/></radialGradient>');
    /* 修容：极淡的软阴影，取代之前的粗描边 */
    s.push('<radialGradient id="contour' + uid + '" cx="0.5" cy="0.5" r="0.5">'
      + '<stop offset="0" stop-color="' + rgba(rgbshade(c2, 0.60), 0.26) + '"/>'
      + '<stop offset="0.6" stop-color="' + rgba(rgbshade(c2, 0.60), 0.12) + '"/>'
      + '<stop offset="1" stop-color="' + rgba(rgbshade(c2, 0.60), 0) + '"/></radialGradient>');
    /* 眼影：由睫毛根部向上渐隐 */
    s.push('<linearGradient id="es' + uid + '" x1="0.1" y1="1" x2="0.3" y2="0">'
      + '<stop offset="0" stop-color="' + rgba(c1, 0.60) + '"/>'
      + '<stop offset="0.55" stop-color="' + rgba(c2, 0.32) + '"/>'
      + '<stop offset="1" stop-color="' + rgba(c3, 0) + '"/></linearGradient>');
    /* 高光：柔和光斑 */
    s.push('<radialGradient id="hl' + uid + '" cx="0.5" cy="0.5" r="0.5">'
      + '<stop offset="0" stop-color="rgba(255,255,255,0.52)"/>'
      + '<stop offset="1" stop-color="rgba(255,255,255,0)"/></radialGradient>');
    s.push('</defs>');

    // 背景
    s.push('<rect width="420" height="420" fill="url(#bg' + uid + ')"/>');
    s.push('<circle cx="210" cy="192" r="152" fill="' + rgba('#ffffff', 0.30) + '"/>');

    // 头发（在脸后面）
    s.push('<path d="M96,206 C88,112 132,46 210,46 C288,46 332,112 324,206 '
      + 'C322,182 316,166 308,156 C298,144 286,140 274,142 L272,120 '
      + 'C238,100 182,100 148,120 L146,142 C134,140 122,144 112,156 C104,166 98,182 96,206 Z" '
      + 'fill="' + rgbshade(c2, 0.86) + '" opacity="0.92"/>');

    // 脖子 + 肩
    s.push('<path d="M186,332 L186,364 C150,372 120,388 104,410 L316,410 C300,388 270,372 234,364 L234,332 Z" '
      + 'fill="' + skinDeep + '"/>');

    // 脸型（带下颌收窄）
    s.push('<path d="M210,76 C266,76 300,118 302,176 C304,236 288,290 258,318 '
      + 'C238,336 220,344 210,344 C200,344 182,336 162,318 C132,290 116,236 118,176 C120,118 154,76 210,76 Z" '
      + 'fill="url(#skin' + uid + ')"/>');

    // 耳朵
    s.push('<ellipse cx="120" cy="206" rx="13" ry="21" fill="' + skinMid + '"/>');
    s.push('<ellipse cx="300" cy="206" rx="13" ry="21" fill="' + skinMid + '"/>');
    // 颧骨侧影
    s.push('<path d="M124,206 C122,244 132,280 152,302" stroke="' + rgba(skinDeep, 0.45) + '" stroke-width="13" fill="none" stroke-linecap="round"/>');
    s.push('<path d="M296,206 C298,244 288,280 268,302" stroke="' + rgba(skinDeep, 0.45) + '" stroke-width="13" fill="none" stroke-linecap="round"/>');

    /* ---- 左侧五官（右侧用镜像复制，保证对称） ---- */
    const EYE_X = 166, EYE_Y = 205, BROW_Y = 163;
    const FACE_FONT = 'PingFang SC, Microsoft YaHei, sans-serif';
    const EW = 22, EH = 11.5;   // 眼睛尺寸调到接近真人比例（原为脸宽的 31%，现约 24%）

    function brow() {
      const o = [];
      if (f.brow) {
        // 已画眉：柳叶形，眉尾收尖
        o.push('<path d="M136,' + (BROW_Y + 5) + ' C150,' + (BROW_Y - 10) + ' 174,' + (BROW_Y - 12) + ' 198,' + (BROW_Y + 3)
          + ' C184,' + (BROW_Y - 1) + ' 154,' + (BROW_Y - 3) + ' 136,' + (BROW_Y + 5) + ' Z" '
          + 'fill="' + rgba(rgbshade(c2, 0.58), 0.80) + '"/>');
        // 眉头压淡，避免整条一样深
        o.push('<ellipse cx="142" cy="' + (BROW_Y + 1) + '" rx="12" ry="8" fill="' + rgba(skin, 0.40) + '"/>');
        // 细毛流
        for (let k = 0; k < 7; k++) {
          const bx = 142 + k * 8.5;
          const by = BROW_Y + 2 - Math.sin(k / 6 * Math.PI) * 7;
          o.push('<path d="M' + bx + ',' + by + ' l3.5,-3.5" stroke="' + rgba(rgbshade(c2, 0.5), 0.5)
            + '" stroke-width="1.2" stroke-linecap="round"/>');
        }
      } else {
        // 素眉：更淡更柔
        o.push('<path d="M140,' + (BROW_Y + 4) + ' C154,' + (BROW_Y - 7) + ' 176,' + (BROW_Y - 9) + ' 194,' + (BROW_Y + 2) + '" '
          + 'stroke="' + rgba('#9c7a6c', 0.42) + '" stroke-width="4.2" fill="none" stroke-linecap="round"/>');
      }
      return o.join('');
    }

    function eye() {
      const cx = EYE_X, cy = EYE_Y, o = [];
      // 眼窝软阴影
      o.push('<ellipse cx="' + cx + '" cy="' + (cy - 4) + '" rx="27" ry="15" fill="' + rgba(skinDeep, 0.20) + '"/>');
      // 眼影（已上妆）：由睫毛根部向上渐隐
      if (f.eye) {
        o.push('<path d="M' + (cx - 24) + ',' + (cy + 2) + ' C' + (cx - 15) + ',' + (cy - 17) + ' ' + (cx + 9) + ',' + (cy - 18) + ' ' + (cx + 23) + ',' + (cy - 4)
          + ' C' + (cx + 8) + ',' + (cy - 10) + ' ' + (cx - 10) + ',' + (cy - 4) + ' ' + (cx - 24) + ',' + (cy + 2) + ' Z" fill="url(#es' + uid + ')"/>');
        // 眼尾加深
        o.push('<ellipse cx="' + (cx + 16) + '" cy="' + (cy - 6) + '" rx="10" ry="7" fill="' + rgba(c1, 0.26) + '"/>');
      }
      // 眼白
      o.push('<path d="M' + (cx - EW) + ',' + cy + ' C' + (cx - 13) + ',' + (cy - EH) + ' ' + (cx + 13) + ',' + (cy - EH) + ' ' + (cx + EW) + ',' + cy
        + ' C' + (cx + 13) + ',' + (cy + EH - 2) + ' ' + (cx - 13) + ',' + (cy + EH - 2) + ' ' + (cx - EW) + ',' + cy + ' Z" fill="#fdfaf8"/>');
      // 虹膜
      o.push('<circle cx="' + cx + '" cy="' + cy + '" r="9.4" fill="url(#iris' + uid + ')"/>');
      o.push('<circle cx="' + cx + '" cy="' + cy + '" r="3.9" fill="#1c1310"/>');
      o.push('<circle cx="' + (cx - 3.4) + '" cy="' + (cy - 3.8) + '" r="2.7" fill="#ffffff" opacity="0.92"/>');
      o.push('<circle cx="' + (cx + 3.8) + '" cy="' + (cy + 3.8) + '" r="1.4" fill="#ffffff" opacity="0.5"/>');
      // 上眼睑：细，深棕而非纯黑
      o.push('<path d="M' + (cx - EW) + ',' + cy + ' C' + (cx - 13) + ',' + (cy - EH) + ' ' + (cx + 13) + ',' + (cy - EH) + ' ' + (cx + EW) + ',' + cy
        + '" stroke="#7a5a52" stroke-width="1.8" fill="none" stroke-linecap="round"/>');
      // 双眼皮褶
      o.push('<path d="M' + (cx - 16) + ',' + (cy - 8) + ' C' + (cx - 9) + ',' + (cy - 16) + ' ' + (cx + 9) + ',' + (cy - 16) + ' ' + (cx + 16) + ',' + (cy - 8)
        + '" stroke="' + rgba('#9c7a72', 0.36) + '" stroke-width="1.2" fill="none" stroke-linecap="round"/>');
      // 下眼睑：很淡
      o.push('<path d="M' + (cx - 17) + ',' + (cy + 5) + ' C' + (cx - 9) + ',' + (cy + 10) + ' ' + (cx + 9) + ',' + (cy + 10) + ' ' + (cx + 17) + ',' + (cy + 5)
        + '" stroke="' + rgba('#b08a80', 0.38) + '" stroke-width="1.1" fill="none" stroke-linecap="round"/>');
      // 眼线 + 睫毛（已上妆）
      if (f.eye) {
        o.push('<path d="M' + (cx - EW - 1) + ',' + (cy + 0.4) + ' C' + (cx - 13) + ',' + (cy - EH - 0.8) + ' ' + (cx + 13) + ',' + (cy - EH - 0.8)
          + ' ' + (cx + EW + 1) + ',' + (cy - 1.2) + ' C' + (cx + EW + 5) + ',' + (cy - 3) + ' ' + (cx + EW + 8) + ',' + (cy - 5.2) + ' ' + (cx + EW + 9) + ',' + (cy - 6.6) + '" '
          + 'stroke="#3d2b30" stroke-width="1.9" fill="none" stroke-linecap="round"/>');
        // 睫毛：细、扇形、只在上眼睑
        for (let k = 0; k < 6; k++) {
          const t = k / 5;
          const lx = cx - 16 + k * 7.2;
          const ly = cy - 9 + Math.abs(t - 0.5) * 3.4;
          const len = 4.2 + Math.sin(t * Math.PI) * 2.2 + t * 3.4;
          o.push('<path d="M' + lx + ',' + ly + ' q1.1,-' + (len * 0.55).toFixed(1) + ' 2.2,-' + len.toFixed(1) + '" '
            + 'stroke="#3d2b30" stroke-width="1.15" fill="none" stroke-linecap="round" opacity="0.82"/>');
        }
      }
      return o.join('');
    }

    function cheek() {
      const o = [];
      if (f.cheek) {
        // 修容：极淡软阴影（不再用粗描边，避免像糊了泥）
        o.push('<ellipse cx="144" cy="252" rx="33" ry="19" fill="url(#contour' + uid + ')" transform="rotate(-16 144 252)"/>');
        // 腮红：径向渐变晕开
        o.push('<ellipse cx="156" cy="240" rx="33" ry="23" fill="url(#blush' + uid + ')"/>');
        // 高光：柔和光斑
        o.push('<ellipse cx="152" cy="220" rx="24" ry="9" fill="url(#hl' + uid + ')"/>');
      }
      return o.join('');
    }

    const leftSide = function () { return brow() + eye() + cheek(); };
    s.push('<g>' + leftSide() + '</g>');
    s.push('<g transform="translate(420,0) scale(-1,1)">' + leftSide() + '</g>');

    /* ---- 鼻子：只用柔和明暗，不画硬线与鼻孔（硬线 + 两个深色点会读成小胡子） ---- */
    s.push('<path d="M205,202 C203,222 201,236 198,244" stroke="' + rgba(skinDeep, 0.28)
      + '" stroke-width="9" fill="none" stroke-linecap="round"/>');
    s.push('<ellipse cx="212" cy="214" rx="4.5" ry="17" fill="' + rgba('#ffffff', 0.24) + '"/>');
    s.push('<ellipse cx="210" cy="246" rx="10" ry="4" fill="' + rgba(skinDeep, 0.16) + '"/>');

    /* ---- 唇 ---- */
    // 唇形：上唇有唇峰、下唇更饱满
    const lipPath = 'M180,277 C188,268 199,263 210,270 C221,263 232,268 240,277 '
      + 'C234,284 222,291 210,295 C198,291 186,284 180,277 Z';
    if (f.lip) {
      s.push('<path d="' + lipPath + '" fill="url(#lipg' + uid + ')"/>');
      // 唇缝：淡，不能画成硬线
      s.push('<path d="M180,277 C196,279.5 224,279.5 240,277" stroke="' + rgba('#8a4d52', 0.38)
        + '" stroke-width="1.2" fill="none"/>');
      // 下唇高光：柔光斑
      s.push('<ellipse cx="210" cy="286" rx="15" ry="4.5" fill="' + rgba('#ffffff', 0.20) + '"/>');
      if (stageId === 'lip') {
        // 只在这一步显示唇峰与中线提示
        s.push('<path d="M210,271 L210,293" stroke="' + rgba('#ffffff', 0.34) + '" stroke-width="1.1"/>');
        s.push('<ellipse cx="196" cy="267" rx="5" ry="3" fill="' + rgba('#ffffff', 0.28) + '"/>');
        s.push('<ellipse cx="224" cy="267" rx="5" ry="3" fill="' + rgba('#ffffff', 0.28) + '"/>');
      }
    } else {
      s.push('<path d="' + lipPath + '" fill="#dba8a2"/>');
      s.push('<path d="M180,277 C196,279.5 224,279.5 240,277" stroke="' + rgba('#b0837e', 0.5)
        + '" stroke-width="1.2" fill="none"/>');
    }

    /* ---- 定妆/护肤的光泽 ---- */
    if (f.glow) {
      s.push('<ellipse cx="164" cy="150" rx="30" ry="13" fill="' + rgba('#ffffff', 0.22) + '"/>');
      s.push('<ellipse cx="256" cy="150" rx="30" ry="13" fill="' + rgba('#ffffff', 0.22) + '"/>');
      s.push('<ellipse cx="210" cy="132" rx="40" ry="14" fill="' + rgba('#ffffff', 0.20) + '"/>');
    }
    if (f.clean) {
      s.push('<circle cx="86" cy="120" r="13" fill="none" stroke="' + rgba('#7fc8e8', 0.85) + '" stroke-width="2"/>');
      s.push('<circle cx="104" cy="140" r="8" fill="none" stroke="' + rgba('#7fc8e8', 0.85) + '" stroke-width="2"/>');
      s.push('<circle cx="334" cy="96" r="10" fill="none" stroke="' + rgba('#7fc8e8', 0.85) + '" stroke-width="2"/>');
      s.push('<circle cx="346" cy="114" r="5.5" fill="none" stroke="' + rgba('#7fc8e8', 0.85) + '" stroke-width="2"/>');
    }

    /* ---- 当前步骤的标注框 ---- */
    if (showZone) {
      const z = ZONE[stageId];
      s.push('<rect x="' + z.x + '" y="' + z.y + '" width="' + z.w + '" height="' + z.h + '" rx="20" '
        + 'fill="none" stroke="' + c1 + '" stroke-width="2.4" stroke-dasharray="9 7" opacity="0.9"/>');
      s.push('<rect x="30" y="378" width="360" height="32" rx="16" fill="' + rgba('#ffffff', 0.92) + '"/>');
      s.push('<text x="210" y="399" text-anchor="middle" font-size="14.5" font-weight="700" fill="' + rgbshade(c2, 0.8)
        + '" font-family="PingFang SC, Microsoft YaHei, sans-serif">' + escapeXmlText(z.label) + '</text>');
    }

    /* ---- 左右对称参考线（可选） ---- */
    if (opts && opts.grid) {
      const FONT = 'PingFang SC, Microsoft YaHei, sans-serif';
      const gl = 'rgba(236, 95, 138, 0.52)';
      const gs = 'rgba(236, 95, 138, 0.26)';
      // 中轴线
      s.push('<line x1="210" y1="62" x2="210" y2="372" stroke="' + gl + '" stroke-width="1.3" stroke-dasharray="9 7"/>');
      // 横向基准线：眉 / 眼 / 鼻底 / 唇
      [[BROW_Y, '眉'], [EYE_Y, '眼'], [248, '鼻底'], [287, '唇']].forEach(function (r) {
        s.push('<line x1="92" y1="' + r[0] + '" x2="328" y2="' + r[0] + '" stroke="' + gs
          + '" stroke-width="1.1" stroke-dasharray="7 7"/>');
        s.push('<text x="86" y="' + (r[0] + 4) + '" text-anchor="end" font-size="11" fill="' + gs
          + '" font-family="' + FONT + '">' + r[1] + '</text>');
      });
      // 双眼垂直对齐线（用来检查两边是否等高）
      s.push('<line x1="166" y1="152" x2="166" y2="232" stroke="' + gs + '" stroke-width="1" stroke-dasharray="4 5"/>');
      s.push('<line x1="254" y1="152" x2="254" y2="232" stroke="' + gs + '" stroke-width="1" stroke-dasharray="4 5"/>');
      // 左右标记
      s.push('<text x="104" y="90" font-size="11.5" font-weight="700" fill="' + gs + '" font-family="' + FONT + '">左</text>');
      s.push('<text x="308" y="90" font-size="11.5" font-weight="700" fill="' + gs + '" font-family="' + FONT + '">右</text>');
    }

    s.push('</svg>');
    return s.join('');
  }

  /* 局部特写：眼妆 / 眉妆 / 唇妆 / 修容 的技法示意 */
  function renderCloseupSVG(stageId, palette) {
    const p = (palette && palette.length ? palette : ['#e2557f', '#c4456c', '#f08aa8']);
    const c1 = p[0], c2 = p[1] || p[0], c3 = p[2] || p[0];
    const uid = 'c' + (++svgCounter);
    const s = [];
    const F = 'PingFang SC, Microsoft YaHei, sans-serif';

    function chip(x, y, text, fill) {
      const w = 18 + text.length * 13;
      return '<rect x="' + x + '" y="' + y + '" width="' + w + '" height="24" rx="12" fill="' + fill + '"/>'
        + '<text x="' + (x + w / 2) + '" y="' + (y + 16.5) + '" text-anchor="middle" font-size="12.5" font-weight="700" '
        + 'fill="#ffffff" font-family="' + F + '">' + escapeXmlText(text) + '</text>';
    }

    if (stageId === 'eye') {
      s.push('<svg viewBox="0 0 420 210" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="眼妆技法特写">');
      s.push('<defs><radialGradient id="iris' + uid + '" cx="0.5" cy="0.36" r="0.66">'
        + '<stop offset="0" stop-color="#9a7250"/><stop offset="0.62" stop-color="#5f4230"/><stop offset="1" stop-color="#33231a"/></radialGradient></defs>');
      s.push('<rect width="420" height="210" fill="' + rgba(c3, 0.16) + '"/>');
      const cx = 210, cy = 108;
      // 眼皮底
      s.push('<path d="M' + (cx - 96) + ',' + (cy + 10) + ' C' + (cx - 70) + ',' + (cy - 62) + ' ' + (cx + 70) + ',' + (cy - 62) + ' ' + (cx + 96) + ',' + (cy + 10)
        + ' C' + (cx + 60) + ',' + (cy - 6) + ' ' + (cx - 60) + ',' + (cy - 6) + ' ' + (cx - 96) + ',' + (cy + 10) + ' Z" fill="#fcdfcd"/>');
      // 三层眼影
      s.push('<path d="M' + (cx - 92) + ',' + (cy + 2) + ' C' + (cx - 66) + ',' + (cy - 56) + ' ' + (cx + 66) + ',' + (cy - 56) + ' ' + (cx + 92) + ',' + (cy + 2)
        + ' C' + (cx + 54) + ',' + (cy - 12) + ' ' + (cx - 54) + ',' + (cy - 12) + ' ' + (cx - 92) + ',' + (cy + 2) + ' Z" fill="' + rgba(c3, 0.72) + '"/>');
      s.push('<path d="M' + (cx - 70) + ',' + (cy - 12) + ' C' + (cx - 44) + ',' + (cy - 50) + ' ' + (cx + 40) + ',' + (cy - 50) + ' ' + (cx + 74) + ',' + (cy - 4)
        + ' C' + (cx + 34) + ',' + (cy - 20) + ' ' + (cx - 34) + ',' + (cy - 22) + ' ' + (cx - 70) + ',' + (cy - 12) + ' Z" fill="' + rgba(c2, 0.82) + '"/>');
      s.push('<path d="M' + (cx + 30) + ',' + (cy - 22) + ' C' + (cx + 52) + ',' + (cy - 34) + ' ' + (cx + 70) + ',' + (cy - 22) + ' ' + (cx + 78) + ',' + (cy - 4)
        + ' C' + (cx + 58) + ',' + (cy - 14) + ' ' + (cx + 42) + ',' + (cy - 18) + ' ' + (cx + 30) + ',' + (cy - 22) + ' Z" fill="' + rgba(c1, 0.92) + '"/>');
      // 眼球
      s.push('<path d="M' + (cx - 88) + ',' + (cy + 12) + ' C' + (cx - 56) + ',' + (cy - 22) + ' ' + (cx + 56) + ',' + (cy - 22) + ' ' + (cx + 88) + ',' + (cy + 12)
        + ' C' + (cx + 56) + ',' + (cy + 46) + ' ' + (cx - 56) + ',' + (cy + 46) + ' ' + (cx - 88) + ',' + (cy + 12) + ' Z" fill="#fdfaf8"/>');
      s.push('<circle cx="' + cx + '" cy="' + (cy + 10) + '" r="30" fill="url(#iris' + uid + ')" />');
      s.push('<circle cx="' + cx + '" cy="' + (cy + 10) + '" r="13" fill="#1c1310"/>');
      s.push('<circle cx="' + (cx - 11) + '" cy="' + (cy - 2) + '" r="8" fill="#ffffff" opacity="0.95"/>');
      // 眼线
      s.push('<path d="M' + (cx - 90) + ',' + (cy + 8) + ' C' + (cx - 56) + ',' + (cy - 24) + ' ' + (cx + 56) + ',' + (cy - 24) + ' ' + (cx + 92) + ',' + (cy + 6)
        + ' L' + (cx + 116) + ',' + (cy - 12) + '" stroke="#2a1f28" stroke-width="6" fill="none" stroke-linecap="round"/>');
      // 睫毛
      for (let k = 0; k < 7; k++) {
        const lx = cx - 62 + k * 21;
        s.push('<path d="M' + lx + ',' + (cy - 18) + ' l' + (k > 4 ? 10 : 3) + ',-18" stroke="#2a1f28" stroke-width="3" stroke-linecap="round"/>');
      }
      // 标注
      s.push(chip(16, 16, '① 浅色打底', rgba(c3, 0.95)));
      s.push(chip(150, 16, '② 主色铺眼窝', rgba(c2, 0.95)));
      s.push(chip(308, 16, '③ 深色加深眼尾', rgba(c1, 0.95)));
      s.push('<text x="16" y="196" font-size="12.5" fill="#6f6473" font-family="' + F + '">箭头方向 = 从睫毛根部向眼窝晕染；眼尾向上拉长</text>');
      s.push('</svg>');
      return s.join('');
    }

    if (stageId === 'brow') {
      s.push('<svg viewBox="0 0 420 190" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="眉妆技法特写">');
      s.push('<rect width="420" height="190" fill="' + rgba(c3, 0.16) + '"/>');
      s.push('<rect x="30" y="52" width="360" height="86" rx="43" fill="#fcdfcd"/>');
      // 眉形
      s.push('<path d="M70,116 C110,64 210,52 300,74 C326,80 340,90 348,100 '
        + 'C320,96 250,86 190,94 C140,101 100,110 70,116 Z" fill="' + rgba(rgbshade(c2, 0.66), 0.95) + '"/>');
      // 毛流
      for (let k = 0; k < 12; k++) {
        const bx = 80 + k * 22;
        const by = 112 - Math.sin(k / 12 * Math.PI) * 34;
        s.push('<path d="M' + bx + ',' + by + ' l13,-11" stroke="' + rgba(rgbshade(c2, 0.5), 0.75) + '" stroke-width="2.4" stroke-linecap="round"/>');
      }
      // 三点标记
      const pts = [[70, 112, '眉头', '起点·浅'], [248, 62, '眉峰', '最高点'], [348, 100, '眉尾', '收尖·深']];
      pts.forEach(function (pt) {
        s.push('<circle cx="' + pt[0] + '" cy="' + pt[1] + '" r="6.5" fill="' + c1 + '" stroke="#fff" stroke-width="2.5"/>');
      });
      s.push(chip(16, 14, '眉头：与鼻翼对齐，最浅', rgba(c3, 0.95)));
      s.push(chip(20, 150, '眉峰：瞳孔外侧上方', rgba(c2, 0.95)));
      s.push(chip(250, 150, '眉尾：鼻翼-眼尾延长线，收尖', rgba(c1, 0.95)));
      s.push('<text x="196" y="52" text-anchor="middle" font-size="12.5" fill="#6f6473" font-family="' + F + '">顺毛流一笔笔描画 · 前浅后深</text>');
      s.push('</svg>');
      return s.join('');
    }

    if (stageId === 'lip') {
      s.push('<svg viewBox="0 0 420 200" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="唇妆技法特写">');
      s.push('<rect width="420" height="200" fill="' + rgba(c3, 0.16) + '"/>');
      s.push('<defs><linearGradient id="lg' + uid + '" x1="0" y1="0" x2="0" y2="1">'
        + '<stop offset="0" stop-color="' + rgbshade(c1, 1.12) + '"/>'
        + '<stop offset="1" stop-color="' + rgbshade(c2, 0.86) + '"/></linearGradient></defs>');
      // 唇
      s.push('<path d="M100,100 C130,72 170,66 210,84 C250,66 290,72 320,100 '
        + 'C290,120 250,136 210,146 C170,136 130,120 100,100 Z" fill="url(#lg' + uid + ')"/>');
      // 唇峰
      s.push('<path d="M210,84 C204,76 196,76 192,82 C198,84 204,86 210,84 Z" fill="' + rgba('#ffffff', 0.28) + '"/>');
      s.push('<path d="M210,84 C216,76 224,76 228,82 C222,84 216,86 210,84 Z" fill="' + rgba('#ffffff', 0.28) + '"/>');
      // 唇中高光
      s.push('<ellipse cx="210" cy="126" rx="42" ry="12" fill="' + rgba('#ffffff', 0.30) + '"/>');
      // 中线
      s.push('<path d="M100,100 C150,104 270,104 320,100" stroke="' + rgba(rgbshade(c2, 0.7), 0.7) + '" stroke-width="2.2" fill="none"/>');
      // 由内向外的箭头
      s.push('<path d="M210,168 L150,168" stroke="' + c1 + '" stroke-width="3" stroke-linecap="round"/>');
      s.push('<path d="M156,163 L148,168 L156,173" fill="none" stroke="' + c1 + '" stroke-width="3" stroke-linecap="round"/>');
      s.push('<path d="M210,168 L270,168" stroke="' + c1 + '" stroke-width="3" stroke-linecap="round"/>');
      s.push('<path d="M264,163 L272,168 L264,173" fill="none" stroke="' + c1 + '" stroke-width="3" stroke-linecap="round"/>');
      s.push('<circle cx="210" cy="168" r="5" fill="' + c1 + '"/>');
      // 标注
      s.push('<circle cx="192" cy="80" r="6" fill="' + c1 + '" stroke="#fff" stroke-width="2.5"/>');
      s.push('<circle cx="228" cy="80" r="6" fill="' + c1 + '" stroke="#fff" stroke-width="2.5"/>');
      s.push(chip(16, 14, '唇峰：勾勒出 M 形', rgba(c3, 0.95)));
      s.push(chip(250, 14, '唇心：色最饱满', rgba(c2, 0.95)));
      s.push('<text x="210" y="190" text-anchor="middle" font-size="12.5" fill="#6f6473" font-family="' + F + '">从唇心向外晕开，边缘用手指虚化更自然</text>');
      s.push('</svg>');
      return s.join('');
    }

    if (stageId === 'cheek') {
      s.push('<svg viewBox="0 0 420 210" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="腮红修容技法特写">');
      s.push('<rect width="420" height="210" fill="' + rgba(c3, 0.16) + '"/>');
      // 侧脸轮廓
      s.push('<path d="M60,20 C150,10 250,30 300,96 C336,144 320,190 280,200 L60,200 Z" fill="#fcdfcd"/>');
      // 修容区
      s.push('<path d="M120,112 C160,128 210,138 252,134 C246,152 210,168 168,164 C138,160 122,138 120,112 Z" fill="' + rgba(rgbshade(c2, 0.66), 0.42) + '"/>');
      // 腮红区
      s.push('<ellipse cx="176" cy="112" rx="46" ry="30" fill="' + rgba(c1, 0.48) + '"/>');
      // 高光区
      s.push('<ellipse cx="196" cy="76" rx="52" ry="15" fill="' + rgba('#ffffff', 0.55) + '"/>');
      // 箭头
      s.push('<path d="M110,168 C160,180 220,180 262,150" stroke="' + c1 + '" stroke-width="3" fill="none" stroke-linecap="round"/>');
      s.push('<path d="M254,144 L264,149 L255,157" fill="none" stroke="' + c1 + '" stroke-width="3" stroke-linecap="round"/>');
      s.push(chip(288, 34, '① 修容：颧骨下方', rgba(c2, 0.95)));
      s.push(chip(288, 84, '② 腮红：苹果肌', rgba(c1, 0.95)));
      s.push(chip(288, 134, '③ 高光：颧骨最高点', rgba(c3, 0.95)));
      s.push('<text x="16" y="200" font-size="12.5" fill="#6f6473" font-family="' + F + '">腮红斜向上扫更立体；圆脸斜扫、长脸横扫</text>');
      s.push('</svg>');
      return s.join('');
    }

    return '';
  }

  return {
    loadConfig: loadConfig,
    saveConfig: saveConfig,
    defaultConfig: defaultConfig,
    PROVIDERS: PROVIDERS,
    fileToDataURL: fileToDataURL,
    compressImage: compressImage,
    prepareForAPI: prepareForAPI,
    analyzeColors: analyzeColors,
    matchLookByColor: matchLookByColor,
    inferSkinFromImage: inferSkinFromImage,
    checkQuizCompleteness: checkQuizCompleteness,
    recognizeLook: recognizeLook,
    analyzeSkin: analyzeSkin,
    analyzeSkinByRules: analyzeSkinByRules,
    recommendLooks: recommendLooks,
    LOOK_FIT: LOOK_FIT,
    renderFaceSVG: renderFaceSVG,
    renderCloseupSVG: renderCloseupSVG,
    hasApi: hasApi,
    isLocalProxy: isLocalProxy,
    needsBrowserKey: needsBrowserKey,
    isLocalEnv: isLocalEnv,
    apiBase: apiBase,
    testConnection: testConnection,
    PROXY_BASE: PROXY_BASE,
    SITE_API: SITE_API
  };
})();
