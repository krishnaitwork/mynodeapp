# Gateway Usage Examples

This document provides real-world examples of how to use the Node.js Gateway for various scenarios.

## 📋 Table of Contents
1. [Local Development Setup](#local-development-setup)
2. [Production Deployment](#production-deployment)
3. [Microservices Architecture](#microservices-architecture)
4. [Authentication Flows](#authentication-flows)
5. [External API Proxying](#external-api-proxying)
6. [Static Site Hosting](#static-site-hosting)
7. [Multi-tenant SaaS](#multi-tenant-saas)
8. [Development Testing](#development-testing)

## 🔧 Local Development Setup

### Scenario: Full-Stack Development Environment

**Goal**: Develop a React frontend, Node.js API, and authentication service locally with proper HTTPS and domain routing.

#### Configuration (`gateway.config.json`):
```json
{
  "email": "developer@company.com",
  "agreeToTerms": true,
  "acme": {
    "directoryUrl": "https://acme-v02.api.letsencrypt.org/directory",
    "configDir": "./storage"
  },
  "apps": [
    {
      "host": "app.local.dev",
      "altNames": ["app.local.dev", "www.local.dev"],
      "preserveHost": false,
      "cwd": "c:/projects/frontend",
      "start": "npm run dev",
      "healthUrl": "http://127.0.0.1:3000/health",
      "port": 3000
    },
    {
      "host": "api.local.dev",
      "altNames": ["api.local.dev"],
      "preserveHost": false,
      "cwd": "c:/projects/backend",
      "start": "npm start",
      "healthUrl": "http://127.0.0.1:3001/health",
      "port": 3001
    },
    {
      "host": "auth.local.dev",
      "altNames": ["auth.local.dev"],
      "preserveHost": false,
      "cwd": "c:/projects/auth-service",
      "start": "npm start",
      "healthUrl": "http://127.0.0.1:3002/health",
      "port": 3002
    }
  ]
}
```

#### Setup Steps:
1. **Add to hosts file** (`C:\Windows\System32\drivers\etc\hosts`):
   ```
   127.0.0.1 app.local.dev
   127.0.0.1 api.local.dev
   127.0.0.1 auth.local.dev
   ```

2. **Start the gateway**:
   ```bash
   cd gateway
   node gateway.js
   ```

3. **Access your applications**:
   - Frontend: `https://app.local.dev:4443`
   - API: `https://api.local.dev:4443`
   - Auth: `https://auth.local.dev:4443`

#### Benefits:
- ✅ Automatic HTTPS with self-signed certificates
- ✅ Cross-origin requests work properly
- ✅ Services auto-restart on crash
- ✅ Real domain names for testing

## 🚀 Production Deployment

### Scenario: Production API Gateway

**Goal**: Deploy a production-ready gateway with Let's Encrypt SSL for public domains.

#### Configuration:
```json
{
  "email": "admin@company.com",
  "agreeToTerms": true,
  "acme": {
    "directoryUrl": "https://acme-v02.api.letsencrypt.org/directory",
    "configDir": "./storage"
  },
  "apps": [
    {
      "host": "api.company.com",
      "altNames": ["api.company.com", "www.api.company.com"],
      "preserveHost": true,
      "upstream": {
        "protocol": "http",
        "host": "127.0.0.1",
        "port": 8080,
        "rejectUnauthorized": false
      },
      "healthUrl": "http://127.0.0.1:8080/health"
    },
    {
      "host": "admin.company.com",
      "altNames": ["admin.company.com"],
      "preserveHost": true,
      "upstream": {
        "protocol": "http",
        "host": "127.0.0.1",
        "port": 8081,
        "rejectUnauthorized": false
      },
      "healthUrl": "http://127.0.0.1:8081/health"
    }
  ]
}
```

#### Production Setup:
1. **Configure DNS** to point to your server:
   ```
   A api.company.com     → 203.0.113.10
   A admin.company.com   → 203.0.113.10
   ```

2. **Set up port forwarding** (as Administrator):
   ```cmd
   netsh interface portproxy add v4tov4 listenport=443 listenaddress=0.0.0.0 connectport=4443 connectaddress=127.0.0.1
   netsh interface portproxy add v4tov4 listenport=80 listenaddress=0.0.0.0 connectport=8080 connectaddress=127.0.0.1
   ```

3. **Start with PM2** for production:
   ```bash
   npm install -g pm2
   pm2 start gateway.js --name="gateway"
   pm2 startup
   pm2 save
   ```

#### Result:
- ✅ Automatic Let's Encrypt certificates
- ✅ Access via standard ports (80/443)
- ✅ Process monitoring and auto-restart
- ✅ Public domains with proper SSL

## 🏗️ Microservices Architecture

### Scenario: Multiple Service Domains

**Goal**: Route different subdomains to different microservices.

#### Configuration:
```json
{
  "apps": [
    {
      "host": "users.company.com",
      "preserveHost": true,
      "upstream": {
        "protocol": "http",
        "host": "user-service.internal",
        "port": 3000
      },
      "healthUrl": "http://user-service.internal:3000/health"
    },
    {
      "host": "orders.company.com", 
      "preserveHost": true,
      "upstream": {
        "protocol": "http",
        "host": "order-service.internal",
        "port": 3001
      },
      "healthUrl": "http://order-service.internal:3001/health"
    },
    {
      "host": "payments.company.com",
      "preserveHost": true,
      "upstream": {
        "protocol": "https",
        "host": "payment-service.internal",
        "port": 3002,
        "rejectUnauthorized": true
      },
      "healthUrl": "https://payment-service.internal:3002/health"
    }
  ]
}
```

#### Architecture Benefits:
```
Internet → Gateway → Internal Services
           ├── users.company.com → user-service:3000
           ├── orders.company.com → order-service:3001
           └── payments.company.com → payment-service:3002
```

## 🔐 Authentication Flows

### Scenario: Cross-Domain Authentication

**Goal**: Implement OAuth-style authentication across multiple domains.

#### Configuration:
```json
{
  "apps": [
    {
      "host": "app.company.com",
      "cwd": "c:/services/main-app",
      "start": "npm start",
      "port": 3000,
      "preserveHost": false
    },
    {
      "host": "auth.company.com",
      "cwd": "c:/services/auth-provider", 
      "start": "npm start",
      "port": 3001,
      "preserveHost": false
    }
  ]
}
```

#### Authentication Flow Implementation:

**Main App** (`/login` route):
```javascript
app.get('/login', (req, res) => {
  const returnUrl = `https://app.company.com/callback`;
  const authUrl = `https://auth.company.com/authenticate?return=${encodeURIComponent(returnUrl)}`;
  res.redirect(authUrl);
});

app.get('/callback', (req, res) => {
  const token = req.query.token;
  if (token) {
    // Set authentication cookie
    res.cookie('auth_token', token, { httpOnly: true, secure: true });
    res.redirect('/dashboard');
  } else {
    res.redirect('/login');
  }
});
```

**Auth Service** (`/authenticate` route):
```javascript
app.get('/authenticate', (req, res) => {
  // Show login form with return URL
  res.render('login', { returnUrl: req.query.return });
});

app.post('/authenticate', (req, res) => {
  const { username, password } = req.body;
  const returnUrl = req.body.returnUrl;
  
  if (validateCredentials(username, password)) {
    const token = generateJWT(username);
    res.redirect(`${returnUrl}?token=${token}`);
  } else {
    res.render('login', { error: 'Invalid credentials', returnUrl });
  }
});
```

#### Flow Diagram:
```
1. User → https://app.company.com/login
2. App → Redirect to https://auth.company.com/authenticate?return=...
3. Auth → User enters credentials
4. Auth → Redirect to https://app.company.com/callback?token=...
5. App → Sets cookie and redirects to dashboard
```

## 🌐 External API Proxying

### Scenario: Proxy External APIs with Custom Domains

**Goal**: Provide custom branded domains for external services.

#### Configuration:
```json
{
  "apps": [
    {
      "host": "maps.ourcompany.com",
      "preserveHost": true,
      "upstream": {
        "protocol": "https",
        "host": "maps.googleapis.com",
        "port": 443,
        "rejectUnauthorized": true
      },
      "healthUrl": "https://maps.googleapis.com/maps/api/js"
    },
    {
      "host": "analytics.ourcompany.com",
      "preserveHost": true,
      "upstream": {
        "protocol": "https", 
        "host": "www.google-analytics.com",
        "port": 443,
        "rejectUnauthorized": true
      }
    }
  ]
}
```

#### Client Usage:
```javascript
// Instead of: https://maps.googleapis.com/maps/api/js
// Use: https://maps.ourcompany.com/maps/api/js

const script = document.createElement('script');
script.src = 'https://maps.ourcompany.com/maps/api/js?key=YOUR_KEY';
document.head.appendChild(script);
```

## 📄 Static Site Hosting

### Scenario: Host Multiple Static Sites

**Goal**: Serve static React/Vue builds with SPA routing support.

#### Configuration:
```json
{
  "apps": [
    {
      "host": "marketing.company.com",
      "staticDir": "C:/websites/marketing-site/build",
      "altNames": ["marketing.company.com", "www.marketing.company.com"]
    },
    {
      "host": "docs.company.com",
      "staticDir": "C:/websites/documentation/dist",
      "altNames": ["docs.company.com"]
    },
    {
      "host": "blog.company.com",
      "staticDir": "C:/websites/blog/public",
      "altNames": ["blog.company.com"]
    }
  ]
}
```

#### Directory Structure:
```
C:/websites/
├── marketing-site/build/
│   ├── index.html
│   ├── static/
│   └── ...
├── documentation/dist/
│   ├── index.html
│   ├── assets/
│   └── ...
└── blog/public/
    ├── index.html
    ├── posts/
    └── ...
```

#### Features:
- ✅ SPA routing (falls back to index.html)
- ✅ Proper MIME types
- ✅ HTTPS with automatic certificates
- ✅ Cache headers

## 🏢 Multi-tenant SaaS

### Scenario: Tenant-Specific Subdomains

**Goal**: Route different customer subdomains to appropriate services.

#### Configuration:
```json
{
  "apps": [
    {
      "host": "acme-corp.saas.company.com",
      "preserveHost": true,
      "upstream": {
        "protocol": "http",
        "host": "tenant-service",
        "port": 3000
      },
      "healthUrl": "http://tenant-service:3000/health"
    },
    {
      "host": "widgets-inc.saas.company.com",
      "preserveHost": true, 
      "upstream": {
        "protocol": "http",
        "host": "tenant-service",
        "port": 3000
      },
      "healthUrl": "http://tenant-service:3000/health"
    },
    {
      "host": "admin.saas.company.com",
      "preserveHost": true,
      "upstream": {
        "protocol": "http",
        "host": "admin-service",
        "port": 3001
      },
      "healthUrl": "http://admin-service:3001/health"
    }
  ]
}
```

#### Backend Service Implementation:
```javascript
app.use((req, res, next) => {
  // Extract tenant from Host header
  const host = req.headers.host;
  const tenant = host.split('.')[0];
  
  if (tenant === 'admin') {
    req.isAdmin = true;
  } else {
    req.tenant = tenant;
  }
  
  next();
});

app.get('/dashboard', (req, res) => {
  if (req.isAdmin) {
    res.render('admin-dashboard');
  } else {
    res.render('tenant-dashboard', { tenant: req.tenant });
  }
});
```

## 🧪 Development Testing

### Scenario: Test External API Behavior Internally

**Goal**: Simulate external API calls to test error handling and network behavior.

#### Configuration:
```json
{
  "apps": [
    {
      "host": "internal-api.test.com",
      "cwd": "c:/services/api",
      "start": "npm start",
      "port": 3000
    },
    {
      "host": "external-api.test.com",
      "preserveHost": true,
      "upstream": {
        "protocol": "https",
        "host": "internal-api.test.com",
        "port": 4443,
        "rejectUnauthorized": false
      },
      "healthUrl": "https://internal-api.test.com:4443/health"
    }
  ]
}
```

#### Test Implementation:
```javascript
// Simulate external API call
async function callExternalAPI() {
  try {
    // This will loop through the gateway, simulating network behavior
    const response = await fetch('https://external-api.test.com/data');
    return await response.json();
  } catch (error) {
    console.error('External API call failed:', error);
    throw error;
  }
}

// Test error scenarios
async function testNetworkFailures() {
  // Temporarily disable health endpoint to simulate failures
  // Test retry logic, circuit breakers, etc.
}
```

#### Benefits:
- ✅ Test network failure scenarios
- ✅ Simulate SSL handshake delays
- ✅ Test redirect handling
- ✅ Verify header manipulation

## 🔧 Advanced Configurations

### Custom Headers and Security
```json
{
  "host": "secure.company.com",
  "upstream": {
    "protocol": "https",
    "host": "backend.internal",
    "port": 3000,
    "headers": {
      "X-Custom-Header": "value",
      "Authorization": "Bearer secret-token"
    }
  }
}
```

### WebSocket Proxying
```json
{
  "host": "realtime.company.com",
  "upstream": {
    "protocol": "http",
    "host": "websocket-service",
    "port": 3001
  }
}
```

**Client Usage**:
```javascript
const ws = new WebSocket('wss://realtime.company.com/socket');
ws.onmessage = (event) => {
  console.log('Received:', event.data);
};
```

## 📊 Monitoring and Debugging

### Health Check Endpoints
Add to your backend services:
```javascript
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    version: process.env.npm_package_version
  });
});
```

### Debug Logging
```bash
# Enable detailed gateway logging
set DEBUG=gateway:*
node gateway.js
```

### Certificate Monitoring
```bash
# Check certificate expiration
node -e "
const fs = require('fs');
const cert = fs.readFileSync('./storage/domain.com.crt', 'utf8');
const x509 = require('crypto').X509Certificate || require('node:crypto').X509Certificate;
const c = new x509(cert);
console.log('Expires:', c.validTo);
"
```

This comprehensive guide covers the most common usage scenarios for the Node.js Gateway. Each example can be adapted to your specific needs and combined to create complex routing architectures.
