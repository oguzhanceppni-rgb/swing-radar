import gsap from "gsap";
import { useGSAP } from "@gsap/react";
import { SplitText } from "gsap/SplitText";
import { ScrambleTextPlugin } from "gsap/ScrambleTextPlugin";
import { Flip } from "gsap/Flip";
import { DrawSVGPlugin } from "gsap/DrawSVGPlugin";
import { CustomEase } from "gsap/CustomEase";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import Lenis from "lenis";

gsap.registerPlugin(ScrollTrigger, useGSAP, SplitText, ScrambleTextPlugin, Flip, DrawSVGPlugin, CustomEase);

// transitions.dev --ease-smooth-out ile aynı eğri
CustomEase.create("smooth", "0.22, 1, 0.36, 1");
gsap.defaults({ ease: "smooth", duration: 0.6 });

export const reduced = () => typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;
export { gsap, useGSAP, SplitText, Flip, ScrollTrigger };

// Ekranın altında kalan blokları kaydırdıkça 3B olarak yerine oturtur (bir kez): aşağıdan, geriye yatık, bulanık → düz ve net.
// useGSAP içinde çağrılır; temizliği context yapar.
export const FROM3D = { y: 24, opacity: 0 };
export const TO3D = { y: 0, opacity: 1, duration: 0.9, ease: "power3.out", clearProps: "transform" };
// bulanıklık hareketten biraz önce açılır
export const UNBLUR = { duration: 0.01, clearProps: "filter" };
export function revealEls(els: Element[], onEnter?: (b: Element[]) => void, small = false) {
  if (!els.length || reduced()) return;
  gsap.set(els, small ? { y: 16, opacity: 0 } : FROM3D);
  ScrollTrigger.batch(els, { start: "top 95%", once: true, onEnter: b => {
    gsap.to(b, small ? { y: 0, opacity: 1, duration: 0.7, ease: "power3.out", stagger: 0.05, clearProps: "transform" } : { ...TO3D, stagger: 0.08 });
    gsap.to(b, { ...UNBLUR, duration: small ? 0.4 : UNBLUR.duration, stagger: small ? 0.05 : 0.08 });
    onEnter?.(b);
  } });
}
export function reveal(scope: Element | null | undefined, sel: string, onEnter?: (b: Element[]) => void) {
  if (scope) revealEls(Array.from(scope.querySelectorAll(sel)), onEnter, true);
}

// Fareyi takip eden ışık (paneller) + mıknatıs düğmeler. Bir kez kurulur.
export function pointerFx() {
  if (reduced() || matchMedia("(hover: none)").matches) return () => {};
  const move = (e: PointerEvent) => {
    const t = e.target as Element;
    const p = t.closest?.<HTMLElement>(".panel");
    if (p) { const r = p.getBoundingClientRect(); p.style.setProperty("--mx", e.clientX - r.left + "px"); p.style.setProperty("--my", e.clientY - r.top + "px"); }
    const b = t.closest?.<HTMLButtonElement>(".btn");
    if (b && !b.disabled) { const r = b.getBoundingClientRect(); gsap.to(b, { x: (e.clientX - r.left - r.width / 2) * 0.3, y: (e.clientY - r.top - r.height / 2) * 0.45, duration: 0.4, ease: "power3.out" }); }
  };
  const out = (e: PointerEvent) => {
    const b = (e.target as Element).closest?.(".btn");
    if (b && !b.contains(e.relatedTarget as Node)) gsap.to(b, { x: 0, y: 0, duration: 0.9, ease: "elastic.out(1, 0.35)" });
  };
  addEventListener("pointermove", move, { passive: true }); addEventListener("pointerout", out);
  return () => { removeEventListener("pointermove", move); removeEventListener("pointerout", out); };
}

// Tek yumuşak kaydırma motoru: Lenis, GSAP ticker'ına bağlı; ScrollTrigger her karede güncellenir.
// İç kaydırma alanları (tablo, arama listesi, büyütülmüş harita) data-lenis-prevent ile kendi kaydırmasını korur.
let lenis: Lenis | null = null;
export function startLenis() {
  if (reduced() || lenis) return () => {};
  lenis = new Lenis({ duration: 1.25, easing: t => 1 - Math.pow(1 - t, 4), wheelMultiplier: 0.9, touchMultiplier: 1.2 });
  lenis.on("scroll", ScrollTrigger.update);
  const tick = (t: number) => lenis?.raf(t * 1000);
  gsap.ticker.add(tick); gsap.ticker.lagSmoothing(0);
  document.documentElement.classList.add("lenis-on");
  return () => { gsap.ticker.remove(tick); lenis?.destroy(); lenis = null; document.documentElement.classList.remove("lenis-on"); };
}
export const lenisStop = () => lenis?.stop();
export const lenisStart = () => lenis?.start();
export function scrollToEl(t: string | number, instant = false) {
  if (lenis && instant && typeof t === "number") { lenis.resize(); scrollTo(0, t); lenis.scrollTo(t, { immediate: true, force: true }); return; }
  if (lenis) { lenis.scrollTo(t as any, { immediate: instant, offset: typeof t === "string" ? -84 : 0, duration: 1.4 }); return; }
  if (typeof t === "number") scrollTo({ top: t, behavior: instant ? "auto" : "smooth" });
  else document.querySelector(t)?.scrollIntoView({ behavior: instant ? "auto" : "smooth", block: "start" });
}
