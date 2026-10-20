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
