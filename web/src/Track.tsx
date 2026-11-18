import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as api from "./api";
import type { TrackSum, TrackTrade } from "./api";
import { MKT, Tabs, VCLASS, VTEXT, money, pct } from "./ui";
import { useGSAP, reduced, reveal } from "./motion";

// Sinyal takibi: her taramanın ALINIR/KARARSIZ sinyallerinin gerçekte ne yaptığı (taramadaki çıkış kuralıyla, komisyon dahil).
// Hesap yalnızca "Güncelle" ile (ya da 2 saatten eskiyse sayfa açılınca) bulutta yapılır.
const STALE_MS = 2 * 3600e3;
const GROUPS: [string, string][] = [["tümü", "Tümü"], ["bist", "BIST 100"], ["us", "Nasdaq-100"], ["bist:ALINIR", "BIST · Alınır"], ["bist:KARARSIZ", "BIST · Kararsız"], ["us:ALINIR", "Nasdaq · Alınır"], ["us:KARARSIZ", "Nasdaq · Kararsız"]];
const sp = (v: number | null | undefined, d = 1) => (v == null ? "—" : pct(v, d));
const cls = (v: number | null | undefined) => (v == null ? "muted" : v >= 0 ? "pos" : "neg");

export default function Track() {
  const [st, setSt] = useState<Awaited<ReturnType<typeof api.track>> | null>(null);
  const [busy, setBusy] = useState(false), [err, setErr] = useState<string | null>(null);
  const [mkt, setMkt] = useState<"all" | "bist" | "us">("all");
  const ref = useRef<HTMLElement>(null);

  const refresh = useCallback(async () => {
    if (busy) return;
    setBusy(true); setErr(null);
    try {
      const t0 = Date.now();
      await api.refreshTrack();
      for (;;) {
        await new Promise(r => setTimeout(r, 1500));
        const s = await api.track();
        if (s.status === "error") throw new Error(s.error ?? "Takip hesaplanamadı");
        if (s.status === "done" && s.updated_at && Date.parse(s.updated_at) >= t0 - 2000) { setSt(s); break; }
        if (Date.now() - t0 > 90_000) throw new Error("Takip 90 saniyede bitmedi");
      }
    } catch (e: any) { setErr(e?.message ?? String(e)); }
    finally { setBusy(false); }
  }, [busy]);
  useEffect(() => {
    api.track().then(r => { setSt(r); if (!r.data || Date.now() - Date.parse(r.data.at) > STALE_MS) refresh(); })
      .catch(e => setErr(e?.code === "not_granted" ? "Sayfanın Supabase'e erişmesine izin ver ve yenile." : String(e?.message ?? e)));
  }, []); // eslint-disable-line

  const d = st?.data;
  const trades = useMemo(() => (d?.trades ?? []).filter(t => mkt === "all" || t.market === mkt), [d, mkt]);
  useGSAP(() => { if (!reduced() && d) reveal(ref.current, ".trk-card, .trk-table"); }, { scope: ref, dependencies: [d?.at] });
  const all = d?.summary["tümü"];

  return (
    <section ref={ref} className="page track">
      <header className="titlebar">
        <div className="title-left">
          <h1>Sinyal takibi</h1>
          <p className="meta">{d ? <>{d.since ? `${new Date(d.since).toLocaleDateString("tr-TR")} tarihinden beri` : ""} {d.signals} sinyal · güncelleme {new Date(d.at).toLocaleString("tr-TR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</> : "Henüz hesaplanmadı"}</p>
        </div>
        <div className="title-right">
          {err && <span className="small neg" role="alert">{err}</span>}
          <button className={"btn" + (busy ? " is-scanning" : "")} onClick={refresh} disabled={busy}><span className="scan-dot" aria-hidden />{busy ? "Hesaplanıyor" : "Güncelle"}</button>
        </div>
      </header>

      <p className="small muted trk-note">Her taramadaki Alınır ve Kararsız hisseler, sinyal günü kapanışından alınmış sayılır ve taramadaki kuralla çıkılır:
        ilk stop, haftalık kapanış haftalık HAHO altındaysa çıkış (ilk 5 gün hariç), en çok 90 gün. Komisyon düşülür (BIST %0,2, Nasdaq %0,1).
        Aynı hissede açık işlem varken gelen yeni sinyal sayılmaz. Bu gerçek, geriye dönük olmayan sonuçtur; anlamlı olması için en az 30–50 kapanmış işlem gerekir.</p>

      {!d ? <div className="state"><p className="muted">{busy ? "Fiyatlar çekiliyor, 10–30 saniye sürer…" : "Veri yok."}</p><div className="skel" /><div className="skel" /></div> : <>
        {all && <div className="trk-hero">
          <div className="kpi"><span className="kpi-label">Kapanan işlem</span><span className="display-num kpi-xl">{all.closed}</span><span className="small muted">{all.open} açık</span></div>
          <div className="kpi"><span className="kpi-label">İsabet (kapanan, net kâr)</span><span className="kpi-val">{all.win == null ? "—" : pct(all.win, 0, false)}</span></div>
          <div className="kpi"><span className="kpi-label">Ortalama net (kapanan)</span><span className={"kpi-val " + cls(all.avg)}>{sp(all.avg)}</span></div>
          <div className="kpi"><span className="kpi-label">Endekse göre (kapanan)</span><span className={"kpi-val " + cls(all.avgEx)}>{sp(all.avgEx)}</span></div>
          <div className="kpi"><span className="kpi-label">Açıkların durumu</span><span className={"kpi-val " + cls(all.openAvg)}>{sp(all.openAvg)}</span><span className="small muted">endekse göre {sp(all.openEx)}</span></div>
        </div>}

        <div className="trk-grid">
          {GROUPS.filter(([k]) => k !== "tümü" && d.summary[k]).map(([k, label]) => <Card key={k} label={label} s={d.summary[k]} />)}
        </div>

        <section className="panel trk-table" aria-labelledby="trk-h">
          <div className="panel-head">
            <h2 id="trk-h">İşlemler</h2>
            <Tabs label="Pazar" value={mkt} onChange={setMkt}
              items={[{ id: "all", text: "Tümü", count: d.trades.length }, { id: "bist", text: "BIST", count: d.trades.filter(t => t.market === "bist").length }, { id: "us", text: "Nasdaq", count: d.trades.filter(t => t.market === "us").length }] as { id: "all" | "bist" | "us"; text: string; count: number }[]} />
          </div>
          <div className="table-wrap" data-lenis-prevent>
            <table>
              <thead><tr><th>Hisse</th><th>Sinyal</th><th>Tarih</th><th className="r">Giriş</th><th className="r">Stop</th><th>Durum</th><th className="r">Gün</th><th className="r">Net</th><th className="r">Endekse göre</th><th className="r hide-m">20g / 40g / 60g</th></tr></thead>
              <tbody>{trades.map(t => <Row key={t.id} t={t} />)}</tbody>
            </table>
          </div>
        </section>
        <p className="foot">Geçmiş sonuç geleceği garanti etmez; yatırım tavsiyesi değildir.</p>
      </>}
    </section>
  );
}

function Card({ label, s }: { label: string; s: TrackSum }) {
  const hz = (h: TrackSum["h20"], n: string) => h.n ? <span>{n}: <b className={cls(h.ex)}>{sp(h.ex)}</b> <span className="muted">(%{Math.round((h.hit ?? 0) * 100)} isabet, {h.n})</span></span> : <span className="muted">{n}: henüz yok</span>;
  return (
    <div className="panel trk-card">
      <h3>{label}</h3>
      <dl className="facts">
        <dt>Sinyal · kapanan · açık</dt><dd>{s.n} · {s.closed} · {s.open}</dd>
        <dt>İsabet (kapanan)</dt><dd>{s.win == null ? "—" : pct(s.win, 0, false)}</dd>
        <dt>Ortalama net · endekse göre</dt><dd><span className={cls(s.avg)}>{sp(s.avg)}</span> · <span className={cls(s.avgEx)}>{sp(s.avgEx)}</span></dd>
        <dt>Açıklar (şu an)</dt><dd><span className={cls(s.openAvg)}>{sp(s.openAvg)}</span></dd>
      </dl>
      <p className="small trk-hz">{hz(s.h20, "20g")}{hz(s.h40, "40g")}{hz(s.h60, "60g")}</p>
    </div>
  );
}

function Row({ t }: { t: TrackTrade }) {
  const st = t.status === "açık" ? "neutral" : t.status === "stop" ? "neg" : t.status === "veri yok" ? "neutral" : (t.ret ?? 0) >= 0 ? "pos" : "warn";
  const h = (x: TrackTrade["h20"]) => (x ? <span className={cls(x.ex)}>{pct(x.ex, 1)}</span> : <span className="muted">·</span>);
  return (
    <tr>
      <td><span className="sym">{t.symbol}</span><span className="sub">{MKT[t.market]}</span></td>
      <td><span className={"pill " + VCLASS[t.verdict]}>{VTEXT[t.verdict]} {t.score}</span></td>
      <td className="small">{new Date(t.date).toLocaleDateString("tr-TR", { day: "numeric", month: "short" })}</td>
      <td className="r">{money(t.entry, t.market)}</td>
      <td className="r muted">{money(t.stop, t.market)}</td>
      <td><span className={"pill " + st}>{t.status}</span>{t.exitDate && <span className="sub">{new Date(t.exitDate).toLocaleDateString("tr-TR", { day: "numeric", month: "short" })}</span>}</td>
      <td className="r">{t.days ?? "—"}</td>
      <td className={"r " + cls(t.ret)}>{t.ret == null ? "—" : pct(t.ret, 1)}</td>
      <td className={"r " + cls(t.excess)}>{t.excess == null ? "—" : pct(t.excess, 1)}</td>
      <td className="r hide-m">{h(t.h20)} / {h(t.h40)} / {h(t.h60)}</td>
    </tr>
  );
}
