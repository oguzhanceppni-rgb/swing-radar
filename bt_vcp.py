"""Nasdaq'ta VCP'yi kurulumdan çıkarmak isabeti artırıyor mu? (bt_signals.py ile aynı ölçü)"""
import sys
from pathlib import Path
import numpy as np
sys.path.insert(0, str(Path(__file__).parent))
from bt_signals import load, forward_excess, dedupe, stats, signals, H

L = []
for mkt in ("us", "bist"):
    data, bench = load(mkt); ex = forward_excess(data)
    sig = {t: signals(d, bench.close) for t, d in data.items()}
    variants = {"TT + (kırılım | geri çekilme | VCP) — şimdiki": lambda s: s.trend_template & (s.kirilim_55g | s.geri_cekilme | s.vcp),
                "TT + (kırılım | geri çekilme) — VCP'siz": lambda s: s.trend_template & (s.kirilim_55g | s.geri_cekilme),
                "TT + yalnız VCP": lambda s: s.trend_template & s.vcp & ~(s.kirilim_55g | s.geri_cekilme)}
    L += [f"## {mkt}", "", "| Kural | n | 20g | 40g | 60g | 40g isabet | 40g t |", "|---|---|---|---|---|---|---|"]
    for name, f in variants.items():
        r = {}
        for hz in H:
            rows = []
            for t, s in sig.items():
                fl = f(s).values.astype(bool); x = ex[hz][t].reindex(s.index).values
                rows += [(s.index[i], x[i]) for i in dedupe(fl) if not np.isnan(x[i])]
            r[hz] = stats(rows)
        g = lambda hz: "—" if not r[hz] else f"{r[hz]['ort']*100:+.1f}%"
        s40 = r[40]
        L.append(f"| {name} | {s40['n'] if s40 else '—'} | {g(20)} | {g(40)} | {g(60)} | {s40['isabet']*100:.0f}% | {s40['t']:.1f} |" if s40 else f"| {name} | az örnek |")
    L.append("")
(Path(__file__).parent / "bt_vcp.md").write_text("\n".join(L), encoding="utf-8")
print("bitti")
