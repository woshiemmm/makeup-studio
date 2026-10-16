/* ============================================================
 * app.js — 应用主逻辑：导航、选妆、教学渲染、识别、分析、设置
 * ============================================================ */
(function () {
  'use strict';
  const D = window.MAKEUP_DATA;
  const V = window.VISION;
  const S = window.STORE;

  const state = {
    currentLook: null,
    currentStage: 0,
    customNotes: {},          // 肤质分析定制建议：{ stageId: [notes] }
    customLookName: '',       // 定制方案来源标签
    recognizeFile: null,
    faceFile: null,
    lastRecognize: null,      // 最近一次识别结果，供「保存到我的妆容」使用
    processLook: '',          // 「化妆流程」板块当前指定的妆容，空 = 标准流程
    lookGroup: 'all',         // 选妆分类筛选：all / female / male / cos
    lookScenes: []            // 选妆场合筛选（可多选）
  };

  const $ = function (sel) { return document.querySelector(sel); };
  const $$ = function (sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); };

  /* ============ 工具 ============ */
  function el(tag, cls, html) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  }

  /* 配色横条上该用深字还是浅字：按配色亮度自动判断，保证可读 */
  function hexToRgbLocal(hex) {
    const h = String(hex || '').replace('#', '');
    const full = h.length === 3 ? h.split('').map(function (c) { return c + c; }).join('') : h;
    const n = parseInt(full, 16);
    if (isNaN(n)) return { r: 128, g: 128, b: 128 };
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }
  function bandTextColor(palette) {
    const list = (palette || []).slice(0, 2);
    if (!list.length) return '#ffffff';
    let lum = 0;
    list.forEach(function (c) {
      const rgb = hexToRgbLocal(c);
      lum += (0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b) / 255;
    });
    lum = lum / list.length;
    return lum > 0.6 ? '#2a2233' : '#ffffff';
  }

  /* ============ 路由（hash） ============
   * 用地址栏 hash 记录「当前视图 + 当前妆容」，这样：
   *   · 浏览器返回键 / 手机返回手势 能一步步退回（而不是直接退出网站）
   *   · 地址可以直接收藏、分享，打开就是同一个页面
   * 形如：#/teach            → 选妆容
   *       #/teach/natural    → 清透裸妆的教学
   *       #/process          → 化妆流程
   */
  const VIEWS = ['teach', 'process', 'recognize', 'analysis', 'shop', 'settings'];

  /* 解析地址栏的 hash。第二个路径段对 teach 是妆容 id，对 shop 是品类 id */
  function currentRoute() {
    const raw = (typeof location !== 'undefined' && location.hash) ? location.hash : '';
    const parts = raw.replace(/^#\/?/, '').split('/').filter(function (s) { return s; });
    const view = VIEWS.indexOf(parts[0]) >= 0 ? parts[0] : 'teach';
    return { view: view, look: parts[1] || '', raw: raw };
  }

  /* 跳转到某个视图（会写入历史记录，因此返回键可用） */
  function go(view, lookId) {
    const want = '#/' + view + (lookId ? '/' + lookId : '');
    if (location.hash === want) {
      applyRoute();                 // hash 没变不会触发 hashchange，手动应用
    } else {
      location.hash = want;         // 触发 hashchange → applyRoute
    }
  }

  /* 兼容旧调用点 */
  function switchView(name) { go(name); }

  function applyRoute() {
    const r = currentRoute();
    syncNav(routeKey(r));            // 维护站内导航栈（供悬浮返回按钮使用）

    $$('.nav-item').forEach(function (b) { b.classList.toggle('active', b.dataset.view === r.view); });
    $$('.view').forEach(function (v) { v.classList.toggle('active', v.id === 'view-' + r.view); });

    if (r.view === 'process') {
      renderProcess();
    } else if (r.view === 'shop') {
      renderShopPage(r.look);          // r.look 这里是品类 id，空表示显示目录
    } else if (r.view === 'teach') {
      const valid = r.look && D.looks.some(function (l) { return l.id === r.look; });
      const panelOpen = $('#teaching-panel') && !$('#teaching-panel').classList.contains('hidden');
      if (valid) {
        // 已经在这个妆容的教学里就不重渲染，避免丢掉「肤质定制」内容
        if (!(state.currentLook === r.look && panelOpen)) {
          selectLook(r.look, { silent: true });
        }
      } else {
        showLookPicker();
      }
    }

    // 标记这条历史记录来自应用内部，供返回按钮判断（直接打开链接时 state 为空）
    try {
      history.replaceState(Object.assign({}, history.state || {}, { app: true }), '', location.href);
    } catch (e) { /* 某些环境不允许 replaceState，忽略即可 */ }

    updateBackFab();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  /* 回到「选妆容」 */
  function showLookPicker() {
    if ($('#teaching-panel')) $('#teaching-panel').classList.add('hidden');
    if ($('#shop-card')) $('#shop-card').classList.add('hidden');   // 清单跟着教学面板一起收起
    if ($('#tips-card')) $('#tips-card').classList.add('hidden');
    if ($('#look-picker')) $('#look-picker').classList.remove('hidden');
    renderLookGrid($('#look-search') ? $('#look-search').value : '');
  }

  /* ---- 悬浮返回按钮 ---- */
  // 桌面端让按钮对齐主内容左边缘（主内容是居中且有最大宽度的）
  function positionBackFab() {
    const fab = $('#back-fab');
    const main = document.querySelector('.main');
    if (!fab || !main) return;
    if (window.innerWidth <= 820) { fab.style.left = ''; return; }   // 移动端交给 CSS
    const r = main.getBoundingClientRect();
    fab.style.left = Math.max(12, Math.round(r.left - 6)) + 'px';
  }

  function updateBackFab() {
    const fab = $('#back-fab');
    if (!fab) return;
    const r = currentRoute();
    // 「选妆容」是首页，没地方可退，就隐藏按钮
    const isHome = (r.view === 'teach' && !r.look);
    fab.classList.toggle('hidden', isHome);
    positionBackFab();
  }

  /* 应用内导航栈：记录走过的页面，供悬浮返回按钮使用。
   * 悬浮按钮绝不调用 history.back() —— 直接打开网址时那会退到浏览器主界面。
   * 浏览器自带的返回键不受影响，仍然走 history。 */
  const navStack = [];
  let navCurrent = '';

  function routeKey(r) { return r.view + (r.look ? '/' + r.look : ''); }

  function syncNav(key) {
    if (key === navCurrent) return;
    if (navStack.length && navStack[navStack.length - 1] === key) {
      navStack.pop();                       // 说明是「后退」，出栈
    } else {
      if (navCurrent) {
        navStack.push(navCurrent);          // 说明是「前进」，入栈
        if (navStack.length > 60) navStack.shift();
      }
    }
    navCurrent = key;
  }

  // 回到上一级；没有站内历史就退回逻辑上的上一级，绝不退出站点
  function goBack() {
    if (navStack.length) {
      const top = navStack[navStack.length - 1];
      const i = top.indexOf('/');
      if (i > 0) go(top.slice(0, i), top.slice(i + 1));
      else go(top);
      return;
    }
    // 直接打开了深层链接（前面没有站内页面）→ 按路径退回上一层。
    // 先把 navCurrent 改成目标，这样 syncNav 不会把当前页误当成「前进」压栈，
    // 否则再点一次返回会又跳回来。
    const r = currentRoute();
    const parent = r.look ? (r.view === 'shop' ? 'shop' : 'teach') : 'teach';
    navCurrent = parent;
    go(parent);
  }

  /* ============ 选妆 ============ */
  function lookGroup(l) { return l.group || 'female'; }
  const AUDIENCE_LABEL = { f: '偏女性', m: '偏男性', any: '男女皆可' };

  function renderLookTabs() {
    const box = $('#look-tabs');
    if (!box) return;
    const curG = state.lookGroup || 'all';
    const curS = state.lookScenes || [];

    /* 第一行：类型 */
    const groups = (D.lookGroups || [
      { id: 'all', name: '全部', icon: '✨' },
      { id: 'female', name: '日常女妆', icon: '💄' },
      { id: 'male', name: '男生妆容', icon: '🧔' },
      { id: 'cos', name: 'Cos · 舞台', icon: '🎭' }
    ]);
    let html = '<div class="look-tabs">' + groups.map(function (g) {
      const n = g.id === 'all'
        ? D.looks.length
        : D.looks.filter(function (l) { return lookGroup(l) === g.id; }).length;
      if (!n) return '';
      return '<button class="look-tab' + (g.id === curG ? ' active' : '') + '" data-lookgroup="' + g.id +
        '" type="button">' + g.icon + ' ' + escapeHtml(g.name) + '<i>' + n + '</i></button>';
    }).join('') + '</div>';

    /* 第二行：场合（可多选） */
    const scenes = D.scenes || [];
    if (scenes.length) {
      html += '<div class="look-scenes">' +
        '<span class="ls-label">场合</span>' +
        scenes.map(function (s) {
          const on = curS.indexOf(s.id) >= 0;
          const n = D.looks.filter(function (l) {
            return (l.scene || []).indexOf(s.id) >= 0 && (curG === 'all' || lookGroup(l) === curG);
          }).length;
          return '<button class="ls-chip' + (on ? ' active' : '') + '" data-lookscene="' + s.id +
            '" type="button" title="' + escapeHtml(s.desc || '') + '">' + s.icon + ' ' + escapeHtml(s.name) +
            '<i>' + n + '</i></button>';
        }).join('') +
        (curS.length ? '<button class="ls-clear" data-lookscene="__clear" type="button">清除场合筛选</button>' : '') +
      '</div>';
    }

    box.innerHTML = html;

    box.querySelectorAll('[data-lookgroup]').forEach(function (b) {
      b.addEventListener('click', function () {
        state.lookGroup = b.dataset.lookgroup;
        state.lookScenes = [];
        renderLookTabs();
        renderLookGrid($('#look-search') ? $('#look-search').value : '');
      });
    });
    box.querySelectorAll('[data-lookscene]').forEach(function (b) {
      b.addEventListener('click', function () {
        const id = b.dataset.lookscene;
        let s = (state.lookScenes || []).slice();
        if (id === '__clear') s = [];
        else s = s.indexOf(id) >= 0 ? s.filter(function (x) { return x !== id; }) : s.concat(id);
        state.lookScenes = s;
        renderLookTabs();
        renderLookGrid($('#look-search') ? $('#look-search').value : '');
      });
    });
  }

  function renderLookGrid(filter) {
    const grid = $('#look-grid');
    grid.innerHTML = '';
    const q = (filter || '').trim().toLowerCase();
    const grp = state.lookGroup || 'all';
    const scenes = state.lookScenes || [];
    const diffClass = { '入门': 'diff-easy', '进阶': 'diff-mid', '高阶': 'diff-hard' };
    let i = 0;
    D.looks.forEach(function (look) {
      if (grp !== 'all' && lookGroup(look) !== grp) return;
      if (scenes.length && !scenes.some(function (s) { return (look.scene || []).indexOf(s) >= 0; })) return;
      const hay = (look.name + look.en + look.tagline + look.occasion + (look.scene || []).join('')).toLowerCase();
      if (q && hay.indexOf(q) === -1) return;
      const isSel = state.currentLook === look.id;
      const card = el('div', 'look-card' + (isSel ? ' selected' : ''));
      const band = 'linear-gradient(135deg,' + look.palette[0] + ',' + (look.palette[1] || look.palette[0]) + ')';
      /* 妆容名称与难度徽章都放进彩色横条；文字颜色按配色亮度自适应 */
      card.innerHTML =
        '<div class="look-band" style="background:' + band + ';color:' + bandTextColor(look.palette) + '">' +
        '<h4>' + escapeHtml(look.name) + '</h4>' +
        '<span class="badge ' + (diffClass[look.difficulty] || 'diff-easy') + '">' + escapeHtml(look.difficulty) + '</span>' +
        '</div>' +
        '<div class="body">' +
        '<div class="swatches">' + look.palette.map(function (c) { return '<span class="swatch" style="background:' + c + '"></span>'; }).join('') + '</div>' +
        '<div class="look-tags">' +
          '<span class="lt-aud lt-' + (look.audience || 'any') + '">' +
            (look.audience === 'm' ? '♂' : look.audience === 'f' ? '♀' : '⚥') + ' ' +
            (AUDIENCE_LABEL[look.audience] || '男女皆可') + '</span>' +
          (look.scene || []).map(function (s) {
            const sc = (D.scenes || []).find(function (x) { return x.id === s; });
            return sc ? '<span class="lt-scene">' + sc.icon + ' ' + escapeHtml(sc.name) + '</span>' : '';
          }).join('') +
        '</div>' +
        '<p class="tag">' + escapeHtml(look.tagline) + '</p>' +
        '<button class="btn-preview" type="button">' +
          (isSel ? '✓ 已选择 · 参考与教程' : '👁 参考与教程') +
        '</button>' +
        '</div>';
      /* 入场动画错开，但封顶 —— 妆容多了以后不能第 40 张等 2 秒才出现 */
      card.style.animationDelay = (Math.min(i, 11) * 45) + 'ms';
      i++;
      card.addEventListener('click', function (e) {
        if (e.target.closest('.btn-preview')) return;   // 点预览不进入教学
        selectLook(look.id);
      });
      card.querySelector('.btn-preview').addEventListener('click', function (e) {
        e.stopPropagation();
        openLookPreview({
          name: look.name, nameEn: look.en, tagline: look.tagline,
          palette: look.palette, lookId: look.id, showTeach: true
        });
      });
      grid.appendChild(card);
    });
    if (!grid.children.length) {
      grid.appendChild(el('p', 'tag', scenes.length
        ? '这个场合下还没有妆容，换个场合或点「清除场合筛选」看看。'
        : (q ? '没找到匹配的妆容，试试「烟熏」「裸妆」「男」「cos」等关键词。'
             : '这个分类下暂时没有妆容。')));
    }
  }

  function selectLook(lookId, opts) {
    const look = D.looks.find(function (l) { return l.id === lookId; });
    if (!look) return;
    state.currentLook = lookId;
    state.currentStage = 0;
    if (!opts || !opts.keepCustom) {
      state.customNotes = {};
      state.customLookName = '';
    }
    $('#look-picker').classList.add('hidden');
    $('#teaching-panel').classList.remove('hidden');
    renderLookGrid($('#look-search').value);
    renderTeaching();
    // 写入地址栏，返回键可退回「选妆容」
    if (!(opts && opts.silent)) go('teach', lookId);
  }

  /* 「返回选择妆容」按钮 */
  function changeLook() { go('teach'); }

  /* ============ 教学渲染 ============ */
  function getStageContent(stage) {
    const look = D.looks.find(function (l) { return l.id === state.currentLook; });
    const tweak = (look.tweaks && look.tweaks[stage.id]) || {};
    const intro = tweak.intro || stage.intro;
    const steps = tweak.steps || stage.steps;
    const notes = (tweak.notes || []).concat(state.customNotes[stage.id] || []);
    return { intro: intro, steps: steps, notes: notes, tweak: tweak, look: look };
  }

  function renderTeaching() {
    const look = D.looks.find(function (l) { return l.id === state.currentLook; });
    $('#teach-look-name').textContent = look.name + (state.customLookName ? ' · ' + state.customLookName : '');
    $('#teach-look-meta').textContent = look.tagline;

    // 妆容简介：英文名 + 难度 + 适合场合 + 一段说明（原先散在页面底部大列表里）
    const diffCls = { '入门': 'diff-easy', '进阶': 'diff-mid', '高阶': 'diff-hard' };
    $('#teach-look-intro').innerHTML =
      '<div class="li-tags">' +
        '<span class="li-en">' + escapeHtml(look.en) + '</span>' +
        '<span class="badge ' + (diffCls[look.difficulty] || 'diff-easy') + '">' + escapeHtml(look.difficulty) + '</span>' +
        '<span class="li-occasion">适合：' + escapeHtml(look.occasion) + '</span>' +
      '</div>' +
      '<p class="li-desc">' + escapeHtml(look.desc) + '</p>';

    $('#teach-palette').innerHTML = '<span>本妆配色</span>' + look.palette.map(function (c) { return '<span class="swatch" style="background:' + c + '"></span>'; }).join('');

    // 该妆容的精选跟练教程（具体视频，非搜索页）
    const strip = $('#teach-tutorials');
    const lookTuts = (D.tutorials && D.tutorials[look.id]) ? D.tutorials[look.id] : [];
    if (lookTuts.length) {
      strip.classList.remove('hidden');
      strip.innerHTML = '<span class="tut-strip-label">🎬 精选跟练教程</span>' +
        lookTuts.map(function (v) {
          const short = v.t.length > 24 ? v.t.slice(0, 24) + '…' : v.t;
          return '<a class="tut-chip" href="https://www.bilibili.com/video/' + v.bv + '/" ' +
            'target="_blank" rel="noopener" title="' + escapeHtml(v.t) + '">▶ ' + escapeHtml(short) + '</a>';
        }).join('');
    } else {
      // 这款妆容还没有人工筛选的具体视频 —— 给按名字的直达搜索，不编造视频号
      strip.classList.remove('hidden');
      strip.innerHTML = '<span class="tut-strip-label">🎬 找这款妆容的教程</span>' +
        '<a class="tut-chip" href="https://search.bilibili.com/all?keyword=' +
          encodeURIComponent(look.name + ' 教程') + '" target="_blank" rel="noopener">' +
          '▶ B 站搜「' + escapeHtml(look.name) + '」</a>' +
        '<a class="tut-chip" href="https://www.xiaohongshu.com/search_result?keyword=' +
          encodeURIComponent(look.name + ' 教程') + '" target="_blank" rel="noopener">' +
          '📕 小红书图文</a>' +
        '<span class="tut-strip-note">这款还没有人工筛选的视频，先给你直达搜索</span>';
    }

    // 阶段标签
    const tabs = $('#stage-tabs');
    tabs.innerHTML = '';
    D.stages.forEach(function (s, i) {
      const cls = 'stage-tab' + (i === state.currentStage ? ' active' : '') + (i < state.currentStage ? ' done' : '');
      const t = el('button', cls);
      t.innerHTML = '<span>' + s.icon + '</span>' + s.title;
      t.style.animationDelay = (i * 45) + 'ms';
      t.addEventListener('click', function () { state.currentStage = i; renderTeaching(); });
      tabs.appendChild(t);
    });

    renderAidBar();           // 眼型 / 脸型 / 辅助开关
    renderStageContent();
    updateStageNav();
    renderShop(look.id);      // 购物清单随妆容变化
    renderTips();             // 新手通用技巧
  }

  function renderStageContent() {
    const stage = D.stages[state.currentStage];
    const look = D.looks.find(function (l) { return l.id === state.currentLook; });
    const c = getStageContent(stage);
    const wrap = $('#stage-content');
    wrap.innerHTML = '';

    const layout = el('div', 'stage-layout solo');
    const prefs = currentPrefs();

    // 正文（原先左侧的程序生成配图已移除）
    const body = el('div', 'stage-body');
    body.appendChild(el('h4', null, stage.icon + ' ' + stage.title));
    body.appendChild(el('p', 'stage-intro', c.intro));

    c.steps.forEach(function (s, i) {
      const step = el('div', 'step');
      step.innerHTML =
        '<div class="step-num">' + (i + 1) + '</div>' +
        '<div class="step-text"><h5>' + escapeHtml(s.name) + '</h5>' +
        '<p>' + escapeHtml(s.desc) + '</p>' +
        (s.tip ? '<div class="tip">' + escapeHtml(s.tip) + '</div>' : '') + '</div>';
      step.style.animationDelay = (0.08 + i * 0.09) + 's';
      body.appendChild(step);
    });

    // 眼型 / 脸型针对性调整
    const sg = shapeGuideBox(stage.id);
    if (sg) body.appendChild(sg);

    // 新手辅助：手法技巧 + 画错了怎么救（可在个性化里关掉）
    const bb = prefOn('guide') ? beginnerBox(stage.id) : null;
    if (bb) body.appendChild(bb);

    if (c.notes.length) {
      const nb = el('div', 'notes-box');
      nb.innerHTML = '<h5>' + (state.customNotes[stage.id] ? '🧖‍♀️ 本妆定制 + 肤质建议' : '✨ 本妆定制建议') + '</h5><ul>' +
        c.notes.map(function (n) { return '<li>' + escapeHtml(n) + '</li>'; }).join('') + '</ul>';
      body.appendChild(nb);
    }

    // 照着画：自检清单
    const ck = checklistBox(stage, state.currentLook, state.currentStage, false);
    if (ck) body.appendChild(ck);

    // 产品（点一下直接搜同款）
    body.appendChild(el('h5', null, '🧴 所需产品（点击可搜同款）'));
    body.appendChild(productChips(stage.products));

    // 具体产品推荐（可折叠，按肤质筛选）
    const sp = stageProductBox(stage.id);
    if (sp) body.appendChild(sp);

    // 视频
    body.appendChild(renderVideo(stage));

    layout.appendChild(body);
    wrap.appendChild(layout);
  }

  function renderVideo(stage) {
    const v = stage.video || {};
    const box = el('div', 'video-section');
    box.appendChild(el('h5', null, '🎬 公开视频教学素材'));

    // 内嵌（若配置了具体 BV / 视频 ID）
    let embedHtml = '';
    if (v.bilibiliBV) {
      embedHtml += '<iframe src="https://player.bilibili.com/player.html?bvid=' + encodeURIComponent(v.bilibiliBV) + '&page=1&high_quality=1" scrolling="no" frameborder="no" allowfullscreen="true"></iframe>';
    } else if (v.youtubeId) {
      embedHtml += '<iframe src="https://www.youtube.com/embed/' + encodeURIComponent(v.youtubeId) + '" title="YouTube video" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen></iframe>';
    }
    if (embedHtml) {
      box.appendChild(el('div', 'video-embed', embedHtml));
    }

    // 外链（始终提供，作为回退）
    const links = el('div', 'video-links');
    const bq = encodeURIComponent(v.bilibili || stage.title + ' 教程');
    const yq = encodeURIComponent(v.youtube || 'makeup tutorial');
    links.innerHTML =
      '<a class="video-link" href="https://search.bilibili.com/all?keyword=' + bq + '" target="_blank" rel="noopener">📺 在 Bilibili 搜索相关教程</a>' +
      '<a class="video-link" href="https://www.youtube.com/results?search_query=' + yq + '" target="_blank" rel="noopener">▶️ 在 YouTube 搜索相关教程</a>';
    box.appendChild(links);
    box.appendChild(el('p', 'hint', '视频内容来自公开平台，版权归原作者所有；点击链接跳转至源站观看。'));
    return box;
  }

  function updateStageNav() {
    const total = D.stages.length;
    $('#stage-progress').innerHTML =
      '第 ' + (state.currentStage + 1) + ' / ' + total + ' 步 · ' + D.stages[state.currentStage].title +
      '<div class="bar"><i style="width:' + ((state.currentStage + 1) / total * 100) + '%"></i></div>';
    $('#btn-prev').disabled = state.currentStage === 0;
    $('#btn-next').textContent = state.currentStage === total - 1 ? '完成 🎉' : '下一步 →';
  }

  /* ============ 化妆辅助：眼型 / 脸型 / 参考线 / 自检清单 ============ */
  function currentPrefs() { return S.getPrefs(); }

  /* ============ 界面主题与风格 ============ */
  /* 主题被下线后，本地存着的旧 id 会失效 —— 统一回落到默认，避免界面卡在无选中状态 */
  function currentThemeId() {
    const id = currentPrefs().theme;
    const ok = (D.themes || []).some(function (t) { return t.id === id; });
    return ok ? id : 'rose';
  }

  function applyTheme(id) {
    const t = (id || 'rose');
    const root = document.documentElement;
    // rose 就是 :root 里的默认值，不用加属性
    if (t === 'rose') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', t);
  }

  function applyUIStyle(id) {
    const s = (id || 'soft');
    const root = document.documentElement;
    if (s === 'soft') root.removeAttribute('data-style');
    else root.setAttribute('data-style', s);
  }

  function applyAppearance() {
    applyTheme(currentThemeId());
    applyUIStyle(currentPrefs().uiStyle);
  }

  function setTheme(id) {
    S.setPrefs({ theme: id });
    applyTheme(id);
    const t = (D.themes || []).find(function (x) { return x.id === id; });
    flashPers('已切换到「' + ((t && t.name) || id) + '」主题');
  }

  function setUIStyle(id) {
    S.setPrefs({ uiStyle: id });
    applyUIStyle(id);
    const s = (D.uiStyles || []).find(function (x) { return x.id === id; });
    flashPers('界面风格：' + ((s && s.name) || id));
  }

  /* 判断某个开关当前是否开启（grid/checklist 默认关，showShop/guide 默认开） */
  function prefOn(k) {
    const v = currentPrefs()[k];
    if (k === 'grid' || k === 'checklist') return !!v;
    return v !== false;
  }

  function labelFor(field, val) {
    if (!val) return '不指定';
    let x = null;
    if (field === 'eye') x = (D.eyeShapes || []).find(function (s) { return s.id === val; });
    if (field === 'face') x = (D.faceShapes || []).find(function (s) { return s.id === val; });
    if (field === 'tier') x = (D.budgetTiers || []).find(function (s) { return s.id === val; });
    return x ? x.name : val;
  }

  function flashPers(msg) {
    const st = $('#pers-status');
    if (!st) return;
    st.className = 'hint ok';
    st.textContent = '✅ ' + msg;
    clearTimeout(flashPers._t);
    flashPers._t = setTimeout(function () { st.textContent = ''; }, 2600);
  }

  /* 设置页的「个性化」面板 */
  function renderPersonalize() {
    const body = $('#personalize-body');
    if (!body) return;
    const tiers = D.budgetTiers || [];
    const defaultTier = currentPrefs().tier || (tiers[1] && tiers[1].id) || '';

    const chipRow = function (label, hint, items, field, current, allowEmpty) {
      return '<div class="pers-group">' +
        '<div class="pers-head"><b>' + label + '</b>' + (hint ? '<small>' + hint + '</small>' : '') + '</div>' +
        '<div class="pers-chips">' +
          (allowEmpty
            ? '<button class="aid-chip' + (!current ? ' active' : '') + '" data-pers="' + field +
              '" data-val="" type="button">不指定</button>'
            : '') +
          items.map(function (it) {
            const nm = (it.icon ? it.icon + ' ' : '') + it.name;
            return '<button class="aid-chip' + (current === it.id ? ' active' : '') + '" data-pers="' + field +
              '" data-val="' + it.id + '" type="button" title="' + escapeHtml(it.brief || it.note || '') + '">' +
              escapeHtml(nm) + '</button>';
          }).join('') +
        '</div></div>';
    };

    /* 开关用真正的 toggle 控件：状态一眼可见，切换时布局不跳动 */
    const switchRow = function (field, label, hint) {
      const on = prefOn(field);
      return '<label class="switch-row">' +
        '<span class="switch-text"><b>' + label + '</b><small>' + escapeHtml(hint) + '</small></span>' +
        '<span class="switch"><input type="checkbox" data-pers-toggle="' + field + '"' +
          (on ? ' checked' : '') + ' /><i></i></span>' +
      '</label>';
    };

    /* 主题色卡 */
    const themeGrid = function () {
      const cur = currentThemeId();
      return '<div class="pers-group">' +
        '<div class="pers-head"><b>🎨 界面主题</b><small>' + (D.themes || []).length + ' 套配色，点一下立刻生效，按账号保存</small></div>' +
        '<div class="theme-grid">' +
          (D.themes || []).map(function (t) {
            return '<button class="theme-swatch' + (t.id === cur ? ' active' : '') + '" data-theme="' + t.id +
              '" type="button" title="' + escapeHtml(t.desc || '') + '">' +
              '<span class="ts-dots">' +
                t.colors.map(function (c) { return '<i style="background:' + c + '"></i>'; }).join('') +
              '</span>' +
              '<span class="ts-name">' + escapeHtml(t.name) + '</span>' +
              '<span class="ts-check">' + (t.id === cur ? '✓ 使用中' : '') + '</span>' +
            '</button>';
          }).join('') +
        '</div>' +
      '</div>';
    };

    /* 风格（质感）：和配色独立，可自由组合 */
    const styleGrid = function () {
      const cur = currentPrefs().uiStyle || 'soft';
      return '<div class="pers-group">' +
        '<div class="pers-head"><b>🧊 界面风格</b><small>和配色独立，' + (D.themes || []).length + ' × ' +
          (D.uiStyles || []).length + ' 一共 ' + ((D.themes || []).length * (D.uiStyles || []).length) +
          ' 种组合</small></div>' +
        '<div class="style-grid">' +
          (D.uiStyles || []).map(function (s) {
            return '<button class="style-card' + (s.id === cur ? ' active' : '') + '" data-uistyle="' + s.id +
              '" data-style="' + s.id + '" type="button">' +
              '<span class="sc-preview"><i></i><i></i><i></i></span>' +
              '<span class="sc-name">' + escapeHtml(s.name) + '</span>' +
              '<span class="sc-desc">' + escapeHtml(s.desc) + '</span>' +
              '<span class="sc-check">' + (s.id === cur ? '✓ 使用中' : '') + '</span>' +
            '</button>';
          }).join('') +
        '</div>' +
      '</div>';
    };

    body.innerHTML =
      themeGrid() +
      styleGrid() +
      chipRow('👁 我的眼型', '眼妆步骤会给出针对这个眼型的调整', D.eyeShapes || [], 'eye', currentPrefs().eye, true) +
      chipRow('😊 我的脸型', '腮红修容步骤会给出针对这个脸型的调整', D.faceShapes || [], 'face', currentPrefs().face, true) +
      chipRow('💰 预算档位', '决定购物清单里搜索关键词的价位倾向', tiers, 'tier', defaultTier, false) +
      (currentTier().custom
        ? '<div class="pers-group"><div class="pers-head"><b>✏️ 自定义搜索词</b>' +
            '<small>会拼在搜索词里，例如「国货 散粉 200元以内」；留空等同于中端</small></div>' +
            '<div class="pers-custom">' +
              '<label class="field"><span>关键词</span><input type="text" id="pers-kw" class="input" maxlength="24" value="' +
                escapeHtml(currentPrefs().customKw || '') + '" placeholder="' +
                escapeHtml((currentTier().hints && currentTier().hints.kw) || '') + '" /></label>' +
              '<label class="field"><span>价格区间</span><input type="text" id="pers-price" class="input" maxlength="20" value="' +
                escapeHtml(currentPrefs().customPrice || '') + '" placeholder="' +
                escapeHtml((currentTier().hints && currentTier().hints.price) || '') + '" /></label>' +
            '</div>' +
            '<p class="tier-preview">实际搜索词示例：<b>' + escapeHtml(tierKeyword('散粉')) + '</b></p>' +
          '</div>'
        : '') +
      (currentTier().total
        ? '<div class="pers-group"><div class="pers-head"><b>🎯 总预算搭配</b>' +
            '<small>从每个品类挑一款凑成一套，总价不超过这个金额（最多允许超 ' +
              ((D.makeupSet && D.makeupSet.tolerance) || 50) + ' 元）</small></div>' +
            '<div class="pers-custom">' +
              '<label class="field"><span>总预算（元）</span>' +
                '<input type="number" id="pers-budget" class="input" min="100" step="50" value="' +
                  (Number(currentPrefs().budgetTotal) || '') + '" placeholder="例如 1000" /></label>' +
              '<label class="field"><span>套餐范围</span>' +
                '<select id="pers-preset" class="input">' +
                  ((D.makeupSet && D.makeupSet.presets) || []).map(function (p) {
                    return '<option value="' + p.id + '"' +
                      (p.id === (currentPrefs().budgetPreset || 'makeup') ? ' selected' : '') + '>' +
                      escapeHtml(p.name) + '（' + p.cats.length + ' 个品类）</option>';
                  }).join('') +
                '</select></label>' +
            '</div>' +
            '<p class="tier-preview">在「🛍️ 产品推荐」页可以看到搭配结果，也可以在那里直接设置。</p>' +
          '</div>'
        : '') +
      '<div class="pers-group">' +
        '<div class="pers-head"><b>🔧 显示选项</b><small>拨动开关即时生效，设置存在当前账号</small></div>' +
        '<div class="switch-list">' +
          switchRow('checklist', '照着画 · 自检清单', '每一步末尾给出可勾选的自检项，勾选状态存进账号') +
          switchRow('guide', '新手技巧与补救', '每一步显示「手法技巧」和「画错了怎么救」；熟练后可关掉让页面更清爽') +
          switchRow('showShop', '化妆品购买入口', '在购物清单和产品标签上显示各平台直达链接') +
        '</div>' +
      '</div>' +
      '<div class="pers-actions">' +
        '<button class="btn ghost" id="btn-reset-pers" type="button">↺ 重置个性化</button>' +
        '<span class="hint" id="pers-status"></span>' +
      '</div>';

    // 主题色卡
    body.querySelectorAll('[data-theme]').forEach(function (b) {
      b.addEventListener('click', function () {
        setTheme(b.dataset.theme);
        renderPersonalize();
      });
    });

    // 界面风格
    body.querySelectorAll('[data-uistyle]').forEach(function (b) {
      b.addEventListener('click', function () {
        setUIStyle(b.dataset.uistyle);
        renderPersonalize();
      });
    });

    body.querySelectorAll('[data-pers]').forEach(function (b) {
      b.addEventListener('click', function () {
        const patch = {};
        patch[b.dataset.pers] = b.dataset.val;
        S.setPrefs(patch);
        renderPersonalize();
        flashPers('已选择：' + labelFor(b.dataset.pers, b.dataset.val));
      });
    });

    // 自定义搜索词输入
    const pkw = body.querySelector('#pers-kw');
    const ppr = body.querySelector('#pers-price');
    if (pkw || ppr) {
      const commit = function () {
        S.setPrefs({
          customKw: pkw ? pkw.value.trim() : '',
          customPrice: ppr ? ppr.value.trim() : ''
        });
        const pv = body.querySelector('.tier-preview b');
        if (pv) pv.textContent = tierKeyword('散粉');
        flashPers('已保存自定义搜索词');
      };
      [pkw, ppr].forEach(function (inp) {
        if (!inp) return;
        inp.addEventListener('change', commit);
        inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') inp.blur(); });
      });
    }

    // 总预算输入
    const pbg = body.querySelector('#pers-budget');
    const pps = body.querySelector('#pers-preset');
    if (pbg || pps) {
      const commitBudget = function () {
        const v = Number((pbg ? pbg.value : '').trim()) || 0;
        S.setPrefs({
          budgetTotal: v,
          budgetPreset: pps ? pps.value : (currentPrefs().budgetPreset || 'makeup')
        });
        budgetPick = 0;
        flashPers(v ? ('已设为 ¥' + v + ' 总预算，去「🛍️ 产品推荐」看搭配') : '已清除总预算');
        if (v) renderBudgetCard();
      };
      [pbg, pps].forEach(function (inp) {
        if (!inp) return;
        inp.addEventListener('change', commitBudget);
        inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') inp.blur(); });
      });
    }

    body.querySelectorAll('[data-pers-toggle]').forEach(function (cb) {
      cb.addEventListener('change', function () {
        const k = cb.dataset.persToggle;
        const next = cb.checked;
        const patch = {};
        patch[k] = next;
        S.setPrefs(patch);
        const row = cb.closest('.switch-row');
        const name = row ? row.querySelector('b').textContent : k;
        flashPers('已' + (next ? '开启' : '关闭') + '：' + name);
        // 开关状态由 checkbox 自己维护，无需整体重渲染，避免页面跳动
      });
    });

    $('#btn-reset-pers').addEventListener('click', async function () {
      const ok = await confirmDialog({
        title: '重置个性化',
        message: '确定要把个性化设置恢复成默认值吗？',
        detail: '你将失去：已选的眼型、脸型、预算档位，以及三个显示开关的状态。',
        okText: '重置',
        danger: true
      });
      if (!ok) return;
      S.setPrefs({ eye: '', face: '', grid: false, checklist: false, tier: '', showShop: true, guide: true });
      renderPersonalize();
      flashPers('已重置为默认');
      toast('个性化已重置为默认', { type: 'info' });
    });
  }

  function renderAidBar() {
    const bar = $('#aid-bar');
    if (!bar) return;
    const p = currentPrefs();

    const chipRow = function (label, items, field, current) {
      return '<div class="aid-row"><span class="aid-label">' + label + '</span>' +
        '<button class="aid-chip' + (!current ? ' active' : '') + '" data-aid="' + field +
          '" data-val="" type="button">不指定</button>' +
        items.map(function (it) {
          return '<button class="aid-chip' + (current === it.id ? ' active' : '') + '" data-aid="' + field +
            '" data-val="' + it.id + '" type="button" title="' + escapeHtml(it.brief || '') + '">' +
            escapeHtml(it.name) + '</button>';
        }).join('') + '</div>';
    };

    bar.innerHTML =
      chipRow('👁 眼型', D.eyeShapes || [], 'eye', p.eye) +
      chipRow('😊 脸型', D.faceShapes || [], 'face', p.face) +
      '<div class="aid-row"><span class="aid-label">🔧 辅助</span>' +
        '<button class="aid-chip' + (p.checklist ? ' active' : '') + '" data-toggle="checklist" type="button">照着画 · 自检清单</button>' +
      '</div>';

    bar.querySelectorAll('[data-aid]').forEach(function (b) {
      b.addEventListener('click', function () {
        const patch = {};
        patch[b.dataset.aid] = b.dataset.val;
        S.setPrefs(patch);
        renderTeaching();
      });
    });
    bar.querySelectorAll('[data-toggle]').forEach(function (b) {
      b.addEventListener('click', function () {
        const k = b.dataset.toggle;
        const patch = {};
        patch[k] = !currentPrefs()[k];
        S.setPrefs(patch);
        renderTeaching();
      });
    });
  }

  /* 按所选眼型 / 脸型，给出当前这一步的针对性调整 */
  function shapeGuideBox(stageId) {
    const p = currentPrefs();
    const blocks = [];
    const eye = (D.eyeShapes || []).find(function (x) { return x.id === p.eye; });
    const face = (D.faceShapes || []).find(function (x) { return x.id === p.face; });

    const collect = function (shape, icon) {
      if (!shape) return;
      const items = (shape.tips || []).filter(function (t) { return !t.s || t.s === stageId; });
      if (!items.length) return;
      blocks.push({
        title: icon + ' ' + shape.name + ' · 这一步怎么调',
        brief: shape.brief,
        items: items.map(function (t) { return t.t; })
      });
    };
    collect(eye, '👁');
    collect(face, '😊');

    if (!blocks.length) return null;
    const box = el('div', 'shape-box');
    box.innerHTML = blocks.map(function (b) {
      return '<div class="shape-block"><h5>' + escapeHtml(b.title) + '</h5>' +
        (b.brief ? '<p class="shape-brief">' + escapeHtml(b.brief) + '</p>' : '') +
        '<ul>' + b.items.map(function (t) { return '<li>' + escapeHtml(t) + '</li>'; }).join('') + '</ul></div>';
    }).join('');
    return box;
  }

  /* 照着画：这一步的自检清单（勾选状态存账号） */
  function checklistBox(stage, lookKey, stageIdx, showEvenIfEmpty) {
    const items = (D.selfChecks && D.selfChecks[stage.id]) || [];
    if (!items.length) return null;
    if (!showEvenIfEmpty && !currentPrefs().checklist) return null;

    const key = (lookKey || 'std') + ':' + stageIdx;
    const done = S.getChecklist(key);

    const box = el('div', 'check-box');
    box.innerHTML =
      '<h5>📋 照着画 · 自检清单</h5>' +
      '<p class="check-sub">画完这一步，逐项对照检查一遍。勾选状态会保存在你的账号里。</p>' +
      '<div class="check-list">' +
        items.map(function (t, i) {
          const on = done.indexOf(i) >= 0;
          return '<label class="check-item' + (on ? ' done' : '') + '">' +
            '<input type="checkbox"' + (on ? ' checked' : '') + ' data-idx="' + i + '" />' +
            '<span>' + escapeHtml(t) + '</span></label>';
        }).join('') +
      '</div>' +
      '<button class="mini-btn" data-reset="1" type="button">清空勾选</button>';

    box.querySelectorAll('input[type=checkbox]').forEach(function (cb) {
      cb.addEventListener('change', function () {
        const cur = S.getChecklist(key);
        const i = parseInt(cb.dataset.idx, 10);
        const pos = cur.indexOf(i);
        if (cb.checked && pos < 0) cur.push(i);
        if (!cb.checked && pos >= 0) cur.splice(pos, 1);
        S.setChecklist(key, cur);
        cb.closest('.check-item').classList.toggle('done', cb.checked);
      });
    });
    box.querySelector('[data-reset]').addEventListener('click', async function () {
      const ok = await confirmDialog({
        title: '清空自检勾选',
        message: '确定要清空这一步的全部勾选吗？',
        detail: '只是把自检清单恢复成未勾选状态，不影响你的妆容和档案。',
        okText: '清空',
        danger: true
      });
      if (!ok) return;
      S.clearChecklist(key);
      renderTeaching();
      toast('自检勾选已清空', { type: 'info' });
    });
    return box;
  }

  /* ============ 新手辅助：手法技巧 + 画错了怎么救 ============ */
  function beginnerBox(stageId) {
    const b = D.beginner && D.beginner[stageId];
    if (!b) return null;
    const tips = b.tips || [];
    const fixes = b.fixes || [];
    if (!tips.length && !fixes.length) return null;

    const box = el('div', 'beginner-box');
    box.innerHTML =
      (tips.length
        ? '<div class="bg-block">' +
            '<h5>🔰 新手手法技巧</h5>' +
            '<ul class="bg-tips">' + tips.map(function (t) { return '<li>' + escapeHtml(t) + '</li>'; }).join('') + '</ul>' +
          '</div>'
        : '') +
      (fixes.length
        ? '<div class="bg-block">' +
            '<h5>🩹 画错了怎么救</h5>' +
            '<div class="fix-list">' +
              fixes.map(function (f) {
                return '<div class="fix-item"><b>' + escapeHtml(f.p) + '</b>' +
                  '<span>' + escapeHtml(f.f) + '</span></div>';
              }).join('') +
            '</div>' +
          '</div>'
        : '');
    return box;
  }

  /* 通用新手技巧（任何妆容都适用） */
  function renderTips() {
    const card = $('#tips-card');
    if (!card) return;
    if (!prefOn('guide')) { card.classList.add('hidden'); card.innerHTML = ''; return; }
    const list = D.beginnerGeneral || [];
    if (!list.length) { card.classList.add('hidden'); return; }

    card.classList.remove('hidden');
    card.innerHTML =
      '<details class="tips-fold" open>' +
        '<summary>' +
          '<span class="tips-fold-title">🔰 新手通用技巧</span>' +
          '<span class="tips-fold-sub">' + list.length + ' 条最容易踩的坑 · 点击收起</span>' +
        '</summary>' +
        '<div class="tips-grid">' +
          list.map(function (t) {
            return '<div class="tip-card"><b>' + escapeHtml(t.t) + '</b>' +
              '<p>' + escapeHtml(t.d) + '</p></div>';
          }).join('') +
        '</div>' +
      '</details>';
  }

  /* ============ 化妆品购买链接 ============
   * 只给「品类 + 精确搜索关键词」，不给具体商品链接：
   * 商品链接会失效，且同品类不同肤质/预算的选择差别很大，应由用户自己比价。
   */
  const SHOP_PLATFORMS = [
    { name: '淘宝', url: function (k) { return 'https://s.taobao.com/search?q=' + k; } },
    { name: '京东', url: function (k) { return 'https://search.jd.com/Search?keyword=' + k; } },
    { name: '拼多多', url: function (k) { return 'https://mobile.yangkeduo.com/search_result.html?search_key=' + k; }, app: true },
    { name: '抖音商城', url: function (k) { return 'https://www.douyin.com/search/' + k; }, app: true },
    { name: '小红书', url: function (k) { return 'https://www.xiaohongshu.com/search_result?keyword=' + k; } }
  ];

  function currentTier() {
    const tiers = D.budgetTiers || [];
    const id = currentPrefs().tier;
    return tiers.find(function (t) { return t.id === id; }) || tiers[1] || tiers[0] || { prefix: '', name: '' };
  }

  /* 生成搜索关键词：
   *   ［自定义关键词］ + ［档位前缀］ + 品类关键词 + ［自定义价格］
   * 自定义档位时，前后两段由用户填写。
   */
  function tierKeyword(kw, tier) {
    const t = tier || currentTier();
    const p = currentPrefs();
    const parts = [];
    if (t && t.custom) {
      if (p.customKw) parts.push(String(p.customKw).trim());
      parts.push(kw || '');
      if (p.customPrice) parts.push(String(p.customPrice).trim());
    } else {
      if (t && t.prefix) parts.push(t.prefix);
      parts.push(kw || '');
    }
    return parts.filter(function (x) { return x; }).join(' ').replace(/\s+/g, ' ').trim();
  }

  function shopLinks(kw, tier) {
    const full = tierKeyword(kw, tier);
    const k = encodeURIComponent(full);
    const safe = escapeHtml(full);
    return '<span class="shop-links">' +
      SHOP_PLATFORMS.map(function (p) {
        return '<a href="' + p.url(k) + '" target="_blank" rel="noopener" title="在' + p.name +
          '搜索「' + safe + '」' + (p.app ? '（App 内体验更好）' : '') + '">' + p.name + '</a>';
      }).join('') + '</span>';
  }

  /* 阶段产品标签：点一下直接搜同款（带当前预算档位）；
     若在「个性化」里关掉了购买入口，就只作为普通标签显示 */
  function productChips(names) {
    const box = el('div', 'products');
    const show = prefOn('showShop');
    const tier = currentTier();
    (names || []).forEach(function (p) {
      if (!show) {
        const sp = el('span', 'product-chip');
        sp.textContent = p;
        box.appendChild(sp);
        return;
      }
      const full = tierKeyword(p, tier);
      const a = el('a', 'product-chip');
      a.href = 'https://s.taobao.com/search?q=' + encodeURIComponent(full);
      a.target = '_blank';
      a.rel = 'noopener';
      a.title = '在淘宝搜索「' + full + '」';
      a.textContent = p;
      box.appendChild(a);
    });
    return box;
  }

  /* 某个妆容的完整购物清单 */
  function renderShop(lookId) {
    const card = $('#shop-card');
    if (!card) return;
    // 个性化里关掉了购买入口
    if (!prefOn('showShop')) { card.classList.add('hidden'); card.innerHTML = ''; return; }
    const list = (D.shopping && D.shopping[lookId]) || [];
    if (!list.length) { card.classList.add('hidden'); card.innerHTML = ''; return; }

    const look = D.looks.find(function (l) { return l.id === lookId; });

    // 按类别分组
    const groups = [];
    const idx = {};
    list.forEach(function (it) {
      if (idx[it.c] == null) { idx[it.c] = groups.length; groups.push({ c: it.c, items: [] }); }
      groups[idx[it.c]].items.push(it);
    });

    // 预算档位
    const tiers = D.budgetTiers || [];
    const prefs = currentPrefs();
    const tierId = prefs.tier || (tiers[1] && tiers[1].id) || '';
    const tier = tiers.find(function (t) { return t.id === tierId; }) || tiers[0] || {};

    const itemHtml = function (it) {
      const base = it.kw || it.item;
      return '<div class="shop-item" data-kw="' + escapeHtml(base) + '">' +
        '<span class="shop-item-main"><b>' + escapeHtml(it.item) + '</b>' +
        (it.note ? '<small>' + escapeHtml(it.note) + '</small>' : '') + '</span>' +
        shopLinks(base, tier) + '</div>';
    };

    card.classList.remove('hidden');
    card.innerHTML =
      '<div class="card-title">' +
        '<h3>🛍 「' + escapeHtml(look ? look.name : '') + '」需要买什么</h3>' +
        '<span class="hint">点平台名跳到该品类的搜索页，自己比价挑选</span>' +
      '</div>' +
      '<div class="tier-row">' +
        '<span class="tier-label">预算档位</span>' +
        tiers.map(function (t) {
          return '<button class="aid-chip' + (t.id === tierId ? ' active' : '') + '" data-tier="' + t.id +
            '" type="button">' + t.icon + ' ' + escapeHtml(t.name) + '</button>';
        }).join('') +
      '</div>' +
      (tier.custom
        ? '<div class="tier-custom">' +
            '<label class="field"><span>自定义关键词（选填）</span>' +
              '<input type="text" id="tier-kw" class="input" maxlength="24" value="' +
                escapeHtml(prefs.customKw || '') + '" placeholder="' +
                escapeHtml((tier.hints && tier.hints.kw) || '') + '" /></label>' +
            '<label class="field"><span>价格区间（选填）</span>' +
              '<input type="text" id="tier-price" class="input" maxlength="20" value="' +
                escapeHtml(prefs.customPrice || '') + '" placeholder="' +
                escapeHtml((tier.hints && tier.hints.price) || '') + '" /></label>' +
            '<p class="tier-preview">实际搜索词示例：<b>' + escapeHtml(tierKeyword('散粉', tier)) + '</b></p>' +
          '</div>'
        : '') +
      '<div class="tier-note">' +
        '<b>' + (tier.icon || '') + ' ' + escapeHtml(tier.name || '') + '</b>' +
        '<span>' + escapeHtml(tier.note || '') + '</span>' +
        (tier.brands && tier.brands.length
          ? '<p class="tier-brands">常见参考品牌：' + tier.brands.map(escapeHtml).join(' · ') +
            '<br><i>仅为常见品牌举例，不是推荐也不是唯一选择；价格与活动随时变化，请以平台实际为准。</i></p>'
          : '') +
      '</div>' +
      '<div class="shop-list">' +
        groups.map(function (g) {
          return '<div class="shop-group"><h5>' + escapeHtml(g.c) + '</h5>' +
            g.items.map(itemHtml).join('') + '</div>';
        }).join('') +
      '</div>' +
      '<details class="shop-basics">' +
        '<summary>➕ 基础工具（任何妆容都用得上）</summary>' +
        '<div class="shop-list">' + (D.shoppingBasics || []).map(itemHtml).join('') + '</div>' +
      '</details>' +
      '<p class="hint">⚠️ 上面给的是<b>品类和搜索关键词</b>，不是具体商品链接 —— 商品链接容易失效，' +
      '而且同一品类在不同肤质和预算下选择差别很大，建议自己比价。购买请认准官方旗舰店，注意辨别真伪。' +
      '<br>拼多多 / 抖音商城的链接在手机 App 内体验更好，电脑上可能需要扫码或跳转。</p>';

    // 切换预算档位
    card.querySelectorAll('[data-tier]').forEach(function (b) {
      b.addEventListener('click', function () {
        S.setPrefs({ tier: b.dataset.tier });
        renderShop(lookId);
      });
    });

    // 自定义档位：输入时只更新链接，不重渲染（否则会丢焦点）
    const kwInput = card.querySelector('#tier-kw');
    const priceInput = card.querySelector('#tier-price');
    if (kwInput || priceInput) {
      const applyCustom = function () {
        S.setPrefs({
          customKw: kwInput ? kwInput.value.trim() : '',
          customPrice: priceInput ? priceInput.value.trim() : ''
        });
        const t2 = { custom: true };
        // 原地更新每个商品的平台链接
        card.querySelectorAll('.shop-item').forEach(function (row) {
          const base = row.dataset.kw;
          if (!base) return;
          const full = tierKeyword(base, t2);
          const enc = encodeURIComponent(full);
          row.querySelectorAll('.shop-links a').forEach(function (a, i) {
            const plat = SHOP_PLATFORMS[i];
            if (!plat) return;
            a.href = plat.url(enc);
            a.title = '在' + plat.name + '搜索「' + full + '」' + (plat.app ? '（App 内体验更好）' : '');
          });
        });
        // 同步更新示例搜索词
        const pv = card.querySelector('.tier-preview b');
        if (pv) pv.textContent = tierKeyword('散粉', t2);
      };
      [kwInput, priceInput].forEach(function (inp) {
        if (!inp) return;
        inp.addEventListener('change', applyCustom);
        inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') inp.blur(); });
      });
    }
  }

  /* ============ 化妆流程（独立大板块） ============ */
  function renderProcess() {
    const row = $('#proc-look-row');
    const nav = $('#proc-nav');
    const wrap = $('#process-content');
    if (!wrap || !row || !nav) return;

    const lookId = state.processLook || '';
    const look = lookId ? D.looks.find(function (l) { return l.id === lookId; }) : null;
    const palette = look ? look.palette : ['#e8a2b0', '#d98292', '#f5c6ce', '#b95f73'];
    const prefs = currentPrefs();

    /* 妆容选择：不选 = 标准流程 */
    row.innerHTML =
      '<button class="chip' + (!look ? ' active' : '') + '" data-look="" type="button">标准流程</button>' +
      D.looks.map(function (l) {
        return '<button class="chip' + (lookId === l.id ? ' active' : '') + '" data-look="' + l.id + '" type="button">' +
          escapeHtml(l.name) + '</button>';
      }).join('');
    row.querySelectorAll('[data-look]').forEach(function (b) {
      b.addEventListener('click', function () {
        state.processLook = b.dataset.look;
        renderProcess();
      });
    });

    /* 顶部步骤速跳 */
    nav.innerHTML = D.stages.map(function (s, i) {
      return '<a class="proc-chip" href="#proc-stage-' + (i + 1) + '">' +
        '<b>' + (i + 1) + '</b>' + s.icon + ' ' + escapeHtml(s.title) + '</a>';
    }).join('');

    /* 八个阶段依次铺开 */
    wrap.innerHTML = '';
    D.stages.forEach(function (stage, i) {
      const tw = (look && look.tweaks && look.tweaks[stage.id]) || {};
      const intro = tw.intro || stage.intro;
      const steps = tw.steps || stage.steps;
      const notes = tw.notes || [];

      const art = el('article', 'proc-stage');
      art.id = 'proc-stage-' + (i + 1);

      art.innerHTML =
        '<header class="proc-stage-head">' +
          '<span class="proc-num">' + (i + 1) + '</span>' +
          '<h3>' + stage.icon + ' ' + escapeHtml(stage.title) + '</h3>' +
          '<span class="proc-count">' + steps.length + ' 个要点</span>' +
        '</header>' +
        '<div class="stage-layout solo">' +
          '<div class="stage-body">' +
            '<p class="stage-intro">' + escapeHtml(intro) + '</p>' +
            steps.map(function (s, k) {
              return '<div class="step"><div class="step-num">' + (k + 1) + '</div>' +
                '<div class="step-text"><h5>' + escapeHtml(s.name) + '</h5>' +
                '<p>' + escapeHtml(s.desc) + '</p>' +
                (s.tip ? '<div class="tip">' + escapeHtml(s.tip) + '</div>' : '') +
                '</div></div>';
            }).join('') +
            (notes.length
              ? '<div class="notes-box"><h5>✨ ' + (look ? escapeHtml(look.name) + ' 的定制建议' : '补充要点') + '</h5><ul>' +
                notes.map(function (n) { return '<li>' + escapeHtml(n) + '</li>'; }).join('') + '</ul></div>'
              : '') +
            '<h5>🧴 所需产品（点击可搜同款）</h5>' +
          '</div>' +
        '</div>';

      // 眼型/脸型调整、新手辅助、产品标签与视频区块都是 DOM 元素，单独追加
      const bodyEl = art.querySelector('.stage-body');
      const sg = shapeGuideBox(stage.id);
      if (sg) bodyEl.appendChild(sg);
      const bb = prefOn('guide') ? beginnerBox(stage.id) : null;
      if (bb) bodyEl.appendChild(bb);
      bodyEl.appendChild(productChips(stage.products));
      const sp = stageProductBox(stage.id);
      if (sp) bodyEl.appendChild(sp);
      bodyEl.appendChild(renderVideo(stage));
      wrap.appendChild(art);
    });
  }

  /* ============ 妆容识别 ============ */
  function setupDropzone(dropEl, inputEl, onFile) {
    dropEl.addEventListener('click', function (e) { if (e.target !== inputEl) inputEl.click(); });
    inputEl.addEventListener('change', function () { if (inputEl.files[0]) onFile(inputEl.files[0]); });
    ['dragover', 'dragenter'].forEach(function (ev) {
      dropEl.addEventListener(ev, function (e) { e.preventDefault(); dropEl.classList.add('drag'); });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      dropEl.addEventListener(ev, function (e) { e.preventDefault(); dropEl.classList.remove('drag'); });
    });
    dropEl.addEventListener('drop', function (e) {
      const f = e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) onFile(f);
    });
  }

  async function handleRecognizeFile(file) {
    if (!file.type || file.type.indexOf('image/') !== 0) { alert('请上传图片文件'); return; }
    state.recognizeFile = file;
    state.lastRecognize = null;
    const dataURL = await V.fileToDataURL(file);
    const img = $('#recognize-img');
    img.src = dataURL;
    $('#recognize-preview').classList.remove('hidden');
    $('#recognize-result').classList.add('hidden');
    $('#recognize-status').classList.add('hidden');
    $('#btn-save-look').disabled = true;      // 识别成功后才可保存
  }

  async function runRecognize() {
    if (!state.recognizeFile) { alert('请先上传妆容图片'); return; }
    const status = $('#recognize-status');
    status.classList.remove('hidden');
    status.textContent = '正在识别妆容风格…（未配置 API 时使用本地配色分析）';
    const btn = $('#btn-recognize');
    btn.disabled = true;

    try {
      const cfg = V.loadConfig();
      const img = $('#recognize-img');
      // 等待图片就绪
      if (!img.complete || !img.naturalWidth) { await new Promise(function (r) { img.onload = r; }); }
      const result = await V.recognizeLook(img, cfg);
      state.lastRecognize = result;                       // 供「保存到我的妆容」使用
      $('#btn-save-look').disabled = false;
      renderRecognizeResult(result);
      const hit = D.looks.find(function (l) { return l.id === result.lookId; });
      toast('识别完成：' + (hit ? hit.name : '已完成') +
        (result.mode === 'api' ? '（AI 视觉识别）' : '（本地配色分析）') +
        (result.cached ? ' · 来自缓存' : ''), { type: 'ok' });
    } catch (e) {
      state.lastRecognize = null;
      $('#btn-save-look').disabled = true;
      status.textContent = '识别出错：' + e.message;
      toast('识别失败：' + e.message, { type: 'err', duration: 5000 });
    } finally {
      btn.disabled = false;
      status.classList.add('hidden');
    }
  }

  /* ---------- 识别结果：妆容还原报告 ---------- */
  function restoreHtml(rs) {
    if (!rs) return '';
    const E = escapeHtml;
    const dot = function (hex) { return hex ? '<i class="rs-dot" style="background:' + E(hex) + '"></i>' : ''; };
    const hexc = function (hex) { return hex ? ' <code class="rs-hex">' + E(hex) + '</code>' : ''; };
    const sub = function (t) { return t ? '<i class="rs-sub">' + E(t) + '</i>' : ''; };
    const row = function (label, inner) {
      if (!inner) return '';
      return '<div class="rs-row"><span class="rs-label">' + label + '</span><span class="rs-val">' + inner + '</span></div>';
    };
    const e = rs.eye || {}, sk = rs.skin || {}, br = rs.brow || {}, ch = rs.cheek || {}, lp = rs.lip || {};
    const shadows = (e.shadows || []).map(function (s) {
      return '<span class="rs-shade">' + dot(s.hex) + E(s.color) + hexc(s.hex) +
        (s.where ? '<em>' + E(s.where) + '</em>' : '') +
        (s.texture ? '<em>' + E(s.texture) + '</em>' : '') + '</span>';
    }).join('');

    return '<div class="result-box rs-box">' +
      '<h4>📸 这张图的妆容还原' +
        (rs.approx ? ' <span class="rs-approx">粗略近似</span>' : '') + '</h4>' +
      '<p class="rs-style">' + E(rs.styleName) + (rs.vibe ? ' <small>' + E(rs.vibe) + '</small>' : '') + '</p>' +
      (rs.summary ? '<p class="rs-sum">' + E(rs.summary) + '</p>' : '') +
      '<div class="rs-grid">' +
        row('底妆', [sk.finish, sk.coverage, sk.shade].filter(Boolean).map(E).join(' · ') + sub(sk.detail)) +
        row('眉毛', [br.shape, br.thickness, br.color].filter(Boolean).map(E).join(' · ') + sub(br.detail)) +
        row('眼影', shadows) +
        row('眼线', E(e.liner)) +
        row('睫毛', E(e.lashes)) +
        row('眼部其他', E(e.extra)) +
        row('腮红', (ch.color ? dot(ch.hex) + E(ch.color) + hexc(ch.hex) : '') +
          (ch.where ? '<em class="rs-pos">' + E(ch.where) + '</em>' : '') + sub(ch.how)) +
        row('修容高光', E(rs.contour)) +
        row('唇妆', (lp.color ? dot(lp.hex) + E(lp.color) + hexc(lp.hex) : '') +
          (lp.texture ? '<em class="rs-pos">' + E(lp.texture) + '</em>' : '') + sub(lp.shape)) +
      '</div>' +
      ((rs.sampled && rs.sampled.length)
        ? '<div class="rs-sampled"><span>图上实际采样到的色调</span>' +
            rs.sampled.map(function (s) { return '<i class="rs-tag">' + E(s.name) + ' ' + s.percent + '%</i>'; }).join('') +
          '</div>'
        : '') +
    '</div>';
  }

  /* ---------- 识别结果：专属跟练步骤 ---------- */
  function stepsHtml(steps) {
    if (!steps || !steps.length) return '';
    const E = escapeHtml;
    return '<div class="result-box bs-box">' +
      '<h4>🪞 专属跟练步骤</h4>' +
      '<p class="hint" style="margin-top:0">这 ' + steps.length + ' 步是<b>按你这张图</b>拆出来的，不是套现成模板。' +
        '点标题展开/收起。</p>' +
      steps.map(function (s, i) {
        return '<details class="bs-stage"' + (i === 0 ? ' open' : '') + '>' +
          '<summary><span class="bs-no">' + (i + 1) + '</span>' + E(s.icon) + ' ' + E(s.title) +
            '<i>' + s.items.length + ' 个要点</i></summary>' +
          (s.intro ? '<p class="bs-intro">' + E(s.intro) + '</p>' : '') +
          s.items.map(function (it, k) {
            return '<div class="bs-item"><span class="bs-k">' + (k + 1) + '</span>' +
              '<div class="bs-body"><b>' + E(it.name) + '</b><p>' + E(it.desc) + '</p>' +
              (it.tip ? '<div class="tip">' + E(it.tip) + '</div>' : '') + '</div></div>';
          }).join('') +
        '</details>';
      }).join('') +
    '</div>';
  }

  /* ---------- 识别结果：全网找同款 ---------- */
  function searchHtml(r) {
    const qs = (r.queries || []).slice(0, 5);
    if (!qs.length) return '';
    const q0 = qs[0];
    const direct = function (label, url) {
      return '<a class="srch-d" href="' + url + '" target="_blank" rel="noopener">' + label + '</a>';
    };
    const isFile = (typeof location !== 'undefined' && location.protocol === 'file:');
    return '<div class="result-box srch-box">' +
      '<h4>🔎 全网找同款</h4>' +
      '<p class="hint" style="margin-top:0">' +
        (isFile
          ? '你目前是直接打开本地文件，服务器搜索用不了。用下面的<b>直达链接</b>去搜一样方便。'
          : '点按钮由<b>服务器实际去网上抓</b>（不是跳转到搜索页），抓不到还会自动给你直达链接。') +
      '</p>' +
      '<div class="srch-chips">' +
        qs.map(function (q, i) {
          return '<button class="srch-chip' + (i === 0 ? ' active' : '') + '" data-q="' + escapeHtml(q) +
            '" type="button">' + escapeHtml(q) + '</button>';
        }).join('') +
      '</div>' +
      '<div class="srch-actions">' +
        (isFile ? '' : '<button class="btn primary" id="btn-do-search" type="button">🔎 抓取真实结果</button>') +
        '<span class="srch-direct"><span>直达：</span>' +
          direct('B站', 'https://search.bilibili.com/all?keyword=' + encodeURIComponent(q0)) +
          direct('小红书', 'https://www.xiaohongshu.com/search_result?keyword=' + encodeURIComponent(q0)) +
          direct('抖音', 'https://www.douyin.com/search/' + encodeURIComponent(q0)) +
          direct('Google', 'https://www.google.com/search?q=' + encodeURIComponent(q0)) +
        '</span>' +
      '</div>' +
      '<div class="srch-res" id="srch-res"></div>' +
    '</div>';
  }

  async function runSearch(queries, box, btn) {
    if (!box) return;
    box.innerHTML = '<p class="hint">正在搜索…（每个词一次请求，可能要几秒）</p>';
    if (btn) { btn.disabled = true; }
    const cfg = (VISION.loadConfig ? VISION.loadConfig() : {}) || {};
    const headers = {};
    if (cfg.accessCode) headers['x-access-code'] = cfg.accessCode;

    const all = [], seen = {}, failed = [];
    try {
      for (let i = 0; i < queries.length; i++) {
        if (all.length >= 12) break;
        const q = queries[i];
        let j = null;
        try {
          const resp = await fetch('/api/search?n=5&q=' + encodeURIComponent(q), { headers: headers });
          j = await resp.json();
        } catch (e) { j = null; }
        if (j && j.results && j.results.length) {
          j.results.forEach(function (x) {
            if (!x.url || seen[x.url]) return;
            seen[x.url] = 1;
            all.push({ q: q, title: x.title, url: x.url, snippet: x.snippet || '', src: x.src, meta: x.meta || '' });
          });
        } else {
          failed.push(q);
        }
      }
    } finally {
      if (btn) { btn.disabled = false; }
    }

    if (!all.length) {
      box.innerHTML = '<p class="hint">没抓到结果（搜索源可能被限流或未配置）。' +
        '用上面的「直达」链接去搜，效果一样。</p>';
      return;
    }
    /* B 站视频排前面，其余按抓到顺序 */
    all.sort(function (a, b) { return (a.src === 'bilibili' ? 0 : 1) - (b.src === 'bilibili' ? 0 : 1); });
    const nBili = all.filter(function (x) { return x.src === 'bilibili'; }).length;
    box.innerHTML = '<p class="hint" style="margin:0 0 8px">共抓到 <b>' + all.length + '</b> 条' +
      (nBili ? '（其中 B 站视频 ' + nBili + ' 条）' : '') +
      (failed.length ? '，' + failed.length + ' 个词没抓到' : '') + '：</p>' +
      '<div class="srch-list">' + all.slice(0, 12).map(function (x) {
        const isBili = x.src === 'bilibili';
        return '<a class="srch-item' + (isBili ? ' is-bili' : '') + '" href="' + escapeHtml(x.url) +
          '" target="_blank" rel="noopener">' +
          '<b>' + (isBili ? '<span class="srch-tag">B站</span>' : '') + escapeHtml(x.title) + '</b>' +
          (x.meta ? '<em>' + escapeHtml(x.meta) + '</em>' : '') +
          (x.snippet ? '<span>' + escapeHtml(x.snippet.slice(0, 130)) + '</span>' : '') +
          '<i>' + escapeHtml(x.q) + '</i>' +
        '</a>';
      }).join('') + '</div>';
  }

  function renderRecognizeResult(r) {
    const look = D.looks.find(function (l) { return l.id === r.lookId; }) || D.looks[0];
    const box = $('#recognize-result');
    box.classList.remove('hidden');

    const E = escapeHtml;
    const isApi = r.mode === 'api';
    const AUD = { f: '♀ 偏女性', m: '♂ 偏男性', any: '⚥ 男女皆可' };
    const aud = function (l) {
      return '<span class="lt-aud lt-' + (l.audience || 'any') + '">' + (AUD[l.audience] || '') + '</span>';
    };
    const parts = [];

    /* ① 还原报告 —— 本次的重点，放最上面 */
    if (r.restore) {
      parts.push(restoreHtml(r.restore));
    } else {
      parts.push('<div class="result-box"><h4>🔍 识别结果：' + E(look.name) + ' ' + aud(look) + '</h4>' +
        '<p class="sub">' + E(look.tagline) + '</p></div>');
    }

    /* ② 专属跟练步骤 */
    parts.push(stepsHtml(r.steps));

    /* ③ 全网找同款 */
    parts.push(searchHtml(r));

    /* ④ 参考：最接近的现成妆容 */
    const sceneNames = (look.scene || []).map(function (s) {
      const sc = (D.scenes || []).find(function (x) { return x.id === s; });
      return sc ? sc.icon + sc.name : s;
    });
    parts.push('<div class="result-box ref-box">' +
      '<h4>📚 参考：最接近的现成妆容</h4>' +
      '<p class="hint" style="margin-top:0">还原报告是照你这张图写的；下面这款是站内已有的、最接近的成套教学，' +
        '想按现成流程学就用它。</p>' +
      '<p class="ref-name">' + E(look.name) + ' ' + aud(look) + '</p>' +
      '<p class="sub">' + E(look.tagline) + '（' + (isApi ? 'AI 视觉识别' : '本地配色分析演示模式') + '）</p>' +
      (sceneNames.length ? '<p class="sub" style="margin-top:-4px">适合场合：' + E(sceneNames.join(' · ')) + '</p>' : '') +
      '<div class="meter"><i style="width:' + Math.round(r.confidence * 100) + '%"></i></div>' +
      '<p class="confidence">相似度 ' + Math.round(r.confidence * 100) + '%</p>' +
      '<div class="tag-row">' + look.palette.map(function (c) {
        return '<span class="tag-chip" style="background:' + c + '22;border:1px solid ' + c + ';color:' + c + '">' + c + '</span>';
      }).join('') + '</div></div>');

    /* 花费 / 缓存 */
    if (r.usage) {
      const u = r.usage;
      parts.push('<p class="hint">💰 本次消耗 ' + (u.total_tokens != null ? u.total_tokens : '?') + ' tokens' +
        (u.prompt_tokens != null ? '（输入 ' + u.prompt_tokens + ' / 输出 ' + (u.completion_tokens || 0) + '）' : '') +
        (r.sentBytes ? ' · 上传图片约 ' + Math.round(r.sentBytes / 1024) + ' KB' : '') + '</p>');
    } else if (r.cached) {
      parts.push('<p class="hint">⚡ 来自本地缓存，本次未调用接口（花费 0）</p>');
    }

    /* AI 模式却没拿到还原结果 —— 说明模型没按要求返回 JSON，必须说清楚 */
    if (isApi && !r.restore) {
      parts.push('<div class="result-box"><h4>⚠️ 这次没能拿到逐处还原</h4>' +
        '<p>模型这次没有按要求的 JSON 格式返回（最常见的原因是被输出长度截断了）。可以：</p>' +
        '<ul class="clean">' +
          '<li>点「清除」重新传一次图再识别（同一张图会命中缓存，直接重试拿到的还是旧结果）</li>' +
          '<li>到「设置 → AI 识别」把<b>最大输出长度</b>调大（建议 3500 以上）</li>' +
        '</ul>' +
        '<p class="hint">下面仍然给出了站内最接近的现成妆容，可以先用着。</p></div>');
    }
    if (r.partial) {
      parts.push('<p class="hint">✂️ 这次模型输出被长度限制<b>截断了</b>，上面的还原是从半截 JSON 里抢救出来的，' +
        '后面几项可能缺失。到「设置 → AI 识别」调大最大输出长度可以拿到完整结果。</p>');
    }

    /* 候选排名 */
    const ranked = r.ranked || null;
    if (ranked && ranked.length > 1) {
      parts.push('<div class="result-box"><h4>📊 配色候选排名</h4>' +
        '<p class="hint" style="margin-top:0">按配色相似度排序，仅供交叉参考。</p>' +
        '<div class="rank-list">' +
          ranked.map(function (x, i) {
            const l2 = D.looks.find(function (y) { return y.id === x.lookId; });
            if (!l2) return '';
            const pct = Math.max(4, Math.min(100, Math.round(x.score)));
            return '<button class="rank-item' + (i === 0 ? ' top' : '') + '" data-rank-look="' + x.lookId + '" type="button">' +
              '<span class="rk-no">' + (i + 1) + '</span>' +
              '<span class="rk-name">' + E(l2.name) +
                '<i class="lt-aud lt-' + (l2.audience || 'any') + '">' +
                (AUD[l2.audience] || '').replace(/^[♀♂⚥]\s*/, '') + '</i></span>' +
              '<span class="rk-bar"><i style="width:' + pct + '%"></i></span>' +
              '<span class="rk-score">' + pct + '</span></button>';
          }).join('') +
        '</div></div>');
    }

    if (r.apiText) {
      parts.push('<div class="result-box"><details class="ai-raw"><summary>🤖 查看 AI 原始回复</summary>' +
        '<p style="white-space:pre-wrap">' + E(r.apiText) + '</p></details></div>');
    }
    if (r.needCode) {
      parts.push('<div class="result-box"><h4>ℹ️ 当前使用本地配色分析</h4>' +
        '<p>本站 AI 识别已开启访问口令保护。若你持有口令，可在「设置 → 访问口令」中填写后重试，' +
        '就能拿到逐处还原的结果。</p></div>');
    }
    if (r.error) {
      parts.push('<div class="result-box"><h4>⚠️ AI 识别失败，已回退为本地配色分析</h4>' +
        '<p>' + E(r.error) + '</p></div>');
    }

    parts.push('<div class="apply-box">' +
      '<button class="btn primary" id="btn-go-look" type="button">🎨 去学习「' + E(look.name) + '」的完整教学 →</button>' +
      '</div>');

    box.innerHTML = parts.join('');

    /* ---- 事件绑定 ---- */
    const goBtn = $('#btn-go-look');
    if (goBtn) goBtn.addEventListener('click', function () { selectLook(look.id); });

    box.querySelectorAll('[data-rank-look]').forEach(function (b) {
      b.addEventListener('click', function () {
        selectLook(b.dataset.rankLook);
        go('teach');
        toast('已切换到「' + (D.looks.find(function (y) { return y.id === b.dataset.rankLook; }) || {}).name + '」', { type: 'ok' });
      });
    });

    /* 搜索：选词 + 抓取 */
    const chips = box.querySelectorAll('.srch-chip');
    const doBtn = $('#btn-do-search');
    const resBox = $('#srch-res');
    let chosen = (r.queries || [])[0] || '';
    chips.forEach(function (c) {
      c.addEventListener('click', function () {
        chips.forEach(function (x) { x.classList.remove('active'); });
        c.classList.add('active');
        chosen = c.dataset.q;
        if (resBox) resBox.innerHTML = '';
      });
    });
    if (doBtn) {
      doBtn.addEventListener('click', function () {
        const all = (r.queries || []).slice(0, 3);
        const qs = chosen ? [chosen].concat(all.filter(function (x) { return x !== chosen; })) : all;
        runSearch(qs, resBox, doBtn);
      });
    }
  }

  /* ============ 肤质分析 ============ */
  function renderQuiz() {
    const form = $('#quiz-form');
    form.innerHTML = '';
    D.quiz.forEach(function (q) {
      const block = el('div', 'q-block');
      block.innerHTML = '<p class="q-title">' + q.title + (q.multi ? '<small>（可多选）</small>' : '') + '</p>' +
        (q.hint ? '<p class="q-hint">' + escapeHtml(q.hint) + '</p>' : '');
      const row = el('div', 'option-row');
      q.options.forEach(function (opt) {
        const chip = el('label', 'chip');
        chip.innerHTML = '<input type="' + (q.multi ? 'checkbox' : 'radio') + '" name="q-' + q.id + '" value="' + opt.value + '">' + opt.label;
        const input = chip.querySelector('input');
        input.addEventListener('change', function () {
          if (!q.multi) {
            row.querySelectorAll('.chip').forEach(function (c) { c.classList.remove('active'); });
            chip.classList.add('active');
          } else {
            chip.classList.toggle('active', input.checked);
          }
        });
        row.appendChild(chip);
      });
      block.appendChild(row);
      form.appendChild(block);
    });
  }

  function collectAnswers() {
    const answers = {};
    D.quiz.forEach(function (q) {
      const checked = $$('input[name="q-' + q.id + '"]:checked');
      if (q.multi) answers[q.id] = checked.map(function (c) { return c.value; });
      else answers[q.id] = checked.length ? checked[0].value : '';
    });
    return answers;
  }

  async function handleFaceFile(file) {
    if (!file.type || file.type.indexOf('image/') !== 0) { alert('请上传图片文件'); return; }
    state.faceFile = file;
    const dataURL = await V.fileToDataURL(file);
    const img = $('#face-img');
    img.src = dataURL;
    $('#face-preview').classList.remove('hidden');
    $('#analysis-result').classList.add('hidden');
    $('#analysis-status').classList.add('hidden');
  }

  async function runAnalysis() {
    const answers = collectAnswers();
    const missing = D.quiz.filter(function (q) {
      return q.multi ? (answers[q.id] || []).length === 0 : !answers[q.id];
    });
    if (missing.length) { alert('请先回答：' + missing.map(function (q) { return q.title; }).join('；')); return; }
    if (!state.faceFile) { alert('请先上传脸部照片'); return; }

    const status = $('#analysis-status');
    status.classList.remove('hidden');
    status.textContent = '正在分析皮肤状态…（未配置 API 时使用本地规则分析）';
    const btn = $('#btn-analyze');
    btn.disabled = true;

    try {
      const cfg = V.loadConfig();
      const img = $('#face-img');
      if (!img.complete || !img.naturalWidth) { await new Promise(function (r) { img.onload = r; }); }
      const result = await V.analyzeSkin(img, answers, cfg);
      // 选了「不确定」时，用照片推断出的肤质补齐，供报告 / 推荐 / 存档统一使用
      const norm = Object.assign({}, answers);
      if (result.demo && result.demo.skinTypeId) norm.skinType = result.demo.skinTypeId;
      renderAnalysisResult(result, norm);
      // 把问卷结论存进当前账号的肤质档案，下次自动带出
      if (result.demo) {
        S.saveSkinProfile({
          answers: norm,
          skinTypeTitle: result.demo.skinType.title,
          base: result.demo.skinType.base,
          after: result.demo.skinType.after,
          concerns: result.demo.concerns,
          analysis: result.analysis || null      // 照片分析结果，供妆容推荐使用
        });
        renderSkinProfile();
        renderRecommend();                        // 顺手给出适合的妆容
        toast('分析完成，已存入肤质档案并生成妆容推荐', { type: 'ok' });
      } else {
        toast('分析完成', { type: 'ok' });
      }
    } catch (e) {
      status.textContent = '分析出错：' + e.message;
      toast('分析失败：' + e.message, { type: 'err', duration: 5000 });
    } finally {
      btn.disabled = false;
      status.classList.add('hidden');
    }
  }

  /* ============ 肤质自测方法 ============ */
  const SKIN_TYPE_NAME = { oily: '油性', dry: '干性', combo: '混合', normal: '中性', sensitive: '敏感' };
  const TIER_LABEL = { cheap: '超平价', value: '平价', mid: '中端', premium: '高端' };

  function renderSkinGuide() {
    const body = $('#skin-guide-body');
    const card = $('#skin-guide-card');
    if (!body || !card) return;
    const g = D.skinTypeGuide;
    if (!g) { card.classList.add('hidden'); return; }

    body.innerHTML =
      '<p class="guide-intro">' + escapeHtml(g.intro) + '</p>' +
      '<p class="guide-warn">💡 ' + escapeHtml(g.warn) + '</p>' +
      '<div class="guide-methods">' +
        g.methods.map(function (m) {
          return '<div class="guide-method">' +
            '<div class="gm-head">' +
              '<span class="gm-icon">' + m.icon + '</span>' +
              '<b>' + escapeHtml(m.name) + '</b>' +
              '<span class="gm-badge">' + escapeHtml(m.level) + '</span>' +
              '<span class="gm-time">' + escapeHtml(m.time) + '</span>' +
            '</div>' +
            '<ol class="gm-steps">' +
              m.steps.map(function (s) { return '<li>' + escapeHtml(s) + '</li>'; }).join('') +
            '</ol>' +
            '<div class="gm-results">' +
              m.results.map(function (r) {
                return '<div class="gm-result">' +
                  '<span class="gm-tag' + (r.value ? ' gm-' + r.value : '') + '">' +
                    escapeHtml(r.value ? (SKIN_TYPE_NAME[r.value] || r.value) : '观察') + '</span>' +
                  '<span class="gm-text">' + escapeHtml(r.text) + '</span>' +
                '</div>';
              }).join('') +
            '</div>' +
            (m.extra ? '<p class="gm-extra">⚠️ ' + escapeHtml(m.extra) + '</p>' : '') +
          '</div>';
        }).join('') +
      '</div>' +
      '<p class="guide-note">📌 ' + escapeHtml(g.note) + '</p>';
  }

  /* ============ 产品推荐（按肤质筛选 + 购买链接） ============ */
  function productLinks(name) {
    const k = encodeURIComponent(name);
    return SHOP_PLATFORMS.map(function (p) {
      return '<a href="' + p.url(k) + '" target="_blank" rel="noopener" title="在' + p.name +
        '搜索「' + escapeHtml(name) + '」' + (p.app ? '（App 内体验更好）' : '') + '">' + p.name + '</a>';
    }).join('');
  }

  /* 价格数字（用于排序） */
  function priceNum(it) {
    const m = String(it.price || '').match(/¥\s*(\d+)/);
    return m ? parseInt(m[1], 10) : 0;
  }

  /* 按预算档位筛选，带保底：筛空了就不过滤，避免整块消失 */
  function tierFilter(list) {
    const tierPref = currentPrefs().tier || '';
    if (!tierPref) return { list: list, filtered: false };
    const t = list.filter(function (i) { return i.tier === tierPref; });
    return t.length ? { list: t, filtered: true } : { list: list, filtered: false };
  }

  /* 产品是否适合某个肤质（没写 suits 或写了 all 就是通用） */
  function fitsSkin(it, skinType) {
    if (!it.suits || it.suits.indexOf('all') >= 0) return true;
    if (!skinType) return true;                 // 没有档案时不做筛除
    return it.suits.indexOf(skinType) >= 0;
  }

  /* 单个产品卡片（内联和详情页共用） */
  function productCardHtml(it, opts) {
    const o = opts || {};
    const showShop = prefOn('showShop');
    const tierPref = currentPrefs().tier || '';
    const skinType = currentSkinType();
    const unfit = skinType && !fitsSkin(it, skinType);
    const sc = scoreOf(it);
    return '<div class="sp-item' + (unfit ? ' sp-unfit-item' : '') + '">' +
      '<div class="sp-top">' +
        (o.rank ? '<span class="sp-rank">' + escapeHtml(o.rank) + '</span>' : '') +
        '<b class="sp-name">' + escapeHtml(it.name) + '</b>' +
        '<span class="sp-tier sp-' + it.tier + '">' + (TIER_LABEL[it.tier] || '') + '</span>' +
        '<span class="sp-score" title="综合评分：档位 40% + 口碑排序 22% + 优缺点 14% + 性价比 12% + 安全性 10%">' +
          '综合 <b>' + sc + '</b></span>' +
        (tierPref && it.tier === tierPref ? '<span class="sp-match">✓ 符合你的档位</span>' : '') +
        (unfit ? '<span class="sp-unfit-tag">不太适合你的肤质</span>' : '') +
        (it.risk ? '<span class="sp-risk-tag">⚠️ 需评估风险</span>' : '') +
      '</div>' +
      '<div class="sp-price">' + escapeHtml(it.price) + '</div>' +
      '<p class="sp-why">' + escapeHtml(it.why) + '</p>' +
      '<div class="sp-pc">' +
        '<span class="sp-pros">👍 ' + it.pros.map(escapeHtml).join(' · ') + '</span>' +
        '<span class="sp-cons">👎 ' + it.cons.map(escapeHtml).join(' · ') + '</span>' +
      '</div>' +
      (it.riskNote ? '<div class="sp-risk">⚠️ ' + escapeHtml(it.riskNote) + '</div>' : '') +
      (showShop
        ? '<div class="sp-links"><span class="sp-links-label">搜同款</span>' + productLinks(it.name) + '</div>'
        : '') +
    '</div>';
  }

  /* 内联版：每个品类只显示「首选」一款 + 跳转查看全部 */
  function renderProductGroups(cats, items, match) {
    const box = el('div', 'skin-products');

    cats.forEach(function (cat) {
      const all = items.filter(function (i) {
        return i.cat === cat.id && match(i);
      });
      if (!all.length) return;

      const tf = tierFilter(all);
      const top = tf.list[0];

      const group = el('div', 'sp-group');
      group.innerHTML =
        '<div class="sp-head">' +
          '<span class="sp-icon">' + cat.icon + '</span>' +
          '<b>' + escapeHtml(cat.name) + '</b>' +
          '<small>' + escapeHtml(cat.why || '') + '</small>' +
          '<span class="sp-count">共 ' + all.length + ' 款</span>' +
        '</div>' +
        '<div class="sp-list">' + productCardHtml(top, { rank: '首选' }) + '</div>' +
        '<div class="sp-more">' +
          '<button class="btn ghost sp-more-btn" data-cat="' + cat.id + '" type="button">' +
            '查看「' + escapeHtml(cat.name) + '」全部 ' + all.length + ' 款 →' +
          '</button>' +
          (tf.filtered ? '<span class="sp-more-note">已优先显示你预算档位内的选择</span>' : '') +
        '</div>';
      box.appendChild(group);
    });

    box.querySelectorAll('[data-cat]').forEach(function (b) {
      b.addEventListener('click', function () { go('shop', b.dataset.cat); });
    });
    return box;
  }

  /* ============ 总预算搭配（每个品类挑一款，总价不超预算的背包问题） ============ */
  /* 档位 → 基础分（0~1）。刻度要做成明显「凸」的：
   * 每升一档的收益递增，算法才会在预算充足时把重点品类推到高端，
   * 而不是把钱摊成十几个中端小升级。 */
  const TIER_Q = { cheap: 0.02, value: 0.10, mid: 0.35, premium: 1.0 };

  /* ============ 综合品质分（0~1） ============
   * 不只看档位，而是把五项合起来看「总体」：
   *   ① 档位        —— 40%
   *   ② 口碑排序    —— 22%（该品类内，作者按口碑从好到差排的）
   *   ③ 优缺点比    —— 14%（优点多、缺点少说明表现更均衡）
   *   ④ 同档性价比  —— 12%（同样档位里更便宜的分更高）
   *   ⑤ 安全性      —— 10%（低价白牌扣分）
   * 再叠加与用户肤质的契合度。
   */
  function qualityOf(it, list, skinType) {
    const tier = TIER_Q[it.tier] !== undefined ? TIER_Q[it.tier] : 0.3;

    const idx = list.indexOf(it);
    const rank = list.length > 1 ? (list.length - 1 - idx) / (list.length - 1) : 1;

    const np = (it.pros || []).length, nc = (it.cons || []).length;
    const pc = (np + nc) ? np / (np + nc) : 0.5;

    const sameTier = list.filter(function (x) { return x.tier === it.tier; });
    let value = 0.5;
    if (sameTier.length > 1) {
      const ps = sameTier.map(priceNum);
      const lo = Math.min.apply(null, ps), hi = Math.max.apply(null, ps);
      value = hi > lo ? (hi - priceNum(it)) / (hi - lo) : 1;
    }

    const safe = it.risk ? 0 : 1;

    let q = 0.40 * tier + 0.22 * rank + 0.14 * pc + 0.12 * value + 0.10 * safe;
    if (skinType) q += fitsSkin(it, skinType) ? 0.06 : -0.12;
    return Math.max(0, Math.min(1, q));
  }

  /* 预算搭配用的评分 = 综合品质 × 品类权重（钱优先花在重要品类上） */
  function productScore(it, list, skinType) {
    const cw = CAT_WEIGHT[it.cat] || 1;
    return cw * qualityOf(it, list, skinType);
  }

  /* 拿到一个产品的综合分（0~100），供界面显示 */
  function scoreOf(it) {
    const all = (D.makeupProducts ? D.makeupProducts.items : [])
      .concat(D.skinProducts ? D.skinProducts.items : []);
    const list = all.filter(function (x) { return x.cat === it.cat; });
    return Math.round(qualityOf(it, list, currentSkinType()) * 100);
  }

  /* 品类权重：决定「这个品类值不值得多花钱」。
   * 没有它的话，算法会把预算砸在最容易买到高端货的品类上
   * （比如花 150 买一块海绵，却用 25 块的粉底）。 */
  const CAT_WEIGHT = {
    foundation: 3.2, cushion: 3.2,        // 底妆最影响妆效
    lip: 2.6, brow: 2.5,                  // 口红和眉毛最影响气色
    concealer: 2.3, powder: 2.2,
    primer: 2.0, sunscreen: 2.4,
    eyeshadow: 1.8, blush: 1.6,
    cleanser: 2.0, moist: 2.0, serum: 1.8, remover: 1.8,
    eyeliner: 1.3, mascara: 1.3, setting: 1.2, toner: 1.3,
    browgel: 1.0, eyeprimer: 1.0, lipbase: 1.0,
    contour: 0.9, mask: 0.9,
    brush: 0.8, tool: 0.8, lashes: 0.7, touchup: 0.7
  };

  /* 在总预算内找一套。
   * 三阶段：
   *   ① 全套能装下 → 在预算内挑尽量好的；
   *   ② 全套装不下 → 按品类重要性逐件砍，先凑出「现在买得起的那几件」，
   *      并告知还差哪些、补齐全套还要多少；
   *   ③ 连一件都买不起且低于最低预算 → 交给界面提示做不到。
   * 说明：只有「预算 + 容差」都装不下时才会进入第 ② 步；且第 ② 步一律优先最省。
   */
  function solveBudgetSet(catIds, budget, tolerance, skinType) {
    const all = (D.makeupProducts ? D.makeupProducts.items : [])
      .concat(D.skinProducts ? D.skinProducts.items : []);

    const groups = [];
    catIds.forEach(function (cid) {
      const list = all.filter(function (i) { return i.cat === cid; });
      if (list.length) groups.push({ id: cid, list: list });
    });
    if (!groups.length) return { error: '没有可用的产品数据' };

    const cheapest = function (g) { return Math.min.apply(null, g.list.map(priceNum)); };
    const sumCheapest = function (gs) {
      return gs.reduce(function (a, g) { return a + cheapest(g); }, 0);
    };

    /* 按重要性排序：没在 priority 里的排最后，保持原顺序 */
    const pri = (D.makeupSet && D.makeupSet.priority) || [];
    const ordered = groups.slice().sort(function (a, b) {
      const ia = pri.indexOf(a.id), ib = pri.indexOf(b.id);
      return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib);
    });

    const minTotal = sumCheapest(ordered);

    /* 给定上限求解：DP 层数 = 品类数，状态 = 已花金额 */
    const solveCap = function (gs, cap) {
      let dp = new Map();
      dp.set(0, { score: 0, item: null, from: null });
      const layers = [dp];

      gs.forEach(function (g) {
        const next = new Map();
        g.list.forEach(function (it) {
          const p = priceNum(it);
          const q = productScore(it, g.list, skinType);
          dp.forEach(function (st, spent) {
            const ns = spent + p;
            if (ns > cap) return;
            const sc = st.score + q;
            const cur = next.get(ns);
            if (cur && cur.score >= sc) return;
            next.set(ns, { score: sc, item: it, from: spent });
          });
        });
        layers.push(next);
        dp = next;
      });

      const rebuild = function (spent) {
        const picks = [];
        let s = spent;
        for (let i = gs.length; i >= 1; i--) {
          const node = layers[i].get(s);
          if (!node || !node.item) return null;
          picks.unshift(node.item);
          s = node.from;
        }
        return picks.length === gs.length ? picks : null;
      };

      const out = [];
      dp.forEach(function (st, spent) {
        const picks = rebuild(spent);
        if (picks) out.push({ score: st.score, spent: spent, picks: picks });
      });
      return out;
    };

    const dedupe = function (sols, minSpendFirst) {
      sols.sort(minSpendFirst
        ? function (a, b) { return (a.spent - b.spent) || (b.score - a.score); }
        : function (a, b) { return (b.score - a.score) || (a.spent - b.spent); });
      const list = [], seen = {};
      for (let i = 0; i < sols.length && list.length < 6; i++) {
        const key = sols[i].picks.map(function (x) { return x.name; }).join('|');
        if (seen[key]) continue;
        seen[key] = 1;
        list.push(sols[i]);
      }
      return list;
    };

    /* ① 全套能在「预算内」配齐 → 在预算内挑尽量好的 */
    let dropped = [], relaxed = false;
    let sols = solveCap(ordered, budget);
    if (sols.length) {
      return {
        solutions: dedupe(sols, false),
        minTotal: minTotal, cap: budget, relaxed: false, budget: budget,
        reduced: false, dropped: [], usedCount: ordered.length, fullCount: ordered.length
      };
    }

    /* ② 全套配不齐 → 在「严格预算内」尽可能多买几个品类（数量优先）。
     *    先把一件底妆保底放进去 —— 没有底妆的套装没法用。 */
    const baseIdx = ordered.findIndex(function (g) {
      return g.id === 'foundation' || g.id === 'cushion';
    });
    let baseItem = null, restGroups = ordered;
    if (baseIdx >= 0) {
      const g = ordered[baseIdx];
      const affordable = g.list
        .filter(function (it) { return priceNum(it) <= budget; })
        .sort(function (a, b) { return priceNum(a) - priceNum(b); });
      if (affordable.length) {
        baseItem = affordable[0];               // 选最便宜的，把预算留给更多品类
        restGroups = ordered.filter(function (x, i) { return i !== baseIdx; });
      }
    }
    const baseCost = baseItem ? priceNum(baseItem) : 0;

    /* 数量优先 DP：每个品类要么不买，要么买其中一件 */
    const pickMaxCount = function (gs, cap) {
      let dp = new Map();
      dp.set(0, { count: 0, score: 0, picks: [] });
      gs.forEach(function (g) {
        const next = new Map(dp);              // 继承「这个品类不买」
        g.list.forEach(function (it) {
          const p = priceNum(it);
          if (p > cap) return;
          const q = productScore(it, g.list, skinType);
          dp.forEach(function (st, spent) {
            const ns = spent + p;
            if (ns > cap) return;
            const count = st.count + 1;
            const score = st.score + q;
            const cur = next.get(ns);
            if (cur && (cur.count > count || (cur.count === count && cur.score >= score))) return;
            next.set(ns, { count: count, score: score, picks: st.picks.concat(it) });
          });
        });
        dp = next;
      });
      let best = null;
      dp.forEach(function (st) {
        if (!best || st.count > best.count || (st.count === best.count && st.score > best.score)) best = st;
      });
      return best;
    };

    const got = pickMaxCount(restGroups, Math.max(0, budget - baseCost));
    let picks = (got ? got.picks : []).slice();
    if (baseItem) picks.unshift(baseItem);

    if (picks.length) {
      const spent = picks.reduce(function (a, it) { return a + priceNum(it); }, 0);
      dropped = ordered.filter(function (g) {
        return !picks.some(function (it) { return it.cat === g.id; });
      });
      return {
        solutions: [{ score: 0, spent: spent, picks: picks }],
        minTotal: minTotal, cap: budget, relaxed: false, budget: budget,
        reduced: true, countFirst: true,
        dropped: dropped.map(function (g) { return { cat: g.id, min: cheapest(g) }; }),
        restCost: sumCheapest(dropped),
        usedCount: picks.length, fullCount: ordered.length
      };
    }

    /* ③ 严格预算内连一件都买不起 → 才动用容差，至少给一件 */
    const flat = [];
    ordered.forEach(function (g) {
      g.list.forEach(function (it) { flat.push({ it: it }); });
    });
    flat.sort(function (a, b) { return priceNum(a.it) - priceNum(b.it); });
    const only = flat[0];
    if (only && priceNum(only.it) <= budget + tolerance) {
      return {
        solutions: [{ score: 0, spent: priceNum(only.it), picks: [only.it] }],
        minTotal: minTotal, cap: budget + tolerance, relaxed: true, budget: budget,
        reduced: true, countFirst: true,
        dropped: ordered.filter(function (g) { return g.id !== only.it.cat; })
          .map(function (g) { return { cat: g.id, min: cheapest(g) }; }),
        restCost: 0, usedCount: 1, fullCount: ordered.length
      };
    }

    return { impossible: true, minTotal: minTotal, cap: budget + tolerance,
             fullCount: ordered.length };
  }

  let budgetPick = 0;                             // 「换一套」当前显示第几套

  function currentBudgetPreset() {
    const list = (D.makeupSet && D.makeupSet.presets) || [];
    const id = currentPrefs().budgetPreset || 'makeup';
    return list.find(function (p) { return p.id === id; }) || list[0] || null;
  }

  /* ============ 总预算搭配卡片 ============ */
  function renderBudgetCard() {
    const card = $('#budget-card');
    if (!card) return;
    const preset = currentBudgetPreset();
    if (!preset) { card.classList.add('hidden'); return; }
    card.classList.remove('hidden');

    const prefs = currentPrefs();
    const budget = Number(prefs.budgetTotal) || 0;
    const tol = (D.makeupSet && D.makeupSet.tolerance) || 50;

    /* ---- 还没设预算 → 就地输入 ---- */
    if (!budget) {
      card.innerHTML =
        '<div class="card-title"><h3>🎯 总预算搭配</h3>' +
          '<span class="hint">输入总金额，自动从每个品类挑一款凑成一套</span></div>' +
        '<div class="budget-form">' +
          '<label class="field"><span>总预算（元）</span>' +
            '<input type="number" id="budget-total" class="input" min="100" step="50" placeholder="例如 1000" /></label>' +
          '<label class="field"><span>套餐范围</span>' +
            '<select id="budget-preset" class="input">' +
              D.makeupSet.presets.map(function (p) {
                return '<option value="' + p.id + '"' + (p.id === preset.id ? ' selected' : '') + '>' +
                  escapeHtml(p.name) + '（' + p.cats.length + ' 个品类）</option>';
              }).join('') +
            '</select></label>' +
          '<button class="btn primary" id="btn-budget-go" type="button">生成方案 →</button>' +
        '</div>' +
        '<p class="hint">' + escapeHtml(preset.note) +
          ' 允许超出 <b>' + tol + ' 元</b>以内。</p>';

      $('#btn-budget-go').addEventListener('click', function () {
        const v = Number(($('#budget-total').value || '').trim());
        if (!v || v < 100) { toast('请输入一个不小于 100 的金额', { type: 'warn' }); return; }
        S.setPrefs({ budgetTotal: v, budgetPreset: $('#budget-preset').value, tier: 'total' });
        budgetPick = 0;
        renderBudgetCard();
        renderPersonalize();
        toast('已按 ¥' + v + ' 总预算搭配');
      });
      return;
    }

    /* ---- 已设预算 → 求解并展示 ---- */
    const skinType = currentSkinType();

    /* 低于最低预算：直接告诉用户做不到 */
    const minB = (D.makeupSet && D.makeupSet.minBudget) || 100;
    if (budget < minB) {
      card.innerHTML =
        '<div class="card-title"><h3>🎯 总预算搭配</h3>' +
          '<button class="btn ghost" id="btn-budget-reset" type="button">重新设置</button></div>' +
        '<div class="warn-box"><h5>⚠️ ¥' + budget + ' 做不到</h5>' +
          '<p>这个金额低于最低预算 <b>¥' + minB + '</b>，连一件正经的底妆或口红都买不到，' +
          '凑不出能用的方案。</p>' +
          '<p>建议：预算至少给到 <b>¥' + minB + '</b> 以上；' +
          '如果预算确实只有几十块，可以先买一支<b>眉笔或口红</b>练手，不必凑套装。</p></div>' +
        '<div class="budget-form">' +
          '<label class="field"><span>调整总预算（元）</span>' +
            '<input type="number" id="budget-total" class="input" min="' + minB + '" step="50" value="' + budget + '" /></label>' +
          '<button class="btn primary" id="btn-budget-go" type="button">重新生成</button>' +
        '</div>';
      bindBudgetReset();
      $('#btn-budget-go').addEventListener('click', function () {
        const v = Number(($('#budget-total').value || '').trim());
        if (!v || v < minB) { toast('请输入一个不小于 ¥' + minB + ' 的金额', { type: 'warn' }); return; }
        S.setPrefs({ budgetTotal: v, tier: 'total' });
        budgetPick = 0;
        renderBudgetCard();
        renderPersonalize();
      });
      return;
    }

    const res = solveBudgetSet(preset.cats, budget, tol, skinType);

    if (res.impossible) {
      card.innerHTML =
        '<div class="card-title"><h3>🎯 总预算搭配</h3>' +
          '<button class="btn ghost" id="btn-budget-reset" type="button">重新设置</button></div>' +
        '<div class="warn-box"><h5>⚠️ 这个预算凑不出一套</h5>' +
          '<p>「' + escapeHtml(preset.name) + '」共 ' + preset.cats.length + ' 个品类，' +
          '按最便宜的选也要 <b>¥' + res.minTotal + '</b>（含允许超出的 ' + tol + ' 元，上限 ¥' + res.cap + '）。</p>' +
          '<p>建议：把预算提到 <b>¥' + res.minTotal + '</b> 以上，或把套餐换成品类更少的「彩妆全套」。</p></div>' +
        '<div class="budget-form">' +
          '<label class="field"><span>调整总预算（元）</span>' +
            '<input type="number" id="budget-total" class="input" min="100" step="50" value="' + budget + '" /></label>' +
          '<button class="btn primary" id="btn-budget-go" type="button">重新生成</button>' +
        '</div>';
      bindBudgetReset();
      $('#btn-budget-go').addEventListener('click', function () {
        const v = Number(($('#budget-total').value || '').trim());
        if (!v || v < 100) { toast('请输入一个不小于 100 的金额', { type: 'warn' }); return; }
        S.setPrefs({ budgetTotal: v });
        budgetPick = 0;
        renderBudgetCard();
        renderPersonalize();
      });
      return;
    }

    const sols = res.solutions;
    if (budgetPick >= sols.length) budgetPick = 0;
    const sol = sols[budgetPick];
    const over = sol.spent - budget;

    card.innerHTML =
      '<div class="card-title"><h3>🎯 ¥' + budget + ' 总预算搭配</h3>' +
        '<button class="btn ghost" id="btn-budget-reset" type="button">重新设置</button></div>' +
      '<div class="budget-sum">' +
        '<div class="bs-main">' +
          '<span class="bs-total">¥' + sol.spent + '</span>' +
          '<span class="bs-of"> / 预算 ¥' + budget + '</span>' +
        '</div>' +
        '<div class="bs-sub">' +
          (res.reduced ? '起步套装 · ' : escapeHtml(preset.name) + ' · ') + sol.picks.length + ' 件 · ' +
          (res.relaxed
            ? '<span class="bs-over">预算装不下完整一套，这是最省的一套（超 ¥' + over + '，在允许的 ' + tol + ' 元内）</span>'
            : (over > 0
                ? '<span class="bs-over">超出 ¥' + over + '（允许 ' + tol + ' 元内）</span>'
                : '<span class="bs-save">还剩 ¥' + (-over) + '</span>')) +
        '</div>' +
        (sols.length > 1
          ? '<button class="btn ghost" id="btn-budget-again" type="button">换一套（' + (budgetPick + 1) + '/' + sols.length + '）</button>'
          : '') +
      '</div>' +

      /* 预算不足：说明这是一份「先买这些」的起步清单 */
      (res.reduced
        ? '<div class="warn-box"><h5>📌 预算暂时买不齐全套（' + res.usedCount + ' / ' + res.fullCount + ' 件）</h5>' +
            '<p>已经按<b>重要性</b>把最不能省的几件挑出来了 —— 有这些就能开始画。</p>' +
            '<p>把剩下的 <b>' + res.dropped.length + '</b> 件补齐，还需要约 <b>¥' + res.restCost + '</b>，' +
            '也就是说全套大约 <b>¥' + (sol.spent + res.restCost) + '</b> 起。</p></div>'
        : '') +

      '<div class="budget-list">' +
        sol.picks.map(function (it) {
          const cat = ((D.makeupProducts || {}).categories || [])
            .concat((D.skinProducts || {}).categories || [])
            .find(function (c) { return c.id === it.cat; }) || { icon: '•', name: it.cat };
          return '<div class="bl-item' + (it.risk ? ' bl-risk' : '') + '">' +
            '<span class="bl-cat"><b>' + cat.icon + '</b> ' + escapeHtml(cat.name) + '</span>' +
            '<span class="bl-name">' + escapeHtml(it.name) + '</span>' +
            '<span class="bl-tier sp-' + it.tier + '">' + (TIER_LABEL[it.tier] || '') + '</span>' +
            '<span class="bl-score">综合 ' + scoreOf(it) + '</span>' +
            (it.risk ? '<span class="sp-risk-tag">⚠️</span>' : '') +
            '<span class="bl-price">¥' + priceNum(it) + '</span>' +
            (prefOn('showShop')
              ? '<span class="bl-links">' + productLinks(it.name) + '</span>'
              : '') +
          '</div>';
        }).join('') +
      '</div>' +

      /* 含低价白牌时给出安全提示 */
      ((function () {
        const risky = sol.picks.filter(function (it) { return it.risk; });
        if (!risky.length) return '';
        return '<div class="safety-box">' +
          '<h5>⚠️ 这套里有 ' + risky.length + ' 件是低价白牌，请先看这段</h5>' +
          '<p>低价商品能让你用同样的钱买到更多品类，但<b>安全上没有保障</b>。这些产品通常：</p>' +
          '<ul class="clean">' +
            '<li>没有完整备案信息，成分表可能缺失或与实物不符</li>' +
            '<li>微生物、重金属（铅、砷）、石棉残留超标的风险更高</li>' +
            '<li>防腐体系较弱，开封后更容易变质</li>' +
          '</ul>' +
          '<p><b>建议这样用：</b></p>' +
          '<ul class="clean">' +
            '<li>优先加钱换成「<b>正规品牌小样 / 旅行装</b>」—— 同样便宜但配方有保障</li>' +
            '<li>上脸前先在<b>耳后或手腕内侧试 24 小时</b>，无红肿刺痛再用</li>' +
            '<li><b>眼周和嘴唇尽量别用白牌</b>：眼线、睫毛膏、口红、润唇这几项风险最高</li>' +
            '<li>一出现刺痛、发痒、起疹、奇效（突然特别白嫩）<b>立刻停用</b></li>' +
          '</ul>' +
          '<p class="safety-note">下面是这套里带风险标记的几件：' +
            risky.map(function (it) { return escapeHtml(it.name.replace('【超平价】', '')); }).join('、') +
          '</p>' +
        '</div>';
      })()) +

      /* 还没买的：按建议顺序列出来，并给出各自最低价 */
      (res.reduced && res.dropped.length
        ? (function () {
            const catOf = function (id) {
              return ((D.makeupProducts || {}).categories || [])
                .concat((D.skinProducts || {}).categories || [])
                .find(function (c) { return c.id === id; }) || { icon: '•', name: id };
            };
            return '<div class="budget-next">' +
              '<h5>🗒️ 还没买的（按建议顺序，预算够了再加）</h5>' +
              '<div class="bn-list">' +
                res.dropped.map(function (d) {
                  const c = catOf(d.cat);
                  return '<span class="bn-item"><b>' + c.icon + '</b> ' + escapeHtml(c.name) +
                    '<i>最低 ¥' + d.min + '</i></span>';
                }).join('') +
              '</div>' +
              '<p class="hint">这些加起来约 ¥' + res.restCost + '。先把当前这几件用熟，比一次买齐更不容易闲置。</p>' +
              '</div>';
          })()
        : '') +

      '<p class="hint">' +
        (skinType ? '已按你的肤质「' + (SKIN_TYPE_NAME[skinType] || '') + '」加权。' : '做过肤质分析后会按你的肤质加权。') +
        '同价位下优先选口碑更好的；单品价格以平台实际为准。</p>';

    bindBudgetReset();
    const again = $('#btn-budget-again');
    if (again) {
      again.addEventListener('click', function () {
        budgetPick = (budgetPick + 1) % sols.length;
        renderBudgetCard();
      });
    }
  }

  function bindBudgetReset() {
    const b = $('#btn-budget-reset');
    if (b) {
      b.addEventListener('click', function () {
        S.setPrefs({ budgetTotal: 0, tier: (currentPrefs().tier === 'total' ? '' : currentPrefs().tier) });
        renderBudgetCard();
        renderPersonalize();
        toast('已清除总预算设置', { type: 'info' });
      });
    }
  }
  /* ============ 产品推荐页（品类目录 + 品类详情） ============ */
  let shopSort = 'pick';                        // pick | priceAsc | priceDesc
  let shopOnlyFit = false;                      // 是否只看适合自己肤质的

  /* 两个产品库合并成一个可检索集合 */
  function productSets() {
    const out = [];
    if (D.makeupProducts && D.makeupProducts.categories) out.push({ key: 'makeup', label: '彩妆', data: D.makeupProducts });
    if (D.skinProducts && D.skinProducts.categories) out.push({ key: 'skin', label: '护肤', data: D.skinProducts });
    return out;
  }

  function findCategory(catId) {
    const sets = productSets();
    for (let i = 0; i < sets.length; i++) {
      const hit = sets[i].data.categories.find(function (x) { return x.id === catId; });
      if (hit) return { cat: hit, set: sets[i] };
    }
    return null;
  }

  function renderShopPage(catId) {
    const catCard = $('#shop-catalog-card');
    const detCard = $('#shop-detail-card');
    if (!catCard || !detCard) return;
    const skinType = currentSkinType();

    renderBudgetCard();                // 顶部「总预算搭配」卡片

    /* ---- 品类目录 ---- */
    const catalog = $('#shop-catalog');
    if (catalog) {
      catalog.innerHTML = '';
      productSets().forEach(function (set) {
        const all = set.data.items;
        const wrap = el('div', 'shop-cat-group');
        wrap.innerHTML = '<h4 class="shop-cat-title">' + set.label + ' · ' + set.data.categories.length + ' 个品类 · ' +
          all.length + ' 款</h4>';
        const grid = el('div', 'shop-cat-grid');
        set.data.categories.forEach(function (c) {
          const items = all.filter(function (i) { return i.cat === c.id; });
          const usable = items.filter(function (i) { return fitsSkin(i, skinType); });
          const b = el('button', 'shop-cat-btn');
          b.type = 'button';
          b.innerHTML =
            '<span class="scb-icon">' + c.icon + '</span>' +
            '<span class="scb-name">' + escapeHtml(c.name) + '</span>' +
            '<span class="scb-count">' +
              (skinType && usable.length < items.length
                ? usable.length + ' / ' + items.length + ' 款适合你'
                : items.length + ' 款') +
            '</span>';
          b.addEventListener('click', function () { go('shop', c.id); });
          grid.appendChild(b);
        });
        wrap.appendChild(grid);
        catalog.appendChild(wrap);
      });
      const hint = $('#shop-cat-hint');
      if (hint) {
        hint.textContent = skinType
          ? '已按你的肤质「' + (SKIN_TYPE_NAME[skinType] || '') + '」标注适合你的款数'
          : '做过肤质分析后，这里会标注每个品类适合你的款数';
      }
    }

    /* ---- 未选品类 → 显示目录 ---- */
    const found = catId ? findCategory(catId) : null;
    if (!found) {
      catCard.classList.remove('hidden');
      detCard.classList.add('hidden');
      $('#shop-title').textContent = '🛍️ 产品推荐';
      $('#shop-sub').textContent = '按品类查看具体产品，含推荐理由、优缺点与各平台购买链接。';
      return;
    }

    /* ---- 品类详情 ---- */
    catCard.classList.add('hidden');
    detCard.classList.remove('hidden');

    const all = found.set.data.items.filter(function (i) { return i.cat === catId; });
    const usable = all.filter(function (i) { return fitsSkin(i, skinType); });

    $('#shop-title').textContent = found.cat.icon + ' ' + found.cat.name;
    $('#shop-sub').textContent = found.set.label + '品类 · 共 ' + all.length + ' 款' +
      (skinType && usable.length < all.length ? ' · 其中 ' + usable.length + ' 款适合你的肤质' : '');
    $('#shop-detail-title').textContent = found.cat.icon + ' ' + found.cat.name;

    /* 工具栏：排序 + 只看适合我的 */
    const tb = $('#shop-toolbar');
    tb.innerHTML =
      '<div class="st-sorts">' +
        '<span class="st-label">排序</span>' +
        [['pick', '推荐顺序'], ['priceAsc', '价格从低到高'], ['priceDesc', '价格从高到低']]
          .map(function (o) {
            return '<button class="aid-chip' + (shopSort === o[0] ? ' active' : '') +
              '" data-sort="' + o[0] + '" type="button">' + o[1] + '</button>';
          }).join('') +
        '<button class="aid-chip' + (shopOnlyFit ? ' active' : '') + '" data-onlyfit="1" type="button">' +
          '只看适合我的' + (skinType ? '' : '（需先做肤质分析）') + '</button>' +
      '</div>';

    /* 列表 */
    const body = $('#shop-detail-body');
    body.innerHTML = '';

    let list = (shopOnlyFit && skinType) ? usable : all;
    if (!list.length) list = all;

    if (shopSort === 'priceAsc') {
      list = list.slice().sort(function (a, b) { return priceNum(a) - priceNum(b); });
    } else if (shopSort === 'priceDesc') {
      list = list.slice().sort(function (a, b) { return priceNum(b) - priceNum(a); });
    } else {
      // 推荐顺序：预算档位内的排前面，其余保持作者排序（已是质量顺序）
      const tierPref = currentPrefs().tier || '';
      if (tierPref) {
        list = list.slice().sort(function (a, b) {
          return (b.tier === tierPref ? 1 : 0) - (a.tier === tierPref ? 1 : 0);
        });
      }
    }

    const wrap = el('div', 'sp-group solo');
    wrap.innerHTML = '<div class="sp-list">' + list.map(function (it, i) {
      return productCardHtml(it, { rank: (shopSort === 'pick' && i === 0) ? '首选' : '' });
    }).join('') + '</div>';
    body.appendChild(wrap);
    body.appendChild(el('p', 'disclaimer', '⚠️ ' + found.set.data.disclaimer));

    /* 事件绑定 */
    tb.querySelectorAll('[data-sort]').forEach(function (b) {
      b.addEventListener('click', function () { shopSort = b.dataset.sort; renderShopPage(catId); });
    });
    const ofb = tb.querySelector('[data-onlyfit]');
    if (ofb) {
      ofb.addEventListener('click', function () {
        if (!skinType) { toast('先做一次「肤质分析」，才能按肤质筛选', { type: 'warn' }); return; }
        shopOnlyFit = !shopOnlyFit;
        renderShopPage(catId);
      });
    }
  }

  /* 护肤品：按肤质筛（保底逻辑，数据里已保证每格 >= 2 款） */
  function skinProductBlock(skinTypeId) {
    const P = D.skinProducts;
    if (!P || !P.categories) return null;
    return renderProductGroups(P.categories, P.items, function (i) {
      return i.suits && i.suits.indexOf(skinTypeId) >= 0;
    });
  }

  /* 当前账号的肤质（用于彩妆筛选），没有档案就返回空 */
  function currentSkinType() {
    const p = S.getSkinProfile();
    const t = p && p.answers && p.answers.skinType;
    return (t && t !== 'unknown') ? t : '';
  }

  /* ============ 教学页：某一步具体买什么（可折叠） ============ */
  // 妆前准备 / 妆后护肤 这两步属于护肤范畴，从护肤品库里并入选定品类
  const SKIN_MERGE = {
    prep: ['cleanser', 'toner', 'serum', 'moist', 'sunscreen'],
    after: ['remover', 'mask']
  };

  function stageProductBox(stageId) {
    const M = D.makeupProducts;
    if (!M || !M.categories) return null;

    const skinType = currentSkinType();
    const matchFn = function (i) {
      if (!i.suits || i.suits.indexOf('all') >= 0) return true;
      if (!skinType) return true;               // 没有肤质档案时不做筛除
      return i.suits.indexOf(skinType) >= 0;
    };

    let cats = M.categories.filter(function (c) { return c.stage === stageId; });
    let items = M.items;

    // 并入护肤品库中的相关品类
    const mergeIds = SKIN_MERGE[stageId];
    if (mergeIds && D.skinProducts) {
      const extra = D.skinProducts.categories.filter(function (c) {
        return mergeIds.indexOf(c.id) >= 0;
      });
      cats = cats.concat(extra);
      items = M.items.concat(D.skinProducts.items);
    }

    const total = cats.reduce(function (n, c) {
      return n + items.filter(function (i) {
        return i.cat === c.id && matchFn(i);
      }).length;
    }, 0);
    if (!total) return null;

    const box = el('details', 'stage-shop');
    box.open = true;                              // 默认展开
    const sum = el('summary', 'ss-summary');
    sum.innerHTML =
      '<span class="ss-icon">🛍</span>' +
      '<span class="ss-text">' +
        '<b>这一步具体买什么</b>' +
        '<small>' + cats.length + ' 个品类 · ' + total + ' 款具体产品' +
          (skinType ? ' · 已按你的肤质「' + escapeHtml(SKIN_TYPE_NAME[skinType] || '') + '」筛选' : '') +
          ' · 每类先给首选，点「查看全部」看其余' +
        '</small>' +
      '</span>' +
      '<span class="ss-arrow">▾</span>';
    box.appendChild(sum);

    const inner = el('div', 'ss-body');
    inner.appendChild(renderProductGroups(cats, items, matchFn));
    inner.appendChild(el('p', 'disclaimer', '⚠️ ' + M.disclaimer));
    box.appendChild(inner);
    return box;
  }

  function renderAnalysisResult(result, answers) {
    const demo = result.demo;
    const box = $('#analysis-result');
    box.classList.remove('hidden');
    box.innerHTML = '';

    const card = function (title, txt) {
      return '<div class="metric"><h5>' + title + '</h5><p>' + txt + '</p></div>';
    };
    const typeName = SKIN_TYPE_NAME;

    const head = el('div', 'result-box');
    head.innerHTML = '<h4>🧪 肤质分析报告</h4><p class="sub">' +
      (result.mode === 'api' ? 'AI 视觉分析（已结合云端判断）' : '本地规则分析（未使用云端 AI）') + '</p>';
    box.appendChild(head);

    if (!demo) { box.appendChild(el('p', 'note', '没有得到有效的分析结果。')); return; }

    /* ---- ① 信息完整性提示 ---- */
    const comp = demo.completeness;
    if (comp && !comp.complete) {
      const w = el('div', 'warn-box');
      w.innerHTML = '<h5>⚠️ 问卷信息不完整，结论会偏笼统</h5>' +
        '<p>你没有回答：<b>' + comp.missing.map(escapeHtml).join('、') + '</b></p>' +
        '<p>缺这些会影响建议的针对性 —— 比如不知道肤色基调，就没法给准确的选色建议；' +
        '不知道肌肤困扰，遮瑕重点就只能是通用建议。建议返回上面补一下再重新生成。</p>' +
        (comp.unsure.length ? '<p class="warn-sub">另外：' + comp.unsure.map(escapeHtml).join('；') + '</p>' : '');
      box.appendChild(w);
    } else if (comp && comp.unsure.length) {
      const w = el('div', 'warn-box info');
      w.innerHTML = '<h5>ℹ️ 有选项你选了「不确定」</h5><p>' +
        comp.unsure.map(escapeHtml).join('；') + '</p>';
      box.appendChild(w);
    }

    /* ---- ② 照片分析 ---- */
    if (demo.infer) {
      const p = el('div', 'result-box');
      p.innerHTML = '<h4>📷 照片分析</h4>' +
        '<p>从照片像素看，你的皮肤倾向是 <b class="hl">' + escapeHtml(typeName[demo.infer.guess] || '') +
        '</b>（把握度：' + escapeHtml(demo.infer.confidence) + '）</p>' +
        '<ul class="clean">' + demo.infer.signals.map(function (s) {
          return '<li>' + escapeHtml(s) + '</li>';
        }).join('') + '</ul>' +
        '<p class="note">' + escapeHtml(demo.infer.caveat) + '</p>';
      box.appendChild(p);
    }

    /* ---- ③ 肤质判断 ---- */
    const st = demo.skinType;
    const judge = el('div', 'result-box');
    judge.innerHTML = '<h4>🩺 肤质判断</h4>' +
      '<div class="skin-type-head">' +
        '<div class="st-title">' + escapeHtml(st.title) + '</div>' +
        (st.alias ? '<div class="st-alias">' + escapeHtml(st.alias) + '</div>' : '') +
        '<div class="st-basis">判断依据：' + (demo.inferred
          ? '你选了<b>「不确定」</b>，这里采用<b>照片推断</b>的结果 —— 建议用页面底部的自测方法核实一次'
          : '<b>你的自述</b>' + (demo.infer ? '（照片观感：' + escapeHtml(typeName[demo.infer.guess] || '') +
              '，把握度 ' + escapeHtml(demo.infer.confidence) + '）' : '')) +
        '</div>' +
      '</div>' +
      '<div class="analysis-grid">' +
        (st.traits ? card('📋 特征描述', escapeHtml(st.traits)) : '') +
        (demo.image && demo.image.length
          ? card('📷 照片补充观察', demo.image.map(escapeHtml).join('<br>')) : '') +
      '</div>';
    box.appendChild(judge);

    /* ---- ④ 日常护理流程 ---- */
    if (st.morning || st.night || st.avoid || st.star) {
      const flow = el('div', 'result-box');
      flow.innerHTML = '<h4>📋 日常护理流程</h4><div class="analysis-grid">' +
        (st.morning ? card('☀️ 晨间流程', escapeHtml(st.morning)) : '') +
        (st.night ? card('🌙 夜间流程', escapeHtml(st.night)) : '') +
        (st.avoid ? card('⛔ 要避开的', escapeHtml(st.avoid)) : '') +
        (st.star ? card('✨ 建议成分', escapeHtml(st.star)) : '') +
        '</div>';
      box.appendChild(flow);
    }

    /* ---- ⑤ 妆容方案 ---- */
    const mk = el('div', 'result-box');
    mk.innerHTML = '<h4>💄 妆容方案</h4><div class="analysis-grid">' +
      card('🧴 底妆建议', escapeHtml(st.base)) +
      (demo.undertone ? card('🎨 底色选择', escapeHtml(demo.undertone)) : '') +
      (demo.depth ? card('🎨 深浅选择', escapeHtml(demo.depth)) : '') +
      (demo.concerns && demo.concerns.length
        ? card('🎯 遮瑕与困扰', demo.concerns.map(escapeHtml).join('<br>· ')) : '') +
      (demo.sensitive ? card('🌿 敏感提示', escapeHtml(demo.sensitive)) : '') +
      (demo.climate ? card('🌤️ 环境适配', escapeHtml(demo.climate)) : '') +
      (st.after ? card('🌙 妆后护肤', escapeHtml(st.after)) : '') +
      '</div>';
    box.appendChild(mk);

    /* ---- ⑥ 具体产品推荐 ---- */
    const prod = skinProductBlock(demo.skinTypeId);
    if (prod) {
      const wrap = el('div', 'result-box');
      const tierPref = currentPrefs().tier || '';
      wrap.innerHTML = '<h4>🧴 具体产品推荐</h4>' +
        '<p class="sub">按你的肤质「' + escapeHtml(st.title) + '」筛选，每个分类给 2 款以上。' +
        '推荐理由来自公开评测与美妆社区的口碑共识' +
        (tierPref ? '；符合你预算档位（' + escapeHtml(TIER_LABEL[tierPref] || '') + '）的排在前面' : '') +
        '。</p>';
      wrap.appendChild(prod);
      wrap.appendChild(el('p', 'disclaimer', '⚠️ ' + D.skinProducts.disclaimer));
      box.appendChild(wrap);
    }

    if (result.mode === 'api' && result.apiText) {
      const ai = el('div', 'result-box');
      ai.innerHTML = '<h4>🤖 AI 详细建议</h4><p style="white-space:pre-wrap">' + escapeHtml(result.apiText) + '</p>';
      box.appendChild(ai);
    }
    if (result.needCode) {
      const note = el('div', 'result-box');
      note.innerHTML = '<h4>ℹ️ 当前使用本地规则分析</h4><p>本站 AI 分析已开启访问口令保护。' +
        '若你持有口令，可在「设置 → 访问口令」中填写后重试，获得更精准的 AI 建议。</p>';
      box.appendChild(note);
    }

    if (result.error) {
      const err = el('div', 'result-box');
      err.innerHTML = '<h4>⚠️ 云端分析失败，已回退演示模式</h4><p>' + escapeHtml(result.error) + '</p>';
      box.appendChild(err);
    }

    // 定制方案按钮
    const apply = el('div', 'apply-box');
    const btn = el('button', 'btn primary', '🧖‍♀️ 应用此方案，定制化妆步骤 →');
    btn.addEventListener('click', function () { applyCustomPlan(result, answers); });
    apply.appendChild(btn);
    box.appendChild(apply);
  }

  function applyCustomPlan(result, answers) {
    // 推荐一个底妆妆容作为基底
    const lookId = recommendLook(answers);
    const demo = result.demo;
    const notes = {};
    const add = function (stageId, txt) { (notes[stageId] = notes[stageId] || []).push(txt); };

    if (demo) {
      add('prep', demo.climate || '');
      add('prep', demo.sensitive || '');
      add('base', demo.skinType.base);
      add('base', demo.depth);
      add('base', demo.undertone);
      (demo.concerns || []).forEach(function (c) { add('base', c); });
      add('finish', answers.climate === 'humid' ? '潮湿环境：加强控油持妆，散粉+定妆喷雾双重定妆。' : (answers.climate === 'dry' ? '干燥环境：减少散粉，用保湿定妆喷雾。' : ''));
      add('after', demo.skinType.after);
      add('after', demo.sensitive || '');
    }

    // 过滤空项
    for (const k in notes) notes[k] = notes[k].filter(Boolean);
    state.customNotes = notes;
    state.customLookName = '肤质定制方案';
    selectLook(lookId, { keepCustom: true });   // selectLook 会切到教学视图并写入路由
    toast('已按你的肤质定制教学步骤', { type: 'ok' });
  }

  function recommendLook(answers) {
    if (answers.skinType === 'oily') return 'natural';
    if (answers.undertone === 'cool') return answers.sensitive === 'yes' ? 'korean' : 'sweet';
    if (answers.undertone === 'warm') return 'daily';
    return 'natural';
  }

  /* ============ 设置 ============ */
  // 按供应商调整表单：是否禁用 Base、是否需要在浏览器填 Key
  function applyProviderUI(provider) {
    const p = V.PROVIDERS[provider] || {};
    const keyInput = $('#cfg-key');
    const needsKey = !p.noKey;
    $('#cfg-base').disabled = provider === 'gemini';
    keyInput.disabled = !needsKey;
    keyInput.placeholder = needsKey ? 'sk-…（DeepSeek 平台的 API Key）' : '无需填写：Key 保存在服务器端';
    if (!needsKey) keyInput.value = '';
    const hint = $('#cfg-key-hint');
    if (hint) {
      hint.textContent = needsKey
        ? ''
        : '✓ 该供应商的 API Key 存放在服务器环境变量中，浏览器无需填写，也不会暴露给访客。';
    }
  }

  function loadSettingsUI() {
    const cfg = V.loadConfig();
    document.querySelector('input[name="ai-mode"][value="' + cfg.mode + '"]').checked = true;
    $('#cfg-provider').value = cfg.provider;
    $('#cfg-key').value = cfg.key || '';
    $('#cfg-base').value = cfg.base;
    $('#cfg-model').value = cfg.model;
    if ($('#cfg-access')) $('#cfg-access').value = cfg.accessCode || '';
    applyProviderUI(cfg.provider);
    loadTokenUI(cfg);
  }

  /* 省 token 设置 */
  function loadTokenUI(cfg) {
    cfg = cfg || V.loadConfig();
    if ($('#cfg-detail')) $('#cfg-detail').value = cfg.detail || 'high';
    if ($('#cfg-maximg')) $('#cfg-maximg').value = String(cfg.maxImageSize || 1024);
    if ($('#cfg-maxtok')) $('#cfg-maxtok').value = cfg.maxTokens || 3000;
    if ($('#cfg-cache')) $('#cfg-cache').value = cfg.cache === false ? '0' : '1';
  }

  function saveTokenSettings() {
    const cfg = V.loadConfig();
    cfg.detail = $('#cfg-detail').value;
    cfg.maxImageSize = parseInt($('#cfg-maximg').value, 10) || 1024;
    cfg.maxTokens = Math.max(100, Math.min(8000, parseInt($('#cfg-maxtok').value, 10) || 3000));
    cfg.cache = $('#cfg-cache').value === '1';
    V.saveConfig(cfg);
    const st = $('#token-status');
    st.className = 'hint ok';
    st.textContent = '✅ 已保存：' + (cfg.detail === 'low' ? '省流 512×512' : '高清') +
      ' · 上传前缩放到 ' + cfg.maxImageSize + 'px · max_tokens ' + cfg.maxTokens +
      ' · 缓存' + (cfg.cache ? '开启' : '关闭');
    toast('省钱设置已保存');
  }

  function syncProviderDefaults() {
    const provider = $('#cfg-provider').value;
    const p = V.PROVIDERS[provider];
    if (!p) return;
    $('#cfg-base').value = p.base || '';
    $('#cfg-model').value = p.model || '';
    applyProviderUI(provider);
  }

  function saveSettings() {
    const cfg = V.loadConfig();
    cfg.mode = (document.querySelector('input[name="ai-mode"]:checked') || {}).value || 'auto';
    cfg.provider = $('#cfg-provider').value;
    cfg.key = $('#cfg-key').value.trim();
    cfg.base = $('#cfg-base').value.trim();
    cfg.model = $('#cfg-model').value.trim();
    cfg.accessCode = $('#cfg-access') ? $('#cfg-access').value.trim() : '';
    V.saveConfig(cfg);

    let desc;
    if (cfg.mode === 'demo') desc = '仅演示模式（离线）';
    else if (cfg.mode === 'api') desc = '仅真实 API';
    else desc = V.hasApi(cfg) ? '自动（将使用真实 API）' : '自动（未配置密钥，使用演示模式）';

    const isCors = cfg.provider === 'deepseek';
    $('#cfg-status').className = 'hint ok';
    $('#cfg-status').textContent = '✅ 已保存。当前模式：' + desc +
      (isCors ? '　提示：DeepSeek 官方接口已实测允许浏览器直连（CORS 开放），一般可直接用；若你们那边网络受限再换「本站服务器」。' : '');
    toast('接口配置已保存 · ' + desc, { type: desc.indexOf('演示') >= 0 ? 'warn' : 'ok' });
  }

  async function resetSettings() {
    const ok = await confirmDialog({
      title: '恢复默认设置',
      message: '确定要把接口配置恢复成默认值吗？',
      detail: '你将失去：当前的供应商、API Key、访问口令，以及「省 Token」里的全部设置。',
      okText: '恢复默认',
      danger: true
    });
    if (!ok) return;
    V.saveConfig(V.defaultConfig());
    loadSettingsUI();
    $('#cfg-status').className = 'hint';
    $('#cfg-status').textContent = '已恢复默认设置。';
    toast('接口配置已恢复默认', { type: 'info' });
  }

  async function testSettings() {
    const cfg = {
      mode: 'api',
      provider: $('#cfg-provider').value,
      key: $('#cfg-key').value.trim(),
      base: $('#cfg-base').value.trim(),
      model: $('#cfg-model').value.trim(),
      accessCode: $('#cfg-access') ? $('#cfg-access').value.trim() : ''
    };
    const statusEl = $('#cfg-status');
    const btn = $('#btn-test-cfg');
    if (!cfg.model) {
      statusEl.className = 'hint err';
      statusEl.textContent = '⚠️ 请先填写模型名称（DeepSeek 用 deepseek-flash）。';
      return;
    }
    btn.disabled = true;
    statusEl.className = 'hint';
    statusEl.textContent = '⏳ 正在测试连接，请稍候…';
    try {
      const r = await V.testConnection(cfg);
      const good = r.ok && (r.visionOk || r.visionTested === false);
      statusEl.className = 'hint ' + (good ? 'ok' : (r.ok ? 'warn' : 'err'));
      statusEl.textContent = (good ? '✅ ' : '⚠️ ') + r.detail + '（耗时 ' + r.ms + 'ms）';
      if (good) statusEl.textContent += ' — 记得点「💾 保存配置」才会生效';
    } catch (e) {
      statusEl.className = 'hint err';
      statusEl.textContent = '❌ ' + e.message;
    } finally {
      btn.disabled = false;
    }
  }

  /* ============ 轻提示 Toast ============ */
  /* toast('已保存') / toast('失败了', {type:'err'}) / toast('已保存', {action:'去看看', onAction:fn}) */
  const TOAST_ICON = { ok: '✅', warn: '⚠️', err: '❌', info: 'ℹ️' };

  /* 同一条提示还在屏幕上时，重复触发不新增，只刷新计时并计次，避免刷屏 */
  const activeToasts = new Map();   // key -> { el, hit, refresh, remove }

  function toast(msg, opts) {
    const o = opts || {};
    const box = $('#toast-box');
    if (!box) return null;

    const type = o.type || 'ok';
    const key = type + '|' + msg;

    // 已有相同提示 → 刷新计时 + 计次脉冲
    const prev = activeToasts.get(key);
    if (prev && prev.el.parentNode) {
      prev.hit++;
      const badge = prev.el.querySelector('.toast-hit');
      if (badge) badge.textContent = '×' + prev.hit;
      prev.refresh();
      prev.el.classList.remove('pulse');
      void prev.el.offsetWidth;      // 强制重排，让动画能重放
      prev.el.classList.add('pulse');
      return prev.remove;
    }

    const item = el('div', 'toast toast-' + type);
    item.innerHTML =
      '<span class="toast-icon">' + (TOAST_ICON[type] || TOAST_ICON.ok) + '</span>' +
      '<span class="toast-text">' + escapeHtml(msg) + '</span>' +
      '<span class="toast-hit"></span>' +
      (o.action ? '<button class="toast-action" type="button">' + escapeHtml(o.action) + '</button>' : '');

    box.appendChild(item);
    requestAnimationFrame(function () { item.classList.add('in'); });

    let gone = false;
    let timer = null;
    const remove = function () {
      if (gone) return;
      gone = true;
      clearTimeout(timer);
      activeToasts.delete(key);
      item.classList.remove('in');
      item.classList.add('out');
      setTimeout(function () { if (item.parentNode) item.parentNode.removeChild(item); }, 280);
    };
    const refresh = function () {
      clearTimeout(timer);
      timer = setTimeout(remove, o.duration || 2600);
    };
    refresh();

    const rec = { el: item, hit: 1, refresh: refresh, remove: remove };
    activeToasts.set(key, rec);

    if (o.action && typeof o.onAction === 'function') {
      item.querySelector('.toast-action').addEventListener('click', function (e) {
        e.stopPropagation();
        remove();
        o.onAction();
      });
    }
    // 点一下可以提前关掉
    item.addEventListener('click', remove);
    return remove;
  }

  /* ============ 移动端：导航栏随滚动收起 / 出现 ============ */
  function initMobileNav() {
    const bar = document.querySelector('.sidebar');
    if (!bar) return;
    const mq = window.matchMedia('(max-width: 820px)');
    let lastY = window.scrollY || 0;
    let ticking = false;

    const update = function () {
      ticking = false;
      if (!mq.matches) { bar.classList.remove('nav-collapsed'); return; }
      const y = window.scrollY || 0;
      const dy = y - lastY;
      if (y <= 60) {
        bar.classList.remove('nav-collapsed');      // 只有滚回顶部才弹出
      } else if (dy > 6) {
        bar.classList.add('nav-collapsed');         // 向下滚动就收起
      }
      // 往上滚不再触发弹出 —— 否则动画太频繁，很打断阅读
      lastY = y;
    };

    window.addEventListener('scroll', function () {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(update);
    }, { passive: true });

    const onMq = function () {
      if (!mq.matches) bar.classList.remove('nav-collapsed');
      lastY = window.scrollY || 0;
    };
    if (mq.addEventListener) mq.addEventListener('change', onMq);
    else if (mq.addListener) mq.addListener(onMq);
  }

  /* ============ 网络状态提示 ============ */
  // navigator.onLine 只能反映本机有没有网络接口，但用来做友好提示足够了
  function setNetStatus(online, silent) {
    const badge = $('#net-badge');
    if (badge) badge.classList.toggle('hidden', online);
    if (silent) return;
    if (online) {
      toast('网络已恢复', { type: 'ok' });
    } else {
      toast('网络已断开 · 教学功能正常，AI 识别与分析暂不可用', { type: 'warn', duration: 4200 });
    }
  }

  function initNetWatch() {
    const online = (typeof navigator === 'undefined' || navigator.onLine !== false);
    setNetStatus(online, true);                       // 首次进入静默处理，不弹提示
    window.addEventListener('online', function () { setNetStatus(true); });
    window.addEventListener('offline', function () { setNetStatus(false); });
  }

  /* ============ 通用弹窗 ============ */
  function openModal(html, opts) {
    const card = $('#modal-card');
    card.className = 'modal-card' + (opts && opts.narrow ? ' narrow' : '');
    card.innerHTML = html;
    $('#modal-backdrop').classList.remove('hidden');
    document.body.style.overflow = 'hidden';
    card.querySelectorAll('[data-close]').forEach(function (b) {
      b.addEventListener('click', closeModal);
    });
    const focusable = card.querySelector('input, select, button.btn');
    if (focusable) setTimeout(function () { focusable.focus(); }, 60);
  }

  /* 有待确认的对话框时，关闭（含 ESC / 点遮罩）一律视为「取消」 */
  let pendingConfirm = null;

  function closeModal() {
    $('#modal-backdrop').classList.add('hidden');
    $('#modal-card').className = 'modal-card';
    $('#modal-card').innerHTML = '';
    document.body.style.overflow = '';
    if (pendingConfirm) {
      const r = pendingConfirm;
      pendingConfirm = null;
      r(false);
    }
  }

  /* 统一的二次确认弹窗。返回 Promise<boolean>：
   * 确认 → true；取消 / 按 ESC / 点遮罩 → false
   * 用法： if (!(await confirmDialog({...}))) return;
   */
  function confirmDialog(opts) {
    const o = opts || {};
    return new Promise(function (resolve) {
      let settled = false;
      const finish = function (v) {
        if (settled) return;
        settled = true;
        pendingConfirm = null;
        resolve(v);
      };
      pendingConfirm = finish;

      const html =
        '<div class="modal-head">' +
          '<div><h3>' + escapeHtml(o.title || '确认操作') + '</h3>' +
            (o.sub ? '<p class="sub">' + escapeHtml(o.sub) + '</p>' : '') + '</div>' +
          '<button class="modal-close" data-cf="0" aria-label="取消">×</button>' +
        '</div>' +
        '<div class="modal-body">' +
          '<p class="cf-msg">' + (o.html || escapeHtml(o.message || '确定要执行这个操作吗？')) + '</p>' +
          (o.detail ? '<div class="' + (o.danger ? 'cf-detail danger' : 'cf-detail') + '">' + o.detail + '</div>' : '') +
        '</div>' +
        '<div class="modal-foot">' +
          '<button class="btn ghost" data-cf="0" type="button">' + escapeHtml(o.cancelText || '取消') + '</button>' +
          '<button class="btn ' + (o.danger ? 'danger' : 'primary') + '" data-cf="1" type="button">' +
            escapeHtml(o.okText || '确定') + '</button>' +
        '</div>';

      openModal(html, { narrow: true });

      $('#modal-card').querySelectorAll('[data-cf]').forEach(function (b) {
        b.addEventListener('click', function () {
          finish(b.dataset.cf === '1');   // 先结算，再关闭（否则会被当成取消）
          closeModal();
        });
      });
    });
  }

  /* ============ 妆前 / 妆后预览 ============ */
  function openLookPreview(opts) {
    const palette = (opts.palette && opts.palette.length) ? opts.palette : ['#ec5f8a', '#c4456c', '#f08aa8'];
    const name = opts.name || '妆容';

    // 妆前：素颜示意；妆后：有真实参考图就用真图，否则生成完整妆容示意
    const lookId = opts.lookId || '';
    const savedPhoto = lookId ? S.getLookPhoto(lookId) : '';
    const realPhoto = opts.image || savedPhoto;

    // 只保留用户自己上传的实拍图；程序生成的「妆前 / 妆后」插画已移除
    const afterPhoto = realPhoto || '';

    // 该妆容的精选视频教程。没有的话不硬塞通用视频，改为按名字直达搜索
    const curated = (D.tutorials && lookId && D.tutorials[lookId]) ? D.tutorials[lookId] : [];

    const kwCn = encodeURIComponent(name + ' 妆前 妆后 对比');
    const kwTut = encodeURIComponent(name + ' 化妆教程');
    const kwVid = encodeURIComponent(name + ' 教程 详细步骤 跟练');

    const html =
      '<div class="modal-head">' +
        '<div>' +
          '<h3>' + escapeHtml(name) + ' · 参考与教程</h3>' +
          '<p class="sub">' + escapeHtml(opts.tagline || '') + '</p>' +
        '</div>' +
        '<button class="modal-close" data-close="1" aria-label="关闭">×</button>' +
      '</div>' +
      '<div class="modal-body">' +
        (afterPhoto
          ? '<div class="ba-compare single">' +
              '<div class="ba-item ba-after">' +
                '<img src="' + afterPhoto + '" alt="' + escapeHtml(name) + ' 实拍参考图" />' +
                '<div class="ba-label">' + escapeHtml(name) + ' · 实拍参考</div>' +
              '</div>' +
            '</div>'
          : '') +
        (lookId
          ? '<div class="photo-ctl">' +
              '<input type="file" id="pv-photo-file" accept="image/*" hidden />' +
              '<button class="mini-btn" id="pv-photo-set">📷 ' + (afterPhoto ? '换一张实拍图' : '上传你的实拍参考图') + '</button>' +
              (afterPhoto ? '<button class="mini-btn danger" id="pv-photo-clear">删除这张图</button>' : '') +
              '<span class="hint">' +
                (afterPhoto
                  ? '这张图只存在你自己的浏览器里，不会上传到服务器。'
                  : '可以传一张你自己的素颜照或参考博主的妆后照，方便对着练。只存本机，不会上传。') +
              '</span>' +
            '</div>'
          : '') +

        (curated.length
          ? '<h4 class="gallery-title">🎬 精选跟练教程</h4>' +
            '<p class="preview-note" style="margin-top:0">下面都是<b>筛好的具体视频</b>（不是搜索页）。' +
            '点标题去 B 站看，或点「本页试播」直接在弹窗里播放。</p>' +
            '<div class="tut-list">' + curated.map(function (v) {
              return '<div class="tut-card">' +
                '<a class="tut-main" href="https://www.bilibili.com/video/' + v.bv + '/" target="_blank" rel="noopener">' +
                  '<span class="tut-play">▶</span>' +
                  '<span class="tut-info"><b>' + escapeHtml(v.t) + '</b>' +
                  '<small>Bilibili' + (v.tag ? ' · ' + escapeHtml(v.tag) : '') + '</small></span>' +
                '</a>' +
                '<button class="mini-btn" data-bv="' + v.bv + '" type="button">本页试播</button>' +
              '</div>';
            }).join('') + '</div>' +
            '<div class="tut-player hidden" id="tut-player"></div>'
          : '<h4 class="gallery-title">🎬 找这款妆容的教程</h4>' +
            '<p class="preview-note" style="margin-top:0">这款妆容暂时<b>没有人工筛选过的具体视频</b>' +
            '（我们不会随便塞一个不相关的视频号给你）。下面按妆容名直达搜索，' +
            '里面有大量真实跟练视频。</p>' +
            '<div class="gallery-links">' +
              '<a href="https://search.bilibili.com/all?keyword=' + encodeURIComponent(name + ' 教程') +
                '" target="_blank" rel="noopener">B站搜「' + escapeHtml(name) + '」</a>' +
              '<a href="https://www.xiaohongshu.com/search_result?keyword=' + encodeURIComponent(name + ' 教程') +
                '" target="_blank" rel="noopener">小红书图文</a>' +
              '<a href="https://www.douyin.com/search/' + encodeURIComponent(name + ' 教程') +
                '" target="_blank" rel="noopener">抖音视频</a>' +
            '</div>') +

        '<h4 class="gallery-title">🔎 还想找更多参考？</h4>' +
        '<div class="gallery-links">' +
          '<a href="https://search.bilibili.com/all?keyword=' + kwVid + '" target="_blank" rel="noopener">B站搜视频教程</a>' +
          '<a href="https://www.xiaohongshu.com/search_result?keyword=' + kwTut + '" target="_blank" rel="noopener">小红书图文</a>' +
          '<a href="https://www.zhihu.com/search?type=content&q=' + kwVid + '" target="_blank" rel="noopener">知乎长文</a>' +
          '<a href="https://image.baidu.com/search/index?tn=baiduimage&word=' + kwCn + '" target="_blank" rel="noopener">图片搜索</a>' +
        '</div>' +
      '</div>' +
      '<div class="modal-foot">' +
        '<button class="btn ghost" data-close="1">关闭</button>' +
        (opts.showTeach && lookId ? '<button class="btn primary" id="modal-go-teach">🎨 去学这个妆容</button>' : '') +
      '</div>';

    openModal(html);

    // 精选教程：本页试播（B站播放器）
    const player = $('#tut-player');
    if (player) {
      $$('#modal-card [data-bv]').forEach(function (b) {
        b.addEventListener('click', function () {
          player.classList.remove('hidden');
          player.innerHTML =
            '<iframe src="https://player.bilibili.com/player.html?bvid=' + encodeURIComponent(b.dataset.bv) +
            '&page=1&high_quality=1&danmaku=0" scrolling="no" frameborder="no" allowfullscreen="true"></iframe>' +
            '<p class="hint">如果这里放不出来，说明该视频不允许站外嵌入，点上面的标题链接去 B 站看即可。</p>';
          player.scrollIntoView({ behavior: 'smooth', block: 'center' });
        });
      });
    }

    // 上传 / 清除实拍参考图
    const fileInput = $('#pv-photo-file');
    if (fileInput) {
      fileInput.addEventListener('change', async function () {
        const file = fileInput.files && fileInput.files[0];
        if (!file) return;
        const dataUrl = await V.fileToDataURL(file);
        const img = new Image();
        img.onload = function () {
          const small = V.compressImage(img, 900, 0.82);
          const r = S.setLookPhoto(lookId, small);
          if (!r.ok) { alert('保存失败：浏览器存储空间不足。'); return; }
          openLookPreview(opts);          // 重新打开以显示新图
        };
        img.src = dataUrl;
      });
      const setBtn = $('#pv-photo-set');
      if (setBtn) setBtn.addEventListener('click', function () { fileInput.click(); });
      const clearBtn = $('#pv-photo-clear');
      if (clearBtn) {
        clearBtn.addEventListener('click', async function () {
          const ok = await confirmDialog({
            title: '删除实拍参考图',
            sub: '此操作不可撤销',
            message: '确定要删除你上传的这张参考图吗？',
            detail: '图片会从本机浏览器里删除，删除后无法恢复。',
            okText: '删除',
            danger: true
          });
          if (!ok) { openLookPreview(opts); return; }   // 取消后把弹窗恢复回来
          S.setLookPhoto(lookId, '');
          openLookPreview(opts);
          toast('参考图已删除', { type: 'info' });
        });
      }
    }

    if (opts.showTeach && lookId) {
      $('#modal-go-teach').addEventListener('click', function () {
        closeModal();
        selectLook(lookId);
      });
    }
  }

  /* ============ 我的妆容 ============ */
  function formatDate(ts) {
    const d = new Date(ts);
    return d.getFullYear() + '/' + (d.getMonth() + 1) + '/' + d.getDate();
  }

  function baseLookName(id) {
    const l = D.looks.find(function (x) { return x.id === id; });
    return l ? l.name : '自定义';
  }

  function renderMyLooks(filter) {
    const grid = $('#my-looks-grid');
    const hint = $('#my-looks-hint');
    if (!grid) return;

    const looks = S.listLooks();
    grid.innerHTML = '';
    hint.textContent = '';

    if (!looks.length) {
      grid.innerHTML = '<div class="empty-state">还没有保存的妆容。<br>' +
        '到「妆容识别」上传一张喜欢的妆容图片，识别后点「💾 保存到我的妆容」即可收藏。</div>';
      return;
    }

    const q = (filter || '').trim().toLowerCase();
    const list = looks.filter(function (l) {
      if (!q) return true;
      return (l.name + ' ' + (l.note || '') + ' ' + baseLookName(l.baseLookId)).toLowerCase().indexOf(q) !== -1;
    });

    if (!list.length) {
      grid.innerHTML = '<div class="empty-state">没有匹配「' + escapeHtml(filter) + '」的妆容。</div>';
      return;
    }

    list.forEach(function (item, i) {
      const card = el('div', 'my-look-card');
      card.style.animationDelay = (Math.min(i, 11) * 45) + 'ms';   // 封顶，存了几十款也不会等半天
      const thumb = item.image
        ? '<img class="my-look-thumb" src="' + item.image + '" alt="' + escapeHtml(item.name) + '" />'
        : '<div class="my-look-thumb" style="background:linear-gradient(135deg,' +
            (item.palette[0] || '#ec5f8a') + ',' + (item.palette[1] || '#c4456c') + ')"></div>';
      const swatches = (item.palette || []).map(function (c) {
        return '<i style="background:' + c + '"></i>';
      }).join('');

      card.innerHTML = thumb +
        '<div class="my-look-body">' +
          '<h5 title="' + escapeHtml(item.name) + '">' + escapeHtml(item.name) + '</h5>' +
          '<p class="my-look-sub">按「' + escapeHtml(baseLookName(item.baseLookId)) + '」教学 · ' + formatDate(item.createdAt) + '</p>' +
          (swatches ? '<div class="my-look-swatches">' + swatches + '</div>' : '') +
          '<div class="my-look-actions">' +
            '<button class="mini-btn" data-act="teach">按此教学</button>' +
            '<button class="mini-btn" data-act="preview">预览</button>' +
            '<button class="mini-btn" data-act="rename">重命名</button>' +
            '<button class="mini-btn" data-act="note">备注</button>' +
            '<button class="mini-btn danger" data-act="delete">删除</button>' +
          '</div>' +
        '</div>';

      card.querySelectorAll('[data-act]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          const act = btn.dataset.act;
          if (act === 'teach') applyMyLook(item);
          else if (act === 'preview') {
            openLookPreview({
              name: item.name, tagline: '我的妆容 · 参考「' + baseLookName(item.baseLookId) + '」',
              palette: item.palette, image: item.image, lookId: item.baseLookId, showTeach: true
            });
          } else if (act === 'rename') renameMyLook(item);
          else if (act === 'note') editMyLookNote(item);
          else if (act === 'delete') deleteMyLook(item);
        });
      });

      grid.appendChild(card);
    });

    hint.textContent = '共 ' + looks.length + ' 个妆容（每个账号最多保存 ' + S.MAX_LOOKS + ' 个）';
  }

  function applyMyLook(item) {
    const base = D.looks.find(function (l) { return l.id === item.baseLookId; }) || D.looks[0];
    if (!base) return;
    state.customNotes = {};
    state.customNotes.base = [
      '这是你保存的妆容「' + item.name + '」的参考配色：' + (item.palette || []).join(' / ') +
      '。按下面的步骤操作即可接近这个风格。'
    ];
    if (item.note) state.customNotes.base.push('你的备注：' + item.note);
    state.customLookName = '我的妆容 · ' + item.name;
    selectLook(base.id, { keepCustom: true });
  }

  function renameMyLook(item) {
    const name = prompt('给这个妆容起个新名字：', item.name);
    if (name == null) return;
    const r = S.updateLook(item.id, { name: name });
    if (!r.ok) { toast('重命名失败，可能是存储空间不足', { type: 'err' }); return; }
    renderMyLooks($('#my-look-search').value);
    toast('已重命名为「' + r.item.name + '」');
  }

  function editMyLookNote(item) {
    const note = prompt('给「' + item.name + '」加一句备注（留空可清除）：', item.note || '');
    if (note == null) return;
    S.updateLook(item.id, { note: note });
    renderMyLooks($('#my-look-search').value);
    toast(note.trim() ? '备注已保存' : '备注已清除', { type: note.trim() ? 'ok' : 'info' });
  }

  async function deleteMyLook(item) {
    const ok = await confirmDialog({
      title: '删除妆容',
      sub: '此操作不可撤销',
      html: '确定要删除「<b>' + escapeHtml(item.name) + '</b>」吗？',
      detail: '删除后，这个妆容的<b>名称、备注和参考图片</b>都会从当前账号中移除，无法恢复。',
      okText: '删除',
      danger: true
    });
    if (!ok) return;
    S.deleteLook(item.id);
    renderMyLooks($('#my-look-search').value);
    toast('已删除「' + item.name + '」', { type: 'info' });
  }

  /* 把当前识别结果保存为「我的妆容」 */
  async function openSaveLookModal() {
    const r = state.lastRecognize;
    if (!r) { alert('请先点「✨ 开始识别」，识别成功后再保存。'); return; }
    if (!state.recognizeFile) { alert('请先上传一张妆容图片。'); return; }

    const img = $('#recognize-img');
    const suggested = (D.looks.find(function (l) { return l.id === r.lookId; }) || {}).name || '我的妆容';

    const html =
      '<div class="modal-head">' +
        '<div><h3>保存到我的妆容</h3><p class="sub">图片会压缩后保存在本机浏览器</p></div>' +
        '<button class="modal-close" data-close="1">×</button>' +
      '</div>' +
      '<div class="modal-body">' +
        '<div class="form-row">' +
          '<label class="field"><span>妆容名称</span>' +
            '<input type="text" id="save-look-name" class="input" maxlength="24" value="' + escapeHtml(suggested) + '" /></label>' +
        '</div>' +
        '<div class="form-row" style="margin-top:14px">' +
          '<label class="field"><span>备注（选填）</span>' +
            '<input type="text" id="save-look-note" class="input" maxlength="200" placeholder="例如：适合秋天、想要这种眼妆" /></label>' +
        '</div>' +
        '<div style="margin-top:16px" class="ba-compare single">' +
          '<div class="ba-item ba-after"><img src="' + img.src + '" alt="参考图" /><div class="ba-label">你导入的参考图</div></div>' +
        '</div>' +
      '</div>' +
      '<div class="modal-foot">' +
        '<button class="btn ghost" data-close="1">取消</button>' +
        '<button class="btn primary" id="save-look-confirm">💾 保存</button>' +
      '</div>';

    openModal(html);

    $('#save-look-confirm').addEventListener('click', function () {
      const name = $('#save-look-name').value.trim() || suggested;
      const note = $('#save-look-note').value.trim();
      const look = D.looks.find(function (l) { return l.id === r.lookId; }) || {};

      // 压缩图片，避免占满浏览器存储
      const small = V.compressImage(img, 460, 0.72);
      const res = S.addLook({
        name: name, note: note,
        baseLookId: r.lookId,
        confidence: r.confidence,
        palette: look.palette || [],
        image: small
      });

      if (!res.ok) {
        if (res.reason === 'limit') {
          alert('每个账号最多保存 ' + res.limit + ' 个妆容，请先删除一些再保存。');
        } else {
          alert('保存失败：浏览器存储空间不足。可以删除一些已保存的妆容后重试。');
        }
        return;
      }
      closeModal();
      renderMyLooks('');
      go('teach');
      toast('已保存「' + res.item.name + '」到我的妆容', {
        action: '去看看',
        duration: 4500,
        onAction: function () {
          const cardEl = $('#my-looks-card');
          if (cardEl) cardEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      });
    });
  }

  /* ============ 账号管理 ============ */
  function refreshAccountUI() {
    const acc = S.currentAccount();
    if (!acc) return;
    const nameEl = $('#account-name');
    const avEl = $('#account-avatar');
    if (nameEl) nameEl.textContent = acc.name;
    if (avEl) {
      avEl.textContent = acc.name.slice(0, 1);
      avEl.style.background = acc.color;
    }
    renderSettingsAccount();
  }

  function renderSettingsAccount() {
    const row = $('#settings-account-row');
    if (!row) return;
    const acc = S.currentAccount();
    const looks = S.listLooks().length;
    const u = S.usage();
    row.innerHTML =
      '<span class="account-avatar" style="background:' + acc.color + '">' + escapeHtml(acc.name.slice(0, 1)) + '</span>' +
      '<span class="account-meta">' +
        '<b>' + escapeHtml(acc.name) + '</b>' +
        '<small>已保存 ' + looks + ' 个妆容 · 创建于 ' + formatDate(acc.createdAt) + '</small>' +
      '</span>';
    const bar = $('#storage-bar');
    if (bar) bar.style.width = Math.max(2, Math.round(u.percent)) + '%';
    const txt = $('#storage-text');
    if (txt) {
      txt.textContent = '本地存储已用约 ' + u.usedMB.toFixed(2) + ' MB / 约 5 MB（' +
        Math.round(u.percent) + '%）。浏览器数据被清除时，账号与妆容会一并丢失。';
    }
  }

  function openAccountModal() {
    const accounts = S.listAccounts();
    const cur = S.currentAccount();

    let html =
      '<div class="modal-head">' +
        '<div><h3>账号管理</h3><p class="sub">本地账号 · 数据保存在本机浏览器</p></div>' +
        '<button class="modal-close" data-close="1">×</button>' +
      '</div>' +
      '<div class="modal-body">' +
        '<h4 class="gallery-title">已有账号（' + accounts.length + '）</h4>' +
        '<div class="acc-list">';

    accounts.forEach(function (a) {
      const isCur = a.id === cur.id;
      html += '<div class="acc-item' + (isCur ? ' current' : '') + '">' +
        '<span class="account-avatar" style="background:' + a.color + '">' + escapeHtml(a.name.slice(0, 1)) + '</span>' +
        '<span class="acc-name">' + escapeHtml(a.name) + '</span>' +
        (isCur ? '<span class="acc-tag">当前</span>'
               : '<button class="mini-btn" data-switch="' + a.id + '">切换</button>') +
        '<span class="acc-btns">' +
          '<button class="mini-btn" data-rename="' + a.id + '">重命名</button>' +
          (accounts.length > 1 ? '<button class="mini-btn danger" data-del="' + a.id + '">删除</button>' : '') +
        '</span>' +
      '</div>';
    });

    html += '</div>' +
      '<h4 class="gallery-title">新建账号</h4>' +
      '<div class="form-row">' +
        '<label class="field"><span>账号名称</span>' +
          '<input type="text" id="new-acc-name" class="input" maxlength="20" placeholder="例如：小美 / 我的小号" /></label>' +
        '<button class="btn primary" id="btn-create-acc">+ 创建账号</button>' +
      '</div>' +
      '<p class="preview-note">每个账号有独立的「我的妆容」和肤质档案。删除账号会同时删除它的数据。</p>' +
      '</div>';

    openModal(html);

    $$('#modal-card [data-switch]').forEach(function (b) {
      b.addEventListener('click', function () {
        S.switchAccount(b.dataset.switch);
        refreshAccountUI();
        renderMyLooks('');
        renderSkinProfile();
        renderRecommend();
        renderPersonalize();     // 个性化设置是按账号存的
        closeModal();
        toast('已切换到「' + S.currentAccount().name + '」', { type: 'info' });
      });
    });

    $$('#modal-card [data-rename]').forEach(function (b) {
      b.addEventListener('click', function () {
        const acc = S.listAccounts().find(function (x) { return x.id === b.dataset.rename; });
        const name = prompt('输入新的账号名称：', acc ? acc.name : '');
        if (name == null) return;
        if (!S.renameAccount(b.dataset.rename, name)) { toast('名称不能为空', { type: 'warn' }); return; }
        refreshAccountUI();
        openAccountModal();
        toast('账号已重命名');
      });
    });

    $$('#modal-card [data-del]').forEach(function (b) {
      b.addEventListener('click', async function () {
        const acc = S.listAccounts().find(function (x) { return x.id === b.dataset.del; });
        const nLooks = S.listLooks(b.dataset.del).length;
        const profile = S.getSkinProfile(b.dataset.del);
        const ok = await confirmDialog({
          title: '删除账号',
          sub: '此操作不可撤销',
          html: '确定要删除账号「<b>' + escapeHtml(acc ? acc.name : '') + '</b>」吗？',
          detail: '这个账号里的数据会被一并删除：<br>· 我的妆容 <b>' + nLooks + '</b> 个<br>' +
            '· 肤质档案 ' + (profile ? '<b>1</b> 份' : '无') + '<br>· 个性化设置<br>' +
            '<br>删除后无法恢复，其他账号不受影响。',
          okText: '删除账号',
          danger: true
        });
        if (!ok) { openAccountModal(); return; }   // 取消后把账号面板恢复回来
        const delName = acc ? acc.name : '';
        const r = S.deleteAccount(b.dataset.del);
        if (!r.ok) { toast(r.reason === 'last' ? '至少要保留一个账号' : '删除失败', { type: 'err' }); return; }
        refreshAccountUI();
        renderMyLooks('');
        renderSkinProfile();
        renderRecommend();
        renderPersonalize();
        openAccountModal();
        toast('已删除账号「' + delName + '」', { type: 'info' });
      });
    });

    const createBtn = $('#btn-create-acc');
    const nameInput = $('#new-acc-name');
    const doCreate = function () {
      const name = nameInput.value.trim();
      if (!name) { alert('请输入账号名称。'); nameInput.focus(); return; }
      const acc = S.createAccount(name);
      if (!acc) { toast('创建失败，浏览器存储可能已满', { type: 'err' }); return; }
      refreshAccountUI();
      renderMyLooks('');
      renderSkinProfile();
      renderRecommend();
      renderPersonalize();
      closeModal();
      toast('已创建账号「' + acc.name + '」并切换过去');
    };
    createBtn.addEventListener('click', doCreate);
    nameInput.addEventListener('keydown', function (e) { if (e.key === 'Enter') doCreate(); });
  }

  /* ============ 妆容推荐（肤质档案 + 照片 → 适合画什么） ============ */
  function renderRecommend() {
    const card = $('#recommend-card');
    const body = $('#recommend-body');
    if (!card || !body) return;

    const p = S.getSkinProfile();
    if (!p || !p.answers) { card.classList.add('hidden'); return; }

    const list = V.recommendLooks(p.answers, p.analysis || null);
    const top = list.slice(0, 4);
    const low = list.filter(function (r) { return r.score < 46; }).slice(0, 2);

    const answerText = (function () {
      const m = { oily: '油性', dry: '干性', combo: '混合', normal: '中性', sensitive: '敏感' };
      const u = { cool: '冷调', warm: '暖调', neutral: '中性' };
      const d = { fair: '白皙', light: '自然偏白', medium: '自然', deep: '偏深' };
      return (m[p.answers.skinType] || '') + '肌 · ' + (u[p.answers.undertone] || '') + '肤色 · ' +
        (d[p.answers.depth] || '') + '肤色';
    })();

    card.classList.remove('hidden');
    body.innerHTML =
      '<p class="preview-note" style="margin-top:0">依据你的档案：<b>' + escapeHtml(answerText) + '</b>' +
      (p.concerns && p.concerns.length ? '，困扰：' + escapeHtml(p.concerns.join('、')) : '') +
      (p.analysis ? '，并结合你上传照片的明暗与色调分析' : '') + '。</p>' +
      '<div class="rec-list">' +
        top.map(function (r, i) {
          const look = D.looks.find(function (l) { return l.id === r.lookId; });
          return '<div class="rec-item' + (i === 0 ? ' best' : '') + '">' +
            '<div class="rec-head">' +
              '<span class="rec-rank">' + (i === 0 ? '🏆 最推荐' : '#' + (i + 1)) + '</span>' +
              '<h5>' + escapeHtml(r.name) + '</h5>' +
              '<span class="rec-score">' + r.score + '%</span>' +
            '</div>' +
            '<div class="rec-bar"><i style="width:' + r.score + '%"></i></div>' +
            '<p class="rec-note">' + escapeHtml(r.note) + '</p>' +
            (r.pros.length
              ? '<ul class="rec-pros">' + r.pros.map(function (x) { return '<li>' + escapeHtml(x) + '</li>'; }).join('') + '</ul>'
              : '') +
            (r.cons.length
              ? '<ul class="rec-cons">' + r.cons.map(function (x) { return '<li>' + escapeHtml(x) + '</li>'; }).join('') + '</ul>'
              : '') +
            '<div class="rec-actions">' +
              '<button class="mini-btn" data-go="' + r.lookId + '" type="button">🎨 去学这个妆容</button>' +
              (look ? '<button class="mini-btn" data-pv="' + r.lookId + '" type="button">👁 预览</button>' : '') +
            '</div>' +
          '</div>';
        }).join('') +
      '</div>' +
      (low.length
        ? '<div class="rec-warn"><b>⚠️ 相对不太建议</b><ul>' +
          low.map(function (r) {
            return '<li><b>' + escapeHtml(r.name) + '</b>（' + r.score + '%）' +
              (r.cons.length ? '：' + escapeHtml(r.cons[0]) : '') + '</li>';
          }).join('') + '</ul></div>'
        : '') +
      '<p class="hint">推荐依据是你的肤质、肤色基调、深浅、困扰与照片明暗，只作参考。' +
      '喜欢哪个风格就去画，化妆没有硬性规矩。</p>';

    // 交互
    body.querySelectorAll('[data-go]').forEach(function (b) {
      b.addEventListener('click', function () { selectLook(b.dataset.go); });
    });
    body.querySelectorAll('[data-pv]').forEach(function (b) {
      b.addEventListener('click', function () {
        const look = D.looks.find(function (l) { return l.id === b.dataset.pv; });
        if (look) openLookPreview({
          name: look.name, nameEn: look.en, tagline: look.tagline,
          palette: look.palette, lookId: look.id, showTeach: true
        });
      });
    });
  }

  /* ============ 肤质档案 ============ */
  function renderSkinProfile() {
    const card = $('#skin-profile-card');
    if (!card) return;
    const p = S.getSkinProfile();
    if (!p) { card.classList.add('hidden'); return; }

    card.classList.remove('hidden');
    const answers = p.answers || {};
    const labelMap = { skinType: '肤质', undertone: '肤色基调', depth: '肤色深浅', concerns: '肌肤困扰', sensitive: '敏感', climate: '气候' };
    const valueMap = {
      oily: '油性', dry: '干性', combo: '混合', normal: '中性', sensitive: '敏感',
      cool: '冷调', warm: '暖调', neutral: '中性',
      fair: '白皙', light: '自然偏白', medium: '自然', deep: '偏深',
      no: '不会', sometimes: '偶尔', yes: '经常',
      dry2: '干燥', humid: '潮湿'
    };
    const rows = [];
    Object.keys(labelMap).forEach(function (k) {
      let v = answers[k];
      if (v == null || v === '') return;
      if (Array.isArray(v)) v = v.map(function (x) { return valueMap[x] || x; }).join('、');
      else v = valueMap[v] || v;
      rows.push('<b>' + labelMap[k] + '</b>：' + escapeHtml(v));
    });

    const body = card.querySelector('#skin-profile-body') || card;
    body.innerHTML =
      '<div class="analysis-grid">' +
        '<div class="metric"><h5>🩺 肤质</h5><p>' + escapeHtml(p.skinTypeTitle || '已记录') + '</p></div>' +
        '<div class="metric"><h5>🧴 底妆要点</h5><p>' + escapeHtml((p.base || '').slice(0, 120)) + '</p></div>' +
        '<div class="metric"><h5>🌙 妆后护肤</h5><p>' + escapeHtml((p.after || '').slice(0, 120)) + '</p></div>' +
      '</div>' +
      '<p class="preview-note">问卷记录（' + formatDate(p.savedAt || Date.now()) + '）：' + rows.join(' ｜ ') +
      '<br>下次生成分析报告时会自动带上这份档案，你也可以直接点「应用此方案」按它定制化妆步骤。</p>';
  }

  /* ============ 初始化 ============ */
  function init() {
    // 界面主题与风格（要尽早，避免闪一下默认配色）
    applyAppearance();

    // 导航
    $$('.nav-item').forEach(function (b) {
      b.addEventListener('click', function () { switchView(b.dataset.view); });
    });

    // 产品推荐：从品类详情返回目录
    const shopBack = $('#btn-shop-back');
    if (shopBack) shopBack.addEventListener('click', function () { go('shop'); });

    // 选妆
    renderLookTabs();
    renderLookGrid('');
    $('#look-search').addEventListener('input', function () { renderLookGrid(this.value); });

    // 悬浮返回按钮
    $('#back-fab').addEventListener('click', goBack);
    window.addEventListener('resize', positionBackFab);

    // 教学导航
    $('#btn-prev').addEventListener('click', function () { if (state.currentStage > 0) { state.currentStage--; renderTeaching(); } });
    $('#btn-next').addEventListener('click', function () {
      if (state.currentStage < D.stages.length - 1) { state.currentStage++; renderTeaching(); }
      else { alert('🎉 恭喜完成「' + (D.looks.find(function (l) { return l.id === state.currentLook; }) || {}).name + '」全部步骤！记得妆后好好卸妆护肤哦。'); }
    });

    // 识别
    setupDropzone($('#drop-recognize'), $('#file-recognize'), handleRecognizeFile);
    $('#btn-recognize').addEventListener('click', runRecognize);
    $('#btn-save-look').addEventListener('click', openSaveLookModal);
    $('#btn-clear-recognize').addEventListener('click', async function () {
      // 已识别但还没保存时，清掉会丢失结果，先问一下
      if (state.lastRecognize) {
        const ok = await confirmDialog({
          title: '清除识别结果',
          message: '确定要清除当前图片和识别结果吗？',
          detail: '如果还没点「💾 保存到我的妆容」，这次识别的内容会丢失。',
          okText: '清除',
          danger: true
        });
        if (!ok) return;
      }
      state.recognizeFile = null;
      state.lastRecognize = null;
      $('#recognize-img').src = '';
      $('#recognize-preview').classList.add('hidden');
      $('#recognize-result').classList.add('hidden');
      $('#file-recognize').value = '';
      $('#btn-save-look').disabled = true;
    });

    // 分析
    setupDropzone($('#drop-face'), $('#file-face'), handleFaceFile);
    renderQuiz();
    renderSkinGuide();
    $('#btn-analyze').addEventListener('click', runAnalysis);
    $('#btn-clear-face').addEventListener('click', function () {
      state.faceFile = null;
      $('#face-img').src = '';
      $('#face-preview').classList.add('hidden');
      $('#analysis-result').classList.add('hidden');
      $('#file-face').value = '';
    });
    $('#btn-clear-profile').addEventListener('click', async function () {
      const ok = await confirmDialog({
        title: '清除肤质档案',
        sub: '此操作不可撤销',
        message: '确定要清除已保存的肤质档案吗？',
        detail: '清除后，「适合你的妆容」推荐也会一并失效，需要重新上传照片并填写问卷才能恢复。',
        okText: '清除',
        danger: true
      });
      if (!ok) return;
      S.clearSkinProfile();
      renderSkinProfile();
      renderRecommend();
      toast('肤质档案已清除', { type: 'info' });
    });
    $('#btn-recommend').addEventListener('click', function () {
      renderRecommend();
      const c = $('#recommend-card');
      if (c) {
        if (c.classList.contains('hidden')) {
          alert('还没有肤质档案。请先上传脸部照片并完成问卷，生成一次分析报告。');
          return;
        }
        c.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });

    // 我的妆容
    renderMyLooks('');
    $('#my-look-search').addEventListener('input', function () { renderMyLooks(this.value); });

    // 预览当前妆容
    $('#btn-preview-current').addEventListener('click', function () {
      const look = D.looks.find(function (l) { return l.id === state.currentLook; });
      if (!look) return;
      openLookPreview({
        name: look.name, nameEn: look.en, tagline: look.tagline,
        palette: look.palette, lookId: look.id, showTeach: false
      });
    });

    // 账号
    refreshAccountUI();
    renderSkinProfile();
    renderRecommend();
    $('#account-current').addEventListener('click', openAccountModal);
    $('#btn-manage-accounts').addEventListener('click', openAccountModal);

    // 弹窗关闭：点遮罩、按 ESC
    $('#modal-backdrop').addEventListener('click', function (e) {
      if (e.target === $('#modal-backdrop')) closeModal();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !$('#modal-backdrop').classList.contains('hidden')) closeModal();
    });

    // 设置
    loadSettingsUI();
    renderPersonalize();
    $('#cfg-provider').addEventListener('change', syncProviderDefaults);
    $('#btn-save-cfg').addEventListener('click', saveSettings);
    $('#btn-test-cfg').addEventListener('click', testSettings);
    $('#btn-reset-cfg').addEventListener('click', resetSettings);
    $('#btn-save-token').addEventListener('click', saveTokenSettings);

    // 显示 / 隐藏已保存的 API Key
    $('#btn-eye-key').addEventListener('click', function () {
      const inp = $('#cfg-key');
      const show = inp.type === 'password';
      inp.type = show ? 'text' : 'password';
      this.textContent = show ? '🙈 隐藏' : '👁 显示';
    });
    // 一键复制（方便填到 Cloudflare 环境变量里）
    $('#btn-copy-key').addEventListener('click', async function () {
      const btn = this;
      const v = ($('#cfg-key').value || '').trim();
      if (!v) { toast('还没有填写 API Key', { type: 'warn' }); return; }
      let ok = false;
      try {
        await navigator.clipboard.writeText(v);
        ok = true;
      } catch (e) {
        // 剪贴板不可用时退回到手动选中
        const inp = $('#cfg-key');
        const wasPwd = inp.type === 'password';
        inp.type = 'text';
        inp.select();
        ok = document.execCommand && document.execCommand('copy');
        if (!wasPwd) { /* 保持可见，方便手动复制 */ }
      }
      if (ok) {
        btn.textContent = '已复制';
        btn.classList.add('copied');
        toast('API Key 已复制到剪贴板');
        setTimeout(function () { btn.textContent = '复制'; btn.classList.remove('copied'); }, 2200);
      } else {
        toast('自动复制失败，请手动选中后按 Ctrl+C', { type: 'warn', duration: 4000 });
      }
    });

    // 网络状态
    initNetWatch();

    // 移动端导航栏随滚动收起
    initMobileNav();

    // 路由：浏览器返回键 / 前进键 / 直接改地址 都会走这里
    window.addEventListener('hashchange', applyRoute);
    applyRoute();     // 首次进入按当前地址渲染
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
