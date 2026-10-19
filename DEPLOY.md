# Put the proxy online (so you can use it from Chrome's address bar)

You end up with a normal web address like `https://my-proxy.onrender.com`.

## Option A: Render (easiest, free)

1. Create a free GitHub account and a new repository. Upload `server.js`, `package.json` and `Dockerfile` to it.
2. Create a free account at render.com and choose New > Web Service, then connect that repository.
3. Settings: Runtime = Node, Build command = (leave blank), Start command = `node server.js`, Instance type = Free.
4. Under Environment, add `PROXY_PASSWORD` with a password only you know.
5. Deploy. Render shows your address at the top of the page.

Free Render services sleep when idle, so the first visit after a while takes about 30-60 seconds.

## Option B: Google Cloud Run (free tier, needs a card on file)

1. Install the gcloud CLI and run `gcloud auth login`.
2. In the folder with the three files, run:

   gcloud run deploy web-proxy --source . --region australia-southeast1 --allow-unauthenticated --set-env-vars PROXY_PASSWORD=yourpassword

3. It prints your address when it finishes.

## Use it from Chrome's address bar

Open `chrome://settings/searchEngines`, click Add under Site search, and fill in:

- Name: My Proxy
- Shortcut: p
- URL: `https://YOUR-ADDRESS/?url=%s`

Now type `p`, press Tab, enter a site such as `wikipedia.org` and press Enter. It opens through your proxy. Chrome will ask for the password the first time.

## Please read

- Always set `PROXY_PASSWORD`. A public proxy with no password gets found and abused within days, and hosts will suspend it.
- Many free hosts forbid open proxies in their terms. A password-protected personal one is much less likely to be flagged.
- Free tiers have monthly limits, so it is not truly unlimited.
