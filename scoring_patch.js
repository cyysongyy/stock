/**
 * scoring_patch.js v4
 * 分析 tab — 5 條件買點偵測器
 *
 * 每條件 20 分，共 100 分：
 *   1. K < 20        (KD隨機指標超賣)          /20
 *   2. 低於月線       (收盤 < MA20)             /20
 *   3. 當日跌 3%+    (今日跌幅 >= 3%)           /20
 *   4. 接近淨值/折價  (ETF溢價率 <= 0.5%)       /20
 *   5. 指數跌 1%+    (TAIEX 當日跌幅 >= 1%)    /20
 *
 * 資料來源：
 *   歷史 K 線 → Yahoo Finance (.TW / .TWO)   不需 Proxy，iPhone 可用
 *   即時價格  → tw_price_cache (TWSE MIS，已有)
 *   ETF 淨值  → TWSE BWIBBU_d
 *   指數      → TWSE MIS tse_t00.tw
 */

/* ════════════════════════════════════════════════
   0. 啟動：背景重抓今日價格（不清除舊快取）
      抓成功才覆蓋，失敗保留舊資料
   ════════════════════════════════════════════════ */
(function _initPriceRefresh() {
  setTimeout(async () => {
    try {
      if (typeof fetchLiveAndRender === 'function') {
        await fetchLiveAndRender();
      }
    } catch(e) {}
    // 買點訊號偵測卡片（含中文名稱、首頁訊號點用的 scoreCache）以前只在使用者切到
    // 分析頁時才抓，App 一開啟就先背景抓好，使用者點進分析頁時資料已經是現成的
    try {
      await renderTechAnalysis();
    } catch(e) {}
  }, 1500);
})();

// 買點訊號偵測（本檔案）寫自己的快取，跟 index.html 的基本面評分 scoreCache
// 分開存，兩者 total/color 算法不同，共用同一個 key 會互相覆蓋，造成首頁訊號點
// 的顏色跟文字對不上（顏色用 A 系統的，文字又用 B 系統的門檻重算）
let dipCache = (function () {
  try { return JSON.parse(localStorage.getItem('tw_dip_cache') || '{}'); } catch (e) { return {}; }
})();

/* ════════════════════════════════════════════════
   1. Fetch 工具
   ════════════════════════════════════════════════ */

// 讀當前使用者的持股（多使用者命名空間由 index.html 的 KEY_HOLD 決定）
function _spHoldings() {
  try { if (typeof holdings !== 'undefined' && Array.isArray(holdings)) return holdings; } catch(e) {}
  try { return JSON.parse(localStorage.getItem(typeof KEY_HOLD !== 'undefined' ? KEY_HOLD : 'tw_holdings') || '[]'); } catch(e) { return []; }
}

async function _yFetch(url) {
  // 直接 fetch + allorigins fallback
  // 注意：iOS 15 不支援 AbortSignal.timeout()，改用 AbortController + setTimeout
  const tries = [
    u => u,
    u => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
    u => `https://corsproxy.io/?${encodeURIComponent(u)}`,
  ];
  for (const t of tries) {
    try {
      const ctrl = new AbortController();
      const tid  = setTimeout(() => ctrl.abort(), 10000);
      let r;
      try {
        r = await fetch(t(url), {
          signal:  ctrl.signal,
          headers: { 'Accept': 'application/json' }
        });
      } finally {
        clearTimeout(tid);
      }
      if (!r.ok) continue;
      const txt = await r.text();
      if (!txt || txt.trim()[0] === '<') continue;
      return JSON.parse(txt);
    } catch(e) {}
  }
  return null;
}

/* ════════════════════════════════════════════════
   2. Yahoo Finance 歷史 K 線
   ════════════════════════════════════════════════ */

const _HIST_KEY = c => `tw_hist_v3_${c}`;
const _HIST_TTL = 4 * 3600 * 1000;

/** 判斷股票市場（.TW 或 .TWO） */
function _yahooSuffix(code) {
  // ETF 通常以 00 開頭或 6碼 → .TW
  // 上櫃股通常 6xxx, 7xxx 4碼 → 先試 .TW，再試 .TWO
  return '.TW';  // 先統一試 .TW，失敗時 fallback 到 .TWO
}

/** Yahoo Finance chart API → OHLCV 陣列 */
async function _yahooOHLCV(code) {
  const suffixes = ['.TW', '.TWO'];
  for (const suf of suffixes) {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${code}${suf}?interval=1d&range=3mo`;
    const data = await _yFetch(url);
    if (!data) continue;
    const result = data?.chart?.result?.[0];
    if (!result) continue;
    const ts  = result.timestamp || [];
    const q   = result.indicators?.quote?.[0] || {};
    const closes = q.close || [];
    if (closes.length < 5) continue;

    const candles = ts.map((t, i) => ({
      ts:     t,
      open:   q.open?.[i]   || 0,
      high:   q.high?.[i]   || 0,
      low:    q.low?.[i]    || 0,
      close:  closes[i]     || 0,
      volume: q.volume?.[i] || 0,
    })).filter(c => c.close > 0);

    return candles;
  }
  return [];
}

async function fetchHistory(code) {
  try {
    const raw = localStorage.getItem(_HIST_KEY(code));
    if (raw) {
      const c = JSON.parse(raw);
      if (c.ts && Date.now() - c.ts < _HIST_TTL && c.data?.length >= 20)
        return c.data;
    }
  } catch(e) {}

  const candles = await _yahooOHLCV(code);
  try {
    if (candles.length >= 5)
      localStorage.setItem(_HIST_KEY(code), JSON.stringify({ ts: Date.now(), data: candles }));
  } catch(e) {}
  return candles;
}

/* ════════════════════════════════════════════════
   3. 指標計算
   ════════════════════════════════════════════════ */

function _calcMA(candles, n) {
  if (candles.length < n) return null;
  return candles.slice(-n).reduce((s, c) => s + c.close, 0) / n;
}

function _calcKD(candles, n = 9) {
  if (candles.length < n) return { k: 50, d: 50 };
  let k = 50, d = 50;
  for (let i = n - 1; i < candles.length; i++) {
    const slice = candles.slice(i - n + 1, i + 1);
    const lo = Math.min(...slice.map(c => c.low));
    const hi = Math.max(...slice.map(c => c.high));
    const rsv = hi === lo ? 50 : (candles[i].close - lo) / (hi - lo) * 100;
    k = k * 2 / 3 + rsv / 3;
    d = d * 2 / 3 + k / 3;
  }
  return { k: Math.round(k * 10) / 10, d: Math.round(d * 10) / 10 };
}

/* ════════════════════════════════════════════════
   4. ETF 淨值（BWIBBU_d）
   ════════════════════════════════════════════════ */

let _navCache = null;
let _navCacheTs = 0;
const _NAV_TTL = 6 * 3600 * 1000;

async function fetchETFNav() {
  if (_navCache && Date.now() - _navCacheTs < _NAV_TTL) return _navCache;
  const url = 'https://www.twse.com.tw/rwd/zh/fund/BWIBBU_d?response=json';
  const data = await _yFetch(url);
  if (!data || !Array.isArray(data.data)) return {};

  const fields = data.fields || [];
  // 欄位：證券代號, 證券名稱, 殖利率, 股利年度, 本益比, 股價淨值比, 財報年/季
  // BWIBBU 實際欄位視版本而定，嘗試多種對應
  const codeIdx = fields.findIndex(f => /代號/.test(f));
  const pbIdx   = fields.findIndex(f => /淨值比/.test(f));
  // 另外嘗試抓「溢折價率」欄位 (ETF 專屬)
  const premIdx = fields.findIndex(f => /溢折|折溢/.test(f));

  const nav = {};
  for (const row of data.data) {
    const code = codeIdx >= 0 ? String(row[codeIdx]).trim() : '';
    if (!code) continue;
    nav[code] = {
      pb:      pbIdx   >= 0 ? parseFloat(String(row[pbIdx]).replace(/,/g, ''))   : null,
      premium: premIdx >= 0 ? parseFloat(String(row[premIdx]).replace(/%/g, '')) : null,
    };
  }
  _navCache = nav;
  _navCacheTs = Date.now();
  return nav;
}

/* ════════════════════════════════════════════════
   5. 加權指數（TAIEX）
   ════════════════════════════════════════════════ */

let _taiexCache = null;
let _taiexTs = 0;
const _TAIEX_TTL = 10 * 60 * 1000;  // 10分鐘

async function fetchTAIEX() {
  if (_taiexCache && Date.now() - _taiexTs < _TAIEX_TTL) return _taiexCache;
  const url = 'https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=tse_t00.tw&json=1&delay=0';
  const data = await _yFetch(url);
  const msg = data?.msgArray?.[0];
  if (!msg) return null;

  // z=現價, y=昨收, o=開盤
  const cur  = parseFloat(msg.z || msg.tv || 0);
  const prev = parseFloat(msg.y || 0);
  const chg  = prev > 0 ? (cur - prev) / prev * 100 : 0;

  _taiexCache = { cur, prev, chgPct: Math.round(chg * 100) / 100 };
  _taiexTs = Date.now();
  return _taiexCache;
}

/* ════════════════════════════════════════════════
   6. 五條件評分
   ════════════════════════════════════════════════ */

async function scoreBuySignal(holding, taiex, navMap) {
  const code = holding.code;

  // 現價資訊（從 tw_price_cache）
  let curPrice = null, prevClose = null, chgPct = null;
  try {
    const pc = JSON.parse(localStorage.getItem('tw_price_cache') || '{}');
    const entry = pc[code];
    if (entry) {
      curPrice  = parseFloat(entry.price || entry.z || 0) || null;
      if (entry.chgPct !== null && entry.chgPct !== undefined) {
        chgPct = entry.chgPct;  // Yahoo v8 已算好漲跌幅
      } else {
        prevClose = parseFloat(entry.y || 0) || null;
        if (curPrice && prevClose && prevClose > 0)
          chgPct = (curPrice - prevClose) / prevClose * 100;
      }
    }
  } catch(e) {}

  // 歷史 K 線
  const candles = await fetchHistory(code);
  const hasHistory = candles.length >= 20;

  const kd   = hasHistory ? _calcKD(candles) : { k: 50, d: 50 };
  const ma20 = hasHistory ? _calcMA(candles, 20) : null;
  const close = candles.length > 0 ? candles[candles.length - 1].close : (curPrice || 0);

  // 條件 4：ETF 溢折價
  const navInfo = navMap[code] || null;
  let premiumPct = navInfo?.premium ?? null;
  // 若無溢折價欄位，用 PB 比 1 估算
  if (premiumPct === null && navInfo?.pb != null)
    premiumPct = (navInfo.pb - 1) * 100;

  // ── 逐條計分 ──
  const items = [];

  // 1. K < 20
  const cond1 = hasHistory && kd.k < 20;
  const cond1p = hasHistory && kd.k < 30;  // 部分分
  items.push({
    label: 'K < 20（超賣）',
    score: cond1 ? 20 : (cond1p ? 10 : 0),
    max: 20,
    detail: hasHistory ? `K=${kd.k}　D=${kd.d}` : '資料不足',
    met: cond1,
  });

  // 2. 低於月線 (MA20)
  const cond2 = hasHistory && ma20 !== null && close < ma20;
  items.push({
    label: '低於月線(MA20)',
    score: cond2 ? 20 : (hasHistory && ma20 && close < ma20 * 1.02 ? 10 : 0),
    max: 20,
    detail: hasHistory && ma20 ? `MA20=${ma20.toFixed(2)}　現價=${close.toFixed(2)}` : '資料不足',
    met: cond2,
  });

  // 3. 當日跌 3%+
  const cond3 = chgPct !== null && chgPct <= -3;
  const cond3p = chgPct !== null && chgPct <= -1.5;
  items.push({
    label: '當日跌幅 ≥ 3%',
    score: cond3 ? 20 : (cond3p ? 10 : 0),
    max: 20,
    detail: chgPct !== null ? `今日 ${chgPct >= 0 ? '+' : ''}${chgPct.toFixed(2)}%` : '無即時資料',
    met: cond3,
  });

  // 4. 接近淨值 / 折價 (ETF 溢價 <= 0.5%)
  const isETF = /ETF|etf|00[0-9]{2}/.test(holding.name || '') || /^00/.test(code);
  const cond4 = isETF && premiumPct !== null && premiumPct <= 0.5;
  const cond4p = isETF && premiumPct !== null && premiumPct <= 2;
  items.push({
    label: isETF ? '接近淨值/折價' : '接近淨值(非ETF略)',
    score: !isETF ? 10 : (cond4 ? 20 : (cond4p ? 10 : 0)),
    max: 20,
    detail: isETF
      ? (premiumPct !== null ? `溢價率 ${premiumPct >= 0 ? '+' : ''}${premiumPct.toFixed(2)}%` : '淨值資料不足')
      : '非ETF，給基礎分',
    met: !isETF ? false : cond4,
  });

  // 5. 指數當日跌 1%+
  const cond5 = taiex !== null && taiex.chgPct <= -1;
  const cond5p = taiex !== null && taiex.chgPct <= -0.5;
  items.push({
    label: '指數跌幅 ≥ 1%',
    score: cond5 ? 20 : (cond5p ? 10 : 0),
    max: 20,
    detail: taiex ? `TAIEX ${taiex.chgPct >= 0 ? '+' : ''}${taiex.chgPct}%` : '指數資料不足',
    met: cond5,
  });

  const total = Math.min(100, items.reduce((s, i) => s + i.score, 0));
  const metCount = items.filter(i => i.met).length;

  return { total, metCount, items, kd, ma20, close, chgPct, taiex, hasHistory };
}

/* ════════════════════════════════════════════════
   7. 渲染
   ════════════════════════════════════════════════ */

function _verdict(score, metCount) {
  if (metCount >= 5) return { text: '🔥 強力買點',   color: '#f44336' };
  if (metCount >= 4) return { text: '✅ 值得積極關注', color: '#4caf50' };
  if (metCount >= 3) return { text: '🟡 可考慮買入',  color: '#ffc107' };
  if (metCount >= 2) return { text: '👀 持續觀察',    color: '#90caf9' };
  return                    { text: '⏸️ 尚未到位',    color: '#666' };
}

// 排名顏色：1-2綠、3-5黃、6+紅
function _rankColor(rank) {
  if (rank <= 2) return { dot: '#4caf50', label: '🟢 值得買入', cacheColor: 'green' };
  if (rank <= 5) return { dot: '#ffc107', label: '🟡 考慮買入', cacheColor: 'yellow' };
  return               { dot: '#ff4757', label: '🔴 暫不考慮', cacheColor: 'red' };
}

function _condRow(item) {
  const icon = item.met ? '✅' : (item.score > 0 ? '🟡' : '⬜');
  const barPct = item.max > 0 ? Math.min(100, item.score / item.max * 100) : 0;
  const barCol = item.score >= item.max ? '#f44336' : item.score > 0 ? '#ffc107' : '#333';
  return `
    <div style="margin-bottom:8px">
      <div style="display:flex;justify-content:space-between;align-items:center;font-size:12px;margin-bottom:3px">
        <span>${icon} <b style="color:#e0e0e0">${item.label}</b></span>
        <span style="color:#aaa;font-size:11px">${item.detail}</span>
      </div>
      <div style="background:#1e1e30;border-radius:3px;height:5px">
        <div style="width:${barPct}%;height:100%;background:${barCol};border-radius:3px;transition:width .4s"></div>
      </div>
    </div>`;
}

function _card(holding, result, rank) {
  const code = (holding.code || '').replace('.TW', '').replace('.TWO', '');
  let name = holding.name || holding.n || '';
  if (!name) {
    try {
      const pc = (typeof priceCache !== 'undefined' ? priceCache : {});
      name = pc[code + '.TW']?.name || pc[code]?.name || '';
    } catch (e) {}
  }
  name = name || code || '—';
  const v = _verdict(result.total, result.metCount);
  const rc = _rankColor(rank);
  const metStr = `${result.metCount}/5 條件成立`;

  return `
    <div style="background:#1a1a2e;border-radius:12px;padding:16px;margin-bottom:14px;border:1px solid ${rc.dot}44">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">
        <div style="display:flex;align-items:center;gap:10px">
          <div style="width:14px;height:14px;border-radius:50%;background:${rc.dot};flex-shrink:0"></div>
          <div>
            <div style="font-size:15px;font-weight:700;color:#e0e0e0">${code}
              ${name!==code?`<span style="font-size:11px;color:#aaa;font-weight:400"> ${name}</span>`:''}
            </div>
            <div style="font-size:11px;color:${rc.dot};margin-top:2px">${rc.label} &nbsp;
              <span style="color:${v.color};font-size:10px">${v.text}</span>
            </div>
          </div>
        </div>
        <div style="text-align:right">
          <div style="font-size:28px;font-weight:700;color:${rc.dot};line-height:1">${result.total}</div>
          <div style="font-size:10px;color:#555">${metStr}</div>
        </div>
      </div>
      ${result.items.map(_condRow).join('')}
      <div style="font-size:10px;color:#444;margin-top:8px;padding-top:8px;border-top:1px solid #1e1e30">
        現價 ${result.close ? result.close.toFixed(2) : '—'}
        均成本 ${holding.cost || '—'}　持股 ${holding.qty || 0} 股
        ${result.hasHistory ? '' : '　⚠️ K線歷史不足'}
      </div>
    </div>`;
}

/* ════════════════════════════════════════════════
   8. 主渲染
   ════════════════════════════════════════════════ */

async function renderTechAnalysis() {
  // 找容器 — index.html 用 #analysis-content
  let wrap = document.getElementById('analysis-content')
          || document.getElementById('analysis-wrap')
          || document.getElementById('analysis')
          || document.querySelector('#tab-analysis');
  if (!wrap) {
    for (const d of document.querySelectorAll('div[id]')) {
      if (d.textContent.includes('持股評分')) { wrap = d; break; }
    }
  }
  if (!wrap) return;

  // 讀持股
  let holdings = [];
  try {
    holdings = _spHoldings();
  } catch(e) {}
  if (!Array.isArray(holdings) || !holdings.length) {
    wrap.innerHTML = '<div style="padding:20px;text-align:center;color:#888">尚未新增持股</div>';
    return;
  }

  wrap.innerHTML = `<div style="padding:20px;text-align:center;color:#aaa">
    <div style="font-size:26px;margin-bottom:8px">⏳</div>
    正在抓取 K 線與指數資料…
  </div>`;

  // 並行抓指數 + ETF淨值
  const [taiex, navMap] = await Promise.all([fetchTAIEX(), fetchETFNav()]);

  // 依序評分（避免 Yahoo Finance rate limit）
  const results = [];
  for (const h of holdings) {
    const r = await scoreBuySignal(h, taiex, navMap);
    results.push({ holding: h, result: r });
    await new Promise(res => setTimeout(res, 300));  // 稍微延遲避免限速
  }

  results.sort((a, b) => b.result.total - a.result.total);

  const t = new Date().toLocaleTimeString('zh-TW', { hour12: false });
  const taiexStr = taiex
    ? `TAIEX ${taiex.cur.toLocaleString()} (${taiex.chgPct >= 0 ? '+' : ''}${taiex.chgPct}%)`
    : 'TAIEX —';

  const refreshFn = `(async()=>{
    ${JSON.stringify(holdings.map(h => h.code))}.forEach(c=>{
      try{localStorage.removeItem('tw_hist_v3_'+c)}catch(e){}
    });
    _navCache=null; _taiexCache=null;
    if(typeof fetchTWSEPrices==='function') await fetchTWSEPrices();
    else if(typeof refreshPrices==='function') await refreshPrices();
    await renderTechAnalysis();
  })()`;

  let html = `
    <div style="padding:0 0 12px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
        <div style="font-size:14px;font-weight:700;color:#e8c84a">📊 買點訊號偵測（100分）</div>
        <div style="display:flex;align-items:center;gap:6px">
          <span style="font-size:10px;color:#555">${t}</span>
          <button onclick="${refreshFn.replace(/"/g,"'")}"
            style="background:#1565c0;color:#fff;border:none;border-radius:5px;padding:4px 10px;font-size:11px;cursor:pointer">↻ 刷新</button>
        </div>
      </div>
      <div style="font-size:11px;color:#888;background:#111122;border-radius:6px;padding:6px 10px;margin-bottom:12px">
        ${taiexStr} | 每條件20分，條件越多買點越強
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;font-size:10px;margin-bottom:12px;color:#777">
        <span>&#x2705; 條件成立(20分)</span>
        <span>&#x1F7E1; 部分成立(10分)</span>
        <span>&#x2B1C; 未達標(0分)</span>
      </div>
    </div>`;

  // 依排名分三組 + 寫回 scoreCache（同步首頁訊號點）
  const groups = [
    { label: '🟢 值得買入（第 1–2 名）', color: '#4caf50', items: results.slice(0, 2) },
    { label: '🟡 考慮買入（第 3–5 名）', color: '#ffc107', items: results.slice(2, 5) },
    { label: '🔴 暫不考慮（第 6 名以後）', color: '#ff4757', items: results.slice(5) },
  ];

  // 寫回 dipCache 讓首頁訊號點同步（獨立快取，見上方宣告處的說明）
  results.forEach(({ holding, result }, idx) => {
    const rank = idx + 1;
    const rc = _rankColor(rank);
    const code = (holding.code || '').replace('.TW','').replace('.TWO','');
    dipCache[code] = { total: result.total, color: rc.cacheColor };
  });
  try { localStorage.setItem('tw_dip_cache', JSON.stringify(dipCache)); } catch(e) {}

  groups.forEach(({ label, color, items }, gi) => {
    if (!items.length) return;
    html += `<div style="margin:${gi===0?'0':'16px'} 0 8px;font-size:12px;font-weight:700;color:${color};
      border-left:3px solid ${color};padding-left:8px">${label}</div>`;
    items.forEach(({ holding, result }, i) => {
      const rank = (gi === 0 ? 0 : gi === 1 ? 2 : 5) + i + 1;
      html += _card(holding, result, rank);
    });
  });

  html += `<div style="font-size:10px;color:#333;text-align:center;padding:8px 0">
    K-line: Yahoo Finance | Live: TWSE MIS | NAV: TWSE BWIBBU_d
  </div>`;

  wrap.innerHTML = html;
  // 刷新首頁持股列表的訊號點
  if (typeof renderPortfolio === 'function') setTimeout(() => renderPortfolio(), 100);
}

/* ================================================
   9. 即時股價抓取（不覆蓋 index.html 的 fetchTWSEPrices）
      改名為 _fetchYahooPrices，避免 hoisting 衝突
      策略：
      1. Yahoo Finance v8 chart API（即時 meta.regularMarketPrice）
      2. TWSE MIS + proxy（補齊主動型ETF等 Yahoo 沒有的代碼）
      成功才合併寫入，失敗保留舊快取
   ================================================ */

async function _fetchYahooPrices(codes) {
  const prices = {};
  const today = new Date().toLocaleDateString('zh-TW');

  /* ── 方法1: Yahoo Finance v8 chart API（讀 meta.regularMarketPrice，
     缺值時改讀歷史收盤序列最後一筆 —— 冷門ETF常有 meta 即時欄位是空的，
     但 indicators.quote[0].close 仍有正常的歷史收盤價，分析頁的K線圖
     走的正是這條路，才會抓到價格而庫存頁抓不到）── */
  async function _yahooLivePrice(code) {
    const suffixes = ['.TW', '.TWO'];
    for (const suf of suffixes) {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${code}${suf}?interval=1d&range=10d`;
      const data = await _yFetch(url);
      const result = data?.chart?.result?.[0];
      if (!result) continue;
      const meta = result.meta || {};
      let price = meta.regularMarketPrice || meta.previousClose || null;
      let prev  = meta.chartPreviousClose || meta.previousClose || null;
      if (!price) {
        const closes = (result.indicators?.quote?.[0]?.close || []).filter(v => v != null);
        if (closes.length) {
          price = closes[closes.length - 1];
          prev  = closes.length > 1 ? closes[closes.length - 2] : null;
        }
      }
      if (price) {
        // meta.symbol is just the ticker (e.g. "00712.TW") — never show that as
        // the name, it just duplicates the code. Try the quote endpoint for a
        // real company/ETF name; leave it blank (not the ticker) if that fails too.
        let name = '';
        try {
          const q = await _yFetch(`https://query1.finance.yahoo.com/v7/finance/quote?symbols=${code}${suf}&fields=longName,shortName`);
          const qr = q?.quoteResponse?.result?.[0];
          name = qr?.longName || qr?.shortName || '';
        } catch (e) {}
        prices[code] = {
          price:   +price.toFixed(2),
          chgPct:  prev ? +((price - prev) / prev * 100).toFixed(2) : null,
          name,
          date:    today
        };
        return;
      }
    }
  }

  await Promise.all(codes.map(c => _yahooLivePrice(c)));

  /* ── 方法2: TWSE MIS（補齊 Yahoo 沒有的代碼）── */
  const miss = codes.filter(c => !prices[c]);
  if (miss.length) {
    async function _mis(list, mkt) {
      const exch = list.map(c => `${mkt}_${c}.tw`).join('|');
      const base = `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=${encodeURIComponent(exch)}&json=1&delay=0`;
      for (const url of [base,
        `https://api.allorigins.win/raw?url=${encodeURIComponent(base)}`,
        `https://corsproxy.io/?${encodeURIComponent(base)}`]) {
        try {
          const r = await Promise.race([
            fetch(url, { cache: 'no-store' }),
            new Promise((_, j) => setTimeout(() => j(new Error('to')), 7000))
          ]);
          if (!r.ok) continue;
          const txt = await r.text();
          if (!txt || txt[0] === '<') continue;
          const j = JSON.parse(txt);
          (j.msgArray || []).forEach(s => {
            const p = parseFloat(s.z) || parseFloat(s.y) || null;
            const y = parseFloat(s.y) || null;
            if (p) prices[s.c] = { price: p, chgPct: y ? +((p-y)/y*100).toFixed(2) : null, name: s.n, date: today };
          });
          return;
        } catch(e) {}
      }
    }
    await _mis(miss, 'tse');
    const still = miss.filter(c => !prices[c]);
    if (still.length) await _mis(still, 'otc');
  }

  /* ── 方法3: TWSE Open API（有 CORS 標頭，不需 proxy，最穩定）── */
  const miss2 = codes.filter(c => !prices[c]);
  if (miss2.length) {
    try {
      const ctrl2 = new AbortController();
      const tid2 = setTimeout(() => ctrl2.abort(), 12000);
      let resp;
      try {
        resp = await fetch('https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL', {
          signal: ctrl2.signal, cache: 'no-store'
        });
      } finally { clearTimeout(tid2); }
      if (resp && resp.ok) {
        const data = await resp.json();
        data.forEach(s => {
          if (miss2.includes(s.Code)) {
            const p = parseFloat((s.ClosingPrice || '').replace(/,/g, '')) || null;
            const o = parseFloat((s.OpeningPrice || '').replace(/,/g, '')) || null;
            if (p) prices[s.Code] = {
              price:  p,
              chgPct: o && o > 0 ? +((p - o) / o * 100).toFixed(2) : null,
              name:   s.Name || s.Code,
              date:   today
            };
          }
        });
      }
    } catch(e) {}
    // 上櫃用 TPEx Open API
    const miss3 = codes.filter(c => !prices[c]);
    if (miss3.length) {
      try {
        const ctrl3 = new AbortController();
        const tid3 = setTimeout(() => ctrl3.abort(), 12000);
        let resp3;
        try {
          resp3 = await fetch('https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes', {
            signal: ctrl3.signal, cache: 'no-store'
          });
        } finally { clearTimeout(tid3); }
        if (resp3 && resp3.ok) {
          const data3 = await resp3.json();
          data3.forEach(s => {
            if (miss3.includes(s.SecuritiesCompanyCode)) {
              const p = parseFloat((s.Close || '').replace(/,/g, '')) || null;
              if (p) prices[s.SecuritiesCompanyCode] = {
                price: p, chgPct: null, name: s.CompanyName || s.SecuritiesCompanyCode, date: today
              };
            }
          });
        }
      } catch(e) {}
    }
  }

  /* ── 成功才合併寫入 localStorage，失敗保留舊快取 ── */
  if (Object.keys(prices).length > 0) {
    try {
      const old = JSON.parse(localStorage.getItem('tw_price_cache') || '{}');
      localStorage.setItem('tw_price_cache', JSON.stringify({ ...old, ...prices }));
      if (typeof priceCache !== 'undefined') Object.assign(priceCache, prices);
    } catch(e) {}
  }

  return prices;
}

/* ================================================
   10. Override & Hook
   ================================================ */

async function renderAnalysis()        { await renderTechAnalysis(); }
async function renderScores()          { await renderTechAnalysis(); }
async function renderPortfolioScores() { await renderTechAnalysis(); }

(function () {
  function patch() {
    if (typeof window.switchTab !== 'function') return false;
    const orig = window.switchTab;
    window.switchTab = function (tab) {
      orig.call(this, tab);
      if (tab === 'analysis' || tab === 'scores') setTimeout(() => renderTechAnalysis(), 80);
    };
    return true;
  }
  if (!patch()) {
    window.addEventListener('DOMContentLoaded', patch);
    window.addEventListener('load', patch);
  }
})();

/* ================================================
   11. 持股列表 — 自動補中文股票名稱
       .hr-sname 顯示中文名（覆蓋 Yahoo ticker 格式）
   ================================================ */

const _NAME_CACHE_KEY = 'tw_stock_names';

async function _fetchStockNames(codes) {
  const names = {};

  async function _tryMIS(list, mkt) {
    const exch = list.map(c => `${mkt}_${c}.tw`).join('|');
    const base  = `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=${encodeURIComponent(exch)}&json=1&delay=0`;
    for (const url of [base,
      `https://api.allorigins.win/raw?url=${encodeURIComponent(base)}`,
      `https://corsproxy.io/?${encodeURIComponent(base)}`]) {
      try {
        const r = await Promise.race([
          fetch(url, { cache: 'no-store' }),
          new Promise((_, j) => setTimeout(() => j(new Error('to')), 6000))
        ]);
        if (!r.ok) continue;
        const txt = await r.text();
        if (!txt || txt[0] === '<') continue;
        const j = JSON.parse(txt);
        (j.msgArray || []).forEach(s => { if (s.n) names[s.c] = s.n; });
        return;
      } catch(e) {}
    }
  }

  await _tryMIS(codes, 'tse');
  const miss = codes.filter(c => !names[c]);
  if (miss.length) await _tryMIS(miss, 'otc');

  // 存入快取
  if (Object.keys(names).length > 0) {
    try {
      const old = JSON.parse(localStorage.getItem(_NAME_CACHE_KEY) || '{}');
      localStorage.setItem(_NAME_CACHE_KEY, JSON.stringify({ ...old, ...names }));
    } catch(e) {}
  }
  return names;
}

function _injectPortfolioNames() {
  let nameCache = {};
  try { nameCache = JSON.parse(localStorage.getItem(_NAME_CACHE_KEY) || '{}'); } catch(e) {}

  // 以 priceCache 補充（TWSE MIS fallback 有中文名）
  try {
    const pc = JSON.parse(localStorage.getItem('tw_price_cache') || '{}');
    Object.entries(pc).forEach(([c, v]) => {
      if (v.name && !/\.\w+$/.test(v.name) && !nameCache[c]) nameCache[c] = v.name;
    });
  } catch(e) {}

  document.querySelectorAll('.holding-row').forEach(row => {
    const codeEl  = row.querySelector('.hr-code');
    const snameEl = row.querySelector('.hr-sname');
    if (!codeEl || !snameEl) return;
    const code = codeEl.textContent.trim();
    const name = nameCache[code];
    if (!name) return;
    snameEl.textContent = name;
    snameEl.style.cssText += ';color:#90caf9!important;font-size:11px!important';
  });
}

(function _patchPortfolioNames() {
  // 攔截 renderPortfolio，執行後補名稱
  const _origRP = window.renderPortfolio;
  if (typeof _origRP === 'function') {
    window.renderPortfolio = async function(...args) {
      const r = await _origRP.apply(this, args);
      // 先用快取立即顯示
      setTimeout(_injectPortfolioNames, 60);
      // 背景從 TWSE 更新名稱
      try {
        const holdings = _spHoldings();
        const codes = holdings
          .map(h => (h.code || '').replace('.TW', '').replace('.TWO', ''))
          .filter(Boolean);
        if (codes.length) _fetchStockNames(codes).then(_injectPortfolioNames);
      } catch(e) {}
      return r;
    };
  }

  // 頁面載入後也補一次（處理 renderPortfolio 在 patch 前就執行的情況）
  window.addEventListener('load', () => setTimeout(async () => {
    try {
      const holdings = _spHoldings();
      const codes = holdings
        .map(h => (h.code || '').replace('.TW', '').replace('.TWO', ''))
        .filter(Boolean);
      if (codes.length) {
        await _fetchStockNames(codes);
        _injectPortfolioNames();
      }
    } catch(e) {}
  }, 2000));
})();

/* ================================================
   12. 目標價 Bar 顏色修正
       若目標賣出價 < 平均成本 → 紅色 bar + 負百分比
       支援 .target-strip/.ts-fill（detail panel）
       及 .tp-bar-fill（holding row 行內 bar）
   ================================================ */

function _patchTargetBars() {
  let holdingMap = {};
  try {
    _spHoldings().forEach(h => { holdingMap[h.code] = h; });
  } catch(e) {}

  // ── 情境 A：detail-panel 內的 .target-strip ──
  document.querySelectorAll('.detail-panel').forEach(panel => {
    const row = panel.previousElementSibling;
    if (!row || !row.classList.contains('holding-row')) return;
    const codeEl = row.querySelector('.hr-code');
    if (!codeEl) return;
    const h = holdingMap[codeEl.textContent.trim()];
    if (!h) return;

    const target = parseFloat(h.target) || 0;
    const cost   = parseFloat(h.cost)   || 0;
    if (!target || !cost || target >= cost) return;  // 只處理 target < cost

    const strip = panel.querySelector('.target-strip');
    if (!strip) return;

    const lossPct = ((target - cost) / cost * 100).toFixed(1);
    const fillPct = Math.min(100, Math.abs(parseFloat(lossPct)));

    const fill   = strip.querySelector('.ts-fill');
    const labels = strip.querySelector('.ts-labels');

    if (fill) {
      fill.style.cssText += ';background:linear-gradient(90deg,#ff4757,#ff8800)!important;width:' + fillPct + '%';
    }
    if (labels) {
      labels.textContent = lossPct + '% 低於成本';
      labels.style.color = '#ff4757';
    }
  });

  // ── 情境 B：holding-row 內的 .tp-bar-wrap（行內 bar）──
  document.querySelectorAll('.tp-bar-wrap').forEach(wrap => {
    // 向上找 holding-row
    let el = wrap;
    while (el && !el.classList.contains('holding-row')) el = el.parentElement;
    if (!el) return;
    const codeEl = el.querySelector('.hr-code');
    if (!codeEl) return;
    const h = holdingMap[codeEl.textContent.trim()];
    if (!h) return;

    const target = parseFloat(h.target) || 0;
    const cost   = parseFloat(h.cost)   || 0;
    if (!target || !cost || target >= cost) return;

    const lossPct = ((target - cost) / cost * 100).toFixed(1);
    const fillPct = Math.min(100, Math.abs(parseFloat(lossPct)));

    const fill   = wrap.querySelector('.tp-bar-fill');
    const label  = wrap.querySelector('.tp-bar-row');

    if (fill) {
      fill.classList.remove('target');
      fill.classList.add('stop');
      fill.style.width = fillPct + '%';
    }
    if (label) {
      // 更新文字：把原本 "X% → price" 改為 "-Y% 低於成本 → price"
      const orig = label.textContent.trim();
      const arrow = orig.indexOf('→');
      const priceStr = arrow >= 0 ? orig.slice(arrow) : '';
      label.innerHTML = `<span style="color:#ff4757">${lossPct}% 低於成本</span>`
                       + (priceStr ? ` <span style="color:#aaa">${priceStr}</span>` : '');
    }
  });
}

// 每次 renderPortfolio 後自動補丁（已在 Section 11 攔截中加入）
// 另外監聽 detail-panel 展開（class 變化）
(function _watchTargetBars() {
  // MutationObserver：監聽 detail-panel 的 class 或 style 變化
  const obs = new MutationObserver(() => { try { _patchTargetBars(); } catch(e) {} });
  function _startObs() {
    document.querySelectorAll('.detail-panel').forEach(p => {
      obs.observe(p, { attributes: true, attributeFilter: ['class', 'style'] });
    });
  }
  window.addEventListener('load', () => {
    setTimeout(_startObs, 2500);
    setTimeout(_patchTargetBars, 2600);
  });
  // 也在 renderPortfolio 後掛接（補到 _patchPortfolioNames 已有的攔截裡）
  const _origInject = window._injectPortfolioNames;
  if (typeof _origInject === 'function') {
    window._injectPortfolioNames = function() {
      _origInject.apply(this, arguments);
      setTimeout(_patchTargetBars, 80);
    };
  }
})();

/* ── 注意：不要在此定義 fetchLiveAndRender ──
   index.html 已定義全域的 fetchLiveAndRender()，供刷新按鈕／30秒自動刷新／
   初始載入共用，其內部呼叫 fetchTWSEPrices()，而 fetchTWSEPrices() 在抓不到
   報價時會自動 fallback 到本檔案的 _fetchYahooPrices()（見下方）。
   曾經在這裡用同名函式覆蓋 index.html 的版本，但因為沒有把抓到的資料組成
   dataMap 傳給 renderPortfolio()，導致訊號/K線資料遺失，且每次刷新都重複
   跑一次很慢的多重 proxy fallback，因此移除，改由 fetchTWSEPrices() 統一
   呼叫 _fetchYahooPrices() 作為最後備援。 */
