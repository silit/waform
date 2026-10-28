'use strict';
// Turns a Webflow form_submission payload into a lead and a WhatsApp alert text.

const NAME_KEYS = ['name', 'fullname', 'firstname', 'isim', 'adsoyad', 'ad', 'adiniz', 'adsoyadiniz'];
const PHONE_KEYS = ['phone', 'phonenumber', 'tel', 'telefon', 'mobile', 'whatsapp', 'gsm', 'cep', 'telefonnumaraniz', 'numara'];
const EMAIL_KEYS = ['email', 'emailaddress', 'eposta', 'mail', 'epostaadresiniz'];
const MESSAGE_KEYS = ['message', 'mesaj', 'mesajiniz', 'note', 'notes', 'not', 'comment', 'comments', 'details', 'aciklama', 'yourmessage'];

function norm(s) {
  return String(s || '').toLowerCase()
    .replace(/ı/g, 'i').replace(/ş/g, 's').replace(/ğ/g, 'g').replace(/ç/g, 'c').replace(/ö/g, 'o').replace(/ü/g, 'u')
    .replace(/[^a-z0-9]+/g, '');
}

function digits(s) { return String(s || '').replace(/[^\d]/g, ''); }

// Normalises a phone entered by a visitor into international digits where possible.
// defaultCountry is the owner's country calling code (digits), used for local numbers.
function phoneDigits(raw, defaultCountry) {
  let d = digits(raw);
  if (!d) return '';
  const hasPlus = /^\s*\+/.test(String(raw || ''));
  if (hasPlus) return d;
  if (d.startsWith('00')) return d.slice(2);
  if (defaultCountry && d.startsWith('0')) return defaultCountry + d.slice(1);
  if (defaultCountry && d.length <= 10 && !d.startsWith(defaultCountry)) return defaultCountry + d;
  return d;
}

function pick(data, keys) {
  for (const k of Object.keys(data)) {
    const n = norm(k);
    if (keys.some((key) => n === key || n.startsWith(key))) return { key: k, value: String(data[k] == null ? '' : data[k]).trim() };
  }
  return null;
}

// payload: the "payload" object of a form_submission webhook. site: stored site config.
function leadFrom(payload, site) {
  const data = (payload && payload.data) || {};
  const found = {};
  const used = new Set();
  const name = pick(data, NAME_KEYS); if (name) { found.name = name.value; used.add(name.key); }
  const phone = pick(data, PHONE_KEYS); if (phone) { found.phone = phone.value; used.add(phone.key); }
  const email = pick(data, EMAIL_KEYS); if (email) { found.email = email.value; used.add(email.key); }
  const message = pick(data, MESSAGE_KEYS); if (message) { found.message = message.value; used.add(message.key); }
  const extra = [];
  for (const k of Object.keys(data)) {
    if (used.has(k)) continue;
    const v = String(data[k] == null ? '' : data[k]).trim();
    if (!v || v.length > 2000) continue;
    extra.push({ label: k, value: v });
  }
  const country = site && site.number ? countryCode(site.number) : '';
  const pd = found.phone ? phoneDigits(found.phone, country) : '';
  return {
    id: payload.id || '',
    site: (site && site.name) || payload.siteId || '',
    form: payload.name || 'Form',
    name: found.name || '',
    phone: found.phone || '',
    phoneDigits: pd.length >= 8 && pd.length <= 15 ? pd : '',
    email: found.email || '',
    message: found.message || '',
    extra,
    submittedAt: payload.submittedAt || new Date().toISOString(),
    source: ((site && site.domain) ? site.domain + ' · ' : '') + (payload.name || 'Form')
  };
}

// Very small country code guess from the owner's number: 1-3 leading digits that match common codes.
function countryCode(number) {
  const d = digits(number);
  const three = ['880', '886', '960', '961', '962', '963', '964', '965', '966', '967', '968', '970', '971', '972', '973', '974', '975', '976', '977', '992', '993', '994', '995', '996', '998', '351', '352', '353', '354', '355', '356', '357', '358', '359', '370', '371', '372', '373', '374', '375', '376', '377', '378', '380', '381', '382', '383', '385', '386', '387', '389', '420', '421', '423', '212', '213', '216', '218', '220', '221', '222', '223', '224', '225', '226', '227', '228', '229', '230', '231', '232', '233', '234', '235', '236', '237', '238', '239', '240', '241', '242', '243', '244', '245', '246', '248', '249', '250', '251', '252', '253', '254', '255', '256', '257', '258', '260', '261', '262', '263', '264', '265', '266', '267', '268', '269', '290', '291', '297', '298', '299', '500', '501', '502', '503', '504', '505', '506', '507', '508', '509', '590', '591', '592', '593', '594', '595', '596', '597', '598', '599', '670', '672', '673', '674', '675', '676', '677', '678', '679', '680', '681', '682', '683', '685', '686', '687', '688', '689', '690', '691', '692', '850', '852', '853', '855', '856'];
  if (d.startsWith('1') || d.startsWith('7')) return d[0];
  if (three.includes(d.slice(0, 3))) return d.slice(0, 3);
  return d.slice(0, 2);
}

function replyLink(lead, greeting) {
  if (!lead.phoneDigits) return '';
  const text = String(greeting || 'Hi {name}, thanks for your message!').replace(/\{name\}/gi, lead.name || '').replace(/\s+,/g, ',').trim();
  return 'https://wa.me/' + lead.phoneDigits + '?text=' + encodeURIComponent(text);
}

function alertText(lead, site) {
  const lines = ['🟢 New lead: ' + (lead.site || 'your site')];
  if (lead.name) lines.push('Name: ' + lead.name);
  if (lead.phone) lines.push('Phone: ' + lead.phone);
  if (lead.email) lines.push('Email: ' + lead.email);
  if (lead.message) lines.push('Message: ' + lead.message);
  lead.extra.forEach((f) => lines.push(f.label + ': ' + f.value));
  lines.push('Form: ' + lead.form);
  const link = replyLink(lead, site && site.replyText);
  if (link) lines.push('', 'Reply on WhatsApp: ' + link);
  else if (lead.email) lines.push('', 'Reply by email: ' + lead.email);
  return lines.join('\n');
}

module.exports = { leadFrom, alertText, replyLink, phoneDigits, norm, countryCode };
