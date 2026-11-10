# Restock server

Your household's own server for [Restock](https://github.com/d-plenty/Restock), the local-first grocery, bottle shop and pharmacy price tracker. Phones sync through it at home and away, it keeps your price history, runs the shopping list with Home Assistant all the time, and gives you Restock in a browser. Phones never need it to work: everything works on a phone with no signal or with the server off.

Needs Restock 0.9.4 or newer on the phones.

## Set it up

1. In the app's **Configuration** tab, set **password** to something only you know, then **Save**. It's only used until you choose a passphrase on the web page.
2. **Start** the app, then **Open web UI** (or go to `http://<your Home Assistant's address>:8787`).
3. Log in with `admin` and that password, choose a passphrase, then **Set up this server** with your house's name.
4. Sign in, open **Server and phones → Add a phone**, and on each phone: Restock → **Settings → Sync and backups → Your server → Connect**, and scan the code.

The first login with the starting password only works from your home network or Tailscale.

Already used this app with Restock 0.9.3? It keeps your household as it was until you hand it over: on the web page open **Server and phones → Take this household** and scan the code with the household's owner phone (Restock 0.9.4).

## Home Assistant's shopping list

On the server's web page, open **Home Assistant**: use the address `http://homeassistant:8123` (Home Assistant itself, as this app sees it), paste a long-lived access token (your Home Assistant profile → Security), **Test connection**, pick the to-do list and turn it on. Every phone and browser on the server then shares that one list. The token stays on the server and is never shown again.

## Options

- **password**: the starting password (until you set a passphrase on the web page).
- **user**: the user name, `admin` unless you set it.
- **home_url**: the address phones use at home, e.g. `http://192.168.1.10:8787`. Leave it out to use the address you open the web page with.
- **away_url**: the address away from home: `https://…` (for example through a Cloudflare Tunnel) or a Tailscale `100.x` address.
- **trust_proxy**: `cloudflare` behind a Cloudflare Tunnel, `true` behind your own https reverse proxy.

"Keep data for" (3, 6, 9 or 12 months, or until you delete it) is on the server's web page, under Settings.

## Backups and privacy

The server's data lives in this app's folder, so Home Assistant backups include it. The server can read what phones share with it (to merge it, keep history and run Home Assistant), and so can anyone with a copy of that data: keep your Home Assistant backups private (Home Assistant can encrypt them). The server's web page can also download its own encrypted backup.

## Need Docker instead?

The same server runs anywhere with one `docker run` command: see the [README](https://github.com/d-plenty/restock-server).
