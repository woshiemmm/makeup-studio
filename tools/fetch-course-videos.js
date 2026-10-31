#!/usr/bin/env node
/* ============================================================
 * tools/fetch-course-videos.js
 * ------------------------------------------------------------
 * 给「零基础课程」抓真实 B 站视频链接。
 *
 * 为什么要有这个脚本：
 *   视频号（BV 号）不能编 —— 编出来的点开就是 404。
 *   这个脚本走 B 站公开搜索接口，按关键词拿真实视频，
 *   并把结果写进 course-videos.json，再手动挑好的烤进 data.js。
 *
 * 用法：
 *   node tools/fetch-course-videos.js          # 抓取并写 course-videos.json
 *   node tools/fetch-course-videos.js --show   # 只打印，不写文件
 *
 * 注意：抓取结果只作为「候选」，最终收录哪些由人来看标题判断 ——
 *       自动挑的往往不如人眼看一遍准。
 * ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122 Safari/537.36';
const OUT = path.join(__dirname, '..', 'course-videos.json');

/* 每节课要搜什么；key 是课时 id */
const TOPICS = [
  { id: 'l01', q: '新手 化妆 入门 第一课' },
  { id: 'l02', q: '脸型 判断 化妆 教程' },
  { id: 'l03', q: '新手 化妆 需要 买什么 清单' },
  { id: 'l04', q: '新手 底妆 服帖 不卡粉' },
  { id: 'l05', q: '遮瑕 新手 黑眼圈 痘印' },
  { id: 'l06', q: '定妆 持妆 一整天 技巧' },
  { id: 'l07', q: '新手 画眉毛 教程 对称' },
  { id: 'l08', q: '新手 眼影 画法 三个色' },
  { id: 'l09', q: '新手 眼线 手抖 画法' },
  { id: 'l10', q: '睫毛 夹翘 刷法 教程' },
  { id: 'l11', q: '腮红 位置 画法 脸型' },
  { id: 'l12', q: '修容 高光 新手 教程' },
  { id: 'l13', q: '唇妆 新手 画法 唇形' },
  { id: 'l14', q: '完整 化妆 新手 全流程' },
  { id: 'l15', q: '补妆 持妆 脱妆 补救' },
  { id: 'l16', q: '卸妆 正确 方法 干净' },
  { id: 'l17', q: '化妆 常见错误 翻车 急救' },
  { id: 'l18', q: '化妆 练习 21天 计划' }
];

let biliCookie = '';
let biliCookieAt = 0;

async function getCookie() {
  if (biliCookie && Date.now() - biliCookieAt < 30 * 60 * 1000) return biliCookie;
  try {
    const r = await fetch('https://www.bilibili.com/', { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(15000) });
    const raw = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
    const c = raw.map(function (x) { return String(x).split(';')[0]; }).join('; ');
    if (c) { biliCookie = c; biliCookieAt = Date.now(); }
  } catch (e) { console.error('  取 cookie 失败：' + e.message); }
  return biliCookie;
}

function decode(s) {
  return String(s || '').replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'").replace(/\s+/g, ' ').trim();
}

function play(n) {
  const v = Number(n) || 0;
  if (v >= 100000000) return (v / 100000000).toFixed(1) + '亿';
  if (v >= 10000) return (v / 10000).toFixed(1) + '万';
  return String(v);
}

async function searchOne(q, want) {
  const cookie = await getCookie();
  const url = 'https://api.bilibili.com/x/web-interface/search/all/v2?page=1&keyword=' + encodeURIComponent(q);
  const r = await fetch(url, {
    headers: { 'User-Agent': UA, 'Referer': 'https://search.bilibili.com/', 'Cookie': cookie, 'Accept': 'application/json' },
    signal: AbortSignal.timeout(20000)
  });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const j = await r.json();
  if (j.code !== 0) throw new Error('code ' + j.code + ' ' + (j.message || ''));
  const groups = (j.data && j.data.result) || [];
  let vids = [];
  groups.forEach(function (g) { if (g.result_type === 'video') vids = g.data || []; });

  return vids.map(function (v) {
    return {
      bv: v.bvid,
      t: decode(v.title),
      play: Number(v.play) || 0,
      playText: play(v.play),
      duration: v.duration || '',
      author: decode(v.author),
      tag: decode(v.tag || '')
    };
  }).filter(function (v) {
    /* 排除明显不相关的：标题里要有关键词之一 */
    return v.bv && v.t && v.play > 300;
  })
    .sort(function (a, b) { return b.play - a.play; })
    .slice(0, want || 5);
}

(async function () {
  const showOnly = process.argv.indexOf('--show') >= 0;
  const out = {};
  let ok = 0, bad = 0;

  for (let i = 0; i < TOPICS.length; i++) {
    const t = TOPICS[i];
    process.stdout.write('  [' + (i + 1) + '/' + TOPICS.length + '] ' + t.id + '  ' + t.q + ' … ');
    try {
      const list = await searchOne(t.q, 5);
      out[t.id] = { q: t.q, videos: list };
      ok++;
      console.log(list.length + ' 条');
      list.forEach(function (v, k) {
        console.log('        ' + (k + 1) + '. [' + v.playText + '] ' + v.t.slice(0, 46) + '   ' + v.bv);
      });
    } catch (e) {
      bad++;
      out[t.id] = { q: t.q, videos: [], error: e.message };
      console.log('失败：' + e.message);
    }
    await new Promise(function (r) { setTimeout(r, 700); });   // 别把 B 站惹急
  }

  console.log('');
  console.log('  成功 ' + ok + ' / 失败 ' + bad);
  if (!showOnly) {
    fs.writeFileSync(OUT, JSON.stringify(out, null, 2), 'utf8');
    console.log('  已写入 ' + path.basename(OUT));
  } else {
    console.log('  （--show 模式，未写文件）');
  }
})();
