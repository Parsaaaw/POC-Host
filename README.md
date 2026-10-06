# POC Host

A lightweight **Cloudflare Workers + D1** host for security-testing PoCs, callback collection, and controlled HTTP response behavior.

It is designed for situations where you need a small, disposable place to host test files and observe out-of-band requests without running a full server.

> **Use responsibly:** deploy this only for systems, applications, and targets you are authorized to test. The callback catcher is intentionally public and stores request metadata such as IP addresses and headers.

---

## ✨ Highlights

| Feature | Description |
|---|---|
| 📦 File host | Store and serve small PoC files directly from D1 |
| 🏷️ Multi-tag | Add multiple tags to every file and filter by them |
| 📝 Rename / delete | Manage files directly from the dashboard |
| 🧩 Raw mode | Keep selected files in raw `text/plain` mode |
| 🔁 Append mode | Append new file content instead of replacing it |
| 🎛️ Response controls | Configure status, headers, redirect target, and delay per file |
| 📡 Callback catcher | Capture out-of-band HTTP requests at `/c/<id>` |
| 🌐 Browser capture | Collect browser-side values such as `location.hash`, URL, viewport, timezone, and more |
| 🔐 Token-protected panel | Protect management routes with a Wrangler secret |
| ⚙️ Configurable paths | Change the management, file, and callback prefixes from one config block |
| ☁️ No filesystem | Uses Cloudflare D1 instead of a server-side disk/volume |

---

## 🧱 Architecture

```text
                         ┌──────────────────────┐
                         │   Cloudflare Worker   │
                         └──────────┬───────────┘
                                    │
                 ┌──────────────────┼──────────────────┐
                 │                  │                  │
                 ▼                  ▼                  ▼
          Management UI       Public files        Callback catcher
           /poc_app/*             /f/*                /c/*
                 │                  │                  │
                 └──────────────────┼──────────────────┘
                                    ▼
                                Cloudflare D1
```

The Worker contains the dashboard HTML/JavaScript, while D1 stores file content, metadata, callback records, and response settings.

This project is intentionally optimized for **small PoC files**. It is not intended to replace object storage or a general-purpose application server.

---

## 🚀 Quick Start

### 1. Install Wrangler

```bash
npm install -g wrangler
wrangler login
```

### 2. Create a D1 database

```bash
wrangler d1 create poc_host_db
```

Copy the returned `database_id` into `wrangler.toml`:

```toml
[[d1_databases]]
binding = "DB"
database_name = "poc_host_db"
database_id = "YOUR_DATABASE_ID"
```

### 3. Initialize the schema

For a **new** database:

```bash
wrangler d1 execute poc_host_db --remote --file=./schema.sql
```

### 4. Protect the management panel

Set the dashboard token as a Wrangler secret:

```bash
wrangler secret put CREATE_TOKEN
```

You can intentionally leave it unset for a local/private setup, but a public deployment should normally protect the management routes.

### 5. Deploy

```bash
wrangler deploy
```

---

## ⚙️ Configuration

The public path configuration lives near the top of `src/index.js`:

```js
const CONFIG = Object.freeze({
  APP_PATH: 'poc_app',
  FILE_PATH: 'f',
  CALLBACK_PATH: 'c',
});
```

Change these values before publishing if you prefer different URL prefixes.

For example:

```js
const CONFIG = Object.freeze({
  APP_PATH: 'dashboard',
  FILE_PATH: 'files',
  CALLBACK_PATH: 'callback',
});
```

The resulting URLs become:

```text
/dashboard/create
/dashboard/list
/files/example.js
/callback/test
```

### Important

These paths are **customization/obscurity only**. They are not an authentication mechanism.

Use `CREATE_TOKEN` for actual access control.

---

## 🖥️ Dashboard

The management UI lives under `APP_PATH`.

Default:

```text
/poc_app/create
/poc_app/list
/poc_app/callbacks
```

The panel supports:

- creating files
- updating file content
- renaming files
- deleting files
- toggling raw mode
- adding/removing multiple tags
- filtering by tag or name
- configuring response behavior
- viewing callback requests
- viewing detailed callback headers/body/browser data

When a valid token is supplied, the dashboard remembers it in an `HttpOnly` cookie scoped to the management path.

---

# 📦 Files

Public files are served from `FILE_PATH`.

Default:

```text
/f/<filename>
```

Example:

```text
/f/poc.js
```

The public file route does **not** require the management token.

### Storage model

Each file stores:

```text
name
extension
content
tags
raw flag
size
modified timestamp
response configuration
```

D1 rows are best suited to small PoC files. Avoid treating this as a large binary/file-storage service.

---

## 🏷️ Multi-tag

A file can have any number of tags.

Example:

```json
{
  "tags": ["acme", "xss", "callback"]
}
```

Tags are normalized and duplicate names are removed case-insensitively.

An empty array removes every tag:

```json
{
  "tags": []
}
```

Legacy single-tag rows are still supported, so existing data can be upgraded without rewriting every old record first.

### Tag API

Replace the complete tag set:

```http
POST /poc_app/api/files/<name>/tags
```

```json
{
  "tags": ["xss", "ssrf", "stored"]
}
```

The older singular `tag` endpoint/field remains accepted for compatibility.

---

# 🎛️ Per-file Response Controls

Every public file can have its own HTTP response behavior.

Available controls:

### Status code

Any status from `100` to `599` can be selected.

Statuses that do not allow a response body are handled without a body, including:

```text
204
205
304
```

### Custom response headers

Enter one header per line:

```text
X-Test: hello
Content-Type: text/html; charset=utf-8
Cache-Control: no-store
```

Custom headers are applied after the built-in response headers, so a custom value can override built-in headers such as `Content-Type`.

`raw` mode intentionally keeps `text/plain` behavior.

### Redirect

Supported redirect statuses:

```text
301
302
303
307
308
```

Set the target URL and the Worker will return it through the `Location` header.

### Delay

Configure a response delay from:

```text
0 ms → 30000 ms
```

This can be useful when testing timeout handling, navigation behavior, and client-side race conditions.

---

## ➕ Header append / merge behavior

When editing an existing file, response headers support two modes.

### Replace

The new header set replaces the stored custom headers.

### Append

The new set is merged into the existing one.

Header names are compared **case-insensitively**.

Example:

Existing:

```text
X-Test: old
X-Existing: keep
```

Append:

```text
X-Test: new
X-New: value
```

Result:

```text
X-Test: new
X-Existing: keep
X-New: value
```

So an appended header with an already-existing name **overwrites that header's value**, while unrelated existing headers are preserved.

---

## 📡 Callback Catcher

The callback catcher provides a public endpoint for out-of-band request collection:

```text
/c/<id>
```

For example:

```text
https://your-worker.example/c/test
```

The callback endpoint intentionally does **not** require the management token. This allows an unrelated browser or server to reach it.

### What gets captured server-side

For each callback request, the Worker can store:

- callback ID
- HTTP method
- full request URL
- path
- query parameters
- request headers visible to the Worker
- request body
- body truncation flag
- header truncation flag
- client IP
- `Referer`
- `User-Agent`
- optional browser-provided `location_hash`
- timestamp

### Browser-side capture

A `GET` to `/c/<id>` returns a fixed HTML document with a fixed JavaScript payload.

The browser script sends a follow-up request to:

```text
/c/<id>/collect
```

The browser-side report can include values such as:

```text
location.href
location.hash
document.referrer
navigator.userAgent
navigator.language
navigator.languages
navigator.platform
Intl timezone
cookieEnabled
online state
doNotTrack
viewport size
screen size
color depth
pixel depth
devicePixelRatio
visibilityState
userAgentData
```

The Worker also captures the HTTP headers of the `/collect` request server-side.

### Why `location.hash` is collected in JavaScript

The URL fragment is a browser-side value and is not sent as part of the normal HTTP request to the server. The fixed callback page therefore reads it in JavaScript and submits it to `/collect`.

### Callback management UI

Open:

```text
/poc_app/callbacks
```

The callback panel lets you:

- generate a new callback ID
- copy the callback URL
- filter by callback ID
- inspect request details
- inspect headers/body/query data
- inspect browser-side data
- delete one callback ID
- delete all callback records

---

## 🔌 Callback API

List recent callbacks:

```http
GET /poc_app/api/callbacks
```

Filter by ID:

```http
GET /poc_app/api/callbacks?id=test
```

Fetch one record:

```http
GET /poc_app/api/callbacks?seq=123
```

Delete one callback ID:

```http
DELETE /poc_app/api/callbacks?id=test
```

Delete all callback records:

```http
DELETE /poc_app/api/callbacks
```

These management endpoints are protected by `CREATE_TOKEN` when configured.

---

## 🔌 File API

List files:

```http
GET /poc_app/api/files
```

Filter by tag:

```http
GET /poc_app/api/files?tag=xss
```

Create/update a file:

```http
POST /poc_app/api/files
```

Example:

```json
{
  "filename": "demo",
  "ext": "js",
  "content": "console.log('hello')",
  "tags": ["demo", "test"]
}
```

The public URL returned by the API uses the configured `FILE_PATH`.

### Other file operations

```text
POST   /poc_app/api/files/<name>/tags
POST   /poc_app/api/files/<name>/tag
POST   /poc_app/api/files/<name>/raw
POST   /poc_app/api/files/<name>/rename
GET    /poc_app/api/files/<name>/response
POST   /poc_app/api/files/<name>/response
DELETE /poc_app/api/files/<name>
```

All management APIs use the same token protection as the dashboard.

---

## 🧪 Local Development

Run D1 locally:

```bash
wrangler d1 execute poc_host_db --local --file=./schema.sql
```

Start the Worker:

```bash
wrangler dev
```

Local D1 data is kept under `.wrangler/` and does not modify the remote database.

---

## 🗃️ Existing D1 Databases & Migrations

`schema.sql` contains the current full schema for a fresh database.

For an **existing database created before the callback catcher / response controls**, apply the matching migrations.

### Callback catcher

```bash
wrangler d1 execute poc_host_db --remote --file=./migrations/0002_callbacks.sql
```

### Response controls

```bash
wrangler d1 execute poc_host_db --remote --file=./migrations/0003_response.sql
```

> Do not blindly run an `ALTER TABLE` migration against a fresh database that was already initialized from the latest `schema.sql`; the latest schema already contains those columns/tables.

The Worker also contains compatibility/lazy schema checks for older deployments.

---

## 🔐 Security Notes

### Management token

Set `CREATE_TOKEN` with Wrangler rather than hard-coding it in the repository:

```bash
wrangler secret put CREATE_TOKEN
```

Do not commit secrets, local environment files, or `.wrangler/` state.

### Public callback endpoint

The callback catcher is intentionally unauthenticated. Anyone who knows an ID can send requests to it.

Because callback records may contain IP addresses, headers, cookies, URLs, and request bodies, treat the D1 database as sensitive data and avoid exposing the management panel to untrusted users.

### Path configuration is not auth

Changing `/poc_app`, `/f`, or `/c` to another value only changes the URL structure. It does not make a public route private.

---

## 📁 Project Layout

```text
.
├── src/
│   └── index.js              # Worker, routing, APIs, and UI
├── migrations/
│   ├── 0002_callbacks.sql   # Existing DB → callback catcher
│   └── 0003_response.sql    # Existing DB → response controls
├── schema.sql                # Full current D1 schema
├── wrangler.toml             # Worker + D1 binding
└── .gitignore                # Local/runtime files excluded from Git
```

---

## 📝 Design Notes

### Why D1?

Cloudflare Workers do not provide a normal persistent local filesystem suitable for this use case. D1 keeps the application state in a durable database instead of relying on a mounted server volume.

### Why a fixed callback HTML/JS payload?

The callback route should stay predictable and lightweight. The Worker records what it can see at the HTTP layer, then the browser reports browser-only values through `/collect`.

### Why separate server and browser capture?

Browser JavaScript cannot enumerate every HTTP request header. Conversely, values such as URL fragments are not available to the server-side request handler. Keeping both layers gives the callback panel a more complete picture of an event.

---

## ✅ Before You Publish

Check these before making the repository public:

```text
[ ] Replace database_id in wrangler.toml
[ ] Set CREATE_TOKEN with `wrangler secret put CREATE_TOKEN`
[ ] Review CONFIG paths in src/index.js
[ ] Make sure no real PoC secrets or target-specific data are committed
[ ] Make sure .wrangler/ and local environment files stay ignored
[ ] Initialize D1 with schema.sql
[ ] Deploy and verify /<APP_PATH>/list
[ ] Test one /<CALLBACK_PATH>/<id> callback
```

---

## License

Add the license you want to use for the public repository before publishing.
