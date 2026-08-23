// ============================================================================
//  Merzona → WhatsApp Bridge
//  A small server that receives quotation data from the Merzona tool
//  (Quotation_Generator.html) every time it's saved, and automatically
//  posts it as a WhatsApp message to the "Tasks" group.
//
//  ⚠️ This uses whatsapp-web.js (an unofficial automation via WhatsApp Web),
//  not the official WhatsApp Cloud API — because the official API cannot
//  send messages to groups at all. This means there is some (small) risk
//  of the number getting banned by WhatsApp/Meta since it's not an
//  officially supported way to use the platform. Use a non-critical number
//  for this (like your existing test number) if you can.
// ============================================================================

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const qrcode = require('qrcode');
const { Client, LocalAuth } = require('whatsapp-web.js');

const PORT = process.env.PORT || 3000;
const AUTH_TOKEN = process.env.AUTH_TOKEN || '';
const GROUP_ID = process.env.GROUP_ID || '';
// Set this to the actual domain your tool runs on (no trailing slash).
// Set to '*' temporarily if you want to test quickly without CORS restrictions.
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'https://management4w-beep.github.io';
// Where the WhatsApp login session gets saved, so you don't have to rescan
// the QR code every time the server restarts. On Railway you must attach a
// Volume at exactly this path (see README.md).
const AUTH_DATA_PATH = process.env.AUTH_DATA_PATH || '/data/.wwebjs_auth';

// ---- Login-approval system settings ----
// A secret only the tool's owner knows - used both to approve/deny/revoke device
// requests, and as a one-time "owner bypass" link opened on the owner's own devices.
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
// The owner's personal WhatsApp number (digits only, with country code, no + or spaces,
// e.g. 971501234567) - this is who gets notified when someone requests access.
const OWNER_WHATSAPP_NUMBER = (process.env.OWNER_WHATSAPP_NUMBER || '').replace(/[^0-9]/g, '');
// The public URL this server is reachable at (no trailing slash) - used to build the
// approve/deny links sent inside the WhatsApp notification.
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
// Where the approved/pending device list is stored - same persistent Volume as the
// WhatsApp login session, so it also survives restarts.
const ACCESS_DATA_PATH = process.env.ACCESS_DATA_PATH || '/data/access-devices.json';

if (!AUTH_TOKEN) {
  console.warn('[WARNING] No AUTH_TOKEN set in environment variables - anyone who knows the server URL can use it!');
}
if (!ADMIN_TOKEN) {
  console.warn('[WARNING] No ADMIN_TOKEN set - the login-approval feature will not work securely until you set one.');
}

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(cors({ origin: ALLOWED_ORIGIN === '*' ? true : ALLOWED_ORIGIN }));

let lastQr = null;
let clientReady = false;

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: AUTH_DATA_PATH }),
  puppeteer: {
    headless: true,
    // When deployed via the included Dockerfile, PUPPETEER_EXECUTABLE_PATH points at the
    // system Chromium installed there (apt-get) instead of Puppeteer's own bundled download -
    // the bundled one is missing several native libraries on minimal Linux hosts like Railway's
    // default image, which crashes with "error while loading shared libraries: libglib-2.0...".
    // Falls back to the bundled Chromium (undefined = default) when this isn't set, e.g. locally.
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  },
});

client.on('qr', (qr) => {
  lastQr = qr;
  clientReady = false;
  console.log('[WhatsApp] A new QR code is ready - open /qr in your browser to scan it with your WhatsApp number.');
});
client.on('ready', () => {
  clientReady = true;
  lastQr = null;
  console.log('[WhatsApp] Login successful ✅ - the server is ready to send messages.');
});
client.on('auth_failure', (msg) => {
  clientReady = false;
  console.error('[WhatsApp] Login failed:', msg);
});
client.on('disconnected', (reason) => {
  clientReady = false;
  console.warn('[WhatsApp] Disconnected:', reason);
});

// Chrome writes lock files (SingletonLock etc.) into its profile folder while running, and
// removes them on a clean exit. If the container gets killed mid-crash (exactly what happens
// while the earlier "missing shared libraries" bug was crash-looping), those lock files are
// left behind on the persistent Volume - and every future start then refuses to launch,
// thinking another Chrome instance already owns that profile ("Code: 21" / "profile appears to
// be in use by another Chromium process"). Clean any of these up before every start so a bad
// crash never permanently wedges the profile.
function cleanupStaleChromeLocks(rootDir) {
  const lockNames = new Set(['SingletonLock', 'SingletonCookie', 'SingletonSocket']);
  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (lockNames.has(entry.name)) {
        try {
          fs.unlinkSync(full);
          console.log('[Startup] Removed stale Chrome lock file:', full);
        } catch (e) {
          console.warn('[Startup] Could not remove stale lock file:', full, e.message);
        }
      }
    }
  }
  walk(rootDir);
}
cleanupStaleChromeLocks(AUTH_DATA_PATH);

client.initialize();

function checkAuth(req, res, next) {
  const token = req.headers['x-api-key'] || req.query.token;
  if (!AUTH_TOKEN || token !== AUTH_TOKEN) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

// Simple abuse protection: cap at 30 messages per hour.
const sendLog = [];
function isRateLimited() {
  const now = Date.now();
  while (sendLog.length && now - sendLog[0] > 3600 * 1000) sendLog.shift();
  return sendLog.length >= 30;
}

// ---- Login-approval system: simple JSON-file device store ----
function loadDevices() {
  try {
    return JSON.parse(fs.readFileSync(ACCESS_DATA_PATH, 'utf8'));
  } catch (e) {
    return {};
  }
}
function saveDevices(devices) {
  try {
    fs.mkdirSync(path.dirname(ACCESS_DATA_PATH), { recursive: true });
    fs.writeFileSync(ACCESS_DATA_PATH, JSON.stringify(devices, null, 2));
  } catch (e) {
    console.error('[Access] Failed to save devices store:', e);
  }
}
function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
// Cap new access requests (not repeat status checks) at 20/hour to deter spam.
const accessRequestLog = [];
function isAccessRequestRateLimited() {
  const now = Date.now();
  while (accessRequestLog.length && now - accessRequestLog[0] > 3600 * 1000) accessRequestLog.shift();
  return accessRequestLog.length >= 20;
}

app.get('/', (req, res) => {
  res.send('Merzona WhatsApp Bridge - running. Open /qr to log in, or /health to check status.');
});

app.get('/health', (req, res) => {
  res.json({ ok: true, whatsappReady: clientReady, groupConfigured: !!GROUP_ID });
});

// Shows the QR code as an image so you can scan it from your phone without
// needing terminal access.
app.get('/qr', async (req, res) => {
  if (clientReady) {
    return res.send('<h2 style="font-family:sans-serif">Already logged in ✅ - no need to scan a new code.</h2>');
  }
  if (!lastQr) {
    return res.send(
      '<html><body style="font-family:sans-serif;text-align:center">' +
        '<h2>No QR code ready yet - the server is still starting up...</h2>' +
        '<p>This page auto-refreshes every 3 seconds</p>' +
        '<script>setTimeout(()=>location.reload(),3000)</script></body></html>'
    );
  }
  try {
    const dataUrl = await qrcode.toDataURL(lastQr);
    res.send(
      `<html><body style="font-family:sans-serif;text-align:center">
        <h2>Scan this QR code from WhatsApp: Settings → Linked Devices → Link a Device</h2>
        <img src="${dataUrl}" style="width:320px;height:320px" />
        <p>This page auto-refreshes every 5 seconds until the code is scanned</p>
        <script>setTimeout(()=>location.reload(),5000)</script>
      </body></html>`
    );
  } catch (e) {
    res.status(500).send('Failed to generate QR code: ' + String(e));
  }
});

// To find the ID of the "Tasks" group (login must already be done).
// Open in your browser with ?token=your_token, or send the x-api-key header.
app.get('/groups', checkAuth, async (req, res) => {
  if (!clientReady) return res.status(503).json({ error: 'whatsapp client not ready yet - log in first via /qr' });
  try {
    const chats = await client.getChats();
    const groups = chats
      .filter((c) => c.isGroup)
      .map((c) => ({ id: c.id._serialized, name: c.name }));
    res.json({ groups });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// Main route: called automatically by the quotation tool on every save.
app.post('/send-quotation', checkAuth, async (req, res) => {
  if (!clientReady) return res.status(503).json({ error: 'whatsapp
