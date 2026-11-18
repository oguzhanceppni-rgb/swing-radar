// Swing Radar ileriye dönük takip — yalnızca istekle: swing_track_start() → pg_net → bu fonksiyon → swing_track_put(payload).
// swing_signals (her taramanın ALINIR/KARARSIZ sinyalleri, tarama bitince tetikleyiciyle eklenir) için gerçek sonuç:
// giriş = sinyal günü kapanışı; çıkış = taramadakiyle aynı kural (ilk stop; haftalık kapanış < haftalık HAHO, ilk 5 gün hariç; en çok 90 gün).
// Aynı hissede açık işlem varken gelen yeni sinyal sayılmaz. Maliyet: BIST %0,2, ABD %0,1 (gidiş-dönüş).
import { createClient } from "jsr:@supabase/supabase-js@2";

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

// Only pg_net calls from the owner's DB carry this key (Vault 'fn_key', read via service role).
let fnKey: string | null = null;
const authorized = async (req: Request) =>
  (fnKey ??= (await sb.rpc("fn_key")).data ?? null) !== null && req.headers.get("x-fn-key") === fnKey;
const UA = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36" };
const HOLD = 90, MIN_DAYS = 5, COST: Record<string, number> = { bist: 0.002, us: 0.001 };
const BENCH: Record<string, string> = { bist: "XU100.IS", us: "^NDX" };
const CLOSE_UTC: Record<string, number> = { bist: 15.25, us: 21 };
type D = { t: number[]; o: number[]; h: number[]; l: number[]; c: number[]; v: number[]; live: number | null };

const dayKey = (ts: number, off: number) => { const x = new Date((ts + off) * 1000); return Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), x.getUTCDate()) / 1000; };
async function chart(ticker: string, mkt: string): Promise<D | null> {
  for (let a = 0; a < 3; a++) {
    const r = await fetch(`https://query${1 + (a % 2)}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=2y&interval=1d`, { headers: UA });
    if (r.status === 429 || r.status >= 500) { await new Promise(s => setTimeout(s, 800 * (a + 1))); continue; }
    if (!r.ok) return null;
    const res = (await r.json())?.chart?.result?.[0]; if (!res?.timestamp) return null;
    const q = res.indicators.quote[0], adj = res.indicators.adjclose?.[0]?.adjclose ?? q.close, off = res.meta.gmtoffset ?? 0;
    // Yahoo'nun boş bıraktığı son günler (BIST) 1 saatlik mumlardan kurulur
    const holes = new Set<number>(); const n0 = res.timestamp.length;
    for (let i = Math.max(0, n0 - 40); i < n0; i++) if (q.close[i] == null) holes.add(dayKey(res.timestamp[i], off));
    const fill = new Map<number, number[]>();
    if (holes.size) {
      const h = await (await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?range=3mo&interval=60m`, { headers: UA })).json().catch(() => null);
      const hr = h?.chart?.result?.[0], hq = hr?.indicators?.quote?.[0];
      hr?.timestamp?.forEach((ts: number, i: number) => {
        if (hq.close[i] == null || hq.open[i] == null) return;
        const k = dayKey(ts, hr.meta.gmtoffset ?? 0); if (!holes.has(k)) return;
        const b = fill.get(k); if (!b) fill.set(k, [hq.open[i], hq.high[i], hq.low[i], hq.close[i], hq.volume[i] ?? 0]);
        else { b[1] = Math.max(b[1], hq.high[i]); b[2] = Math.min(b[2], hq.low[i]); b[3] = hq.close[i]; b[4] += hq.volume[i] ?? 0; }
      });
    }
    const d: D = { t: [], o: [], h: [], l: [], c: [], v: [], live: res.meta.regularMarketPrice ?? null };
    res.timestamp.forEach((ts: number, i: number) => {
      const c = q.close[i], k = dayKey(ts, off);
      if (c == null || q.open[i] == null || q.high[i] == null || q.low[i] == null) {
        const f = fill.get(k); if (!f) return; d.t.push(k); d.o.push(f[0]); d.h.push(f[1]); d.l.push(f[2]); d.c.push(f[3]); d.v.push(f[4]); return;
      }
      const m = adj[i] != null ? adj[i] / c : 1;
      d.t.push(k); d.o.push(q.open[i] * m); d.h.push(q.high[i] * m); d.l.push(q.low[i] * m); d.c.push(adj[i] ?? c); d.v.push(q.volume[i] ?? 0);
    });
    // seans kapanmadıysa bugünün yarım mumu atılır (kurallar kapanmış mumla)
    const now = new Date(), last = d.t.length - 1;
    if (last >= 0 && d.t[last] === Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) / 1000 && now.getUTCHours() + now.getUTCMinutes() / 60 < CLOSE_UTC[mkt])
      for (const k of ["t", "o", "h", "l", "c", "v"] as const) d[k].pop();
    return d.c.length > 30 ? d : null;
  }
  return null;
}
async function pool<T, R>(xs: T[], n: number, f: (x: T) => Promise<R>) {
  const out: R[] = new Array(xs.length); let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < xs.length) { const k = i++; out[k] = await f(xs[k]); } }));
  return out;
}
// haftalık HAHO (VWMA20, cuma kapanışlı haftalar): o günün haftası bittiyse ve kapanış altındaysa çıkış
function weeklyExit(d: D) {
  const key = d.t.map(t => { const wd = new Date(t * 1000).getUTCDay(); return t + ((5 - wd + 7) % 7) * 86400; });
  const wc: number[] = [], wv: number[] = [], wi: number[] = [];
  key.forEach((k, i) => { if (i === 0 || k !== key[i - 1]) { wc.push(d.c[i]); wv.push(d.v[i]); } else { wc[wc.length - 1] = d.c[i]; wv[wv.length - 1] += d.v[i]; } wi.push(wc.length - 1); });
  const vw = wc.map((_, k) => { if (k < 19) return NaN; let a = 0, b = 0; for (let j = k - 19; j <= k; j++) { a += wc[j] * wv[j]; b += wv[j]; } return b > 0 ? a / b : NaN; });
  const n = d.t.length, lastDone = new Date(d.t[n - 1] * 1000).getUTCDay() === 5;
  return key.map((k, i) => (i < n - 1 ? key[i + 1] !== k : lastDone) && d.c[i] < vw[wi[i]]);
}
const idxOn = (d: D, ts: number) => { let i = -1; for (let k = 0; k < d.t.length && d.t[k] <= ts; k++) i = k; return i; };
const iso = (ts: number) => new Date(ts * 1000).toISOString().slice(0, 10);

Deno.serve(async (req: Request) => {
  if (!(await authorized(req))) return new Response("forbidden", { status: 403 });
  try {
    const { data: sigs, error } = await sb.from("swing_signals").select("*").order("signal_date").order("id");
    if (error) throw new Error(error.message);
    const tick = [...new Set((sigs ?? []).map(s => s.ticker))];
    const all = [...tick, ...Object.values(BENCH)];
    const got = await pool(all, 8, t => chart(t, t.endsWith(".IS") ? "bist" : "us").catch(() => null));
    const D = new Map(all.map((t, i) => [t, got[i]]));
    const EX = new Map<string, boolean[]>();
    const busyUntil = new Map<string, number>(); // ticker → açık işlemin bitiş zamanı (açıksa sonsuz)
    const trades: any[] = [];
    for (const s of sigs ?? []) {
      const d = D.get(s.ticker), b = D.get(BENCH[s.market]);
      const sigTs = Date.parse(s.signal_date) / 1000;
      if ((busyUntil.get(s.ticker) ?? -1) >= sigTs) continue; // aynı hissede açık işlem var
      if (!d || !b) { trades.push({ ...base(s), status: "veri yok" }); continue; }
      if (!EX.has(s.ticker)) EX.set(s.ticker, weeklyExit(d));
      const ex = EX.get(s.ticker)!, i = idxOn(d, sigTs);
      if (i < 0 || d.t[i] !== sigTs) { trades.push({ ...base(s), status: "veri yok" }); continue; }
      const entry = +s.entry, stop = +s.stop, cost = COST[s.market] ?? 0.002;
      let status = "açık", j = d.c.length - 1, px = d.live ?? d.c[j], exitTs: number | null = null;
      for (let k = i + 1; k < Math.min(i + 1 + HOLD, d.c.length); k++) {
        if (d.l[k] <= stop) { status = "stop"; j = k; px = d.o[k] < stop ? d.o[k] : stop; break; }
        if (ex[k] && k - i > MIN_DAYS) { status = "HAHO çıkışı"; j = k; px = d.c[k]; break; }
        if (k - i === HOLD) { status = "süre doldu"; j = k; px = d.c[k]; break; }
      }
      if (status !== "açık") exitTs = d.t[j];
      busyUntil.set(s.ticker, exitTs ?? Infinity);
      const bi = idxOn(b, sigTs), bj = status === "açık" ? b.c.length - 1 : idxOn(b, d.t[j]);
      const bLast = status === "açık" ? (b.live ?? b.c[bj]) : b.c[bj];
      const ret = px / entry - 1 - (status === "açık" ? cost / 2 : cost), bret = bi >= 0 ? bLast / b.c[bi] - 1 : null;
      const hz = (h: number) => {
        const k = i + h; if (k >= d.c.length || bi < 0) return null;
        const bkk = idxOn(b, d.t[k]); if (bkk < 0) return null;
        return { ret: d.c[k] / entry - 1, ex: d.c[k] / entry - b.c[bkk] / b.c[bi] };
      };
      trades.push({ ...base(s), status, exitDate: exitTs ? iso(exitTs) : null, exitPx: px, days: (status === "açık" ? d.c.length - 1 : j) - i,
        ret, bench: bret, excess: bret == null ? null : ret - bret, h20: hz(20), h40: hz(40), h60: hz(60) });
    }
    // özet: pazar × karar ve toplam
    const groups: Record<string, any[]> = {};
    for (const t of trades) if (t.ret != null) for (const k of ["tümü", t.market, `${t.market}:${t.verdict}`]) (groups[k] ??= []).push(t);
    const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
    const summary = Object.fromEntries(Object.entries(groups).map(([k, ts]) => {
      const closed = ts.filter(t => t.status !== "açık"), open = ts.filter(t => t.status === "açık");
      const hzs = (h: string) => { const a = ts.map(t => t[h]).filter(Boolean); return { n: a.length, hit: a.length ? a.filter((x: any) => x.ex > 0).length / a.length : null, ex: mean(a.map((x: any) => x.ex)) }; };
      return [k, { n: ts.length, closed: closed.length, open: open.length,
        win: closed.length ? closed.filter(t => t.ret > 0).length / closed.length : null, avg: mean(closed.map(t => t.ret)), avgEx: mean(closed.map(t => t.excess).filter((x: any) => x != null)),
        openAvg: mean(open.map(t => t.ret)), openEx: mean(open.map(t => t.excess).filter((x: any) => x != null)),
        h20: hzs("h20"), h40: hzs("h40"), h60: hzs("h60") }];
    }));
    const payload = { at: new Date().toISOString(), since: sigs?.[0]?.signal_date ?? null, signals: sigs?.length ?? 0, trades: trades.reverse(), summary };
    await sb.rpc("swing_track_put", { payload, err: null });
    return new Response("ok");
  } catch (e) {
    await sb.rpc("swing_track_put", { payload: null, err: String((e as Error).message ?? e) });
    return new Response(String(e), { status: 500 });
  }
});
function base(s: any) {
  return { id: s.id, ticker: s.ticker, symbol: s.symbol, market: s.market, verdict: s.verdict, score: s.score, date: s.signal_date, entry: +s.entry, stop: +s.stop, scanId: s.scan_id };
}
