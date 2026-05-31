/**
 * scoring_patch.js — 技術面三階段評分系統
 * 覆蓋 index.html 的 renderAnalysis / renderScores 函式
 *
 * 評分邏輯（共 100 分）：
 *   第一階段 40分：底部蓄積（月線下方）
 *     - 下影線紅K   /15
 *     - 量縮價穩    /10
 *     - KD超賣      /10
 *     - KD黃金交叉  /15
 *   第二階段 30分：站回月線（MA20）
 *     - 重回月線    /15
 *     - 站穩月線    /15
 *   第三階段 30分：出量突破確認
 *     - 出量突破    /20
 *     - 多頭排列    /10
 *
 * 資料來源：
 *   上市股 → TWSE STOCK_DAY API（月K資料）
 *   上櫃股 → TPEX 每日成交資訊
 *   快取：localStorage tw_hist_v2_${code}，TTL 4小時
 *
 * 使用方式：在 index.html 的 </body> 前加入
 *   <script src="scoring_patch.js"></script>
 */

/* ═══════════════════════════════════════════════════
   工具函式
   ═══════════════════════════════════════════════════ */

const _HIST_CACHE_KEY = code => `tw_hist_v2_${code}`;
const _HIST_TTL = 4 * 3600 * 1000;

/** 抓取工具：直抓 → corsproxy → allorigins 三層 fallback */
async function _techFetchJson(url) {
  const proxies = [
    u => u,
    u => `https://corsproxy.io/?${encodeURIComponent(u)}`,
    u => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
  ];
  for (const p of proxies) {
    try {
      const r = await fetch(p(url), { signal: AbortSignal.timeout(8000) });
      if (!r.ok) continue;
      const txt = await r.text();
      return JSON.parse(txt);
    } catch (e) { /* try next */ }
  }
  return null;
}

/** 取得本月與上個月的 YYYYMM01 字串，e.g. ['20250601','20250501'] */
function _twoMonths() {
  const now = new Date();
  const cur = new Date(now.getFullYear(), now.getMonth(), 1);
  const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const fmt = d => `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}01`;
  return [fmt(cur), fmt(prev)];
}

/* ═══════════════════════════════════════════════════
   歷史 OHLCV 抓取
   ═══════════════════════════════════════════════════ */

/** 從 TWSE STOCK_DAY 抓取一個月的資料 */
async function _fetchTWSEMonth(code, yyyymm01) {
  const url = `https://www.twse.com.tw/rwd/zh/stock/STOCK_DAY?stockNo=${code}&date=${yyyymm01}&response=json`;
  const data = await _techFetchJson(url);
  if (!data || data.stat !== 'OK' || !Array.isArray(data.data)) return [];
  return data.data.map(row => {
    // fields: 日期,成交股數,成交金額,開盤價,最高價,最低價,收盤價,漲跌價差,成交筆數
    const parse = s => parseFloat(String(s).replace(/,/g, ''));
    return {
      date: row[0],
      volume: parse(row[1]),
      open:   parse(row[3]),
      high:   parse(row[4]),
      low:    parse(row[5]),
      close:  parse(row[6]),
    };
  }).filter(c => !isNaN(c.close) && c.close > 0);
}

/** 從 TPEX 抓取一個月的資料 */
async function _fetchTPEXMonth(code, yyyymm01) {
  const y = yyyymm01.substring(0,4);
  const m = yyyymm01.substring(4,6);
  const d = `${y}/${m}/01`;
  const url = `https://www.tpex.org.tw/web/stock/aftertrading/daily_trading_info/st43_result.php?l=zh-tw&d=${d}&stkno=${code}&s=0,asc,0&output=json`;
  const data = await _techFetchJson(url);
  if (!data || !Array.isArray(data.aaData)) return [];
  return data.aaData.map(row => {
    // aaData: [日期, 成交量, 成交金額, 開盤, 最高, 最低, 收盤, ...]
    const parse = s => parseFloat(String(s).replace(/,/g, ''));
    return {
      date:   row[0],
      volume: parse(row[1]),
      open:   parse(row[3]),
      high:   parse(row[4]),
      low:    parse(row[5]),
      close:  parse(row[6]),
    };
  }).filter(c => !isNaN(c.close) && c.close > 0);
}

/** 取得股票歷史資料（含快取） */
async function fetchStockHistory(code) {
  // 讀快取
  try {
    const raw = localStorage.getItem(_HIST_CACHE_KEY(code));
    if (raw) {
      const cached = JSON.parse(raw);
      if (cached.ts && Date.now() - cached.ts < _HIST_TTL && Array.isArray(cached.data) && cached.data.length >= 20) {
        return cached.data;
      }
    }
  } catch(e) {}

  const [curMonth, prevMonth] = _twoMonths();
  // 先試 TWSE，再試 TPEX
  let candles = [];
  const twseCur  = await _fetchTWSEMonth(code, curMonth);
  const twsePrev = await _fetchTWSEMonth(code, prevMonth);
  candles = [...twsePrev, ...twseCur];

  if (candles.length < 10) {
    const tpexCur  = await _fetchTPEXMonth(code, curMonth);
    const tpexPrev = await _fetchTPEXMonth(code, prevMonth);
    candles = [...tpexPrev, ...tpexCur];
  }

  // 去重並排序
  const seen = new Set();
  candles = candles.filter(c => {
    if (seen.has(c.date)) return false;
    seen.add(c.date);
    return true;
  }).sort((a,b) => a.date < b.date ? -1 : 1);

  try {
    localStorage.setItem(_HIST_CACHE_KEY(code), JSON.stringify({ ts: Date.now(), data: candles }));
  } catch(e) {}

  return candles;
}

/* ═══════════════════════════════════════════════════
   技術指標計算
   ═══════════════════════════════════════════════════ */

function _ma(candles, period, offset = 0) {
  const n = candles.length;
  const end = n - 1 - offset;
  const start = end - period + 1;
  if (start < 0) return null;
  const sum = candles.slice(start, end + 1).reduce((s, c) => s + c.close, 0);
  return sum / period;
}

function _calcKD(candles, period = 9) {
  const n = candles.length;
  if (n < period) return [];
  let k = 50, d = 50;
  const history = [];
  for (let i = period - 1; i < n; i++) {
    const slice = candles.slice(i - period + 1, i + 1);
    const low9  = Math.min(...slice.map(c => c.low));
    const high9 = Math.max(...slice.map(c => c.high));
    const rsv = high9 === low9 ? 50 : (candles[i].close - low9) / (high9 - low9) * 100;
    k = k * 2/3 + rsv * 1/3;
    d = d * 2/3 + k * 1/3;
    history.push({ k: Math.round(k * 10) / 10, d: Math.round(d * 10) / 10 });
  }
  return history;
}

/* ═══════════════════════════════════════════════════
   三階段評分
   ═══════════════════════════════════════════════════ */

function calcTechScore(candles) {
  const n = candles.length;
  if (n < 21) {
    return {
      score: 0,
      details: {
        '下影線紅K': {score:0, max:15},
        '量縮價穩':  {score:0, max:10},
        'KD超賣':    {score:0, max:10},
        'KD黃金交叉':{score:0, max:15},
        '重回月線':  {score:0, max:15},
        '站穩月線':  {score:0, max:15},
        '出量突破':  {score:0, max:20},
        '多頭排列':  {score:0, max:10},
      },
      signals: ['⚠️ 資料不足'],
      kd: { k: 50, d: 50 },
      ma5: null, ma10: null, ma20: null,
      close: candles[n-1]?.close || 0,
      insufficient: true,
    };
  }

  const last = candles[n - 1];
  const prev = candles[n - 2];

  const ma5  = _ma(candles, 5);
  const ma10 = _ma(candles, 10);
  const ma20 = _ma(candles, 20);
  const ma20p = _ma(candles, 20, 1);  // MA20 前一日

  const kdArr = _calcKD(candles, 9);
  const kdLen = kdArr.length;
  const kd    = kdLen > 0 ? kdArr[kdLen - 1] : { k: 50, d: 50 };
  const kdPrev= kdLen > 1 ? kdArr[kdLen - 2] : { k: 50, d: 50 };

  const vol20 = candles.slice(n - 20).reduce((s, c) => s + c.volume, 0) / 20;
  const vol10 = candles.slice(n - 10).reduce((s, c) => s + c.volume, 0) / 10;
  const vol3  = candles.slice(n - 3).reduce((s, c) => s + c.volume, 0) / 3;

  // 蠟燭形態
  const body        = Math.abs(last.close - last.open);
  const lowerShadow = Math.min(last.open, last.close) - last.low;
  const isRedCandle = last.close >= last.open;  // 台股：紅K = 收漲
  const hasLongLower= body > 0 && lowerShadow > body * 1.5;

  const belowMA20 = last.close < (ma20 || Infinity);

  let score = 0;
  const signals = [];
  const details = {};

  /* ── 第一階段：底部蓄積 40分 ── */

  // 下影線紅K /15
  let s1a = 0;
  if (belowMA20 && isRedCandle && hasLongLower) {
    s1a = 15; signals.push('🕯️ 下影線紅K');
  } else if (belowMA20 && hasLongLower) {
    s1a = 8;
  } else if (hasLongLower) {
    s1a = 4;
  }
  details['下影線紅K'] = { score: s1a, max: 15 };
  score += s1a;

  // 量縮價穩 /10
  let s1b = 0;
  const priceChgPct = prev.close > 0 ? Math.abs(last.close - prev.close) / prev.close * 100 : 99;
  if (vol3 < vol10 * 0.7 && priceChgPct < 1.5) {
    s1b = 10; signals.push('📉 量縮價穩');
  } else if (vol3 < vol10 * 0.85 && priceChgPct < 2.5) {
    s1b = 5;
  }
  details['量縮價穩'] = { score: s1b, max: 10 };
  score += s1b;

  // KD超賣 /10
  let s1c = 0;
  if (kd.k < 20) {
    s1c = 10; signals.push('⚠️ KD超賣');
  } else if (kd.k < 30) {
    s1c = 5;
  }
  details['KD超賣'] = { score: s1c, max: 10 };
  score += s1c;

  // KD黃金交叉 /15（K從<20上穿D）
  let s1d = 0;
  const kdGoldenFull = kdPrev.k < 20 && kdPrev.k <= kdPrev.d && kd.k > kd.d;
  const kdGoldenNorm = kdPrev.k <= kdPrev.d && kd.k > kd.d;
  if (kdGoldenFull) {
    s1d = 15; signals.push('✨ KD黃金交叉');
  } else if (kdGoldenNorm) {
    s1d = 8;  signals.push('🔔 KD交叉');
  }
  details['KD黃金交叉'] = { score: s1d, max: 15 };
  score += s1d;

  /* ── 第二階段：站回月線 30分 ── */

  // 重回月線 /15（前日在下、今日在上）
  let s2a = 0;
  const justReclaimed = ma20p !== null && prev.close < ma20p && last.close > ma20;
  if (justReclaimed) {
    s2a = 15; signals.push('🚀 突破月線');
  } else if (ma20 !== null && last.close > ma20) {
    s2a = 7;
  }
  details['重回月線'] = { score: s2a, max: 15 };
  score += s2a;

  // 站穩月線 /15（連續2日 > MA20）
  let s2b = 0;
  if (ma20 !== null && last.close > ma20 && prev.close > (ma20p || ma20)) {
    s2b = 15; signals.push('✅ 站穩月線');
  } else if (ma20 !== null && last.close > ma20) {
    s2b = 7;
  }
  details['站穩月線'] = { score: s2b, max: 15 };
  score += s2b;

  /* ── 第三階段：出量突破 30分 ── */

  // 出量突破 /20
  let s3a = 0;
  const isBreakout = justReclaimed;
  if (isBreakout && last.volume > vol20 * 1.5) {
    s3a = 20; signals.push('💥 出量突破');
  } else if (last.volume > vol20 * 1.5) {
    s3a = 10; signals.push('📊 爆量');
  } else if (last.volume > vol20 * 1.2) {
    s3a = 5;
  }
  details['出量突破'] = { score: s3a, max: 20 };
  score += s3a;

  // 多頭排列 /10（MA5 > MA10 > MA20）
  let s3b = 0;
  if (ma5 && ma10 && ma20 && ma5 > ma10 && ma10 > ma20) {
    s3b = 10; signals.push('📈 多頭排列');
  } else if (ma5 && ma20 && ma5 > ma20) {
    s3b = 5;
  }
  details['多頭排列'] = { score: s3b, max: 10 };
  score += s3b;

  return {
    score: Math.min(100, score),
    details,
    signals,
    kd,
    ma5, ma10, ma20,
    close: last.close,
    belowMA20,
    vol3, vol20,
  };
}

/* ═══════════════════════════════════════════════════
   渲染
   ═══════════════════════════════════════════════════ */

function _scoreColor(score) {
  if (score >= 80) return '#4caf50';
  if (score >= 60) return '#ffc107';
  return '#f44336';
}

function _verdict(score) {
  if (score >= 80) return { text: '✅ 值得買入', color: '#4caf50' };
  if (score >= 60) return { text: '🟡 可考慮',   color: '#ffc107' };
  return                { text: '🔴 暫不考慮',    color: '#f44336' };
}

function _barHTML(detail) {
  const rows = Object.entries(detail).map(([label, { score: s, max }]) => {
    const pct = max > 0 ? Math.min(100, (s / max) * 100) : 0;
    const color = s >= max * 0.8 ? '#4caf50' : s >= max * 0.5 ? '#ffc107' : '#555';
    return `
      <div style="margin-bottom:5px">
        <div style="display:flex;justify-content:space-between;font-size:11px;color:#aaa;margin-bottom:2px">
          <span>${label} <span style="color:#666">/${max}</span></span>
          <span style="color:${_scoreColor(s/max*100)}">${s}</span>
        </div>
        <div style="background:#2a2a3a;border-radius:3px;height:6px;overflow:hidden">
          <div style="width:${pct}%;height:100%;background:${color};border-radius:3px;transition:width .3s"></div>
        </div>
      </div>`;
  }).join('');
  return rows;
}

function _signalTagsHTML(signals) {
  if (!signals.length) return '';
  return `<div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:8px">
    ${signals.map(s => `<span style="background:#1a2a1a;border:1px solid #2e4a2e;color:#81c784;border-radius:4px;padding:2px 7px;font-size:11px">${s}</span>`).join('')}
  </div>`;
}

function _maStatusHTML(result) {
  const { close, ma5, ma10, ma20, kd } = result;
  const fmt = v => v ? v.toFixed(2) : '—';
  const rel = ma20 ? (close > ma20 ? '<span style="color:#f44336">月線上方</span>' : '<span style="color:#4caf50">月線下方</span>') : '—';
  return `
    <div style="display:flex;gap:10px;flex-wrap:wrap;font-size:11px;color:#888;margin-top:8px;padding-top:8px;border-top:1px solid #2a2a3a">
      <span>MA5 <b style="color:#90caf9">${fmt(ma5)}</b></span>
      <span>MA10 <b style="color:#90caf9">${fmt(ma10)}</b></span>
      <span>MA20 <b style="color:#90caf9">${fmt(ma20)}</b></span>
      <span>K <b style="color:#ffb74d">${kd.k}</b></span>
      <span>D <b style="color:#ffb74d">${kd.d}</b></span>
      <span>${rel}</span>
    </div>`;
}

function _scoreCardHTML(holding, result, price) {
  const { score, details, signals, insufficient } = result;
  const v = _verdict(score);
  const dotColor = _scoreColor(score);
  const priceStr = price ? price.toFixed(2) : '—';
  return `
    <div style="background:#1a1a2e;border-radius:12px;padding:16px;margin-bottom:12px;border:1px solid #2a2a4a">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
        <div style="display:flex;align-items:center;gap:10px">
          <div style="width:14px;height:14px;border-radius:50%;background:${dotColor};flex-shrink:0"></div>
          <div>
            <div style="font-size:15px;font-weight:700;color:#e0e0e0">${holding.name} <span style="font-size:12px;color:#666;font-weight:400">${holding.code}</span></div>
            <div style="font-size:11px;color:${v.color}">${v.text}</div>
          </div>
        </div>
        <div style="font-size:28px;font-weight:700;color:${dotColor}">${score}</div>
      </div>
      ${insufficient ? '<div style="color:#888;font-size:12px;padding:8px 0">歷史資料不足（需至少21筆），評分暫以0計</div>' : ''}
      ${_barHTML(details)}
      ${_signalTagsHTML(signals)}
      ${_maStatusHTML(result)}
      <div style="font-size:10px;color:#444;margin-top:6px">現價 ${priceStr}　持股 ${holding.qty} 股　均成本 ${holding.cost}</div>
    </div>`;
}

/** 主渲染函式：分析 tab */
async function renderTechAnalysis() {
  // 找容器：優先找 id="analysis-wrap"，備選找 tab-panel[data-tab="analysis"] 或 .tab-content.active
  let wrap = document.getElementById('analysis-wrap')
          || document.getElementById('analysis')
          || document.querySelector('[data-tab="analysis"]')
          || document.querySelector('.tab-pane.active');

  // 如果找不到，嘗試找包含 "持股評分" 文字的父容器
  if (!wrap) {
    const allDivs = document.querySelectorAll('div');
    for (const d of allDivs) {
      if (d.textContent.includes('持股評分') && d.children.length > 0) {
        wrap = d; break;
      }
    }
  }
  if (!wrap) return;

  // 讀取持股（兼容多種 localStorage key）
  let holdings = [];
  try {
    const raw = localStorage.getItem('tw_holdings') || localStorage.getItem('holdings') || '[]';
    holdings = JSON.parse(raw);
  } catch(e) {}
  if (!Array.isArray(holdings) || holdings.length === 0) {
    wrap.innerHTML = '<div style="padding:20px;text-align:center;color:#888">尚未新增持股</div>';
    return;
  }

  // 顯示載入中
  wrap.innerHTML = `
    <div style="padding:20px;text-align:center;color:#aaa;font-size:14px">
      <div style="font-size:24px;margin-bottom:8px">⏳</div>
      正在抓取 K 線歷史資料計算評分…
    </div>`;

  // 讀取現價快取
  let prices = {};
  try {
    const pc = localStorage.getItem('tw_price_cache');
    if (pc) prices = JSON.parse(pc);
  } catch(e) {}

  // 並行抓取所有股票歷史
  const results = await Promise.all(holdings.map(async h => {
    const candles = await fetchStockHistory(h.code);
    const result  = calcTechScore(candles);
    return { holding: h, result, price: prices[h.code]?.price || null };
  }));

  // 按分數排序
  results.sort((a, b) => b.result.score - a.result.score);

  const updateTime = new Date().toLocaleTimeString('zh-TW', { hour12: false });

  let html = `
    <div style="padding:0 0 10px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
        <div style="font-size:14px;font-weight:700;color:#e8c84a">📊 持股技術評分（100分）</div>
        <div style="display:flex;align-items:center;gap:8px">
          <span style="font-size:10px;color:#555">更新 ${updateTime}</span>
          <button onclick="(async()=>{
            const codes=${JSON.stringify(holdings.map(h=>h.code))};
            codes.forEach(c=>{ try{localStorage.removeItem('tw_hist_v2_'+c)}catch(e){} });
            await renderTechAnalysis();
          })()" style="background:#1565c0;color:#fff;border:none;border-radius:5px;padding:4px 10px;font-size:11px;cursor:pointer">↻ 刷新</button>
        </div>
      </div>
      <div style="font-size:11px;color:#666;margin-bottom:12px">
        🟢 80+值得買入　🟡 60-79可考慮　🔴 &lt;60不考慮
      </div>
    </div>`;

  html += results.map(({ holding, result, price }) =>
    _scoreCardHTML(holding, result, price)
  ).join('');

  html += `<div style="font-size:10px;color:#333;text-align:center;padding:8px 0">
    資料來源：TWSE / TPEX　K線歷史快取4小時
  </div>`;

  wrap.innerHTML = html;
}

/* ═══════════════════════════════════════════════════
   掛鉤到 switchTab
   ═══════════════════════════════════════════════════ */

// 覆蓋可能的函數名稱
async function renderAnalysis() { await renderTechAnalysis(); }
async function renderScores()   { await renderTechAnalysis(); }

// 攔截 switchTab
(function _patchSwitchTab() {
  function tryPatch() {
    if (typeof window.switchTab !== 'function') return false;
    const orig = window.switchTab;
    window.switchTab = function(tab) {
      orig.call(this, tab);
      if (tab === 'analysis' || tab === '分析') {
        setTimeout(() => renderTechAnalysis(), 50);
      }
    };
    return true;
  }
  if (!tryPatch()) {
    // switchTab 尚未定義，等 DOM 完成後再試
    window.addEventListener('DOMContentLoaded', tryPatch);
    window.addEventListener('load', tryPatch);
  }
})();
