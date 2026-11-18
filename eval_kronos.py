"""Kronos işe yarıyor mu? Walk-forward test: geçmişteki kesim tarihlerinde 20 günlük tahmin, gerçekleşen getiriyle kıyas.

Ölçütler (her kesim tarihinde hisseler arası):
  IC   = Spearman sıra korelasyonu (tahmin medyanı ↔ gerçekleşen 20g getiri). 0,03+ kullanılabilir, 0,05+ iyi sayılır.
  isabet = yön tutturma oranı (pUp20 > 0,5 ↔ gerçek > 0)
  ilk-üçte-bir − son-üçte-bir = tahmine göre sıralanınca en iyi 1/3 ile en kötü 1/3'ün gerçek getiri farkı
Kullanım: .venv/Scripts/python -I eval_kronos.py [hisse_sayısı=40] [kesim_sayısı=6]
"""
import sys
import numpy as np, pandas as pd
sys.path.insert(0, __import__("os").path.dirname(__import__("os").path.abspath(__file__)))
import scan

N = int(sys.argv[1]) if len(sys.argv) > 1 else 40
CUTS = int(sys.argv[2]) if len(sys.argv) > 2 else 6
H = 20

def evaluate(mkt):
    uni = (scan.universe_bist() if mkt == "bist" else scan.universe_us())[:N]
    data = scan.download([u["ticker"] for u in uni], mkt)
    rows = []
    for c in range(CUTS):
        end = -(H + 1 + c * 40)                                 # kesimler 40 gün arayla, en yenisi 21 gün önce
        cut = {t: d.iloc[:end + 1] if end + 1 else d for t, d in data.items() if len(d) > 420 + abs(end)}
        real = {t: float(data[t].close.iloc[end + H] / data[t].close.iloc[end] - 1) for t in cut}
        old = scan.HOLD; scan.HOLD = H
        k = scan.kronos_forecast(cut, list(cut), samples=4)
        scan.HOLD = old
        for t, v in k.items():
            rows.append({"cut": c, "t": t, "pred": v["med40"], "pUp": v["pUp20"], "real": real[t],
                         "mom": float(cut[t].close.iloc[-1] / cut[t].close.iloc[-64] - 1)})   # kıyas: 3 aylık momentum
    df = pd.DataFrame(rows)
    df.to_csv(f"eval_{mkt}.csv", index=False)
    sp = lambda a, b: a.rank().corr(b.rank())            # Spearman = sıraların Pearson korelasyonu
    ic = df.groupby("cut").apply(lambda g: sp(g.pred, g.real))
    icm = df.groupby("cut").apply(lambda g: sp(g.mom, g.real))
    spread = df.groupby("cut").apply(lambda g: g[g.pred >= g.pred.quantile(2 / 3)].real.mean() - g[g.pred <= g.pred.quantile(1 / 3)].real.mean())
    hit = ((df.pUp > 0.5) == (df.real > 0)).mean()
    print(f"\n[{mkt}] {df.t.nunique()} hisse × {CUTS} kesim = {len(df)} tahmin, ufuk {H} gün")
    print(f"  Kronos IC ort {ic.mean():+.3f} (kesimler: {np.round(ic.values, 2)})")
    print(f"  Momentum IC ort {icm.mean():+.3f}  ← kıyas")
    print(f"  Yön isabeti {hit:.1%}  (taban: gerçek yukarı oranı {(df.real > 0).mean():.1%})")
    print(f"  İlk 1/3 − son 1/3 getiri farkı ort {spread.mean():+.2%}")
    print(f"  Tahmin medyanı ort {df.pred.median():+.2%} vs gerçek medyan {df.real.median():+.2%}  ← yanlılık")
    return df

if __name__ == "__main__":
    for m in (sys.argv[3:] or ["us", "bist"]):
        evaluate(m)
