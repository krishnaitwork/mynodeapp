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

const crtFiles = fs.readdirSync(storeDir).filter(f => f.toLowerCase().endsWith('.crt'));
if (crtFiles.length === 0) {
  console.log('No .crt files found in', storeDir);
  process.exit(0);
}

console.log('Importing certificates from', storeDir);

for (const crt of crtFiles) {
  const full = path.join(storeDir, crt);
  console.log('- Processing', full);

  // PowerShell script: remove existing certs with same Subject in CurrentUser\Root, then import
  // Use a script block with a single-quoted path to avoid interpolation/parsing issues
  const safePath = full.replace(/'/g, "''");
  const ps = `& {
    try {
      $path = '${safePath}'
      $cert = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2($path)
      $subject = $cert.Subject
      Write-Output "Certificate subject: $subject"
      $existing = Get-ChildItem Cert:\\CurrentUser\\Root | Where-Object { $_.Subject -eq $subject }
      foreach ($e in $existing) {
        Write-Output "Removing existing certificate: $($e.Thumbprint)  $($e.Subject)"
        Remove-Item -Path ("Cert:\\CurrentUser\\Root\\" + $e.Thumbprint) -ErrorAction Stop
      }
  Write-Output "Importing: $path"
  # Use certutil to import into CurrentUser store without UI prompts
  $add = & certutil -user -addstore Root $path 2>&1
  Write-Output $add
  Write-Output "Imported: $path"
    } catch {
      Write-Error ("Failed to import {0}: {1}" -f $path, $_.Exception.Message)
      exit 1
    }
  }`;

  const res = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
  if (res.stdout) process.stdout.write(res.stdout);
  if (res.stderr) process.stderr.write(res.stderr);
  if (res.error) console.error('spawn error', res.error);
  if (res.status !== 0) {
    console.error('PowerShell command failed for', full);
  }
}

console.log('Done.');
