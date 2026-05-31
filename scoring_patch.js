/**
 * scoring_patch.js v2 — 技術面三階段評分系統
 *
 * 評分邏輯（共100分）：
 *   第一階段40分：底部蓄積（月線下方）
 *     下影線紅K/15、量縮價穩/10、KD超賣/10、KD黃金交叉/15
 *   第二階段30分：站回月線
 *     重回月線/15、站穩月線/15
 *   第三階段30分：出量突破
 *     出量突破/20、多頭排列/10
 *
 * 資料：TWSE STOCK_DAY（兩個月K線）+ 多層 proxy fallback
 *       無歷史資料時改以持倉損益%估算基礎分
 */

/* ─── CORS Proxy chain ───────────────────────────── */
async function _techFetch(url) {
  // 優先使用原本 dashboard 的 fetchAny（已對 iOS 優化）
  if (typeof fetchAny === 'function') {
    try { return await (await fetchAny(url)).json(); } catch(e) {}
  }
  const proxies = [
    u => u,
    u => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
    u => `https://corsproxy.io/?${encodeURIComponent(u)}`,
    u => `https://thingproxy.freeboard.io/fetch/${u}`,
  ];
  for (const p of proxies) {
    try {
      const r = await fetch(p(url), { signal: AbortSignal.timeout(9000) });
      if (!r.ok) continue;
      const txt = await r.text();
      if (!txt || txt.startsWith('<')) continue;
      return JSON.parse(txt);
    } catch(e) {}
  }
  return null;
}

/* ─── 月份工具 ───────────────────────────────────── */
function _monthStr(offset = 0) {
  const d = new Date();
  d.setMonth(d.getMonth() + offset);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  return `${y}${m}01`;
}

/* ─── 歷史 K 線抓取 ──────────────────────────────── */
const _HIST_KEY  = c => `tw_hist_v2_${c}`;
const _HIST_TTL  = 4 * 3600 * 1000;

async function _fetchTWSE(code, yyyymm01) {
  // 嘗試新舊兩種 URL
  const urls = [
    `https://www.twse.com.tw/rwd/zh/stock/STOCK_DAY?stockNo=${code}&date=${yyyymm01}&response=json`,
    `https://www.twse.com.tw/exchangeReport/STOCK_DAY?response=json&date=${yyyymm01}&stockNo=${code}`,
  ];
  for (const url of urls) {
    const d = await _techFetch(url);
    if (d && d.stat === 'OK' && Array.isArray(d.data) && d.data.length > 0) {
      return d.data.map(r => ({
        date:   r[0],
        volume: parseFloat(String(r[1]).replace(/,/g,'')),
        open:   parseFloat(String(r[3]).replace(/,/g,'')),
        high:   parseFloat(String(r[4]).replace(/,/g,'')),
        low:    parseFloat(String(r[5]).replace(/,/g,'')),
        close:  parseFloat(String(r[6]).replace(/,/g,'')),
      })).filter(c => !isNaN(c.close) && c.close > 0);
    }
  }
  return [];
}

async function _fetchTPEX(code, yyyymm01) {
  const y = yyyymm01.substring(0,4);
  const m = yyyymm01.substring(4,6);
  const url = `https://www.tpex.org.tw/web/stock/aftertrading/daily_trading_info/st43_result.php?l=zh-tw&d=${y}/${m}/01&stkno=${code}&s=0,asc,0&output=json`;
  const d = await _techFetch(url);
  if (!d || !Array.isArray(d.aaData)) return [];
  return d.aaData.map(r => ({
    date:   r[0],
    volume: parseFloat(String(r[1]).replace(/,/g,'')),
    open:   parseFloat(String(r[3]).replace(/,/g,'')),
    high:   parseFloat(String(r[4]).replace(/,/g,'')),
    low:    parseFloat(String(r[5]).replace(/,/g,'')),
    close:  parseFloat(String(r[6]).replace(/,/g,'')),
  })).filter(c => !isNaN(c.close) && c.close > 0);
}

async function fetchStockHistory(code) {
  try {
    const raw = localStorage.getItem(_HIST_KEY(code));
    if (raw) {
      const c = JSON.parse(raw);
      if (c.ts && Date.now() - c.ts < _HIST_TTL && Array.isArray(c.data) && c.data.length >= 10) {
        return c.data;
      }
    }
  } catch(e) {}

  const months = [_monthStr(0), _monthStr(-1), _monthStr(-2)];
  let candles = [];

  for (const mo of months) {
    const rows = await _fetchTWSE(code, mo);
    if (rows.length > 0) { candles = [...rows, ...candles]; }
  }
  if (candles.length < 10) {
    candles = [];
    for (const mo of months) {
      const rows = await _fetchTPEX(code, mo);
      if (rows.length > 0) candles = [...rows, ...candles];
    }
  }

  // 去重排序
  const seen = new Set();
  candles = candles.filter(c => { if (seen.has(c.date)) return false; seen.add(c.date); return true; })
                   .sort((a,b) => a.date < b.date ? -1 : 1);

  try { localStorage.setItem(_HIST_KEY(code), JSON.stringify({ ts: Date.now(), data: candles })); } catch(e) {}
  return candles;
}

/* ─── 技術指標計算 ───────────────────────────────── */
function _ma(arr, n, off=0) {
  const end = arr.length - 1 - off;
  const start = end - n + 1;
  if (start < 0) return null;
  return arr.slice(start, end+1).reduce((s,c)=>s+c.close,0)/n;
}

function _calcKD(arr, n=9) {
  if (arr.length < n) return [];
  let k=50, d=50;
  return arr.slice(n-1).map((_, i) => {
    const sl = arr.slice(i, i+n);
    const lo = Math.min(...sl.map(c=>c.low));
    const hi = Math.max(...sl.map(c=>c.high));
    const rsv = hi===lo ? 50 : (arr[i+n-1].close-lo)/(hi-lo)*100;
    k = k*2/3+rsv/3;
    d = d*2/3+k/3;
    return { k: Math.round(k*10)/10, d: Math.round(d*10)/10 };
  });
}

/* ─── 三階段評分 ─────────────────────────────────── */
function calcTechScore(candles, holding) {
  const EMPTY = () => ({
    '下影線紅K':{score:0,max:15},
    '量縮價穩': {score:0,max:10},
    'KD超賣':   {score:0,max:10},
    'KD黃金交叉':{score:0,max:15},
    '重回月線': {score:0,max:15},
    '站穩月線': {score:0,max:15},
    '出量突破': {score:0,max:20},
    '多頭排列': {score:0,max:10},
  });

  // ── 歷史資料不足：改用損益%估算 ──
  if (!candles || candles.length < 21) {
    const pl = holding && holding.cost > 0 && holding._price
      ? (holding._price - holding.cost) / holding.cost * 100
      : null;

    if (pl === null) return { score:0, details:EMPTY(), signals:['⚠️ 資料不足'], kd:{k:50,d:50}, ma5:null, ma10:null, ma20:null, close:0, insufficient:true };

    // 以損益%粗估
    let s = 30; // 基礎分
    const det = EMPTY();
    if (pl > 15)      { s += 20; det['多頭排列'].score=10; det['站穩月線'].score=10; }
    else if (pl > 5)  { s += 10; det['站穩月線'].score=7; }
    else if (pl > 0)  { s += 5; }
    else if (pl > -5) { s += 8; det['KD超賣'].score=5; }
    else              { s += 15; det['KD超賣'].score=10; det['量縮價穩'].score=5; }
    det['重回月線'].score = pl > 0 ? 8 : 0;
    s = Math.min(70, Math.max(0, s));
    return { score:s, details:det, signals:['📊 損益估算（無K線）'], kd:{k:50,d:50}, ma5:null, ma10:null, ma20:null, close:holding._price||0, estimated:true };
  }

  const n = candles.length;
  const last = candles[n-1], prev = candles[n-2];
  const ma5=_ma(candles,5), ma10=_ma(candles,10), ma20=_ma(candles,20), ma20p=_ma(candles,20,1);
  const kdArr=_calcKD(candles,9);
  const kd   = kdArr.length>0 ? kdArr[kdArr.length-1] : {k:50,d:50};
  const kdPrev= kdArr.length>1 ? kdArr[kdArr.length-2] : {k:50,d:50};
  const vol20 = candles.slice(n-20).reduce((s,c)=>s+c.volume,0)/20;
  const vol10 = candles.slice(n-10).reduce((s,c)=>s+c.volume,0)/10;
  const vol3  = candles.slice(n-3).reduce((s,c)=>s+c.volume,0)/3;
  const body  = Math.abs(last.close-last.open);
  const lShadow= Math.min(last.open,last.close)-last.low;
  const isRed = last.close>=last.open;
  const longShadow= body>0 && lShadow>body*1.5;
  const belowMA20 = ma20!==null && last.close<ma20;

  let score=0;
  const signals=[], det=EMPTY();

  // Stage 1
  let s1a=0;
  if (belowMA20&&isRed&&longShadow){s1a=15;signals.push('🕯️ 下影線紅K');}
  else if (belowMA20&&longShadow)   s1a=8;
  else if (longShadow)              s1a=4;
  det['下影線紅K'].score=s1a; score+=s1a;

  let s1b=0;
  const pChg=prev.close>0?Math.abs(last.close-prev.close)/prev.close*100:99;
  if (vol3<vol10*0.7&&pChg<1.5){s1b=10;signals.push('📉 量縮價穩');}
  else if (vol3<vol10*0.85&&pChg<2.5) s1b=5;
  det['量縮價穩'].score=s1b; score+=s1b;

  let s1c=0;
  if (kd.k<20){s1c=10;signals.push('⚠️ KD超賣');}
  else if (kd.k<30) s1c=5;
  det['KD超賣'].score=s1c; score+=s1c;

  let s1d=0;
  if (kdPrev.k<20&&kdPrev.k<=kdPrev.d&&kd.k>kd.d){s1d=15;signals.push('✨ KD黃金交叉');}
  else if (kdPrev.k<=kdPrev.d&&kd.k>kd.d){s1d=8;signals.push('🔔 KD交叉');}
  det['KD黃金交叉'].score=s1d; score+=s1d;

  // Stage 2
  const justReclaimed = ma20p!==null && prev.close<ma20p && ma20!==null && last.close>ma20;
  let s2a=0;
  if (justReclaimed){s2a=15;signals.push('🚀 突破月線');}
  else if (ma20&&last.close>ma20) s2a=7;
  det['重回月線'].score=s2a; score+=s2a;

  let s2b=0;
  if (ma20&&last.close>ma20&&prev.close>(ma20p||ma20)){s2b=15;signals.push('✅ 站穩月線');}
  else if (ma20&&last.close>ma20) s2b=7;
  det['站穩月線'].score=s2b; score+=s2b;

  // Stage 3
  let s3a=0;
  if (justReclaimed&&last.volume>vol20*1.5){s3a=20;signals.push('💥 出量突破');}
  else if (last.volume>vol20*1.5){s3a=10;signals.push('📊 爆量');}
  else if (last.volume>vol20*1.2) s3a=5;
  det['出量突破'].score=s3a; score+=s3a;

  let s3b=0;
  if (ma5&&ma10&&ma20&&ma5>ma10&&ma10>ma20){s3b=10;signals.push('📈 多頭排列');}
  else if (ma5&&ma20&&ma5>ma20) s3b=5;
  det['多頭排列'].score=s3b; score+=s3b;

  return { score:Math.min(100,score), details:det, signals, kd, ma5, ma10, ma20, close:last.close, belowMA20 };
}

/* ─── 渲染工具 ───────────────────────────────────── */
function _sc(s){ return s>=80?'#4caf50':s>=60?'#ffc107':'#f44336'; }
function _verdict(s){
  if(s>=80) return {text:'✅ 值得買入',color:'#4caf50'};
  if(s>=60) return {text:'🟡 可考慮',  color:'#ffc107'};
  return            {text:'🔴 暫不考慮',color:'#f44336'};
}

function _bars(det){
  return Object.entries(det).map(([label,{score:s,max}])=>{
    const pct=max>0?Math.min(100,s/max*100):0;
    const col=s>=max*0.8?'#4caf50':s>=max*0.5?'#ffc107':'#555';
    return `<div style="margin-bottom:5px">
      <div style="display:flex;justify-content:space-between;font-size:11px;color:#aaa;margin-bottom:2px">
        <span>${label}<span style="color:#555"> /${max}</span></span>
        <span style="color:${_sc(s/max*100)}">${s}</span>
      </div>
      <div style="background:#2a2a3a;border-radius:3px;height:6px">
        <div style="width:${pct}%;height:100%;background:${col};border-radius:3px;transition:width .3s"></div>
      </div></div>`;
  }).join('');
}

function _signals(sigs){
  if(!sigs.length) return '';
  return `<div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:8px">${
    sigs.map(s=>`<span style="background:#1a2a1a;border:1px solid #2e4a2e;color:#81c784;border-radius:4px;padding:2px 7px;font-size:11px">${s}</span>`).join('')
  }</div>`;
}

function _maRow(r){
  const f=v=>v?v.toFixed(2):'—';
  const rel=r.ma20?(r.close>r.ma20?'<span style="color:#f44336">月線上</span>':'<span style="color:#4caf50">月線下</span>'):'—';
  return `<div style="display:flex;flex-wrap:wrap;gap:8px;font-size:11px;color:#777;margin-top:8px;padding-top:8px;border-top:1px solid #2a2a3a">
    <span>MA5 <b style="color:#90caf9">${f(r.ma5)}</b></span>
    <span>MA10 <b style="color:#90caf9">${f(r.ma10)}</b></span>
    <span>MA20 <b style="color:#90caf9">${f(r.ma20)}</b></span>
    <span>K <b style="color:#ffb74d">${r.kd.k}</b></span>
    <span>D <b style="color:#ffb74d">${r.kd.d}</b></span>
    <span>${rel}</span>
  </div>`;
}

function _card(holding, result, price){
  const v = _verdict(result.score);
  const name = holding.name || holding.n || holding.code || '—';
  const priceStr = price ? price.toFixed(2) : (result.close ? result.close.toFixed(2) : '—');
  const note = result.estimated ? '<div style="font-size:10px;color:#666;margin-top:4px">⚠️ K線資料暫時無法取得，以損益%估算</div>' : '';
  return `
    <div style="background:#1a1a2e;border-radius:12px;padding:16px;margin-bottom:12px;border:1px solid #2a2a4a">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
        <div style="display:flex;align-items:center;gap:10px">
          <div style="width:14px;height:14px;border-radius:50%;background:${_sc(result.score)};flex-shrink:0"></div>
          <div>
            <div style="font-size:15px;font-weight:700;color:#e0e0e0">${name} <span style="font-size:12px;color:#555;font-weight:400">${holding.code}</span></div>
            <div style="font-size:11px;color:${v.color}">${v.text}</div>
          </div>
        </div>
        <div style="font-size:28px;font-weight:700;color:${_sc(result.score)}">${result.score}</div>
      </div>
      ${_bars(result.details)}
      ${_signals(result.signals)}
      ${_maRow(result)}
      ${note}
      <div style="font-size:10px;color:#444;margin-top:6px">現價 ${priceStr}　持股 ${holding.qty||0} 股　均成本 ${holding.cost||0}</div>
    </div>`;
}

/* ─── 主渲染 ─────────────────────────────────────── */
async function renderTechAnalysis() {
  // 找容器（嘗試多種可能的 ID / selector）
  let wrap = document.getElementById('analysis-wrap')
          || document.getElementById('analysis')
          || document.querySelector('#tab-analysis')
          || document.querySelector('[data-tab="analysis"]');

  if (!wrap) {
    // 找含「持股評分」的 div
    for (const d of document.querySelectorAll('div')) {
      if (d.textContent.includes('持股評分') && d.id) { wrap=d; break; }
    }
  }
  if (!wrap) return;

  // 讀持股
  let holdings = [];
  try {
    const raw = localStorage.getItem('tw_holdings') || localStorage.getItem('holdings') || '[]';
    holdings = JSON.parse(raw);
  } catch(e) {}
  if (!Array.isArray(holdings) || !holdings.length) {
    wrap.innerHTML='<div style="padding:20px;text-align:center;color:#888">尚未新增持股</div>';
    return;
  }

  // 讀現價快取
  let prices={};
  try { prices=JSON.parse(localStorage.getItem('tw_price_cache')||'{}'); } catch(e) {}

  wrap.innerHTML=`<div style="padding:20px;text-align:center;color:#aaa;font-size:14px"><div style="font-size:24px;margin-bottom:8px">⏳</div>正在抓取 K 線資料…</div>`;

  // 並行抓取
  const results = await Promise.all(holdings.map(async h => {
    const price = prices[h.code]?.price || prices[h.code]?.z || null;
    const hWithPrice = { ...h, _price: price ? parseFloat(price) : null };
    const candles = await fetchStockHistory(h.code);
    const result  = calcTechScore(candles, hWithPrice);
    return { holding: h, result, price: hWithPrice._price };
  }));

  results.sort((a,b)=>b.result.score-a.result.score);

  const t = new Date().toLocaleTimeString('zh-TW',{hour12:false});
  const refreshCode = `(async()=>{
    ${JSON.stringify(holdings.map(h=>h.code))}.forEach(c=>{ try{localStorage.removeItem('tw_hist_v2_'+c)}catch(e){} });
    await renderTechAnalysis();
  })()`;

  let html=`
    <div style="padding:0 0 10px">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
        <div style="font-size:14px;font-weight:700;color:#e8c84a">📊 持股技術評分（100分）</div>
        <div style="display:flex;align-items:center;gap:6px">
          <span style="font-size:10px;color:#555">${t}</span>
          <button onclick="${refreshCode.replace(/"/g,"'")}" style="background:#1565c0;color:#fff;border:none;border-radius:5px;padding:4px 10px;font-size:11px;cursor:pointer">↻ 刷新</button>
        </div>
      </div>
      <div style="font-size:11px;color:#666;margin-bottom:12px">🟢 80+值得買入　🟡 60-79可考慮　🔴 &lt;60不考慮</div>
    </div>`;

  html += results.map(({holding,result,price})=>_card(holding,result,price)).join('');
  html += `<div style="font-size:10px;color:#333;text-align:center;padding:8px 0">資料來源：TWSE / TPEX　K線快取4小時</div>`;

  wrap.innerHTML = html;
}

/* ─── 覆蓋 & 掛鉤 ────────────────────────────────── */
async function renderAnalysis(){ await renderTechAnalysis(); }
async function renderScores()  { await renderTechAnalysis(); }

(function(){
  function patch(){
    if (typeof window.switchTab !== 'function') return false;
    const orig = window.switchTab;
    window.switchTab = function(tab){
      orig.call(this, tab);
      if (tab==='analysis'||tab==='分析') setTimeout(()=>renderTechAnalysis(), 80);
    };
    return true;
  }
  if (!patch()) {
    window.addEventListener('DOMContentLoaded', patch);
    window.addEventListener('load', patch);
  }
})();
