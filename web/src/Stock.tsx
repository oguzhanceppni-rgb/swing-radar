import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import * as api from "./api";
import type { Advice, NewsItem, Scan, Settings, Stock, StockExtra } from "./api";
import { MKT, QUAD, VCLASS, VTEXT, WatchBtn, quadOf, money, pct, trNum, when } from "./ui";
import { gsap, useGSAP, reduced } from "./motion";
import Rotation from "./Rotation";
import { ATONE, AdvBody, advSince } from "./Portfolio";

// Hisse sayfası (#hisse/TICKER): öneri + analiz (plan, grafik, zaman makinesi, derin analiz) + rotasyon haritası + hisseye özel haberler.
// Derin analiz ve haberler yalnızca sayfa açılınca bulutta hesaplanır (swing_stock_start); 6 saatten yeniyse yeniden istenmez.
const FRESH_MS = 6 * 3600e3;
const sg = (n: number) => (n > 0 ? "+" : n < 0 ? "−" : "") + Math.abs(n);
const ago = (iso: string) => { const h = (Date.now() - Date.parse(iso)) / 36e5; return h < 1 ? "az önce" : h < 24 ? `${Math.round(h)} saat önce` : `${Math.round(h / 24)} gün önce`; };
const tone = (p: number) => (p > 0 ? "pozitif" : p < 0 ? "negatif" : "nötr");

// portföyde olmayan hisse için kural özeti: taramanın kararı + eksikler + derin analiz + haber sayısı (mekanik; yorum değil)
function ruleCard(s: Stock, st: Settings, max: number, x: StockExtra | null): Pick<Advice, "symbol" | "action" | "title" | "body"> {
  const L: string[] = [], p = s.plan, shares = api.sizeFor(s, st);
  const miss: string[] = [];
  if (!s.tt) miss.push("Stage 2 trendi (Trend Template)");
  if (!s.setups.length) miss.push("kurulum (55g kırılım ya da geri çekilme)");
  if (!s.regimeOk) miss.push("endeks rejimi");
  if (s.earn && s.earn.days <= 14) miss.push(`bilanço ${s.earn.days === 0 ? "bugün" : s.earn.days + " gün içinde"}`);
  if (s.ern && !s.ern.good) miss.push("son bilançoda büyüme yavaşladı");
  if (!s.liquid) miss.push("işlem hacmi");
  let action = "İZLE", title = "";
  if (s.verdict === "ALINIR") {
    action = "AL"; title = `Tarama ALINIR ${s.score}/${max}`;
    L.push(`Kural: giriş ~${money(p.entry, s.market)}, ilk stop ${money(p.stop, s.market)} (${pct(-p.riskPct / 100)}), çıkış haftalık kapanış HAHO altı. %${trNum(st.risk_pct, 1)} riskle ${shares.toLocaleString("tr-TR")} adet ≈ ${money(shares * p.entry, s.market)}.`);
  } else if (s.verdict === "KARARSIZ") {
    title = `Kararsız ${s.score}/${max}: ALINIR için eksik var`;
    L.push(`Kural: yeni giriş yok, izle. Eksik: ${miss.join(", ") || `puan ${s.score}/6`}.`);
  } else {
    action = "BEKLE"; title = `Alınmaz ${s.score}/${max}`;
    L.push(`Kural: yeni giriş için uygun değil. Eksik: ${miss.join(", ") || "puan yetersiz"}.`);
  }
  const d = x?.deep;
  if (d && !d.error && d.tech && d.fund) {
    const top = (w: string[]) => w.filter(y => !y.startsWith("0 ")).slice(0, 2).map(y => y.replace(/^[+-]\d+ /, "")).join("; ");
    L.push(`Teknik ${tone(d.tech.pts)} (${sg(d.tech.pts)}): ${top(d.tech.why) || "puanlanan sinyal yok"}.`);
    L.push(`Bilanço: temel ${tone(d.fund.pts)} (${sg(d.fund.pts)})${top(d.fund.why) ? ": " + top(d.fund.why) : ""}.`);
  } else if (s.ern) L.push(`Bilanço: ${s.ern.period} net kâr yıllık ${pct(s.ern.g, 0)}${s.ern.gp != null ? ` (önceki çeyrek ${pct(s.ern.gp, 0)})` : ""}.`);
  if (s.earn && s.earn.days > 14) L.push(`Bilanço (takvim): sonraki açıklama ${s.earn.date.slice(8)}.${s.earn.date.slice(5, 7)}.${s.earn.date.slice(0, 4)}${s.earn.est ? " (tahmini)" : ""}.`);
  const items = x?.news.items ?? [], rec = items.filter(i => i.at && Date.now() - Date.parse(i.at) < 96 * 3600e3);
  if (x) L.push(rec.length ? `Haber (son 4 gün, ${rec.length} başlık): “${rec[0].t.slice(0, 140)}” (${rec[0].src}).` : "Haber: son 4 günde hisseye özel başlık yok.");
  return { symbol: s.symbol, action, title, body: L.join("\n") };
}

export default function StockPage({ s, scan, st, owned, back, open, detail, watched, toggleWatch }: {
  s: Stock; scan: Scan; st: Settings; owned: Set<string>; back: () => void; open: (ticker: string) => void; watched: boolean; toggleWatch: () => void;
  detail: (extra: { deep?: StockExtra["deep"]; bars?: api.Bar[]; loading: boolean }) => ReactNode;
}) {
  const [x, setX] = useState<StockExtra | null>(null);
  const [busy, setBusy] = useState(true), [err, setErr] = useState<string | null>(null);
  const [adv, setAdv] = useState<Advice[]>([]);
  const ref = useRef<HTMLElement>(null);
  const max = scan.params.maxScore ?? 9, m = scan.markets.find(k => k.market === s.market)!;
  const isOwned = owned.has(s.ticker);

  useEffect(() => {
    let on = true;
    (async () => {
      setBusy(true); setErr(null); setX(null);
      try {
        let r = await api.stockExtra(s.ticker);
        if (on && r?.data) setX(r.data);
        const fresh = r?.status === "done" && r.data && r.data.scanId === scan.id && Date.now() - Date.parse(r.data.at) < FRESH_MS;
        if (!fresh) {
          const t0 = Date.now();
          if (r?.status !== "running") await api.startStockExtra(s.ticker);
          for (;;) {
            await new Promise(k => setTimeout(k, 2500));
            if (!on) return;
            r = await api.stockExtra(s.ticker);
            if (r?.status === "error") throw new Error(r.error ?? "Analiz alınamadı");
            if (r?.status === "done" && r.updated_at && Date.parse(r.updated_at) >= t0 - 3000) { setX(r.data); break; }
            if (Date.now() - t0 > 150_000) throw new Error("Analiz 150 saniyede bitmedi; sayfayı yeniden aç.");
          }
        }
      } catch (e: any) { if (on) setErr(e?.code === "not_granted" ? "Sayfanın Supabase'e erişmesine izin ver ve yenile." : e?.message ?? String(e)); }
      finally { if (on) setBusy(false); }
    })();
    if (isOwned) api.adviceFor(s.symbol).then(a => on && setAdv(a)).catch(() => {}); else setAdv([]);
    return () => { on = false; };
  }, [s.ticker, scan.id]); // eslint-disable-line

  useGSAP(() => { if (!reduced()) gsap.from(".stk-card, .stk-side > *", { y: 14, opacity: 0, stagger: 0.07, duration: 0.5, clearProps: "all" }); }, { scope: ref, dependencies: [s.ticker] });

  const card = useMemo(() => ruleCard(s, st, max, x), [s, st, max, x]);
  const q = quadOf(s.rrg?.[s.rrg.length - 1]), q0 = quadOf(s.rrg?.[0]);
  const news: NewsItem[] = x?.news.items ?? [];

  return (
    <section ref={ref} className="page stk">
      <header className="titlebar">
        <div className="title-left">
          <h1 className="stk-h1">{s.symbol}<WatchBtn on={watched} onClick={toggleWatch} sym={s.symbol} big /></h1>
          <p className="meta">{s.name !== s.symbol ? s.name + " · " : ""}{MKT[s.market]}{isOwned ? " · portföyünde" : ""} · tarama {when(scan.created_at)}</p>
        </div>
        <div className="actions">
          <span className={"pill pill-lg " + VCLASS[s.verdict]}>{VTEXT[s.verdict]} {s.score}/{max}</span>
          <button className="btn btn-ghost" onClick={back}>← Taramaya dön</button>
        </div>
      </header>

      <section className="panel stk-card advice" aria-labelledby="stk-adv">
        <div className="panel-head"><h2 id="stk-adv">Öneri</h2><span className="small muted">{isOwned && adv.length ? "portföy kuralları · " + (adv[0].source ?? "") : "tarama kuralları"}{busy ? " · analiz ve haberler alınıyor…" : ""}</span></div>
        <ol className="adv-list">
          {(isOwned && adv.length ? adv : [card as Advice]).map((a, i) => (
            <li key={i} className="adv">
              <span className="adv-rail" aria-hidden />
              <div className="adv-key"><b>{a.symbol}</b><span className={"tag tag-" + (ATONE[a.action] ?? "neutral")}>{a.action}</span></div>
              <div className="adv-body">
                <p className="adv-title">{a.title}{a.prev_action && <span className="adv-chg">{a.prev_action} → {a.action}</span>}</p>
                <AdvBody a={a} />
                {a.created_at && a.source?.startsWith("Kural") && <div className="adv-foot"><span>{a.source} · bu eylem {advSince(a)}</span></div>}
              </div>
            </li>
          ))}
        </ol>
        <p className="adv-note">Kurallar mekaniktir: taramanın puanı, plan, bilanço ve teknik göstergelerden türetilir. Haber satırı yalnızca en yeni başlığı gösterir, yorum içermez. Yatırım tavsiyesi değildir.</p>
      </section>

      <div className="stk-grid">
        <div className="stk-main">{detail({ deep: x?.deep, bars: (x as any)?.bars, loading: busy })}</div>
        <div className="stk-side">
          <section className="panel" aria-labelledby="stk-rot">
            <div className="panel-head"><h2 id="stk-rot">Rotasyon haritasında</h2>{q && <span className={"quad-tag" + (q === "lead" ? " lead" : "")}>{QUAD[q].name}</span>}</div>
            {s.rrg && q ? <p className="small stk-rot-text">Endekse göre <b>{QUAD[q].name.toLocaleLowerCase("tr-TR")}</b> bölgede: {QUAD[q].sub}. RS-oran {s.rrg[s.rrg.length - 1][0].toFixed(1)}, momentum {s.rrg[s.rrg.length - 1][1].toFixed(1)}{q0 ? `; 6 hafta önce ${QUAD[q0].name.toLocaleLowerCase("tr-TR")} bölgedeydi` : ""}. Haritada başka bir hisseye tıklarsan onun sayfası açılır.</p>
              : <p className="small muted">Bu hisse için rotasyon verisi yok.</p>}
            <Rotation stocks={m.stocks} selected={s.ticker} onSelect={t => { if (t !== s.ticker) open(t); }} scanning={false} owned={owned} quad={null} version={scan.id + s.market + s.ticker} />
          </section>
          <section className="panel stock-news" aria-labelledby="stk-news">
            <div className="panel-head"><h2 id="stk-news">{s.symbol} haberleri</h2><span className="small muted">{x ? `son 2 hafta · ${ago(x.at)} çekildi` : busy ? "alınıyor…" : ""}</span></div>
            {err ? <p className="small neg" role="alert">{err}</p>
              : x?.news.error ? <p className="small neg">Haber alınamadı: {x.news.error}</p>
              : !x ? <><div className="skel" /><div className="skel" /></>
              : !news.length ? <p className="small muted">Son iki haftada bu hisseye özel haber bulunamadı.</p>
              : <ul>{news.map(it => (
                  <li key={it.u} className="n-item">
                    <a href={it.u} target="_blank" rel="noopener noreferrer">
                      <span className="n-t">{it.t}</span>
                      {it.d && <span className="n-d">{it.d}</span>}
                      <span className="n-meta">{it.src}{it.at ? " · " + ago(it.at) : ""}</span>
                    </a>
                  </li>))}</ul>}
            <p className="small muted">Kaynak: Bing Haberler. Genel piyasa ve sektör haberleri Haberler sayfasında.</p>
          </section>
        </div>
      </div>
      <p className="foot">Yatırım tavsiyesi değildir. Puanlar kurallı bir taramanın ve geçmiş verinin özetidir; backtest ve simülasyon geleceği garanti etmez.</p>
    </section>
  );
}
