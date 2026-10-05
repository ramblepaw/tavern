# Tavern

A self-hosted chat app built for online roleplay. It runs on your own computer or server, and works in the browser on iPhones, Android phones and desktops. On an iPhone you can add it to the Home Screen so it opens full-screen like a normal app.

## Features

- **Multiple chats**: direct messages and named group chats, with live updates, unread badges and typing indicators.
- **Images**: attach up to 4 pictures per message. Photos are auto-rotated, shrunk and stripped of metadata (including GPS). Animated GIFs are kept. Tap a picture to view it full-screen.
- **User profiles**: avatar, display name, pronouns, bio and name colour. Tap anyone's avatar to see their profile.
- **Characters**: each person can make any number of characters with their own name, picture, bio and colour, then post as a character or as themselves (OOC) from a picker next to the message box. Old messages keep the character's name and picture even if you edit or delete the character later.
- **Roleplay formatting**: `*actions*`, `"speech"` (highlighted), `((out-of-character))` (dimmed), `**bold**`, `~~strike~~`, `||spoilers||`, and clickable links.
- **Search**: find messages across all your chats, or inside one chat (the magnifier in the chat header). Matches the start of each word, highlights what matched, and tapping a result jumps to that spot in the conversation.
- **Push notifications**: get an alert on your phone when someone messages you, even when the app is closed. Turn them on under **You → Notifications**. See below for what they need.
- **Private by default**: invite-only sign-up, and pictures are only visible to signed-in people.

## Run it

You need [Node.js](https://nodejs.org) 22.13 or newer.

```
npm install
npm start
```

On Windows you can also double-click `start.bat`.

Open `http://localhost:3000`. The first account you create becomes the **admin**. After that, sign-up needs an invite code. Open **You → Invite people**, create a code, and send your friend the link.

The server prints your local network address too (for example `http://192.168.1.20:3000`). Other devices on the same Wi-Fi can use that.

## Using it on an iPhone

1. Open the server address in **Safari**.
2. Tap **Share → Add to Home Screen**.

For friends who aren't on your Wi-Fi, the server needs to be reachable from the internet. **Use HTTPS**. Passwords and sessions shouldn't travel over plain HTTP outside your home network. iOS also only enables its app-like features, such as the offline shell, on HTTPS. Easy options:

- **Tailscale**: install it on the host and on each phone, then run `tailscale serve --bg 3000` to get an HTTPS address that only your tailnet can reach. (`tailscale funnel` makes it public.)
- **Cloudflare Tunnel**: `cloudflared tunnel --url http://localhost:3000` gives you a public HTTPS address.
- Any reverse proxy (Caddy, nginx) with a certificate.

When you run behind a proxy or tunnel, start the server with `TRUST_PROXY=1` so cookies are marked Secure and rate limiting sees real IP addresses:

```
set TRUST_PROXY=1&& npm start        (Windows cmd)
$env:TRUST_PROXY=1; npm start        (PowerShell)
TRUST_PROXY=1 npm start              (macOS / Linux)
```

## Running it on a NAS or server (Docker / TrueNAS)

A `Dockerfile` and `docker-compose.yml` are included. For TrueNAS SCALE, follow [DEPLOY-TRUENAS.md](DEPLOY-TRUENAS.md). On any other Docker host, `docker compose up -d --build` works after you adjust the volume path in the compose file.

## Push notifications

Notifications use standard Web Push, so no third-party account or app store is involved. The server creates its own keys on first start (`data/vapid.json`) and sends alerts through Apple's, Google's or Mozilla's push services. The message text is encrypted end to end between your server and the device.

What they need:

- **HTTPS.** Browsers refuse notifications on plain HTTP (the only exception is `localhost`). See the HTTPS options above.
- **iPhone and iPad:** iOS 16.4 or newer, and Tavern must be **added to the Home Screen** and opened from there. Notifications can't be turned on from a normal Safari tab.
- **Set `VAPID_SUBJECT`** to a real contact such as `mailto:you@yourdomain.com`. Apple's push service rejects bogus ones.

To turn them on, open **You → Notifications** and tap it. Allow the permission prompt, then use **Send a test notification** to confirm it works. Each device is opted in separately, and signing out turns notifications off for that device.

You only get an alert when you're *not* looking at that chat. Tapping a notification opens the chat.

## Search

Tap the magnifier on the **Chats** screen to search everything, or the one in a chat's header to search just that chat. You can only ever find messages from chats you're in. Messages sent before you updated to this version are indexed automatically the first time the server starts.

## Settings

All optional, set as environment variables:

| Variable | Default | What it does |
| --- | --- | --- |
| `PORT` | `3000` | Port to listen on |
| `HOST` | `0.0.0.0` | Address to bind. Use `127.0.0.1` to allow only this computer, for example when a tunnel runs on the same machine |
| `DATA_DIR` | `./data` | Where the database and uploaded images are stored |
| `MAX_UPLOAD_MB` | `15` | Largest allowed image upload |
| `OPEN_REGISTRATION` | `false` | `true` lets anyone sign up without an invite code |
| `TRUST_PROXY` | off | Set to `1` behind a reverse proxy or tunnel |
| `VAPID_SUBJECT` | `mailto:admin@example.com` | Your contact address, sent to the push services. Set this to a real one |

## Backups, passwords, upgrades

- **Backup**: stop the server and copy the `data/` folder. It holds `chat.db`, `uploads/` and `vapid.json`. Keep `vapid.json` with the database: if it's lost, everyone has to turn notifications back on.
- **Forgot your password?** `npm run reset-password -- <username> <new password>`
- Nothing else needs migrating. Updating the app is replacing the files and restarting.

## How it's built

Node + Express, SQLite (Node's built-in `node:sqlite`, with FTS5 for search), WebSockets (`ws`) for live updates, `web-push` for notifications, and `sharp` for image processing. The front end is plain JavaScript with no build step, in `public/`. The server is in `server/`.

## Not included (yet)

- Deleting user accounts.
- Muting individual chats (notifications are all-or-nothing per device for now).
