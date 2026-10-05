#!/usr/bin/env node
/**
 * 背景價格/訊號提醒 — 在 App 沒開啟時，定期檢查持股並透過 Telegram 通知。
 *
 * 持股資料來源：App 既有的 Google Sheet 雲端同步（同一組 Apps Script 網址/金鑰，
 * action=read），因為瀏覽器的 localStorage 在這裡（GitHub Actions）存取不到。
 *
 * 判斷邏輯盡量沿用 index.html / scoring_patch.js 既有、已經在正式站上運作的
 * 同一套抓價/計算方式（TWSE MIS、Yahoo Finance K 線、KD/MA），只是搬到 Node 執行。
 * 買點訊號偵測簡化為 4 條件（K<20、跌破MA20、當日跌幅≥3%、大盤跌1%)，
 * 不含 ETF 淨值折溢價（省略 BWIBBU_d 這個額外端點）——完整 5 條件版本只在
 * App 開啟時由 scoring_patch.js 計算。
 *
 * 需要的 GitHub Secrets：
 *   SHEET_URL, SHEET_SECRET       — 與 App 內「雲端同步」設定的 Apps Script 網址/金鑰相同
 *   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
 */
import fs from 'node:fs';

const STATE_FILE = new URL('./alerts-state.json', import.meta.url);

function isMarketOpen() {
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
  const day = now.getDay();
  if (day === 0 || day === 6) return false;
  const mins = now.getHours() * 60 + now.getMinutes();
  return mins >= 540 && mins <= 810; // 09:00–13:30
}

function todayTW() {
  return new Date().toLocaleDateString('zh-TW', { timeZone: 'Asia/Taipei' });
}

function normalizeCode(code) {
  if (code === undefined || code === null) return code;
  let s = String(code);
  if (/^\d+$/.test(s)) {
    if (s.length <= 2) s = s.padStart(4, '0');
    else if (s.length === 3) s = s.padStart(5, '0');
  }
  return s;
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch (e) { return {}; }
}
function saveState(state, today) {
  const pruned = {};
  for (const k in state) if (k.endsWith('_' + today)) pruned[k] = state[k];
  fs.writeFileSync(STATE_FILE, JSON.stringify(pruned, null, 2) + '\n');
}

async function fetchHoldings() {
  const url = `${process.env.SHEET_URL}?action=read&secret=${encodeURIComponent(process.env.SHEET_SECRET)}`;
  const r = await fetch(url);
  const j = await r.json();
  if (!j.ok) throw new Error('讀取 Sheet 失敗：' + (j.error || '未知錯誤'));
  return (j.holdings || []).map(h => ({ ...h, code: normalizeCode(h.code) }));
}

// 同 index.html 的 fetchMisChunked：單次 ex_ch 帶太多代碼 TWSE MIS 會漏回，分小批平行請求
async function fetchMisChunked(mkt, codes, chunkSize = 4) {
  const chunks = [];
  for (let i = 0; i < codes.length; i += chunkSize) chunks.push(codes.slice(i, i + chunkSize));
  const prices = {};
  await Promise.all(chunks.map(async chunk => {
    const exch = chunk.map(c => `${mkt}_${c}.tw`).join('|');
    try {
      const r = await fetch(`https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=${encodeURIComponent(exch)}&json=1&delay=0`);
      if (!r.ok) return;
      const j = await r.json();
      (j.msgArray || []).forEach(s => {
        const price = parseFloat(s.z) || parseFloat(s.y) || null;
        const prev = parseFloat(s.y) || null;
        if (price) prices[s.c] = { price, chgPct: prev ? (price - prev) / prev * 100 : null };
      });
    } catch (e) {}
  }));
  return prices;
}
async function fetchPrices(codes) {
  const prices = { ...(await fetchMisChunked('tse', codes)) };
  const missing = codes.filter(c => !prices[c]);
  if (missing.length) Object.assign(prices, await fetchMisChunked('otc', missing));
  return prices;
}
async function fetchTAIEX() {
  try {
    const r = await fetch('https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=tse_t00.tw&json=1&delay=0');
    const j = await r.json();
    const msg = j?.msgArray?.[0];
    if (!msg) return null;
    const cur = parseFloat(msg.z || msg.tv || 0), prev = parseFloat(msg.y || 0);
    if (!cur || !prev) return null;
    return { chgPct: Math.round((cur - prev) / prev * 100 * 100) / 100 };
  } catch (e) { return null; }
}

// 同 scoring_patch.js 的 _yahooOHLCV：抓近 3 個月日線
async function fetchHistory(code) {
  for (const suf of ['.TW', '.TWO']) {
    try {
      const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${code}${suf}?interval=1d&range=3mo`);
      if (!r.ok) continue;
      const j = await r.json();
      const result = j?.chart?.result?.[0];
      if (!result) continue;
      const ts = result.timestamp || [], q = result.indicators?.quote?.[0] || {};
      const candles = ts.map((t, i) => ({
        close: q.close?.[i] || 0, high: q.high?.[i] || 0, low: q.low?.[i] || 0,
      })).filter(c => c.close > 0);
      if (candles.length >= 5) return candles;
    } catch (e) {}
  }
  return [];
}
// 同 scoring_patch.js 的 _calcKD / _calcMA
function calcKD(candles, n = 9) {
  if (candles.length < n) return { k: 50, d: 50 };
  let k = 50, d = 50;
  for (let i = n - 1; i < candles.length; i++) {
    const slice = candles.slice(i - n + 1, i + 1);
    const lo = Math.min(...slice.map(c => c.low)), hi = Math.max(...slice.map(c => c.high));
    const rsv = hi === lo ? 50 : (candles[i].close - lo) / (hi - lo) * 100;
    k = k * 2 / 3 + rsv / 3; d = d * 2 / 3 + k / 3;
  }
  return { k: Math.round(k * 10) / 10, d: Math.round(d * 10) / 10 };
}
function calcMA(candles, n) {
  if (candles.length < n) return null;
  return candles.slice(-n).reduce((s, c) => s + c.close, 0) / n;
}

async function sendTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN, chatId = process.env.TELEGRAM_CHAT_ID;
  const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
  if (!r.ok) console.error('Telegram 發送失敗：', await r.text());
}

async function main() {
  // Secrets 還沒設定時直接結束（exit 0），避免排程每 10 分鐘就在 Actions 頁面噴一次失敗通知；
  // 等四個 secrets 都補齊後，這個檢查自然就不會擋下去了
  const required = ['SHEET_URL', 'SHEET_SECRET', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'];
  const missing = required.filter(k => !process.env[k]);
  if (missing.length) { console.log('尚未設定必要的 secrets，略過本次檢查：' + missing.join(', ')); return; }

  if (!isMarketOpen()) { console.log('非台股交易時段，略過'); return; }

  const holdings = await fetchHoldings();
  if (!holdings.length) { console.log('尚無持股'); return; }

  const codes = holdings.map(h => (h.code || '').replace('.TW', '').replace('.TWO', ''));
  const [prices, taiex] = await Promise.all([fetchPrices(codes), fetchTAIEX()]);

  const today = todayTW();
  const state = loadState();
  let changed = false;
  const messages = [];

  for (const h of holdings) {
    const code = (h.code || '').replace('.TW', '').replace('.TWO', '');
    const name = h.name || code;
    const p = prices[code];
    if (!p) continue;
    const curr = p.price;

    if (h.target && curr >= h.target) {
      const k = `${code}_target_${today}`;
      if (!state[k]) {
        state[k] = 1; changed = true;
        messages.push(`💰 ${code} ${name}\n現價 $${curr.toFixed(2)} 已達目標 $${h.target}`);
      }
    }
    if (h.stop && curr <= h.stop) {
      const k = `${code}_stop_${today}`;
      if (!state[k]) {
        state[k] = 1; changed = true;
        messages.push(`⚠️ ${code} ${name}\n現價 $${curr.toFixed(2)} 已跌破停損 $${h.stop}`);
      }
    }

    const candles = await fetchHistory(code);
    if (candles.length >= 20) {
      const kd = calcKD(candles);
      const ma20 = calcMA(candles, 20);
      const close = candles[candles.length - 1].close;
      let met = 0;
      if (kd.k < 20) met++;
      if (ma20 && close < ma20) met++;
      if (p.chgPct != null && p.chgPct <= -3) met++;
      if (taiex && taiex.chgPct <= -1) met++;
      if (met >= 3) {
        const k = `${code}_dip_${today}`;
        if (!state[k]) {
          state[k] = 1; changed = true;
          messages.push(`📉 ${code} ${name} 買點訊號（${met}/4 項成立）\n現價 $${curr.toFixed(2)}　K=${kd.k}　MA20=${ma20 ? ma20.toFixed(2) : '—'}`);
        }
      }
    }
    // 避免過快連續打 Yahoo Finance
    await new Promise(res => setTimeout(res, 300));
  }

  for (const msg of messages) await sendTelegram(msg);
  if (changed) saveState(state, today);
  console.log(`檢查 ${holdings.length} 檔持股，發送 ${messages.length} 則通知`);
}

main().catch(e => { console.error(e); process.exit(1); });
