// Test runner for waform: simulates Webflow form markup in jsdom.
// Run: node test/run.js
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'waform.js'), 'utf8');

const WEBFLOW_FORM = `
<div class="w-form">
  <form id="email-form" name="email-form" data-name="Contact Form" method="get" class="form" data-wa-number="+90 532 123 45 67" data-wa-template="{all}">
    <label for="name">Full Name</label>
    <input class="w-input" name="name" data-name="Name" type="text" id="name">
    <label for="email">Email Address *</label>
    <input class="w-input" name="email" data-name="Email" type="email" id="email">
    <label for="treatment">Treatment</label>
    <select id="treatment" name="treatment" data-name="Treatment" class="w-select">
      <option value="">Select one...</option>
      <option value="veneers">Veneers</option>
      <option value="implants">Implants</option>
    </select>
    <label class="w-checkbox">
      <input type="checkbox" id="newsletter" name="newsletter" data-name="Newsletter" class="w-checkbox-input">
      <span class="w-form-label">Subscribe to newsletter</span>
    </label>
    <label for="message">Message</label>
    <textarea id="message" name="message" data-name="Message" class="w-input"></textarea>
    <input type="hidden" name="utm_source" value="google">
    <input type="submit" value="Submit" data-wait="Please wait..." class="w-button">
  </form>
  <div class="w-form-done"><div>Thank you! Your submission has been received!</div></div>
  <div class="w-form-fail"><div>Oops! Something went wrong while submitting the form.</div></div>
</div>`;

const CSS = `<style>.w-form-done,.w-form-fail{display:none}</style>`;

let passed = 0, failed = 0;
function assert(cond, msg) {
  if (cond) { passed++; console.log('  ok   ' + msg); }
  else { failed++; console.log('  FAIL ' + msg); }
}
function eq(a, b, msg) {
  assert(a === b, msg + (a === b ? '' : ` (got ${JSON.stringify(a)}, expected ${JSON.stringify(b)})`));
}
const tick = () => new Promise(r => setTimeout(r, 20));

async function makeDom({ ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120', config = null, html = WEBFLOW_FORM, scriptAttrs = '' } = {}) {
  const virtualConsole = new VirtualConsole();
  const warnings = [];
  virtualConsole.on('warn', (...a) => warnings.push(a.join(' ')));
  virtualConsole.on('jsdomError', () => {}); // ignore "not implemented: navigation"
  const dom = new JSDOM(`<!doctype html><html><head><title>Contact Us</title>${CSS}</head><body>${html}
    ${config ? `<script>window.WAFormConfig = ${JSON.stringify(config)};</script>` : ''}
    <script ${scriptAttrs}>${SRC}</script>
  </body></html>`, {
    runScripts: 'dangerously',
    url: 'https://example.com/contact',
    pretendToBeVisual: true,
    resources: { userAgent: ua },
    virtualConsole
  });
  dom.warnings = warnings;
  await tick(); // jsdom fires DOMContentLoaded asynchronously
  return dom;
}

function fill(doc) {
  doc.getElementById('name').value = 'Ayşe Yılmaz';
  doc.getElementById('email').value = 'ayse@example.com';
  doc.getElementById('treatment').value = 'implants';
  doc.getElementById('newsletter').checked = true;
  doc.getElementById('message').value = 'Hello, I would like a quote.';
}

function submit(form, win) {
  const ev = new win.Event('submit', { bubbles: true, cancelable: true });
  form.dispatchEvent(ev);
  return ev;
}

function decodeText(url) {
  return decodeURIComponent(url.split('?text=')[1]);
}

(async () => {
  console.log('1. Desktop, auto mode, Webflow submission kept');
  {
    const dom = await makeDom();
    const { window } = dom;
    const doc = window.document;
    let opened = null;
    window.open = (url) => { opened = url; return { opener: 1 }; };
    assert(window.WAForm && window.WAForm.version === '0.1.1', 'WAForm global is exposed');
    const form = doc.getElementById('email-form');
    eq(form.getAttribute('data-waform-bound'), '1', 'form is bound at load');
    fill(doc);
    const ev = submit(form, window);
    eq(ev.defaultPrevented, false, 'native/Webflow submission is not prevented');
    eq(opened, null, 'desktop auto mode opens nothing by itself');
    const expectedUrl = window.WAForm.linkFor(form);
    assert(expectedUrl.startsWith('https://wa.me/905321234567?text='), 'link uses the cleaned number');
    const text = decodeText(expectedUrl);
    eq(text, 'Full Name: Ayşe Yılmaz\nEmail Address: ayse@example.com\nTreatment: Implants\nSubscribe to newsletter: Yes\nMessage: Hello, I would like a quote.', '{all} lists labels and values, skips hidden, maps select text');
    eq(doc.querySelector('.waform-button'), null, 'no button before success');
    doc.querySelector('.w-form-done').style.display = 'block';
    await tick();
    const btn = doc.querySelector('.w-form-done .waform-button');
    assert(btn, 'button injected into success message');
    if (btn) {
      eq(btn.getAttribute('href'), expectedUrl, 'button links to the wa.me url');
      eq(btn.textContent, 'Continue on WhatsApp', 'default button text');
      eq(btn.getAttribute('target'), '_blank', 'button opens in a new tab');
    }
    doc.querySelector('.w-form-done').style.display = 'block';
    await tick();
    eq(doc.querySelectorAll('.waform-button').length, 1, 'button is injected only once');
  }

  console.log('2. Template placeholders, intro, exclude, global config and script attributes');
  {
    const html = WEBFLOW_FORM.replace(' data-wa-number="+90 532 123 45 67" data-wa-template="{all}"', '');
    const dom = await makeDom({
      html,
      config: { number: '44 7700 900123', template: 'Hi, I am {full name} ({Email}).\\nTreatment: {treatment}\\nPage: {page}\\n{url}', intro: 'New lead' },
      scriptAttrs: 'data-wa-exclude="newsletter, message" data-wa-button-text="Chat now"'
    });
    const { window } = dom;
    const doc = window.document;
    fill(doc);
    const form = doc.getElementById('email-form');
    const url = window.WAForm.linkFor(form);
    assert(url.startsWith('https://wa.me/447700900123?text='), 'number from window.WAFormConfig');
    eq(decodeText(url), 'New lead\nHi, I am Ayşe Yılmaz (ayse@example.com).\nTreatment: Implants\nPage: Contact Us\nhttps://example.com/contact', 'placeholders resolve by label, name or data-name, \\n becomes a line break, intro is prepended');
    const cfg = window.WAForm.readConfig(form);
    eq(cfg.exclude, 'newsletter, message', 'script tag attribute overrides global config');
    eq(cfg.buttonText, 'Chat now', 'script tag button text');
    const data = window.WAForm.collect(form, cfg);
    eq(data.fields.map(f => f.name).join(','), 'name,email,treatment', 'excluded fields are left out');
  }

  console.log('3. submit=false skips Webflow and opens WhatsApp right away (desktop)');
  {
    const dom = await makeDom({ scriptAttrs: 'data-wa-submit="false"' });
    const { window } = dom;
    const doc = window.document;
    let opened = null;
    window.open = (url) => { opened = url; return { opener: 1 }; };
    fill(doc);
    const form = doc.getElementById('email-form');
    let webflowHandlerRan = false;
    form.addEventListener('submit', () => { webflowHandlerRan = true; });
    const ev = submit(form, window);
    eq(ev.defaultPrevented, true, 'default prevented');
    eq(webflowHandlerRan, false, 'later submit listeners do not run');
    assert(opened && opened.startsWith('https://wa.me/905321234567?text='), 'WhatsApp opened immediately');
  }

  console.log('4. Mobile, auto mode: same tab redirect after success');
  {
    const dom = await makeDom({ ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1' });
    const { window } = dom;
    const doc = window.document;
    let navigated = null, opened = null;
    window.WAForm.navigate = (url) => { navigated = url; };
    window.open = (url) => { opened = url; return {}; };
    assert(window.WAForm.isMobile(), 'iPhone detected as mobile');
    fill(doc);
    const form = doc.getElementById('email-form');
    submit(form, window);
    eq(opened, null, 'no new tab on mobile');
    eq(navigated, null, 'no redirect before success');
    doc.querySelector('.w-form-done').style.display = 'block';
    await tick();
    assert(navigated && navigated.startsWith('https://wa.me/905321234567?text='), 'redirect to wa.me after success');
  }

  console.log('5. Failure state: nothing happens, and the delay fallback respects failure');
  {
    const dom = await makeDom({ ua: 'Mozilla/5.0 (Linux; Android 14) Mobile', scriptAttrs: 'data-wa-delay="60"' });
    const { window } = dom;
    const doc = window.document;
    let navigated = null;
    window.WAForm.navigate = (url) => { navigated = url; };
    fill(doc);
    submit(doc.getElementById('email-form'), window);
    doc.querySelector('.w-form-fail').style.display = 'block';
    await new Promise(r => setTimeout(r, 120));
    eq(navigated, null, 'no redirect when the form fails');
  }

  console.log('6. Delay fallback fires when no success element exists');
  {
    const html = '<form id="plain" data-wa-number="905321234567" data-wa-mode="redirect" data-wa-delay="40"><input name="phone" id="phone"><input type="submit"></form>';
    const dom = await makeDom({ html });
    const { window } = dom;
    const doc = window.document;
    let navigated = null;
    window.WAForm.navigate = (url) => { navigated = url; };
    doc.getElementById('phone').value = '555';
    submit(doc.getElementById('plain'), window);
    await new Promise(r => setTimeout(r, 90));
    assert(navigated && decodeText(navigated) === 'phone: 555', 'fallback redirect after delay, label falls back to field name');
  }

  console.log('7. Button mode, custom class, opt-out and invalid number');
  {
    const html = WEBFLOW_FORM.replace('data-wa-template="{all}"', 'data-wa-template="{all}" data-wa-mode="button" data-wa-button-class="btn-primary"')
      + '<form id="off" data-wa="off" data-wa-number="905321234567"><input name="x"></form>'
      + '<form id="bad" data-wa-number="123"><input name="x"></form>';
    const dom = await makeDom({ html });
    const { window } = dom;
    const doc = window.document;
    let opened = null;
    window.open = (url) => { opened = url; return {}; };
    fill(doc);
    submit(doc.getElementById('email-form'), window);
    eq(opened, null, 'button mode opens nothing by itself');
    doc.querySelector('.w-form-done').style.display = 'block';
    await tick();
    const btn = doc.querySelector('.waform-button');
    assert(btn && btn.className === 'waform-button btn-primary' && !btn.getAttribute('style'), 'custom class used, no inline style');
    eq(doc.getElementById('off').getAttribute('data-waform-bound'), null, 'data-wa="off" form is not bound');
    doc.getElementById('bad').querySelector('input').value = 'a';
    submit(doc.getElementById('bad'), window);
    assert(dom.warnings.some(w => w.includes('No valid WhatsApp number')), 'short number logs a warning');
  }

  console.log('8. newtab mode opens right away; desktop=web targets WhatsApp Web on desktop only');
  {
    const dom = await makeDom({ scriptAttrs: 'data-wa-mode="newtab" data-wa-desktop="web"' });
    const { window } = dom;
    const doc = window.document;
    let opened = null;
    window.open = (url) => { opened = url; return { opener: 1 }; };
    fill(doc);
    submit(doc.getElementById('email-form'), window);
    assert(opened && opened.startsWith('https://web.whatsapp.com/send?phone=905321234567&text='), 'desktop newtab goes straight to WhatsApp Web');
    const mobile = await makeDom({ ua: 'Mozilla/5.0 (Linux; Android 14) Mobile', scriptAttrs: 'data-wa-desktop="web"' });
    fill(mobile.window.document);
    assert(mobile.window.WAForm.linkFor(mobile.window.document.getElementById('email-form')).startsWith('https://wa.me/'), 'mobile keeps wa.me even with desktop=web');
  }

  console.log('9. waform:submit event can cancel');
  {
    const dom = await makeDom();
    const { window } = dom;
    const doc = window.document;
    let opened = null;
    window.open = (url) => { opened = url; return {}; };
    const form = doc.getElementById('email-form');
    let detail = null;
    form.addEventListener('waform:submit', (e) => { detail = e.detail; e.preventDefault(); });
    fill(doc);
    submit(form, window);
    assert(detail && detail.fields.length === 5 && detail.url.startsWith('https://wa.me/'), 'event carries fields and url');
    eq(opened, null, 'cancelled event stops WhatsApp opening');
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
