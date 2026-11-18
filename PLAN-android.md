# Swing Radar — Android planı (henüz uygulanmadı)

Hazırlandı: 4 Kasım 2026. Uygulama sonraki bir oturumda yapılacak.

## Karar: önce mevcut siteyi telefona uyarla, ayrı uygulamayı gerekirse sonra yap

| Yol | Ne demek | Artı | Eksi |
|---|---|---|---|
| **A. Mevcut site, mobil uyumlu** (önerilen 1. aşama) | Aynı claude.ai sayfası; Claude Android uygulamasından ya da Chrome'dan açılır, Chrome'da "Ana ekrana ekle" ile simge olur | Veri ve güvenlik aynen kalır (Supabase bağlantısı claude.ai hesabın üzerinden) | claude.ai'ye giriş gerekir; çevrimdışı çalışmaz; tam ekran "uygulama" hissi sınırlı |
| **B. Kendi adresinde PWA** (gerekirse 2. aşama) | Site ayrı bir adreste (Vercel / GitHub Pages) yayınlanır, telefona uygulama gibi kurulur | Tam ekran, kendi simgesi, hızlı açılış, son veriyi önbellekte tutar | Supabase'e doğrudan bağlanır: giriş (e-posta bağlantısı) + satır güvenliği (RLS) kurulmalı, aksi halde portföy herkese açık olur |
| C. Gerçek APK (Capacitor) | B'nin Play Store'suz paketlenmiş hali | Yerel bildirim | Gereksiz iş; otomatik bildirim zaten istenmiyor |

## 1. aşama — mobil uyum (yaklaşık 1–2 oturum)

1. **Gezinme:** Sol menü telefonda alt sekme çubuğuna dönüşür (Tarama, Portföy, Haberler, Günlük, Diğer). Logo üstte küçük bant.
2. **Açılış sahnesi (3B küre):**
   - Telefonda parçacık sayısı yarıya, ekran keskinliği 1,5× ile sınırlı.
   - Sahne yüksekliği kısalır (340vh → ~220vh), "Sahneyi atla" büyük ve başparmak hizasında.
   - Kodlar daha az (en fazla 10) ve dokunmaya uygun boyutta.
   - Three.js yalnızca gerektiğinde yüklenir (site açılışı ~1,3 MB → ~750 KB).
3. **Yumuşak kaydırma (Lenis):** Dokunmatik ekranda kapalı, telefonun kendi kaydırması kullanılır.
4. **Tablolar → kartlar:** Aday tablosu, pozisyonlar, emirler ve haber takvimi telefonda satır yerine kart.
5. **Rotasyon haritası:** Fare yerine dokunma: iki parmakla yakınlaştırma, tek parmakla kaydırma, "Büyüt" tam ekran açar.
6. **Hisse detayı:** Seçince alttan açılan tam ekran panel; grafik dokunmayla gezilir.
7. **Dokunma alanları:** Tüm düğmeler en az 44 px; arama kutusu üstte sabit ve tam genişlik.
8. **Test:** 360×800 ve 412×915 ekranlarda kontrol, ardından senin telefonunda Claude Android uygulaması ve Chrome ile deneme; Chrome'da "Ana ekrana ekle".

## 2. aşama — yalnızca 1. aşama yetmezse PWA

1. Supabase Auth (yalnızca senin e-postan) + tüm swing_* tablolarına RLS.
2. Siteyi `api.ts` üzerinden MCP yerine Supabase JS istemcisiyle çalışacak şekilde ikinci bir "mod" ile derle.
3. Manifest + servis çalışanı (son tarama, portföy ve haberler önbellekte; çevrimdışı okunur).
4. Vercel'e yayın, telefona kurulum, simge = mevcut logo.

## Bilinçli olarak dışarıda bırakılanlar
- Otomatik tarama ya da arka planda çalışan bot (kural: taramalar yalnızca istekle).
- Push bildirimleri (istenirse 2. aşamadan sonra, yalnızca senin başlattığın taramaların sonucu için).
