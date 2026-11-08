#!/usr/bin/env node
/**
 * 風險預警監控（伺服器端）：蒐集華爾街、亞股、總體風險指標 → 依 config/risk-alerts.json 的參數評分
 * → 發佈 risk-state.json（給 App 首頁預警卡讀）→ 必要時用 Telegram 通知。
 *
 * 持股資料只用在 Telegram 訊息（私人頻道），不會寫進發佈的 JSON（資料分支是公開的）。
 *
 * 用法：node .github/scripts/risk-monitor.mjs [--dry-run] [--print]
 *   --dry-run  不寫檔、不發 Telegram；--print  印出完整 JSON
 * 環境變數：
 *   DATA_DIR（輸出資料夾，預設 .risk-data）、RISK_CONFIG（設定檔路徑）
 *   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID（沒設就不發通知）
 *   SHEET_URL, SHEET_SECRET（沒設就不在通知裡列出受影響的持股）
 *   測試用：NOW、YAHOO_BASE、YAHOO2_BASE、STOOQ_BASE、CNBC_BASE、TELEGRAM_API_BASE
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getQuote, mapLimit, expectedUSClose } from './lib/market-data.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');
const ARGS = new Set(process.argv.slice(2));
const CONFIG_PATH = process.env.RISK_CONFIG || path.join(ROOT, 'config/risk-alerts.json');
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, '.risk-data');
const NOW = process.env.NOW ? new Date(process.env.NOW) : new Date();
const TG_API = process.env.TELEGRAM_API_BASE || 'https://api.telegram.org';
const HOUR = 36e5;

const ACTIONS = {
  watch: '留意盤勢，暫緩加碼，確認每檔持股都有設定停損價。',
  warn: '考慮降低風險部位、收緊停損，避免追價與加碼。',
  danger: '優先控管風險：評估減碼或執行停損，避免融資加碼。',
};
const DISCLAIMER = '預警依規則與歷史相關性推估，不保證準確，僅供參考，非投資建議。';

// ── 小工具 ─────────────────────────────────────────────────
const weightedMean = items => {
  const ok = items.filter(i => i.v != null && Number.isFinite(i.v));
  if (!ok.length) return null;
  return ok.reduce((s, i) => s + i.v * i.w, 0) / ok.reduce((s, i) => s + i.w, 0);
};
const stdev = xs => { const m = xs.reduce((a, b) => a + b, 0) / xs.length; return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length); };
const fmtPct = x => (x == null ? '—' : `${x > 0 ? '+' : ''}${x.toFixed(2)}%`);
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const quoteLink = sym => `https://finance.yahoo.com/quote/${encodeURIComponent(sym)}`;
const taipeiParts = d => Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Taipei', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
}).formatToParts(d).map(x => [x.type, x.value]));
const taipeiStamp = d => { const p = taipeiParts(d); return `${+p.month}/${+p.day} ${String(Number(p.hour) % 24).padStart(2, '0')}:${p.minute}`; };

export function loadConfig(file = CONFIG_PATH) {
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const k of ['levels', 'symbols', 'rules', 'notify']) if (!cfg[k]) throw new Error(`設定檔缺少 ${k}`);
  const ids = new Set();
  for (const r of cfg.rules) {
    if (!r.id || ids.has(r.id)) throw new Error(`規則 id 重複或缺少：${r.id}`);
    ids.add(r.id);
    if (!['<=', '>='].includes(r.op)) throw new Error(`規則 ${r.id} 的 op 只能是 <= 或 >=`);
    if (!Array.isArray(r.tiers) || !r.tiers.length) throw new Error(`規則 ${r.id} 缺少 tiers`);
    if (r.symbol !== '_usWeighted' && !cfg.symbols[r.symbol]) throw new Error(`規則 ${r.id} 的 symbol 不在 symbols 裡：${r.symbol}`);
  }
  cfg.levels = [...cfg.levels].sort((a, b) => a.minScore - b.minScore);
  return cfg;
}

// ── 蒐集與評分 ──────────────────────────────────────────────
async function collect(cfg) {
  const needUS = expectedUSClose(NOW);
  const entries = Object.entries(cfg.symbols);
  const factors = {};
  await mapLimit(entries, 4, async ([sym, meta]) => {
    try {
      const q = await getQuote(sym, meta, meta.group === 'us' ? needUS : null);
      const ageDays = (NOW - Date.parse(q.date + 'T00:00:00Z')) / 864e5;
      const stale = meta.group === 'us' ? q.date < needUS : ageDays > 5;
      factors[sym] = { name: meta.name, group: meta.group, last: q.last, chg1d: q.chg1d, chg5d: q.chg5d, date: q.date, src: q.src, stale, rets: q.rets, diag: q.diag?.length ? q.diag : undefined };
    } catch (e) {
      factors[sym] = { name: meta.name, group: meta.group, error: e.message, diag: e.diag ?? [e.message] };
    }
  });
  return { factors, needUS };
}

const usable = f => f && !f.error && !f.stale && Number.isFinite(f.chg1d);

function evaluate(cfg, factors) {
  // 虛擬因子：美股加權（與首頁預測卡同一算法），至少要有一半權重的資料
  const w = cfg.usWeights ?? {};
  const wSum = Object.values(w).reduce((a, b) => a + b, 0);
  const got = Object.entries(w).filter(([s]) => usable(factors[s]));
  const cov = got.reduce((s, [, x]) => s + x, 0) / (wSum || 1);
  const usWeighted = cov >= 0.5 ? weightedMean(got.map(([s, x]) => ({ v: factors[s].chg1d, w: x }))) : null;
  factors._usWeighted = { name: '美股加權指標', group: 'virtual', chg1d: usWeighted, last: usWeighted, date: null, src: '計算', stale: usWeighted == null, coverage: cov };

  const triggered = [], skipped = [];
  for (const r of cfg.rules) {
    const f = factors[r.symbol];
    const v = r.symbol === '_usWeighted' ? f.chg1d : usable(f) ? (r.metric === 'last' ? f.last : r.metric === 'chg5d' ? f.chg5d : f.chg1d) : null;
    if (v == null || !Number.isFinite(v)) { skipped.push({ id: r.id, symbol: r.symbol, reason: f?.error ? '抓不到資料' : '資料過舊或不足' }); continue; }
    const hit = r.tiers.filter(t => (r.op === '<=' ? v <= t.value : v >= t.value)).sort((a, b) => b.points - a.points)[0];
    if (!hit) continue;
    triggered.push({
      id: r.id, label: r.label, symbol: r.symbol, name: f.name, metric: r.metric, op: r.op, value: +v.toFixed(2),
      tier: hit.value, points: hit.points, why: r.why, link: r.symbol === '_usWeighted' ? null : quoteLink(r.symbol),
    });
  }
  triggered.sort((a, b) => b.points - a.points);
  const score = Math.min(100, triggered.reduce((s, t) => s + t.points, 0));
  const lv = [...cfg.levels].reverse().find(l => score >= l.minScore);
  const level = lv ? { id: lv.id, label: lv.label, rank: cfg.levels.indexOf(lv) + 1 } : { id: 'normal', label: '正常', rank: 0 };

  const used = [...new Set(cfg.rules.map(r => r.symbol))];
  const okCount = used.filter(s => (s === '_usWeighted' ? usWeighted != null : usable(factors[s]))).length;
  const coverage = used.length ? okCount / used.length : 0;
  return { triggered, skipped, score, level, coverage, usWeighted };
}

function taiexOutlook(cfg, factors, usWeighted) {
  const asia = weightedMean((cfg.asiaSymbols ?? []).map(s => ({ v: usable(factors[s]) ? factors[s].chg1d : null, w: 1 })));
  const tw = cfg.taiexWeights ?? { us: 0.6, asia: 0.3 };
  const expected = weightedMean([{ v: usWeighted, w: tw.us }, { v: asia, w: tw.asia }]);
  if (expected == null) return null;
  const rets = (factors['^TWII']?.rets ?? []).slice(-10);
  const band = Math.max(0.5, rets.length > 2 ? stdev(rets) : 1);
  return { expected: +expected.toFixed(2), low: +(expected - band).toFixed(2), high: +(expected + band).toFixed(2), us: usWeighted == null ? null : +usWeighted.toFixed(2), asia: asia == null ? null : +asia.toFixed(2), basis: `美股 ${tw.us * 100}%／亞股 ${tw.asia * 100}%，區間取加權指數近 10 日波動` };
}

// ── 持股連動（只用在私人通知；App 端用同樣規則比對本機持股）──────────
export function matchExposure(h, rules) {
  const code = String(h.code ?? '').replace(/\.(TW|TWO)$/i, ''), name = h.name ?? '';
  const hits = rules.filter(r => !r.default && ((r.codes ?? []).includes(code) || (r.nameRegex && new RegExp(r.nameRegex, 'i').test(name))));
  return hits.length ? hits : rules.filter(r => r.default);
}
export function affectedHoldings(holdings, rules, triggered) {
  const out = [];
  for (const h of holdings) {
    const hits = matchExposure(h, rules), seen = new Map();
    for (const r of hits) for (const tok of r.factors ?? []) {
      const t = triggered.find(x => x.id === tok || x.symbol === tok);
      if (t) seen.set(t.id, t);
    }
    if (seen.size) out.push({ code: String(h.code).replace(/\.(TW|TWO)$/i, ''), name: h.name || '', groups: hits.map(r => r.label), factors: [...seen.values()] });
  }
  return out;
}

// ── 通知判斷（純函式，方便測試）────────────────────────────────
export function decideNotify({ rank, status, state, cfg, now }) {
  const n = cfg.notify, minRank = (cfg.levels.findIndex(l => l.id === n.minLevel) + 1) || 2;
  const next = { ...state };
  if (status !== 'ok') {
    const due = !state.lastDataIssueAt || now - state.lastDataIssueAt >= (n.dataIssueCooldownHours ?? 12) * HOUR;
    if (due) { next.lastDataIssueAt = +now; return { send: 'dataIssue', state: next }; }
    return { send: null, state: next };
  }
  next.lastOkAt = +now;
  let send = null;
  const lastRank = state.lastRank ?? 0;
  if (rank >= minRank) {
    if (rank > lastRank) send = 'alert';
    else if (rank === lastRank && (!state.lastSentAt || now - state.lastSentAt >= (n.cooldownHours ?? 6) * HOUR)) send = 'alert';
  } else if (n.sendRecovery && lastRank >= minRank) send = 'recovery';
  if (send) next.lastSentAt = +now;
  next.lastRank = rank;
  return { send, state: next };
}

export function isQuiet(cfg, now) {
  const q = cfg.notify.quiet; if (!q) return false;
  const p = taipeiParts(now), cur = (Number(p.hour) % 24) * 60 + Number(p.minute);
  const m = s => { const [h, mi] = s.split(':').map(Number); return h * 60 + mi; };
  const a = m(q.start), b = m(q.end);
  return a <= b ? cur >= a && cur < b : cur >= a || cur < b;
}

// ── Telegram ───────────────────────────────────────────────
function buildMessage(kind, snap, affected, cfg) {
  const L = [];
  if (kind === 'dataIssue') {
    L.push('⚠️ <b>預警資料來源異常</b>', `時間：${taipeiStamp(NOW)}（台北）`, `可用資料只有 ${(snap.coverage * 100).toFixed(0)}%，暫停評分以免誤報。`);
    const bad = Object.entries(snap.factors).filter(([, f]) => f.error).slice(0, 6).map(([s, f]) => `• ${esc(f.name)}：${esc((f.diag ?? [f.error])[0])}`);
    if (bad.length) L.push('', ...bad);
    return L.join('\n');
  }
  if (kind === 'recovery') {
    L.push('✅ <b>風險預警解除</b>', `時間：${taipeiStamp(NOW)}（台北）`, `風險分數回到 ${snap.score}/100（${snap.level.label}）。`);
    return L.join('\n');
  }
  L.push(`🚨 <b>風險預警｜${snap.level.label}（${snap.score}/100）</b>`, `時間：${taipeiStamp(NOW)}（台北）`, '');
  for (const t of snap.triggered.slice(0, 8)) {
    const val = t.metric === 'last' ? t.value.toFixed(1) : fmtPct(t.value);
    L.push(`• ${esc(t.name)} ${val}｜${esc(t.label)}${t.link ? ` <a href="${t.link}">行情</a>` : ''}`);
  }
  if (snap.taiex) L.push('', `預估台股開盤：${fmtPct(snap.taiex.expected)}（${fmtPct(snap.taiex.low)} ～ ${fmtPct(snap.taiex.high)}）`);
  if (affected.length) {
    L.push('', '可能受影響的持股：');
    for (const a of affected.slice(0, 8)) L.push(`• ${esc(a.name || a.code)}（${a.code}）：${a.factors.map(f => esc(f.name)).join('、')}`);
  }
  L.push('', `建議：${ACTIONS[snap.level.id] ?? ACTIONS.warn}`, `<i>${DISCLAIMER}</i>`);
  return L.join('\n');
}

async function sendTelegram(text, silent) {
  const token = process.env.TELEGRAM_BOT_TOKEN, chat = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chat) { console.log('（沒有設定 Telegram 金鑰，略過通知）'); return false; }
  const r = await fetch(`${TG_API}/bot${token}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chat, text, parse_mode: 'HTML', disable_web_page_preview: true, disable_notification: !!silent }),
  });
  if (!r.ok) { console.error('Telegram 發送失敗：', r.status, (await r.text()).slice(0, 200)); return false; }
  return true;
}

async function fetchHoldings() {
  if (!process.env.SHEET_URL || !process.env.SHEET_SECRET) return [];
  try {
    const r = await fetch(`${process.env.SHEET_URL}?action=read&secret=${encodeURIComponent(process.env.SHEET_SECRET)}`, { signal: AbortSignal.timeout(20000) });
    const j = await r.json();
    return j.ok ? (j.holdings ?? []) : [];
  } catch (e) { console.error('讀取持股失敗（通知將不列出持股）：', e.message); return []; }
}

const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };

// ── 主流程 ─────────────────────────────────────────────────
async function main() {
  const cfg = loadConfig();
  const { factors, needUS } = await collect(cfg);
  const ev = evaluate(cfg, factors);
  const status = ev.coverage >= (cfg.minCoverage ?? 0.6) ? 'ok' : 'degraded';
  const taiex = status === 'ok' ? taiexOutlook(cfg, factors, ev.usWeighted) : null;

  const stateFile = path.join(DATA_DIR, 'risk-notify-state.json');
  const prev = readJson(stateFile, {});
  const dec = decideNotify({ rank: ev.level.rank, status, state: prev, cfg, now: NOW });

  const publicFactors = Object.fromEntries(Object.entries(factors).map(([s, f]) => {
    const { rets, ...rest } = f; return [s, rest];
  }));
  const snap = {
    version: 1, generatedAt: NOW.toISOString(), asOf: NOW.toISOString(), status,
    expectedUSClose: needUS, score: ev.score, level: ev.level, thresholds: cfg.levels.map(l => ({ id: l.id, label: l.label, minScore: l.minScore })),
    triggered: ev.triggered, skipped: ev.skipped, coverage: +ev.coverage.toFixed(2), taiex,
    factors: publicFactors, exposure: cfg.exposure, lastOkAt: dec.state.lastOkAt ? new Date(dec.state.lastOkAt).toISOString() : null,
    staleAfterMinutes: cfg.staleAfterMinutes ?? 120,
    links: [
      { label: 'CNBC 市場', url: 'https://www.cnbc.com/markets/' },
      { label: 'Yahoo 財經', url: 'https://finance.yahoo.com/' },
      { label: '台灣證券交易所', url: 'https://www.twse.com.tw/zh/' },
    ],
    disclaimer: DISCLAIMER,
  };

  console.log(`風險分數 ${ev.score}/100（${ev.level.label}）｜資料涵蓋 ${(ev.coverage * 100).toFixed(0)}%｜狀態 ${status}｜觸發 ${ev.triggered.length} 項｜通知：${dec.send ?? '無'}`);
  for (const t of ev.triggered) console.log(`  • ${t.name} ${t.metric === 'last' ? t.value : fmtPct(t.value)}（${t.label}，+${t.points}）`);
  if (status === 'degraded') for (const [s, f] of Object.entries(factors)) if (f.error) console.log(`  ✗ ${s}：${(f.diag ?? [f.error]).join('；')}`);
  if (ARGS.has('--print')) console.log(JSON.stringify(snap, null, 2));
  if (ARGS.has('--dry-run')) { console.log('（--dry-run：不寫檔、不通知）'); return; }

  if (dec.send) {
    const holdings = dec.send === 'alert' ? await fetchHoldings() : [];
    const affected = affectedHoldings(holdings, cfg.exposure, ev.triggered);
    const silent = isQuiet(cfg, NOW) && ev.level.rank < ((cfg.levels.findIndex(l => l.id === cfg.notify.quiet?.silentBelow) + 1) || 99);
    const ok = await sendTelegram(buildMessage(dec.send, { ...snap, factors }, affected, cfg), silent);
    // 發送失敗就不要記成「已通知」，下一輪再試
    if (!ok && process.env.TELEGRAM_BOT_TOKEN) { dec.state.lastSentAt = prev.lastSentAt; if (dec.send === 'dataIssue') dec.state.lastDataIssueAt = prev.lastDataIssueAt; dec.state.lastRank = prev.lastRank ?? 0; }
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(path.join(DATA_DIR, 'risk-state.json'), JSON.stringify(snap, null, 2) + '\n');
  fs.writeFileSync(stateFile, JSON.stringify(dec.state, null, 2) + '\n');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch(e => { console.error('risk-monitor 失敗：', e); process.exitCode = 1; });
}
