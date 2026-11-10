# Restock server

Your own sync server for [Restock](https://github.com/d-plenty/Restock), the local-first grocery, bottle shop and pharmacy price tracker. It's end-to-end encrypted: it only keeps sealed files and never has your household's key.

## Set it up

1. In the app's **Configuration** tab, set **password** to something only you know, then **Save**. It's only used until you choose a passphrase on the web page.
2. **Start** the app, then **Open web UI** (or go to `http://<your Home Assistant's address>:8787`).
3. Log in with `admin` and that password, and choose a passphrase.
4. On each phone: Restock → **Settings → Sync and backups → Restock server → Connect**, and scan the code from the web page's **Add a phone**.

The first login with the starting password only works from your home network or Tailscale.

## Options

- **password**: the starting password (until you set a passphrase on the web page).
- **user**: the user name, `admin` unless you set it.
- **home_url**: the address phones use at home, e.g. `http://192.168.1.10:8787`. Leave it out to use the address you open the web page with.
- **away_url**: the address away from home: `https://…` (for example through a Cloudflare Tunnel) or a Tailscale `100.x` address.
- **trust_proxy**: `cloudflare` behind a Cloudflare Tunnel, `true` behind your own https reverse proxy.

## Backups

The server's files live in this app's data, so Home Assistant backups include them. Everything in them is sealed.

## Need Docker instead?

The same server runs anywhere with one `docker run` command: see the [README](https://github.com/d-plenty/restock-server).
