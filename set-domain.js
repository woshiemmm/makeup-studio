#!/usr/bin/env node
/* ============================================================
 * set-domain.js —— 一键把 __SITE_URL__ 替换成你的真实域名
 * ------------------------------------------------------------
 * SEO 需要正确的绝对地址（canonical / og:url / sitemap）。
 * 部署到 Cloudflare Pages 拿到网址后，运行一次即可：
 *
 *     node set-domain.js https://makeup-studio.pages.dev
 *
 * 会自动更新：index.html、robots.txt、sitemap.xml
 * 若绑定了自定义域名，改用自定义域名再跑一次即可。
 * ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const TOKEN = '__SITE_URL__';
const TARGETS = ['index.html', 'robots.txt', 'sitemap.xml'];

function normalize(input) {
  if (!input) return null;
  let s = String(input).trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  try {
    const u = new URL(s);
    return u.origin;
  } catch (e) {
    return null;
  }
}

function main() {
  const arg = process.argv[2];

  if (!arg || arg === '-h' || arg === '--help') {
    console.log('');
    console.log('  用法：  node set-domain.js https://你的域名');
    console.log('');
    console.log('  示例：  node set-domain.js https://makeup-studio.pages.dev');
    console.log('          node set-domain.js makeup.example.com');
    console.log('');
    process.exit(arg ? 0 : 1);
  }

  const site = normalize(arg);
  if (!site) {
    console.error('✗ 无法解析这个网址：' + arg);
    process.exit(1);
  }

  console.log('');
  console.log('  将 __SITE_URL__ 替换为：' + site);
  console.log('');

  let changed = 0;
  TARGETS.forEach(function (name) {
    const file = path.join(ROOT, name);
    if (!fs.existsSync(file)) {
      console.log('  · 跳过（不存在）：' + name);
      return;
    }
    const before = fs.readFileSync(file, 'utf8');
    const after = before.split(TOKEN).join(site);
    const hits = before.split(TOKEN).length - 1;
    if (after === before) {
      console.log('  · 无变化：' + name);
    } else {
      fs.writeFileSync(file, after, 'utf8');
      changed += hits;
      console.log('  ✓ ' + name + '（替换 ' + hits + ' 处）');
    }
  });

  console.log('');
  if (changed === 0) {
    console.log('  没有找到 __SITE_URL__ 占位符，可能已经设置过了。');
  } else {
    console.log('  完成！共替换 ' + changed + ' 处。');
    console.log('');
    console.log('  下一步：把改动重新部署一次，然后到搜索引擎提交你的网址：');
    console.log('    · Google Search Console : https://search.google.com/search-console');
    console.log('    · 百度搜索资源平台      : https://ziyuan.baidu.com/');
    console.log('    提交 sitemap 地址：' + site + '/sitemap.xml');
  }
  console.log('');
}

main();
