import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import selfsigned from 'selfsigned';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cfgPath = path.join(__dirname, 'gateway.config.json');
if (!fs.existsSync(cfgPath)) {
  console.error('gateway.config.json not found');
  process.exit(1);
}
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
const storeDir = path.resolve(__dirname, cfg.acme?.configDir || './storage');
fs.mkdirSync(storeDir, { recursive: true });

function generate(hostname) {
  const certPath = path.join(storeDir, `${hostname}.crt`);
  const keyPath = path.join(storeDir, `${hostname}.key`);
  const jsonPath = path.join(storeDir, `${hostname}_selfsigned.json`);

  const attrs = [{ name: 'commonName', value: hostname }];
  const extensions = [{
    name: 'subjectAltName',
    altNames: [{ type: 2, value: hostname }]
  }];
  const pems = selfsigned.generate(attrs, { days: 1365, extensions });

  fs.writeFileSync(certPath, pems.cert);
  fs.writeFileSync(keyPath, pems.private);
  fs.writeFileSync(jsonPath, JSON.stringify({ cert: pems.cert, key: pems.private }));
  console.log(`Regenerated self-signed cert for ${hostname} -> ${certPath}`);
}

for (const app of cfg.apps || []) {
  const host = (app.host || '').toLowerCase();
  if (!host) continue;
  if (host.includes('.local') || host.includes('localhost') || host.includes('.console')) {
    generate(host);
  }
}

console.log('Done.');
