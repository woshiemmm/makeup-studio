#!/usr/bin/env node
/* ============================================================
 * tools/gen-seo.js
 * ------------------------------------------------------------
 * 把 data.js 里的 8 种妆容与 8 个教学阶段渲染成「静态 HTML」，
 * 注入 index.html 的 SEO-OVERVIEW 标记之间。
 *
 * 为什么要这么做：页面主体内容原本由 JS 动态生成，搜索引擎
 * 抓到的只是一个空容器。注入静态正文后，百度 / Google 能直接
 * 读到完整的妆容名、步骤、技巧等中文内容，才谈得上「被搜到」。
 *
 * 用法：node tools/gen-seo.js
 * ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const START = '<!-- SEO-OVERVIEW:START -->';
const END = '<!-- SEO-OVERVIEW:END -->';

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

/* 载入 data.js */
function loadData() {
  const code = fs.readFileSync(path.join(ROOT, 'data.js'), 'utf8');
  const sandbox = {};
  // data.js 形如 window.MAKEUP_DATA = {...}
  const fn = new Function('window', code + '\nreturn window.MAKEUP_DATA;');
  return fn(sandbox);
}

function buildOverview(D) {
  const out = [];
  /* 用 <details> 折叠：界面上不占地方，但正文仍在 HTML 里，搜索引擎照样抓得到 */
  out.push('<details class="seo-fold">');
  out.push('  <summary>');
  out.push('    <span class="seo-fold-title">📖 全部妆容与完整流程一览</span>');
  out.push('    <span class="seo-fold-sub">' + D.looks.length + ' 种妆容 · ' + D.stages.length +
    ' 个步骤 · 点击展开</span>');
  out.push('  </summary>');
  out.push('  <div class="seo-overview" id="overview">');

  /* 妆容 */
  out.push('  <h4 class="ov-h">八种妆容风格</h4>');
  out.push('  <div class="ov-looks">');
  D.looks.forEach(function (l) {
    out.push('    <article class="ov-look">');
    out.push('      <div class="ov-look-band" style="background:linear-gradient(135deg,' +
      esc(l.palette[0]) + ',' + esc(l.palette[1] || l.palette[0]) + ')"></div>');
    out.push('      <div class="ov-look-body">');
    out.push('        <h5>' + esc(l.name) + ' <small>' + esc(l.en) + '</small></h5>');
    out.push('        <p class="ov-tag">' + esc(l.tagline) + '</p>');
    out.push('        <p class="ov-desc">' + esc(l.desc) + '</p>');
    out.push('        <p class="ov-meta">难度：' + esc(l.difficulty) + ' ｜ 适合：' + esc(l.occasion) + '</p>');
    out.push('        <p class="ov-eco">配色：' + l.palette.map(esc).join(' · ') + '</p>');
    out.push('      </div>');
    out.push('    </article>');
  });
  out.push('  </div>');

  /* 流程 */
  out.push('  <h4 class="ov-h">完整化妆流程（' + D.stages.length + ' 步）</h4>');
  out.push('  <div class="ov-stages">');
  D.stages.forEach(function (s, i) {
    out.push('    <article class="ov-stage">');
    out.push('      <h5>' + (i + 1) + '. ' + esc(s.icon) + ' ' + esc(s.title) + '</h5>');
    out.push('      <p class="ov-intro">' + esc(s.intro) + '</p>');
    out.push('      <ol>');
    s.steps.forEach(function (st) {
      out.push('        <li><b>' + esc(st.name) + '</b>：' + esc(st.desc) +
        (st.tip ? ' <i>（贴士：' + esc(st.tip) + '）</i>' : '') + '</li>');
    });
    out.push('      </ol>');
    out.push('      <p class="ov-meta">所需产品：' + s.products.map(esc).join('、') + '</p>');
    out.push('    </article>');
  });
  out.push('  </div>');
  out.push('  </div>');
  out.push('</details>');
  return out.join('\n');
}

function main() {
  const D = loadData();
  if (!D || !D.looks || !D.stages) {
    console.error('✗ 无法从 data.js 读取 MAKEUP_DATA');
    process.exit(1);
  }

  const htmlPath = path.join(ROOT, 'index.html');
  let html = fs.readFileSync(htmlPath, 'utf8');

  const a = html.indexOf(START);
  const b = html.indexOf(END);
  if (a === -1 || b === -1) {
    console.error('✗ index.html 中找不到 SEO-OVERVIEW 标记');
    process.exit(1);
  }

  const block = START + '\n' + buildOverview(D) + '\n      ' + END;
  const next = html.slice(0, a) + block + html.slice(b + END.length);

  if (next === html) {
    console.log('· SEO 内容块无变化');
  } else {
    fs.writeFileSync(htmlPath, next, 'utf8');
    console.log('✓ 已写入静态 SEO 内容块：' +
      D.looks.length + ' 种妆容 + ' + D.stages.length + ' 个阶段');
  }
}

main();
