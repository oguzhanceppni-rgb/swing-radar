import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as api from "./api";
import type { CalEvent, News as NewsT, NewsItem } from "./api";
import { gsap, useGSAP, reduced, reveal } from "./motion";

// Haberler: üstte bugünün takvimi (seni etkileyenler + 3 yıldız), altında portföy hisseleri, ulusal ve küresel öne çıkanlar.
// Veri yalnızca "Haberleri getir" ile (ya da 2 saatten eskiyse sayfa açılınca) bulutta çekilir.
const STALE_MS = 2 * 3600e3;
const ago = (iso: string | null) => {
  if (!iso) return "";
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
  return m < 1 ? "şimdi" : m < 60 ? `${m} dk önce` : m < 48 * 60 ? `${Math.round(m / 60)} sa önce` : `${Math.round(m / 1440)} gün önce`;
};
const hhmm = (iso: string) => new Date(iso).toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" });

// aynı olayı anlatan haberleri tek satırda topla (kelime örtüşmesi), diğer kaynakları say
const words = (t: string) => new Set(t.toLocaleLowerCase("tr").replace(/[^a-zçğıöşü0-9 ]/g, " ").split(" ").filter(w => w.length > 3));
function cluster(items: NewsItem[]) {
  const out: { it: NewsItem; more: NewsItem[]; w: Set<string> }[] = [];
  for (const it of items) {
    const w = words(it.t), hit = out.find(c => { let n = 0; w.forEach(x => c.w.has(x) && n++); return n / Math.min(w.size, c.w.size || 1) >= 0.5; });
    if (hit) hit.more.push(it); else out.push({ it, more: [], w });
  }
  return out;
}

export default function News({ owned, watched, onOpen }: { owned: Set<string>; watched?: Set<string>; onOpen?: (ticker: string) => void }) {
  const [st, setSt] = useState<Awaited<ReturnType<typeof api.news>> | null>(null);
  const [busy, setBusy] = useState(false), [err, setErr] = useState<string | null>(null);
  const ref = useRef<HTMLElement>(null);

  const load = useCallback(async () => { const r = await api.news(); setSt(r); return r; }, []);
  const refresh = useCallback(async () => {
    if (busy) return;
    setBusy(true); setErr(null);
    try {
      const t0 = Date.now();
      await api.refreshNews();
      for (;;) {
        await new Promise(r => setTimeout(r, 1500));
        const s = await api.news();
        if (s.status === "error") throw new Error(s.error ?? "Haberler alınamadı");
        if (s.status === "done" && s.updated_at && Date.parse(s.updated_at) >= t0 - 2000) { setSt(s); break; }
        if (Date.now() - t0 > 60_000) throw new Error("Haberler 60 saniyede gelmedi");
      }
    } catch (e: any) { setErr(e?.message ?? String(e)); }
    finally { setBusy(false); }
  }, [busy]);
  useEffect(() => {
    load().then(r => { if (!r.data || Date.now() - Date.parse(r.data.at) > STALE_MS) refresh(); })
      .catch(e => setErr(e?.code === "not_granted" ? "Sayfanın Supabase'e erişmesine izin ver ve yenile." : String(e?.message ?? e)));
  }, []); // eslint-disable-line

  const d = st?.data;
  useGSAP(() => {
    if (reduced() || !d) return;
    reveal(ref.current, ".news-col, .stock-news, .cal");
  }, { scope: ref, dependencies: [d?.at] });

  return (
    <section ref={ref} className="page news">
      <header className="titlebar">
        <div className="title-left">
          <h1>Haberler</h1>
          <p className="meta">{d ? <>Güncelleme <span className="num">{ago(d.at)}</span> · Investing.com, Bloomberg HT, AA, NinjaNews, Bing Haberler</> : "Henüz haber çekilmedi"}</p>
        </div>
        <div className="title-right">
          {err && <span className="small neg" role="alert">{err}</span>}
          <button className={"btn" + (busy ? " is-scanning" : "")} onClick={refresh} disabled={busy}><span className="scan-dot" aria-hidden />{busy ? "Getiriliyor" : "Haberleri getir"}</button>
        </div>
      </header>

      {!d ? <div className="state"><p className="muted">{busy ? "Kaynaklar taranıyor, 10–20 saniye sürer…" : "Haber yok."}</p><div className="skel" /><div className="skel" /></div> : <>
        <div className="news-split">
          <NewsCol id="nat" title="Ulusal öne çıkanlar" items={d.national} />
          <NewsCol id="glob" title="Küresel öne çıkanlar" items={d.global} />
        </div>
        <SectorNews sectors={d.sectors} />
        <div className="news-stocks-split">
          <section className="news-stocks" aria-labelledby="ns-h">
            <h2 id="ns-h">Portföyündekiler</h2>
            <div className="stock-grid">
              {d.stocks.filter(s => !s.watch).map(s => <StockNews key={s.symbol} s={s} owned={owned.has(s.symbol + ".IS") || s.owned} />)}
            </div>
          </section>
          <section className="news-stocks" aria-labelledby="nw-h">
            <h2 id="nw-h">Takip ettiklerin</h2>
            {(() => {
              const ws = d.stocks.filter(s => s.watch), n = watched?.size ?? 0;
              if (!n) return <p className="small muted">Takip listen boş. Hisse kodlarının yanındaki <b>Takip et</b> düğmesiyle eklersin; haberleri bir sonraki yenilemede burada çıkar.</p>;
              return <>
                {ws.length < n && <p className="small muted">Yeni eklediğin {n - ws.length} hissenin haberleri bir sonraki yenilemede gelir. <button className="link" onClick={refresh} disabled={busy}>Şimdi yenile</button></p>}
                <div className="stock-grid">{ws.map(s => <StockNews key={s.symbol} s={{ ...s, ticker: [...(watched ?? [])].find(t => t === s.symbol || t === s.symbol + ".IS") }} owned={false} watch onOpen={onOpen} />)}</div>
              </>;
            })()}
          </section>
        </div>
        <Calendar ev={d.calendar} />
        {d.errors.length > 0 && <p className="foot">Ulaşılamayan kaynak: {d.errors.join(" · ")}</p>}
        <p className="foot">Sıralama: Fed/TCMB/faiz, enflasyon ve istihdam, jeopolitik, piyasa ve şirket haberi anahtar kelimeleri + tazelik. Aynı olayı anlatan haberler tek satırda toplanır. Takvim Investing.com'dan, Türkiye saatiyle; bugünün 3 yıldızlı olayları ile TL ve doları etkileyen 2 yıldızlılar. Yatırım tavsiyesi değildir.</p>
      </>}
    </section>
  );
}

// Sektör haberleri: haberi olan sektörler sekme olarak dizilir, seçilenin haberleri altında.
function SectorNews({ sectors }: { sectors: NewsT["sectors"] }) {
  const list = useMemo(() => Object.entries(sectors ?? {}).filter(([, v]) => v.items.length).sort((a, b) => b[1].items.length - a[1].items.length), [sectors]);
  const [sel, setSel] = useState<string | null>(null);
  const cur = list.find(([k]) => k === sel) ?? list[0];
  const groups = useMemo(() => cluster(cur?.[1].items ?? []), [cur]);
  const ol = useRef<HTMLOListElement>(null);
  useGSAP(() => { if (!reduced() && ol.current) gsap.from(ol.current.children, { opacity: 0, y: 10, duration: 0.45, stagger: 0.04, ease: "power3.out", clearProps: "all" }); }, { dependencies: [cur?.[0]] });
  return (
    <section className="panel news-col sec-news" aria-labelledby="sec-h">
      <div className="panel-head"><h2 id="sec-h">Sektör haberleri</h2><span className="small muted">son 3 gün · anahtar kelimeyle sektöre yerleştirilir</span></div>
      {!list.length ? <p className="small muted">Son 3 günde sektörlere dair haber bulunamadı.</p> : <>
        <div className="sec-tabs" role="tablist" aria-label="Sektör">
          {list.map(([k, v]) => <button key={k} role="tab" aria-selected={k === cur![0]} onClick={() => setSel(k)}>{v.tr}<span className="tab-count">{v.items.length}</span></button>)}
        </div>
        <ol ref={ol} className="sec-list">{groups.slice(0, 10).map(g => <Item key={g.it.u} it={g.it} more={g.more.length} />)}</ol>
      </>}
    </section>
  );
}

function Calendar({ ev }: { ev: CalEvent[] }) {
  const now = Date.now();
  const rows = useMemo(() => [...ev].sort((a, b) => (a.at ?? "").localeCompare(b.at ?? "")), [ev]);
  const next = rows.find(e => e.at && Date.parse(e.at.replace(" ", "T") + "+03:00") > now);
  return (
    <section className="panel cal" aria-labelledby="cal-h">
      <div className="panel-head">
        <h2 id="cal-h">Bugünün takvimi</h2>
        <span className="small muted">{rows.length} olay{next ? <> · sıradaki <b>{next.time}</b> {next.ev}</> : " · bugün kalan olay yok"}</span>
      </div>
      {!rows.length ? <p className="small muted">Bugün seni etkileyen ya da 3 yıldızlı olay yok.</p> :
        <table className="cal-table">
          <thead><tr><th>Saat</th><th>Önem</th><th>Olay</th><th className="r">Açıklanan</th><th className="r hide-m">Beklenti</th><th className="r hide-m">Önceki</th><th className="hide-m hide-l">Seni nasıl etkiler</th></tr></thead>
          <tbody>
            {rows.map((e, i) => {
              const past = e.at && Date.parse(e.at.replace(" ", "T") + "+03:00") <= now;
              return (
                <tr key={i} className={"cal-row" + (past ? " is-past" : "") + (e === next ? " is-next" : "")}>
                  <td className="num">{e.time}</td>
                  <td><span className="stars" aria-label={`${e.stars} yıldız`}>{"★".repeat(e.stars)}<i>{"★".repeat(3 - e.stars)}</i></span></td>
                  <td><span className="cal-cur">{e.cur}</span> {e.ev}{e.mine && <span className="tag tag-warn cal-mine">seni etkiler</span>}</td>
                  <td className={"r num " + (e.good > 0 ? "pos" : e.good < 0 ? "neg" : "")}>{e.act || "—"}</td>
                  <td className="r num hide-m">{e.fc || "—"}</td>
                  <td className="r num hide-m muted">{e.prev || "—"}</td>
                  <td className="small muted hide-m hide-l">{e.why}</td>
                </tr>
              );
            })}
          </tbody>
        </table>}
    </section>
  );
}

function StockNews({ s, owned, watch, onOpen }: { s: NewsT["stocks"][number] & { ticker?: string }; owned: boolean; watch?: boolean; onOpen?: (ticker: string) => void }) {
  const groups = useMemo(() => cluster(s.items), [s.items]);
  return (
    <article className="panel stock-news">
      <header>{watch && onOpen ? <button className="link stock-news-sym" onClick={() => onOpen(s.ticker ?? s.symbol)}><b>{s.symbol}</b></button> : <b>{s.symbol}</b>}<span className="small muted">{s.symbol === "YZG" ? "gümüş fonu" : watch ? "takipte" : owned ? "portföyde" : "bekleyen emir"}</span></header>
      {s.error ? <p className="small neg">Haber alınamadı: {s.error}</p> : !groups.length ? <p className="small muted">Son bir haftada haber yok.</p> :
        <ul>{groups.slice(0, 4).map(g => <Item key={g.it.u} it={g.it} more={g.more.length} compact />)}</ul>}
    </article>
  );
}

function NewsCol({ id, title, items }: { id: string; title: string; items: NewsItem[] }) {
  const groups = useMemo(() => cluster(items), [items]);
  return (
    <section className="panel news-col" aria-labelledby={id}>
      <div className="panel-head"><h2 id={id}>{title}</h2><span className="small muted">son 36 saat</span></div>
      <ol>{groups.slice(0, 9).map((g, i) => <Item key={g.it.u} it={g.it} more={g.more.length} lead={i === 0} />)}</ol>
    </section>
  );
}

function Item({ it, more, lead, compact }: { it: NewsItem; more: number; lead?: boolean; compact?: boolean }) {
  return (
    <li className={"n-item" + (lead ? " is-lead" : "")}>
      <a href={it.u} target="_blank" rel="noopener noreferrer">
        <span className="n-t">{it.t}</span>
        {!compact && it.d && <span className="n-d">{it.d}</span>}
        <span className="n-meta">{it.src} · {it.at ? (Date.now() - Date.parse(it.at) < 864e5 ? `${hhmm(it.at)} · ${ago(it.at)}` : ago(it.at)) : ""}{more > 0 && <> · +{more} kaynak</>}</span>
      </a>
    </li>
  );
}
