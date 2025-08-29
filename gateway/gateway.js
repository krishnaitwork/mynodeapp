import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import httpProxy from "http-proxy";
import { request } from "undici";
import * as acme from "acme-client";
import selfsigned from "selfsigned";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, "gateway.config.json"), "utf8"));

/* ----------------------- Simple process supervisor ----------------------- */
const children = new Map(); // host -> child
function startApp(app) {
  if (children.has(app.host)) return;
  const child = spawn(app.start.split(" ")[0], app.start.split(" ").slice(1), {
    cwd: app.cwd,
    env: { ...process.env, NODE_ENV: process.env.NODE_ENV || "production" },
    stdio: "inherit",
    shell: true
  });
  children.set(app.host, child);
  child.on("exit", (code) => {
    console.error(`[${app.host}] exited with code ${code}. Restarting in 2s...`);
    children.delete(app.host);
    setTimeout(() => startApp(app), 2000);
  });
}
for (const app of cfg.apps) startApp(app);

/* ----------------------- Health wait (optional) -------------------------- */
async function waitHealthy(app, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if (!app.healthUrl) return true;
      const res = await request(app.healthUrl, { method: "GET" });
      if (res.statusCode >= 200 && res.statusCode < 500) return true;
    } catch {}
    await new Promise(r => setTimeout(r, 500));
  }
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
  if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
    try {
      const cert = tls.createSecureContext({
        key: fs.readFileSync(keyPath),
        cert: fs.readFileSync(certPath)
      }).context.getCertificate();
      // If valid for >10 days, reuse
      return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
    } catch { /* fallthrough to renew */ }
  }

  // For local domains, use self-signed certificates
  if (hostname.includes('.local') || hostname.includes('localhost') || hostname.includes('.console')) {
    console.log(`Using self-signed certificate for local domain: ${hostname}`);
    const app = hostMap.get(hostname);
    const alt = (app && Array.isArray(app.altNames) && app.altNames.length) ? app.altNames : [hostname];
    return selfSigned(hostname, alt);
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
    return { key, cert };
  } catch (error) {
    console.error(`ACME failed for ${hostname}, falling back to self-signed:`, error.message);
    return selfSigned(hostname);
  }
}

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

const hostMap = new Map(cfg.apps.map(a => [a.host.toLowerCase(), a]));

// HTTP server:
//  - serves ACME HTTP-01 challenges at /.well-known/acme-challenge/{token}
//  - redirects everything else to HTTPS
const httpSrv = http.createServer(async (req, res) => {
  // ACME challenge
  if (req.url && req.url.startsWith("/.well-known/acme-challenge/")) {
    const token = req.url.split("/").pop();
    const val = challenges.get(token);
    if (!val) { res.writeHead(404); res.end("not found"); return; }
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end(val);
    return;
  }
  // otherwise redirect to https
  const host = req.headers.host || "";
  const location = `https://${host}${req.url || "/"}`;
  res.writeHead(301, { Location: location });
  res.end();
});

// HTTPS server with dynamic SNI certs per hostname
const defaultCreds = selfSigned("localhost");
const secureContextCache = new Map(); // hostname -> SecureContext

async function getSecureContext(servername) {
  servername = (servername || "").toLowerCase();
  if (!hostMap.has(servername)) return tls.createSecureContext(defaultCreds);
  if (secureContextCache.has(servername)) return secureContextCache.get(servername);
  const { key, cert } = await ensureCert(servername);
  const ctx = tls.createSecureContext({ key, cert });
  secureContextCache.set(servername, ctx);
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
  await waitHealthy(app);

  proxy.web(req, res, { target: `http://127.0.0.1:${app.port}` }, (err) => {
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
  proxy.ws(req, socket, head, { target: `http://127.0.0.1:${app.port}` });
});

/* ------------------------------ Start servers ---------------------------- */
function startServers() {
  httpSrv.listen(8080, () => console.log("HTTP  server listening on :80 (for ACME + redirect)"));
  httpsSrv.listen(4443, () => console.log("HTTPS server listening on :4443"));
}

// Handle port conflicts
httpSrv.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.log('Port 8080 is already in use. Attempting to close previous instance...');
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
    console.log('Port 4443 is already in use. Attempting to close previous instance...');
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

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('Shutting down servers...');
  httpSrv.close(() => console.log('HTTP server closed'));
  httpsSrv.close(() => console.log('HTTPS server closed'));
  // Kill child processes
  for (const [host, child] of children) {
    console.log(`Killing process for ${host}`);
    child.kill();
  }
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('Shutting down servers...');
  httpSrv.close(() => console.log('HTTP server closed'));
  httpsSrv.close(() => console.log('HTTPS server closed'));
  for (const [host, child] of children) {
    console.log(`Killing process for ${host}`);
    child.kill();
  }
  process.exit(0);
});
