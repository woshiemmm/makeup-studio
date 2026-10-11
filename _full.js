/* 全量妆容识别准确率测试（扩充后应覆盖 40 款） */
const fs = require('fs');
const d = 'C:/Users/emmm8/Documents/deepseek-harness/default-workspace/';
const store = {};
global.window = global;
global.localStorage = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; }, key: () => null, get length() { return 0; } };
global.document = { createElement: () => ({ getContext: () => null }), readyState: 'complete' };
global.navigator = { onLine: true };
eval(fs.readFileSync(d + 'data.js', 'utf8'));
eval(fs.readFileSync(d + 'vision.js', 'utf8'));
const D = window.MAKEUP_DATA, V = window.VISION;

let pass = 0, fail = 0;
function ck(n, c, e) { if (c) { console.log('  OK   ' + n); pass++; } else { console.log('  FAIL ' + n + (e !== undefined ? ' -> ' + e : '')); fail++; } }

function hx(h0) { let h = String(h0).replace('#', ''); if (h.length === 3) h = h[0]+h[0]+h[1]+h[1]+h[2]+h[2]; return { r: parseInt(h.slice(0,2),16), g: parseInt(h.slice(2,4),16), b: parseInt(h.slice(4,6),16) }; }
function bk(pr,pg,pb){ const lum=(pr+pg+pb)/3; if(lum<50) return 'dark'; const rn=pr/255,gn=pg/255,bn=pb/255,mx=Math.max(rn,gn,bn),mn=Math.min(rn,gn,bn),dd=mx-mn; const s=mx===0?0:dd/mx; if(s<0.14) return 'neutral'; let h=0; if(dd!==0){ if(mx===rn)h=((gn-bn)/dd)%6; else if(mx===gn)h=(bn-rn)/dd+2; else h=(rn-gn)/dd+4; h*=60; if(h<0)h+=360; } if(h<15||h>=345)return 'red'; if(h<45)return 'orange'; if(h<70)return 'yellow'; if(h<165)return 'green'; if(h<250)return 'blue'; if(h<300)return 'purple'; if(h<345)return 'pink'; return 'neutral'; }
function synth(look) {
  const buckets = { red:0,orange:0,yellow:0,green:0,blue:0,purple:0,pink:0,neutral:0,dark:0 };
  let r=0,g=0,b=0,sat=0,val=0,n=0;
  look.palette.forEach(function (c) {
    const p = hx(c); buckets[bk(p.r,p.g,p.b)] += 40; r+=p.r; g+=p.g; b+=p.b; n++;
    const rn=p.r/255,gn=p.g/255,bn=p.b/255,mx=Math.max(rn,gn,bn),mn=Math.min(rn,gn,bn);
    sat += mx===0?0:(mx-mn)/mx; val += mx;
  });
  const avg = { r:r/n, g:g/n, b:b/n };
  return { avg, brightness:(avg.r+avg.g+avg.b)/3, avgSat:sat/n, avgVal:val/n, buckets, dominant:'', warmRatio:0, topCount:200 };
}

console.log('=== 妆容总数 ===');
console.log('  ' + D.looks.length + ' 款');
const g = {};
D.looks.forEach(function (l) { g[l.group || 'female'] = (g[l.group || 'female'] || 0) + 1; });
console.log('  分组: ' + JSON.stringify(g));

console.log('');
console.log('=== 往返识别准确率 ===');
let hit = 0; const miss = [];
D.looks.forEach(function (l) {
  const r = V.matchLookByColor(synth(l));
  if (r.lookId === l.id) hit++;
  else miss.push({ id: l.id, name: l.name, got: r.lookId, inTop4: r.ranked.some(function (x) { return x.lookId === l.id; }) });
});
const rate = Math.round(hit / D.looks.length * 100);
console.log('  准确率: ' + hit + '/' + D.looks.length + ' = ' + rate + '%');
ck('准确率 ≥ 80%', rate >= 80, rate + '%');
ck('准确率 ≥ 90%', rate >= 90, rate + '%');
if (miss.length) {
  console.log('');
  console.log('  未命中 ' + miss.length + ' 款：');
  miss.forEach(function (m) { console.log('    · ' + m.id.padEnd(14) + m.name.padEnd(12) + '→ ' + m.got + (m.inTop4 ? '（前4内有）' : '')); });
}

console.log('');
console.log('=== 分区准确率 ===');
['female','male','cos'].forEach(function (grp) {
  const list = D.looks.filter(function (l) { return (l.group || 'female') === grp; });
  const h = list.filter(function (l) { return V.matchLookByColor(synth(l)).lookId === l.id; }).length;
  const nm = { female:'日常女妆', male:'男生妆容', cos:'Cos · 舞台' }[grp];
  console.log('  ' + nm.padEnd(12) + h + '/' + list.length + '  ' + Math.round(h/list.length*100) + '%');
  ck(nm + ' 准确率 ≥ 80%', h/list.length >= 0.8, Math.round(h/list.length*100) + '%');
});

console.log('');
console.log('=== 数据完整性 ===');
let bad = [];
const scIds = D.scenes.map(function (x) { return x.id; });
const seen = {};
D.looks.forEach(function (l) {
  if (seen[l.id]) bad.push('id 重复: ' + l.id); seen[l.id] = 1;
  ['name','en','tagline','difficulty','occasion','desc'].forEach(function (k) { if (!l[k]) bad.push(l.id + ' 缺 ' + k); });
  if (!l.palette || l.palette.length !== 4) bad.push(l.id + ' palette 不是 4 色');
  if (!l.audience) bad.push(l.id + ' 缺 audience');
  if (!l.scene || !l.scene.length) bad.push(l.id + ' 缺 scene');
  (l.scene || []).forEach(function (s) { if (scIds.indexOf(s) < 0) bad.push(l.id + ' 无效场合 ' + s); });
  if (!D.shopping[l.id]) bad.push(l.id + ' 缺购物清单');
  if (!V.LOOK_FIT[l.id]) bad.push(l.id + ' 缺 LOOK_FIT');
  const st = Object.keys(l.tweaks || {});
  if (st.length < 4) bad.push(l.id + ' 阶段仅 ' + st.length);
});
console.log('  问题: ' + (bad.length ? bad.slice(0,10).join('; ') : '无 ✓'));
ck('全部字段完整', bad.length === 0, bad.length + ' 处问题');
ck('购物清单全齐', D.looks.every(function (l) { return D.shopping[l.id]; }));
ck('LOOK_FIT 全齐', D.looks.every(function (l) { return V.LOOK_FIT[l.id]; }));

console.log('');
console.log('=== 调色板区分度 ===');
const palMap = {};
let dup = 0;
D.looks.forEach(function (l) {
  const k = l.palette.join('');
  if (palMap[k]) { dup++; console.log('  重复: ' + l.id + ' 与 ' + palMap[k]); }
  palMap[k] = l.id;
});
ck('没有完全相同的调色板', dup === 0, dup + ' 组重复');

console.log('');
console.log('=== 场合 / 类型分布 ===');
D.lookGroups.forEach(function (gg) {
  if (gg.id === 'all') return;
  const n = D.looks.filter(function (l) { return (l.group || 'female') === gg.id; }).length;
  console.log('  ' + gg.icon + ' ' + gg.name.padEnd(12) + n + ' 款');
});
D.scenes.forEach(function (s) {
  const n = D.looks.filter(function (l) { return (l.scene || []).indexOf(s.id) >= 0; }).length;
  console.log('  ' + s.icon + ' ' + s.name.padEnd(6) + n + ' 款');
});
ck('每个场合都有妆容', D.scenes.every(function (s) {
  return D.looks.some(function (l) { return (l.scene || []).indexOf(s.id) >= 0; });
}));

console.log('');
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
