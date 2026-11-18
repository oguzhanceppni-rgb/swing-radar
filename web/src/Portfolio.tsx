import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as api from "./api";
import type { Advice, Order, Portfolio as PF, Position, Quote } from "./api";
import { gsap, useGSAP, reduced, reveal, revealEls } from "./motion";
import { Odds, Seg, VCLASS, VTEXT, pct, signed, tl, trNum, when } from "./ui";
import Chart, { type PriceLine } from "./Chart";
import CountUp from "./bits/CountUp";

const LADDER = ["#0297DE", "#7ccbf5", "#FC734D", "#ffa98f", "#8496a1", "#b3c0c8"];
const STALE_MS = 10 * 60_000;
const today = () => new Date(new Date().toLocaleString("en-US", { timeZone: "Europe/Istanbul" })).toISOString().slice(0, 10);
const daysTo = (d: string) => Math.round((Date.parse(d) - Date.parse(today())) / 86400000);
const parseNum = (s: string) => { const x = +String(s).trim().replace(/\s/g, "").replace(/\.(?=\d{3}(\D|$))/g, "").replace(",", "."); return Number.isFinite(x) && String(s).trim() !== "" ? x : null; };

type Row = Position & { price: number; fx: number; q: Quote | null; value: number; costV: number; pnl: number; pnlPct: number; day: number; dayPct: number | null;
  weight: number; stopDist: number | null; t1Dist: number | null; openRisk: number | null; rNow: number | null; stale: boolean };

export default function Portfolio({ ownedChange, onPrices, onOpen, watch = [], stocks = [], toggleWatch }: { ownedChange?: (t: string[]) => void; onPrices?: () => void; onOpen?: (ticker: string) => void;
  watch?: api.Watch[]; stocks?: api.Stock[]; toggleWatch?: (s: api.Watch) => void }) {
  const [pf, setPf] = useState<PF | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sel, setSel] = useState<number | null>(null);
  const ref = useRef<HTMLElement>(null);

  const load = useCallback(async () => {
    try { const p = await api.portfolio(); setPf(p); setErr(null); ownedChange?.(p.positions.map(x => x.ticker)); return p; }
    catch (e: any) { setErr(e?.code === "not_granted" ? "Sayfanın Supabase'e erişmesine izin ver ve yenile." : "Portföy okunamadı: " + (e?.message ?? e)); return null; }
  }, [ownedChange]);

  const refresh = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    try {
      const t0 = Date.now();
      await api.refreshQuotes();
      for (;;) {
        await new Promise(r => setTimeout(r, 1500));
        const s = await api.quotesState();
        if (s.status === "error") throw new Error(s.error ?? "Fiyatlar alınamadı");
        if (s.status === "done" && s.updated_at && Date.parse(s.updated_at) >= t0 - 2000) break;
        if (Date.now() - t0 > 45_000) throw new Error("Fiyatlar 45 saniyede gelmedi");
      }
      await load(); onPrices?.();
    } catch (e: any) { setErr(e?.message ?? String(e)); }
    finally { setBusy(false); }
  }, [busy, load]);

  useEffect(() => { load().then(p => { if (p && (!p.quotes || Date.now() - Date.parse(p.quotes.at) > STALE_MS)) refresh(); }); }, []); // eslint-disable-line

  const fx = pf?.quotes?.quotes["USDTRY=X"]?.last ?? null;
  const rows: Row[] = useMemo(() => {
    if (!pf) return [];
    const base = pf.positions.map(p => {
      const q = p.kind === "stock" ? pf.quotes?.quotes[p.ticker] ?? null : null;
      const price = q?.last ?? p.manual_price ?? p.cost;
      const f = p.kind === "fund" || p.ticker.endsWith(".IS") ? 1 : fx ?? 1;
      const value = p.qty * price * f, costV = p.qty * p.cost * f;
      const day = q ? p.qty * (q.last - q.prev) * f : 0;
      return { ...p, price, fx: f, q, value, costV, pnl: value - costV, pnlPct: price / p.cost - 1, day, dayPct: q ? q.chg1d : null,
        weight: 0, stopDist: p.stop && p.horizon !== "uzun" ? price / p.stop - 1 : null, t1Dist: p.target1 ? p.target1 / price - 1 : null,
        openRisk: p.stop && p.horizon !== "uzun" ? Math.max(0, price - p.stop) * p.qty * f : null, rNow: p.stop && p.stop < p.cost ? (price - p.cost) / (p.cost - p.stop) : null,
        stale: p.kind === "fund" ? !p.manual_at || daysTo(p.manual_at) < -3 : !q };
    });
    const total = base.reduce((a, r) => a + r.value, 0) + pf.cash;
    return base.map(r => ({ ...r, weight: total ? r.value / total : 0 })).sort((a, b) => b.value - a.value);
  }, [pf, fx]);

  const tot = useMemo(() => {
    const inv = rows.reduce((a, r) => a + r.value, 0), cost = rows.reduce((a, r) => a + r.costV, 0), cash = pf?.cash ?? 0;
    const day = rows.reduce((a, r) => a + r.day, 0), risk = rows.reduce((a, r) => a + (r.openRisk ?? 0), 0);
    return { inv, cost, cash, total: inv + cash, day, dayPct: day / (inv + cash - day || 1), pnl: inv - cost, pnlPct: (inv - cost) / (cost || 1), risk };
  }, [rows, pf]);

  // bulgu cümlesi: tek bakışta ne önemli
  const finding = useMemo(() => {
    if (!pf || !rows.length) return "";
    const parts: string[] = [];
    const near = rows.filter(r => r.stopDist != null).sort((a, b) => a.stopDist! - b.stopDist!)[0];
    const tgt = rows.filter(r => r.t1Dist != null && r.t1Dist > 0).sort((a, b) => a.t1Dist! - b.t1Dist!)[0];
    parts.push(`Portföy bugün ${signed(tot.day)} (${pct(tot.dayPct, 2)}), toplam kâr/zarar ${signed(tot.pnl)} (${pct(tot.pnlPct)}).`);
    if (near) parts.push(`Stopa en yakın ${near.symbol}: ${pct(near.stopDist, 1, false)} uzakta.`);
    if (tgt) parts.push(`İlk hedefe en yakın ${tgt.symbol}: ${pct(tgt.t1Dist, 1, false)} kaldı.`);
    const due = pf.orders.filter(o => o.status === "bekliyor" && o.valid_until && daysTo(o.valid_until) <= 1);
    if (due.length) parts.push(`${[...new Set(due.map(o => o.symbol))].join(", ")} emirleri ${daysTo(due[0].valid_until!) <= 0 ? "bugün" : "yarın"} sona eriyor.`);
    return parts.join(" ");
  }, [pf, rows, tot]);

  useGSAP(() => {
    if (reduced() || !pf) return;
    gsap.timeline()
      .from(".pf-total > *", { y: 16, opacity: 0, stagger: 0.08, duration: 0.6 })
      .from(".alloc-bar span", { scaleX: 0, transformOrigin: "left center", stagger: 0.07, duration: 0.8, ease: "expo.out" }, 0.15)
      .from(".alloc-legend span", { opacity: 0, y: 6, stagger: 0.05, duration: 0.4 }, 0.4)
      .from(".pf-finding", { opacity: 0, y: 6, duration: 0.7 }, 0.25)
      .from(".pf-grid tbody tr", { x: -14, opacity: 0, stagger: 0.07, duration: 0.7, ease: "expo.out" }, 0.5)
      .from(".alloc-bar span", { color: "transparent", duration: 0.4, stagger: 0.07 }, 0.7);
    // ekranın altında kalan bloklar kaydırdıkça sırayla yerine oturur
    const rise = (sel: string, extra?: (b: Element[]) => void) => reveal(ref.current, sel, extra);
    rise(".order");
    revealEls(gsap.utils.toArray<Element>(".pf-grid .panel, .pf-grid .disclose", ref.current));
    rise(".adv", b => {
      gsap.from(b.map(x => x.querySelector(".adv-rail")), { scaleY: 0, transformOrigin: "top center", stagger: 0.09, duration: 0.9, ease: "power3.inOut", delay: 0.1 });
      gsap.from(b.map(x => x.querySelector(".tag")), { opacity: 0, x: -6, stagger: 0.09, duration: 0.5, delay: 0.35 });
    });
    rise(".adv-note");
  }, { scope: ref, dependencies: [!!pf] });

  if (err && !pf) return <section className="state"><h2>Portföy</h2><p>{err}</p><button className="btn" onClick={() => load()}>Tekrar dene</button></section>;
  if (!pf) return <section className="state" aria-busy="true"><p className="muted">Portföy okunuyor…</p><div className="skel" /><div className="skel" /></section>;
  const cur = rows.find(r => r.id === sel) ?? rows[0] ?? null;
  const pending = pf.orders.filter(o => o.status === "bekliyor");

  return (
    <section ref={ref} className="page">
      <header className="titlebar">
        <div className="title-left">
          <h1>Portföy</h1>
          <p className="meta">{pf.quotes ? <>Fiyatlar <span className="num">{when(pf.quotes.at)}</span>{Object.values(pf.quotes.quotes).some(q => q.partial) ? " · seans açık, son fiyat" : " · kapanış"}{fx ? <> · USD/TRY <span className="num">{trNum(fx, 2)}</span></> : null}</> : "Fiyat bekleniyor"}</p>
        </div>
        <div className="actions">
          {err && <span className="small neg" role="alert">{err}</span>}
            <button className={"btn" + (busy ? " is-scanning" : "")} onClick={refresh} disabled={busy}><span className="scan-dot" aria-hidden />{busy ? "Fiyatlar alınıyor" : "Fiyatları yenile"}</button>
        </div>
      </header>

      <div className="pf-hero">
        <div className="pf-total">
          <span className="kpi-label">Toplam değer</span>
          <span className="display-num"><span className="cur">₺</span><CountUp key={Math.round(tot.total)} to={Math.round(tot.total)} duration={1.2} separator="." /></span>
          <div className="pf-sub">
            <span>Bugün <b className={tot.day >= 0 ? "pos" : "neg"}>{signed(tot.day)} ({pct(tot.dayPct, 2)})</b></span>
            <span>Kâr/zarar <b className={tot.pnl >= 0 ? "pos" : "neg"}>{signed(tot.pnl)} ({pct(tot.pnlPct)})</b></span>
            {fx && <span>≈ <b>${trNum(tot.total / fx, 0)}</b></span>}
          </div>
          <div className="pf-sub">
            <CashEdit cash={tot.cash} onSave={async v => { await api.setCash(v); await load(); }} />
            <span>Stoplar tetiklenirse <b className="neg">{tl(-tot.risk)}</b> <span className="muted">({pct(tot.risk / (tot.total || 1), 1, false)})</span></span>
          </div>
        </div>
        <div className="alloc">
          <div className="alloc-bar" role="img" aria-label={"Dağılım: " + rows.map(r => `${r.symbol} ${pct(r.weight, 0, false)}`).join(", ") + `, nakit ${pct(tot.cash / (tot.total || 1), 0, false)}`}>
            {rows.map((r, i) => <span key={r.id} style={{ flexGrow: r.weight, background: LADDER[i % LADDER.length] }}>{r.weight > 0.08 ? r.symbol : ""}</span>)}
            <span className="a-cash" style={{ flexGrow: tot.cash / (tot.total || 1) }}>{tot.cash / (tot.total || 1) > 0.08 ? "Nakit" : ""}</span>
          </div>
          <div className="alloc-legend">
            {rows.map((r, i) => <span key={r.id}><i style={{ background: LADDER[i % LADDER.length] }} />{r.symbol} <b className="num">{pct(r.weight, 0, false)}</b></span>)}
            <span><i style={{ background: "var(--raised)" }} />Nakit <b className="num">{pct(tot.cash / (tot.total || 1), 0, false)}</b></span>
          </div>
          <p className="finding pf-finding">{finding}</p>
        </div>
      </div>

      <div className="pf-grid">
        <div className="page">
          <section className="panel" aria-labelledby="pos-h">
            <div className="panel-head"><h2 id="pos-h">Pozisyonlar</h2><span className="small muted">Satıra tıkla, sağda planı ve grafiği açılır.</span></div>
            <div className="table-wrap" data-lenis-prevent>
              <table>
                <thead><tr><th>Varlık</th><th className="r">Son</th><th className="r hide-m">Değer</th><th className="r">Kâr/zarar</th><th>Plan cetveli</th><th className="hide-m hide-l">Hedef / stop olasılığı</th></tr></thead>
                <tbody>
                  {rows.map(r => (
                    <tr key={r.id} className={r.stopDist != null && r.stopDist < 0.03 ? "near-stop" : ""} aria-current={cur?.id === r.id ? "true" : undefined} tabIndex={0}
                      onClick={() => setSel(r.id)} onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); setSel(r.id); } }}
                      style={cur?.id === r.id ? { background: "var(--accent-soft)" } : undefined}>
                      <td><span className="sym">{r.symbol}</span><span className="sub">{trNum(r.qty, 0)} adet · maliyet {trNum(r.cost)}</span></td>
                      <td className="r"><span className="sym num">{trNum(r.price)}</span><span className={"sub " + (r.dayPct == null ? "" : r.dayPct >= 0 ? "pos" : "neg")}>{r.kind === "fund" ? (r.manual_at ? `fon · ${r.manual_at.slice(8, 10)}.${r.manual_at.slice(5, 7)}` : "fon") : pct(r.dayPct, 2)}</span></td>
                      <td className="r hide-m"><span className="sym num">{tl(r.value)}</span><span className="sub">{pct(r.weight, 0, false)} ağırlık</span></td>
                      <td className="r"><span className={"sym num " + (r.pnl >= 0 ? "pos" : "neg")}>{signed(r.pnl)}</span><span className="sub">{pct(r.pnlPct)}</span></td>
                      <td><Ruler r={r} /></td>
                      <td className="hide-m hide-l">{pf.quotes?.mc[r.id] ? <Odds mc={pf.quotes.mc[r.id]} hold={40} label={`${r.symbol}: `} /> : <span className="small muted">{r.kind === "fund" ? "fon, veri yok" : r.stopDist != null && r.stopDist <= 0 ? "stop altında" : r.t1Dist != null && r.t1Dist <= 0 ? "hedef 1 geçildi" : "—"}</span>}</td>
                    </tr>))}
                  {!rows.length && <tr><td colSpan={6} className="empty-row">Pozisyon yok. Aşağıdan ekle.</td></tr>}
                </tbody>
              </table>
            </div>
          </section>

          <section className="panel" aria-labelledby="ord-h">
            <div className="panel-head"><h2 id="ord-h">Bekleyen emirler ve plan</h2><span className="small muted">{pending.length} bekliyor</span></div>
            <div className="orders">
              {pf.orders.map(o => <OrderRow key={o.id} o={o} q={pf.quotes?.quotes[o.ticker] ?? null} onStatus={async s => { await api.setOrderStatus(o.id, s); await load(); }} />)}
              {!pf.orders.length && <p className="small muted">Bekleyen emir yok.</p>}
            </div>
          </section>

          <details className="disclose">
            <summary>Pozisyon ekle</summary>
            <div className="disclose-body"><PositionForm onSave={async p => { await api.savePosition(p); await load(); refresh(); }} /></div>
          </details>
          <details className="disclose">
            <summary>Emir veya plan ekle</summary>
            <div className="disclose-body"><OrderForm onSave={async o => { await api.addOrder(o); await load(); }} /></div>
          </details>
          <AdviceList items={pf.advice} onOpen={onOpen} tickers={Object.fromEntries(pf.positions.filter(p => p.kind === "stock").map(p => [p.symbol, p.ticker]))} onStatus={async (id, st) => { await api.setAdviceStatus(id, st); await load(); }} />
          <p className="foot">Hisse fiyatları Yahoo'dan bulutta alınır. TEFAS dış isteklere kapalı olduğu için fon fiyatını sağdaki panelden elle girersin. Hermes sabah brief'i kendi portfolio.json dosyasını okumaya devam eder.</p>
        </div>
        <div className="pf-side">
          {cur && <PositionDetail key={cur.id + ":" + (pf.quotes?.at ?? "")} r={cur} pf={pf} reload={load} refresh={refresh} />}
          <WatchList watch={watch} stocks={stocks} onOpen={onOpen} toggle={toggleWatch} />
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- plan cetveli: stop · maliyet · son · hedef 1 · hedef 2
function Ruler({ r, lg }: { r: Row; lg?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const marks = [r.stop, r.cost, r.price, r.target1, r.target2].filter((x): x is number => x != null);
  const lo = Math.min(...marks) * 0.997, hi = Math.max(...marks) * 1.003;
  const X = (v: number) => ((v - lo) / (hi - lo || 1)) * 100;
  const gain = r.price >= r.cost;
  useGSAP(() => {
    if (reduced()) return;
    gsap.from(ref.current!.querySelectorAll(".tick, .zone-loss, .zone-gain"), { opacity: 0, duration: 0.4, stagger: 0.04 });
    gsap.fromTo(ref.current!.querySelector(".now"), { left: X(r.cost) + "%" }, { left: X(r.price) + "%", duration: 1.1, ease: "expo.out", delay: 0.2 });
  }, { scope: ref, dependencies: [r.price, r.cost, r.stop] });
  const label = `Plan: stop ${r.stop ? trNum(r.stop) : "yok"}, maliyet ${trNum(r.cost)}, son ${trNum(r.price)}, hedef 1 ${r.target1 ? trNum(r.target1) : "yok"}, hedef 2 ${r.target2 ? trNum(r.target2) : "yok"}`;
  return (
    <div className={"ruler" + (lg ? " ruler-lg" : "")} ref={ref} role="img" aria-label={label} title={label}>
      <span className="track" />
      {r.stop != null && <span className="zone-loss" style={{ left: X(r.stop) + "%", width: X(r.cost) - X(r.stop) + "%" }} />}
      {(r.target2 ?? r.target1) != null && <span className="zone-gain" style={{ left: X(r.cost) + "%", width: X((r.target2 ?? r.target1)!) - X(r.cost) + "%" }} />}
      {r.stop != null && <span className="tick stop" style={{ left: X(r.stop) + "%" }} />}
      <span className="tick" style={{ left: X(r.cost) + "%" }} />
      {r.target1 != null && <span className="tick tgt" style={{ left: X(r.target1) + "%" }} />}
      {r.target2 != null && <span className="tick tgt" style={{ left: X(r.target2) + "%" }} />}
      <span className={"now " + (gain ? "gain" : "loss")} style={{ left: X(r.price) + "%" }} />
      {lg && <>
        {r.stop != null && <span className="rl" style={{ left: X(r.stop) + "%" }}>Stop {trNum(r.stop)}</span>}
        <span className="rl top" style={{ left: X(r.cost) + "%" }}>Maliyet {trNum(r.cost)}</span>
        {r.target1 != null && <span className="rl" style={{ left: X(r.target1) + "%" }}>H1 {trNum(r.target1)}</span>}
        {r.target2 != null && <span className="rl top" style={{ left: X(r.target2) + "%" }}>H2 {trNum(r.target2)}</span>}
      </>}
    </div>
  );
}

// ---------------------------------------------------------------- pozisyon detayı
function PositionDetail({ r, pf, reload, refresh }: { r: Row; pf: PF; reload: () => Promise<unknown>; refresh: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [price, setPrice] = useState("");
  const [msg, setMsg] = useState("");
  const scan = pf.quotes?.scan[r.ticker];
  const mc = pf.quotes?.mc[r.id];
  const lines = useMemo<PriceLine[]>(() => [
    { price: r.cost, title: "Maliyet", tone: "ink" },
    ...(r.stop ? [{ price: r.stop, title: "Stop", tone: "stop" as const }] : []),
    ...(r.target1 ? [{ price: r.target1, title: "H1", tone: "target" as const }] : []),
    ...(r.target2 ? [{ price: r.target2, title: "H2", tone: "target" as const }] : []),
  ], [r.cost, r.stop, r.target1, r.target2]);
  useGSAP(() => {
    if (reduced()) return;
    gsap.timeline()
      .from(".sym-lg", { y: 8, opacity: 0, duration: 0.6 }, 0)
      .from(".d-price > *", { y: 10, opacity: 0, stagger: 0.06, duration: 0.5 }, 0.05)
      .from(".d-grid section, .facts > *", { y: 10, opacity: 0, stagger: 0.025, duration: 0.45 }, 0.25);
  }, { scope: ref, dependencies: [r.id] });
  return (
    <aside className="panel detail" ref={ref} aria-labelledby="pd-h">
      <div className="d-head">
        <div><h2 id="pd-h" className="sym-lg">{r.symbol}</h2><p className="d-name">{r.name ?? ""}</p></div>
        <div className="d-price">
          <span className="display-num price"><span className="cur">{r.fx === 1 ? "₺" : "$"}</span>{trNum(r.price)}</span>
          <span className={"small " + (r.dayPct == null ? "muted" : r.dayPct >= 0 ? "pos" : "neg")}>{r.kind === "fund" ? (r.manual_at ? `elle girildi · ${r.manual_at}` : "fiyat girilmedi") : `${pct(r.dayPct, 2)} bugün`}</span>
        </div>
      </div>
      <Ruler r={r} lg />
      <div className="d-grid">
        <section aria-labelledby="pp-h">
          <h3 id="pp-h">Pozisyon</h3>
          <dl className="facts">
            <dt>Adet · maliyet</dt><dd>{trNum(r.qty, 0)} · {trNum(r.cost)}</dd>
            <dt>Değer</dt><dd>{tl(r.value)}</dd>
            <dt>Kâr/zarar</dt><dd className={r.pnl >= 0 ? "pos" : "neg"}>{signed(r.pnl)} · {pct(r.pnlPct)}</dd>
            <dt>Şu an</dt><dd>{r.rNow == null ? "—" : (r.rNow >= 0 ? "+" : "−") + trNum(Math.abs(r.rNow)) + "R"}</dd>
          </dl>
        </section>
        <section aria-labelledby="pr-h">
          <h3 id="pr-h">Plana uzaklık</h3>
          <dl className="facts">
            <dt>Stop {r.stop ? trNum(r.stop) : ""}</dt><dd className={r.stopDist != null && r.stopDist < 0.03 ? "neg" : ""}>{r.stopDist == null ? "—" : pct(-r.stopDist / (1 + r.stopDist))}</dd>
            <dt>Hedef 1 {r.target1 ? trNum(r.target1) : ""}</dt><dd>{pct(r.t1Dist)}</dd>
            <dt>Hedef 2 {r.target2 ? trNum(r.target2) : ""}</dt><dd>{r.target2 ? pct(r.target2 / r.price - 1) : "—"}</dd>
            <dt>Stopta kayıp (bugünden)</dt><dd className="neg">{r.openRisk == null ? "—" : tl(-r.openRisk)}</dd>
          </dl>
        </section>
        {mc && <section className="wide" aria-labelledby="pm-h">
          <h3 id="pm-h">Zaman makinesi: senin stop ve ilk hedefinle</h3>
          <Odds mc={mc} big hold={40} />
          <dl className="facts">
            <dt><i className="key key-t" />40 gün içinde önce hedef 1</dt><dd>{pct(mc.target, 0, false)}</dd>
            <dt><i className="key key-n" />İkisi de değil</dt><dd>{pct(mc.neither, 0, false)}</dd>
            <dt><i className="key key-s" />Önce stop</dt><dd>{pct(mc.stop, 0, false)}</dd>
          </dl>
          <p className="small muted">Son 250 günün mumlarından {mc.paths.toLocaleString("tr-TR")} yol, bugünkü fiyattan. Aynı mum ikisine de değerse stop sayılır.</p>
        </section>}
        {scan && <section className="wide" aria-labelledby="ps-h">
          <h3 id="ps-h">Swing taraması <span className={"pill " + VCLASS[scan.verdict]}>{VTEXT[scan.verdict]}</span><Seg score={scan.score} max={pf.quotes?.maxScore ?? 8} verdict={scan.verdict} /></h3>
          <ul className="why">{scan.why.map(w => <li key={w} className={w.startsWith("-") ? "neg" : w.startsWith("! ") ? "warn" : w.startsWith("0 ") ? "muted" : ""}><span className="num">{w.split(" ")[0]}</span> {w.split(" ").slice(1).join(" ")}</li>)}</ul>
          <p className="small muted">Yeni giriş için puan. Elde tuttuğun pozisyon için karar senin stop/hedef planın.</p>
        </section>}
      </div>
      {r.q?.bars?.length ? <Chart bars={r.q.bars} lines={lines} label={`${r.symbol} günlük mumlar, maliyet, stop ve hedef çizgileri`} /> : null}
      {r.kind === "fund" && (
        <form className="d-add" onSubmit={async e => { e.preventDefault(); const v = parseNum(price); if (!v || v <= 0) { setMsg("Geçerli bir fiyat gir, örnek 11,2354"); return; } await api.setFundPrice(r.id, v); setPrice(""); setMsg("Fon fiyatı kaydedildi."); await reload(); }}>
          <label htmlFor="fp" className="small">Fon fiyatı</label>
          <input id="fp" inputMode="decimal" placeholder={trNum(r.price, 4)} value={price} onChange={e => setPrice(e.target.value)} aria-describedby="fp-h" />
          <button className="btn btn-sm">Kaydet</button>
          <span id="fp-h" className="small muted" style={{ gridColumn: "1 / -1" }}>TEFAS'taki son fiyatı gir; bugünün tarihiyle kaydedilir. <a href={`https://www.tefas.gov.tr/FonAnaliz.aspx?FonKod=${r.symbol}`} target="_blank" rel="noreferrer">TEFAS'ta aç</a></span>
          <span role="status">{msg}</span>
        </form>
      )}
      {r.note && <p className="small muted">Not: {r.note}</p>}
      <details className="disclose" style={{ background: "var(--ground)" }}>
        <summary>Pozisyonu düzenle</summary>
        <div className="disclose-body">
          <PositionForm init={r} onSave={async p => { await api.savePosition({ ...p, id: r.id }); await reload(); refresh(); }} />
          <button className="link link-danger" style={{ justifySelf: "start" }} onClick={async () => { await api.deletePosition(r.id); await reload(); }}>Pozisyonu sil (satıldı)</button>
        </div>
      </details>
    </aside>
  );
}

// ---------------------------------------------------------------- emir satırı
function OrderRow({ o, q, onStatus }: { o: Order; q: Quote | null; onStatus: (s: Order["status"]) => Promise<void> }) {
  const left = o.valid_until ? daysTo(o.valid_until) : null;
  const dist = q && o.price ? q.last / o.price - 1 : null;
  const done = o.status !== "bekliyor";
  return (
    <div className="order" style={done ? { opacity: 0.55 } : undefined}>
      <div>
        <span className="sym">{o.side === "al" ? "Al" : "Sat"} {o.symbol}{o.price ? <> · limit <span className="num">{trNum(o.price)}</span></> : null}{o.amount ? <span className="muted"> · {tl(o.amount)}</span> : null}</span>
        <span className="sub" style={{ maxWidth: "none", whiteSpace: "normal" }}>{o.note}</span>
      </div>
      <div className="r small">{q ? <>Son <b className="num">{trNum(q.last)}</b>{dist != null && <div className={"dist " + (Math.abs(dist) < 0.02 ? "pos" : "muted")}>{dist > 0 ? `limite ${pct(dist, 1, false)} yukarıda` : "limitin altında"}</div>}</> : <span className="muted">—</span>}</div>
      <div className="r small hide-m">{done ? <span className="pill neutral">{o.status}</span> : left == null ? <span className="muted">süresiz</span> : <span className={left <= 1 ? "due" : "muted"}>{left < 0 ? "süresi doldu" : left === 0 ? "bugün bitiyor" : left === 1 ? "yarın bitiyor" : `${left} gün`}</span>}</div>
      <div className="order-actions">
        {done ? <button className="link" onClick={() => onStatus("bekliyor")}>Geri al</button> : <>
          <button className="link" onClick={() => onStatus("gerçekleşti")}>Gerçekleşti</button>
          <button className="link link-danger" onClick={() => onStatus("iptal")}>İptal</button>
        </>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- formlar
function CashEdit({ cash, onSave }: { cash: number; onSave: (v: number) => Promise<void> }) {
  const [edit, setEdit] = useState(false), [v, setV] = useState(String(cash));
  if (!edit) return <span>Nakit <b>{tl(cash)}</b> <button className="link" onClick={() => { setV(String(cash)); setEdit(true); }}>düzenle</button></span>;
  return (
    <form className="inline" onSubmit={async e => { e.preventDefault(); const x = parseNum(v); if (x == null || x < 0) return; await onSave(x); setEdit(false); }}>
      <label htmlFor="cash" className="small">Nakit ₺</label>
      <input id="cash" inputMode="decimal" value={v} onChange={e => setV(e.target.value)} autoFocus />
      <button className="btn btn-sm">Kaydet</button><button type="button" className="link" onClick={() => setEdit(false)}>Vazgeç</button>
    </form>
  );
}

function PositionForm({ init, onSave }: { init?: Position; onSave: (p: Omit<Position, "id" | "manual_price" | "manual_at">) => Promise<void> }) {
  const [f, setF] = useState({
    symbol: init?.symbol ?? "", market: init ? (init.kind === "fund" ? "fund" : init.ticker.endsWith(".IS") ? "bist" : "us") : "bist",
    qty: init ? String(init.qty) : "", cost: init ? String(init.cost) : "", stop: init?.stop != null ? String(init.stop) : "",
    t1: init?.target1 != null ? String(init.target1) : "", t2: init?.target2 != null ? String(init.target2) : "", name: init?.name ?? "", note: init?.note ?? "",
    horizon: init?.horizon ?? "swing", proxy: init?.proxy ?? "" });
  const [msg, setMsg] = useState("");
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });
  const id = (k: string) => (init ? "e-" : "n-") + k;
  return (
    <form className="form-grid" onSubmit={async e => {
      e.preventDefault();
      const sym = f.symbol.trim().toUpperCase().replace(/\.IS$/, ""), qty = parseNum(f.qty), cost = parseNum(f.cost);
      if (!/^[A-Z0-9-]{2,10}$/.test(sym)) { setMsg("Sembol 2–10 harf/rakam olmalı, örnek THYAO."); return; }
      if (!qty || qty <= 0 || !cost || cost <= 0) { setMsg("Adet ve maliyet 0'dan büyük olmalı."); return; }
      const stop = parseNum(f.stop), t1 = parseNum(f.t1), t2 = parseNum(f.t2);
      if (stop != null && stop >= cost * 1.5) { setMsg("Stop maliyetin çok üstünde görünüyor, kontrol et."); return; }
      try {
        await onSave({ symbol: sym, ticker: f.market === "bist" ? sym + ".IS" : sym, kind: f.market === "fund" ? "fund" : "stock", name: f.name || null, qty, cost, stop, target1: t1, target2: t2, note: f.note || null, horizon: f.horizon === "uzun" ? "uzun" : "swing", proxy: f.proxy.trim().toUpperCase() || null });
        setMsg("Kaydedildi."); if (!init) setF({ ...f, symbol: "", qty: "", cost: "", stop: "", t1: "", t2: "", name: "", note: "" });
      } catch { setMsg("Kaydedilemedi, tekrar dene."); }
    }}>
      <div className="field"><label htmlFor={id("s")}>Sembol</label><input id={id("s")} value={f.symbol} onChange={set("symbol")} placeholder="THYAO" autoCapitalize="characters" /></div>
      <div className="field"><label htmlFor={id("m")}>Tür</label><select id={id("m")} value={f.market} onChange={set("market")}><option value="bist">BIST hisse</option><option value="us">ABD hisse ($)</option><option value="fund">TEFAS fonu</option></select></div>
      <div className="field"><label htmlFor={id("q")}>Adet</label><input id={id("q")} inputMode="decimal" value={f.qty} onChange={set("qty")} /></div>
      <div className="field"><label htmlFor={id("c")}>Ortalama maliyet</label><input id={id("c")} inputMode="decimal" value={f.cost} onChange={set("cost")} /></div>
      <div className="field"><label htmlFor={id("hz")}>Vade</label><select id={id("hz")} value={f.horizon} onChange={set("horizon")}><option value="swing">Swing (stop ve hedefli)</option><option value="uzun">Uzun vadeli birikim</option></select></div>
      {f.horizon === "uzun" && <div className="field"><label htmlFor={id("px")} title="Yahoo kodu. Fonun izlediği varlık; ekleme bölgesi bunun TL trendine göre hesaplanır.">Dayanak varlık</label><input id={id("px")} value={f.proxy} onChange={set("proxy")} placeholder="örnek SI=F (gümüş), GC=F (altın)" maxLength={12} /></div>}
      <div className="field"><label htmlFor={id("st")}>Stop</label><input id={id("st")} inputMode="decimal" value={f.stop} onChange={set("stop")} placeholder="isteğe bağlı" /></div>
      <div className="field"><label htmlFor={id("t1")}>Hedef 1</label><input id={id("t1")} inputMode="decimal" value={f.t1} onChange={set("t1")} placeholder="isteğe bağlı" /></div>
      <div className="field"><label htmlFor={id("t2")}>Hedef 2</label><input id={id("t2")} inputMode="decimal" value={f.t2} onChange={set("t2")} placeholder="isteğe bağlı" /></div>
      <div className="field"><label htmlFor={id("n")}>Ad</label><input id={id("n")} value={f.name} onChange={set("name")} placeholder="isteğe bağlı" /></div>
      <div className="field" style={{ gridColumn: "1 / -2" }}><label htmlFor={id("no")}>Not</label><input id={id("no")} value={f.note} onChange={set("note")} placeholder="örnek: stop günlük kapanışla" maxLength={200} /></div>
      <div className="field"><button className="btn">{init ? "Değişiklikleri kaydet" : "Pozisyonu ekle"}</button></div>
      <span className="small" role="status" style={{ gridColumn: "1 / -1", color: msg === "Kaydedildi." ? "var(--positive)" : "var(--negative)" }}>{msg}</span>
    </form>
  );
}

function OrderForm({ onSave }: { onSave: (o: Omit<Order, "id" | "status">) => Promise<void> }) {
  const [f, setF] = useState({ symbol: "", side: "al", price: "", amount: "", valid: "", note: "" });
  const [msg, setMsg] = useState("");
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });
  return (
    <form className="form-grid" onSubmit={async e => {
      e.preventDefault();
      const sym = f.symbol.trim().toUpperCase().replace(/\.IS$/, "");
      if (!/^[A-Z0-9-]{2,10}$/.test(sym)) { setMsg("Sembol 2–10 harf/rakam olmalı."); return; }
      const price = parseNum(f.price), amount = parseNum(f.amount);
      if (price == null && amount == null) { setMsg("Limit fiyat ya da tutar gir."); return; }
      try { await onSave({ symbol: sym, ticker: sym + ".IS", side: f.side as "al", price, amount, qty: null, valid_until: f.valid || null, note: f.note || null }); setMsg("Eklendi."); setF({ symbol: "", side: "al", price: "", amount: "", valid: "", note: "" }); }
      catch { setMsg("Eklenemedi."); }
    }}>
      <div className="field"><label htmlFor="o-s">Sembol (BIST)</label><input id="o-s" value={f.symbol} onChange={set("symbol")} placeholder="TCELL" /></div>
      <div className="field"><label htmlFor="o-y">Yön</label><select id="o-y" value={f.side} onChange={set("side")}><option value="al">Al</option><option value="sat">Sat</option></select></div>
      <div className="field"><label htmlFor="o-p">Limit fiyat</label><input id="o-p" inputMode="decimal" value={f.price} onChange={set("price")} placeholder="isteğe bağlı" /></div>
      <div className="field"><label htmlFor="o-a">Tutar ₺</label><input id="o-a" inputMode="decimal" value={f.amount} onChange={set("amount")} placeholder="isteğe bağlı" /></div>
      <div className="field"><label htmlFor="o-v">Geçerlilik</label><input id="o-v" type="date" value={f.valid} onChange={set("valid")} /></div>
      <div className="field" style={{ gridColumn: "span 2" }}><label htmlFor="o-n">Not</label><input id="o-n" value={f.note} onChange={set("note")} maxLength={200} /></div>
      <div className="field"><button className="btn">Ekle</button></div>
      <span className="small" role="status" style={{ gridColumn: "1 / -1" }}>{msg}</span>
    </form>
  );
}

// ---------------------------------------------------------------- öneriler: sohbetlerden + Hermes brief'ten, Supabase swing_advice tablosunda
export const ATONE: Record<string, string> = { AL: "pos", EKLE: "pos", TUT: "neutral", KORU: "neutral", "İZLE": "neutral", BEKLE: "warn", "TEMKİNLİ": "warn", AZALT: "neg", SAT: "neg" };
// öneri gövdesi: her satır bir başlık (Plan, Kural, Teknik, Bilanço, Haber…) ile başlar
export function AdvBody({ a }: { a: Advice }) {
  return (
    <div className="adv-lines">
      {a.body.split(/\r?\n/).map((l, i) => {
        const m = l.match(/^(Plan|Pozisyon|Kural|Teknik [a-zçğıöşü]+|Bilanço|Haber|Dayanak|Derin analiz|Gerekçe)( \([^)]*\))?:/);
        return <p key={i} className={"adv-text" + (m?.[1] === "Kural" ? " adv-rule" : "")}>{m ? <><b>{m[0]}</b>{l.slice(m[0].length)}</> : l}</p>;
      })}
    </div>
  );
}
export const advSince = (a: Advice) => { const h = (Date.now() - Date.parse(a.created_at)) / 36e5; return h < 1 ? "az önce" : h < 36 ? `${Math.round(h)} saattir` : `${Math.round(h / 24)} gündür`; };
function AdviceList({ items, onStatus, onOpen, tickers }: { items: Advice[]; onStatus: (id: number, s: Advice["status"]) => Promise<void>; onOpen?: (ticker: string) => void; tickers: Record<string, string> }) {
  const [busy, setBusy] = useState<number | null>(null);
  const live = items.filter(a => a.status === "aktif"), old = items.filter(a => a.status !== "aktif");
  const last = items.reduce((m, a) => (a.updated_at > m ? a.updated_at : m), "");
  // kapatılan öneri sağa kayıp yüksekliğini kapatarak listeden çıkar, sonra kaydedilir
  const act = async (id: number, st: Advice["status"], el?: Element | null) => {
    setBusy(id);
    try {
      if (el && !reduced()) await gsap.to(el, { x: 24, opacity: 0, height: 0, paddingTop: 0, paddingBottom: 0, duration: 0.55, ease: "power2.inOut" });
      await onStatus(id, st);
    } finally { setBusy(null); }
  };
  return (
    <section className="panel advice" aria-labelledby="adv-h">
      <div className="panel-head">
        <h2 id="adv-h">Öneriler</h2>
        <span className="small muted">{live.length} açık{last && <> · güncelleme {when(last)}</>}</span>
      </div>
      <ol className="adv-list">
        {live.map(a => (
          <li key={a.id} className="adv">
            <span className="adv-rail" aria-hidden />
            <div className="adv-key">{onOpen && tickers[a.symbol] ? <button className="link adv-sym" onClick={() => onOpen(tickers[a.symbol])} title="Hisse sayfasını aç"><b>{a.symbol}</b></button> : <b>{a.symbol}</b>}<span className={"tag tag-" + (ATONE[a.action] ?? "neutral")}>{a.action}</span></div>
            <div className="adv-body">
              <p className="adv-title">{a.title}{a.prev_action && <span className="adv-chg" title="Önceki fiyat yenilemesindeki eylem">{a.prev_action} → {a.action}</span>}</p>
              <AdvBody a={a} />
              <div className="adv-foot">
                <span>{a.source ?? "Sohbet"}{a.source?.startsWith("Kural") ? ` · bu eylem ${advSince(a)}` : ""}</span>
                <span className="adv-acts">
                  <button className="link" disabled={busy === a.id} onClick={e => act(a.id, "yapildi", e.currentTarget.closest("li"))}>Yapıldı</button>
                  <button className="link link-muted" disabled={busy === a.id} onClick={e => act(a.id, "gecersiz", e.currentTarget.closest("li"))}>Geçersiz</button>
                </span>
              </div>
            </div>
          </li>
        ))}
        {!live.length && <li className="adv-empty muted small">Açık öneri yok. Fiyatları yenileyince kurallar yeniden hesaplanır.</li>}
      </ol>
      {old.length > 0 && (
        <details className="adv-old">
          <summary>Kapananlar ({old.length})</summary>
          <ul>{old.map(a => <li key={a.id}><b>{a.symbol}</b> {a.title} <span className="muted">· {a.status === "yapildi" ? "yapıldı" : "geçersiz"} {when(a.updated_at)}</span> <button className="link link-muted" onClick={() => act(a.id, "aktif")}>geri al</button></li>)}</ul>
        </details>
      )}
      <p className="adv-note">"Kural" kaynaklı öneriler her fiyat yenilemede yeniden yazılır. Her pozisyon için tek kart: senin stop ve hedeflerin (plan), günlük teknik (50 ve 200 günlük ortalama, RSI, haftalık HAHO, rotasyon), son bilanço ve bilanço tarihi, son 4 günün haber başlıkları. Uzun vadeli birikim pozisyonlarında stop uyarısı yoktur; ekleme bölgesi dayanak varlığın TL trendine göre hesaplanır. Haber satırı anahtar kelime taramasıdır, yorum değildir. Kapattığın kart, eylem değişene ya da 24 saat geçene kadar geri gelmez. Kurallar mekaniktir; yatırım tavsiyesi değildir.</p>
    </section>
  );
}

// ---------------------------------------------------------------- takip listesi: izlenen hisselerin son fiyatı, günlük değişim, tarama kararı
function WatchList({ watch, stocks, onOpen, toggle }: { watch: api.Watch[]; stocks: api.Stock[]; onOpen?: (t: string) => void; toggle?: (w: api.Watch) => void }) {
  const by = useMemo(() => new Map(stocks.map(s => [s.ticker, s])), [stocks]);
  return (
    <section className="panel watch-panel" aria-labelledby="wl-h">
      <div className="panel-head"><h2 id="wl-h">Takip ettiklerin</h2><span className="small muted">{watch.length} hisse</span></div>
      {!watch.length ? <p className="small muted">Takip listen boş. Tarama tablosunda, hisse detayında ya da hisse sayfasında kodun yanındaki <b>Takip et</b> düğmesiyle eklersin.</p> :
        <ul className="watch-list">
          {watch.map(w => {
            const s = by.get(w.ticker), px = s ? api.pxNow(s) : null, ch = s ? api.chgDay(s) : null;
            return (
              <li key={w.ticker}>
                <button className="watch-row" onClick={() => onOpen?.(w.ticker)} title="Hisse sayfasını aç">
                  <span className="sym">{w.symbol}<span className="sub">{w.market === "bist" ? "BIST" : "Nasdaq"}{w.name && w.name !== w.symbol ? " · " + w.name.replace(/0307/g, "") : ""}</span></span>
                  <span className="r num">{px != null ? (w.market === "bist" ? "₺" : "$") + trNum(px) : "—"}<span className={"sub " + (ch == null ? "" : ch >= 0 ? "pos" : "neg")}>{ch == null ? "taramada yok" : pct(ch, 2)}</span></span>
                  {s ? <span className={"pill " + VCLASS[s.verdict]}>{VTEXT[s.verdict]} {s.score}</span> : <span />}
                </button>
                <button className="link link-muted watch-x" onClick={() => toggle?.(w)} aria-label={`${w.symbol} takipten çıkar`} title="Takipten çıkar">×</button>
              </li>);
          })}
        </ul>}
      <p className="small muted">Fiyatlar son fiyat yenilemesinden. Haberleri Haberler sayfasında, Takip ettiklerin bölümünde.</p>
    </section>
  );
}
