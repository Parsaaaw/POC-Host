// poc-host — Cloudflare Workers port (D1-backed) of the original Express app.
// Same routes, same behavior, same HTML/JS on the client side. The only real
// change is the storage layer: Railway's "./data" disk + ".meta.json"
// sidecar is replaced by one D1 table (see schema.sql) that holds file
// content, tag and raw-only flag together, so it's durable across deploys
// by default — no Volume to configure.
//
// Auth: the configurable management path (create/list/api) is protected by CREATE_TOKEN (if set).
// The token can be sent as ?token=, X-Create-Token header, JSON body, or —
// new — via an HttpOnly cookie that is set automatically the first time a
// valid token is supplied. The configurable file path NEVER requires auth.

// ---------------------------------------------------------------------------
// Public configuration
// Change these two values before publishing/deploying if you want different
// management/file paths. They must be single URL path segments (no slashes).
// Example: APP_PATH = 'dashboard' and FILE_PATH = 'files'
// NOTE: changing these is path customization/obscurity, not authentication.
// Keep CREATE_TOKEN configured as a Wrangler secret for real access control.
const CONFIG = Object.freeze({
  APP_PATH: 'poc_app',
  FILE_PATH: 'f',
  CALLBACK_PATH: 'c',
});

function normalizePathSegment(value, fallback) {
  const cleaned = String(value || '')
    .trim()
    .replace(/^\/+|\/+$/g, '');
  if (!cleaned || cleaned === '.' || cleaned === '..' || cleaned.includes('/')) {
    return fallback;
  }
  return cleaned.replace(/[^a-zA-Z0-9_-]/g, '_');
}

const APP_PATH = normalizePathSegment(CONFIG.APP_PATH, 'poc_app');
const FILE_PATH = normalizePathSegment(CONFIG.FILE_PATH, 'f');
const CALLBACK_PATH = normalizePathSegment(CONFIG.CALLBACK_PATH, 'c');
const APP_BASE = `/${APP_PATH}`;
const FILE_BASE = `/${FILE_PATH}`;
const CALLBACK_BASE = `/${CALLBACK_PATH}`;
if (APP_PATH === FILE_PATH || APP_PATH === CALLBACK_PATH || FILE_PATH === CALLBACK_PATH) {
  throw new Error('APP_PATH, FILE_PATH and CALLBACK_PATH must be different');
}

function fileUrl(name) {
  return `${FILE_BASE}/${encodeURIComponent(name)}`;
}

function apiFilesUrl(name = '') {
  return `${APP_BASE}/api/files${name ? `/${encodeURIComponent(name)}` : ''}`;
}

function callbackUrl(id) {
  return `${CALLBACK_BASE}/${encodeURIComponent(id)}`;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function normalizeTags(value) {
  const input = Array.isArray(value) ? value : [value];
  const seen = new Set();
  const tags = [];

  for (const item of input) {
    if (item === undefined || item === null) continue;
    const tag = item.toString().trim();
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    tags.push(tag);
  }

  return tags;
}

// The existing D1 schema has a single TEXT column named `tag`. To avoid a
// schema migration for existing deployments, multi-tags are stored there as
// a JSON array string. Legacy plain-text rows are transparently read as one
// tag, so existing data keeps working.
function parseStoredTags(value) {
  if (value === undefined || value === null || value === '') return [];
  if (Array.isArray(value)) return normalizeTags(value);

  const text = String(value).trim();
  if (!text) return [];

  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return normalizeTags(parsed);
  } catch {}

  return [text];
}

function serializeTags(tags) {
  const normalized = normalizeTags(tags);
  return normalized.length ? JSON.stringify(normalized) : null;
}

const MIME = {
  js: 'application/javascript; charset=utf-8',
  mjs: 'application/javascript; charset=utf-8',
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json; charset=utf-8',
  xml: 'application/xml; charset=utf-8',
  svg: 'image/svg+xml',
  txt: 'text/plain; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  php: 'text/plain; charset=utf-8', // served, not executed (static host)
};

function mimeFor(ext) {
  return MIME[(ext || '').toLowerCase()] || 'application/octet-stream';
}

function safeName(name) {
  return (name || '').replace(/[^a-zA-Z0-9._-]/g, '_');
}

function byteLen(str) {
  return new TextEncoder().encode(str).length;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

function html(body, status = 200) {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

function notFound() {
  return new Response('not found', { status: 404 });
}

// --- favicon (inline SVG data URI, so no extra route/file is needed) ------
const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#3a3ea8"/><stop offset="1" stop-color="#7a2f6e"/></linearGradient></defs><rect width="32" height="32" rx="8" fill="url(#g)"/><path d="M9 10l7 6-7 6" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M19 23h5" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round"/></svg>`;
const FAVICON_LINK = `<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,${encodeURIComponent(FAVICON_SVG)}">`;

// --- auth (token via URL/header/body, or remembered via cookie) ---------
const COOKIE_NAME = 'poc_token';
const COOKIE_MAX_AGE = 60 * 60 * 24 * 30; // 30 days

function getCookie(req, name) {
  const header = req.headers.get('cookie') || '';
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    if (part.slice(0, i).trim() === name) {
      try {
        return decodeURIComponent(part.slice(i + 1).trim());
      } catch {
        return null;
      }
    }
  }
  return null;
}

function suppliedToken(req, url, body) {
  return (
    url.searchParams.get('token') ||
    req.headers.get('x-create-token') ||
    (body && body.token) ||
    null
  );
}

function checkToken(req, url, body, env) {
  const CREATE_TOKEN = env.CREATE_TOKEN || null;
  if (!CREATE_TOKEN) return true;
  if (suppliedToken(req, url, body) === CREATE_TOKEN) return true;
  return getCookie(req, COOKIE_NAME) === CREATE_TOKEN;
}

// The cookie is scoped to the configurable management path, so the browser never even sends it to
// file path — PoC links stay completely auth-free.
function authCookie(token) {
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=${APP_BASE}; Max-Age=${COOKIE_MAX_AGE}; HttpOnly; Secure; SameSite=Lax`;
}

function clearAuthCookie() {
  return `${COOKIE_NAME}=; Path=${APP_BASE}; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

// If the request carried a valid token explicitly, remember it in a cookie.
function withAuthCookie(res, req, url, body, env) {
  const CREATE_TOKEN = env.CREATE_TOKEN || null;
  if (CREATE_TOKEN && suppliedToken(req, url, body) === CREATE_TOKEN) {
    res.headers.append('Set-Cookie', authCookie(CREATE_TOKEN));
  }
  return res;
}

// --- D1 helpers -------------------------------------------------------
async function getFile(db, name) {
  return db.prepare('SELECT * FROM files WHERE name = ?').bind(name).first();
}

async function listFiles(db) {
  const { results } = await db
    .prepare('SELECT name, ext, tag, raw, size, modified, response_status, response_headers, redirect_url, delay_ms FROM files ORDER BY modified DESC')
    .all();
  return results || [];
}

const NO_BODY_STATUSES = new Set([101, 204, 205, 304]);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_RESPONSE_DELAY = 30_000;

function parseStoredHeaders(value) {
  if (value === undefined || value === null || value === '') return {};
  try {
    const parsed = JSON.parse(String(value));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out = {};
    for (const [name, headerValue] of Object.entries(parsed)) {
      const key = String(name).trim();
      if (!key) continue;
      out[key] = String(headerValue ?? '');
    }
    return out;
  } catch {
    return {};
  }
}

function validateHeaders(input) {
  if (input === undefined || input === null) return {};
  let source = input;
  if (typeof source === 'string') {
    try {
      source = JSON.parse(source);
    } catch {
      const parsed = {};
      for (const line of source.split(/\r?\n/)) {
        if (!line.trim()) continue;
        const i = line.indexOf(':');
        if (i <= 0) throw new Error(`Invalid header line: ${line}`);
        parsed[line.slice(0, i).trim()] = line.slice(i + 1).trim();
      }
      source = parsed;
    }
  }
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw new Error('headers must be an object or header lines');
  }
  const out = {};
  try {
    for (const [name, headerValue] of Object.entries(source)) {
      const key = String(name).trim();
      const value = String(headerValue ?? '');
      if (!key) continue;
      new Headers({ [key]: value });
      out[key] = value;
    }
  } catch (error) {
    throw new Error(`Invalid response header: ${error?.message || String(error)}`);
  }
  return out;
}

function mergeHeaders(existing, incoming) {
  const out = { ...existing };
  const lowerToKey = new Map(Object.keys(out).map(key => [key.toLowerCase(), key]));
  for (const [name, value] of Object.entries(incoming)) {
    const previousKey = lowerToKey.get(name.toLowerCase());
    if (previousKey) delete out[previousKey];
    out[name] = value;
    lowerToKey.set(name.toLowerCase(), name);
  }
  return out;
}

function parseResponseConfig(row) {
  return {
    status: Number.isInteger(Number(row?.response_status)) ? Number(row.response_status) : 200,
    headers: parseStoredHeaders(row?.response_headers),
    redirectUrl: String(row?.redirect_url || ''),
    delayMs: Math.max(0, Math.min(MAX_RESPONSE_DELAY, Number(row?.delay_ms) || 0)),
  };
}

function normalizeResponseConfig(input, existing = null) {
  const base = existing ? parseResponseConfig(existing) : { status: 200, headers: {}, redirectUrl: '', delayMs: 0 };
  if (!input || typeof input !== 'object' || Array.isArray(input)) return base;

  const has = key => Object.prototype.hasOwnProperty.call(input, key);
  const status = Number.parseInt(has('status') ? input.status : base.status, 10);
  if (!Number.isInteger(status) || status < 100 || status > 599) {
    throw new Error('response status must be an integer between 100 and 599');
  }

  const delayMs = Number.parseInt(has('delayMs') ? input.delayMs : base.delayMs, 10);
  if (!Number.isInteger(delayMs) || delayMs < 0 || delayMs > MAX_RESPONSE_DELAY) {
    throw new Error(`delayMs must be an integer between 0 and ${MAX_RESPONSE_DELAY}`);
  }

  const redirectUrl = has('redirectUrl') ? String(input.redirectUrl || '').trim() : base.redirectUrl;
  if (redirectUrl.length > 4096) throw new Error('redirectUrl is too long');
  if (redirectUrl && !REDIRECT_STATUSES.has(status)) {
    throw new Error('redirectUrl requires status 301, 302, 303, 307 or 308');
  }

  let headers = has('headers') ? validateHeaders(input.headers) : base.headers;
  if (has('headers') && input.headersMode === 'append') headers = mergeHeaders(base.headers, headers);

  return { status, headers, redirectUrl, delayMs };
}

let responseSchemaReady = false;
let responseSchemaPromise = null;

async function ensureResponseSchema(db) {
  if (!db || typeof db.prepare !== 'function') {
    throw new Error('D1 binding DB is missing. Check the [[d1_databases]] binding name in wrangler.toml.');
  }
  if (responseSchemaReady) return;
  if (!responseSchemaPromise) {
    responseSchemaPromise = (async () => {
      const alterations = [
        `ALTER TABLE files ADD COLUMN response_status INTEGER NOT NULL DEFAULT 200`,
        `ALTER TABLE files ADD COLUMN response_headers TEXT`,
        `ALTER TABLE files ADD COLUMN redirect_url TEXT`,
        `ALTER TABLE files ADD COLUMN delay_ms INTEGER NOT NULL DEFAULT 0`,
      ];
      for (const sql of alterations) {
        try {
          await db.prepare(sql).run();
        } catch (error) {
          const message = String(error?.message || error || '');
          if (!/duplicate column name|already exists/i.test(message)) throw error;
        }
      }
      responseSchemaReady = true;
    })().catch(error => {
      responseSchemaPromise = null;
      throw error;
    });
  }
  await responseSchemaPromise;
}

const CALLBACK_BODY_LIMIT = 256 * 1024;
const CALLBACK_HEADER_LIMIT = 64 * 1024;
const CALLBACK_BROWSER_LIMIT = 128 * 1024;

// Callback storage is bootstrapped lazily on first use. Existing deployments
// can therefore adopt the callback feature without having to recreate the D1 DB.
const CALLBACK_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS callback_requests (
  seq               INTEGER PRIMARY KEY AUTOINCREMENT,
  id                TEXT NOT NULL,
  method            TEXT NOT NULL,
  url               TEXT NOT NULL,
  path              TEXT NOT NULL,
  query             TEXT,
  headers           TEXT,
  body              TEXT,
  body_truncated    INTEGER NOT NULL DEFAULT 0,
  headers_truncated INTEGER NOT NULL DEFAULT 0,
  ip                TEXT,
  referer           TEXT,
  user_agent        TEXT,
  location_hash     TEXT,
  received          INTEGER NOT NULL
)`;
let callbackSchemaReady = false;
let callbackSchemaPromise = null;

async function ensureCallbackSchema(db) {
  if (!db || typeof db.prepare !== 'function') {
    throw new Error('D1 binding DB is missing. Check the [[d1_databases]] binding name in wrangler.toml.');
  }
  if (callbackSchemaReady) return;
  if (!callbackSchemaPromise) {
    callbackSchemaPromise = (async () => {
      await db.prepare(CALLBACK_TABLE_SQL).run();
      callbackSchemaReady = true;
    })().catch(error => {
      callbackSchemaPromise = null;
      throw error;
    });
  }
  await callbackSchemaPromise;
}

function callbackId(value) {
  let id = String(value || '').trim();
  try { id = decodeURIComponent(id); } catch {}
  id = id.replace(/[^a-zA-Z0-9._:@-]/g, '_').slice(0, 128);
  return id;
}

function callbackRequestHeaders(req) {
  const headers = {};
  for (const [key, value] of req.headers.entries()) headers[key] = value;
  return headers;
}

function getClientIp(req) {
  const direct = req.headers.get('cf-connecting-ip') || req.headers.get('true-client-ip');
  if (direct) return direct;
  const forwarded = req.headers.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0].trim();
  return '';
}

function getLocationHash(req, url) {
  return (
    url.searchParams.get('hash') ||
    url.searchParams.get('__hash') ||
    url.searchParams.get('location_hash') ||
    req.headers.get('x-location-hash') ||
    req.headers.get('x-hash') ||
    ''
  );
}

async function readCallbackBody(req, limit = CALLBACK_BODY_LIMIT) {
  if (req.method === 'GET' || req.method === 'HEAD') {
    return { body: '', truncated: false };
  }
  try {
    const text = await req.text();
    if (text.length <= limit) return { body: text, truncated: false };
    return { body: text.slice(0, limit), truncated: true };
  } catch {
    return { body: '', truncated: false };
  }
}

function callbackResponse(status = 204) {
  return new Response(null, {
    status,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': '*',
      'Access-Control-Allow-Headers': '*',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'Pragma': 'no-cache',
    },
  });
}

// This is intentionally a fixed HTML/JS payload. The client derives the
// callback URL from location.pathname, so changing CONFIG.CALLBACK_PATH does
// not require changing this source.
const CALLBACK_HTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow,noarchive">
<title>Callback</title>
<style>
html,body{margin:0;width:100%;height:100%;background:#050507;color:#fff}
body{font-family:system-ui,-apple-system,sans-serif;display:grid;place-items:center;overflow:hidden}
main{opacity:.55;font-size:12px;letter-spacing:.02em}
</style>
</head>
<body>
<main>callback</main>
<script>
(() => {
  const base = location.pathname.replace(/\\/+$/, '');
  const endpoint = base + '/collect';
  const nav = navigator;
  const scr = window.screen || {};
  let timezone = '';
  try { timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (_) {}

  const browser = {
    href: location.href,
    hash: location.hash || '',
    referrer: document.referrer || '',
    userAgent: nav.userAgent || '',
    language: nav.language || '',
    languages: Array.isArray(nav.languages) ? nav.languages : [],
    platform: nav.platform || '',
    timezone,
    cookieEnabled: !!nav.cookieEnabled,
    online: !!nav.onLine,
    hardwareConcurrency: nav.hardwareConcurrency || null,
    maxTouchPoints: nav.maxTouchPoints || 0,
    deviceMemory: nav.deviceMemory || null,
    doNotTrack: nav.doNotTrack || null,
    viewport: { width: window.innerWidth || 0, height: window.innerHeight || 0 },
    screen: {
      width: scr.width || 0,
      height: scr.height || 0,
      availWidth: scr.availWidth || 0,
      availHeight: scr.availHeight || 0,
      colorDepth: scr.colorDepth || 0,
      pixelDepth: scr.pixelDepth || 0,
    },
    devicePixelRatio: window.devicePixelRatio || 1,
    visibilityState: document.visibilityState || '',
    userAgentData: nav.userAgentData ? {
      mobile: !!nav.userAgentData.mobile,
      platform: nav.userAgentData.platform || '',
      brands: Array.isArray(nav.userAgentData.brands) ? nav.userAgentData.brands : []
    } : null,
    capturedAt: new Date().toISOString()
  };

  const payload = JSON.stringify(browser);
  try {
    if (nav.sendBeacon) {
      const blob = new Blob([payload], {type:'text/plain;charset=UTF-8'});
      if (nav.sendBeacon(endpoint, blob)) return;
    }
  } catch (_) {}

  try {
    fetch(endpoint, {
      method:'POST',
      headers:{'Content-Type':'text/plain;charset=UTF-8'},
      body:payload,
      keepalive:true,
      credentials:'omit'
    }).catch(() => {});
  } catch (_) {}
})();
</script>
</body>
</html>`;

async function storeCallbackRequest({ req, url, env, id, method, body, bodyTruncated, locationHash = '' }) {
  const headersObject = callbackRequestHeaders(req);
  let headersJson = JSON.stringify(headersObject);
  let headersTruncated = false;
  if (headersJson.length > CALLBACK_HEADER_LIMIT) {
    headersJson = headersJson.slice(0, CALLBACK_HEADER_LIMIT);
    headersTruncated = true;
  }

  const queryJson = JSON.stringify(Array.from(url.searchParams.entries()));
  const referer = req.headers.get('referer') || req.headers.get('referrer') || '';
  const userAgent = req.headers.get('user-agent') || '';
  const ip = getClientIp(req);

  const result = await env.DB.prepare(
    `INSERT INTO callback_requests
      (id, method, url, path, query, headers, body, body_truncated, headers_truncated, ip, referer, user_agent, location_hash, received)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    id,
    method,
    url.toString(),
    url.pathname,
    queryJson,
    headersJson,
    body,
    bodyTruncated ? 1 : 0,
    headersTruncated ? 1 : 0,
    ip,
    referer,
    userAgent,
    locationHash || '',
    Date.now()
  ).run();

  return Number(result?.meta?.last_row_id || 0);
}

async function handleCallback(req, url, env, id) {
  await ensureCallbackSchema(env.DB);
  id = callbackId(id);
  if (!id) return callbackResponse();

  const { body, truncated } = await readCallbackBody(req);
  await storeCallbackRequest({
    req,
    url,
    env,
    id,
    method: req.method,
    body,
    bodyTruncated: truncated,
    locationHash: getLocationHash(req, url),
  });

  // GET is the browser-facing page: fixed HTML + fixed JS. Other methods are
  // captured normally but stay lightweight with a 204 response.
  if (req.method === 'GET') {
    return new Response(CALLBACK_HTML, {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        'Pragma': 'no-cache',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  }
  return callbackResponse();
}

async function handleCallbackBrowserCollect(req, url, env, id) {
  await ensureCallbackSchema(env.DB);
  id = callbackId(id);
  if (!id) return callbackResponse();

  const { body, truncated } = await readCallbackBody(req, CALLBACK_BROWSER_LIMIT);
  let browser = {};
  try {
    browser = JSON.parse(body || '{}');
    if (!browser || typeof browser !== 'object' || Array.isArray(browser)) browser = {};
  } catch {
    browser = {};
  }

  // The browser cannot enumerate arbitrary request headers, so the Worker
  // captures headers of this /collect request separately via req.headers.
  // Browser-only values (hash, viewport, timezone, userAgentData, ...) live
  // in the JSON body of this BROWSER record.
  const browserBody = JSON.stringify({
    type: 'browser',
    ...browser,
  });

  const hash = typeof browser.hash === 'string' ? browser.hash.slice(0, CALLBACK_BROWSER_LIMIT) : '';
  await storeCallbackRequest({
    req,
    url,
    env,
    id,
    method: 'BROWSER',
    body: browserBody.slice(0, CALLBACK_BROWSER_LIMIT),
    bodyTruncated: truncated || browserBody.length > CALLBACK_BROWSER_LIMIT,
    locationHash: hash,
  });

  return callbackResponse();
}

async function getCallback(db, seq) {
  return db.prepare('SELECT * FROM callback_requests WHERE seq = ?').bind(Number(seq)).first();
}

async function listCallbacks(db, id = '', limit = 100) {
  limit = Math.max(1, Math.min(Number(limit) || 100, 200));
  let result;
  if (id) {
    result = await db
      .prepare('SELECT * FROM callback_requests WHERE id = ? ORDER BY received DESC LIMIT ?')
      .bind(id, limit)
      .all();
  } else {
    result = await db
      .prepare('SELECT * FROM callback_requests ORDER BY received DESC LIMIT ?')
      .bind(limit)
      .all();
  }
  return result.results || [];
}

function parseCallbackRow(row) {
  let query = [];
  let headers = {};
  try { query = JSON.parse(row.query || '[]'); } catch {}
  try { headers = JSON.parse(row.headers || '{}'); } catch {}
  return {
    seq: row.seq,
    id: row.id,
    method: row.method,
    url: row.url,
    path: row.path,
    query,
    headers,
    body: row.body || '',
    bodyTruncated: !!row.body_truncated,
    headersTruncated: !!row.headers_truncated,
    ip: row.ip || '',
    referer: row.referer || '',
    userAgent: row.user_agent || '',
    locationHash: row.location_hash || '',
    received: row.received,
  };
}


// --- HTML pages (unchanged from the Express version, apart from the
// server-rendered bits pulling from D1 instead of fs) -------------------

function createPageHtml() {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>PoC host</title>
${FAVICON_LINK}
<style>
  *{box-sizing:border-box}
  html,body{height:100%}
  body{font-family:system-ui,sans-serif;margin:0;background:#000;color:#fff;padding:60px 20px;position:relative;overflow-x:hidden}
  .blob{position:fixed;border-radius:50%;filter:blur(90px);z-index:0;pointer-events:none}
  .b1{width:420px;height:420px;top:-120px;left:-100px;background:#3a3ea8;opacity:.35}
  .b2{width:380px;height:380px;bottom:-140px;right:-80px;background:#7a2f6e;opacity:.3}
  .b3{width:300px;height:300px;top:40%;right:10%;background:#1f6f78;opacity:.22}
  .wrap{max-width:600px;margin:0 auto;position:relative;z-index:1}
  h2{font-weight:400;margin:0 0 28px;font-size:22px}
  .card{background:linear-gradient(155deg,rgba(255,255,255,.09),rgba(255,255,255,.02));backdrop-filter:blur(24px) saturate(160%);-webkit-backdrop-filter:blur(24px) saturate(160%);border:1px solid rgba(255,255,255,.14);border-radius:22px;padding:28px 28px 32px;box-shadow:0 20px 60px rgba(0,0,0,.55),inset 0 1px 0 rgba(255,255,255,.12)}
  label{display:block;margin-top:20px;font-size:12px;color:rgba(255,255,255,.55);letter-spacing:.02em}
  label:first-of-type{margin-top:0}
  input,textarea,select{width:100%;background:rgba(255,255,255,.05);color:#fff;border:1px solid rgba(255,255,255,.12);border-radius:12px;padding:10px 12px;font-size:14px;margin-top:6px;backdrop-filter:blur(6px)}
  input::placeholder,textarea::placeholder{color:rgba(255,255,255,.3)}
  input:focus,textarea:focus,select:focus{outline:0;border-color:rgba(255,255,255,.4);background:rgba(255,255,255,.08)}
  textarea{height:260px;font-family:monospace;resize:vertical}
  select{background-color:rgba(255,255,255,.05)}
  select option{background:#111;color:#fff}
  button{margin-top:26px;padding:11px 24px;border:1px solid rgba(255,255,255,.25);border-radius:999px;background:linear-gradient(155deg,rgba(255,255,255,.22),rgba(255,255,255,.06));color:#fff;cursor:pointer;font-size:13px;box-shadow:inset 0 1px 0 rgba(255,255,255,.3),0 6px 18px rgba(0,0,0,.4);transition:transform .15s ease,box-shadow .15s ease}
  button:hover{transform:translateY(-1px);box-shadow:inset 0 1px 0 rgba(255,255,255,.4),0 10px 24px rgba(0,0,0,.5)}
  #out{margin-top:20px;padding-top:14px;border-top:1px solid rgba(255,255,255,.12);word-break:break-all;font-size:13px;color:rgba(255,255,255,.65)}
  a{color:#fff}
</style>
</head>
<body>
<div class="blob b1"></div><div class="blob b2"></div><div class="blob b3"></div>
<div class="wrap">
<h2>Create PoC file</h2>
<div class="card">
<label>Filename (no extension)</label>
<input id="filename" placeholder="poc">
<label>Extension (optional)</label>
<input id="ext" placeholder="js — leave empty for no extension">
<label>Tags (optional — comma-separated)</label>
<input id="tags" placeholder="e.g. acme-program, xss, poc">
<label>Code / content</label>
<textarea id="content" spellcheck="false"></textarea>
<label>Mode</label>
<select id="mode">
  <option value="rewrite">rewrite (overwrite if exists)</option>
  <option value="append">append (add content to end if exists)</option>
</select>
<label>Response status</label>
<input id="response-status" type="number" min="100" max="599" value="200" placeholder="200">
<label>Redirect URL (optional)</label>
<input id="redirect-url" placeholder="https://example.com/other">
<label>Response delay (ms)</label>
<input id="delay-ms" type="number" min="0" max="30000" value="0" placeholder="0">
<label>Response headers (one per line: Name: value)</label>
<textarea id="response-headers" spellcheck="false" style="height:140px" placeholder="Content-Type: text/html; charset=utf-8
X-Test: hello"></textarea>
<label style="display:flex;align-items:center;gap:8px;margin-top:14px">
  <input type="checkbox" id="headers-append" style="width:auto;margin:0">
  <span style="color:rgba(255,255,255,.55)">Append headers on update (merge; duplicate names overwrite old value)</span>
</label>
<label style="display:flex;align-items:center;gap:8px;margin-top:14px">
  <input type="checkbox" id="raw" style="width:auto;margin:0">
  <span style="color:rgba(255,255,255,.55)">Serve as raw text only (raw forces text/plain)</span>
</label>
<button onclick="submitFile()">Create</button>
<div id="out"></div>
</div>
</div>
<script>
const API_FILES = '${APP_BASE}/api/files';
function apiFilesUrl(name=''){ return API_FILES + (name ? '/' + encodeURIComponent(name) : ''); }
async function submitFile(){
  const filename = document.getElementById('filename').value.trim();
  const ext = document.getElementById('ext').value.trim().replace(/^\\./,'');
  const tags = document.getElementById('tags').value.split(',').map(v => v.trim()).filter(Boolean);
  const content = document.getElementById('content').value;
  const mode = document.getElementById('mode').value;
  const raw = document.getElementById('raw').checked;
  const responseStatus = Number(document.getElementById('response-status').value || 200);
  const redirectUrl = document.getElementById('redirect-url').value.trim();
  const delayMs = Number(document.getElementById('delay-ms').value || 0);
  const responseHeaders = {};
  for (const line of document.getElementById('response-headers').value.split(/\\r?\\n/)) {
    if (!line.trim()) continue;
    const i = line.indexOf(':');
    if (i <= 0) { document.getElementById('out').textContent = 'Error: invalid header line: ' + line; return; }
    responseHeaders[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  const headersMode = document.getElementById('headers-append').checked ? 'append' : 'replace';
  const res = await fetch(apiFilesUrl(), {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({filename, ext, content, mode, tags, raw, response: {
      status: responseStatus,
      redirectUrl,
      delayMs,
      headers: responseHeaders,
      headersMode
    }})
  });
  const data = await res.json();
  const out = document.getElementById('out');
  if (!res.ok) { out.textContent = 'Error: ' + (data.error || res.status); return; }
  out.innerHTML = 'Live at: <a href="' + data.url + '" target="_blank">' + location.origin + data.url + '</a>'
    + '<br><small>mode: ' + data.mode + (data.overwritten ? ' (overwrote existing file)' : '')
    + (data.raw ? ' · raw-only' : '')
    + ' · status: ' + data.response.status
    + (data.response.redirectUrl ? ' · redirect' : '')
    + (data.response.delayMs ? ' · delay: ' + data.response.delayMs + 'ms' : '')
    + '</small>';
}
</script>
</body>
</html>`;
}

function listPageHtml({ files, distinctTags, qTag, qSearch, totalFiles, CREATE_TOKEN }) {
  const rows = files.map(f => {
    const tags = normalizeTags(f.tags);
    const tagsHtml = tags.map(tag => `<span class="tag">${escapeHtml(tag)}</span>`).join(' ');
    const tagData = JSON.stringify(tags.map(tag => tag.toLowerCase()));
    const safeName = escapeHtml(f.name);
    const responseSummary = `${f.response?.status || 200}${f.response?.redirectUrl ? ' ↗' : ''}${f.response?.delayMs ? ' · ' + f.response.delayMs + 'ms' : ''}${Object.keys(f.response?.headers || {}).length ? ' · ' + Object.keys(f.response.headers).length + ' hdr' : ''}`;

    return `<tr data-name="${safeName}" data-search="${escapeHtml(f.name.toLowerCase())}" data-tags="${escapeHtml(tagData)}">
    <td><a href="${fileUrl(f.name)}" target="_blank">${safeName}</a>${f.raw ? ' <span class="raw-badge">raw-only</span>' : ''}</td>
    <td>${tagsHtml}</td>
    <td>${f.size} B</td>
    <td>${new Date(f.modified).toLocaleString()}<br><span class="response-badge">${escapeHtml(responseSummary)}</span></td>
    <td class="actions">
      <button onclick="toggleRaw('${f.name.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}', ${f.raw ? 'true' : 'false'})">${f.raw ? 'make live' : 'make raw-only'}</button>
      <button onclick="tagFile('${f.name.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}')">tags</button>
      <button onclick="renameFile('${f.name.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}')">rename</button>
      <button onclick="responseFile('${f.name.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}')">response</button>
      <button class="danger" onclick="deleteFile('${f.name.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}')">delete</button>
    </td>
  </tr>`;
  }).join('');

  const tagOptions = distinctTags.map(t =>
    `<option value="${escapeHtml(t)}" ${t === qTag ? 'selected' : ''}>${escapeHtml(t)}</option>`
  ).join('');

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>PoC files</title>
${FAVICON_LINK}
<style>
  *{box-sizing:border-box}
  body{font-family:system-ui,sans-serif;margin:0;background:#000;color:#fff;padding:60px 20px;position:relative;overflow-x:hidden}
  .blob{position:fixed;border-radius:50%;filter:blur(90px);z-index:0;pointer-events:none}
  .b1{width:420px;height:420px;top:-120px;left:-100px;background:#3a3ea8;opacity:.35}
  .b2{width:380px;height:380px;bottom:-140px;right:-80px;background:#7a2f6e;opacity:.3}
  .b3{width:300px;height:300px;top:40%;right:10%;background:#1f6f78;opacity:.22}
  .wrap{max-width:1000px;margin:0 auto;position:relative;z-index:1}
  h2{font-weight:400;margin:0 0 20px;font-size:22px}
  .card{background:linear-gradient(155deg,rgba(255,255,255,.09),rgba(255,255,255,.02));backdrop-filter:blur(24px) saturate(160%);-webkit-backdrop-filter:blur(24px) saturate(160%);border:1px solid rgba(255,255,255,.14);border-radius:22px;padding:20px 24px;box-shadow:0 20px 60px rgba(0,0,0,.55),inset 0 1px 0 rgba(255,255,255,.12)}
  table{width:100%;border-collapse:collapse;margin-top:8px}
  th,td{text-align:left;padding:12px 8px;border-bottom:1px solid rgba(255,255,255,.1);font-size:13px;vertical-align:top}
  th{color:rgba(255,255,255,.5);font-weight:400;font-size:11px;text-transform:uppercase;letter-spacing:.04em}
  tr:last-child td{border-bottom:0}
  a{color:#fff;word-break:break-all}
  .empty{color:rgba(255,255,255,.5);margin-top:4px;font-size:13px}
  .actions{white-space:nowrap}
  .tag,.raw-badge,.response-badge{display:inline-block;border:1px solid rgba(255,255,255,.18);background:rgba(255,255,255,.06);color:rgba(255,255,255,.75);padding:3px 10px;border-radius:999px;font-size:11px;margin:2px 4px 2px 0}
  .raw-badge{margin-left:6px;color:rgba(255,255,255,.5)}
  button{padding:6px 12px;border:1px solid rgba(255,255,255,.16);border-radius:999px;background:rgba(255,255,255,.06);color:rgba(255,255,255,.8);cursor:pointer;font-size:11px;margin-right:6px;margin-bottom:4px;backdrop-filter:blur(6px);transition:transform .15s ease,background .15s ease}
  button:hover{background:rgba(255,255,255,.14);color:#fff;transform:translateY(-1px)}
  button.danger{color:#ff9b9b;border-color:rgba(255,120,120,.3)}
  button.danger:hover{background:rgba(255,80,80,.16)}
  #token-row{margin-bottom:16px;font-size:13px;color:rgba(255,255,255,.5)}
  #filter-row{margin-bottom:16px;display:flex;gap:12px;flex-wrap:wrap;align-items:center}
  #filter-row input,#filter-row select{background:rgba(255,255,255,.06);color:#fff;border:1px solid rgba(255,255,255,.15);border-radius:10px;padding:8px 10px;font-size:13px}
  #filter-row input{min-width:240px;flex:1}
  #filter-row select option{background:#111}
  #filter-row a{font-size:12px;color:rgba(255,255,255,.5);align-self:center}
</style>
</head>
<body>
<div class="blob b1"></div><div class="blob b2"></div><div class="blob b3"></div>
<div class="wrap">
<h2 id="count-heading">PoC files (${files.length}${qTag || qSearch ? ` of ${totalFiles}` : ''})</h2>
${CREATE_TOKEN ? '<div id="token-row">Logged in via cookie · <a href="' + APP_BASE + '/logout">log out</a> · <a href="' + APP_BASE + '/callbacks">callback catcher</a></div>' : '<div id="token-row"><a href="' + APP_BASE + '/callbacks">callback catcher</a></div>'}
<div class="card">
<div id="filter-row">
  <select id="tag-filter" onchange="liveFilter()">
    <option value="">All tags</option>
    ${tagOptions}
  </select>
  <input id="search" placeholder="search name or tag..." value="${escapeHtml(qSearch)}" oninput="liveFilter()">
  <a id="clear-filter-link" href="${APP_BASE}/list" style="${qTag || qSearch ? '' : 'display:none'}">clear filter</a>
</div>
${files.length ? `<table id="fileTable"><tr><th>name</th><th>tags</th><th>size</th><th>modified</th><th></th></tr>${rows}</table><div class="empty" id="no-match" style="display:none">nothing matches</div>` : '<div class="empty">nothing matches — try clearing the filter, or create one at ' + APP_BASE + '/create</div>'}
</div>
</div>
<script>
const TOTAL_FILES = ${totalFiles};
const APP_BASE = '${APP_BASE}';
const API_FILES = APP_BASE + '/api/files';
function apiFilesUrl(name=''){ return API_FILES + (name ? '/' + encodeURIComponent(name) : ''); }

function liveFilter(){
  const tag = document.getElementById('tag-filter').value.toLowerCase();
  const q = document.getElementById('search').value.trim().toLowerCase();
  const table = document.getElementById('fileTable');
  if (table) {
    let visible = 0;
    table.querySelectorAll('tr[data-name]').forEach(tr => {
      const rowTags = tr.dataset.tags || '[]';
      const rowSearch = tr.dataset.search || '';
      let tags = [];
      try { tags = JSON.parse(rowTags); } catch {}
      const matchesTag = !tag || tags.includes(tag);
      const matchesSearch = !q || rowSearch.includes(q) || tags.some(value => value.includes(q));
      const matches = matchesTag && matchesSearch;
      tr.style.display = matches ? '' : 'none';
      if (matches) visible++;
    });
    const noMatch = document.getElementById('no-match');
    if (noMatch) noMatch.style.display = visible === 0 ? '' : 'none';
    const heading = document.getElementById('count-heading');
    if (heading) heading.textContent = 'PoC files (' + visible + (tag || q ? ' of ' + TOTAL_FILES : '') + ')';
  }
  const params = new URLSearchParams(location.search);
  const rawTag = document.getElementById('tag-filter').value;
  if (rawTag) params.set('tag', rawTag); else params.delete('tag');
  if (q) params.set('q', q); else params.delete('q');
  const qs = params.toString();
  history.replaceState(null, '', APP_BASE + '/list' + (qs ? '?' + qs : ''));
  const clearLink = document.getElementById('clear-filter-link');
  if (clearLink) clearLink.style.display = qs ? '' : 'none';
}

function tagFile(name){
  const row = document.querySelector('tr[data-name="' + CSS.escape(name) + '"]');
  const existing = row ? Array.from(row.querySelectorAll('.tag')).map(el => el.textContent.trim()) : [];
  const current = existing.join(', ');
  const value = prompt(
    'Edit tags for ' + name + '\\n\\nEnter multiple tags separated by commas. Empty = remove all tags.',
    current
  );
  if (value === null) return;

  const tags = value.split(',').map(v => v.trim()).filter(Boolean);
  updateTags(name, tags);
}

async function updateTags(name, tags){
  const res = await fetch(apiFilesUrl(name) + '/tags', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({ tags })
  });
  const data = await res.json();
  if (!res.ok) { alert('Error: ' + (data.error || res.status)); return; }
  location.reload();
}

async function responseFile(name){
  const base = apiFilesUrl(name) + '/response';
  const currentRes = await fetch(base);
  const currentData = await currentRes.json().catch(() => ({}));
  if (!currentRes.ok) { alert('Error: ' + (currentData.error || currentRes.status)); return; }
  const current = currentData.response || {status:200, redirectUrl:'', delayMs:0, headers:{}};

  const statusValue = prompt('Response status (100-599):', String(current.status));
  if (statusValue === null) return;
  const status = Number(statusValue);
  if (!Number.isInteger(status) || status < 100 || status > 599) { alert('Invalid status'); return; }

  const redirectUrl = prompt('Redirect URL (empty = normal response):', current.redirectUrl || '');
  if (redirectUrl === null) return;

  const delayValue = prompt('Response delay in milliseconds (0-30000):', String(current.delayMs || 0));
  if (delayValue === null) return;
  const delayMs = Number(delayValue);
  if (!Number.isInteger(delayMs) || delayMs < 0 || delayMs > 30000) { alert('Invalid delay'); return; }

  const headerText = Object.entries(current.headers || {}).map(([k,v]) => k + ': ' + v).join('\\n');
  const newHeaderText = prompt('Response headers, one per line (Name: value):', headerText);
  if (newHeaderText === null) return;
  const headers = {};
  for (const line of newHeaderText.split(/\\r?\\n/)) {
    if (!line.trim()) continue;
    const i = line.indexOf(':');
    if (i <= 0) { alert('Invalid header line: ' + line); return; }
    headers[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }

  const append = confirm('Append/merge with existing headers?\\n\\nDuplicate names overwrite the old value.\\n\\nCancel = replace all custom response headers.');
  const res = await fetch(base, {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({response: {status, redirectUrl, delayMs, headers, headersMode: append ? 'append' : 'replace'}})
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { alert('Error: ' + (data.error || res.status)); return; }
  location.reload();
}

async function deleteFile(name){
  if (!confirm('Delete ' + name + '?')) return;
  const res = await fetch(apiFilesUrl(name), { method: 'DELETE' });
  const data = await res.json();
  if (!res.ok) { alert('Error: ' + (data.error || res.status)); return; }
  const row = document.querySelector('tr[data-name="' + CSS.escape(name) + '"]');
  if (row) row.remove();
}

async function renameFile(name){
  const newName = prompt('New name for ' + name + ' (include extension if you want one):', name);
  if (!newName || newName === name) return;
  const res = await fetch(apiFilesUrl(name) + '/rename', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({ newName })
  });
  const data = await res.json();
  if (!res.ok) { alert('Error: ' + (data.error || res.status)); return; }
  location.reload();
}

async function toggleRaw(name, currentlyRaw){
  const makeRaw = !currentlyRaw;
  const msg = makeRaw
    ? 'Make ' + name + ' raw-only? It will always be served as text/plain and will never execute for any viewer, no matter what URL they use.'
    : 'Make ' + name + ' live again? It will be served with its real content type and will execute for any viewer.';
  if (!confirm(msg)) return;
  const res = await fetch(apiFilesUrl(name) + '/raw', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({ raw: makeRaw })
  });
  const data = await res.json();
  if (!res.ok) { alert('Error: ' + (data.error || res.status)); return; }
  location.reload();
}
</script>
</body>
</html>`;
}

// --- callback catcher page -----------------------------------------------
function callbackPageHtml({ requests, qId, totalRequests, newId }) {
  const rows = requests.map(row => {
    const r = parseCallbackRow(row);
    const queryText = r.query.map(([k, v]) => `${k}=${v}`).join('&');
    return `<tr>
      <td><span class="method">${escapeHtml(r.method === 'BROWSER' ? 'BROWSER' : r.method)}</span></td>
      <td><code>${escapeHtml(r.id)}</code></td>
      <td>${escapeHtml(r.ip || '—')}</td>
      <td class="wrap-cell">${escapeHtml(r.referer || '—')}</td>
      <td class="wrap-cell">${escapeHtml(queryText || '—')}</td>
      <td>${escapeHtml(r.body ? r.body.slice(0, 160) : '—')}${r.body.length > 160 || r.bodyTruncated ? '…' : ''}</td>
      <td>${escapeHtml(new Date(r.received).toLocaleString())}</td>
      <td><button onclick="showCallback(${Number(r.seq) || 0})">view</button></td>
    </tr>`;
  }).join('');


  const firstUrl = callbackUrl(newId);
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Callback catcher</title>
${FAVICON_LINK}
<style>
  *{box-sizing:border-box}
  body{font-family:system-ui,sans-serif;margin:0;background:#000;color:#fff;padding:50px 20px;position:relative;overflow-x:hidden}
  .blob{position:fixed;border-radius:50%;filter:blur(90px);z-index:0;pointer-events:none}
  .b1{width:420px;height:420px;top:-120px;left:-100px;background:#3a3ea8;opacity:.35}
  .b2{width:380px;height:380px;bottom:-140px;right:-80px;background:#7a2f6e;opacity:.3}
  .b3{width:300px;height:300px;top:40%;right:10%;background:#1f6f78;opacity:.22}
  .wrap{max-width:1200px;margin:0 auto;position:relative;z-index:1}
  .top{display:flex;justify-content:space-between;align-items:center;gap:12px;margin-bottom:18px;flex-wrap:wrap}
  h2{font-weight:400;margin:0;font-size:22px}
  .nav a{color:rgba(255,255,255,.6);font-size:12px;margin-left:14px}
  .card{background:linear-gradient(155deg,rgba(255,255,255,.09),rgba(255,255,255,.02));backdrop-filter:blur(24px) saturate(160%);-webkit-backdrop-filter:blur(24px) saturate(160%);border:1px solid rgba(255,255,255,.14);border-radius:22px;padding:20px 24px;box-shadow:0 20px 60px rgba(0,0,0,.55),inset 0 1px 0 rgba(255,255,255,.12);margin-bottom:16px}
  .grid{display:grid;grid-template-columns:1fr auto;gap:10px}
  label{display:block;margin-bottom:5px;font-size:11px;color:rgba(255,255,255,.5);text-transform:uppercase;letter-spacing:.04em}
  input{width:100%;background:rgba(255,255,255,.05);color:#fff;border:1px solid rgba(255,255,255,.12);border-radius:10px;padding:10px 12px;font-size:13px}
  input:focus{outline:0;border-color:rgba(255,255,255,.35)}
  .url{display:grid;grid-template-columns:1fr auto auto;gap:8px;margin-top:10px}
  button{padding:8px 12px;border:1px solid rgba(255,255,255,.16);border-radius:999px;background:rgba(255,255,255,.06);color:rgba(255,255,255,.85);cursor:pointer;font-size:11px;margin-right:5px;margin-bottom:4px}
  button:hover{background:rgba(255,255,255,.14);color:#fff}
  button.danger{color:#ff9b9b;border-color:rgba(255,120,120,.3)}
  .hint{margin-top:10px;color:rgba(255,255,255,.5);font-size:12px;line-height:1.6}
  code,pre{font-family:ui-monospace,SFMono-Regular,Consolas,monospace}
  .snippet{margin-top:10px;padding:10px 12px;background:rgba(0,0,0,.22);border-radius:10px;color:rgba(255,255,255,.72);font-size:12px;overflow:auto}
  .bar{display:flex;gap:8px;justify-content:space-between;align-items:center;flex-wrap:wrap;margin-bottom:14px}
  .bar .left{display:flex;gap:8px;align-items:center}
  .count{font-size:12px;color:rgba(255,255,255,.45)}
  table{width:100%;border-collapse:collapse}
  th,td{text-align:left;padding:10px 8px;border-bottom:1px solid rgba(255,255,255,.1);font-size:12px;vertical-align:top}
  th{color:rgba(255,255,255,.5);font-weight:400;font-size:10px;text-transform:uppercase;letter-spacing:.04em}
  tr:last-child td{border-bottom:0}
  .method{display:inline-block;padding:3px 8px;border-radius:999px;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.13);font-size:10px}
  .wrap-cell{max-width:220px;word-break:break-word}
  .empty{color:rgba(255,255,255,.5);font-size:13px}
  #detail{white-space:pre-wrap;word-break:break-word;margin:0;padding:12px;background:rgba(0,0,0,.3);border-radius:12px;max-height:70vh;overflow:auto;font-size:12px;color:rgba(255,255,255,.78)}
  @media(max-width:900px){table{display:block;overflow:auto;white-space:nowrap}.grid{grid-template-columns:1fr}.url{grid-template-columns:1fr}}
</style>
</head>
<body>
<div class="blob b1"></div><div class="blob b2"></div><div class="blob b3"></div>
<div class="wrap">
  <div class="top">
    <h2>Callback catcher</h2>
    <div class="nav"><a href="${APP_BASE}/list">files</a><a href="${APP_BASE}/create">create</a><a href="${APP_BASE}/logout">log out</a></div>
  </div>

  <div class="card">
    <div class="grid">
      <div><label>Catcher ID</label><input id="catcher-id" value="${escapeHtml(newId)}" oninput="updateUrl()"></div>
      <div style="align-self:end"><button onclick="randomId()">new id</button></div>
    </div>
    <div class="url">
      <input id="callback-url" value="${escapeHtml(firstUrl)}" readonly>
      <button onclick="copyValue('callback-url')">copy URL</button>
      <a id="open-link" href="${escapeHtml(firstUrl)}" target="_blank"><button type="button">open</button></a>
    </div>
    <div class="snippet" id="snippet"></div>
    <div class="hint">A GET to this URL returns a fixed HTML page with fixed JavaScript. The Worker records the incoming IP, headers, query, body, Referer and User-Agent; the page then sends browser-side data such as <code>location.href</code>, <code>location.hash</code>, viewport, screen, language and timezone to <code>/collect</code>. Browser JavaScript cannot enumerate arbitrary HTTP headers, so the Worker captures those server-side from the request itself.</div>
  </div>

  <div class="card">
    <div class="bar">
      <div class="left">
        <form method="GET" action="${APP_BASE}/callbacks"><input name="id" value="${escapeHtml(qId)}" placeholder="filter by catcher ID" style="width:240px"></form>
        <span class="count">${requests.length}${qId ? ` of ${totalRequests}` : ''} shown</span>
      </div>
      <div><button onclick="location.reload()">refresh</button><button class="danger" onclick="clearCallbacks()">clear ${qId ? 'this ID' : 'all'}</button></div>
    </div>
    ${requests.length ? `<div style="overflow:auto"><table><tr><th>method</th><th>id</th><th>ip</th><th>referer</th><th>query</th><th>body</th><th>received</th><th></th></tr>${rows}</table></div>` : '<div class="empty">No callbacks captured yet.</div>'}
  </div>

  <div class="card" id="detail-card" style="display:none"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px"><span style="font-size:12px;color:rgba(255,255,255,.5)">request details</span><button onclick="document.getElementById('detail-card').style.display='none'">close</button></div><pre id="detail"></pre></div>
</div>
<script>
const APP_BASE = ${JSON.stringify(APP_BASE)};
const CALLBACK_BASE = ${JSON.stringify(CALLBACK_BASE)};
const initialId = ${JSON.stringify(newId)};

function updateUrl(){
  const id = document.getElementById('catcher-id').value.trim() || initialId;
  const url = CALLBACK_BASE + '/' + encodeURIComponent(id);
  document.getElementById('callback-url').value = location.origin + url;
  document.getElementById('open-link').href = url;
  document.getElementById('snippet').textContent = '<GET ' + (location.origin + url) + '>  →  fixed HTML + browser report to ' + (location.origin + url + '/collect');
}
function randomId(){
  const id = (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36)).slice(0, 12);
  document.getElementById('catcher-id').value = id;
  updateUrl();
}
async function copyValue(id){
  const value = document.getElementById(id).value;
  try { await navigator.clipboard.writeText(value); } catch { window.prompt('Copy this value:', value); }
}
async function showCallback(seq){
  const card = document.getElementById('detail-card');
  const detail = document.getElementById('detail');
  card.style.display = '';
  detail.style.display = 'block';
  detail.textContent = 'Loading…';
  card.scrollIntoView({behavior:'smooth',block:'nearest'});
  try {
    const res = await fetch(APP_BASE + '/api/callbacks?seq=' + encodeURIComponent(seq));
    const data = await res.json();
    if (!res.ok || !data.request) { detail.textContent = 'Request not found'; return; }
    const r = data.request;
    const queryText = r.query.map(([k,v]) => k + '=' + v).join('&');
    let bodyText = r.body || '—';
    if (r.method === 'BROWSER' && r.body) {
      try { bodyText = JSON.stringify(JSON.parse(r.body), null, 2); } catch {}
    }
    detail.textContent = [
      'Sequence: ' + r.seq,
      'ID: ' + r.id,
      'Method: ' + r.method,
      'URL: ' + r.url,
      'IP: ' + (r.ip || '—'),
      'Referer: ' + (r.referer || '—'),
      'User-Agent: ' + (r.userAgent || '—'),
      'Location hash: ' + (r.locationHash || '—'),
      'Query: ' + (queryText || '—'),
      'Headers' + (r.headersTruncated ? ' (truncated)' : '') + ':',
      JSON.stringify(r.headers, null, 2),
      (r.method === 'BROWSER' ? 'Browser data' : 'Body') + (r.bodyTruncated ? ' (truncated)' : '') + ':',
      bodyText,
      'Received: ' + new Date(r.received).toLocaleString(),
    ].join('\\n');
  } catch (e) {
    detail.textContent = 'Failed to load request details';
  }
}
async function clearCallbacks(){
  const id = new URLSearchParams(location.search).get('id') || '';
  if (!confirm(id ? 'Clear callbacks for ' + id + '?' : 'Clear all callbacks?')) return;
  const url = APP_BASE + '/api/callbacks' + (id ? '?id=' + encodeURIComponent(id) : '');
  const res = await fetch(url, {method:'DELETE'});
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { alert(data.error || 'delete failed'); return; }
  location.reload();
}
updateUrl();
</script>
</body>
</html>`;
}

// --- login page ---------------------------------------------------------
// Shown by the management list/create pages when there is no valid token
// or cookie. Submitting the right token sets the cookie and reloads the same
// URL (so ?tag=... filters etc. are preserved).
function loginPageHtml() {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>PoC host</title>
${FAVICON_LINK}
<style>
  *{box-sizing:border-box}
  body{font-family:system-ui,sans-serif;margin:0;background:#000;color:#fff;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px;position:relative;overflow:hidden}
  .blob{position:fixed;border-radius:50%;filter:blur(90px);z-index:0;pointer-events:none}
  .b1{width:420px;height:420px;top:-120px;left:-100px;background:#3a3ea8;opacity:.35}
  .b2{width:380px;height:380px;bottom:-140px;right:-80px;background:#7a2f6e;opacity:.3}
  .card{position:relative;z-index:1;width:100%;max-width:360px;background:linear-gradient(155deg,rgba(255,255,255,.09),rgba(255,255,255,.02));backdrop-filter:blur(24px) saturate(160%);-webkit-backdrop-filter:blur(24px) saturate(160%);border:1px solid rgba(255,255,255,.14);border-radius:22px;padding:28px;box-shadow:0 20px 60px rgba(0,0,0,.55),inset 0 1px 0 rgba(255,255,255,.12)}
  h2{font-weight:400;margin:0 0 20px;font-size:20px}
  input{width:100%;background:rgba(255,255,255,.05);color:#fff;border:1px solid rgba(255,255,255,.12);border-radius:12px;padding:10px 12px;font-size:14px}
  input:focus{outline:0;border-color:rgba(255,255,255,.4);background:rgba(255,255,255,.08)}
  button{margin-top:18px;width:100%;padding:11px 24px;border:1px solid rgba(255,255,255,.25);border-radius:999px;background:linear-gradient(155deg,rgba(255,255,255,.22),rgba(255,255,255,.06));color:#fff;cursor:pointer;font-size:13px}
  #err{margin-top:14px;font-size:13px;color:#ff9b9b;min-height:1em}
</style>
</head>
<body>
<div class="blob b1"></div><div class="blob b2"></div>
<form class="card" onsubmit="return login(event)">
  <h2>Token</h2>
  <input id="token" type="password" placeholder="token" autocomplete="current-password" autofocus>
  <button type="submit">Enter</button>
  <div id="err"></div>
</form>
<script>
async function login(e){
  e.preventDefault();
  const err = document.getElementById('err');
  err.textContent = '';
  const token = document.getElementById('token').value;
  const res = await fetch(APP_BASE + '/login', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({ token })
  });
  if (res.ok) { location.reload(); return; }
  err.textContent = 'Wrong token';
  return false;
}
</script>
</body>
</html>`;
}

async function handleLogin(req, env) {
  let body = {};
  try { body = await req.json(); } catch {}
  const CREATE_TOKEN = env.CREATE_TOKEN || null;
  if (!CREATE_TOKEN) return json({ ok: true });
  if (!body || body.token !== CREATE_TOKEN) return json({ error: 'wrong token' }, 403);
  const res = json({ ok: true });
  res.headers.append('Set-Cookie', authCookie(CREATE_TOKEN));
  return res;
}

// --- route handlers -----------------------------------------------------

// NOTE: no auth here, on purpose. PoC links must be openable by anyone.
async function handleGetF(name, env) {
  await ensureResponseSchema(env.DB);
  name = safeName(name);
  if (name === '' || name === '.meta.json') return notFound();
  const row = await getFile(env.DB, name);
  if (!row) return notFound();

  const ext = name.includes('.') ? name.split('.').pop() : '';
  const isRaw = !!row.raw;
  const response = parseResponseConfig(row);

  if (response.delayMs > 0) await new Promise(resolve => setTimeout(resolve, response.delayMs));

  const headers = new Headers({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': '*',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Credentials': 'true',
    'Cross-Origin-Resource-Policy': 'cross-origin',
    'Timing-Allow-Origin': '*',
    'Content-Type': isRaw ? 'text/plain; charset=utf-8' : mimeFor(ext),
    'Cache-Control': 'no-store',
  });

  for (const [headerName, value] of Object.entries(response.headers)) {
    if (isRaw && headerName.toLowerCase() === 'content-type') continue;
    headers.set(headerName, value);
  }
  if (response.redirectUrl) headers.set('Location', response.redirectUrl);

  const body = NO_BODY_STATUSES.has(response.status) ? null : row.content;
  return new Response(body, { status: response.status, headers });
}

async function handleCreateOrUpdate(req, url, env) {
  await ensureResponseSchema(env.DB);
  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'invalid JSON body' }, 400);
  }
  if (!checkToken(req, url, body, env)) {
    return json({ error: 'invalid or missing token' }, 403);
  }

  let { filename, ext, content, mode, tag, tags, raw, response } = body || {};
  if (!filename || content === undefined) {
    return json({ error: 'filename and content are required' }, 400);
  }
  mode = mode === 'append' ? 'append' : 'rewrite';

  filename = safeName(filename);
  ext = (ext || '').toString().replace(/^\./, '').replace(/[^a-zA-Z0-9]/g, '');
  if (!filename) return json({ error: 'invalid filename' }, 400);

  const fullName = ext ? `${filename}.${ext}` : filename;
  const existing = await getFile(env.DB, fullName);
  const existed = !!existing;

  let newContent;
  if (mode === 'append' && existing) {
    newContent = existing.content + content;
  } else {
    newContent = content;
  }

  // Only touch tag/raw if explicitly supplied, so appending/re-overwriting
  // doesn't silently clear a tag or flip raw back off — same rule as the
  // original.
  const tagsWasSupplied = Object.prototype.hasOwnProperty.call(body || {}, 'tags') ||
    Object.prototype.hasOwnProperty.call(body || {}, 'tag');
  const suppliedTags = Object.prototype.hasOwnProperty.call(body || {}, 'tags')
    ? tags
    : tag;
  const nextTags = tagsWasSupplied
    ? normalizeTags(suppliedTags)
    : parseStoredTags(existing ? existing.tag : null);
  const nextTag = serializeTags(nextTags);
  const nextRaw =
    raw !== undefined
      ? (raw === true || raw === 'true' ? 1 : 0)
      : (existing ? existing.raw : 0);

  const responseSupplied = Object.prototype.hasOwnProperty.call(body || {}, 'response');
  let nextResponse = existing ? parseResponseConfig(existing) : { status: 200, headers: {}, redirectUrl: '', delayMs: 0 };
  if (responseSupplied) {
    try {
      nextResponse = normalizeResponseConfig(response, existing);
    } catch (error) {
      return json({ error: error?.message || String(error) }, 400);
    }
  }

  await env.DB.prepare(
    `INSERT INTO files (name, ext, content, tag, raw, size, modified, response_status, response_headers, redirect_url, delay_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET
       ext = excluded.ext,
       content = excluded.content,
       tag = excluded.tag,
       raw = excluded.raw,
       size = excluded.size,
       modified = excluded.modified,
       response_status = excluded.response_status,
       response_headers = excluded.response_headers,
       redirect_url = excluded.redirect_url,
       delay_ms = excluded.delay_ms`
  )
    .bind(fullName, ext, newContent, nextTag, nextRaw, byteLen(newContent), Date.now(), nextResponse.status, JSON.stringify(nextResponse.headers), nextResponse.redirectUrl || null, nextResponse.delayMs)
    .run();

  return withAuthCookie(
    json({
      ok: true,
      url: fileUrl(fullName),
      mode,
      overwritten: mode === 'rewrite' && existed,
      raw: !!nextRaw,
      tags: nextTags,
      response: nextResponse,
    }),
    req, url, body, env
  );
}

async function handleDelete(name, req, url, env) {
  if (!checkToken(req, url, null, env)) return json({ error: 'invalid or missing token' }, 403);
  name = safeName(name);
  const existing = await getFile(env.DB, name);
  if (!existing) return json({ error: 'not found' }, 404);
  await env.DB.prepare('DELETE FROM files WHERE name = ?').bind(name).run();
  return json({ ok: true, deleted: name });
}

async function handleSetTags(name, req, url, env) {
  let body = {};
  try { body = await req.json(); } catch {}
  if (!checkToken(req, url, body, env)) return json({ error: 'invalid or missing token' }, 403);
  name = safeName(name);
  const existing = await getFile(env.DB, name);
  if (!existing) return json({ error: 'not found' }, 404);

  const hasTags = Object.prototype.hasOwnProperty.call(body || {}, 'tags');
  const hasLegacyTag = Object.prototype.hasOwnProperty.call(body || {}, 'tag');
  if (!hasTags && !hasLegacyTag) return json({ error: 'tags is required' }, 400);

  const tags = normalizeTags(hasTags ? body.tags : body.tag);
  const stored = serializeTags(tags);
  await env.DB.prepare('UPDATE files SET tag = ? WHERE name = ?')
    .bind(stored, name)
    .run();

  return json({ ok: true, name, tag: tags[0] || null, tags });
}

async function handleSetTag(name, req, url, env) {
  // Backward-compatible alias for older clients: {tag: "value"} or empty to clear.
  return handleSetTags(name, req, url, env);
}

async function handleSetRaw(name, req, url, env) {
  let body = {};
  try { body = await req.json(); } catch {}
  if (!checkToken(req, url, body, env)) return json({ error: 'invalid or missing token' }, 403);
  name = safeName(name);
  const existing = await getFile(env.DB, name);
  if (!existing) return json({ error: 'not found' }, 404);
  const raw = !!(body && body.raw);
  await env.DB.prepare('UPDATE files SET raw = ? WHERE name = ?')
    .bind(raw ? 1 : 0, name)
    .run();
  return json({ ok: true, name, raw });
}

async function handleResponseConfig(name, req, url, env) {
  await ensureResponseSchema(env.DB);
  if (!checkToken(req, url, null, env)) return json({ error: 'invalid or missing token' }, 403);
  name = safeName(name);
  const existing = await getFile(env.DB, name);
  if (!existing) return json({ error: 'not found' }, 404);

  if (req.method === 'GET') {
    return withAuthCookie(json({ ok: true, name, response: parseResponseConfig(existing) }), req, url, null, env);
  }

  let body;
  try { body = await req.json(); } catch { return json({ error: 'invalid JSON body' }, 400); }
  try {
    const input = Object.prototype.hasOwnProperty.call(body || {}, 'response') ? body.response : body;
    const next = normalizeResponseConfig(input, existing);
    await env.DB.prepare(
      `UPDATE files SET response_status = ?, response_headers = ?, redirect_url = ?, delay_ms = ?, modified = ? WHERE name = ?`
    )
      .bind(next.status, JSON.stringify(next.headers), next.redirectUrl || null, next.delayMs, Date.now(), name)
      .run();
    return withAuthCookie(json({ ok: true, name, response: next }), req, url, body, env);
  } catch (error) {
    return json({ error: error?.message || String(error) }, 400);
  }
}

async function handleRename(name, req, url, env) {
  let body = {};
  try { body = await req.json(); } catch {}
  if (!checkToken(req, url, body, env)) return json({ error: 'invalid or missing token' }, 403);
  name = safeName(name);
  const newName = safeName(((body && body.newName) || '').toString().trim());
  if (!newName) return json({ error: 'newName is required' }, 400);

  const existing = await getFile(env.DB, name);
  if (!existing) return json({ error: 'not found' }, 404);
  const dest = await getFile(env.DB, newName);
  if (dest) return json({ error: 'a file with that name already exists' }, 409);

  await env.DB.prepare('UPDATE files SET name = ? WHERE name = ?')
    .bind(newName, name)
    .run();
  return json({ ok: true, url: fileUrl(newName) });
}

async function handleListApi(req, url, env) {
  await ensureResponseSchema(env.DB);
  if (!checkToken(req, url, null, env)) return json({ error: 'invalid or missing token' }, 403);
  let files = await listFiles(env.DB);
  files = files.map(f => {
    const tags = parseStoredTags(f.tag);
    return {
      name: f.name,
      url: fileUrl(f.name),
      size: f.size,
      modified: f.modified,
      tag: tags[0] || null,
      tags,
      raw: !!f.raw,
      response: parseResponseConfig(f),
    };
  });
  const wantedTag = url.searchParams.get('tag');
  if (wantedTag) {
    const w = wantedTag.toLowerCase();
    files = files.filter(f => f.tags.some(tag => tag.toLowerCase() === w));
  }
  return withAuthCookie(json({ files }), req, url, null, env);
}

async function handleListPage(req, url, env) {
  await ensureResponseSchema(env.DB);
  if (!checkToken(req, url, null, env)) return html(loginPageHtml(), 401);
  const CREATE_TOKEN = env.CREATE_TOKEN || null;

  // First visit with ?token=...: remember it in a cookie and redirect to the
  // same URL without the token, so it doesn't linger in the address bar or
  // browser history.
  if (CREATE_TOKEN && url.searchParams.get('token') === CREATE_TOKEN) {
    const clean = new URL(url);
    clean.searchParams.delete('token');
    const res = new Response(null, {
      status: 302,
      headers: { Location: clean.pathname + clean.search },
    });
    res.headers.append('Set-Cookie', authCookie(CREATE_TOKEN));
    return res;
  }

  const all = await listFiles(env.DB);
  const totalFiles = all.length;
  const qTag = (url.searchParams.get('tag') || '').trim();
  const qSearch = (url.searchParams.get('q') || '').trim().toLowerCase();

  const normalizedAll = all.map(f => ({
    ...f,
    tags: parseStoredTags(f.tag),
    response: parseResponseConfig(f),
  }));
  const distinctTags = [...new Set(normalizedAll.flatMap(f => f.tags))].sort((a, b) => a.localeCompare(b));

  let files = normalizedAll;
  if (qTag) files = files.filter(f => f.tags.includes(qTag));
  if (qSearch) files = files.filter(f =>
    f.name.toLowerCase().includes(qSearch) || f.tags.some(tag => tag.toLowerCase().includes(qSearch))
  );

  return html(listPageHtml({ files, distinctTags, qTag, qSearch, totalFiles, CREATE_TOKEN }));
}

async function handleCallbacksApi(req, url, env) {
  if (!checkToken(req, url, null, env)) return json({ error: 'invalid or missing token' }, 403);
  try {
    await ensureCallbackSchema(env.DB);
  } catch (error) {
    console.error('Callback API bootstrap error', error?.message || String(error));
    return json({ error: error?.message || String(error) }, 500);
  }
  const seq = Number(url.searchParams.get('seq') || 0);
  if (seq > 0) {
    const row = await getCallback(env.DB, seq);
    return withAuthCookie(
      json({ request: row ? parseCallbackRow(row) : null }),
      req, url, null, env
    );
  }
  const id = callbackId(url.searchParams.get('id') || '');
  const limit = url.searchParams.get('limit') || '100';
  const rows = await listCallbacks(env.DB, id, limit);
  return withAuthCookie(
    json({ requests: rows.map(parseCallbackRow) }),
    req, url, null, env
  );
}

async function handleDeleteCallbacks(req, url, env) {
  if (!checkToken(req, url, null, env)) return json({ error: 'invalid or missing token' }, 403);
  try {
    await ensureCallbackSchema(env.DB);
  } catch (error) {
    console.error('Callback API bootstrap error', error?.message || String(error));
    return json({ error: error?.message || String(error) }, 500);
  }
  const id = callbackId(url.searchParams.get('id') || '');
  if (id) {
    await env.DB.prepare('DELETE FROM callback_requests WHERE id = ?').bind(id).run();
    return json({ ok: true, id });
  }
  await env.DB.prepare('DELETE FROM callback_requests').run();
  return json({ ok: true, all: true });
}

async function handleCallbacksPage(req, url, env) {
  if (!checkToken(req, url, null, env)) return html(loginPageHtml(), 401);
  try {
    await ensureCallbackSchema(env.DB);
    const qId = callbackId(url.searchParams.get('id') || '');
    const all = await listCallbacks(env.DB, qId, 200);
    let totalRequests = all.length;
    if (qId) {
      const count = await env.DB.prepare('SELECT COUNT(*) AS count FROM callback_requests WHERE id = ?').bind(qId).first();
      totalRequests = Number(count?.count || 0);
    } else {
      const count = await env.DB.prepare('SELECT COUNT(*) AS count FROM callback_requests').first();
      totalRequests = Number(count?.count || all.length);
    }
    const newId = ((crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36)).replace(/-/g, '')).slice(0, 12);
    return html(callbackPageHtml({ requests: all, qId, totalRequests, newId }));
  } catch (error) {
    console.error('Callback panel error', error?.message || String(error));
    return html(`<!doctype html><meta charset="utf-8"><title>Callback storage error</title><pre style="white-space:pre-wrap;font:14px monospace">Callback storage error\n\n${escapeHtml(error?.message || String(error))}</pre>`, 500);
  }
}

function handleLogout() {
  const res = html('logged out');
  res.headers.append('Set-Cookie', clearAuthCookie());
  return res;
}

// --- main fetch handler ---------------------------------------------------

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const parts = url.pathname.split('/').filter(Boolean);

    // FILE_PATH/:name — kept at top-level on purpose, deliberately separate-looking
    // from the management path, same as the original. No authentication, ever.
    if (parts[0] === FILE_PATH && parts.length === 2 && request.method === 'GET') {
      return handleGetF(parts[1], env);
    }

    // Public callback catcher: /<CALLBACK_PATH>/<id> accepts every HTTP method.
    // It intentionally requires no management token because callbacks may originate
    // from an unrelated browser/server context.
    if (parts[0] === CALLBACK_PATH && parts.length === 3 && parts[2] === 'collect' && request.method === 'POST') {
      try {
        return await handleCallbackBrowserCollect(request, url, env, parts[1]);
      } catch (error) {
        console.error('Callback browser collect error', {
          message: error?.message || String(error),
          stack: error?.stack || '',
          path: url.pathname,
          method: request.method,
        });
        return new Response(
          `Callback browser collection error\n\n${error?.message || String(error)}\n`,
          { status: 500, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' } }
        );
      }
    }

    if (parts[0] === CALLBACK_PATH && parts.length === 2) {
      try {
        return await handleCallback(request, url, env, parts[1]);
      } catch (error) {
        console.error('Callback catcher error', {
          message: error?.message || String(error),
          stack: error?.stack || '',
          path: url.pathname,
          method: request.method,
        });
        return new Response(
          `Callback storage error\n\n${error?.message || String(error)}\n`,
          {
            status: 500,
            headers: {
              'Content-Type': 'text/plain; charset=utf-8',
              'Cache-Control': 'no-store',
            },
          }
        );
      }
    }

    if (parts[0] === APP_PATH) {
      const sub = parts.slice(1);

      // GET /<APP_PATH>/create
      if (sub.length === 1 && sub[0] === 'create' && request.method === 'GET') {
        if (!checkToken(request, url, null, env)) return html(loginPageHtml(), 401);
        return html(createPageHtml());
      }

      // POST /<APP_PATH>/login — validates the token and sets the cookie
      if (sub.length === 1 && sub[0] === 'login' && request.method === 'POST') {
        return handleLogin(request, env);
      }

      // GET /<APP_PATH>/list
      if (sub.length === 1 && sub[0] === 'list' && request.method === 'GET') {
        return handleListPage(request, url, env);
      }

      // GET /<APP_PATH>/callbacks
      if (sub.length === 1 && sub[0] === 'callbacks' && request.method === 'GET') {
        return handleCallbacksPage(request, url, env);
      }

      // GET/DELETE /<APP_PATH>/api/callbacks
      if (sub[0] === 'api' && sub[1] === 'callbacks') {
        if (sub.length === 2 && request.method === 'GET') {
          return handleCallbacksApi(request, url, env);
        }
        if (sub.length === 2 && request.method === 'DELETE') {
          return handleDeleteCallbacks(request, url, env);
        }
      }

      // GET /<APP_PATH>/logout — clears the remembered-token cookie
      if (sub.length === 1 && sub[0] === 'logout' && request.method === 'GET') {
        return handleLogout();
      }

      // management path/api/files...
      if (sub[0] === 'api' && sub[1] === 'files') {
        // POST /<APP_PATH>/api/files
        if (sub.length === 2 && request.method === 'POST') {
          return handleCreateOrUpdate(request, url, env);
        }
        // GET /<APP_PATH>/api/files
        if (sub.length === 2 && request.method === 'GET') {
          return handleListApi(request, url, env);
        }
        // management path/api/files/:name...
        if (sub.length === 3 && request.method === 'DELETE') {
          return handleDelete(sub[2], request, url, env);
        }
        if (sub.length === 4 && sub[3] === 'tags' && request.method === 'POST') {
          return handleSetTags(sub[2], request, url, env);
        }
        if (sub.length === 4 && sub[3] === 'tag' && request.method === 'POST') {
          return handleSetTag(sub[2], request, url, env);
        }
        if (sub.length === 4 && sub[3] === 'raw' && request.method === 'POST') {
          return handleSetRaw(sub[2], request, url, env);
        }
        if (sub.length === 4 && sub[3] === 'rename' && request.method === 'POST') {
          return handleRename(sub[2], request, url, env);
        }
        if (sub.length === 4 && sub[3] === 'response' && (request.method === 'GET' || request.method === 'POST')) {
          return handleResponseConfig(sub[2], request, url, env);
        }
      }

      // No handler for the bare management path itself — falls through to
      // the generic 404 below, same as the original.
    }

    // Everything else (including bare '/') — identical 404, no hint
    // anything lives under the configured paths.
    return notFound();
  },
};
