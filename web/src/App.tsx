import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import * as api from "./api";
import { isExitMc, type Bar, type Phase, type Scan, type ScanState, type Settings, type Stock, type Verdict } from "./api";
import { gsap, useGSAP, reduced, reveal, revealEls, pointerFx, scrollToEl, startLenis, FROM3D, TO3D, UNBLUR, ScrollTrigger } from "./motion";
import { MKT, SETUP, VCLASS, VTEXT, QUAD, quadOf, Tabs, Odds, Seg, WatchBtn, money, pct, trNum, when, type Quad } from "./ui";
import { Journal, History, SettingsView } from "./Views";
import Rotation from "./Rotation";
import Hero3D, { reaccel } from "./Hero3D";
import Portfolio from "./Portfolio";
import News from "./News";
import Track from "./Track";
import { DeepView, ensureDeep } from "./Deep";
import Chart, { type PriceLine } from "./Chart";
import CountUp from "./bits/CountUp";
import { Search, Tape } from "./Search";
import StockPage from "./Stock";

// ---------------------------------------------------------------- yönlendirme (yalnızca #ad)
const VIEWS = [
  { id: "tarama", label: "Tarama", icon: "M4 19V5M4 19h16M8 15l3-4 3 2 5-6" },
  { id: "portfoy", label: "Portföy", icon: "M4 7h16v12H4zM8 7V5h8v2M4 12h16" },
  { id: "haberler", label: "Haberler", icon: "M5 5h11v14H6a1 1 0 0 1-1-1zM16 9h3v9a1 1 0 0 1-1 1h-2M8 9h5M8 12h5M8 15h3" },
  { id: "takip", label: "Sinyal takibi", icon: "M4 18l5-6 4 3 7-9M15 6h5v5" },
  { id: "islemler", label: "İşlem günlüğü", icon: "M6 4h12v16H6zM9 8h6M9 12h6M9 16h3" },
  { id: "gecmis", label: "Tarama geçmişi", icon: "M12 7v5l3 2M3.5 12a8.5 8.5 0 1 0 2.5-6M3 4v4h4" },
  { id: "ayarlar", label: "Risk ayarları", icon: "M4 7h10M18 7h2M4 17h4M12 17h8M14 5v4M8 15v4" },
] as const;
// "hisse" menüde yok: #hisse/TICKER ile açılır (arama, şerit, tablo, harita)
type View = (typeof VIEWS)[number]["id"] | "hisse";
const hashTicker = () => (location.hash.startsWith("#hisse/") ? decodeURIComponent(location.hash.slice(7)) : null);
const readHash = (): View => (hashTicker() ? "hisse" : VIEWS.find(v => "#" + v.id === location.hash)?.id ?? "tarama");
type Job = { id: number; st: ScanState | null; err?: string };
type Toast = { id: number; title: string; text: string; tone: "pos" | "neg" };

export default function App() {
  const [view, setView] = useState<View>(readHash);
  const [scan, setScan] = useState<Scan | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [st, setSt] = useState<Settings | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const [owned, setOwned] = useState<Set<string>>(new Set());
  const [menu, setMenu] = useState(false);
  const [jump, setJump] = useState<{ t: string; n: number } | null>(null);
  const [live, setLive] = useState<api.Live>({});
  const [stk, setStk] = useState<string | null>(hashTicker);
  // takip listesi: iyimser güncelleme, hata olursa geri alınır
  const [watch, setWatch] = useState<api.Watch[]>([]);
  useEffect(() => { api.watchList().then(setWatch).catch(() => {}); }, []);
  const watched = useMemo(() => new Set(watch.map(w => w.ticker)), [watch]);
  const toggleWatch = useCallback(async (s: { ticker: string; symbol: string; market: "bist" | "us"; name: string | null }) => {
    const on = watch.some(w => w.ticker === s.ticker), prev = watch;
    setWatch(on ? watch.filter(w => w.ticker !== s.ticker) : [...watch, { ticker: s.ticker, symbol: s.symbol, market: s.market, name: s.name, added_at: new Date().toISOString() }]);
    try { await (on ? api.watchRemove(s.ticker) : api.watchAdd(s)); }
    catch (e: any) { setWatch(prev); setToast({ id: Date.now(), tone: "neg", title: "Takip listesi güncellenemedi", text: e?.message ?? String(e) }); }
  }, [watch]);
  const pinned = useRef(false); // Geçmiş'ten eski bir tarama açıldıysa en yeniye atlanmaz
  const curtain = useRef<HTMLDivElement>(null);
  const [mkt, setMkt] = useState<"bist" | "us">(() => { try { return (sessionStorage.getItem("sr-mkt") as any) || "bist"; } catch { return "bist"; } });
  const shell = useRef<HTMLDivElement>(null), page = useRef<HTMLDivElement>(null), nav = useRef<HTMLDivElement>(null), pill = useRef<HTMLSpanElement>(null);

  useEffect(() => { const f = () => { setView(readHash()); setStk(hashTicker()); setMenu(false); }; addEventListener("hashchange", f); return () => removeEventListener("hashchange", f); }, []);
  // sayfa geçişi (iki perde): eski sayfa bulanıklaşıp hafifçe yükselerek söner, üstte ince vişne çizgi soldan dolar;
  // sayfa arkada değişir, çizgi sağa çekilirken yenisi katman katman yerine oturur (giriş useGSAP'ta).
  const leaving = useRef(false);
  const go = (v: View, after?: () => void, ticker?: string) => {
    setMenu(false);
    const swap = () => { location.hash = ticker ? "hisse/" + encodeURIComponent(ticker) : v; setView(v); if (ticker) setStk(ticker); scrollToEl(0, true); after?.(); leaving.current = false; };
    if ((v === view && !ticker) || reduced() || !page.current) return swap();
    if (leaving.current) return;
    leaving.current = true;
    gsap.timeline({ defaults: { ease: "power2.in" } })
      .to(curtain.current, { scaleX: 1, transformOrigin: "left center", duration: 0.3, ease: "power2.inOut" }, 0)
      .to(page.current, { opacity: 0, y: -8, duration: 0.24, ease: "power1.in", onComplete: swap }, 0);
  };
  const openStock = (t: string) => go("hisse", undefined, t);
  const find = (s: Stock) => { chooseMkt(s.market); openStock(s.ticker); };
  const toScan = (s: Stock) => { chooseMkt(s.market); go("tarama", () => setJump({ t: s.ticker, n: Date.now() })); };
  const chooseMkt = (v: "bist" | "us") => { try { sessionStorage.setItem("sr-mkt", v); } catch { /* yok */ } setMkt(v); };
  const ownedChange = useCallback((t: string[]) => setOwned(new Set(t)), []);

  const load = useCallback(async (id?: number) => {
    setErr(null);
    try {
      const [s, cfg, own] = await Promise.all([id ? api.scanById(id) : api.latestScan(), api.settings(), api.ownedTickers().catch(() => [])]);
      setScan(s); setSt(cfg); setOwned(new Set(own));
      api.liveState().then(r => setLive(r.live)).catch(() => {});
      if (s) ensureDeep(s.id).catch(() => {});
      return s;
    } catch (e: any) {
      setErr(e?.code === "not_granted" ? "Bu sayfa verileri senin Supabase bağlantın üzerinden okur. Sayfanın Supabase'e erişmesine izin ver ve yenile."
        : "Veri okunamadı: " + (e?.message ?? String(e)) + ". Supabase projesi uykuya geçmiş olabilir; panelden uyandırıp yenile.");
      return null;
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load]);

  // ---------------------------------------------------------------- tek veri: en yeni tarama + son fiyatlar her görünümde aynı
  // Sayfa açılınca, görünüm değişince ve pencereye dönünce: daha yeni tarama varsa yüklenir; fiyatlar 10 dk'dan eskiyse
  // bulutta yenilenir (portföy, öneriler, arama, şerit, ısı haritası birlikte). Portföy sayfası kendi yenilemesini yapar.
  const syncing = useRef(false);
  const reloadLive = useCallback(() => api.liveState().then(r => setLive(r.live)).catch(() => {}), []);
  const sync = useCallback(async (refreshPrices: boolean) => {
    if (syncing.current) return;
    syncing.current = true;
    try {
      const latest = await api.latestScanId();
      if (latest && !pinned.current && latest !== scanIdRef.current) await load();
      const st = await api.liveState(); setLive(st.live);
      if (!refreshPrices || st.status === "running" || (st.at && Date.now() - Date.parse(st.at) < 10 * 60_000)) return;
      const t0 = Date.now();
      await api.refreshQuotes();
      for (;;) {
        await new Promise(r => setTimeout(r, 1500));
        const s = await api.quotesState();
        if (s.status === "error" || Date.now() - t0 > 45_000) break;
        if (s.status === "done" && s.updated_at && Date.parse(s.updated_at) >= t0 - 2000) break;
      }
      await reloadLive();
      // haberler 3 saatten eskiyse arka planda yenilenir; öneriler bir sonraki fiyat yenilemesinde yeni başlıkları okur
      const nw = await api.newsAge();
      if (nw.status !== "running" && (!nw.at || Date.now() - Date.parse(nw.at) > 3 * 3600e3)) api.refreshNews().catch(() => {});
    } catch { /* bir sonraki tetikte tekrar */ } finally { syncing.current = false; }
  }, [load, reloadLive]);
  const scanIdRef = useRef<number | null>(null);
  useEffect(() => { scanIdRef.current = scan?.id ?? null; }, [scan?.id]);
  useEffect(() => { if (!loading && !err) sync(view !== "portfoy"); }, [view, loading]); // eslint-disable-line
  useEffect(() => {
    const f = () => { if (document.visibilityState === "visible") sync(view !== "portfoy"); };
    addEventListener("focus", f); document.addEventListener("visibilitychange", f);
    return () => { removeEventListener("focus", f); document.removeEventListener("visibilitychange", f); };
  }, [sync, view]);

  // ---------------------------------------------------------------- tarama: başlat → yokla → yükle
  const scanning = !!job && !job.err && job.st?.status !== "done";
  const startScan = async () => {
    if (scanning) return;
    pinned.current = false;
    if (view !== "tarama") go("tarama");
    setJob({ id: 0, st: null });
    try {
      const id = await api.startScan();
      setJob({ id, st: null });
      const t0 = Date.now();
      for (;;) {
        await new Promise(r => setTimeout(r, 1300));
        const s = await api.scanState(id);
        if (!s) throw new Error("Tarama kaydı bulunamadı.");
        setJob({ id, st: s });
        if (s.status === "error") throw new Error(s.error ?? "Bilinmeyen hata");
        if (s.status === "done") break;
        if (Date.now() - t0 > 180_000) throw new Error("Tarama 3 dakikada bitmedi. Biraz sonra Geçmiş'ten kontrol et.");
      }
      const res = await load(id);
      const picks = res?.markets.flatMap(m => m.stocks.filter(x => x.verdict === "ALINIR").map(x => x.symbol)) ?? [];
      setToast({ id: Date.now(), tone: "pos", title: `Tarama bitti · ${res?.seconds ?? "—"} sn`, text: picks.length ? `Alınır: ${picks.join(", ")}` : "Bu taramada alınır aday çıkmadı." });
      setTimeout(() => setJob(null), 1600);
    } catch (e: any) {
      setJob(j => ({ id: j?.id ?? 0, st: j?.st ?? null, err: e?.message ?? String(e) }));
      setToast({ id: Date.now(), tone: "neg", title: "Tarama başarısız", text: e?.message ?? String(e) });
    }
  };

  // ---------------------------------------------------------------- hareket: kenar çubuğu girişi, aktif öğe zemini, sayfa geçişi
  useGSAP(() => {
    if (reduced() || loading) return;
    gsap.from(".side > *, .nav-item", { x: -14, opacity: 0, stagger: 0.04, duration: 0.5 });
    gsap.from(".topline > *", { y: -12, opacity: 0, stagger: 0.1, duration: 0.8, ease: "expo.out", delay: 0.15 });
  }, { scope: shell, dependencies: [loading] });
  useLayoutEffect(() => {
    const a = nav.current?.querySelector<HTMLElement>(`[data-v="${view}"]`), p = pill.current;
    if (!a || !p) return;
    gsap.to(p, { y: a.offsetTop, duration: reduced() ? 0 : 0.45, ease: "smooth" });
  }, [view, loading]);
  useGSAP(() => {
    if (reduced() || loading) return;
    const pg = page.current!, top = pg.children.length === 1 ? pg.firstElementChild! : pg, blocks = Array.from(top.children);
    gsap.timeline({ defaults: { ease: "expo.out" } })
      .to(curtain.current, { scaleX: 0, transformOrigin: "right center", duration: 0.7, ease: "power3.inOut" }, 0)
      .fromTo(pg, { opacity: 0, y: 0 }, { opacity: 1, duration: 0.5, ease: "power1.out", clearProps: "transform,opacity" }, 0)
      .fromTo(blocks, FROM3D, { ...TO3D, stagger: 0.06 }, 0)
      .to(blocks, { ...UNBLUR, stagger: 0.08 }, 0.05)
      .from(pg.querySelector("h1"), { clipPath: "inset(0 100% 0 0)", duration: 0.8, ease: "power3.out", clearProps: "clipPath" }, 0.05)
      .from(pg.querySelectorAll(".titlebar .meta, .titlebar p"), { opacity: 0, x: -10, duration: 0.6, ease: "power3.out" }, 0.25)
      .call(() => ScrollTrigger.refresh());
    // sayfa içindeki paneller ekrana girdikçe
    const skip = new Set(blocks);
    revealEls(Array.from(pg.querySelectorAll(".panel, .disclose")).filter(e => !skip.has(e) && !e.querySelector(".rot-svg")));
    // başlık kaydırırken daha yavaş kayar ve söner (derinlik)
    const tl = pg.querySelector(".title-left");
    if (tl) gsap.to(tl, { y: 70, opacity: 0.15, ease: "none", scrollTrigger: { trigger: tl, start: "top 70px", end: "+=420", scrub: 0.4 } });
  }, { dependencies: [view, loading, stk] });
  useEffect(() => pointerFx(), []);
  useEffect(() => startLenis(), []);
  // üstte kaydırma ilerleme çizgisi
  useGSAP(() => {
    if (reduced() || loading) return;
    gsap.fromTo(".scroll-prog", { scaleX: 0 }, { scaleX: 1, ease: "none", scrollTrigger: { start: 0, end: "max", scrub: 0.3 } });
  }, { scope: shell, dependencies: [loading] });

  const scanL = useMemo(() => (scan ? api.withLive(scan, live) : null), [scan, live]);
  const all = useMemo(() => scanL?.markets.flatMap(m => m.stocks) ?? [], [scanL]);
  const market = scanL?.markets.find(m => m.market === mkt) ?? scanL?.markets[0] ?? null;

  return (
    <div className="shell" ref={shell}>
      <div className="topbar-m">
        <button className="menu-btn" aria-label="Menüyü aç" aria-expanded={menu} onClick={() => setMenu(true)}><svg viewBox="0 0 24 24"><path d="M4 7h16M4 12h16M4 17h16" /></svg></button>
        <b>Swing Radar</b>
      </div>
      {menu && <div className="scrim" onClick={() => setMenu(false)} aria-hidden />}
      <nav className={"side" + (menu ? " open" : "")} aria-label="Bölümler">
        <a className="brand" href="#tarama" onClick={e => { e.preventDefault(); go("tarama"); }}>
          <Mark />
          <span className="sr-only">Swing Radar</span>
        </a>
        <div className="nav" ref={nav}>
          <span className="nav-pill" ref={pill} aria-hidden style={{ left: 0, right: 0, top: 0 }} />
          {VIEWS.map(v => (
            <a key={v.id} href={"#" + v.id} data-v={v.id} className="nav-item" aria-current={view === v.id ? "page" : undefined} onClick={e => { e.preventDefault(); go(v.id); }}>
              <svg viewBox="0 0 24 24" aria-hidden><path d={v.icon} pathLength={1} /></svg>{v.label}
            </a>
          ))}
        </div>
        <div className="side-foot">
          {scan ? <>
            <span>Son tarama <b className="num">{when(scan.created_at)}</b></span>
            <span>{scan.params.source === "local" ? (scan.params.kronos ? "Bilgisayar + Kronos" : "Bilgisayar") : "Bulut"} · veri {market?.asOf}</span>
          </> : <span>Henüz tarama yok</span>}
          <span>Yatırım tavsiyesi değildir.</span>
        </div>
      </nav>
      <div className="scroll-prog" aria-hidden />
      <main className="main">
        {all.length > 0 && <div className="topline"><Search stocks={all} owned={owned} onPick={find} /><Tape stocks={all} onPick={find} /></div>}
        <div ref={curtain} className="curtain" aria-hidden />
        {job && view === "tarama" && <ScanProgress job={job} onClose={() => setJob(null)} />}
        <div ref={page} className="page">
          {err ? <Problem text={err} retry={() => load()} />
            : loading ? <Loading />
            : view === "tarama" ? (scan && market && st
              ? <ScanView key={scan.id} scan={scanL!} market={market} st={st} scanning={scanning} owned={owned} mkt={mkt} chooseMkt={chooseMkt} startScan={startScan} jump={jump} openStock={openStock} watched={watched} toggleWatch={toggleWatch} />
              : <Empty onScan={startScan} />)
            : view === "hisse" ? (() => {
                const s = all.find(x => x.ticker === stk);
                if (!scanL || !st) return <Loading />;
                if (!s) return <section className="state"><h1>Hisse bulunamadı</h1><p>{stk} son taramada yok. XU100 ve Nasdaq-100 hisseleri açılabilir.</p><button className="btn" onClick={() => go("tarama")}>Taramaya dön</button></section>;
                return <StockPage key={scanL.id + s.ticker} s={s} scan={scanL} st={st} owned={owned} back={() => toScan(s)} open={openStock} watched={watched.has(s.ticker)} toggleWatch={() => toggleWatch(s)}
                  detail={extra => <Detail s={s} scanId={scanL.id} st={st} hold={scanL.params.hold} max={scanL.params.maxScore ?? 10} owned={owned.has(s.ticker)} extra={extra} />} />;
              })()
            : view === "portfoy" ? <Portfolio ownedChange={ownedChange} onPrices={reloadLive} onOpen={openStock} watch={watch} stocks={all} toggleWatch={toggleWatch} />
            : view === "haberler" ? <News owned={owned} watched={watched} onOpen={openStock} />
            : view === "takip" ? <Track />
            : view === "islemler" ? <Journal scan={scanL} />
            : view === "gecmis" ? <History current={scan?.id} open={id => { pinned.current = true; load(id); go("tarama"); }} />
            : <SettingsView st={st} onSave={setSt} />}
        </div>
      </main>
      {toast && <ToastView key={toast.id} t={toast} onDone={() => setToast(null)} />}
    </div>
  );
}

// ---------------------------------------------------------------- durumlar
function Problem({ text, retry }: { text: string; retry: () => void }) {
  return <section className="state"><h1>Bağlantı sorunu</h1><p>{text}</p><button className="btn" onClick={retry}>Tekrar dene</button></section>;
}
function Loading() {
  return <section className="state" aria-busy="true"><p className="muted">Son tarama okunuyor…</p><div className="skel" /><div className="skel" /><div className="skel" /></section>;
}
function Empty({ onScan }: { onScan: () => void }) {
  return (
    <section className="state">
      <h1>Henüz tarama yok</h1>
      <p>İlk taramayı başlat: iki piyasa bulutta yaklaşık 10 saniyede taranır.</p>
      <button className="btn" onClick={onScan}>Şimdi tara</button>
    </section>
  );
}

// ---------------------------------------------------------------- canlı tarama ilerlemesi
const PHASE: Record<string, string> = { universe: "Endeks listesi alınıyor", data: "Günlük mumlar indiriliyor", rules: "Kurallar ve Monte Carlo", done: "Bitti" };
function ScanProgress({ job, onClose }: { job: Job; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [sec, setSec] = useState(0);
  useEffect(() => { const t0 = Date.now(); const i = setInterval(() => setSec((Date.now() - t0) / 1000), 100); return () => clearInterval(i); }, [job.id]);
  useGSAP(() => { if (!reduced()) gsap.from(ref.current, { height: 0, opacity: 0, paddingTop: 0, paddingBottom: 0, duration: 0.45 }); }, { scope: ref });
  const pctOf = (p?: Phase) => (!p ? 0.03 : p === "done" ? 1 : p.phase === "universe" ? 0.08 : p.phase === "data" ? 0.1 + 0.75 * ((p.done ?? 0) / (p.total || 1)) : 0.92);
  return (
    <div className={"scanbar" + (job.err ? " is-error" : "")} ref={ref} role="status" aria-live="polite">
      {(["bist", "us"] as const).map(m => {
        const p = job.st?.progress?.[m];
        const label = job.err ? "Durdu" : !p ? "Sırada" : p === "done" ? PHASE.done : PHASE[p.phase] + (p.phase === "data" && p.total ? ` ${p.done}/${p.total}` : "");
        return (
          <div key={m}>
            <div className="scan-head small"><b>{MKT[m]}</b><span className="muted">{label}</span></div>
            <div className="scan-track"><span className={"scan-fill" + (p === "done" ? " done" : "")} style={{ transform: `scaleX(${pctOf(p)})` }} /></div>
          </div>
        );
      })}
      <div className="scan-side small">
        {job.err ? <><span className="neg">{job.err}</span> <button className="link" onClick={onClose}>Kapat</button></>
          : <span className="num">{trNum(sec, 1)} sn</span>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- bildirim (transitions.dev #22)
function ToastView({ t, onDone }: { t: Toast; onDone: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useGSAP(() => {
    gsap.timeline({ onComplete: onDone })
      .from(ref.current, { y: 24, opacity: 0, scale: 0.96, duration: reduced() ? 0.01 : 0.45 })
      .to(ref.current, { y: 12, opacity: 0, duration: reduced() ? 0.01 : 0.35 }, "+=5");
  }, { scope: ref });
  return <div className={"toast toast-" + t.tone} ref={ref} role="status"><b>{t.title}</b><span>{t.text}</span></div>;
}

// ---------------------------------------------------------------- Tarama görünümü
type Filter = "all" | Verdict;
function ScanView({ scan, market: m, st, scanning, owned, mkt, chooseMkt, startScan, jump, openStock, watched, toggleWatch }: {
  scan: Scan; market: Scan["markets"][number]; st: Settings; scanning: boolean; owned: Set<string>;
  mkt: "bist" | "us"; chooseMkt: (v: "bist" | "us") => void; startScan: () => void; jump: { t: string; n: number } | null; openStock: (t: string) => void;
  watched: Set<string>; toggleWatch: (s: Stock) => void;
}) {
  // önceki günün taramasına göre değişim: puan farkı, yeni giren adaylar, listeden düşenler
  const [prev, setPrev] = useState<Awaited<ReturnType<typeof api.prevScores>>>(null);
  useEffect(() => { let on = true; api.prevScores(scan.id).then(p => on && setPrev(p)).catch(() => {}); return () => { on = false; }; }, [scan.id]);
  const [filter, setFilter] = useState<Filter>("all");
  const [quad, setQuad] = useState<Quad | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const max = scan.params.maxScore ?? 10, hold = scan.params.hold;
  useEffect(() => { setSel(null); setFilter("all"); setQuad(null); }, [m.market]);
  const counts = useMemo(() => ({
    all: m.stocks.length,
    ALINIR: m.stocks.filter(s => s.verdict === "ALINIR").length,
    KARARSIZ: m.stocks.filter(s => s.verdict === "KARARSIZ").length,
    ALINMAZ: m.stocks.filter(s => s.verdict === "ALINMAZ").length,
  }), [m]);
  const qc = useMemo(() => {
    const o = { lead: 0, weak: 0, lag: 0, impr: 0 } as Record<Quad, number>;
    for (const s of m.stocks) { const q = quadOf(s.rrg?.[s.rrg.length - 1]); if (q) o[q]++; }
    return o;
  }, [m]);
  const rows = m.stocks.filter(s => (filter === "all" || s.verdict === filter) && (!quad || quadOf(s.rrg?.[s.rrg.length - 1]) === quad));
  const stock = m.stocks.find(s => s.ticker === sel) ?? rows[0] ?? m.stocks[0] ?? null;
  const tt = m.stocks.filter(s => s.tt).length;
  const r = m.regime;
  const picks = m.stocks.filter(s => s.verdict === "ALINIR");
  const top6 = [...m.stocks].sort((a, b) => b.score - a.score || b.rs - a.rs).slice(0, 6);
  const ownedHere = m.stocks.filter(s => owned.has(s.ticker));
  const accN = useMemo(() => reaccel(m.stocks).length, [m.stocks]);
  const finding = `${MKT[m.market]} son 20 günde ${pct(r.chg20)}, 200 günlük ortalamanın ${r.ok ? "üstünde ve 50 günlük yükselişte" : r.close < r.sma200 ? "altında" : "üstünde ama 50 günlük ortalama düşüyor"}. `
    + `${m.stocks.length} hisseden ${tt} tanesi Stage 2 trendinde, ${qc.lead} tanesi lider bölgede; ${counts.ALINIR ? counts.ALINIR + " alınır aday var." : "alınır aday yok."}`
    + (ownedHere.length ? ` Portföyündeki ${ownedHere.map(s => `${s.symbol} ${QUAD[quadOf(s.rrg?.[s.rrg.length - 1]) ?? "lag"].name.toLocaleLowerCase("tr-TR")}`).join(", ")} bölgede.` : "");

  const root = useRef<HTMLElement>(null), tbody = useRef<HTMLTableSectionElement>(null), hl = useRef<HTMLDivElement>(null);
  useGSAP(() => {
    if (reduced()) return;
    gsap.timeline({ delay: 0.1 })
      .from(".hero-side .kpi", { y: 18, opacity: 0, stagger: 0.07, duration: 0.6 }, 0)
      .from(".finding", { opacity: 0, y: 6, duration: 0.7 }, 0.25)
      .from(".quad-cell", { y: 14, opacity: 0, stagger: 0.06, duration: 0.5 }, 0.4)
      .from(".ladder-bar span", { scaleX: 0, transformOrigin: "left center", stagger: 0.1, duration: 0.8, ease: "expo.out" }, 0.5)
      .from(gsap.utils.toArray(".pick"), { y: 10, opacity: 0, stagger: 0.06, duration: 0.8, ease: "expo.out" }, 0.7);
  }, { scope: root, dependencies: [m.market, scan.id] });
  useGSAP(() => {
    if (reduced() || !tbody.current) return;
    gsap.from(tbody.current.children, { opacity: 0, x: -10, duration: 0.45, stagger: { each: 0.02, amount: 0.45 }, clearProps: "all" });
  }, { dependencies: [m.market, filter, quad, scan.id], scope: tbody });
  useLayoutEffect(() => {
    const row = tbody.current?.querySelector<HTMLElement>(`tr[data-t="${stock?.ticker}"]`), h = hl.current;
    if (!row || !h) { if (h) h.style.opacity = "0"; return; }
    gsap.to(h, { y: row.offsetTop, height: row.offsetHeight, opacity: 1, duration: reduced() ? 0 : 0.4, ease: "smooth" });
  }, [stock?.ticker, filter, quad, rows.length]);
  useEffect(() => { if (jump && m.stocks.some(s => s.ticker === jump.t)) select(jump.t); }, [jump?.n, m.market]); // eslint-disable-line
  const select = (t: string) => {
    setSel(t);
    if (!rows.some(x => x.ticker === t)) { setFilter("all"); setQuad(null); }
    // yalnızca tablonun kendi kaydırma alanı oynar; sayfa (ve harita) yerinde kalır
    requestAnimationFrame(() => {
      const row = tbody.current?.querySelector<HTMLElement>(`tr[data-t="${t}"]`), box = row?.closest<HTMLElement>(".table-wrap");
      if (!row || !box) return;
      const top = row.offsetTop - box.clientHeight / 2 + row.offsetHeight / 2;
      box.scrollTo({ top: Math.max(0, top), behavior: reduced() ? "auto" : "smooth" });
    });
  };

  return (
    <section ref={root} className="page">
      <header className="titlebar">
        <div className="title-left">
          <h1>Tarama</h1>
          <p className="meta">1–2 aylık swing: Trend Template, kırılım, geri çekilme, VCP · 2×ATR ilk stop, haftalık HAHO altı kapanışta çıkış, en çok {hold} gün</p>
        </div>
        <div className="actions">
          <Tabs label="Piyasa" value={mkt} onChange={chooseMkt} items={scan.markets.map(x => ({ id: x.market, text: MKT[x.market] }))} />
            <button className={"btn" + (scanning ? " is-scanning" : "")} onClick={startScan} disabled={scanning} aria-describedby="scan-help">
              <span className="scan-dot" aria-hidden />{scanning ? "Taranıyor" : "Şimdi tara"}
            </button>
          <span id="scan-help" className="sr-only">İki piyasayı bulutta yaklaşık 10 saniyede tarar.</span>
        </div>
      </header>

      <Hero3D stocks={m.stocks} owned={owned} selected={sel}
        onPick={t => { select(t); requestAnimationFrame(() => scrollToEl(".split")); }}
        mid={<>
          <p className="h3d-kicker">Son iki hafta · rotasyon ivmesi</p>
          <h2 className="h3d-title">{accN} hisse<br /><em>yeniden ivmeleniyor.</em></h2>
          <p className="h3d-sub">Momentumu dipten dönüp art arda yükselen hisseler. Ekrandaki kodlara tıkla, hisse açılır. İvme tek başına alım sinyali değildir; karar puanı aşağıda.</p>
        </>}
        end={<>
          <p className="h3d-kicker">Piyasa rejimi</p>
          <h2 className="h3d-title">{r.ok ? <>Rejim olumlu.<br /><em>Boyutu koru.</em></> : <>Endeks zayıf.<br /><em>Boyutu küçük tut.</em></>}</h2>
          <p className="h3d-sub">{counts.ALINIR ? `${counts.ALINIR} alınır aday var.` : "Alınır aday yok."} Aşağıda rotasyon haritası, adaylar ve her hissenin planı.</p>
        </>}>
        <p className="h3d-kicker">{MKT[m.market]} · son tarama {when(scan.created_at)}</p>
        <h2 className="h3d-title">{m.stocks.length} hisse.<br /><em>{qc.lead}</em> tanesi lider.</h2>
        <p className="h3d-sub">{counts.ALINIR ? `${counts.ALINIR} alınır aday var.` : "Bu taramada alınır aday yok."} Endeks 20 günde {pct(r.chg20)}, {r.ok ? "rejim olumlu." : "rejim zayıf, boyut küçük tutulmalı."}</p>
        <p className="h3d-hint"><span aria-hidden>↓</span> Kaydır: küre rotasyon haritasına dönüşür</p>
      </Hero3D>

      <div className="hero">
        <div className="panel">
          <Rotation stocks={m.stocks} selected={sel} onSelect={t => (t === sel ? setSel(null) : select(t))} scanning={scanning} owned={owned} quad={quad} version={scan.id + m.market} />
        </div>
        <div className="hero-side">
          <div className="kpis">
            <div className="kpi"><span className="kpi-label">{m.bench === "^NDX" ? "Nasdaq-100" : "BIST 100"} kapanış</span><span className="display-num kpi-xl"><CountUp key={m.market + scan.id} to={Math.round(r.close)} duration={1.3} separator="." /></span></div>
            <div className="kpi"><span className="kpi-label">20 günde</span><span className={"kpi-val " + (r.chg20 >= 0 ? "pos" : "neg")}>{pct(r.chg20)}</span></div>
            <div className="kpi"><span className="kpi-label">200g ortalamaya</span><span className="kpi-val">{pct(r.close / r.sma200 - 1)}</span></div>
            <div className="kpi"><span className="kpi-label">Rejim</span><span className={"pill pill-lg " + (r.ok ? "pos" : "neg")}>{r.ok ? "Swing'e uygun" : "Zayıf, boyutu küçült"}</span></div>
          </div>
          <p className="finding">{finding}</p>
          <div className="quad-table" role="group" aria-label="Rotasyon çeyreklerine göre süz">
            {(["lead", "weak", "impr", "lag"] as Quad[]).map(q => (
              <button key={q} className={"quad-cell" + (q === "lead" ? " lead" : "")} aria-pressed={quad === q} onClick={() => setQuad(quad === q ? null : q)}>
                <span className="display-num">{qc[q]}</span><span className="small">{QUAD[q].name}</span>
              </button>
            ))}
          </div>
          <div className="ladder">
            <div className="ladder-bar" role="img" aria-label={`Alınır ${counts.ALINIR}, kararsız ${counts.KARARSIZ}, alınmaz ${counts.ALINMAZ}`}>
              <span className="l-pos" style={{ flexGrow: counts.ALINIR || 0.0001 }} />
              <span className="l-warn" style={{ flexGrow: counts.KARARSIZ || 0.0001 }} />
              <span className="l-neg" style={{ flexGrow: counts.ALINMAZ || 0.0001 }} />
            </div>
            <div className="ladder-legend"><span><b>{counts.ALINIR}</b> alınır</span><span><b>{counts.KARARSIZ}</b> kararsız</span><span><b>{counts.ALINMAZ}</b> alınmaz</span><span className="muted">liste: {m.source ?? "KAP / Nasdaq"}</span></div>
          </div>
          {picks.length > 0 && <div className="picks">{picks.map(s => <button key={s.ticker} className="pick" onClick={() => select(s.ticker)}>{s.symbol}<span className="num">{s.score}/{max}</span></button>)}</div>}
          <div className="leaders" aria-labelledby="lead-h">
            <h3 id="lead-h" className="small">En yüksek puanlı 6 hisse</h3>
            {top6.map(s => (
              <button key={s.ticker} className="leader" aria-current={sel === s.ticker || undefined} onClick={() => select(s.ticker)}>
                <span className="sym">{s.symbol}</span>
                <span className={"pill " + VCLASS[s.verdict]}>{VTEXT[s.verdict]} {s.score}</span>
                <span className={"num " + (s.chg20 >= 0 ? "pos" : "neg")}>{pct(s.chg20)}</span>
                <Odds mc={s.mc} hold={hold} />
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="split">
        <section className="panel list-panel" aria-labelledby="list-h">
          <div className="panel-head">
            <h2 id="list-h">Adaylar{quad ? <span className="small muted" style={{ fontWeight: 400 }}> · {QUAD[quad].name} <button className="link" onClick={() => setQuad(null)}>temizle</button></span> : null}</h2>
            <Tabs label="Karar filtresi" value={filter} onChange={setFilter}
              items={[{ id: "all", text: "Tümü", count: counts.all }, { id: "ALINIR", text: "Alınır", count: counts.ALINIR }, { id: "KARARSIZ", text: "Kararsız", count: counts.KARARSIZ }, { id: "ALINMAZ", text: "Alınmaz", count: counts.ALINMAZ }] as { id: Filter; text: string; count: number }[]} />
          </div>
          {prev && (() => {
            const now = m.stocks.filter(s => s.verdict !== "ALINMAZ"), was = (t: string) => prev.by[t] && prev.by[t].verdict !== "ALINMAZ";
            const inn = now.filter(s => !was(s.ticker)).map(s => s.symbol), out = m.stocks.filter(s => s.verdict === "ALINMAZ" && was(s.ticker)).map(s => s.symbol);
            const mv = m.stocks.filter(s => prev.by[s.ticker] && prev.by[s.ticker].score !== s.score).length;
            return <p className="small muted cand-diff">Önceki taramaya ({when(prev.at)}) göre: {inn.length ? <>aday listesine giren <b>{inn.join(", ")}</b>; </> : "aday listesine giren yok; "}{out.length ? <>çıkan <b>{out.join(", ")}</b>; </> : "çıkan yok; "}{mv} hissenin puanı değişti.</p>;
          })()}
          <div className="table-wrap" data-lenis-prevent>
            <div className="row-hl" ref={hl} aria-hidden />
            <table>
              <thead><tr><th>Hisse</th><th>Puan</th><th>Karar</th><th className="hide-m">Rotasyon</th><th className="hide-m">Kurulum</th><th className="r">20g</th><th className="hide-m hide-l" title="Monte Carlo: kârlı kapanış / zararla çıkış / ilk stop">Kârlı / zarar / stop</th></tr></thead>
              <tbody ref={tbody}>
                {rows.map(s => {
                  const q = quadOf(s.rrg?.[s.rrg.length - 1]);
                  return (
                    <tr key={s.ticker} data-t={s.ticker} aria-current={stock?.ticker === s.ticker ? "true" : undefined} tabIndex={0} onClick={() => select(s.ticker)}
                      onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); select(s.ticker); } }}>
                      <td><span className="sym">{s.symbol}<WatchBtn on={watched.has(s.ticker)} onClick={() => toggleWatch(s)} sym={s.symbol} />{owned.has(s.ticker) && <span className="pill accent" style={{ marginLeft: 8 }}>portföyde</span>}</span><span className="sub">{s.name !== s.symbol ? s.name : s.sector ?? ""}</span></td>
                      <td><span className="score-cell"><span className="num">{s.score}</span><Seg score={s.score} max={max} verdict={s.verdict} />{(() => { const p0 = prev?.by[s.ticker]; if (!prev) return null; if (!p0) return <span className="chg-tag new" title="Önceki taramada endekste yoktu">yeni</span>; const d = s.score - p0.score; return d ? <span className={"chg-tag " + (d > 0 ? "up" : "dn")} title={`Önceki tarama (${when(prev.at)}): ${p0.score}`}>{d > 0 ? "+" : "−"}{Math.abs(d)}</span> : null; })()}</span></td>
                      <td><span className={"pill " + VCLASS[s.verdict]}>{VTEXT[s.verdict]}</span></td>
                      <td className="hide-m"><span className={"quad-tag" + (q === "lead" ? " lead" : "")}>{q ? QUAD[q].name : "—"}</span></td>
                      <td className="small hide-m">{s.setups.length ? s.setups.map(k => SETUP[k]).join(", ") : <span className="muted">—</span>}</td>
                      <td className={"r " + (s.chg20 >= 0 ? "" : "muted")}>{pct(s.chg20)}</td>
                      <td className="hide-m hide-l"><Odds mc={s.mc} hold={hold} /></td>
                    </tr>);
                })}
                {!rows.length && <tr><td colSpan={7} className="empty-row">Bu süzgeçte hisse yok. {filter === "ALINIR" ? "Zayıf piyasada sistem bilerek az sinyal verir." : ""}</td></tr>}
              </tbody>
            </table>
          </div>
        </section>
        {stock && <Detail key={scan.id + stock.ticker} s={stock} scanId={scan.id} st={st} hold={hold} max={max} owned={owned.has(stock.ticker)} onOpen={() => openStock(stock.ticker)} watch={{ on: watched.has(stock.ticker), toggle: () => toggleWatch(stock) }} />}
      </div>
      <p className="foot">
        Yatırım tavsiyesi değildir. Puanlar kurallı bir taramanın ve geçmiş verinin özetidir; backtest ve simülasyon geleceği garanti etmez.
        Kaynak: Yahoo günlük veri, KAP ve Nasdaq endeks listeleri{scan.params.kronos ? ", Kronos (NeoQuasar/Kronos-small)" : ""}. Rotasyon: hisse/endeks oranının 50 günlük ortalamasına göre seviyesi ve 10 günlük ivmesi.
      </p>
    </section>
  );
}

// ---------------------------------------------------------------- hisse detayı
function Detail({ s, scanId, st, hold, max, owned, extra, onOpen, watch }: { s: Stock; scanId: number; st: Settings; hold: number; max: number; owned: boolean;
  extra?: { deep?: api.DeepStock; bars?: Bar[]; loading: boolean }; onOpen?: () => void; watch?: { on: boolean; toggle: () => void } }) {
  const [b, setB] = useState<Bar[] | null>(null);
  const [note, setNote] = useState("");
  const [saved, setSaved] = useState<"idle" | "saving" | "ok" | "err">("idle");
  const ref = useRef<HTMLElement>(null);
  // mumlar: ilk 30 hissede taramadan; diğerlerinde hisse sayfasının isteğe bağlı analizinden (extra.bars)
  useEffect(() => { let on = true; if (s.hasBars) api.bars(scanId, s.ticker).then(x => on && setB(x)).catch(() => on && setB([])); else setB(extra?.bars?.length ? extra.bars : extra?.loading ? null : []); return () => { on = false; }; }, [s.ticker, s.hasBars, scanId, extra?.bars, extra?.loading]);
  useGSAP(() => {
    if (reduced()) return;
    gsap.timeline()
      .from(".sym-lg", { y: 8, opacity: 0, duration: 0.6 }, 0)
      .from(".d-price > *", { y: 10, opacity: 0, stagger: 0.06, duration: 0.5 }, 0.05)
      .from(".d-verdict", { y: 12, opacity: 0, duration: 0.5 }, 0.1)
      .from(".why li", { x: -10, opacity: 0, stagger: 0.05, duration: 0.45 }, 0.25);
    reveal(ref.current, ".chart-box, .d-grid section, .d-add");
  }, { scope: ref, dependencies: [s.ticker] });
  const shares = api.sizeFor(s, st);
  const p = s.plan, h = s.hist, k = s.kronos;
  const lines = useMemo<PriceLine[]>(() => [
    { price: p.entry, title: "Giriş", tone: "ink" }, { price: p.stop, title: "Stop", tone: "stop" }, p.exitRule ? (p.haho != null ? { price: p.haho, title: "Haftalık HAHO", tone: "target" } : null) : { price: p.target, title: "Hedef 2R", tone: "target" }].filter(Boolean) as PriceLine[], [p.entry, p.stop, p.target, p.haho]);
  const q = quadOf(s.rrg?.[s.rrg.length - 1]);
  const add = async () => {
    setSaved("saving");
    try { await api.addTrade(s, shares || null, note); setSaved("ok"); setNote(""); } catch { setSaved("err"); }
  };
  return (
    <aside className="panel detail" ref={ref} aria-labelledby="d-h">
      <div className="d-head">
        <div>
          <h2 id="d-h" className="sym-lg">{s.symbol}{watch && <WatchBtn on={watch.on} onClick={watch.toggle} sym={s.symbol} big />}</h2>
          <p className="d-name">{s.name !== s.symbol ? s.name + " · " : ""}{s.sector || MKT[s.market]}{owned ? " · portföyünde" : ""}</p>
          {onOpen && <button className="link d-open" onClick={onOpen}>Hisse sayfasını aç: haberler, öneri, rotasyon →</button>}
        </div>
        <div className="d-price">
          {s.live != null ? <>
            <span className="display-num price"><span className="cur">{s.market === "bist" ? "₺" : "$"}</span>{trNum(s.live)}</span>
            <span className={"small " + ((s.liveChg ?? 0) >= 0 ? "pos" : "neg")}>{pct(s.liveChg ?? 0, 2)} {s.liveOpen === false ? "günlük, son fiyat" : "seans içi"} · {s.liveAt ? new Date(s.liveAt).toLocaleString("tr-TR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : ""}{s.market === "bist" ? " (≈15 dk gecikmeli)" : ""}</span>
            <span className="small muted">Taramadaki kapanış {trNum(s.close)} · plan kapanışa göre</span>
          </> : <>
            <span className="display-num price"><span className="cur">{s.market === "bist" ? "₺" : "$"}</span>{trNum(s.close)}</span>
            <span className={"small " + (s.chg1d >= 0 ? "pos" : "neg")}>{pct(s.chg1d, 2)} son gün</span>
          </>}
        </div>
      </div>

      <div className="d-verdict">
        <div className="score-big">
          <span className="display-num"><CountUp to={s.score} duration={0.9} /><small>/{max}</small></span>
          <Seg score={s.score} max={max} verdict={s.verdict} lg />
        </div>
        <div>
          <span className={"pill pill-lg " + VCLASS[s.verdict]}>{VTEXT[s.verdict]}</span>
          <ul className="why">{s.why.map(w => <li key={w} className={w.startsWith("-") ? "neg" : w.startsWith("! ") ? "warn" : w.startsWith("0 ") ? "muted" : ""}><span className="num">{w.split(" ")[0]}</span> {w.split(" ").slice(1).join(" ")}</li>)}</ul>
        </div>
      </div>

      {b === null ? <div className="chart skel" aria-busy="true" /> : b.length ? <Chart bars={b} lines={lines} kronos={k} entry={p.entry} label={`${s.symbol} günlük mum grafiği, giriş, stop ve hedef çizgileri`} />
        : <p className="chart chart-none muted small">{onOpen ? "Grafik taramada yalnızca puanı en yüksek 30 hisse için saklanır; hisse sayfasında her hisse için çizilir." : "Grafik verisi alınamadı."}</p>}

      <div className="d-grid">
        <section aria-labelledby="plan-h">
          <h3 id="plan-h">Plan</h3>
          <dl className="facts">
            <dt>Giriş</dt><dd>{money(p.entry, s.market)}</dd>
            <dt>{p.exitRule ? "İlk stop" : "Stop"}</dt><dd className="neg">{money(p.stop, s.market)} <span className="muted">{pct(-p.riskPct / 100)}</span></dd>
            {p.exitRule ? <>
              <dt>Çıkış: haftalık kapanış HAHO altı</dt><dd>{p.haho != null ? <>{money(p.haho, s.market)} <span className="muted">{pct(p.haho / p.entry - 1)}</span></> : "—"}</dd>
              <dt>En çok</dt><dd>{p.maxDays} işlem günü</dd>
            </> : <><dt>Hedef 2R</dt><dd className="pos">{money(p.target, s.market)} <span className="muted">{pct((2 * p.riskPct) / 100)}</span></dd></>}
            <dt>Adet · %{trNum(st.risk_pct, 1)} risk</dt><dd>{shares.toLocaleString("tr-TR")} <span className="muted">≈ {money(shares * p.entry, s.market)}</span></dd>
            <dt>Stopta kayıp</dt><dd>{money(shares * (p.entry - p.stop), s.market)}</dd>
          </dl>
        </section>
        <section aria-labelledby="odds-h">
          <h3 id="odds-h">Zaman makinesi</h3>
          <Odds mc={s.mc} big hold={hold} />
          {isExitMc(s.mc) ? <>
            <dl className="facts">
              <dt><i className="key key-t" />Kârlı kapanış</dt><dd>{pct(s.mc.win, 0, false)}</dd>
              <dt><i className="key key-n" />Zararla çıkış</dt><dd>{pct(Math.max(0, 1 - s.mc.win - s.mc.stop), 0, false)}</dd>
              <dt><i className="key key-s" />İlk stop</dt><dd>{pct(s.mc.stop, 0, false)}</dd>
              <dt>Ortalama sonuç</dt><dd className={s.mc.meanR >= 0 ? "pos" : "neg"}>{(s.mc.meanR >= 0 ? "+" : "−") + trNum(Math.abs(s.mc.meanR))}R <span className="muted">{pct(s.mc.meanPct)}</span></dd>
              <dt>Medyan süre</dt><dd>{s.mc.medDays} gün</dd>
            </dl>
            <p className="small muted">Son 250 günün mumları 10 günlük bloklarla {s.mc.paths.toLocaleString("tr-TR")} yola dizildi (seed {s.mc.seed}); çıkışların {pct(s.mc.haho, 0, false)}'i HAHO, {pct(s.mc.time, 0, false)}'i {s.mc.maxDays} gün sınırı.</p>
          </> : <>
            <dl className="facts">
              <dt><i className="key key-t" />Hedef önce</dt><dd>{pct(s.mc.target, 0, false)}</dd>
              <dt><i className="key key-n" />{hold} gün doldu</dt><dd>{pct(s.mc.neither, 0, false)}</dd>
              <dt><i className="key key-s" />Stop önce</dt><dd>{pct(s.mc.stop, 0, false)}</dd>
            </dl>
            <p className="small muted">Son 250 günün mumlarından {s.mc.paths.toLocaleString("tr-TR")} yol (seed {s.mc.seed}).</p>
          </>}
        </section>
        <section className="wide" aria-labelledby="hist-h">
          <h3 id="hist-h">Geçmiş ve rotasyon</h3>
          <p className="small">
            {SETUP[s.histSetup]} kuralı, 3 yıl: {h.n ? <><b className="num">{h.n}</b> sinyal → {h.haho != null ? <><b className="num">{h.stop}</b> ilk stop, <b className="num">{h.haho}</b> HAHO çıkışı, <b className="num">{h.time}</b> süre doldu; kârlı <b className="num">{pct(h.win ?? 0, 0, false)}</b>, ortalama <b className="num">{trNum(h.avgDays ?? 0, 0)}</b> gün;</> : <><b className="num">{h.target}</b> hedef, <b className="num">{h.stop}</b> stop, <b className="num">{h.time}</b> süre doldu;</>} ortalama <b className="num">{h.avgR == null ? "—" : (h.avgR >= 0 ? "+" : "−") + trNum(Math.abs(h.avgR)) + "R"}</b>.</> : "bu hissede kural hiç tetiklenmemiş."}
            {h.n > 0 && h.n < 5 && <span className="muted"> Örnek az, güvenme.</span>}
            {q && s.rrg && <> Rotasyonda <b>{QUAD[q].name.toLocaleLowerCase("tr-TR")}</b> bölgede (RS-oran {s.rrg[s.rrg.length - 1][0].toFixed(1)}, momentum {s.rrg[s.rrg.length - 1][1].toFixed(1)}; 6 hafta önce {QUAD[quadOf(s.rrg[0])!].name.toLocaleLowerCase("tr-TR")}).</>}
          </p>
        </section>
        <section className="wide" aria-labelledby="k-h">
          <h3 id="k-h">Kronos tahmini <span className="pill neutral">deneysel, puana katılmaz</span></h3>
          {k ? (
            <dl className="facts" style={{ gridTemplateColumns: "repeat(4, auto 1fr)" }}>
              <dt>20g yukarı</dt><dd>{pct(k.pUp20, 0, false)}</dd>
              <dt>20g medyan</dt><dd>{pct(k.med20)}</dd>
              <dt>40g medyan</dt><dd>{pct(k.med40)}</dd>
              <dt>40g %10–%90</dt><dd>{pct(k.p10)} … {pct(k.p90)}</dd>
            </dl>
          ) : <p className="small muted">Bulut taramasında Kronos yok. Masaüstündeki "Swing Radar Kronos Tarama" kısayolu ekran kartında hesaplayıp buraya yükler. Geriye dönük testte yön isabeti yazı-tura düzeyinde çıktığı için karara etkisi yok.</p>}
        </section>
      </div>
      {extra ? <DeepView s={s} over={extra.deep} loading={extra.loading} /> : <DeepView s={s} />}

      <form className="d-add" onSubmit={e => { e.preventDefault(); add(); }}>
        <label htmlFor="note" className="small">Günlüğe ekle</label>
        <input id="note" value={note} onChange={e => setNote(e.target.value)} placeholder="Neden aldın? (isteğe bağlı)" maxLength={200} />
        <button className="btn" disabled={saved === "saving"}>{saved === "saving" ? "Ekleniyor…" : `${shares || "—"} adet ekle`}</button>
        <span className="small" role="status">{saved === "ok" ? "Günlüğe eklendi." : saved === "err" ? "Eklenemedi, tekrar dene." : ""}</span>
      </form>
    </aside>
  );
}

// Logo: vişne çürüğü rozet üzerinde krem çizim. "0"dan çıkan fiyat oku mumlarla yükselir, bir kez geri çekilir (sola yatık Z / N),
// sonra rezidansın en üst katına uzanır. Altında oka eşlik eden şehir çubukları, en altta zemin çizgisi.
const LP: [number, number][] = [[14.5, 30], [29, 16.5], [33.5, 21.5], [46, 8.5]];
const onPath = (x: number) => { for (let i = 0; i < LP.length - 1; i++) { const [x0, y0] = LP[i], [x1, y1] = LP[i + 1]; if (x <= x1) return y0 + (y1 - y0) * (x - x0) / (x1 - x0); } return LP[LP.length - 1][1]; };
const LC = (() => {
  const out: { x: number; y: number; up: boolean }[] = [];
  const seg = (i: number, n: number, up: boolean) => { const [x0] = LP[i], [x1] = LP[i + 1]; for (let k = 1; k <= n; k++) { const x = x0 + (x1 - x0) * (k - 0.5) / n; out.push({ x, y: onPath(x), up }); } };
  seg(0, 6, true); seg(1, 2, false); seg(2, 5, true);
  return out;
})();
const BARS = Array.from({ length: 16 }, (_, i) => 16.5 + i * 1.75).map(x => ({ x, top: onPath(x) + 4.2 }));
function Mark() {
  return (
    <svg className="mark" viewBox="0 0 64 40" aria-hidden>
      <rect className="lg-bg" width="64" height="40" rx="8" />
      {BARS.map(b => <line key={b.x} className="lg-bar" x1={b.x} x2={b.x} y1={b.top} y2={34.5} />)}
      {/* yan kanat (cam) */}
      <path className="lg-wing" d="M43.4 34.5V22.6L47.6 20.4V34.5z" />
      <path className="lg-glass" d="M45.5 21.5V34.5M43.4 25.6H47.6M43.4 28.6H47.6M43.4 31.6H47.6" />
      {/* rezidans: kademeli kule, tepe ve sivri uç */}
      <path className="lg-tower" d="M48 34.5V15.2h1.6V11h1.5V7.6h3.8V11h1.5v4.2h1.6v19.3z" />
      <path className="lg-glass" d="M50.6 15.2V34.5M53 11V34.5M55.4 15.2V34.5M48 18.4H57M48 21.6H57M48 24.8H57M48 28H57M48 31.2H57M49.6 13.1H55.4" />
      <path className="lg-spire" d="M53 7.6V2.4" />
      <line className="lg-base" x1="4.5" x2="59.5" y1="34.6" y2="34.6" />
      <ellipse className="lg-zero" cx="9.4" cy="26.6" rx="3.7" ry="6.6" />
      {/* fiyat oku */}
      <path className="lg-arrow" d={"M" + LP.map(p => p.join(" ")).join("L") + "L49.6 5.4"} />
      <path className="lg-head" d="M51.6 3.4L46.6 4.6 50.4 8.4z" />
      {LC.map((c, i) => (
        <g key={i} className={c.up ? "lg-up" : "lg-dn"}>
          <line x1={c.x} x2={c.x} y1={c.y - 2.5} y2={c.y + 2.5} />
          <rect x={c.x - 0.8} y={c.y - 1.5} width={1.6} height={3} rx={0.3} />
        </g>
      ))}
    </svg>
  );
}
