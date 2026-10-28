'use strict';
// WhatsApp Business Platform (Cloud API) sender.
//
// Env:
//   WHATSAPP_TOKEN          system user or temporary access token
//   WHATSAPP_PHONE_ID       the business phone number id shown in API Setup
//   WHATSAPP_TEMPLATE       optional approved template name for lead alerts (see README for the body)
//   WHATSAPP_TEMPLATE_LANG  template language code, default en
//   WHATSAPP_API_VERSION    Graph API version, default v22.0
//   WHATSAPP_API_BASE       override for tests
//
// Text messages are only delivered inside the 24-hour customer service window, so production
// alerts use a utility template. With no template configured we send text (fine for testing).

function env() {
  return {
    token: process.env.WHATSAPP_TOKEN || '',
    phoneId: process.env.WHATSAPP_PHONE_ID || '',
    template: process.env.WHATSAPP_TEMPLATE || '',
    lang: process.env.WHATSAPP_TEMPLATE_LANG || 'en',
    version: process.env.WHATSAPP_API_VERSION || 'v22.0',
    base: (process.env.WHATSAPP_API_BASE || 'https://graph.facebook.com').replace(/\/+$/, '')
  };
}

function enabled() {
  const e = env();
  return !!(e.token && e.phoneId);
}

async function post(payload) {
  const e = env();
  if (!e.token || !e.phoneId) {
    const err = new Error('WhatsApp is not configured (WHATSAPP_TOKEN and WHATSAPP_PHONE_ID)');
    err.code = 'not_configured';
    throw err;
  }
  const res = await fetch(`${e.base}/${e.version}/${e.phoneId}/messages`, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + e.token, 'Content-Type': 'application/json' },
    body: JSON.stringify(Object.assign({ messaging_product: 'whatsapp', recipient_type: 'individual' }, payload))
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    const detail = data.error || {};
    const err = new Error(detail.message || ('WhatsApp API error ' + res.status));
    err.code = detail.code;
    err.subcode = detail.error_subcode;
    err.data = detail;
    throw err;
  }
  return data;
}

// Free-form text. Delivered only inside an open 24h window with that recipient.
async function sendText(to, body) {
  return post({ to, type: 'text', text: { preview_url: false, body } });
}

// Template parameters cannot contain newlines, tabs or more than four spaces in a row.
function param(text, max) {
  const clean = String(text == null || text === '' ? '-' : text).replace(/[\r\n\t]+/g, ' ').replace(/ {4,}/g, '   ').trim() || '-';
  return clean.length > (max || 1000) ? clean.slice(0, (max || 1000) - 1) + '…' : clean;
}

// Lead alert template with six body parameters: site, name, phone, email, message, source
// and one dynamic URL button that takes the lead's phone digits.
async function sendLeadTemplate(to, lead) {
  const e = env();
  const components = [{
    type: 'body',
    parameters: [
      { type: 'text', text: param(lead.site, 60) },
      { type: 'text', text: param(lead.name, 100) },
      { type: 'text', text: param(lead.phone, 40) },
      { type: 'text', text: param(lead.email, 100) },
      { type: 'text', text: param(lead.message, 600) },
      { type: 'text', text: param(lead.source, 120) }
    ]
  }];
  if (lead.phoneDigits) {
    components.push({ type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: lead.phoneDigits }] });
  }
  return post({ to, type: 'template', template: { name: e.template, language: { code: e.lang }, components } });
}

// Sends the alert the best available way: template when configured, otherwise text.
// If a text send fails because the 24h window is closed (code 131047) and a template exists, fall back to it.
async function sendLeadAlert(to, lead, text) {
  const e = env();
  if (e.template) return sendLeadTemplate(to, lead);
  try {
    return await sendText(to, text);
  } catch (err) {
    if (err.code === 131047 && e.template) return sendLeadTemplate(to, lead);
    throw err;
  }
}

module.exports = { enabled, sendText, sendLeadTemplate, sendLeadAlert, param };
