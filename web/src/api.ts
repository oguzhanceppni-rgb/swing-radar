// Tüm veri, görüntüleyenin Supabase connector'ı (execute_sql) üzerinden gelir — sayfa CSP nedeniyle başka hiçbir yere istek atamaz.
const SERVER = "Supabase", PROJECT = "dewbnadsgvpmpiezmfgt";

// exitRule "weeklyHaho": ilk stop + haftalık kapanış < haftalık HAHO, en çok maxDays gün. Eski taramalarda yok (2R hedef).
export type Plan = { entry: number; stop: number; target: number; riskPct: number; exitRule?: string; haho?: number | null; maxDays?: number };
export type Hist = { n: number; target?: number; haho?: number; stop: number; time: number; win: number | null; avgR: number | null; avgDays?: number | null };
// sabit hedefli (portföy, eski taramalar) ya da haftalık HAHO çıkışlı (yeni taramalar)
export type MCFixed = { target: number; stop: number; neither: number; seed: number; paths: number };
export type MCExit = { stop: number; haho: number; time: number; win: number; meanR: number; medR: number; meanPct: number; medDays: number; seed: number; paths: number; maxDays: number };
export type MC = MCFixed | MCExit;
export const isExitMc = (m: MC): m is MCExit => "haho" in m;
export type Kronos = { pUp20: number; med20: number; med40: number; p10: number; p90: number; path: number[] } | null;
export type Verdict = "ALINIR" | "KARARSIZ" | "ALINMAZ";
export type Stock = {
  ticker: string; symbol: string; name: string; sector: string | null; market: "bist" | "us";
  close: number; chg1d: number; chg20: number; rs: number; rsi: number; tt: boolean; setups: string[];
  plan: Plan; riskPct: number; atr: number; liquid: boolean; regimeOk: boolean;
  hist: Hist; histSetup: string; mc: MC; kronos: Kronos; score: number; verdict: Verdict; why: string[];
  earn?: { date: string; days: number; est: boolean; src: string } | null; ern?: { good: boolean; period: string; g: number; gp: number | null } | null;
  hasBars?: boolean; rrg?: number[][] | null; live?: number | null; liveAt?: string | null; liveChg?: number | null; liveOpen?: boolean;
};
export type Regime = { ok: boolean; close: number; sma50: number; sma200: number; chg20: number; spark: number[] };
export type Market = { market: "bist" | "us"; bench: string; regime: Regime; count: number; stocks: Stock[]; asOf: string; source?: string };
export type Params = { hold: number; atrK: number; r: number; kronos: boolean; maxScore?: number; mcPaths?: number; source?: "cloud" | "local" };
export type Scan = { id: number; created_at: string; createdAt: string; seconds: number; params: Params; markets: Market[] };
export type Bar = [number, number, number, number, number, number];
export type Trade = { id: number; ticker: string; symbol: string; market: string; entry: number; stop: number; target: number; shares: number | null; exit: number | null; note: string | null; opened_at: string; closed_at: string | null };
export type Settings = { capital_try: number; capital_usd: number; risk_pct: number };
export type Phase = { phase: "universe" | "data" | "rules"; done?: number; total?: number; source?: string } | "done";
export type ScanState = { status: "queued" | "running" | "done" | "error"; error: string | null; progress: Partial<Record<"bist" | "us", Phase>>; sec: number };

type Mcp = { callTool: (s: string, t: string, i: unknown, o?: unknown) => Promise<any> };
let mcpP: Promise<Mcp | null> | null = null;
const getMcp = () => (mcpP ??= (window as any).claude?.use?.("mcp") ?? Promise.resolve(null));

const q = (s: unknown) => "'" + String(s ?? "").replace(/'/g, "''") + "'";
const n = (v: unknown) => { const x = Number(v); if (!Number.isFinite(x)) throw new Error("Geçersiz sayı"); return x; };
const parse = <T,>(v: unknown): T => (typeof v === "string" ? JSON.parse(v) : v) as T;

// Yalnızca yerel geliştirme (vite dev): Supabase yerine ../last_scan.json + sahte tarama akışı. Yayın paketine girmez.
export async function sql<T = any>(query: string): Promise<T[]> {
  if (import.meta.env.DEV && !(window as any).claude) return (await import("./dev")).devSql(query) as any;
  const mcp = await getMcp();
  if (!mcp) throw { code: "not_granted" };
  const r = await mcp.callTool(SERVER, "execute_sql", { project_id: PROJECT, query }, { cache: false });
  let t: any = typeof r.payload === "string" ? r.payload : r.payload?.result ?? r.content?.[0]?.text ?? "";
  try { const j = JSON.parse(t); if (Array.isArray(j)) return j; if (typeof j?.result === "string") t = j.result; } catch { /* zarf metni */ }
  if (/ERROR:|error:/.test(String(t)) && !/untrusted-data/.test(String(t))) throw new Error(String(t).slice(0, 200));
  const m = String(t).match(/<untrusted-data-([\w-]+)>\s*(\[[\s\S]*?\])\s*<\/untrusted-data-\1>/);
  return m ? JSON.parse(m[2]) : [];
}

// Özet: mumlar ve sparkline'lar çıkarılır; mumlar hisse açılınca ayrıca çekilir.
const SUMMARY = (where: string) => `
  select id, created_at, result - 'markets' as meta,
    (select jsonb_agg((m - 'stocks') || jsonb_build_object('stocks',
       (select jsonb_agg((s - 'bars' - 'spark') || jsonb_build_object('hasBars', s ? 'bars')) from jsonb_array_elements(m->'stocks') s)))
     from jsonb_array_elements(result->'markets') m) as markets
  from swing_scans ${where}`;
const toScan = (r: any): Scan => ({ id: r.id, created_at: r.created_at, ...parse<any>(r.meta), markets: parse<Market[]>(r.markets) });

export async function latestScan(): Promise<Scan | null> {
  const [r] = await sql(SUMMARY("where status = 'done' order by id desc limit 1"));
  return r ? toScan(r) : null;
}
export async function latestScanId(): Promise<number | null> {
  const [r] = await sql<{ id: number | null }>("select max(id) as id from swing_scans where status = 'done'");
  return r?.id != null ? +r.id : null;
}

// ---------------------------------------------------------------- tek fiyat kaynağı: portföy fiyat yenilemesi taramadaki tüm hisselerin son fiyatını da yazar
// [son, önceki kapanış, zaman (sn), seans açık mı]. Arama, şerit, ısı haritası ve tablo bunu taramanın anlık görüntüsüne tercih eder.
export type Live = Record<string, [number, number, number, boolean]>;
export async function liveState(): Promise<{ at: string | null; live: Live; status: string; updated_at: string | null }> {
  const [r] = await sql(`select data->>'at' as at, coalesce(data->'live', '{}'::jsonb) as live, status, updated_at from swing_quotes where id = 1`);
  return r ? { at: r.at, live: parse<Live>(r.live) ?? {}, status: r.status, updated_at: r.updated_at } : { at: null, live: {}, status: "", updated_at: null };
}
export function withLive(s: Scan, live: Live): Scan {
  const t0 = Date.parse(s.created_at) / 1000 - 60;
  return { ...s, markets: s.markets.map(m => ({ ...m, stocks: m.stocks.map(x => {
    const q = live[x.ticker]; if (!q || q[2] < t0) return x;
    return { ...x, live: q[0], liveChg: q[0] / q[1] - 1, liveAt: new Date(q[2] * 1000).toISOString(), liveOpen: q[3] };
  }) })) };
}
// gösterim: varsa son fiyat, yoksa taramadaki kapanış
export const pxNow = (s: Stock) => s.live ?? s.close;
export const chgDay = (s: Stock) => s.liveChg ?? s.chg1d;
export const chg20Now = (s: Stock) => (s.live != null ? (s.live / s.close) * (1 + s.chg20) - 1 : s.chg20);

export async function scanById(id: number): Promise<Scan | null> {
  const [r] = await sql(SUMMARY(`where id = ${n(id)} and status = 'done'`));
  return r ? toScan(r) : null;
}
export async function scans() {
  return sql<{ id: number; created_at: string; seconds: number; source: string; kronos: boolean; picks: string | null; n: number }>(`
    select id, created_at, (result->>'seconds')::int seconds, source, coalesce((result->'params'->>'kronos')::boolean, false) kronos,
      (select count(*) from jsonb_array_elements(result->'markets') m, jsonb_array_elements(m->'stocks') s where s->>'verdict' = 'ALINIR')::int n,
      (select string_agg(s->>'symbol', ' · ') from jsonb_array_elements(result->'markets') m, jsonb_array_elements(m->'stocks') s where s->>'verdict' = 'ALINIR') picks
    from swing_scans where status = 'done' order by id desc limit 20`);
}
export async function bars(scanId: number, ticker: string): Promise<Bar[]> {
  const [r] = await sql(`select s->'bars' as bars from swing_scans, jsonb_array_elements(result->'markets') m, jsonb_array_elements(m->'stocks') s
    where id = ${n(scanId)} and s->>'ticker' = ${q(ticker)} limit 1`);
  return r?.bars ? parse<Bar[]>(r.bars) : [];
}

// Tarama: bulutta (edge fn, Kronos'suz) iki piyasa paralel çalışır; sayfa ilerlemeyi yoklar.
export async function startScan(): Promise<number> {
  const [r] = await sql<{ id: number }>("select swing_start() as id");
  return n(r.id);
}
export async function scanState(id: number): Promise<ScanState | null> {
  const [r] = await sql(`select status, error, progress, extract(epoch from coalesce(finished_at, now()) - created_at)::int sec from swing_scans where id = ${n(id)}`);
  return r ? { ...r, progress: parse(r.progress) } : null;
}

export const trades = () => sql<Trade>("select * from swing_trades order by closed_at is not null, opened_at desc");
export const addTrade = (s: Stock, shares: number | null, note: string) => sql(
  `insert into swing_trades(ticker, symbol, market, entry, stop, target, shares, note) values (${q(s.ticker)}, ${q(s.symbol)}, ${q(s.market)},
   ${n(s.plan.entry)}, ${n(s.plan.stop)}, ${n(s.plan.target)}, ${shares == null ? "null" : n(shares)}, ${q(note)}) returning id`);
export const closeTrade = (id: number, exit: number) => sql(`update swing_trades set exit = ${n(exit)}, closed_at = now() where id = ${n(id)}`);
export const deleteTrade = (id: number) => sql(`delete from swing_trades where id = ${n(id)}`);

export async function settings(): Promise<Settings> {
  const [r] = await sql("select capital_try, capital_usd, risk_pct from swing_settings where id = 1");
  return r ? { capital_try: +r.capital_try, capital_usd: +r.capital_usd, risk_pct: +r.risk_pct } : { capital_try: 100000, capital_usd: 5000, risk_pct: 1 };
}
export const saveSettings = (s: Settings) => sql(
  `update swing_settings set capital_try = ${n(s.capital_try)}, capital_usd = ${n(s.capital_usd)}, risk_pct = ${n(s.risk_pct)} where id = 1`);

// risk tabanlı adet: (sermaye × risk%) ÷ (giriş − stop), sermayeyi aşmayan tam lot
export const sizeFor = (s: Stock, st: Settings) => {
  const cap = s.market === "bist" ? st.capital_try : st.capital_usd;
  const per = s.plan.entry - s.plan.stop;
  if (per <= 0) return 0;
  return Math.max(0, Math.min(Math.floor((cap * st.risk_pct) / 100 / per), Math.floor(cap / s.plan.entry)));
};

// ---------------------------------------------------------------- portföy
export type Position = { id: number; symbol: string; ticker: string; kind: "stock" | "fund"; name: string | null; qty: number; cost: number;
  stop: number | null; target1: number | null; target2: number | null; manual_price: number | null; manual_at: string | null; note: string | null;
  horizon?: "swing" | "uzun"; proxy?: string | null };
export type Order = { id: number; symbol: string; ticker: string; side: "al" | "sat"; price: number | null; amount: number | null; qty: number | null;
  valid_until: string | null; status: "bekliyor" | "gerçekleşti" | "iptal"; note: string | null };
export type Quote = { last: number; prev: number; chg1d: number; at: string | null; partial: boolean; tt: boolean; rsi: number; atr: number;
  sma50: number | null; sma200: number | null; setups: string[]; bars: Bar[] };
export type Quotes = { at: string; quotes: Record<string, Quote>; mc: Record<string, MCFixed>; maxScore: number;
  scan: Record<string, { score: number; verdict: Verdict; why: string[]; rs: number; setups: string[] }>; live?: Live };
export type Advice = { id: number; created_at: string; updated_at: string; symbol: string; action: string; title: string; body: string; status: "aktif" | "yapildi" | "gecersiz"; prio: number; source: string | null; prev_action?: string | null };
export type Portfolio = { advice: Advice[]; positions: Position[]; orders: Order[]; cash: number; quotes: Quotes | null; qstatus: string; qerror: string | null; requested_at: string | null };

const num = (v: any) => (v == null ? null : +v);
export async function portfolio(): Promise<Portfolio> {
  const [r] = await sql(`select
    (select coalesce(jsonb_agg(p order by p.id), '[]') from swing_positions p) positions,
    (select coalesce(jsonb_agg(a order by a.status = 'aktif' desc, a.prio, a.id), '[]') from swing_advice a where a.status = 'aktif' or a.updated_at > now() - interval '21 days') advice,
    (select coalesce(jsonb_agg(o order by o.status = 'bekliyor' desc, o.valid_until nulls last, o.id), '[]') from swing_orders o where o.status = 'bekliyor' or o.created_at > now() - interval '14 days') orders,
    (select cash_try from swing_settings where id = 1) cash,
    (select data from swing_quotes where id = 1) quotes, (select status from swing_quotes where id = 1) qstatus,
    (select error from swing_quotes where id = 1) qerror, (select requested_at from swing_quotes where id = 1) requested_at`);
  const pos = parse<any[]>(r.positions).map(p => ({ ...p, qty: +p.qty, cost: +p.cost, stop: num(p.stop), target1: num(p.target1), target2: num(p.target2), manual_price: num(p.manual_price) }));
  const ord = parse<any[]>(r.orders).map(o => ({ ...o, price: num(o.price), amount: num(o.amount), qty: num(o.qty) }));
  return { advice: parse<Advice[]>(r.advice ?? "[]"), positions: pos, orders: ord, cash: +r.cash, quotes: r.quotes ? parse<Quotes>(r.quotes) : null, qstatus: r.qstatus, qerror: r.qerror, requested_at: r.requested_at };
}
export const refreshQuotes = () => sql("select swing_quotes_start() as t");
export async function quotesState() {
  const [r] = await sql(`select status, error, updated_at from swing_quotes where id = 1`);
  return r as { status: string; error: string | null; updated_at: string | null };
}
const nn = (v: number | null | undefined) => (v == null || !Number.isFinite(+v) ? "null" : n(v));
export const savePosition = (p: Omit<Position, "id" | "manual_price" | "manual_at"> & { id?: number }) => p.id
  ? sql(`update swing_positions set symbol=${q(p.symbol)}, ticker=${q(p.ticker)}, kind=${q(p.kind)}, name=${q(p.name)}, qty=${n(p.qty)}, cost=${n(p.cost)},
      stop=${nn(p.stop)}, target1=${nn(p.target1)}, target2=${nn(p.target2)}, note=${q(p.note)}, horizon=${q(p.horizon === "uzun" ? "uzun" : "swing")}, proxy=${p.proxy ? q(p.proxy) : "null"} where id=${n(p.id)}`)
  : sql(`insert into swing_positions(symbol, ticker, kind, name, qty, cost, stop, target1, target2, note, horizon, proxy) values (${q(p.symbol)}, ${q(p.ticker)}, ${q(p.kind)}, ${q(p.name)},
      ${n(p.qty)}, ${n(p.cost)}, ${nn(p.stop)}, ${nn(p.target1)}, ${nn(p.target2)}, ${q(p.note)}, ${q(p.horizon === "uzun" ? "uzun" : "swing")}, ${p.proxy ? q(p.proxy) : "null"})`);
export const deletePosition = (id: number) => sql(`delete from swing_positions where id = ${n(id)}`);
export const setFundPrice = (id: number, price: number) => sql(`update swing_positions set manual_price = ${n(price)}, manual_at = current_date where id = ${n(id)}`);
export const setCash = (v: number) => sql(`update swing_settings set cash_try = ${n(v)} where id = 1`);
export const addOrder = (o: Omit<Order, "id" | "status">) => sql(`insert into swing_orders(symbol, ticker, side, price, amount, qty, valid_until, note)
  values (${q(o.symbol)}, ${q(o.ticker)}, ${q(o.side)}, ${nn(o.price)}, ${nn(o.amount)}, ${nn(o.qty)}, ${o.valid_until ? q(o.valid_until) : "null"}, ${q(o.note)})`);
export const setAdviceStatus = (id: number, status: Advice["status"]) => sql(`update swing_advice set status = ${q(status)}, updated_at = now() where id = ${n(id)}`);
export const setOrderStatus = (id: number, status: Order["status"]) => sql(`update swing_orders set status = ${q(status)} where id = ${n(id)}`);
export async function ownedTickers(): Promise<string[]> {
  if (import.meta.env.DEV && !(window as any).claude) return ["GARAN.IS", "KCHOL.IS"];
  return (await sql<{ ticker: string }>("select ticker from swing_positions")).map(r => r.ticker);
}

// ---------------------------------------------------------------- haberler (swing-news edge fn; yalnızca istekle)
export type NewsItem = { t: string; u: string; src: string; at: string | null; d?: string; score?: number };
export type CalEvent = { at: string | null; time: string; country: string; cur: string; stars: number; ev: string; act: string; fc: string; prev: string; good: number; why: string; mine: boolean };
export type News = { at: string; sectors?: Record<string, { tr: string; items: NewsItem[] }>; stocks: { symbol: string; name?: string; owned: boolean; watch?: boolean; items: NewsItem[]; error: string | null }[]; national: NewsItem[]; global: NewsItem[]; calendar: CalEvent[]; errors: string[] };
export async function news() {
  const [r] = await sql(`select status, error, updated_at, data from swing_news where id = 1`);
  return { status: r?.status as string, error: r?.error as string | null, updated_at: r?.updated_at as string | null, data: r?.data ? parse<News>(r.data) : null };
}
export const refreshNews = () => sql("select swing_news_start() as t");
export async function newsAge() {
  const [r] = await sql("select status, data->>'at' as at from swing_news where id = 1");
  return { status: (r?.status ?? "") as string, at: (r?.at ?? null) as string | null };
}

// ---------------------------------------------------------------- ileriye dönük takip (swing-track edge fn; yalnızca istekle)
export type TrackHz = { ret: number; ex: number } | null;
export type TrackTrade = { id: number; ticker: string; symbol: string; market: "bist" | "us"; verdict: Verdict; score: number; date: string; entry: number; stop: number;
  status: string; exitDate?: string | null; exitPx?: number; days?: number; ret?: number; bench?: number | null; excess?: number | null; h20?: TrackHz; h40?: TrackHz; h60?: TrackHz };
export type TrackSum = { n: number; closed: number; open: number; win: number | null; avg: number | null; avgEx: number | null; openAvg: number | null; openEx: number | null;
  h20: { n: number; hit: number | null; ex: number | null }; h40: { n: number; hit: number | null; ex: number | null }; h60: { n: number; hit: number | null; ex: number | null } };
export type Track = { at: string; since: string | null; signals: number; trades: TrackTrade[]; summary: Record<string, TrackSum> };
export async function track() {
  const [r] = await sql(`select status, error, updated_at, data from swing_track where id = 1`);
  return { status: r?.status as string, error: r?.error as string | null, updated_at: r?.updated_at as string | null, data: r?.data ? parse<Track>(r.data) : null };
}
export const refreshTrack = () => sql("select swing_track_start() as t");

// ---------------------------------------------------------------- derin analiz + ısı haritası (swing-deep edge fn; yalnızca istekle)
export type DeepTF = { tf: string; close: number; haho: number | null; aboveHaho: boolean | null; touchHaho: boolean; rsi: number | null; div: "boğa" | "ayı" | null; divAgo: number | null;
  stK: number | null; stD: number | null; stoch: string | null; demand: { lo: number; hi: number; dist: number } | null; supply: { lo: number; hi: number; dist: number } | null;
  inDemand: boolean; inSupply: boolean; brk: { dir: "yukarı" | "aşağı"; ago: number; level: number; vol?: number | null } | null;
  divVol?: boolean | null; vol?: { rel: number | null; ud: number | null; obvUp: boolean | null } };
export type DeepStock = { ticker: string; symbol: string; market: string; verdict: string; score?: number; error: string | null;
  profile?: { sector: string | null; sectorTr: string | null; industry: string | null; summary: string | null; employees: number | null; site: string | null };
  bank?: boolean; fund?: { pts: number; why: string[]; m: Record<string, number | string | null>; hist: Record<string, { d: string; v: number }[]> };
  tfs?: DeepTF[]; tech?: { pts: number; why: string[] }; total?: number };
export type DeepMeta = { sector: string | null; sectorTr: string | null; industry: string | null; cap: number | null; name: string | null };
export type Deep = { at: string; scanId: number; meta: Record<string, DeepMeta>; deep: Record<string, DeepStock> };
export async function deep() {
  const [r] = await sql(`select status, error, updated_at, scan_id, data from swing_deep where id = 1`);
  return { status: r?.status as string, error: r?.error as string | null, scanId: r?.scan_id ? +r.scan_id : null, data: r?.data ? parse<Deep>(r.data) : null };
}
export const startDeep = (scanId: number) => sql(`select swing_deep_start(${n(scanId)}) as t`);

// ---------------------------------------------------------------- hisse sayfası: tek hisse derin analiz + haberler (swing-deep tek hisse modu; yalnızca istekle)
export type StockExtra = { at: string; scanId: number; deep: DeepStock; news: { items: NewsItem[]; error: string | null }; bars?: Bar[] };
export async function stockExtra(ticker: string) {
  const [r] = await sql(`select status, error, updated_at, data from swing_stock where ticker = ${q(ticker)}`);
  return r ? { status: r.status as string, error: r.error as string | null, updated_at: r.updated_at as string | null, data: r.data ? parse<StockExtra>(r.data) : null } : null;
}
export const startStockExtra = (ticker: string) => sql(`select swing_stock_start(${q(ticker)}) as t`);
export const adviceFor = (symbol: string) => sql<Advice>(`select * from swing_advice where status = 'aktif' and symbol = ${q(symbol)} order by prio, id`);

// önceki günün taraması: adaylar tablosunda puan değişimi ve yeni girenler için (aynı gün yeniden taramalar sayılmaz)
export type PrevScore = Record<string, { score: number; verdict: Verdict }>;
export async function prevScores(scanId: number): Promise<{ at: string; by: PrevScore } | null> {
  const [r] = await sql(`select p.created_at, (select jsonb_object_agg(s->>'ticker', jsonb_build_object('score', (s->>'score')::int, 'verdict', s->>'verdict'))
      from jsonb_array_elements(p.result->'markets') m, jsonb_array_elements(m->'stocks') s) as by
    from swing_scans p, swing_scans c where c.id = ${n(scanId)} and p.status = 'done' and p.id < c.id
      and (p.created_at at time zone 'Europe/Istanbul')::date < (c.created_at at time zone 'Europe/Istanbul')::date
    order by p.id desc limit 1`);
  return r?.by ? { at: r.created_at, by: parse<PrevScore>(r.by) } : null;
}

// ---------------------------------------------------------------- takip listesi (izlenen hisseler; portföyde olmak zorunda değil)
export type Watch = { ticker: string; symbol: string; market: "bist" | "us"; name: string | null; added_at: string };
export const watchList = () => sql<Watch>("select ticker, symbol, market, name, added_at from swing_watch order by added_at");
export const watchAdd = (s: { ticker: string; symbol: string; market: string; name: string | null }) => sql(`insert into swing_watch(ticker, symbol, market, name) values (${q(s.ticker)}, ${q(s.symbol)}, ${q(s.market)}, ${q(s.name)}) on conflict (ticker) do nothing`);
export const watchRemove = (ticker: string) => sql(`delete from swing_watch where ticker = ${q(ticker)}`);
