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
  if (!clientReady) return res.status(503).json({ error: 'whatsapp client not ready yet' });
  if (!GROUP_ID) return res.status(500).json({ error: 'GROUP_ID not set on the server - see README.md' });
  if (isRateLimited()) return res.status(429).json({ error: 'rate limit exceeded' });

  try {
    const { ref, client: clientName, location, mobile, items, grandTotal } = req.body || {};
    if (!Array.isArray(items) || !items.length) {
      return res.status(400).json({ error: 'no items provided' });
    }

    // NOTE: the outgoing WhatsApp message text below is in Arabic on purpose,
    // since that's the language of the "Tasks" group / the team reading it.
    // Only this file's comments and API responses were translated to English.
    let msg = '📋 *عرض سعر جديد - Merzona*\n';
    if (ref) msg += `المرجع: ${ref}\n`;
    if (clientName) msg += `العميل: ${clientName}\n`;
    if (location) msg += `الإمارة: ${location}\n`;
    if (mobile) msg += `الموبايل: ${mobile}\n`;
    msg += '\n*البنود:*\n';
    items.forEach((it, i) => {
      const name = (it.name || '').toString().trim();
      if (!name) return;
      const dims = it.width && it.height ? `${it.width}×${it.height}mm` : '';
      const qtyTxt = it.qty ? `×${it.qty}` : '';
      const priceTxt = it.pricePerM2 ? `${it.pricePerM2} AED/m²` : '';
      const parts = [name, dims, qtyTxt, priceTxt].filter(Boolean);
      msg += `${i + 1}. ${parts.join(' - ')}\n`;
    });
    if (grandTotal) msg += `\n*الإجمالي: ${grandTotal} AED*`;

    await client.sendMessage(GROUP_ID, msg);
    sendLog.push(Date.now());
    res.json({ ok: true });
  } catch (e) {
    console.error('[WhatsApp] Failed to send message:', e);
    res.status(500).json({ error: String(e) });
  }
});

// ============================================================================
//  Login-approval system
//  Every new browser/device that opens the Merzona tool is locked out until
//  the owner approves it. The owner is notified instantly on WhatsApp with
//  one-tap Approve/Deny links. Once approved, a device stays approved until
//  the owner revokes it from /access/admin.
// ============================================================================

// Called by the tool when a device requests access (or when the owner opens
// their one-time "owner bypass" link, which sends adminToken instead).
app.post('/access/request', async (req, res) => {
  try {
    const { deviceToken, name, adminToken } = req.body || {};
    if (!deviceToken || typeof deviceToken !== 'string' || deviceToken.length < 8) {
      return res.status(400).json({ error: 'invalid deviceToken' });
    }
    const devices = loadDevices();

    // Owner bypass: only works if the caller supplies the real ADMIN_TOKEN (never
    // shipped inside the tool's own source - the owner pastes it into the URL once).
    if (adminToken && ADMIN_TOKEN && adminToken === ADMIN_TOKEN) {
      const prior = devices[deviceToken];
      devices[deviceToken] = {
        name: (name || 'Owner device').toString().slice(0, 80),
        status: 'approved',
        requestedAt: (prior && prior.requestedAt) || Date.now(),
        approvedAt: Date.now(),
        isOwner: true,
      };
      saveDevices(devices);
      return res.json({ status: 'approved' });
    }

    const existing = devices[deviceToken];
    if (existing && existing.status === 'approved') return res.json({ status: 'approved' });
    if (existing && existing.status === 'pending') return res.json({ status: 'pending' });

    if (isAccessRequestRateLimited()) {
      return res.status(429).json({ error: 'too many requests, try again later' });
    }
    accessRequestLog.push(Date.now());

    devices[deviceToken] = {
      name: (name || 'بدون اسم').toString().trim().slice(0, 80) || 'بدون اسم',
      status: 'pending',
      requestedAt: Date.now(),
    };
    saveDevices(devices);

    if (clientReady && OWNER_WHATSAPP_NUMBER && PUBLIC_BASE_URL && ADMIN_TOKEN) {
      const approveUrl = `${PUBLIC_BASE_URL}/access/approve?admin=${encodeURIComponent(ADMIN_TOKEN)}&device=${encodeURIComponent(deviceToken)}&action=approve`;
      const denyUrl = `${PUBLIC_BASE_URL}/access/approve?admin=${encodeURIComponent(ADMIN_TOKEN)}&device=${encodeURIComponent(deviceToken)}&action=deny`;
      const msg =
        `🔐 *طلب دخول جديد لأداة Merzona*\n` +
        `الاسم: ${devices[deviceToken].name}\n` +
        `الوقت: ${new Date().toLocaleString('ar-AE')}\n\n` +
        `✅ للموافقة: ${approveUrl}\n\n` +
        `⛔ للرفض: ${denyUrl}`;
      client.sendMessage(OWNER_WHATSAPP_NUMBER + '@c.us', msg).catch((e) => console.error('[Access] Failed to notify owner on WhatsApp:', e));
    } else {
      console.warn('[Access] New pending request but WhatsApp notification could not be sent (server not fully configured, or not logged in yet) - check /access/admin manually.');
    }

    res.json({ status: 'pending' });
  } catch (e) {
    console.error('[Access] /access/request failed:', e);
    res.status(500).json({ error: String(e) });
  }
});

// Polled by the tool while it's waiting for approval.
app.get('/access/status', (req, res) => {
  const deviceToken = (req.query.device || '').toString();
  const devices = loadDevices();
  const entry = devices[deviceToken];
  if (!entry) return res.json({ status: 'none' });
  res.json({ status: entry.status, name: entry.name });
});

// One-tap link the owner opens from the WhatsApp notification (or the admin panel).
app.get('/access/approve', (req, res) => {
  const { admin, device, action } = req.query;
  if (!ADMIN_TOKEN || admin !== ADMIN_TOKEN) {
    return res.status(401).send('<h2 style="font-family:sans-serif">غير مصرح - Unauthorized</h2>');
  }
  const devices = loadDevices();
  const entry = devices[device];
  if (!entry) {
    return res.status(404).send('<h2 style="font-family:sans-serif">الطلب مش موجود (ربما انحذف)</h2>');
  }
  if (action === 'approve') {
    entry.status = 'approved';
    entry.approvedAt = Date.now();
  } else if (action === 'deny') {
    entry.status = 'denied';
  } else if (action === 'revoke') {
    entry.status = 'revoked';
  } else {
    return res.status(400).send('<h2 style="font-family:sans-serif">إجراء غير معروف</h2>');
  }
  devices[device] = entry;
  saveDevices(devices);
  const label = { approve: 'تمت الموافقة ✅', deny: 'تم الرفض ⛔', revoke: 'تم إلغاء الوصول ⛔' }[action];
  res.send(`<html><body style="font-family:sans-serif;text-align:center;padding-top:60px;direction:rtl">
    <h2>${label}</h2>
    <p>${escapeHtml(entry.name)}</p>
    <p><a href="/access/admin?admin=${encodeURIComponent(ADMIN_TOKEN)}">فتح لوحة إدارة الأجهزة</a></p>
  </body></html>`);
});

// Full list of devices (pending/approved/denied/revoked) with inline actions - a fallback
// for when the owner missed the WhatsApp notification, and the only way to revoke access.
app.get('/access/admin', (req, res) => {
  if (!ADMIN_TOKEN || req.query.admin !== ADMIN_TOKEN) {
    return res.status(401).send('<h2 style="font-family:sans-serif">غير مصرح - Unauthorized</h2>');
  }
  const devices = loadDevices();
  const rows = Object.entries(devices)
    .sort((a, b) => (b[1].requestedAt || 0) - (a[1].requestedAt || 0))
    .map(([token, d]) => {
      const badge = { pending: '🟡 بانتظار الموافقة', approved: '🟢 مسموح', denied: '⛔ مرفوض', revoked: '⚫ ملغي' }[d.status] || d.status;
      const actions = [];
      if (d.status !== 'approved') actions.push(`<a href="/access/approve?admin=${encodeURIComponent(ADMIN_TOKEN)}&device=${encodeURIComponent(token)}&action=approve">موافقة</a>`);
      if (d.status !== 'denied' && d.status !== 'approved') actions.push(`<a href="/access/approve?admin=${encodeURIComponent(ADMIN_TOKEN)}&device=${encodeURIComponent(token)}&action=deny">رفض</a>`);
      if (d.status === 'approved') actions.push(`<a href="/access/approve?admin=${encodeURIComponent(ADMIN_TOKEN)}&device=${encodeURIComponent(token)}&action=revoke" style="color:#c0392b">إلغاء الوصول</a>`);
      return `<tr>
        <td>${escapeHtml(d.name || '')}</td>
        <td>${badge}</td>
        <td>${d.requestedAt ? new Date(d.requestedAt).toLocaleString('ar-AE') : ''}</td>
        <td>${actions.join(' | ')}</td>
      </tr>`;
    })
    .join('');
  res.send(`<html><body style="font-family:sans-serif;padding:24px;direction:rtl">
    <h2>لوحة إدارة أجهزة الدخول - أداة Merzona</h2>
    <table border="1" cellpadding="8" style="border-collapse:collapse;width:100%;max-width:800px">
      <tr><th>الاسم</th><th>الحالة</th><th>وقت الطلب</th><th>إجراء</th></tr>
      ${rows || '<tr><td colspan="4">ما في طلبات لسا</td></tr>'}
    </table>
  </body></html>`);
});

app.listen(PORT, () => console.log(`[Server] Running on port ${PORT}`));
