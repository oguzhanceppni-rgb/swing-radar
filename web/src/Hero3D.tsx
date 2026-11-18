import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import * as THREE from "three";
import type { Stock } from "./api";
import { gsap, reduced, ScrollTrigger, SplitText, scrollToEl } from "./motion";
import { trNum } from "./ui";

// Tarama açılışı (sabit sahne, 3 perde):
// 1) Piyasa küresi: her hisse yüzeyde bir nokta, arkasında yoğun bir parçacık kabuğu; yavaşça döner, fareye eğilir.
// 2) Kaydırınca: son iki haftada ivmesi yeniden artan hisselerin kodları ekranın rastgele yerlerinde belirir;
//    her biri kendi ritminde salınır, döner ve süzülür. Koda tıkla: hisse açılır.
// 3) Rejim cümlesi.
THREE.ColorManagement.enabled = false; // renkler shader'a doğrudan sRGB gider (krem paletle birebir)
// açılış gece sahnesi: koyu vişne-siyah zeminde aynı paletin aydınlık tonları
const QC = { lead: "#0297DE", weak: "#7ccbf5", impr: "#FC734D", lag: "#4c5f6b" } as const;
const quad = (p: number[] | null) => !p ? "lag" : p[0] >= 100 ? (p[1] >= 100 ? "lead" : "weak") : (p[1] >= 100 ? "impr" : "lag");
// kodlar sayfa paletinin (vişne, yeşil, hardal) dışında, koyu zeminde rahat okunan açık tonlar
const INK = ["#7ccbf5", "#ffffff", "#2aaef0", "#ffa98f", "#b9e4fa", "#FC734D", "#e6f7ff"];
const webgl = () => { try { const c = document.createElement("canvas"); return !!(c.getContext("webgl2") || c.getContext("webgl")); } catch { return false; } };
const R = 3.2;
const NIGHT: Record<string, string> = {
  "--ground": "#010406", "--surface": "#050c11", "--raised": "#0a151d", "--border": "#101c25", "--rule": "#0c161d",
};
const day = () => { const cs = getComputedStyle(document.documentElement); return Object.fromEntries(Object.keys(NIGHT).map(k => [k, cs.getPropertyValue(k).trim()])); };

// ivme yeniden artıyor: son iki adımda (≈10 gün) momentum yükseliyor ve yakın dibinden belirgin dönmüş
export function reaccel(stocks: Stock[]) {
  const rows = stocks.map(s => {
    const t = s.rrg; if (!t || t.length < 4) return null;
    const y = t.map(p => p[1]), n = y.length, lo = Math.min(...y.slice(n - 4, n - 1));
    return { s, up: y[n - 1] - lo, rising: y[n - 1] > y[n - 2] && y[n - 2] >= y[n - 3] - 0.2 };
  }).filter((r): r is NonNullable<typeof r> => !!r);
  const hit = rows.filter(r => r.rising && r.up > 0.8).sort((a, b) => b.up - a.up);
  return (hit.length >= 6 ? hit : rows.filter(r => r.up > 0).sort((a, b) => b.up - a.up)).slice(0, 18);
}

const VERT = /* glsl */ `
attribute vec3 aCol; attribute float aSize; attribute float aIdx;
uniform float uRot, uPix, uH, uSel, uHover, uA;
varying vec3 vCol; varying float vSel; varying float vFront;
void main() {
  float c = cos(uRot), s = sin(uRot);
  vec3 a = vec3(c * position.x + s * position.z, position.y, -s * position.x + c * position.z);
  vec4 mv = modelViewMatrix * vec4(a, 1.0);
  float sel = step(abs(aIdx - uSel), 0.5), hov = step(abs(aIdx - uHover), 0.5);
  gl_PointSize = aSize * (1.0 + sel * 0.9 + hov * 0.7) * uPix * uH * 0.15 / -mv.z;
  gl_Position = projectionMatrix * mv;
  vCol = aCol; vSel = sel; vFront = smoothstep(-${R.toFixed(1)}, ${R.toFixed(1)}, a.z) * uA;
}`;
const FRAG = /* glsl */ `
varying vec3 vCol; varying float vSel; varying float vFront;
void main() {
  float r = length(gl_PointCoord - 0.5);
  float disc = smoothstep(0.5, 0.40, r);
  float ring = smoothstep(0.5, 0.45, r) * smoothstep(0.33, 0.38, r);
  float a = mix(disc, max(smoothstep(0.28, 0.22, r), ring), vSel);
  if (a < 0.02) discard;
  gl_FragColor = vec4(vCol, a * mix(0.28, 0.95, vFront));
}`;
const SHELL_VERT = /* glsl */ `
uniform float uRot, uPix, uH;
varying float vFront;
void main() {
  float c = cos(uRot), s = sin(uRot);
  vec3 a = vec3(c * position.x + s * position.z, position.y, -s * position.x + c * position.z);
  vec4 mv = modelViewMatrix * vec4(a, 1.0);
  gl_PointSize = uPix * uH * 0.03 / -mv.z;
  gl_Position = projectionMatrix * mv;
  vFront = smoothstep(-${R.toFixed(1)}, ${R.toFixed(1)}, a.z);
}`;
const SHELL_FRAG = /* glsl */ `
uniform float uA; varying float vFront;
void main() { float r = length(gl_PointCoord - 0.5); if (r > 0.5) discard; gl_FragColor = vec4(0.96, 0.78, 0.80, uA * mix(0.10, 0.5, vFront) * smoothstep(0.5, 0.15, r)); }`;

export default function Hero3D({ stocks, owned, selected, onPick, mid, end, children }: {
  stocks: Stock[]; owned: Set<string>; selected: string | null; onPick: (t: string) => void; mid: ReactNode; end: ReactNode; children: ReactNode;
}) {
  const [ok] = useState(() => !reduced() && webgl());
  const sec = useRef<HTMLElement>(null), cv = useRef<HTMLCanvasElement>(null), tip = useRef<HTMLDivElement>(null);
  const uni = useRef<Record<string, THREE.IUniform> | null>(null);
  const pick = useRef(onPick); pick.current = onPick;
  const acc = useMemo(() => reaccel(stocks), [stocks]);

  // kodların ekrandaki yerleri: rastgele, kürenin göbeğinden ve sol alttaki yazı alanından kaçarak, birbirine binmeden
  const spots = useMemo(() => {
    const out: { x: number; y: number }[] = [];
    for (let i = 0; i < acc.length; i++) {
      let best = { x: 50, y: 50 }, bd = -1;
      for (let k = 0; k < 40; k++) {
        const x = 4 + Math.random() * 80, y = 6 + Math.random() * 78;
        if (((x - 55) / 17) ** 2 + ((y - 47) / 26) ** 2 < 1 || (x < 56 && y > 44)) continue;
        const d = Math.min(99, ...out.map(o => Math.hypot((o.x - x) * 1.6, o.y - y)));
        if (d > bd) { bd = d; best = { x, y }; }
      }
      out.push(best);
    }
    return out;
  }, [acc]);

  // 3B küre
  useEffect(() => {
    if (!ok) return;
    const canvas = cv.current!, box = canvas.parentElement!, n = stocks.length;
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: "high-performance" });
    const dpr = Math.min(devicePixelRatio || 1, 1.75);
    renderer.setPixelRatio(dpr);
    const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(35, 1, 0.1, 100);
    camera.position.set(0, 0, 13);
    const group = new THREE.Group(); group.rotation.x = 0.32; scene.add(group);

    const fib = (i: number, m: number, r: number) => { const k = i + 0.5, phi = Math.acos(1 - (2 * k) / m), th = Math.PI * (1 + Math.sqrt(5)) * k; return [r * Math.sin(phi) * Math.cos(th), r * Math.cos(phi), r * Math.sin(phi) * Math.sin(th)]; };
    const pos = new Float32Array(n * 3), col = new Float32Array(n * 3), size = new Float32Array(n), idx = new Float32Array(n);
    const c = new THREE.Color();
    stocks.forEach((s, i) => {
      pos.set(fib(i, n, R * 1.012), i * 3);
      c.set(s.verdict === "ALINIR" ? "#ffffff" : QC[quad(s.rrg?.[s.rrg.length - 1] ?? null)]); col.set([c.r, c.g, c.b], i * 3);
      size[i] = 0.85 + (s.score / 8) * 0.9 + (owned.has(s.ticker) ? 0.5 : 0); idx[i] = i;
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geo.setAttribute("aCol", new THREE.BufferAttribute(col, 3));
    geo.setAttribute("aSize", new THREE.BufferAttribute(size, 1));
    geo.setAttribute("aIdx", new THREE.BufferAttribute(idx, 1));
    const u = { uRot: { value: 0 }, uPix: { value: dpr }, uH: { value: 800 }, uSel: { value: -1 }, uHover: { value: -1 }, uA: { value: 1 } };
    uni.current = u;
    const mat = new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: FRAG, uniforms: u, transparent: true, depthWrite: false });
    const pts = new THREE.Points(geo, mat); pts.renderOrder = 2; group.add(pts);

    // küre kabuğu: 2600 eşit dağılmış parçacık, önde koyu arkada soluk
    const sn = 2600, sp = new Float32Array(sn * 3);
    for (let i = 0; i < sn; i++) sp.set(fib(i, sn, R), i * 3);
    const sgeo = new THREE.BufferGeometry(); sgeo.setAttribute("position", new THREE.BufferAttribute(sp, 3));
    const su = { uRot: u.uRot, uPix: u.uPix, uH: u.uH, uA: { value: 1 } };
    const smat = new THREE.ShaderMaterial({ vertexShader: SHELL_VERT, fragmentShader: SHELL_FRAG, uniforms: su, transparent: true, depthWrite: false });
    group.add(new THREE.Points(sgeo, smat));

    const fit = () => {
      const w = box.clientWidth, h = box.clientHeight;
      renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); u.uH.value = h;
      camera.position.z = w / h < 1.2 ? 17 : 13;
    };
    fit();
    const ro = new ResizeObserver(fit); ro.observe(box);

    let target = 0, p = 0, rot = 0, mx = 0, my = 0, tx = 0, ty = 0, raf = 0, seen = true, hover = -1, prev = performance.now();
    const st = ScrollTrigger.create({ trigger: sec.current, start: "top top+=72", end: "bottom bottom", onUpdate: s => { target = s.progress; } });
    const io = new IntersectionObserver(([e]) => { seen = e.isIntersecting; }); io.observe(box);

    const v = new THREE.Vector3();
    const screenOf = (i: number) => {
      const cr = Math.cos(rot), sr = Math.sin(rot), x0 = pos[i * 3], y0 = pos[i * 3 + 1], z0 = pos[i * 3 + 2];
      v.set(cr * x0 + sr * z0, y0, -sr * x0 + cr * z0);
      const front = v.z > -0.6;
      v.applyMatrix4(group.matrixWorld).project(camera);
      return [(v.x + 1) / 2 * box.clientWidth, (1 - v.y) / 2 * box.clientHeight, front ? 1 : 0];
    };
    const move = (e: PointerEvent) => {
      const r = box.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
      tx = x / r.width - 0.5; ty = y / r.height - 0.5;
      let best = -1, bd = 16 * 16;
      if (p < 0.25) for (let i = 0; i < n; i++) { const [px, py, f] = screenOf(i), d = (px - x) ** 2 + (py - y) ** 2; if (f && d < bd) { bd = d; best = i; } }
      hover = best; u.uHover.value = best; canvas.style.cursor = best >= 0 ? "pointer" : "";
      const t = tip.current!;
      if (best >= 0) {
        const s = stocks[best], [px, py] = screenOf(best);
        t.innerHTML = `<b>${s.symbol}</b><span>${s.verdict === "ALINIR" ? "Alınır" : s.verdict === "KARARSIZ" ? "Kararsız" : "Alınmaz"} · ${s.score}/8</span>`;
        t.style.transform = `translate(${px + 14}px, ${py - 14}px)`; t.style.opacity = "1";
      } else t.style.opacity = "0";
    };
    const leave = () => { hover = -1; u.uHover.value = -1; tip.current!.style.opacity = "0"; tx = ty = 0; };
    const click = () => { if (hover >= 0) pick.current(stocks[hover].ticker); };
    canvas.addEventListener("pointermove", move); canvas.addEventListener("pointerleave", leave); canvas.addEventListener("click", click);

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const dt = Math.min(0.05, (now - prev) / 1000); prev = now;
      if (!seen || document.hidden) return;
      p += (target - p) * Math.min(1, dt * 5);
      const e = Math.min(1, p * 2.2);
      rot += dt * (0.14 + e * 0.1);
      mx += (tx - mx) * Math.min(1, dt * 3); my += (ty - my) * Math.min(1, dt * 3);
      group.rotation.set(0.32 + my * 0.35, mx * 0.5, 0);
      group.scale.setScalar(1 - 0.22 * e);
      u.uRot.value = rot; u.uA.value = 1 - 0.55 * e; su.uA.value = 1 - 0.6 * e;
      renderer.render(scene, camera);
    };
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf); st.kill(); ro.disconnect(); io.disconnect();
      canvas.removeEventListener("pointermove", move); canvas.removeEventListener("pointerleave", leave); canvas.removeEventListener("click", click);
      geo.dispose(); sgeo.dispose(); mat.dispose(); smat.dispose(); renderer.dispose(); uni.current = null;
    };
  }, [ok, stocks, owned]);

  // perdeler: kaydırmaya bağlı (scrub) zaman çizelgesi + kodların sonsuz salınım/dönme/öteleme hareketi
  useEffect(() => {
    if (!ok || !sec.current) return;
    const ctx = gsap.context(() => {
      const s1 = SplitText.create(".h3d-open .h3d-title", { type: "words", mask: "words" });
      const s2 = SplitText.create(".h3d-mid .h3d-title", { type: "words", mask: "words" });
      const s3 = SplitText.create(".h3d-endc .h3d-title", { type: "words", mask: "words" });
      const tl = gsap.timeline({ defaults: { ease: "none" }, scrollTrigger: { trigger: sec.current, start: "top top+=72", end: "bottom bottom", scrub: 0.9 } });
      tl.to(s1.words, { yPercent: -110, stagger: 0.02, duration: 0.12 }, 0.04)
        .to(".h3d-open .h3d-kicker, .h3d-open .h3d-sub, .h3d-open .h3d-hint", { opacity: 0, y: -24, duration: 0.1 }, 0.04)
        .from(s2.words, { yPercent: 110, stagger: 0.02, duration: 0.12 }, 0.2)
        .from(".h3d-mid .h3d-sub, .h3d-mid .h3d-kicker", { opacity: 0, y: 20, duration: 0.08 }, 0.22)
        .from(".tk", { opacity: 0, scale: 0.2, filter: "blur(10px)", stagger: { each: 0.012, from: "random" }, duration: 0.1, ease: "back.out(2)" }, 0.24)
        .to(s2.words, { yPercent: -110, stagger: 0.02, duration: 0.1 }, 0.66)
        .to(".h3d-mid .h3d-sub, .h3d-mid .h3d-kicker", { opacity: 0, duration: 0.06 }, 0.66)
        .from(s3.words, { yPercent: 110, stagger: 0.02, duration: 0.12 }, 0.74)
        .from(".h3d-endc .h3d-sub, .h3d-endc .h3d-kicker", { opacity: 0, y: 20, duration: 0.08 }, 0.76)
        .to(".h3d-tks", { opacity: 0, duration: 0.12, ease: "power1.in" }, 0.84)
        // sitenin kabuğu (kenar çubuğu, arama, şerit, başlık) da gece sahnesinde koyu başlar, şafakla kreme döner
        .fromTo(document.documentElement, NIGHT, { ...day(), duration: 0.16, ease: "power1.inOut" }, 0.84)
        .to(".h3d-stage", { "--dawn": 1,  duration: 0.16, ease: "power1.inOut" }, 0.84);
      gsap.utils.toArray<HTMLElement>(".tk-in").forEach(el => {
        const a = gsap.utils.random(12, 34), b = gsap.utils.random(8, 26);
        gsap.to(el, { x: `random(${-a}, ${a})`, y: `random(${-b}, ${b})`, duration: "random(1.6, 3)", ease: "sine.inOut", repeat: -1, repeatRefresh: true });
        gsap.fromTo(el, { rotation: gsap.utils.random(-14, -3) }, { rotation: gsap.utils.random(3, 14), duration: gsap.utils.random(1.3, 2.6), ease: "sine.inOut", repeat: -1, yoyo: true });
        gsap.to(el, { scale: gsap.utils.random(1.04, 1.12), duration: gsap.utils.random(0.9, 1.6), ease: "sine.inOut", repeat: -1, yoyo: true, delay: Math.random() });
      });
      // öteleme: her kod sahne içinde yavaşça uzun bir yol izler
      gsap.utils.toArray<HTMLElement>(".tk").forEach(el => {
        gsap.to(el, { xPercent: "random(-55, 55)", yPercent: "random(-90, 90)", duration: "random(5, 9)", ease: "sine.inOut", repeat: -1, repeatRefresh: true });
      });
    }, sec);
    return () => ctx.revert();
  }, [ok, acc]);

  useEffect(() => { if (uni.current) uni.current.uSel.value = selected ? stocks.findIndex(s => s.ticker === selected) : -1; }, [selected, stocks]);

  // sahneyi atla: hemen altındaki uygulamaya iner. Gün içinde ikinci açılışta sahne kendiliğinden atlanır (yukarı kaydırınca yine oynar).
  const past = () => { const el = sec.current; return el ? el.getBoundingClientRect().top + scrollY + el.offsetHeight - 72 : 0; };
  const skip = () => scrollToEl(past());
  const [again] = useState(() => {
    const today = new Date().toISOString().slice(0, 10);
    try { const seen = localStorage.getItem("sr-hero"); localStorage.setItem("sr-hero", today); return seen === today; } catch { return false; }
  });
  useEffect(() => {
    if (!ok || !again) return;
    const t = setTimeout(() => { ScrollTrigger.refresh(); if (scrollY < 40) scrollToEl(past(), true); }, 400);
    return () => clearTimeout(t);
  }, [ok, again]);

  if (!ok) return null;
  const max = Math.max(1, ...acc.map(a => a.up));
  return (
    <section ref={sec} className="h3d" aria-label="Piyasa küresi ve ivmesi yeniden artan hisseler">
      <div className="h3d-stage">
        <div className="h3d-dawn" aria-hidden />
        <canvas ref={cv} className="h3d-canvas" aria-hidden />
        <div className="h3d-tks">
          {acc.map((a, i) => (
            <button key={a.s.ticker} className="tk" style={{ left: spots[i]?.x + "%", top: spots[i]?.y + "%", color: INK[i % INK.length], fontSize: 18 + 26 * (a.up / max) }}
              onClick={() => pick.current(a.s.ticker)} aria-label={`${a.s.symbol}: ivme son iki haftada ${trNum(a.up, 1)} puan arttı. Hisseyi aç`}>
              <span className="tk-in"><b>{a.s.symbol}</b><small>ivme +{trNum(a.up, 1)}</small></span>
            </button>
          ))}
        </div>
        <div className="h3d-copy h3d-open">{children}</div>
        <div className="h3d-mid h3d-copy">{mid}</div>
        <div className="h3d-endc h3d-copy">{end}</div>
        <div ref={tip} className="h3d-tip" aria-hidden />
        <button className="h3d-skip" onClick={skip}>Sahneyi atla <span aria-hidden>↓</span></button>
      </div>
    </section>
  );
}
