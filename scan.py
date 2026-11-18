"""Swing Radar — XU100 + Nasdaq-100 swing taraması (1–2 ay vade).

Akış (day-trader-skill'in scanner→entry→exit→timemachine zincirinin günlük mum uyarlaması):
  1. evren   : KAP'tan XU100, Nasdaq API'den NDX100 bileşenleri
  2. veri    : yfinance günlük OHLCV (3 yıl)
  3. kurulum : Trend Template (Stage 2), 55g kırılım, SMA20/50 geri çekilme, VCP-lite
  4. plan    : giriş = son kapanış, ilk stop = 2×ATR (min swing low); çıkış = haftalık kapanış haftalık HAHO (VWMA20) altında,
               en çok 90 işlem günü (bt_signals.py testi: 2R/40 güne göre birim zamanda daha verimli)
  5. zaman makinesi: aynı kuralın bu hissedeki geçmiş sonuçları + 10.000 yollu Monte Carlo
  6. Kronos  : 40 günlük olasılıksal tahmin (yol dağılımı)
  7. puan    : 0–8, ALINIR / KARARSIZ / ALINMAZ → Supabase swing_scans tablosu

Kullanım:  .venv/Scripts/python scan.py [--market bist|us|all] [--no-kronos] [--no-upload]
Yatırım tavsiyesi değildir; çıktı bir tarama ve istatistik özetidir.
"""
import argparse, json, os, re, sys, time, urllib.request, urllib.parse
from datetime import datetime, timedelta, timezone
import numpy as np
import pandas as pd
import warnings; warnings.filterwarnings("ignore")
import yfinance as yf

HERE = os.path.dirname(os.path.abspath(__file__))
UA = {"User-Agent": "Mozilla/5.0"}

HOLD = 90          # en uzun elde tutma (işlem günü) ≈ 4 ay; normal çıkış haftalık HAHO kuralıyla
ATR_K = 2.0        # ilk stop = giriş − 2×ATR20
R_MULT = 2.0       # yalnızca referans (işlem günlüğü); çıkış kuralı değildir
MIN_DAYS = 5       # girişten sonraki ilk hafta HAHO çıkışı uygulanmaz
MC_PATHS = 10_000
MAX_SCORE = 9      # trend 2 + RS 2 + kurulum 2 + geçmiş 1 + bilanço 1 (BIST) + Monte Carlo 1
BENCH = {"bist": "XU100.IS", "us": "^NDX"}
MIN_TURNOVER = {"bist": 50e6, "us": 20e6}   # 20g ort. işlem hacmi (TL / $)


# ---------------------------------------------------------------- 1. evren
def get(url):
    return urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=30).read().decode("utf-8", "replace")

def universe_bist():
    h = get("https://www.kap.org.tr/tr/Endeksler")
    end = h.find('\\"name\\":\\"BIST 100\\"')
    seg = h[h.rfind('{\\"code\\"', 0, end):end]
    codes = re.findall(r'stockCode\\":\\"([A-Z0-9]+)\\",\\"title\\":\\"([^\\]+)', seg)
    return [{"ticker": c + ".IS", "symbol": c, "name": t.title(), "sector": None} for c, t in codes]

def universe_us():
    rows = json.loads(get("https://api.nasdaq.com/api/quote/list-type/nasdaq100"))["data"]["data"]["rows"]
    return [{"ticker": r["symbol"].replace(".", "-"), "symbol": r["symbol"], "name": r["companyName"], "sector": r.get("sector")} for r in rows]


# ---------------------------------------------------------------- 2. veri
CLOSE_UTC = {"bist": 15.25, "us": 21.0}   # seans kapanışı (UTC saat; BIST 18:10 TSİ, Nasdaq 16:00 ET kış)

def download(tickers, mkt):
    """Seans kapanmadıysa bugünün yarım mumu atılır — kurallar yalnızca kapanmış günlük mumlarla çalışır."""
    raw = yf.download(tickers, period="3y", interval="1d", auto_adjust=True, group_by="ticker", progress=False, threads=True)
    # Yahoo bazen BIST hisselerinde son günlerin günlük mumunu boş gönderiyor (endeks dolu gelirken).
    # Boş kalan son 40 gün 1 saatlik mumlardan yeniden kurulur; aksi halde fiyatlar bir gün eski kalır.
    holes = {}
    for t in tickers:
        try:
            c = raw[t]["Close"].iloc[-40:]
        except KeyError:
            continue
        miss = c[c.isna()].index
        if len(miss):
            holes[t] = set(miss.date)
    hourly = {}
    if holes:
        hr = yf.download(list(holes), period="3mo", interval="60m", auto_adjust=True, group_by="ticker", progress=False, threads=True)
        for t, days in holes.items():
            try:
                h = (hr[t] if t in hr.columns.get_level_values(0) else hr).dropna(subset=["Close"])
            except KeyError:
                continue
            h = h.rename(columns=str.lower)
            g = h.groupby(h.index.date).agg(open=("open", "first"), high=("high", "max"), low=("low", "min"), close=("close", "last"), volume=("volume", "sum"))
            hourly[t] = g[g.index.isin(days)]
    out = {}
    for t in tickers:
        try:
            d = raw[t].rename(columns=str.lower)[["open", "high", "low", "close", "volume"]]
        except KeyError:
            continue
        if t in hourly:
            for day, row in hourly[t].iterrows():
                m = d.index.date == day
                if m.any():
                    d.loc[m, ["open", "high", "low", "close", "volume"]] = row[["open", "high", "low", "close", "volume"]].values
        d = d.dropna(subset=["close"])
        now = datetime.now(timezone.utc)
        if len(d) and d.index[-1].date() == now.date() and now.hour + now.minute / 60 < CLOSE_UTC[mkt]:
            d = d.iloc[:-1]
        if len(d) >= 260:
            out[t] = d
    return out


# ---------------------------------------------------------------- 3. göstergeler + kurulumlar
def rsi(c, n=14):
    d = c.diff()
    up, dn = d.clip(lower=0).ewm(alpha=1 / n).mean(), (-d.clip(upper=0)).ewm(alpha=1 / n).mean()
    return 100 - 100 / (1 + up / dn)

def indicators(d):
    c, h, l = d.close, d.high, d.low
    x = pd.DataFrame(index=d.index)
    for n in (20, 50, 150, 200):
        x[f"sma{n}"] = c.rolling(n).mean()
    tr = pd.concat([h - l, (h - c.shift()).abs(), (l - c.shift()).abs()], axis=1).max(axis=1)
    x["atr"] = tr.rolling(20).mean()
    x["rsi"] = rsi(c)
    x["hi55"] = h.rolling(55).max().shift()          # önceki 55 günün tepesi (bugün hariç)
    x["hi252"], x["lo252"] = h.rolling(252).max(), l.rolling(252).min()
    x["vol50"] = d.volume.rolling(50).mean()
    x["swlo20"] = l.rolling(20).min()
    # Trend Template (Minervini Stage 2), 7 kural
    x["tt"] = ((c > x.sma50) & (x.sma50 > x.sma150) & (x.sma150 > x.sma200) & (c > x.sma150)
               & (x.sma200 > x.sma200.shift(21)) & (c >= 1.25 * x.lo252) & (c >= 0.75 * x.hi252))
    # kurulumlar (her biri bool seri → geçmişte de aynı kural test edilebilsin)
    x["breakout"] = x.tt & (c > x.hi55) & (d.volume > 1.5 * x.vol50)
    near = ((c - x.sma20).abs() / c < 0.02) | ((c - x.sma50).abs() / c < 0.02)
    x["pullback"] = x.tt & near & (x.rsi.between(40, 55)) & (x.rsi > x.rsi.shift())
    rng = lambda a, b: (h.shift(a).rolling(b - a).max() - l.shift(a).rolling(b - a).min()) / c
    x["vcp"] = x.tt & (rng(0, 10) < rng(10, 25)) & (rng(10, 25) < rng(25, 45)) & (rng(0, 10) < 0.10) & (c >= 0.9 * h.rolling(45).max())
    return x

SETUPS = {"breakout": "55g kırılım + hacim", "pullback": "Trend içi geri çekilme", "vcp": "Volatilite daralması (VCP)"}


# ---------------------------------------------------------------- rotasyon (RRG benzeri): x = RS-oran, y = RS-momentum, 100 = endeksle aynı
def rrg(d, bench, N=50, M=10):
    """Son 6 haftanın izi (5 günde bir). Bulut fonksiyonundaki rrg() ile aynı hesap."""
    ratio = (d.close / bench.close.reindex(d.index).ffill())
    rsr = 100 * ratio / ratio.rolling(N).mean()
    rsm = 100 * rsr / rsr.shift(M)
    idx = [len(ratio) - 1 - 5 * w for w in range(5, -1, -1)]
    if idx[0] - M - N < 0: return None
    pts = [[round(float(rsr.iloc[i]), 2), round(float(rsm.iloc[i]), 2)] for i in idx]
    return pts if all(np.isfinite(v) for p in pts for v in p) else None


# ---------------------------------------------------------------- 4–5. plan + zaman makinesi
def weekly_haho(d):
    """Haftalık HAHO (haftalık VWMA20) ve her gün için 'hafta kapanışı HAHO altında' bayrağı (yalnızca kapanmış haftalar)."""
    wk = d.index.to_period("W-FRI")
    g = d.groupby(wk)
    wc, wvol = g.close.last(), g.volume.sum()
    vw = (wc * wvol).rolling(20).sum() / wvol.rolling(20).sum()
    ser = pd.Series(wk)
    week_end = (ser != ser.shift(-1)).to_numpy(copy=True)
    week_end[-1] = d.index[-1].weekday() == 4          # son hafta bitmediyse kapanış sayılmaz
    exit_flag = week_end & (d.close.values < vw.reindex(wk).values)
    return exit_flag, wc, wvol, vw

def plan(close, atr, swlo, haho=None):
    stop = max(close - ATR_K * atr, swlo * 0.995) if swlo < close else close - ATR_K * atr
    stop = min(stop, close - 1.0 * atr)              # stop en az 1 ATR uzakta olsun
    risk = close - stop
    return {"entry": close, "stop": stop, "target": close + R_MULT * risk, "riskPct": risk / close * 100,
            "exitRule": "weeklyHaho", "haho": None if haho is None or np.isnan(haho) else float(haho), "maxDays": HOLD}

def walk(l, c, wexit, i, stop, n=HOLD):
    """i. günün kapanışında gir; ilk stop gün içinde, haftalık HAHO çıkışı hafta kapanışında. Aynı gün ikisi → stop."""
    for j in range(i + 1, min(i + 1 + n, len(c))):
        if l[j] <= stop: return "stop", stop - c[i], j - i
        if wexit[j] and j - i > MIN_DAYS: return "haho", c[j] - c[i], j - i
    if i + n >= len(c): return None, 0.0, 0
    return "time", c[i + n] - c[i], n

def history(d, x, setup, wexit):
    """Bu hissede aynı kural geçmişte tetiklendiğinde ne oldu? (5 gün içindeki tekrarlar atlanır)"""
    l, c = d.low.values, d.close.values
    fired, last = np.flatnonzero(x[setup].values), -99
    res = {"stop": 0, "haho": 0, "time": 0}; R, days = [], []
    for i in fired:
        if i - last < 5 or np.isnan(x.atr.values[i]): continue
        last = i
        p = plan(c[i], x.atr.values[i], x.swlo20.values[i])
        out, pnl, dd = walk(l, c, wexit, i, p["stop"])
        if out:
            res[out] += 1; R.append(pnl / (c[i] - p["stop"])); days.append(dd)
    n = len(R)
    return {"n": n, "stop": res["stop"], "haho": res["haho"], "time": res["time"],
            "win": float(np.mean(np.array(R) > 0)) if n else None, "avgR": float(np.mean(R)) if n else None,
            "avgDays": float(np.mean(days)) if n else None}

def monte_carlo(d, p, seed=42):
    """Son 250 günün mumlarını (önceki kapanışa oranla, hacimle birlikte) 10 günlük bloklar hâlinde karıştırıp 90 günlük yollar üretir.
    Her yolda: ilk stop gün içinde; her 5. gün hafta kapanışı → haftalık HAHO (son 19 gerçek hafta + simüle haftalar) altındaysa çık."""
    rng = np.random.default_rng(seed)
    t = d.iloc[-251:]
    pc = t.close.shift().values[1:]
    rh, rl, rc = t.high.values[1:] / pc, t.low.values[1:] / pc, t.close.values[1:] / pc
    rv = t.volume.values[1:]
    P, D = MC_PATHS, HOLD; W = D // 5
    # 10 günlük bloklarla örnekleme: tek tek gün karıştırmak trendi yok eder ve trend takipli çıkışı haksız yere cezalandırır
    B = 10; nb = -(-D // B)
    starts = rng.integers(0, len(rc) - B + 1, size=(P, nb))
    idx = (starts[:, :, None] + np.arange(B)).reshape(P, nb * B)[:, :D]
    closes = p["entry"] * np.cumprod(rc[idx], axis=1)
    prev = np.hstack([np.full((P, 1), p["entry"]), closes[:, :-1]])
    lo = prev * rl[idx]
    vol = rv[idx]
    _, wc, wvol, _ = weekly_haho(d)
    k0 = 1 if d.index[-1].weekday() != 4 else 0          # bitmemiş son hafta geçmişe katılmaz
    hc, hv = wc.values[-19 - k0:len(wc) - k0], wvol.values[-19 - k0:len(wvol) - k0]
    sc, sv = closes[:, 4::5][:, :W], vol.reshape(P, W, 5).sum(2)
    fc = np.hstack([np.broadcast_to(hc, (P, len(hc))), sc]); fv = np.hstack([np.broadcast_to(hv, (P, len(hv))), sv])
    ccv = np.hstack([np.zeros((P, 1)), np.cumsum(fc * fv, 1)]); cvv = np.hstack([np.zeros((P, 1)), np.cumsum(fv, 1)])
    L = len(hc); k = np.arange(W)
    vw = (ccv[:, L + k + 1] - ccv[:, L + k + 1 - 20]) / (cvv[:, L + k + 1] - cvv[:, L + k + 1 - 20])
    ex = sc < vw; ex[:, 0] = False                     # ilk hafta (gün ≤ MIN_DAYS) HAHO çıkışı yok
    hit_s = np.where((lo <= p["stop"]).any(1), (lo <= p["stop"]).argmax(1), D + 1)
    hk = np.where(ex.any(1), ex.argmax(1), W + 1); hit_h = np.where(hk <= W - 1, hk * 5 + 4, D + 1)
    is_s = (hit_s <= hit_h) & (hit_s <= D - 1); is_h = ~is_s & (hit_h <= D - 1)
    px = np.where(is_s, p["stop"], np.where(is_h, closes[np.arange(P), np.minimum(hit_h, D - 1)], closes[:, -1]))
    risk = p["entry"] - p["stop"]; R = (px - p["entry"]) / risk
    dd = np.where(is_s, hit_s + 1, np.where(is_h, hit_h + 1, D))
    return {"stop": float(is_s.mean()), "haho": float(is_h.mean()), "time": float((~is_s & ~is_h).mean()),
            "win": float((R > 0).mean()), "meanR": float(R.mean()), "medR": float(np.median(R)),
            "meanPct": float((px / p["entry"] - 1).mean()), "medDays": float(np.median(dd)), "seed": seed, "paths": P, "maxDays": D}


# ---------------------------------------------------------------- 6. Kronos
def kronos_forecast(data, tickers, samples=8, lookback=400):
    """Her hisse için `samples` bağımsız 40 günlük yol üretir (predict_batch ile aynı seriyi tekrar vererek)."""
    sys.path.insert(0, os.path.join(HERE, "kronos"))
    import torch
    from model import Kronos, KronosTokenizer, KronosPredictor
    tok = KronosTokenizer.from_pretrained("NeoQuasar/Kronos-Tokenizer-base")
    mdl = Kronos.from_pretrained("NeoQuasar/Kronos-small")
    pr = KronosPredictor(mdl, tok, max_context=512)
    out, todo = {}, [t for t in tickers if len(data[t]) >= lookback]
    chunk = max(1, 64 // samples)                     # 6 GB VRAM: 64 seri × 400 mum güvenli
    for k in range(0, len(todo), chunk):
        part = todo[k:k + chunk]
        dfs, xs, ys = [], [], []
        for t in part:
            d = data[t].iloc[-lookback:]
            df = d[["open", "high", "low", "close", "volume"]].reset_index(drop=True)
            xts = pd.Series(d.index.tz_localize(None))
            yts = pd.Series(pd.bdate_range(xts.iloc[-1] + pd.Timedelta(days=1), periods=HOLD))
            for _ in range(samples):
                dfs.append(df); xs.append(xts); ys.append(yts)
        preds = pr.predict_batch(dfs, xs, ys, pred_len=HOLD, T=1.0, top_p=0.9, sample_count=1, verbose=False)
        for j, t in enumerate(part):
            last = data[t].close.iloc[-1]
            paths = np.array([p["close"].values for p in preds[j * samples:(j + 1) * samples]]) / last - 1
            r20, r40 = paths[:, 19], paths[:, -1]
            out[t] = {"pUp20": float((r20 > 0).mean()), "med20": float(np.median(r20)), "med40": float(np.median(r40)),
                      "p10": float(np.percentile(r40, 10)), "p90": float(np.percentile(r40, 90)),
                      "path": [round(float(v), 4) for v in np.median(paths, axis=0)]}
        torch.cuda.empty_cache()
        print(f"  kronos {min(k + chunk, len(todo))}/{len(todo)}", flush=True)
    return out


# ---------------------------------------------------------------- 7. puan
ISY = "https://www.isyatirim.com.tr/_layouts/15/IsYatirim.Website/Common/Data.aspx/MaliTablo"
def isy_net(code):
    """BIST bilanço filtresi (swing-scan isyNet ile aynı; bt_improve.py: isabet %37→%39, işlem başı +13,0%→+17,8%).
    Yıl başından kümülatif ana ortaklık net kârı; iyi = net kâr > 0, yıllık büyüme > 0 ve önceki çeyreğin yıllık büyümesinden yüksek."""
    now = datetime.now(timezone.utc); y, m = now.year, (now.month - 1) // 3 * 3
    if m == 0: y, m = y - 1, 12
    ps = []
    for _ in range(8):
        ps.append((y, m)); m -= 3
        if m == 0: y, m = y - 1, 12
    for grp in ("XI_29", "UFRS_K"):
        q = {}
        try:
            for i in (0, 4):
                part = ps[i:i + 4]
                qs = "&".join(f"year{k+1}={yy}&period{k+1}={mm}" for k, (yy, mm) in enumerate(part))
                req = urllib.request.Request(f"{ISY}?companyCode={code}&exchange=TRY&financialGroup={grp}&{qs}", headers={"User-Agent": "Mozilla/5.0"})
                j = json.loads(urllib.request.urlopen(req, timeout=15).read())
                if not j.get("ok") or not j.get("value"): continue
                rows = {r["itemCode"]: r for r in j["value"]}
                row = rows.get("3ZA" if grp != "XI_29" and "3ZA" in rows else "3Z" if "3Z" in rows else "3L")
                if not row: continue
                for k, (yy, mm) in enumerate(part):
                    v = row.get(f"value{k+1}")
                    if v not in (None, ""): q[(yy, mm)] = float(v)
        except Exception:
            continue
        key = next((k for k in ps if k in q), None)
        if not key: continue
        ky, km = key; prev = q.get((ky - 1, km))
        if not prev: return None
        g = (q[key] - prev) / abs(prev)
        pm, py = (km - 3, ky) if km > 3 else (12, ky - 1)
        a, b = q.get((py, pm)), q.get((py - 1, pm))
        gp = (a - b) / abs(b) if a is not None and b else None
        return {"good": q[key] > 0 and g > 0 and (gp is None or g > gp), "period": f"{km}A{str(ky)[2:]}", "g": g, "gp": gp}
    return None

# bilanço tarihi yakınsa ALINIR verilmez (kullanıcı kuralı, swing-scan earnDates/bistDeadline ile aynı; geriye test edilmedi)
EARN_DAYS, SPK_DAYS = 14, {3: 40, 6: 50, 9: 40, 12: 70}
def _day_diff(dt):
    return (dt.date() - datetime.now(timezone.utc).date()).days

def earn_dates(tickers):
    import http.cookiejar
    out = {}
    try:
        op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
        ua = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130 Safari/537.36"}
        try: op.open(urllib.request.Request("https://fc.yahoo.com", headers=ua), timeout=10)
        except Exception: pass
        crumb = op.open(urllib.request.Request("https://query2.finance.yahoo.com/v1/test/getcrumb", headers=ua), timeout=10).read().decode()
        for i in range(0, len(tickers), 50):
            u = ("https://query2.finance.yahoo.com/v7/finance/quote?symbols=" + ",".join(urllib.parse.quote(t) for t in tickers[i:i + 50])
                 + "&fields=earningsTimestamp,earningsTimestampStart,isEarningsDateEstimate&crumb=" + urllib.parse.quote(crumb))
            for r in json.loads(op.open(urllib.request.Request(u, headers=ua), timeout=15).read())["quoteResponse"]["result"]:
                ts = sorted(x for x in (r.get("earningsTimestamp"), r.get("earningsTimestampStart"))
                            if x and _day_diff(datetime.fromtimestamp(x, timezone.utc)) >= 0)
                if ts:
                    dt = datetime.fromtimestamp(ts[0], timezone.utc)
                    out[r["symbol"]] = {"date": dt.strftime("%Y-%m-%d"), "days": _day_diff(dt), "est": bool(r.get("isEarningsDateEstimate")), "src": "Yahoo"}
    except Exception:
        pass
    return out

def bist_deadline(e):
    if not e: return None
    m, y = map(int, e["period"].split("A"))
    nm, ny = (3, 2000 + y + 1) if m == 12 else (m + 3, 2000 + y)
    end = datetime(ny + (nm == 12), nm % 12 + 1, 1, tzinfo=timezone.utc) - timedelta(days=1)
    dl = end + timedelta(days=SPK_DAYS[nm])
    if _day_diff(end) >= 0 or _day_diff(dl) < 0: return None
    return {"date": dl.strftime("%Y-%m-%d"), "days": _day_diff(dl), "est": True, "src": "SPK son tarih"}

def score(s):
    pts, why = 0, []
    def add(v, txt):
        nonlocal pts; pts += v; why.append(("+" if v > 0 else "") + f"{v} {txt}")
    if s["tt"]: add(2, "Stage 2 trend (Trend Template 7/7)")
    if s["rs"] >= 80: add(2, f"Göreli güç %{s['rs']:.0f} dilimde")
    elif s["rs"] >= 60: add(1, f"Göreli güç %{s['rs']:.0f} dilimde")
    if s["setups"]: add(2, "Kurulum: " + ", ".join(SETUPS[k] for k in s["setups"]))
    hst = s.get("hist")
    if hst and hst["n"] >= 5:
        if hst["avgR"] >= 0.3: add(1, f"Geçmiş: {hst['n']} sinyal, ortalama +{hst['avgR']:.2f}R, kârlı %{hst['win']*100:.0f}")
        elif hst["avgR"] < 0: add(-1, f"Geçmiş: {hst['n']} sinyal, ortalama {hst['avgR']:.2f}R (negatif)")
    e = s.get("ern"); pc = lambda x: f"{'+' if x >= 0 else ''}{round(x * 100)}%"
    if e and e["good"]: add(1, f"Bilanço iyi: {e['period']} net kâr yıllık {pc(e['g'])}" + (f", hızlanıyor (önceki {pc(e['gp'])})" if e["gp"] is not None else ""))
    elif e: why.append(f"0 Bilanço zayıf: {e['period']} net kâr yıllık {pc(e['g'])}" + (f" (önceki {pc(e['gp'])})" if e["gp"] is not None else "") + "; ALINIR verilmez")
    en = s.get("earn"); near = bool(en) and en["days"] <= EARN_DAYS
    if near:
        dd = f"{en['date'][8:]}.{en['date'][5:7]}"
        why.append(f"! Bilanço {'bugün' if en['days'] == 0 else str(en['days']) + ' gün içinde'} ({'' if en['src'] == 'Yahoo' else 'en geç '}{dd}{', tahmini' if en['est'] and en['src'] == 'Yahoo' else ''}): sürpriz riski, ALINIR verilmez; açıklanmasını bekle ya da küçük pozisyon")
    mc = s["mc"]
    if mc["meanR"] >= 0.2 and mc["win"] >= 0.45: add(1, f"Monte Carlo: ortalama +{mc['meanR']:.2f}R, kârlı kapanış %{mc['win']*100:.0f}, ilk stop %{mc['stop']*100:.0f}")
    # Kronos puana katılmaz: eval_kronos.py walk-forward testinde (3 Kas 2026, 20g ufuk) IC US +0,11 (t=0,7),
    # BIST −0,09; yön isabeti taban oranında; mutlak tahminler −%7/−%8 kayık. Yalnızca deneysel bilgi olarak gösterilir.
    if s["riskPct"] > 12: add(-1, f"Stop çok uzak (%{s['riskPct']:.1f})")
    if not s["liquid"]: add(-2, "Düşük işlem hacmi")
    if not s["regimeOk"]: add(-1, "Endeks 200 günlük ortalamanın altında")
    neg = any(w.startswith("-") for w in why)
    verdict = "ALINIR" if pts >= 6 and not neg and s["setups"] and not (e and not e["good"]) and not near else "ALINMAZ" if pts <= 2 else "KARARSIZ"
    return max(0, min(MAX_SCORE, pts)), verdict, why


def regime(bench):
    c = bench.close
    s50, s200 = c.rolling(50).mean(), c.rolling(200).mean()
    ok = bool(c.iloc[-1] > s200.iloc[-1] and s50.iloc[-1] > s50.iloc[-21])
    return {"ok": ok, "close": float(c.iloc[-1]), "sma50": float(s50.iloc[-1]), "sma200": float(s200.iloc[-1]),
            "chg20": float(c.iloc[-1] / c.iloc[-21] - 1), "spark": [round(float(v), 2) for v in c.iloc[-120:]]}


def run_market(mkt, use_kronos):
    uni = universe_bist() if mkt == "bist" else universe_us()
    print(f"[{mkt}] evren: {len(uni)} hisse", flush=True)
    data = download([u["ticker"] for u in uni] + [BENCH[mkt]], mkt)
    bench = data.pop(BENCH[mkt])
    reg = regime(bench)
    meta = {u["ticker"]: u for u in uni if u["ticker"] in data}
    # göreli güç: 63g ve 126g getirinin ağırlıklı ortalaması → evren içi yüzdelik
    perf = {t: 0.6 * (d.close.iloc[-1] / d.close.iloc[-64] - 1) + 0.4 * (d.close.iloc[-1] / d.close.iloc[-127] - 1) for t, d in data.items()}
    rs = pd.Series(perf).rank(pct=True) * 100
    kron = kronos_forecast(data, list(data)) if use_kronos else {}
    ern = {}
    if mkt == "bist":
        from concurrent.futures import ThreadPoolExecutor
        with ThreadPoolExecutor(8) as ex: ern = dict(zip(data, ex.map(lambda t: isy_net(meta[t]["symbol"]), data)))
    ed = earn_dates(list(data))
    earn = {t: ed.get(t) or (bist_deadline(ern.get(t)) if mkt == "bist" else None) for t in data}
    rows = []
    for t, d in data.items():
        x = indicators(d)
        last = x.iloc[-1]
        c = float(d.close.iloc[-1])
        setups = [k for k in SETUPS if bool(last[k]) and not (mkt == "us" and k == "vcp")]  # VCP Nasdaq'ta negatif (bt_vcp.py)
        wexit, _, _, wvw = weekly_haho(d)
        p = plan(c, float(last.atr), float(last.swlo20), float(wvw.iloc[-1]))
        primary = setups[0] if setups else "pullback"
        s = {"ticker": t, "symbol": meta[t]["symbol"], "name": meta[t]["name"], "sector": meta[t]["sector"], "market": mkt,
             "close": c, "chg1d": float(c / d.close.iloc[-2] - 1), "chg20": float(c / d.close.iloc[-21] - 1),
             "rs": float(rs[t]), "rsi": float(last.rsi), "tt": bool(last.tt), "setups": setups,
             "plan": p, "riskPct": p["riskPct"], "atr": float(last.atr),
             "liquid": float((d.close * d.volume).iloc[-20:].mean()) >= MIN_TURNOVER[mkt],
             "regimeOk": reg["ok"], "ern": ern.get(t), "earn": earn.get(t), "hist": history(d, x, primary, wexit), "histSetup": primary,
             "mc": monte_carlo(d, p), "kronos": kron.get(t), "rrg": rrg(d, bench),
             "spark": [round(float(v), 4) for v in d.close.iloc[-60:]]}
        s["score"], s["verdict"], s["why"] = score(s)
        rows.append(s)
    rows.sort(key=lambda r: (-r["score"], -r["rs"]))
    for r in rows[:30]:   # grafikler için son 150 mum yalnızca ilk 30 adayda
        d = data[r["ticker"]].iloc[-150:]
        r["bars"] = [[int(pd.Timestamp(ts.date()).tz_localize("UTC").timestamp()), round(float(o), 4), round(float(h), 4), round(float(l), 4), round(float(c), 4), int(v)]
                     for ts, o, h, l, c, v in zip(d.index, d.open, d.high, d.low, d.close, d.volume)]
    return {"market": mkt, "bench": BENCH[mkt], "regime": reg, "count": len(rows), "stocks": rows,
            "asOf": str(bench.index[-1].date())}


def upload(result):
    env = dict(l.strip().split("=", 1) for l in open(os.path.join(HERE, ".env")) if "=" in l and not l.startswith("#"))
    body = json.dumps({"payload": result, "token": env["SWING_INGEST_TOKEN"]}, default=float).encode()
    req = urllib.request.Request(env["SUPABASE_URL"] + "/rest/v1/rpc/swing_ingest", data=body, method="POST",
                                 headers={"apikey": env["SUPABASE_ANON_KEY"], "Authorization": "Bearer " + env["SUPABASE_ANON_KEY"],
                                          "Content-Type": "application/json"})
    return json.loads(urllib.request.urlopen(req, timeout=60).read() or "null")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--market", default="all", choices=["bist", "us", "all"])
    ap.add_argument("--no-kronos", action="store_true")
    ap.add_argument("--no-upload", action="store_true")
    a = ap.parse_args()
    t0 = time.time()
    res = {"createdAt": datetime.now(timezone.utc).isoformat(), "params": {"hold": HOLD, "atrK": ATR_K, "r": R_MULT, "kronos": not a.no_kronos, "maxScore": MAX_SCORE, "mcPaths": MC_PATHS, "source": "local"},
           "markets": [run_market(m, not a.no_kronos) for m in (["bist", "us"] if a.market == "all" else [a.market])]}
    res["seconds"] = round(time.time() - t0)
    json.dump(res, open(os.path.join(HERE, "last_scan.json"), "w", encoding="utf-8"), ensure_ascii=False, default=float)
    for m in res["markets"]:
        print(f"\n[{m['market']}] {m['asOf']} rejim={'OK' if m['regime']['ok'] else 'ZAYIF'}")
        for r in m["stocks"][:8]:
            print(f"  {r['symbol']:6} {r['score']:>2} {r['verdict']:8} RS{r['rs']:3.0f} {','.join(r['setups']) or '-'}")
    if not a.no_upload:
        print("supabase:", upload(res))
    print(f"bitti {res['seconds']} sn")
