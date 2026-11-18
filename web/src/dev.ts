// Yalnızca `vite dev` için sahte veri katmanı: ../last_scan.json + ../dev_portfolio.json + sahte tarama/yenileme. Üretim paketine girmez.
let scan: any = null, pf: any = null;
const load = async () => (scan ??= await (await fetch("/@fs/C:/Users/oguzh/swing-radar/dev_scan7.json")).json());
const loadPf = async () => (pf ??= await (await fetch("/@fs/C:/Users/oguzh/swing-radar/dev_portfolio.json")).json());
let watchDev: any[] = [{ ticker: "THYAO.IS", symbol: "THYAO", market: "bist", name: "Türk Hava Yolları", added_at: "2026-11-14T08:00:00Z" }];
let started = 0, qStarted = 0, nStarted = 0, sStarted = 0, nextId = 100;
const settings = { capital_try: 100000, capital_usd: 5000, risk_pct: 1 };

export async function devSql(qs: string): Promise<any[]> {
  const r = await load(), p = await loadPf();
  await new Promise(s => setTimeout(s, 120)); // ağ gecikmesi taklidi
  if (qs.includes("swing_start()")) { started = Date.now(); return [{ id: 99 }]; }
  if (qs.includes("swing_deep_start(")) return [{ t: new Date().toISOString() }];
  if (qs.includes("from swing_deep")) { const dd = await (await fetch("/@fs/C:/Users/oguzh/swing-radar/dev_deep.json")).json(); return [{ status: "done", error: null, updated_at: dd.at, scan_id: dd.scanId, data: dd }]; }
  if (qs.includes("swing_track_start()")) return [{ t: new Date().toISOString() }];
  if (qs.includes("from swing_track")) { const tr = await (await fetch("/@fs/C:/Users/oguzh/swing-radar/dev_track.json")).json(); return [{ status: "done", error: null, updated_at: new Date().toISOString(), data: { ...tr, at: new Date().toISOString() } }]; }
  if (qs.includes("swing_news_start()")) { nStarted = Date.now(); return [{ t: new Date().toISOString() }]; }
  if (qs.includes("from swing_news")) {
    const news = await (await fetch("/@fs/C:/Users/oguzh/swing-radar/dev_news.json")).json(), done = Date.now() - nStarted > 2500;
    return [{ status: done ? "done" : "running", error: null, updated_at: done ? new Date().toISOString() : news.at, data: done ? { ...news, at: nStarted ? new Date().toISOString() : news.at } : news }];
  }
  if (qs.includes("swing_quotes_start()")) { qStarted = Date.now(); return [{ t: new Date().toISOString() }]; }
  if (qs.includes("from swing_quotes where id = 1") && qs.startsWith("select status")) {
    const done = Date.now() - qStarted > 2500;
    return [{ status: done ? "done" : "running", error: null, updated_at: done ? new Date().toISOString() : p.quotes.at }];
  }
  if (qs.includes("extract(epoch from coalesce(finished_at")) {
    const t = (Date.now() - started) / 1000;
    const ph = (o: number) => (t < o ? { phase: "universe" } : t < o + 4 ? { phase: "data", done: Math.min(101, Math.round(((t - o) / 4) * 101)), total: 101, source: "KAP" } : t < o + 5.5 ? { phase: "rules", done: 99, total: 101 } : "done");
    const progress = { us: ph(0.6), bist: ph(1.1) };
    return [{ status: progress.us === "done" && progress.bist === "done" ? "done" : "running", error: null, progress, sec: Math.round(t) }];
  }
  // portföy
  if (qs.includes("from swing_positions p) positions")) {
    return [{ advice: p.advice ?? [], positions: p.positions, orders: p.orders, cash: p.cash, quotes: { ...p.quotes, at: qStarted ? new Date().toISOString() : p.quotes.at }, qstatus: "done", qerror: null, requested_at: p.quotes.at }];
  }
  if (qs.startsWith("update swing_positions set manual_price")) {
    const [, price, id] = qs.match(/manual_price = ([\d.]+).*id = (\d+)/)!;
    const x = p.positions.find((y: any) => y.id === +id); x.manual_price = +price; x.manual_at = new Date().toISOString().slice(0, 10); return [];
  }
  if (qs.startsWith("update swing_settings set cash_try")) { p.cash = +qs.match(/cash_try = ([\d.]+)/)![1]; return []; }
  if (qs.startsWith("update swing_advice set status")) {
    const [, st, id] = qs.match(/status = '([^']+)'.*where id = (\d+)/)!; const a = p.advice.find((o: any) => o.id === +id); a.status = st; a.updated_at = new Date().toISOString(); return [];
  }
  if (qs.startsWith("update swing_orders set status")) {
    const [, st, id] = qs.match(/status = '([^']+)' where id = (\d+)/)!; p.orders.find((o: any) => o.id === +id).status = st; return [];
  }
  if (qs.startsWith("delete from swing_positions")) { const id = +qs.match(/id = (\d+)/)![1]; p.positions = p.positions.filter((x: any) => x.id !== id); return []; }
  if (qs.includes("insert into swing_positions")) {
    const v = qs.match(/values \((.*)\)/s)![1].split(",").map(s => s.trim().replace(/^'|'$/g, ""));
    p.positions.push({ id: nextId++, symbol: v[0], ticker: v[1], kind: v[2], name: v[3], qty: +v[4], cost: +v[5], stop: v[6] === "null" ? null : +v[6], target1: v[7] === "null" ? null : +v[7], target2: v[8] === "null" ? null : +v[8], note: v[9], manual_price: null, manual_at: null });
    return [];
  }
  if (qs.includes("insert into swing_orders")) {
    const v = qs.match(/values \((.*)\)/s)![1].split(",").map(s => s.trim().replace(/^'|'$/g, ""));
    p.orders.push({ id: nextId++, symbol: v[0], ticker: v[1], side: v[2], price: v[3] === "null" ? null : +v[3], amount: v[4] === "null" ? null : +v[4], qty: null, valid_until: v[6] === "null" ? null : v[6], status: "bekliyor", note: v[7] });
    return [];
  }
  if (qs.startsWith("update swing_positions set symbol")) return [];
  // takip listesi (bellekte)
  if (qs.includes("from swing_watch")) return watchDev;
  if (qs.startsWith("insert into swing_watch")) { const v = [...qs.matchAll(/'((?:[^']|'')*)'/g)].map(m => m[1]); if (!watchDev.some(w => w.ticker === v[0])) watchDev.push({ ticker: v[0], symbol: v[1], market: v[2], name: v[3], added_at: new Date().toISOString() }); return []; }
  if (qs.startsWith("delete from swing_watch")) { const t = qs.match(/ticker = '([^']+)'/)![1]; watchDev = watchDev.filter(w => w.ticker !== t); return []; }
  // hisse sayfası: tek hisse analiz + haber (2,5 sn sonra hazır), öneri, önceki tarama farkı, en yeni tarama no
  if (qs.includes("swing_stock_start(")) { sStarted = Date.now(); return [{ t: new Date().toISOString() }]; }
  if (qs.includes("from swing_stock where ticker")) {
    if (!sStarted) return [];
    if (Date.now() - sStarted < 2500) return [{ status: "running", error: null, updated_at: null, data: null }];
    const t = qs.match(/ticker = '([^']+)'/)![1], dd = await (await fetch("/@fs/C:/Users/oguzh/swing-radar/dev_deep.json")).json();
    const deep = dd.deep[t] ?? { ...(Object.values(dd.deep)[0] as any), ticker: t };
    const st = r.markets.flatMap((m: any) => m.stocks).find((s: any) => s.ticker === t), any30 = r.markets.flatMap((m: any) => m.stocks).find((s: any) => s.bars);
    const news = { error: null, items: [1, 2, 3].map(i => ({ t: `${st?.symbol ?? t} için örnek haber başlığı ${i}`, u: "https://example.com/" + i, src: "Örnek Kaynak", at: new Date(Date.now() - i * 20 * 3600e3).toISOString(), d: "Yerel önizleme için sahte haber özeti." })) };
    return [{ status: "done", error: null, updated_at: new Date().toISOString(), data: { at: new Date().toISOString(), scanId: started ? 99 : 2, deep, news, bars: st?.bars ?? any30?.bars } }];
  }
  if (qs.includes("from swing_advice where status = 'aktif' and symbol")) { const sym = qs.match(/symbol = '([^']+)'/)![1]; return (p.advice ?? []).filter((a: any) => a.status === "aktif" && a.symbol === sym); }
  if (qs.includes("from swing_scans p, swing_scans c")) {
    const by: any = {}; r.markets.flatMap((m: any) => m.stocks).forEach((s: any, i: number) => { by[s.ticker] = { score: Math.max(0, s.score - (i % 7 === 0 ? 1 : i % 11 === 0 ? -1 : 0)), verdict: i % 13 === 0 ? "ALINMAZ" : s.verdict }; });
    return [{ created_at: new Date(Date.parse(r.createdAt) - 864e5).toISOString(), by }];
  }
  if (qs.includes("select max(id) as id from swing_scans")) return [{ id: started ? 99 : 2 }];
  if (qs.includes("coalesce(data->'live'")) return [{ at: new Date().toISOString(), live: {}, status: "done", updated_at: new Date().toISOString() }];
  if (qs.includes("data->>'at' as at from swing_news")) return [{ status: "done", at: new Date().toISOString() }];
  // tarama
  if (qs.includes("from swing_settings where id = 1") && qs.includes("capital_try")) return [settings];
  if (qs.includes("update swing_settings")) return [];
  if (qs.includes("from swing_trades")) return [];
  if (qs.includes("s->'bars' as bars")) {
    const t = qs.match(/s->>'ticker' = '([^']+)'/)![1];
    return [{ bars: r.markets.flatMap((m: any) => m.stocks).find((s: any) => s.ticker === t)?.bars ?? null }];
  }
  if (qs.includes(") picks")) return [{ id: 2, created_at: r.createdAt, seconds: r.seconds, source: "local", kronos: false, n: 2, picks: "KDP · ABNB" }, { id: 1, created_at: r.createdAt, seconds: 5, source: "cloud", kronos: false, n: 2, picks: "KDP · ABNB" }];
  const { markets, ...meta } = r;
  return [{ id: started ? 99 : 2, created_at: started ? new Date().toISOString() : r.createdAt, meta, markets: markets.map((m: any) => ({ ...m, stocks: m.stocks.map(({ bars, spark, ...s }: any) => ({ ...s, hasBars: !!bars })) })) }];
}
