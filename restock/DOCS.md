# Restock server

Your household's own server for [Restock](https://github.com/d-plenty/Restock), the local-first price tracker for Australian supermarkets, bottle shops and chemists. Phones sync through it at home and away. It runs the shopping list with Home Assistant all the time, shows your spending and price history in its Data tab, and gives you Restock in a browser and on iPhone.

The server is optional: everything works on a phone with no signal or with the server off.

Works with Restock 0.9.4 and 0.9.5 on the phones.

## Set it up

1. In the app's **Configuration** tab, set **password** to something only you know, then **Save**. It's only used until you choose a passphrase on the web page.
2. **Start** the app, then **Open web UI** (or go to `http://<your Home Assistant's address>:8787`).
3. Log in with `admin` and that password, choose a passphrase, then **Set up this server** with your house's name.
4. Sign in, open **Server and phones → Add a phone**, and on each phone: Restock → **Settings → Sync and backups → Join your server**, and scan the code.

The first login with the starting password only works from your home network or Tailscale.

Already used this app with Restock 0.9.3? It keeps your household as it was until you hand it over: on the web page open **Server and phones → Take this household** and scan the code with the household's owner phone (Restock 0.9.4 or newer).

## Updating from 0.9.4

Update the app, then your phones. Nothing to scan. Your **Keep data for** setting carries on as **Auto delete** (in Data → Manage data). Phones still on 0.9.4 keep syncing, but don't show the new General list until they update.

## Home Assistant's shopping list

On the server's web page, open **Home Assistant**: use the address `http://homeassistant:8123` (Home Assistant itself, as this app sees it), paste a long-lived access token (your Home Assistant profile → Security), **Test connection**, pick the to-do list and turn it on. Every phone and browser on the server then shares that one list. A voice add that matches nothing you track goes on the General list. The token stays on the server and is never shown again.

## Restock on iPhone

Put the server's web page on an iPhone's home screen: open its **https** address in Safari, tap Share, then **Add to Home Screen**. The Shopping list then works with no signal. It needs https (iPhones only keep a web app for offline on https), so give the server an https address first: a Cloudflare Tunnel hostname pointing at `http://<Home Assistant's address>:8787` (set **away_url** to it and **trust_proxy** to `cloudflare`), or Tailscale's https. The steps are on the sign-in page, under **On iPhone?**.

## Options

- **password**: the starting password (until you set a passphrase on the web page).
- **user**: the user name, `admin` unless you set it.
- **home_url**: the address phones use at home, e.g. `http://192.168.1.10:8787`. Leave it out to use the address you open the web page with.
- **away_url**: the address away from home: `https://…` (for example through a Cloudflare Tunnel) or a Tailscale `100.x` address.
- **trust_proxy**: `cloudflare` behind a Cloudflare Tunnel, `true` behind your own https reverse proxy.

The time zone is Home Assistant's own (Settings → System → General). The Data tab's months and days, and Auto delete at 3 am, use it.

These are on the server's web page instead:

- **Auto delete** (Data → Manage data): off on a new server, or after 3, 6, 9 or 12 months, or any number of months up to 120. Turning it on or shortening it asks you to type DELETE and your passphrase.
- **Let the web page search the shops** (Settings): off unless you turn it on. The server then asks the shops only when someone presses Search on the web page. Some shops, Coles most of all, may block a server. To see which shops answer, run this on any computer at home with Docker: `docker run --rm ghcr.io/d-plenty/restock-server:latest node scripts/try-search.mjs`.

## Backups and privacy

The server's data lives in this app's folder, so Home Assistant backups include it. The server can read what phones share with it (to merge it, keep history and run Home Assistant), and so can anyone with a copy of that data: keep your Home Assistant backups private (Home Assistant can encrypt them). The server's web page can also download its own encrypted backup, and the Data tab can download your data as a spreadsheet, CSV files or a full export file. Keep those private too.

## Problems?

Server problems go in [restock-server's issues](https://github.com/d-plenty/restock-server/issues/new/choose); the app's **Log** tab usually shows why it won't start. Problems with the app on your phone go in [Restock's issues](https://github.com/d-plenty/Restock/issues/new/choose).

## Need Docker instead?

The same server runs anywhere with one `docker run` command: see the [README](https://github.com/d-plenty/restock-server).
