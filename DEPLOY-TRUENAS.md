# Running Tavern on TrueNAS

This guide is for **TrueNAS SCALE 24.10 ("Electric Eel") or newer**, where Apps run on Docker. Check your version on the dashboard.

- **24.04 "Dragonfish" or older** used Kubernetes for apps. Update first, or ask for a different guide.
- **TrueNAS CORE** (FreeBSD) isn't covered here.

There are four steps: make a dataset for the data, publish the app to GitHub (which builds the image for you), install it as a Custom App, then add HTTPS if friends will connect from outside your home.

Replace `tank` with the name of your pool everywhere below.

---

## 1. Make a dataset for Tavern's data

The database and uploaded pictures live here, so this is what you back up.

1. **Datasets → select your pool → Add Dataset.** Name it `apps` if you don't have one already, then add a child dataset called `tavern`. The result is `/mnt/tank/apps/tavern`.
2. Open the `tavern` dataset, **Permissions → Edit**, set **User** and **Group** to `apps` (the built-in user with ID 568), tick **Apply User** and **Apply Group**, and save.

> Keep this on a local dataset. Don't point it at an SMB or NFS share. SQLite databases corrupt on network file systems.

## 2. Publish the image from GitHub

Like your other apps, the NAS pulls a ready-made image. GitHub builds it for you using the included workflow, [`.github/workflows/docker.yml`](.github/workflows/docker.yml).

1. **Create a GitHub repository** named `tavern` and push this project to it (`main` branch). The workflow starts by itself.
2. Watch the **Actions** tab. The first run takes a few minutes and ends green.
3. **Make the image public**, so the NAS can pull it without signing in: on your GitHub profile open **Packages → tavern → Package settings → Change visibility → Public**. (The image only contains the app's code, never your chats or settings. Those live in the dataset.)

Your image is now at `ghcr.io/<your-github-username>/tavern:latest`.

> **Prefer to keep it private?** Then the NAS has to sign in to GitHub to pull. Open the TrueNAS shell and run `sudo docker login ghcr.io` with your username and a personal access token that has the `read:packages` scope.

**No GitHub?** You can build on the NAS instead: copy `server`, `scripts`, `public`, `Dockerfile`, `package.json`, `package-lock.json` and `.dockerignore` to a folder there, then in the TrueNAS shell run `sudo docker build -t tavern:latest .` and use `image: tavern:latest` in the YAML below.
## 3. Install it as a Custom App

1. **Apps → Discover Apps → Custom App → Install via YAML.**
2. Name it `tavern`.
3. Paste the contents of [`docker-compose.yml`](docker-compose.yml) and edit the lines marked `CHANGE`:
   - the **image** name, if your GitHub username or repository name differs from `ramblepaw/tavern`
   - the **port** (left number) if 30300 is already used
   - **`VAPID_SUBJECT`** to your real email, because push notifications need it
   - the **`/mnt/tank/...`** path to your pool name
4. **Save.** Wait for the app to show **Running**.

Open `http://<your-NAS-ip>:30300`. The first account you create becomes the admin. Add friends from **You → Invite people**.

That already works on your home network. Notifications and "Add to Home Screen" install need HTTPS, which is the next step.

## 4. Put Nginx in front (HTTPS on your domain)

Browsers only allow notifications and app-style install over HTTPS, so Nginx terminates HTTPS and forwards to Tavern's port. Friends then visit `https://chat.yourdomain.com`.

First, point a DNS record for `chat.yourdomain.com` (an `A` record to your public IP, or whatever you already do for your other sites) and make sure ports 80 and 443 reach your Nginx. **Do not forward port 30300**: that's plain HTTP, and only Nginx should talk to it.

Three things matter. If any is missing, Tavern half-works:

| Setting | Why |
| --- | --- |
| **WebSocket upgrade** | Live messages, typing indicators and unread counts ride on a WebSocket at `/ws`. Without it messages only appear after a refresh. |
| **Upload size limit** | Stock Nginx allows only **1 MB** per request, so with a hand-written config you need `client_max_body_size 20m` or larger pictures fail with a "413" error (Tavern's own limit is 15 MB). Nginx Proxy Manager usually allows more by default. |
| **Keep the `Host` header** | Tavern rejects requests whose `Origin` and `Host` differ (a CSRF protection). Nginx must pass the original host name through. |

### If you use Nginx Proxy Manager

1. **Hosts → Proxy Hosts → Add Proxy Host.**
2. **Details tab:** Domain Names `chat.yourdomain.com`, Scheme `http`, Forward Hostname / IP = **your NAS's LAN IP** (not `localhost`; NPM runs in its own container), Forward Port `30300`. Switch on **Websockets Support** and **Block Common Exploits**.
3. **SSL tab:** request a new Let's Encrypt certificate, then switch on **Force SSL** and **HTTP/2 Support**.
4. **Advanced tab:** leave it empty for now. Nginx Proxy Manager's defaults normally allow large uploads (that's why other apps behind it work without extra settings).

Save, then run the checks below. **Only if** a picture over 1 MB fails with "That upload is too large for the server", come back to the Advanced tab and add:

```nginx
client_max_body_size 20m;
```

NPM already forwards the `Host`, `X-Forwarded-For` and `X-Forwarded-Proto` headers.
### If you maintain Nginx config files yourself

Put the `map` in the `http {}` block and the servers alongside your others:

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 80;
    server_name chat.yourdomain.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;                 # add "http2" here on nginx older than 1.25.1
    server_name chat.yourdomain.com;

    ssl_certificate     /path/to/fullchain.pem;
    ssl_certificate_key /path/to/privkey.pem;

    client_max_body_size 20m;       # pictures; nginx's default is 1m

    location / {
        proxy_pass http://NAS-LAN-IP:30300;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade           $http_upgrade;
        proxy_set_header Connection        $connection_upgrade;
        proxy_read_timeout 3600s;   # keeps idle WebSockets open
    }
}
```

Reload Nginx (`nginx -s reload`, or restart its app in TrueNAS).

### If your domain also goes through Cloudflare's orange-cloud proxy

Traffic then passes two proxies (Cloudflare, then your Nginx). In the app YAML change `TRUST_PROXY: "1"` to `"2"` so Tavern sees visitors' real addresses and still marks the cookie secure. If you aren't using Cloudflare's proxy, leave it at `"1"`.

### Check it works

1. Visit `https://chat.yourdomain.com`. You should see a padlock and the sign-in page.
2. Open it in two browsers (or a browser and your phone), sign in as two different people, start a chat and send a message. It should appear on the other side **instantly**. If it only shows up after a refresh, the WebSocket isn't getting through.
3. Send a picture bigger than 1 MB. If it fails, `client_max_body_size` isn't applied.

---
## Turn on notifications

1. Open `https://chat.yourdomain.com` on each phone. On an iPhone use **Safari → Share → Add to Home Screen**, then open Tavern from the Home Screen. iOS must be 16.4 or newer.
2. **You → Notifications**, allow the prompt, then tap **Send a test notification**.

## Updating Tavern

1. Push your changes to GitHub and wait for the **Actions** run to finish.
2. On the NAS, open **System → Shell** and pull the new image: `sudo docker pull ghcr.io/ramblepaw/tavern:latest`
3. In **Apps**, open `tavern`, then **Stop** and **Start** it.

TrueNAS won't re-pull a `latest` image on its own, which is why step 2 is needed. Your data is on the dataset, so updates never touch it.
## Backups

Add a **periodic snapshot task** (Data Protection → Periodic Snapshot Tasks) for `tank/apps/tavern`, and replicate it somewhere else if you can. The dataset holds the chat database, all pictures, and `vapid.json`. Losing `vapid.json` means everyone has to turn notifications back on.

## If something goes wrong

| Symptom | Likely cause |
| --- | --- |
| App stops straight away; logs show `EACCES` or `SQLITE_CANTOPEN` | The dataset isn't owned by `apps` (step 1, permissions). |
| `docker: command not found` in the shell | You're on an older TrueNAS without Docker apps (see the top of this guide). |
| App shows Running but the page doesn't load | Wrong port. Check the left number in `ports:` and try `http://<NAS-ip>:<port>`. |
| Logs say the port is already allocated | Another app uses it. Change the left number in `ports:`. |
| Can sign in but messages only appear after refreshing | Nginx isn't passing WebSockets: switch on Websockets Support (NPM) or add the `Upgrade` headers. |
| Pictures fail with "413" or "too large for the server" | Add `client_max_body_size 20m;` (NPM: Advanced tab of the proxy host). |
| "Cross-origin request blocked" when signing in | Nginx isn't passing the `Host` header. |
| Signed out on every visit over HTTPS | `TRUST_PROXY: "1"` is missing, so the cookie isn't marked secure. |
| "Notifications" says it needs HTTPS or the Home Screen | Open the HTTPS address, not the LAN one. On iPhone, launch from the Home Screen icon. |

View logs under **Apps → tavern → Workloads → Logs**.



