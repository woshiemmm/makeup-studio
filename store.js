/* ============================================================
 * store.js — 本地账号系统 + 用户数据存储
 * ------------------------------------------------------------
 * 完全基于浏览器本地存储（localStorage），不需要服务器：
 *   · 可创建 / 切换 / 重命名 / 删除多个账号
 *   · 每个账号拥有独立数据：自定义妆容、肤质档案
 *   · 数据只存在你自己的浏览器里，不会上传到任何地方
 *
 * 注意：清除浏览器数据会一并清除账号与妆容。如需跨设备同步，
 *       需要接云端数据库（Cloudflare D1），见 DEPLOY.md。
 * ============================================================ */
window.STORE = (function () {
  'use strict';

  const ACC_KEY = 'makeup_accounts_v1';       // { accounts:[...], currentId }
  const DATA_PREFIX = 'makeup_userdata_v1_';  // makeup_userdata_v1_<accountId>
  const MAX_LOOKS = 40;                       // 每个账号最多保存的妆容数

  const AVATAR_COLORS = ['#ec5f8a', '#e6a65b', '#5b8fd9', '#4cb482', '#a06fd9', '#e07a5f', '#3f8f8f', '#c4456c'];

  function uid(prefix) {
    return (prefix || 'id') + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  function readJSON(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) { return fallback; }
  }

  /* 写入失败（通常是超出配额）会返回 false，由调用方提示用户 */
  function writeJSON(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (e) {
      return false;
    }
  }

  function pickColor(accounts) {
    return AVATAR_COLORS[accounts.length % AVATAR_COLORS.length];
  }

  /* ---------------- 账号 ---------------- */
  function loadAccounts() {
    let state = readJSON(ACC_KEY, null);
    if (!state || !Array.isArray(state.accounts) || state.accounts.length === 0) {
      state = { accounts: [], currentId: '' };
      const first = {
        id: uid('acc'),
        name: '我的账号',
        color: AVATAR_COLORS[0],
        createdAt: Date.now()
      };
      state.accounts.push(first);
      state.currentId = first.id;
      writeJSON(ACC_KEY, state);
    }
    if (!state.accounts.some(function (a) { return a.id === state.currentId; })) {
      state.currentId = state.accounts[0].id;
      writeJSON(ACC_KEY, state);
    }
    return state;
  }

  function saveAccounts(state) { return writeJSON(ACC_KEY, state); }

  function listAccounts() { return loadAccounts().accounts; }

  function currentAccount() {
    const state = loadAccounts();
    return state.accounts.find(function (a) { return a.id === state.currentId; }) || state.accounts[0];
  }

  function createAccount(name) {
    const state = loadAccounts();
    const nick = String(name || '').trim() || ('账号 ' + (state.accounts.length + 1));
    const acc = { id: uid('acc'), name: nick.slice(0, 20), color: pickColor(state.accounts), createdAt: Date.now() };
    state.accounts.push(acc);
    state.currentId = acc.id;
    if (!saveAccounts(state)) return null;
    return acc;
  }

  function switchAccount(id) {
    const state = loadAccounts();
    if (!state.accounts.some(function (a) { return a.id === id; })) return false;
    state.currentId = id;
    return saveAccounts(state);
  }

  function renameAccount(id, name) {
    const state = loadAccounts();
    const acc = state.accounts.find(function (a) { return a.id === id; });
    if (!acc) return false;
    const nick = String(name || '').trim();
    if (!nick) return false;
    acc.name = nick.slice(0, 20);
    return saveAccounts(state);
  }

  /* 删除账号并清掉它的数据；至少保留一个账号 */
  function deleteAccount(id) {
    const state = loadAccounts();
    if (state.accounts.length <= 1) return { ok: false, reason: 'last' };
    const idx = state.accounts.findIndex(function (a) { return a.id === id; });
    if (idx === -1) return { ok: false, reason: 'notfound' };
    state.accounts.splice(idx, 1);
    if (state.currentId === id) state.currentId = state.accounts[0].id;
    try { localStorage.removeItem(DATA_PREFIX + id); } catch (e) { /* ignore */ }
    return { ok: saveAccounts(state) };
  }

  /* ---------------- 账号数据 ---------------- */
  function dataKey(accountId) {
    return DATA_PREFIX + (accountId || currentAccount().id);
  }

  function defaultData() {
    return { myLooks: [], skinProfile: null, prefs: null, checklist: {}, updatedAt: Date.now() };
  }

  function getData(accountId) {
    const d = readJSON(dataKey(accountId), null);
    if (!d) return defaultData();
    if (!Array.isArray(d.myLooks)) d.myLooks = [];
    return d;
  }

  function saveData(data, accountId) {
    data.updatedAt = Date.now();
    return writeJSON(dataKey(accountId), data);
  }

  /* ---------------- 自定义妆容 ---------------- */
  function listLooks(accountId) { return getData(accountId).myLooks || []; }

  function addLook(look, accountId) {
    const data = getData(accountId);
    if (data.myLooks.length >= MAX_LOOKS) {
      return { ok: false, reason: 'limit', limit: MAX_LOOKS };
    }
    const item = {
      id: uid('look'),
      name: String(look.name || '').trim().slice(0, 24) || '未命名妆容',
      note: String(look.note || '').slice(0, 200),
      baseLookId: look.baseLookId || 'natural',
      confidence: look.confidence || 0,
      palette: (look.palette || []).slice(0, 6),
      image: look.image || '',
      createdAt: Date.now()
    };
    data.myLooks.unshift(item);
    const ok = saveData(data, accountId);
    if (!ok) {
      data.myLooks.shift();
      return { ok: false, reason: 'quota' };
    }
    return { ok: true, item: item };
  }

  function updateLook(id, patch, accountId) {
    const data = getData(accountId);
    const item = data.myLooks.find(function (l) { return l.id === id; });
    if (!item) return { ok: false, reason: 'notfound' };
    if (patch.name != null) item.name = String(patch.name).trim().slice(0, 24) || item.name;
    if (patch.note != null) item.note = String(patch.note).slice(0, 200);
    if (patch.image != null) item.image = patch.image;
    return { ok: saveData(data, accountId), item: item };
  }

  function deleteLook(id, accountId) {
    const data = getData(accountId);
    const before = data.myLooks.length;
    data.myLooks = data.myLooks.filter(function (l) { return l.id !== id; });
    if (data.myLooks.length === before) return { ok: false, reason: 'notfound' };
    return { ok: saveData(data, accountId) };
  }

  /* ---------------- 肤质档案 ---------------- */
  function saveSkinProfile(profile, accountId) {
    const data = getData(accountId);
    data.skinProfile = Object.assign({}, profile, { savedAt: Date.now() });
    return { ok: saveData(data, accountId), profile: data.skinProfile };
  }

  function getSkinProfile(accountId) { return getData(accountId).skinProfile; }

  function clearSkinProfile(accountId) {
    const data = getData(accountId);
    data.skinProfile = null;
    return { ok: saveData(data, accountId) };
  }

  /* ---------------- 化妆辅助偏好（眼型 / 脸型 / 参考线 / 自检清单） ---------------- */
  const DEFAULT_PREFS = {
    eye: '', face: '', grid: false, checklist: false, tier: '',
    customKw: '',         // 自定义档位：搜索关键词
    customPrice: '',      // 自定义档位：价格区间
    budgetTotal: 0,       // 总预算模式的金额（元），0 表示未设置
    budgetPreset: 'makeup', // 总预算套餐：makeup（彩妆全妆）/ all（彩妆+护肤）
    theme: 'rose',        // 界面主题配色
    showShop: true,       // 是否显示化妆品购买入口
    guide: true           // 是否显示新手辅助（手法技巧 / 画错补救）
  };

  function getPrefs(accountId) {
    const d = getData(accountId);
    return Object.assign({}, DEFAULT_PREFS, d.prefs || {});
  }

  function setPrefs(patch, accountId) {
    const d = getData(accountId);
    d.prefs = Object.assign({}, DEFAULT_PREFS, d.prefs || {}, patch || {});
    return { ok: saveData(d, accountId), prefs: d.prefs };
  }

  /* 自检清单勾选状态：{ '<lookId>:<stageIdx>': [0, 2] } */
  function getChecklist(key, accountId) {
    const d = getData(accountId);
    return (d.checklist && d.checklist[key]) || [];
  }

  function setChecklist(key, arr, accountId) {
    const d = getData(accountId);
    if (!d.checklist) d.checklist = {};
    d.checklist[key] = arr || [];
    return { ok: saveData(d, accountId) };
  }

  function clearChecklist(key, accountId) { return setChecklist(key, [], accountId); }

  /* ---------------- 妆容实拍参考图（按妆容 id 存） ---------------- */
  const PHOTO_KEY = 'makeup_look_photos_v1';

  function listLookPhotos() { return readJSON(PHOTO_KEY, {}); }

  function getLookPhoto(lookId) {
    if (!lookId) return '';
    return listLookPhotos()[lookId] || '';
  }

  function setLookPhoto(lookId, dataUrl) {
    if (!lookId) return { ok: false, reason: 'noid' };
    const all = listLookPhotos();
    if (dataUrl) {
      all[lookId] = dataUrl;
    } else {
      delete all[lookId];
    }
    const ok = writeJSON(PHOTO_KEY, all);
    if (!ok && dataUrl) return { ok: false, reason: 'quota' };
    return { ok: true };
  }

  function clearAllLookPhotos() { return writeJSON(PHOTO_KEY, {}); }

  /* ---------------- 用量信息 ---------------- */
  function usage() {
    let bytes = 0;
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.indexOf('makeup_') === 0) {
          bytes += (localStorage.getItem(k) || '').length + k.length;
        }
      }
    } catch (e) { /* ignore */ }
    // 粗略估算：UTF-16 每字符约 2 字节
    const usedMB = (bytes * 2) / 1048576;
    return { usedMB: usedMB, approxLimitMB: 5, percent: Math.min(100, (usedMB / 5) * 100) };
  }

  return {
    MAX_LOOKS: MAX_LOOKS,
    AVATAR_COLORS: AVATAR_COLORS,
    listAccounts: listAccounts,
    currentAccount: currentAccount,
    createAccount: createAccount,
    switchAccount: switchAccount,
    renameAccount: renameAccount,
    deleteAccount: deleteAccount,
    listLooks: listLooks,
    addLook: addLook,
    updateLook: updateLook,
    deleteLook: deleteLook,
    saveSkinProfile: saveSkinProfile,
    getSkinProfile: getSkinProfile,
    clearSkinProfile: clearSkinProfile,
    getLookPhoto: getLookPhoto,
    setLookPhoto: setLookPhoto,
    clearAllLookPhotos: clearAllLookPhotos,
    getPrefs: getPrefs,
    setPrefs: setPrefs,
    getChecklist: getChecklist,
    setChecklist: setChecklist,
    clearChecklist: clearChecklist,
    usage: usage
  };
})();
