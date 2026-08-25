# Merzona WhatsApp Bridge

A small server that does two things for the Merzona tool:

1. **WhatsApp notify**: posts every saved quotation to the "Tasks" WhatsApp
   group automatically.
2. **Login approval**: locks the tool (Dashboard/Quotation/Procurement)
   until you approve each new device, with a one-tap Approve/Deny link sent
   to your WhatsApp.

Both run from **one deployment** — you set this server up once, not twice.

---

## Quick checklist

Do these in order. Each one is a single action — don't worry about the "why"
behind each, that's all explained further down if you want it later.

**Setup (about 15 minutes, once):**

- [ ] **1.** Sign up at [railway.app](https://railway.app) using the "Login
  with GitHub" button (creates a free GitHub account too if you don't have
  one yet).
- [ ] **2.** On github.com, create a new repository (e.g. name it
  `merzona-server`) and upload **all 5 files** from this `whatsapp-server`
  folder (including `Dockerfile` — it has no file extension, that's normal)
  using **Add file → Upload files** — the same drag-and-drop way you already
  update the Merzona tool, no coding required. The `Dockerfile` is what
  makes WhatsApp actually able to launch on Railway's servers; without it
  the deploy crashes with a "shared libraries" error.
- [ ] **3.** In Railway: **New Project → Deploy from GitHub repo** → pick
  `merzona-server`.
- [ ] **4.** In the service's Settings, click **New → Volume**, attach it,
  and set its Mount Path to exactly `/data` (this keeps your WhatsApp login
  from being wiped every time the server restarts).
- [ ] **5.** In the service's **Variables** tab, paste in all of these at
  once (only fill in the one marked ✏️ — the rest are ready to use):

  ```
  AUTH_TOKEN=SWkEojES13KEGpg0Rib3cfQrRUQI6Nky
  ADMIN_TOKEN=NqxhZ6sVAQIAENZcdCKVKFjDfCv12JJV
  ALLOWED_ORIGIN=https://management4w-beep.github.io
  OWNER_WHATSAPP_NUMBER=✏️ your number, digits + country code only, e.g. 971501234567
  GROUP_ID=
  PUBLIC_BASE_URL=
  ```

  (Leave `GROUP_ID` and `PUBLIC_BASE_URL` blank for now — you'll fill those
  in step 6, since they don't exist until the server is actually live.)

**First-time config (once, right after it's deployed):**

- [ ] **6.** Once deployed, Railway shows you a public URL (Settings →
  Networking → "Generate Domain" if it's not there yet), something like
  `https://your-app.up.railway.app`. Go back to Variables, set
  `PUBLIC_BASE_URL` to that URL (no trailing slash), and save.
- [ ] **7.** Open `<your-url>/qr` in a browser and scan it from WhatsApp on
  your number (Settings → Linked Devices → Link a Device).
- [ ] **8.** Open `<your-url>/groups?token=SWkEojES13KEGpg0Rib3cfQrRUQI6Nky`
  — find the "Tasks" group in the list, copy its `id`, go back to Variables
  and paste it into `GROUP_ID`, save.
- [ ] **9.** Open `Dashboard.html`, `Quotation_Generator.html`, and
  `procurement.html` — in **all three**, find `var ACCESS_SERVER_URL = '';`
  and set it to your URL. In `Quotation_Generator.html` **only**, also find
  `WHATSAPP_NOTIFY_URL` / `WHATSAPP_NOTIFY_TOKEN` and fill those in too (see
  the exact snippets below). Re-upload all three files to your GitHub Pages
  repo like you normally do.
- [ ] **10.** Open the tool once on each of your own devices with
  `#owner=NqxhZ6sVAQIAENZcdCKVKFjDfCv12JJV` added to the very end of the
  URL — this unlocks that device permanently, one time only, and never
  needs repeating.
- [ ] **11.** Test: save a test quotation (check the "Tasks" group gets a
  message), and open the tool link from a different browser to see the
  "request access" screen + your WhatsApp approval notification.

That's it — steps 1-5 are a one-time setup, 6-11 are quick copy/paste
actions right after. Everything below is optional background reading.

---

### The exact lines to edit in step 9

In **all three** files (`Dashboard.html`, `Quotation_Generator.html`,
`procurement.html`):

```js
var ACCESS_SERVER_URL = 'https://your-app.up.railway.app';
```

In `Quotation_Generator.html` **only**, additionally:

```js
const WHATSAPP_NOTIFY_URL = 'https://your-app.up.railway.app/send-quotation';
const WHATSAPP_NOTIFY_TOKEN = 'SWkEojES13KEGpg0Rib3cfQrRUQI6Nky';
```

---

## Why does this need a server at all?

The official WhatsApp Cloud API **cannot send messages to WhatsApp Groups at
all** — test number or real number, doesn't matter, that's a hard limit set
by Meta. The only way to send to a group automatically is via the
`whatsapp-web.js` library, which runs a background WhatsApp Web session on
your own number. That means:

- ⚠️ **This is not an officially supported use of WhatsApp/Meta.** There is
  a (small but real) risk the number could get flagged if it sends a large
  volume of messages or otherwise looks automated. Use a non-critical number
  for this (like your existing test number) rather than your main business
  line.
- The server needs to stay running 24/7 — that's why it needs separate
  hosting (Railway) instead of living on GitHub Pages with the rest of the
  tool.

## Google Drive silent-token service (no more Google popups)

Solves "I have to click Sync / approve Google every time I open the tool."
One-time setup, then every tool gets a ready Drive token from this server —
no Google window ever, not even once an hour.

- [ ] **1.** Go to [Google Cloud Console](https://console.cloud.google.com/apis/credentials),
  open the OAuth 2.0 Client ID already used by the tool
  (`575144277793-dgh7oslo72umva7cb37rpa82tman9vfm.apps.googleusercontent.com`),
  and copy its **Client secret**.
- [ ] **2.** In that same client's **Authorized redirect URIs**, add:
  `<your-url>/drive-auth/callback` (exactly, no trailing slash) — save.
- [ ] **3.** In Railway → Variables, add:
  ```
  GOOGLE_CLIENT_ID=575144277793-dgh7oslo72umva7cb37rpa82tman9vfm.apps.googleusercontent.com
  GOOGLE_CLIENT_SECRET=✏️ paste the client secret from step 1
  ```
- [ ] **4.** Open `<your-url>/drive-auth/start?admin=<ADMIN_TOKEN>` in a
  browser, sign in with the Google account that owns the Drive folder, and
  approve. You'll see "تم الربط بنجاح ✅" — that's it, one time only. The
  server stores what it needs on the same `/data` Volume from step 4 above.
- [ ] **5.** That's it — `Quotation_Generator.html` and `Dashboard.html`
  already call this service first automatically (already wired in the code).
  If the server is ever unreachable, they fall back to the old
  browser-popup method on their own, so nothing breaks either way.

**If you ever need to re-link** (switched Google accounts, or see
`not-linked-yet` / `refresh-failed` errors): just open
`<your-url>/drive-auth/start?admin=<ADMIN_TOKEN>` again.

## Electronic contract signing (client e-signature)

Lets a client sign a quotation from their phone (draw their signature, no
app/account needed) instead of printing and signing on paper. The quotation's
"Client Signature" box now shows a QR code + link — the client taps/scans it,
signs on a simple web page, and:

- gets an instant download of the signed contract PDF (the original
  quotation with a signature certificate page appended),
- the contract is added to the Dashboard's "العقود" (Contracts) tab
  automatically, with the signed PDF attached,
- a copy is sent to a dedicated WhatsApp group for signed contracts.

This reuses the same Google Drive link from the section above — nothing
extra to set up there. Two new things needed:

- [ ] **1.** Upload `sign.html` to your GitHub Pages repo, alongside
  `index.html`/`Dashboard.html` (**Add file → Upload files → Commit
  changes**, same as always). It's a public page with no login — that's
  intentional, since your clients don't have accounts on the tool.
- [ ] **2.** Create a new WhatsApp group called e.g. "العقود" (or any name
  you like), add the linked WhatsApp number to it, then open
  `<your-url>/groups?token=<AUTH_TOKEN>` and find its `id` (same way you
  found `GROUP_ID` originally). In Railway → Variables, add:
  ```
  CONTRACTS_GROUP_ID=✏️ paste the id you just found
  ```

That's it — the next quotation you save will already show the QR/sign link
in its "Client Signature" box. Older, already-sent quotations only get the
new sign box once you edit and re-save them from the updated tool (or the
client can still just sign the paper copy as before — nothing is broken for
existing quotations).

**Notes:**
- Rendering the signature certificate page reuses the same Chromium
  installed in the Dockerfile for WhatsApp — no extra system setup needed on
  Railway.
- A signing link only works for the one quotation it was generated for, and
  stops meaning anything useful to a stranger even if guessed — each
  quotation gets its own long random code, checked on every request.
- If a client re-opens a link after already signing, they just see a
  "already signed" screen with a download button instead of being able to
  sign again.

## Managing things afterward

- **Missed a WhatsApp access-request notification?** Open
  `<your-url>/access/admin?admin=NqxhZ6sVAQIAENZcdCKVKFjDfCv12JJV` — lists
  every device that's ever asked, with Approve/Deny/Revoke links. Bookmark
  it.
- **Revoking someone's access** (e.g. an employee leaves): tap "إلغاء
  الوصول" next to their name on that same admin page. Their browser
  re-checks every ~5 minutes even with the tab still open, and locks itself
  again once it notices — or instantly on their next reload.
- If someone clears their browser data or opens the tool on a different
  device, they show up as a brand-new request needing approval again —
  that's expected, not a bug.
- If the server is off or asleep, saving to Google Drive still works fine —
  only the WhatsApp notify silently fails (logged to the browser console,
  never blocks the save). The login-approval gate, though, depends on the
  server being reachable — if it's down, nobody new can get in until it's
  back up (already-approved devices keep working from their local cache).
- Both `AUTH_TOKEN` and `WHATSAPP_NOTIFY_TOKEN` above are visible inside
  `Quotation_Generator.html`'s source code (anyone using "View Page Source"
  can see them) — an inherent limit of the tool being static files with no
  backend of its own. The server caps WhatsApp sends at 30/hour as basic
  abuse protection. If you ever notice odd activity, generate new random
  tokens, update both the Railway variables and the tool files, and
  re-upload.
- To change the WhatsApp message wording, edit `server.js` — search for
  `msg += ...` inside `/send-quotation` (notify) or `/access/request`
  (owner-notification text).
