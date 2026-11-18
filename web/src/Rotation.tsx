import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Stock } from "./api";
import { gsap, useGSAP, reduced, Flip , lenisStop, lenisStart } from "./motion";
import { QUAD, quadOf, VTEXT, type Quad } from "./ui";

// Rotasyon haritası (RRG benzeri): x = RS-oran (hisse/endeks, 50 günlük ortalamasına göre), y = RS-momentum (RS-oranın 10 günlük değişimi).
// Fareyle üzerine gelince büyüyüp sayfanın ortasına açılır (arkada kayan yıldızlı gece gökyüzü).
// İçinde: tekerlek = imleç etrafında yakınlaş/uzaklaş, sürükle = kaydır, çift tık = yakınlaş. Noktalar ve yazılar boyut değiştirmez.
const W = 600, H = 540, L = 38, R = 14, T = 14, B = 30;
const PW = W - L - R, PH = H - T - B;
const KMAX = 14;
// rota renkleri: en eski hafta altın → en yeni vişne
const ROUTE = ["#12415c", "#0b6fa6", "#0297DE", "#7ccbf5", "#FC734D"];
const VCOL: Record<string, string> = { ALINIR: "var(--v-alinir)", KARARSIZ: "var(--v-kararsiz)", ALINMAZ: "var(--v-alinmaz)" };
const hash = (t: string) => [...t].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
type View = { k: number; tx: number; ty: number };               // ekran = taban × k + t
const HOME: View = { k: 1, tx: 0, ty: 0 };
const fit = (k: number, tx: number, ty: number): View => {
  k = clamp(k, 1, KMAX);
  return { k, tx: clamp(tx, (W - R) * (1 - k), L * (1 - k)), ty: clamp(ty, (H - B) * (1 - k), T * (1 - k)) };
};

export default function Rotation({ stocks, selected, onSelect, scanning, owned, quad, version }: {
  stocks: Stock[]; selected: string | null; onSelect: (t: string) => void; scanning: boolean; owned: Set<string>; quad: Quad | null; version: string;
}) {
  const root = useRef<HTMLDivElement>(null), slot = useRef<HTMLDivElement>(null), svg = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [view, setView] = useState<View>(HOME);
  const [intro, setIntro] = useState(reduced() ? 1 : 0);
  const [week, setWeek] = useState<number | null>(null);
  const [selDraw, setSelDraw] = useState(1);
  const [lifted, setLifted] = useState(false);
  const [panning, setPanning] = useState(false);
  const v = useRef<View>({ ...HOME }), goal = useRef<View>({ ...HOME }), tw = useRef<gsap.core.Tween | null>(null);
  const liftedRef = useRef(false), flipState = useRef<Flip.FlipState | null>(null), entered = useRef(false);
  const tLift = useRef(0), tClose = useRef(0);
  const drag = useRef<{ id: number; x: number; y: number; t: View; moved: boolean } | null>(null), justDragged = useRef(false);
  const pts = useMemo(() => stocks.filter(s => s.rrg && s.rrg.length), [stocks]);

  // taban ölçek: uç değerler kenara yapışır, merkez her zaman 100/100
  const base = useMemo(() => {
    const q = (a: number[], p: number) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? 0; };
    const hx = Math.max(4, q(pts.flatMap(s => s.rrg!.map(p => Math.abs(p[0] - 100))), 0.97) * 1.08);
    const hy = Math.max(2.5, q(pts.flatMap(s => s.rrg!.map(p => Math.abs(p[1] - 100))), 0.97) * 1.08);
    const bx = (x: number) => L + clamp((x - (100 - hx)) / (2 * hx), 0, 1) * PW;
    const by = (y: number) => T + (1 - clamp((y - (100 - hy)) / (2 * hy), 0, 1)) * PH;
    const ix = (px: number) => 100 - hx + ((px - L) / PW) * 2 * hx;
    const iy = (py: number) => 100 - hy + (1 - (py - T) / PH) * 2 * hy;
    return { bx, by, ix, iy, hx, hy };
  }, [pts]);
  const sx = (x: number) => base.bx(x) * view.k + view.tx;
  const sy = (y: number) => base.by(y) * view.k + view.ty;
  const cx = sx(100), cy = sy(100), ccx = clamp(cx, L, W - R), ccy = clamp(cy, T, H - B);
  const head = (s: Stock) => s.rrg![s.rrg!.length - 1];
  const at = (s: Stock): number[] => {
    if (week == null) return head(s);
    const a = s.rrg!, i = Math.min(a.length - 2, Math.floor(week)), f = week - i;
    return [a[i][0] + (a[i + 1][0] - a[i][0]) * f, a[i][1] + (a[i + 1][1] - a[i][1]) * f];
  };
  const radius = (s: Stock) => 3.4 + s.score * 0.7;
  const inQuad = (s: Stock) => quad == null || quadOf(head(s)) === quad;
  const focus = selected && pts.some(s => s.ticker === selected) ? selected : null;
  const dim = (s: Stock) => (!inQuad(s) ? 0.12 : focus && s.ticker !== focus ? (s.ticker === hover ? 0.8 : owned.has(s.ticker) ? 0.45 : 0.18) : 1);
  const showTrail = (s: Stock) => s.ticker === focus || s.ticker === hover || (week != null && inQuad(s) && s.verdict !== "ALINMAZ") || (!focus && owned.has(s.ticker));
  const showLabel = (s: Stock) => s.ticker === focus || s.ticker === hover || (!focus && (owned.has(s.ticker) || s.verdict === "ALINIR" || view.k > 1.8));
  const order = useMemo(() => [...pts].sort((a, b) => a.score - b.score), [pts]);

  // ---------------------------------------------------------------- görünüm: yakınlaşma ve kaydırma
  const to = (t: View, d: number) => {
    const f = fit(t.k, t.tx, t.ty);
    goal.current = f;
    tw.current?.kill();
    if (d === 0 || reduced()) { v.current = { ...f }; setView(f); return; }
    tw.current = gsap.to(v.current, { ...f, duration: d, ease: "power3.out", onUpdate: () => setView({ ...v.current }) });
  };
  const zoomAt = (px: number, py: number, k2: number, d = 0.28) => {
    const g = goal.current; k2 = clamp(k2, 1, KMAX);
    to({ k: k2, tx: px - ((px - g.tx) * k2) / g.k, ty: py - ((py - g.ty) * k2) / g.k }, d);
  };
  const svgPt = (clientX: number, clientY: number) => {
    const m = svg.current?.getScreenCTM(); if (!m) return null;
    const p = new DOMPoint(clientX, clientY).matrixTransform(m.inverse());
    return { x: p.x, y: p.y };
  };
  const frame = (d = 0.8) => {                                    // seçili rotayı ortala, yoksa tümü
    const s = focus ? pts.find(x => x.ticker === focus) : null;
    if (!s) { to(HOME, d); return; }
    const xs = s.rrg!.map(p => base.bx(p[0])), ys = s.rrg!.map(p => base.by(p[1]));
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    const k = clamp(Math.min((PW * 0.6) / Math.max(1, x1 - x0), (PH * 0.6) / Math.max(1, y1 - y0)), 1, 6);
    to({ k, tx: L + PW / 2 - ((x0 + x1) / 2) * k, ty: T + PH / 2 - ((y0 + y1) / 2) * k }, d);
  };
  useEffect(() => { if (!drag.current && week == null) frame(0.9); }, [focus]); // eslint-disable-line

  // tekerlek: yalnızca harita büyükken (küçükken sayfa normal kaysın)
  useEffect(() => {
    const el = svg.current!;
    const onWheel = (e: WheelEvent) => {
      if (!liftedRef.current) return;
      e.preventDefault();
      const p = svgPt(e.clientX, e.clientY); if (!p) return;
      const dy = e.deltaMode === 1 ? e.deltaY * 30 : e.deltaY;
      zoomAt(p.x, p.y, goal.current.k * Math.exp(-dy * 0.0016), 0.4);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }); // her render'da güncel kapanışlar

  const onDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || (e.pointerType !== "mouse" && !liftedRef.current)) return;
    drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, t: { ...goal.current }, moved: false };
  };
  const onDragMove = (e: React.PointerEvent) => {
    const d = drag.current; if (!d || d.id !== e.pointerId) return;
    const dx = e.clientX - d.x, dy = e.clientY - d.y;
    if (!d.moved && Math.hypot(dx, dy) < 4) return;
    if (!d.moved) { d.moved = true; svg.current!.setPointerCapture(e.pointerId); setPanning(true); }
    const s = W / svg.current!.getBoundingClientRect().width;
    to({ k: d.t.k, tx: d.t.tx + dx * s, ty: d.t.ty + dy * s }, 0);
  };
  const onUp = (e: React.PointerEvent) => {
    const d = drag.current; if (!d || d.id !== e.pointerId) return;
    if (d.moved) { justDragged.current = true; setTimeout(() => (justDragged.current = false), 0); svg.current!.releasePointerCapture(e.pointerId); }
    drag.current = null; setPanning(false);
  };
  const onDbl = (e: React.MouseEvent) => { const p = svgPt(e.clientX, e.clientY); if (p) zoomAt(p.x, p.y, goal.current.k * 2, 0.7); };
  const zoomBtn = (f: number) => zoomAt(L + PW / 2, T + PH / 2, goal.current.k * f, 0.6);

  // ---------------------------------------------------------------- büyüt: sayfanın ortasına aç (GSAP Flip)
  const lift = useCallback((on: boolean) => {
    if (on === liftedRef.current || !root.current) return;
    flipState.current = Flip.getState(root.current);
    if (on && slot.current) slot.current.style.height = slot.current.offsetHeight + "px";
    liftedRef.current = on; entered.current = false;
    setLifted(on);
  }, []);
  useLayoutEffect(() => {
    const st = flipState.current; if (!st || !root.current) return;
    flipState.current = null;
    const done = () => { if (!liftedRef.current && slot.current) slot.current.style.height = ""; };
    if (reduced()) { done(); return; }
    Flip.from(st, { duration: 0.85, ease: "expo.inOut", scale: false, onComplete: done });
  }, [lifted]);
  useEffect(() => {
    if (!lifted) return;
    const k = (e: KeyboardEvent) => {
      if (e.key === "Escape") lift(false);
      else if (e.key === "+" || e.key === "=") zoomBtn(1.5);
      else if (e.key === "-") zoomBtn(1 / 1.5);
      else if (e.key === "0") frame(0.6);
    };
    addEventListener("keydown", k); document.body.style.overflow = "hidden"; lenisStop();
    return () => { removeEventListener("keydown", k); document.body.style.overflow = ""; lenisStart(); };
  }, [lifted]); // eslint-disable-line
  const onEnter = (e: React.PointerEvent) => {
    if (e.pointerType !== "mouse") return;
    clearTimeout(tClose.current);
    if (!liftedRef.current) tLift.current = window.setTimeout(() => lift(true), 380);
  };
  const onRootMove = (e: React.PointerEvent) => { if (liftedRef.current && e.pointerType === "mouse") { entered.current = true; clearTimeout(tClose.current); } };
  const onRootLeave = (e: React.PointerEvent) => {
    setHover(null);
    clearTimeout(tLift.current);
  };
  useEffect(() => () => { clearTimeout(tLift.current); clearTimeout(tClose.current); tw.current?.kill(); }, []);

  // ---------------------------------------------------------------- açılış ve seçim animasyonları
  useGSAP(() => {
    if (reduced()) { setIntro(1); return; }
    const o = { p: 0 };
    gsap.to(o, { p: 1, duration: 1.3, ease: "expo.out", delay: 0.15, onUpdate: () => setIntro(o.p) });
    gsap.from(svg.current!.querySelectorAll(".q, .axis, .q-label, .q-sub"), { opacity: 0, duration: 0.6, stagger: 0.04 });
  }, { scope: svg, dependencies: [version] });
  const ip = (s: Stock) => clamp(intro * 1.25 - (hash(s.ticker) % 100) / 400, 0, 1);
  useEffect(() => {
    if (!focus || reduced()) { setSelDraw(1); return; }
    const o = { p: 0 }; setSelDraw(0);
    const t = gsap.to(o, { p: 1, duration: 0.9, ease: "power2.inOut", onUpdate: () => setSelDraw(o.p) });
    return () => { t.kill(); };
  }, [focus]);
  useGSAP(() => {
    if (!scanning || reduced()) return;
    gsap.fromTo(".scan-g", { x: L }, { x: W - R, duration: 1.4, ease: "none", repeat: -1 });
  }, { scope: svg, dependencies: [scanning] });
  const play = () => {
    if (week != null) return;
    to(HOME, 0.4);
    if (reduced()) return;
    const o = { w: 0 }; setWeek(0);
    gsap.to(o, { w: 5, duration: 4, ease: "none", delay: 0.4, onUpdate: () => setWeek(o.w), onComplete: () => { setWeek(null); frame(0.9); } });
  };

  const trailPath = (s: Stock, upto = 5) => {
    const a = s.rrg!, n = Math.floor(upto), f = upto - n, out: number[][] = a.slice(0, n + 1);
    if (f > 0 && n < a.length - 1) out.push([a[n][0] + (a[n + 1][0] - a[n][0]) * f, a[n][1] + (a[n + 1][1] - a[n][1]) * f]);
    return out.map((p, i) => `${i ? "L" : "M"}${sx(p[0]).toFixed(1)},${sy(p[1]).toFixed(1)}`).join("");
  };
  const sel = focus ? pts.find(s => s.ticker === focus)! : null;
  const hv = hover ? pts.find(s => s.ticker === hover) : null;
  const tipPos = hv && svg.current ? (() => {
    const sr = svg.current!.getBoundingClientRect(), rr = root.current!.getBoundingClientRect(), k = sr.width / W; const [x, y] = at(hv);
    return { left: sr.left - rr.left + sx(x) * k, top: sr.top - rr.top + sy(y) * k };
  })() : null;
  const counts = (q: Quad) => pts.filter(s => quadOf(head(s)) === q).length;
  const lead = pts.filter(s => quadOf(head(s)) === "lead" && s.verdict === "ALINIR").map(s => s.symbol);
  const ticks = useMemo(() => {
    if (view.k < 1.2) return null;
    const x0 = base.ix((L - view.tx) / view.k), x1 = base.ix((W - R - view.tx) / view.k);
    const y0 = base.iy((H - B - view.ty) / view.k), y1 = base.iy((T - view.ty) / view.k);
    const step = (a: number, b: number) => { const r = Math.abs(b - a); return r > 24 ? 8 : r > 12 ? 4 : r > 6 ? 2 : r > 3 ? 1 : r > 1.5 ? 0.5 : 0.25; };
    const mk = (a: number, b: number) => { const s = step(a, b), o: number[] = []; for (let x = Math.ceil(Math.min(a, b) / s) * s; x <= Math.max(a, b); x += s) o.push(+x.toFixed(2)); return o; };
    return { xs: mk(x0, x1), ys: mk(y0, y1) };
  }, [view, base]);

  return (
    <div className="rot-slot" ref={slot}>
      <div ref={root} className={"rot" + (lifted ? " rot-lifted" : "")} role={lifted ? "dialog" : undefined} aria-modal={lifted || undefined} aria-label={lifted ? "Rotasyon haritası, büyütülmüş" : undefined}
        onPointerEnter={onEnter} onPointerMove={onRootMove} onPointerLeave={onRootLeave}>
        <div className="rot-head">
          <h2>Rotasyon haritası</h2>
          <div className="actions">
            <span className="small muted" aria-live="polite">{week != null ? (5 - Math.floor(week) > 0 ? `${5 - Math.floor(week)} hafta önce` : "bugün") : view.k > 1.05 ? `${view.k.toFixed(1)}×` : "bugün"}</span>
            <div className="zoom-ctl" role="group" aria-label="Yakınlaştırma">
              <button onClick={() => zoomBtn(1 / 1.6)} aria-label="Uzaklaştır" disabled={view.k <= 1.01}>−</button>
              <button onClick={() => zoomBtn(1.6)} aria-label="Yakınlaştır" disabled={view.k >= KMAX - 0.01}>+</button>
              <button className="zoom-fit" onClick={() => frame(0.6)} aria-label={focus ? "Seçili rotaya sığdır" : "Tümünü göster"}>Sığdır</button>
            </div>
            <button className="btn btn-ghost btn-sm" onClick={play} disabled={week != null}>{week != null ? "Oynatılıyor" : "Son 6 haftayı oynat"}</button>
            <button className="btn btn-ghost btn-sm" onClick={() => lift(!lifted)} aria-pressed={lifted}>{lifted ? "Kapat" : "Büyüt"}</button>
          </div>
        </div>
        <div className="rot-wrap">
          <svg ref={svg} viewBox={`0 0 ${W} ${H}`} className={"rot-svg" + (scanning ? " dim" : "") + (view.k > 1.01 ? " can-pan" : "") + (panning ? " panning" : "")} role="img"
            aria-label={`Rotasyon haritası, ${pts.length} hisse. Lider ${counts("lead")}, zayıflayan ${counts("weak")}, geride ${counts("lag")}, toparlanan ${counts("impr")}. ${lead.length ? "Lider bölgede alınır: " + lead.join(", ") + "." : ""}${sel ? ` Seçili ${sel.symbol}: 6 hafta önce ${QUAD[quadOf(sel.rrg![0])!].name}, şimdi ${QUAD[quadOf(head(sel))!].name}.` : ""}`}
            onPointerDown={onDown} onPointerMove={onDragMove} onPointerUp={onUp} onPointerCancel={onUp} onDoubleClick={onDbl}>
            <defs>
              <clipPath id="plot"><rect x={L} y={T} width={PW} height={PH} rx={10} /></clipPath>
              <marker id="arrow" viewBox="0 0 10 10" refX="6" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#FC734D" /></marker>
            </defs>
            <g clipPath="url(#plot)">
              <rect className="q q-other" x={L} y={T} width={PW} height={PH} />
              <rect className="q q-lead" x={ccx} y={T} width={Math.max(0, W - R - ccx)} height={Math.max(0, ccy - T)} />
              {ticks && <g className="grid">
                {ticks.xs.map(x => <line key={"gx" + x} x1={sx(x)} x2={sx(x)} y1={T} y2={H - B} />)}
                {ticks.ys.map(y => <line key={"gy" + y} x1={L} x2={W - R} y1={sy(y)} y2={sy(y)} />)}
              </g>}
              <line className="axis" x1={L} x2={W - R} y1={cy} y2={cy} />
              <line className="axis" x1={cx} x2={cx} y1={T} y2={H - B} />
              <text className="q-label lead" x={W - R - 12} y={T + 22} textAnchor="end">{QUAD.lead.name}</text>
              <text className="q-sub" x={W - R - 12} y={T + 38} textAnchor="end">{QUAD.lead.sub}</text>
              <text className="q-label" x={W - R - 12} y={H - B - 26} textAnchor="end">{QUAD.weak.name}</text>
              <text className="q-sub" x={W - R - 12} y={H - B - 10} textAnchor="end">{QUAD.weak.sub}</text>
              <text className="q-label" x={L + 12} y={H - B - 26}>{QUAD.lag.name}</text>
              <text className="q-sub" x={L + 12} y={H - B - 10}>{QUAD.lag.sub}</text>
              <text className="q-label" x={L + 12} y={T + 22}>{QUAD.impr.name}</text>
              <text className="q-sub" x={L + 12} y={T + 38}>{QUAD.impr.sub}</text>

              {order.filter(s => showTrail(s) && s.ticker !== focus).map(s => (
                <path key={"tr" + s.ticker} className="trail" d={trailPath(s, week ?? 5)} stroke={VCOL[s.verdict]} style={{ opacity: dim(s) * 0.8 }} />
              ))}

              {sel && (() => {
                const a = sel.rrg!, upto = (week ?? 5) * selDraw;
                const P = (i: number) => [sx(a[i][0]), sy(a[i][1])];
                const segs = a.slice(0, -1).map((_, i) => {
                  if (i >= upto) return null;
                  const f = Math.min(1, upto - i), [x0, y0] = P(i), [x1, y1] = P(i + 1);
                  return { d: `M${x0.toFixed(1)},${y0.toFixed(1)}L${(x0 + (x1 - x0) * f).toFixed(1)},${(y0 + (y1 - y0) * f).toFixed(1)}`, c: ROUTE[i] };
                }).filter(Boolean) as { d: string; c: string }[];
                const full = trailPath(sel, upto);
                return (
                  <g className="sel-route">
                    <path className="route-halo" d={full} />
                    {segs.map((g, i) => <path key={i} className="route-seg" d={g.d} stroke={g.c} markerEnd={i === 4 && selDraw > 0.95 && week == null ? "url(#arrow)" : undefined} />)}
                    <path className="route-flow" d={full} />
                    {a.slice(0, -1).map((p, i) => i <= upto && (
                      <g key={i} transform={`translate(${sx(p[0]).toFixed(1)},${sy(p[1]).toFixed(1)})`}>
                        <circle className="route-dot" r={10} style={{ fill: ROUTE[i] }} />
                        <text className="route-num" y={4} textAnchor="middle">{5 - i}</text>
                      </g>
                    ))}
                  </g>
                );
              })()}

              {!scanning && week == null && view.k <= 1.01 && (
                <g className="sweep" style={{ transformOrigin: `${cx}px ${cy}px` }} aria-hidden>
                  <path d={`M${cx},${cy} L${cx},${cy - 720} A720,720 0 0 0 ${cx - 720 * Math.sin(0.55)},${cy - 720 * Math.cos(0.55)} Z`} />
                  <line x1={cx} y1={cy} x2={cx} y2={cy - 720} />
                </g>
              )}
              {scanning && <g className="scan-g"><rect className="scanglow" x={-24} y={T} width={24} height={PH} opacity={0.7} /><line className="scanline" x1={0} x2={0} y1={T} y2={H - B} /></g>}

              {order.map(s => {
                const [x, y] = at(s), p = ip(s);
                const px = cx + (sx(x) - cx) * p, py = cy + (sy(y) - cy) * p;
                const isSel = s.ticker === focus;
                return (
                  <g key={s.ticker} data-t={s.ticker} className={"pt" + (isSel ? " is-sel" : "")} transform={`translate(${px.toFixed(1)},${py.toFixed(1)})`} style={{ opacity: dim(s) * Math.min(1, p * 2) }}
                    onPointerEnter={() => setHover(s.ticker)} onPointerLeave={() => setHover(h => (h === s.ticker ? null : h))}
                    onClick={() => { if (!justDragged.current) onSelect(s.ticker); }}>
                    <circle r={14} fill="transparent" />
                    <circle className="head" r={radius(s) + (isSel ? 3 : 0)} fill={isSel ? ROUTE[4] : VCOL[s.verdict]} />
                    {owned.has(s.ticker) && <circle className="own" r={radius(s) + 4.5} />}
                    {isSel && <circle className="sel-ring" r={radius(s) + 8} />}
                    {showLabel(s) && <text className={"lbl" + (isSel ? " lbl-sel" : "")} x={radius(s) + (isSel ? 11 : 5)} y={4}>{s.symbol}</text>}
                  </g>
                );
              })}
            </g>

            {ticks ? <>
              {ticks.xs.map(x => <text key={"tx" + x} className="tick" x={sx(x)} y={H - 10} textAnchor="middle">{x}</text>)}
              {ticks.ys.map(y => <text key={"ty" + y} className="tick" x={L - 6} y={sy(y) + 4} textAnchor="end">{y}</text>)}
            </> : <>
              <text className="tick" x={L} y={H - 10}>{(100 - base.hx).toFixed(0)}</text>
              <text className="tick" x={cx} y={H - 10} textAnchor="middle">100 · RS-oran →</text>
              <text className="tick" x={W - R} y={H - 10} textAnchor="end">{(100 + base.hx).toFixed(0)}</text>
              <text className="tick" x={L - 6} y={T + 10} textAnchor="end">{(100 + base.hy).toFixed(0)}</text>
              <text className="tick" x={L - 6} y={cy + 4} textAnchor="end">100</text>
              <text className="tick" x={L - 6} y={H - B} textAnchor="end">{(100 - base.hy).toFixed(0)}</text>
            </>}
          </svg>
        </div>
        {hv && tipPos && <div className="rot-tip" style={tipPos} role="status"><b>{hv.symbol}</b> · {VTEXT[hv.verdict]} {hv.score}/8 · {QUAD[quadOf(head(hv))!].name}</div>}
        <div className="rot-legend">
          {sel ? <>
            <span><i style={{ background: "var(--accent)" }} /><b>{sel.symbol}</b>&nbsp;rotası: {QUAD[quadOf(sel.rrg![0])!].name} → {QUAD[quadOf(head(sel))!].name}</span>
            <span className="route-key" aria-hidden>{ROUTE.map(c => <i key={c} style={{ background: c }} />)}</span>
            <span className="muted">5 hafta önce → bugün</span>
          </> : <>
            <span><i style={{ background: "var(--v-alinir)" }} />Alınır</span>
            <span><i style={{ background: "var(--v-kararsiz)" }} />Kararsız</span>
            <span><i style={{ background: "var(--v-alinmaz)" }} />Alınmaz</span>
            <span><i className="own-key" />Portföyünde</span>
          </>}
          <span className="muted">{lifted ? "Tekerlek: yakınlaş/uzaklaş · sürükle: kaydır · çift tık: yakınlaş · Esc: kapat" : "Fareyle üzerine gel: harita büyür. Noktaya tıkla: rotası açılır, tekrar tıkla: kapanır."}</span>
        </div>
      </div>
    </div>
  );
}
