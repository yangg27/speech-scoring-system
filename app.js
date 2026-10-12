/* =========================================================================
   演讲比赛评分系统 —— 单页应用
   后端：WorkBuddy 云服务（PostgreSQL + PostgREST，匿名可读写）
   ========================================================================= */

/* ---------------- 1. 云服务配置 ----------------
   ⚠️ 请替换为你自己的 WorkBuddy 云服务配置（详见 docs/SETUP.md）。
   获取方式：在 WorkBuddy 中创建云服务应用后，读取 .workbuddy/applications.yaml
   及云服务凭据，endpoint 形如 https://<你的应用>.app.workbuddy.host，
   publishableKey 以 wbpk_ 开头。
   注意：publishableKey 是前端公钥，会随前端代码公开，这是设计如此；
   真正的安全边界由数据库 RLS 策略控制。 */
const PUBLIC_CONFIG = {
  endpoint: 'https://YOUR-APP.app.workbuddy.host',
  publishableKey: 'wbpk_REPLACE_WITH_YOUR_KEY'
};

let cloud = null;
try {
  cloud = WorkBuddyCloud.createWorkBuddyCloud({
    endpoint: PUBLIC_CONFIG.endpoint,
    publishableKey: PUBLIC_CONFIG.publishableKey
  });
} catch (e) { console.error('cloud init failed', e); }

/* ---------------- 2. 通用工具 ---------------- */
const $  = (s, r) => (r || document).querySelector(s);
const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));

function esc(s){
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
function uid(p){ return (p || 'd') + Math.random().toString(36).slice(2, 9); }
function num(v, d){ const n = Number(v); return isNaN(n) ? (d === undefined ? 0 : d) : n; }
function fx(v, digits){
  if (v === null || v === undefined || v === '' || isNaN(Number(v))) return '—';
  const d = digits === undefined ? 2 : digits;
  return (Math.round(Number(v) * Math.pow(10, d)) / Math.pow(10, d)).toFixed(d);
}
function fmtTime(iso){
  if (!iso) return '';
  const d = new Date(iso);
  const p = n => String(n).padStart(2, '0');
  return p(d.getMonth()+1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}
function pad2(n){ return String(n).padStart(2, '0'); }

let toastTimer = null;
function toast(msg, type){
  const el = $('#toast');
  el.textContent = msg;
  el.className = 'show ' + (type || '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = ''; }, 2600);
}

function modal(html){
  const m = document.createElement('div');
  m.className = 'mask';
  m.innerHTML = '<div class="modal">' + html + '</div>';
  m.addEventListener('click', e => { if (e.target === m) m.remove(); });
  document.body.appendChild(m);
  return m;
}
function closeModal(m){ if (m && m.parentNode) m.remove(); }

function confirmBox(title, desc, okText, danger){
  return new Promise(resolve => {
    const m = modal(
      '<h3>' + esc(title) + '</h3><p>' + desc + '</p>' +
      '<div class="row-btns">' +
        '<button class="btn" data-x="no">取消</button>' +
        '<button class="btn ' + (danger ? 'btn-d' : 'btn-p') + '" data-x="yes">' + esc(okText || '确定') + '</button>' +
      '</div>');
    m.addEventListener('click', e => {
      const b = e.target.closest('[data-x]');
      if (!b) return;
      const v = b.dataset.x === 'yes';
      closeModal(m);
      resolve(v);
    });
  });
}

function promptBox(title, desc, defVal, placeholder){
  return new Promise(resolve => {
    let done = false;
    const m = modal(
      '<h3>' + esc(title) + '</h3>' +
      (desc ? '<p>' + desc + '</p>' : '') +
      '<div class="field"><input class="inp" id="__pb" value="' + esc(defVal || '') + '" placeholder="' + esc(placeholder || '') + '"></div>' +
      '<div class="row-btns">' +
        '<button class="btn" data-x="no">取消</button>' +
        '<button class="btn btn-p" data-x="yes">确定</button>' +
      '</div>');
    const inp = $('#__pb', m);
    setTimeout(() => { inp && inp.focus(); }, 60);
    const finish = v => { if (done) return; done = true; closeModal(m); resolve(v); };
    m.addEventListener('click', e => {
      const b = e.target.closest('[data-x]');
      if (!b) return;
      finish(b.dataset.x === 'yes' ? (inp ? inp.value.trim() : '') : null);
    });
    m.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target === inp) finish(inp.value.trim()); });
  });
}

async function copyText(text, tip){
  try {
    if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(text);
    else {
      const ta = document.createElement('textarea');
      ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select(); document.execCommand('copy'); ta.remove();
    }
    toast(tip || '已复制', 'ok');
    return true;
  } catch (e) { toast('复制失败，请手动复制', 'err'); return false; }
}

function download(name, content, mime){
  const blob = new Blob([content], { type: (mime || 'text/plain') + ';charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 400);
}
function csvCell(v){
  const s = String(v == null ? '' : v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function toCSV(rows){ return '\uFEFF' + rows.map(r => r.map(csvCell).join(',')).join('\r\n'); }

/* ---------------- 3. 数据层 ---------------- */
async function unwrap(promise){
  const { data, error } = await promise;
  if (error) { const e = new Error(error.message || '数据库操作失败'); e.code = error.code; throw e; }
  return data;
}
/* 云服务 SDK 回调错误码形如 DATABASE_23505 / DATABASE_42P01，此处归一化处理 */
function normalizeCode(e){
  const raw = String((e && (e.code || e.statusCode)) || '');
  const m = raw.match(/([0-9A-Z]{5})$/);
  if (/^DATABASE_/.test(raw)) return raw.replace(/^DATABASE_/, '');
  if (m && /^(23|42|P0)/.test(m[1])) return m[1];
  return raw;
}
function dbErr(e){
  const c = normalizeCode(e);
  if (c === '23505') return '该评委对此选手已评过分，请勿重复提交';
  if (c === '23503') return '关联的数据不存在，请刷新后重试';
  if (c === '42501') return '没有权限执行该操作';
  if (c === '42P01') return '数据表不存在，请检查后端初始化';
  if (c === '22001') return '输入内容过长，请精简后重试';
  if (c === '22P02') return '输入格式不正确';
  if (e && e.message && /fetch|network|Failed to fetch/i.test(e.message)) return '网络异常，请检查网络后重试';
  const msg = (e && e.message) || '';
  if (/duplicate key/i.test(msg)) return '该记录已存在，请勿重复提交';
  return msg || '操作失败，请重试';
}

const DB = {
  async listEvents(){
    return (await unwrap(cloud.database.from('events').select('*').order('created_at', { ascending: false }))) || [];
  },
  async getEvent(id){
    return await unwrap(cloud.database.from('events').select('*').eq('id', id).maybeSingle());
  },
  async createEvent(p){
    const d = await unwrap(cloud.database.from('events').insert(p).select());
    return d && d[0];
  },
  async updateEvent(id, patch){
    const d = await unwrap(cloud.database.from('events').update(patch).eq('id', id).select());
    return d && d[0];
  },
  async deleteEvent(id){ await unwrap(cloud.database.from('events').delete().eq('id', id).select()); },

  async listSpeakers(eid){
    return (await unwrap(cloud.database.from('speakers').select('*').eq('event_id', eid).order('seq', { ascending: true }))) || [];
  },
  async addSpeakers(rows){ return (await unwrap(cloud.database.from('speakers').insert(rows).select())) || []; },
  async updateSpeaker(id, patch){
    const d = await unwrap(cloud.database.from('speakers').update(patch).eq('id', id).select());
    return d && d[0];
  },
  async deleteSpeaker(id){ await unwrap(cloud.database.from('speakers').delete().eq('id', id).select()); },

  async listScores(eid){
    return (await unwrap(cloud.database.from('scores').select('*').eq('event_id', eid))) || [];
  },
  async insertScore(p){
    const d = await unwrap(cloud.database.from('scores').insert(p).select());
    return d && d[0];
  },
  async updateScore(id, patch){
    const d = await unwrap(cloud.database.from('scores').update(patch).eq('id', id).select());
    return d && d[0];
  },
  async deleteScore(id){ await unwrap(cloud.database.from('scores').delete().eq('id', id).select()); },

  async getConfig(key){
    const d = await unwrap(cloud.database.from('app_config').select('*').eq('cfg_key', key).maybeSingle());
    return d ? d.cfg_value : null;
  },
  async setConfig(key, value){
    await unwrap(cloud.database.from('app_config').upsert({ cfg_key: key, cfg_value: value, updated_at: new Date().toISOString() }));
  }
};

/* ---------------- 4. 计分引擎 ---------------- */
const DEFAULT_DIMS = [
  { id: 'd_topic', name: '主题内容', max: 30, weight: 1 },
  { id: 'd_lang',  name: '语言表达', max: 30, weight: 1 },
  { id: 'd_stage', name: '台风仪表', max: 20, weight: 1 },
  { id: 'd_time',  name: '时间控制', max: 20, weight: 1 }
];
const DEFAULT_SETTINGS = { dropHighest: false, dropLowest: false, dropCount: 1 };

/* 维度归一化
   支持两种形态：
   ① 扁平（旧）：{ id, name, max, weight }
   ② 分组（新）：{ id, group: '一、实战内容质量（50分）', name: '二级细则名', max, weight,
                   desc: '打分标准全文', tiers: '15/11/7' }  —— 档位用斜杠分隔的满分数值
   分组仅用于展示与汇总，打分仍以二级细则为单位。 */
function normDims(raw){
  let arr = raw;
  if (typeof arr === 'string') { try { arr = JSON.parse(arr); } catch (e) { arr = null; } }
  if (!Array.isArray(arr) || !arr.length) return DEFAULT_DIMS.map(d => Object.assign({}, d));
  return arr.map(d => ({
    id: d.id || uid(),
    group: d.group ? String(d.group) : '',
    name: String(d.name || '维度'),
    max: num(d.max, 10),
    weight: num(d.weight, 1) || 1,
    desc: d.desc ? String(d.desc) : '',
    tiers: d.tiers ? String(d.tiers) : ''
  }));
}
/* 解析档位：'15/11/7' → [{label:'优',value:15},...]
   档位标签按分值从高到低自动命名 */
const TIER_LABELS = ['优', '良', '中', '待改进', '差'];
function parseTiers(tiers, max){
  if (!tiers) return [];
  const parts = String(tiers).split(/[\/、,，\s]+/).map(x => num(x, NaN)).filter(v => !isNaN(v) && v > 0);
  if (!parts.length) return [];
  return parts.map((v, i) => ({ label: TIER_LABELS[i] || ('档' + (i + 1)), value: v }));
}
/* 按分组归并，返回 [{group, dims:[...], max}]；无分组时全部归入空组 */
function groupDims(dims){
  const out = [];
  const idx = {};
  dims.forEach(d => {
    const g = d.group || '';
    if (!(g in idx)) { idx[g] = out.length; out.push({ group: g, dims: [], max: 0 }); }
    const slot = out[idx[g]];
    slot.dims.push(d);
    slot.max += num(d.max, 0) * num(d.weight, 1);
  });
  return out;
}
/* 预设评委名单归一化
   支持两种录入格式：
   ① 纯姓名：张三
   ② 姓名,单位：张三,示例集团   （逗号可中英文/制表符）
   也兼容已是对象数组的形态 */
function normJudges(raw){
  let arr = raw;
  if (typeof arr === 'string') { try { arr = JSON.parse(arr); } catch (e) { arr = null; } }
  if (!Array.isArray(arr)) return [];
  return arr.map(j => {
    if (j && typeof j === 'object') {
      return { name: String(j.name || '').trim(), dept: String(j.dept || j.department || '').trim() };
    }
    const parts = String(j == null ? '' : j).split(/[,，\t]+/).map(x => x.trim());
    return { name: parts[0] || '', dept: parts[1] || '' };
  }).filter(j => j.name);
}
function normSettings(raw){
  let o = raw;
  if (typeof o === 'string') { try { o = JSON.parse(o); } catch (e) { o = null; } }
  return Object.assign({}, DEFAULT_SETTINGS, o || {});
}
/* 被移除的评委（其评分不计入统计，但数据保留可恢复） */
function normExcluded(raw){
  let a = raw;
  if (typeof a === 'string') { try { a = JSON.parse(a); } catch (e) { a = null; } }
  if (!Array.isArray(a)) return [];
  return a.map(x => String(x == null ? '' : (x && typeof x === 'object' ? x.name : x)).trim()).filter(Boolean);
}

function computeResults(event, speakers, scores){
  const dims = normDims(event && event.dimensions);
  const st = normSettings(event && event.settings);
  const dropHigh = !!st.dropHighest, dropLow = !!st.dropLowest;
  const dropN = Math.max(1, Math.round(num(st.dropCount, 1)));

  /* 被移除评委的评分：保留在库里，但不参与任何统计（可随时恢复） */
  const excluded = normExcluded(st.excludedJudges);
  const isExcluded = n => excluded.indexOf(String(n)) >= 0;
  const allScores = scores || [];
  const activeScores = allScores.filter(s => !isExcluded(s.judge_name));

  const judges = Array.from(new Set(activeScores.map(s => s.judge_name))).sort((a, b) => a.localeCompare(b, 'zh'));

  const rows = speakers.map(sp => {
    const mine = activeScores.filter(s => String(s.speaker_id) === String(sp.id));
    const dimOut = {};
    let total = 0, rawTotal = 0, maxTotal = 0, scoredDims = 0;

    dims.forEach(d => {
      const mx = num(d.max, 0);
      maxTotal += mx;
      const vals = mine.map(r => {
        const v = r.scores ? r.scores[d.id] : null;
        return (v === null || v === undefined || v === '') ? null : Number(v);
      }).filter(v => v !== null && !isNaN(v));

      let used = vals.slice().sort((a, b) => a - b);
      const removed = [];
      if (vals.length >= (2 * dropN + 1)) {
        if (dropHigh) for (let i = 0; i < dropN; i++) removed.push(used.pop());
        if (dropLow)  for (let i = 0; i < dropN; i++) removed.push(used.shift());
      }
      const avg = used.length ? used.reduce((a, b) => a + b, 0) / used.length : null;
      const rawAvg = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
      const gains = used.length ? (Math.max.apply(null, used.length ? used : [0]) - Math.min.apply(null, used.length ? used : [0])) : null;

      dimOut[d.id] = { id: d.id, name: d.name, max: mx, weight: num(d.weight, 1),
        vals, count: vals.length, avg, rawAvg, removed, spread: gains,
        rate: (avg !== null && mx > 0) ? avg / mx : null };
      if (avg !== null) { total += avg * num(d.weight, 1); rawTotal += rawAvg * num(d.weight, 1); scoredDims++; }
    });

    const wMax = dims.reduce((a, d) => a + num(d.max, 0) * num(d.weight, 1), 0);
    return {
      speaker: sp, dims: dimOut,
      total: scoredDims > 0 ? total : 0,
      rawTotal: scoredDims > 0 ? rawTotal : 0,
      maxTotal: wMax,
      judgeCount: mine.length,
      rate: wMax > 0 ? total / wMax : 0,
      complete: dims.length > 0 && scoredDims === dims.length,
      scoredDims, allDims: dims.length
    };
  });

  const ranked = rows.slice().sort((a, b) => {
    if (Math.abs(b.total - a.total) > 1e-9) return b.total - a.total;
    return num(a.speaker.seq) - num(b.speaker.seq);
  });
  ranked.forEach((r, i) => {
    r.rank = (i > 0 && Math.abs(ranked[i-1].total - r.total) < 1e-9) ? ranked[i-1].rank : (i + 1);
  });

  const judgeStats = judges.map(j => {
    const js = activeScores.filter(s => s.judge_name === j);
    let sum = 0, cnt = 0, lastAt = null;
    const spkSet = new Set();
    js.forEach(s => {
      spkSet.add(String(s.speaker_id));
      dims.forEach(d => {
        const v = s.scores ? s.scores[d.id] : null;
        if (v !== null && v !== undefined && v !== '') { sum += Number(v); cnt++; }
      });
      if (s.updated_at && (!lastAt || s.updated_at > lastAt)) lastAt = s.updated_at;
      if (s.created_at && (!lastAt || s.created_at > lastAt)) lastAt = s.created_at;
    });
    const mx = dims.reduce((a, d) => a + num(d.max, 0), 0);
    return { name: j, avg: cnt ? sum / cnt : null, maxTotal: mx, scored: spkSet.size,
      total: speakers.length, lastAt, rate: speakers.length ? spkSet.size / speakers.length : 0,
      preset: false };
  });

  /* 合并预设评委名单：名单里未提交的也要显示（标记未提交），
     不在名单但实际提交了的同样保留（不隐藏真实数据） */
  const presetJudges = normJudges(st.judgeRoster);
  const statByName = {};
  judgeStats.forEach(j => { statByName[j.name] = j; });
  const mergedStats = presetJudges.map(p => {
    const hit = statByName[p.name];
    if (hit) { hit.preset = true; hit.dept = p.dept; return hit; }
    return { name: p.name, dept: p.dept, avg: null, maxTotal: dims.reduce((a, d) => a + num(d.max, 0), 0),
      scored: 0, total: speakers.length, lastAt: null, rate: 0, preset: true, idle: true };
  });
  judgeStats.forEach(j => { if (!presetJudges.some(p => p.name === j.name)) mergedStats.push(j); });
  /* 排序：已提交的按提交量降序在前，未提交的排后 */
  mergedStats.sort((a, b) => (b.scored - a.scored) || a.name.localeCompare(b.name, 'zh'));

  /* 大屏/概览用的评委总数：优先取预设名单口径（活动开始前就能看到应有几人） */
  const judgeTotal = mergedStats.length;

  /* ---- 被移除评委：列出其历史评分条数，供管理台恢复时参考 ---- */
  const excludedStats = excluded.map(n => {
    const js = allScores.filter(s => String(s.judge_name) === n);
    const rosterHit = presetJudges.find(p => p.name === n);
    return { name: n, dept: rosterHit ? rosterHit.dept : '',
      scored: new Set(js.map(s => String(s.speaker_id))).size, total: speakers.length, records: js.length };
  });

  /* ---- 异常留痕检测：同设备 / 同IP 出现多个评委名 ----
     只做告警不做拦截：会场共用 WiFi 会让所有评委出口 IP 相同（按 IP 拦=全场瘫痪），
     设备指纹也可能被清缓存绕过。故交给管理员人工判断。 */
  const byDev = {}, byIp = {}, seen = {};
  allScores.forEach(s => {
    const m = s.meta || {};
    const nm = String(s.judge_name);
    if (m.device_id) { (byDev[m.device_id] = byDev[m.device_id] || new Set()).add(nm); }
    if (m.ip) { (byIp[m.ip] = byIp[m.ip] || new Set()).add(nm); }
    const key = nm + '|' + (m.device_id || '');
    if (m.device_id) seen[key] = true;
  });
  const deviceAlerts = Object.keys(byDev).map(k => ({ device: k, judges: Array.from(byDev[k]).sort() }))
    .filter(x => x.judges.length > 1).sort((a, b) => b.judges.length - a.judges.length);
  const ipAlerts = Object.keys(byIp).map(k => ({ ip: k, judges: Array.from(byIp[k]).sort() }))
    .filter(x => x.judges.length > 1).sort((a, b) => b.judges.length - a.judges.length);
  /* 同一（设备,评委名）组合写入过多次不同来源，说明中途换过评委 */
  const switchLogs = [];
  allScores.forEach(s => {
    const m = s.meta || {};
    if (m.from_judge && String(m.from_judge) !== String(s.judge_name)) {
      switchLogs.push({ at: m.switched_at || s.created_at, device: m.device_id || '', from: m.from_judge,
        to: String(s.judge_name), approved: !!m.switch_approved, ip: m.ip || '', loc: m.loc || '' });
    }
  });
  switchLogs.sort((a, b) => String(b.at).localeCompare(String(a.at)));

  const dimStats = dims.map(d => {
    const vals = [];
    rows.forEach(r => { const o = r.dims[d.id]; if (o && o.avg !== null) vals.push(o.avg); });
    const avg = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
    const mx = num(d.max, 0);
    return { id: d.id, name: d.name, max: mx, weight: num(d.weight, 1), avg, rate: mx > 0 ? avg / mx : 0, count: vals.length };
  });

  const wMax = rows.length ? rows[0].maxTotal : dims.reduce((a, d) => a + num(d.max, 0) * num(d.weight, 1), 0);

  /* 一级分组汇总：把二级细则得分归并到大项，用于分析页与评委端展示 */
  const gdefs = groupDims(dims);
  const groups = gdefs.map(g => {
    const perSpeaker = rows.map(r => {
      let got = 0, full = 0, has = false;
      g.dims.forEach(d => {
        const o = r.dims[d.id];
        full += num(d.max, 0) * num(d.weight, 1);
        if (o && o.avg !== null) { got += o.avg * num(d.weight, 1); has = true; }
      });
      return { speaker: r.speaker, got: has ? got : null, full };
    });
    const vals = perSpeaker.filter(x => x.got !== null).map(x => x.got);
    const avg = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
    return {
      group: g.group, dims: g.dims, max: g.max,
      perSpeaker, avg, rate: g.max > 0 ? avg / g.max : 0
    };
  });

  return { rows, ranked, judges, judgeStats: mergedStats, judgeTotal, presetJudges,
    dimStats, dims, groups, settings: st, wMax,
    excluded, excludedStats, activeScores, allScores, deviceAlerts, ipAlerts, switchLogs };
}

/* ---------------- 5. 全局状态 ---------------- */
const S = {
  route: { path: '/', params: new URLSearchParams() },
  events: [], event: null, speakers: [], scores: [],
  tab: 'overview', judgeName: '', editingSpeakerId: null, timer: null, busy: false
};

const LS = {
  get(k, d){ try { const v = localStorage.getItem(k); return v === null ? d : v; } catch (e) { return d; } },
  set(k, v){ try { localStorage.setItem(k, v); } catch (e) {} },
  del(k){ try { localStorage.removeItem(k); } catch (e) {} }
};
function adminPin(){ return LS.get('sp_admin_pin', ''); }
function adminUnlocked(){ return LS.get('sp_admin_ok', '') === '1'; }
function judgeNameKey(eid){ return 'sp_judge_' + eid; }
function devBindKey(eid){ return 'sp_dev_bind_' + eid; }
function devHistKey(eid){ return 'sp_dev_hist_' + eid; }

/* 管理口令校验（评委端放行也要用） */
async function verifyAdminPin(v){
  let pin = adminPin();
  if (!pin) {
    try { pin = await DB.getConfig('admin_pin'); } catch (e) {}
    if (!pin) pin = 'admin888';
    LS.set('sp_admin_pin', pin);
  }
  return String(v || '').trim() === String(pin).trim();
}

/* ---- 设备/网络留痕 ----
   作用：① 同一台设备反复换评委名时留下证据；② 管理台可核对异常。
   局限（如实说明，不夸大）：清缓存/无痕窗口会换新 deviceId，指纹只能提高门槛，
   不能百分百识别有心造假；真正可靠的是"本机锁定 + 现场管理"。 */
function deviceId(){
  let v = LS.get('sp_device_id', '');
  if (!v) {
    v = 'dev_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
    LS.set('sp_device_id', v);
  }
  return v;
}
function uaShort(){
  const ua = navigator.userAgent || '';
  const m = ua.match(/(MicroMessenger|Edg|Chrome|Firefox|Safari)[\/\s]([\d.]+)/);
  return m ? (m[1] + ' ' + m[2]) : ua.slice(0, 40);
}
let _ipCache = null, _ipPending = null;
/* 出口 IP：评委可能共用会场同一个 WiFi，故仅留痕 + 告警，绝不做硬拦截 */
function fetchIp(){
  if (_ipCache) return Promise.resolve(_ipCache);
  if (_ipPending) return _ipPending;
  _ipPending = new Promise(resolve => {
    let done = false;
    const finish = r => { if (!done) { done = true; resolve(r); } };
    const ctl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    const t = setTimeout(() => { if (ctl) ctl.abort(); finish(null); }, 3500);
    try {
      fetch('https://myip.ipip.net/json', ctl ? { signal: ctl.signal } : undefined)
        .then(r => r.json())
        .then(d => {
          const ip = d && d.data && d.data.ip;
          const loc = ((d && d.data && d.data.location) || []).filter(Boolean).join(' ');
          if (ip) _ipCache = { ip: ip, loc: loc, at: new Date().toISOString() };
          clearTimeout(t); finish(_ipCache);
        })
        .catch(() => { clearTimeout(t); finish(null); });
    } catch (e) { clearTimeout(t); finish(null); }
  });
  return _ipPending;
}
/* 本机绑定的评委（用于防一人多评） */
function devBound(eid){
  let o = LS.get(devBindKey(eid), '');
  if (!o) return null;
  try { o = JSON.parse(o); } catch (e) { return null; }
  return (o && o.judge) ? o : null;
}
function devHistory(eid){
  let a = LS.get(devHistKey(eid), '');
  if (!a) return [];
  try { a = JSON.parse(a); } catch (e) { return []; }
  return Array.isArray(a) ? a : [];
}
function pushDevHistory(eid, from, to, approved){
  const a = devHistory(eid);
  a.push({ from: from || '', to: to || '', at: new Date().toISOString(), approved: !!approved });
  LS.set(devHistKey(eid), JSON.stringify(a.slice(-20)));
}

function judgeLink(eid){ return location.origin + location.pathname + '#/judge?e=' + eid; }
function boardLink(eid){ return location.origin + location.pathname + '#/board?e=' + eid; }

/* 二维码生成（本地库 qrcode-generator，无 CDN 依赖）
   返回 <img> 的 dataURL；typeNumber=0 表示自动选择版本 */
function makeQR(text, px){
  try {
    if (typeof qrcode === 'undefined') return null;
    const size = px || 212;
    const qr = qrcode(0, 'M');
    qr.addData(String(text));
    qr.make();
    /* 单元格大小按目标尺寸估算：模块数 = getModuleCount() */
    const count = qr.getModuleCount();
    const cell = Math.max(2, Math.floor(size / (count + 4)));
    return { src: qr.createDataURL(cell, cell), modules: count };
  } catch (e) {
    console.warn('QR gen failed', e);
    return null;
  }
}
function renderQR(container, text, px){
  if (!container) return false;
  const r = makeQR(text, px);
  if (!r) { container.innerHTML = '<div class="hint" style="color:#dc2626">二维码生成失败</div>'; return false; }
  container.innerHTML = '<img alt="二维码" src="' + r.src + '" style="width:212px;height:212px;display:block">';
  return true;
}
function shell(inner, opts){
  opts = opts || {};
  const nav = opts.nav || '';
  /* 大屏模式：品牌与导航都不可点，纯展示，防止观众/投影时跳到其他页面 */
  if (opts.boardMode) {
    return '<div class="topbar"><div class="topbar-in">' +
      '<div class="brand" style="cursor:default"><span class="dot"></span>演讲评分系统</div>' +
      '<span class="evchip">实时展示中</span>' +
      '<div class="topnav"></div>' +
      '</div></div>' + inner;
  }
  return '<div class="topbar"><div class="topbar-in">' +
    '<div class="brand" data-a="goHome"><span class="dot"></span>演讲评分系统</div>' +
    (opts.evChip ? '<span class="evchip">' + esc(opts.evChip) + '</span>' : '') +
    '<div class="topnav">' + nav + '</div>' +
    '</div></div>' + inner;
}
function adminNav(){
  return '<a data-a="goHome">活动列表</a>' +
    '<a data-a="goAdmin" data-tab="live">实时看板</a>' +
    '<a data-a="openBoard">大屏</a>' +
    '<a data-a="logout">退出</a>';
}
function judgeNav(eid){
  return '<a data-a="goJudgeList">我的评分</a>' +
    '<a data-a="judgeSwitch">切换评委</a>';
}

/* ---------------- 7. 视图：首页 ---------------- */
const Views = {};

Views.home = async function(){
  const app = $('#app');
  app.innerHTML = shell('<div class="wrap"><div class="loading"><span class="spin spin-d"></span> 加载活动…</div></div>',
    { nav: '<a data-a="goHome" class="active">活动列表</a>' });
  try {
    S.events = await DB.listEvents();
  } catch (e) {
    app.innerHTML = shell('<div class="wrap"><div class="card"><div class="card-t">加载失败</div>' +
      '<div class="card-d">' + esc(dbErr(e)) + '</div>' +
      '<button class="btn btn-p" data-a="goHome">重试</button></div></div>', { nav: '' });
    return;
  }

  const cards = S.events.length ? S.events.map(ev => {
    const dims = normDims(ev.dimensions);
    const st = normSettings(ev.settings);
    return '<div class="card">' +
      '<div class="card-t">' + esc(ev.name) +
        '<span class="pill ' + (ev.status === 'live' ? 'pill-g' : ev.status === 'closed' ? 'pill-n' : 'pill-a') + '">' +
        (ev.status === 'live' ? '进行中' : ev.status === 'closed' ? '已结束' : '筹备中') + '</span>' +
      '</div>' +
      '<div class="card-d">' + dims.length + ' 个评分维度，总分 ' + fx(dims.reduce((a, d) => a + num(d.max, 0) * num(d.weight, 1), 0), 0) + ' 分' +
        ((st.dropHighest || st.dropLowest) ? ' · 去掉' + (st.dropHighest ? '最高分' : '') + (st.dropHighest && st.dropLowest ? '和' : '') + (st.dropLowest ? '最低分' : '') : '') +
        ' · 创建于 ' + fmtTime(ev.created_at) + '</div>' +
      '<div class="row-btns">' +
        '<button class="btn btn-p btn-sm" data-a="openAdmin" data-id="' + ev.id + '">管理</button>' +
        '<button class="btn btn-sm" data-a="openBoardById" data-id="' + ev.id + '">实时看板</button>' +
        '<button class="btn btn-sm" data-a="openJudgeById" data-id="' + ev.id + '">评委入口</button>' +
        '<button class="btn btn-sm" data-a="showLinks" data-id="' + ev.id + '">二维码/链接</button>' +
        '<button class="btn btn-d btn-sm" data-a="delEvent" data-id="' + ev.id + '">删除</button>' +
      '</div></div>';
  }).join('') : '<div class="card"><div class="empty"><div class="ico">🎤</div>' +
      '<div class="t">还没有活动</div><div class="d">创建第一个演讲比赛活动，配置评分维度与选手名单，即可生成评委扫码入口。</div>' +
      '<div style="margin-top:18px"><button class="btn btn-p" data-a="newEvent">+ 创建活动</button></div>' +
    '</div></div>';

  app.innerHTML = shell('<div class="wrap">' +
    '<div class="board-hero"><h1>演讲比赛评分系统</h1>' +
      '<div class="sub">多活动 · 多维度 · 多评委扫码评分 · 实时排名与分析导出</div></div>' +
    '<div class="sec-title">全部活动（' + S.events.length + '）</div>' +
    '<div style="margin-bottom:16px"><button class="btn btn-p" data-a="newEvent">+ 创建活动</button></div>' +
    cards + '</div>',
    { nav: '<a data-a="goHome" class="active">活动列表</a>' });
};

/* ---------------- 8. 视图：管理端 ---------------- */
Views.adminRoute = async function(){
  const eid = S.route.params.get('e');
  const app = $('#app');
  if (!eid) { go('#/'); return; }

  if (!adminUnlocked()) {
    app.innerHTML = shell('<div class="wrap-narrow" style="padding-top:44px">' +
      '<div class="card"><div class="card-t">🔒 管理员验证</div>' +
      '<div class="card-d">请输入管理口令进入活动管理台。</div>' +
      '<div class="field"><input class="inp" id="pinInput" type="password" placeholder="管理口令" autocomplete="current-password"></div>' +
      '<button class="btn btn-p btn-block" data-a="checkPin">进入管理台</button>' +
      '<div class="hint" style="text-align:center;margin-top:12px">首次使用默认口令 <b>admin888</b>，登录后可在「活动配置」中修改。</div>' +
      '</div></div>', { nav: '<a data-a="goHome">← 返回活动列表</a>' });
    const inp = $('#pinInput');
    if (inp) { setTimeout(() => inp.focus(), 80);
      inp.addEventListener('keydown', e => { if (e.key === 'Enter') Actions.checkPin(); }); }
    return;
  }

  app.innerHTML = shell('<div class="wrap"><div class="loading"><span class="spin spin-d"></span> 加载活动数据…</div></div>', {});
  try {
    S.event = await DB.getEvent(eid);
    if (!S.event) { toast('活动不存在', 'err'); go('#/'); return; }
    S.event.dimensions = normDims(S.event.dimensions);
    S.event.settings = normSettings(S.event.settings);
    S.speakers = await DB.listSpeakers(eid);
    S.scores = await DB.listScores(eid);
  } catch (e) {
    app.innerHTML = shell('<div class="wrap"><div class="card"><div class="card-t">加载失败</div>' +
      '<div class="card-d">' + esc(dbErr(e)) + '</div><button class="btn btn-p" data-a="goHome">返回</button></div></div>', {});
    return;
  }

  const tabs = [
    ['overview', '概览与二维码'],
    ['config', '活动配置'],
    ['speakers', '选手名单'],
    ['judges', '评委名单'],
    ['live', '实时看板'],
    ['analysis', '分析总结'],
    ['export', '导出数据']
  ];
  app.innerHTML = shell('<div class="wrap">' +
    '<div class="tabs">' + tabs.map(t =>
      '<button data-a="setTab" data-tab="' + t[0] + '" class="' + (S.tab === t[0] ? 'on' : '') + '">' + t[1] + '</button>'
    ).join('') + '</div>' +
    '<div id="tabBody"></div></div>',
    { evChip: S.event.name, nav: adminNav() });

  renderTab();
};

function renderTab(){
  const body = $('#tabBody');
  if (!body) return;
  if (S.timer) { clearInterval(S.timer); S.timer = null; }
  const map = {
    overview: TabOverview, config: TabConfig, speakers: TabSpeakers,
    judges: TabJudges, live: TabLive, analysis: TabAnalysis, export: TabExport
  };
  body.innerHTML = (map[S.tab] || TabOverview)();
  if (S.tab === 'overview') afterOverview();
  if (S.tab === 'live') { afterLive(); startLive(); }
  if (S.tab === 'analysis') afterAnalysis();
  if (S.tab === 'speakers') afterSpeakers();
  if (S.tab === 'judges') afterJudges();
  if (S.tab === 'config') afterConfig();
}

/* --- 8.1 概览与二维码 --- */
function TabOverview(){
  const ev = S.event;
  const res = computeResults(ev, S.speakers, S.scores);
  const totalMax = ev.dimensions.reduce((a, d) => a + num(d.max, 0) * num(d.weight, 1), 0);
  return '<div class="grid2" style="align-items:start">' +
    '<div class="card"><div class="card-t">活动状态</div>' +
      '<div class="card-d">' + esc(ev.name) + '</div>' +
      '<div class="lrow"><div class="lrow-main"><div class="lrow-t">评分维度</div>' +
        '<div class="lrow-s">' + ev.dimensions.map(d => esc(d.name) + '(' + fx(d.max, 0) + '分)').join(' · ') + '</div></div></div>' +
      '<div class="lrow"><div class="lrow-main"><div class="lrow-t">总分</div>' +
        '<div class="lrow-s">' + fx(totalMax, 0) + ' 分' +
        ((ev.settings.dropHighest || ev.settings.dropLowest) ? ' · 去掉' + (ev.settings.dropHighest ? '最高分' : '') + (ev.settings.dropHighest && ev.settings.dropLowest ? '和' : '') + (ev.settings.dropLowest ? '最低分' : '') + '（各' + ev.settings.dropCount + '个）' : '') +
        '</div></div></div>' +
      '<div class="lrow"><div class="lrow-main"><div class="lrow-t">选手 / 评委</div>' +
        '<div class="lrow-s">' + S.speakers.length + ' 名选手 · ' + res.judgeTotal + ' 位评委' +
          (res.judgeTotal > res.judges.length ? '（已提交 ' + res.judges.length + ' 位）' : '') + '</div></div></div>' +
      '<div class="lrow"><div class="lrow-main"><div class="lrow-t">评分进度</div>' +
        '<div class="lrow-s">已收 ' + S.scores.length + ' 条评分记录</div>' +
        '<div class="bar" style="margin-top:7px"><i style="width:' + progressPct(res) + '%"></i></div></div>' +
        '<div class="num">' + progressPct(res) + '%</div></div>' +
      '<div class="hr"></div>' +
      '<div class="row-btns">' +
        '<button class="btn ' + (ev.status === 'live' ? 'btn-g' : 'btn-p') + '" data-a="toggleStatus">' +
          (ev.status === 'live' ? '⏸ 暂停接收评分' : '▶ 开始接收评分') + '</button>' +
        '<button class="btn" data-a="openBoard">大屏展示</button>' +
      '</div>' +
    '</div>' +
    '<div class="card"><div class="card-t">评委扫码入口</div>' +
      '<div class="card-d">评委用手机扫描下方二维码，输入姓名后即可开始评分。同一活动下每位评委独立记录。</div>' +
      '<div class="qr-grid">' +
        '<div class="qr-box"><div id="qrJudge"></div><div class="hint" style="margin-top:9px">评委评分入口</div></div>' +
        '<div class="qr-box"><div id="qrBoard"></div><div class="hint" style="margin-top:9px">实时看板（观众/大屏）</div></div>' +
      '</div>' +
      '<div class="hr"></div>' +
      '<div class="field"><label>评委入口链接</label>' +
        '<input class="inp" readonly value="' + esc(judgeLink(ev.id)) + '" onclick="this.select()"></div>' +
      '<div class="row-btns">' +
        '<button class="btn btn-sm" data-a="copyJudgeLink">复制评委链接</button>' +
        '<button class="btn btn-sm" data-a="copyBoardLink">复制看板链接</button>' +
        '<button class="btn btn-sm" data-a="downloadQR">下载二维码</button>' +
      '</div>' +
    '</div></div>';
}
function progressPct(res){
  const total = S.speakers.length * Math.max(1, res.judges.length);
  if (!total || !res.judges.length) return 0;
  return Math.min(100, Math.round(S.scores.length / total * 100));
}
function afterOverview(){
  renderQR($('#qrJudge'), judgeLink(S.event.id));
  renderQR($('#qrBoard'), boardLink(S.event.id));
}

/* --- 8.2 活动配置 --- */
function TabConfig(){
  const ev = S.event;
  const st = ev.settings;
  return '<div class="grid2" style="align-items:start">' +
    '<div class="card"><div class="card-t">基本信息</div>' +
      '<div class="field"><label>活动名称</label><input class="inp" id="cfgName" value="' + esc(ev.name) + '"></div>' +
      '<div class="field"><label>选手之间评分是否公开显示给评委</label>' +
        '<label class="switch"><input type="checkbox" id="cfgJudgeSeeAll" ' + (st.judgeSeeAll ? 'checked' : '') + '> 允许评委查看其他人的评分</label>' +
      '</div>' +
      '<div class="field"><label>防代打 / 防多评（推荐开启）</label>' +
        '<label class="switch"><input type="checkbox" id="cfgDeviceLock" ' + (st.deviceLock !== false ? 'checked' : '') + '> 一台设备只能绑定一位评委</label>' +
        '<div class="hint">开启后：评委首次输入姓名即绑定本机，之后本机只能以该评委身份评分；' +
          '如需换人（设备借用、临时替补）需<b>管理员输入口令放行</b>。<br>' +
          '同时系统会记录每条评分的<b>设备指纹与出口 IP</b>，在「评委名单」页的「异常留痕」中可核查。</div>' +
      '</div>' +
      '<button class="btn btn-p" data-a="saveBasic">保存基本信息</button>' +
      '<div class="hr"></div>' +
      '<div class="card-t" style="font-size:14px">管理口令</div>' +
      '<div class="card-d">用于进入本管理台。默认 admin888，建议修改。</div>' +
      '<div class="row-btns">' +
        '<button class="btn btn-sm" data-a="changePin">修改管理口令</button>' +
        '<button class="btn btn-sm" data-a="resetPin">恢复为默认口令</button>' +
      '</div>' +
    '</div>' +
    '<div class="card"><div class="card-t">评分细则（维度设置）</div>' +
      '<div class="card-d">可自由增删细则并设置分值。<b>每个细则都可单独设置一级分组、打分标准、档位快捷键</b>——打分标准会在评委端展示，档位会生成一键打分按钮。</div>' +
      '<div class="dim-sum" id="dimSummary"></div>' +
      '<div id="dimList">' + dimRowsHtml(ev.dimensions) + '</div>' +
      '<div class="row-btns" style="margin-top:6px">' +
        '<button class="btn btn-sm" data-a="addDim">+ 添加细则</button>' +
        '<button class="btn btn-p" data-a="saveRules">保存评分细则</button>' +
        '<button class="btn btn-sm" data-a="resetDims">恢复默认模板</button>' +
      '</div>' +
      '<div class="hr"></div>' +
      '<div class="card-t" style="font-size:14px">计分规则</div>' +
      '<label class="switch"><input type="checkbox" id="cfgDropHigh" ' + (st.dropHighest ? 'checked' : '') + '> 去掉最高分</label>' +
      '<label class="switch"><input type="checkbox" id="cfgDropLow" ' + (st.dropLowest ? 'checked' : '') + '> 去掉最低分</label>' +
      '<div class="field" style="margin-top:8px"><label>去掉个数</label>' +
        '<input class="inp dw" id="cfgDropCount" type="number" min="1" step="1" value="' + num(st.dropCount, 1) + '" style="width:96px">' +
        '<div class="hint">需该题有效评委数 ≥ 去掉总数×2+1 时生效，否则不剔除。</div></div>' +
      '<div class="row-btns"><button class="btn btn-p" data-a="saveRules">保存计分规则</button></div>' +
      '<div class="hr"></div>' +
      '<div class="card-t" style="font-size:14px">排序方式</div>' +
      '<div class="row-btns">' +
        '<button class="btn btn-sm" data-a="renumber">按当前顺序重排序号</button>' +
        '<button class="btn btn-sm" data-a="shuffle">随机打乱顺序</button>' +
      '</div>' +
    '</div></div>';
}
function dimRowsHtml(dims){
  const groups = groupDims(dims);
  let n = 0;
  return groups.map(g =>
    (g.group ? '<div class="dim-grp-h">' + esc(g.group) + '　<span class="pill pill-n">' + fx(g.max, 0) + ' 分</span></div>' : '') +
    g.dims.map(d => {
      n++;
      return '<div class="dimrow" data-dim="' + esc(d.id) + '">' +
        '<div class="dimrow-top">' +
          '<span class="lrow-idx">' + n + '</span>' +
          '<input class="inp dim-name" value="' + esc(d.name) + '" placeholder="评分细则名称">' +
          '<input class="inp dw dim-max" type="number" min="1" step="1" value="' + num(d.max, 10) + '" title="分值">' +
          '<input class="inp dw dim-weight" type="number" min="0.1" step="0.1" value="' + num(d.weight, 1) + '" title="权重">' +
          '<button class="btn btn-d btn-xs" data-a="delDim" data-dim="' + esc(d.id) + '">删除</button>' +
        '</div>' +
        '<div class="dimrow-sub">' +
          '<label class="sub-lb">一级分组</label>' +
          '<input class="inp dim-group" value="' + esc(d.group) + '" placeholder="如：一、实战内容质量（50分）。留空则不分组">' +
        '</div>' +
        '<div class="dimrow-sub">' +
          '<label class="sub-lb">打分标准<span class="sub-lb-h">评委可见</span></label>' +
          '<textarea class="inp dim-desc" rows="3" placeholder="按区间写清给分依据，如：精准结合本职工作，场景真实（12-15分）；基本贴合（8-11分）；与岗位无关（0-7分）">' + esc(d.desc) + '</textarea>' +
        '</div>' +
        '<div class="dimrow-sub">' +
          '<label class="sub-lb">档位快捷键<span class="sub-lb-h">现场一点即得</span></label>' +
          '<input class="inp dim-tiers" value="' + esc(d.tiers) + '" placeholder="斜杠分隔，如 15/11/7。留空则显示百分比按钮">' +
          '<div class="sub-hint">对应「优 / 良 / 中 / 待改进 / 差」，依次填入各档分值即可。</div>' +
        '</div>' +
      '</div>';
    }).join('')
  ).join('') +
  '<div class="hint">每行：细则名称 / 分值 / 权重；下方依次设置「一级分组 / 打分标准 / 档位快捷键」。改完记得点下方保存。</div>';
}
function afterConfig(){
  /* 输入变化时实时汇总分组与总分，让用户立刻看到改动结果 */
  const box = $('#dimList');
  if (!box) return;
  const summarize = () => {
    const out = $('#dimSummary');
    if (!out) return;
    const dims = readDimsFromUI();
    const total = dims.reduce((a, d) => a + d.max * d.weight, 0);
    const groups = groupDims(dims).filter(g => g.group);
    out.innerHTML = '<b>' + dims.length + '</b> 项细则' +
      (groups.length ? ' · <b>' + groups.length + '</b> 个一级分组' : '') +
      ' · 总分上限 <b class="' + (total === 100 ? 'ok-txt' : '') + '">' + fx(total, 0) + '</b> 分' +
      (total === 100 ? ' <span class="pill pill-g">百分制</span>' : '') +
      (groups.length ? '<div class="dim-sum-g">' + groups.map(g => esc(g.group) + ' ' + fx(g.max, 0) + '分').join('　·　') + '</div>' : '');
  };
  /* 用 dataset 标记避免重复绑定监听器 */
  if (!box.dataset.bound) {
    box.addEventListener('input', summarize);
    box.dataset.bound = '1';
  }
  summarize();
}
function readDimsFromUI(){
  const out = [];
  $$('#dimList .dimrow').forEach(r => {
    const q = s => { const el = $(s, r); return el ? el.value.trim() : ''; };
    const name = q('.dim-name');
    if (!name) return;
    out.push({
      id: r.dataset.dim || uid(),
      group: q('.dim-group'),
      name,
      max: Math.max(1, Math.round(num(q('.dim-max'), 10))),
      weight: num(q('.dim-weight'), 1) || 1,
      desc: q('.dim-desc'),
      tiers: q('.dim-tiers')
    });
  });
  return out;
}

/* --- 8.3 选手名单 --- */
function TabSpeakers(){
  const list = S.speakers;
  return '<div class="grid2" style="align-items:start">' +
    '<div class="card"><div class="card-t">添加选手</div>' +
      '<div class="card-d">支持批量输入，每行一位。<b>格式：项目名称,汇报人,汇报主题</b>（逗号可为中英文；后两项可省略）。若只有两段，第二段按「单位/部门」处理。</div>' +
      '<div class="field"><label>选手名单</label>' +
        '<textarea class="inp" id="spBatch" placeholder="研发中心,张伟,AI助力效率提升&#10;市场部,李娜,数据驱动决策&#10;生产部,王强,智能质检实践"></textarea></div>' +
      '<div class="row-btns">' +
        '<button class="btn btn-p" data-a="addSpeakers">批量添加</button>' +
        '<button class="btn btn-sm" data-a="sampleSpeakers">填入示例</button>' +
      '</div>' +
    '</div>' +
    '<div class="card"><div class="card-t">选手顺序（' + list.length + ' 人）</div>' +
      '<div class="card-d">评分序号即为比赛出场顺序，可直接上下移动调整。</div>' +
      (list.length ? list.map((sp, i) =>
        '<div class="lrow">' +
          '<span class="lrow-idx">' + (i + 1) + '</span>' +
          '<div class="lrow-main"><div class="lrow-t">' + esc(sp.name) + '</div>' +
            '<div class="lrow-s">' + esc(sp.department || '—') + '</div>' +
            (sp.group_name ? '<div class="lrow-s" style="color:#9ca3af">' + esc(sp.group_name) + '</div>' : '') +
          '</div>' +
          '<button class="btn btn-xs" data-a="spUp" data-id="' + sp.id + '">↑</button>' +
          '<button class="btn btn-xs" data-a="spDown" data-id="' + sp.id + '">↓</button>' +
          '<button class="btn btn-xs" data-a="spEdit" data-id="' + sp.id + '">改</button>' +
          '<button class="btn btn-d btn-xs" data-a="spDel" data-id="' + sp.id + '">删</button>' +
        '</div>').join('')
        : '<div class="empty"><div class="ico">👥</div><div class="t">暂无选手</div>' +
          '<div class="d">在左侧批量输入名单后，选手将按添加顺序编号。</div></div>') +
    '</div></div>';
}
function afterSpeakers(){}

/* --- 8.3b 评委名单 --- */
function TabJudges(){
  const res = computeResults(S.event, S.speakers, S.scores);
  const preset = res.presetJudges || [];
  const stats = res.judgeStats || [];
  const submitted = res.judges || [];
  const notInList = submitted.filter(n => !preset.some(p => p.name === n));

  return '<div class="grid2" style="align-items:start">' +
    '<div class="card"><div class="card-t">📋 录入评委名单</div>' +
      '<div class="card-d">每行一位。<b>格式：姓名,单位</b>（逗号可为中英文；单位可省略）。<br>' +
        '录入后：① 概览/看板会显示「应有几位评委」；② 未提交的评委会被标出来，方便催收；③ 评委扫码输名字时会校验。</div>' +
      '<div class="field"><label>评委名单</label>' +
        '<textarea class="inp" id="jdBatch" rows="8" placeholder="张评委,示例集团&#10;李评委,研发中心&#10;王评委"></textarea></div>' +
      '<div class="row-btns">' +
        '<button class="btn btn-p" data-a="saveJudges">保存评委名单</button>' +
        '<button class="btn btn-sm" data-a="sampleJudges">填入示例</button>' +
        '<button class="btn btn-sm" data-a="clearJudges">清空</button>' +
      '</div>' +
      '<div class="hint">名单仅用于显示与校验，<b>不会限制评分</b>——不在名单里的人扫码后仍可正常评分。<br>' +
        '<b>删除评委</b>请用右侧表格每行的「移除」按钮（数据保留可恢复）。</div>' +
    '</div>' +

    '<div class="card"><div class="card-t">评委提交进度（' + stats.length + ' 位）' +
      '<span class="pill pill-n" style="margin-left:auto">移除即不计分</span></div>' +
      '<div class="card-d">按名单显示每位评委的提交情况。未在名单中但已提交的，也会一并列出。<br>' +
        '「移除」= 该评委的评分<b>不计入任何统计</b>（数据保留，可随时恢复）。</div>' +
      (stats.length ? '<div class="tbl-wrap"><table class="tbl"><thead><tr>' +
        '<th>评委</th><th>单位</th><th>已评</th><th>进度</th><th>平均分</th><th>状态</th><th>操作</th></tr></thead><tbody>' +
        stats.map(j =>
          '<tr>' +
            '<td class="num"><b>' + esc(j.name) + '</b></td>' +
            '<td>' + esc(j.dept || '—') + '</td>' +
            '<td class="num">' + j.scored + ' / ' + j.total + '</td>' +
            '<td><div class="bar" style="width:92px"><i style="width:' + Math.round(j.rate * 100) + '%"></i></div></td>' +
            '<td class="num">' + (j.avg !== null ? fx(j.avg) : '—') + '</td>' +
            '<td>' + (j.scored > 0
              ? '<span class="pill pill-g">' + (j.rate >= 1 ? '已完成' : '进行中') + '</span>'
              : '<span class="pill pill-a">未提交</span>') +
              (j.preset ? '' : ' <span class="pill pill-n" title="不在预设名单中">名单外</span>') + '</td>' +
            '<td class="nowrap"><button class="btn btn-d btn-xs" data-a="removeJudge" data-name="' + esc(j.name) +
              '" data-records="' + j.scored + '">移除</button></td>' +
          '</tr>').join('') +
        '</tbody></table></div>'
        : '<div class="empty"><div class="ico">🧑‍⚖️</div><div class="t">尚未录入评委</div>' +
          '<div class="d">在左侧录入评委名单后，这里会显示每位评委的提交进度。</div></div>') +
      (stats.length ? '<div class="hr"></div><div class="hint">' +
        '未提交 <b>' + stats.filter(j => !j.scored).length + '</b> 位' +
        ' · 进行中 <b>' + stats.filter(j => j.scored > 0 && j.rate < 1).length + '</b> 位' +
        ' · 已完成 <b>' + stats.filter(j => j.rate >= 1 && j.scored > 0).length + '</b> 位' +
        (notInList.length ? ' · <span class="warn-txt">名单外提交 ' + notInList.length + ' 位（' + esc(notInList.join('、')) + '）</span>' : '') +
        '</div>' : '') +
    '</div>' +

    /* 已移除评委：可一键恢复 */
    (res.excludedStats.length ? '<div class="card" style="grid-column:1/-1"><div class="card-t">🚫 已移除评委（' + res.excludedStats.length + ' 位）' +
      '<span class="pill pill-a" style="margin-left:auto">评分已不计入统计</span></div>' +
      '<div class="card-d">以下评委的评分已从排名与统计中排除，<b>数据仍完整保留</b>。点「恢复」即刻重新计入。</div>' +
      '<div class="tbl-wrap"><table class="tbl"><thead><tr>' +
        '<th>评委</th><th>单位</th><th>被排除评分</th><th>操作</th></tr></thead><tbody>' +
      res.excludedStats.map(j => '<tr>' +
        '<td class="num"><b>' + esc(j.name) + '</b></td>' +
        '<td>' + esc(j.dept || '—') + '</td>' +
        '<td class="num">' + j.scored + ' 条（' + j.records + ' 次提交）</td>' +
        '<td class="nowrap"><button class="btn btn-xs" data-a="restoreJudge" data-name="' + esc(j.name) + '">恢复</button></td>' +
      '</tr>').join('') + '</tbody></table></div></div>' : '') +

    /* 异常留痕告警 */
    JudgeAlertCard(res) +
  '</div>';
}
/* 异常留痕面板：同设备 / 同IP 多评委 + 切换记录。
   只告警不拦截——会场共用 WiFi 会导致所有评委出口 IP 相同。 */
function JudgeAlertCard(res){
  const dev = res.deviceAlerts || [], ip = res.ipAlerts || [], sw = res.switchLogs || [];
  const total = dev.length + ip.length + sw.length;
  return '<div class="card" style="grid-column:1/-1">' +
    '<div class="card-t">🔍 异常留痕' +
      (total ? '<span class="pill pill-a" style="margin-left:auto">' + total + ' 条待核</span>'
             : '<span class="pill pill-g" style="margin-left:auto">未发现异常</span>') + '</div>' +
    '<div class="card-d">系统会记录每条评分的<b>设备指纹与出口 IP</b>，用于事后核查数据真实性。<br>' +
      '说明：会场共用 WiFi 时所有评委会显示<b>同一 IP</b>，这属正常；<b>同一设备出现多个评委名</b>才需重点关注。' +
      '清缓存/无痕窗口可更换设备指纹，故此处为<b>线索提示</b>而非定罪依据。</div>' +
    (total ? '' :
      '<div class="hint" style="margin-top:8px">✓ 当前所有评分来自不同设备，且未发现换人操作。</div>') +
    (dev.length ? '<div class="hr"></div><div class="sub-lb">⚠️ 同一设备提交了多个评委的评分 <span class="sub-lb-h">' + dev.length + ' 台设备</span></div>' +
      '<div class="tbl-wrap"><table class="tbl"><thead><tr><th>设备</th><th>涉及评委</th></tr></thead><tbody>' +
      dev.map(d => '<tr><td class="num">' + esc(d.device.slice(0, 14)) + '…</td>' +
        '<td><span class="warn-txt">' + esc(d.judges.join('、')) + '</span>（' + d.judges.length + ' 人）</td></tr>').join('') +
      '</tbody></table></div>' : '') +
    (ip.length ? '<div class="hr"></div><div class="sub-lb">ℹ️ 同一 IP 出现多个评委 <span class="sub-lb-h">' + ip.length + ' 个 IP</span></div>' +
      '<div class="tbl-wrap"><table class="tbl"><thead><tr><th>IP</th><th>涉及评委</th></tr></thead><tbody>' +
      ip.map(d => '<tr><td class="num">' + esc(d.ip) + '</td>' +
        '<td>' + esc(d.judges.join('、')) + '（' + d.judges.length + ' 人）</td></tr>').join('') +
      '</tbody></table></div>' +
      '<div class="hint">同一 WiFi 下 IP 相同属正常现象，仅供参考。</div>' : '') +
    (sw.length ? '<div class="hr"></div><div class="sub-lb">🔄 评委切换记录 <span class="sub-lb-h">' + sw.length + ' 次</span></div>' +
      '<div class="tbl-wrap"><table class="tbl"><thead><tr><th>时间</th><th>设备</th><th>切换</th><th>IP</th><th>放行</th></tr></thead><tbody>' +
      sw.slice(0, 20).map(s => '<tr>' +
        '<td class="num">' + esc(fmtTime(s.at)) + '</td>' +
        '<td class="num">' + esc(String(s.device).slice(0, 14)) + '…</td>' +
        '<td>' + esc(s.from || '—') + ' → <b>' + esc(s.to) + '</b></td>' +
        '<td class="num">' + esc(s.ip || '—') + '<div class="lrow-s">' + esc(s.loc || '') + '</div></td>' +
        '<td>' + (s.approved ? '<span class="pill pill-g">口令放行</span>' : '<span class="pill pill-a">未放行</span>') + '</td>' +
      '</tr>').join('') + '</tbody></table></div>' : '') +
  '</div>';
}
function afterJudges(){
  const ta = $('#jdBatch');
  if (!ta) return;
  const res = computeResults(S.event, S.speakers, S.scores);
  const preset = res.presetJudges || [];
  ta.value = preset.map(p => p.dept ? (p.name + ',' + p.dept) : p.name).join('\n');
}

/* --- 8.4 实时看板（管理端） --- */
function TabLive(){
  const res = computeResults(S.event, S.speakers, S.scores);
  const done = res.rows.filter(r => r.complete).length;
  return '<div class="kpis">' +
    kpi('选手数', S.speakers.length, '人') +
    kpi('评委数', res.judgeTotal, '位') +
    kpi('评分记录', S.scores.length, '条') +
    kpi('已完成评分', done, '人') +
    kpi('总分上限', res.wMax, '分') +
  '</div>' +
  '<div class="card"><div class="card-t"><span class="live-dot"></span> 实时排名' +
    '<span class="pill pill-n" style="margin-left:auto">5 秒自动刷新</span></div>' +
    '<div class="card-d">按当前已收评分实时计算。点击选手可查看各维度明细。</div>' +
    rankListHtml(res) + '</div>' +
  '<div class="card"><div class="card-t">评委提交进度' +
    '<span class="pill pill-n" style="margin-left:auto">' + res.judgeTotal + ' 位' +
      (res.judgeTotal > res.judges.length ? ' · 已提交 ' + res.judges.length : '') + '</span></div>' +
    '<div class="card-d">用于发现尚未提交评分的评委。</div>' +
    (res.judgeStats.length ? '<div class="tbl-wrap"><table class="tbl"><thead><tr>' +
      '<th>评委</th><th>单位</th><th>已评</th><th>进度</th><th>平均分</th><th>状态</th><th>最新提交</th></tr></thead><tbody>' +
      res.judgeStats.map(j => '<tr>' +
        '<td class="num"><b>' + esc(j.name) + '</b></td>' +
        '<td>' + esc(j.dept || '—') + '</td>' +
        '<td class="num">' + j.scored + ' / ' + j.total + '</td>' +
        '<td><div class="bar" style="width:110px"><i style="width:' + Math.round(j.rate * 100) + '%"></i></div></td>' +
        '<td class="num">' + fx(j.avg) + '</td>' +
        '<td>' + (j.scored > 0
          ? '<span class="pill pill-g">' + (j.rate >= 1 ? '已完成' : '进行中') + '</span>'
          : '<span class="pill pill-a">未提交</span>') + '</td>' +
        '<td>' + (j.lastAt ? fmtTime(j.lastAt) : '—') + '</td></tr>').join('') +
      '</tbody></table></div>'
      : '<div class="empty"><div class="ico">📝</div><div class="t">暂无评委</div>' +
        '<div class="d">在「评委名单」页录入评委后，这里会显示每位评委的提交进度。</div></div>') +
  '</div>';
}
function kpi(k, v, u){
  return '<div class="kpi"><div class="k">' + esc(k) + '</div><div class="v">' + v + (u ? ' <small>' + u + '</small>' : '') + '</div></div>';
}
function rankListHtml(res){
  if (!res.ranked.length) return '<div class="empty"><div class="ico">📊</div><div class="t">暂无排名数据</div><div class="d">请先添加选手并邀请评委评分。</div></div>';
  const hasGroup = res.groups.some(g => g.group);
  return '<div class="mlist">' + res.ranked.map(r => {
    const cls = r.rank === 1 ? 'g1' : r.rank === 2 ? 'g2' : r.rank === 3 ? 'g3' : '';
    /* 分组小计 */
    const gsub = hasGroup ? '<div class="gsub">' + res.groups.filter(g => g.group).map(g => {
      const item = g.perSpeaker.find(x => String(x.speaker.id) === String(r.speaker.id));
      const label = g.group.replace(/^[一二三四五六七八九十]+、/, '').replace(/（.*?）/, '');
      return '<span class="gsub-i">' + esc(label) + ' <b>' + (item && item.got !== null ? fx(item.got, 1) : '—') +
        '</b>/' + fx(g.max, 0) + '</span>';
    }).join('') + '</div>' : '';
    return '<div class="mrow' + (r.rank <= 3 ? ' top' : '') + '">' +
      '<div class="mrank ' + cls + '">' + r.rank + '</div>' +
      '<div style="min-width:0;flex:1">' +
        '<div class="mname">' + esc(r.speaker.name) +
          '<span class="mtag">' + esc(r.speaker.department || '') + '</span></div>' +
        (r.speaker.group_name ? '<div class="mtopic">' + esc(r.speaker.group_name) + '</div>' : '') +
        '<div class="mmeta">' + r.judgeCount + ' 位评委已评' +
          (r.complete ? '' : ' <span class="pill pill-a">部分未评</span>') + '</div>' +
        '<div class="bar" style="width:180px;margin-top:6px"><i style="width:' + Math.round(r.rate * 100) + '%"></i></div>' +
        gsub +
      '</div>' +
      '<div class="mscore"><div class="s">' + fx(r.total) + ' <small>/ ' + fx(r.maxTotal, 0) + '</small></div>' +
        '<div class="mmeta">得分率 ' + fx(r.rate * 100, 1) + '%</div></div>' +
    '</div>';
  }).join('') + '</div>';
}
function afterLive(){
  $$('#tabBody .mrow').forEach((el, i) => {
    el.style.cursor = 'pointer';
    el.addEventListener('click', () => {
      const res = computeResults(S.event, S.speakers, S.scores);
      openSpeakerDetail(res.ranked[i]);
    });
  });
}
function startLive(){
  if (S.timer) clearInterval(S.timer);
  S.timer = setInterval(async () => {
    if (S.tab !== 'live' || document.hidden) return;
    try {
      S.speakers = await DB.listSpeakers(S.event.id);
      S.scores = await DB.listScores(S.event.id);
      const body = $('#tabBody');
      if (body) { body.innerHTML = TabLive(); afterLive(); }
    } catch (e) { /* 静默 */ }
  }, 5000);
}

function openSpeakerDetail(row){
  if (!row) return;
  const dims = S.event.dimensions;
  const res = computeResults(S.event, S.speakers, S.scores);
  /* 分组小计表 */
  const groupRows = res.groups.filter(g => g.group).map(g => {
    const item = g.perSpeaker.find(x => String(x.speaker.id) === String(row.speaker.id));
    const got = item && item.got !== null ? item.got : null;
    return '<tr><td>' + esc(g.group) + '</td>' +
      '<td class="num">' + (got !== null ? fx(got) : '—') + ' / ' + fx(g.max, 0) + '</td>' +
      '<td><div class="bar ' + (got !== null && got / g.max >= 0.9 ? 'bar-ok' : got !== null && got / g.max < 0.75 ? 'bar-warn' : '') +
        '" style="width:90px"><i style="width:' + (got !== null ? Math.round(got / g.max * 100) : 0) + '%"></i></div></td></tr>';
  }).join('');
  const rows = dims.map(d => {
    const o = row.dims[d.id] || {};
    return '<tr><td>' + esc(d.group ? d.group.replace(/（.*?）/, '') + ' · ' : '') + esc(d.name) + '</td>' +
      '<td class="num">' + (o.avg !== null && o.avg !== undefined ? fx(o.avg) : '—') + ' / ' + fx(d.max, 0) + '</td>' +
      '<td class="num">' + (o.rate !== null && o.rate !== undefined ? fx(o.rate * 100, 1) + '%' : '—') + '</td>' +
      '<td class="num">' + (o.count || 0) + '</td></tr>';
  }).join('');
  const judgeRows = S.scores.filter(s => String(s.speaker_id) === String(row.speaker.id)).map(s =>
    '<tr><td>' + esc(s.judge_name) + '</td>' +
      dims.map(d => '<td class="num">' + (s.scores && s.scores[d.id] != null ? fx(s.scores[d.id], 1) : '—') + '</td>').join('') +
      '<td class="num"><b>' + fx(dims.reduce((a, d) => a + num(s.scores ? s.scores[d.id] : 0), 0), 1) + '</b></td></tr>').join('');

  modal('<h3>第 ' + num(row.speaker.seq) + ' 号 · ' + esc(row.speaker.name) + '</h3>' +
    '<p style="margin-bottom:12px">' + esc(row.speaker.department || '') +
      (row.speaker.group_name ? '<br><span style="color:#6b7280">汇报主题：' + esc(row.speaker.group_name) + '</span>' : '') + '</p>' +
    '<p>总分 <b style="color:#1d4ed8;font-size:19px">' + fx(row.total) + '</b> / ' + fx(row.maxTotal, 0) +
      ' &nbsp;排名第 <b>' + row.rank + '</b>（' + row.judgeCount + ' 位评委）</p>' +
    (groupRows ? '<div class="sec-title" style="margin-top:14px">一级维度得分</div>' +
      '<div class="tbl-wrap"><table class="tbl tbl-detail"><thead><tr><th>一级维度</th><th>得分</th><th></th></tr></thead><tbody>' +
      groupRows + '</tbody></table></div>' : '') +
    '<div class="sec-title" style="margin-top:14px">各细则得分</div>' +
    '<div class="tbl-wrap"><table class="tbl tbl-detail"><thead><tr><th>评分细则</th><th>均分</th><th>得分率</th><th>有效票</th></tr></thead><tbody>' +
      rows + '</tbody></table></div>' +
    (judgeRows ? '<div class="sec-title" style="margin-top:16px">各评委原始打分</div>' +
      '<div class="tbl-wrap"><table class="tbl tbl-detail"><thead><tr><th>评委</th>' +
      dims.map(d => '<th>' + esc(d.name) + '</th>').join('') + '<th>合计</th></tr></thead><tbody>' + judgeRows + '</tbody></table></div>' : '') +
    '<div class="row-btns" style="margin-top:16px"><button class="btn" data-a="closeModalTop">关闭</button></div>');
}

/* --- 8.5 分析总结 --- */
function TabAnalysis(){
  const res = computeResults(S.event, S.speakers, S.scores);
  if (!S.speakers.length || !S.scores.length) {
    return '<div class="card"><div class="empty"><div class="ico">📈</div><div class="t">暂无可分析数据</div>' +
      '<div class="d">需要至少一位选手和一条评分记录。评分汇总后，此处会自动生成维度得失、评委倾向、选手强弱项等多维度的分析总结。</div></div></div>';
  }
  const ranked = res.ranked;
  const first = ranked[0], last = ranked[ranked.length - 1];
  const avgAll = ranked.reduce((a, r) => a + r.total, 0) / ranked.length;

  /* 1. 一级维度总体得失（分组时优先展示） */
  const hasGroup = res.groups.some(g => g.group);
  const groupHtml = hasGroup ? res.groups.filter(g => g.group).map(g => {
    const lossRate = 1 - g.rate;
    const cls = g.rate >= 0.9 ? 'ok-txt' : g.rate >= 0.75 ? '' : 'warn-txt';
    const barCls = g.rate >= 0.9 ? 'bar-ok' : g.rate >= 0.75 ? '' : 'bar-warn';
    return '<div class="lrow"><div class="lrow-main">' +
      '<div class="lrow-t">' + esc(g.group) + '</div>' +
      '<div class="bar ' + barCls + '" style="margin-top:6px"><i style="width:' + Math.round(g.rate * 100) + '%"></i></div>' +
      '<div class="lrow-s ' + cls + '">全场均分 ' + fx(g.avg) + ' / ' + fx(g.max, 0) +
        ' · 得分率 ' + fx(g.rate * 100, 1) + '% · 人均失分 ' + fx(g.max - g.avg, 2) + ' 分</div>' +
      '</div></div>';
  }).join('') : '';

  /* 2. 各二级细则得失 */
  const dimHtml = res.dimStats.map(d => {
    const lossRate = 1 - d.rate;
    const cls = d.rate >= 0.9 ? 'ok-txt' : d.rate >= 0.75 ? '' : 'warn-txt';
    const barCls = d.rate >= 0.9 ? 'bar-ok' : d.rate >= 0.75 ? '' : 'bar-warn';
    const meta = res.dims.find(x => x.id === d.id) || {};
    return '<div class="lrow"><div class="lrow-main">' +
      '<div class="lrow-t">' + esc(d.name) + '<span class="pill pill-n" style="margin-left:6px">' + fx(d.max, 0) + '分</span></div>' +
      (meta.group ? '<div class="lrow-s" style="color:#9ca3af">' + esc(meta.group) + '</div>' : '') +
      '<div class="bar ' + barCls + '" style="margin-top:6px"><i style="width:' + Math.round(d.rate * 100) + '%"></i></div>' +
      '<div class="lrow-s ' + cls + '">全场均分 ' + fx(d.avg) + ' · 得分率 ' + fx(d.rate * 100, 1) + '% · 共失分 ' + fx(d.max - d.avg, 2) + ' 分/人</div>' +
      '</div></div>';
  }).join('');

  /* 2. 评委打分倾向 */
  const judgeRows = res.judgeStats.map(j => {
    const gap = j.avg !== null ? j.avg - (avgAll / Math.max(1, res.dims.length)) : null;
    const tendency = gap === null ? '—' : (gap > 0.8 ? '偏宽松' : gap < -0.8 ? '偏严格' : '平稳');
    const tCls = tendency === '偏宽松' ? 'warn-txt' : tendency === '偏严格' ? 'ok-txt' : '';
    return '<tr><td class="num">' + esc(j.name) + '</td>' +
      '<td class="num">' + (j.avg !== null ? fx(j.avg) : '—') + '</td>' +
      '<td class="' + tCls + '" style="font-weight:700">' + tendency + '</td>' +
      '<td class="num">' + j.scored + '/' + j.total + '</td></tr>';
  }).join('');

  /* 3. 各选手强弱项（相对全场） */
  const weakStrong = ranked.map(r => {
    let best = null, worst = null;
    res.dims.forEach(d => {
      const o = r.dims[d.id];
      if (!o || o.rate === null) return;
      const rel = o.rate - (res.dimStats.find(x => x.id === d.id) || { rate: 0 }).rate;
      if (!best || rel > best.rel) best = { name: d.name, rel, rate: o.rate };
      if (!worst || rel < worst.rel) worst = { name: d.name, rel, rate: o.rate };
    });
    return { r, best, worst };
  });

  /* 4. 自动结论文本 */
  const sortedDim = res.dimStats.slice().sort((a, b) => a.rate - b.rate);
  const weakest = sortedDim[0], strongest = sortedDim[sortedDim.length - 1];
  const spreadList = ranked.map(r => r.total);
  const maxScore = Math.max.apply(null, spreadList), minScore = Math.min.apply(null, spreadList);

  /* 各维度离散度（谁最不稳定） */
  const volatility = res.dims.map(d => {
    let mxSpread = 0, mxName = '', mnSpread = Infinity, mnName = '';
    ranked.forEach(r => {
      const o = r.dims[d.id];
      if (!o || o.spread === null) return;
      if (o.spread > mxSpread) { mxSpread = o.spread; mxName = r.speaker.name; }
      if (o.spread < mnSpread) { mnSpread = o.spread; mnName = r.speaker.name; }
    });
    return { dim: d.name, maxSpread: mxSpread, maxName: mxName, minSpread: mnSpread === Infinity ? 0 : mnSpread, minName: mnName, avgDiff: mxSpread };
  });
  const mostDivisive = volatility.slice().sort((a, b) => b.maxSpread - a.maxSpread)[0];

  /* 一级维度表现（分组场景） */
  const gList = res.groups.filter(g => g.group);
  const gWeak = hasGroup && gList.length ? gList.slice().sort((a, b) => a.rate - b.rate)[0] : null;
  const gStrong = hasGroup && gList.length ? gList.slice().sort((a, b) => b.rate - a.rate)[0] : null;

  return '<div class="card"><div class="card-t">📌 综合结论</div>' +
    '<div class="analysis-blk"><div class="t">🏆 总体格局</div><div class="d">' +
      '本次共有 <b>' + S.speakers.length + '</b> 名选手、<b>' + res.judges.length + '</b> 位评委参与，累计 <b>' + S.scores.length + '</b> 条评分记录。' +
      '排名首位为 <b>' + esc(first.speaker.name) + '</b>（' + fx(first.total) + ' 分，得分率 ' + fx(first.rate * 100, 1) + '%）；' +
      '末位为 <b>' + esc(last.speaker.name) + '</b>（' + fx(last.total) + ' 分）。' +
      '选手平均得分 <b>' + fx(avgAll) + '</b> 分，全场极差 <b>' + fx(maxScore - minScore) + '</b> 分，' +
      (maxScore - minScore > res.wMax * 0.25 ? '差距明显，选手水平分化较大。' : '分差不大，竞争较为胶着。') +
    '</div></div>' +

    (gWeak ? '<div class="analysis-blk"><div class="t">📊 一级维度表现</div><div class="d">' +
      '四大考核板块中，得分率最低的是 <b>' + esc(gWeak.group) + '</b>（得分率 ' + fx(gWeak.rate * 100, 1) + '%，人均失分 ' + fx(gWeak.max - gWeak.avg, 2) + ' 分 / 满分 ' + fx(gWeak.max, 0) + ' 分），' +
      '是本次整体最薄弱的板块；表现最好的是 <b>' + esc(gStrong.group) + '</b>（得分率 ' + fx(gStrong.rate * 100, 1) + '%）。' +
      '各板块得分率：' + gList.map(g => esc(g.group) + ' ' + fx(g.rate * 100, 1) + '%').join('、') + '。' +
    '</div></div>' : '') +

    '<div class="analysis-blk"><div class="t">📉 共性失分细则</div><div class="d">' +
      '全场得分率最低的细则是 <b>' + esc(weakest.name) + '</b>（得分率 ' + fx(weakest.rate * 100, 1) + '%，人均失分 ' + fx(weakest.max - weakest.avg, 2) + ' 分）——' +
      '这是本次选手整体最薄弱的环节，建议作为后续培训与复盘的<b>首要改进方向</b>。' +
      '相对而言表现最好的细则是 <b>' + esc(strongest.name) + '</b>（得分率 ' + fx(strongest.rate * 100, 1) + '%）。' +
    '</div></div>' +

    '<div class="analysis-blk"><div class="t">⚖️ 评委一致性</div><div class="d">' +
      '评委间平均分极差为 <b>' + fx(Math.max.apply(null, res.judgeStats.map(j => j.avg || 0)) - Math.min.apply(null, res.judgeStats.map(j => j.avg || 0))) + '</b> 分。' +
      (mostDivisive && mostDivisive.maxSpread > 0
        ? '分歧最大的细则是 <b>' + esc(mostDivisive.dim) + '</b>，最大分差达 <b>' + fx(mostDivisive.maxSpread) + '</b> 分（' + esc(mostDivisive.maxName) + '）；' +
          '一致性最高的是 <b>' + esc(volatility.slice().sort((a, b) => a.avgDiff - b.avgDiff)[0].dim) + '</b>。'
        : '') +
      '若某位评委整体明显偏高或偏低，可在导出数据中进一步核查其打分习惯。' +
    '</div></div>' +

    '<div class="analysis-blk"><div class="t">💡 改进建议</div><div class="d">' +
      '① 针对薄弱细则 <b>' + esc(weakest.name) + '</b> 组织专项训练；' +
      '② 对得分靠后选手（' + esc(ranked.slice(Math.max(0, ranked.length - 2)).map(r => r.speaker.name).join('、')) + '）进行一对一反馈；' +
      '③ 若需对外发布结果，建议同时公布各一级维度得分，避免仅看总分造成片面评价。' +
    '</div></div>' +
    '</div>' +

    '<div class="grid2" style="align-items:start">' +
    '<div class="card"><div class="card-t">' + (hasGroup ? '一级维度总体得失' : '各维度总体得失情况') + '</div>' +
      '<div class="card-d">得分率越低，说明该维度选手普遍失分越多。</div>' +
      (groupHtml || '') + '</div>' +
    '<div class="card"><div class="card-t">评委打分倾向</div>' +
      '<div class="card-d">与全场平均对比，识别偏宽松/偏严格的评委。</div>' +
      '<div class="tbl-wrap"><table class="tbl"><thead><tr><th>评委</th><th>平均单维度分</th><th>倾向</th><th>完成度</th></tr></thead><tbody>' +
      judgeRows + '</tbody></table></div></div>' +
    '</div>' +

    '<div class="card"><div class="card-t">' + (hasGroup ? '各二级细则得失明细' : '各维度总体得失情况') + '</div>' +
      '<div class="card-d">二级细则为实际打分行，此处反映每项细则的得失分布。</div>' + dimHtml + '</div>' +

    '<div class="card"><div class="card-t">选手强弱项对照</div>' +
      '<div class="card-d">「相对强弱」为该选手某维度得分率与全场该维度得分率之差，正值表示相对占优。</div>' +
      '<div class="tbl-wrap"><table class="tbl"><thead><tr><th>排名</th><th>选手</th><th>总分</th><th>相对最强项</th><th>相对最弱项</th><th>建议关注</th></tr></thead><tbody>' +
      weakStrong.map(ws => '<tr>' +
        '<td class="rank rank-' + (ws.r.rank <= 3 ? ws.r.rank : '') + '">' + ws.r.rank + '</td>' +
        '<td class="num">' + esc(ws.r.speaker.name) + '</td>' +
        '<td class="num">' + fx(ws.r.total) + '</td>' +
        '<td>' + (ws.best ? esc(ws.best.name) + ' <span class="delta p">+' + fx(ws.best.rel * 100, 1) + '%</span>' : '—') + '</td>' +
        '<td>' + (ws.worst ? esc(ws.worst.name) + ' <span class="delta n">' + fx(ws.worst.rel * 100, 1) + '%</span>' : '—') + '</td>' +
        '<td>' + (ws.worst && ws.worst.rate < 0.75 ? '<span class="pill pill-r">' + esc(ws.worst.name) + '待提升</span>' : '<span class="pill pill-g">均衡</span>') + '</td>' +
      '</tr>').join('') + '</tbody></table></div></div>';
}
function afterAnalysis(){}

/* --- 8.6 导出 --- */
function buildExport(){
  const ev = S.event;
  const res = computeResults(ev, S.speakers, S.scores);
  const dims = res.dims;

  /* 明细 CSV */
  const detail = [['选手序号','选手姓名','单位/部门','评委姓名'].concat(dims.map(d => d.name + '(' + d.max + ')')).concat(['合计','提交时间'])];
  S.scores.slice().sort((a, b) => num(a.speaker_id) - num(b.speaker_id)).forEach(s => {
    const sp = S.speakers.find(x => String(x.id) === String(s.speaker_id));
    const row = [sp ? num(sp.seq) : '', sp ? sp.name : '', sp ? (sp.department || '') : '', s.judge_name];
    let tot = 0;
    dims.forEach(d => { const v = s.scores ? num(s.scores[d.id], 0) : 0; tot += v; row.push(v); });
    row.push(Math.round(tot * 100) / 100);
    row.push(s.updated_at || s.created_at || '');
    detail.push(row);
  });

  /* 汇总 CSV */
  const summary = [['排名','选手序号','选手姓名','单位/部门','评委数']
    .concat(dims.map(d => d.name + '均分'))
    .concat(dims.map(d => d.name + '得分率'))
    .concat(['加权总分','总分上限','得分率','是否完整'])] ;
  res.ranked.forEach(r => {
    const row = [r.rank, num(r.speaker.seq), r.speaker.name, r.speaker.department || '', r.judgeCount];
    dims.forEach(d => row.push(r.dims[d.id] && r.dims[d.id].avg !== null ? fx(r.dims[d.id].avg, 2) : ''));
    dims.forEach(d => row.push(r.dims[d.id] && r.dims[d.id].rate !== null ? fx(r.dims[d.id].rate * 100, 1) + '%' : ''));
    row.push(fx(r.total, 2), fx(r.maxTotal, 0), fx(r.rate * 100, 1) + '%', r.complete ? '是' : '否');
    summary.push(row);
  });

  /* 维度分析 CSV（含一级分组） */
  const dimCsv = [['一级等级','二级细则','分值','权重','全场均分','得分率','人均失分','全场最高均分','全场最低均分']];
  res.dimStats.forEach(d => {
    let mx = -Infinity, mn = Infinity;
    res.rows.forEach(r => { const o = r.dims[d.id]; if (o && o.avg !== null) { mx = Math.max(mx, o.avg); mn = Math.min(mn, o.avg); } });
    const meta = res.dims.find(x => x.id === d.id) || {};
    dimCsv.push([meta.group || '未分组', d.name, d.max, d.weight, fx(d.avg, 2), fx(d.rate * 100, 1) + '%', fx(d.max - d.avg, 2),
      mx === -Infinity ? '' : fx(mx, 2), mn === Infinity ? '' : fx(mn, 2)]);
  });

  /* 一级维度汇总 CSV */
  const groupCsv = [['一级维度','满分','全场均分','得分率','人均失分','细则项数']];
  res.groups.forEach(g => {
    groupCsv.push([g.group || '未分组', fx(g.max, 0), fx(g.avg, 2), fx(g.rate * 100, 1) + '%',
      fx(g.max - g.avg, 2), g.count]);
  });

  /* 评委 CSV */
  const judgeCsv = [['评委','已评选手数','选手总数','完成率','平均单维度分','最新提交时间']];
  res.judgeStats.forEach(j => {
    judgeCsv.push([j.name, j.scored, j.total, fx(j.rate * 100, 1) + '%', j.avg !== null ? fx(j.avg, 2) : '', j.lastAt || '']);
  });

  /* AI 提示词 */
  const prompt = buildAIPrompt(ev, res);

  return { detail, summary, dimCsv, groupCsv, judgeCsv, prompt, res };
}

function buildAIPrompt(ev, res){
  const dims = res.dims;
  const hasGroup = res.groups.some(g => g.group);
  const L = [];
  L.push('你是一位专业的演讲比赛评委组长与培训专家。请基于下列真实评分数据，为我输出一份深度分析报告。');
  L.push('');
  L.push('## 一、活动背景');
  L.push('- 活动名称：' + ev.name);
  if (hasGroup) {
    L.push('- 评分结构（两级制）：');
    res.groups.filter(g => g.group).forEach(g => {
      L.push('  - ' + g.group + '（满分 ' + fx(g.max, 0) + ' 分）：' +
        dims.filter(d => d.group === g.group).map(d => d.name + '（' + d.max + '分）').join('、'));
    });
    const ungrouped = dims.filter(d => !d.group);
    if (ungrouped.length) L.push('  - 未分组细则：' + ungrouped.map(d => d.name + '（' + d.max + '分）').join('、'));
  }
  L.push('- 评分细则与分值：' + dims.map(d => (d.group ? '[' + d.group + '] ' : '') + d.name + '（满分 ' + d.max + '，权重 ' + d.weight + '）').join('；'));
  L.push('- 总分上限：' + fx(res.wMax, 0) + ' 分');
  L.push('- 计分规则：' + ((res.settings.dropHighest || res.settings.dropLowest)
      ? ('去除' + (res.settings.dropHighest ? '最高分' : '') + (res.settings.dropHighest && res.settings.dropLowest ? '和' : '') + (res.settings.dropLowest ? '最低分' : '') + '各 ' + res.settings.dropCount + ' 个后取平均')
      : '所有有效评分取算术平均'));
  L.push('- 评委人数：' + res.judges.length + ' 位（' + res.judges.join('、') + '）');
  L.push('- 选手人数：' + S.speakers.length + ' 名');
  L.push('- 有效评分记录：' + S.scores.length + ' 条');
  L.push('');
  L.push('## 二、最终排名与各细则得分');
  L.push('| 排名 | 选手 | ' + dims.map(d => (hasGroup && d.group ? d.group.replace(/^[一二三四五六七八九十]+、/, '') + '-' : '') + d.name + '(' + d.max + ')').join(' | ') + ' | 加权总分(' + fx(res.wMax, 0) + ') | 得分率 |');
  L.push('|---|---|' + dims.map(() => '---|').join('') + '---|---|');
  res.ranked.forEach(r => {
    L.push('| ' + r.rank + ' | ' + r.speaker.name + ' | ' +
      dims.map(d => { const o = r.dims[d.id]; return o && o.avg !== null ? fx(o.avg, 2) : '—'; }).join(' | ') +
      ' | ' + fx(r.total, 2) + ' | ' + fx(r.rate * 100, 1) + '% |');
  });
  L.push('');
  if (hasGroup) {
    L.push('## 二之二、各选手一级维度得分（汇总）');
    const gs = res.groups.filter(g => g.group);
    L.push('| 排名 | 选手 | ' + gs.map(g => g.group + '(' + fx(g.max, 0) + ')').join(' | ') + ' | 总分 |');
    L.push('|---|---|' + gs.map(() => '---|').join('') + '---|');
    res.ranked.forEach(r => {
      L.push('| ' + r.rank + ' | ' + r.speaker.name + ' | ' +
        gs.map(g => { const o = r.groups && r.groups[g.group]; return o && o.avg !== null ? fx(o.avg, 2) : '—'; }).join(' | ') +
        ' | ' + fx(r.total, 2) + ' |');
    });
    L.push('');
    L.push('## 二之三、一级维度全场汇总');
    L.push('| 一级维度 | 满分 | 全场均分 | 得分率 | 人均失分 |');
    L.push('|---|---|---|---|---|');
    gs.forEach(g => {
      L.push('| ' + g.group + ' | ' + fx(g.max, 0) + ' | ' + fx(g.avg, 2) + ' | ' + fx(g.rate * 100, 1) + '% | ' + fx(g.max - g.avg, 2) + ' |');
    });
  }
  L.push('');
  L.push('## 三、各细则全场表现');
  L.push('| 一级维度 | 细则 | 满分 | 全场均分 | 得分率 | 人均失分 | 最高均分 | 最低均分 |');
  L.push('|---|---|---|---|---|---|---|---|');
  res.dimStats.forEach(d => {
    let mx = -Infinity, mn = Infinity, mxN = '', mnN = '';
    res.rows.forEach(r => { const o = r.dims[d.id]; if (o && o.avg !== null) { if (o.avg > mx) { mx = o.avg; mxN = r.speaker.name; } if (o.avg < mn) { mn = o.avg; mnN = r.speaker.name; } } });
    const meta = res.dims.find(x => x.id === d.id) || {};
    L.push('| ' + (meta.group || '未分组') + ' | ' + d.name + ' | ' + d.max + ' | ' + fx(d.avg, 2) + ' | ' + fx(d.rate * 100, 1) + '% | ' + fx(d.max - d.avg, 2) +
      ' | ' + (mx === -Infinity ? '—' : fx(mx, 2) + '（' + mxN + '）') + ' | ' + (mn === Infinity ? '—' : fx(mn, 2) + '（' + mnN + '）') + ' |');
  });
  L.push('');
  L.push('## 四、评委打分倾向');
  L.push('| 评委 | 平均单维度分 | 已评选手 | 完成率 |');
  L.push('|---|---|---|---|');
  res.judgeStats.forEach(j => {
    L.push('| ' + j.name + ' | ' + (j.avg !== null ? fx(j.avg, 2) : '—') + ' | ' + j.scored + '/' + j.total + ' | ' + fx(j.rate * 100, 1) + '% |');
  });
  L.push('');
  L.push('## 五、各评委对每位选手的原始打分（用于交叉验证与异常识别）');
  L.push('| 选手 | 评委 | ' + dims.map(d => d.name).join(' | ') + ' | 合计 |');
  L.push('|---|---|' + dims.map(() => '---|').join('') + '---|');
  S.scores.slice().sort((a, b) => num(a.speaker_id) - num(b.speaker_id)).forEach(s => {
    const sp = S.speakers.find(x => String(x.id) === String(s.speaker_id));
    let tot = 0;
    dims.forEach(d => { tot += num(s.scores ? s.scores[d.id] : 0, 0); });
    L.push('| ' + (sp ? sp.name : '?') + ' | ' + s.judge_name + ' | ' +
      dims.map(d => (s.scores && s.scores[d.id] != null ? fx(s.scores[d.id], 1) : '—')).join(' | ') +
      ' | ' + fx(tot, 1) + ' |');
  });
  L.push('');
  L.push('## 六、请你完成以下分析任务');
  L.push('1. **排名合理性验证**：检查是否存在评委打分明显偏离群体的情况，指出可能的异常打分及其对排名的影响。');
  L.push('2. **共性薄弱环节**：' + (hasGroup ? '先从一级维度（' + res.groups.filter(g => g.group).map(g => g.group).join('、') + '）判断整体最薄弱板块，再细化到二级细则，指出选手整体最薄弱的 1-2 项并分析可能原因。' : '从维度得分率出发，指出选手整体最薄弱的 1-2 个维度，并分析可能原因。'));
  L.push('3. **选手个体诊断**：为排名前 3 与排名后 2 的选手分别给出「优势维度 / 短板维度 / 具体提升建议」。');
  L.push('4. **评委一致性评估**：评估评委之间打分的一致性，指出偏宽松或偏严格的评委，判断是否需要复核。');
  L.push('5. **可操作改进清单**：面向组织方，给出 5 条可落地的改进建议（含培训重点、赛制优化、评分表优化）。');
  L.push('6. **一句话总结**：用一句话概括本次比赛的总体水平与最突出的问题。');
  L.push('');
  L.push('请注意：分析要基于数据、结论要具体，避免空泛的套话。若某个维度样本过少，请明确指出数据局限性。');
  return L.join('\n');
}

function TabExport(){
  const res = computeResults(S.event, S.speakers, S.scores);
  return '<div class="card"><div class="card-t">📦 导出完整评分数据</div>' +
    '<div class="card-d">导出内容包含活动配置、选手名单、全部原始打分与计算结果，可直接交给 AI 进行深度分析。</div>' +
    '<div class="kpis" style="margin:4px 0 16px">' +
      kpi('原始评分记录', S.scores.length, '条') +
      kpi('涉及选手', S.speakers.length, '人') +
      kpi('涉及评委', res.judges.length, '位') +
      kpi('数据完整度', S.speakers.length ? fx(S.scores.length / (S.speakers.length * Math.max(1, res.judges.length)) * 100, 0) : 0, '%') +
    '</div>' +
    '<div class="row-btns">' +
      '<button class="btn btn-p" data-a="expAll">⬇ 导出全部数据（CSV 包）</button>' +
      '<button class="btn btn-p" data-a="expAI">🤖 生成 AI 分析提示词 + 数据</button>' +
      '<button class="btn" data-a="expSummary">导出排名汇总</button>' +
      '<button class="btn" data-a="expDetail">导出原始打分明细</button>' +
      '<button class="btn" data-a="expJSON">导出 JSON 全量</button>' +
    '</div>' +
    '<div class="hr"></div>' +
    '<div class="card-t" style="font-size:14px">数据预览（AI 分析提示词节选）</div>' +
    '<div class="code">' + esc(buildAIPrompt(S.event, res).split('\n').slice(0, 26).join('\n')) + '\n…</div>' +
    '<div class="hint" style="margin-top:9px">完整提示词包含全部原始打分数据，点击上方「生成 AI 分析提示词 + 数据」即可获取。</div>' +
  '</div>';
}

/* ---------------- 9. 视图：评委端 ---------------- */
Views.judgeEntry = async function(){
  const eid = S.route.params.get('e');
  const app = $('#app');
  if (!eid) { app.innerHTML = shell('<div class="wrap-narrow" style="padding-top:40px"><div class="card">' +
    '<div class="card-t">链接无效</div><div class="card-d">缺少活动参数，请重新扫码。</div></div></div>', {}); return; }

  app.innerHTML = shell('<div class="wrap-narrow" style="padding-top:30px"><div class="loading"><span class="spin spin-d"></span> 加载…</div></div>', {});
  let ev;
  try { ev = await DB.getEvent(eid); } catch (e) { toast(dbErr(e), 'err'); }
  if (!ev) {
    app.innerHTML = shell('<div class="wrap-narrow" style="padding-top:40px"><div class="card">' +
      '<div class="card-t">活动不存在</div><div class="card-d">该活动可能已被删除，请向组织者确认链接。</div></div></div>', {});
    return;
  }
  S.event = ev;
  S.event.dimensions = normDims(ev.dimensions);
  S.event.settings = normSettings(ev.settings);

  const saved = LS.get(judgeNameKey(eid), '');
  const presetJ = normJudges(S.event.settings && S.event.settings.judgeRoster);
  const excl = normExcluded(S.event.settings && S.event.settings.excludedJudges);
  const bound = devBound(eid);
  const lockOn = S.event.settings.deviceLock !== false;   /* 默认开启 */
  const hist = devHistory(eid);

  /* 本机已绑定评委：直接给「继续评分」，不再给自由输入框（防同一设备换名多评） */
  if (bound && lockOn && excl.indexOf(bound.judge) < 0) {
    app.innerHTML = shell('<div class="wrap-narrow" style="padding-top:22px">' +
      '<div class="board-hero" style="padding:18px 20px"><h1 style="font-size:19px">' + esc(ev.name) + '</h1>' +
        '<div class="sub">' + (ev.status === 'live' ? '● 正在接收评分' : ev.status === 'closed' ? '评分已结束' : '筹备中') + '</div></div>' +
      '<div class="card"><div class="card-t">🔒 本机已绑定评委</div>' +
        '<div class="card-d">这台设备已用于 <b>' + esc(bound.judge) + '</b> 评分（' + fmtTime(bound.at) + '）。<br>' +
          '为防止同一设备代多人打分，<b>本机已锁定为该评委</b>。</div>' +
        '<div class="bindbox"><div class="bindbox-n">' + esc(bound.judge) + '</div>' +
          (bound.dept ? '<div class="bindbox-d">' + esc(bound.dept) + '</div>' : '') + '</div>' +
        '<button class="btn btn-p btn-lg btn-block" data-a="judgeLogin">继续以「' + esc(bound.judge) + '」评分</button>' +
        '<div class="row-btns" style="margin-top:10px">' +
          '<button class="btn btn-sm" data-a="judgeSwitch" data-bound="' + esc(bound.judge) + '">更换评委（需管理口令）</button>' +
        '</div>' +
        (hist.length ? '<div class="hint" style="margin-top:10px">本机换人记录：' +
          hist.slice(-3).map(h => esc(h.from || '—') + ' → ' + esc(h.to)).join('　|　') + '</div>' : '') +
        '<div class="hint" style="margin-top:8px">如这台设备需换给别的评委，请点上方按钮并由管理员输入口令放行。</div>' +
      '</div></div>', {});
    return;
  }

  app.innerHTML = shell('<div class="wrap-narrow" style="padding-top:22px">' +
    '<div class="board-hero" style="padding:18px 20px"><h1 style="font-size:19px">' + esc(ev.name) + '</h1>' +
      '<div class="sub">' + (ev.status === 'live' ? '● 正在接收评分' : ev.status === 'closed' ? '评分已结束' : '筹备中') + '</div></div>' +
    '<div class="card"><div class="card-t">👋 欢迎，请输入您的姓名</div>' +
      '<div class="card-d">姓名用于区分不同评委的评分，提交后不可更改（如需修改请点「切换评委」）。' +
        (lockOn ? '<br>提交后<b>这台设备将绑定为您的评委身份</b>，如需换人需管理员口令放行。' : '') + '</div>' +
      (presetJ.length ? '<div class="jroster"><div class="jroster-t">评委名单（点击快速填入）</div>' +
        presetJ.map(j => '<button class="jroster-i" data-a="pickJudge" data-name="' + esc(j.name) + '">' +
          esc(j.name) + (j.dept ? '<span class="jroster-d">' + esc(j.dept) + '</span>' : '') + '</button>').join('') + '</div>' : '') +
      '<div class="field"><label>评委姓名</label>' +
        '<input class="inp" id="jName" value="' + esc(saved) + '" placeholder="请输入您的真实姓名" maxlength="20"></div>' +
      '<button class="btn btn-p btn-lg btn-block" data-a="judgeLogin">开始评分</button>' +
      '<div class="hint" style="text-align:center;margin-top:12px">评分维度：' + S.event.dimensions.map(d => esc(d.name) + ' ' + fx(d.max, 0) + '分').join(' · ') + '</div>' +
    '</div></div>', {});
  const inp = $('#jName');
  if (inp) {
    setTimeout(() => inp.focus(), 90);
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') Actions.judgeLogin(); });
  }
};

Views.judgeList = async function(){
  const eid = S.route.params.get('e');
  const app = $('#app');
  const jn = LS.get(judgeNameKey(eid), '');
  if (!eid || !jn) { go('#/judge?e=' + eid); return; }

  app.innerHTML = shell('<div class="jwrap" style="padding-top:24px"><div class="loading"><span class="spin spin-d"></span> 加载…</div></div>',
    { nav: judgeNav(eid) });
  try {
    S.event = await DB.getEvent(eid);
    if (!S.event) { go('#/judge?e=' + eid); return; }
    S.event.dimensions = normDims(S.event.dimensions);
    S.event.settings = normSettings(S.event.settings);
    S.speakers = await DB.listSpeakers(eid);
    S.scores = await DB.listScores(eid);
  } catch (e) { toast(dbErr(e), 'err'); return; }

  const my = S.scores.filter(s => s.judge_name === jn);
  const myBySpk = {};
  my.forEach(s => { myBySpk[String(s.speaker_id)] = s; });
  const doneN = S.speakers.filter(sp => myBySpk[String(sp.id)]).length;
  const pct = S.speakers.length ? Math.round(doneN / S.speakers.length * 100) : 0;

  app.innerHTML = shell('<div class="jwrap" style="padding-top:20px">' +
    '<div class="card" style="padding:16px"><div style="display:flex;align-items:center;gap:12px">' +
      '<div style="flex:1;min-width:0"><div class="card-t" style="margin-bottom:2px">' + esc(S.event.name) + '</div>' +
      '<div class="lrow-s">评委：<b>' + esc(jn) + '</b></div></div>' +
      '<div style="text-align:right"><div style="font-size:24px;font-weight:850;color:#2563eb">' + doneN + '<span style="font-size:14px;color:#9ca3af">/' + S.speakers.length + '</span></div>' +
      '<div class="lrow-s">已评</div></div></div>' +
      '<div class="bar" style="margin-top:11px"><i style="width:' + pct + '%"></i></div>' +
    '</div>' +
    '<div class="sec-title">请选择打分选手</div>' +
    (S.speakers.length ? '<div class="card" style="padding:8px 16px">' + S.speakers.map(sp => {
      const s = myBySpk[String(sp.id)];
      const tot = s ? S.event.dimensions.reduce((a, d) => a + num(s.scores ? s.scores[d.id] : 0), 0) : null;
      return '<div class="lrow" style="cursor:pointer" data-a="judgeOpenSpk" data-id="' + sp.id + '">' +
        '<span class="lrow-idx">' + num(sp.seq) + '</span>' +
        '<div class="lrow-main"><div class="lrow-t">' + esc(sp.name) + '</div>' +
          '<div class="lrow-s">' + esc(sp.department || '') + (s ? ' · 已提交 ' + fmtTime(s.updated_at || s.created_at) : '') + '</div>' +
          (sp.group_name ? '<div class="lrow-s" style="color:#9ca3af;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(sp.group_name) + '</div>' : '') +
        '</div>' +
        (s ? '<span class="pill pill-g">' + fx(tot, 1) + ' 分</span>' : '<span class="pill pill-a">待评</span>') +
        '<span style="color:#9ca3af">›</span></div>';
    }).join('') + '</div>'
      : '<div class="card"><div class="empty"><div class="ico">👥</div><div class="t">暂无选手</div>' +
        '<div class="d">组织者尚未录入选手名单，请稍后再试。</div></div></div>') +
    '</div>', { nav: judgeNav(eid) });
};

Views.judgeScore = async function(){
  const eid = S.route.params.get('e');
  const sid = S.route.params.get('s');
  const jn = LS.get(judgeNameKey(eid), '');
  const app = $('#app');
  if (!eid || !sid || !jn) { go('#/judge/list?e=' + eid); return; }

  app.innerHTML = shell('<div class="jwrap" style="padding-top:24px"><div class="loading"><span class="spin spin-d"></span> 加载…</div></div>', {});
  try {
    if (!S.event || String(S.event.id) !== String(eid)) {
      S.event = await DB.getEvent(eid);
      S.event.dimensions = normDims(S.event.dimensions);
      S.event.settings = normSettings(S.event.settings);
    }
    S.speakers = await DB.listSpeakers(eid);
  } catch (e) { toast(dbErr(e), 'err'); return; }

  const sp = S.speakers.find(x => String(x.id) === String(sid));
  if (!sp) { go('#/judge/list?e=' + eid); return; }

  let mine = null;
  try {
    const all = await DB.listScores(eid);
    mine = all.find(s => String(s.speaker_id) === String(sid) && s.judge_name === jn) || null;
  } catch (e) {}

  const dims = S.event.dimensions;
  const initVals = {};
  dims.forEach(d => {
    const v = mine && mine.scores && mine.scores[d.id] != null ? Number(mine.scores[d.id]) : Math.round(num(d.max, 0) * 0.8);
    initVals[d.id] = v;
  });

  /* 该选手的出场顺序信息 */
  const orderIdx = S.speakers.findIndex(x => String(x.id) === String(sid)) + 1;
  const groups = groupDims(dims);

  /* 二级细则卡片（含打分标准与档位快捷按钮） */
  function dimCard(d){
    const tiers = parseTiers(d.tiers, d.max);
    const quickBtns = tiers.length
      ? tiers.map(t => '<button data-a="quickSet" data-dim="' + esc(d.id) + '" data-val="' + t.value + '">' +
          esc(t.label) + ' ' + fx(t.value, 0) + '</button>').join('')
      : [100, 90, 85, 80, 70, 60].map(p =>
          '<button data-a="quickSet" data-dim="' + esc(d.id) + '" data-pct="' + p + '">' + p + '%</button>').join('') +
        '<button data-a="quickSet" data-dim="' + esc(d.id) + '" data-pct="0">0</button>';
    return '<div class="score-card">' +
      '<div class="score-head"><span class="score-name">' + esc(d.name) + '</span>' +
        '<span class="score-val" id="v_' + esc(d.id) + '">' + initVals[d.id] + ' <small>/ ' + fx(d.max, 0) + '</small></span></div>' +
      (d.desc ? '<details class="std"><summary>查看打分标准</summary><div class="std-body">' + esc(d.desc) + '</div></details>' : '') +
      '<input type="range" min="0" max="' + num(d.max, 10) + '" step="0.5" value="' + initVals[d.id] + '" id="r_' + esc(d.id) + '" data-dim="' + esc(d.id) + '" data-max="' + num(d.max, 10) + '">' +
      '<div class="quick">' + quickBtns + '</div>' +
    '</div>';
  }

  const cardsHtml = groups.map((g, gi) =>
    (g.group ? '<div class="dim-group"><div class="dim-group-t">' + esc(g.group) +
      '<span class="dim-group-m"><b id="gsub_' + gi + '">0</b> / ' + fx(g.max, 0) + ' 分</span></div>' : '<div class="dim-group">') +
    g.dims.map(dimCard).join('') + '</div>'
  ).join('');

  app.innerHTML = shell('<div class="jwrap" style="padding-top:18px">' +
    '<div class="card" style="padding:15px 16px;margin-bottom:14px">' +
      '<div style="display:flex;align-items:center;gap:12px">' +
        '<div class="mrank" style="background:#eff6ff;color:#1d4ed8;font-weight:850">' + num(sp.seq) + '</div>' +
        '<div style="flex:1;min-width:0"><div class="card-t" style="margin-bottom:1px">' + esc(sp.name) + '</div>' +
          '<div class="lrow-s">' + esc(sp.department || '') + ' · 第 ' + orderIdx + ' 位出场</div>' +
          (sp.group_name ? '<div class="lrow-s" style="margin-top:2px">汇报主题：' + esc(sp.group_name) + '</div>' : '') +
        '</div>' +
        (mine ? '<span class="pill pill-g">已提交</span>' : '<span class="pill pill-a">未提交</span>') +
      '</div>' +
    '</div>' +
    '<div class="jtotal"><span class="t">当前合计</span><span class="v" id="jTotal">0</span></div>' +
    '<div id="dimCards">' + cardsHtml + '</div>' +
    '<div class="field"><label>评语（选填）</label>' +
      '<textarea class="inp" id="jComment" placeholder="对该选手的简短评语或建议…" style="min-height:76px">' + esc(mine && mine.comment ? mine.comment : '') + '</textarea></div>' +
    '</div>' +
    '<div class="sticky-foot"><div class="sticky-foot-in">' +
      '<button class="btn" data-a="judgeBack" style="flex:0 0 auto">返回</button>' +
      '<button class="btn btn-p" data-a="judgeSubmit" style="flex:1">' + (mine ? '更新我的评分' : '提交评分') + '</button>' +
    '</div></div>', { nav: judgeNav(eid) });

  const recalc = () => {
    let tot = 0;
    dims.forEach(d => {
      const el = $('#r_' + d.id);
      const vEl = $('#v_' + d.id);
      if (!el) return;
      const v = num(el.value, 0);
      tot += v;
      if (vEl) vEl.innerHTML = fx(v, 1) + ' <small>/ ' + fx(d.max, 0) + '</small>';
    });
    /* 分组小计 */
    groups.forEach((g, gi) => {
      let sub = 0;
      g.dims.forEach(d => { const el = $('#r_' + d.id); if (el) sub += num(el.value, 0); });
      const el = $('#gsub_' + gi);
      if (el) el.textContent = fx(sub, 1) + ' / ' + fx(g.max, 0);
    });
    const tEl = $('#jTotal');
    if (tEl) tEl.textContent = fx(tot, 1);
  };
  $$('#dimCards input[type=range]').forEach(el => {
    el.addEventListener('input', recalc);
  });
  recalc();
  window.__recalc = recalc;
};

/* ---------------- 10. 视图：大屏看板 ---------------- */
Views.board = async function(){
  const eid = S.route.params.get('e');
  const app = $('#app');
  app.innerHTML = shell('<div class="wrap"><div class="loading"><span class="spin spin-d"></span> 加载看板…</div></div>', {});
  try {
    S.event = await DB.getEvent(eid);
    if (!S.event) throw new Error('活动不存在');
    S.event.dimensions = normDims(S.event.dimensions);
    S.event.settings = normSettings(S.event.settings);
  } catch (e) {
    app.innerHTML = shell('<div class="wrap"><div class="card"><div class="card-t">无法打开看板</div>' +
      '<div class="card-d">' + esc(e.message || dbErr(e)) + '</div></div></div>', {});
    return;
  }
  await refreshBoard();
  if (S.timer) clearInterval(S.timer);
  S.timer = setInterval(() => { if (!document.hidden) refreshBoard(); }, 5000);
};

async function refreshBoard(){
  const eid = S.event.id;
  try {
    S.speakers = await DB.listSpeakers(eid);
    S.scores = await DB.listScores(eid);
  } catch (e) { return; }
  const res = computeResults(S.event, S.speakers, S.scores);
  const app = $('#app');
  const avg = res.ranked.length ? res.ranked.reduce((a, r) => a + r.total, 0) / res.ranked.length : 0;

  app.innerHTML = shell('<div class="wrap">' +
    '<div class="board-hero"><h1>🏆 ' + esc(S.event.name) + '</h1>' +
      '<div class="sub"><span class="live-dot"></span> 实时评分看板 · ' +
        S.speakers.length + ' 名选手 · ' + res.judges.length + ' 位评委 · 已收 ' + S.scores.length + ' 条评分 · 更新于 ' + fmtTime(new Date().toISOString()) + '</div></div>' +
    '<div class="kpis">' +
      kpi('当前领先', res.ranked.length ? String(res.ranked[0].speaker.name) : '—', '') +
      kpi('最高得分', res.ranked.length ? fx(res.ranked[0].total) : '—', '') +
      kpi('全场均分', fx(avg), '') +
      kpi('评分进度', progressPct(res), '%') +
    '</div>' +
    '<div class="grid2" style="align-items:start">' +
      '<div class="card"><div class="card-t">实时排名</div>' + rankListHtml(res) + '</div>' +
      '<div>' +
        '<div class="card"><div class="card-t">维度均分对比</div>' +
          res.dimStats.map(d => '<div style="margin-bottom:12px"><div style="display:flex;justify-content:space-between;font-size:13px;font-weight:700">' +
            '<span>' + esc(d.name) + '</span><span class="num">' + fx(d.avg) + ' / ' + fx(d.max, 0) + '</span></div>' +
            '<div class="bar ' + (d.rate >= 0.9 ? 'bar-ok' : d.rate >= 0.75 ? '' : 'bar-warn') + '" style="margin-top:5px">' +
            '<i style="width:' + Math.round(d.rate * 100) + '%"></i></div></div>').join('') +
        '</div>' +
        '<div class="card"><div class="card-t">评委提交进度</div>' +
          (res.judgeStats.length ? res.judgeStats.map(j =>
            '<div class="lrow"><div class="lrow-main"><div class="lrow-t" style="font-size:13.5px">' + esc(j.name) + '</div>' +
              '<div class="bar" style="margin-top:5px"><i style="width:' + Math.round(j.rate * 100) + '%"></i></div></div>' +
              '<span class="num" style="font-size:13px">' + j.scored + '/' + j.total + '</span></div>').join('')
            : '<div class="lrow-s">暂无评委提交</div>') +
        '</div>' +
      '</div>' +
    '</div></div>', { boardMode: true });
}

/* 大屏纯展示：不提供任何可跳转入口
   —— 观众扫码/投影时只能看，不能点进管理台、选手页或其他活动。 */

/* ---------------- 11. 交互动作 ---------------- */
const Actions = {
  goHome(){ go('#/'); },
  goAdmin(t){ if (t && t.dataset.tab) S.tab = t.dataset.tab; go('#/admin?e=' + S.event.id); },
  setTab(t){
    S.tab = t.dataset.tab;
    $$('.tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === S.tab));
    /* 看板/分析/导出依赖最新评分数据，切过去前先拉一次，避免显示旧快照 */
    if (['live', 'analysis', 'export', 'overview'].indexOf(S.tab) >= 0) {
      const body = $('#tabBody');
      if (body) body.innerHTML = '<div class="loading"><span class="spin spin-d"></span> 加载最新数据…</div>';
      DB.listScores(S.event.id).then(rows => {
        S.scores = rows;
        return DB.listSpeakers(S.event.id);
      }).then(sp => {
        S.speakers = sp;
        renderTab();
      }).catch(() => renderTab());
    } else {
      renderTab();
    }
  },
  openBoard(){ window.open(boardLink(S.event.id), '_blank'); },
  openBoardById(t){ window.open(boardLink(t.dataset.id), '_blank'); },
  openJudgeById(t){ window.open(judgeLink(t.dataset.id), '_blank'); },
  /* 进入管理台需口令：先本地校验拦住，再进管理台（管理台内部仍有一道校验） */
  async openAdmin(t){
    const id = t.dataset.id;
    if (adminUnlocked()) { go('#/admin?e=' + id); return; }
    const pin = await promptBox('🔒 需要管理口令',
      '进入活动管理台需要验证管理员身份。<br><span class="hint">如忘记口令，请在管理台内的「活动配置」中重置，或联系创建者。</span>',
      '', '管理口令');
    if (pin === null) return;
    const ok = await verifyAdminPin(pin);
    if (!ok) { toast('口令错误', 'err'); return; }
    LS.set('sp_admin_ok', '1');
    go('#/admin?e=' + id);
  },
  closeModalTop(){ const m = document.querySelector('.mask'); if (m) m.remove(); },

  async newEvent(){
    const name = await promptBox('创建新活动', '输入活动名称，创建后可在「活动配置」中调整评分维度。', '', '如：2026 年安全生产主题演讲比赛');
    if (!name) return;
    try {
      const ev = await DB.createEvent({
        name, dimensions: DEFAULT_DIMS, settings: DEFAULT_SETTINGS, status: 'draft'
      });
      toast('活动创建成功', 'ok');
      go('#/admin?e=' + ev.id);
    } catch (e) { toast(dbErr(e), 'err'); }
  },

  async delEvent(t){
    const id = t.dataset.id;
    const ev = S.events.find(x => String(x.id) === String(id));
    const evName = ev ? ev.name : id;

    /* 删除是不可逆操作：先要管理口令，再二次确认 */
    const pin = await promptBox('🔒 删除活动需要管理口令',
      '即将删除活动「<b>' + esc(evName) + '</b>」，并清除其<b>全部选手名单与评分记录</b>。' +
      '<br><br>此操作<b>不可恢复</b>，请输入管理口令以验证身份。', '', '管理口令');
    if (pin === null) return;
    const okPin = await verifyAdminPin(pin);
    if (!okPin) { toast('口令错误，未执行删除', 'err'); return; }

    const ok = await confirmBox('再次确认删除',
      '将永久删除活动「<b>' + esc(evName) + '</b>」及其全部选手名单与评分记录，此操作不可恢复。', '确认删除', true);
    if (!ok) return;

    try {
      /* 前端显式级联：数据库未建外键，直接删活动会留下孤儿数据
         （孤儿选手/评分会在导出与统计里造成幽灵记录） */
      const sp = await DB.listSpeakers(id).catch(() => []);
      for (const s of sp) { await DB.deleteSpeaker(s.id).catch(() => {}); }
      const sc = await DB.listScores(id).catch(() => []);
      for (const s of sc) { await DB.deleteScore(s.id).catch(() => {}); }
      await DB.deleteEvent(id);
      toast('已删除活动及全部关联数据', 'ok');
      Views.home();
    } catch (e) { toast(dbErr(e), 'err'); }
  },

  async showLinks(t){
    const id = t.dataset.id;
    const ev = S.events.find(x => String(x.id) === String(id));
    const m = modal('<h3>' + esc(ev ? ev.name : '') + ' · 分享入口</h3>' +
      '<p>评委用手机扫码或点击链接即可进入评分（无需登录）。</p>' +
      '<div class="qr-grid" style="justify-content:center"><div class="qr-box"><div id="qmJudge"></div><div class="hint" style="margin-top:9px">评委评分入口</div></div>' +
      '<div class="qr-box"><div id="qmBoard"></div><div class="hint" style="margin-top:9px">实时看板</div></div></div>' +
      '<div class="field" style="margin-top:14px"><label>评委入口</label><input class="inp" readonly value="' + esc(judgeLink(id)) + '" onclick="this.select()"></div>' +
      '<div class="field"><label>看板链接</label><input class="inp" readonly value="' + esc(boardLink(id)) + '" onclick="this.select()"></div>' +
      '<div class="row-btns" style="justify-content:space-between">' +
        '<button class="btn btn-sm" data-a="copyTextVal" data-src="' + esc(judgeLink(id)) + '">复制评委链接</button>' +
        '<button class="btn btn-sm" data-a="copyTextVal" data-src="' + esc(boardLink(id)) + '">复制看板链接</button>' +
        '<button class="btn" data-a="closeModalTop">关闭</button>' +
      '</div>');
    renderQR($('#qmJudge', m), judgeLink(id));
    renderQR($('#qmBoard', m), boardLink(id));
  },
  copyTextVal(t){ copyText(t.dataset.src, '已复制'); },
  copyJudgeLink(){ copyText(judgeLink(S.event.id), '评委链接已复制'); },
  copyBoardLink(){ copyText(boardLink(S.event.id), '看板链接已复制'); },
  downloadQR(){
    const img = $('#qrJudge img');
    if (!img || !img.src || img.src.indexOf('data:') !== 0) { toast('二维码未就绪', 'err'); return; }
    const a = document.createElement('a');
    a.href = img.src;
    a.download = (S.event.name || 'event') + '-评委入口二维码.png';
    document.body.appendChild(a); a.click(); a.remove();
    toast('二维码已下载', 'ok');
  },

  async checkPin(){
    const inp = $('#pinInput');
    const v = inp ? inp.value.trim() : '';
    if (!v) { toast('请输入口令', 'err'); return; }
    let pin = adminPin();
    if (!pin) {
      try { pin = await DB.getConfig('admin_pin'); } catch (e) {}
      if (!pin) pin = 'admin888';
      LS.set('sp_admin_pin', pin);
    }
    if (v === pin) { LS.set('sp_admin_ok', '1'); toast('验证通过', 'ok'); Views.adminRoute(); }
    else toast('口令错误', 'err');
  },
  logout(){ LS.set('sp_admin_ok', '0'); toast('已退出管理台'); go('#/'); },

  async changePin(){
    const cur = adminPin() || 'admin888';
    const np = await promptBox('修改管理口令', '当前口令：<b>' + esc(cur) + '</b>。请输入新口令（建议 6 位以上）。', '', '新口令');
    if (!np) return;
    try {
      await DB.setConfig('admin_pin', np);
      LS.set('sp_admin_pin', np);
      toast('口令已更新', 'ok');
    } catch (e) { toast(dbErr(e), 'err'); }
  },
  async resetPin(){
    const ok = await confirmBox('恢复默认口令', '口令将恢复为 <b>admin888</b>。', '确认恢复', true);
    if (!ok) return;
    try { await DB.setConfig('admin_pin', 'admin888'); LS.set('sp_admin_pin', 'admin888'); toast('已恢复默认口令', 'ok'); }
    catch (e) { toast(dbErr(e), 'err'); }
  },

  async saveBasic(){
    const name = ($('#cfgName') || {}).value;
    if (!name || !name.trim()) { toast('活动名称不能为空', 'err'); return; }
    const judgeSeeAll = ($('#cfgJudgeSeeAll') || {}).checked || false;
    const deviceLock = ($('#cfgDeviceLock') || {}).checked !== false;
    const st = Object.assign({}, S.event.settings, { judgeSeeAll, deviceLock });
    try {
      await DB.updateEvent(S.event.id, { name: name.trim(), settings: st });
      S.event.name = name.trim(); S.event.settings = st;
      toast('已保存', 'ok');
      Views.adminRoute();
    } catch (e) { toast(dbErr(e), 'err'); }
  },

  addDim(){
    const dims = readDimsFromUI();
    dims.push({ id: uid('d'), group: '', name: '新评分细则', max: 10, weight: 1, desc: '', tiers: '' });
    S.event.dimensions = dims;
    const box = $('#dimList'); if (box) box.innerHTML = dimRowsHtml(dims);
    afterConfig();
    toast('已添加细则，记得保存');
  },
  delDim(t){
    const id = t.dataset.dim;
    const dims = readDimsFromUI().filter(d => d.id !== id);
    if (!dims.length) { toast('至少保留一个维度', 'err'); return; }
    S.event.dimensions = dims;
    const box = $('#dimList'); if (box) box.innerHTML = dimRowsHtml(dims);
    afterConfig();
    toast('已删除，记得保存');
  },
  async resetDims(){
    const ok = await confirmBox('恢复默认模板', '将评分维度恢复为：主题内容 30 / 语言表达 30 / 台风仪表 20 / 时间控制 20。', '恢复模板', true);
    if (!ok) return;
    S.event.dimensions = DEFAULT_DIMS.map(d => Object.assign({}, d));
    const box = $('#dimList'); if (box) box.innerHTML = dimRowsHtml(S.event.dimensions);
    toast('已恢复模板，请保存');
  },
  async saveRules(){
    const dims = readDimsFromUI();
    if (!dims.length) { toast('至少需要一个评分维度', 'err'); return; }
    const st = Object.assign({}, S.event.settings, {
      dropHighest: ($('#cfgDropHigh') || {}).checked || false,
      dropLowest: ($('#cfgDropLow') || {}).checked || false,
      dropCount: Math.max(1, Math.round(num(($('#cfgDropCount') || {}).value, 1)))
    });
    try {
      await DB.updateEvent(S.event.id, { dimensions: dims, settings: st });
      S.event.dimensions = dims; S.event.settings = st;
      toast('评分细则已保存（总分上限 ' + dims.reduce((a, d) => a + d.max * d.weight, 0) + ' 分）', 'ok');
    } catch (e) { toast(dbErr(e), 'err'); }
  },

  async addSpeakers(){
    const ta = $('#spBatch');
    const raw = ta ? ta.value : '';
    const lines = raw.split('\n').map(l => l.trim()).filter(Boolean);
    if (!lines.length) { toast('请输入选手名单', 'err'); return; }
    const rows = lines.map((l, i) => {
      /* 支持两种分隔：逗号/制表符 分段；格式：姓名,单位,汇报主题（第三段可选） */
      const parts = l.split(/[,，\t]+/).map(x => x.trim());
      return {
        event_id: S.event.id,
        seq: S.speakers.length + i + 1,
        name: parts[0],
        department: parts[1] || '',
        group_name: parts.slice(2).join(' ') || ''
      };
    }).filter(r => r.name);
    if (!rows.length) { toast('未解析到有效姓名', 'err'); return; }
    try {
      await DB.addSpeakers(rows);
      S.speakers = await DB.listSpeakers(S.event.id);
      toast('已添加 ' + rows.length + ' 名选手', 'ok');
      renderTab();
    } catch (e) { toast(dbErr(e), 'err'); }
  },
  sampleSpeakers(){
    const ta = $('#spBatch');
    if (ta) ta.value = '张三,市场营销部,AI辅助文案创作\n李四,技术研发中心,AI办公实践分享\n王五,人力资源部,AI提升工作效率';
  },
  /* ---- 评委名单 ---- */
  async saveJudges(){
    const ta = $('#jdBatch');
    if (!ta) return;
    const lines = ta.value.split('\n').map(l => l.trim()).filter(Boolean);
    const list = normJudges(lines);
    if (!list.length) { toast('请至少录入一位评委', 'err'); return; }
    const dup = list.map(j => j.name).filter((n, i, a) => a.indexOf(n) !== i);
    if (dup.length) { toast('评委姓名重复：' + [...new Set(dup)].join('、'), 'err'); return; }
    const st = Object.assign({}, S.event.settings, { judgeRoster: list });
    try {
      await DB.updateEvent(S.event.id, { settings: st });
      S.event.settings = st;
      toast('评委名单已保存（' + list.length + ' 位）', 'ok');
      renderTab();
    } catch (e) { toast(dbErr(e), 'err'); }
  },
  sampleJudges(){
    const ta = $('#jdBatch');
    if (ta) ta.value = '张评委,示例集团研发中心\n李评委,示例集团品质部\n王评委,示例集团运营部';
  },
  async clearJudges(){
    const ok = await confirmBox('清空评委名单', '将删除预设的评委名单（已提交的评分数据不受影响）。', '确认清空', true);
    if (!ok) return;
    const st = Object.assign({}, S.event.settings, { judgeRoster: [] });
    try {
      await DB.updateEvent(S.event.id, { settings: st });
      S.event.settings = st;
      toast('评委名单已清空', 'ok');
      renderTab();
    } catch (e) { toast(dbErr(e), 'err'); }
  },
  /* ---- 移除 / 恢复单个评委 ----
     移除 = 加入 settings.excludedJudges → 其评分不计入任何统计（数据保留） */
  async removeJudge(t){
    const name = t.dataset.name || '';
    if (!name) return;
    const recs = num(t.dataset.records, 0);
    const ok = await confirmBox('移除评委「' + name + '」',
      (recs > 0
        ? '该评委已提交 <b>' + recs + '</b> 条评分，移除后这些评分将<b>不计入</b>排名与统计。'
        : '该评委尚未提交评分。') +
      '<br><br>数据<b>不会删除</b>，可随时在「已移除评委」区域点「恢复」重新计入。',
      '确认移除', true);
    if (!ok) return;
    const cur = normExcluded(S.event.settings && S.event.settings.excludedJudges);
    if (cur.indexOf(name) >= 0) { toast('该评委已在移除列表中', 'err'); return; }
    cur.push(name);
    const st = Object.assign({}, S.event.settings, { excludedJudges: cur });
    try {
      await DB.updateEvent(S.event.id, { settings: st });
      S.event.settings = st;
      toast('已移除「' + name + '」，其评分不再计入统计', 'ok');
      renderTab();
    } catch (e) { toast(dbErr(e), 'err'); }
  },
  async restoreJudge(t){
    const name = t.dataset.name || '';
    if (!name) return;
    const cur = normExcluded(S.event.settings && S.event.settings.excludedJudges).filter(n => n !== name);
    const st = Object.assign({}, S.event.settings, { excludedJudges: cur });
    try {
      await DB.updateEvent(S.event.id, { settings: st });
      S.event.settings = st;
      toast('已恢复「' + name + '」，其评分重新计入统计', 'ok');
      renderTab();
    } catch (e) { toast(dbErr(e), 'err'); }
  },
  /* 评委端：点击名单快速填入姓名 */
  pickJudge(t){
    const inp = $('#jName');
    if (!inp) return;
    inp.value = t.dataset.name || '';
    $$('.jroster-i').forEach(b => b.classList.toggle('on', b === t));
    inp.focus();
  },
  async spUp(t){
    const i = S.speakers.findIndex(x => String(x.id) === String(t.dataset.id));
    if (i <= 0) return;
    await swapSeq(i, i - 1);
  },
  async spDown(t){
    const i = S.speakers.findIndex(x => String(x.id) === String(t.dataset.id));
    if (i < 0 || i >= S.speakers.length - 1) return;
    await swapSeq(i, i + 1);
  },
  async spEdit(t){
    const sp = S.speakers.find(x => String(x.id) === String(t.dataset.id));
    if (!sp) return;
    const cur = [sp.name, sp.department || '', sp.group_name || ''].join(',');
    const v = await promptBox('编辑选手', '格式：<b>汇报人,项目名称,汇报主题</b>', cur, '汇报人,项目名称,汇报主题');
    if (v === null) return;
    const parts = v.split(/[,，\t]+/).map(x => x.trim());
    if (!parts[0]) { toast('姓名不能为空', 'err'); return; }
    try {
      await DB.updateSpeaker(sp.id, {
        name: parts[0], department: parts[1] || '', group_name: parts.slice(2).join(' ') || ''
      });
      S.speakers = await DB.listSpeakers(S.event.id);
      toast('已更新', 'ok'); renderTab();
    } catch (e) { toast(dbErr(e), 'err'); }
  },
  async spDel(t){
    const sp = S.speakers.find(x => String(x.id) === String(t.dataset.id));
    if (!sp) return;
    const ok = await confirmBox('删除选手', '将删除「' + esc(sp.name) + '」及其全部评分记录，不可恢复。', '确认删除', true);
    if (!ok) return;
    try {
      const scs = await DB.listScores(S.event.id);
      const mine = scs.filter(s => String(s.speaker_id) === String(sp.id));
      for (const s of mine) await DB.deleteScore(s.id);
      await DB.deleteSpeaker(sp.id);
      S.speakers = await DB.listSpeakers(S.event.id);
      S.scores = await DB.listScores(S.event.id);
      toast('已删除', 'ok'); renderTab();
    } catch (e) { toast(dbErr(e), 'err'); }
  },
  async renumber(){
    try {
      for (let i = 0; i < S.speakers.length; i++) {
        if (num(S.speakers[i].seq) !== i + 1) await DB.updateSpeaker(S.speakers[i].id, { seq: i + 1 });
      }
      S.speakers = await DB.listSpeakers(S.event.id);
      toast('序号已重排', 'ok'); renderTab();
    } catch (e) { toast(dbErr(e), 'err'); }
  },
  async shuffle(){
    const ok = await confirmBox('随机打乱顺序', '将随机重排选手出场顺序（评分数据不受影响）。', '打乱', false);
    if (!ok) return;
    const arr = S.speakers.slice();
    for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); const t = arr[i]; arr[i] = arr[j]; arr[j] = t; }
    try {
      for (let i = 0; i < arr.length; i++) await DB.updateSpeaker(arr[i].id, { seq: i + 1 });
      S.speakers = await DB.listSpeakers(S.event.id);
      toast('已打乱顺序', 'ok'); renderTab();
    } catch (e) { toast(dbErr(e), 'err'); }
  },
  async toggleStatus(){
    const cur = S.event.status || 'draft';
    const next = cur === 'live' ? 'closed' : 'live';
    try {
      await DB.updateEvent(S.event.id, { status: next });
      S.event.status = next;
      toast(next === 'live' ? '已开始接收评分' : '已停止接收评分', 'ok');
      renderTab();
    } catch (e) { toast(dbErr(e), 'err'); }
  },

  /* 导出 */
  expAll(){
    const b = buildExport();
    const parts = [];
    parts.push('=== 活动信息 ===');
    parts.push('活动名称,' + S.event.name);
    parts.push('导出时间,' + new Date().toLocaleString('zh-CN'));
    parts.push('评分维度,' + S.event.dimensions.map(d => (d.group ? '[' + d.group + ']' : '') + d.name + '(' + d.max + '分,权重' + d.weight + ')').join(' / '));
    parts.push('');
    parts.push('=== 一、排名汇总 ===');
    parts.push(toCSV(b.summary));
    parts.push('');
    parts.push('=== 二、原始打分明细 ===');
    parts.push(toCSV(b.detail));
    parts.push('');
    parts.push('=== 三、一级维度汇总 ===');
    parts.push(toCSV(b.groupCsv));
    parts.push('');
    parts.push('=== 四、二级细则分析 ===');
    parts.push(toCSV(b.dimCsv));
    parts.push('');
    parts.push('=== 五、评委统计 ===');
    parts.push(toCSV(b.judgeCsv));
    parts.push('');
    parts.push('=== 六、AI 分析提示词（复制下面的内容 + 上面数据一起发给 AI） ===');
    parts.push(b.prompt);
    download(S.event.name + '_完整评分数据_' + dateTag() + '.txt', parts.join('\n'), 'text/plain');
    toast('完整数据包已导出', 'ok');
  },
  expAI(){
    const b = buildExport();
    download(S.event.name + '_AI分析数据_' + dateTag() + '.md', '# ' + S.event.name + ' · AI 分析数据包\n\n' + b.prompt, 'text/markdown');
    toast('AI 分析数据包已导出', 'ok');
  },
  expSummary(){ const b = buildExport(); download(S.event.name + '_排名汇总_' + dateTag() + '.csv', toCSV(b.summary), 'text/csv'); toast('已导出排名汇总', 'ok'); },
  expDetail(){ const b = buildExport(); download(S.event.name + '_原始打分明细_' + dateTag() + '.csv', toCSV(b.detail), 'text/csv'); toast('已导出打分明细', 'ok'); },
  expJSON(){
    const b = buildExport();
    const data = {
      exportedAt: new Date().toISOString(),
      event: { name: S.event.name, dimensions: S.event.dimensions, settings: S.event.settings, status: S.event.status },
      speakers: S.speakers.map(s => ({ seq: s.seq, name: s.name, department: s.department, topic: s.group_name || '' })),
      scores: S.scores.map(s => {
        const sp = S.speakers.find(x => String(x.id) === String(s.speaker_id));
        return { speakerSeq: sp ? sp.seq : null, speaker: sp ? sp.name : null, judge: s.judge_name, scores: s.scores, comment: s.comment, at: s.updated_at || s.created_at };
      }),
      groupSummary: b.res.groups.map(g => ({ group: g.group || '未分组', max: g.max, avg: Number(fx(g.avg, 2)), rate: Number(fx(g.rate * 100, 2)) })),
      ranking: b.res.ranked.map(r => ({
        rank: r.rank, name: r.speaker.name, total: Number(fx(r.total, 2)), rate: Number(fx(r.rate * 100, 2)),
        groups: Object.fromEntries(b.res.groups.filter(g => g.group).map(g => [g.group, r.groups && r.groups[g.group] && r.groups[g.group].avg !== null ? Number(fx(r.groups[g.group].avg, 2)) : null])),
        dims: Object.fromEntries(b.res.dims.map(d => [d.name, r.dims[d.id] && r.dims[d.id].avg !== null ? Number(fx(r.dims[d.id].avg, 2)) : null]))
      })),
      judgeStats: b.res.judgeStats.map(j => ({ name: j.name, scored: j.scored, total: j.total, avg: j.avg === null ? null : Number(fx(j.avg, 2)) }))
    };
    download(S.event.name + '_全量数据_' + dateTag() + '.json', JSON.stringify(data, null, 2), 'application/json');
    toast('JSON 已导出', 'ok');
  },

  /* 评委端 */
  judgeLogin(){
    const eid = S.route.params.get('e');
    const bound = devBound(eid);
    const lockOn = S.event && S.event.settings && S.event.settings.deviceLock !== false;
    const st = (S.event && S.event.settings) || {};
    const excl = normExcluded(st.excludedJudges);

    /* 本机已锁定：直接用绑定身份进入（此按钮来自「继续以…评分」） */
    if (bound && lockOn && excl.indexOf(bound.judge) < 0) {
      LS.set(judgeNameKey(eid), bound.judge);
      S.judgeName = bound.judge;
      toast('欢迎回来，' + bound.judge, 'ok');
      go('#/judge/list?e=' + eid);
      return;
    }

    const inp = $('#jName');
    const v = inp ? inp.value.trim() : '';
    if (!v) { toast('请输入姓名', 'err'); return; }

    /* 被移除的评委禁止登录评分 */
    if (excl.indexOf(v) >= 0) { toast('该评委已被管理员移除，无法评分', 'err'); return; }

    const presetJ = normJudges(st.judgeRoster);
    /* 本机首次进入：绑定设备 → 评委（核心防多评手段） */
    if (lockOn) {
      const p = presetJ.find(j => j.name === v);
      LS.set(devBindKey(eid), JSON.stringify({ judge: v, dept: p ? p.dept : '', at: new Date().toISOString() }));
    }
    LS.set(judgeNameKey(eid), v);
    S.judgeName = v;
    const bound0 = devBound(eid);
    if (bound0 && bound0.judge !== v) pushDevHistory(eid, bound0.judge, v, true);

    /* 名单软校验：不在预设名单中给出提示，但不阻止（防临时换人） */
    if (presetJ.length && !presetJ.some(j => j.name === v)) {
      toast('提示：' + v + ' 不在预设评委名单中，仍可正常评分', 'ok');
    } else {
      toast('欢迎，' + v, 'ok');
    }
    go('#/judge/list?e=' + eid);
  },
  /* 更换评委：本机已绑定时需管理员口令放行 */
  async judgeSwitch(t){
    const eid = S.route.params.get('e');
    const bound = devBound(eid);
    const lockOn = S.event && S.event.settings && S.event.settings.deviceLock !== false;

    /* 未绑定 / 未开启锁定 → 普通切换 */
    if (!bound || !lockOn) {
      const ok = await confirmBox('切换评委', '将清除本机保存的评委姓名，需要重新输入。已提交的评分不受影响。', '切换', false);
      if (!ok) return;
      LS.del(judgeNameKey(eid));
      go('#/judge?e=' + eid);
      return;
    }

    /* 已绑定 → 要求管理口令 */
    const pin = await promptBox('更换评委需要管理口令',
      '本机当前绑定为 <b>' + esc(bound.judge) + '</b>。<br><br>' +
      '为防止同一设备代多人打分，更换评委需管理员输入<b>管理口令</b>放行。<br>' +
      '<span class="hint">放行后本机将解除绑定，可重新选择评委。</span>',
      '', '管理口令');
    if (pin === null) return;
    const okPin = await verifyAdminPin(pin);
    if (!okPin) { toast('口令错误，未放行', 'err'); return; }
    pushDevHistory(eid, bound.judge, '（已解除绑定）', true);
    LS.del(devBindKey(eid));
    LS.del(judgeNameKey(eid));
    toast('已放行，请重新选择评委', 'ok');
    go('#/judge?e=' + eid);
  },
  judgeOpenSpk(t){ go('#/judge/score?e=' + S.route.params.get('e') + '&s=' + t.dataset.id); },
  judgeBack(){ go('#/judge/list?e=' + S.route.params.get('e')); },
  quickSet(t){
    const dim = t.dataset.dim;
    const el = $('#r_' + dim);
    if (!el) return;
    if (t.dataset.val !== undefined && t.dataset.val !== '') {
      /* 档位按钮：直接给该档满分数值 */
      el.value = num(t.dataset.val, 0);
    } else {
      const pct = num(t.dataset.pct, 0);
      const mx = num(el.dataset.max, 10);
      el.value = Math.round(mx * pct / 100 * 2) / 2;
    }
    if (window.__recalc) window.__recalc();
  },
  async judgeSubmit(){
    const eid = S.route.params.get('e');
    const sid = S.route.params.get('s');
    const jn = LS.get(judgeNameKey(eid), '');
    if (!jn) { go('#/judge?e=' + eid); return; }

    const dims = S.event.dimensions;
    const sc = {};
    let tot = 0;
    for (const d of dims) {
      const el = $('#r_' + d.id);
      if (!el) continue;
      const v = num(el.value, 0);
      if (v < 0 || v > d.max) { toast(d.name + ' 分值应在 0 ~ ' + d.max + ' 之间', 'err'); return; }
      sc[d.id] = v; tot += v;
    }
    const comment = ($('#jComment') || {}).value || '';

    S.busy = true;
    const btns = $$('[data-a="judgeSubmit"]');
    btns.forEach(b => { b.disabled = true; b.innerHTML = '<span class="spin"></span> 提交中…'; });

    /* 设备 / 网络留痕：用于事后核查同一设备是否代多人打分。
       取 IP 失败不阻塞提交（超时 3.5s 即放行）。 */
    let netInfo = null;
    try { netInfo = await fetchIp(); } catch (e) { netInfo = null; }
    const binding = devBound(eid);
    const payload = {
      event_id: num(eid), speaker_id: num(sid), judge_name: jn, scores: sc, comment,
      updated_at: new Date().toISOString(),
      meta: {
        device_id: deviceId(),
        ip: netInfo ? netInfo.ip : '',
        loc: netInfo ? netInfo.loc : '',
        ua: uaShort(),
        /* 若本机曾绑定过别的评委，记录来源，供管理台核查换人 */
        from_judge: (binding && binding.judge !== jn) ? binding.judge : '',
        switched_at: (binding && binding.judge !== jn) ? new Date().toISOString() : '',
        switch_approved: false
      }
    };

    try {
      const all = await DB.listScores(eid);
      const exist = all.find(s => String(s.speaker_id) === String(sid) && s.judge_name === jn);
      if (exist) await DB.updateScore(exist.id, payload);
      else await DB.insertScore(payload);
      toast('提交成功，合计 ' + fx(tot, 1) + ' 分', 'ok');
      go('#/judge/list?e=' + eid);
    } catch (e) {
      const c = normalizeCode(e);
      /* 重复提交（网络重试导致的已存在）视为成功，避免评委以为没提交上而反复点 */
      if (c === '23505') {
        try {
          const all2 = await DB.listScores(eid);
          const ex2 = all2.find(s => String(s.speaker_id) === String(sid) && s.judge_name === jn);
          if (ex2) await DB.updateScore(ex2.id, payload);
          toast('提交成功，合计 ' + fx(tot, 1) + ' 分', 'ok');
          go('#/judge/list?e=' + eid);
          return;
        } catch (e2) { /* 继续走失败分支 */ }
      }
      toast(dbErr(e), 'err');
      btns.forEach(b => { b.disabled = false; b.textContent = '重试提交'; });
    } finally { S.busy = false; }
  }
};
window.__actions = Actions;

async function swapSeq(i, j){
  const a = S.speakers[i], b = S.speakers[j];
  try {
    await DB.updateSpeaker(a.id, { seq: num(b.seq) });
    await DB.updateSpeaker(b.id, { seq: num(a.seq) });
    S.speakers = await DB.listSpeakers(S.event.id);
    renderTab();
  } catch (e) { toast(dbErr(e), 'err'); }
}
function dateTag(){
  const d = new Date();
  return d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) + '_' + pad2(d.getHours()) + pad2(d.getMinutes());
}

/* ---------------- 12. 事件绑定 / 启动 ---------------- */
function go(hash){
  if (location.hash === hash) { S.route = parseRoute(); onRoute(); return; }
  location.hash = hash;
}
function parseRoute(){
  const raw = (location.hash || '').replace(/^#/, '') || '/';
  const qi = raw.indexOf('?');
  const path = (qi >= 0 ? raw.slice(0, qi) : raw) || '/';
  const qs = qi >= 0 ? raw.slice(qi + 1) : '';
  return { path, params: new URLSearchParams(qs) };
}
window.addEventListener('hashchange', () => { S.route = parseRoute(); onRoute(); });

async function onRoute(){
  if (S.timer) { clearInterval(S.timer); S.timer = null; }
  const p = S.route.path;
  window.scrollTo(0, 0);
  try {
    if (p === '/')            return Views.home();
    if (p === '/judge')       return Views.judgeEntry();
    if (p === '/judge/list')  return Views.judgeList();
    if (p === '/judge/score') return Views.judgeScore();
    if (p === '/board')       return Views.board();
    if (p.indexOf('/admin') === 0) return Views.adminRoute();
    return Views.home();
  } catch (e) {
    console.error(e);
    $('#app').innerHTML = shell('<div class="wrap"><div class="card"><div class="card-t">页面出错</div>' +
      '<div class="card-d">' + esc(e.message || String(e)) + '</div>' +
      '<button class="btn btn-p" data-a="goHome">返回活动列表</button></div></div>', {});
  }
}

document.addEventListener('click', e => {
  const t = e.target.closest('[data-a]');
  if (!t) return;
  const fn = Actions[t.dataset.a];
  if (fn) { e.preventDefault(); fn(t, e); }
});

function boot(){
  if (!cloud) {
    $('#app').innerHTML = '<div class="wrap-narrow" style="padding-top:60px"><div class="card">' +
      '<div class="card-t">初始化失败</div><div class="card-d">云服务 SDK 未能加载，请检查网络后刷新页面重试。</div>' +
      '<button class="btn btn-p" onclick="location.reload()">刷新页面</button></div></div>';
    return;
  }
  /* 关键：首次加载必须先解析 hash 路由，否则扫码进入 #/judge?e=xx 会落到首页 */
  S.route = parseRoute();
  onRoute();
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();