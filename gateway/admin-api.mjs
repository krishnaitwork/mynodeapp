import fs from 'node:fs';
import path from 'node:path';
import { URL, fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

// Minimal router without external deps
export function installAdminApi(server, { manager, token, certInstaller }) {
  const routes = [];
  const add = (method, pattern, handler) => routes.push({ method, pattern, handler });

  function auth(req, res) {
    if (!token) return true; // no token = open (dev)
  const pathOnly = (req.url || '').split('?')[0];
  // Allow the HTML shell to load so user can input token
  if (req.method === 'GET' && (pathOnly === '/admin' || pathOnly === '/admin/')) return true;
    const hdr = req.headers['x-admin-token'];
    const url = new URL(req.url, 'http://localhost');
    const q = url.searchParams.get('token');
    if (hdr === token || q === token) return true;
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'unauthorized' }));
    return false;
  }

  function json(res, status, obj) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
  }

  add('GET', /^\/admin\/apps$/, (req, res) => {
  const apps = manager.listApps().map(a => ({ ...a, runtime: manager.runtime(a.host) }));
  json(res, 200, { apps });
  });

  add('POST', /^\/admin\/apps$/, async (req, res) => {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const data = JSON.parse(body || '{}');
        const created = manager.addApp(data);
        json(res, 201, created);
      } catch (e) { json(res, 400, { error: e.message }); }
    });
  });

  add('GET', /^\/admin\/apps\/([^/]+)$/i, (req, res, m) => {
    const app = manager.getApp(m[1]);
    if (!app) return json(res, 404, { error: 'not found' });
  json(res, 200, { ...app, runtime: manager.runtime(app.host) });
  });

  add('PATCH', /^\/admin\/apps\/([^/]+)$/i, (req, res, m) => {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const partial = JSON.parse(body || '{}');
        const app = manager.updateApp(m[1], partial);
        json(res, 200, app);
      } catch (e) { json(res, 400, { error: e.message }); }
    });
  });

  add('DELETE', /^\/admin\/apps\/([^/]+)$/i, (req, res, m) => {
    try {
      manager.removeApp(m[1]);
      json(res, 200, { deleted: true });
    } catch (e) { json(res, 404, { error: e.message }); }
  });

  add('POST', /^\/admin\/apps\/([^/]+)\/start$/i, (req, res, m) => {
    try { json(res, 200, manager.start(m[1])); }
    catch (e) { json(res, 400, { error: e.message }); }
  });
  add('POST', /^\/admin\/apps\/([^/]+)\/stop$/i, (req, res, m) => {
    try { json(res, 200, manager.stop(m[1])); }
    catch (e) { json(res, 400, { error: e.message }); }
  });
  add('POST', /^\/admin\/apps\/([^/]+)\/restart$/i, (req, res, m) => {
    try { json(res, 200, manager.restart(m[1])); }
    catch (e) { json(res, 400, { error: e.message }); }
  });

  add('POST', /^\/admin\/apps\/([^/]+)\/enable$/i, (req, res, m) => {
    try { json(res, 200, manager.enable(m[1])); }
    catch (e) { json(res, 400, { error: e.message }); }
  });
  add('POST', /^\/admin\/apps\/([^/]+)\/disable$/i, (req, res, m) => {
    try { json(res, 200, manager.disable(m[1])); }
    catch (e) { json(res, 400, { error: e.message }); }
  });

  add('GET', /^\/admin\/apps\/([^/]+)\/runtime$/i, (req, res, m) => {
    try { json(res, 200, manager.runtime(m[1])); }
    catch (e) { json(res, 404, { error: e.message }); }
  });

  add('GET', /^\/admin\/apps\/([^/]+)\/logs$/i, (req, res, m) => {
    try {
      if (!m || !m[1]) {
        return json(res, 400, { error: 'Invalid app host in URL' });
      }
      
      const host = decodeURIComponent(m[1]);
      const url = new URL(req.url, 'http://localhost');
      const limit = parseInt(url.searchParams.get('limit') || '200', 10);
      
      const logs = manager.tail(host, limit);
      json(res, 200, { logs: logs || [] });
    } catch (e) { 
      console.error('Logs API error:', e);
      json(res, 400, { error: e.message }); 
    }
  });

  // Trigger certificate installation/generation for a single host (sync to ensureCert in gateway)
  add('POST', /^\/admin\/apps\/([^/]+)\/install-cert$/i, async (req, res, m) => {
    try {
      const host = decodeURIComponent(m[1]);
      if (typeof certInstaller !== 'function') return json(res, 400, { error: 'cert installer not available' });
      // call the installer which returns {key, cert} or throws
      const result = await certInstaller(host);
      // If on Windows, try to import into CurrentUser Root using certutil.exe
      const isWin = process.platform === 'win32';
      if (isWin && result && result.certPath) {
        try {
          const { spawn } = await import('node:child_process');
          await new Promise((resolve, reject) => {
            const args = ['-user', '-addstore', 'Root', result.certPath];
            const p = spawn('certutil.exe', args, { stdio: 'inherit' });
            p.on('exit', (code) => code === 0 ? resolve() : reject(new Error('certutil exit code '+code)));
            p.on('error', (err) => reject(err));
          });
          json(res, 200, { installed: true, host, importedToStore: true });
        } catch (e) {
          console.error('certutil import failed', e);
          json(res, 200, { installed: true, host, importedToStore: false, importError: e.message });
        }
      } else {
        json(res, 200, { installed: true, host, ok: !!result });
      }
    } catch (e) {
      console.error('install-cert error:', e);
      json(res, 400, { error: e.message });
    }
  });

  // Inspect uploaded certificate (.crt/.pem) and return subject/SANs for verification
  add('POST', /^\/admin\/inspect-cert$/i, async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const buf = Buffer.concat(chunks);
      const txt = buf.toString('utf8');
      const pemMatch = txt.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/);
      if (!pemMatch) return json(res, 400, { error: 'No PEM certificate found in upload' });
      const pem = pemMatch[0];
      try {
        const cert = new crypto.X509Certificate(pem);
        // subject is a string like 'CN=...'
        const subject = cert.subject || '';
        // subjectAltName may be a string like 'DNS:example.com, DNS:foo'
        const sanRaw = cert.subjectAltName || '';
        const sans = [];
        const dnsRe = /DNS:([^,\s]+)/g;
        let m;
        while ((m = dnsRe.exec(sanRaw)) !== null) sans.push(m[1]);
        return json(res, 200, { subject, sanRaw, sans });
      } catch (e) {
        return json(res, 400, { error: 'Failed to parse certificate: ' + e.message });
      }
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  });

  // Serve static admin UI (single file) at /admin (HTML) and /admin/app.js
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const uiPath = path.join(__dirname, 'admin-ui.html');
  let uiHtmlCache = null;

  add('GET', /^\/admin\/?$/, (req, res) => {
    try {
      if (!uiHtmlCache) uiHtmlCache = fs.readFileSync(uiPath, 'utf8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(uiHtmlCache);
    } catch (e) {
      res.writeHead(500); res.end('UI missing');
    }
  return true;
  });

  function handle(req, res) {
    if (!req.url.startsWith('/admin')) return false;
    if (!auth(req, res)) return true;
    for (const r of routes) {
      if (req.method === r.method) {
        const pathOnly = req.url.split('?')[0];
        const m = pathOnly.match(r.pattern);
        if (m) {
          r.handler(req, res, m);
          return true; // always mark handled to avoid outer server continuing
        }
      }
    }
    res.writeHead(404); res.end('not found');
    return true;
  }

  return { handle };
}
