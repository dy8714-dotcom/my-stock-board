// 株価データ更新スクリプト
// watchlist.json の銘柄について、Yahoo Finance から次の2種類を取得し、data/latest.json に保存します。
//   1) 当日の5分足
//   2) 日足1年分（ここから日足の直近約3か月と、週足約1年を作ります）
//
// 環境変数
//   MODE      : "test"（10銘柄だけ）または "full"（全銘柄）。初期値は full
//   DELAY_SEC : リクエストの間隔（秒）。初期値は 5
//
// 安全のための決まり
//   - HTTP 429（制限）または 403（拒否）を受けたら、その場で取得を中止します。
//   - 取れなかった銘柄は、前回のデータを残して「前回分」として表示します。
import { readFile, writeFile, mkdir, appendFile } from 'node:fs/promises';

const MODE = (process.env.MODE || 'full').toLowerCase();
const DELAY_MS = Math.round(Number(process.env.DELAY_SEC || 5) * 1000);
const JITTER_MS = DELAY_MS > 0 ? 1000 : 0;
const TIMEOUT_MS = 20000;
const RETRY_WAIT_MS = DELAY_MS > 0 ? 10000 : 0;
const HOSTS = ['query1.finance.yahoo.com', 'query2.finance.yahoo.com'];
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const TEST_SYMBOLS = ['^N225', '^TOPX', 'USDJPY=X', '^DJI', 'NVDA', '7203.T', '285A.T', '8035.T', '6857.T', '9984.T'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let hostIdx = 0;

async function getChart(symbol, interval, range) {
  const host = HOSTS[hostIdx++ % HOSTS.length];
  const url = `https://${host}/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}&includePrePost=false`;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: ctrl.signal });
      clearTimeout(timer);
      if (res.status === 429 || res.status === 403) return { status: res.status, stop: true };
      if (res.status >= 500 && attempt < 2) { await sleep(RETRY_WAIT_MS); continue; }
      let json = null;
      try { json = await res.json(); } catch (e) { /* JSONではない */ }
      return { status: res.status, json };
    } catch (e) {
      clearTimeout(timer);
      if (attempt < 2) { await sleep(RETRY_WAIT_MS); continue; }
      return { status: 0, error: String(e && e.message ? e.message : e) };
    }
  }
  return { status: 0, error: 'unknown' };
}

function parseChart(json) {
  const r = json && json.chart && json.chart.result && json.chart.result[0];
  if (!r) {
    const err = json && json.chart && json.chart.error;
    return { error: err ? (err.description || err.code || 'error') : 'データなし' };
  }
  const ts = r.timestamp || [];
  const q = r.indicators && r.indicators.quote && r.indicators.quote[0] ? r.indicators.quote[0] : {};
  const close = q.close || [];
  const t = [];
  const c = [];
  for (let i = 0; i < ts.length; i++) {
    const v = close[i];
    if (v !== null && v !== undefined && Number.isFinite(v)) { t.push(ts[i]); c.push(v); }
  }
  return { meta: r.meta || {}, t, c };
}

// 日足の配列から週足（週ごとの最後の終値）を作る。月曜始まり。
function toWeekly(t, c) {
  const weeks = new Map();
  for (let i = 0; i < t.length; i++) {
    const d = new Date(t[i] * 1000);
    const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
    weeks.set(monday.getTime(), c[i]);
  }
  return [...weeks.entries()].sort((a, b) => a[0] - b[0]).map((e) => e[1]);
}

const rnd = (arr) => arr.map((v) => Number(v.toPrecision(7)));

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch (e) { return fallback; }
}

const watch = await readJson('watchlist.json', null);
if (!watch || !Array.isArray(watch.items)) {
  console.error('watchlist.json を読めませんでした。');
  process.exit(1);
}
let symbols = watch.items.map((i) => i.symbol).filter(Boolean);
if (MODE === 'test') symbols = symbols.filter((s) => TEST_SYMBOLS.includes(s));

const prev = await readJson('data/latest.json', { items: {} });
const items = Object.assign({}, prev.items || {});
const log = [];
let stopped = null;
let okCount = 0;
let failCount = 0;
const startedAt = Date.now();

outer:
for (let i = 0; i < symbols.length; i++) {
  const sym = symbols[i];
  const dayRes = await getChart(sym, '5m', '1d');
  if (dayRes.stop) { stopped = `HTTP ${dayRes.status} を ${sym} で受信したため、取得を中止しました。`; break outer; }
  await sleep(DELAY_MS + Math.floor(Math.random() * JITTER_MS));
  const longRes = await getChart(sym, '1d', '1y');
  if (longRes.stop) { stopped = `HTTP ${longRes.status} を ${sym} で受信したため、取得を中止しました。`; break outer; }

  const day = dayRes.json ? parseChart(dayRes.json) : { error: dayRes.error || `HTTP ${dayRes.status}` };
  const lng = longRes.json ? parseChart(longRes.json) : { error: longRes.error || `HTTP ${longRes.status}` };
  const lc = lng.c || [];
  const dc = day.c || [];
  const meta = day.meta || lng.meta || {};

  let price = meta.regularMarketPrice;
  if (!Number.isFinite(price)) price = dc.length ? dc[dc.length - 1] : (lc.length ? lc[lc.length - 1] : null);
  let prevClose = meta.chartPreviousClose;
  if (!Number.isFinite(prevClose)) prevClose = Number.isFinite(meta.previousClose) ? meta.previousClose : (lc.length >= 2 ? lc[lc.length - 2] : null);

  if (price === null || price === undefined || !Number.isFinite(price)) {
    const reason = day.error || lng.error || '価格を取得できません';
    failCount++;
    const old = items[sym];
    items[sym] = old && old.price !== undefined ? Object.assign({}, old, { stale: true, err: reason }) : { ok: false, err: reason };
    log.push({ sym, ok: false, note: reason });
  } else {
    okCount++;
    items[sym] = {
      ok: true,
      stale: false,
      price: Number(price.toPrecision(8)),
      prev: Number.isFinite(prevClose) ? Number(prevClose.toPrecision(8)) : null,
      day: rnd(dc),
      daily: rnd(lc.slice(-62)),
      weekly: rnd(toWeekly(lng.t || [], lc).slice(-52)),
      asOf: dc.length ? new Date(day.t[day.t.length - 1] * 1000).toISOString() : null
    };
    log.push({ sym, ok: true, note: `5分足${dc.length}本 / 日足${Math.min(lc.length, 62)}本 / 週足${Math.min(toWeekly(lng.t || [], lc).length, 52)}本` });
  }
  console.log(`${i + 1}/${symbols.length} ${sym} ${log[log.length - 1].ok ? 'OK' : 'NG'} ${log[log.length - 1].note}`);
  if (i < symbols.length - 1) await sleep(DELAY_MS + Math.floor(Math.random() * JITTER_MS));
}

// 取得できなかった銘柄（中止で未実施のもの）に、前回データが残っていれば「前回分」の印を付ける
for (const s of symbols) {
  if (!log.some((l) => l.sym === s) && items[s]) items[s] = Object.assign({}, items[s], { stale: true });
}

const out = {
  version: 1,
  updatedAt: new Date().toISOString(),
  mode: MODE,
  stopped,
  okCount,
  failCount,
  items
};
await mkdir('data', { recursive: true });
await writeFile('data/latest.json', JSON.stringify(out));

const minutes = ((Date.now() - startedAt) / 60000).toFixed(1);
const lines = [];
lines.push('# 株価データ更新の結果');
lines.push('');
lines.push(`- モード: ${MODE}（対象 ${symbols.length} 銘柄）`);
lines.push(`- 成功: ${okCount} / 失敗: ${failCount} / 所要時間: 約${minutes}分`);
lines.push(`- リクエスト間隔: 約${DELAY_MS / 1000}秒`);
if (stopped) lines.push(`- **中止**: ${stopped}`);
lines.push('');
lines.push('| 銘柄 | 結果 | 内容 |');
lines.push('|---|---|---|');
for (const l of log) lines.push(`| ${l.sym} | ${l.ok ? 'OK' : '**失敗**'} | ${l.note} |`);
const md = lines.join('\n') + '\n';
console.log(md);
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, md);
