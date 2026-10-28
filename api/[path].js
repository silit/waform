/*
 * waform Marketplace app (Webflow Data Client)
 *
 * Routes (vercel.json rewrites /auth, /callback, /setup, /install, /uninstall, /logout, /health here)
 *   GET  /auth       start the Webflow OAuth flow
 *   GET  /callback   exchange the code for a token, keep it in an encrypted one-hour cookie
 *   GET  /setup      list the authorized sites and show the settings form
 *   POST /install    register the hosted script (once per site) and apply it with data-wa-* attributes
 *   POST /uninstall  remove the script from the site's custom code
 *   GET  /logout     drop the session cookie
 *   GET  /health     plain ok
 *
 * Nothing is stored server side. The token lives in the visitor's cookie, encrypted, for one hour.
 * Form submissions never touch this server: the script talks to WhatsApp and Webflow only.
 */
'use strict';

const crypto = require('crypto');

const ENV = {
  clientId: process.env.WEBFLOW_CLIENT_ID || '',
  clientSecret: process.env.WEBFLOW_CLIENT_SECRET || '',
  sessionSecret: process.env.SESSION_SECRET || '',
  appUrl: (process.env.APP_URL || '').replace(/\/+$/, ''),
  apiBase: (process.env.WEBFLOW_API_BASE || 'https://api.webflow.com').replace(/\/+$/, ''),
  authBase: (process.env.WEBFLOW_AUTH_BASE || 'https://webflow.com').replace(/\/+$/, ''),
  scriptUrl: process.env.WAFORM_SCRIPT_URL || 'https://cdn.jsdelivr.net/gh/silit/waform@0.1.0/dist/waform.min.js',
  scriptVersion: process.env.WAFORM_VERSION || '0.1.0',
  supportEmail: process.env.SUPPORT_EMAIL || ''
};

const SCOPES = ['sites:read', 'sites:write', 'custom_code:read', 'custom_code:write'];
const SCRIPT_NAME = 'waform';
const SESSION_TTL_MS = 60 * 60 * 1000;
const DEFAULT_BUTTON = 'Continue on WhatsApp';

/* ---------- small helpers ---------- */

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function fromB64url(s) {
  s = String(s).replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Buffer.from(s, 'base64');
}
function key() {
  if (!ENV.sessionSecret) throw new Error('SESSION_SECRET is not set');
  return crypto.createHash('sha256').update(ENV.sessionSecret).digest();
}
function seal(obj) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(obj), 'utf8'), cipher.final()]);
  return b64url(iv) + '.' + b64url(data) + '.' + b64url(cipher.getAuthTag());
}
function open(token) {
  try {
    const [iv, data, tag] = String(token).split('.');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key(), fromB64url(iv));
    decipher.setAuthTag(fromB64url(tag));
    const out = Buffer.concat([decipher.update(fromB64url(data)), decipher.final()]).toString('utf8');
    const obj = JSON.parse(out);
    if (!obj || !obj.exp || obj.exp < Date.now()) return null;
    return obj;
  } catch (e) {
    return null;
  }
}
function parseCookies(req) {
  const out = {};
  String(req.headers.cookie || '').split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}
function cookie(name, value, maxAgeSec) {
  const parts = [name + '=' + encodeURIComponent(value), 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Secure'];
  if (maxAgeSec != null) parts.push('Max-Age=' + maxAgeSec);
  return parts.join('; ');
}
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function digits(s) { return String(s || '').replace(/[^\d]/g, ''); }

function send(res, status, body, headers) {
  const h = Object.assign({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }, headers || {});
  res.statusCode = status;
  for (const k of Object.keys(h)) res.setHeader(k, h[k]);
  res.end(body);
}
function redirect(res, location, headers) {
  send(res, 302, '', Object.assign({ Location: location }, headers || {}));
}

async function readBody(req) {
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === 'object') return req.body;
    return Object.fromEntries(new URLSearchParams(String(req.body)));
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8');
  const type = String(req.headers['content-type'] || '');
  if (type.includes('application/json')) {
    try { return JSON.parse(raw); } catch (e) { return {}; }
  }
  return Object.fromEntries(new URLSearchParams(raw));
}

function routeOf(req) {
  if (req.query && req.query.path) return String(req.query.path);
  const u = new URL(req.url, 'http://local');
  return u.pathname.replace(/^\/(api\/)?/, '').split('/')[0];
}
function queryOf(req) {
  const u = new URL(req.url, 'http://local');
  const q = Object.fromEntries(u.searchParams);
  if (req.query) for (const k of Object.keys(req.query)) if (q[k] === undefined) q[k] = req.query[k];
  return q;
}

/* ---------- Webflow API ---------- */

async function wf(token, method, path, body) {
  const res = await fetch(ENV.apiBase + '/v2' + path, {
    method,
    headers: {
      Authorization: 'Bearer ' + token,
      Accept: 'application/json',
      'Content-Type': 'application/json'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = { raw: text }; }
  if (!res.ok) {
    const err = new Error((data && (data.message || data.msg || data.error)) || ('Webflow API error ' + res.status));
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

async function listSites(token) {
  const data = await wf(token, 'GET', '/sites');
  return (data && data.sites) || [];
}

async function integrityOf(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('Could not download the script from ' + url + ' (' + res.status + ')');
  const buf = Buffer.from(await res.arrayBuffer());
  return 'sha384-' + crypto.createHash('sha384').update(buf).digest('base64');
}

async function ensureRegistered(token, siteId) {
  const data = await wf(token, 'GET', '/sites/' + siteId + '/registered_scripts');
  const list = (data && data.registeredScripts) || [];
  // Same name and version means the same bytes, even if the CDN path changed (tag vs commit URL)
  const found = list.find((s) => s.displayName === SCRIPT_NAME && s.version === ENV.scriptVersion);
  if (found) return found;
  const integrityHash = await integrityOf(ENV.scriptUrl);
  return wf(token, 'POST', '/sites/' + siteId + '/registered_scripts/hosted', {
    hostedLocation: ENV.scriptUrl,
    integrityHash,
    version: ENV.scriptVersion,
    displayName: SCRIPT_NAME,
    canCopy: true
  });
}

async function getSiteScripts(token, siteId) {
  try {
    const data = await wf(token, 'GET', '/sites/' + siteId + '/custom_code');
    return (data && data.scripts) || [];
  } catch (e) {
    if (e.status === 404) return [];
    throw e;
  }
}

function isOurs(entry) {
  const id = String(entry.id || '').toLowerCase();
  return id === SCRIPT_NAME || id.replace(/[^a-z]/g, '') === SCRIPT_NAME;
}

function attributesFrom(cfg) {
  const attrs = { 'data-wa-number': cfg.number };
  if (cfg.template && cfg.template.trim() !== '{all}') attrs['data-wa-template'] = cfg.template.replace(/\r?\n/g, '\\n');
  if (cfg.intro) attrs['data-wa-intro'] = cfg.intro.replace(/\r?\n/g, '\\n');
  if (cfg.mode && cfg.mode !== 'auto') attrs['data-wa-mode'] = cfg.mode;
  if (cfg.buttonText && cfg.buttonText !== DEFAULT_BUTTON) attrs['data-wa-button-text'] = cfg.buttonText;
  if (cfg.exclude) attrs['data-wa-exclude'] = cfg.exclude;
  if (cfg.submit === false) attrs['data-wa-submit'] = 'false';
  return attrs;
}

function configFromAttributes(attrs) {
  attrs = attrs || {};
  return {
    number: attrs['data-wa-number'] || '',
    template: (attrs['data-wa-template'] || '{all}').replace(/\\n/g, '\n'),
    intro: (attrs['data-wa-intro'] || '').replace(/\\n/g, '\n'),
    mode: attrs['data-wa-mode'] || 'auto',
    buttonText: attrs['data-wa-button-text'] || DEFAULT_BUTTON,
    exclude: attrs['data-wa-exclude'] || '',
    submit: attrs['data-wa-submit'] !== 'false'
  };
}

async function applyToSite(token, siteId, cfg) {
  const script = await ensureRegistered(token, siteId);
  const existing = await getSiteScripts(token, siteId);
  const kept = existing.filter((s) => !isOurs(s)).map((s) => ({
    id: s.id, version: s.version, location: s.location || 'header', attributes: s.attributes || undefined
  }));
  kept.push({ id: script.id, version: script.version, location: 'footer', attributes: attributesFrom(cfg) });
  await wf(token, 'PUT', '/sites/' + siteId + '/custom_code', { scripts: kept });
  return script;
}

async function removeFromSite(token, siteId) {
  const existing = await getSiteScripts(token, siteId);
  const kept = existing.filter((s) => !isOurs(s)).map((s) => ({
    id: s.id, version: s.version, location: s.location || 'header', attributes: s.attributes || undefined
  }));
  await wf(token, 'PUT', '/sites/' + siteId + '/custom_code', { scripts: kept });
  return existing.length - kept.length;
}

async function publishSite(token, site) {
  const body = { publishToWebflowSubdomain: true };
  const domains = (site.customDomains || []).map((d) => d.id).filter(Boolean);
  if (domains.length) body.customDomains = domains;
  return wf(token, 'POST', '/sites/' + site.id + '/publish', body);
}

/* ---------- pages ---------- */

const CSS = `
:root{--bg:#f5f8f6;--surface:#fff;--fg:#14211b;--muted:#5d6f67;--line:#d7e0db;--accent:#15994d;--accent-ink:#fff;--bubble:#dcf8c6;--bubble-ink:#14211b;--chat:#e4ddd3;--warn:#b4530a}
@media(prefers-color-scheme:dark){:root{--bg:#0e1512;--surface:#162019;--fg:#e8efeb;--muted:#94a59c;--line:#28362f;--accent:#36d375;--accent-ink:#0a1a10;--bubble:#0f5a44;--bubble-ink:#e8efeb;--chat:#0b1310;--warn:#f0a35a;color-scheme:dark}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 Figtree,"Segoe UI",Helvetica,Arial,sans-serif;padding:0 max(16px,env(safe-area-inset-left)) 48px max(16px,env(safe-area-inset-right))}
.wrap{max-width:1040px;margin:0 auto}a{color:var(--accent)}h1,h2,h3{font-family:"Bricolage Grotesque",Arial,sans-serif;margin:0;line-height:1.1}h1{font-size:clamp(28px,4vw,40px)}h2{font-size:22px}h3{font-size:17px}p{margin:0}
.top{display:flex;justify-content:space-between;align-items:center;padding:18px 0;border-bottom:1px solid var(--line);margin-bottom:28px}.brand{font-family:"Bricolage Grotesque",Arial,sans-serif;font-weight:700;font-size:22px}.brand small{font-family:Figtree,sans-serif;font-weight:500;font-size:13px;color:var(--muted);margin-left:8px}.top a{font-size:14px;text-decoration:none;color:var(--fg)}
.grid{display:grid;grid-template-columns:minmax(0,5fr) minmax(0,5fr);gap:20px;align-items:start}@media(max-width:820px){.grid{grid-template-columns:1fr}}
.panel{background:var(--surface);border:1px solid var(--line);border-radius:14px;padding:22px;min-width:0}.panel+.panel{margin-top:20px}
.fields{display:grid;gap:14px}.field{display:grid;gap:6px}label{font-size:14px;font-weight:600}.hint{font-size:13px;color:var(--muted)}code{font-family:"JetBrains Mono",Menlo,Consolas,monospace;font-size:12.5px;background:var(--bg);padding:1px 5px;border-radius:4px}
input[type=text],input[type=tel],select,textarea{width:100%;font:inherit;font-size:15px;color:var(--fg);background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:10px 12px}textarea{font-family:"JetBrains Mono",Menlo,Consolas,monospace;font-size:13.5px;min-height:90px;resize:vertical}
.check{display:flex;gap:10px;align-items:flex-start;font-size:14px;font-weight:400}.check input{margin-top:3px;accent-color:var(--accent)}
.btn{font:inherit;font-weight:600;font-size:14px;border-radius:8px;padding:10px 16px;cursor:pointer;border:1px solid var(--line);background:var(--surface);color:var(--fg);text-decoration:none;display:inline-flex;gap:8px;align-items:center}.btn.primary{background:var(--accent);color:var(--accent-ink);border-color:var(--accent)}.btn.danger{color:var(--warn)}
.actions{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin-top:16px}.muted{color:var(--muted)}.small{font-size:13px}
.chat{background:var(--chat);border-radius:12px;padding:16px;display:grid;gap:8px;justify-items:end}.bubble{background:var(--bubble);color:var(--bubble-ink);border-radius:12px 2px 12px 12px;padding:9px 12px;max-width:92%;font-size:14.5px;white-space:pre-wrap;word-break:break-word}
.site{display:flex;gap:12px;align-items:center;padding:12px;border:1px solid var(--line);border-radius:10px;margin-bottom:8px}.site input{accent-color:var(--accent)}.site .meta{font-size:13px;color:var(--muted)}.pill{font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;border-radius:999px;padding:2px 8px;background:var(--bubble);color:var(--bubble-ink)}
.ok{border-left:4px solid var(--accent);padding-left:14px}.err{border-left:4px solid var(--warn);padding-left:14px}ol{padding-left:20px;display:grid;gap:8px;margin:0}
`;

function layout(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>${esc(title)}</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,700&family=Figtree:wght@400;500;600&family=JetBrains+Mono:wght@400&display=swap">
<style>${CSS}</style></head><body><div class="wrap">
<header class="top"><div class="brand">waform<small>for Webflow forms</small></div><nav><a href="/">Home</a> &nbsp; <a href="/logout">Sign out</a></nav></header>
${body}
<footer class="small muted" style="margin-top:40px;padding-top:16px;border-top:1px solid var(--line)">waform ${esc(ENV.scriptVersion)} &nbsp;·&nbsp; <a href="/privacy">Privacy</a> &nbsp;·&nbsp; <a href="/terms">Terms</a> &nbsp;·&nbsp; Not affiliated with WhatsApp or Webflow.</footer>
</div></body></html>`;
}

function errorPage(title, message, backHref) {
  return layout(title, `<div class="panel err"><h2>${esc(title)}</h2><p style="margin-top:8px">${esc(message)}</p>
<div class="actions"><a class="btn" href="${esc(backHref || '/setup')}">Back</a><a class="btn" href="/auth">Connect again</a></div></div>`);
}

function setupPage(sites, selectedId, cfg, notice) {
  const siteRows = sites.map((s) => {
    const installed = s._installed;
    return `<label class="site"><input type="radio" name="site_id" value="${esc(s.id)}" ${s.id === selectedId ? 'checked' : ''} required>
<div><div><strong>${esc(s.displayName || s.shortName)}</strong> ${installed ? '<span class="pill">installed</span>' : ''}</div>
<div class="meta">${esc((s.customDomains || []).map((d) => d.url).join(', ') || (s.shortName ? s.shortName + '.webflow.io' : ''))}</div></div></label>`;
  }).join('');

  const noSites = sites.length === 0 ? `<p class="muted">No site was authorized. Go back and allow at least one site.</p>` : '';

  return layout('Set up waform', `
${notice ? `<div class="panel ok" style="margin-bottom:20px">${notice}</div>` : ''}
<form method="post" action="/install" id="setup">
<div class="grid">
  <div>
    <div class="panel">
      <h2>1. Choose the site</h2>
      <p class="hint" style="margin:6px 0 14px">Only sites you allowed during sign in are listed.</p>
      ${siteRows}${noSites}
    </div>
    <div class="panel">
      <h2>2. WhatsApp settings</h2>
      <div class="fields" style="margin-top:14px">
        <div class="field"><label for="number">WhatsApp number</label><input type="tel" id="number" name="number" value="${esc(cfg.number)}" placeholder="905320000000" required><span class="hint">International format with country code. Spaces and + are fine.</span></div>
        <div class="field"><label for="template">Message template</label><textarea id="template" name="template" rows="4">${esc(cfg.template)}</textarea><span class="hint"><code>{all}</code> lists every filled field. Field names such as <code>{name}</code> or <code>{email}</code>, plus <code>{page}</code>, <code>{url}</code>, <code>{date}</code>.</span></div>
        <div class="field"><label for="intro">First line (optional)</label><input type="text" id="intro" name="intro" value="${esc(cfg.intro)}" placeholder="New lead from the website"></div>
        <div class="field"><label for="mode">Behaviour</label><select id="mode" name="mode">
          <option value="auto" ${cfg.mode === 'auto' ? 'selected' : ''}>Auto (recommended)</option>
          <option value="redirect" ${cfg.mode === 'redirect' ? 'selected' : ''}>Same tab, after the form succeeds</option>
          <option value="newtab" ${cfg.mode === 'newtab' ? 'selected' : ''}>New tab right away</option>
          <option value="button" ${cfg.mode === 'button' ? 'selected' : ''}>Button in the success message only</option>
        </select><span class="hint">Auto: phones go straight to WhatsApp, desktops open a new tab and get a button too.</span></div>
        <div class="field"><label for="button_text">Button text</label><input type="text" id="button_text" name="button_text" value="${esc(cfg.buttonText)}"></div>
        <div class="field"><label for="exclude">Fields to leave out of {all}</label><input type="text" id="exclude" name="exclude" value="${esc(cfg.exclude)}" placeholder="newsletter, privacy"></div>
        <label class="check"><input type="checkbox" name="submit" value="true" ${cfg.submit ? 'checked' : ''}> Keep the normal Webflow submission (email notifications, Forms tab). Untick for an instant jump with nothing stored in Webflow.</label>
        <label class="check"><input type="checkbox" name="publish" value="true" checked> Publish the site after installing, so it goes live right away.</label>
      </div>
    </div>
  </div>
  <div>
    <div class="panel">
      <h2>Message preview</h2>
      <p class="hint" style="margin:6px 0 14px">Example submission: Full Name, Email, Phone, Message.</p>
      <div class="chat"><div class="bubble" id="preview"></div></div>
      <div class="actions"><button class="btn primary" type="submit">Install on this site</button><span class="small muted">Adds one script to the site's footer. Nothing else changes.</span></div>
    </div>
    <div class="panel">
      <h3>Remove waform</h3>
      <p class="hint" style="margin:6px 0 12px">Removes the script from the selected site. Republish the site afterwards.</p>
      <button class="btn danger" type="submit" formaction="/uninstall" formnovalidate>Remove from the selected site</button>
    </div>
  </div>
</div>
</form>
<script>
(function(){
  var S=[['Full Name','Ayşe Yılmaz'],['Email','ayse@example.com'],['Phone','+90 532 000 00 00'],['Message','I would like a quote for two people.']];
  var A={name:'Full Name',fullname:'Full Name',email:'Email',emailaddress:'Email',phone:'Phone',phonenumber:'Phone',message:'Message'};
  function norm(s){return String(s||'').trim().toLowerCase().replace(/[^a-z0-9]+/g,'')}
  function $(id){return document.getElementById(id)}
  function render(){
    var ex={};String($('exclude').value||'').split(',').forEach(function(k){if(norm(k))ex[norm(k)]=1});
    var fields=S.filter(function(f){var k=norm(f[0]);if(ex[k])return false;for(var a in A)if(ex[a]&&A[a]===f[0])return false;return true});
    var map={};fields.forEach(function(f){map[norm(f[0])]=f[1]});for(var a in A)if(map[norm(A[a])]!=null)map[a]=map[norm(A[a])];
    var t=($('template').value||'{all}').replace(/\\{([^{}]+)\\}/g,function(m,raw){var k=norm(raw);if(k==='all')return fields.map(function(f){return f[0]+': '+f[1]}).join('\\n');if(k==='url')return 'https://yoursite.com/contact';if(k==='page')return 'Contact';if(k==='date')return new Date().toLocaleString();return map[k]!=null?map[k]:''});
    var intro=$('intro').value.trim();if(intro)t=intro+'\\n'+t;
    $('preview').textContent=t.replace(/\\n{3,}/g,'\\n\\n').trim()||'(empty message)';
  }
  ['template','intro','exclude'].forEach(function(id){$(id).addEventListener('input',render)});render();
})();
</script>`);
}

function donePage(site, published, cfg) {
  const domain = (site.customDomains && site.customDomains[0] && site.customDomains[0].url) || (site.shortName ? site.shortName + '.webflow.io' : '');
  return layout('waform installed', `
<div class="panel ok">
  <h2>Installed on ${esc(site.displayName || site.shortName)}</h2>
  <p style="margin-top:8px">${published ? 'The site was published, so it is live now.' : 'The script is added. Publish the site in Webflow to make it live.'}</p>
  <ol style="margin-top:16px">
    <li>Open ${domain ? '<a href="https://' + esc(domain) + '" target="_blank" rel="noopener">' + esc(domain) + '</a>' : 'the published site'} and submit any form once.</li>
    <li>Desktop opens a WhatsApp tab and shows a button in the success message. Phones jump to WhatsApp after Webflow confirms the submission.</li>
    <li>Check the message arrives at +${esc(cfg.number)} with the fields you expect.</li>
  </ol>
  <div class="actions"><a class="btn" href="/setup">Change settings or install on another site</a></div>
</div>`);
}

/* ---------- handlers ---------- */

async function handleAuth(req, res) {
  if (!ENV.clientId || !ENV.appUrl) return send(res, 500, errorPage('Not configured', 'WEBFLOW_CLIENT_ID and APP_URL must be set.', '/'));
  const state = b64url(crypto.randomBytes(16));
  const url = ENV.authBase + '/oauth/authorize?' + new URLSearchParams({
    response_type: 'code',
    client_id: ENV.clientId,
    redirect_uri: ENV.appUrl + '/callback',
    scope: SCOPES.join(' '),
    state
  }).toString();
  redirect(res, url, { 'Set-Cookie': cookie('wa_state', state, 600) });
}

async function handleCallback(req, res) {
  const q = queryOf(req);
  const cookies = parseCookies(req);
  if (q.error) return send(res, 400, errorPage('Authorization cancelled', String(q.error_description || q.error), '/'));
  if (!q.code) return send(res, 400, errorPage('Missing code', 'Webflow did not return an authorization code.', '/'));
  if (q.state && cookies.wa_state && q.state !== cookies.wa_state) {
    return send(res, 400, errorPage('State mismatch', 'The sign in request did not match. Start again.', '/'));
  }
  const tokenRes = await fetch(ENV.apiBase + '/oauth/access_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      client_id: ENV.clientId,
      client_secret: ENV.clientSecret,
      code: q.code,
      redirect_uri: ENV.appUrl + '/callback',
      grant_type: 'authorization_code'
    })
  });
  const tokenData = await tokenRes.json().catch(() => ({}));
  if (!tokenRes.ok || !tokenData.access_token) {
    return send(res, 400, errorPage('Could not sign in', (tokenData && (tokenData.error_description || tokenData.message)) || 'Webflow rejected the code. Start again.', '/'));
  }
  const session = seal({ t: tokenData.access_token, exp: Date.now() + SESSION_TTL_MS });
  res.setHeader('Set-Cookie', [cookie('wa_session', session, SESSION_TTL_MS / 1000), cookie('wa_state', '', 0)]);
  redirect(res, '/setup');
}

function sessionOf(req) {
  const cookies = parseCookies(req);
  return cookies.wa_session ? open(cookies.wa_session) : null;
}

async function loadSites(token) {
  const sites = await listSites(token);
  for (const s of sites) {
    try {
      const scripts = await getSiteScripts(token, s.id);
      const ours = scripts.find(isOurs);
      s._installed = !!ours;
      s._config = ours ? configFromAttributes(ours.attributes) : null;
    } catch (e) {
      s._installed = false;
    }
  }
  return sites;
}

async function handleSetup(req, res) {
  const session = sessionOf(req);
  if (!session) return redirect(res, '/auth');
  const q = queryOf(req);
  const sites = await loadSites(session.t);
  const selected = sites.find((s) => s.id === q.site) || sites.find((s) => s._installed) || sites[0];
  const cfg = (selected && selected._config) || configFromAttributes({});
  send(res, 200, setupPage(sites, selected ? selected.id : '', cfg, q.removed ? 'waform was removed. Publish the site to apply the change.' : ''));
}

async function handleInstall(req, res) {
  const session = sessionOf(req);
  if (!session) return redirect(res, '/auth');
  const body = await readBody(req);
  const cfg = {
    number: digits(body.number),
    template: String(body.template || '{all}').trim() || '{all}',
    intro: String(body.intro || '').trim(),
    mode: ['auto', 'redirect', 'newtab', 'button'].includes(body.mode) ? body.mode : 'auto',
    buttonText: String(body.button_text || '').trim() || DEFAULT_BUTTON,
    exclude: String(body.exclude || '').trim(),
    submit: body.submit === 'true' || body.submit === 'on'
  };
  if (!body.site_id) return send(res, 400, errorPage('Choose a site', 'Select the site to install on.'));
  if (cfg.number.length < 8 || cfg.number.length > 15) return send(res, 400, errorPage('Check the number', 'Enter 8 to 15 digits including the country code, for example 905320000000.'));

  const sites = await listSites(session.t);
  const site = sites.find((s) => s.id === body.site_id);
  if (!site) return send(res, 403, errorPage('Site not authorized', 'That site was not part of the sign in. Connect again and allow it.'));

  try {
    await applyToSite(session.t, site.id, cfg);
  } catch (e) {
    return send(res, 502, errorPage('Install failed', e.message || 'Webflow returned an error.'));
  }
  let published = false;
  if (body.publish === 'true' || body.publish === 'on') {
    try { await publishSite(session.t, site); published = true; } catch (e) { published = false; }
  }
  send(res, 200, donePage(site, published, cfg));
}

async function handleUninstall(req, res) {
  const session = sessionOf(req);
  if (!session) return redirect(res, '/auth');
  const body = await readBody(req);
  if (!body.site_id) return send(res, 400, errorPage('Choose a site', 'Select the site to remove waform from.'));
  const sites = await listSites(session.t);
  const site = sites.find((s) => s.id === body.site_id);
  if (!site) return send(res, 403, errorPage('Site not authorized', 'That site was not part of the sign in.'));
  try {
    await removeFromSite(session.t, site.id);
  } catch (e) {
    return send(res, 502, errorPage('Remove failed', e.message || 'Webflow returned an error.'));
  }
  redirect(res, '/setup?removed=1&site=' + encodeURIComponent(site.id));
}

function handleLogout(req, res) {
  res.setHeader('Set-Cookie', [cookie('wa_session', '', 0), cookie('wa_state', '', 0)]);
  redirect(res, '/');
}

module.exports = async function handler(req, res) {
  const route = routeOf(req);
  const method = (req.method || 'GET').toUpperCase();
  try {
    if (route === 'health') return send(res, 200, 'ok', { 'Content-Type': 'text/plain' });
    if (route === 'auth' && method === 'GET') return await handleAuth(req, res);
    if (route === 'callback' && method === 'GET') return await handleCallback(req, res);
    if (route === 'setup' && method === 'GET') return await handleSetup(req, res);
    if (route === 'install' && method === 'POST') return await handleInstall(req, res);
    if (route === 'uninstall' && method === 'POST') return await handleUninstall(req, res);
    if (route === 'logout') return handleLogout(req, res);
    return send(res, 404, errorPage('Not found', 'There is nothing at this address.', '/'));
  } catch (e) {
    console.error('[waform]', e && e.message);
    return send(res, 500, errorPage('Something went wrong', (e && e.message) || 'Unexpected error.', '/'));
  }
};

module.exports._internal = { seal, open, attributesFrom, configFromAttributes, isOurs, ENV, setupPage, donePage, errorPage };
