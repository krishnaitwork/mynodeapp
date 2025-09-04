import fs from 'node:fs';
import path from 'node:path';
import { URL, fileURLToPath } from 'node:url';

// Minimal router without external deps
export function installAdminApi(server, { manager, token }) {
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
