import { useEffect, useRef, useState } from "react";
import * as api from "./api";
import type { Scan, Settings, Trade } from "./api";
import { MKT, trNum, pct, when } from "./ui";
import CountUp from "./bits/CountUp";
import { gsap, useGSAP, reduced, reveal } from "./motion";

const useRowsIn = (ref: React.RefObject<HTMLElement | null>, deps: unknown[]) =>
  useGSAP(() => { if (!reduced() && ref.current) gsap.from(ref.current.querySelectorAll("tbody tr"), { opacity: 0, y: 10, stagger: 0.04, duration: 0.5, clearProps: "all" }); }, { scope: ref, dependencies: deps });

// ---------------------------------------------------------------- İşlem günlüğü
export function Journal({ scan }: { scan: Scan | null }) {
  const [list, setList] = useState<Trade[] | null>(null);
  const [exits, setExits] = useState<Record<number, string>>({});
  const ref = useRef<HTMLElement>(null);
  const refresh = () => api.trades().then(setList).catch(() => setList([]));
  useEffect(() => { refresh(); }, []);
  useRowsIn(ref, [list?.length]);
  const kp = useRef<HTMLElement>(null);
  useGSAP(() => { if (!reduced()) gsap.from(".kpi", { y: 18, opacity: 0, stagger: 0.08, duration: 0.8, ease: "expo.out", delay: 0.15 }); }, { scope: kp });
  const stockOf = (t: Trade) => scan?.markets.flatMap(m => m.stocks).find(s => s.ticker === t.ticker); const last = (t: Trade) => { const s = stockOf(t); return s ? (s.live ?? s.close) : null; };
  const R = (t: Trade, px: number) => (px - +t.entry) / (+t.entry - +t.stop);
  const open = list?.filter(t => !t.closed_at) ?? [], closed = list?.filter(t => t.closed_at) ?? [];
  const closedR = closed.map(t => R(t, +t.exit!)), sumR = closedR.reduce((a, b) => a + b, 0);
  const wins = closedR.filter(r => r > 0).length;
  return (
    <>
      <header className="titlebar"><div className="title-left"><h1>İşlem günlüğü</h1>
        <p className="muted small">Açık pozisyonlar son taramanın kapanışıyla değerlenir. Sonuçlar R cinsinden: 1R = girişte göze alınan risk.</p></div></header>
      <section className="kpis-row" ref={kp}>
        <div className="kpi"><span className="kpi-label">Açık</span><span className="display-num kpi-val" style={{ fontSize: "var(--t-title)" }}><CountUp to={open.length} duration={0.8} /></span></div>
        <div className="kpi"><span className="kpi-label">Kapanan</span><span className="display-num kpi-val" style={{ fontSize: "var(--t-title)" }}><CountUp to={closed.length} duration={0.8} /></span></div>
        <div className="kpi"><span className="kpi-label">Kazanan oranı</span><span className="kpi-val num">{closed.length ? pct(wins / closed.length, 0, false) : "—"}</span></div>
        <div className="kpi"><span className="kpi-label">Toplam</span><span className={"kpi-val num " + (sumR >= 0 ? "" : "neg")}>{closed.length ? (sumR >= 0 ? "+" : "−") + trNum(Math.abs(sumR)) + "R" : "—"}</span></div>
      </section>
      <section className="panel" ref={ref}>
        <div className="table-wrap" data-lenis-prevent>
          <table>
            <thead><tr><th>Hisse</th><th>Açılış</th><th className="r">Giriş</th><th className="r">Stop</th><th className="r">Hedef</th><th className="r">Adet</th><th className="r">Son / çıkış</th><th className="r">Sonuç</th><th>İşlem</th></tr></thead>
            <tbody>
              {list === null && <tr><td colSpan={9} className="muted empty-row">Okunuyor…</td></tr>}
              {list?.length === 0 && <tr><td colSpan={9} className="muted empty-row">Günlük boş. Radar'da bir hisse seçip "Günlüğe ekle" ile ilk işlemini kaydet.</td></tr>}
              {list?.map(t => {
                const px = t.closed_at ? +t.exit! : last(t);
                const r = px == null ? null : R(t, px);
                return (
                  <tr key={t.id}>
                    <td><span className="sym">{t.symbol}</span><span className="sub">{t.note || MKT[t.market as "bist"]}</span></td>
                    <td className="num small">{when(t.opened_at)}</td>
                    <td className="r num">{trNum(+t.entry)}</td><td className="r num">{trNum(+t.stop)}</td><td className="r num">{trNum(+t.target)}</td>
                    <td className="r num">{t.shares ?? "—"}</td>
                    <td className="r num">{px == null ? "—" : trNum(px)}{!t.closed_at && <span className="muted"> son</span>}</td>
                    <td className={"r num " + (r == null ? "" : r >= 0 ? "pos" : "neg")}>{r == null ? "—" : (r >= 0 ? "+" : "−") + trNum(Math.abs(r)) + "R"}</td>
                    <td>{t.closed_at ? <button className="link" onClick={() => api.deleteTrade(t.id).then(refresh)}>Sil</button> : (
                      <form className="inline" onSubmit={e => { e.preventDefault(); const v = parseFloat((exits[t.id] ?? "").replace(",", ".")); if (v > 0) api.closeTrade(t.id, v).then(refresh); }}>
                        <input aria-label={`${t.symbol} çıkış fiyatı`} inputMode="decimal" placeholder="Çıkış" value={exits[t.id] ?? ""} onChange={e => setExits({ ...exits, [t.id]: e.target.value })} />
                        <button className="link">Kapat</button>
                      </form>)}
                    </td>
                  </tr>);
              })}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

// ---------------------------------------------------------------- Tarama geçmişi
export function History({ current, open }: { current?: number; open: (id: number) => void }) {
  const [list, setList] = useState<Awaited<ReturnType<typeof api.scans>> | null>(null);
  const ref = useRef<HTMLElement>(null);
  useEffect(() => { api.scans().then(setList).catch(() => setList([])); }, []);
  useRowsIn(ref, [list?.length]);
  return (
    <>
      <header className="titlebar"><div className="title-left"><h1>Tarama geçmişi</h1><p className="muted small">Son 20 tarama. Birini açınca Radar o günün sonuçlarını gösterir.</p></div></header>
      <section className="panel" ref={ref}>
        <table>
          <thead><tr><th>Tarih</th><th>Kaynak</th><th className="r">Süre</th><th className="r">Alınır</th><th>Adaylar</th><th /></tr></thead>
          <tbody>
            {list === null && <tr><td colSpan={6} className="muted empty-row">Okunuyor…</td></tr>}
            {list?.length === 0 && <tr><td colSpan={6} className="muted empty-row">Henüz tamamlanmış tarama yok.</td></tr>}
            {list?.map(r => (
              <tr key={r.id} aria-current={r.id === current ? "true" : undefined} onClick={() => open(r.id)}>
                <td className="num">{when(r.created_at)}</td>
                <td className="small">{r.source === "local" ? (r.kronos ? "Bilgisayar · Kronos" : "Bilgisayar") : "Bulut"}</td>
                <td className="r num">{r.seconds ?? "—"} sn</td><td className="r num">{r.n}</td>
                <td className="small">{r.picks || <span className="muted">—</span>}</td>
                <td><button className="link" onClick={e => { e.stopPropagation(); open(r.id); }}>{r.id === current ? "Açık" : "Aç"}</button></td>
              </tr>))}
          </tbody>
        </table>
      </section>
    </>
  );
}

// ---------------------------------------------------------------- Risk ayarları
export function SettingsView({ st, onSave }: { st: Settings | null; onSave: (s: Settings) => void }) {
  const [f, setF] = useState<Record<keyof Settings, string>>(() => {
    const s = st ?? { capital_try: 100000, capital_usd: 5000, risk_pct: 1 };
    return { capital_try: String(s.capital_try), capital_usd: String(s.capital_usd), risk_pct: String(s.risk_pct) };
  });
  const [msg, setMsg] = useState("");
  const fr = useRef<HTMLFormElement>(null), hw = useRef<HTMLElement>(null);
  useGSAP(() => {
    if (reduced()) return;
    gsap.from(fr.current!.querySelectorAll(".field"), { y: 16, opacity: 0, stagger: 0.08, duration: 0.8, ease: "expo.out", delay: 0.2 });
    reveal(hw.current, "h2, p, pre");
  });
  const field = (k: keyof Settings, label: string, hint: string) => (
    <div className="field">
      <label htmlFor={k}>{label}</label>
      <input id={k} inputMode="decimal" value={f[k]} aria-describedby={k + "-h"} onChange={e => setF({ ...f, [k]: e.target.value })} />
      <span id={k + "-h"} className="small muted">{hint}</span>
    </div>);
  return (
    <>
      <header className="titlebar"><div className="title-left"><h1>Risk ayarları</h1><p className="muted small">Adet hesabı: (sermaye × risk %) ÷ (giriş − stop), sermayeyi aşmayacak şekilde tam lot.</p></div></header>
      <form ref={fr} className="panel settings" onSubmit={async e => {
        e.preventDefault();
        const num = (x: string) => +x.replace(/\./g, "").replace(",", ".");
        const s = { capital_try: num(f.capital_try), capital_usd: num(f.capital_usd), risk_pct: +f.risk_pct.replace(",", ".") };
        if (!(s.capital_try > 0 && s.capital_usd > 0 && s.risk_pct > 0 && s.risk_pct <= 5)) { setMsg("Sermaye 0'dan büyük, risk %0–5 arası olmalı."); return; }
        try { await api.saveSettings(s); onSave(s); setMsg("Kaydedildi."); } catch { setMsg("Kaydedilemedi."); }
      }}>
        {field("capital_try", "BIST sermayesi (₺)", "BIST hisseleri bu tutarla boyutlanır.")}
        {field("capital_usd", "ABD sermayesi ($)", "Nasdaq-100 hisseleri bu tutarla boyutlanır.")}
        {field("risk_pct", "İşlem başı risk (%)", "Stop olursa sermayenin yüzde kaçını kaybedersin. Swing için genelde %0,5–1.")}
        <div className="field"><button className="btn">Kaydet</button><span className="small" role="status">{msg}</span></div>
      </form>
      <section ref={hw} className="panel how">
        <h2>İki tarama yolu</h2>
        <p><b>Bulut taraması</b>: Tarama sayfasındaki "Şimdi tara" düğmesi. Supabase'de çalışır, iki piyasayı yaklaşık 10 saniyede tarar. Kronos içermez; puan zaten Kronos'u kullanmıyor.</p>
        <p><b>Bilgisayar taraması</b>: Masaüstündeki "Swing Radar Kronos Tarama" kısayolu. Aynı kurallara ek olarak Kronos tahminlerini ekran kartında hesaplar (yaklaşık 6 dakika) ve sonucu buraya yükler.</p>
        <pre><code>cd ~/swing-radar{"\n"}.venv/Scripts/python -I scan.py              # iki piyasa, Kronos'lu{"\n"}.venv/Scripts/python -I scan.py --no-kronos   # hızlı</code></pre>
      </section>
    </>
  );
}
