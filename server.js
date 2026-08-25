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
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const { PDFDocument } = require('pdf-lib');
const puppeteer = require('puppeteer-core');

const PORT = process.env.PORT || 3000;
const AUTH_TOKEN = process.env.AUTH_TOKEN || '';
const GROUP_ID = process.env.GROUP_ID || '';
// مجموعة واتساب جديدة مخصصة للعقود الموقّعة إلكترونيًا (منفصلة عن مجموعة Tasks) - لازم تتضاف
// كمتغير بيئة منفصل بنفس طريقة GROUP_ID (شوف /groups لمعرفة الـid تبعها بعد ما تنشئها).
const CONTRACTS_GROUP_ID = process.env.CONTRACTS_GROUP_ID || '';
// Set this to the actual domain your tool runs on (no trailing slash).
// Set to '*' temporarily if you want to test quickly without CORS restrictions.
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'https://management4w-beep.github.io';
// Where the WhatsApp login session gets saved, so you don't have to rescan
// the QR code every time the server restarts. On Railway you must attach a
// Volume at exactly this path (see README.md).
const AUTH_DATA_PATH = process.env.AUTH_DATA_PATH || '/data/.wwebjs_auth';

// ---- Google Drive silent-token service ----
// حل مشكلة "لازم أكبس موافقة جوجل كل شوي" من جذورها: بدل ما كل متصفح يفتح نافذة جوجل بنفسه (والمتصفح
// بيمنع هيك نوافذ لو ما كانت نتيجة كبسة حقيقية)، منعمل مرة وحدة بس ربط دائم بين هالسيرفر وحساب جوجل
// درايف (عبر GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET + refresh token محفوظ)، وبعدها أي أداة (الفاتورة
// أو الداشبورد) بتطلب توكن جاهز من هالسيرفر مباشرة (/drive-token) بدون ما تحتاج تفتح ولا نافذة جوجل
// إطلاقًا، ولا حتى مرة كل ساعة - السيرفر هو يلي بيجدد التوكن لحاله بالخلفية طول ما refresh token صالح.
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const GOOGLE_DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive';
// نفس الفولدر (Volume) المستمر يلي محفوظ فيه جلسة الواتساب ولائحة الأجهزة - هيك refresh token
// بيضل موجود حتى لو السيرفر أعاد التشغيل.
const GOOGLE_REFRESH_TOKEN_PATH = process.env.GOOGLE_REFRESH_TOKEN_PATH || '/data/google-refresh-token.json';

function loadGoogleRefreshToken() {
  try {
    return JSON.parse(fs.readFileSync(GOOGLE_REFRESH_TOKEN_PATH, 'utf8')).refresh_token || null;
  } catch (e) {
    return null;
  }
}
function saveGoogleRefreshToken(token) {
  try {
    fs.mkdirSync(path.dirname(GOOGLE_REFRESH_TOKEN_PATH), { recursive: true });
    fs.writeFileSync(GOOGLE_REFRESH_TOKEN_PATH, JSON.stringify({ refresh_token: token, savedAt: Date.now() }, null, 2));
  } catch (e) {
    console.error('[Drive Auth] Failed to save refresh token:', e);
  }
}
if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
  console.warn('[WARNING] GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET not set - the /drive-token silent-sync service will not work until you configure them (see README.md).');
}

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
// 15mb (not 1mb) because a saved quotation's PDF file now rides along in the same request,
// base64-encoded (roughly +33% size) - a few-page quotation PDF can be a couple MB.
app.use(express.json({ limit: '15mb' }));
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
  // whatsapp-web.js ships with a bundled/cached WhatsApp Web build. When WhatsApp updates
  // their own web app, that bundled build can go stale and calls like getChats() then fail
  // with cryptic minified errors such as "r: r" (an internal error from WhatsApp Web's own
  // obfuscated code, not from our server). Pinning to a known-compatible build fetched fresh
  // from a maintained community mirror avoids this instead of relying on the stale local cache.
  webVersionCache: {
    type: 'remote',
    remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.3000.1023250906-alpha.html',
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

// Fallback way to find a group's ID that doesn't rely on client.getChats() - on some
// WhatsApp Web builds that call fails with an opaque internal error (e.g. "r: r") even
// though the connection itself is fine. Listening to messages instead uses the raw data
// that already arrives with each message event, no extra internal calls needed. See the
// /last-messages route below - send a test message in the group, then open that route.
const recentMessages = [];
client.on('message_create', (msg) => {
  try {
    recentMessages.unshift({
      from: msg.from,
      fromMe: !!msg.fromMe,
      body: (msg.body || '').toString().slice(0, 80),
      at: Date.now(),
    });
    if (recentMessages.length > 20) recentMessages.length = 20;
  } catch (e) {
    console.error('[Debug] Failed to record message:', e);
  }
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
  res.json({ ok: true, whatsappReady: clientReady, groupConfigured: !!GROUP_ID, contractsGroupConfigured: !!CONTRACTS_GROUP_ID });
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
    console.error('[Groups] client.getChats() failed:', e);
    res.status(500).json({ error: String(e), name: e && e.name, message: e && e.message, hint: 'try /last-messages instead - send a test message in the target group first' });
  }
});

// Fallback for finding a group's ID when /groups fails: send any test message in the
// target group from your phone (with the server already connected), then open this.
app.get('/last-messages', checkAuth, (req, res) => {
  res.json({ messages: recentMessages });
});

// Main route: called automatically by the quotation tool on every save.
app.post('/send-quotation', checkAuth, async (req, res) => {
  if (!clientReady) return res.status(503).json({ error: 'whatsapp client not ready yet' });
  if (!GROUP_ID) return res.status(500).json({ error: 'GROUP_ID not set on the server - see README.md' });
  if (isRateLimited()) return res.status(429).json({ error: 'rate limit exceeded' });

  const { ref, client: clientName, location, mobile, items, grandTotal, pdfBase64, pdfFilename } = req.body || {};
  if (!Array.isArray(items) || !items.length) {
    return res.status(400).json({ error: 'no items provided' });
  }

  // 🔧 إصلاح 2026-08-25: نرد على المتصفح فورًا هون (بعد التحقق من صحة البيانات بس)، قبل
  // ما نبعت فعليًا عبر واتساب. سبب الإصلاح: client.sendMessage() مع مرفق PDF عبر
  // whatsapp-web.js ممكن ياخد كذا ثانية (بتفتح/تتحكم بمتصفح داخلي)، وإذا تخطينا مهلة
  // الاتصال (سواء عند Railway أو بالمتصفح نفسه)، الاتصال بينقطع قبل ما يوصل الرد -
  // والمتصفح بيسجلها غلط كأنها مشكلة CORS ("Failed to fetch") رغم إنو غالبًا الرسالة
  // نفسها بتكون انبعتت أو بتنبعث لاحقًا. هلق منرد فورًا ومنكمل الإرسال الفعلي بالخلفية،
  // ومنسجل أي فشل حقيقي بلوغ السيرفر (Railway logs) بدل ما نخلي المتصفح ينتظره.
  res.json({ ok: true, queued: true });

  (async () => {
    try {
      // NOTE: the outgoing WhatsApp message text below is in Arabic on purpose,
      // since that's the language of the "Tasks" group / the team reading it.
      // Only this file's comments and API responses were translated to English.
      let msg = '📋 *عرض سعر جديد - Merzona*\n';
      if (ref) msg += `المرجع: ${ref}\n`;
      if (clientName) msg += `العميل: ${clientName}\n`;
      if (location) msg += `الإمارة: ${location}\n`;
      if (mobile) msg += `الموبايل: ${mobile}\n`;
      msg += '\n*البنود:*\n';

      // Group identical items (same name + same price/m²) into one line and sum their
      // quantity - dimensions are intentionally left out of the message entirely. An item
      // only appears as a separate line when a DIFFERENT price was set for a similar name.
      const grouped = new Map();
      items.forEach((it) => {
        const name = (it.name || '').toString().trim();
        if (!name) return;
        const price = (it.pricePerM2 || '').toString().trim();
        const key = name.toLowerCase() + '||' + price;
        const qty = parseFloat(it.qty) || 1;
        if (grouped.has(key)) {
          grouped.get(key).qty += qty;
        } else {
          grouped.set(key, { name, price, qty });
        }
      });
      let lineNo = 0;
      for (const g of grouped.values()) {
        lineNo++;
        const qtyTxt = g.qty ? `×${g.qty}` : '';
        const priceTxt = g.price ? `${g.price} AED/m²` : '';
        const parts = [g.name, qtyTxt, priceTxt].filter(Boolean);
        msg += `${lineNo}. ${parts.join(' - ')}\n`;
      }
      if (grandTotal) msg += `\n*الإجمالي: ${grandTotal} AED*`;

      // Attach the quotation PDF itself when the tool sent one along - falls back to a
      // plain text message (still useful) if the PDF is missing or fails to attach for
      // any reason, so a PDF problem never blocks the notification from going out.
      if (pdfBase64) {
        try {
          const media = new MessageMedia('application/pdf', pdfBase64, (pdfFilename || 'quotation.pdf').toString());
          await client.sendMessage(GROUP_ID, media, { caption: msg });
        } catch (mediaErr) {
          console.error('[WhatsApp] Failed to attach PDF, sending text-only instead:', mediaErr);
          await client.sendMessage(GROUP_ID, msg);
        }
      } else {
        await client.sendMessage(GROUP_ID, msg);
      }

      sendLog.push(Date.now());
      console.log('[WhatsApp] ✅ تم إرسال عرض السعر بنجاح (بالخلفية) - المرجع:', ref || '(بدون مرجع)');
    } catch (e) {
      console.error('[WhatsApp] Failed to send message (background):', e);
    }
  })();
});

// ============================================================================
//  Google Drive silent-token service
//  One-time setup (owner only, via /drive-auth/start): links this server to a
//  Google Drive account and stores a long-lived refresh token. After that,
//  every tool (Quotation_Generator / Dashboard) can fetch a ready access token
//  from /drive-token any time, with zero Google popups - not even once an hour.
// ============================================================================

// Owner-only, one time (or whenever you want to re-link / switch Google accounts):
// open this URL with ?admin=<ADMIN_TOKEN> from a normal browser, sign in with the
// Google account that owns the Drive folder, and approve. The server then stores
// the refresh token itself - no copy/pasting secrets around.
app.get('/drive-auth/start', (req, res) => {
  if (!ADMIN_TOKEN || req.query.admin !== ADMIN_TOKEN) {
    return res.status(401).send('<h2 style="font-family:sans-serif">غير مصرح - Unauthorized</h2>');
  }
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    return res.status(500).send('<h2 style="font-family:sans-serif">السيرفر مش مجهز بعد</h2><p style="font-family:sans-serif">لازم تضيف GOOGLE_CLIENT_ID و GOOGLE_CLIENT_SECRET بمتغيرات البيئة على Railway أول (شوف README.md).</p>');
  }
  if (!PUBLIC_BASE_URL) {
    return res.status(500).send('<h2 style="font-family:sans-serif">PUBLIC_BASE_URL مش مضبوط</h2>');
  }
  const redirectUri = PUBLIC_BASE_URL + '/drive-auth/callback';
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: GOOGLE_DRIVE_SCOPE,
    access_type: 'offline',
    prompt: 'consent', // بيضمن إنه جوجل يرجع refresh_token دايمًا (حتى لو كنت وافقت قبل هيك من نافذة المتصفح)
    state: ADMIN_TOKEN,
  });
  res.redirect('https://accounts.google.com/o/oauth2/v2/auth?' + params.toString());
});

// جوجل بيرجع لهون بعد ما توافق - منستبدل الكود بـ refresh token دائم ومنخزنه على السيرفر.
app.get('/drive-auth/callback', async (req, res) => {
  const { code, state, error } = req.query;
  if (error) {
    return res.status(400).send('<h2 style="font-family:sans-serif">صار خطأ من جوجل</h2><p>' + escapeHtml(String(error)) + '</p>');
  }
  if (!ADMIN_TOKEN || state !== ADMIN_TOKEN) {
    return res.status(401).send('<h2 style="font-family:sans-serif">غير مصرح - Unauthorized</h2>');
  }
  if (!code) {
    return res.status(400).send('<h2 style="font-family:sans-serif">ما وصل كود من جوجل</h2>');
  }
  try {
    const redirectUri = PUBLIC_BASE_URL + '/drive-auth/callback';
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: code.toString(),
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      }),
    });
    const data = await tokenRes.json();
    if (!tokenRes.ok || !data.refresh_token) {
      return res.status(502).send(
        '<div style="font-family:sans-serif;direction:rtl;padding:20px">' +
        '<h2>ما رجع refresh_token ⚠️</h2>' +
        '<p>غالبًا لأنك سبق ووافقت قبل هيك ولسا في refresh token شغال من مرة سابقة (جوجل بيرجعه أول مرة بس عادةً). ' +
        'جرب: روح https://myaccount.google.com/permissions وألغي صلاحية "Merzona" (أو اسم التطبيق يلي حاطينه بـ Google Cloud Console)، وبعدين افتح رابط /drive-auth/start من جديد.</p>' +
        '<pre style="background:#f4f4f4;padding:10px;white-space:pre-wrap">' + escapeHtml(JSON.stringify(data, null, 2)) + '</pre>' +
        '</div>'
      );
    }
    saveGoogleRefreshToken(data.refresh_token);
    res.send('<h2 style="font-family:sans-serif;direction:rtl">تم الربط بنجاح ✅</h2><p style="font-family:sans-serif;direction:rtl">هلق كل الأدوات فيها تاخد توكن جوجل درايف تلقائيًا بدون أي نافذة أو كبسة. تقدر تسكر هالصفحة.</p>');
  } catch (e) {
    console.error('[Drive Auth] Callback failed:', e);
    res.status(500).send('<h2 style="font-family:sans-serif">صار خطأ</h2><pre>' + escapeHtml(String(e)) + '</pre>');
  }
});

// نفس منطق تجديد التوكن يلي بيستخدمه /drive-token تحت، بس كدالة قابلة لإعادة الاستخدام من أي
// مكان تاني بالسيرفر (خدمة التوقيع الإلكتروني تحت مثلاً) - بترمي Error بدل ما ترجع JSON مباشرة،
// حتى كل route يقدر يحوّلها لرسالة/status code مناسب إله.
async function getServerDriveAccessToken() {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    throw new Error('not-configured');
  }
  const refreshToken = loadGoogleRefreshToken();
  if (!refreshToken) {
    throw new Error('not-linked-yet');
  }
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  const data = await tokenRes.json();
  if (!tokenRes.ok || !data.access_token) {
    console.error('[Drive Token] Refresh failed:', data);
    throw new Error('refresh-failed');
  }
  return data.access_token;
}

// بتنادى عليه أداة الفاتورة والداشبورد عوضًا عن ما تفتح نافذة جوجل بنفسها - بيرجع توكن جاهز صالح
// لساعة تقريبًا، مبني على الـ refresh token المخزّن فوق. نفس AUTH_TOKEN تبع بقية السيرفر (x-api-key
// أو ?token=) - حتى ما يقدر أي حدا غريب يطلب توكن درايف حي من هون.
app.get('/drive-token', checkAuth, async (req, res) => {
  try {
    const access_token = await getServerDriveAccessToken();
    res.json({ access_token, expires_in: 3600 });
  } catch (e) {
    const msg = e && e.message;
    if (msg === 'not-configured') return res.status(500).json({ error: 'not-configured' });
    if (msg === 'not-linked-yet') return res.status(503).json({ error: 'not-linked-yet' });
    console.error('[Drive Token] Failed:', e);
    res.status(502).json({ error: 'refresh-failed' });
  }
});

// ============================================================================
//  Electronic contract signing (client-facing, no login required)
//  ------------------------------------------------------------------------
//  الزبون بيضغط رابط/QR "توقيع إلكتروني" الموجود بصندوق "توقيع الزبون" بعرض السعر (PDF)، فتفتحله
//  صفحة sign.html (عامة، بدون أي تسجيل دخول - مو موظف عندو حساب جوجل) بتعرضله ملخص العرض وتاخد
//  توقيعه (رسم باليد) + اسمه الكامل. لما يأكّد:
//   1. منولّد صفحة "شهادة توقيع إلكتروني" (Puppeteer - نفس كروميوم المستخدم أصلاً لواتساب) فيها
//      كل تفاصيل التوقيع، ومنلزقها كصفحة إضافية بآخر ملف PDF عرض السعر الأصلي (pdf-lib).
//   2. منرفع النسخة الموقّعة لنفس مجلد العرض بجوجل درايف (تحت "عقود مرفقة" - نفس مكان الملفات
//      يلي الموظف نفسه بيرفعها يدويًا من تبويب "العقود" بالداشبورد).
//   3. منحقن سجل "عقد" + "ملف مرفق" داخل ملف المزامنة المشترك (merzona-sync-data.json) مباشرة -
//      فبأول مزامنة/فتح للداشبورد على أي جهاز، العقد الجديد بيظهر تلقائيًا بتبويب "العقود" مع
//      رابط ملف الـPDF الموقّع، بدون ما يحتاج الموظف يضيفه يدويًا.
//   4. منبعت نسخة عن العقد الموقّع لمجموعة واتساب "العقود" (CONTRACTS_GROUP_ID).
//  الأمان: كل عرض سعر إله "signToken" عشوائي (32 خانة hex) اتولّد بالمتصفح وقت الحفظ ومحفوظ جوا
//  ملف بيانات العرض (<ref>-data.json) بجوجل درايف - رابط التوقيع ما بيشتغل بدون تطابق هالرمز مع
//  الرقم المرجعي، فتخمين رقم مرجعي (حتى لو كان تسلسلي وسهل التخمين) لحاله ما كافي.
// ============================================================================

const DRIVE_ROOT_FOLDER_ID_SERVER = '13q5WtejXrydWEeIEZ7pZoon6ocyVuX1D'; // نفس مجلد جوجل درايف الرئيسي المستخدم بكل أدوات ميرزونا
const SYNC_FILE_NAME = 'merzona-sync-data.json'; // نفس ملف المزامنة المشترك يلي الداشبورد بيقرأ/يكتب منه

function getYearFromReferenceServer(refRaw) {
  const digits = ((refRaw || '').match(/\d+/g) || []).join('');
  const m = digits.match(/^(\d{2})0\d+/);
  if (m) return '20' + m[1];
  return String(new Date().getFullYear());
}

function fmtNumServer(n) {
  const num = Number(n) || 0;
  return num.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

// ---- Drive REST helpers (Node's built-in fetch/FormData/Blob - Node 18+, نفس اللي بتعتمد عليه
// بقية السيرفر أصلاً لطلبات جوجل درايف) - نفس منطق الدوال الموجودة بـ index.html/Dashboard.html
// (findOrCreateDriveFolder / uploadFileToDriveFolder) بس بجهة السيرفر. ----
async function driveFindItemInParent(name, parentId, token) {
  const safeName = String(name).replace(/'/g, "\\'");
  const q = encodeURIComponent(`name = '${safeName}' and '${parentId}' in parents and trashed = false`);
  const res = await fetch(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name,mimeType)`, {
    headers: { Authorization: 'Bearer ' + token },
  });
  const data = await res.json();
  return (data.files && data.files[0]) || null;
}
async function driveFindOrCreateFolder(name, parentId, token) {
  const existing = await driveFindItemInParent(name, parentId, token);
  if (existing) return existing.id;
  const createRes = await fetch('https://www.googleapis.com/drive/v3/files', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder', parents: [parentId] }),
  });
  const createData = await createRes.json();
  return createData.id;
}
async function driveDownloadBuffer(fileId, token) {
  const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
    headers: { Authorization: 'Bearer ' + token },
  });
  if (!res.ok) throw new Error('drive-download-failed-' + res.status);
  const ab = await res.arrayBuffer();
  return Buffer.from(ab);
}
async function driveUploadBuffer(filename, mimeType, buffer, parentId, token) {
  const metadata = { name: filename, parents: [parentId] };
  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
  form.append('file', new Blob([buffer], { type: mimeType }));
  const res = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token },
    body: form,
  });
  return res.json();
}
async function driveUpdateFileContent(fileId, mimeType, buffer, token) {
  const res = await fetch(`https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`, {
    method: 'PATCH',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': mimeType },
    body: buffer,
  });
  if (!res.ok) throw new Error('drive-update-failed-' + res.status);
  return res.json();
}

// يلاقي مجلد عرض السعر (year/refSafe) بدون ما ينشئه لو مش موجود - عكس دوال الحفظ العادية يلي
// بتنشئ المجلد لو ناقص، هون بالعكس: لو المجلد مش موجود يعني عرض السعر نفسه ما انحفظ لجوجل درايف
// بعد من الأداة، فمنعتبرها "not-found" بدل ما ننشئ مجلدات فاضية.
async function locateRefFolderId(ref, token) {
  const year = getYearFromReferenceServer(ref);
  const yearFolder = await driveFindItemInParent(year, DRIVE_ROOT_FOLDER_ID_SERVER, token);
  if (!yearFolder) return null;
  const refFolder = await driveFindItemInParent(ref, yearFolder.id, token);
  return refFolder ? refFolder.id : null;
}

async function loadQuotationDataFile(ref, token) {
  const refFolderId = await locateRefFolderId(ref, token);
  if (!refFolderId) return null;
  const dataFileItem = await driveFindItemInParent(ref + '-data.json', refFolderId, token);
  if (!dataFileItem) return null;
  const buf = await driveDownloadBuffer(dataFileItem.id, token);
  let data;
  try {
    data = JSON.parse(buf.toString('utf8'));
  } catch (e) {
    return null;
  }
  return { data, fileId: dataFileItem.id, refFolderId };
}
async function saveQuotationDataFile(fileId, data, token) {
  await driveUpdateFileContent(fileId, 'application/json', Buffer.from(JSON.stringify(data)), token);
}

async function driveGetOrCreateSyncFileId(token) {
  const found = await driveFindItemInParent(SYNC_FILE_NAME, DRIVE_ROOT_FOLDER_ID_SERVER, token);
  if (found) return found.id;
  const created = await driveUploadBuffer(SYNC_FILE_NAME, 'application/json', Buffer.from('{}'), DRIVE_ROOT_FOLDER_ID_SERVER, token);
  return created.id;
}

// منحقن سجل العقد + الملف المرفق مباشرة جوا ملف المزامنة المشترك - بنفس بالضبط نظام الطوابع
// الزمنية لكل سجل (per-record timestamp) يلي الداشبورد نفسه بيعتمد عليه بمنطق الدمج (نفس فكرة
// mergeOneSyncKey جوا Dashboard.html) - فأي جهاز موظف بيفتح الداشبورد بعدين، أو يعمل مزامنة/مطابقة،
// بيلتقط هالتحديث تلقائيًا كأنو موظف تاني ضافه من جهازه هو بالضبط.
async function appendSignedContractToSyncData(token, { ref, clientName, fileEntry }) {
  const fileId = await driveGetOrCreateSyncFileId(token);
  const buf = await driveDownloadBuffer(fileId, token);
  let remote;
  try {
    remote = JSON.parse(buf.toString('utf8') || '{}');
  } catch (e) {
    remote = {};
  }
  const now = Date.now();

  remote.merzona_contracts = remote.merzona_contracts || {};
  remote.merzona_contracts__ts = remote.merzona_contracts__ts || {};
  if (!remote.merzona_contracts[ref]) {
    remote.merzona_contracts[ref] = { client: clientName || '—', paymentTables: [], createdAt: now };
    remote.merzona_contracts__ts[ref] = now;
  }

  remote.merzona_contract_files = remote.merzona_contract_files || {};
  remote.merzona_contract_files__ts = remote.merzona_contract_files__ts || {};
  const existing = remote.merzona_contract_files[ref];
  const list = Array.isArray(existing) ? existing.slice() : existing ? [existing] : [];
  list.push(fileEntry);
  remote.merzona_contract_files[ref] = list;
  remote.merzona_contract_files__ts[ref] = now;

  await driveUpdateFileContent(fileId, 'application/json', Buffer.from(JSON.stringify(remote)), token);
}

// بيولّد صفحة "شهادة توقيع إلكتروني" (HTML → PDF عبر Puppeteer/كروميوم) - منستخدم كروميوم بدل ما
// نعتمد على خطوط pdf-lib القياسية (يلي أصلاً ما بتدعم العربي إطلاقًا) - هيك النص العربي بيطلع
// بشكله الصحيح تمامًا (نفس محرك المتصفح يلي بيرسم كل صفحات ميرزونا العادية).
async function renderCertificatePdf({ ref, clientName, total, signerName, signatureDataUrl, signedAtIso }) {
  const signedAtDisplay = new Date(signedAtIso).toLocaleString('en-GB', { timeZone: 'Asia/Dubai', hour12: false }) + ' (Dubai time)';
  const html = `<!doctype html><html dir="rtl" lang="ar"><head><meta charset="utf-8"><style>
    body{font-family:'Segoe UI',Tahoma,Arial,sans-serif; margin:0; padding:36px; color:#1a1a2e; -webkit-print-color-adjust:exact;}
    .cert-box{border:2px solid #A15C1E; border-radius:10px; padding:30px;}
    h1{font-size:19px; color:#A15C1E; text-align:center; margin:0 0 4px;}
    h1 span{font-size:13px; display:block; margin-top:4px; color:#555; font-weight:400;}
    h2{font-size:12px; color:#888; text-align:center; margin:0 0 26px; font-weight:400;}
    table{width:100%; border-collapse:collapse; margin-bottom:22px;}
    td{padding:8px 4px; font-size:13px; border-bottom:1px solid #eee;}
    td.label{color:#888; width:40%;}
    td.val{font-weight:600;}
    .agree{font-size:11.5px; color:#333; background:#faf6ef; border:1px solid #e8dcc8; border-radius:6px; padding:14px; margin-bottom:22px; line-height:1.8;}
    .sign-box{text-align:center;}
    .sign-box img{max-width:240px; max-height:100px; border-bottom:1px solid #999; padding-bottom:8px;}
    .sign-label{font-size:11px; color:#888; margin-top:6px;}
    .footer{margin-top:26px; font-size:9.5px; color:#aaa; text-align:center;}
  </style></head><body>
    <div class="cert-box">
      <h1>شهادة توقيع إلكتروني<span>Electronic Signature Certificate</span></h1>
      <h2>Merzona for Aluminum &amp; Glass Works</h2>
      <table>
        <tr><td class="label">الرقم المرجعي / Reference</td><td class="val">${escapeHtml(ref)}</td></tr>
        <tr><td class="label">اسم العميل / Client</td><td class="val">${escapeHtml(clientName || '-')}</td></tr>
        <tr><td class="label">القيمة الإجمالية / Total</td><td class="val">${total ? fmtNumServer(total) + ' AED' : '-'}</td></tr>
        <tr><td class="label">اسم الموقّع / Signed by</td><td class="val">${escapeHtml(signerName)}</td></tr>
        <tr><td class="label">تاريخ ووقت التوقيع / Signed at</td><td class="val">${escapeHtml(signedAtDisplay)}</td></tr>
      </table>
      <div class="agree">
        بتوقيعي أدناه، أقر بأنني اطّلعت على جميع بنود وشروط عرض السعر المذكور أعلاه ووافقت عليها بالكامل، ويُعتبر هذا التوقيع الإلكتروني ملزمًا قانونيًا بذات قوة التوقيع الخطي.<br><br>
        By signing below, I confirm that I have reviewed and fully agree to all terms, conditions and items stated in the above-referenced quotation. This electronic signature carries the same legal weight as a handwritten signature.
      </div>
      <div class="sign-box">
        <img src="${signatureDataUrl}">
        <div class="sign-label">توقيع الزبون / Client Signature</div>
      </div>
      <div class="footer">تم إنشاء هذه الشهادة تلقائيًا بواسطة أداة Merzona الإلكترونية — Generated automatically by the Merzona quotation system</div>
    </div>
  </body></html>`;

  const browser = await puppeteer.launch({
    headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle0' });
    const pdfBuffer = await page.pdf({ format: 'A4', printBackground: true, margin: { top: '15mm', bottom: '15mm', left: '15mm', right: '15mm' } });
    return pdfBuffer;
  } finally {
    await browser.close();
  }
}

async function mergeCertificateIntoPdf(originalPdfBuffer, certPdfBuffer) {
  const mainDoc = await PDFDocument.load(originalPdfBuffer);
  const certDoc = await PDFDocument.load(certPdfBuffer);
  const certPages = await mainDoc.copyPages(certDoc, certDoc.getPageIndices());
  certPages.forEach((p) => mainDoc.addPage(p));
  const bytes = await mainDoc.save();
  return Buffer.from(bytes);
}

async function sendSignedContractToWhatsApp({ ref, clientName, total, signerName, pdfBuffer }) {
  if (!clientReady) throw new Error('whatsapp-not-ready');
  if (!CONTRACTS_GROUP_ID) throw new Error('CONTRACTS_GROUP_ID not set on the server - see README.md');
  let msg = '✅ *عقد جديد موقّع إلكترونيًا - Merzona*\n';
  msg += `المرجع: ${ref}\n`;
  if (clientName) msg += `العميل: ${clientName}\n`;
  if (total) msg += `القيمة الإجمالية: ${fmtNumServer(total)} AED\n`;
  msg += `الموقّع: ${signerName}\n`;
  const pdfBase64 = pdfBuffer.toString('base64');
  const media = new MessageMedia('application/pdf', pdfBase64, ref + '-signed.pdf');
  await client.sendMessage(CONTRACTS_GROUP_ID, media, { caption: msg });
}

const REF_PATTERN = /^[A-Za-z0-9\-_؀-ۿ]{3,60}$/;

const signViewLog = [];
function isSignViewRateLimited() {
  const now = Date.now();
  while (signViewLog.length && now - signViewLog[0] > 3600 * 1000) signViewLog.shift();
  return signViewLog.length >= 120;
}
const signSubmitLog = [];
function isSignSubmitRateLimited() {
  const now = Date.now();
  while (signSubmitLog.length && now - signSubmitLog[0] > 3600 * 1000) signSubmitLog.shift();
  return signSubmitLog.length >= 20;
}

// معلومات العرض المطلوب توقيعه - بتتأكد من تطابق الرمز السري (t) أول شي قبل ما ترجع أي معلومة.
app.get('/sign/:ref', async (req, res) => {
  const ref = String(req.params.ref || '').trim();
  const token = String(req.query.t || '');
  if (!REF_PATTERN.test(ref)) return res.status(400).json({ error: 'bad-ref' });
  if (!token) return res.status(400).json({ error: 'missing-token' });
  if (isSignViewRateLimited()) return res.status(429).json({ error: 'rate-limit' });
  signViewLog.push(Date.now());
  try {
    const driveToken = await getServerDriveAccessToken();
    const found = await loadQuotationDataFile(ref, driveToken);
    if (!found) return res.status(404).json({ error: 'not-found' });
    const { data } = found;
    if (!data.signToken || data.signToken !== token) return res.status(401).json({ error: 'invalid-token' });
    res.json({
      ok: true,
      ref,
      client: (data.fields && data.fields['m-client']) || '',
      total: data.grandTotal || 0,
      signed: !!data.signedAt,
      signedAt: data.signedAt || null,
      signerName: data.signerName || null,
    });
  } catch (e) {
    console.error('[Sign] GET /sign failed:', e);
    const msg = e && e.message;
    const code = msg === 'not-linked-yet' ? 503 : msg === 'not-configured' ? 500 : 500;
    res.status(code).json({ error: msg || String(e) });
  }
});

// تنفيذ التوقيع نفسه - بيتحقق من الرمز، يولّد شهادة التوقيع، يلزقها بآخر ملف PDF الأصلي، يرفع
// النسخة الموقّعة لجوجل درايف، يحدّث سجل العقد بالمزامنة المشتركة، ويبعت نسخة لمجموعة واتساب "العقود".
app.post('/sign/:ref', async (req, res) => {
  const ref = String(req.params.ref || '').trim();
  const { t: token, signerName, signatureDataUrl, agree } = req.body || {};
  if (!REF_PATTERN.test(ref)) return res.status(400).json({ error: 'bad-ref' });
  if (!token) return res.status(400).json({ error: 'missing-token' });
  if (!agree) return res.status(400).json({ error: 'must-agree' });
  const cleanSignerName = String(signerName || '').trim().slice(0, 120);
  if (!cleanSignerName) return res.status(400).json({ error: 'missing-signer-name' });
  if (!/^data:image\/(png|jpeg);base64,/.test(String(signatureDataUrl || ''))) {
    return res.status(400).json({ error: 'missing-signature' });
  }
  if (isSignSubmitRateLimited()) return res.status(429).json({ error: 'rate-limit' });
  signSubmitLog.push(Date.now());

  try {
    const driveToken = await getServerDriveAccessToken();
    const found = await loadQuotationDataFile(ref, driveToken);
    if (!found) return res.status(404).json({ error: 'not-found' });
    const { data, fileId, refFolderId } = found;
    if (!data.signToken || data.signToken !== token) return res.status(401).json({ error: 'invalid-token' });

    if (data.signedAt) {
      // موقّع أصلاً من قبل - منرجع نفس رابط التحميل بدل ما نكرر العملية ونولّد شهادة توقيع تانية
      return res.json({ ok: true, alreadySigned: true, downloadUrl: `/sign/${encodeURIComponent(ref)}/pdf?t=${encodeURIComponent(token)}` });
    }

    const originalPdfItem = await driveFindItemInParent(ref + '.pdf', refFolderId, driveToken);
    if (!originalPdfItem) return res.status(500).json({ error: 'quotation-pdf-missing' });
    const originalPdfBuffer = await driveDownloadBuffer(originalPdfItem.id, driveToken);

    const signedAtIso = new Date().toISOString();
    const clientName = (data.fields && data.fields['m-client']) || '';
    const total = data.grandTotal || 0;

    const certPdfBuffer = await renderCertificatePdf({ ref, clientName, total, signerName: cleanSignerName, signatureDataUrl, signedAtIso });
    const mergedPdfBuffer = await mergeCertificateIntoPdf(originalPdfBuffer, certPdfBuffer);

    const filesFolderId = await driveFindOrCreateFolder('عقود مرفقة', refFolderId, driveToken);
    const uploaded = await driveUploadBuffer(ref + '-signed.pdf', 'application/pdf', mergedPdfBuffer, filesFolderId, driveToken);

    data.signedAt = signedAtIso;
    data.signerName = cleanSignerName;
    data.signedPdfDriveId = uploaded.id;
    await saveQuotationDataFile(fileId, data, driveToken);

    try {
      await appendSignedContractToSyncData(driveToken, {
        ref,
        clientName,
        fileEntry: {
          name: ref + '-signed.pdf',
          driveFileId: uploaded.id,
          driveViewLink: uploaded.webViewLink || 'https://drive.google.com/file/d/' + uploaded.id + '/view',
        },
      });
    } catch (syncErr) {
      console.error('[Sign] Failed to update shared sync data (contract will need to be added manually in Dashboard):', syncErr);
    }

    let whatsappWarning = null;
    try {
      await sendSignedContractToWhatsApp({ ref, clientName, total, signerName: cleanSignerName, pdfBuffer: mergedPdfBuffer });
    } catch (waErr) {
      console.error('[Sign] Failed to send WhatsApp notification for signed contract:', waErr);
      whatsappWarning = String((waErr && waErr.message) || waErr);
    }

    res.json({ ok: true, downloadUrl: `/sign/${encodeURIComponent(ref)}/pdf?t=${encodeURIComponent(token)}`, whatsappWarning });
  } catch (e) {
    console.error('[Sign] POST /sign failed:', e);
    const msg = e && e.message;
    const code = msg === 'not-linked-yet' ? 503 : 500;
    res.status(code).json({ error: msg || String(e) });
  }
});

// تحميل نسخة العقد الموقّعة (يفتحها الزبون بعد التوقيع، أو يعيد فتحها لاحقًا بنفس الرابط) - بيتحقق
// من نفس الرمز السري، وما بيسمح بالتحميل إلا لو فعلاً موقّع.
app.get('/sign/:ref/pdf', async (req, res) => {
  const ref = String(req.params.ref || '').trim();
  const token = String(req.query.t || '');
  if (!REF_PATTERN.test(ref)) return res.status(400).send('bad ref');
  if (!token) return res.status(400).send('missing token');
  try {
    const driveToken = await getServerDriveAccessToken();
    const found = await loadQuotationDataFile(ref, driveToken);
    if (!found) return res.status(404).send('not found');
    const { data } = found;
    if (!data.signToken || data.signToken !== token) return res.status(401).send('unauthorized');
    if (!data.signedAt || !data.signedPdfDriveId) return res.status(404).send('not signed yet');
    const pdfBuffer = await driveDownloadBuffer(data.signedPdfDriveId, driveToken);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${ref}-signed.pdf"`);
    res.send(pdfBuffer);
  } catch (e) {
    console.error('[Sign] GET /sign/:ref/pdf failed:', e);
    res.status(500).send('server error');
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
