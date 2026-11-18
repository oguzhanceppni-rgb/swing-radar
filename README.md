# Swing Radar

XU100 + Nasdaq-100 için 1–2 aylık swing taraması. Tarama yerelde çalışır (Kronos GPU'da), sonuç Supabase `swing_scans` tablosuna yüklenir, site (claude.ai artifact "Swing Radar") oradan okur.

- `scan.py`: evren (KAP / Nasdaq API) → yfinance günlük veri → Trend Template, 55g kırılım, geri çekilme, VCP → plan (2×ATR stop, 2R hedef, 40 gün) → geçmiş backtest + 10.000 yollu Monte Carlo → puan 0–8 → yükleme
- `eval_kronos.py`: Kronos walk-forward testi (puana neden katılmadığının kanıtı)
- `web/`: Vite + React site; `python inline.py` tek dosyalık `swing-radar.html` üretir
- `kronos/`: shiyu-coder/Kronos klonu

Çalıştır: `.venv/Scripts/python -I scan.py` (`--market bist|us`, `--no-kronos`, `--no-upload`)
Yatırım tavsiyesi değildir.
