#!/usr/bin/env node
/* ============================================================
 * tools/gen-seo.js
 * ------------------------------------------------------------
 * 把 data.js 里的全部妆容与 8 个教学阶段渲染成一个**独立的静态页**
 * guide.html —— 给搜索引擎抓的正文页。
 *
 * 为什么不再注入 index.html：
 *   index.html 是应用外壳，把 500 行正文塞进去会让页面非常臃肿。
 *   独立成页后，应用页面保持干净，正文照样能被百度 / Google 抓到，
 *   而且可以单独被收录、单独出现在搜索结果里。
 *
 * 用法：node tools/gen-seo.js
 * ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'guide.html');
const SITE = process.env.SITE_URL || 'https://makeup-studio-2ak.pages.dev';

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

function loadData() {
  const code = fs.readFileSync(path.join(ROOT, 'data.js'), 'utf8');
  const sandbox = {};
  const fn = new Function('window', code + '\nreturn window.MAKEUP_DATA;');
  return fn(sandbox);
}

/* ---------------- 正文 ---------------- */
function buildBody(D) {
  const out = [];

  out.push('<h1>全部妆容与完整化妆流程</h1>');
  out.push('<p class="gd-lead">' + D.looks.length + ' 种妆容风格、' + D.stages.length +
    ' 个化妆阶段，从妆前准备到妆后护肤的完整步骤与要点。' +
    '每一种妆容都可以在应用里按步骤跟着画。</p>');

  out.push('<p class="gd-cta"><a class="btn primary" href="./">→ 打开妆造教学应用</a></p>');

  /* ---- 妆容 ---- */
  out.push('<h2 class="ov-h">' + D.looks.length + ' 种妆容风格</h2>');
  const byGroup = {};
  D.looks.forEach(function (l) {
    const g = l.group || 'female';
    (byGroup[g] = byGroup[g] || []).push(l);
  });
  const groupName = { female: '日常女妆', male: '男生妆容', cos: 'Cos · 舞台' };
  const audName = { f: '偏女性', m: '偏男性', any: '男女皆可' };

  ['female', 'male', 'cos'].forEach(function (g) {
    const list = byGroup[g] || [];
    if (!list.length) return;
    out.push('<h3 class="gd-sub">' + esc(groupName[g]) + '（' + list.length + ' 种）</h3>');
    out.push('<div class="ov-looks">');
    list.forEach(function (l) {
      out.push('  <article class="ov-look">');
      out.push('    <div class="ov-look-band" style="background:linear-gradient(135deg,' +
        esc(l.palette[0]) + ',' + esc(l.palette[1] || l.palette[0]) + ')"></div>');
      out.push('    <div class="ov-look-body">');
      out.push('      <h5><a href="./#/teach/' + esc(l.id) + '">' + esc(l.name) + '</a> <small>' + esc(l.en) + '</small></h5>');
      out.push('      <p class="ov-tag">' + esc(l.tagline) + '</p>');
      out.push('      <p class="ov-desc">' + esc(l.desc) + '</p>');
      out.push('      <p class="ov-meta">难度：' + esc(l.difficulty) +
        ' ｜ 适合：' + esc(l.occasion) +
        ' ｜ 适合人群：' + esc(audName[l.audience] || '男女皆可') + '</p>');
      out.push('      <p class="ov-eco">配色：' + l.palette.map(esc).join(' · ') + '</p>');
      out.push('    </div>');
      out.push('  </article>');
    });
    out.push('</div>');
  });

  /* ---- 完整流程 ---- */
  out.push('<h2 class="ov-h">完整化妆流程（' + D.stages.length + ' 步）</h2>');
  out.push('<p class="gd-lead">这是所有妆容通用的标准流程。每一步都包含做法、要点与所需产品。</p>');
  out.push('<div class="ov-stages">');
  D.stages.forEach(function (s, i) {
    out.push('  <article class="ov-stage">');
    out.push('    <h5>' + (i + 1) + '. ' + esc(s.icon) + ' ' + esc(s.title) + '</h5>');
    out.push('    <p class="ov-intro">' + esc(s.intro) + '</p>');
    out.push('    <ol>');
    (s.steps || []).forEach(function (st) {
      out.push('      <li><b>' + esc(st.name) + '</b>：' + esc(st.desc) +
        (st.tip ? ' <i>（贴士：' + esc(st.tip) + '）</i>' : '') + '</li>');
    });
    out.push('    </ol>');
    if (s.products && s.products.length) {
      out.push('    <p class="ov-meta">所需产品：' + s.products.map(esc).join('、') + '</p>');
    }
    out.push('  </article>');
  });
  out.push('</div>');

  return out.join('\n');
}

/* ---------------- 页面 ---------------- */
function buildPage(D) {
  const title = '全部妆容与完整化妆流程一览 · 妆 · 妆造教学';
  const desc = D.looks.length + ' 种妆容风格（含日常女妆、男生妆容、Cos 舞台）与从妆前准备到妆后护肤的 ' +
    D.stages.length + ' 步完整化妆流程，含具体做法、要点与所需产品。';
  return '<!DOCTYPE html>\n<html lang="zh-CN">\n<head>\n' +
'<meta charset="UTF-8" />\n' +
'<meta name="viewport" content="width=device-width, initial-scale=1" />\n' +
'<title>' + esc(title) + '</title>\n' +
'<meta name="description" content="' + esc(desc) + '" />\n' +
'<meta name="keywords" content="化妆教程,妆容大全,化妆流程,男生化妆,cos妆,新手化妆步骤" />\n' +
'<link rel="canonical" href="' + SITE + '/guide.html" />\n' +
'<link rel="icon" href="favicon.svg" type="image/svg+xml" />\n' +
'<link rel="stylesheet" href="styles.css" />\n' +
'<style>\n' +
'  .gd-wrap { max-width: 900px; margin: 0 auto; padding: 28px 20px 80px; }\n' +
'  .gd-top { display: flex; align-items: center; justify-content: space-between; gap: 14px;\n' +
'            flex-wrap: wrap; margin-bottom: 26px; }\n' +
'  .gd-brand { font-size: 17px; font-weight: 800; color: var(--ink); }\n' +
'  .gd-lead { color: var(--ink-soft); font-size: 14px; line-height: 1.9; margin: 0 0 16px; }\n' +
'  .gd-cta { margin: 0 0 30px; }\n' +
'  .gd-cta a { text-decoration: none; display: inline-block; }\n' +
'  .gd-sub { font-size: 15px; margin: 22px 0 12px; color: var(--primary-2); }\n' +
'  .gd-foot { margin-top: 40px; padding-top: 20px; border-top: 1px solid var(--line);\n' +
'             color: var(--ink-faint); font-size: 12.5px; }\n' +
'</style>\n' +
'</head>\n<body>\n<div class="gd-wrap">\n' +
'  <div class="gd-top">\n' +
'    <span class="gd-brand">💄 妆 · 妆造教学</span>\n' +
'    <a class="btn ghost" href="./">← 回到应用</a>\n' +
'  </div>\n' +
  buildBody(D) + '\n' +
'  <p class="gd-foot">本页为静态内容页，供检索与通读；交互式跟练请回到应用。' +
'内容仅作学习参考，产品价格为大致区间，请以平台实际为准。</p>\n' +
'</div>\n</body>\n</html>\n';
}

function main() {
  const D = loadData();
  if (!D || !D.looks || !D.stages) {
    console.error('✗ 无法从 data.js 读取 MAKEUP_DATA');
    process.exit(1);
  }
  const html = buildPage(D);
  const old = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
  if (old === html) {
    console.log('· guide.html 无变化');
  } else {
    fs.writeFileSync(OUT, html, 'utf8');
    console.log('✓ 已生成 guide.html：' + D.looks.length + ' 种妆容 + ' +
      D.stages.length + ' 个阶段，' + Math.round(html.length / 1024) + ' KB');
  }

  /* 顺手把 sitemap 补上 guide.html */
  const smPath = path.join(ROOT, 'sitemap.xml');
  if (fs.existsSync(smPath)) {
    let sm = fs.readFileSync(smPath, 'utf8');
    if (sm.indexOf('guide.html') < 0) {
      sm = sm.replace('</urlset>',
        '  <url>\n    <loc>' + SITE + '/guide.html</loc>\n' +
        '    <changefreq>weekly</changefreq>\n    <priority>0.9</priority>\n  </url>\n</urlset>');
      fs.writeFileSync(smPath, sm, 'utf8');
      console.log('✓ sitemap.xml 已加入 guide.html');
    }
  }
}

main();
