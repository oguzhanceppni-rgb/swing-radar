"""Arz-talep bölgesi testi: bölge kaç kez test edildikten sonra işe yarıyor?

Kullanıcı kuralı: bölge birden çok kez test edilip tuttuysa orada sürekli alıcı/satıcı var → daha güçlü.
Bölge tanımı swing-deep ile aynı: gövdesi > 1,5×ATR14 olan güçlü mumdan önceki sakin (gövde < 0,6×ATR) taban mumu;
uzak kenarın ötesinde kapanış olunca bölge ölür. "Test" = fiyatın bölgeye yeni girişi (önceki gün dışarıdaydı).

Olay: fiyatın bölgeye k'ıncı kez girdiği gün (giriş günü kapanışında bölge hâlâ geçerli). Ölçü bt_signals.py ile aynı:
20/40/60 gün ileri getiri − aynı gün piyasa ortalaması, 10 gün tekrar engeli, aylık kümelenmiş t, iki yarı kararlılığı.
Ek olarak swing-deep'in canlı kuralı: talep bölgesinde ya da %3 üstünde VE bölge ≥2 kez test edilmiş (durum sinyali).

Kullanım:  .venv/Scripts/python -I bt_sd.py   → bt_sd.md
"""
import sys
from pathlib import Path
import numpy as np, pandas as pd

sys.path.insert(0, str(Path(__file__).parent))
from bt_signals import load, forward_excess, dedupe, stats, verdict, H, OUT


def sd_signals(d):
    o, h, l, c = (d[k].values for k in ("open", "high", "low", "close")); n = len(c)
    tr = np.maximum.reduce([h - l, np.abs(h - np.r_[np.nan, c[:-1]]), np.abs(l - np.r_[np.nan, c[:-1]])])
    atr = pd.Series(tr).rolling(14).mean().values
    cs = pd.Series(c); s50, s150, s200 = (cs.rolling(k).mean().values for k in (50, 150, 200))
    tt = (c > s50) & (s50 > s150) & (s150 > s200) & (s200 > np.r_[[np.nan] * 21, s200[:-21]])
    names = ["talep_0", "talep_1", "talep_2plus", "talep_3plus", "arz_0", "arz_1", "arz_2plus", "arz_3plus",
             "talep_canli_2plus", "talep_canli_0_1", "tt_talep_2plus", "tt_talep_0_1",
             "onay_0", "onay_1", "onay_2plus", "onay_guclu_2plus", "tt_onay_2plus", "tt_onay_0_1"]
    s = {k: np.zeros(n, bool) for k in names}
    dem, sup = [], []  # [lo, hi, tests, inside_prev, son_giris_gunu]
    for t in range(16, n):
        dem = [z for z in dem if c[t] >= z[0]]; sup = [z for z in sup if c[t] <= z[1]]
        for z in dem:
            inside = l[t] <= z[1]
            if inside and not z[3]:
                k = z[2]; s["talep_0" if k == 0 else "talep_1" if k == 1 else "talep_2plus"][t] = True
                if k >= 3: s["talep_3plus"][t] = True
                if k >= 2 and tt[t]: s["tt_talep_2plus"][t] = True
                if k <= 1 and tt[t]: s["tt_talep_0_1"][t] = True
                z[2] += 1; z[4] = t
            z[3] = inside
            # onaylı tepki: girişten sonraki en çok 3 gün içinde yeşil mum, bölgenin üstünde ve önceki günün tepesinin üstünde kapanış
            if z[4] >= 0 and 0 <= t - z[4] <= 3 and c[t] > o[t] and c[t] > z[1] and c[t] > h[t - 1]:
                k = z[2] - 1; z[4] = -1  # bu girişten önceki test sayısı; giriş başına tek onay
                s["onay_0" if k == 0 else "onay_1" if k == 1 else "onay_2plus"][t] = True
                if k >= 2 and (c[t] - o[t]) > atr[t]: s["onay_guclu_2plus"][t] = True
                if k >= 2 and tt[t]: s["tt_onay_2plus"][t] = True
                if k <= 1 and tt[t]: s["tt_onay_0_1"][t] = True
            elif z[4] >= 0 and t - z[4] > 3: z[4] = -1
        for z in sup:
            inside = h[t] >= z[0]
            if inside and not z[3]:
                k = z[2]; s["arz_0" if k == 0 else "arz_1" if k == 1 else "arz_2plus"][t] = True
                if k >= 3: s["arz_3plus"][t] = True
                z[2] += 1
            z[3] = inside
        # canlı kural (swing-deep): bölgede ya da %3 üstünde
        near = [z for z in dem if z[0] <= c[t] <= z[1] * 1.03]
        if near:
            if max(z[2] for z in near) >= 2: s["talep_canli_2plus"][t] = True
            else: s["talep_canli_0_1"][t] = True
        body = c[t] - o[t]; bb = abs(c[t - 1] - o[t - 1])
        if not np.isnan(atr[t]) and abs(body) > 1.5 * atr[t] and bb < 0.6 * atr[t]:
            (dem if body > 0 else sup).append([l[t - 1], h[t - 1], 0, True, -1])  # oluştuğu gün "içeride" sayılmaz → ilk giriş = 1. test
    return s, names


LABEL = {"talep_0": "Talep: ilk test", "talep_1": "Talep: 2. test (1 kez test edilmiş)", "talep_2plus": "Talep: 3.+ test (≥2 kez test edilmiş)",
         "talep_3plus": "Talep: 4.+ test (≥3 kez test edilmiş)", "arz_0": "Arz: ilk test", "arz_1": "Arz: 2. test", "arz_2plus": "Arz: 3.+ test (≥2 kez)",
         "arz_3plus": "Arz: 4.+ test (≥3 kez)", "talep_canli_2plus": "Canlı kural: talep bölgesinde/%3 üstü, ≥2 test (+1 alan)",
         "talep_canli_0_1": "Canlı kural: talep bölgesinde/%3 üstü, 0–1 test (puansız)",
         "tt_talep_2plus": "Trend Template + talep 3.+ test", "tt_talep_0_1": "Trend Template + talep ilk/2. test",
         "onay_0": "ONAYLI tepki: ilk test", "onay_1": "ONAYLI tepki: 2. test", "onay_2plus": "ONAYLI tepki: 3.+ test (≥2 kez test edilmiş)",
         "onay_guclu_2plus": "ONAYLI güçlü tepki (gövde > ATR): 3.+ test", "tt_onay_2plus": "Trend Template + onaylı tepki, 3.+ test",
         "tt_onay_0_1": "Trend Template + onaylı tepki, ilk/2. test"}


def run(mkt):
    data, _ = load(mkt); ex = forward_excess(data)
    sig = {t: sd_signals(d) for t, d in data.items()}; names = next(iter(sig.values()))[1]
    res = {}
    for nm in names:
        res[nm] = {}
        for hz in H:
            rows = []
            for t, (s, _) in sig.items():
                x = ex[hz][t].values; idx = data[t].index
                for i in dedupe(s[nm]):
                    if not np.isnan(x[i]): rows.append((idx[i], x[i]))
            res[nm][hz] = stats(rows)
    print(mkt, len(data), "hisse", flush=True)
    return len(data), res


if __name__ == "__main__":
    L = ["# Arz-talep: test sayısı testi", "", "Ölçü: 20/40/60 gün sonra piyasa ortalamasına göre fazla getiri. Arz satırlarında NEGATİF = kural doğru (arz düşüş getirir).",
         "Karar: |t| ≥ 2 ve iki yarıda aynı işaret → GÜÇLÜ; |t| ≥ 1,5 → zayıf.", ""]
    for m in ("bist", "us"):
        nh, res = run(m)
        L += [f"## {'BIST 100' if m == 'bist' else 'Nasdaq-100'} ({nh} hisse, 6 yıl)", "",
              "| Sinyal | n (40g) | 20g | 40g | 60g | 40g isabet | 40g t | 1./2. yarı (40g) | Karar |", "|---|---|---|---|---|---|---|---|---|"]
        f = lambda x: "—" if not x else f"{x['ort']*100:+.1f}%"
        for k, v in res.items():
            s = v[40]
            L.append(f"| {LABEL[k]} | {s['n'] if s else '—'} | {f(v[20])} | {f(v[40])} | {f(v[60])} | "
                     f"{'—' if not s else f'{s['isabet']*100:.0f}%'} | {'—' if not s else f'{s['t']:.1f}'} | "
                     f"{'—' if not s else f'{s['ilk_yari']*100:+.1f}% / {s['ikinci_yari']*100:+.1f}%'} | {verdict(s)} |")
        L.append("")
    L += ["Sınırlar: bugünkü endeks bileşenleri (hayatta kalma yanlılığı), komisyon yok. Yatırım tavsiyesi değildir."]
    (OUT / "bt_sd.md").write_text("\n".join(L), encoding="utf-8")
    print("bitti")
