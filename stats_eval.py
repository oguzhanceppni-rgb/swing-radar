import sys, pandas as pd, numpy as np
for m in sys.argv[1:]:
    df = pd.read_csv(f"eval_{m}.csv")
    sp = lambda a, b: a.rank().corr(b.rank())
    g = df.groupby("cut")
    ic = g.apply(lambda x: sp(x.pred, x.real)); icm = g.apply(lambda x: sp(x.mom, x.real))
    sprd = g.apply(lambda x: x[x.pred >= x.pred.quantile(2/3)].real.mean() - x[x.pred <= x.pred.quantile(1/3)].real.mean())
    print(f"[{m}] n={len(df)}  Kronos IC {ic.mean():+.3f} (t={ic.mean()/ic.std()*np.sqrt(len(ic)):.2f}) {np.round(ic.values,2)}")
    print(f"   momentum IC {icm.mean():+.3f} {np.round(icm.values,2)}")
    print(f"   yön isabeti {((df.pUp>0.5)==(df.real>0)).mean():.1%}  gerçek yukarı oranı {(df.real>0).mean():.1%}")
    print(f"   üst1/3-alt1/3 fark {sprd.mean():+.2%}   tahmin medyan {df.pred.median():+.2%} / gerçek medyan {df.real.median():+.2%}")
