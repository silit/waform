// End-to-end test of the Marketplace app against a mock Webflow API.
// Run: node test/app.js
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

process.env.WEBFLOW_CLIENT_ID = 'cid_test';
process.env.WEBFLOW_CLIENT_SECRET = 'secret_test';
process.env.SESSION_SECRET = 'a-long-random-session-secret-for-tests';
process.env.APP_URL = 'https://app.test';

let passed = 0, failed = 0;
function assert(c, m) { if (c) { passed++; console.log('  ok   ' + m); } else { failed++; console.log('  FAIL ' + m); } }

// ---- mock Webflow ----
const SCRIPT_BYTES = fs.readFileSync(path.join(__dirname, '..', 'dist', 'waform.min.js'));
const mock = {
  tokens: new Set(),
  registered: {},         // siteId -> [scripts]
  customCode: { site_a: { scripts: [{ id: 'hotjar', version: '1.0.0', location: 'header', attributes: { 'data-x': '1' } }] } },
  published: [],
  log: []
};
function json(res, status, body) { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); }
const mockServer = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString();
    const body = raw ? JSON.parse(raw) : {};
    const u = new URL(req.url, 'http://x');
    mock.log.push(req.method + ' ' + u.pathname);
    if (u.pathname === '/cdn/waform.min.js') { res.writeHead(200, { 'Content-Type': 'application/javascript' }); return res.end(SCRIPT_BYTES); }
    if (u.pathname === '/oauth/access_token') {
      if (body.client_id !== 'cid_test' || body.client_secret !== 'secret_test' || body.code !== 'good-code') return json(res, 400, { error: 'invalid_grant' });
      mock.tokens.add('tok_123');
      return json(res, 200, { access_token: 'tok_123', token_type: 'bearer' });
    }
    const auth = req.headers.authorization || '';
    if (auth !== 'Bearer tok_123') return json(res, 401, { message: 'Unauthorized' });
    if (u.pathname === '/v2/sites') return json(res, 200, { sites: [
      { id: 'site_a', displayName: 'Demo Clinic', shortName: 'demo-clinic', customDomains: [{ id: 'dom1', url: 'democlinic.com' }] },
      { id: 'site_b', displayName: 'Second Site', shortName: 'second-site', customDomains: [] }
    ] });
    let m;
    if ((m = u.pathname.match(/^\/v2\/sites\/(\w+)\/registered_scripts\/hosted$/)) && req.method === 'POST') {
      const list = mock.registered[m[1]] = mock.registered[m[1]] || [];
      if (list.find((s) => s.displayName === body.displayName && s.version === body.version)) return json(res, 400, { message: 'Script already exists' });
      const rec = Object.assign({ id: body.displayName.toLowerCase().replace(/[^a-z0-9]+/g, '_'), createdOn: new Date().toISOString() }, body);
      list.push(rec);
      return json(res, 201, rec);
    }
    if ((m = u.pathname.match(/^\/v2\/sites\/(\w+)\/registered_scripts$/)) && req.method === 'GET') {
      return json(res, 200, { registeredScripts: mock.registered[m[1]] || [] });
    }
    if ((m = u.pathname.match(/^\/v2\/sites\/(\w+)\/custom_code$/))) {
      if (req.method === 'GET') return mock.customCode[m[1]] ? json(res, 200, mock.customCode[m[1]]) : json(res, 404, { message: 'Not found' });
      if (req.method === 'PUT') { mock.customCode[m[1]] = { scripts: body.scripts, lastUpdated: new Date().toISOString() }; return json(res, 200, mock.customCode[m[1]]); }
    }
    if ((m = u.pathname.match(/^\/v2\/sites\/(\w+)\/publish$/)) && req.method === 'POST') { mock.published.push({ site: m[1], body }); return json(res, 202, { customDomains: body.customDomains || [], publishToWebflowSubdomain: !!body.publishToWebflowSubdomain }); }
    json(res, 404, { message: 'mock: no route ' + req.method + ' ' + u.pathname });
  });
});

// ---- app under test ----
function startApp(port) {
  const handler = require('../api/[path].js');
  return http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    req.query = Object.fromEntries(u.searchParams);
    req.query.path = u.pathname.replace(/^\//, '');
    handler(req, res);
  }).listen(port);
}

function request(port, method, p, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}
function cookiesFrom(res) {
  const set = res.headers['set-cookie'] || [];
  return set.map((c) => c.split(';')[0]).filter((c) => !c.endsWith('=')).join('; ');
}

(async () => {
  await new Promise((r) => mockServer.listen(0, r));
  const mockPort = mockServer.address().port;
  process.env.WEBFLOW_API_BASE = 'http://127.0.0.1:' + mockPort;
  process.env.WEBFLOW_AUTH_BASE = 'http://127.0.0.1:' + mockPort;
  process.env.WAFORM_SCRIPT_URL = 'http://127.0.0.1:' + mockPort + '/cdn/waform.min.js';
  const app = startApp(0);
  await new Promise((r) => app.on('listening', r));
  const port = app.address().port;

  console.log('1. /auth redirects to Webflow with the right scopes and a state cookie');
  const auth = await request(port, 'GET', '/auth');
  assert(auth.status === 302, 'redirect status');
  const loc = new URL(auth.headers.location);
  assert(loc.pathname === '/oauth/authorize' && loc.searchParams.get('client_id') === 'cid_test', 'authorize url and client id');
  assert(loc.searchParams.get('scope') === 'sites:read sites:write custom_code:read custom_code:write', 'scopes');
  assert(loc.searchParams.get('redirect_uri') === 'https://app.test/callback', 'redirect uri');
  const state = loc.searchParams.get('state');
  const stateCookie = cookiesFrom(auth);
  assert(stateCookie.includes('wa_state=' + state), 'state cookie matches state param');

  console.log('2. /callback rejects a wrong state and a bad code, accepts a good one');
  const bad = await request(port, 'GET', '/callback?code=good-code&state=other', { headers: { Cookie: stateCookie } });
  assert(bad.status === 400 && bad.body.includes('State mismatch'), 'state mismatch rejected');
  const badCode = await request(port, 'GET', '/callback?code=nope&state=' + state, { headers: { Cookie: stateCookie } });
  assert(badCode.status === 400 && badCode.body.includes('Could not sign in'), 'bad code rejected');
  const cb = await request(port, 'GET', '/callback?code=good-code&state=' + state, { headers: { Cookie: stateCookie } });
  assert(cb.status === 302 && cb.headers.location === '/setup', 'good code redirects to setup');
  const session = cookiesFrom(cb);
  assert(/wa_session=/.test(session), 'session cookie set');
  const internal = require('../api/[path].js')._internal;
  const opened = internal.open(decodeURIComponent(session.match(/wa_session=([^;]+)/)[1]));
  assert(opened && opened.t === 'tok_123', 'session cookie decrypts to the token');

  console.log('3. /setup without a session redirects; with a session lists sites');
  const anon = await request(port, 'GET', '/setup');
  assert(anon.status === 302 && anon.headers.location === '/auth', 'anonymous redirected to /auth');
  const setup = await request(port, 'GET', '/setup', { headers: { Cookie: session } });
  assert(setup.status === 200 && setup.body.includes('Demo Clinic') && setup.body.includes('Second Site'), 'both sites listed');
  assert(!setup.body.includes('class="pill"'), 'nothing marked installed yet');

  console.log('4. /install registers the hosted script, keeps other scripts, applies attributes, publishes');
  const form = new URLSearchParams({ site_id: 'site_a', number: '+90 532 000 00 00', template: 'Hi, I am {name}.\n{all}', intro: 'New lead', mode: 'auto', button_text: 'Continue on WhatsApp', exclude: 'newsletter', submit: 'true', publish: 'true' }).toString();
  const inst = await request(port, 'POST', '/install', { headers: { Cookie: session, 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(form) }, body: form });
  assert(inst.status === 200 && inst.body.includes('Installed on Demo Clinic'), 'success page');
  const reg = mock.registered.site_a || [];
  assert(reg.length === 1 && reg[0].displayName === 'waform' && reg[0].version === '0.1.0' && reg[0].canCopy === true, 'hosted script registered once');
  const expectedHash = 'sha384-' + crypto.createHash('sha384').update(SCRIPT_BYTES).digest('base64');
  assert(reg[0].integrityHash === expectedHash, 'integrity hash computed from the hosted bytes');
  const scripts = mock.customCode.site_a.scripts;
  assert(scripts.length === 2 && scripts[0].id === 'hotjar' && scripts[0].attributes['data-x'] === '1', 'existing script kept with attributes');
  const ours = scripts[1];
  assert(ours.id === 'waform' && ours.location === 'footer' && ours.version === '0.1.0', 'our script applied in the footer');
  assert(ours.attributes['data-wa-number'] === '905320000000', 'number cleaned');
  assert(ours.attributes['data-wa-template'] === 'Hi, I am {name}.\\n{all}', 'template newline escaped for the attribute');
  assert(ours.attributes['data-wa-intro'] === 'New lead' && ours.attributes['data-wa-exclude'] === 'newsletter', 'intro and exclude set');
  assert(!('data-wa-mode' in ours.attributes) && !('data-wa-button-text' in ours.attributes) && !('data-wa-submit' in ours.attributes), 'defaults omitted');
  assert(mock.published.length === 1 && mock.published[0].body.customDomains[0] === 'dom1' && mock.published[0].body.publishToWebflowSubdomain === true, 'site published to domain and subdomain');

  console.log('5. reinstall replaces our entry instead of duplicating, and setup shows the saved config');
  const form2 = new URLSearchParams({ site_id: 'site_a', number: '447700900123', template: '{all}', mode: 'button', button_text: 'Chat now', submit: 'false' }).toString();
  const inst2 = await request(port, 'POST', '/install', { headers: { Cookie: session, 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(form2) }, body: form2 });
  assert(inst2.status === 200 && inst2.body.includes('Publish the site in Webflow'), 'no publish this time, reminder shown');
  const s2 = mock.customCode.site_a.scripts;
  assert(s2.length === 2 && s2.filter(internal.isOurs).length === 1, 'still one waform entry');
  const a2 = s2[1].attributes;
  assert(a2['data-wa-number'] === '447700900123' && a2['data-wa-mode'] === 'button' && a2['data-wa-button-text'] === 'Chat now' && a2['data-wa-submit'] === 'false' && !('data-wa-template' in a2), 'new attributes applied');
  assert((mock.registered.site_a || []).length === 1, 'hosted script not registered twice');
  const setup2 = await request(port, 'GET', '/setup?site=site_a', { headers: { Cookie: session } });
  assert(setup2.body.includes('class="pill"') && setup2.body.includes('value="447700900123"') && setup2.body.includes('<option value="button" selected>'), 'setup page reflects installed config');

  console.log('6. validation and uninstall');
  const badNum = new URLSearchParams({ site_id: 'site_a', number: '123' }).toString();
  const v = await request(port, 'POST', '/install', { headers: { Cookie: session, 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(badNum) }, body: badNum });
  assert(v.status === 400 && v.body.includes('Check the number'), 'short number rejected');
  const foreign = new URLSearchParams({ site_id: 'site_zzz', number: '905320000000' }).toString();
  const f = await request(port, 'POST', '/install', { headers: { Cookie: session, 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(foreign) }, body: foreign });
  assert(f.status === 403, 'unauthorized site rejected');
  const un = new URLSearchParams({ site_id: 'site_a' }).toString();
  const u = await request(port, 'POST', '/uninstall', { headers: { Cookie: session, 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(un) }, body: un });
  assert(u.status === 302 && /removed=1/.test(u.headers.location), 'uninstall redirects with notice');
  assert(mock.customCode.site_a.scripts.length === 1 && mock.customCode.site_a.scripts[0].id === 'hotjar', 'only our script removed');
  const health = await request(port, 'GET', '/health');
  assert(health.status === 200 && health.body === 'ok', 'health ok');
  const logout = await request(port, 'GET', '/logout', { headers: { Cookie: session } });
  assert(logout.status === 302 && (logout.headers['set-cookie'] || []).some((c) => c.startsWith('wa_session=;')), 'logout clears the session');

  console.log(`\n${passed} passed, ${failed} failed`);
  mockServer.close(); app.close();
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
