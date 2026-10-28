/*! waform v0.1.1 | Webflow form to WhatsApp | MIT License */
/*
 * waform turns any Webflow form into a WhatsApp conversation.
 *
 * How it works
 *   1. The visitor submits a Webflow form as usual.
 *   2. The form still submits to Webflow (so email notifications and the
 *      Forms tab keep working) unless you set data-wa-submit="false".
 *   3. waform builds a message from the fields, using your template, and
 *      opens WhatsApp (wa.me) with the message pre-filled.
 *
 * Configuration (lowest to highest priority)
 *   window.WAFormConfig = { number: "...", template: "...", ... }
 *   script tag attributes: data-wa-number="..." data-wa-template="..." on the waform script element
 *   form attributes: <form data-wa-number="..." data-wa-template="..." ...>
 *
 * Options (attribute form in brackets)
 *   number      [data-wa-number]       WhatsApp number in international format, digits only, e.g. 905321234567
 *   template    [data-wa-template]     Message template. Placeholders: {all}, {field name}, {page}, {url}, {date}. Use \n for a line break.
 *   intro       [data-wa-intro]        Optional first line, e.g. "New website lead"
 *   mode        [data-wa-mode]         auto | redirect | newtab | button (default auto)
 *   submit      [data-wa-submit]       true | false. false skips the Webflow submission entirely (default true)
 *   buttonText  [data-wa-button-text]  Text of the fallback button shown in the success message
 *   buttonClass [data-wa-button-class] Use your own class for the button instead of the built-in style
 *   exclude     [data-wa-exclude]      Comma separated field names to leave out of {all}
 *   delay       [data-wa-delay]        Milliseconds to wait for the success state before continuing anyway (default 2500)
 *   desktop     [data-wa-desktop]      wa | web. Where desktop links go: wa.me (choose app or web) or straight to WhatsApp Web (default wa)
 *
 * Opt a single form out with data-wa="off".
 *
 * Modes
 *   auto      Mobile: open WhatsApp in the same tab after the form succeeds.
 *             Desktop: show a "Continue on WhatsApp" button in the success message, nothing opens on its own.
 *   redirect  Same tab after success, on every device.
 *   newtab    New tab right away (inside the click, so popup blockers allow it), plus the button.
 *   button    Only show the button in the success message, on every device.
 */
(function (window, document) {
  'use strict';

  if (!window || !document || window.WAForm) return;

  var VERSION = '0.1.1';

  var DEFAULTS = {
    number: '',
    template: '{all}',
    intro: '',
    mode: 'auto',
    submit: true,
    buttonText: 'Continue on WhatsApp',
    buttonClass: '',
    exclude: '',
    delay: 2500,
    desktop: 'wa'
  };

  var ATTR = {
    number: 'data-wa-number',
    template: 'data-wa-template',
    intro: 'data-wa-intro',
    mode: 'data-wa-mode',
    submit: 'data-wa-submit',
    buttonText: 'data-wa-button-text',
    buttonClass: 'data-wa-button-class',
    exclude: 'data-wa-exclude',
    delay: 'data-wa-delay',
    desktop: 'data-wa-desktop'
  };

  var SKIP_TYPES = { submit: 1, button: 1, reset: 1, image: 1, file: 1, hidden: 1, password: 1 };

  // Attributes placed on the <script> tag itself are read once at load time.
  var scriptConfig = {};
  var currentScript = document.currentScript;
  if (currentScript) {
    for (var key in ATTR) {
      if (currentScript.hasAttribute(ATTR[key])) {
        scriptConfig[key] = currentScript.getAttribute(ATTR[key]);
      }
    }
  }

  function warn() {
    if (window.console && console.warn) {
      console.warn.apply(console, ['[waform]'].concat([].slice.call(arguments)));
    }
  }

  function trim(s) {
    return String(s == null ? '' : s).replace(/^\s+|\s+$/g, '');
  }

  function norm(s) {
    return trim(s).toLowerCase().replace(/[^a-z0-9]+/g, '');
  }

  function toBool(v) {
    if (v === true || v === false) return v;
    var s = trim(v).toLowerCase();
    return !(s === 'false' || s === '0' || s === 'no' || s === 'off');
  }

  function cleanNumber(n) {
    return String(n == null ? '' : n).replace(/[^\d]/g, '');
  }

  function unescapeNewlines(s) {
    return String(s == null ? '' : s).replace(/\\n/g, '\n');
  }

  function isMobile() {
    var ua = navigator.userAgent || '';
    if (/Android|iPhone|iPad|iPod|Windows Phone|Mobile/i.test(ua)) return true;
    // iPadOS reports itself as a Mac but has touch points
    return /Macintosh/i.test(ua) && navigator.maxTouchPoints > 1;
  }

  function readConfig(form) {
    var cfg = {};
    var global = window.WAFormConfig || {};
    for (var key in DEFAULTS) {
      var value = DEFAULTS[key];
      if (global[key] != null) value = global[key];
      if (scriptConfig[key] != null) value = scriptConfig[key];
      if (form && form.hasAttribute(ATTR[key])) value = form.getAttribute(ATTR[key]);
      cfg[key] = value;
    }
    cfg.number = cleanNumber(cfg.number);
    cfg.template = unescapeNewlines(cfg.template || DEFAULTS.template);
    cfg.intro = unescapeNewlines(cfg.intro);
    cfg.mode = trim(cfg.mode).toLowerCase() || 'auto';
    cfg.submit = toBool(cfg.submit);
    cfg.delay = parseInt(cfg.delay, 10);
    if (isNaN(cfg.delay) || cfg.delay < 0) cfg.delay = DEFAULTS.delay;
    cfg.desktop = trim(cfg.desktop).toLowerCase() === 'web' ? 'web' : 'wa';
    return cfg;
  }

  function isVisible(el) {
    if (!el) return false;
    var style = window.getComputedStyle ? window.getComputedStyle(el) : el.style;
    return style.display !== 'none' && style.visibility !== 'hidden';
  }

  function labelFor(el, form) {
    var text = '';
    if (el.id) {
      var lab = form.querySelector('label[for="' + el.id.replace(/"/g, '\\"') + '"]');
      if (lab) text = lab.textContent;
    }
    if (!text) {
      var wrap = el.closest ? el.closest('label') : null;
      if (wrap) {
        var span = wrap.querySelector('.w-form-label');
        text = span ? span.textContent : wrap.textContent;
      }
    }
    text = trim(text).replace(/\s+/g, ' ').replace(/[\s:*]+$/, '');
    return text || trim(el.getAttribute('data-name')) || trim(el.getAttribute('placeholder')) || trim(el.name);
  }

  // Collects the visible, filled fields of a form.
  // Returns { fields: [{label, value, name}], map: {normalizedKey: value} }
  function collect(form, cfg) {
    var excluded = {};
    var ex = trim(cfg && cfg.exclude ? cfg.exclude : '').split(',');
    for (var i = 0; i < ex.length; i++) if (norm(ex[i])) excluded[norm(ex[i])] = 1;

    var fields = [];
    var index = {};
    var map = {};
    var els = form.querySelectorAll('input, textarea, select');

    for (var j = 0; j < els.length; j++) {
      var el = els[j];
      var type = (el.type || '').toLowerCase();
      var tag = el.tagName.toLowerCase();
      if (SKIP_TYPES[type]) continue;

      var name = el.name || el.getAttribute('data-name');
      if (!name) continue;
      var dataName = el.getAttribute('data-name') || '';
      if (excluded[norm(name)] || (dataName && excluded[norm(dataName)])) continue;

      var value;
      if (type === 'checkbox') {
        if (!el.checked) continue;
        value = (el.value && el.value !== 'on') ? el.value : 'Yes';
      } else if (type === 'radio') {
        if (!el.checked) continue;
        value = el.value;
      } else if (tag === 'select') {
        var opt = el.options[el.selectedIndex];
        value = opt ? (opt.text || opt.value) : '';
        if (opt && opt.value === '') value = '';
      } else {
        value = el.value;
      }
      value = trim(value);
      if (!value) continue;

      var label = labelFor(el, form);
      var k = norm(name);
      if (index[k] != null) {
        // Several inputs with the same name (checkbox groups): join the values
        fields[index[k]].value += ', ' + value;
        value = fields[index[k]].value;
      } else {
        index[k] = fields.length;
        fields.push({ label: label, value: value, name: name });
      }
      map[k] = value;
      if (dataName) map[norm(dataName)] = value;
      if (label) map[norm(label)] = value;
    }
    return { fields: fields, map: map };
  }

  // Fills the template with the collected data.
  function build(cfg, data) {
    var text = String(cfg.template || DEFAULTS.template).replace(/\{([^{}]+)\}/g, function (m, raw) {
      var k = norm(raw);
      if (k === 'all') {
        var lines = [];
        for (var i = 0; i < data.fields.length; i++) {
          lines.push(data.fields[i].label + ': ' + data.fields[i].value);
        }
        return lines.join('\n');
      }
      if (k === 'url') return window.location.href;
      if (k === 'page') return document.title;
      if (k === 'date') return new Date().toLocaleString();
      return data.map[k] != null ? data.map[k] : '';
    });
    if (cfg.intro) text = cfg.intro + '\n' + text;
    return trim(text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n'));
  }

  // target: 'wa' (wa.me, works everywhere) or 'web' (straight to WhatsApp Web, desktop only)
  function link(number, text, target) {
    if (target === 'web') {
      return 'https://web.whatsapp.com/send?phone=' + cleanNumber(number) + '&text=' + encodeURIComponent(text);
    }
    return 'https://wa.me/' + cleanNumber(number) + '?text=' + encodeURIComponent(text);
  }

  function targetFor(cfg) {
    return (cfg.desktop === 'web' && !isMobile()) ? 'web' : 'wa';
  }

  function linkFor(form) {
    var cfg = readConfig(form);
    var data = collect(form, cfg);
    return link(cfg.number, build(cfg, data), targetFor(cfg));
  }

  function navigate(url) {
    window.location.href = url;
  }

  function openTab(url) {
    try {
      var w = window.open(url, '_blank');
      if (!w) return false;
      try { w.opener = null; } catch (err) {}
      return true;
    } catch (e) {
      return false;
    }
  }

  function wrapperOf(form) {
    var wrap = form.closest ? form.closest('.w-form') : null;
    return wrap || form.parentNode;
  }

  function injectButton(form, url, cfg) {
    var wrap = wrapperOf(form);
    if (!wrap) return;
    if (wrap.querySelector('.waform-button')) return;
    var done = wrap.querySelector('.w-form-done');
    var host = (done && isVisible(done)) ? done : wrap;
    var a = document.createElement('a');
    a.className = 'waform-button' + (cfg.buttonClass ? ' ' + cfg.buttonClass : '');
    a.href = url;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = cfg.buttonText || DEFAULTS.buttonText;
    if (!cfg.buttonClass) {
      a.setAttribute('style', 'display:inline-block;margin-top:12px;padding:12px 20px;border-radius:8px;background:#25D366;color:#fff;font-weight:600;text-decoration:none;line-height:1.2;');
    }
    host.appendChild(a);
  }

  // Runs cb once the Webflow success message becomes visible.
  // Falls back to a timer when no success element exists, and stays quiet when the form fails.
  function onSuccess(form, cfg, cb) {
    var wrap = wrapperOf(form);
    var done = wrap ? wrap.querySelector('.w-form-done') : null;
    var fail = wrap ? wrap.querySelector('.w-form-fail') : null;
    var fired = false;
    var observer = null;
    var timer = null;

    function finish() {
      if (fired) return;
      fired = true;
      if (observer) observer.disconnect();
      if (timer) clearTimeout(timer);
      cb();
    }

    function check() {
      if (fired) return;
      if (fail && isVisible(fail)) {
        fired = true;
        if (observer) observer.disconnect();
        if (timer) clearTimeout(timer);
        return;
      }
      if (done && isVisible(done)) finish();
    }

    if (done && window.MutationObserver) {
      observer = new MutationObserver(check);
      observer.observe(done, { attributes: true, attributeFilter: ['style', 'class'] });
      if (fail) observer.observe(fail, { attributes: true, attributeFilter: ['style', 'class'] });
      observer.observe(form, { attributes: true, attributeFilter: ['style', 'class'] });
    }
    timer = setTimeout(function () {
      if (fail && isVisible(fail)) return;
      finish();
    }, cfg.delay);
  }

  function dispatch(form, name, detail) {
    try {
      var ev;
      if (typeof window.CustomEvent === 'function') {
        ev = new CustomEvent(name, { bubbles: true, cancelable: true, detail: detail });
      } else {
        ev = document.createEvent('CustomEvent');
        ev.initCustomEvent(name, true, true, detail);
      }
      return form.dispatchEvent(ev);
    } catch (e) {
      return true;
    }
  }

  function handleSubmit(e) {
    var form = e.currentTarget || e.target;
    if (!form || form.getAttribute('data-wa') === 'off') return;

    var cfg = readConfig(form);
    if (!cfg.number || cfg.number.length < 8 || cfg.number.length > 15) {
      warn('No valid WhatsApp number for this form. Add data-wa-number or window.WAFormConfig.number.');
      return;
    }
    if (form.checkValidity && !form.checkValidity()) return;

    var data = collect(form, cfg);
    var text = build(cfg, data);
    var url = link(cfg.number, text, targetFor(cfg));

    // Listeners can inspect or cancel: form.addEventListener('waform:submit', e => e.preventDefault())
    if (!dispatch(form, 'waform:submit', { url: url, text: text, fields: data.fields, config: cfg })) return;

    var mode = cfg.mode;
    if (mode === 'auto') mode = isMobile() ? 'redirect' : 'button';

    if (!cfg.submit) {
      // Skip the Webflow submission entirely
      e.preventDefault();
      if (e.stopImmediatePropagation) e.stopImmediatePropagation();
      if (mode === 'redirect') {
        WAForm.navigate(url);
      } else if (!openTab(url)) {
        // Popup blocked: fall back to a same-tab redirect
        WAForm.navigate(url);
      }
      return;
    }

    if (mode === 'redirect') {
      onSuccess(form, cfg, function () { WAForm.navigate(url); });
      return;
    }
    if (mode === 'newtab') {
      openTab(url); // Inside the click, so browsers allow it
    }
    onSuccess(form, cfg, function () { injectButton(form, url, cfg); });
  }

  function bind(form) {
    if (form.getAttribute('data-waform-bound')) return;
    if (form.getAttribute('data-wa') === 'off') return;
    var cfg = readConfig(form);
    if (!cfg.number) return;
    form.setAttribute('data-waform-bound', '1');
    // Capture phase: runs before Webflow's own submit handler
    form.addEventListener('submit', handleSubmit, true);
  }

  function init(root) {
    var scope = root || document;
    var forms = scope.querySelectorAll('form');
    var bound = 0;
    for (var i = 0; i < forms.length; i++) {
      bind(forms[i]);
      if (forms[i].getAttribute('data-waform-bound')) bound++;
    }
    return bound;
  }

  var WAForm = {
    version: VERSION,
    init: init,
    collect: collect,
    build: build,
    link: link,
    linkFor: linkFor,
    readConfig: readConfig,
    navigate: navigate,
    isMobile: isMobile
  };
  window.WAForm = WAForm;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { init(); });
  } else {
    init();
  }
})(typeof window !== 'undefined' ? window : null, typeof document !== 'undefined' ? document : null);
