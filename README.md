# Node.js Gateway - Enterprise-Grade Reverse Proxy

A production-ready HTTPS gateway that provides nginx-like functionality with automatic SSL certificate management, process supervision, and advanced routing capabilities.

## 🚀 Features

### Core Capabilities
- **SNI-based HTTPS termination** - Different certificates per domain
- **Automatic SSL management** - Let's Encrypt + self-signed fallback
- **Reverse proxy** - Route domains to internal services
- **Process supervision** - Auto-start and restart backend applications
- **Static file serving** - SPA support with fallback routing
- **WebSocket proxying** - Full bidirectional WebSocket support
- **Health checking** - Ensure backends are ready before routing
- **Header rewriting** - Fix Location and Set-Cookie headers automatically

### Advanced Features
- **Cross-domain authentication flows** - Support complex auth redirects
- **Internal redirect testing** - Simulate external API calls internally
- **Windows certificate integration** - Export and import SSL certificates
- **Development-friendly** - Hot reload, detailed logging, graceful shutdown

## 📁 Project Structure

```
mynodeapp/
├── gateway/
│   ├── gateway.js                 # Main gateway server
│   ├── gateway.config.json        # Configuration file
│   ├── storage/                   # SSL certificates storage
│   ├── import-currentuser-certs.js # Windows cert import utility
│   └── regenerate-selfsigned.js   # Certificate generation utility
├── apps/
│   ├── app1/                      # Sample application (image server)
│   ├── app2/                      # Sample application (auth provider)
│   ├── app3/                      # Sample application (API server)
│   └── app4/                      # Sample application (backend service)
└── README.md                      # This file
```

## 🛠 Installation & Setup

### Prerequisites
- Node.js 18+ (ES modules support)
- Windows 10/11 (for certificate features)
- Administrator access (for port 443 binding or port forwarding)

### 1. Install Dependencies
```bash
cd gateway
npm install
```

### 2. Configure Applications
Edit `gateway/gateway.config.json` to define your applications:

```json
{
  "email": "your-email@domain.com",
  "agreeToTerms": true,
  "acme": {
    "directoryUrl": "https://acme-v02.api.letsencrypt.org/directory",
    "configDir": "./storage"
  },
  "apps": [
    {
      "host": "local.console",
      "cwd": "c:/path/to/your/app",
      "start": "npm start",
      "healthUrl": "http://127.0.0.1:3000/health",
      "port": 3000
    }
  ]
}
```

### 3. Start the Gateway
```bash
cd gateway
node gateway.js
```

## 📝 Configuration Guide

### Basic Application Configuration

```json
{
  "host": "app.example.com",           // Public domain
  "altNames": ["app.example.com"],     // Alternative names (for SSL SAN)
  "preserveHost": false,               // Forward original Host header
  "cwd": "c:/path/to/app",            // Working directory
  "start": "npm start",                // Start command
  "healthUrl": "http://127.0.0.1:3000/health",  // Health check URL
  "port": 3000                         // Backend port
}
```

### Advanced Proxy Configuration

```json
{
  "host": "api.example.com",
  "preserveHost": true,                // Send original Host to backend
  "upstream": {
    "protocol": "https",               // Backend protocol
    "host": "internal-api.company.com", // Backend hostname
    "port": 443,                       // Backend port
    "rejectUnauthorized": false        // Accept self-signed certs
  },
  "healthUrl": "https://internal-api.company.com/health"
}
```

### Static File Serving

```json
{
  "host": "spa.example.com",
  "staticDir": "C:/path/to/built/spa",  // Serve static files
  "preserveHost": false
}
```

## 🔧 Usage Scenarios

### 1. Local Development Environment

**Scenario**: Develop multiple services locally with custom domains

```json
{
  "apps": [
    {
      "host": "app.local.dev",
      "cwd": "c:/projects/frontend",
      "start": "npm run dev",
      "port": 3000
    },
    {
      "host": "api.local.dev", 
      "cwd": "c:/projects/backend",
      "start": "npm start",
      "port": 3001
    }
  ]
}
```

**Benefits**:
- Access via `https://app.local.dev` and `https://api.local.dev`
- Automatic SSL certificates
- Cross-origin requests work properly
- Services auto-restart on crash

### 2. Production Proxy

**Scenario**: Route public domains to internal services

```json
{
  "apps": [
    {
      "host": "api.company.com",
      "preserveHost": true,
      "upstream": {
        "protocol": "http",
        "host": "127.0.0.1",
        "port": 8080
      }
    }
  ]
}
```

**Benefits**:
- Public domain with automatic Let's Encrypt SSL
- Internal service runs on non-privileged port
- Health checking ensures reliability

### 3. External Service Proxying

**Scenario**: Proxy to external APIs with custom domains

```json
{
  "apps": [
    {
      "host": "external.yourcompany.com",
      "preserveHost": true,
      "upstream": {
        "protocol": "https",
        "host": "api.external-service.com",
        "port": 443,
        "rejectUnauthorized": true
      }
    }
  ]
}
```

**Benefits**:
- Custom branding for external APIs
- SSL termination and re-encryption
- Header manipulation and security

### 4. Internal Redirect Testing

**Scenario**: Test external API behavior internally

```json
{
  "apps": [
    {
      "host": "app.production.com",
      "port": 3000
    },
    {
      "host": "api.production.com",
      "upstream": {
        "protocol": "https",
        "host": "app.production.com",
        "port": 4443
      }
    }
  ]
}
```

**Benefits**:
- Simulate network hops and SSL handshakes
- Test redirect loops and header handling
- Reproduce production issues locally

### 5. Multi-tenant Architecture

**Scenario**: Different subdomains for different customers

```json
{
  "apps": [
    {
      "host": "tenant1.saas.com",
      "upstream": { "host": "127.0.0.1", "port": 3001 }
    },
    {
      "host": "tenant2.saas.com", 
      "upstream": { "host": "127.0.0.1", "port": 3002 }
    },
    {
      "host": "admin.saas.com",
      "upstream": { "host": "127.0.0.1", "port": 3000 }
    }
  ]
}
```

## 🌐 SSL Certificate Management

### Automatic Let's Encrypt
- Certificates automatically obtained for public domains
- HTTP-01 challenge method via port 80
- Automatic renewal before expiration
- Certificates saved to `gateway/storage/`

### Self-Signed Fallback
- Local domains (`.local`, `.console`) use self-signed certificates
- 2048-bit RSA keys with SHA-256 signatures
- Subject Alternative Names (SAN) support
- Exported as `.crt` and `.key` files

### Windows Integration
```bash
# Import certificates to Windows trusted store
node import-currentuser-certs.js

# Generate new self-signed certificates
node regenerate-selfsigned.js
```

### Certificate Files
```
gateway/storage/
├── domain.com.crt          # Certificate file
├── domain.com.key          # Private key
└── domain.com_selfsigned.json  # Cache file
```

## 🚪 Port Configuration

### Development Setup (Default)
```
HTTP:  127.0.0.1:8080  (ACME challenges + redirect to HTTPS)
HTTPS: 127.0.0.1:4443  (Main gateway)
```

Access: `https://local.console:4443`

### Production Setup (Port 443)

**Option 1: Port Forwarding (Recommended)**
```cmd
# Run as Administrator
netsh interface portproxy add v4tov4 listenport=443 listenaddress=0.0.0.0 connectport=4443 connectaddress=127.0.0.1
netsh interface portproxy add v4tov4 listenport=80 listenaddress=0.0.0.0 connectport=8080 connectaddress=127.0.0.1
```

**Option 2: Environment Variables**
```cmd
set HTTP_PORT=80
set HTTPS_PORT=443
node gateway.js
```

Access: `https://local.console` (standard port)

## 🔄 Advanced Routing Features

### Host Header Preservation
```json
{
  "preserveHost": true   // Backend sees original Host header
}
```

**Use cases**:
- Multi-tenant applications
- Domain-based routing in backends
- SEO and analytics tracking

### Response Header Rewriting
The gateway automatically rewrites:
- **Location headers**: Internal redirects become public URLs
- **Set-Cookie Domain**: Removes domain restrictions
- **Callback URLs**: Injects correct ports for auth flows

### WebSocket Support
WebSockets are automatically proxied with the same routing rules:
```javascript
// Client connects to gateway
const ws = new WebSocket('wss://app.example.com/websocket');
// Gateway forwards to backend WebSocket server
```

## 🔐 Authentication Flow Example

The gateway supports complex authentication patterns:

```
1. Browser → https://app.company.com/protected
2. App redirects → https://auth.company.com/login?callback=...
3. Auth service → validates user → redirects back with token
4. App → receives callback → serves protected content
```

Configuration:
```json
{
  "apps": [
    {
      "host": "app.company.com",
      "port": 3000
    },
    {
      "host": "auth.company.com",
      "port": 3001
    }
  ]
}
```

## 🔧 Troubleshooting

### Common Issues

**1. Port 443 Already in Use**
```bash
# Check what's using port 443
netstat -ano | findstr :443

# Stop IIS if running
iisreset /stop

# Or use port forwarding instead
```

**2. SSL Certificate Errors**
```bash
# Regenerate self-signed certificates
node regenerate-selfsigned.js

# Check certificate validity
node -e "console.log(require('fs').readFileSync('./storage/domain.crt', 'utf8'))"
```

**3. Backend Health Check Failures**
- Ensure backend service is running
- Check `healthUrl` is accessible
- Verify port numbers in configuration

**4. DNS Resolution**
Add to `C:\Windows\System32\drivers\etc\hosts`:
```
127.0.0.1 local.console
127.0.0.1 app.local.console
```

### Debug Mode
```bash
# Enable detailed logging
set DEBUG=gateway:*
node gateway.js
```

## 📊 Performance & Production

### Recommendations
- Use PM2 for process management in production
- Enable compression middleware for static content
- Implement rate limiting for public APIs
- Monitor certificate expiration dates
- Set up log rotation and monitoring

### Security Considerations
- Validate callback URLs in authentication flows
- Implement CORS policies for cross-origin requests
- Use strong certificate validation for external upstreams
- Regular security updates for dependencies

### Scaling
- Multiple gateway instances behind a load balancer
- Shared certificate storage (Redis/Database)
- Health check endpoints for monitoring
- Metrics collection and alerting

## 🔗 API Reference

### Health Check Endpoint
```
GET /_health
Response: { "status": "ok", "uptime": 12345 }
```

### Certificate Info
```
GET /_certs
Response: { "domains": ["app.com"], "expiry": "2024-01-01" }
```

## 📈 Monitoring & Logging

### Built-in Logging
- Process start/stop events
- Certificate generation/renewal
- Health check failures
- Proxy errors and redirects

### Custom Monitoring
```javascript
// Add custom middleware for metrics
app.use((req, res, next) => {
  console.log(`${req.method} ${req.url} - ${req.headers.host}`);
  next();
});
```

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test with multiple domains and scenarios
5. Submit a pull request

## 📄 License

MIT License - see LICENSE file for details

## 🆘 Support

For issues and questions:
1. Check the troubleshooting section
2. Review the configuration examples
3. Enable debug logging
4. Create an issue with detailed logs

---

**This gateway provides enterprise-grade reverse proxy capabilities comparable to nginx, AWS ALB, or Cloudflare Workers, but with the simplicity of Node.js and automatic SSL management.**
