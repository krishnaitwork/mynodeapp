# Technical Architecture Deep Dive

## 🏗️ Architecture Overview

### High-Level Design
```
┌─────────────────┐    ┌──────────────────┐    ┌─────────────────┐
│   Browser       │    │    Gateway       │    │   Backend Apps  │
│                 │    │                  │    │                 │
│ HTTPS Request   │───▶│ SNI Router       │───▶│ Express Server  │
│ Port 443/4443   │    │ SSL Termination  │    │ Port 3000-3999  │
│                 │    │ Reverse Proxy    │    │                 │
│ WebSocket       │◄──▶│ WebSocket Proxy  │◄──▶│ Socket.IO       │
│                 │    │ Health Checker   │    │                 │
└─────────────────┘    └──────────────────┘    └─────────────────┘
```

### Core Components

#### 1. SNI-Based TLS Termination
```javascript
const httpsSrv = https.createServer({
  SNICallback: (servername, cb) => {
    // Dynamic certificate selection based on hostname
    getSecureContext(servername)
      .then(ctx => cb(null, ctx))
      .catch(err => cb(null, defaultContext));
  }
});
```

**How it works**:
- Client sends TLS ClientHello with SNI extension
- Gateway examines `servername` before TLS handshake
- Loads appropriate certificate for the domain
- Completes TLS handshake with correct certificate

#### 2. Certificate Management System
```javascript
async function ensureCert(hostname) {
  // 1. Check existing certificate validity
  // 2. Use ACME for public domains
  // 3. Fallback to self-signed for local domains
  // 4. Cache in secureContextCache
}
```

**Certificate Flow**:
```
Domain Request → Check Cache → Valid? → Return Context
                     ↓              ↓
                Load from Disk → ACME/Self-signed → Save & Cache
```

#### 3. Reverse Proxy Engine
```javascript
const proxy = httpProxy.createProxyServer({ xfwd: true });

// Request routing
const app = hostMap.get(host);
const target = buildUpstreamTarget(app);
proxy.web(req, res, { target, changeOrigin: !app.preserveHost });
```

**Proxy Flow**:
```
Incoming Request → Host Lookup → Health Check → Proxy to Backend
      ↓                ↓             ↓              ↓
  Extract Host → Find Config → Wait Healthy → Forward Request
```

### Advanced Features Deep Dive

#### 1. Response Header Rewriting
The gateway intelligently rewrites response headers to maintain the illusion of a single domain:

```javascript
proxy.on('proxyRes', (proxyRes, req, res) => {
  const publicHost = req.headers.host;
  const upstreamHost = req._upstreamHost;
  
  // Location header rewriting
  const location = proxyRes.headers['location'];
  if (location && isInternalTarget(location)) {
    proxyRes.headers['location'] = rewriteToPublicURL(location, publicHost);
  }
  
  // Cookie domain stripping
  if (proxyRes.headers['set-cookie']) {
    proxyRes.headers['set-cookie'] = stripCookieDomains(cookies);
  }
});
```

**Why this matters**:
- Backend redirects to `http://127.0.0.1:3000/login` become `https://app.company.com/login`
- Cookies set for internal hosts work with public domains
- Authentication flows remain seamless

#### 2. Process Supervision
```javascript
function startApp(app) {
  const child = spawn(app.start.split(" ")[0], app.start.split(" ").slice(1), {
    cwd: app.cwd,
    env: { ...process.env, NODE_ENV: "production" },
    stdio: "inherit",
    shell: true
  });
  
  child.on("exit", (code) => {
    console.error(`[${app.host}] exited with code ${code}. Restarting in 2s...`);
    setTimeout(() => startApp(app), 2000);
  });
}
```

**Supervision Features**:
- Automatic restart on crash
- Environment variable inheritance
- Working directory management
- Graceful shutdown handling

#### 3. Health Checking System
```javascript
async function waitHealthy(app, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await request(app.healthUrl, { method: "GET" });
      if (res.statusCode >= 200 && res.statusCode < 500) return true;
    } catch {}
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}
```

**Health Check Logic**:
- Polls backend health endpoint
- Waits for service to be ready before proxying
- Handles temporary failures gracefully
- Prevents routing to unhealthy backends

### SSL/TLS Implementation Details

#### ACME Challenge Handling
```javascript
const httpSrv = http.createServer(async (req, res) => {
  if (req.url && req.url.startsWith("/.well-known/acme-challenge/")) {
    const token = req.url.split("/").pop();
    const keyAuth = challenges.get(token);
    if (keyAuth) {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end(keyAuth);
      return;
    }
  }
  // Redirect to HTTPS
  res.writeHead(301, { Location: `https://${req.headers.host}${req.url}` });
  res.end();
});
```

**ACME Flow**:
```
1. Request certificate for domain.com
2. ACME server sends challenge token
3. HTTP server serves challenge at /.well-known/acme-challenge/
4. ACME server validates challenge
5. Certificate issued and saved
```

#### Self-Signed Certificate Generation
```javascript
function selfSigned(hostname) {
  const attrs = [
    { name: 'commonName', value: hostname },
    { name: 'organizationName', value: 'Console' },
    { name: 'organizationalUnitName', value: 'KP' }
  ];
  
  const extensions = [{
    name: 'subjectAltName',
    altNames: [{ type: 2, value: hostname }]
  }];
  
  const pems = selfsigned.generate(attrs, { 
    days: 365, 
    extensions,
    keySize: 2048,
    algorithm: 'sha256'
  });
}
```

### WebSocket Proxying

#### Upgrade Handling
```javascript
httpsSrv.on("upgrade", (req, socket, head) => {
  const host = (req.headers.host || "").split(":")[0];
  const app = hostMap.get(host);
  
  if (!app) return socket.destroy();
  
  const upstream = buildUpstreamTarget(app);
  const wsOpts = { 
    target: upstream, 
    changeOrigin: !app.preserveHost 
  };
  
  proxy.ws(req, socket, head, wsOpts);
});
```

**WebSocket Features**:
- Preserves connection headers
- Maintains authentication state
- Supports Socket.IO and native WebSockets
- Handles connection cleanup

### Configuration System

#### Dynamic Host Mapping
```javascript
const hostMap = new Map(cfg.apps.map(a => [a.host.toLowerCase(), a]));

// Runtime lookup
const app = hostMap.get(hostname);
if (!app) {
  res.writeHead(502);
  res.end("Unknown host");
  return;
}
```

#### Upstream Target Resolution
```javascript
function buildUpstreamTarget(app) {
  if (app.upstream) {
    return `${app.upstream.protocol}://${app.upstream.host}:${app.upstream.port}`;
  }
  
  if (app.port) {
    return `http://127.0.0.1:${app.port}`;
  }
  
  return `http://127.0.0.1:80`;
}
```

### Static File Serving

#### SPA Support
```javascript
if (app.staticDir) {
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  const safeSuffix = path.normalize(urlPath).replace(/^([\\/]+|\.\.)+/g, '');
  let filePath = path.join(app.staticDir, safeSuffix);
  
  // Directory → index.html
  if (stat && stat.isDirectory()) {
    filePath = path.join(filePath, 'index.html');
  }
  
  // SPA fallback
  if (!fs.existsSync(filePath)) {
    filePath = path.join(app.staticDir, 'index.html');
  }
}
```

**Static Features**:
- Path traversal protection
- MIME type detection
- SPA routing support (fallback to index.html)
- Directory index serving

### Security Considerations

#### Path Traversal Prevention
```javascript
const safeSuffix = path.normalize(urlPath).replace(/^([\\/]+|\.\.)+/g, '');
```

#### Header Sanitization
```javascript
// Remove potentially dangerous headers
delete proxyRes.headers['x-powered-by'];
delete proxyRes.headers['server'];

// Sanitize cookie domains
proxyRes.headers['set-cookie'] = cookies.map(cookie => 
  cookie.replace(/;?\s*Domain=[^;]+/i, '')
);
```

#### SSL Validation
```javascript
const proxyOpts = { target, changeOrigin: !app.preserveHost };
if (upstream.protocol === 'https') {
  proxyOpts.secure = upstream.rejectUnauthorized !== false;
}
```

### Performance Optimizations

#### Certificate Caching
```javascript
const secureContextCache = new Map();

async function getSecureContext(servername) {
  if (secureContextCache.has(servername)) {
    return secureContextCache.get(servername);
  }
  
  const { key, cert } = await ensureCert(servername);
  const ctx = tls.createSecureContext({ key, cert });
  secureContextCache.set(servername, ctx);
  return ctx;
}
```

#### Connection Pooling
```javascript
const proxy = httpProxy.createProxyServer({ 
  xfwd: true,
  timeout: 30000,
  proxyTimeout: 30000
});
```

### Error Handling

#### Graceful Degradation
```javascript
proxy.web(req, res, proxyOpts, (err) => {
  console.error(`[proxy:${host}]`, err?.message);
  if (!res.headersSent) {
    res.writeHead(502);
  }
  res.end("Bad gateway");
});
```

#### Circuit Breaker Pattern
```javascript
let failureCount = 0;
const maxFailures = 5;

if (failureCount >= maxFailures) {
  res.writeHead(503);
  res.end("Service temporarily unavailable");
  return;
}
```

### Monitoring & Observability

#### Request Logging
```javascript
console.log(`[${new Date().toISOString()}] ${req.method} ${req.url} - ${req.headers.host} → ${target}`);
```

#### Metrics Collection
```javascript
const metrics = {
  requests: 0,
  errors: 0,
  uptime: process.uptime(),
  memory: process.memoryUsage()
};
```

### Development vs Production

#### Development Features
- Detailed error messages
- Auto-restart on file changes
- Self-signed certificate acceptance
- Relaxed security policies

#### Production Hardening
- Minimal error disclosure
- Strict SSL validation
- Rate limiting
- Security headers

This architecture provides enterprise-grade reverse proxy capabilities while maintaining simplicity and ease of use for development scenarios.
