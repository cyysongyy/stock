// 伺服器端（GitHub Actions）行情蒐集：Yahoo → Stooq → CNBC。
// Node 直接連線，沒有瀏覽器的 CORS 限制，也不經過免費代理。
// 每個來源失敗都會留下診斷文字，全部失敗時 throw 帶 .diag 的錯誤。
// Stooq / CNBC 的代號對照與回應格式沒有在正式環境驗證過；解析失敗只會多一行診斷，不會讓整體失敗。

const UA = 'Mozilla/5.0 (compatible; tw-stock-risk-monitor)';
const DAY = 864e5;
const base = {
  yahoo1: () => process.env.YAHOO_BASE || 'https://query1.finance.yahoo.com',
  yahoo2: () => process.env.YAHOO2_BASE || process.env.YAHOO_BASE || 'https://query2.finance.yahoo.com',
  stooq: () => process.env.STOOQ_BASE || 'https://stooq.com',
  cnbc: () => process.env.CNBC_BASE || 'https://quote.cnbc.com',
};

const sleep = ms => new Promise(r => setTimeout(r, ms));
const isoDay = ts => new Date(ts * 1000).toISOString().slice(0, 10);

// 目前應該已收盤的最新美股交易日（美東時間，16:30 後才算當天，跳過週末；休市日不處理）
export function expectedUSClose(now = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(now).map(x => [x.type, x.value]));
  let d = new Date(`${p.year}-${p.month}-${p.day}T12:00:00Z`);
  if ((Number(p.hour) % 24) * 60 + Number(p.minute) < 16 * 60 + 30) d = new Date(d.getTime() - DAY);
  while ([0, 6].includes(d.getUTCDay())) d = new Date(d.getTime() - DAY);
  return d.toISOString().slice(0, 10);
}

async function http(url, { timeoutMs = 15000, retries = 1 } = {}) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: '*/*' }, signal: AbortSignal.timeout(timeoutMs) });
      const text = await r.text();
      if (r.ok) return text;
      lastErr = new Error(`HTTP ${r.status}${text && text.length < 100 ? ' ' + text.replace(/\s+/g, ' ').trim() : ''}`);
      if (r.status !== 429 && r.status < 500) break;
    } catch (e) {
      lastErr = new Error(`無法連線 ${new URL(url).host}（${e.name === 'TimeoutError' ? '逾時' : (e.cause?.code ?? e.message)}）`);
    }
    if (i < retries) await sleep(1500);
  }
  throw lastErr;
}

// ── 各來源：都回傳 { bars: [{ts, c}], via } 或 { quote: {...}, via } ──
async function fromYahoo(sym) {
  const q = `/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=1mo&includePrePost=false`;
  let text, diag = [];
  for (const b of [base.yahoo1(), base.yahoo2()]) {
    try { text = await http(b + q); break; } catch (e) { diag.push(`${new URL(b).host}：${e.message}`); }
  }
  if (text === undefined) { const e = new Error('Yahoo 失敗'); e.diag = diag; throw e; }
  const j = JSON.parse(text);
  const res = j.chart?.result?.[0];
  if (!res?.timestamp) throw new Error(j.chart?.error?.description ?? '內容無資料');
  const close = res.indicators?.quote?.[0]?.close ?? [];
  const bars = res.timestamp.map((t, i) => ({ ts: t, c: close[i] })).filter(b => b.c != null);
  // 剛收盤時最後一根 K 棒的收盤價可能是 null，改用 meta 的即時價補上，避免日期停在前一天
  const m = res.meta;
  if (close.at(-1) == null && Number.isFinite(m?.regularMarketPrice) && m?.regularMarketTime
      && bars.length && isoDay(m.regularMarketTime) > isoDay(bars.at(-1).ts)) {
    bars.push({ ts: m.regularMarketTime, c: m.regularMarketPrice });
  }
  return { bars, via: 'Yahoo' };
}

async function fromStooq(sym, code) {
  if (!code) throw new Error('無對應代號');
  const text = await http(`${base.stooq()}/q/d/l/?s=${encodeURIComponent(code)}&i=d`);
  const rows = text.trim().split(/\r?\n/);
  if (!/^date,/i.test(rows[0] ?? '')) throw new Error('不是 CSV：' + text.slice(0, 40).replace(/\s+/g, ' '));
  const bars = rows.slice(1).map(l => l.split(','))
    .filter(a => /^\d{4}-\d\d-\d\d$/.test(a[0]) && Number.isFinite(parseFloat(a[4])))
    .map(a => ({ ts: Date.UTC(+a[0].slice(0, 4), +a[0].slice(5, 7) - 1, +a[0].slice(8, 10), 14, 30) / 1000, c: parseFloat(a[4]) }));
  if (bars.length < 3) throw new Error('CSV 資料不足');
  return { bars: bars.slice(-25), via: 'Stooq' };
}

async function fromCnbc(sym, code) {
  if (!code) throw new Error('無對應代號');
  const url = `${base.cnbc()}/quote-html-webservice/restQuote/symbolType/symbol?symbols=${encodeURIComponent(code)}&requestMethod=itv&noform=1&partnerId=2&fund=1&exthrs=0&output=json&events=1`;
  const q = JSON.parse(await http(url))?.FormattedQuoteResult?.FormattedQuote?.[0];
  const last = parseFloat(String(q?.last ?? '').replace(/,/g, ''));
  const pct = parseFloat(String(q?.change_pct ?? '').replace(/[,%+]/g, ''));
  const day = String(q?.last_time ?? '').slice(0, 10);
  if (!Number.isFinite(last) || !Number.isFinite(pct) || !/^\d{4}-\d\d-\d\d$/.test(day)) throw new Error('欄位缺漏');
  // CNBC 只有最新一筆，沒有歷史序列，只能當備援（沒有 5 日變動與波動度）
  return { quote: { last, chg1d: pct, date: day, ts: Date.UTC(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10), 14, 30) / 1000 }, via: 'CNBC' };
}

function shape(r) {
  if (r.quote) return { ...r.quote, chg5d: null, rets: [], src: r.via };
  const b = r.bars;
  if (b.length < 3) throw new Error(`資料不足（${b.length} 筆）`);
  const rets = b.slice(1).map((x, i) => (x.c - b[i].c) / b[i].c * 100);
  const last = b.at(-1);
  const five = b.length > 5 ? (last.c - b.at(-6).c) / b.at(-6).c * 100 : null;
  return { last: last.c, chg1d: rets.at(-1), chg5d: five, date: isoDay(last.ts), ts: last.ts, rets, src: r.via };
}

// need：資料至少要到這一天才算夠新（null 代表不要求）。落後就換下一個來源，最後取日期最新的
export async function getQuote(sym, meta, need = null) {
  const sources = [
    ['Yahoo', () => fromYahoo(sym)],
    ['Stooq', () => fromStooq(sym, meta.stooq)],
    ['CNBC', () => fromCnbc(sym, meta.cnbc)],
  ];
  let best = null; const diag = [];
  for (const [id, get] of sources) {
    try {
      const d = shape(await get());
      if (!best || d.date > best.date) best = d;
      if (!need || d.date >= need) break;
      diag.push(`${id}：資料只到 ${d.date}，落後應有的 ${need}`);
    } catch (e) {
      (e.diag ?? [e.message]).forEach(x => diag.push(`${id} → ${x}`));
    }
  }
  if (!best) { const e = new Error(`${sym} 所有來源失敗`); e.diag = diag; throw e; }
  return { ...best, diag };
}

export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
  }));
  return out;
}
