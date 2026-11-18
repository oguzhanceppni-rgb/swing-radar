// Swing Radar derin analiz — yalnızca istekle: swing_deep_start(scan_id) → pg_net → bu fonksiyon → swing_deep_put(payload).
// 1) Isı haritası için taramadaki tüm hisselerin sektör / sanayi / piyasa değeri (Yahoo quote).
// 2) ALINIR + KARARSIZ hisseler için: şirket profili, çeyreklik bilanço (FAVÖK, net faaliyet kârı, borç; bankalarda net faiz geliri, ROE)
//    ve çok zaman dilimli teknik (4S-G-H-A): HAHO (VWMA20), RSI + uyumsuzluk, Stokastik RSI, arz-talep bölgeleri, trend kırılımı (4S-G).
// Sektör/dünya yorumu yapılmaz; ilgili haberler ısı haritasına swing-news ile yerleşir, değerlendirme kullanıcıda.
import { createClient } from "jsr:@supabase/supabase-js@2";

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

// Only pg_net calls from the owner's DB carry this key (Vault 'fn_key', read via service role).
let fnKey: string | null = null;
const authorized = async (req: Request) =>
  (fnKey ??= (await sb.rpc("fn_key")).data ?? null) !== null && req.headers.get("x-fn-key") === fnKey;
const UA = { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36" };
const INFL: Record<string, number> = { bist: 0.30, us: 0.03 }; // nominal büyümenin "gerçek" sayılması için eşik (TÜFE yıllık ≈ %29,8)

let auth: { cookie: string; crumb: string } | null = null;
async function yAuth() {
  if (auth) return auth;
  const r0 = await fetch("https://fc.yahoo.com", { headers: UA, redirect: "manual" });
  const cookie = (r0.headers.get("set-cookie") ?? "").split(";")[0];
  const crumb = await (await fetch("https://query2.finance.yahoo.com/v1/test/getcrumb", { headers: { ...UA, cookie } })).text();
  return (auth = { cookie, crumb });
}
async function yj(url: string, withAuth = false) {
  for (let a = 0; a < 3; a++) {
    let u = url, h: Record<string, string> = UA;
    if (withAuth) { const { cookie, crumb } = await yAuth(); u += (u.includes("?") ? "&" : "?") + "crumb=" + encodeURIComponent(crumb); h = { ...UA, cookie }; }
    const r = await fetch(u, { headers: h, signal: AbortSignal.timeout(15000) });
    if (r.status === 429 || r.status >= 500) { await new Promise(s => setTimeout(s, 700 * (a + 1))); continue; }
    if (!r.ok) throw new Error(`yahoo ${r.status}`);
    return await r.json();
  }
  throw new Error("yahoo 429");
}
async function pool<T, R>(xs: T[], n: number, f: (x: T) => Promise<R>) {
  const out: R[] = new Array(xs.length); let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < xs.length) { const k = i++; out[k] = await f(xs[k]); } }));
  return out;
}

// ---------------------------------------------------------------- mumlar
type B = { t: number[]; o: number[]; h: number[]; l: number[]; c: number[]; v: number[] };
async function bars(t: string, interval: string, range: string): Promise<B & { off: number }> {
  const res = (await yj(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(t)}?interval=${interval}&range=${range}`))?.chart?.result?.[0];
  const q = res?.indicators?.quote?.[0], b: B & { off: number } = { t: [], o: [], h: [], l: [], c: [], v: [], off: res?.meta?.gmtoffset ?? 0 };
  // günlükte Yahoo'nun boş bıraktığı son günler (BIST'te görülüyor) 1 saatlik mumlardan kurulur
  const ts0: number[] = res?.timestamp ?? [], off = b.off, day = (ts: number) => new Date((ts + off) * 1000).toISOString().slice(0, 10);
  let fill = new Map<string, number[]>();
  if (interval === "1d") {
    const holes = new Set(ts0.slice(-40).filter((_, k) => q.close[ts0.length - Math.min(40, ts0.length) + k] == null).map(day));
    if (holes.size) {
      const h = await bars(t, "60m", "3mo");
      h.t.forEach((x, i) => { const k = day(x); if (!holes.has(k)) return; const f = fill.get(k); if (!f) fill.set(k, [h.o[i], h.h[i], h.l[i], h.c[i], h.v[i]]); else { f[1] = Math.max(f[1], h.h[i]); f[2] = Math.min(f[2], h.l[i]); f[3] = h.c[i]; f[4] += h.v[i]; } });
    }
  }
  ts0.forEach((ts: number, i: number) => {
    if ([q.open[i], q.high[i], q.low[i], q.close[i]].some(x => x == null)) {
      const f = fill.get(day(ts)); if (f) { b.t.push(ts); b.o.push(f[0]); b.h.push(f[1]); b.l.push(f[2]); b.c.push(f[3]); b.v.push(f[4]); }
      return;
    }
    b.t.push(ts); b.o.push(q.open[i]); b.h.push(q.high[i]); b.l.push(q.low[i]); b.c.push(q.close[i]); b.v.push(q.volume[i] ?? 0);
  });
  return b;
}
// 1 saatlik → 4 saatlik: her işlem gününün ilk saatinden başlayarak 4'erli gruplar (BIST 10–14, 14–18; ABD 9:30–13:30, 13:30–16)
function to4h(b: B & { off: number }): B {
  const o: B = { t: [], o: [], h: [], l: [], c: [], v: [] };
  let day = "", k = 0, key = "";
  b.t.forEach((ts, i) => {
    const d = new Date((ts + b.off) * 1000).toISOString().slice(0, 10);
    if (d !== day) { day = d; k = 0; }
    const g = d + ":" + Math.floor(k++ / 4), j = o.t.length - 1;
    if (g !== key) { key = g; o.t.push(ts); o.o.push(b.o[i]); o.h.push(b.h[i]); o.l.push(b.l[i]); o.c.push(b.c[i]); o.v.push(b.v[i]); }
    else { o.h[j] = Math.max(o.h[j], b.h[i]); o.l[j] = Math.min(o.l[j], b.l[i]); o.c[j] = b.c[i]; o.v[j] += b.v[i]; }
  });
  return o;
}

// ---------------------------------------------------------------- göstergeler
const sma = (x: number[], n: number) => x.map((_, i) => i < n - 1 ? NaN : x.slice(i - n + 1, i + 1).reduce((a, b) => a + b, 0) / n);
function vwma(c: number[], v: number[], n: number) {
  return c.map((_, i) => { if (i < n - 1) return NaN; let pv = 0, vv = 0; for (let j = i - n + 1; j <= i; j++) { pv += c[j] * v[j]; vv += v[j]; } return vv > 0 ? pv / vv : sma(c, n)[i]; });
}
function rsi(c: number[], n = 14) {
  const out = new Array(c.length).fill(NaN); let up = 0, dn = 0;
  for (let i = 1; i < c.length; i++) {
    const d = c[i] - c[i - 1], u = Math.max(d, 0), w = Math.max(-d, 0);
    if (i <= n) { up += u / n; dn += w / n; if (i === n) out[i] = 100 - 100 / (1 + up / (dn || 1e-9)); continue; }
    up = (up * (n - 1) + u) / n; dn = (dn * (n - 1) + w) / n; out[i] = 100 - 100 / (1 + up / (dn || 1e-9));
  }
  return out;
}
function stochRsi(r: number[], n = 14) {
  const raw = r.map((x, i) => { if (i < n || isNaN(x)) return NaN; const w = r.slice(i - n + 1, i + 1).filter(y => !isNaN(y)); const lo = Math.min(...w), hi = Math.max(...w); return hi > lo ? (x - lo) / (hi - lo) * 100 : 50; });
  const fill = (x: number[]) => x.map(y => isNaN(y) ? 50 : y);
  const k = sma(fill(raw), 3), d = sma(fill(k), 3);
  return { k, d };
}
function atr(b: B, n = 14) {
  const tr = b.c.map((_, i) => i === 0 ? b.h[0] - b.l[0] : Math.max(b.h[i] - b.l[i], Math.abs(b.h[i] - b.c[i - 1]), Math.abs(b.l[i] - b.c[i - 1])));
  return sma(tr, n);
}
const pivots = (x: number[], k: number, hi: boolean) => {
  const p: number[] = [];
  for (let i = k; i < x.length - k; i++) { let ok = true; for (let j = i - k; j <= i + k; j++) if (j !== i && (hi ? x[j] > x[i] : x[j] < x[i])) { ok = false; break; } if (ok) p.push(i); }
  return p;
};

type Zone = { lo: number; hi: number; dist: number; vol: number; tests: number; react: number | null };
type TF = { tf: string; close: number; haho: number | null; aboveHaho: boolean | null; touchHaho: boolean; rsi: number | null;
  div: "boğa" | "ayı" | null; divAgo: number | null; stK: number | null; stD: number | null; stoch: "aşırı satım dönüşü" | "aşırı alım dönüşü" | "aşırı satım" | "aşırı alım" | null;
  demand: Zone | null; supply: Zone | null; inDemand: boolean; inSupply: boolean;
  brk: { dir: "yukarı" | "aşağı"; ago: number; level: number; vol: number | null } | null;
  divVol: boolean | null; vol: { rel: number | null; ud: number | null; obvUp: boolean | null } };

function analyze(tf: string, b: B, checkBreak: boolean): TF | null {
  const n = b.c.length; if (n < 40) return null;
  const c = b.c[n - 1], hw = vwma(b.c, b.v, 20)[n - 1], r = rsi(b.c), { k, d } = stochRsi(r), a = atr(b);
  const out: TF = { tf, close: c, haho: isNaN(hw) ? null : hw, aboveHaho: isNaN(hw) ? null : c > hw, touchHaho: !isNaN(hw) && b.l[n - 1] <= hw && b.h[n - 1] >= hw,
    rsi: isNaN(r[n - 1]) ? null : r[n - 1], div: null, divAgo: null, stK: k[n - 1], stD: d[n - 1], stoch: null,
    demand: null, supply: null, inDemand: false, inSupply: false, brk: null, divVol: null, vol: { rel: null, ud: null, obvUp: null } };
  // hacim: son mum / 50 mum ortalaması, 50 mumda yükselen/düşen gün hacim oranı, OBV 20 mum eğimi
  const v50 = sma(b.v, 50), rel = (i: number) => (v50[i] > 0 ? b.v[i] / v50[i] : null);
  if (n > 50) {
    let u = 0, w = 0; for (let i = n - 50; i < n; i++) (b.c[i] >= b.c[i - 1] ? (u += b.v[i]) : (w += b.v[i]));
    let obv = 0; const ob: number[] = [0]; for (let i = 1; i < n; i++) { obv += Math.sign(b.c[i] - b.c[i - 1]) * b.v[i]; ob.push(obv); }
    out.vol = { rel: rel(n - 1), ud: w > 0 ? u / w : null, obvUp: ob[n - 1] > ob[n - 21] };
  }
  // RSI uyumsuzluğu: son iki pivot dip/tepe (son 80 mum), ikinci pivot son 15 mum içinde
  const kk = tf === "A" ? 2 : 3, lb = Math.max(0, n - 80);
  const lows = pivots(b.l, kk, false).filter(i => i >= lb), highs = pivots(b.h, kk, true).filter(i => i >= lb);
  if (lows.length >= 2) { const [p1, p2] = lows.slice(-2); if (n - 1 - p2 <= 15 && b.l[p2] < b.l[p1] && r[p2] > r[p1] + 1) { out.div = "boğa"; out.divAgo = n - 1 - p2; out.divVol = b.v[p2] < b.v[p1]; } }
  if (!out.div && highs.length >= 2) { const [p1, p2] = highs.slice(-2); if (n - 1 - p2 <= 15 && b.h[p2] > b.h[p1] && r[p2] < r[p1] - 1) { out.div = "ayı"; out.divAgo = n - 1 - p2; out.divVol = b.v[p2] < b.v[p1]; } }
  // Stokastik RSI (14,14,3,3)
  const K = k[n - 1], D = d[n - 1], K0 = k[n - 2], D0 = d[n - 2];
  if (K0 <= D0 && K > D && Math.min(K0, K) < 25) out.stoch = "aşırı satım dönüşü";
  else if (K0 >= D0 && K < D && Math.max(K0, K) > 75) out.stoch = "aşırı alım dönüşü";
  else if (K < 20) out.stoch = "aşırı satım"; else if (K > 80) out.stoch = "aşırı alım";
  // Arz-talep: güçlü mumdan (gövde > 1,5×ATR) önceki taban mumu bölge; uzak kenarın ötesinde kapanış yoksa geçerli
  const dem: number[][] = [], sup: number[][] = [];
  for (let i = Math.max(16, n - 250); i < n; i++) {
    const body = b.c[i] - b.o[i], base = i - 1, bb = Math.abs(b.c[base] - b.o[base]);
    if (isNaN(a[i]) || Math.abs(body) < 1.5 * a[i] || bb > 0.6 * a[i]) continue;
    const lo = b.l[base], hi = b.h[base], after = b.c.slice(i + 1);
    const tests = (inZone: (j: number) => boolean) => { let t = 0; for (let j = i + 2; j < n - 1; j++) if (inZone(j) && !inZone(j - 1)) t++; return t; };
    if (body > 0 && !after.some(x => x < lo)) dem.push([lo, hi, rel(i) ?? 0, tests(j => b.l[j] <= hi)]);
    if (body < 0 && !after.some(x => x > hi)) sup.push([lo, hi, rel(i) ?? 0, tests(j => b.h[j] >= lo)]);
  }
  const dz = dem.filter(z => z[0] <= c).sort((x, y) => y[1] - x[1])[0], sz = sup.filter(z => z[1] >= c).sort((x, y) => x[0] - y[0])[0];
  // onaylı tepki: son girişten sonra en çok 3 mum içinde bölgenin ve önceki mum tepesinin üstünde (arzda altında) kapanan mum; kaç mum önce
  const react = (lo: number, hi: number, up: boolean) => {
    let entry = -1; for (let j = n - 1; j > 0; j--) { const inZ = up ? b.l[j] <= hi : b.h[j] >= lo, prevIn = up ? b.l[j - 1] <= hi : b.h[j - 1] >= lo; if (inZ && !prevIn) { entry = j; break; } }
    if (entry < 0) return null;
    for (let j = entry; j <= Math.min(n - 1, entry + 3); j++)
      if (up ? b.c[j] > b.o[j] && b.c[j] > hi && b.c[j] > b.h[j - 1] : b.c[j] < b.o[j] && b.c[j] < lo && b.c[j] < b.l[j - 1]) return n - 1 - j;
    return null;
  };
  if (dz) { out.demand = { lo: dz[0], hi: dz[1], dist: c / dz[1] - 1, vol: dz[2], tests: dz[3], react: react(dz[0], dz[1], true) }; out.inDemand = c <= dz[1] * 1.005; }
  if (sz) { out.supply = { lo: sz[0], hi: sz[1], dist: sz[0] / c - 1, vol: sz[2], tests: sz[3], react: react(sz[0], sz[1], false) }; out.inSupply = c >= sz[0] * 0.995; }
  // Trend kırılımı (4S ve G): son iki alçalan tepeden çizilen düşen trend çizgisinin yukarı kırılması, ya da yükselen diplerin aşağı kırılması
  if (checkBreak) {
    const hp = pivots(b.h, 4, true).filter(i => i >= n - 150 && i < n - 2), lp = pivots(b.l, 4, false).filter(i => i >= n - 150 && i < n - 2);
    const tryLine = (ps: number[], ys: number[], up: boolean) => {
      if (ps.length < 2) return null;
      const [p1, p2] = ps.slice(-2); if (up ? ys[p2] >= ys[p1] : ys[p2] <= ys[p1]) return null;
      const slope = (ys[p2] - ys[p1]) / (p2 - p1), line = (i: number) => ys[p2] + slope * (i - p2);
      for (let i = p2 + 1; i < n; i++) {
        const crossed = up ? b.c[i] > line(i) && b.c[i - 1] <= line(i - 1) : b.c[i] < line(i) && b.c[i - 1] >= line(i - 1);
        if (crossed) { const still = up ? c > line(n - 1) : c < line(n - 1); return n - 1 - i <= 12 && still ? { dir: (up ? "yukarı" : "aşağı") as "yukarı" | "aşağı", ago: n - 1 - i, level: line(n - 1), vol: rel(i) } : null; }
      }
      return null;
    };
    out.brk = tryLine(hp, b.h, true) ?? tryLine(lp, b.l, false);
  }
  return out;
}

function techScore(tfs: TF[]) {
  const why: string[] = []; let pts = 0;
  const add = (v: number, t: string) => { pts += v; why.push((v > 0 ? "+" : "") + v + " " + t); };
  const get = (x: string) => tfs.find(t => t.tf === x);
  const above = tfs.filter(t => t.aboveHaho).map(t => t.tf);
  if (above.length >= 3) add(1, `HAHO üstünde: ${above.join("-")}`); else if (above.length <= 1) add(-1, `HAHO altında: ${tfs.filter(t => t.aboveHaho === false).map(t => t.tf).join("-")}`);
  for (const x of ["4S", "G"]) {
    const t = get(x); if (!t) continue;
    // uyumsuzluk: ikinci dipte/tepede hacim azalmışsa (satış/alış kuruyor) puanlanır, değilse yalnız not edilir
    if (t.div === "boğa") t.divVol ? add(1, `${x} RSI pozitif uyumsuzluk, 2. dipte hacim düşük (${t.divAgo} mum önce)`) : why.push(`0 ${x} RSI pozitif uyumsuzluk (hacim onayı yok)`);
    if (t.div === "ayı") t.divVol ? add(-1, `${x} RSI negatif uyumsuzluk, 2. tepede hacim düşük (${t.divAgo} mum önce)`) : why.push(`0 ${x} RSI negatif uyumsuzluk (hacim onayı yok)`);
    if (t.stoch === "aşırı satım dönüşü") add(1, `${x} Stokastik RSI aşırı satımdan yukarı kesti`); if (t.stoch === "aşırı alım dönüşü") add(-1, `${x} Stokastik RSI aşırı alımdan aşağı kesti`);
    // kırılım: kırılım mumu hacmi 50 mum ortalamasının ≥1,5 katıysa puanlanır
    const bv = t.brk?.vol != null ? ` hacim ×${t.brk.vol.toFixed(1)}` : "";
    if (t.brk) (t.brk.vol ?? 0) >= 1.5 ? add(t.brk.dir === "yukarı" ? 1 : -1, `${x} ${t.brk.dir === "yukarı" ? "düşen trend yukarı" : "yükselen trend aşağı"} kırıldı,${bv} (${t.brk.ago} mum önce)`)
      : why.push(`0 ${x} trend ${t.brk.dir} kırıldı ama hacimsiz (${bv.trim() || "hacim yok"})`);
  }
  const g = get("G");
  // arz-talep: puansız bilgi satırı. 6 yıllık test (bt_sd.py): çok testli bölge BIST'te −2,6%/40g (t −4,4);
  // onaylı tepki (girişten ≤3 mum sonra bölge + önceki tepe üstünde yeşil kapanış) negatifliği siler ama avantaj üretmez (t < 1,5)
  const zt = (z: Zone) => `${z.tests ? z.tests + " kez test edildi" : "henüz test edilmedi"}${z.react != null ? `, onaylı tepki ${z.react} mum önce` : ", onaylı tepki yok"}`;
  if (g?.demand && (g.inDemand || g.demand.dist < 0.03)) why.push(`0 Günlük talep bölgesinde (${zt(g.demand)})`);
  if (g?.supply && (g.inSupply || g.supply.dist < 0.03)) why.push(`0 Günlük arz bölgesine yakın (${zt(g.supply)})`);
  // hacim profili (günlük): bilgi amaçlı, testte tek başına etkisiz çıktı → puan yok
  if (g?.vol.ud != null) why.push(`0 Günlük hacim: yükselen/düşen gün oranı ${g.vol.ud.toFixed(2)}, son mum ×${(g.vol.rel ?? 0).toFixed(1)}, OBV 20 mum ${g.vol.obvUp ? "yukarı" : "aşağı"}`);
  return { pts, why };
}

// ---------------------------------------------------------------- bilanço
const TYPES = ["TotalRevenue", "EBITDA", "OperatingIncome", "NetIncome", "TotalDebt", "NetDebt", "StockholdersEquity", "CashAndCashEquivalents",
  "CurrentAssets", "CurrentLiabilities", "FreeCashFlow", "OperatingCashFlow", "NetInterestIncome", "InterestIncome", "TotalAssets"];
async function fundamentals(t: string) {
  const now = Math.floor(Date.now() / 1000);
  const j = await yj(`https://query2.finance.yahoo.com/ws/fundamentals-timeseries/v1/finance/timeseries/${encodeURIComponent(t)}?type=${TYPES.map(x => "quarterly" + x).join(",")}&period1=${now - 86400 * 900}&period2=${now}`);
  const s: Record<string, { d: string; v: number }[]> = {};
  for (const r of j?.timeseries?.result ?? []) {
    const ty = r.meta?.type?.[0]; if (!ty) continue;
    s[ty.replace("quarterly", "")] = (r[ty] ?? []).filter((x: any) => x?.reportedValue?.raw != null).map((x: any) => ({ d: x.asOfDate, v: x.reportedValue.raw }));
  }
  return s;
}
// holding: konsolide tabloda iştiraklerin borcu ve azınlık payları var → borç oranı puanlanmaz, ana ortaklık kârı ve ROE esas alınır
function fundScore(s: Record<string, { d: string; v: number }[]>, bank: boolean, mkt: string, holding = false, cap: number | null = null) {
  const last = (k: string, i = 1) => { const a = s[k] ?? []; return a.length >= i ? a[a.length - i] : null; };
  const ttm = (k: string, back = 0) => { const a = s[k] ?? []; if (a.length < 4 + back) return null; return a.slice(a.length - 4 - back, a.length - back).reduce((x, y) => x + y.v, 0); };
  // büyüme: kümülatif tablo varsa aynı dönem (ör. 9A26 / 9A25), yoksa son çeyrek / bir yıl önceki çeyrek
  const Y = (s as any).__ytd as Record<string, { d: string; v: number }[]> | undefined;
  const yoy = (k: string) => {
    const a = Y?.[k];
    if (a?.length) { const c = a[a.length - 1], pd = `${+c.d.slice(0, 4) - 1}${c.d.slice(4, 7)}`, b = a.find(x => x.d.startsWith(pd)); return b && b.v !== 0 ? (c.v - b.v) / Math.abs(b.v) : null; }
    const l = last(k), b = last(k, 5); return l && b && b.v !== 0 ? (l.v - b.v) / Math.abs(b.v) : null;
  };
  const p = (x: number) => `%${(x * 100).toFixed(0)}`;
  const inf = INFL[mkt] ?? 0, why: string[] = []; let pts = 0;
  // reel büyüme: her dönemin tablosu kendi dönem sonu TL'si ile → (1+g)/(1+TÜFE) − 1
  const real = (g: number) => (1 + g) / (1 + inf) - 1;
  const gtxt = (g: number) => g > 2.5 ? `${trn(1 + g)} kat (düşük baz)` : inf ? `${p(g)} (reel ${real(g) >= 0 ? "+" : ""}${p(real(g))})` : p(g);
  const trn = (x: number) => x.toFixed(1).replace(".", ",");
  const ytdLbl = (k: string) => { const a = Y?.[k]; if (!a?.length) return "yıllık"; const mo = +a[a.length - 1].d.slice(5, 7); return mo === 12 ? "yıllık" : `${mo} aylık, yıllık`; };
  const add = (v: number, t: string) => { pts += v; why.push((v > 0 ? "+" : "") + v + " " + t); };

  const m: Record<string, number | string | null> = { period: last("NetIncome")?.d ?? last("TotalRevenue")?.d ?? null };
  if (bank) {
    m.niiYoY = yoy("NetInterestIncome"); m.niYoY = yoy("NetIncome"); m.niTTM = ttm("NetIncome");
    const eq = last("StockholdersEquity")?.v, eqPrev = last("StockholdersEquity", 5)?.v, ta = last("TotalAssets")?.v;
    m.roe = m.niTTM != null && eq ? (m.niTTM as number) / ((eq + (eqPrev ?? eq)) / 2) : null; m.eqAssets = eq && ta ? eq / ta : null;
    if (m.niiYoY != null) add((m.niiYoY as number) > inf ? 1 : -1, `Net faiz geliri ${ytdLbl("NetInterestIncome")} ${gtxt(m.niiYoY as number)}`);
    if (m.niYoY != null) add((m.niYoY as number) > inf ? 1 : -1, `Net kâr ${ytdLbl("NetIncome")} ${gtxt(m.niYoY as number)}`);
    if (m.roe != null) (m.roe as number) > (mkt === "bist" ? 0.30 : 0.12) ? add(1, `Özsermaye kârlılığı ${p(m.roe as number)}`) : (m.roe as number) < (mkt === "bist" ? 0.20 : 0.08) && add(-1, `Özsermaye kârlılığı ${p(m.roe as number)} (düşük)`);
  } else {
    m.revYoY = yoy("TotalRevenue"); m.ebitdaYoY = yoy("EBITDA"); m.opYoY = yoy("OperatingIncome"); m.niYoY = yoy("NetIncome");
    m.ebitdaTTM = ttm("EBITDA"); m.opTTM = ttm("OperatingIncome"); m.niTTM = ttm("NetIncome"); m.revTTM = ttm("TotalRevenue");
    const op0 = ttm("OperatingIncome", 4), rev0 = ttm("TotalRevenue", 4);
    m.opMargin = m.opTTM != null && m.revTTM ? (m.opTTM as number) / (m.revTTM as number) : null;
    m.opMarginPrev = op0 != null && rev0 ? op0 / rev0 : null;
    m.ebitdaMargin = m.ebitdaTTM != null && m.revTTM ? (m.ebitdaTTM as number) / (m.revTTM as number) : null;
    const nd = last("NetDebt")?.v ?? ((last("TotalDebt")?.v ?? NaN) - (last("CashAndCashEquivalents")?.v ?? 0));
    m.netDebt = isNaN(nd) ? null : nd; m.totalDebt = last("TotalDebt")?.v ?? null;
    m.ndEbitda = m.netDebt != null && m.ebitdaTTM ? (m.netDebt as number) / (m.ebitdaTTM as number) : null;
    const eq = last("StockholdersEquity")?.v; m.debtEquity = m.totalDebt != null && eq ? (m.totalDebt as number) / eq : null;
    const ca = last("CurrentAssets")?.v, cl = last("CurrentLiabilities")?.v; m.currentRatio = ca && cl ? ca / cl : null;
    m.fcfTTM = ttm("FreeCashFlow");
    m.holding = holding ? 1 : 0;
    const eqP = last("StockholdersEquity")?.v, eqP0 = last("StockholdersEquity", 5)?.v;
    m.roe = m.niTTM != null && eqP ? (m.niTTM as number) / ((eqP + (eqP0 ?? eqP)) / 2) : null;
    m.pb = cap && eqP ? cap / eqP : null;
    const pt = ttm("ProfitTotal"), mi = ttm("MinorityProfit"); m.minorityShare = pt && mi != null && pt > 0 ? mi / pt : null;
    if (holding) {
      // holding: ana ortaklık kârı, ROE ve faaliyet kârı; konsolide borç iştiraklere ait olduğundan puanlanmaz
      if (m.niYoY != null) add((m.niYoY as number) > inf ? 1 : -1, `Ana ortaklık net kârı ${ytdLbl("NetIncome")} ${gtxt(m.niYoY as number)}`);
      if (m.opYoY != null) add((m.opYoY as number) > inf ? 1 : -1, `Konsolide net faaliyet kârı ${ytdLbl("OperatingIncome")} ${gtxt(m.opYoY as number)}`);
      // BIST holdingleri TMS 29 (enflasyon muhasebesi) uygular: özkaynak bugünün TL'siyle şişer, ROE reel getiridir → eşikler buna göre
      if (m.roe != null) (m.roe as number) > (mkt === "bist" ? 0.12 : 0.12) ? add(1, `Ana ortaklık özsermaye kârlılığı ${p(m.roe as number)}${mkt === "bist" ? " (reel)" : ""}`) : (m.roe as number) < (mkt === "bist" ? 0.03 : 0.06) && add(-1, `Ana ortaklık özsermaye kârlılığı ${p(m.roe as number)} (düşük)`);
      if (m.opMargin != null && m.opMarginPrev != null) (m.opMargin as number) > (m.opMarginPrev as number) + 0.01 ? add(1, `Faaliyet marjı iyileşiyor (${p(m.opMarginPrev as number)} → ${p(m.opMargin as number)})`) : (m.opMargin as number) < (m.opMarginPrev as number) - 0.02 && add(-1, `Faaliyet marjı geriliyor (${p(m.opMarginPrev as number)} → ${p(m.opMargin as number)})`);
      if (m.niTTM != null && (m.niTTM as number) < 0) add(-1, "Son 12 ay ana ortaklık net zararı");
      const hist = Object.fromEntries(["TotalRevenue", "EBITDA", "OperatingIncome", "NetIncome", "TotalDebt"].map(k => [k, (s[k] ?? []).slice(-6)]));
      return { pts, why, m, hist };
    }
    if (m.ebitdaYoY != null) add((m.ebitdaYoY as number) > inf ? 1 : -1, `FAVÖK ${ytdLbl("EBITDA")} ${gtxt(m.ebitdaYoY as number)}`);
    if (m.opYoY != null) add((m.opYoY as number) > inf ? 1 : -1, `Net faaliyet kârı ${ytdLbl("OperatingIncome")} ${gtxt(m.opYoY as number)}`);
    if (m.opMargin != null && m.opMarginPrev != null) (m.opMargin as number) > (m.opMarginPrev as number) + 0.01 ? add(1, `Faaliyet marjı iyileşiyor (${p(m.opMarginPrev as number)} → ${p(m.opMargin as number)})`) : (m.opMargin as number) < (m.opMarginPrev as number) - 0.02 && add(-1, `Faaliyet marjı geriliyor (${p(m.opMarginPrev as number)} → ${p(m.opMargin as number)})`);
    if (m.ebitdaTTM != null && (m.ebitdaTTM as number) <= 0) add(-2, "Son 12 ay FAVÖK negatif");
    else if (m.ndEbitda != null) (m.ndEbitda as number) < 1.5 ? add(1, `Net borç/FAVÖK ${(m.ndEbitda as number).toFixed(1)}`) : (m.ndEbitda as number) > 3.5 && add(-1, `Net borç/FAVÖK ${(m.ndEbitda as number).toFixed(1)} (yüksek)`);
    if (m.niTTM != null && (m.niTTM as number) < 0) add(-1, "Son 12 ay net zarar");
  }
  const hist = Object.fromEntries(["TotalRevenue", "EBITDA", "OperatingIncome", "NetIncome", "NetInterestIncome", "TotalDebt"].map(k => [k, (s[k] ?? []).slice(-6)]));
  return { pts, why, m, hist };
}

// ---------------------------------------------------------------- BIST bilançosu: İş Yatırım mali tabloları (KAP'a bildirilen resmi tablolar)
// Değerler yıl başından kümülatif gelir; çeyreklik değere çevrilir (Q2 = 6A − 3A …). Bilanço kalemleri dönem sonu bakiyesidir.
const ISY = "https://www.isyatirim.com.tr/_layouts/15/IsYatirim.Website/Common/Data.aspx/MaliTablo";
async function isyTable(code: string, group: string, periods: [number, number][]) {
  const out: Record<string, (number | null)[]> = {};
  for (let i = 0; i < periods.length; i += 4) {
    const ps = periods.slice(i, i + 4); while (ps.length < 4) ps.push(ps[ps.length - 1]);
    const q = ps.map(([y, m], k) => `year${k + 1}=${y}&period${k + 1}=${m}`).join("&");
    const r = await fetch(`${ISY}?companyCode=${code}&exchange=TRY&financialGroup=${group}&${q}`, { headers: UA, signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error(`isyatirim ${r.status}`);
    const j = await r.json(); if (!j.ok || !j.value?.length) return null;
    for (const row of j.value) {
      const a = out[row.itemCode] ??= [];
      for (let k = 0; k < Math.min(4, periods.length - i); k++) { const v = row[`value${k + 1}`]; a[i + k] = v == null || v === "" ? null : +v; }
    }
  }
  return out;
}
async function isyFundamentals(code: string, bank: boolean) {
  // son 12 çeyrek sonu (yeniden eskiye)
  const now = new Date(), periods: [number, number][] = [];
  let y = now.getUTCFullYear(), m = Math.floor(now.getUTCMonth() / 3) * 3; if (m === 0) { y--; m = 12; }
  for (let i = 0; i < 12; i++) { periods.push([y, m]); m -= 3; if (m === 0) { y--; m = 12; } }
  const t = bank ? await isyTable(code, "UFRS_K", periods) ?? await isyTable(code, "UFRS", periods) : await isyTable(code, "XI_29", periods) ?? await isyTable(code, "UFRS_K", periods);
  if (!t) return null;
  const pick = (k: string) => t[k] ?? [];
  const keyRow = bank ? pick("3Z") : pick("3C");
  const first = keyRow.findIndex(v => v != null && v !== 0); if (first < 0) return null;
  const idx = periods.map((_, i) => i).filter(i => i >= first).reverse(); // eskiden yeniye
  const date = (i: number) => `${periods[i][0]}-${String(periods[i][1]).padStart(2, "0")}-${periods[i][1] === 3 || periods[i][1] === 12 ? "31" : "30"}`;
  const flow = (k: string | string[], f: (v: number) => number = v => v) => {
    const rows = (Array.isArray(k) ? k : [k]).map(pick), ytd = (i: number) => { let s = 0, any = false; for (const r of rows) if (r[i] != null) { s += r[i]!; any = true; } return any ? s : null; };
    const out: { d: string; v: number }[] = [];
    for (const i of idx) {
      const cur = ytd(i); if (cur == null) continue;
      if (periods[i][1] === 3) { out.push({ d: date(i), v: f(cur) }); continue; }
      const prev = ytd(i + 1); if (prev == null || periods[i + 1]?.[0] !== periods[i][0]) continue;
      out.push({ d: date(i), v: f(cur - prev) });
    }
    return out;
  };
  const ytdOf = (k: string | string[], f: (v: number) => number = v => v) => {
    const rows = (Array.isArray(k) ? k : [k]).map(pick);
    return idx.map(i => { let s = 0, any = false; for (const r of rows) if (r[i] != null) { s += r[i]!; any = true; } return any ? { d: date(i), v: f(s) } : null; }).filter(Boolean) as { d: string; v: number }[];
  };
  const stock = (k: string | string[]) => idx.map(i => { const v = (Array.isArray(k) ? k : [k]).reduce<number | null>((a, kk) => { const x = pick(kk)[i]; return x == null ? a : (a ?? 0) + x; }, null); return v == null ? null : { d: date(i), v }; }).filter(Boolean) as { d: string; v: number }[];
  const ni = bank ? (t["3ZA"] ? "3ZA" : "3Z") : (t["3Z"] ? "3Z" : "3L");
  if (bank) return { NetInterestIncome: flow("3C"), NetIncome: flow(ni), StockholdersEquity: stock("2O"), TotalAssets: stock("1Z"),
    __ytd: { NetInterestIncome: ytdOf("3C"), NetIncome: ytdOf(ni) } } as any;
  const op = flow("3H"), dep = flow("4B", v => Math.abs(v));
  const ebitda = op.map(o => { const d = dep.find(x => x.d === o.d); return { d: o.d, v: o.v + (d?.v ?? 0) }; });
  return {
    TotalRevenue: flow("3C"), OperatingIncome: op, EBITDA: ebitda, NetIncome: flow(t["3Z"] ? "3Z" : "3L"),
    TotalDebt: stock(["2AA", "2BA"]), CashAndCashEquivalents: stock("1AA"), StockholdersEquity: stock("2O"),
    CurrentAssets: stock("1A"), CurrentLiabilities: stock("2A"), TotalAssets: stock("1BL"),
    ProfitTotal: flow("3L"), MinorityProfit: flow("3LB"),
    __ytd: { TotalRevenue: ytdOf("3C"), OperatingIncome: ytdOf("3H"), NetIncome: ytdOf(ni),
      EBITDA: (() => { const o = ytdOf("3H"), d = ytdOf("4B", v => Math.abs(v)); return o.map(x => ({ d: x.d, v: x.v + (d.find(y => y.d === x.d)?.v ?? 0) })); })() },
  } as any;
}

// ---------------------------------------------------------------- ana akış
const SECTOR_TR: Record<string, string> = {
  "Financial Services": "Finans", Technology: "Teknoloji", Industrials: "Sanayi", "Consumer Cyclical": "Döngüsel tüketim", "Consumer Defensive": "Temel tüketim",
  Energy: "Enerji", "Basic Materials": "Temel malzeme", Utilities: "Altyapı (elektrik-gaz)", Healthcare: "Sağlık", "Communication Services": "İletişim", "Real Estate": "Gayrimenkul",
};
type Meta = Record<string, { sector: string | null; sectorTr: string | null; industry: string | null; cap: number | null; name: string | null }>;
async function quoteMeta(tickers: string[], meta: Meta) {
  for (let i = 0; i < tickers.length; i += 50) {
    const j = await yj(`https://query2.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(tickers.slice(i, i + 50).join(","))}&fields=sector,industry,marketCap,longName,shortName`, true);
    for (const r of j?.quoteResponse?.result ?? []) meta[r.symbol] = { sector: r.sector ?? null, sectorTr: SECTOR_TR[r.sector] ?? r.sector ?? null, industry: r.industry ?? null, cap: r.marketCap ?? null, name: r.longName ?? r.shortName ?? null };
  }
}
// tek hisse: şirket profili + bilanço + 4S-G-H-A teknik
async function deepOne(s: any, meta: Meta) {
  try {
    const [prof, fs, h1, d1, w1, m1] = await Promise.all([
      yj(`https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(s.ticker)}?modules=assetProfile`, true).catch(() => null),
      fundamentals(s.ticker).catch(() => ({})),
      bars(s.ticker, "60m", "730d"), bars(s.ticker, "1d", "2y"), bars(s.ticker, "1wk", "10y"), bars(s.ticker, "1mo", "10y"),
    ]);
    const ap = prof?.quoteSummary?.result?.[0]?.assetProfile ?? {};
    const sector = ap.sector ?? meta[s.ticker]?.sector ?? null, industry = ap.industry ?? meta[s.ticker]?.industry ?? null;
    const bank = /bank/i.test(industry ?? "") || (sector === "Financial Services" && !!(fs as any).NetInterestIncome?.length && !(fs as any).EBITDA?.length);
    // BIST: resmi tablolar (İş Yatırım / KAP); alınamazsa Yahoo'ya düşer
    let fsrc = "Yahoo Finance", fdata: any = fs;
    if (s.market === "bist") { const iy = await isyFundamentals(s.symbol, bank).catch(() => null); if (iy) { fdata = iy; fsrc = "İş Yatırım (KAP mali tabloları)"; } }
    const tfs = [analyze("4S", to4h(h1), true), analyze("G", d1, true), analyze("H", w1, false), analyze("A", m1, false)].filter(Boolean) as TF[];
    const holding = !bank && (/conglomerate/i.test(industry ?? "") || /holding/i.test((meta[s.ticker]?.name ?? s.name ?? "")));
    const tech = techScore(tfs), fund = { ...fundScore(fdata, bank, s.market, holding, meta[s.ticker]?.cap ?? null), source: fsrc };
    return { ticker: s.ticker, symbol: s.symbol, market: s.market, verdict: s.verdict, score: s.score,
      profile: { sector, sectorTr: SECTOR_TR[sector] ?? sector, industry, summary: ap.longBusinessSummary ?? null, employees: ap.fullTimeEmployees ?? null, site: ap.website ?? null },
      bank, holding, fund, tfs, tech, total: tech.pts + fund.pts, error: null,
      // son 150 günlük mum (hisse sayfası grafiği; toplu analizde saklanmaz). Zaman = borsa yerel günü, UTC gece yarısı
      bars: d1.t.slice(-150).map((ts, i) => { const k = d1.t.length - Math.min(150, d1.t.length) + i; return [Math.floor((ts + d1.off) / 86400) * 86400, +d1.o[k].toFixed(4), +d1.h[k].toFixed(4), +d1.l[k].toFixed(4), +d1.c[k].toFixed(4), Math.round(d1.v[k])]; }) };
  } catch (e) { return { ticker: s.ticker, symbol: s.symbol, market: s.market, verdict: s.verdict, error: String((e as Error).message ?? e) }; }
}

// ---------------------------------------------------------------- tek hisse haberleri (Bing News RSS; hisse sayfası, yalnızca istekle)
const ent = (s: string) => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/<[^>]+>/g, " ")
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
  .replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const xtag = (x: string, n: string) => x.match(new RegExp(`<${n}[^>]*>([\\s\\S]*?)</${n}>`, "i"))?.[1] ?? "";
async function stockNews(s: any, longName: string | null) {
  const tr = s.market === "bist";
  // şirket adının ayırt edici ilk kelimesi (A.Ş., Holding, Inc. gibi ekler atılır)
  const clean = (longName ?? s.name ?? s.symbol).replace(/\b(a\.?ş\.?|t\.?a\.?ş\.?|anonim|şirketi|sanayi|ticaret|ve|holding|inc\.?|corp\.?|corporation|company|co\.?|plc|ltd\.?|class [a-c]|common stock)\b/gi, " ").replace(/[.,]/g, " ").replace(/\s+/g, " ").trim();
  const key = (clean.split(" ")[0] || s.symbol).toLocaleLowerCase("tr");
  const q = tr ? `${s.symbol} ${clean.split(" ").slice(0, 2).join(" ")} hisse` : `${s.symbol} ${clean.split(" ").slice(0, 2).join(" ")} stock`;
  const r = await fetch(`https://www.bing.com/news/search?q=${encodeURIComponent(q)}&format=rss&setlang=${tr ? "tr-TR&cc=TR" : "en-US&cc=US"}`,
    { headers: { ...UA, "accept-language": tr ? "tr-TR,tr;q=0.9" : "en-US,en;q=0.9" }, signal: AbortSignal.timeout(12000) });
  if (!r.ok) throw new Error(`bing ${r.status}`);
  const x = await r.text(), seen = new Set<string>(), sym = s.symbol.toLocaleLowerCase("tr");
  return x.split(/<item[\s>]/i).slice(1, 31).map(it => {
    let u = ent(xtag(it, "link")) || ent(xtag(it, "guid"));
    const real = u.match(/[?&]url=([^&]+)/)?.[1]; if (real) u = decodeURIComponent(real);
    const d = new Date(ent(xtag(it, "pubDate")));
    return { t: ent(xtag(it, "title")), u, src: ent(xtag(it, "News:Source")) || "Bing", at: isNaN(+d) ? null : d.toISOString(), d: ent(xtag(it, "description")).slice(0, 220) };
  }).filter(i => {
    if (!i.t || !i.u) return false;
    const txt = (i.t + " " + i.d).toLocaleLowerCase("tr");
    if (!(txt.includes(key) || new RegExp(`(^|[^a-zçğıöşü0-9])${sym.replace(/[.-]/g, "\\$&")}([^a-zçğıöşü0-9]|$)`).test(txt))) return false;
    if (i.at && Date.now() - +new Date(i.at) > 14 * 864e5) return false;
    const k = i.t.toLocaleLowerCase("tr").replace(/[^a-zçğıöşü0-9]/g, "").slice(0, 60); if (seen.has(k)) return false; seen.add(k); return true;
  }).sort((a, b) => +new Date(b.at ?? 0) - +new Date(a.at ?? 0)).slice(0, 10);
}

Deno.serve(async (req: Request) => {
  if (!(await authorized(req))) return new Response("forbidden", { status: 403 });
  let scanId = 0;
  const body = await req.json().catch(() => ({}));
  // ---- tek hisse modu: swing_stock_start(ticker) → { ticker } → swing_stock satırı (derin analiz + haberler)
  if (typeof body.ticker === "string") {
    const tk: string = body.ticker;
    try {
      const { data: rows } = await sb.from("swing_scans").select("id,result").eq("status", "done").order("id", { ascending: false }).limit(1);
      const scan = rows?.[0]; if (!scan) throw new Error("tarama bulunamadı");
      const s = scan.result.markets.flatMap((m: any) => m.stocks.map((x: any) => ({ ...x, market: m.market }))).find((x: any) => x.ticker === tk);
      if (!s) throw new Error("hisse son taramada yok");
      const meta: Meta = {}; await quoteMeta([tk], meta).catch(() => {});
      const [{ bars, ...deep }, news]: [any, any] = await Promise.all([deepOne(s, meta), stockNews(s, meta[tk]?.name ?? null).then(items => ({ items, error: null as string | null })).catch(e => ({ items: [], error: String((e as Error).message ?? e) }))]);
      const data = { at: new Date().toISOString(), scanId: scan.id, meta: meta[tk] ?? null, deep, news, bars: bars ?? [] };
      await sb.from("swing_stock").upsert({ ticker: tk, status: "done", updated_at: new Date().toISOString(), error: null, data });
      return new Response("ok");
    } catch (e) {
      await sb.from("swing_stock").upsert({ ticker: tk, status: "error", updated_at: new Date().toISOString(), error: String((e as Error).message ?? e) });
      return new Response(String(e), { status: 500 });
    }
  }
  try {
    // deneme modu: veritabanına yazmadan BIST bilanço puanını döndürür ({ test: [["GARAN", true], ["KCHOL", false]] })
    if (Array.isArray(body.test)) {
      const r = await Promise.all(body.test.map(async ([c, b]: [string, boolean]) => { const f = await isyFundamentals(c, b).catch(e => String(e)); return [c, typeof f === "string" || !f ? f : { last: Object.fromEntries(Object.entries(f as Record<string, any[]>).filter(([k]) => k !== "__ytd").map(([k, v]) => [k, v.slice(-5)])), score: fundScore(f as any, b, "bist", /HOL/.test(c)) }]; }));
      return new Response(JSON.stringify(Object.fromEntries(r)), { headers: { "content-type": "application/json" } });
    }
    scanId = body.scan_id ?? 0;
    const q = sb.from("swing_scans").select("id,result").eq("status", "done").order("id", { ascending: false }).limit(1);
    const { data: rows } = scanId ? await sb.from("swing_scans").select("id,result").eq("id", scanId) : await q;
    const scan = rows?.[0]; if (!scan) throw new Error("tarama bulunamadı");
    scanId = scan.id;
    const stocks: any[] = scan.result.markets.flatMap((m: any) => m.stocks.map((s: any) => ({ ...s, market: m.market })));
    // 1) sektör + piyasa değeri (50'lik gruplar)
    const meta: Meta = {};
    await quoteMeta(stocks.map(s => s.ticker), meta);
    // 2) ALINIR + KARARSIZ + portföydeki hisseler: derin analiz (öneriler portföy hisselerinin temel/teknik puanını buradan okur)
    const { data: pos } = await sb.from("swing_positions").select("ticker").eq("kind", "stock");
    const owned = new Set((pos ?? []).map((p: any) => p.ticker));
    const pick = stocks.filter(s => s.verdict === "ALINIR" || s.verdict === "KARARSIZ" || owned.has(s.ticker));
    const deep = await pool(pick, 4, s => deepOne(s, meta));
    const payload = { at: new Date().toISOString(), scanId, meta, deep: Object.fromEntries(deep.map(({ bars: _b, ...d }: any) => [d.ticker, d])) };
    await sb.rpc("swing_deep_put", { payload, err: null });
    return new Response("ok");
  } catch (e) {
    await sb.rpc("swing_deep_put", { payload: null, err: String((e as Error).message ?? e) });
    return new Response(String(e), { status: 500 });
  }
});
