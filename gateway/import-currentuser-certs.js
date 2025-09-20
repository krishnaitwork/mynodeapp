import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cfgPath = path.join(__dirname, 'gateway.config.json');
if (!fs.existsSync(cfgPath)) {
  console.error('gateway.config.json not found next to this script');
  process.exit(1);
}
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
const storeDir = path.resolve(__dirname, cfg.acme?.configDir || './storage');

if (!fs.existsSync(storeDir)) {
  console.error('Storage directory not found:', storeDir);
  process.exit(1);
}

// Get domains from config to limit certificate operations to only configured domains
const configDomains = new Set();
for (const app of cfg.apps) {
  if (app.host) configDomains.add(app.host.toLowerCase());
  if (app.altNames && Array.isArray(app.altNames)) {
    for (const alt of app.altNames) configDomains.add(alt.toLowerCase());
  }
}

console.log('Configured domains:', Array.from(configDomains).join(', '));

// Only process certificate files for domains that are actually in the config
const allCrtFiles = fs.readdirSync(storeDir).filter(f => f.toLowerCase().endsWith('.crt'));

// Helper: consider domains like .local, local., localhost, .console as local environment
function isLocalDomain(d) {
  if (!d) return false;
  const s = d.toLowerCase();
  return s.includes('.local') || s.includes('local.') || s.includes('localhost') || s.includes('.console');
}

// If all configured domains are local-like, prefer a single combined cert (local-combined.crt)
const allLocal = Array.from(configDomains).length > 0 && Array.from(configDomains).every(isLocalDomain);
let crtFiles = [];
if (allLocal) {
  const combinedName = 'local-gateway.crt';
  if (allCrtFiles.includes(combinedName)) {
    crtFiles = [combinedName];
  } else {
    // Fallback: if combined cert not present, try to match any configured domains as before
    crtFiles = allCrtFiles.filter(f => {
      const domain = f.replace(/\.crt$/i, '').toLowerCase();
      return configDomains.has(domain);
    });
  }
} else {
  crtFiles = allCrtFiles.filter(f => {
    const domain = f.replace(/\.crt$/i, '').toLowerCase();
    return configDomains.has(domain);
  });
}

if (crtFiles.length === 0) {
  console.log('No .crt files found for configured domains in', storeDir);
  console.log('Available .crt files:', allCrtFiles.join(', ') || '(none)');
  process.exit(0);
}

console.log('Importing certificates for configured domains from', storeDir);
console.log('Processing files:', crtFiles.join(', '));

// Phase 1: read CN and SANs from certificate files for configured domains only
const targets = [];
for (const crt of crtFiles) {
  const full = path.join(storeDir, crt);
  console.log('- Reading', full);

  const safePath = full.replace(/'/g, "''");
  const psRead = `& {
    try {
      $path = '${safePath}'
      $cert = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2($path)
      $cn = $cert.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false)
      $sans = $null
      try {
        $ext = $cert.Extensions | Where-Object { $_.Oid.Value -eq '2.5.29.17' }
        if ($ext) { $sans = $ext.Format($true) }
      } catch {}
      Write-Output "CERT_CN::$cn"
      Write-Output "CERT_SANS::$sans"
    } catch {
      Write-Error ("Failed to read certificate {0}: {1}" -f $path, $_.Exception.Message)
      exit 1
    }
  }`;

  const readRes = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psRead], { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
  if (readRes.error) console.error('spawn error', readRes.error);
  if (readRes.stderr) process.stderr.write(readRes.stderr);
  const out = (readRes.stdout || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  let certCN = null;
  let certSANsRaw = null;
  for (const line of out) {
    if (line.startsWith('CERT_CN::')) certCN = line.replace('CERT_CN::', '').trim();
    if (line.startsWith('CERT_SANS::')) certSANsRaw = line.replace('CERT_SANS::', '').trim();
    if (line.startsWith('Failed to read certificate')) console.error(line);
  }

  const dnsNames = [];
  if (certSANsRaw) {
    const dnsRe = /DNS Name=([^,\n\r]+)/g;
    let m;
    while ((m = dnsRe.exec(certSANsRaw)) !== null) dnsNames.push(m[1].trim());
  }

  targets.push({ file: full, cn: certCN, dns: dnsNames });
}

console.log('\nTargets to process:');
for (const t of targets) console.log('-', path.basename(t.file), 'CN=', t.cn, 'SANs=', t.dns.join(',') || '(none)');

// Phase 2: list store entries and compute deletions for any target CN/SAN
console.log('\nScanning CurrentUser Root store for existing matching certificates...');
console.log('Will only match certificates for these configured domains:', Array.from(configDomains).join(', '));
const listRes = spawnSync('certutil.exe', ['-user', '-store', 'Root'], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
if (listRes.error) console.error('certutil spawn error', listRes.error);
if (listRes.stderr) process.stderr.write(listRes.stderr);
const listOut = listRes.stdout || '';

const entries = [];
const lines = listOut.split(/\r?\n/);
let current = {};
for (const line of lines) {
  const tmatch = line.match(/Cert Hash\(sha1\):\s*([0-9A-Fa-f]+)/);
  if (tmatch) {
    if (current.thumbprint) entries.push(current);
    current = { thumbprint: tmatch[1], subject: '' };
    continue;
  }
  const smatch = line.match(/^\s*Subject:\s*(.*)$/);
  if (smatch && current) {
    current.subject = smatch[1].trim();
  }
}
if (current.thumbprint) entries.push(current);

console.log(`\nFound ${entries.length} certificates in CurrentUser Root store`);
console.log('Certificate subjects found:');
for (const e of entries) {
  if (e.subject) console.log(`  - ${e.subject.substring(0, 80)}${e.subject.length > 80 ? '...' : ''}`);
}

const toDelete = new Set();
for (const e of entries) {
  if (!e.subject) continue;
  for (const t of targets) {
    // Only delete if CN matches exactly (and is in configured domains)
    if (t.cn && configDomains.has(t.cn.toLowerCase()) && e.subject.includes(`CN=${t.cn}`)) {
      console.log(`Match found for CN: ${t.cn} in subject: ${e.subject}`);
      toDelete.add(e.thumbprint);
    }
    
    // For SAN matching, be more precise - match DNS names in certificate extensions, not subject string
    for (const dns of t.dns) {
      if (dns && configDomains.has(dns.toLowerCase())) {
        // More precise matching: look for exact CN match or check if it's a SAN-based cert
        if (e.subject.includes(`CN=${dns}`) || 
            (t.cn === dns && e.subject.includes(`CN=${t.cn}`))) {
          console.log(`Match found for SAN DNS: ${dns} in subject: ${e.subject}`);
          toDelete.add(e.thumbprint);
        }
      }
    }
  }
}

if (toDelete.size === 0) console.log('No existing matching certificates found.');
else {
  console.log('Will remove the following existing certificates:');
  for (const thumb of toDelete) console.log('-', thumb);
}

// Phase 3: delete matching entries first
for (const thumb of toDelete) {
  console.log('Removing existing certificate (via certutil):', thumb);
  const delRes = spawnSync('certutil.exe', ['-user', '-delstore', 'Root', thumb], { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
  if (delRes.stdout) process.stdout.write(delRes.stdout);
  if (delRes.stderr) process.stderr.write(delRes.stderr);
  if (delRes.error) console.error('certutil delete error', delRes.error);
  if (delRes.status !== 0) console.error('certutil delete failed for', thumb);
}

// Phase 4: import all certificate files (after deletions)
console.log('\nImporting certificate files...');
for (const t of targets) {
  console.log('- Importing', t.file);
  const certutilRes = spawnSync('certutil.exe', ['-user', '-addstore', 'Root', t.file], { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
  if (certutilRes.stdout) process.stdout.write(certutilRes.stdout);
  if (certutilRes.stderr) process.stderr.write(certutilRes.stderr);
  if (certutilRes.error) console.error('certutil spawn error', certutilRes.error);
  if (certutilRes.status !== 0) {
    console.error('certutil failed for', t.file);
  }
}

console.log('Done.');
