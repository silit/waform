'use strict';
// Tiny Upstash Redis REST client. Works with the env names Vercel's Upstash integration sets
// (KV_REST_API_URL / KV_REST_API_TOKEN) and with Upstash's own (UPSTASH_REDIS_REST_URL / _TOKEN).
// When nothing is configured every call is a no-op that resolves to null, so the app still runs.

function config() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || '';
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || '';
  return url && token ? { url: url.replace(/\/+$/, ''), token } : null;
}

function enabled() {
  return !!config();
}

async function command(...parts) {
  const cfg = config();
  if (!cfg) return null;
  const res = await fetch(cfg.url, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + cfg.token, 'Content-Type': 'application/json' },
    body: JSON.stringify(parts.map((p) => (typeof p === 'string' ? p : String(p))))
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) throw new Error('KV error: ' + (data.error || res.status));
  return data.result;
}

async function getJSON(key) {
  const raw = await command('GET', key);
  if (raw == null) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}

async function setJSON(key, value, ttlSeconds) {
  const args = ['SET', key, JSON.stringify(value)];
  if (ttlSeconds) args.push('EX', String(ttlSeconds));
  return command(...args);
}

async function del(key) {
  return command('DEL', key);
}

// Returns true the first time a key is seen, false afterwards (used to drop webhook retries).
async function firstTime(key, ttlSeconds) {
  if (!enabled()) return true;
  const result = await command('SET', key, '1', 'NX', 'EX', String(ttlSeconds || 86400));
  return result === 'OK';
}

async function pushJSON(listKey, value, keep) {
  await command('LPUSH', listKey, JSON.stringify(value));
  if (keep) await command('LTRIM', listKey, '0', String(keep - 1));
}

async function listJSON(listKey, count) {
  const items = await command('LRANGE', listKey, '0', String((count || 50) - 1));
  return (items || []).map((s) => { try { return JSON.parse(s); } catch (e) { return null; } }).filter(Boolean);
}

async function incr(key) {
  return command('INCR', key);
}

module.exports = { enabled, command, getJSON, setJSON, del, firstTime, pushJSON, listJSON, incr };
