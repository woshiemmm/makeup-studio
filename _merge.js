/* 合并 4 个子代理产出的妆容批次到 data.js / vision.js
 * 合并前逐项校验，任何一项不合格就中止，不写坏数据。 */
const fs = require('fs');
const vm = require('vm');
const d = 'C:/Users/emmm8/Documents/deepseek-harness/default-workspace/';

const STAGES = ['prep', 'base', 'brow', 'eye', 'cheek', 'lip', 'finish', 'after'];
const SCENES = ['daily', 'work', 'date', 'stage', 'formal', 'cosplay'];
const GROUPS = ['female', 'male', 'cos'];
const AUDS = ['f', 'm', 'any'];

/* 读 data.js 现有内容，拿到已存在的 id，防重复 */
let dataSrc = fs.readFileSync(d + 'data.js', 'utf8');
let visionSrc = fs.readFileSync(d + 'vision.js', 'utf8');

const sandbox = { window: {}, localStorage: { getItem: () => null, setItem: () => {} }, console };
vm.createContext(sandbox);
vm.runInContext(dataSrc, sandbox);
const D = sandbox.window.MAKEUP_DATA;
const existing = D.looks.map(function (l) { return l.id; });

/* ---------- 1. 读并校验 4 个批次 ---------- */
const looks = [], shopping = {}, lookFit = {};
const errors = [], warnings = [];

for (let i = 1; i <= 4; i++) {
  const p = d + '_b' + i + '.json';
  if (!fs.existsSync(p)) { errors.push('缺少文件 _b' + i + '.json'); continue; }
  let raw = fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '');
  let j;
  try { j = JSON.parse(raw); }
  catch (e) { errors.push('_b' + i + '.json 不是合法 JSON: ' + e.message); continue; }

  if (!Array.isArray(j.looks)) { errors.push('_b' + i + ' 缺少 looks 数组'); continue; }
  console.log('_b' + i + '.json：looks ' + j.looks.length +
    ' / shopping ' + Object.keys(j.shopping || {}).length +
    ' / lookFit ' + Object.keys(j.lookFit || {}).length);

  j.looks.forEach(function (l) {
    const tag = '_b' + i + ':' + (l.id || '?');
    ['id', 'name', 'en', 'tagline', 'difficulty', 'occasion', 'palette', 'desc', 'tweaks'].forEach(function (k) {
      if (!l[k]) errors.push(tag + ' 缺字段 ' + k);
    });
    if (existing.indexOf(l.id) >= 0) errors.push(tag + ' id 与现有妆容重复');
    if (looks.some(function (x) { return x.id === l.id; })) errors.push(tag + ' id 在批次内重复');
    if (GROUPS.indexOf(l.group) < 0) errors.push(tag + ' group 非法: ' + l.group);
    if (AUDS.indexOf(l.audience) < 0) errors.push(tag + ' audience 非法: ' + l.audience);
    if (!Array.isArray(l.scene) || !l.scene.length) errors.push(tag + ' 缺 scene');
    else l.scene.forEach(function (s) { if (SCENES.indexOf(s) < 0) errors.push(tag + ' scene 非法: ' + s); });
    if (!Array.isArray(l.palette) || l.palette.length !== 4) errors.push(tag + ' palette 不是 4 个色');
    else l.palette.forEach(function (c) { if (!/^#[0-9a-fA-F]{6}$/.test(c)) errors.push(tag + ' 颜色格式错: ' + c); });

    const st = Object.keys(l.tweaks || {});
    if (st.length < 5) errors.push(tag + ' 阶段只有 ' + st.length + ' 个（要求 ≥5）');
    let notes = 0;
    st.forEach(function (s) {
      if (STAGES.indexOf(s) < 0) errors.push(tag + ' 非法阶段 ' + s);
      const t = l.tweaks[s] || {};
      const n = Array.isArray(t.notes) ? t.notes.length : 0;
      if (n < 1) errors.push(tag + '.' + s + ' 没有 notes');
      if (n > 5) warnings.push(tag + '.' + s + ' notes ' + n + ' 条（建议 ≤5）');
      if (!t.notes && !t.intro) errors.push(tag + '.' + s + ' 既无 notes 也无 intro');
      notes += n;
    });
    if (notes < 14) errors.push(tag + ' 总 notes 只有 ' + notes + ' 条（要求 ≥14）');
    looks.push(l);
  });

  Object.keys(j.shopping || {}).forEach(function (k) {
    const arr = j.shopping[k];
    const tag = '_b' + i + ':shopping.' + k;
    if (!Array.isArray(arr) || !arr.length) { errors.push(tag + ' 不是非空数组'); return; }
    if (!j.looks.some(function (l) { return l.id === k; })) warnings.push(tag + ' 找不到对应妆容');
    arr.forEach(function (it, n) {
      ['c', 'item', 'note', 'kw'].forEach(function (f) {
        if (!it[f]) errors.push(tag + '[' + n + '] 缺 ' + f);
      });
    });
    shopping[k] = arr;
  });

  Object.keys(j.lookFit || {}).forEach(function (k) {
    const o = j.lookFit[k];
    const tag = '_b' + i + ':lookFit.' + k;
    ['undertone', 'depth', 'skin'].forEach(function (f) {
      if (!o[f]) { errors.push(tag + ' 缺 ' + f); return; }
      const need = f === 'undertone' ? ['cool', 'warm', 'neutral']
        : f === 'depth' ? ['fair', 'light', 'medium', 'deep']
        : ['oily', 'dry', 'combo', 'normal', 'sensitive'];
      need.forEach(function (x) {
        if (typeof o[f][x] !== 'number') errors.push(tag + '.' + f + ' 缺 ' + x);
      });
    });
    lookFit[k] = o;
  });
}

/* 每款妆容都要有 shopping 和 lookFit */
looks.forEach(function (l) {
  if (!shopping[l.id]) errors.push(l.id + ' 缺 shopping');
  if (!lookFit[l.id]) errors.push(l.id + ' 缺 lookFit');
});
/* 颜色区分度检查：相邻妆容主色不能完全一样 */
const palSeen = {};
D.looks.forEach(function (l) { palSeen[l.palette.join('')] = l.id; });
looks.forEach(function (l) {
  const k = l.palette.join('');
  if (palSeen[k]) warnings.push(l.id + ' 的调色板和 ' + palSeen[k] + ' 完全相同');
  palSeen[k] = l.id;
});

console.log('');
console.log('校验结果：新增妆容 ' + looks.length + ' 款（现有 ' + existing.length + ' → ' + (existing.length + looks.length) + '）');
if (warnings.length) { console.log('提示 ' + warnings.length + ' 条：'); warnings.slice(0, 12).forEach(function (w) { console.log('  · ' + w); }); }
if (errors.length) {
  console.log('');
  console.log('✘ 错误 ' + errors.length + ' 条，已中止，未修改任何文件：');
  errors.slice(0, 30).forEach(function (e) { console.log('  · ' + e); });
  process.exit(1);
}
console.log('✓ 校验通过');

/* ---------- 2. 插入 looks ---------- */
const indent = function (s, pad) { return s.split('\n').map(function (x) { return pad + x; }).join('\n'); };
const looksText = looks.map(function (o) {
  return indent(JSON.stringify(o, null, 2), '    ');
}).join(',\n\n    ');

/* looks 数组的闭合：找 `  ],` 且前面是妆容对象（紧跟 tutorials 注释） */
const looksEndMark = '\n  ],\n\n  /* ---------- 精选跟练教程';
const li = dataSrc.indexOf(looksEndMark);
if (li < 0) { console.error('✘ 找不到 looks 数组结尾标记'); process.exit(1); }
dataSrc = dataSrc.slice(0, li) + ',\n\n    /* ==================== 网络流行妆容扩充 ==================== */\n    ' +
  looksText + dataSrc.slice(li);

/* ---------- 3. 插入 shopping ---------- */
const shopEndMark = '\n  },\n\n  /* ---------- 预算档位';
const si = dataSrc.indexOf(shopEndMark);
if (si < 0) { console.error('✘ 找不到 shopping 结尾标记'); process.exit(1); }
const shopText = Object.keys(shopping).map(function (k) {
  return '    ' + JSON.stringify(k) + ': ' + indent(JSON.stringify(shopping[k], null, 2), '    ').trim();
}).join(',\n\n');
dataSrc = dataSrc.slice(0, si) + ',\n\n    /* ---- 新增妆容的购物清单 ---- */\n' +
  shopText + dataSrc.slice(si);

fs.writeFileSync(d + 'data.js', dataSrc, 'utf8');
console.log('✓ data.js 已写入（looks + shopping）');

/* ---------- 4. 插入 LOOK_FIT ---------- */
const fitText = Object.keys(lookFit).map(function (k) {
  return '    ' + JSON.stringify(k) + ': ' + indent(JSON.stringify(lookFit[k], null, 2), '    ').trim();
}).join(',\n\n');

/* LOOK_FIT 的结尾：最后一个条目是 cos_dark，之后是 `  };` */
const fitAnchor = visionSrc.indexOf('    cos_dark: {');
if (fitAnchor < 0) { console.error('✘ 找不到 LOOK_FIT 里的 cos_dark'); process.exit(1); }
const fitClose = visionSrc.indexOf('\n  };', fitAnchor);
if (fitClose < 0) { console.error('✘ 找不到 LOOK_FIT 结尾'); process.exit(1); }
visionSrc = visionSrc.slice(0, fitClose) + ',\n\n    /* ---- 新增妆容 ---- */\n' +
  fitText + visionSrc.slice(fitClose);

fs.writeFileSync(d + 'vision.js', visionSrc, 'utf8');
console.log('✓ vision.js 已写入（LOOK_FIT）');

/* ---------- 5. 回读验证 ---------- */
const sb2 = { window: {}, localStorage: { getItem: () => null, setItem: () => {} }, console };
vm.createContext(sb2);
try { vm.runInContext(fs.readFileSync(d + 'data.js', 'utf8'), sb2); }
catch (e) { console.error('✘ 写回后 data.js 无法解析: ' + e.message); process.exit(1); }
const D2 = sb2.window.MAKEUP_DATA;
console.log('');
console.log('✓ 回读成功：妆容 ' + D2.looks.length + ' 款');
const g = {};
D2.looks.forEach(function (l) { g[l.group || 'female'] = (g[l.group || 'female'] || 0) + 1; });
console.log('  分组: ' + JSON.stringify(g));
const miss = D2.looks.filter(function (l) { return !D2.shopping[l.id]; });
console.log('  缺购物清单: ' + (miss.length ? miss.map(function (l) { return l.id; }).join(', ') : '无'));

/* 清理批次文件 */
for (let i = 1; i <= 4; i++) {
  const p = d + '_b' + i + '.json';
  if (fs.existsSync(p)) fs.unlinkSync(p);
}
console.log('✓ 已清理批次临时文件');
