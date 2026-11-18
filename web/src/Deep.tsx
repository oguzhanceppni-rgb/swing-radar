import { useEffect, useState } from "react";
import * as api from "./api";
import type { Deep, DeepStock, DeepTF, Stock } from "./api";
import { pct, trNum } from "./ui";

// ---------------------------------------------------------------- ortak veri: derin analiz (swing_deep) — tek yükleme, abone olan bileşenler güncellenir
type DeepState = Awaited<ReturnType<typeof api.deep>> | null;
let cache: DeepState = null, inflight: Promise<DeepState> | null = null, busy = false;
const subs = new Set<(d: DeepState) => void>();
const emit = () => subs.forEach(f => f(cache));
async function load() { inflight ??= api.deep().then(d => (cache = d)).finally(() => (inflight = null)); const d = await inflight; emit(); return d; }
// Tarama değiştiyse ya da hiç derin analiz yoksa bulutta başlatır, bitene kadar 3 sn'de bir okur.
export async function ensureDeep(scanId: number, force = false) {
  if (busy) return;
  const d = cache ?? (await load().catch(() => null));
  if (!force && d && d.scanId === scanId && d.data) return;
  busy = true; emit();
  try {
    const t0 = Date.now();
    await api.startDeep(scanId);
    for (;;) {
      await new Promise(r => setTimeout(r, 3000));
      const s = await load();
      if (s?.status === "error" || (s?.status === "done" && s.scanId === scanId)) break;
      if (Date.now() - t0 > 170_000) break;
    }
  } finally { busy = false; emit(); }
}
export function useDeep() {
  const [d, setD] = useState<DeepState>(cache);
  useEffect(() => { subs.add(setD); if (!cache) load().catch(() => {}); return () => { subs.delete(setD); }; }, []);
  return { d: d?.data ?? null, status: d?.status ?? null, error: d?.error ?? null, running: busy || d?.status === "running" };
}

// ---------------------------------------------------------------- hisse detayında derin analiz
const big = (v: number | null | undefined, mkt: string) => v == null ? "—" : (mkt === "us" ? "$" : "₺") + (Math.abs(v) >= 1e9 ? trNum(v / 1e9, 1) + " mlr" : trNum(v / 1e6, 0) + " mn");
const ratio = (v: unknown, d = 1) => typeof v === "number" ? trNum(v, d) : "—";
const prc = (v: unknown) => typeof v === "number" ? pct(v, 0) : "—";
const Why = ({ w }: { w: string[] }) => <ul className="why">{w.map(x => <li key={x} className={x.startsWith("-") ? "neg" : x.startsWith("0 ") ? "muted" : ""}><span className="num">{x.split(" ")[0]}</span> {x.split(" ").slice(1).join(" ")}</li>)}</ul>;

// puan işareti → pozitif / negatif / nötr
const Tone = ({ pts, label }: { pts: number; label?: string }) => {
  const [c, t] = pts > 0 ? ["pos", "Pozitif"] : pts < 0 ? ["neg", "Negatif"] : ["neutral", "Nötr"];
  return <span className={"pill " + c} title={`Puan ${sgn(pts)}`}>{label ? label + ": " : ""}{t} <span className="num">{sgn(pts)}</span></span>;
};
// over: hisse sayfasında isteğe bağlı hesaplanan tek hisse analizi (ALINMAZ hisseler dahil); yoksa taramanın toplu derin analizi
export function DeepView({ s, over, loading }: { s: Stock; over?: DeepStock; loading?: boolean }) {
  const { d, running: run0 } = useDeep();
  const x = over ?? d?.deep[s.ticker], running = run0 || !!loading;
  if (s.verdict === "ALINMAZ" && !over && loading === undefined) return null;
  if (!x) return <section className="deep"><h3>Derin analiz</h3><p className="small muted">{running ? "Bilanço ve çok zaman dilimli teknik hesaplanıyor (≈1 dk)…" : "Bu tarama için derin analiz henüz yok."}</p></section>;
  if (x.error) return <section className="deep"><h3>Derin analiz</h3><p className="small neg">Alınamadı: {x.error}</p></section>;
  const m = x.fund!.m, mk = s.market, total = x.total ?? 0;
  return (
    <section className="deep" aria-labelledby="deep-h">
      <div className="deep-head">
        <h3 id="deep-h">Derin analiz</h3>
        <span className="deep-tones"><Tone label="Temel" pts={x.fund!.pts} /><Tone label="Teknik" pts={x.tech!.pts} /></span>
      </div>

      <div className="deep-block">
        <h4>Şirket ne iş yapıyor</h4>
        <p className="small muted">{[x.profile?.sectorTr, x.profile?.industry].filter(Boolean).join(" · ")}{x.profile?.employees ? ` · ${x.profile.employees.toLocaleString("tr-TR")} çalışan` : ""}</p>
        {x.profile?.summary ? <p className="deep-sum">{x.profile.summary}</p> : <p className="small muted">Şirket özeti bulunamadı.</p>}
      </div>

      <div className="deep-block">
        <h4>Bilanço <Tone pts={x.fund!.pts} /> {m.period && <span className="small muted">· son dönem {String(m.period).slice(0, 7)}{x.bank ? " · banka" : ""}</span>}</h4>
        <p className="small muted">Kaynak: {(x.fund as any).source ?? "Yahoo Finance"}{s.market === "bist" ? " · çeyreklik değerler kümülatif tablolardan türetilir" : ""}</p>
        <dl className="facts deep-facts">
          {x.bank ? <>
            <dt>Net faiz geliri (yıllık)</dt><dd>{prc(m.niiYoY)}</dd>
            <dt>Net kâr (yıllık)</dt><dd>{prc(m.niYoY)}</dd>
            <dt>Net kâr, son 12 ay</dt><dd>{big(m.niTTM as number, mk)}</dd>
            <dt>Özsermaye kârlılığı</dt><dd>{prc(m.roe)}</dd>
            <dt>Özsermaye / aktif</dt><dd>{prc(m.eqAssets)}</dd>
          </> : <>
            <dt>FAVÖK, son 12 ay</dt><dd>{big(m.ebitdaTTM as number, mk)} <span className="muted">{prc(m.ebitdaYoY)} yıllık</span></dd>
            <dt>Net faaliyet kârı, son 12 ay</dt><dd>{big(m.opTTM as number, mk)} <span className="muted">{prc(m.opYoY)} yıllık</span></dd>
            <dt>Faaliyet marjı</dt><dd>{prc(m.opMarginPrev)} → {prc(m.opMargin)}</dd>
            <dt>Net kâr, son 12 ay</dt><dd>{big(m.niTTM as number, mk)} <span className="muted">{prc(m.niYoY)} yıllık</span></dd>
            <dt>Toplam borç · net borç</dt><dd>{big(m.totalDebt as number, mk)} · {big(m.netDebt as number, mk)}</dd>
            <dt>Net borç / FAVÖK{m.holding ? " (puanlanmaz)" : ""}</dt><dd>{ratio(m.ndEbitda)}</dd>
            {m.holding ? <>
              <dt>Ana ortaklık özsermaye kârlılığı</dt><dd>{prc(m.roe)}</dd>
              <dt>Piyasa değeri / defter değeri</dt><dd>{ratio(m.pb, 2)}</dd>
              <dt>Kârın azınlık payı</dt><dd>{prc(m.minorityShare)}</dd>
            </> : null}
            <dt>Borç / özsermaye</dt><dd>{ratio(m.debtEquity, 2)}</dd>
            <dt>Cari oran</dt><dd>{ratio(m.currentRatio, 2)}</dd>
            <dt>Serbest nakit akışı, 12 ay</dt><dd>{big(m.fcfTTM as number, mk)}</dd>
          </>}
        </dl>
        <Why w={x.fund!.why} />
        {mk === "bist" && <p className="small muted">{x.bank
          ? "Bankalar enflasyon muhasebesi uygulamaz; nominal büyüme yıllık ≈ %30 TÜFE ile karşılaştırılıp reel büyüme hesaplanır."
          : "Tablolar enflasyon muhasebesine (TMS 29) göredir; her dönem kendi dönem sonu TL'siyle raporlanır. Bu yüzden aynı dönem karşılaştırmasında (ör. 9A26 / 9A25) yıllık ≈ %30 TÜFE düşülerek reel büyüme hesaplanır."}
          {m.holding ? " Holding: konsolide borç iştiraklere ait olduğundan borç oranı puanlanmaz; ana ortaklık kârı ve özsermaye kârlılığı esas alınır." : ""}</p>}
      </div>

      <div className="deep-block">
        <h4>Teknik · 4S-G-H-A <Tone pts={x.tech!.pts} /></h4>
        <div className="table-wrap" data-lenis-prevent>
          <table className="tf-table">
            <thead><tr><th>Dilim</th><th>HAHO</th><th className="r">RSI</th><th>Uyumsuzluk</th><th>Stok. RSI</th><th title="Fiyatın en yakın talep bölgesine (altta) ve arz bölgesine (üstte) uzaklığı">Talep / Arz</th><th title="50 mumda yükselen/düşen gün hacim oranı · son mum hacmi / 50 mum ortalaması · OBV 20 mum yönü">Hacim</th><th title="Trend kırılımı (yalnızca 4S ve G); puan için kırılım mumu hacmi ≥1,5×">Kırılım</th></tr></thead>
            <tbody>{x.tfs!.map(t => <TFRow key={t.tf} t={t} />)}</tbody>
          </table>
        </div>
        <Why w={x.tech!.why} />
      </div>
      <p className="small muted">Sektör ve dünya gelişmelerinin etkisi değerlendirilmez; ilgili haberler Haberler sayfasında, Sektör haberleri bölümünda.</p>
    </section>
  );
}
const sgn = (n: number) => (n > 0 ? "+" : "") + n;
function TFRow({ t }: { t: DeepTF }) {
  // %30'dan uzak bölgeler swing ufkunda anlamsız (çoğu eski bölünme/bedelsiz kaynaklı) → gösterilmez
  const zone = (z: DeepTF["demand"], inZ: boolean, sign: string) => inZ ? <b>içinde</b> : !z || Math.abs(z.dist) > 0.3 ? "—" : `${sign}${pct(Math.abs(z.dist), 1, false)}`;
  return (
    <tr>
      <td><b>{t.tf}</b></td>
      <td className={t.aboveHaho ? "pos" : t.aboveHaho === false ? "neg" : ""}>{t.aboveHaho == null ? "—" : t.aboveHaho ? "üstünde" : "altında"}{t.touchHaho ? " · temas" : ""}</td>
      <td className="r num">{t.rsi == null ? "—" : trNum(t.rsi, 0)}</td>
      <td className={t.div === "boğa" ? "pos" : t.div === "ayı" ? "neg" : "muted"}>{t.div ? `${t.div === "boğa" ? "pozitif" : "negatif"} · ${t.divAgo} mum` : "—"}</td>
      <td className={/satım dönüşü/.test(t.stoch ?? "") ? "pos" : /alım dönüşü/.test(t.stoch ?? "") ? "neg" : "muted"}>{t.stoch ?? (t.stK != null ? trNum(t.stK, 0) : "—")}</td>
      <td className="nowrap">{zone(t.demand, t.inDemand, "−")} <span className="muted">/</span> {zone(t.supply, t.inSupply, "+")}</td>
      <td className="nowrap num">{t.vol?.ud == null ? "—" : <><span className={t.vol.ud >= 1 ? "pos" : "neg"}>{trNum(t.vol.ud, 2)}</span> · ×{trNum(t.vol.rel ?? 0, 1)} · OBV {t.vol.obvUp ? "↑" : "↓"}</>}</td>
      <td className={t.brk?.dir === "yukarı" ? "pos" : t.brk ? "neg" : "muted"}>{t.tf === "4S" || t.tf === "G" ? (t.brk ? `${t.brk.dir} · ${t.brk.ago} mum önce${t.brk.vol != null ? ` · hacim ×${trNum(t.brk.vol, 1)}` : ""}` : "yok") : "·"}</td>
    </tr>
  );
}
export type { Deep, DeepStock };
