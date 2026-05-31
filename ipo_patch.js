/**
 * ipo_patch.js — 新上市/興櫃即時追蹤器
 * 覆蓋 index.html 的 renderPotentialStocks()
 * 資料來源：TWSE OpenAPI + TPEX OpenAPI（CORS 友好）
 * 快取：localStorage 'tw_ipo_v3'，TTL 6 小時
 *
 * 使用方式：在 index.html 的 </body> 前加入
 *   <script src="ipo_patch.js"></script>
 */

/* ─── 日期工具 ─────────────────────────────────────── */
function parseListDate(str) {
  if (!str) return null;
  str = String(str).replace(/[\/\-\s]/g, '').trim();
  if (str.length === 7) {                      // 民國 1140501
    const y = parseInt(str.substring(0, 3), 10) + 1911;
    const m = parseInt(str.substring(3, 5), 10) - 1;
    const d = parseInt(str.substring(5, 7), 10);
    return new Date(y, m, d);
  }
  if (str.length === 8) {                      // 西元 20250501
    const y = parseInt(str.substring(0, 4), 10);
    const m = parseInt(str.substring(4, 6), 10) - 1;
    const d = parseInt(str.substring(6, 8), 10);
    return new Date(y, m, d);
  }
  const d = new Date(str);
  return isNaN(d) ? null : d;
}

function daysFromNow(date) {
  if (!date) return 999;
  return Math.round((date - Date.now()) / 86400000);
}

function formatDate(date) {
  if (!date) return '—';
  const m = date.getMonth() + 1;
  const d = date.getDate();
  return `${date.getFullYear()}/${m < 10 ? '0' + m : m}/${d < 10 ? '0' + d : d}`;
}

/* ─── 分類工具 ─────────────────────────────────────── */
function isTechStock(name, industry) {
  const txt = (name || '') + ' ' + (industry || '');
  return /半導體|晶圓|電子|科技|IC設計|AI|人工智慧|算力|軟體|網路|資訊|光電|通訊|5G|HPC|CPU|GPU|晶片|封裝|測試|PCB|連接器|電源|車用電子|伺服器|記憶體|DRAM|面板|感測|雷達|無線|射頻|功率|氮化鎵|碳化矽/i.test(txt);
}

function isETFStock(name) {
  return /ETF|etf|指數基金|指數型|型基金/.test(name || '');
}

function getMarketBadge(market) {
  if (!market) return '';
  if (/上市|TWSE/i.test(market)) return '<span class="ps-badge" style="background:#d32f2f">上市</span>';
  if (/上櫃|TPEX/i.test(market)) return '<span class="ps-badge" style="background:#1565c0">上櫃</span>';
  if (/興櫃/i.test(market)) return '<span class="ps-badge" style="background:#2e7d32">興櫃</span>';
  return `<span class="ps-badge">${market}</span>`;
}

/* ─── 評分 (0-100) ─────────────────────────────────── */
function scoreIPOStock(s) {
  let score = 0;
  // 科技/ETF 加分 (30)
  if (isETFStock(s.name)) score += 30;
  else if (isTechStock(s.name, s.industry)) score += 25;
  else score += 5;
  // 即將上市時間 (30)：越近越高
  const days = daysFromNow(s.listDate);
  if (days >= 0 && days <= 7)       score += 30;
  else if (days >= 0 && days <= 14) score += 24;
  else if (days >= 0 && days <= 30) score += 18;
  else if (days < 0 && days >= -7)  score += 20;  // 剛上市
  else if (days < 0 && days >= -30) score += 12;  // 近期上市
  // 知名度/字數 粗估流動性 (20)
  const codeNum = parseInt(s.code, 10);
  if (isETFStock(s.name)) score += 20;
  else if (codeNum >= 6600 || isNaN(codeNum)) score += 10;
  else score += 15;
  // 市場層級 (20)
  if (/上市|TWSE/i.test(s.market)) score += 20;
  else if (/上櫃|TPEX/i.test(s.market)) score += 14;
  else score += 8;  // 興櫃

  return Math.min(100, score);
}

/* ─── API 抓取（帶 CORS proxy fallback） ──────────────── */
async function _fetchJson(url) {
  // 優先直接抓；失敗才走 proxy
  const proxies = [
    u => u,
    u => `https://corsproxy.io/?${encodeURIComponent(u)}`,
    u => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
  ];
  for (const p of proxies) {
    try {
      const r = await fetch(p(url), { signal: AbortSignal.timeout(8000) });
      if (!r.ok) continue;
      const ct = r.headers.get('content-type') || '';
      if (ct.includes('json')) return await r.json();
      const txt = await r.text();
      return JSON.parse(txt);
    } catch (e) { /* try next */ }
  }
  return null;
}

/* ─── 資料來源 ──────────────────────────────────────── */
async function _fetchTWSEListings() {
  const data = await _fetchJson('https://openapi.twse.com.tw/v1/company/');
  if (!Array.isArray(data)) return [];
  const now = Date.now();
  const results = [];
  for (const item of data) {
    const rawDate = item['上市日期'] || item['listingDate'] || item['ListingDate'] || '';
    const listDate = parseListDate(rawDate);
    if (!listDate) continue;
    const diffDays = (listDate - now) / 86400000;
    if (diffDays < -30 || diffDays > 60) continue;  // 只要前後30/60天
    const name = item['公司名稱'] || item['CompanyName'] || item['name'] || '';
    const code = item['股票代號'] || item['stockCode'] || item['Code'] || '';
    const industry = item['產業別'] || item['IndustryType'] || item['industry'] || '';
    if (!code || !name) continue;
    results.push({ code, name, industry, market: '上市', listDate, source: 'TWSE' });
  }
  return results;
}

async function _fetchTPEXListings() {
  const data = await _fetchJson('https://www.tpex.org.tw/openapi/v1/tpex_mainboard_list');
  if (!Array.isArray(data)) return [];
  const now = Date.now();
  const results = [];
  for (const item of data) {
    const rawDate = item['上櫃日期'] || item['ListingDate'] || item['listingDate'] || '';
    const listDate = parseListDate(rawDate);
    if (!listDate) continue;
    const diffDays = (listDate - now) / 86400000;
    if (diffDays < -30 || diffDays > 60) continue;
    const name = item['公司名稱'] || item['CompanyName'] || item['name'] || '';
    const code = item['股票代號'] || item['SecuritiesCompanyCode'] || item['Code'] || '';
    const industry = item['產業別'] || item['IndustryType'] || item['industry'] || '';
    if (!code || !name) continue;
    results.push({ code, name, industry, market: '上櫃', listDate, source: 'TPEX' });
  }
  return results;
}

async function _fetchTPEXEmerging() {
  const data = await _fetchJson('https://www.tpex.org.tw/openapi/v1/tpex_priceinfo_emerging_stock');
  if (!Array.isArray(data)) return [];
  const results = [];
  for (const item of data) {
    const name = item['公司名稱'] || item['CompanyName'] || '';
    const code = item['股票代號'] || item['SecuritiesCompanyCode'] || '';
    const industry = item['產業別'] || item['IndustryType'] || '';
    if (!code || !name) continue;
    if (!isTechStock(name, industry) && !isETFStock(name)) continue;  // 興櫃只保留科技/ETF
    results.push({ code, name, industry, market: '興櫃', listDate: null, source: 'TPEX_Emerging' });
  }
  return results.slice(0, 20);  // 最多20筆
}

async function _fetchTWSEIPO() {
  const data = await _fetchJson('https://www.twse.com.tw/rwd/zh/ipo/CAPM2?response=json');
  if (!data || !Array.isArray(data.data)) return [];
  const now = Date.now();
  const results = [];
  const fields = data.fields || [];
  const dateIdx = fields.findIndex(f => /日期/.test(f));
  const codeIdx = fields.findIndex(f => /代號/.test(f));
  const nameIdx = fields.findIndex(f => /名稱|公司/.test(f));
  for (const row of data.data) {
    const rawDate = dateIdx >= 0 ? row[dateIdx] : '';
    const listDate = parseListDate(rawDate);
    if (!listDate) continue;
    const diffDays = (listDate - now) / 86400000;
    if (diffDays < -7 || diffDays > 45) continue;
    const code = codeIdx >= 0 ? String(row[codeIdx]).trim() : '';
    const name = nameIdx >= 0 ? String(row[nameIdx]).trim() : '';
    if (!code || !name) continue;
    results.push({ code, name, industry: '', market: '上市IPO', listDate, source: 'TWSE_IPO' });
  }
  return results;
}

/* ─── 主快取層 ─────────────────────────────────────── */
const IPO_CACHE_KEY = 'tw_ipo_v3';
const IPO_CACHE_TTL = 6 * 3600 * 1000;

async function fetchNewListings() {
  // 讀快取
  try {
    const raw = localStorage.getItem(IPO_CACHE_KEY);
    if (raw) {
      const cached = JSON.parse(raw);
      if (cached.ts && Date.now() - cached.ts < IPO_CACHE_TTL && Array.isArray(cached.data)) {
        return { data: cached.data, fromCache: true, ts: cached.ts };
      }
    }
  } catch (e) {}

  // 並行抓取
  const [twse, tpex, emerging, ipoFall] = await Promise.allSettled([
    _fetchTWSEListings(),
    _fetchTPEXListings(),
    _fetchTPEXEmerging(),
    _fetchTWSEIPO(),
  ]);

  const all = [
    ...(twse.status === 'fulfilled' ? twse.value : []),
    ...(tpex.status === 'fulfilled' ? tpex.value : []),
    ...(emerging.status === 'fulfilled' ? emerging.value : []),
    ...(ipoFall.status === 'fulfilled' ? ipoFall.value : []),
  ];

  // 去重（以股票代號為主鍵）
  const seen = new Set();
  const unique = all.filter(s => {
    if (!s.code || seen.has(s.code)) return false;
    seen.add(s.code);
    return true;
  });

  // 評分排序
  unique.forEach(s => { s.score = scoreIPOStock(s); });
  unique.sort((a, b) => b.score - a.score);

  const ts = Date.now();
  try {
    localStorage.setItem(IPO_CACHE_KEY, JSON.stringify({ ts, data: unique }));
  } catch (e) {}

  return { data: unique, fromCache: false, ts };
}

async function refreshIPOData() {
  try { localStorage.removeItem(IPO_CACHE_KEY); } catch (e) {}
  await renderPotentialStocks();
  if (typeof showToast === 'function') showToast('已更新新上市/興櫃資料 ✓');
}

/* ─── 渲染 ─────────────────────────────────────────── */
async function renderPotentialStocks() {
  const wrap = document.getElementById('potential-stocks-wrap');
  if (!wrap) return;

  // ── 載入中佔位 ──
  wrap.innerHTML = `
    <div style="padding:24px;text-align:center;color:#aaa;font-size:14px">
      <div style="font-size:28px;margin-bottom:8px">⏳</div>
      正在抓取最新上市/興櫃資料…
    </div>`;

  let result;
  try {
    result = await fetchNewListings();
  } catch (e) {
    wrap.innerHTML = `<div style="padding:16px;color:#f66;font-size:13px">⚠️ 無法取得資料：${e.message}</div>`;
    return;
  }

  const { data: stocks, fromCache, ts } = result;
  const now = Date.now();
  const updateTime = new Date(ts).toLocaleString('zh-TW', { hour12: false });

  // ── 分組 ──
  const upcoming  = stocks.filter(s => s.listDate && daysFromNow(s.listDate) >= 0 && daysFromNow(s.listDate) <= 30);
  const recent    = stocks.filter(s => s.listDate && daysFromNow(s.listDate) < 0 && daysFromNow(s.listDate) >= -30);
  const etfGroup  = stocks.filter(s => isETFStock(s.name));
  const techGroup = stocks.filter(s => !isETFStock(s.name) && isTechStock(s.name, s.industry));
  const emerging  = stocks.filter(s => s.market === '興櫃');

  function codeTag(s) {
    const days = s.listDate ? daysFromNow(s.listDate) : null;
    let badge = '';
    if (days !== null && days >= 0 && days <= 7)  badge = `<span style="background:#c62828;color:#fff;border-radius:3px;padding:1px 5px;font-size:10px;margin-left:4px">🔥 ${days}天後</span>`;
    else if (days !== null && days >= 0)           badge = `<span style="background:#1565c0;color:#fff;border-radius:3px;padding:1px 5px;font-size:10px;margin-left:4px">${days}天後</span>`;
    else if (days !== null && days >= -7)          badge = `<span style="background:#2e7d32;color:#fff;border-radius:3px;padding:1px 5px;font-size:10px;margin-left:4px">剛上市</span>`;
    const dateStr = s.listDate ? formatDate(s.listDate) : '—';
    return `
      <div class="ipo-row" style="display:flex;align-items:center;justify-content:space-between;padding:7px 10px;background:#1a1a2e;border-radius:6px;margin-bottom:6px">
        <div style="display:flex;align-items:center;gap:8px">
          <span style="font-size:16px;font-weight:700;color:#e8c84a;font-family:monospace">${s.code}</span>
          <span style="font-size:13px;color:#e0e0e0">${s.name}</span>
          ${getMarketBadge(s.market)}
          ${badge}
        </div>
        <div style="text-align:right">
          <div style="font-size:11px;color:#888">${dateStr}</div>
          <div style="font-size:11px;color:#aaa">${s.industry || '—'}</div>
        </div>
      </div>`;
  }

  function sectionHTML(title, icon, items, max) {
    if (!items.length) return '';
    const shown = items.slice(0, max || 999);
    return `
      <div class="ipo-card" style="margin-bottom:14px;background:#12122a;border-radius:10px;padding:12px 14px;border:1px solid #2a2a4a">
        <div class="ipo-title" style="font-size:14px;font-weight:700;color:#e8c84a;margin-bottom:10px">${icon} ${title}
          <span style="font-size:11px;font-weight:400;color:#888;margin-left:6px">(${items.length} 檔)</span>
        </div>
        ${shown.map(codeTag).join('')}
        ${items.length > max ? `<div style="font-size:11px;color:#666;text-align:center;margin-top:4px">… 還有 ${items.length - max} 檔</div>` : ''}
      </div>`;
  }

  // ── 代碼速覽表格 ──
  const topStocks = stocks.slice(0, 30);
  const tableRows = topStocks.map(s => `
    <tr>
      <td style="padding:5px 8px;color:#e8c84a;font-family:monospace;font-weight:700">${s.code}</td>
      <td style="padding:5px 8px;color:#e0e0e0">${s.name}</td>
      <td style="padding:5px 8px">${getMarketBadge(s.market)}</td>
      <td style="padding:5px 8px;color:#aaa;font-size:11px">${s.listDate ? formatDate(s.listDate) : '興櫃中'}</td>
    </tr>`).join('');

  const html = `
    <!-- 標題列 -->
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px">
      <div style="font-size:15px;font-weight:700;color:#e8c84a">📡 新上市 / 興櫃即時追蹤</div>
      <div style="display:flex;align-items:center;gap:8px">
        <span style="font-size:10px;color:#666">${fromCache ? '⚡快取' : '🔄已更新'} ${updateTime}</span>
        <button onclick="refreshIPOData()" style="background:#1565c0;color:#fff;border:none;border-radius:5px;padding:4px 10px;font-size:11px;cursor:pointer">↻ 重新整理</button>
      </div>
    </div>

    ${sectionHTML('即將上市（30天內）', '🚀', upcoming, 10)}
    ${sectionHTML('近期上市（最近30天）', '🟢', recent, 8)}
    ${sectionHTML('ETF 新品', '📦', etfGroup, 8)}
    ${sectionHTML('科技股', '💻', techGroup, 10)}
    ${sectionHTML('興櫃（科技/ETF）', '🌱', emerging, 8)}

    ${stocks.length === 0 ? `
      <div style="padding:20px;text-align:center;color:#888;font-size:13px">
        ⚠️ 目前無近期上市資料，可能是 API 暫時無法存取。<br>
        <button onclick="refreshIPOData()" style="margin-top:8px;background:#333;color:#aaa;border:1px solid #444;border-radius:5px;padding:4px 12px;font-size:11px;cursor:pointer">重試</button>
      </div>` : ''}

    <!-- 股票代碼速覽表 -->
    ${topStocks.length > 0 ? `
    <div style="margin-top:6px;background:#0d0d1e;border-radius:10px;border:1px solid #2a2a4a;overflow:hidden">
      <div style="padding:10px 14px;background:#1a1a30;font-size:13px;font-weight:700;color:#90caf9">📋 股票代碼速覽（前${topStocks.length}檔）</div>
      <div style="overflow-x:auto">
        <table style="width:100%;border-collapse:collapse;font-size:12px">
          <thead>
            <tr style="background:#111128;color:#888">
              <th style="padding:6px 8px;text-align:left">代碼</th>
              <th style="padding:6px 8px;text-align:left">名稱</th>
              <th style="padding:6px 8px;text-align:left">市場</th>
              <th style="padding:6px 8px;text-align:left">上市日</th>
            </tr>
          </thead>
          <tbody>
            ${tableRows}
          </tbody>
        </table>
      </div>
    </div>` : ''}

    <div style="margin-top:8px;font-size:10px;color:#444;text-align:center">
      資料來源：TWSE OpenAPI / TPEX OpenAPI　每6小時更新一次
    </div>
  `;

  wrap.innerHTML = html;
}
