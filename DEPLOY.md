# Moox Proxy (Scramjet): run it and put it online

Moox Proxy now runs on [Scramjet](https://github.com/MercuryWorkshop/scramjet). Pages are rewritten in your browser by a service worker, and traffic travels over a Wisp websocket (`/wisp/`) to this server. Because of that, **it must be served over HTTPS** (or from `localhost`) or the service worker won't register.

## Run it locally

    npm install
    PROXY_PASSWORD=yourpassword npm start

Open http://localhost:8080.

## Option A: Render (easiest, free)

1. Push this repo to GitHub.
2. On render.com choose New > Web Service and connect the repo.
3. Settings: Runtime = Node, Build command = `npm install`, Start command = `npm start`, Instance type = Free. (Or choose Docker and let it use the Dockerfile.)
4. Under Environment, add `PROXY_PASSWORD` with a password only you know.
5. Deploy. Render gives you an `https://` address.

Free Render services sleep when idle, so the first visit after a while takes about 30-60 seconds. WebSockets are supported.

## Option B: Google Cloud Run

    gcloud run deploy moox-proxy --source . --region australia-southeast1 --allow-unauthenticated --set-env-vars PROXY_PASSWORD=yourpassword --session-affinity

## Use it from Chrome's address bar

Open `chrome://settings/searchEngines`, click Add under Site search, and fill in:

- Name: Moox Proxy
- Shortcut: p
- URL: `https://YOUR-ADDRESS/?url=%s`

Type `p`, press Tab, enter a site (or a search) and press Enter. Chrome asks for the password the first time.

## Notes

- Always set `PROXY_PASSWORD`. A public, password-less proxy gets abused and hosts will suspend it. The password protects both the site and the `/wisp/` endpoint.
- The Wisp server refuses connections to localhost and private network addresses.
- Many free hosts forbid open proxies in their terms. A password-protected personal one is much less likely to be flagged.
- Scramjet is licensed AGPL-3.0, so if you run a modified copy as a public service, keep the source available (this repo being public on GitHub covers that).
- Check this proxy against your school's or workplace's acceptable-use rules before relying on it.

## What's in it

- **Tabs** (up to 12), with a friendly error page and a quiet auto-retry when the proxy is still warming up.
- **Favorites** with site icons: drag to reorder, rename with the pencil, Ctrl-click or middle-click for a new tab.
- **Search suggestions** from your favorites, your history and DuckDuckGo/Google (can be turned off in Settings).
- **Menu (the three-bar button):** History, Settings (theme, accent, wallpapers, clock, search engine, text size, high contrast, easy-to-read font, reduce motion, page zoom) and More (backup, shortcuts, log out).
- **Install as an app:** in Chrome, use the install icon in the address bar.
- **Shortcuts** (when you're not typing): `/` address bar, `M` menu, `T` new tab, `W` close tab, `[` `]` switch tab, `H` close page, `Esc` close menu.

Favorites, history and settings are stored in your browser. Use Menu > More > Export my data to keep a copy.

## Accounts, daily limit, unlock codes and the admin page

Moox can run with accounts. It switches on automatically when these settings exist on Render (Service > Environment):

| Name | Value |
| --- | --- |
| `TURSO_DATABASE_URL` | the `libsql://...` address of your free Turso database |
| `TURSO_AUTH_TOKEN` | the token for that database |
| `ADMIN_PASSWORD` | a password only you know, 10+ characters (opens `/admin`) |
| `SIGNUP_MODE` | optional: `open` (default), `code` or `closed`. Also changeable in the admin page |
| `FREE_MINUTES` | optional: free minutes per day (default 60) |
| `FREE_MB`, `GUEST_MB`, `PREMIUM_MB`, `MONTH_MB` | optional: data caps per account per day (defaults 300 / 100 / 2000) and one monthly budget for everyone (default 4000; 0 = off). Also editable in /admin. |
| `GUEST_MINUTES` | optional: minutes per day for guests (default 30) |
| `GUEST_PER_IP` | optional: guest sessions allowed per IP address per day (default 10) |

Without the two Turso settings the site keeps using the single `PROXY_PASSWORD` login. With them, `PROXY_PASSWORD` is no longer used.

**How it works**
- Anyone can sign up (unless you change that). Free accounts get 60 minutes a day of active browsing. It resets at midnight Sydney time. Time only counts while data is actually moving, not while a page sits idle.
- An unlock code makes one account unlimited. Each code works once, ever, on one account only.
- Favorites, history, notes and settings are saved to the account and follow you between devices.
- **Guests** can press "Continue as guest" for 30 minutes a day with nothing saved. When it runs out they see Log in / Sign up. Guests are limited to a few sessions per IP address per day, and you can switch guest access off in the admin page under Controls. On a shared school network, many students share one IP address, so lower or raise `GUEST_PER_IP` to suit.
- There is no password reset (no email). You can set a new password for someone in the admin page.

**Making a Turso database**
1. turso.tech > sign up (a GitHub login works) > Create Database, name it `moox`, pick Singapore or Sydney.
2. Open the database: copy its URL (`libsql://...`) and use Generate Token to make a token. Keep both private.

**The admin page** is `https://YOUR-ADDRESS/admin`.
- Overview: people online, sign-ups, failed logins, alerts.
- Live: every connection with its account and IP address; Terminate or Block IP.
- Users: suspend, log out everywhere, delete, give or remove unlimited time, reset today's time, set a password.
- Codes: generate codes (unlimited forever, or for 7/30/90/365 days), copy them, see who used each, cancel unused ones.
- Security: wrong passwords, bot sign-ups, accounts used from many places, tunnel tries without login, and everything you do as admin.
- Controls: lockdown (cuts everyone off), close all connections, a message banner shown to everyone, sign-ups open / code only / closed, blocked IP list, and a Download backup button.
- Codes also have **Copy invite link**: a link that opens the sign-up page with the code already filled in.
- In the app's Account tab people can log out their other devices or delete their own account.

**Limits to know about**
- The admin page shows what this server can see. It cannot tell if your Render or GitHub account itself is broken into, so use strong passwords and two-step login on those.
- IP addresses come from Render's headers. A determined person can use many IPs, so IP blocks slow people down rather than stop them.
- Anyone can still make many free accounts. If that happens, set sign-ups to "code only" in Controls.
- The free Render plan sleeps when idle; use the UptimeRobot step below.

## Keeping it awake

Add a monitor at uptimerobot.com for `https://YOUR-ADDRESS/health` every 5 minutes. That page needs no login.

## Home page, tools and looks

- The home page has a greeting, quick links, and tools: calculator, weather (asked from the server, cached for 10 minutes), timer/stopwatch and notes (synced to your account).
- The version number at the bottom comes from `package.json`. Tap it to see what's new, which reads `public/changelog.json`. When you change something, add an entry at the top of that file and raise `version` in `package.json`.
- Settings has animated backgrounds (flowing gradient, aurora, stars, snow, bubbles, fireflies), a custom accent colour, your own wallpaper picture, fonts, corner and tile styles, and a "Reduce motion" switch that freezes the animation.
- On phones the menu is a bottom sheet, buttons are bigger, and "Edit favorites" shows rename, remove and move buttons. If Moox is opened inside the Google app or another in-app browser, a banner tells people to open it in Safari or Chrome.


## Apps page, charts and palette (v2.3.0)

- **Apps & games**: a launcher on the home page. The list lives in the database (seeded from `public/apps-default.json` the first time). Manage it in **/admin > Apps** (add, edit, delete, bulk import `Name | URL | Category`, restore defaults).
- **Admin > Charts**: daily users, hours browsed, sign-ups vs guests, busiest hours (last 24h). Busy-hours history starts when 2.3.0 goes live.
- **Ctrl+K** command palette, recent-sites row, and "Reopen last session" on the home page.
- A "time left" badge shows remaining minutes; reading a page counts as active for 45 seconds.
