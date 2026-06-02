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
   0. 啟動：清除過期價格快取，強制重抓今日價格
   ════════════════════════════════════════════════ */
(function _clearStalePriceCache() {
  try {
    const today = new Date().toLocaleDateString('zh-TW');
    const raw = localStorage.getItem('tw_price_cache');
    if (!raw) return;
    const cache = JSON.parse(raw);
    // 如果任何一筆不是今天，全部清除
    const allToday = Object.values(cache).every(v => v && v.date === today);
    if (!allToday) {
      localStorage.removeItem('tw_price_cache');
      console.log('[patch] 清除舊價格快取（' + (Object.values(cache)[0]?.date || '?') + '），將重新抓取');
    }
  } catch(e) {}

  // 延遲 2 秒等 DOM + 其他 script 就緒後，重抓今日即時價格
  setTimeout(async () => {
    try {
      if (typeof fetchLiveAndRender === 'function') {
        await fetchLiveAndRender();
      } else if (typeof fetchTWSEPrices === 'function' && typeof holdings !== 'undefined' && holdings.length) {
        const codes = [...new Set(holdings.map(h => h.code.replace('.TW', '').replace('.TWO', '')))];
        const prices = await fetchTWSEPrices(codes);
        if (typeof priceCache !== 'undefined') Object.assign(priceCache, prices);
        localStorage.setItem('tw_price_cache', JSON.stringify(prices));
        if (typeof renderPortfolio === 'function') renderPortfolio();
      }
    } catch(e) {}
  }, 2000);
})();

/* ════════════════════════════════════════════════
   1. Fetch 工具
   ════════════════════════════════════════════════ */

async function _yFetch(url) {
  // 直接 fetch + allorigins fallback
  const tries = [
    u => u,
    u => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
    u => `https://corsproxy.io/?${encodeURIComponent(u)}`,
  ];
  for (const t of tries) {
    try {
      const r = await fetch(t(url), {
        signal: AbortSignal.timeout(10000),
        headers: { 'Accept': 'application/json' }
      });
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
  const premIdx = fields.findIndex(f => /溢折/.test(f));

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
      prevClose = parseFloat(entry.y || 0) || null;
      if (curPrice && prevClose && prevClose > 0)
        chgPct = (curPrice - prevClose) / prevClose * 100;
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
  const name = holding.name || holding.n || code || '—';
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
              <span style="font-size:11px;color:#aaa;font-weight:400"> ${name}</span>
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
    holdings = JSON.parse(localStorage.getItem('tw_holdings') || localStorage.getItem('holdings') || '[]');
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

  // 寫回 scoreCache 讓首頁訊號點同步
  results.forEach(({ holding, result }, idx) => {
    const rank = idx + 1;
    const rc = _rankColor(rank);
    const code = (holding.code || '').replace('.TW','').replace('.TWO','');
    if (typeof scoreCache !== 'undefined') {
      scoreCache[code] = { total: result.total, color: rc.cacheColor, scores: {} };
      try {
        const KEY_SCORE = Object.keys(localStorage).find(k => k.includes('score') || k.includes('Score')) || 'tw_scores';
        localStorage.setItem(KEY_SCORE, JSON.stringify(scoreCache));
      } catch(e) {}
    }
  });

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
   9. fetchTWSEPrices 覆蓋 — 改用 Yahoo Finance
      (iOS Safari 可用，無需 proxy)
   ================================================ */

async function fetchTWSEPrices(codes) {
  const prices = {};
  const today = new Date().toLocaleDateString('zh-TW');

  // 先嘗試原始 TWSE MIS（收盤後仍可取到前日收盤價）
  try {
    const exch = codes.map(c => 'tse_' + c + '.tw').join('|');
    const url = 'https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=' + encodeURIComponent(exch) + '&json=1&delay=0';
    const r = await Promise.race([
      fetch(url),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 6000))
    ]);
    if (r.ok) {
      const j = await r.json();
      (j.msgArray || []).forEach(s => {
        const price = parseFloat(s.z) || parseFloat(s.y) || null;
        const prev  = parseFloat(s.y) || null;
        const chgPct = price && prev ? +((price - prev) / prev * 100).toFixed(2) : null;
        if (price) prices[s.c] = { price, chgPct, name: s.n, date: today };
      });
      // OTC fallback for missing
      const miss = codes.filter(c => !prices[c]);
      if (miss.length) {
        const exchOtc = miss.map(c => 'otc_' + c + '.tw').join('|');
        const r2 = await Promise.race([
          fetch('https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=' + encodeURIComponent(exchOtc) + '&json=1&delay=0'),
          new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 6000))
        ]);
        if (r2.ok) {
          const j2 = await r2.json();
          (j2.msgArray || []).forEach(s => {
            const price = parseFloat(s.z) || parseFloat(s.y) || null;
            const prev  = parseFloat(s.y) || null;
            const chgPct = price && prev ? +((price - prev) / prev * 100).toFixed(2) : null;
            if (price) prices[s.c] = { price, chgPct, name: s.n, date: today };
          });
        }
      }
    }
  } catch(e) { /* TWSE failed, fall through to Yahoo */ }

  // Yahoo Finance fallback for any still missing
  const missing = codes.filter(c => !prices[c]);
  for (const code of missing) {
    try {
      const data = await _yahooOHLCV(code); // reuse existing function
      if (data && data.length) {
        const last = data[data.length - 1];
        const prev = data.length > 1 ? data[data.length - 2].close : last.close;
        const chgPct = prev ? +((last.close - prev) / prev * 100).toFixed(2) : null;
        prices[code] = { price: last.close, chgPct, name: code, date: today };
      }
    } catch(e) {}
    await new Promise(r => setTimeout(r, 150));
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
