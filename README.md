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
  `merzona-server`) and upload the 4 files from this `whatsapp-server`
  folder using **Add file → Upload files** — the same drag-and-drop way you
  already update the Merzona tool, no coding required.
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
