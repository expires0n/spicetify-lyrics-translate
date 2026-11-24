# Lyrics Translate

<p align="center">
  <img src="assets/logo.png" alt="Lyrics Translate logosu" width="420">
</p>

Spotify'daki şarkı sözlerinin hemen altına çevirisini gösteren bir [Spicetify](https://spicetify.app) eklentisi.

[English README](README.md)

> **Durum: deneysel.** Proje hâlâ geliştiriliyor ve tam kararlı değil. Sözler Spotify'ın dahili uç noktalarından geliyor, Google Translate resmi olmayan bir uç nokta kullanıyor ve yapay zekâ çevirisi senin kendi sunucuna ve API anahtarlarına bağlı. Bunlardan biri güncellenirse bir şeyler bozulabilir. Sorun görürsen Issues sekmesinden bildir.

## Özellikler

- Çeviri her söz satırının altında görünür.
- Çeviri sağlayıcısını seçebilirsin:
  - **Google Translate**: varsayılan, API anahtarı gerekmez (resmi değil, aşağıya bak).
  - **DeepL**: kendi API anahtarın ve bu repodaki küçük yerel proxy.
  - **Yapay zekâ çevirisi**: kendi `llm-proxy.mjs` sunucun; Gemini 3.8 Flash, Gemini 3.5 Flash, Groq üzerinde Qwen veya GPT-OSS 120B. Modeli sen seçebilir ya da sunucuya bırakabilirsin.
- Hedef ve kaynak dili seçebilirsin. Dil kodları her sağlayıcı için otomatik çevrilir.
- Çalma çubuğunda, Spotify'ın sözler butonunun yanında bir küre butonu çıkar:
  - Sol tık: çeviriyi aç/kapat.
  - Sağ tık: ayarları aç.
- Seçtiğin sağlayıcı çalışmazsa (anahtar yok, proxy kapalı, sunucuya ulaşılamıyor, hata ya da kota bitti) o istek Google ile çevrilir ve sebebi gösterilir.
- Çeviriler şarkı başına önbelleğe alınır, aynı şarkı iki kez çevrilmez.
- Google istekleri sınırlarsa eklenti sürekli denemek yerine Google'ı giderek uzayan bir süre bekletir. Yapay zekâ sunucusu ayarlıysa bu sürede çeviriyi o yapar.

## Gereksinimler

- Spotify'da kurulu ve çalışan Spicetify.
- DeepL veya yapay zekâ sunucusu için Node.js 18 ya da üstü. Google Translate için gerekmez.

## Kurulum

1. `lyrics-translate.js` dosyasını Spicetify eklenti klasörüne kopyala:
   - Windows: `%appdata%\spicetify\Extensions\`
   - Linux/macOS: `~/.config/spicetify/Extensions/`
2. Terminalde çalıştır:

   ```sh
   spicetify config extensions lyrics-translate.js
   spicetify apply
   ```

3. Spotify'ı yeniden başlat.

## Sağlayıcılar kısaca

| Sağlayıcı | Anahtar | Kurulum | Ücretsiz kullanım |
| --- | --- | --- | --- |
| Google Translate | Gerekmez | Yok | Resmi olmayan uç nokta, sınırlanabilir veya engellenebilir |
| DeepL | Gerekir (DeepL API anahtarı) | Yerel proxy (Node.js) | Ayda 500.000 karakter |
| Yapay zekâ çevirisi | Gerekir (Gemini ve/veya Groq) | Kendi `llm-proxy.mjs` sunucun (Node.js) | Google AI Studio ve Groq'un ücretsiz katmanları |

## Google Translate (varsayılan, anahtarsız)

Eklenti, Google'ın çeviri widget'ının kullandığı resmi olmayan uç noktayı (`translate.googleapis.com`) kullanır:

- Anahtar ve kurulum gerektirmez. Diğer tüm sağlayıcıların yedeği de budur.
- **Resmi bir API değildir.** Google bunu üçüncü taraf kullanımı için desteklemez ve her an değiştirebilir veya engelleyebilir.
- Yoğun kullanımda Google istekleri sınırlar (HTTP 429). Eklenti bunu azaltmak için bir şarkının tamamını (en fazla 120 satır veya 5.000 karakter) tek istekte gönderir, Google satırları birleştirirse satır satır istek atmak yerine grubu ikiye böler ve sonuçları önbelleğe alır. Kısa sürede çok şarkı açarsan yine de bir süre engellenebilirsin.
- Google engellediğinde tarayıcı sadece **"Failed to fetch"** gösterir, çünkü engellenen cevapta durum kodunu okumaya yarayan başlık yoktur.
- Eklenti bu durumda Google'ı bekletir: ilk engelde 2 dakika, sonra 4, 8, 16 ve en fazla 30 dakika. Kalan süre hata mesajında yazar. Süre Spotify'ın yerel depolamasında tutulur, yani **Spotify'ı yeniden başlatmak süreyi sıfırlamaz**.
- Ayarlara bir yapay zekâ sunucu adresi de girersen, Google Translate seçili olsa bile Google engelliyken çeviriyi yapay zekâ sunucusu yapar.
- Daha güvenilir çeviri için DeepL'i veya kendi anahtarınla yapay zekâ sunucusunu kullan.

## DeepL (API anahtarı + yerel proxy)

Tarayıcılar web sayfalarının DeepL API'sini doğrudan çağırmasına izin vermez (CORS). Bu yüzden eklenti istekleri bilgisayarında çalışan küçük bir proxy'ye, `deepl-proxy.mjs`'e gönderir. Proxy anahtarını ekleyip isteği DeepL'e iletir; anahtarını kaydetmez veya loglamaz.

1. https://www.deepl.com/pro-api adresinden **DeepL API hesabı aç**. Ücretsiz plan ayda 500.000 karakter verir. DeepL Pro (normal kullanıcı) hesabındaki anahtarlar API'de çalışmaz.
2. **Anahtarını kopyala**: https://www.deepl.com/your-account/keys ("API Keys" sekmesi).
   - Ücretsiz plan anahtarları `:fx` ile biter ve otomatik olarak `api-free.deepl.com`'a gider.
   - Ücretli anahtarlar `api.deepl.com`'a gider.
3. https://nodejs.org adresinden **Node.js 18 veya üstünü kur**. `node --version` ile kontrol et.
4. **Proxy'yi başlat.** `deepl-proxy.mjs` dosyasının olduğu klasörde terminal aç:

   ```sh
   node deepl-proxy.mjs
   ```

   `DeepL proxy is running: http://127.0.0.1:8787` yazısını görmelisin. DeepL kullandığın sürece bu pencere açık kalsın.

5. **Eklentiyi ayarla.** Küre butonuna sağ tıkla, **Translation provider** olarak **DeepL** seç, anahtarı **DeepL API key** alanına yapıştır ve **Save**'e bas. Proxy'yi başka portta başlatmadıysan adres `http://127.0.0.1:8787` olarak kalabilir.
6. Sözleri olan bir şarkı aç ve küre butonuna sol tıkla.

## Yapay zekâ çevirisi (kendi sunucun)

Yapay zekâ sağlayıcısı şarkının tamamını bağımlılıksız bir Node.js sunucusu olan `llm-proxy.mjs`'e gönderir. Sunucu modelden her satır için bir çeviri ister, modelleri sırayla dener ve ilk eksiksiz cevabı döndürür. Hiçbiri çalışmazsa eklenti Google'a düşer.

Sunucuda dört model hazır, bu sırayla denenir:

- **Gemini 3.8 Flash**: `gemini-3.8-flash`, Google AI Studio anahtarıyla.
- **Gemini 3.5 Flash**: `gemini-3.5-flash`, aynı anahtarla. Her modelin kendi kotası olduğu için 3.8 Flash'ın ücretsiz hakkı bitince devreye girer.
- **Qwen**: `qwen/qwen3.8-27b`, Groq anahtarıyla.
- **GPT-OSS**: `openai/gpt-oss-120b`, Groq anahtarıyla.

Sırayı `MODEL_ORDER` belirler, varsayılanı `gemini,gemini35,groq,gptoss`. `MODEL_ORDER`'a `gemma` eklersen Gemma (`gemma-4-31b-it`) da kullanılır.

### Çeviri kalitesi

Sunucunun modele verdiği talimat şarkı çevirisi için özel yazıldı:

- Model önce şarkının tamamını okur; kimin konuştuğunu, kime hitap edildiğini ve havayı çözdükten sonra çevirir.
- Kelimesi kelimesine değil, anlamı ve duyguyu çevirir.
- Rap ve hip-hop'ta argo, hedef dildeki aynı tondaki argoyla çevrilir; küfür ve sert ifadeler yumuşatılmaz. N-word olduğu gibi bırakılır.
- Japonca için ayrı kurallar var: düşen özneler, birkaç satıra yayılan cümleler, yansıma kelimeler, katakana ile yazılmış yabancı kelimeler ve romaji. Korece ve Çince için de kısa notlar var.
- Eklenti şarkı adını, sanatçıyı ve Spotify'ın bildirdiği söz dilini ipucu olarak gönderir.

### API anahtarlarını al

- Gemini anahtarı: https://aistudio.google.com/apikey
- Groq anahtarı: https://console.groq.com/keys

En az bir anahtar yeterli. `GEMINI_API_KEY` iki Gemini modelini ve Gemma'yı, `GROQ_API_KEY` Qwen ve GPT-OSS'u açar.

### Sunucuyu kendi bilgisayarında çalıştır

1. `llm-proxy.mjs` dosyasının olduğu klasörde terminal aç.
2. Anahtarlarını ayarla ve sunucuyu başlat:

   ```powershell
   $env:GEMINI_API_KEY="gemini_anahtarin"
   $env:GROQ_API_KEY="groq_anahtarin"
   node llm-proxy.mjs
   ```

   Linux veya macOS'ta aynı değişkenler için `export AD=deger` kullan.
3. `LLM proxy is running: http://127.0.0.1:8788` satırını gör. Altındaki satır hazır modelleri listeler.
4. Küre butonuna sağ tıkla, **AI translation** seç, sunucu adresine `http://127.0.0.1:8788` yaz ve **Save**'e bas.

### Sunucuyu internete aç (Render)

Render aynı dosyayı değiştirmeden çalıştırır. Bir web service oluştur, başlatma komutunu `node llm-proxy.mjs` yap, anahtarları ekle ve servisi açmadan önce **`ACCESS_TOKEN`** ayarla. Render `PORT` değişkenini kendisi verir, sunucu da `0.0.0.0` üzerinde dinler.

- `GET /health`, iki anahtar da ayarlıysa `{"ok":true,"models":["gemini","gemini35","groq","gptoss"]}` döner. Liste boşsa hiç anahtar ayarlanmamış demektir.
- Render'ın ücretsiz planı 15 dakika istek gelmezse uyur. Eklenti şarkı değiştiğinde (en fazla 5 dakikada bir) sağlık isteği atar, böylece müzik çalarken sunucu uyanık kalır. Uykudan sonraki ilk istek yaklaşık bir dakika sürebilir.
- Sunucudaki `ACCESS_TOKEN` değerini eklentideki **AI access token** alanına da yapıştır. Token olmadan adresi bilen herkes kotanı harcayabilir.
- `ALLOWED_ORIGIN` CORS ayarıdır. Varsayılan `*` tüm Spotify kaynaklarında çalışır.

### İstek sınırları

| Sınır | Değer |
| --- | --- |
| İstek başına satır | 400 |
| Satır başına karakter | 500 |
| Toplam karakter | 20.000 |
| IP adresi başına istek | 10 dakikada 40 |
| Zaman aşımı | Toplam 40 sn, model başına 20 sn |

Bir sağlayıcı sınırladığında (HTTP 429) o model 60 saniye, hata günlük kotadan bahsediyorsa bir saat bekletilir ve sıradaki model denenir. Eksik veya boş satır içeren cevap başarısız sayılır. Tüm değişkenler `llm-proxy.mjs`'in en üstündeki yorumlarda yazıyor.

### Model seçimi

**AI model** ayarının beş seçeneği var:

- **Auto**: sunucunun sırasını kullanır.
- **Gemini 3.8 Flash**, **Gemini 3.5 Flash**, **Qwen (Groq)** ve **GPT-OSS (Groq)**: o modelle başlar, olmazsa diğerlerine geçer.

Modeli değiştirmek kayıtlı çevirileri silmez. Çalan şarkıyı yenilemek için **Re-translate this song**'a bas.

## Güvenlik

- API anahtarları Spicetify üzerinden Spotify'ın yerel depolamasında tutulur, bu repodaki dosyalara yazılmaz. Repoya anahtar ekleme.
- DeepL proxy'si sadece `127.0.0.1` üzerinde dinler.
- Yapay zekâ sunucusu yerelde `127.0.0.1` üzerinde dinler. İnternete açmadan önce `ACCESS_TOKEN` ayarla.
- Çevrilen metin seçtiğin sağlayıcıya, yedeğe düşüldüğünde de Google'a gider. Yapay zekâ çevirisinde sözler önce sunucuna, sonra Google'a (Gemini, Gemma) veya Groq'a (Qwen, GPT-OSS) gider.

## Bilinen sınırlamalar

- Sözler Spotify'ın dahili ve belgelenmemiş uç noktasından geliyor. Spotify değiştirirse çalışmayabilir.
- Çeviriler Spotify'ın sayfa öğelerine metinle eşleştiriliyor. Arayüz değişiklikleri bunu bozabilir.
- Google Translate uç noktası resmi değil ve her an sınırlanabilir veya engellenebilir.
- Yapay zekâ çevirisinin kalitesi modele ve şarkıya göre değişir.

## Sorun giderme

- **Çeviri butonu yok:** `spicetify apply` çalıştır ve Spotify'ı yeniden başlat.
- **Sözlerin altında çeviri yok:** sözler görünümünü aç ve çevirinin açık olduğundan emin ol.
- **"Failed to fetch" veya "Google is not responding right now":** Google bağlantını sınırlıyor. Mesajdaki süreyi bekle ya da bir yapay zekâ sunucu adresi gir.
- **"Could not reach the DeepL proxy":** `node deepl-proxy.mjs` çalıştır ve penceresini açık tut.
- **"DeepL error":** anahtarın DeepL API hesabından olduğunu ve aylık kotanın bitmediğini kontrol et.
- **"Could not reach the AI server":** `node llm-proxy.mjs`'in çalıştığını, adresin doğru olduğunu ve token'ın `ACCESS_TOKEN` ile aynı olduğunu kontrol et.
- **"AI server error":** sunucu loguna bak. Genelde yanlış anahtar veya biten kota yazar. `GET /health` çalışan modelleri gösterir.
- **İlk yapay zekâ çevirisi bir dakika sürüyor:** Render'daki ücretsiz sunucu uyuyordu.
- **Eklentiyi güncelledikten sonra:** tekrar `spicetify apply` çalıştır ve Spotify'ı yeniden başlat.
- **Spotify güncellemesi eklentiyi bozduysa:** `spicetify restore backup apply` çalıştır.

## Değişiklik günlüğü

Önemli değişiklikler için [CHANGELOG.md](CHANGELOG.md) dosyasına bak.
