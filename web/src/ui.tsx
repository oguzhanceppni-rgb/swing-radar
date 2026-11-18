import { useLayoutEffect, useRef } from "react";
import { isExitMc, type MC, type Stock, type Verdict } from "./api";
import { gsap, useGSAP, reduced } from "./motion";

// ---------------------------------------------------------------- biçimler
export const trNum = (v: number, d = 2) => v.toLocaleString("tr-TR", { minimumFractionDigits: d, maximumFractionDigits: d });
export const pct = (v: number | null | undefined, d = 1, sign = true) =>
  v == null || !Number.isFinite(v) ? "—" : (sign && v > 0 ? "+" : v < 0 ? "−" : "") + trNum(Math.abs(v * 100), d) + "%";
export const money = (v: number, m: string) => (m === "bist" || m === "TRY" ? "₺" : "$") + trNum(v, Math.abs(v) >= 1000 ? 0 : 2);
export const tl = (v: number, d = 0) => (v < 0 ? "−" : "") + "₺" + trNum(Math.abs(v), d);
export const signed = (v: number, d = 0) => (v > 0 ? "+" : v < 0 ? "−" : "") + "₺" + trNum(Math.abs(v), d);
export const when = (iso: string) => new Date(iso).toLocaleString("tr-TR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
export const MKT = { bist: "BIST 100", us: "Nasdaq-100" } as const;
export const SETUP: Record<string, string> = { breakout: "55g kırılım", pullback: "Geri çekilme", vcp: "VCP" };
export const VCLASS: Record<Verdict, string> = { ALINIR: "pos", KARARSIZ: "warn", ALINMAZ: "neutral" };
export const VTEXT: Record<Verdict, string> = { ALINIR: "Alınır", KARARSIZ: "Kararsız", ALINMAZ: "Alınmaz" };

// rotasyon çeyrekleri (x = RS-oran, y = RS-momentum, 100 = endeks)
export type Quad = "lead" | "weak" | "lag" | "impr";
export const QUAD: Record<Quad, { name: string; sub: string }> = {
  lead: { name: "Lider", sub: "endeksi yeniyor, ivme artıyor" },
  weak: { name: "Zayıflayan", sub: "hâlâ güçlü, ivme düşüyor" },
  lag: { name: "Geride", sub: "endeksin altında, ivme yok" },
  impr: { name: "Toparlanan", sub: "endeksin altında, ivme artıyor" },
};
export const quadOf = (p?: number[] | null): Quad | null => (!p ? null : p[0] >= 100 ? (p[1] >= 100 ? "lead" : "weak") : p[1] >= 100 ? "impr" : "lag");

// ---------------------------------------------------------------- kayan sekme (transitions.dev #16: kayan zemin)
export function Tabs<T extends string>({ items, value, onChange, label }: { items: { id: T; text: string; count?: number }[]; value: T; onChange: (v: T) => void; label: string }) {
  const wrap = useRef<HTMLDivElement>(null), pill = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const b = wrap.current?.querySelector<HTMLElement>(`[data-id="${value}"]`);
    if (b && pill.current) { pill.current.style.width = b.offsetWidth + "px"; pill.current.style.transform = `translateX(${b.offsetLeft}px)`; }
  }, [value, items]);
  return (
    <div className="tabs" role="tablist" aria-label={label} ref={wrap}>
      <span className="tabs-pill" ref={pill} aria-hidden />
      {items.map(i => (
        <button key={i.id} role="tab" aria-selected={i.id === value} tabIndex={i.id === value ? 0 : -1} data-id={i.id} className="tab" onClick={() => onChange(i.id)}
          onKeyDown={e => {
            const k = ({ ArrowRight: 1, ArrowLeft: -1 } as Record<string, number>)[e.key]; if (!k) return;
            e.preventDefault();
            const n = items[(items.findIndex(x => x.id === value) + k + items.length) % items.length];
            onChange(n.id); wrap.current?.querySelector<HTMLElement>(`[data-id="${n.id}"]`)?.focus();
          }}>
          {i.text}{i.count != null && <span className="tab-count">{i.count}</span>}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- olasılık şeridi: hedef önce / süre doldu / stop önce
// yeni (çıkış kurallı) MC: kârlı kapanış / zararla çıkış (HAHO ya da süre) / ilk stop
export const oddsOf = (mc: MC) => isExitMc(mc) ? { t: mc.win, n: Math.max(0, 1 - mc.win - mc.stop), s: mc.stop } : { t: mc.target, n: mc.neither, s: mc.stop };
export function Odds({ mc, big, hold, label }: { mc: MC; big?: boolean; hold: number; label?: string }) {
  const ref = useRef<HTMLDivElement>(null), o = oddsOf(mc);
  useGSAP(() => { if (!reduced()) gsap.from(ref.current!.children, { scaleX: 0, transformOrigin: "left center", duration: big ? 0.9 : 0.6, stagger: 0.08, delay: big ? 0.3 : 0 }); }, { scope: ref, dependencies: [o.t, o.s] });
  const t = isExitMc(mc)
    ? `${label ?? ""}Monte Carlo ${mc.paths.toLocaleString("tr-TR")} yol: kârlı kapanış ${pct(o.t, 0, false)}, zararla çıkış ${pct(o.n, 0, false)}, ilk stop ${pct(o.s, 0, false)}; ortalama ${mc.meanR >= 0 ? "+" : "−"}${Math.abs(mc.meanR).toFixed(2)}R`
    : `${label ?? ""}Monte Carlo ${mc.paths.toLocaleString("tr-TR")} yol: hedef önce ${pct(o.t, 0, false)}, ${hold} günde ikisi de değil ${pct(o.n, 0, false)}, stop önce ${pct(o.s, 0, false)}`;
  return (
    <div className={big ? "odds odds-big" : "odds"} role="img" aria-label={t} title={t} ref={ref}>
      <span className="odds-t" style={{ flexGrow: o.t }} />
      <span className="odds-n" style={{ flexGrow: o.n }} />
      <span className="odds-s" style={{ flexGrow: o.s }} />
    </div>
  );
}

// ---------------------------------------------------------------- puan merdiveni (0..max kademe)
export function Seg({ score, max, verdict, lg }: { score: number; max: number; verdict: Verdict; lg?: boolean }) {
  const ref = useRef<HTMLSpanElement>(null);
  useGSAP(() => { if (lg && !reduced()) gsap.from(ref.current!.querySelectorAll("i.on"), { scaleY: 0, transformOrigin: "bottom center", stagger: 0.06, duration: 0.4, delay: 0.2 }); }, { scope: ref, dependencies: [score] });
  return (
    <span className={"seg" + (lg ? " seg-lg" : "")} ref={ref} aria-hidden>
      {Array.from({ length: max }, (_, i) => <i key={i} className={i < score ? "on " + VCLASS[verdict] : ""} />)}
    </span>
  );
}

export const stockMc = (s: Stock) => s.mc;

// ---------------------------------------------------------------- takip et / takipte (yıldız): hisse kodlarının yanında
export function WatchBtn({ on, onClick, sym, big }: { on: boolean; onClick: () => void; sym: string; big?: boolean }) {
  return (
    <button type="button" className={"watch-btn" + (on ? " on" : "") + (big ? " big" : "")} aria-pressed={on}
      title={on ? `${sym} takip listesinden çıkar` : `${sym} takip listesine ekle`}
      onClick={e => { e.stopPropagation(); onClick(); }} onKeyDown={e => e.stopPropagation()}>
      <svg viewBox="0 0 24 24" aria-hidden><path d="M12 3.5l2.6 5.3 5.9.9-4.25 4.1 1 5.85L12 16.9l-5.25 2.75 1-5.85L3.5 9.7l5.9-.9z" /></svg>
      <span>{on ? "Takipte" : "Takip et"}</span>
    </button>
  );
}
