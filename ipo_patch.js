/**
 * ipo_patch.js v2 — 即將上市 ETF / 新股即時追蹤
 *
 * 資料策略：
 *   1. TWSE OpenAPI company list → 近60天新上市（含ETF）
 *   2. TPEX OpenAPI → 近60天新上櫃
 *   3. TWSE BWIBBU_d ETF清單 → 篩近期成立ETF
 *   4. 靜態已知近期 ETF 清單（備援）
 *
 * 快取：localStorage 'tw_ipo_v3'，TTL 6小時
 */

/* ─── Fetch ──────────────────────────────────────── */
async function _ipoFetch(url) {
  if (typeof fetchAny === 'function') {
    try { return await (await fetchAny(url)).json(); } catch(e) {}
  }
  const proxies = [
    u => u,
    u => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
    u => `https://corsproxy.io/?${encodeURIComponent(u)}`,
  ];
  for (const p of proxies) {
    try {
      const r = await fetch(p(url), { signal: AbortSignal.timeout(10000) });
      if (!r.ok) continue;
      const txt = await r.text();
      if (!txt || txt.trim().startsWith('<')) continue;
      return JSON.parse(txt);
    } catch(e) {}
  }
  return null;
}

/* ─── 日期工具 ───────────────────────────────────── */
function _parseDate(str) {
  if (!str) return null;
  str = String(str).replace(/[\/\-\s]/g,'').trim();
  if (str.length===7) {
    return new Date(parseInt(str.substring(0,3))+1911, parseInt(str.substring(3,5))-1, parseInt(str.substring(5,7)));
  }
  if (str.length===8) {
    return new Date(parseInt(str.substring(0,4)), parseInt(str.substring(4,6))-1, parseInt(str.substring(6,8)));
  }
  const d=new Date(str); return isNaN(d)?null:d;
}

function _fmtDate(d) {
  if (!d) return '—';
  return `${d.getFullYear()}/${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')}`;
}

function _daysFromNow(d) {
  if (!d) return 999;
  return Math.round((d-Date.now())/86400000);
}

/* ─── 分類 ───────────────────────────────────────── */
function _isETF(name) {
  return /ETF|etf|指數基金|指數型|型基金|00[0-9]{2,3}/.test(name||'');
}
function _isTech(name, industry) {
  const t=(name||'')+' '+(industry||'');
  return /半導體|晶圓|電子|科技|IC|AI|算力|軟體|網路|資訊|光電|通訊|5G|HPC|GPU|晶片|封裝|測試|PCB|伺服器|記憶體|車用/i.test(t);
}

/* ─── 靜態備援 ETF 清單（已知近期或常見） ─────────── */
const STATIC_ETF_LIST = [
  // 根據 TWSE 公告的近期新上市 ETF（請自行更新）
  { code:'00940', name:'元大台灣價值高息', market:'上市ETF', note:'近期熱門ETF', listDate: null },
  { code:'00939', name:'統一台灣高息動能', market:'上市ETF', note:'近期熱門ETF', listDate: null },
  { code:'00919', name:'群益台灣精選高息', market:'上市ETF', note:'近期熱門ETF', listDate: null },
  { code:'00929', name:'復華台灣科技優息', market:'上市ETF', note:'近期熱門ETF', listDate: null },
  { code:'00933B',name:'國泰10Y+金融債', market:'上市ETF', note:'債券ETF', listDate: null },
  { code:'00934', name:'中信成長高股息', market:'上市ETF', note:'近期熱門ETF', listDate: null },
];

/* ─── 資料來源 ───────────────────────────────────── */
async function _fetchTWSENew() {
  const d = await _ipoFetch('https://openapi.twse.com.tw/v1/company/');
  if (!Array.isArray(d)) return [];
  const now = Date.now();
  const results = [];
  for (const item of d) {
    const rawDate = item['上市日期']||item['listingDate']||item['ListingDate']||'';
    const listDate = _parseDate(rawDate);
    if (!listDate) continue;
    const diff = (listDate-now)/86400000;
    if (diff < -60 || diff > 60) continue;  // 前後60天
    const name = item['公司名稱']||item['CompanyName']||'';
    const code = item['股票代號']||item['stockCode']||'';
    const ind  = item['產業別']||item['IndustryType']||'';
    if (!code) continue;
    // ETF優先，科技股也要
    if (!_isETF(name) && !_isTech(name,ind)) continue;
    results.push({ code, name, industry:ind, market:'上市', listDate, source:'TWSE' });
  }
  return results;
}

async function _fetchTPEXNew() {
  const d = await _ipoFetch('https://www.tpex.org.tw/openapi/v1/tpex_mainboard_list');
  if (!Array.isArray(d)) return [];
  const now = Date.now();
  const results = [];
  for (const item of d) {
    const rawDate = item['上櫃日期']||item['ListingDate']||'';
    const listDate = _parseDate(rawDate);
    if (!listDate) continue;
    const diff = (listDate-now)/86400000;
    if (diff < -60 || diff > 60) continue;
    const name = item['公司名稱']||item['CompanyName']||'';
    const code = item['股票代號']||item['SecuritiesCompanyCode']||'';
    const ind  = item['產業別']||item['IndustryType']||'';
    if (!code) continue;
    if (!_isETF(name) && !_isTech(name,ind)) continue;
    results.push({ code, name, industry:ind, market:'上櫃', listDate, source:'TPEX' });
  }
  return results;
}

async function _fetchETFList() {
  // 從 TWSE ETF 清單撈最近成立的ETF
  const d = await _ipoFetch('https://www.twse.com.tw/rwd/zh/fund/ETF?response=json');
  if (!d || !Array.isArray(d.data)) return [];
  const now = Date.now();
  const results = [];
  const fields = d.fields || [];
  // 欄位通常：基金簡稱、代號、上市日期、…
  const codeIdx  = fields.findIndex(f=>/代號/.test(f));
  const nameIdx  = fields.findIndex(f=>/簡稱|名稱/.test(f));
  const dateIdx  = fields.findIndex(f=>/上市日期/.test(f));
  for (const row of d.data) {
    const code = codeIdx>=0 ? String(row[codeIdx]).trim() : '';
    const name = nameIdx>=0 ? String(row[nameIdx]).trim() : '';
    const rawDate = dateIdx>=0 ? row[dateIdx] : '';
    const listDate = _parseDate(rawDate);
    if (!listDate) continue;
    const diff = (listDate-now)/86400000;
    if (diff < -90 || diff > 90) continue;  // 近3個月
    if (!code) continue;
    results.push({ code, name, industry:'ETF', market:'上市ETF', listDate, source:'TWSE_ETF' });
  }
  return results;
}

/* ─── 主快取 ─────────────────────────────────────── */
const _IPO_KEY = 'tw_ipo_v3';
const _IPO_TTL = 6*3600*1000;

async function fetchNewListings() {
  try {
    const raw = localStorage.getItem(_IPO_KEY);
    if (raw) {
      const c = JSON.parse(raw);
      if (c.ts && Date.now()-c.ts<_IPO_TTL && Array.isArray(c.data) && c.data.length>0)
        return { data:c.data, fromCache:true, ts:c.ts };
    }
  } catch(e) {}

  const [r1,r2,r3] = await Promise.allSettled([_fetchTWSENew(), _fetchTPEXNew(), _fetchETFList()]);
  let all = [
    ...(r1.status==='fulfilled'?r1.value:[]),
    ...(r2.status==='fulfilled'?r2.value:[]),
    ...(r3.status==='fulfilled'?r3.value:[]),
  ];

  // 去重
  const seen=new Set();
  all = all.filter(s=>{ if(seen.has(s.code)) return false; seen.add(s.code); return true; });

  // 靜態備援：只有在 API 完全失敗時才加入
  if (all.length===0) {
    all = STATIC_ETF_LIST.map(s=>({...s, source:'static'}));
  } else {
    // 補充靜態 ETF 中 API 沒抓到的
    for (const s of STATIC_ETF_LIST) {
      if (!seen.has(s.code)) { all.push({...s, source:'static'}); seen.add(s.code); }
    }
  }

  // 排序：有上市日期的先，按日期排
  all.sort((a,b)=>{
    if (_isETF(a.name)&&!_isETF(b.name)) return -1;
    if (!_isETF(a.name)&&_isETF(b.name)) return 1;
    const da=a.listDate?a.listDate.getTime():0, db=b.listDate?b.listDate.getTime():0;
    return db-da;
  });

  const ts=Date.now();
  try { localStorage.setItem(_IPO_KEY, JSON.stringify({ts, data:all})); } catch(e) {}
  return { data:all, fromCache:false, ts };
}

async function refreshIPOData() {
  try { localStorage.removeItem(_IPO_KEY); } catch(e) {}
  await renderPotentialStocks();
  if (typeof showToast==='function') showToast('已更新資料 ✓');
}

/* ─── 渲染 ───────────────────────────────────────── */
function _marketBadge(m) {
  const map = {'上市ETF':'#c62828','上市':'#c62828','上櫃':'#1565c0','興櫃':'#2e7d32','static':'#555'};
  const color = map[m]||'#444';
  return `<span style="background:${color};color:#fff;border-radius:3px;padding:1px 5px;font-size:10px;margin-left:4px">${m}</span>`;
}

function _daysBadge(d) {
  if (!d) return '';
  const n=_daysFromNow(d);
  if (n>=0&&n<=7)  return `<span style="background:#c62828;color:#fff;border-radius:3px;padding:1px 5px;font-size:10px;margin-left:4px">🔥 ${n}天後上市</span>`;
  if (n>=0&&n<=30) return `<span style="background:#1565c0;color:#fff;border-radius:3px;padding:1px 5px;font-size:10px;margin-left:4px">${n}天後上市</span>`;
  if (n<0&&n>=-7)  return `<span style="background:#2e7d32;color:#fff;border-radius:3px;padding:1px 5px;font-size:10px;margin-left:4px">剛上市</span>`;
  if (n<0&&n>=-30) return `<span style="background:#333;color:#aaa;border-radius:3px;padding:1px 5px;font-size:10px;margin-left:4px">近期上市</span>`;
  return '';
}

function _row(s) {
  return `<div style="display:flex;align-items:center;justify-content:space-between;padding:8px 10px;background:#12122a;border-radius:6px;margin-bottom:6px">
    <div style="display:flex;align-items:center;flex-wrap:wrap;gap:4px">
      <span style="font-size:16px;font-weight:700;color:#e8c84a;font-family:monospace;min-width:56px">${s.code}</span>
      <span style="font-size:13px;color:#e0e0e0">${s.name}</span>
      ${_marketBadge(s.market)}
      ${_daysBadge(s.listDate)}
    </div>
    <div style="text-align:right;flex-shrink:0;margin-left:8px">
      <div style="font-size:11px;color:#777">${s.listDate?_fmtDate(s.listDate):'參考'}</div>
      <div style="font-size:10px;color:#555">${s.industry||'—'}</div>
    </div>
  </div>`;
}

async function renderPotentialStocks() {
  const wrap = document.getElementById('potential-stocks-wrap');
  if (!wrap) return;

  wrap.innerHTML=`<div style="padding:20px;text-align:center;color:#aaa;font-size:14px"><div style="font-size:24px;margin-bottom:8px">⏳</div>正在抓取新上市/ETF資料…</div>`;

  let result;
  try { result = await fetchNewListings(); }
  catch(e) { wrap.innerHTML=`<div style="color:#f66;padding:12px">⚠️ 無法取得資料：${e.message}</div>`; return; }

  const { data:stocks, fromCache, ts } = result;
  const updateTime = new Date(ts).toLocaleString('zh-TW',{hour12:false});

  // 分組
  const upcoming  = stocks.filter(s=>s.listDate&&_daysFromNow(s.listDate)>=0&&_daysFromNow(s.listDate)<=30);
  const recent    = stocks.filter(s=>s.listDate&&_daysFromNow(s.listDate)<0&&_daysFromNow(s.listDate)>=-30);
  const etfList   = stocks.filter(s=>_isETF(s.name));
  const techList  = stocks.filter(s=>!_isETF(s.name)&&_isTech(s.name,s.industry));

  function section(title, icon, items, max) {
    if (!items.length) return '';
    const shown=items.slice(0,max||999);
    return `<div style="background:#12122a;border-radius:10px;padding:12px 14px;margin-bottom:12px;border:1px solid #2a2a4a">
      <div style="font-size:13px;font-weight:700;color:#e8c84a;margin-bottom:8px">${icon} ${title}
        <span style="font-size:11px;font-weight:400;color:#666;margin-left:6px">(${items.length}檔)</span>
      </div>
      ${shown.map(_row).join('')}
      ${items.length>max?`<div style="font-size:11px;color:#444;text-align:center;margin-top:4px">還有 ${items.length-max} 檔…</div>`:''}
    </div>`;
  }

  // 代碼速覽表
  const top = stocks.slice(0,25);
  const tableRows = top.map(s=>`<tr>
    <td style="padding:5px 8px;color:#e8c84a;font-family:monospace;font-weight:700">${s.code}</td>
    <td style="padding:5px 8px;color:#e0e0e0;font-size:12px">${s.name}</td>
    <td style="padding:5px 8px">${_marketBadge(s.market)}</td>
    <td style="padding:5px 8px;color:#777;font-size:11px">${s.listDate?_fmtDate(s.listDate):'—'}</td>
  </tr>`).join('');

  const html = `
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
      <div style="font-size:14px;font-weight:700;color:#e8c84a">📡 新上市 / ETF 即時追蹤</div>
      <div style="display:flex;align-items:center;gap:6px">
        <span style="font-size:10px;color:#555">${fromCache?'⚡快取':'🔄更新'} ${updateTime}</span>
        <button onclick="refreshIPOData()" style="background:#1565c0;color:#fff;border:none;border-radius:5px;padding:4px 10px;font-size:11px;cursor:pointer">↻ 重新整理</button>
      </div>
    </div>

    ${upcoming.length?section('即將上市（30天內）','🚀',upcoming,10):''}
    ${recent.length  ?section('近期上市（30天內）','🟢',recent,8):''}
    ${etfList.length ?section('ETF（近期上市 / 熱門）','📦',etfList,10):''}
    ${techList.length?section('科技股','💻',techList,8):''}

    ${stocks.length===0?`<div style="padding:20px;text-align:center;color:#888;font-size:13px">
      ⚠️ API 暫時無法連線，顯示參考清單<br>
      <button onclick="refreshIPOData()" style="margin-top:8px;background:#333;color:#aaa;border:1px solid #444;border-radius:5px;padding:4px 12px;font-size:11px;cursor:pointer">重試</button>
    </div>`:''}

    ${top.length?`<div style="background:#0d0d1e;border-radius:10px;border:1px solid #2a2a4a;overflow:hidden;margin-top:4px">
      <div style="padding:10px 14px;background:#1a1a30;font-size:13px;font-weight:700;color:#90caf9">📋 股票代碼速覽（前${top.length}檔）</div>
      <div style="overflow-x:auto">
        <table style="width:100%;border-collapse:collapse;font-size:12px">
          <thead><tr style="background:#111128;color:#666">
            <th style="padding:5px 8px;text-align:left">代碼</th>
            <th style="padding:5px 8px;text-align:left">名稱</th>
            <th style="padding:5px 8px;text-align:left">市場</th>
            <th style="padding:5px 8px;text-align:left">日期</th>
          </tr></thead>
          <tbody>${tableRows}</tbody>
        </table>
      </div>
    </div>`:''}

    <div style="margin-top:8px;font-size:10px;color:#333;text-align:center">
      資料來源：TWSE / TPEX OpenAPI　每6小時更新　以ETF為主
    </div>`;

  wrap.innerHTML = html;
}
