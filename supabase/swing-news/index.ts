// Swing Radar haberleri — yalnızca istekle çalışır: swing_news_start() → pg_net → bu fonksiyon → swing_news_put(payload).
// Kaynaklar: Bing News RSS (portföy hisseleri), Bloomberg HT + AA ekonomi (ulusal), Investing.com TR + NinjaNews (küresel),
// Investing.com ekonomik takvimi (bugün; 3 yıldız + TR/ABD 2 yıldız).
import { createClient } from "jsr:@supabase/supabase-js@2";

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const UA = { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36", "accept-language": "tr-TR,tr;q=0.9,en;q=0.8" };
type Item = { t: string; u: string; src: string; at: string | null; d?: string; score?: number; tag?: string };

async function get(url: string, init: RequestInit = {}) {
  const r = await fetch(url, { ...init, headers: { ...UA, ...(init.headers ?? {}) }, signal: AbortSignal.timeout(12000) });
  if (!r.ok) throw new Error(`${new URL(url).host} ${r.status}`);
  const buf = new Uint8Array(await r.arrayBuffer());
  const head = new TextDecoder("latin1").decode(buf.slice(0, 200));
  const cs = (r.headers.get("content-type")?.match(/charset=([\w-]+)/i)?.[1] ?? head.match(/encoding="([\w-]+)"/i)?.[1] ?? "utf-8").toLowerCase();
  try { return new TextDecoder(cs === "iso-8859-9" ? "windows-1254" : cs).decode(buf); } catch { return new TextDecoder().decode(buf); }
}

const ent = (s: string) => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/<[^>]+>/g, " ")
  .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
  .replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
  .replace(/\s+/g, " ").trim();
const tag = (x: string, n: string) => x.match(new RegExp(`<${n}[^>]*>([\\s\\S]*?)</${n}>`, "i"))?.[1] ?? "";
const iso = (s: string) => { const d = new Date(s); return isNaN(+d) ? null : d.toISOString(); };

async function rss(url: string, src: string, max = 30): Promise<Item[]> {
  const x = await get(url);
  return x.split(/<item[\s>]/i).slice(1, max + 1).map(it => {
    let u = ent(tag(it, "link")) || ent(tag(it, "guid"));
    const real = u.match(/[?&]url=([^&]+)/)?.[1]; if (real) u = decodeURIComponent(real);
    return { t: ent(tag(it, "title")), u, src: ent(tag(it, "News:Source")) || src, at: iso(ent(tag(it, "pubDate"))), d: ent(tag(it, "description")).slice(0, 220) };
  }).filter(i => i.t && i.u);
}
async function ninja(max = 30): Promise<Item[]> {
  const j = JSON.parse(await get(`https://ninjanews.io/wp-json/wp/v2/posts?per_page=${max}&_fields=title,link,date_gmt,excerpt`));
  return j.map((p: any) => ({ t: ent(p.title?.rendered ?? ""), u: p.link, src: "NinjaNews", at: iso(p.date_gmt + "Z"), d: ent(p.excerpt?.rendered ?? "").slice(0, 220) }));
}

// önem puanı: piyasayı hareket ettiren anahtar kelimeler + tazelik
const KEY: [RegExp, number][] = [
  [/\b(fed|powell|tcmb|merkez bankas|faiz|ecb|boj|politika faizi)/i, 5], [/(enflasyon|tüfe|üfe|cpi|pce|istihdam|tarım dışı|nfp|işsizlik|gsyh|büyüme|pmi)/i, 4],
  [/(savaş|saldırı|ateşkes|yaptırım|tarife|gümrük|seçim|trump|kriz|resesyon|iflas)/i, 3], [/(bist|borsa|nasdaq|s&p|dolar|altın|gümüş|petrol|brent|tahvil|cds|kur)/i, 2],
  [/(bilanço|kâr|temettü|bedelsiz|halka arz|geri alım|kap)/i, 2],
];
const rank = (i: Item) => KEY.reduce((s, [re, w]) => s + (re.test(i.t + " " + (i.d ?? "")) ? w : 0), 0) + (i.at ? Math.max(0, 3 - (Date.now() - +new Date(i.at)) / 36e5 / 8) : 0);
const dedupe = (a: Item[]) => { const seen = new Set<string>(); return a.filter(i => { const k = i.t.toLocaleLowerCase("tr").replace(/[^a-zçğıöşü0-9]/g, "").slice(0, 60); if (seen.has(k)) return false; seen.add(k); return true; }); };
const top = (a: Item[], n: number, hours = 48) => dedupe(a.filter(i => !i.at || Date.now() - +new Date(i.at) < hours * 36e5))
  .map(i => ({ ...i, score: Math.round(rank(i) * 10) / 10 })).sort((x, y) => y.score! - x.score! || +new Date(y.at ?? 0) - +new Date(x.at ?? 0)).slice(0, n);

// ---------------------------------------------------------------- ekonomik takvim (Investing.com, bugün, TR saati)
const CTRY: Record<string, number> = { TR: 63, US: 5, EU: 72, DE: 17, GB: 4, CN: 37, JP: 35 };
const WHY: Record<string, string> = {
  TRY: "BIST pozisyonların (GARAN, KCHOL) ve TL doğrudan etkilenir",
  USD: "Nasdaq, dolar/TL ve gümüş (YZG) üzerinden etkiler",
  EUR: "Avrupa riski; TL ve dolar üzerinden dolaylı etki",
  CNY: "Emtia ve gümüş talebi üzerinden YZG'yi etkileyebilir",
  GBP: "Küresel risk iştahı üzerinden dolaylı etki", JPY: "Küresel risk iştahı üzerinden dolaylı etki",
};
async function calendar() {
  const body = new URLSearchParams();
  Object.values(CTRY).forEach(c => body.append("country[]", String(c)));
  ["2", "3"].forEach(i => body.append("importance[]", i));
  body.set("timeZone", "63"); body.set("timeFilter", "timeOnly"); body.set("currentTab", "today"); body.set("limit_from", "0");
  const raw = await get("https://tr.investing.com/economic-calendar/Service/getCalendarFilteredData", {
    method: "POST", body, headers: { "x-requested-with": "XMLHttpRequest", "content-type": "application/x-www-form-urlencoded", referer: "https://tr.investing.com/economic-calendar/" },
  });
  const html: string = JSON.parse(raw).data ?? "";
  return html.split(/<tr id="eventRowId_/).slice(1).map(r => {
    const cell = (re: RegExp) => ent(r.match(re)?.[1] ?? "");
    const cur = cell(/class="left flagCur[^"]*">[\s\S]*?<\/span>\s*([A-Z]{3})/);
    const stars = +(r.match(/data-img_key="bull(\d)"/)?.[1] ?? 0);
    return {
      at: r.match(/data-event-datetime="([^"]+)"/)?.[1]?.replace(/\//g, "-") ?? null,
      time: cell(/js-time"[^>]*>([^<]*)</), country: cell(/class="ceFlags[^"]*"[^>]*title="([^"]+)"/) || ent(r.match(/<span title="([^"]+)" class="ceFlags/)?.[1] ?? ""), cur, stars,
      ev: cell(/class="left event"[^>]*>([\s\S]*?)<\/td>/),
      act: cell(/id="eventActual_\d+"[^>]*>([\s\S]*?)<\/td>/), fc: cell(/id="eventForecast_\d+"[^>]*>([\s\S]*?)<\/td>/), prev: cell(/id="eventPrevious_\d+"[^>]*>([\s\S]*?)<\/td>/),
      good: /greenFont/.test(r.match(/id="eventActual_[^>]*/)?.[0] ?? "") ? 1 : /redFont/.test(r.match(/id="eventActual_[^>]*/)?.[0] ?? "") ? -1 : 0,
    };
  }).filter(e => e.ev && (e.stars >= 3 || ((e.cur === "TRY" || e.cur === "USD") && e.stars >= 2)))
    .map(e => ({ ...e, why: WHY[e.cur] ?? "Küresel risk iştahı üzerinden dolaylı etki", mine: e.cur === "TRY" || e.cur === "USD" }));
}

// ---------------------------------------------------------------- portföy hisseleri
const QUERY: Record<string, string> = { GARAN: "Garanti BBVA", KCHOL: "Koç Holding", TCELL: "Turkcell", YZG: "gümüş fiyatları", PPF: "para piyasası fonu" };
async function holdings() {
  const [{ data: pos }, { data: ord }, { data: wl }] = await Promise.all([
    sb.from("swing_positions").select("symbol,name,kind"), sb.from("swing_orders").select("symbol").eq("status", "bekliyor"),
    sb.from("swing_watch").select("symbol,name,market").order("added_at"),
  ]);
  const syms = [...new Set([...(pos ?? []).map((p: any) => p.symbol), ...(ord ?? []).map((o: any) => o.symbol)])].filter(s => s !== "PPF");
  const names = Object.fromEntries((pos ?? []).map((p: any) => [p.symbol, p.name]));
  // takip listesi: portföyde olmayanlar ayrı grupta (watch: true)
  const watch = (wl ?? []).filter((w: any) => !syms.includes(w.symbol));
  const one = async (s: string, q: string, tr: boolean, extra: Record<string, unknown>) => {
    try {
      const it = await rss(`https://www.bing.com/news/search?q=${encodeURIComponent(q)}&format=rss&setlang=${tr ? "tr-TR&cc=TR" : "en-US&cc=US"}`, "Bing", 20);
      const key = q.split(" ")[0].toLocaleLowerCase("tr"), sym = s.toLocaleLowerCase("tr");
      const rel = it.filter(i => { const x = (i.t + " " + (i.d ?? "")).toLocaleLowerCase("tr"); return x.includes(key) || x.includes(sym); });
      return { symbol: s, name: q, items: top(rel, 6, 24 * 7), error: null, ...extra };
    } catch (e) { return { symbol: s, items: [], error: String((e as Error).message), ...extra }; }
  };
  // şirket adının ayırt edici kısmı (A.Ş., Holding, Inc. gibi ekler atılır)
  const clean = (n: string) => n.replace(/(^|\s)(a\.?ş\.?|t\.?a\.?ş\.?|anonim|şirketi|sanayi|ticaret|ve|inc\.?|corp\.?|corporation|company|co\.?|plc|ltd\.?)(?=\s|$)/gi, " ").replace(/[.,]/g, " ").replace(/\s+/g, " ").trim().split(" ").slice(0, 2).join(" ");
  return Promise.all([
    ...syms.map(s => one(s, QUERY[s] ?? (names[s] ?? s), true, { owned: !!names[s] })),
    ...watch.map((w: any) => one(w.symbol, w.market === "us" ? `${w.symbol} ${clean(w.name ?? "")} stock`.trim() : (clean(w.name ?? "") || w.symbol), w.market !== "us", { owned: false, watch: true })),
  ]);
}

// ---------------------------------------------------------------- sektör haberleri (ısı haritası için; yorum yok, yalnızca yerleştirme)
const SECTORS: Record<string, { tr: string; q: string[]; re: RegExp }> = {
  "Financial Services": { tr: "Finans", q: ["bankacılık sektörü", "bank stocks interest rates"], re: /(banka|bankacılık|kredi|mevduat|bddk|faiz|sigorta|aracı kurum|bank|lender|fed)/i },
  Technology: { tr: "Teknoloji", q: ["teknoloji hisseleri yarı iletken", "semiconductor AI chip stocks"], re: /(teknoloji|yazılım|yarı iletken|çip|yapay zeka|nvidia|apple|microsoft|semiconductor|software|chip|\bai\b)/i },
  Industrials: { tr: "Sanayi", q: ["sanayi üretimi savunma havacılık", "industrial stocks defense aerospace"], re: /(sanayi|imalat|savunma|havacılık|lojistik|demiryolu|inşaat|pmi|industrial|defense|aerospace|airline)/i },
  "Consumer Cyclical": { tr: "Döngüsel tüketim", q: ["otomotiv sektörü perakende", "retail auto stocks consumer spending"], re: /(otomotiv|otomobil|perakende|turizm|otel|beyaz eşya|tüketici harcama|retail|automaker|consumer spending)/i },
  "Consumer Defensive": { tr: "Temel tüketim", q: ["gıda fiyatları perakende zincir", "consumer staples food beverage stocks"], re: /(gıda|içecek|market zinciri|tarım|food|beverage|staples)/i },
  Energy: { tr: "Enerji", q: ["petrol fiyatları brent opec", "oil prices OPEC energy stocks"], re: /(petrol|brent|opec|rafineri|doğal ?gaz|akaryakıt|oil|crude|refiner)/i },
  "Basic Materials": { tr: "Temel malzeme", q: ["çelik demir emtia fiyatları", "metals mining steel copper prices"], re: /(çelik|demir|alüminyum|bakır|maden|altın|gümüş|kimya|cam|çimento|steel|copper|mining|gold|silver)/i },
  Utilities: { tr: "Altyapı (elektrik-gaz)", q: ["elektrik doğalgaz zam epdk", "utilities electricity power prices"], re: /(elektrik|doğalgaz|epdk|enerji santrali|yenilenebilir|güneş|rüzgar|utility|utilities|power grid)/i },
  Healthcare: { tr: "Sağlık", q: ["ilaç sağlık sektörü", "biotech pharma FDA"], re: /(ilaç|sağlık|hastane|biyoteknoloji|aşı|fda|pharma|biotech|drug)/i },
  "Communication Services": { tr: "İletişim", q: ["telekom sektörü btk", "telecom media streaming stocks"], re: /(telekom|gsm|btk|medya|reklam|operatör|telecom|streaming|media)/i },
  "Real Estate": { tr: "Gayrimenkul", q: ["konut satışları gayrimenkul", "real estate REIT housing"], re: /(konut|gayrimenkul|gyo|kira|emlak|housing|real estate|reit)/i },
};
async function sectorNews(pool: Item[]) {
  const out: Record<string, { tr: string; items: Item[] }> = {};
  await Promise.all(Object.entries(SECTORS).map(async ([k, v]) => {
    const got = (await Promise.all(v.q.map((q, i) => rss(`https://www.bing.com/news/search?q=${encodeURIComponent(q)}&format=rss&setlang=${i ? "en-US" : "tr-TR"}&cc=${i ? "US" : "TR"}`, "Bing", 15).catch(() => [] as Item[])))).flat();
    out[k] = { tr: v.tr, items: top([...pool.filter(i => v.re.test(i.t)), ...got], 6, 72) };
  }));
  return out;
}

Deno.serve(async () => {
  const errs: string[] = [];
  const safe = async <T,>(name: string, p: Promise<T>, fb: T) => { try { return await p; } catch (e) { errs.push(`${name}: ${(e as Error).message}`); return fb; } };
  try {
    const [stocks, bht, aa, invTr, nj, cal] = await Promise.all([
      safe("portföy", holdings(), []),
      safe("Bloomberg HT", rss("https://www.bloomberght.com/rss", "Bloomberg HT", 60), [] as Item[]),
      safe("AA", rss("https://www.aa.com.tr/tr/rss/default?cat=ekonomi", "Anadolu Ajansı", 40), [] as Item[]),
      safe("Investing", rss("https://tr.investing.com/rss/news.rss", "Investing.com", 40), [] as Item[]),
      safe("NinjaNews", ninja(30), [] as Item[]),
      safe("takvim", calendar(), []),
    ]);
    // küresel / ulusal ayrımı: yurt dışı anahtar kelimeleri olan haber küresele
    const abroad = /(abd|fed|trump|avrupa|ecb|çin|japon|almanya|ingiltere|rusya|ukrayna|israil|iran|wall street|nasdaq|s&p|dow|opec|brent|altın|ons|bitcoin|kripto|küresel|dünya)/i;
    const pool = [...bht, ...aa, ...invTr, ...nj];
    const global = top(pool.filter(i => abroad.test(i.t)), 12, 36);
    const national = top(pool.filter(i => !abroad.test(i.t)), 12, 36);
    const sectors = await safe("sektör", sectorNews(pool), {});
    const payload = { at: new Date().toISOString(), stocks, national, global, calendar: cal, sectors, errors: errs };
    await sb.rpc("swing_news_put", { payload, err: null });
    return new Response("ok");
  } catch (e) {
    await sb.rpc("swing_news_put", { payload: null, err: String((e as Error).message ?? e) });
    return new Response(String(e), { status: 500 });
  }
});
