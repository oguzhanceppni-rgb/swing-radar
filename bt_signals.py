"""Swing Radar — teknik sinyal testi (1–3 ay elde tutma).

Soru: Derin analizdeki ve taramadaki teknik sinyaller, 20/40/60 işlem günü sonra hisseyi aynı piyasadaki
diğer hisselerden daha iyi getiriyor mu?

Yöntem
- Evren: bugünkü XU100 + Nasdaq-100 bileşenleri, 6 yıllık günlük veri (yfinance, düzeltilmiş).
  Not: bugünün bileşenleri kullanıldığı için hayatta kalma yanlılığı var (düşüp endeksten çıkanlar yok);
  sinyaller arası KARŞILAŞTIRMA için sorun değil, mutlak getiriler biraz iyimserdir.
- Getiri ölçüsü: hissenin ileri getirisi − aynı gün aynı piyasadaki tüm hisselerin ortalama ileri getirisi
  (kesitsel fazla getiri). Sinyal yoksa beklenen değer 0'dır; pozitif = seçim avantajı.
- Geleceğe bakma yok: pivotlar yalnızca onaylandıkları gün (k mum sonra) kullanılır; göstergeler o güne kadarki veriyle.
- Aynı hissede aynı sinyal 10 gün içinde tekrar sayılmaz. Anlamlılık için olaylar aylara gruplanır
  (aynı ayın sinyalleri birbirine bağımlı), t-değeri aylık ortalamalardan hesaplanır.
- Kararlılık: dönem ikiye bölünür (ilk yarı / ikinci yarı); işaret iki yarıda da aynı olmalı.
- Çıkış testi: Trend Template + kurulum sinyallerinde 2R/40 gün ile izleyen stop kurallarının karşılaştırması.

Kullanım:  .venv/Scripts/python -I bt_signals.py      → bt_signals.md + bt_signals.json
"""
import json, math, sys, time
from pathlib import Path
import numpy as np, pandas as pd, yfinance as yf

sys.path.insert(0, str(Path(__file__).parent))
import scan  # evren listeleri

H = [20, 40, 60]
OUT = Path(__file__).parent

# ---------------------------------------------------------------- veri
def load(mkt):
    uni = scan.universe_bist() if mkt == "bist" else scan.universe_us()
    tick = [u["ticker"] for u in uni]
    raw = yf.download(tick + [scan.BENCH[mkt]], period="6y", interval="1d", auto_adjust=True, group_by="ticker", progress=False, threads=True)
    data = {}
    for t in tick:
        try:
            d = raw[t].rename(columns=str.lower)[["open", "high", "low", "close", "volume"]].dropna(subset=["close"])
        except KeyError:
            continue
        if len(d) > 400:
            data[t] = d
    bench = raw[scan.BENCH[mkt]].rename(columns=str.lower).dropna(subset=["close"])
    return data, bench

# ---------------------------------------------------------------- göstergeler (tamamı yalnızca geçmişi kullanır)
def rsi(c, n=14):
    d = c.diff(); up = d.clip(lower=0).ewm(alpha=1 / n, adjust=False).mean(); dn = (-d.clip(upper=0)).ewm(alpha=1 / n, adjust=False).mean()
    return 100 - 100 / (1 + up / dn)

def vwma(c, v, n=20):
    return (c * v).rolling(n).sum() / v.rolling(n).sum()

def signals(d, bench_close):
    o, h, l, c, v = d.open, d.high, d.low, d.close, d.volume
    n = len(c); idx = c.index
    s = pd.DataFrame(index=idx)
    sma = lambda x, k: x.rolling(k).mean()
    s50, s150, s200 = sma(c, 50), sma(c, 150), sma(c, 200)
    hi252, lo252 = h.rolling(252).max(), l.rolling(252).min()
    tt = (c > s50) & (s50 > s150) & (s150 > s200) & (c > s150) & (s200 > s200.shift(21)) & (c >= 1.25 * lo252) & (c >= 0.75 * hi252)
    s["trend_template"] = tt
    hi55 = h.rolling(55).max().shift(); vol50 = v.rolling(50).mean()
    s["kirilim_55g"] = tt & (c > hi55) & (v > 1.5 * vol50)
    r = rsi(c); s20 = sma(c, 20)
    near = ((c - s20).abs() / c < 0.02) | ((c - s50).abs() / c < 0.02)
    s["geri_cekilme"] = tt & near & r.between(40, 55) & (r > r.shift())
    rng = lambda a, b: (h.shift(a).rolling(b - a).max() - l.shift(a).rolling(b - a).min()) / c
    s["vcp"] = tt & (rng(0, 10) < rng(10, 25)) & (rng(10, 25) < rng(25, 45)) & (rng(0, 10) < 0.10) & (c >= 0.9 * h.rolling(45).max())
    # göreli güç (63g %60 + 126g %40) → kesitsel sıralama dışarıda yapılır
    s["_perf"] = 0.6 * (c / c.shift(63) - 1) + 0.4 * (c / c.shift(126) - 1)

    # HAHO = VWMA20; günlük ve haftalık (haftalık, bitmiş haftalardan; o hafta bitene kadar bir önceki hafta değeri)
    hw = vwma(c, v)
    s["haho_g_ustu"] = c > hw
    wk = d.resample("W-FRI").agg({"open": "first", "high": "max", "low": "min", "close": "last", "volume": "sum"}).dropna()
    whw = vwma(wk.close, wk.volume); w_above = (wk.close > whw).shift(1)  # yalnızca kapanmış hafta
    s["haho_h_ustu"] = w_above.reindex(idx, method="ffill").fillna(False).astype(bool)
    s["haho_g_ve_h_ustu"] = s.haho_g_ustu & s.haho_h_ustu
    wr = rsi(wk.close).shift(1).reindex(idx, method="ffill")
    s["haftalik_rsi_75_ustu"] = wr > 75
    s["haho_g_alti"] = c < hw

    # Stokastik RSI (14,14,3,3): aşırı satımdan yukarı kesme / aşırı alımdan aşağı kesme
    lo, hi = r.rolling(14).min(), r.rolling(14).max()
    k = ((r - lo) / (hi - lo) * 100).rolling(3).mean(); dd = k.rolling(3).mean()
    s["stokrsi_asiri_satim_donusu"] = (k.shift() <= dd.shift()) & (k > dd) & (np.minimum(k, k.shift()) < 25)
    s["stokrsi_asiri_alim_donusu"] = (k.shift() >= dd.shift()) & (k < dd) & (np.maximum(k, k.shift()) > 75)

    # RSI uyumsuzluğu (pivot k=3, onay günü sinyal), trend çizgisi kırılımı (pivot k=4)
    hv, lv, cv, rv = h.values, l.values, c.values, r.values
    bull = np.zeros(n, bool); bear = np.zeros(n, bool); brk_up = np.zeros(n, bool); brk_dn = np.zeros(n, bool)
    def piv(a, k, top):
        p = {}
        for i in range(k, n - k):
            w = a[i - k:i + k + 1]
            if (a[i] >= w.max()) if top else (a[i] <= w.min()):
                p[i + k] = i
        return p
    pl3, ph3, pl4, ph4 = piv(lv, 3, False), piv(hv, 3, True), piv(lv, 4, False), piv(hv, 4, True)
    # (atr ve pivotlar pro() için aşağıda da kullanılır)
    lows, highs = [], []
    for t in range(n):
        if t in pl3:
            lows.append(pl3[t])
            if len(lows) >= 2:
                p1, p2 = lows[-2], lows[-1]
                if p2 - p1 <= 60 and lv[p2] < lv[p1] and rv[p2] > rv[p1] + 1: bull[t] = True
        if t in ph3:
            highs.append(ph3[t])
            if len(highs) >= 2:
                p1, p2 = highs[-2], highs[-1]
                if p2 - p1 <= 60 and hv[p2] > hv[p1] and rv[p2] < rv[p1] - 1: bear[t] = True
    s["rsi_pozitif_uyumsuzluk"] = bull; s["rsi_negatif_uyumsuzluk"] = bear
    H4, L4 = [], []
    for t in range(1, n):
        if t in ph4: H4.append(ph4[t])
        if t in pl4: L4.append(pl4[t])
        if len(H4) >= 2:
            p1, p2 = H4[-2], H4[-1]
            if hv[p2] < hv[p1] and t - p2 <= 150:
                sl = (hv[p2] - hv[p1]) / (p2 - p1); line = lambda i: hv[p2] + sl * (i - p2)
                if cv[t] > line(t) and cv[t - 1] <= line(t - 1): brk_up[t] = True
        if len(L4) >= 2:
            p1, p2 = L4[-2], L4[-1]
            if lv[p2] > lv[p1] and t - p2 <= 150:
                sl = (lv[p2] - lv[p1]) / (p2 - p1); line = lambda i: lv[p2] + sl * (i - p2)
                if cv[t] < line(t) and cv[t - 1] >= line(t - 1): brk_dn[t] = True
    s["trend_kirilimi_yukari"] = brk_up; s["trend_kirilimi_asagi"] = brk_dn

    # Arz-talep: güçlü mumdan (gövde > 1,5×ATR14) önceki sakin taban mumu; ihlal edilmemiş talep bölgesinin %0–3 üstü
    tr = pd.concat([h - l, (h - c.shift()).abs(), (l - c.shift()).abs()], axis=1).max(axis=1); atr = tr.rolling(14).mean().values
    ov = o.values; dem_near = np.zeros(n, bool); sup_near = np.zeros(n, bool); dem, sup = [], []
    for t in range(16, n):
        dem = [z for z in dem if cv[t] >= z[0]]; sup = [z for z in sup if cv[t] <= z[1]]
        ct = cv[t]
        if any(z[1] * 1.0 <= ct * 1.0 and ct <= z[1] * 1.03 or (z[0] <= ct <= z[1]) for z in dem): dem_near[t] = True
        if any(ct >= z[0] * 0.97 and ct <= z[1] for z in sup): sup_near[t] = True
        body = cv[t] - ov[t]; bb = abs(cv[t - 1] - ov[t - 1])
        if not np.isnan(atr[t]) and abs(body) > 1.5 * atr[t] and bb < 0.6 * atr[t]:
            (dem if body > 0 else sup).append((lv[t - 1], hv[t - 1]))
    s["talep_bolgesinde"] = dem_near; s["arz_bolgesine_dayandi"] = sup_near
    pro(s, d, r, atr, pl3, ph4)
    return s

# ---------------------------------------------------------------- "düzgün kullanım": bağlam + onay + hacim
def pro(s, d, r, atr, pl3, ph4):
    o, h, l, c, v = d.open.values, d.high.values, d.low.values, d.close.values, d.volume.values
    n = len(c); rv = r.values
    vol50 = d.volume.rolling(50).mean().values
    s200 = d.close.rolling(200).mean().values
    up_ctx = (d.close > d.close.rolling(200).mean()).values & s["haho_h_ustu"].values   # büyük trend yukarı
    # --- hacim
    up = np.where(d.close.diff() > 0, v, 0.0); dn = np.where(d.close.diff() < 0, v, 0.0)
    udr = pd.Series(up).rolling(50).sum().values / np.maximum(pd.Series(dn).rolling(50).sum().values, 1)
    s["hacim_birikim_ud50_1_3"] = udr > 1.3
    s["hacim_dagitim_ud50_0_7"] = udr < 0.7
    obv = np.cumsum(np.sign(np.nan_to_num(d.close.diff().values)) * v)
    obv_hi = pd.Series(obv).rolling(50).max().values; c_hi = d.close.rolling(50).max().values
    s["obv_zirvede_fiyat_altinda"] = (obv >= obv_hi) & (c < 0.97 * c_hi)          # OBV önden gidiyor
    s["hacim_kurumasi_trendde"] = up_ctx & (pd.Series(v).rolling(10).mean().values < 0.6 * vol50)
    # --- RSI pozitif uyumsuzluk PRO: yükselen büyük trendde (200g üstü + haftalık HAHO üstü), ikinci dipte hacim azalmış,
    #     ve onay: fiyat ikinci dip mumunun tepesinin üstünde kapanmış (onaydan sonraki 5 gün içinde)
    div_pro = np.zeros(n, bool); div_any_ctx = np.zeros(n, bool); lows = []; pend = None
    for t in range(n):
        if t in pl3:
            lows.append(pl3[t])
            if len(lows) >= 2:
                p1, p2 = lows[-2], lows[-1]
                if p2 - p1 <= 60 and l[p2] < l[p1] and rv[p2] > rv[p1] + 1:
                    if up_ctx[t]: div_any_ctx[t] = True
                    if up_ctx[t] and v[p2] < v[p1]: pend = (p2, t)
        if pend and t - pend[1] <= 5 and c[t] > h[pend[0]]:
            div_pro[t] = True; pend = None
        elif pend and t - pend[1] > 5: pend = None
    s["rsi_poz_uyum_buyuk_trendde"] = div_any_ctx
    s["rsi_poz_uyum_PRO_hacim_onay"] = div_pro
    # --- trend kırılımı PRO: büyük trend yukarıyken düzeltmenin düşen trend çizgisi hacimle (>1,5× ort) kırılır, mum tepeye yakın kapanır
    #     ve RETEST: kırılım sonrası 15 gün içinde çizgiye geri gelip üstünde kapanış
    brk = s["trend_kirilimi_yukari"].values
    rng_hi = (c - l) / np.maximum(h - l, 1e-9)
    s["trend_kirilimi_PRO_hacim"] = brk & up_ctx & (v > 1.5 * vol50) & (rng_hi > 0.66)
    retest = np.zeros(n, bool); H4 = []; lvl = None
    for t in range(1, n):
        if t in ph4: H4.append(ph4[t])
        if len(H4) >= 2:
            p1, p2 = H4[-2], H4[-1]
            if h[p2] < h[p1]:
                sl = (h[p2] - h[p1]) / (p2 - p1); line = lambda i: h[p2] + sl * (i - p2)
                if c[t] > line(t) and c[t - 1] <= line(t - 1) and up_ctx[t]: lvl = (t, line)
        if lvl and 2 <= t - lvl[0] <= 15:
            L = lvl[1](t)
            if l[t] <= L * 1.02 and c[t] > L and c[t] > o[t]: retest[t] = True; lvl = None
        elif lvl and t - lvl[0] > 15: lvl = None
    s["trend_kirilimi_PRO_retest"] = retest
    # --- talep PRO: hacimli (>1,5×) güçlü mumla oluşan, İLK kez test edilen (taze) talep bölgesi; büyük trend yukarı;
    #     dokunulan gün boğa tepki mumu (yeşil, bölge üstünde kapanış)
    dem = []  # [lo, hi, tested]
    t_pro = np.zeros(n, bool); s_pro = np.zeros(n, bool); sup = []
    for t in range(16, n):
        for z in dem:
            if not z[2] and l[t] <= z[1] and c[t] >= z[0]:
                z[2] = True
                if up_ctx[t] and c[t] > o[t] and c[t] > z[1]: t_pro[t] = True
        dem = [z for z in dem if c[t] >= z[0]]
        for z in sup:
            if not z[2] and h[t] >= z[0] and c[t] <= z[1]:
                z[2] = True
                if not up_ctx[t] and c[t] < o[t] and c[t] < z[0]: s_pro[t] = True
        sup = [z for z in sup if c[t] <= z[1]]
        body = c[t] - o[t]; bb = abs(c[t - 1] - o[t - 1])
        if not np.isnan(atr[t]) and abs(body) > 1.5 * atr[t] and bb < 0.6 * atr[t] and v[t] > 1.5 * vol50[t]:
            (dem if body > 0 else sup).append([l[t - 1], h[t - 1], False])
    s["talep_PRO_taze_hacimli_tepki"] = t_pro
    s["arz_PRO_taze_ret_dusus_trendinde"] = s_pro
    # birleşim: üç teknikten en az biri PRO + hacim birikimi
    s["PRO_herhangi_ve_birikim"] = (s["rsi_poz_uyum_PRO_hacim_onay"] | s["trend_kirilimi_PRO_hacim"] | s["trend_kirilimi_PRO_retest"] | s["talep_PRO_taze_hacimli_tepki"]) & s["hacim_birikim_ud50_1_3"]

# ---------------------------------------------------------------- olay istatistiği
def forward_excess(data):
    """Her gün için ileri getiri − aynı gün piyasa ortalaması (kesitsel)."""
    closes = pd.DataFrame({t: d.close for t, d in data.items()})
    out = {}
    for hz in H:
        fwd = closes.shift(-hz) / closes - 1
        out[hz] = fwd.sub(fwd.mean(axis=1), axis=0)
    return out

def dedupe(flags, gap=10):
    idx = np.flatnonzero(flags); keep = []; last = -10**9
    for i in idx:
        if i - last >= gap: keep.append(i); last = i
    return keep

def stats(rows):
    """rows: [(tarih, fazla getiri)] → n, ort, isabet, aylık t, ilk/ikinci yarı ort."""
    if len(rows) < 30: return None
    df = pd.DataFrame(rows, columns=["d", "x"]).dropna()
    if len(df) < 30: return None
    m = df.groupby(df.d.dt.to_period("M")).x.mean()
    t = m.mean() / (m.std(ddof=1) / math.sqrt(len(m))) if len(m) > 3 and m.std() > 0 else float("nan")
    df = df.sort_values("d"); half = df.d.iloc[len(df) // 2]
    a, b = df[df.d < half].x.mean(), df[df.d >= half].x.mean()
    return {"n": int(len(df)), "ort": float(df.x.mean()), "medyan": float(df.x.median()), "isabet": float((df.x > 0).mean()),
            "t": float(t), "ay": int(len(m)), "ilk_yari": float(a), "ikinci_yari": float(b)}

def run_market(mkt):
    t0 = time.time()
    data, bench = load(mkt)
    print(f"[{mkt}] {len(data)} hisse yüklendi ({time.time()-t0:.0f} sn)", flush=True)
    ex = forward_excess(data)
    sigs = {}
    for i, (t, d) in enumerate(data.items()):
        sigs[t] = signals(d, bench.close)
        if i % 20 == 0: print(f"  sinyaller {i}/{len(data)}", flush=True)
    # göreli güç: kesitsel yüzdelik ≥ 80
    perf = pd.DataFrame({t: s._perf for t, s in sigs.items()})
    rs = perf.rank(axis=1, pct=True) * 100
    for t, s in sigs.items():
        s["goreli_guc_80_ustu"] = (rs[t] >= 80).reindex(s.index).fillna(False)
        s["tt_ve_kurulum"] = s.trend_template & (s.kirilim_55g | s.geri_cekilme | s.vcp)
        s["tt_kurulum_ve_rs80"] = s.tt_ve_kurulum & s.goreli_guc_80_ustu
        # birleşimler: derin analiz sinyalleri trend içinde mi işe yarıyor?
        s["tt_ve_trend_kirilimi"] = s.trend_template.shift(1).fillna(False) & s.trend_kirilimi_yukari
        s["tt_ve_stokrsi_donusu"] = s.trend_template & s.stokrsi_asiri_satim_donusu
        s["tt_ve_talep_bolgesi"] = s.trend_template & s.talep_bolgesinde
        s["tt_ve_rsi_poz_uyumsuzluk"] = s.trend_template & s.rsi_pozitif_uyumsuzluk
    names = [c for c in next(iter(sigs.values())).columns if not c.startswith("_")]
    res = {}
    for name in names:
        res[name] = {}
        for hz in H:
            rows = []
            for t, s in sigs.items():
                f = s[name].values.astype(bool); x = ex[hz][t].reindex(s.index).values
                for i in dedupe(f):
                    if not np.isnan(x[i]): rows.append((s.index[i], x[i]))
            res[name][hz] = stats(rows)
    # çıkış kuralı karşılaştırması: tt_ve_kurulum sinyallerinde
    exits = exit_test(data, sigs)
    return {"n_hisse": len(data), "baslangic": str(min(d.index[0] for d in data.values()).date()),
            "bitis": str(max(d.index[-1] for d in data.values()).date()), "sinyal": res, "cikis": exits}

def exit_test(data, sigs):
    """Aynı girişler (Trend Template + kurulum), farklı çıkışlar. Getiri: işlem başına %, ve gün."""
    rules = {"2R hedef / 2×ATR stop / 40 gün": "fixed", "2×ATR stop, 3×ATR izleyen (chandelier), en çok 90 gün": "chand",
             "2×ATR stop, haftalık HAHO altı kapanışta çık, en çok 90 gün": "whaho", "Sadece 60 gün tut": "hold60"}
    out = {k: [] for k in rules}
    for t, d in data.items():
        s = sigs[t]; c, h, l, v = d.close.values, d.high.values, d.low.values, d.volume
        tr = pd.concat([d.high - d.low, (d.high - d.close.shift()).abs(), (d.low - d.close.shift()).abs()], axis=1).max(axis=1)
        atr = tr.rolling(20).mean().values
        wk = d.resample("W-FRI").agg({"close": "last", "volume": "sum"}).dropna()
        whw = (vwma(wk.close, wk.volume)).shift(1).reindex(d.index, method="ffill").values
        for i in dedupe(s.tt_ve_kurulum.values.astype(bool), 20):
            if np.isnan(atr[i]) or i + 91 >= len(c): continue
            e, a = c[i], atr[i]; stop0 = e - 2 * a
            for name, kind in rules.items():
                hi = e; stop = stop0; ret = None; days = 0
                for j in range(i + 1, min(i + (40 if kind == "fixed" else 60 if kind == "hold60" else 90) + 1, len(c))):
                    days = j - i
                    if kind != "hold60" and l[j] <= stop: ret = stop / e - 1; break
                    if kind == "fixed" and h[j] >= e + 4 * a: ret = 4 * a / e; break
                    if kind == "chand":
                        hi = max(hi, h[j]); stop = max(stop, hi - 3 * a)
                    if kind == "whaho" and d.index[j].weekday() == 4 and not np.isnan(whw[j]) and c[j] < whw[j] and j - i > 5:
                        ret = c[j] / e - 1; break
                if ret is None: ret = c[i + days] / e - 1
                out[name].append((ret, days))
    res = {}
    for k, v in out.items():
        if not v: continue
        r = np.array([x[0] for x in v]); dd = np.array([x[1] for x in v])
        res[k] = {"n": int(len(r)), "ort_getiri": float(r.mean()), "medyan": float(np.median(r)), "kazanan": float((r > 0).mean()),
                  "ort_gun": float(dd.mean()), "gunluk_verim": float(r.mean() / dd.mean() * 20)}
    return res

# ---------------------------------------------------------------- rapor
LABEL = {
    "trend_template": "Trend Template (Stage 2)", "kirilim_55g": "55 gün kırılım + hacim", "geri_cekilme": "Trend içi geri çekilme", "vcp": "VCP",
    "goreli_guc_80_ustu": "Göreli güç ≥ %80", "tt_ve_kurulum": "TT + kurulum (taramanın çekirdeği)", "tt_kurulum_ve_rs80": "TT + kurulum + göreli güç ≥ %80",
    "haho_g_ustu": "Günlük HAHO üstü", "haho_h_ustu": "Haftalık HAHO üstü", "haho_g_ve_h_ustu": "Günlük ve haftalık HAHO üstü", "haho_g_alti": "Günlük HAHO altı",
    "haftalik_rsi_75_ustu": "Haftalık RSI > 75", "stokrsi_asiri_satim_donusu": "Stok. RSI aşırı satım dönüşü (G)", "stokrsi_asiri_alim_donusu": "Stok. RSI aşırı alım dönüşü (G)",
    "rsi_pozitif_uyumsuzluk": "RSI pozitif uyumsuzluk (G)", "rsi_negatif_uyumsuzluk": "RSI negatif uyumsuzluk (G)",
    "trend_kirilimi_yukari": "Düşen trend kırılımı (G)", "trend_kirilimi_asagi": "Yükselen trend aşağı kırılımı (G)",
    "talep_bolgesinde": "Talep bölgesinde / %3 üstünde (G)", "arz_bolgesine_dayandi": "Arz bölgesine dayandı (G)",
    "hacim_birikim_ud50_1_3": "Hacim birikimi (50g yükselen/düşen gün hacmi > 1,3)", "hacim_dagitim_ud50_0_7": "Hacim dağıtımı (< 0,7)",
    "obv_zirvede_fiyat_altinda": "OBV zirvede, fiyat henüz değil", "hacim_kurumasi_trendde": "Trendde hacim kuruması (10g < %60)",
    "rsi_poz_uyum_buyuk_trendde": "RSI poz. uyumsuzluk, büyük trend yukarı", "rsi_poz_uyum_PRO_hacim_onay": "RSI poz. uyumsuzluk PRO (trend + hacim azalan dip + onay mumu)",
    "trend_kirilimi_PRO_hacim": "Trend kırılımı PRO (büyük trend + hacim > 1,5× + güçlü kapanış)", "trend_kirilimi_PRO_retest": "Trend kırılımı PRO retest",
    "talep_PRO_taze_hacimli_tepki": "Talep PRO (taze, hacimli bölge, ilk test, boğa tepki)", "arz_PRO_taze_ret_dusus_trendinde": "Arz PRO (taze, düşüş trendi, ret)",
    "PRO_herhangi_ve_birikim": "Herhangi PRO sinyal + hacim birikimi",
    "tt_ve_trend_kirilimi": "TT + trend kırılımı", "tt_ve_stokrsi_donusu": "TT + Stok. RSI dönüşü", "tt_ve_talep_bolgesi": "TT + talep bölgesi", "tt_ve_rsi_poz_uyumsuzluk": "TT + RSI pozitif uyumsuzluk",
}
def verdict(st):
    if not st: return "az örnek"
    stable = (st["ilk_yari"] > 0) == (st["ikinci_yari"] > 0) == (st["ort"] > 0)
    if abs(st["t"]) >= 2 and stable: return "GÜÇLÜ " + ("+" if st["ort"] > 0 else "−")
    if abs(st["t"]) >= 1.5 and stable: return "zayıf " + ("+" if st["ort"] > 0 else "−")
    return "kanıt yok"

def report(all_res):
    L = ["# Swing Radar — teknik sinyal testi", "",
         "Ölçü: sinyalden 20/40/60 işlem günü sonra hissenin, aynı piyasadaki tüm hisselerin ortalamasına göre fazla getirisi.",
         "t: aylara gruplanmış t-değeri (|t| ≥ 2 anlamlı). Karar: |t| ≥ 2 ve iki yarıda aynı işaret → GÜÇLÜ; |t| ≥ 1,5 → zayıf.", ""]
    for mkt, r in all_res.items():
        L += [f"## {'BIST 100' if mkt == 'bist' else 'Nasdaq-100'} — {r['n_hisse']} hisse, {r['baslangic']} → {r['bitis']}", "",
              "| Sinyal | n (40g) | 20g | 40g | 60g | 40g isabet | 40g t | 1. yarı / 2. yarı (40g) | Karar (40g) |", "|---|---|---|---|---|---|---|---|---|"]
        for k, v in r["sinyal"].items():
            st = {hz: v.get(hz) for hz in H}; s40 = st[40]
            f = lambda x: "—" if not x else f"{x['ort']*100:+.1f}%"
            L.append(f"| {LABEL.get(k, k)} | {s40['n'] if s40 else '—'} | {f(st[20])} | {f(st[40])} | {f(st[60])} | "
                     f"{'—' if not s40 else f'{s40['isabet']*100:.0f}%'} | {'—' if not s40 else f'{s40['t']:.1f}'} | "
                     f"{'—' if not s40 else f'{s40['ilk_yari']*100:+.1f}% / {s40['ikinci_yari']*100:+.1f}%'} | {verdict(s40)} |")
        L += ["", "**Çıkış kuralları** (aynı girişler: Trend Template + kurulum)", "", "| Kural | n | Ort. getiri | Medyan | Kazanan | Ort. gün | 20 günlük verim |", "|---|---|---|---|---|---|---|"]
        for k, v in r["cikis"].items():
            L.append(f"| {k} | {v['n']} | {v['ort_getiri']*100:+.1f}% | {v['medyan']*100:+.1f}% | {v['kazanan']*100:.0f}% | {v['ort_gun']:.0f} | {v['gunluk_verim']*100:+.2f}% |")
        L.append("")
    L += ["## Sınırlar", "- Bugünkü endeks bileşenleri kullanıldı (hayatta kalma yanlılığı); karşılaştırmalar için uygun, mutlak getiriler iyimser.",
          "- 4 saatlik sinyaller test edilmedi: ücretsiz kaynakta 1 saatlik veri yalnızca son 2 yıl, örnek yetersiz.",
          "- Komisyon ve kayma dahil değil. Geçmiş sonuç geleceği garanti etmez; yatırım tavsiyesi değildir."]
    (OUT / "bt_signals.md").write_text("\n".join(L), encoding="utf-8")

if __name__ == "__main__":
    allr = {}
    for m in ("bist", "us"):
        allr[m] = run_market(m)
        (OUT / "bt_signals.json").write_text(json.dumps(allr, ensure_ascii=False, indent=1), encoding="utf-8")
    report(allr)
    print("bitti: bt_signals.md")
