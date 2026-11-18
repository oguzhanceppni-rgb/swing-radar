"""Swing Radar — isabet oranını artırma testi (işlem bazlı).

Giriş: Trend Template + kurulum (kırılım / geri çekilme / VCP; Nasdaq'ta VCP yok) — taramanın çekirdeği.
Çıkış (hepsinde aynı): ilk stop 2×ATR20; haftalık kapanış haftalık HAHO (VWMA20) altındaysa çık (ilk 5 gün hariç); en çok 90 gün.
Maliyet: gidiş-dönüş BIST %0,2, Nasdaq %0,1. Aynı hissede 20 günde bir sinyal.

Ölçüler (her varyant için): işlem sayısı, isabet (net getiri > 0), ortalama / medyan net getiri, kâr faktörü,
piyasaya göre fazla getiri (aynı tutma süresinde eşit ağırlıklı evren ortalamasına göre) + aylık kümelenmiş t, iki yarı.

Fikirler:
 1 rejim     : endeks > 200g ort. ve 50g ort. yükseliyor (kesin filtre)
 2 bilanço   : son açıklanan bilançoda net kâr / EPS yıllık büyümesi pozitif ve hızlanıyor (BIST: İş Yatırım/KAP, açıklama gecikmesi
               varsayımı ç.sonu+75 g, yıl sonu +100 g; Nasdaq: Yahoo bilanço tarihleri, EPS sürprizi > 0 ve yıllık EPS artışı)
 3a teyit    : ertesi gün sinyal gününün tepesi aşılırsa gir (giriş = max(açılış, tepe))
 3b retest   : kırılımlarda kırılan seviyeye ilk geri dönüşte (≤12 gün) yeşil kapanışla gir; diğer kurulumlar aynen
 4 uzama     : fiyat 50g ortalamadan en çok %20 (ve %15) uzakta
 5 sektör    : hissenin sektörü (Yahoo) 63 günde evren medyanından güçlü
 6 kısmi kâr : +1R'de (2×ATR) yarısı satılır, kalanı aynı kuralla
 7 dolar rejimi (BIST): XU100/USDTRY > 200g ort.

Kullanım: .venv/Scripts/python -I bt_improve.py  → bt_improve.md, bt_improve.json  (veri önbelleği: .cache_improve/)
"""
import json, math, sys, time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import numpy as np, pandas as pd, requests, yfinance as yf

ROOT = Path(__file__).parent
sys.path.insert(0, str(ROOT))
from bt_signals import load, rsi, vwma

CACHE = ROOT / ".cache_improve"; CACHE.mkdir(exist_ok=True)
COST = {"bist": 0.002, "us": 0.001}
UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130 Safari/537.36"}


# ---------------------------------------------------------------- yardımcı veriler (önbellekli)
def cached(name, fn):
    p = CACHE / name
    if p.exists(): return json.loads(p.read_text(encoding="utf-8"))
    v = fn(); p.write_text(json.dumps(v), encoding="utf-8"); return v


def sectors(tickers):
    def one(t):
        try: return t, yf.Ticker(t).info.get("sector")
        except Exception: return t, None
    with ThreadPoolExecutor(8) as ex: return dict(ex.map(one, tickers))


def isy_quarters(code):
    """İş Yatırım mali tablo: yıl başından kümülatif net kâr (ana ortaklık), 2019-…"""
    url = "https://www.isyatirim.com.tr/_layouts/15/IsYatirim.Website/Common/Data.aspx/MaliTablo"
    periods = [(y, m) for y in range(2019, 2027) for m in (3, 6, 9, 12)]
    for grp in ("XI_29", "UFRS_K", "UFRS"):
        out = {}
        try:
            for i in range(0, len(periods), 4):
                ps = periods[i:i + 4]
                q = "&".join(f"year{k+1}={y}&period{k+1}={m}" for k, (y, m) in enumerate(ps))
                j = requests.get(f"{url}?companyCode={code}&exchange=TRY&financialGroup={grp}&{q}", headers=UA, timeout=20).json()
                if not j.get("ok") or not j.get("value"): continue
                rows = {r["itemCode"]: r for r in j["value"]}
                key = "3ZA" if grp != "XI_29" and "3ZA" in rows else ("3Z" if "3Z" in rows else "3L")
                r = rows.get(key)
                if not r: continue
                for k, (y, m) in enumerate(ps):
                    v = r.get(f"value{k+1}")
                    if v not in (None, ""): out[f"{y}-{m:02d}"] = float(v)
        except Exception:
            continue
        if len(out) >= 8: return out
    return {}


def us_earnings(t):
    try:
        e = yf.Ticker(t).get_earnings_dates(limit=40)
        if e is None or e.empty: return []
        e = e.dropna(subset=["Reported EPS"])
        return [[str(ix.date()), float(r["Reported EPS"]), None if pd.isna(r.get("EPS Estimate")) else float(r["EPS Estimate"])] for ix, r in e.iterrows()]
    except Exception:
        return []


def earnings_flag(mkt, t, idx):
    """Her gün için: son açıklanan bilanço 'iyi' mi (büyüme pozitif ve hızlanıyor / sürpriz pozitif)? Bilgi yoksa NaN."""
    flag = pd.Series(np.nan, index=idx)
    if mkt == "bist":
        q = cached(f"isy_{t.replace('.IS', '')}.json", lambda: isy_quarters(t.replace(".IS", "")))
        if not q: return flag
        keys = sorted(q); ev = []
        for k in keys:
            y, m = int(k[:4]), int(k[5:])
            prev = f"{y-1}-{m:02d}"
            if prev not in q or q[prev] == 0: continue
            g = (q[k] - q[prev]) / abs(q[prev])
            # bir önceki çeyreğin yıllık büyümesi (hızlanma kıyası)
            pm = m - 3 if m > 3 else 12; py = y if m > 3 else y - 1
            pk, ppk = f"{py}-{pm:02d}", f"{py-1}-{pm:02d}"
            gp = (q[pk] - q[ppk]) / abs(q[ppk]) if pk in q and ppk in q and q[ppk] != 0 else None
            good = q[k] > 0 and g > 0 and (gp is None or g > gp)
            avail = pd.Timestamp(y, m, 1) + pd.offsets.MonthEnd(0) + pd.Timedelta(days=100 if m == 12 else 75)
            ev.append((avail, good))
    else:
        e = cached(f"ern_{t}.json", lambda: us_earnings(t))
        if not e: return flag
        e = sorted(e); ev = []
        for i, (d, eps, est) in enumerate(e):
            yago = e[i - 4][1] if i >= 4 else None
            good = (est is None or eps > est) and (yago is None or eps > yago)
            ev.append((pd.Timestamp(d) + pd.Timedelta(days=1), good))
    for avail, good in sorted(ev):
        flag[flag.index >= avail] = float(good)
    return flag


# ---------------------------------------------------------------- işlem simülasyonu
def simulate(c, h, l, o, atr, wexit, i, entry, partial=False, maxd=90):
    """i: giriş günü indeksi (kapanışta / gün içi giriş fiyatı 'entry'). Döner: (brüt getiri, gün, çıkış indeksi)."""
    a = atr; stop = entry - 2 * a; half = False; banked = 0.0
    n = len(c)
    for j in range(i + 1, min(i + maxd + 1, n)):
        if l[j] <= stop:
            px = min(stop, o[j]) if o[j] < stop else stop
            r = px / entry - 1
            return (0.5 * banked + 0.5 * r if half else r), j - i, j
        if partial and not half and h[j] >= entry + 2 * a:
            half = True; banked = 2 * a / entry; stop = max(stop, entry)  # yarısı +1R, kalanı başabaş stop
        if wexit[j] and j - i > 5:
            r = c[j] / entry - 1
            return (0.5 * banked + 0.5 * r if half else r), j - i, j
    j = min(i + maxd, n - 1)
    if j <= i: return None
    if i + maxd >= n: return None  # tamamlanmamış işlem
    r = c[j] / entry - 1
    return (0.5 * banked + 0.5 * r if half else r), j - i, j


def weekly_exit(d):
    wk = d.index.to_period("W-FRI"); g = d.groupby(wk)
    wc, wv = g.close.last(), g.volume.sum()
    vw = (wc * wv).rolling(20).sum() / wv.rolling(20).sum()
    ser = pd.Series(wk); end = (ser != ser.shift(-1)).to_numpy(copy=True); end[-1] = d.index[-1].weekday() == 4
    return end & (d.close.values < vw.reindex(wk).values)


# ---------------------------------------------------------------- ana akış
def run(mkt):
    t0 = time.time()
    data, bench = load(mkt)
    tick = list(data)
    print(f"[{mkt}] {len(data)} hisse", flush=True)
    sec = cached(f"sector_{mkt}.json", lambda: sectors(tick))
    closes = pd.DataFrame({t: d.close for t, d in data.items()}).sort_index()
    mret = closes.pct_change().mean(axis=1).fillna(0); midx = (1 + mret).cumprod()  # eşit ağırlıklı evren
    r63 = closes / closes.shift(63) - 1
    med_all = r63.median(axis=1)
    sec_str = {}
    for s_name in set(v for v in sec.values() if v):
        cols = [t for t in tick if sec.get(t) == s_name]
        sec_str[s_name] = r63[cols].median(axis=1) - med_all
    bc = bench.close.reindex(closes.index).ffill()
    b200, b50 = bc.rolling(200).mean(), bc.rolling(50).mean()
    regime = (bc > b200) & (b50 > b50.shift(21))
    usd_ok = pd.Series(True, index=closes.index)
    if mkt == "bist":
        fx = yf.download("USDTRY=X", period="6y", interval="1d", auto_adjust=True, progress=False)["Close"].squeeze()
        fx = fx.reindex(closes.index).ffill()
        xu_usd = bc / fx; usd_ok = xu_usd > xu_usd.rolling(200).mean()

    # bilanço bayrakları (paralel indirme)
    print(f"[{mkt}] bilanço verisi…", flush=True)
    with ThreadPoolExecutor(6) as ex:
        eflags = dict(zip(tick, ex.map(lambda t: earnings_flag(mkt, t, data[t].index), tick)))
    cov = np.mean([eflags[t].notna().mean() for t in tick])
    print(f"[{mkt}] bilanço kapsamı %{cov*100:.0f} ({time.time()-t0:.0f} sn)", flush=True)

    V = ["0 Temel (şimdiki kural)", "1 Rejim filtresi", "2 Bilanço iyi", "3a Teyit (ertesi gün tepe aşımı)", "3b Kırılımda retest girişi",
         "4a Uzama ≤ %20", "4b Uzama ≤ %15", "5 Sektör güçlü", "6 Kısmi kâr (+1R'de yarısı)"]
    if mkt == "bist": V.append("7 Dolar bazlı rejim")
    V += ["K1 Rejim + uzama≤20 + sektör", "K2 K1 + bilanço", "K3 K1 + teyit", "K4 K2 + teyit", "K5 K1 + kısmi kâr"]
    trades = {v: [] for v in V}

    for t, d in data.items():
        c, h, l, o, vol = (d[k].values for k in ("close", "high", "low", "open", "volume"))
        cs = d.close; idx = d.index; n = len(c)
        s50, s150, s200 = cs.rolling(50).mean(), cs.rolling(150).mean(), cs.rolling(200).mean()
        hi252, lo252 = d.high.rolling(252).max(), d.low.rolling(252).min()
        tt = ((cs > s50) & (s50 > s150) & (s150 > s200) & (s200 > s200.shift(21)) & (cs >= 1.25 * lo252) & (cs >= 0.75 * hi252)).values
        hi55 = d.high.rolling(55).max().shift().values; v50 = d.volume.rolling(50).mean().values
        brk = tt & (c > hi55) & (vol > 1.5 * v50)
        r = rsi(cs); s20 = cs.rolling(20).mean()
        near = (((cs - s20).abs() / cs < 0.02) | ((cs - s50).abs() / cs < 0.02)).values
        pb = tt & near & r.between(40, 55).values & (r > r.shift()).values
        rng = lambda a, b: ((d.high.shift(a).rolling(b - a).max() - d.low.shift(a).rolling(b - a).min()) / cs).values
        vcp = tt & (rng(0, 10) < rng(10, 25)) & (rng(10, 25) < rng(25, 45)) & (rng(0, 10) < 0.10) & (c >= 0.9 * d.high.rolling(45).max().values)
        sig = brk | pb | (vcp if mkt == "bist" else False)
        tr = pd.concat([d.high - d.low, (d.high - cs.shift()).abs(), (d.low - cs.shift()).abs()], axis=1).max(axis=1)
        atr = tr.rolling(20).mean().values
        wexit = weekly_exit(d)
        ext = (c / s50.values - 1)
        reg = regime.reindex(idx).fillna(False).values; uok = usd_ok.reindex(idx).fillna(False).values
        sstr = sec_str.get(sec.get(t)); sok = (sstr.reindex(idx) > 0).values if sstr is not None else np.zeros(n, bool)
        ef = eflags[t].values; eok = ef == 1.0
        mi = midx.reindex(idx).ffill().values
        last = -99
        for i in np.flatnonzero(sig):
            if i - last < 20 or np.isnan(atr[i]) or i < 260: continue
            last = i

            def rec(v, ii, entry, partial=False):
                res = simulate(c, h, l, o, atr[i], wexit, ii, entry, partial)
                if res is None: return
                g, days, j = res
                net = g - COST[mkt]
                exc = net - (mi[j] / mi[ii] - 1)
                trades[v].append((str(idx[i].date()), net, exc, days))

            base = (i, c[i])
            # 3a teyit
            conf = (i + 1, max(o[i + 1], h[i])) if i + 1 < n and h[i + 1] > h[i] else None
            # 3b retest (yalnız kırılım)
            rt = base
            if brk[i]:
                rt = None; lvl = hi55[i]
                for j in range(i + 2, min(i + 13, n)):
                    if c[j] < lvl * 0.97: break
                    if l[j] <= lvl * 1.02 and c[j] > lvl and c[j] > o[j]: rt = (j, c[j]); break
            f_reg, f_ext20, f_ext15, f_sec, f_ern = reg[i], ext[i] <= 0.20, ext[i] <= 0.15, sok[i], eok[i]
            k1 = f_reg and f_ext20 and f_sec
            rec(V[0], *base)
            if f_reg: rec("1 Rejim filtresi", *base)
            if f_ern: rec("2 Bilanço iyi", *base)
            if conf: rec("3a Teyit (ertesi gün tepe aşımı)", *conf)
            if rt: rec("3b Kırılımda retest girişi", *rt)
            if f_ext20: rec("4a Uzama ≤ %20", *base)
            if f_ext15: rec("4b Uzama ≤ %15", *base)
            if f_sec: rec("5 Sektör güçlü", *base)
            rec("6 Kısmi kâr (+1R'de yarısı)", *base, partial=True)
            if mkt == "bist" and uok[i]: rec("7 Dolar bazlı rejim", *base)
            if k1: rec("K1 Rejim + uzama≤20 + sektör", *base)
            if k1 and f_ern: rec("K2 K1 + bilanço", *base)
            if k1 and conf: rec("K3 K1 + teyit", *conf)
            if k1 and f_ern and conf: rec("K4 K2 + teyit", *conf)
            if k1: rec("K5 K1 + kısmi kâr", *base, partial=True)

    out = {}
    for v, tr_ in trades.items():
        if len(tr_) < 15: out[v] = {"n": len(tr_)}; continue
        df = pd.DataFrame(tr_, columns=["d", "net", "exc", "days"]); df["d"] = pd.to_datetime(df.d)
        m = df.groupby(df.d.dt.to_period("M")).exc.mean()
        tval = m.mean() / (m.std(ddof=1) / math.sqrt(len(m))) if len(m) > 3 and m.std() > 0 else float("nan")
        df = df.sort_values("d"); half = df.d.iloc[len(df) // 2]
        pos, neg = df.net[df.net > 0].sum(), -df.net[df.net < 0].sum()
        out[v] = {"n": len(df), "isabet": float((df.net > 0).mean()), "ort": float(df.net.mean()), "medyan": float(df.net.median()),
                  "kf": float(pos / neg) if neg > 0 else float("inf"), "gun": float(df.days.mean()),
                  "fazla": float(df.exc.mean()), "t": float(tval),
                  "y1": float(df[df.d < half].exc.mean()), "y2": float(df[df.d >= half].exc.mean())}
    return {"n_hisse": len(data), "bilanco_kapsami": cov, "sonuc": out}


def report(R):
    L = ["# İsabet oranını artırma testi", "",
         "Aynı giriş (Trend Template + kurulum) ve aynı çıkış (2×ATR stop, haftalık HAHO altı kapanış, en çok 90 gün); komisyon dahil.",
         "İsabet = net kârla kapanan işlem oranı. Fazla = aynı sürede eşit ağırlıklı evrene göre fazla getiri. KF = kâr faktörü (toplam kâr / toplam zarar).",
         "Bir fikir ancak isabeti VE ortalama/fazla getiriyi birlikte artırıyorsa işe yarar sayılır.", ""]
    for mkt, r in R.items():
        b = r["sonuc"]["0 Temel (şimdiki kural)"]
        L += [f"## {'BIST 100' if mkt == 'bist' else 'Nasdaq-100'} — {r['n_hisse']} hisse, bilanço kapsamı %{r['bilanco_kapsami']*100:.0f}", "",
              "| Varyant | İşlem | İsabet | Ort. net | Medyan | KF | Ort. gün | Fazla getiri | t | 1./2. yarı (fazla) | Karar |",
              "|---|---|---|---|---|---|---|---|---|---|---|"]
        for v, s in r["sonuc"].items():
            if "isabet" not in s: L.append(f"| {v} | {s['n']} | az örnek |||||||||"); continue
            better = s["isabet"] > b["isabet"] + 0.01 and s["ort"] >= b["ort"] and s["n"] >= 40
            karar = "—" if v.startswith("0") else ("**İYİLEŞTİRİYOR**" if better and s["y1"] > 0 and s["y2"] > 0 else "iyileştiriyor (kararsız)" if better else "hayır")
            L.append(f"| {v} | {s['n']} | %{s['isabet']*100:.0f} | {s['ort']*100:+.1f}% | {s['medyan']*100:+.1f}% | {s['kf']:.2f} | {s['gun']:.0f} | "
                     f"{s['fazla']*100:+.1f}% | {s['t']:.1f} | {s['y1']*100:+.1f}% / {s['y2']*100:+.1f}% | {karar} |")
        L.append("")
    L += ["Sınırlar: bugünkü endeks bileşenleri (hayatta kalma yanlılığı), BIST bilanço açıklama tarihleri yaklaşık (çeyrek sonu +75 gün, yıl sonu +100 gün),",
          "Nasdaq bilanço geçmişi Yahoo'nun verdiği kadar. Geçmiş sonuç geleceği garanti etmez; yatırım tavsiyesi değildir."]
    (ROOT / "bt_improve.md").write_text("\n".join(L), encoding="utf-8")


if __name__ == "__main__":
    R = {}
    for m in ("bist", "us"):
        R[m] = run(m)
        (ROOT / "bt_improve.json").write_text(json.dumps(R, ensure_ascii=False, indent=1), encoding="utf-8")
    report(R)
    print("bitti")
