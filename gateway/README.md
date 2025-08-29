# Node.js HTTPS Gateway with Let's Encrypt

A powerful Node.js reverse proxy gateway that provides HTTPS termination, automatic SSL certificate management, and app supervision for multiple applications.

## 🚀 Features

- **HTTPS Termination**: Automatic SSL/TLS with Let's Encrypt certificates
- **Reverse Proxy**: Route subdomains to different local applications
- **Auto-Scaling**: Automatic app restart on crashes
- **Health Checks**: Monitor app health before proxying requests
- **SNI Support**: Multiple certificates for different domains
- **Self-Signed Fallback**: Automatic fallback for local development
- **Certificate Export**: Generate `.crt` and `.key` files for external use
- **Graceful Shutdown**: Clean process management

## 📁 Project Structure

```
c:/KP/Git/nodejs/mynodeapp/
├── gateway/
│   ├── package.json
│   ├── gateway.config.json    # Configuration file
│   ├── gateway.js             # Main gateway server
│   └── storage/               # Certificate storage
│       ├── localhost.crt/.key
│       ├── app1.domain.crt/.key
│       └── app2.domain.crt/.key
└── apps/
    ├── app1/                  # Your first application
    │   ├── package.json
    │   └── server.js
    └── app2/                  # Your second application
        ├── package.json
        └── server.js
```

## ⚙️ Configuration

### gateway.config.json

```json
{
  "email": "your-email@example.com",
  "agreeToTerms": true,
  "acme": {
    "mode": "http-01",
    "directoryUrl": "https://acme-v02.api.letsencrypt.org/directory",
    "packageRoot": ".",
    "configDir": "./storage"
  },
  "apps": [
    {
      "host": "app1.yourdomain.com",
      "cwd": "/path/to/app1",
      "start": "npm start",
      "healthUrl": "http://127.0.0.1:3000/health",
      "port": 3000
    }
  ]
}
```

### Configuration Options

| Field | Description | Required |
|-------|-------------|----------|
| `email` | Your email for Let's Encrypt | Yes |
| `agreeToTerms` | Accept Let's Encrypt terms | Yes |
| `acme.mode` | Challenge type (http-01) | Yes |
| `acme.directoryUrl` | Let's Encrypt API URL | Yes |
| `apps[].host` | Subdomain for the app | Yes |
| `apps[].cwd` | Working directory | Yes |
| `apps[].start` | Start command | Yes |
| `apps[].healthUrl` | Health check endpoint | No |
| `apps[].port` | Local port | Yes |

## 🛠️ Setup Instructions

### 1. Install Dependencies

```bash
cd gateway
npm install
```

### 2. Configure DNS

For production, set up DNS records:
- `A` record: `yourdomain.com` → your server IP
- `A` or `CNAME` records for each subdomain:
  - `app1.yourdomain.com` → your server IP
  - `app2.yourdomain.com` → your server IP

For local development, add to your `hosts` file:
```
127.0.0.1    app1.localhost
127.0.0.1    app2.localhost
```

### 3. Start the Gateway

```bash
# For production (requires admin privileges)
sudo node gateway.js

# For development (use different ports)
# Edit gateway.js to change ports from 80/443 to 8080/8443
node gateway.js
```

## ➕ Adding a New Application

### Step 1: Create Your App Directory

```bash
mkdir -p ../apps/app3
cd ../apps/app3
```

### Step 2: Create Your Application

Create a simple Node.js server:

```javascript
// server.js
const http = require('http');

const server = http.createServer((req, res) => {
  // Health check endpoint
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('OK');
    return;
  }

  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Hello from App 3!');
});

server.listen(3002, () => {
  console.log('App 3 listening on port 3002');
});
```

### Step 3: Update Gateway Configuration

Edit `gateway.config.json` and add your new app:

```json
{
  "email": "your-email@example.com",
  "agreeToTerms": true,
  "acme": {
    "mode": "http-01",
    "directoryUrl": "https://acme-v02.api.letsencrypt.org/directory",
    "packageRoot": ".",
    "configDir": "./storage"
  },
  "apps": [
    {
      "host": "app1.yourdomain.com",
      "cwd": "c:/KP/Git/nodejs/mynodeapp/apps/app1",
      "start": "node server.js",
      "healthUrl": "http://127.0.0.1:3000/health",
      "port": 3000
    },
    {
      "host": "app2.yourdomain.com",
      "cwd": "c:/KP/Git/nodejs/mynodeapp/apps/app2",
      "start": "npm start",
      "healthUrl": "http://127.0.0.1:3001/health",
      "port": 3001
    },
    {
      "host": "app3.yourdomain.com",
      "cwd": "c:/KP/Git/nodejs/mynodeapp/apps/app3",
      "start": "node server.js",
      "healthUrl": "http://127.0.0.1:3002/health",
      "port": 3002
    }
  ]
}
```

### Step 4: Update DNS (Production)

Add DNS record for your new subdomain:
- `app3.yourdomain.com` → your server IP

### Step 5: Restart Gateway

```bash
# Stop the current gateway (Ctrl+C)
# Then restart
node gateway.js
```

## 🌐 API Documentation with Swagger

App 3 includes a comprehensive REST API with interactive Swagger UI documentation. This allows you to:

- **Test API endpoints** directly from your browser
- **View API specifications** in OpenAPI 3.0 format
- **Explore request/response schemas**
- **Execute API calls** with the "Try it out" feature

### Swagger UI Access

Once the gateway is running, access Swagger UI at:
- **Local Development**: `https://api.local.console:4443/api-docs`
- **Production**: `https://api.yourdomain.com/api-docs`

### Example API Endpoints

The API includes the following endpoints:

#### Users API
- `GET /api/users` - Get all users
- `GET /api/users/{id}` - Get user by ID
- `POST /api/users` - Create new user
- `PUT /api/users/{id}` - Update user
- `DELETE /api/users/{id}` - Delete user

#### Products API
- `GET /api/products` - Get all products
- `POST /api/products` - Create new product

### Testing the API

#### Using Swagger UI
1. Navigate to `/api-docs`
2. Click on any endpoint
3. Click "Try it out"
4. Fill in the request parameters
5. Click "Execute"

#### Using the Test Script
```bash
cd apps/app3
npm run test:api
```

#### Manual Testing
```bash
# Health check
curl -k https://api.local.console:4443/health

# Get users
curl -k https://api.local.console:4443/api/users

# Create user
curl -k -X POST https://api.local.console:4443/api/users \
  -H "Content-Type: application/json" \
  -d '{"name":"John Doe","email":"john@example.com"}'
```

### API Features

- ✅ **OpenAPI 3.0** specification
- ✅ **Interactive documentation**
- ✅ **Request validation**
- ✅ **Error handling**
- ✅ **CORS support**
- ✅ **JSON responses**
- ✅ **Health monitoring**

## 🔒 Certificate Management

### Automatic Certificate Generation

The gateway automatically:
- Generates Let's Encrypt certificates for production domains
- Falls back to self-signed certificates for local domains
- Renews certificates before expiration
- Saves certificates in `.crt` and `.key` format

### Certificate Files

Certificates are stored in `storage/` directory:
- `{domain}.crt` - Certificate file
- `{domain}.key` - Private key file
- `{domain}_selfsigned.json` - Cache file

### Using Certificates Elsewhere

#### Windows Certificate Manager
1. Open `certmgr.msc`
2. Right-click "Trusted Root Certification Authorities"
3. All Tasks → Import
4. Select `.crt` file from storage directory

#### Convert to PFX (for IIS/other Windows services)
```powershell
cd storage
openssl pkcs12 -export -out certificate.pfx -inkey domain.key -in domain.crt
```

## 🔍 Health Checks

Add health check endpoints to your applications:

```javascript
// In your app's server.js
app.get('/health', (req, res) => {
  res.status(200).send('OK');
});
```

The gateway will:
- Wait for health checks to pass before proxying
- Restart apps that become unhealthy
- Provide status information

## 🚨 Troubleshooting

### Port Conflicts
If you get "address already in use" errors:
```bash
# Kill existing processes
pkill -f "node gateway.js"

# Or find and kill specific process
ps aux | grep "node gateway.js"
kill -9 <PID>
```

### Certificate Issues
```bash
# Clear certificate cache
rm -rf storage/
mkdir storage/

# Restart gateway
node gateway.js
```

### Permission Issues (Linux/Mac)
```bash
# For ports 80/443
sudo node gateway.js

# Or grant capabilities (Linux)
sudo setcap 'cap_net_bind_service=+ep' $(which node)
```

### Windows Issues
- Run PowerShell as Administrator for ports 80/443
- Or modify `gateway.js` to use ports 8080/8443

## 📊 Monitoring

The gateway provides console output for:
- Server startup status
- Certificate generation
- App health status
- Proxy requests
- Error conditions

## 🔄 Process Management

The gateway automatically:
- Starts all configured applications
- Monitors app processes
- Restarts crashed applications
- Handles graceful shutdown (Ctrl+C)
- Cleans up child processes

## 🌐 Production Deployment

### Systemd Service (Linux)
Create `/etc/systemd/system/gateway.service`:

```ini
[Unit]
Description=Node.js Gateway
After=network.target

[Service]
Type=simple
User=your-user
WorkingDirectory=/path/to/gateway
ExecStart=/usr/bin/node gateway.js
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable gateway
sudo systemctl start gateway
```

### PM2 (Cross-platform)
```bash
npm install -g pm2
pm2 start gateway.js --name "gateway"
pm2 save
pm2 startup
```

## 📝 API Endpoints

The gateway exposes:
- `http://your-server:80/` - HTTP redirect to HTTPS
- `https://app1.yourdomain.com/` - Your first app
- `https://app2.yourdomain.com/` - Your second app

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Test thoroughly
5. Submit a pull request

## 📄 License

MIT License - feel free to use in your projects!

---

**Need Help?** Check the troubleshooting section or create an issue with your specific error message.

## ✅ Local dev: regenerate, import and run (quick commands)

If you're developing locally and using hostnames like `local.console`, `app.local.console`, `api.local.console`, follow these steps to regenerate SAN-enabled self-signed certs, import them into the CurrentUser Trusted Root, and start the gateway.

1) (Optional) Add hostnames to your hosts file (requires admin):

```powershell
# Run PowerShell as Administrator
Add-Content -Path C:\Windows\System32\drivers\etc\hosts -Value "127.0.0.1 local.console"
Add-Content -Path C:\Windows\System32\drivers\etc\hosts -Value "127.0.0.1 app.local.console"
Add-Content -Path C:\Windows\System32\drivers\etc\hosts -Value "127.0.0.1 api.local.console"
```

2) Regenerate self-signed certs with SAN DNS entries:

```powershell
cd C:\KP\Git\nodejs\mynodeapp\gateway
node regenerate-selfsigned.js
```

3) Import the regenerated `.crt` files into CurrentUser Trusted Root (removes existing certs with same Subject first):

```powershell
npm run import-currentuser-certs
# or: node import-currentuser-certs.js
```

4) Start the gateway (uses per-host certs via SNI):

```powershell
npm start
# or: node gateway.js
```

5) Verify in browser:

- Open: https://local.console:4443 (or the hostname you configured)
- If you changed to port 443, use that instead.

Verification commands:

```powershell
# List imported certs matching the host
Get-ChildItem Cert:\CurrentUser\Root | Where-Object { $_.Subject -like '*local.console*' } | Format-List Subject,Thumbprint,NotAfter

# Inspect SAN inside a cert file
certutil -dump .\storage\local.console.crt | Select-String -Pattern "Subject Alternative Name","CN="
```

Notes:
- Firefox may use its own trust store; import there separately if needed.
- Importing into `LocalMachine` store requires elevation; CurrentUser avoids admin.
- If the browser still warns, restart the browser after import.

