# Zanity Rapor Merkezi: Discord bağlantısı

`index.html` herkese açık olduğu için Discord webhook adresi bu dosyaya konulmaz. Form, aşağıdaki küçük API servisine gönderim yapar; API, webhook'u Render'daki gizli ortam değişkeninden okuyup Discord'a iletir.

## Discord mesajının görünümü

Her bildirim Discord'da tek bir embed olarak görünür:

- Başlık: `Yeni Zanity bildirimi · ZN-XXXXXX`
- Bildirim türü ve script adı
- Kısa başlık ve açıklama
- Tekrarlama adımları
- Beklenen sonuç
- İşletim sistemi / ortam
- Geri dönüş bilgisi (belirtilmişse)
- Gönderim zamanı

Discord mention'ları kapalıdır; formdaki `@everyone` benzeri yazılar rol/kişi ping'i oluşturmaz.

## Render kurulumu

Mevcut Render **Static Site**'ını koru; API için aynı GitHub deposundan ikinci bir servis oluştur:

1. Render Dashboard → **New** → **Web Service** → bu GitHub reposunu seç.
2. **Root Directory:** `api`
3. **Build Command:** `npm install` (bağımlılık yok; komut zararsızdır)
4. **Start Command:** `npm start`
5. Web Service → **Environment** bölümüne şunları ekle:
   - `DISCORD_WEBHOOK_URL` = Discord'da oluşturduğun webhook adresi
   - `ALLOWED_ORIGIN` = `https://reports.zanity.net`
6. Servis açılınca Render'ın verdiği `https://...onrender.com` adresinin sonuna `/api/report` ekle.
7. `index.html` içindeki `const API_ENDPOINT = "";` satırına bu tam API adresini yaz. API adresi herkese açık olabilir; **webhook adresi değildir** ve gizli tutulması gerekmez.

Örnek biçim (gerçek servis adresinle değiştir):

```js
const API_ENDPOINT = "https://zanity-reports-api.onrender.com/api/report";
```

## Güvenlik notları

- Webhook'u `index.html`, JavaScript, GitHub veya sohbete koyma. Yalnızca API Web Service'in Render **Environment** ayarında sakla.
- Formda şifre, token, webhook veya başka gizli bilgi istenmez.
- API giriş doğrulaması, 12 KB istek sınırı, gizli honeypot alanı ve örnek bir bellek içi istek sınırı içerir. Bu, temel spam azaltma önlemidir; yüksek trafikli/önemli bir destek sisteminde Cloudflare Turnstile gibi bot doğrulaması ve kalıcı rate-limit eklenmelidir.
- CORS, webhook'u gizlemez ve tek başına botları durdurmaz. Webhook'un korunması, yalnızca backend'de tutulmasından gelir.
- Webhook adresi yanlışlıkla yayımlandıysa Discord'dan eskisini silip yenisini oluştur.
