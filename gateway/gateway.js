import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import { spawn } from "node:child_process"; // legacy (may remove if no direct spawns remain)
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import httpProxy from "http-proxy";
import { request } from "undici";
import * as acme from "acme-client";
import selfsigned from "selfsigned";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, "gateway.config.json"), "utf8"));

/* ------------------- App Manager / Admin Control Plane ------------------ */
import { createAppManagerFromFile } from './app-manager.mjs';
import { installAdminApi } from './admin-api.mjs';
import { installAdminWs } from './admin-ws.mjs';

const adminToken = process.env.GATEWAY_ADMIN_TOKEN || cfg.adminToken || '';
const manager = createAppManagerFromFile(path.join(__dirname, 'gateway.config.json'));
// Start all apps with start commands
for (const app of manager.listApps()) {
  if (app.start) {
    try { manager.start(app.host); } catch (e) { console.error('Start failed for', app.host, e); }
  }
}

// Diagnostic event logging
manager.on('app-start', e => console.log(`[app-start] ${e.host} pid=${e.pid}`));
manager.on('app-exit', e => console.log(`[app-exit] ${e.host} code=${e.code} signal=${e.signal}`));
manager.on('app-log', e => { if (e.stream === 'stderr') console.error(`[app-log][${e.host}][stderr] ${e.line.trim()}`); else console.log(`[app-log][${e.host}] ${e.line.trim()}`); });
manager.on('app-health', e => console.log(`[app-health] ${e.host} healthy=${e.healthy} status=${e.statusCode || 0}`));

// Host map must be defined before rebuildHostMap is first invoked
const hostMap = new Map(); // will be populated by rebuildHostMap()

// Rebuild hostMap whenever config changes
function rebuildHostMap() {
  hostMap.clear();
  for (const app of manager.listApps()) hostMap.set(app.host.toLowerCase(), app);
}
manager.on('app-added', rebuildHostMap);
manager.on('app-removed', rebuildHostMap);
manager.on('app-updated', rebuildHostMap);
rebuildHostMap();

/* ----------------------- Health wait (optional) -------------------------- */
async function waitHealthy(app, timeoutMs = 15000) {
  const start = Date.now();
  let firstAttempt = true;
  while (Date.now() - start < timeoutMs) {
    try {
      if (!app.healthUrl) return true;
      const res = await request(app.healthUrl, { method: "GET" });
      if (res.statusCode >= 200 && res.statusCode < 500) return true;
    } catch {}
    if (firstAttempt) {
      firstAttempt = false;
      console.log(`[health] waiting for ${app.host} -> ${app.healthUrl}`);
    }
    await new Promise(r => setTimeout(r, 500));
  }
  console.warn(`[health] timeout after ${timeoutMs}ms for ${app.host} (${app.healthUrl})`);
  return false;
}

/* ----------------------- ACME + certificate store ------------------------ */
const storeDir = path.resolve(__dirname, cfg.acme.configDir || "./storage");
fs.mkdirSync(storeDir, { recursive: true });

const challenges = new Map(); // token -> keyAuthorization

const client = new acme.Client({
  directoryUrl: cfg.acme.directoryUrl,
  accountKey: await acme.forge.createPrivateKey()
});

async function ensureCert(hostname) {
  const certPath = path.join(storeDir, `${hostname}.crt`);
  const keyPath  = path.join(storeDir, `${hostname}.key`);

  // Use existing if present & not expiring soon
  // NOTE: for local-like hostnames we prefer the combined certificate (local-gateway)
  // so skip per-host reuse for local domains to avoid installing per-host CNs.
  if (!isLocalDomainName(hostname) && fs.existsSync(certPath) && fs.existsSync(keyPath)) {
    try {
      const cert = tls.createSecureContext({
        key: fs.readFileSync(keyPath),
        cert: fs.readFileSync(certPath)
      }).context.getCertificate();
      // If valid for >10 days, reuse
      return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath), certPath, keyPath };
    } catch { /* fallthrough to renew */ }
  }

  // For local domains, use self-signed certificates
  if (hostname.includes('.local') || hostname.includes('local.') || hostname.includes('localhost') || hostname.includes('.console')) {
    console.log(`Using combined self-signed certificate for local domains (requested: ${hostname})`);
    // Use a single canonical cert for all local domains so we don't generate multiple files
    const combinedName = 'local-gateway';
    const combinedCertPath = path.join(storeDir, `${combinedName}.crt`);
    const combinedKeyPath = path.join(storeDir, `${combinedName}.key`);

    // If combined cert exists and valid, reuse it — but ensure it actually contains the requested hostname in its SANs
    if (fs.existsSync(combinedCertPath) && fs.existsSync(combinedKeyPath)) {
      try {
        const pem = fs.readFileSync(combinedCertPath, 'utf8');
        // Use X509Certificate to inspect SANs when available
        try {
          const { X509Certificate } = crypto;
          const x = new X509Certificate(pem);
          const sanRaw = x.subjectAltName || '';
          // diagnostic: log existing combined cert CN and SANs
          try {
            const sub = x.subject || '';
            // extract CN robustly up to comma/newline/slash
            const mm = String(sub).match(/CN=([^,\n\r\\/]+)/i);
            if (mm && mm[1]) console.log(`[cert] existing combined cert CN=${mm[1]} SANs=${sanRaw}`);
          } catch(e){}
            // Also ensure the Subject CN of the existing combined cert matches our expected combinedName
            const subjectRaw = x.subject || '';
            let certCN = null;
            try {
              const mcn = String(subjectRaw).match(/CN=([^,\n\r\\/]+)/i);
              if (mcn && mcn[1]) certCN = mcn[1];
            } catch (e) { /* ignore */ }
          const sans = [];
          const dnsRe = /DNS:([^,\s]+)/g;
          let m;
          while ((m = dnsRe.exec(sanRaw)) !== null) sans.push(m[1].toLowerCase());
          // match exact or wildcard SANs (e.g. *.local.console)
          const hostLower = hostname.toLowerCase();
          const sanMatchesHost = (list, host) => {
            for (const s of list) {
              if (!s) continue;
              const ss = s.toLowerCase();
              if (ss === host) return true;
              if (ss.startsWith('*.')) {
                const base = ss.slice(2);
                if (host === base) continue; // wildcard doesn't match the base itself
                if (host.endsWith('.' + base) || host === base) return true;
              }
            }
            return false;
          };
          if (sanMatchesHost(sans, hostLower) && certCN && certCN.toLowerCase() === combinedName.toLowerCase()) {
            return { key: fs.readFileSync(combinedKeyPath), cert: fs.readFileSync(combinedCertPath), certPath: combinedCertPath, keyPath: combinedKeyPath };
          }
          // If certificate CN doesn't match expected combinedName, fallthrough to regenerate
          if (sanMatchesHost(sans, hostLower) && certCN && certCN.toLowerCase() !== combinedName.toLowerCase()) {
            console.log(`[cert] existing combined cert CN (${certCN}) does not match expected (${combinedName}), regenerating`);
          }
          // If hostname not present, fallthrough to regenerate combined cert
        } catch (e) {
          // Unable to parse cert SANs — fallthrough and attempt regenerate
        }
      } catch (e) {
        // Read error — fallthrough and regenerate
      }
    }

    // Build SAN list from configured apps (include host and altNames) but only local-like domains
    const apps = manager.listApps();
    const localNames = new Set();
    // always include requested hostname
    localNames.add(hostname.toLowerCase());
    for (const a of apps) {
      if (!a || !a.host) continue;
      const h = String(a.host).toLowerCase();
      if (h.includes('.local') || h.includes('local.') || h.includes('localhost') || h.includes('.console')) localNames.add(h);
      if (Array.isArray(a.altNames)) {
        for (const alt of a.altNames) {
          const altS = String(alt).toLowerCase();
          if (altS.includes('.local') || altS.includes('local.') || altS.includes('localhost') || altS.includes('.console')) localNames.add(altS);
        }
      }
    }

    let names = Array.from(localNames.values()).map(s => s.toLowerCase());
    if (names.length === 0) names.push(hostname.toLowerCase());

    // Add wildcard SANs for each base domain (e.g. local.console -> *.local.console) so subdomains are covered
    const wildcardSet = new Set();
    for (const n of names) {
      const parts = n.split('.');
      if (parts.length >= 2 && !n.includes('localhost')) {
        const base = parts.slice(-2).join('.');
        if (base && base !== 'localhost') wildcardSet.add(`*.${base}`);
      }
    }
    // Merge wildcard names but avoid duplicates
    for (const w of wildcardSet) if (!names.includes(w)) names.push(w);

    // Generate a self-signed cert that includes all local names (and wildcard variants) as SANs
    // Use a stable Common Name that matches the combined cert filename so Windows store replace logic can find it
    const attrs = [
      { name: 'commonName', value: combinedName },
      { name: 'organizationName', value: 'Console' },
      { name: 'organizationalUnitName', value: 'KP' }
    ];
    const extensions = [{ name: 'subjectAltName', altNames: names.map(n => ({ type: 2, value: n })) }];
    const pems = selfsigned.generate(attrs, { days: 365, extensions });
    const cert = pems.cert;
    const key = pems.private;

  // Atomic write: write to .tmp then rename
  const tmpCert = combinedCertPath + '.tmp';
  const tmpKey = combinedKeyPath + '.tmp';
  fs.writeFileSync(tmpCert, cert);
  fs.writeFileSync(tmpKey, key);
  fs.renameSync(tmpCert, combinedCertPath);
  fs.renameSync(tmpKey, combinedKeyPath);
  console.log(`Combined local certificate saved: ${combinedCertPath}`);
  console.log(`Combined local key saved: ${combinedKeyPath}`);
  return { key, cert, certPath: combinedCertPath, keyPath: combinedKeyPath };
  }

  // HTTP-01 challenge handler uses `challenges` Map via the HTTP server
  try {
    const app = hostMap.get(hostname);
    const altNames = (app && Array.isArray(app.altNames) && app.altNames.length) ? app.altNames : [hostname];
    const [key, csr] = await Promise.all([
      acme.forge.createPrivateKey(),
      // Include altNames so CSR requests include SAN DNS entries
      acme.forge.createCsr({ commonName: hostname, altNames: altNames })
    ]);

    const cert = await client.auto({
      email: cfg.email,
      termsOfServiceAgreed: !!cfg.agreeToTerms,
      challengeCreateFn: async (authz, challenge, keyAuth) => {
        if (challenge.type === "http-01") {
          challenges.set(challenge.token, keyAuth);
        } else {
          throw new Error("Only http-01 is implemented in this sample.");
        }
      },
      challengeRemoveFn: async (authz, challenge) => {
        if (challenge.type === "http-01") {
          challenges.delete(challenge.token);
        }
      },
      csr,
      challengePriority: ["http-01"]
    });

  fs.writeFileSync(certPath, cert);
  fs.writeFileSync(keyPath, key);
  console.log(`Certificate saved: ${certPath}`);
  console.log(`Private key saved: ${keyPath}`);
  return { key, cert, certPath, keyPath };
  } catch (error) {
    console.error(`ACME failed for ${hostname}, falling back to self-signed:`, error.message);
  const r = selfSigned(hostname);
  return { ...r, certPath, keyPath };
  }
}

// Helper to detect local-like domains
function isLocalDomainName(d) {
  if (!d) return false;
  const s = String(d).toLowerCase();
  return s.includes('.local') || s.includes('local.') || s.includes('localhost') || s.includes('.console');
}

// When apps are added or started, proactively ensure the combined local cert is regenerated
manager.on('app-added', async (e) => {
  try {
    const host = e && e.host ? e.host : (e && e.host && e.host.host) ? e.host.host : null;
    if (isLocalDomainName(host)) {
      // ensureCert will rebuild combined cert if the requested hostname isn't yet in SANs
      await ensureCert(host);
      console.log('[cert] ensured combined cert after app-added for', host);
    }
  } catch (err) { console.error('cert ensure on app-added failed', err); }
});

manager.on('app-start', async (e) => {
  try {
    const host = e && e.host ? e.host : null;
    if (isLocalDomainName(host)) {
      await ensureCert(host);
      console.log('[cert] ensured combined cert after app-start for', host);
    }
  } catch (err) { console.error('cert ensure on app-start failed', err); }
});

/* ------------- Fallback self-signed (first boot before ACME) ------------- */
function selfSigned(hostname = "localhost") {
  const certPath = path.join(storeDir, `${hostname}.crt`);
  const keyPath = path.join(storeDir, `${hostname}.key`);
  const jsonPath = path.join(storeDir, `${hostname}_selfsigned.json`);

  // Check if certificate files already exist
  if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
    const cert = fs.readFileSync(certPath, 'utf8');
    const key = fs.readFileSync(keyPath, 'utf8');
    return { key, cert };
  }

  // Check if JSON cache exists
  if (fs.existsSync(jsonPath)) {
    const { cert, key } = JSON.parse(fs.readFileSync(jsonPath, "utf8"));
    // Save as .crt and .key files for external use
    fs.writeFileSync(certPath, cert);
    fs.writeFileSync(keyPath, key);
    console.log(`Certificate saved: ${certPath}`);
    console.log(`Private key saved: ${keyPath}`);
    return { key, cert };
  }

  // Generate new self-signed certificate with explicit Subject Alternative Name (SAN)
  const attrs = [
    { name: 'commonName', value: hostname },
    { name: 'organizationName', value: 'Console' },
    { name: 'organizationalUnitName', value: 'KP' }
  ];
  const extensions = [{
    name: 'subjectAltName',
    altNames: [{ type: 2, value: hostname }] // type 2 == DNS
  }];
  const pems = selfsigned.generate(attrs, { days: 365, extensions });
  const cert = pems.cert;
  const key = pems.private;

  // Save certificate and key as separate files
  fs.writeFileSync(certPath, cert);
  fs.writeFileSync(keyPath, key);

  // Also save JSON cache for quick loading
  fs.writeFileSync(jsonPath, JSON.stringify({ cert, key }));

  console.log(`Self-signed certificate generated:`);
  console.log(`Certificate saved: ${certPath}`);
  console.log(`Private key saved: ${keyPath}`);

  return { key, cert };
}

/* ----------------------- Reverse proxy & SNI TLS ------------------------- */
const proxy = httpProxy.createProxyServer({ xfwd: true });

// Rewrite backend Location headers and Set-Cookie domains so the browser only sees the public host
proxy.on('proxyRes', (proxyRes, req, res) => {
  try {
    const publicHostFull = (req.headers.host || '');
    const publicHost = publicHostFull.split(':')[0];
    const upstreamHost = req._upstreamHost;
    const upstreamProtocol = req._upstreamProtocol || 'http';

    // Rewrite Location headers from upstream -> public host
    const loc = proxyRes.headers['location'];
    if (loc && upstreamHost && publicHost) {
      try {
        // Parse the location; allow relative URLs
        const u = new URL(loc, `${upstreamProtocol}://${upstreamHost}`);
        // Only rewrite if the Location points back to the upstream host (or an internal host)
        const locHost = u.hostname;
        const isInternalTarget = locHost === upstreamHost || locHost === '127.0.0.1' || locHost === 'localhost' || locHost === '::1';
        const ensureCallbackPort = (urlObj) => {
          try {
            const cb = urlObj.searchParams.get('callback');
            if (!cb) return;
            const cbUrl = new URL(cb);
            // If callback hostname matches publicHost but has no port, add the incoming port
            if ((cbUrl.hostname === publicHost) && !cbUrl.port) {
              // Determine incoming port: prefer Host header port, fallback to socket localPort
              let incomingPort;
              try {
                const hostHeader = req.headers.host || '';
                const hhParts = hostHeader.split(':');
                if (hhParts.length === 2) incomingPort = hhParts[1];
              } catch (e) {}
              if (!incomingPort && req.socket && req.socket.localPort) incomingPort = String(req.socket.localPort);
              if (incomingPort) {
                cbUrl.port = incomingPort;
                urlObj.searchParams.set('callback', cbUrl.toString());
              }
            }
          } catch (e) {
            // ignore callback parse errors
          }
        };

        if (isInternalTarget) {
          ensureCallbackPort(u);
          const newLoc = `https://${publicHostFull}${u.pathname}${u.search}${u.hash}`;
          proxyRes.headers['location'] = newLoc;
        } else {
          // Leave public/external hostnames untouched (they may refer to other public services)
          ensureCallbackPort(u);
          proxyRes.headers['location'] = u.toString();
        }
      } catch (e) {
        // Fallback: only replace if it starts with the upstream host/protocol
        try {
          if (loc.startsWith(`${upstreamProtocol}://${upstreamHost}`)) {
            proxyRes.headers['location'] = loc.replace(new RegExp(`^${upstreamProtocol}://${upstreamHost}(:\\d+)?`), `https://${publicHostFull}`);
          }
        } catch (e2) {
          // give up and leave the original loc
        }
      }
    }

    // Rewrite Set-Cookie: remove Domain attribute so cookie becomes host-only for public host
    const sc = proxyRes.headers['set-cookie'];
    if (sc && Array.isArray(sc)) {
      proxyRes.headers['set-cookie'] = sc.map(cookie => cookie.replace(/;?\s*Domain=[^;]+/i, ''));
    }
  } catch (e) {
    // best-effort, don't break the response on rewrite errors
  }
});


// Allow overriding listen ports via env
const HTTP_PORT = parseInt(process.env.GATEWAY_HTTP_PORT || '8080', 10);
const HTTPS_PORT = parseInt(process.env.GATEWAY_HTTPS_PORT || '4443', 10);

// Certificate cache with TTL (24 hours)
const secureContextCache = new Map(); // hostname -> { context, expires }
const CERT_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours
const MAX_CERT_CACHE_SIZE = 100; // Limit cache size

// Periodic cache cleanup (every hour)
setInterval(() => {
  const now = Date.now();
  for (const [hostname, cached] of secureContextCache.entries()) {
    if (now >= cached.expires) {
      secureContextCache.delete(hostname);
    }
  }
  // If still too large, remove oldest entries
  if (secureContextCache.size > MAX_CERT_CACHE_SIZE) {
    const entries = Array.from(secureContextCache.entries());
    entries.sort((a, b) => a[1].expires - b[1].expires);
    const toRemove = entries.slice(0, entries.length - MAX_CERT_CACHE_SIZE);
    toRemove.forEach(([hostname]) => secureContextCache.delete(hostname));
  }
}, 60 * 60 * 1000); // Every hour

// HTTP server:
//  - serves ACME HTTP-01 challenges at /.well-known/acme-challenge/{token}
//  - redirects everything else to HTTPS (ensuring redirect uses HTTPS_PORT, not incoming :8080)
let adminHandler; // assigned after install
const httpSrv = http.createServer(async (req, res) => {
  if (adminHandler && req.url && req.url.startsWith('/admin')) {
  const done = adminHandler(req, res);
  if (done) return; // admin handled fully
  }
  // ACME challenge
  if (req.url && req.url.startsWith("/.well-known/acme-challenge/")) {
    const token = req.url.split("/").pop();
    const val = challenges.get(token);
    if (!val) { res.writeHead(404); res.end("not found"); return; }
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end(val);
    return;
  }
  // otherwise redirect to https (normalize host: replace HTTP_PORT with HTTPS_PORT)
  const hostHeader = req.headers.host || "";
  let hostname = hostHeader;
  let port = '';
  if (hostHeader.includes(':')) {
    const parts = hostHeader.split(':');
    hostname = parts[0];
    port = parts[1];
  }
  // If request came on the HTTP port (or its string form), swap to HTTPS_PORT
  let targetPort = (HTTPS_PORT === 443) ? '' : `:${HTTPS_PORT}`;
  const location = `https://${hostname}${targetPort}${req.url || '/'}`;
  res.writeHead(301, { Location: location });
  res.end();
});

// HTTPS server with dynamic SNI certs per hostname
const defaultCreds = selfSigned("localhost");

async function getSecureContext(servername) {
  servername = (servername || "").toLowerCase();
  if (!hostMap.has(servername)) return tls.createSecureContext(defaultCreds);
  
  // Check cache with TTL
  const cached = secureContextCache.get(servername);
  if (cached && Date.now() < cached.expires) {
    return cached.context;
  }
  
  const { key, cert } = await ensureCert(servername);
  const ctx = tls.createSecureContext({ key, cert });
  secureContextCache.set(servername, { 
    context: ctx, 
    expires: Date.now() + CERT_CACHE_TTL 
  });
  return ctx;
}

const httpsSrv = https.createServer({
  SNICallback: (servername, cb) => {
    // allow async SNI
    getSecureContext(servername)
      .then(ctx => cb(null, ctx))
      .catch(err => {
        console.error("SNI error", err);
        cb(null, tls.createSecureContext(defaultCreds));
      });
  }
}, async (req, res) => {
  const host = (req.headers.host || "").toLowerCase().split(":")[0];
  const app = hostMap.get(host);
  if (!app) { res.writeHead(502); res.end("Unknown host"); return; }

  // Ensure app is healthy before proxying
  // First, ensure process (if start command defined) is actually running
  try {
    if (app.start) {
      const rt = manager.runtime(app.host);
      if (!rt.running) {
        res.writeHead(503, { 'Content-Type': 'text/plain' });
        res.end('App process not running (host: ' + app.host + ')');
        return;
      }
    }
  } catch (e) {
    // If runtime lookup fails, continue to proxy logic (best effort)
  }
  const healthy = await waitHealthy(app);
  if (!healthy && app.healthUrl) {
    // Provide a more descriptive upstream failure response instead of a generic Bad Gateway later
    res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end('Upstream health check failed for host: ' + app.host + ' url: ' + app.healthUrl);
    return;
  }
  // If this app is configured to serve static files, do that instead of proxying
  if (app.staticDir) {
    try {
      // Serve files from the configured staticDir. Protect against path traversal.
      const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
      const safeSuffix = path.normalize(urlPath).replace(/^([\\/]+|\.\.)+/g, '');
      let filePath = path.join(app.staticDir, safeSuffix);
      // If the path is a directory, serve index.html
      let stat;
      try { stat = fs.statSync(filePath); } catch (e) { stat = null; }
      if (stat && stat.isDirectory()) filePath = path.join(filePath, 'index.html');
      // Fallback to index.html for SPA routing if file doesn't exist
      if (!stat || !fs.existsSync(filePath)) {
        filePath = path.join(app.staticDir, 'index.html');
        if (!fs.existsSync(filePath)) {
          res.writeHead(404); res.end('Not found'); return;
        }
      }
      // Minimal mime type mapping
      const ext = path.extname(filePath).toLowerCase();
      const mimes = {
        '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.mjs': 'application/javascript; charset=utf-8',
        '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
        '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.map': 'application/octet-stream', '.wasm': 'application/wasm'
      };
      const ct = mimes[ext] || 'application/octet-stream';
      const stream = fs.createReadStream(filePath);
      res.writeHead(200, { 'Content-Type': ct, 'Cache-Control': 'no-cache' });
      stream.pipe(res);
      stream.on('error', (err) => { console.error('Static file stream error', err); if (!res.headersSent) res.writeHead(500); res.end('Server error'); });
      return;
    } catch (e) {
      console.error('Static serve error for', app.staticDir, e);
      res.writeHead(500); res.end('Server error');
      return;
    }
  }

  // Build upstream target (support app.upstream or local port fallback)
  const upstream = app.upstream || (app.port ? { protocol: 'http', host: '127.0.0.1', port: app.port } : { protocol: 'http', host: '127.0.0.1', port: 80 });
  const target = `${upstream.protocol}://${upstream.host}:${upstream.port}`;
  req._upstreamHost = upstream.host;
  req._upstreamProtocol = upstream.protocol;

  // Respect preserveHost: when true, forward the original Host header to upstream
  const proxyOpts = { target, changeOrigin: !app.preserveHost };
  if (upstream.protocol === 'https') proxyOpts.secure = upstream.rejectUnauthorized !== false;
  if (app.preserveHost && req.headers && req.headers.host) {
    proxyOpts.headers = Object.assign({}, req.headers, { Host: req.headers.host });
  }

  proxy.web(req, res, proxyOpts, (err) => {
    console.error(`[proxy:${host}]`, err?.message);
    if (!res.headersSent) {
      res.writeHead(502);
    }
    res.end("Bad gateway");
  });
});

// Basic hardening for proxy upgrades (WebSockets)
httpsSrv.on("upgrade", (req, socket, head) => {
  const host = (req.headers.host || "").toLowerCase().split(":")[0];
  const app = hostMap.get(host);
  if (!app) return socket.destroy();

  // Build upstream target for websocket proxy
  const upstream = app.upstream || (app.port ? { protocol: 'http', host: '127.0.0.1', port: app.port } : { protocol: 'http', host: '127.0.0.1', port: 80 });
  const target = `${upstream.protocol}://${upstream.host}:${upstream.port}`;
  const wsOpts = { target, changeOrigin: !app.preserveHost };
  if (upstream.protocol === 'https') wsOpts.secure = upstream.rejectUnauthorized !== false;
  if (app.preserveHost && req.headers && req.headers.host) {
    wsOpts.headers = Object.assign({}, req.headers, { Host: req.headers.host });
  }

  proxy.ws(req, socket, head, wsOpts);
});

/* ------------------------------ Start servers ---------------------------- */
function startServers() {
  httpSrv.listen(HTTP_PORT, () => console.log(`HTTP  server listening on :${HTTP_PORT} (ACME + redirect + admin API)`));
  httpsSrv.listen(HTTPS_PORT, () => console.log(`HTTPS server listening on :${HTTPS_PORT}`));
  // Install admin API/WS AFTER servers are created so they can hook events
  // Install admin WebSocket and capture controller so API can toggle it at runtime
  const adminWs = installAdminWs(httpSrv, { manager, token: adminToken });
  const api = installAdminApi(httpSrv, { manager, token: adminToken, certInstaller: ensureCert, adminWs });
  adminHandler = api.handle;
}

// Handle port conflicts
httpSrv.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
  console.log(`Port ${HTTP_PORT} is already in use. Attempting to close previous instance...`);
    // Try to close any existing server on this port
    setTimeout(() => {
      httpSrv.close(() => {
    console.log('Closed previous HTTP server, retrying...');
        setTimeout(startServers, 1000);
      });
    }, 1000);
  } else {
    console.error('HTTP Server error:', err);
  }
});

httpsSrv.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
  console.log(`Port ${HTTPS_PORT} is already in use. Attempting to close previous instance...`);
    setTimeout(() => {
      httpsSrv.close(() => {
        console.log('Closed previous HTTPS server, retrying...');
        setTimeout(startServers, 1000);
      });
    }, 1000);
  } else {
    console.error('HTTPS Server error:', err);
  }
});

startServers();

// Diagnostic: log unexpected exits and errors to help debugging
process.on('exit', (code) => {
  try { console.log('process.exit event, code=' + code); } catch(_){}
});
process.on('uncaughtException', (err) => {
  try { console.error('uncaughtException:', err && err.stack ? err.stack : err); } catch(_){}
});
process.on('unhandledRejection', (reason) => {
  try { console.error('unhandledRejection:', reason); } catch(_){}
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('Shutting down servers...');
  httpSrv.close(() => console.log('HTTP server closed'));
  httpsSrv.close(() => console.log('HTTPS server closed'));
  // Kill child processes
  for (const app of manager.listApps()) {
    try { manager.stop(app.host); } catch {}
  }
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('Shutting down servers...');
  httpSrv.close(() => console.log('HTTP server closed'));
  httpsSrv.close(() => console.log('HTTPS server closed'));
  for (const app of manager.listApps()) {
    try { manager.stop(app.host); } catch {}
  }
  process.exit(0);
});
