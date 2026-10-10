#!/usr/bin/env node
/* ============================================================
 * tools/build.js —— 生成可部署到公网的 dist/
 * ------------------------------------------------------------
 * 与手写 cp 列表的区别：部署白名单**从 index.html 的实际引用推导**，
 * 所以不可能再出现「加了新 js 忘了加进构建命令」这种漏文件事故。
 *
 * 同时做两道检查：
 *   1) index.html 引用到的本地文件必须都存在
 *   2) 本地专用文件（start.bat / server.js 等）绝不允许进 dist
 *      —— start.bat 里可能填过 API Key，传上去就是泄露
 * ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'dist');

/* 站点入口本身，以及不在 index.html 里被引用但公网也需要的文件 */
const EXTRA = ['index.html', 'robots.txt', 'sitemap.xml'];

/* 本地专用文件黑名单：绝不允许出现在 dist 里 */
const FORBIDDEN = [
  'server.js', 'start.bat',
  'set-domain.js', 'set-domain.bat',
  'README.md', 'DEPLOY.md',
  '.gitignore'
];

/* 从 index.html 里解析出所有本地资源引用 */
function localRefs() {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const set = new Set();
  const re = /(?:src|href)\s*=\s*"([^"]+)"/g;
  let m;
  while ((m = re.exec(html))) {
    const u = m[1];
    // 跳过外链、data:、锚点、以及 __SITE_URL__ 占位符
    if (/^(https?:)?\/\//.test(u)) continue;
    if (/^(data:|mailto:|tel:|#)/.test(u)) continue;
    if (u.indexOf('__') >= 0) continue;
    set.add(u.replace(/^\.\//, '').split('?')[0].split('#')[0]);
  }
  return Array.from(set);
}

function main() {
  const refs = localRefs();
  const files = Array.from(new Set(refs.concat(EXTRA))).sort();

  /* ① 完整性：index.html 引用到的本地文件必须真实存在 */
  const missing = files.filter(function (f) { return !fs.existsSync(path.join(ROOT, f)); });
  if (missing.length) {
    console.error('');
    console.error('  ✗ 构建中止：index.html 引用了不存在的文件');
    missing.forEach(function (f) { console.error('      · ' + f); });
    console.error('');
    process.exit(1);
  }

  /* ② 安全：本地专用文件不允许被打包 */
  const leaked = files.filter(function (f) { return FORBIDDEN.indexOf(f) >= 0; });
  if (leaked.length) {
    console.error('');
    console.error('  ✗ 构建中止：检测到本地专用文件被列入部署清单');
    leaked.forEach(function (f) { console.error('      · ' + f + '（可能含 API Key，绝不可上传）'); });
    console.error('');
    process.exit(1);
  }

  /* ③ 生成 dist */
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });

  let bytes = 0;
  files.forEach(function (f) {
    const src = path.join(ROOT, f);
    fs.copyFileSync(src, path.join(OUT, f));
    const size = fs.statSync(src).size;
    bytes += size;
    console.log('  ✓ ' + f.padEnd(16) + (size / 1024).toFixed(1) + ' KB');
  });

  console.log('');
  console.log('  ✓ 已生成 dist/ —— ' + files.length + ' 个文件，合计 ' + (bytes / 1024).toFixed(1) + ' KB');
  console.log('  说明：部署清单由 index.html 的实际引用推导，不会再漏文件。');
  console.log('        本地专用文件（start.bat / server.js 等）已确认未被打包。');
  console.log('');
}

main();
