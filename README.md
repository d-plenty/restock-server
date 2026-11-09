# Restock server

Your own sync box for [Restock](https://github.com/d-plenty/Restock), the local-first grocery price tracker. Run it at home on a NAS, home server, old laptop or Raspberry Pi. Your household's phones sync through it at home and away, and you get Restock in a web browser on any computer.

**Needs Restock 0.9.2 or newer** on your phones. Get Restock from [d-plenty/Restock](https://github.com/d-plenty/Restock).

- **End-to-end encrypted.** Phones seal everything before it leaves them. The server stores the sealed files and hands them back. It never has the key, so it can't read your lists, prices or receipts.
- **Local first.** Phones never wait for the server. If it's off, Restock carries on as normal and catches up later.
- **Restock in your browser.** The server also serves the Restock web app. It opens your household in the browser with your passphrase, not on the server.

## Contents

1. [Start it](#1-start-it)
2. [Log in and set a passphrase](#2-log-in-and-set-a-passphrase)
3. [Add your phones](#3-add-your-phones)
4. [Link the web page with a phone](#4-link-the-web-page-with-a-phone)
- [Sign in with a phone](#sign-in-with-a-phone)
- [At home and away](#at-home-and-away)
- [Backups](#backups)
- [Forgot your passphrase?](#forgot-your-passphrase)
- [Recovering deleted files](#recovering-deleted-files)
- [Updating](#updating)
- [What the server can and can't see](#what-the-server-can-and-cant-see)
- [Settings](#settings) and [what's in the data volume](#whats-in-the-data-volume)
- [For developers](#for-developers)

## 1. Start it

You need [Docker](https://docs.docker.com/get-docker/). Run this on the machine that'll be the server:

```sh
docker run -d --name restock-server -p 8787:8787 -v restock-data:/data -e RESTOCK_PASSWORD=admin ghcr.io/d-plenty/restock-server:latest
```

That's it. It keeps everything in a Docker volume called `restock-data`. `RESTOCK_PASSWORD` is only for the first login; it stops working once you've set a passphrase. If other people use your network, change `admin` to a password of your own before you run it.

While the password is still `admin` (or another one anyone could guess, like the `change-me-now` in `compose.yaml`), the first login only works from your home network or Tailscale, not through Cloudflare Tunnel or anything else from the internet. If you need to set it up from somewhere else, start the server with your own `RESTOCK_PASSWORD`.

To have it start again after a restart, and locked down a bit more, use this instead:

```sh
docker run -d --name restock-server --restart unless-stopped --read-only --cap-drop ALL --security-opt no-new-privileges -p 8787:8787 -v restock-data:/data -e RESTOCK_PASSWORD=admin ghcr.io/d-plenty/restock-server:latest
```

Check it's running with `docker logs restock-server`. You should see the address to open.

### With Docker Compose, Dockge, Portainer or TrueNAS

Use [`compose.yaml`](compose.yaml) from this repo. Change `RESTOCK_PASSWORD` in it first.

- **Docker Compose:** put `compose.yaml` in a folder and run `docker compose up -d` there.
- **Dockge:** *+ Compose*, name it `restock-server`, paste in `compose.yaml`, then *Deploy*.
- **Portainer:** *Stacks → Add stack*, paste in `compose.yaml`, then *Deploy the stack*.
- **TrueNAS SCALE (24.10 or newer):** *Apps → Discover Apps → ⋮ → Install via YAML*, paste in `compose.yaml`, then *Save*. To keep the data on a dataset instead of a Docker volume, change `restock-data:/data` to your dataset's path, for example `/mnt/tank/apps/restock:/data`, and let the server (user 1000) write to it: `sudo chown -R 1000:1000 /mnt/tank/apps/restock`.

## 2. Log in and set a passphrase

1. On a computer on the same network, open `http://<the server's address>:8787`, for example `http://192.168.1.10:8787`. (On the server itself, `http://localhost:8787` works too.)
2. Log in with **admin** and your `RESTOCK_PASSWORD`. If it says *"Finish setting up Restock server from your home network first"*, you're coming in from outside your home network with the default `admin` password (or `change-me-now`): do this step at home (or over Tailscale), or restart the server with your own `RESTOCK_PASSWORD`.
3. Choose a **passphrase**. Four or more random words works well, like *kettle orbit lemon fence*, or anything with at least 20 characters. The page won't take common passwords, the user name or "admin".
4. Sign in with your new passphrase. From now on that's how you sign in, and the first-login password no longer works.

Your passphrase never leaves the browser. The browser turns it into two keys: one proves it's you (the server keeps only a scrypt hash of it), and one locks your web keys (that one never leaves the browser). Keep the passphrase somewhere safe, like a password manager.

## 3. Add your phones

Each phone in the household joins the server once:

1. On the web page, choose **Add a phone** (on the first visit it's under *No phone on this server yet? Add one first*; later it's on the **Phones** page). A QR code appears. It works once, for 10 minutes.
2. On the phone, open Restock and go to **Settings → Sync and backups → Local sync → Restock server**, then scan the code.
3. Do the same for each phone, with a new code each time.

Phones need to be in the same Restock household first (set that up on the phones as usual). The server carries the household's changes; it doesn't make the household.

Each phone gets its own key for the server, and the server keeps only its public half. **Phones** on the web page shows each phone and when it was last seen. **Remove** stops that phone using the server straight away.

## 4. Link the web page with a phone

The first time you sign in, the web page can't see your household yet: only your phones have the key. To hand it over:

1. On the web page, choose **Link with a phone**. A QR code appears.
2. On a phone you added in step 3, open **Settings → Sync and backups → Local sync → Restock server → Scan the web page's code** and scan it.
3. The phone asks "Let this browser see your household?" Say yes.

The phone seals the keys to that browser's own key, which is in the QR code, so the server can't read them or swap them. The browser saves them, locked with your passphrase. You only do this once.

## Sign in with a phone

On a computer you don't use often, you can skip the passphrase: on the sign-in page choose **Sign in with a phone** and scan the code with a phone that's on this server. The code lasts 2 minutes and works once. A browser signed in this way keeps the keys only until you close it, can't change the passphrase vault, and is signed out after 12 hours unused, or straight away if you remove the phone that let it in.

Signed in somewhere you shouldn't be? **Account → Sign out everywhere** signs out every browser.

## At home and away

Phones try the **home** address first, then the **away** address. Away from home the address has to be **https://**, unless it's a Tailscale address (Tailscale already encrypts the connection). Plain `http://` only works on your home network.

The addresses go into the phones' QR code, so set them **before** you add phones (or add the phones again after changing them):

- `RESTOCK_HOME_URL`, for example `http://192.168.1.10:8787`. If you leave it out, it's the address you opened the web page with.
- `RESTOCK_AWAY_URL`, for example `https://restock.example.com`.

Add them with `-e` in the `docker run` command (for example `-e RESTOCK_HOME_URL=http://192.168.1.10:8787`), or in `compose.yaml`.

**Tailscale** (the simplest): install [Tailscale](https://tailscale.com) on the server machine and on the phones, then set `RESTOCK_AWAY_URL` to `http://<the server's Tailscale address>:8787`, for example `http://100.101.5.7:8787`. Or use `tailscale serve` for an `https://<name>.<tailnet>.ts.net` address.

**Cloudflare Tunnel:** point a tunnel's public hostname at the server (`http://restock-server:8787` if `cloudflared` runs in the same Docker network, otherwise `http://localhost:8787`). Then set:

```
RESTOCK_AWAY_URL=https://restock.example.com
RESTOCK_TRUST_PROXY=cloudflare
```

`RESTOCK_TRUST_PROXY` tells the server to read the visitor's real address from Cloudflare, so the lock-out after wrong passphrases hits the person guessing, not everyone. It only believes those headers on connections from your home network or Docker (where the tunnel runs), so someone reaching the port from the internet can't make up an address. Don't put Cloudflare Access (a login page) in front of it: phones can't get past it.

**Your own reverse proxy** (Caddy, Traefik, Nginx Proxy Manager): the same, with `RESTOCK_TRUST_PROXY=true`. The proxy must set `X-Forwarded-For` and `X-Forwarded-Proto`. Serve it at the root of its own hostname (like `restock.example.com`, not `example.com/restock`).

Whatever you use, **don't forward port 8787 on your router**. Away access should go through Tailscale or https.

## Backups

Everything is in the `restock-data` volume. To back it up to a file in the current folder:

```sh
docker run --rm -v restock-data:/data:ro -v "$PWD":/backup alpine tar czf /backup/restock-data.tgz -C /data .
```

To put a backup back (stop the server first):

```sh
docker stop restock-server
docker run --rm -v restock-data:/data -v "$PWD":/backup alpine sh -c "rm -rf /data/* && tar xzf /backup/restock-data.tgz -C /data && chown -R 1000:1000 /data"
docker start restock-server
```

The files in it are sealed, so a backup doesn't give away your lists. It does hold a hash of your passphrase's key, which someone could try to guess offline, so keep backups private (and use a good passphrase). Your phones have their own full copy of everything anyway.

## Forgot your passphrase?

Reset it:

```sh
docker exec restock-server touch /data/reset-passphrase
docker restart restock-server
```

Then open the web page, log in with **admin** and your `RESTOCK_PASSWORD` again, and choose a new passphrase.

**What's lost:** the web page's saved keys and every browser sign-in. **What's kept:** your phones (they stay connected and keep syncing) and every file. After setting the new passphrase, do [Link with a phone](#3-link-the-web-page-with-a-phone) again.

## Recovering deleted files

Phones move older prices and receipt photos to the server and then delete their own copy, so the server's `archive/` and `photos/` files may be the only ones. They're never simply deleted: when a phone deletes one (or another phone replaces it with something different), the old copy goes to `trash/<when>/` in the data volume, with the same name it had under `files/`, for 30 days. The trash is emptied of anything older once a day and when the server starts. It counts towards `RESTOCK_MAX_TOTAL_MB`, and phones and the web page never see it. The **Activity** page lists each `trashed` file and where it went.

To put one back, stop the server, move it back under `files/`, and start it again:

```sh
docker stop restock-server
docker run --rm -v restock-data:/data alpine sh -c "ls -R /data/trash"
docker run --rm -v restock-data:/data alpine sh -c "mkdir -p /data/files/photos && mv /data/trash/2026-11-09T22-56-00.123Z/photos/<sha256>.bin /data/files/photos/ && chown -R 1000:1000 /data/files"
docker start restock-server
```

(Use the folder and name `ls` showed; an archive goes back to `/data/files/archive/<phone>/`.) The phones see it again at their next sync.

Who can delete what: a phone only its own `archive/<phone>/` files, and a photo only if it's the phone that put it on the server (another phone may use the same photo: when it asks, the photo stays). The web page can't delete either.

## Updating

```sh
docker pull ghcr.io/d-plenty/restock-server:latest
docker rm -f restock-server
```

Then run the same `docker run` command as before. Your data stays in the volume.

With Compose: `docker compose pull && docker compose up -d`. In Dockge: *Update*. In Portainer: open the stack, then *Pull and redeploy*. On TrueNAS: *Apps*, select it, then *Update* (or *Edit → Save* to pull again).

Each version is also tagged by number (for example `ghcr.io/d-plenty/restock-server:0.9.2`) if you'd rather choose when to update.

## What the server can and can't see

**It can see:** file names, sizes and times; each phone's name and when it last connected; the web user name; the activity log (which phone or browser uploaded or fetched which file and when, sign-ins, with the last part of addresses hidden); and how much space it's using.

**It can't see:** your lists, pantry, prices, receipts, photos, loyalty cards, the household key, the web page's keys or your passphrase. A full copy of the server's data reveals nothing more than the list above.

One thing to know: the server also serves the web app to your browser. Someone who controlled your server could change that web app, so run the server yourself, from this image, on a machine you trust.

## Settings

| Variable | Default | What it does |
| --- | --- | --- |
| `RESTOCK_PASSWORD` | `admin` | The first-login password. Only works until a passphrase is set. While it's `admin`, `change-me-now` or a few others anyone would try, only from your home network or Tailscale |
| `RESTOCK_USER` | `admin` | The user name. It's fixed when you set the passphrase |
| `RESTOCK_HOME_URL` | the address you open the web page with | The address phones use at home (goes in the phones' QR code) |
| `RESTOCK_AWAY_URL` | none | The address away from home: `https://`, or a Tailscale `100.x` address |
| `RESTOCK_TRUST_PROXY` | off | `cloudflare` behind Cloudflare Tunnel; `true` behind your own reverse proxy |
| `RESTOCK_MAX_FILE_MB` | `32` | The biggest single file the server takes |
| `RESTOCK_MAX_TOTAL_MB` | `2048` | The most the server keeps in all |
| `PORT` | `8787` | The port inside the container |
| `RESTOCK_QUIET` | off | `true` to hide error details in the logs |

## What's in the data volume

```
/data
├── state.json          the web user (salt and scrypt hash of the auth key), the locked vault,
│                       the web page's public key, each phone's name and public key, browser
│                       sign-ins (hashes only), who last wrote each file, a random secret
├── activity.jsonl      the activity log (no contents, no secrets)
├── files/              the sealed files
│   ├── restock-sync-<phone>.bin        each phone's (and the web page's) changes
│   ├── restock-sync-keys-<id>.json     a new household key after a phone is removed, sealed per phone
│   ├── archive/<phone>/<yyyy-mm>.bin   older prices and receipts a phone moved off itself
│   ├── photos/<sha256>.bin             receipt and product photos
│   └── webkeys/<webId>.bin             the current key, sealed to the web page's key
├── trash/<when>/       deleted or replaced archive/ and photos/ files, kept 30 days
├── tmp/                half-written uploads (cleared at start)
└── reset-passphrase    only if you create it (see above)
```

Writes are atomic: a crash leaves the old file or the new one, never half of each.

## For developers

The protocol is in the Restock repo: [docs/server-protocol.md](https://github.com/d-plenty/Restock/blob/main/docs/server-protocol.md). In short:

| Method and path | Who |
| --- | --- |
| `GET /api/v2/health` | anyone: `{ ok, app, version, api: 2 }` |
| `GET /api/v2/login/salt?user=`, `POST /api/v2/login`, `POST /api/v2/logout` (`{ everywhere: true }` signs out everywhere) | anyone / session |
| `POST /api/v2/passphrase`, `GET`/`PUT /api/v2/vault`, `GET`/`PUT /api/v2/web` | session (`GET /api/v2/web` also phones) |
| `POST /api/v2/invites`, `GET /api/v2/devices`, `DELETE /api/v2/devices/<id>` | session (delete: also the phone itself) |
| `POST /api/v2/devices` | invite holder |
| `POST /api/v2/link`, `GET /api/v2/link/<id>` | passphrase session |
| `POST /api/v2/qrlogin`, `GET /api/v2/qrlogin/<id>` | anyone (2 minutes; only the browser that asked can collect) |
| `POST /api/v2/link/<id>`, `POST /api/v2/qrlogin/<id>` | phone (signed) |
| `GET /api/v2/files`, `GET`/`PUT`/`DELETE /api/v2/files/<name>` | phone (signed) or session |
| `GET /api/v2/activity` | session |

Errors are `{ "error": "<code>", "message": "<something to show people>" }` with codes such as `auth`, `clock` (401, with `X-Restock-Time`), `replay`, `removed`, `signed-out`, `mustChange`, `passphrase`, `forbidden`, `name`, `sealed`, `too-big`, `full`, `invite`, `used`, `expired`, `locked`, `rate`.

Limits: 10 wrong logins (or made-up invites) from one address lock it out for 15 minutes; 1,200 requests a minute per address; 10 sign-in codes per 10 minutes per address; sessions end after 30 days unused.

Run it and test it (Node 22, no npm packages needed):

```sh
npm test                              # all the server tests
DATA_DIR=./data npm start             # http://localhost:8787
node test/e2e-server.mjs              # a throwaway server on a temp folder; prints its URL and port
node test/e2e-server.mjs --ready      # ...with a passphrase set, a session cookie and a phone invite
```

`test/client.mjs` has a browser (with cookies) and a phone (signing its requests) for tests against a real server.

Build the image yourself: `docker build -t restock-server .` fetches Restock at the tag in the [Dockerfile](Dockerfile) (`RESTOCK_REF`) and builds the web app. To build without fetching, run `npm run build:server-web` in a Restock checkout, copy its `server/public/app/` here as `public/app/`, and run `docker build --build-arg WEB=local -t restock-server .`. Without a web app, the server still syncs phones and shows a short "web app not built" page.

Releases: bump `version` in `package.json`, then publish a GitHub release tagged `v<version>`. [The image workflow](.github/workflows/image.yml) builds for amd64 and arm64 and pushes `ghcr.io/d-plenty/restock-server:<version>` and `:latest`.

## Licence

GPL-3.0, like Restock. See [LICENSE](LICENSE).
