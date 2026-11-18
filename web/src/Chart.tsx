import { useEffect, useRef } from "react";
import { createChart, CandlestickSeries, LineSeries, HistogramSeries, LineStyle, type UTCTimestamp } from "lightweight-charts";
import type { Bar, Kronos } from "./api";
import { gsap, reduced } from "./motion";

const css = (v: string) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
export type PriceLine = { price: number; title: string; tone: "ink" | "stop" | "target" | "muted" };

// Günlük mumlar + yatay plan çizgileri (+ isteğe bağlı Kronos medyan yolu ve 40. gün bandı).
// Açılışta perde soldan sağa çekilir; Kronos yolu ardından çizilir.
export default function Chart({ bars, lines, kronos, entry, label }: { bars: Bar[]; lines: PriceLine[]; kronos?: Kronos; entry?: number; label: string }) {
  const el = useRef<HTMLDivElement>(null), cover = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!el.current || !bars.length) return;
    const ink = css("--text"), muted = css("--muted"), pos = css("--positive"), acc = css("--negative");
    const chart = createChart(el.current, {
      autoSize: true,
      layout: { background: { color: "transparent" }, textColor: muted, fontFamily: "Inter Tight, system-ui, sans-serif", fontSize: 12, attributionLogo: false },
      grid: { vertLines: { visible: false }, horzLines: { color: css("--rule") } },
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.08, bottom: 0.2 } },
      timeScale: { borderVisible: false, rightOffset: 4 },
      localization: { locale: "tr-TR" },
      crosshair: { vertLine: { color: css("--control"), labelBackgroundColor: css("--raised") }, horzLine: { color: css("--control"), labelBackgroundColor: css("--raised") } },
    });
    const c = chart.addSeries(CandlestickSeries, {
      upColor: pos, downColor: acc, borderUpColor: pos, borderDownColor: acc, wickUpColor: pos, wickDownColor: acc, priceLineVisible: false,
    });
    c.setData(bars.map(b => ({ time: b[0] as UTCTimestamp, open: b[1], high: b[2], low: b[3], close: b[4] })));
    if (bars.some(b => b[5] > 0)) {
      const vol = chart.addSeries(HistogramSeries, { priceScaleId: "v", color: css("--accent-track"), priceFormat: { type: "volume" }, lastValueVisible: false, priceLineVisible: false });
      chart.priceScale("v").applyOptions({ scaleMargins: { top: 0.84, bottom: 0 }, visible: false });
      vol.setData(bars.map(b => ({ time: b[0] as UTCTimestamp, value: b[5] })));
    }
    const lo = Math.min(...lines.map(l => l.price)), hi = Math.max(...lines.map(l => l.price));
    c.applyOptions({ autoscaleInfoProvider: (orig: () => any) => { const r = orig(); if (!r || !lines.length) return r;
      return { ...r, priceRange: { minValue: Math.min(r.priceRange.minValue, lo), maxValue: Math.max(r.priceRange.maxValue, hi) } }; } });
    const tone = { ink, stop: acc, target: pos, muted } as const;
    for (const l of lines) c.createPriceLine({ price: l.price, color: tone[l.tone], lineWidth: 1, lineStyle: l.tone === "ink" || l.tone === "muted" ? LineStyle.Dotted : LineStyle.Solid, title: l.title });

    let draw: gsap.core.Tween | null = null;
    if (kronos && entry) {
      let t = bars[bars.length - 1][0];
      const days: number[] = [];
      while (days.length < kronos.path.length) { t += 86400; const wd = new Date(t * 1000).getUTCDay(); if (wd && wd !== 6) days.push(t); }
      const t0 = bars[bars.length - 1][0] as UTCTimestamp;
      const full = [{ time: t0, value: entry }, ...kronos.path.map((r, i) => ({ time: days[i] as UTCTimestamp, value: entry * (1 + r) }))];
      const line = chart.addSeries(LineSeries, { color: css("--cherry-600"), lineWidth: 2, lastValueVisible: true, priceLineVisible: false, title: "Kronos medyan" });
      const band = (r: number, title: string) => chart.addSeries(LineSeries, { color: css("--cherry-400"), lineWidth: 1, lineStyle: LineStyle.Dashed, lastValueVisible: true, priceLineVisible: false, title })
        .setData([{ time: t0, value: entry }, { time: days[days.length - 1] as UTCTimestamp, value: entry * (1 + r) }]);
      band(kronos.p90, "%90"); band(kronos.p10, "%10");
      if (reduced()) line.setData(full);
      else { const o = { n: 1 }; line.setData(full.slice(0, 1)); draw = gsap.to(o, { n: full.length, duration: 1.2, delay: 0.9, ease: "power2.out", onUpdate: () => line.setData(full.slice(0, Math.max(1, Math.round(o.n)))) }); }
    }
    chart.timeScale().fitContent();
    const reveal = reduced() ? null : gsap.fromTo(cover.current, { scaleX: 1 }, { scaleX: 0, duration: 1.1, ease: "power3.inOut", transformOrigin: "right center" });
    return () => { draw?.kill(); reveal?.kill(); chart.remove(); };
  }, [bars, lines, kronos, entry]);
  return (
    <div className="chart-box">
      <div ref={el} className="chart" role="img" aria-label={label} />
      <div ref={cover} className="chart-cover" aria-hidden />
    </div>
  );
}
