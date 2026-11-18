// Swing Radar bulut taraması — scan.py'nin Kronos'suz TypeScript karşılığı (aynı kurallar, aynı çıktı şekli).
// Çağrı: swing_start() → pg_net POST {id, market} → bu fonksiyon → swing_put_market / swing_progress / swing_fail
import { createClient } from "jsr:@supabase/supabase-js@2";
import { FALLBACK } from "./universe.ts";

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

// Only pg_net calls from the owner's DB carry this key (Vault 'fn_key', read via service role).
let fnKey: string | null = null;
const authorized = async (req: Request) =>
  (fnKey ??= (await sb.rpc("fn_key")).data ?? null) !== null && req.headers.get("x-fn-key") === fnKey;
const UA = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36" };

// çıkış: ilk stop 2×ATR; haftalık kapanış haftalık HAHO (VWMA20) altındaysa çık; en çok 90 gün (bt_signals.py testi)
const HOLD = 90, MIN_DAYS = 5, ATR_K = 2, R_MULT = 2, MC_PATHS = 2000, MAX_SCORE = 9;
const BENCH: Record<string, string> = { bist: "XU100.IS", us: "^NDX" };
const MIN_TURNOVER: Record<string, number> = { bist: 50e6, us: 20e6 };
const CLOSE_UTC: Record<string, number> = { bist: 15.25, us: 21 };
const SETUPS: Record<string, string> = { breakout: "55g kırılım + hacim", pullback: "Trend içi geri çekilme", vcp: "Volatilite daralması (VCP)" };

type U = { ticker: string; symbol: string; name: string; sector: string | null };
type D = { t: number[]; o: number[]; h: number[]; l: number[]; c: number[]; v: number[]; live?: number; liveT?: number; partial?: boolean; filled?: number };

// ---------------------------------------------------------------- evren
async function universe(mkt: string): Promise<{ list: U[]; source: string }> {
  try {
    if (mkt === "bist") {
      const h = await (await fetch("https://www.kap.org.tr/tr/Endeksler", { headers: UA })).text();
      const end = h.indexOf('\\"name\\":\\"BIST 100\\"');
      const seg = h.slice(h.lastIndexOf('{\\"code\\"', end), end);
      const list = [...seg.matchAll(/stockCode\\":\\"([A-Z0-9]+)\\",\\"title\\":\\"([^\\]+)/g)]
        .map(m => ({ ticker: m[1] + ".IS", symbol: m[1], name: title(m[2]), sector: null }));
      if (list.length >= 90) return { list, source: "KAP" };
    } else {
      const j = await (await fetch("https://api.nasdaq.com/api/quote/list-type/nasdaq100", { headers: UA })).json();
      const list = j.data.data.rows.map((r: any) => ({ ticker: r.symbol.replace(".", "-"), symbol: r.symbol, name: r.companyName, sector: r.sector || null }));
      if (list.length >= 90) return { list, source: "Nasdaq" };
    }
  } catch { /* yedeğe düş */ }
  return { list: FALLBACK[mkt].map(([ticker, symbol, name, sector]) => ({ ticker, symbol, name, sector })), source: "yedek liste" };
}
const title = (s: string) => s.toLocaleLowerCase("tr-TR").replace(/(^|\s)\S/g, x => x.toLocaleUpperCase("tr-TR"));

// ---------------------------------------------------------------- veri (Yahoo günlük, düzeltilmiş)
async function chart(ticker: string, mkt: string): Promise<D | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch(`https://query${1 + (attempt % 2)}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=3y&interval=1d&events=div,split`, { headers: UA });
    if (r.status === 429 || r.status >= 500) { await new Promise(s => setTimeout(s, 800 * (attempt + 1))); continue; }
    if (!r.ok) return null;
    const res = (await r.json())?.chart?.result?.[0];
    if (!res?.timestamp) return null;
    const q = res.indicators.quote[0], adj = res.indicators.adjclose?.[0]?.adjclose ?? q.close;
    const off = res.meta.gmtoffset ?? 0;
    const d: D = { t: [], o: [], h: [], l: [], c: [], v: [] };
    const dayOf = (ts: number) => { const x = new Date((ts + off) * 1000); return Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), x.getUTCDate()) / 1000; };
    // Yahoo bazen BIST hisselerinde son günlerin günlük mumunu boş (null) gönderiyor; o günler 1 saatlik mumlardan yeniden kurulur
    const n0 = res.timestamp.length, holes = new Set<number>();
    for (let i = Math.max(0, n0 - 40); i < n0; i++) if (q.close[i] == null) holes.add(dayOf(res.timestamp[i]));
    const fill = holes.size ? await hourlyDays(ticker, holes) : new Map<number, number[]>();
    res.timestamp.forEach((ts: number, i: number) => {
      const c = q.close[i];
      if (c == null || q.open[i] == null || q.high[i] == null || q.low[i] == null) {
        const f = fill.get(dayOf(ts)); if (!f) return;
        d.t.push(dayOf(ts)); d.o.push(f[0]); d.h.push(f[1]); d.l.push(f[2]); d.c.push(f[3]); d.v.push(f[4]); d.filled = (d.filled ?? 0) + 1; return;
      }
      const k = adj[i] != null ? adj[i] / c : 1;
      const day = new Date((ts + off) * 1000); // borsa yerel tarihi → UTC gece yarısı
      d.t.push(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()) / 1000);
      d.o.push(q.open[i] * k); d.h.push(q.high[i] * k); d.l.push(q.low[i] * k); d.c.push(adj[i] ?? c); d.v.push(q.volume[i] ?? 0);
    });
    // seans kapanmadıysa bugünün yarım mumu atılır
    const now = new Date(), last = d.t.length - 1;
    d.live = res.meta.regularMarketPrice ?? d.c[last]; d.liveT = res.meta.regularMarketTime;
    if (last >= 0 && d.t[last] === Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) / 1000
        && now.getUTCHours() + now.getUTCMinutes() / 60 < CLOSE_UTC[mkt]) { for (const k of ["t","o","h","l","c","v"] as const) d[k].pop(); d.partial = true; }
    return d.c.length >= 260 ? d : null;
  }
  return null;
}

async function hourlyDays(ticker: string, days: Set<number>) {
  const out = new Map<number, number[]>();
  try {
    const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=3mo&interval=60m`, { headers: UA });
    const res = r.ok ? (await r.json())?.chart?.result?.[0] : null; if (!res?.timestamp) return out;
    const q = res.indicators.quote[0], off = res.meta.gmtoffset ?? 0;
    res.timestamp.forEach((ts: number, i: number) => {
      if (q.close[i] == null || q.open[i] == null) return;
      const x = new Date((ts + off) * 1000), k = Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), x.getUTCDate()) / 1000;
      if (!days.has(k)) return;
      const b = out.get(k);
      if (!b) out.set(k, [q.open[i], q.high[i], q.low[i], q.close[i], q.volume[i] ?? 0]);
      else { b[1] = Math.max(b[1], q.high[i]); b[2] = Math.min(b[2], q.low[i]); b[3] = q.close[i]; b[4] += q.volume[i] ?? 0; }
    });
  } catch { /* boş kalır */ }
  return out;
}

async function pool<T, R>(items: T[], n: number, fn: (x: T, i: number) => Promise<R>, tick?: (done: number) => void) {
  const out: R[] = new Array(items.length); let next = 0, done = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); done++; tick?.(done); }
  }));
  return out;
}

// ---------------------------------------------------------------- göstergeler (pandas karşılıkları)
const NA = NaN;
// döngüyle (dilim/spread yok) — edge fn CPU sınırı 2 sn
const ext = (a: number[], from: number, to: number, mx: boolean) => { let m = a[from]; for (let j = from + 1; j <= to; j++) m = mx ? (a[j] > m ? a[j] : m) : (a[j] < m ? a[j] : m); return m; };
const sma = (a: number[], n: number) => { const o: number[] = []; let s = 0; a.forEach((x, i) => { s += x; if (i >= n) s -= a[i - n]; o.push(i >= n - 1 ? s / n : NA); }); return o; };
const rmax = (a: number[], n: number) => a.map((_, i) => (i < n - 1 ? NA : ext(a, i - n + 1, i, true)));
const rmin = (a: number[], n: number) => a.map((_, i) => (i < n - 1 ? NA : ext(a, i - n + 1, i, false)));
const shift = (a: number[], k = 1) => a.map((_, i) => (i - k >= 0 ? a[i - k] : NA));
function ewmAdjust(a: number[], alpha: number) { // pandas ewm(alpha, adjust=True), baştaki NaN atlanır
  let num = 0, den = 0; return a.map(x => { if (Number.isNaN(x)) return num ? num / den : NA; num = x + (1 - alpha) * num; den = 1 + (1 - alpha) * den; return num / den; });
}
function indicators(d: D) {
  const { h, l, c, v } = d, n = c.length;
  const sma20 = sma(c, 20), sma50 = sma(c, 50), sma150 = sma(c, 150), sma200 = sma(c, 200);
  const tr = c.map((_, i) => (i ? Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1])) : h[i] - l[i]));
  const atr = sma(tr, 20);
  const diff = c.map((x, i) => (i ? x - c[i - 1] : NA));
  const up = ewmAdjust(diff.map(x => (Number.isNaN(x) ? NA : Math.max(x, 0))), 1 / 14), dn = ewmAdjust(diff.map(x => (Number.isNaN(x) ? NA : Math.max(-x, 0))), 1 / 14);
  const rsi = up.map((u, i) => 100 - 100 / (1 + u / dn[i]));
  const hi55 = shift(rmax(h, 55)), hi252 = rmax(h, 252), lo252 = rmin(l, 252), hi45 = rmax(h, 45);
  const vol50 = sma(v, 50), swlo20 = rmin(l, 20), sma200s = shift(sma200, 21);
  const rng = (a: number, b: number) => c.map((x, i) => (i - b + 1 < 0 ? NA : (ext(h, i - b + 1, i - a, true) - ext(l, i - b + 1, i - a, false)) / x));
  const r0 = rng(0, 10), r1 = rng(10, 25), r2 = rng(25, 45);
  const tt: boolean[] = [], breakout: boolean[] = [], pullback: boolean[] = [], vcp: boolean[] = [];
  for (let i = 0; i < n; i++) {
    const T = c[i] > sma50[i] && sma50[i] > sma150[i] && sma150[i] > sma200[i] && c[i] > sma150[i] && sma200[i] > sma200s[i] && c[i] >= 1.25 * lo252[i] && c[i] >= 0.75 * hi252[i];
    tt.push(T);
    breakout.push(T && c[i] > hi55[i] && v[i] > 1.5 * vol50[i]);
    const near = Math.abs(c[i] - sma20[i]) / c[i] < 0.02 || Math.abs(c[i] - sma50[i]) / c[i] < 0.02;
    pullback.push(T && near && rsi[i] >= 40 && rsi[i] <= 55 && rsi[i] > rsi[i - 1]);
    vcp.push(T && r0[i] < r1[i] && r1[i] < r2[i] && r0[i] < 0.10 && c[i] >= 0.9 * hi45[i]);
  }
  return { atr, rsi, swlo20, tt, breakout, pullback, vcp } as Record<string, any>;
}

// ---------------------------------------------------------------- rotasyon (RRG benzeri): x = RS-oran, y = RS-momentum, 100 = endeksle aynı
function rrg(d: D, b: D): number[][] | null {
  const bi = new Map(b.t.map((t, i) => [t, i]));
  const ratio: number[] = []; let prev = NaN;
  for (let i = 0; i < d.c.length; i++) { const j = bi.get(d.t[i]); if (j != null) prev = d.c[i] / b.c[j]; ratio.push(prev); }
  const N = 50, M = 10, n = ratio.length;
  const rsr = (i: number) => { let s = 0; for (let k = i - N + 1; k <= i; k++) s += ratio[k]; return (100 * ratio[i]) / (s / N); };
  const out: number[][] = [];
  for (let w = 5; w >= 0; w--) {
    const i = n - 1 - 5 * w;
    if (i - M - N < 0) return null;
    const x = rsr(i), y = (100 * x) / rsr(i - M);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    out.push([+x.toFixed(2), +y.toFixed(2)]);
  }
  return out;
}

// ---------------------------------------------------------------- plan + zaman makinesi
type WK = { exit: boolean[]; wc: number[]; wv: number[]; vw: number[]; lastDone: boolean };
function weeklyHaho(d: D): WK {
  // hafta anahtarı = o haftanın cuması (W-FRI); günlük t = yerel tarih UTC gece yarısı
  const key = d.t.map(t => { const wd = new Date(t * 1000).getUTCDay(); return t + ((5 - wd + 7) % 7) * 86400; });
  const wc: number[] = [], wv: number[] = [], wi: number[] = [];
  key.forEach((k, i) => { if (i === 0 || k !== key[i - 1]) { wc.push(d.c[i]); wv.push(d.v[i]); } else { wc[wc.length - 1] = d.c[i]; wv[wv.length - 1] += d.v[i]; } wi.push(wc.length - 1); });
  const vw = wc.map((_, k) => { if (k < 19) return NaN; let a = 0, b = 0; for (let j = k - 19; j <= k; j++) { a += wc[j] * wv[j]; b += wv[j]; } return b > 0 ? a / b : NaN; });
  const n = d.t.length, lastDone = new Date(d.t[n - 1] * 1000).getUTCDay() === 5;
  const exit = key.map((k, i) => { const end = i < n - 1 ? key[i + 1] !== k : lastDone; return end && d.c[i] < vw[wi[i]]; });
  return { exit, wc, wv, vw, lastDone };
}
function plan(close: number, atr: number, swlo: number, haho: number | null = null) {
  let stop = swlo < close ? Math.max(close - ATR_K * atr, swlo * 0.995) : close - ATR_K * atr;
  stop = Math.min(stop, close - atr);
  const risk = close - stop;
  return { entry: close, stop, target: close + R_MULT * risk, riskPct: (risk / close) * 100, exitRule: "weeklyHaho", haho: haho != null && Number.isFinite(haho) ? haho : null, maxDays: HOLD };
}
function walk(d: D, ex: boolean[], i: number, stop: number): [string | null, number, number] {
  for (let j = i + 1; j < Math.min(i + 1 + HOLD, d.c.length); j++) {
    if (d.l[j] <= stop) return ["stop", stop - d.c[i], j - i];
    if (ex[j] && j - i > MIN_DAYS) return ["haho", d.c[j] - d.c[i], j - i];
  }
  if (i + HOLD >= d.c.length) return [null, 0, 0];
  return ["time", d.c[i + HOLD] - d.c[i], HOLD];
}
function history(d: D, x: Record<string, any>, setup: string, ex: boolean[]) {
  const res = { stop: 0, haho: 0, time: 0 } as Record<string, number>, R: number[] = [], days: number[] = [];
  let last = -99;
  (x[setup] as boolean[]).forEach((f, i) => {
    if (!f || i - last < 5 || Number.isNaN(x.atr[i])) return;
    last = i;
    const p = plan(d.c[i], x.atr[i], x.swlo20[i]);
    const [out, pnl, dd] = walk(d, ex, i, p.stop);
    if (out) { res[out]++; R.push(pnl / (d.c[i] - p.stop)); days.push(dd); }
  });
  const n = R.length, mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
  return { n, stop: res.stop, haho: res.haho, time: res.time, win: n ? R.filter(r => r > 0).length / n : null, avgR: n ? mean(R) : null, avgDays: n ? mean(days) : null };
}
function mulberry32(a: number) { return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
// Monte Carlo (çıkış kuralıyla): son 250 günün mumları 10 günlük bloklarla (trendi korur) 90 günlük yollara dizilir;
// her 5. gün hafta kapanışı: haftalık HAHO = son 19 gerçek hafta + simüle haftalar.
function monteCarlo(d: D, p: ReturnType<typeof plan>, wk: WK, seed = 42) {
  const rnd = mulberry32(seed), n = d.c.length, s = n - 250, B = 10;
  const rl: number[] = [], rc: number[] = [], rv: number[] = [];
  for (let i = s; i < n; i++) { const pc = d.c[i - 1]; rl.push(d.l[i] / pc); rc.push(d.c[i] / pc); rv.push(d.v[i]); }
  const k1 = wk.lastDone ? wk.wc.length : wk.wc.length - 1, hc = wk.wc.slice(k1 - 19, k1), hv = wk.wv.slice(k1 - 19, k1);
  const risk = p.entry - p.stop;
  let nS = 0, nH = 0, nT = 0, nW = 0, sumR = 0, sumP = 0; const Rs: number[] = [], Ds: number[] = [];
  for (let k = 0; k < MC_PATHS; k++) {
    const cw = hc.slice(), vw = hv.slice(); let prev = p.entry, wkV = 0, start = 0, out = "", px = 0, day = HOLD;
    for (let j = 0; j < HOLD; j++) {
      if (j % B === 0) start = Math.floor(rnd() * (rl.length - B + 1));
      const r = start + (j % B);
      if (prev * rl[r] <= p.stop) { out = "stop"; px = p.stop; day = j + 1; break; }
      prev *= rc[r]; wkV += rv[r];
      if (j % 5 === 4) {
        cw.push(prev); vw.push(wkV); wkV = 0;
        if (j + 1 > MIN_DAYS) {
          let a = 0, b = 0; const m = cw.length;
          for (let q = m - 20; q < m; q++) { a += cw[q] * vw[q]; b += vw[q]; }
          if (b > 0 && prev < a / b) { out = "haho"; px = prev; day = j + 1; break; }
        }
      }
    }
    if (!out) { out = "time"; px = prev; }
    const R = (px - p.entry) / risk;
    if (out === "stop") nS++; else if (out === "haho") nH++; else nT++;
    if (R > 0) nW++; sumR += R; sumP += px / p.entry - 1; Rs.push(R); Ds.push(day);
  }
  const med = (a: number[]) => { const b = a.slice().sort((x, y) => x - y); return b[Math.floor(b.length / 2)]; };
  const N = MC_PATHS;
  return { stop: nS / N, haho: nH / N, time: nT / N, win: nW / N, meanR: sumR / N, medR: med(Rs), meanPct: sumP / N, medDays: med(Ds), seed, paths: N, maxDays: HOLD };
}
// portföy: kullanıcının kendi stop / ilk hedefiyle (40 gün) — sabit hedefli zaman makinesi
function monteCarloFixed(d: D, p: { entry: number; stop: number; target: number }, seed = 42) {
  const rnd = mulberry32(seed), n = d.c.length, s = n - 250, H40 = 40, N = 4000;
  const rh: number[] = [], rl: number[] = [], rc: number[] = [];
  for (let i = s; i < n; i++) { const pc = d.c[i - 1]; rh.push(d.h[i] / pc); rl.push(d.l[i] / pc); rc.push(d.c[i] / pc); }
  let tgt = 0, stp = 0;
  for (let k = 0; k < N; k++) {
    let prev = p.entry;
    for (let j = 0; j < H40; j++) {
      const r = Math.floor(rnd() * rc.length);
      if (prev * rl[r] <= p.stop) { stp++; break; }
      if (prev * rh[r] >= p.target) { tgt++; break; }
      prev *= rc[r];
    }
  }
  return { target: tgt / N, stop: stp / N, neither: 1 - (tgt + stp) / N, seed, paths: N };
}

// ---------------------------------------------------------------- BIST bilanço filtresi (bt_improve.py: isabet %37→%39, işlem başı +13,0%→+17,8%, t 2,7)
// İş Yatırım (KAP mali tabloları): yıl başından kümülatif ana ortaklık net kârı. "İyi" = son dönem net kâr > 0, yıllık büyüme > 0
// ve bir önceki çeyreğin yıllık büyümesinden yüksek (hızlanma).
type Ern = { good: boolean; period: string; g: number; gp: number | null };
const ISY = "https://www.isyatirim.com.tr/_layouts/15/IsYatirim.Website/Common/Data.aspx/MaliTablo";
async function isyNet(code: string): Promise<Ern | null> {
  const now = new Date(), ps: [number, number][] = [];
  let y = now.getUTCFullYear(), m = Math.floor(now.getUTCMonth() / 3) * 3; if (m === 0) { y--; m = 12; }
  for (let i = 0; i < 8; i++) { ps.push([y, m]); m -= 3; if (m === 0) { y--; m = 12; } }
  for (const grp of ["XI_29", "UFRS_K"]) {
    const q: Record<string, number> = {};
    // İş Yatırım dolu cevabı ~10 sn bekletiyor (13 Kas 2026'dan beri) → iki dönem isteği paralel
    await Promise.all([0, 4].map(async i => {
      try {
        const part = ps.slice(i, i + 4), qs = part.map(([yy, mm], k) => `year${k + 1}=${yy}&period${k + 1}=${mm}`).join("&");
        const r = await fetch(`${ISY}?companyCode=${code}&exchange=TRY&financialGroup=${grp}&${qs}`, { headers: UA, signal: AbortSignal.timeout(15000) });
        if (!r.ok) return;
        const j = await r.json(); if (!j.ok || !j.value?.length) return;
        const rows = Object.fromEntries(j.value.map((x: any) => [x.itemCode, x]));
        const row = rows[grp !== "XI_29" && rows["3ZA"] ? "3ZA" : rows["3Z"] ? "3Z" : "3L"]; if (!row) return;
        part.forEach(([yy, mm], k) => { const v = row[`value${k + 1}`]; if (v != null && v !== "") q[`${yy}-${mm}`] = +v; });
      } catch { /* boş */ }
    }));
    const key = ps.map(([yy, mm]) => `${yy}-${mm}`).find(k => q[k] != null);
    if (!key) continue;
    const [ky, km] = key.split("-").map(Number), prev = q[`${ky - 1}-${km}`];
    if (prev == null || prev === 0) return null;
    const g = (q[key] - prev) / Math.abs(prev);
    const pm = km > 3 ? km - 3 : 12, py = km > 3 ? ky : ky - 1, a = q[`${py}-${pm}`], b = q[`${py - 1}-${pm}`];
    const gp = a != null && b != null && b !== 0 ? (a - b) / Math.abs(b) : null;
    return { good: q[key] > 0 && g > 0 && (gp == null || g > gp), period: `${km}A${String(ky).slice(2)}`, g, gp };
  }
  return null;
}

// ---------------------------------------------------------------- bilanço tarihi yakınsa ALINIR verilmez (kullanıcı kuralı; risk kuralı, geriye test edilmedi)
// Yahoo v7 quote (crumb gerekir): gelecek bilanço tarihi. BIST'te Yahoo boşsa: açıklanmamış dönemin SPK yasal son tarihi
// (çeyrek sonu + 3A 40, 6A 50, 9A 40, 12A 70 gün; konsolide).
const EARN_DAYS = 14;
type Earn = { date: string; days: number; est: boolean; src: string };
let yAuthP: Promise<{ cookie: string; crumb: string }> | null = null;
const yAuth = () => (yAuthP ??= (async () => {
  const r0 = await fetch("https://fc.yahoo.com", { headers: UA, redirect: "manual" });
  const cookie = (r0.headers.get("set-cookie") ?? "").split(";")[0];
  const crumb = await (await fetch("https://query2.finance.yahoo.com/v1/test/getcrumb", { headers: { ...UA, cookie } })).text();
  return { cookie, crumb };
})());
const dayDiff = (ms: number) => Math.floor((ms - Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate())) / 864e5);
async function earnDates(tickers: string[]): Promise<Map<string, Earn>> {
  const out = new Map<string, Earn>();
  try {
    const { cookie, crumb } = await yAuth();
    for (let i = 0; i < tickers.length; i += 50) {
      const u = `https://query2.finance.yahoo.com/v7/finance/quote?symbols=${tickers.slice(i, i + 50).map(encodeURIComponent).join(",")}&fields=earningsTimestamp,earningsTimestampStart,isEarningsDateEstimate&crumb=${encodeURIComponent(crumb)}`;
      const j = await (await fetch(u, { headers: { ...UA, cookie }, signal: AbortSignal.timeout(15000) })).json();
      for (const r of j?.quoteResponse?.result ?? []) {
        const ts = [r.earningsTimestamp, r.earningsTimestampStart].filter((x: number) => x && dayDiff(x * 1000) >= 0).sort((a: number, b: number) => a - b)[0];
        if (ts) out.set(r.symbol, { date: new Date(ts * 1000).toISOString().slice(0, 10), days: dayDiff(ts * 1000), est: !!r.isEarningsDateEstimate, src: "Yahoo" });
      }
    }
  } catch { /* tarih yoksa kural uygulanmaz */ }
  return out;
}
const SPK_DAYS: Record<number, number> = { 3: 40, 6: 50, 9: 40, 12: 70 };
function bistDeadline(e: Ern | null): Earn | null {
  if (!e) return null;
  const [m, y] = e.period.split("A").map(Number);
  const nm = m === 12 ? 3 : m + 3, ny = 2000 + (m === 12 ? y + 1 : y);
  const end = Date.UTC(ny, nm, 0), dl = end + SPK_DAYS[nm] * 864e5; // nm. ayın son günü
  if (dayDiff(end) >= 0) return null; // sonraki dönem henüz bitmedi
  if (dayDiff(dl) < 0) return null; // son tarih geçmiş: farklı mali yıl ya da eksik veri, tahmin yapılmaz
  return { date: new Date(dl).toISOString().slice(0, 10), days: dayDiff(dl), est: true, src: "SPK son tarih" };
}

// ---------------------------------------------------------------- puan (scan.py ile aynı; Kronos yok)
function score(s: any): [number, string, string[]] {
  let pts = 0; const why: string[] = [];
  const add = (v: number, t: string) => { pts += v; why.push((v > 0 ? "+" : "") + v + " " + t); };
  const p0 = (x: number) => Math.round(x * 100);
  if (s.tt) add(2, "Stage 2 trend (Trend Template 7/7)");
  if (s.rs >= 80) add(2, `Göreli güç %${Math.round(s.rs)} dilimde`); else if (s.rs >= 60) add(1, `Göreli güç %${Math.round(s.rs)} dilimde`);
  if (s.setups.length) add(2, "Kurulum: " + s.setups.map((k: string) => SETUPS[k]).join(", "));
  const h = s.hist;
  if (h && h.n >= 5) {
    if (h.avgR >= 0.3) add(1, `Geçmiş: ${h.n} sinyal, ortalama +${h.avgR.toFixed(2)}R, kârlı %${p0(h.win)}`);
    else if (h.avgR != null && h.avgR < 0) add(-1, `Geçmiş: ${h.n} sinyal, ortalama ${h.avgR.toFixed(2)}R (negatif)`);
  }
  const e: Ern | null = s.ern ?? null, pc = (x: number) => (x >= 0 ? "+" : "") + Math.round(x * 100) + "%";
  if (e?.good) add(1, `Bilanço iyi: ${e.period} net kâr yıllık ${pc(e.g)}${e.gp != null ? `, hızlanıyor (önceki ${pc(e.gp)})` : ""}`);
  else if (e) why.push(`0 Bilanço zayıf: ${e.period} net kâr yıllık ${pc(e.g)}${e.gp != null ? ` (önceki ${pc(e.gp)})` : ""}; ALINIR verilmez`);
  const en: Earn | null = s.earn ?? null, near = !!en && en.days <= EARN_DAYS;
  if (near) why.push(`! Bilanço ${en!.days === 0 ? "bugün" : en!.days + " gün içinde"} (${en!.src === "Yahoo" ? "" : "en geç "}${en!.date.slice(8)}.${en!.date.slice(5, 7)}${en!.est && en!.src === "Yahoo" ? ", tahmini" : ""}): sürpriz riski, ALINIR verilmez; açıklanmasını bekle ya da küçük pozisyon`);
  if (s.mc.meanR >= 0.2 && s.mc.win >= 0.45) add(1, `Monte Carlo: ortalama +${s.mc.meanR.toFixed(2)}R, kârlı kapanış %${p0(s.mc.win)}, ilk stop %${p0(s.mc.stop)}`);
  if (s.riskPct > 12) add(-1, `Stop çok uzak (%${s.riskPct.toFixed(1)})`);
  if (!s.liquid) add(-2, "Düşük işlem hacmi");
  if (!s.regimeOk) add(-1, "Endeks 200 günlük ortalamanın altında");
  const neg = why.some(w => w.startsWith("-"));
  const verdict = pts >= 6 && !neg && s.setups.length && !(e && !e.good) && !near ? "ALINIR" : pts <= 2 ? "ALINMAZ" : "KARARSIZ";
  return [Math.max(0, Math.min(MAX_SCORE, pts)), verdict, why];
}

function regime(b: D) {
  const c = b.c, n = c.length, s50 = sma(c, 50), s200 = sma(c, 200);
  return { ok: c[n - 1] > s200[n - 1] && s50[n - 1] > s50[n - 22], close: c[n - 1], sma50: s50[n - 1], sma200: s200[n - 1],
    chg20: c[n - 1] / c[n - 21] - 1, spark: c.slice(-120).map(x => +x.toFixed(2)) };
}

async function runMarket(id: number, mkt: string) {
  const prog = (info: Record<string, unknown>) => sb.rpc("swing_progress", { scan_id: id, mkt, info });
  await prog({ phase: "universe" });
  const { list, source } = await universe(mkt);
  await prog({ phase: "data", done: 0, total: list.length + 1, source });
  let lastTick = 0;
  const all = await pool([...list.map(u => u.ticker), BENCH[mkt]], 8, t => chart(t, mkt), done => {
    if (done - lastTick >= 10) { lastTick = done; prog({ phase: "data", done, total: list.length + 1, source }); }
  });
  const bench = all.pop();
  if (!bench) throw new Error(`${BENCH[mkt]} endeks verisi alınamadı`);
  const reg = regime(bench);
  const data = new Map<string, D>(), meta = new Map<string, U>();
  list.forEach((u, i) => { if (all[i]) { data.set(u.ticker, all[i]!); meta.set(u.ticker, u); } });
  await prog({ phase: "rules", done: data.size, total: list.length + 1, source });
  const ern = new Map<string, Ern | null>();
  // ponytail: 60 sn bütçe; aşılırsa kalan hisselerde bilanço filtresi boş (ALINIR engellenmez). Kalıcı çözüm: isyNet sonucunu tabloda önbelleklemek.
  if (mkt === "bist") { const keys = [...data.keys()], until = Date.now() + 60000;
    const got = await pool(keys, 25, t => Date.now() > until ? Promise.resolve(null) : Promise.race([isyNet(meta.get(t)!.symbol).catch(() => null), new Promise<null>(r => setTimeout(() => r(null), until - Date.now()))]));
    keys.forEach((t, i) => ern.set(t, got[i])); }
  const ed = await earnDates([...data.keys()]);
  const earn = new Map([...data.keys()].map(t => [t, ed.get(t) ?? (mkt === "bist" ? bistDeadline(ern.get(t) ?? null) : null)]));
  const perf = [...data].map(([t, d]) => { const c = d.c, n = c.length; return [t, 0.6 * (c[n - 1] / c[n - 64] - 1) + 0.4 * (c[n - 1] / c[n - 127] - 1)] as [string, number]; });
  const sorted = perf.map(x => x[1]).sort((a, b) => a - b);
  const rs = new Map(perf.map(([t, v]) => { const lo = sorted.indexOf(v), hi = sorted.lastIndexOf(v); return [t, ((lo + hi) / 2 + 1) / sorted.length * 100]; }));
  const rows: any[] = [];
  for (const [t, d] of data) {
    const x = indicators(d), n = d.c.length - 1, c = d.c[n];
    // VCP Nasdaq'ta kurulum sayılmaz: 6 yıllık testte TT+VCP −1,7%/40g (t −3,5); çıkarınca isabet %43 → %45 (bt_vcp.py). BIST'te VCP olumlu, kalır.
    const setups = Object.keys(SETUPS).filter(k => x[k][n] && !(mkt === "us" && k === "vcp"));
    const wk = weeklyHaho(d), p = plan(c, x.atr[n], x.swlo20[n], wk.vw[wk.vw.length - 1]);
    const primary = setups[0] ?? "pullback";
    let turnover = 0; for (let i = n - 19; i <= n; i++) turnover += d.c[i] * d.v[i];
    const u = meta.get(t)!;
    const s: any = { ticker: t, symbol: u.symbol, name: u.name, sector: u.sector, market: mkt, close: c, chg1d: c / d.c[n - 1] - 1, chg20: c / d.c[n - 20] - 1,
      rs: rs.get(t)!, rsi: x.rsi[n], tt: x.tt[n], setups, plan: p, riskPct: p.riskPct, atr: x.atr[n], liquid: turnover / 20 >= MIN_TURNOVER[mkt],
      regimeOk: reg.ok, ern: ern.get(t) ?? null, earn: earn.get(t) ?? null, hist: history(d, x, primary, wk.exit), histSetup: primary, mc: monteCarlo(d, p, wk), kronos: null, rrg: rrg(d, bench), spark: d.c.slice(-60).map(v => +v.toFixed(4)),
      // seans içi anlık fiyat (Yahoo, BIST'te ~15 dk gecikmeli); kurallar kapanmış mumla çalışır, bu yalnızca gösterim içindir
      live: d.partial ? d.live : null, liveAt: d.partial && d.liveT ? new Date(d.liveT * 1000).toISOString() : null, liveChg: d.partial && d.live ? d.live / c - 1 : null };
    [s.score, s.verdict, s.why] = score(s);
    rows.push(s);
  }
  rows.sort((a, b) => b.score - a.score || b.rs - a.rs);
  for (const r of rows.slice(0, 30)) {
    const d = data.get(r.ticker)!, k = d.c.length - 150;
    r.bars = d.c.slice(k).map((_, j) => [d.t[k + j], +d.o[k + j].toFixed(4), +d.h[k + j].toFixed(4), +d.l[k + j].toFixed(4), +d.c[k + j].toFixed(4), Math.round(d.v[k + j])]);
  }
  const asOf = new Date(bench.t[bench.t.length - 1] * 1000).toISOString().slice(0, 10);
  const market = { market: mkt, bench: BENCH[mkt], regime: reg, count: rows.length, stocks: rows, asOf, source, missing: list.length - data.size };
  const metaOut = { createdAt: new Date().toISOString(), params: { hold: HOLD, atrK: ATR_K, r: R_MULT, kronos: false, maxScore: MAX_SCORE, mcPaths: MC_PATHS, source: "cloud" } };
  const { error } = await sb.rpc("swing_put_market", { scan_id: id, market, meta: metaOut });
  if (error) throw new Error(error.message);
}

// ---------------------------------------------------------------- portföy: canlı fiyat + pozisyon analizi (stop/hedef kullanıcının planı)
async function portfolio() {
  const [{ data: pos }, { data: ord }, { data: last }] = await Promise.all([
    sb.from("swing_positions").select("*"), sb.from("swing_orders").select("*").eq("status", "bekliyor"),
    sb.from("swing_scans").select("result").eq("status", "done").order("id", { ascending: false }).limit(1),
  ]);
  const tickers = [...new Set([...(pos ?? []).filter(p => p.kind === "stock").map(p => p.ticker), ...(ord ?? []).map(o => o.ticker).filter(t => /\.IS$|^[A-Z]{1,5}$/.test(t) && t !== "PPF"), "XU100.IS", "USDTRY=X",
    ...(pos ?? []).map(p => p.proxy).filter(Boolean), ...((pos ?? []).some(p => p.kind === "stock" && !p.ticker.endsWith(".IS")) ? ["^NDX"] : [])])];
  const got = await pool(tickers, 6, t => chart(t, t.endsWith(".IS") ? "bist" : "us").catch(() => null));
  const D = new Map(tickers.map((t, i) => [t, got[i]]));
  const quotes: Record<string, unknown> = {};
  for (const [t, d] of D) {
    if (!d) continue;
    const n = d.c.length - 1, x = indicators(d), live = d.live ?? d.c[n];
    const prev = d.partial ? d.c[n] : d.c[n - 1];
    const s50 = sma(d.c, 50)[n], s200 = sma(d.c, 200)[n];
    quotes[t] = { last: live, prev, chg1d: live / prev - 1, at: d.liveT ? new Date(d.liveT * 1000).toISOString() : null, partial: !!d.partial,
      tt: x.tt[n], rsi: x.rsi[n], atr: x.atr[n], sma50: s50, sma200: s200, setups: Object.keys(SETUPS).filter(k => x[k][n]),
      bars: d.c.slice(-120).map((_, j, a) => { const k = d.c.length - a.length + j; return [d.t[k], +d.o[k].toFixed(4), +d.h[k].toFixed(4), +d.l[k].toFixed(4), +d.c[k].toFixed(4), Math.round(d.v[k])]; }) };
  }
  // kullanıcının stop/hedefiyle zaman makinesi: bugünden 40 gün içinde önce hangisi?
  const mc: Record<string, unknown> = {};
  for (const p of pos ?? []) {
    const d = D.get(p.ticker); if (!d || p.kind !== "stock" || !p.stop || !p.target1) continue;
    const live = d.live ?? d.c[d.c.length - 1];
    if (live > p.stop && live < p.target1) mc[p.id] = monteCarloFixed(d, { entry: live, stop: +p.stop, target: +p.target1 });
  }
  const scan: Record<string, unknown> = {};
  for (const m of last?.[0]?.result?.markets ?? []) for (const s of m.stocks) if (tickers.includes(s.ticker) || (pos ?? []).some(p => p.ticker === s.ticker))
    scan[s.ticker] = { score: s.score, verdict: s.verdict, why: s.why, rs: s.rs, setups: s.setups };
  await advise(pos ?? [], ord ?? [], D, mc, last?.[0]?.result ?? null).catch(e => console.error("advise", e));
  const all = (last?.[0]?.result?.markets ?? []).flatMap((m: any) => m.stocks.map((s: any) => s.ticker)).concat(Object.values(BENCH));
  const live = await liveQuotes(all).catch(() => ({}));
  return { at: new Date().toISOString(), quotes, mc, scan, maxScore: MAX_SCORE, live };
}

// taramadaki tüm hisselerin son fiyatı (Yahoo v7 quote, 50'şerli): arama, şerit, ısı haritası ve tablo bununla güncellenir
// değer: [son, önceki kapanış, zaman (sn), seans açık mı]
async function liveQuotes(tickers: string[]): Promise<Record<string, [number, number, number, boolean]>> {
  const out: Record<string, [number, number, number, boolean]> = {};
  const { cookie, crumb } = await yAuth();
  for (let i = 0; i < tickers.length; i += 50) {
    const u = `https://query2.finance.yahoo.com/v7/finance/quote?symbols=${tickers.slice(i, i + 50).map(encodeURIComponent).join(",")}&fields=regularMarketPrice,regularMarketPreviousClose,regularMarketTime,marketState&crumb=${encodeURIComponent(crumb)}`;
    const j = await (await fetch(u, { headers: { ...UA, cookie }, signal: AbortSignal.timeout(15000) })).json().catch(() => null);
    for (const r of j?.quoteResponse?.result ?? [])
      if (r.regularMarketPrice && r.regularMarketPreviousClose) out[r.symbol] = [r.regularMarketPrice, r.regularMarketPreviousClose, r.regularMarketTime ?? 0, r.marketState === "REGULAR"];
  }
  return out;
}

// ---------------------------------------------------------------- kural tabanlı öneriler: her fiyat yenilemede portföye göre yeniden yazılır
// Her pozisyon için tek kart: eylem + Plan / Teknik / Bilanço / Haber satırları. Kaynaklar: canlı fiyat ve günlük mumlar (teknik),
// İş Yatırım mali tabloları + bilanço takvimi (bilanço), swing_news başlıkları (haber), swing_deep (temel/teknik derin puan).
// horizon = 'uzun' (uzun vadeli birikim): stop uyarısı üretilmez; ekleme kararı dayanak varlığın (proxy, TL) trendine göre verilir.
// Sohbetten gelen öneriler (source 'Kural' ile başlamayan) dokunulmaz. Kullanıcının kapattığı kart, eylem değişene ya da 24 saat geçene kadar geri gelmez.
const RISK_PER_TRADE = 0.01, MAX_WEIGHT = 0.25, MAX_HEAT = 0.06, NEAR_STOP = 0.03, NEWS_HOURS = 96;
type Adv = { symbol: string; action: string; title: string; body: string; prio: number; akey: string };
const fN = (x: number, d = 2) => x.toLocaleString("tr-TR", { minimumFractionDigits: d, maximumFractionDigits: d });
const fP = (x: number, d = 1) => (x >= 0 ? "+" : "−") + "%" + fN(Math.abs(x) * 100, d);
const fTL = (x: number) => fN(Math.round(x), 0) + " ₺";
const sg = (n: number) => (n > 0 ? "+" : n < 0 ? "−" : "") + Math.abs(n);

// günlük mumlardan teknik özet: 50g/200g ortalama, RSI, haftalık HAHO, rotasyon çeyreği → puan ve cümle
function techOf(d: D, bench: D | null) {
  const n = d.c.length - 1, c = d.live ?? d.c[n], s50 = sma(d.c, 50)[n], s200 = sma(d.c, 200)[n], rs = indicators(d).rsi[n];
  const wk = weeklyHaho(d), haho = wk.vw[wk.vw.length - 1], k = wk.lastDone ? wk.wc.length - 1 : wk.wc.length - 2;
  const hahoBreak = k >= 0 && wk.wc[k] < wk.vw[k];
  const q = bench ? rrg(d, bench) : null, qp = q?.[q.length - 1];
  const quad = qp ? (qp[0] >= 100 ? (qp[1] >= 100 ? "lider" : "zayıflayan") : qp[1] >= 100 ? "toparlanan" : "geride") : null;
  let pts = 0; const parts: string[] = [];
  if (c > s50) { pts++; parts.push("50g ortalamanın üstünde"); } else { pts--; parts.push(`50g ortalamanın (${fN(s50)}) altında`); }
  if (c > s200) { pts++; parts.push("200g üstünde"); } else { pts--; parts.push(`200g ortalamanın (${fN(s200)}) altında`); }
  if (rs >= 50 && rs < 70) pts++; else if (rs < 40) pts--;
  parts.push(`RSI ${Math.round(rs)}${rs >= 70 ? " (aşırı alım)" : rs <= 30 ? " (aşırı satım)" : ""}`);
  if (Number.isFinite(haho)) { if (c > haho) pts++; else pts--; parts.push(`haftalık HAHO ${fN(haho)} ${c > haho ? "üstünde" : "altında"}${hahoBreak ? " (son hafta altında kapattı)" : ""}`); }
  if (quad) { if (quad === "lider") pts++; else if (quad === "geride") pts--; parts.push(`rotasyonda ${quad}`); }
  const tone = pts >= 2 ? "pozitif" : pts <= -2 ? "negatif" : "nötr";
  return { pts, tone, hahoBreak, above: !Number.isFinite(haho) || c > haho, text: `Teknik ${tone} (${sg(pts)}): ${parts.join(", ")}.` };
}

// başlık taraması: anahtar kelimeyle kaba ton (yorum değil); yalnızca uyarı satırı üretir, tek başına al/sat kararı vermez
const N_NEG = /(zarar|çakıldı|çöktü|ceza|soruşturma|dava |iflas|sert düş|geriledi|değer kayb|satış baskı|iptal etti|grev|hedef fiyat\w* (indir|düşür)|not\w* (indir|düşür)|tavsiye\w* (sat|azalt)|downgrade|lawsuit|probe|plunge|slump|cuts? (guidance|forecast|outlook)|misses|recall)/i;
const N_POS = /(rekor|kâr\w* (art|yüksel|katla)|anlaşma imzala|sözleşme imzala|ihale\w* kazan|geri alım|temettü|bedelsiz|hedef fiyat\w* (yükselt|artır)|tavsiye\w* al|bilanço sürprizi|upgrade|beats|tops estimates|raises? (guidance|forecast|outlook)|buyback|record high)/i;
function newsOf(items: any[] | undefined, at: string | null) {
  if (!items) return null;
  const rec = items.filter(i => i.at && Date.now() - Date.parse(i.at) < NEWS_HOURS * 36e5).sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const age = at ? Math.floor((Date.now() - Date.parse(at)) / 36e5) : null, stale = age != null && age >= 12 ? ` Haberler ${age >= 48 ? Math.floor(age / 24) + " gün" : age + " saat"} önce çekildi; Haberler sayfasından yenile.` : "";
  if (!rec.length) return { neg: 0, pos: 0, text: `Haber: son ${NEWS_HOURS / 24} günde özel başlık yok.${stale}` };
  const neg = rec.filter(i => N_NEG.test(i.t)).length, pos = rec.filter(i => N_POS.test(i.t)).length;
  const tone = neg > pos ? ", başlık taraması olumsuz ağırlıklı" : pos > neg ? ", başlık taraması olumlu ağırlıklı" : "";
  const lead = rec.find(i => (neg > pos ? N_NEG : pos > neg ? N_POS : /./).test(i.t)) ?? rec[0];
  return { neg, pos, text: `Haber (son ${NEWS_HOURS / 24} gün, ${rec.length} başlık${tone}): “${String(lead.t).slice(0, 140)}” (${lead.src}).${stale}` };
}

// uzun vadeli birikim: dayanak varlığın TL serisi (proxy × USD/TRY) → trend durumu
const PROXY_TR: Record<string, string> = { "SI=F": "gümüş", "GC=F": "altın", "XAGUSD=X": "gümüş", "XAUUSD=X": "altın", "BTC-USD": "bitcoin" };
function trendOf(p: D, fx: D | null) {
  let c = p.c.slice();
  if (fx) { const m = new Map(fx.t.map((t, i) => [t, fx.c[i]])); let last = fx.c[0]; c = p.c.map((v, i) => { last = m.get(p.t[i]) ?? last; return v * last; }); }
  const liveNow = (p.live ?? p.c[p.c.length - 1]) * (fx ? fx.live ?? fx.c[fx.c.length - 1] : 1);
  const n = c.length - 1, s50 = sma(c, 50)[n], s200 = sma(c, 200)[n], s200p = sma(c, 200)[n - 20];
  const diff = c.map((x, i) => (i ? x - c[i - 1] : NA));
  const up = ewmAdjust(diff.map(x => (Number.isNaN(x) ? NA : Math.max(x, 0))), 1 / 14), dn = ewmAdjust(diff.map(x => (Number.isNaN(x) ? NA : Math.max(-x, 0))), 1 / 14);
  const rs = 100 - 100 / (1 + up[n] / dn[n]), hi = ext(c, Math.max(0, n - 251), n, true);
  return { last: liveNow, vs50: liveNow / s50 - 1, vs200: liveNow / s200 - 1, slope: s200 / s200p - 1, rsi: rs, chg20: liveNow / c[n - 20] - 1, dd: liveNow / Math.max(hi, liveNow) - 1,
    down: liveNow < s200 && s200 < s200p, upT: liveNow > s200 && s200 >= s200p };
}

async function advise(pos: any[], ord: any[], D: Map<string, D | null>, mc: Record<string, any>, scanRes: any) {
  const [{ data: st }, { data: dp }, { data: nw }, { data: old }, { data: closed }] = await Promise.all([
    sb.from("swing_settings").select("cash_try").eq("id", 1).single(),
    sb.from("swing_deep").select("data").eq("id", 1).single(),
    sb.from("swing_news").select("data").eq("id", 1).single(),
    sb.from("swing_advice").select("akey,symbol,action,prev_action,created_at").like("source", "Kural%").eq("status", "aktif"),
    sb.from("swing_advice").select("akey").like("source", "Kural%").neq("status", "aktif").gt("updated_at", new Date(Date.now() - 864e5).toISOString()),
  ]);
  const cash = +(st?.cash_try ?? 0), fxD = D.get("USDTRY=X") ?? null, fx = fxD?.live ?? null;
  const deep: Record<string, any> = dp?.data?.deep ?? {}, newsAt: string | null = nw?.data?.at ?? null;
  const newsBy = new Map<string, any[]>((nw?.data?.stocks ?? []).map((x: any) => [x.symbol, x.items ?? []]));
  const stocks = new Map<string, any>(), regime: Record<string, boolean> = {};
  for (const m of scanRes?.markets ?? []) { regime[m.market] = !!m.regime?.ok; for (const s of m.stocks) stocks.set(s.ticker, s); }
  const scanAge = scanRes?.createdAt ? (Date.now() - Date.parse(scanRes.createdAt)) / 864e5 : null;
  const held: string[] = pos.filter(p => p.kind === "stock").map(p => p.ticker);
  // bilanço: tarih (Yahoo / SPK son tarihi) + BIST'te son açıklanan dönemin net kâr büyümesi
  const ed = await earnDates([...new Set([...held, ...ord.filter(o => o.side === "al").map(o => o.ticker)])]);
  const ernBy = new Map<string, Ern | null>();
  for (const t of held) if (t.endsWith(".IS")) { const e = await isyNet(t.replace(".IS", "")).catch(() => null); ernBy.set(t, e); if (!ed.has(t)) { const dl = bistDeadline(e); if (dl) ed.set(t, dl); } }
  const nearE = (t: string) => { const e = ed.get(t); return e && e.days <= EARN_DAYS ? e : null; };
  const eTxt = (e: Earn) => `${e.days === 0 ? "bugün" : e.days + " gün içinde"} (${e.src === "Yahoo" ? "" : "en geç "}${e.date.slice(8)}.${e.date.slice(5, 7)})`;
  const pc = (x: number) => (x >= 0 ? "+" : "−") + "%" + Math.round(Math.abs(x) * 100);

  const rows = pos.map(p => {
    const d = p.kind === "stock" ? D.get(p.ticker) ?? null : null;
    const price: number = d ? d.live ?? d.c[d.c.length - 1] : +(p.manual_price ?? p.cost);
    const f = p.kind === "fund" || p.ticker.endsWith(".IS") ? 1 : fx ?? 1, long = p.horizon === "uzun";
    return { p, d, price, long, value: +p.qty * price * f, risk: !long && p.stop ? Math.max(0, price - +p.stop) * +p.qty * f : 0 };
  });
  const total = rows.reduce((a, r) => a + r.value, 0) + cash;
  const heat = rows.reduce((a, r) => a + r.risk, 0) / (total || 1);
  const out: Adv[] = [];

  for (const { p, d, price, value, long } of rows) {
    const sym = p.symbol, stop = p.stop != null ? +p.stop : null, t1 = p.target1 != null ? +p.target1 : null, t2 = p.target2 != null ? +p.target2 : null;
    const cost = +p.cost, w = value / (total || 1), pnl = price / cost - 1;
    const nws = newsOf(newsBy.get(sym), newsAt);
    const L: string[] = [];
    const head = `Son ${fN(price)}${p.kind === "fund" ? ` (elle, ${p.manual_at ? String(p.manual_at).slice(8, 10) + "." + String(p.manual_at).slice(5, 7) : "tarih yok"})` : ""} · maliyet ${fN(cost)} (${fP(pnl)}) · ağırlık %${fN(w * 100, 0)}`;

    // ---- uzun vadeli birikim pozisyonu
    if (long) {
      const pd = p.proxy ? D.get(p.proxy) ?? null : d, usd = p.proxy ? !/\.IS$|TRY/.test(p.proxy) : false;
      const nm = p.proxy ? PROXY_TR[p.proxy] ?? p.proxy : sym;
      L.push(`Pozisyon: ${head}. Uzun vadeli birikim; stop uyarısı üretilmez.`);
      let action = "TUT", title = "Uzun vadeli birikim", rule = "Dayanak varlık tanımlı değil; yalnızca pozisyon bilgisi gösterilir. Pozisyonu düzenleyip dayanak kodu (örnek SI=F) girersen ekleme bölgesi hesaplanır.";
      if (pd) {
        const tr = trendOf(pd, usd ? fxD : null);
        L.push(`Dayanak (${nm}, TL): 20 günde ${fP(tr.chg20)}, 50g ortalamaya göre ${fP(tr.vs50)}, 200g ortalamaya göre ${fP(tr.vs200)} (200g ${tr.slope >= 0 ? "yükseliyor" : "düşüyor"}), RSI ${Math.round(tr.rsi)}, 1 yıllık zirveden ${fP(tr.dd)}.`);
        if (tr.down && tr.vs50 < 0) { action = "BEKLE"; title = `${nm[0].toLocaleUpperCase("tr")}${nm.slice(1)} düşüş trendinde: toplu ekleme için erken`; rule = "Fiyat 50g ve 200g ortalamanın altında, 200g ortalama düşüyor: dönüş işareti yok. Düzenli birikim yapıyorsan kademeyi küçük tut; toplu ekleme için 50g ortalamanın üstünde kapanış beklenir."; }
        else if (tr.down) { action = "TEMKİNLİ"; title = `${nm[0].toLocaleUpperCase("tr")}${nm.slice(1)} toparlanıyor ama uzun trend aşağı`; rule = "Fiyat 50g ortalamanın üstüne çıktı ama 200g ortalamanın altında: küçük kademelerle ekleme, toplu alım yok."; }
        else if (tr.upT && (tr.rsi > 70 || tr.vs50 > 0.10)) { action = "BEKLE"; title = "Trend yukarı ama fiyat uzamış"; rule = "Fiyat 50g ortalamanın %10'dan fazla üstünde ya da RSI 70 üstü: kovalamadan geri çekilme beklenir."; }
        else if (tr.upT && (tr.vs50 <= 0.02 || tr.rsi < 45)) { action = "EKLE"; title = "Yükselen trendde geri çekilme: kademeli ekleme bölgesi"; rule = "Uzun trend yukarı (fiyat 200g üstünde, 200g yükseliyor) ve fiyat 50g ortalamaya geri çekildi: kademeli ekleme kural içinde."; }
        else if (tr.upT) { action = "TUT"; title = "Trend yukarı, nötr bölge"; rule = "Düzenli birikim planı sürer; ekstra ekleme için 50g ortalamaya geri çekilme beklenir."; }
        else { action = "TUT"; title = "Yön belirsiz"; rule = "Fiyat 200g ortalamanın çevresinde, net trend yok: düzenli birikim dışında ekleme yok."; }
        if (action === "EKLE" && w >= MAX_WEIGHT) { action = "TUT"; rule += ` Ağırlık %${MAX_WEIGHT * 100} sınırında; ekleme yapılmaz.`; }
      }
      L.push("Kural: " + rule);
      if (nws) L.push(nws.text);
      if (p.kind === "fund") { const age = p.manual_at ? Math.floor((Date.now() - Date.parse(p.manual_at)) / 864e5) : 999; if (age > 5) L.push(`Fon fiyatı ${age > 90 ? "hiç" : age + " gündür"} girilmedi; kâr/zarar eski fiyatla hesaplanıyor.`); }
      out.push({ symbol: sym, action, title, body: L.join("\n"), prio: action === "EKLE" ? 3 : 5, akey: `${sym}:${action}` });
      continue;
    }

    // ---- swing pozisyonu
    if (p.kind === "fund") {
      const age = p.manual_at ? Math.floor((Date.now() - Date.parse(p.manual_at)) / 864e5) : 999;
      if (age > 3) { out.push({ symbol: sym, action: "BEKLE", title: age > 90 ? "Fon fiyatı girilmedi" : `Fon fiyatı ${age} gündür girilmedi`, body: `Pozisyon: ${head}.\nTEFAS'tan son fiyatı portföy ekranında gir; stop ${stop ? fN(stop) : "—"} kontrolü eski fiyatla çalışıyor.`, prio: 3, akey: `${sym}:BEKLE` }); continue; }
    }
    if (!d && p.kind === "stock") { out.push({ symbol: sym, action: "BEKLE", title: "Fiyat alınamadı", body: "Yahoo bu hisse için veri vermedi; bir sonraki yenilemede tekrar denenir.", prio: 6, akey: `${sym}:veri` }); continue; }
    const s = stocks.get(p.ticker), e = p.kind === "stock" ? nearE(p.ticker) : null, ern = ernBy.get(p.ticker) ?? null, dx = deep[p.ticker];
    const bench = D.get(p.ticker.endsWith(".IS") ? "XU100.IS" : "^NDX") ?? null;
    const tech = d ? techOf(d, bench) : null;
    const partial = !!d?.partial, closeRule = /kapanış/i.test(p.note ?? "") || p.kind === "fund";
    L.push(`Plan: ${head} · stop ${stop != null ? `${fN(stop)} (${fP(stop / price - 1)})` : "yok"}${t1 != null ? ` · H1 ${fN(t1)} (${fP(t1 / price - 1)})` : ""}${t2 != null ? ` · H2 ${fN(t2)}` : ""}.${mc[p.id] ? ` 40 günde önce H1 %${fN(mc[p.id].target * 100, 0)}, önce stop %${fN(mc[p.id].stop * 100, 0)}.` : ""}`);
    if (tech) L.push(tech.text + (dx?.tech ? ` Çok zaman dilimli (4S-G-H-A) puan ${sg(dx.tech.pts)}.` : "") + (s ? ` Tarama: ${s.verdict} ${s.score}/${MAX_SCORE}.` : ""));
    const bl: string[] = [];
    if (ern) bl.push(`${ern.period} net kâr yıllık ${pc(ern.g)}${ern.gp != null ? ` (önceki çeyrek ${pc(ern.gp)})` : ""}: ${ern.good ? "büyüyor ve hızlanıyor" : ern.g > 0 ? "büyüyor ama yavaşlıyor" : "geriliyor"}`);
    if (dx?.fund) bl.push(`temel puan ${sg(dx.fund.pts)}`);
    const en = ed.get(p.ticker); if (en) bl.push(e ? `sonraki bilanço ${eTxt(e)}` : `sonraki bilanço ${en.date.slice(8)}.${en.date.slice(5, 7)}.${en.date.slice(0, 4)}`);
    if (bl.length) L.push("Bilanço: " + bl.join("; ") + ".");
    if (nws) L.push(nws.text);
    const fundBad = (ern && !ern.good && ern.g <= 0) || (dx?.fund && dx.fund.pts <= -2), newsBad = !!nws && nws.neg > nws.pos && nws.neg >= 2;
    let action = "TUT", title = "", rule = "", prio = 5;
    if (stop != null && price <= stop) { action = "SAT"; prio = 1; title = `Stop ${fN(stop)} altında`; rule = partial && closeRule ? `Seans açık: gün kapanışı ${fN(stop)} altında kalırsa planın gereği çık.` : "Plandaki stop çalıştı; çık."; }
    else if (t2 != null && price >= t2) { action = "SAT"; prio = 2; title = `Hedef 2 (${fN(t2)}) geldi`; rule = `Kalan pozisyonu sat ya da stopu hedef 1'e (${t1 ? fN(t1) : "—"}) çekip trendi izle.`; }
    else if (t1 != null && price >= t1) { action = "AZALT"; prio = 2; title = `Hedef 1 (${fN(t1)}) geldi: yarısını sat`; rule = `Yarısını sat, kalan için stopu maliyete (${fN(cost)}) çek.`; }
    else if (tech?.hahoBreak && !tech.above && tech.pts <= 0) { action = "AZALT"; prio = 2; title = "Haftalık kapanış HAHO altında, teknik zayıf"; rule = "Taramanın çıkış kuralı tetiklendi (haftalık kapanış < haftalık HAHO), fiyat hâlâ HAHO altında ve günlük teknik zayıf: kurala göre çıkış ya da azaltma."; }
    else if (stop != null && price / stop - 1 < NEAR_STOP) { action = "TEMKİNLİ"; prio = 2; title = `Stopa %${fN((price / stop - 1) * 100, 1)} kaldı`; rule = `Stop ${fN(stop)}${closeRule ? " (günlük kapanışla)" : ""}; ekleme yapma, stopu aşağı çekme.`; }
    else if (e) { action = "TEMKİNLİ"; prio = 3; title = `Bilanço ${eTxt(e)}: ekleme yok`; rule = "Bilanço öncesi pozisyon büyütme; stop yerinde kalsın."; }
    else if (t1 != null && t1 / price - 1 < 0.02) { action = "TUT"; prio = 2; title = `Hedef 1'e %${fN((t1 / price - 1) * 100, 1)} kaldı`; rule = `${fN(t1)} görülürse plan: yarısını sat, kalan için stopu maliyete (${fN(cost)}) çek.` + (tech?.hahoBreak ? ` Geçen hafta HAHO altında kapatmıştı, fiyat şimdi ${tech.above ? "yeniden üstünde" : "hâlâ altında"}; cuma kapanışı belirleyici.` : ""); }
    else if (tech && (tech.tone === "negatif" || (fundBad && tech.pts <= 0) || (newsBad && tech.pts <= 0))) {
      action = "TEMKİNLİ"; prio = 3;
      title = tech.tone === "negatif" ? "Teknik negatif: ekleme yok" : fundBad ? "Bilanço zayıf, teknik destek vermiyor" : "Olumsuz haber akışı, teknik destek vermiyor";
      rule = "Ekleme yapma; stop yerinde. Teknik toparlanana (50g ortalama ve haftalık HAHO üstü) kadar pozisyon büyütülmez." + (tech.hahoBreak ? " Haftalık kapanış HAHO altında kaldı; bir hafta daha altında kapanırsa kural azaltma der." : "");
    }
    else if (tech?.hahoBreak) { action = "TEMKİNLİ"; prio = 3; title = tech.above ? "Geçen hafta HAHO altında kapattı, fiyat yeniden üstünde" : "Haftalık kapanış HAHO altında"; rule = tech.above ? "Çıkış kuralı geçen hafta tetiklendi ama fiyat HAHO'yu geri aldı: ekleme yok, cuma kapanışı HAHO altında kalırsa azalt." : "Çıkış kuralı tetiklendi, günlük teknik henüz bozulmadı: ekleme yok, cuma kapanışı da HAHO altında kalırsa azalt."; }
    else if (s?.verdict === "ALINIR" && w < MAX_WEIGHT && tech && tech.pts >= 0 && !fundBad) { action = "EKLE"; prio = 4; title = `Tarama ALINIR (${s.score}/${MAX_SCORE}), teknik ${tech.tone}`; rule = `Ekleme kural içinde: ağırlık %${MAX_WEIGHT * 100} sınırının altında. Eklersen stopu taramanınkine (${fN(s.plan.stop)}) göre yeniden düşün.`; }
    else { title = `Plan geçerli${tech ? `, teknik ${tech.tone}` : ""}`; rule = (s?.verdict === "ALINMAZ" ? "Tarama yeni giriş için ALINMAZ diyor; elde tutmak için planın geçerli, ekleme yok." : "Stop ve hedefler yerinde; değişiklik gerektiren bir koşul yok."); }
    L.splice(1, 0, "Kural: " + rule);
    out.push({ symbol: sym, action, title, body: L.join("\n"), prio, akey: `${sym}:${action}` });
  }

  // bekleyen emirler
  const today = new Date().toISOString().slice(0, 10);
  for (const o of ord) {
    if (o.valid_until && o.valid_until < today) { out.push({ symbol: o.symbol, action: "BEKLE", title: "Emrin süresi doldu", body: `${o.side === "al" ? "Alış" : "Satış"} emri ${o.valid_until} tarihinde bitti; ekranda iptal ya da gerçekleşti olarak işaretle.`, prio: 4, akey: `${o.symbol}:emir-${o.id}` }); continue; }
    if (o.side !== "al") continue;
    const s = stocks.get(o.ticker), e = nearE(o.ticker);
    if (e) out.push({ symbol: o.symbol, action: "TEMKİNLİ", title: `Alış emri: bilanço ${eTxt(e)}`, body: `Bilanço sonrasına bırakmak sürpriz riskini önler.${s ? ` Tarama: ${s.verdict} ${s.score}/${MAX_SCORE}.` : ""}`, prio: 3, akey: `${o.symbol}:emir-bilanco` });
    else if (s?.verdict === "ALINMAZ") out.push({ symbol: o.symbol, action: "TEMKİNLİ", title: `Alış emri var, tarama ALINMAZ (${s.score}/${MAX_SCORE})`, body: "Emir dolarsa kural dışı bir giriş olur; emri gözden geçir.", prio: 3, akey: `${o.symbol}:emir-alinmaz` });
  }

  // portföy düzeyi: risk, nakit ve adaylar
  if (heat > MAX_HEAT) out.push({ symbol: "PORTFÖY", action: "AZALT", title: `Stoplarda toplam risk %${fN(heat * 100, 1)}`, body: `Sınır %${MAX_HEAT * 100}. Yeni alım yapma; en zayıf pozisyonu azalt ya da stopları yaklaştır.`, prio: 1, akey: "PORTFÖY:AZALT" });
  const cands = [...stocks.values()].filter(s => s.verdict === "ALINIR" && !held.includes(s.ticker)).sort((a, b) => b.score - a.score).slice(0, 3);
  let free = cash; const short: string[] = [];
  for (const s of cands) {
    const cf = s.market === "us" ? fx ?? 0 : 1; if (!cf) continue;
    const riskTL = total * RISK_PER_TRADE, px = s.plan.entry * cf;
    const qty = Math.min(Math.floor(riskTL / ((s.plan.entry - s.plan.stop) * cf)), Math.floor((MAX_WEIGHT * total) / px), Math.floor(free / px));
    if (qty < 1) { short.push(`${s.symbol} için nakit ya da %${MAX_WEIGHT * 100} sınırı yetmiyor (1 adet ${fTL(px)})`); continue; }
    free -= qty * px;
    const dx = deep[s.ticker];
    out.push({ symbol: s.symbol, action: "AL", title: `Tarama ALINIR ${s.score}/${MAX_SCORE}: ${qty} ${s.market === "us" ? "adet" : "lot"}`,
      body: `Plan: giriş ~${s.market === "us" ? "$" : ""}${fN(s.plan.entry)}, stop ${fN(s.plan.stop)} (${fP(s.plan.stop / s.plan.entry - 1)}), çıkış haftalık kapanış HAHO altı. Adet, stopta kaybın portföyün %${RISK_PER_TRADE * 100}'i (${fTL(riskTL)}) olacağı şekilde; tutar ${fTL(qty * px)} (portföyün %${fN(qty * px / total * 100, 0)}).${s.market === "us" ? " ABD hissesi: hesabın yoksa geç." : ""}${heat > MAX_HEAT ? " Önce portföy riskini düşür." : ""}`
        + (dx?.tech ? `\nDerin analiz: temel ${sg(dx.fund?.pts ?? 0)}, teknik ${sg(dx.tech.pts)}.` : "") + `\nGerekçe: ${(s.why as string[]).filter(w => w.startsWith("+")).map(w => w.replace(/^\+\d+ /, "")).join("; ")}.`,
      prio: 3, akey: `${s.symbol}:AL` });
  }
  // en yakın adaylar: ALINIR'a ne eksik
  const watch = [...stocks.values()].filter(s => s.verdict === "KARARSIZ" && !held.includes(s.ticker)).sort((a, b) => b.score - a.score || b.rs - a.rs).slice(0, 4).map(s => {
    const miss: string[] = [];
    if (!s.setups?.length) miss.push("kurulum (55g kırılım ya da geri çekilme)");
    if (!s.regimeOk) miss.push("endeks rejimi");
    if (s.earn && s.earn.days <= EARN_DAYS) miss.push(`bilanço ${s.earn.days} gün içinde`);
    if (s.ern && !s.ern.good) miss.push("bilanço zayıf");
    if (s.score < 6) miss.push(`puan ${s.score}/6`);
    if ((s.why as string[]).some(w => w.startsWith("-") && !/Endeks/.test(w))) miss.push((s.why as string[]).find(w => w.startsWith("-") && !/Endeks/.test(w))!.replace(/^-\d+ /, "").toLocaleLowerCase("tr"));
    const dx = deep[s.ticker];
    return `${s.symbol} ${s.score}/${MAX_SCORE}${dx?.tech ? ` (temel ${sg(dx.fund?.pts ?? 0)}, teknik ${sg(dx.tech.pts)})` : ""}: eksik ${miss.join(", ") || "—"}`;
  });
  if (watch.length) out.push({ symbol: "ADAYLAR", action: "İZLE", title: `ALINIR'a en yakın ${watch.length} hisse`, body: watch.join("\n"), prio: 6, akey: "ADAYLAR:İZLE" });
  const weak = [regime.bist === false ? "BIST 100" : "", regime.us === false ? "Nasdaq-100" : ""].filter(Boolean);
  out.push({ symbol: "NAKİT", action: "KORU", title: `Nakit %${fN(cash / (total || 1) * 100, 0)} (${fTL(cash)})`,
    body: (cands.length ? `Taramada elde olmayan ${cands.length} ALINIR aday var; lot hesabı yukarıda.` :
      `Son taramada elde olmayan ALINIR aday yok${weak.length ? `; ${weak.join(" ve ")} rejimi zayıf` : ""}. Nakit, 6+ puanlı ALINIR çıkana kadar bekler.`)
      + (short.length ? " " + short.join("; ") + "." : "") + (scanAge != null && scanAge > 1.5 ? ` Son tarama ${Math.floor(scanAge)} gün önce: yeniden tara.` : ""),
    prio: 7, akey: "NAKİT:KORU" });

  // yaz: aktif kural kartlarını sil, yenilerini ekle; eylemi değişen kart önceki eylemi taşır
  const src = `Kural · fiyat ${new Date().toLocaleString("tr-TR", { timeZone: "Europe/Istanbul", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}`;
  const prev = new Map((old ?? []).map((x: any) => [x.symbol, x.action]));
  const skip = new Set((closed ?? []).map((x: any) => x.akey));
  await sb.from("swing_advice").delete().like("source", "Kural%").eq("status", "aktif");
  // aynı eylem sürüyorsa ilk çıktığı an (created_at) ve önceki eylem korunur: "ne zamandır böyle" görünür
  const same = new Map((old ?? []).map((x: any) => [x.akey, x]));
  const ins = out.filter(a => !skip.has(a.akey)).map(a => { const o: any = same.get(a.akey);
    return { ...a, status: "aktif", source: src, ...(o ? { created_at: o.created_at, prev_action: o.prev_action } : { prev_action: prev.has(a.symbol) && prev.get(a.symbol) !== a.action ? prev.get(a.symbol) : null }) }; });
  if (ins.length) { const { error } = await sb.from("swing_advice").insert(ins); if (error) throw new Error(error.message); }
}

Deno.serve(async req => {
  if (!(await authorized(req))) return new Response("forbidden", { status: 403 });
  let id = 0, mkt = "";
  try {
    const body = await req.json();
    if (body.mode === "portfolio") {
      try { await sb.rpc("swing_quotes_put", { payload: await portfolio(), err: null }); return new Response("ok"); }
      catch (e) { await sb.rpc("swing_quotes_put", { payload: null, err: String((e as Error).message ?? e) }); return new Response(String(e), { status: 500 }); }
    }
    ({ id, market: mkt } = body);
    if (!Number.isInteger(id) || !(mkt in BENCH)) return new Response("bad request", { status: 400 });
    const { data: row } = await sb.from("swing_scans").select("status, created_at").eq("id", id).single();
    if (!row || row.status !== "running" || Date.now() - Date.parse(row.created_at) > 10 * 60_000) return new Response("not running", { status: 409 });
    await runMarket(id, mkt);
    return new Response("ok");
  } catch (e) {
    if (id) await sb.rpc("swing_fail", { scan_id: id, msg: `${mkt}: ${(e as Error).message ?? e}` });
    return new Response(String(e), { status: 500 });
  }
});
