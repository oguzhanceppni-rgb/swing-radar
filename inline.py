"""web/dist çıktısını tek dosyalık artifact HTML'ine (swing-radar.html) gömer."""
import glob, re, os
d = os.path.join(os.path.dirname(os.path.abspath(__file__)), "web", "dist")
html = open(os.path.join(d, "index.html"), encoding="utf-8").read()
jsf = glob.glob(os.path.join(d, "assets", "*.js"))
assert len(jsf) == 1, f"tek JS bekleniyordu: {jsf}"
js = open(jsf[0], encoding="utf-8").read().replace("</script", r"<\/script")
css = open(glob.glob(os.path.join(d, "assets", "*.css"))[0], encoding="utf-8").read()
html = re.sub(r'<script type="module" crossorigin src="[^"]+"></script>', lambda m: '<script type="module">' + js + "</script>", html)
html = re.sub(r'<link rel="stylesheet" crossorigin href="[^"]+">', lambda m: "<style>" + css + "</style>", html)
assert "last_scan.json" not in html, "geliştirme verisi pakete sızdı"
out = os.path.join(os.path.dirname(d), "..", "swing-radar.html")
open(out, "w", encoding="utf-8").write(html)
print("ok", round(len(html) / 1024), "KB")
