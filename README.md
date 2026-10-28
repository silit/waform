# waform

Webflow formunu WhatsApp sohbetine çeviren tek bir script. Ziyaretçi formu doldurur, form yine Webflow'a gider (e-posta bildirimi, Forms sekmesi, entegrasyonlar bozulmaz), ardından WhatsApp cevaplar hazır yazılmış halde açılır.

- Backend yok, çerez yok, takip yok
- 6 KB (gzip 2,9 KB), herhangi bir sayıda form
- Mobilde WhatsApp'a geçiş, masaüstünde yeni sekme + başarı mesajında buton
- Ayarlar üç yerden: `window.WAFormConfig`, script tag attribute'ları, form attribute'ları

## Dosyalar

```
src/waform.js          okunabilir kaynak
dist/waform.min.js     CDN'den servis edilen dosya (terser), SRI hash ile kayıt edilir
api/[path].js          Marketplace uygulaması (Vercel serverless, Node 20, bağımlılık yok)
public/index.html      landing + snippet üretici ("Install on Webflow" butonu /auth'a gider)
public/privacy.html    gizlilik politikası (Marketplace zorunlu)
public/terms.html      kullanım şartları (Marketplace zorunlu)
public/logo-512.png    logo; assets/logo-900.png Marketplace yükleme boyutu
assets/listing.md      Marketplace formu için hazır metinler, kategori, inceleme notu
vercel.json            /auth, /callback, /setup, /install, /uninstall yönlendirmeleri
test/run.js            script testleri (31), test/app.js uygulama testleri (34, sahte Webflow API ile)
site/index.html        landing'in artifact önizleme sürümü
```

## Marketplace uygulaması nasıl çalışır

1. Kullanıcı `/auth`'a gelir (Marketplace "Install" butonu ya da landing). Webflow'un izin ekranına gider, siteleri seçer.
2. `/callback` kodu token'a çevirir; token sadece kullanıcının tarayıcısında, şifreli ve 1 saatlik bir cookie'de durur. Sunucuda hiçbir şey saklanmaz.
3. `/setup` izin verilen siteleri listeler, numara ve şablon formunu gösterir, kurulu olanın ayarlarını geri okur.
4. `/install` sitede `waform` adlı hosted script'i bir kez kaydeder (jsDelivr URL + sha384 integrity), site custom code listesine footer'a ekler (`data-wa-*` attribute'ları ayarları taşır, mevcut diğer script'lere dokunmaz), istenirse siteyi publish eder.
5. `/uninstall` sadece bizim satırı siler.

Gerekli ortam değişkenleri `.env.example` dosyasında. Scope'lar: `sites:read sites:write custom_code:read custom_code:write`.

## Kurulum (son kullanıcı)

1. Snippet'i Webflow'da Site settings > Custom code > Footer code alanına yapıştır, publish et.

```html
<script>
  window.WAFormConfig = {
    number: "905320000000",
    template: "Merhaba, web sitenizden yazıyorum.\n{all}"
  };
</script>
<script src="https://cdn.jsdelivr.net/gh/silit/waform@0.1.0/dist/waform.min.js" defer></script>
```

2. Farklı numara isteyen forma, form elementine custom attribute ekle: `data-wa-number` = `905321112233`. Formu devre dışı bırakmak için `data-wa` = `off`.
3. Yayındaki sitede test gönder.

## Attribute referansı

| Form attribute | Config key | Ne yapar | Varsayılan |
|---|---|---|---|
| `data-wa-number` | `number` | Ülke kodlu numara, rakam dışı karakterler temizlenir | yok, zorunlu |
| `data-wa-template` | `template` | Mesaj şablonu. `{all}`, `{alan adı}`, `{page}`, `{url}`, `{date}`. Attribute içinde satır sonu için `\n` | `{all}` |
| `data-wa-intro` | `intro` | Şablonun üstüne eklenen ilk satır | boş |
| `data-wa-mode` | `mode` | `auto`, `redirect`, `newtab`, `button` | `auto` |
| `data-wa-submit` | `submit` | `false`: Webflow gönderimini atla, WhatsApp'ı anında aç | `true` |
| `data-wa-button-text` | `buttonText` | Başarı mesajındaki butonun yazısı | Continue on WhatsApp |
| `data-wa-button-class` | `buttonClass` | Kendi class'ın, yerleşik yeşil stil kalkar | boş |
| `data-wa-exclude` | `exclude` | `{all}` dışında bırakılacak alanlar, virgülle | boş |
| `data-wa-delay` | `delay` | Başarı mesajı gelmezse kaç ms sonra yine de devam edilsin | 2500 |

Öncelik, düşükten yükseğe: `window.WAFormConfig` < script tag attribute < form attribute.

Placeholder eşleşmesi alan adını (Webflow'daki Name ayarı), `data-name`'i veya label metnini kullanır; büyük/küçük harf, boşluk ve tire fark etmez: `{Full Name}`, `{full-name}`, `{fullname}` aynıdır.

## Davranış detayları

- Script, form elementine capture fazında submit dinleyicisi bağlar; Webflow'un kendi handler'ından önce çalışır. `submit=true` iken Webflow gönderimi aynen devam eder, başarı mesajı (`.w-form-done`) görünür olunca WhatsApp adımı tetiklenir. `.w-form-fail` görünürse hiçbir şey olmaz.
- `auto` modu: mobilde başarı sonrası aynı sekmede `wa.me` yönlendirmesi; masaüstünde tıklama anında yeni sekme (popup engeline takılmaz) ve ek olarak başarı mesajında buton.
- iPhone'da Safari, kullanıcı tıklaması dışında yapılan yönlendirmede önce wa.me sayfasını gösterip "Continue to chat" butonu çıkarabilir (bir ekstra dokunuş). Anında geçiş isteyen müşteri için `data-wa-submit="false"`.
- Checkbox: işaretliyse değeri, değer yoksa "Yes". Aynı isimli checkbox grubu virgülle birleşir. Select: seçili seçeneğin metni. `hidden`, `password`, `file` alanları hiç alınmaz.
- Koddan müdahale: form üzerinde `waform:submit` event'i (`detail.url`, `detail.text`, `detail.fields`), `preventDefault()` iptal eder. `WAForm.linkFor(form)` linki döner, `WAForm.init()` sonradan eklenen formları bağlar.

## Geliştirme

```
npm install
npm test            # script + uygulama testleri
npm run build       # dist/ üretir (sürüm değişince WAFORM_VERSION ve URL'yi de güncelle)
npm run logo        # assets/logo.svg'den PNG'leri üretir
```

Vercel'de yerel çalıştırmak için `npx vercel dev` (Vercel CLI girişi gerekir); testler için gerekmez.

Kaynak dosyada asla `</script>` geçmemeli (inline kullanımda tag'i kapatır).

## Yayına alma adımları

1. **GitHub:** public `waform` repo'su, bu klasör push, `v0.1.0` tag'i. jsDelivr: `https://cdn.jsdelivr.net/gh/silit/waform@0.1.0/dist/waform.min.js`. Bu URL'yi `.env.example`'daki `WAFORM_SCRIPT_URL`, `public/index.html`'deki Script URL alanı ve `api/[path].js` varsayılanına yaz.
2. **Webflow uygulama kaydı:** kendi workspace'inde Apps & Integrations > App Development > Create an App. Building blocks: Data Client; Redirect URI `https://<vercel-adresi>/callback`; scope'lar `sites:read sites:write custom_code:read custom_code:write`. Client ID ve Secret'ı al (secret bir kez gösterilir).
3. **Vercel:** GitHub ile giriş, "Import" ile repo'yu seç, deploy. Settings > Environment Variables'a `.env.example`'daki değişkenleri gir, Redeploy. Adresi Webflow'daki Redirect URI ile birebir eşle.
4. **Test:** `https://<vercel-adresi>/auth` → test siteni seç → numara gir → Install → yayındaki sitede form gönder.
5. **Marketplace:** `assets/listing.md`'deki metinler, `assets/logo-900.png`, 3-5 ekran görüntüsü (1280x846), privacy ve terms adresleri; form: https://developers.webflow.com/submit
6. **Sonraki sürüm:** Pro katmanı (Paddle abonelik): Webflow form webhook'u ile işletme sahibine Telegram/WhatsApp bildirimi ve Google Sheets kaydı.

## Lisans

MIT. WhatsApp ve Webflow ile bir bağı yoktur; isimleri kendi sahiplerinin markasıdır.
