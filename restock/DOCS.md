# Restock server

Your household's own server for [Restock](https://github.com/d-plenty/Restock), the local-first price tracker for Australian supermarkets, bottle shops and chemists. Phones and tablets (Android, iPhone and iPad) sync through it at home and away. It runs the shopping list with Home Assistant all the time, keeps your price history and spending, and can keep each phone's backup.

The server is optional: everything works on a phone with no signal or with the server off.

Works with Restock 0.14.0 to 0.19.0 on the phones. A phone on an older version is asked to update first; it keeps everything it has.

## Set it up

1. In the app's **Configuration** tab, set **password** to something only you know, then **Save**. It's only used until you choose a passphrase on the web page.
2. **Start** the app, then **Open web UI** (or go to `http://<your Home Assistant's address>:8787`).
3. Log in with `admin` and that password, choose a passphrase, then **Set up this server** with your house's name.
4. Sign in, open **Phones and admins → Add a phone or tablet**, and on each phone: **Join a home server** on Restock's first screen, or **Settings → Sync → Join your server** on one already set up. Scan the code.

The first login with the starting password only works from your home network or Tailscale.

## The web page

The web page looks after the server; the shopping list, the pantry and the shops are on the phones. It has **Phones and admins** (add, rename, remove, make admin, each phone's backup, and Activity), **Data** (spending, price history, exports, deleting, and how long data is kept) and **Server settings** (Household, Addresses, Sign-in and security, Home Assistant, This browser, Updates and moving).

An **admin phone** can do the everyday parts too, in Restock: **Settings → Sync → Restock server → Server admin**. Once there's an admin phone, sensitive changes on the web page also need a yes on it.

## Updating

Update the app, then your phones. Nothing to scan, and everything stays.

## Home Assistant's shopping list

On the server's web page, open **Server settings → Home Assistant**: use the address `http://homeassistant:8123` (Home Assistant itself, as this app sees it), paste a long-lived access token (your Home Assistant profile → Security), **Test**, pick the to-do list and turn it on. Every phone on the server then shares that one list. A voice add that matches nothing you track goes on the General list. The token stays on the server and is never shown again.

## Away from home

Give phones an address that reaches port 8787 on Home Assistant: Tailscale, or a Cloudflare Tunnel hostname pointing at `http://<Home Assistant's address>:8787` (set **away_url** to it and **trust_proxy** to `cloudflare`). **Server settings → Addresses → Test both** checks that each address answers.

## Options

- **password**: the starting password (until you set a passphrase on the web page).
- **user**: the user name, `admin` unless you set it.
- **home_url**: the address phones use at home, e.g. `http://192.168.1.10:8787`. Leave it out to set it on the web page (Server settings → Addresses).
- **away_url**: the address away from home: `https://…` (for example through a Cloudflare Tunnel). Leave it out to set it on the web page.
- **trust_proxy**: `cloudflare` behind a Cloudflare Tunnel, `true` behind your own https reverse proxy.

The time zone is Home Assistant's own (Settings → System → General) unless you set one in Server settings → Household. Activity, the Data page's months and days, and the nightly tidy-up at about 3 am use it.

## Backups and privacy

The server's data lives in this app's folder, so Home Assistant backups include it. The server can read what phones share with it (to merge it, keep history and run Home Assistant), and so can anyone with a copy of that data: keep your Home Assistant backups private (Home Assistant can encrypt them). The web page can also download the server's own encrypted backup (**Data → Download a backup**), and Data can export your data as a spreadsheet, CSV files or a full export file. Keep those private too.

**Phone backups** (Phones and admins → Phone backups) are different: each phone's whole backup, sealed to a key that only your passphrase opens. The server keeps them but can't read them.

## Problems?

Server problems go in [restock-server's issues](https://github.com/d-plenty/restock-server/issues/new/choose); the app's **Log** tab usually shows why it won't start. Problems with the app on your phone go in [Restock's issues](https://github.com/d-plenty/Restock/issues/new/choose).

## Need Docker instead?

The same server runs anywhere with one `docker run` command: see the [README](https://github.com/d-plenty/restock-server), which has the full guide.
