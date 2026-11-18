import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { Stock } from "./api";
import { chgDay } from "./api";
import { MKT, VCLASS, VTEXT, pct } from "./ui";
import { gsap, reduced } from "./motion";

const norm = (x: string) => x.toLocaleLowerCase("tr-TR");

// En üstteki hisse arama: sembol başı veya ad içinde eşleşme, ok tuşları + Enter, "/" ile odak.
export function Search({ stocks, owned, onPick }: { stocks: Stock[]; owned: Set<string>; onPick: (s: Stock) => void }) {
  const [q, setQ] = useState(""), [open, setOpen] = useState(false), [i, setI] = useState(0);
  const inp = useRef<HTMLInputElement>(null), list = useRef<HTMLUListElement>(null), id = useId();
  const hits = useMemo(() => {
    const k = norm(q.trim());
    if (!k) return [];
    const head = (s: Stock) => (norm(s.symbol).startsWith(k) ? 0 : 1);
    return stocks.filter(s => norm(s.symbol).startsWith(k) || norm(s.name ?? "").replace(/0307/g, "").includes(k))
      .sort((a, b) => head(a) - head(b) || b.score - a.score).slice(0, 8);
  }, [q, stocks]);
  const shown = open && q.trim().length > 0;

  useEffect(() => {
    const f = (e: KeyboardEvent) => {
      if (e.key === "/" && !(e.target as HTMLElement).closest("input,textarea")) { e.preventDefault(); inp.current?.focus(); }
    };
    addEventListener("keydown", f); return () => removeEventListener("keydown", f);
  }, []);
  useEffect(() => setI(0), [q]);
  // açılışta satırlar kademeli düşer (transitions.dev dropdown + stagger)
  useEffect(() => {
    if (!shown || reduced() || !list.current) return;
    const t = gsap.from(list.current.children, { y: -8, opacity: 0, duration: 0.32, stagger: 0.035, clearProps: "all" });
    return () => { t.kill(); };
  }, [shown, hits.length]);

  const pick = (s?: Stock) => { if (!s) return; onPick(s); setQ(""); setOpen(false); inp.current?.blur(); };
  return (
    <div className={"search" + (shown ? " is-open" : "")}>
      <svg viewBox="0 0 24 24" aria-hidden><circle cx="11" cy="11" r="6.5" /><path d="m16 16 4 4" /></svg>
      <input ref={inp} value={q} placeholder="Hisse ara: sembol veya şirket adı" aria-label="Hisse ara"
        role="combobox" aria-expanded={shown} aria-controls={id} aria-autocomplete="list"
        aria-activedescendant={shown && hits[i] ? id + hits[i].ticker : undefined}
        onChange={e => { setQ(e.target.value); setOpen(true); }} onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 120)}
        onKeyDown={e => {
          if (e.key === "ArrowDown") { e.preventDefault(); setI(x => Math.min(hits.length - 1, x + 1)); }
          else if (e.key === "ArrowUp") { e.preventDefault(); setI(x => Math.max(0, x - 1)); }
          else if (e.key === "Enter") pick(hits[i]);
          else if (e.key === "Escape") { setQ(""); inp.current?.blur(); }
        }} />
      {q ? <button className="search-x" aria-label="Aramayı temizle" onMouseDown={e => e.preventDefault()} onClick={() => { setQ(""); inp.current?.focus(); }}>×</button>
        : <kbd aria-hidden>/</kbd>}
      <ul ref={list} id={id} role="listbox" className="search-list" data-lenis-prevent hidden={!shown}>
        {hits.map((s, n) => (
          <li key={s.ticker} id={id + s.ticker} role="option" aria-selected={n === i} onMouseEnter={() => setI(n)} onMouseDown={e => { e.preventDefault(); pick(s); }}>
            <span className="sr-sym">{s.symbol}{owned.has(s.ticker) && <i>portföyde</i>}</span>
            <span className="sr-name">{s.name !== s.symbol ? s.name.replace(/0307/g, "") : ""} · {MKT[s.market]}</span>
            <span className={"num " + (chgDay(s) >= 0 ? "pos" : "neg")} title="Günlük değişim">{pct(chgDay(s), 1)}</span>
            <span className={"pill " + VCLASS[s.verdict]}>{VTEXT[s.verdict]} {s.score}</span>
          </li>
        ))}
        {!hits.length && <li className="sr-none">“{q.trim()}” bu taramada yok. XU100 ve Nasdaq-100 hisseleri aranır.</li>}
      </ul>
    </div>
  );
}

// Son taramanın günlük değişimlerinden kayan şerit; üzerine gelince durur, tıklayınca hisseyi açar.
export function Tape({ stocks, onPick }: { stocks: Stock[]; onPick: (s: Stock) => void }) {
  const chg = chgDay; // son fiyat varsa günlük değişim ondan
  const top = useMemo(() => [...stocks].sort((a, b) => Math.abs(chg(b)) - Math.abs(chg(a))).slice(0, 28), [stocks]);
  const row = (k: string) => top.map(s => (
    <button key={k + s.ticker} tabIndex={k === "a" ? 0 : -1} aria-hidden={k === "b" || undefined} onClick={() => onPick(s)}>
      <b>{s.symbol}</b><span className={"num " + (chg(s) >= 0 ? "pos" : "neg")}>{chg(s) >= 0 ? "▲" : "▼"} {pct(chg(s), 1)}</span>
    </button>
  ));
  return (
    <div className="tape" aria-label="Son taramada günün en çok hareket eden hisseleri">
      <div className="tape-track" style={{ animationDuration: top.length * 2.2 + "s" }}>{row("a")}{row("b")}</div>
    </div>
  );
}
