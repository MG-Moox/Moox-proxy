// Simple web proxy: open http://localhost:8080, type a URL, browse through it.
// Zero dependencies. Requires Node 18+.
//
// Env vars:
//   PORT            port to listen on (default 8080)
//   PROXY_PASSWORD  if set, require HTTP basic auth (any username) - strongly
//                   recommended if you expose this to the internet
const http = require('http');
const https = require('https');
const dns = require('dns').promises;
const net = require('net');

const PORT = process.env.PORT || 8080;
const PASSWORD = process.env.PROXY_PASSWORD || '';
const MAX_REDIRECTS = 5;
const TIMEOUT_MS = 20000;

// ---------- SSRF protection: never let the proxy reach private networks ----------
function isPrivateIP(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 0 || a === 10 || a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      a >= 224
    );
  }
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase();
    if (l === '::1' || l === '::') return true;
    if (l.startsWith('fe80') || l.startsWith('fc') || l.startsWith('fd')) return true;
    const m = l.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (m) return isPrivateIP(m[1]);
  }
  return false;
}

// Custom lookup so the IP we check is the IP we connect to (stops DNS rebinding).
function safeLookup(hostname, opts, cb) {
  dns.lookup(hostname, { all: true }).then(
    (addrs) => {
      const ok = addrs.filter((a) => !isPrivateIP(a.address));
      if (!ok.length) return cb(new Error('Blocked: private or internal address'));
      if (opts && opts.all) return cb(null, ok);
      cb(null, ok[0].address, ok[0].family);
    },
    (err) => cb(err)
  );
}

// ---------- helpers ----------
const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const proxify = (u) => '/?url=' + encodeURIComponent(u);

function rewriteUrl(raw, base) {
  const v = raw.trim();
  if (!v || /^(#|data:|javascript:|mailto:|tel:|blob:|about:)/i.test(v)) return raw;
  try {
    const abs = new URL(v, base);
    // Search result links are wrapped by DuckDuckGo; unwrap them to the real page.
    if (/(^|\.)duckduckgo\.com$/.test(abs.hostname) && abs.pathname.startsWith('/l/') && abs.searchParams.get('uddg')) {
      return proxify(abs.searchParams.get('uddg'));
    }
    return proxify(abs.href);
  } catch {
    return raw;
  }
}

function rewriteHTML(html, base) {
  html = html.replace(/(\s(?:href|src|action|poster|data-src)\s*=\s*)(["'])(.*?)\2/gi, (m, pre, q, val) => `${pre}${q}${rewriteUrl(val, base)}${q}`);
  html = html.replace(/(\ssrcset\s*=\s*)(["'])(.*?)\2/gi, (m, pre, q, val) => {
    const out = val.split(',').map((part) => {
      const [u, ...rest] = part.trim().split(/\s+/);
      return [rewriteUrl(u, base), ...rest].join(' ');
    });
    return `${pre}${q}${out.join(', ')}${q}`;
  });
  html = html.replace(/(<meta[^>]+http-equiv=["']?refresh["']?[^>]*content=["']\d+;\s*url=)([^"']+)/gi, (m, pre, u) => pre + rewriteUrl(u, base));
  html = html.replace(/<(link|script)([^>]*)\sintegrity=(["']).*?\3/gi, '<$1$2'); // SRI breaks after rewriting
  return html;
}

function rewriteCSS(css, base) {
  return css.replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, (m, q, u) => `url(${q}${rewriteUrl(u, base)}${q})`);
}

const homePage = (msg = '') => `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Web Proxy</title>
<style>
  body{font-family:system-ui,sans-serif;max-width:560px;margin:15vh auto;padding:0 1rem;text-align:center}
  form{display:flex;gap:.5rem}
  input{flex:1;padding:.7rem;font-size:1rem;border:1px solid #888;border-radius:6px}
  button{padding:.7rem 1.2rem;font-size:1rem;border:0;border-radius:6px;background:#2563eb;color:#fff;cursor:pointer}
  .err{color:#b91c1c;margin-top:1rem}
</style>
<h1>Web Proxy</h1>
<form action="/" method="get"><input name="url" placeholder="Search or enter a website" autofocus required><button>Go</button></form>
${msg ? `<p class="err">${esc(msg)}</p>` : ''}`;

function authorized(req) {
  if (!PASSWORD) return true;
  const h = req.headers.authorization || '';
  if (!h.startsWith('Basic ')) return false;
  const pass = Buffer.from(h.slice(6), 'base64').toString().split(':').slice(1).join(':');
  return pass === PASSWORD;
}

// ---------- core: fetch upstream, following redirects ourselves ----------
function fetchUpstream(target, req, body, redirects, cb) {
  // Node skips the custom lookup for IP literals, so check those (and localhost) here.
  const host = target.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost') || (net.isIP(host) && isPrivateIP(host))) {
    return cb(new Error('Blocked: private or internal address'));
  }
  const lib = target.protocol === 'https:' ? https : http;
  const headers = {
    'user-agent': req.headers['user-agent'] || 'Mozilla/5.0',
    accept: req.headers.accept || '*/*',
    'accept-language': req.headers['accept-language'] || 'en',
    'accept-encoding': 'identity', // keep bodies readable so we can rewrite them
  };
  if (req.headers['content-type']) headers['content-type'] = req.headers['content-type'];
  if (body && body.length) headers['content-length'] = body.length;
  if (req.headers.range) headers.range = req.headers.range;

  const up = lib.request(target, { method: req.method, headers, lookup: safeLookup, timeout: TIMEOUT_MS }, (res) => {
    const loc = res.headers.location;
    if (res.statusCode >= 300 && res.statusCode < 400 && loc && redirects < MAX_REDIRECTS) {
      res.resume();
      const next = new URL(loc, target);
      const keep = res.statusCode === 307 || res.statusCode === 308;
      const nreq = keep ? req : { ...req, method: 'GET', headers: { ...req.headers, 'content-type': undefined } };
      return fetchUpstream(next, nreq, keep ? body : null, redirects + 1, cb);
    }
    cb(null, res, target);
  });
  up.on('timeout', () => up.destroy(new Error('Upstream timed out')));
  up.on('error', (e) => cb(e));
  if (body && body.length) up.write(body);
  up.end();
}

// ---------- server ----------
http.createServer((req, res) => {
  // Health check for uptime pings; deliberately needs no password and reveals nothing.
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    return res.end('ok');
  }

  if (!authorized(req)) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="proxy"' });
    return res.end('Authentication required');
  }

  const reqUrl = new URL(req.url, 'http://localhost');
  let raw = reqUrl.searchParams.get('url');

  if (!raw) {
    // Relative request that escaped rewriting (e.g. from JS): use the Referer's target.
    try {
      const ref = new URL(req.headers.referer || '');
      const base = ref.searchParams.get('url');
      if (base && reqUrl.pathname !== '/') {
        res.writeHead(302, { Location: rewriteUrl(reqUrl.pathname + reqUrl.search, base) });
        return res.end();
      }
    } catch {}
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(homePage());
  }

  raw = raw.trim();
  if (!/^https?:\/\//i.test(raw)) {
    // Looks like a website (no spaces, has a dot) -> open it; otherwise treat it as a search.
    const looksLikeSite = !/\s/.test(raw) && raw.includes('.');
    raw = looksLikeSite ? 'https://' + raw : 'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(raw);
  }
  let target;
  try {
    target = new URL(raw);
    if (!/^https?:$/.test(target.protocol)) throw new Error();
  } catch {
    res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(homePage('Invalid URL'));
  }

  // Forms using GET lose their fields when the action is rewritten; merge any extra params back.
  for (const [k, v] of reqUrl.searchParams) if (k !== 'url' && req.method === 'GET') target.searchParams.set(k, v);

  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    fetchUpstream(target, req, body, 0, (err, up, finalUrl) => {
      if (err) {
        res.writeHead(502, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(homePage('Could not fetch that page: ' + err.message));
      }
      const out = { ...up.headers };
      for (const h of ['content-security-policy', 'content-security-policy-report-only', 'x-frame-options', 'strict-transport-security', 'content-encoding', 'set-cookie', 'location']) delete out[h];

      const type = (up.headers['content-type'] || '').toLowerCase();
      const isHTML = type.includes('text/html');
      const isCSS = type.includes('text/css');

      if (!isHTML && !isCSS) {
        res.writeHead(up.statusCode, out);
        return up.pipe(res);
      }

      delete out['content-length'];
      const parts = [];
      up.on('data', (c) => parts.push(c));
      up.on('end', () => {
        const text = Buffer.concat(parts).toString('utf8');
        const rewritten = isHTML ? rewriteHTML(text, finalUrl.href) : rewriteCSS(text, finalUrl.href);
        out['content-type'] = isHTML ? 'text/html; charset=utf-8' : 'text/css; charset=utf-8';
        res.writeHead(up.statusCode, out);
        res.end(rewritten);
      });
    });
  });
}).listen(PORT, () => console.log(`Web proxy running at http://localhost:${PORT}`));
