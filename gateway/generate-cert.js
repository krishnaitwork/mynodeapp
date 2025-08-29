#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import selfsigned from 'selfsigned';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cfgPath = path.join(__dirname, 'gateway.config.json');
if (!fs.existsSync(cfgPath)) {
  console.error('gateway.config.json not found next to this script');
  process.exit(1);
}
const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
const storeDir = path.resolve(__dirname, cfg.acme?.configDir || './storage');
fs.mkdirSync(storeDir, { recursive: true });

const customCfgPath = path.join(__dirname, 'custom-certs.json');
if (!fs.existsSync(customCfgPath)) {
  console.error('custom-certs.json not found. Copy custom-certs.json.example and edit it to define domains to generate.');
  process.exit(1);
}
const custom = JSON.parse(fs.readFileSync(customCfgPath, 'utf8'));
const entries = Array.isArray(custom) ? custom : (custom.entries || []);
if (!entries.length) {
  console.error('No entries found in custom-certs.json');
  process.exit(1);
}

// CLI: optional domain filter
const argDomain = process.argv[2] && process.argv[2].toLowerCase();
const selected = argDomain ? entries.filter(e => (e.domain || '').toLowerCase() === argDomain) : entries;
if (!selected.length) {
  console.error(argDomain ? `No matching entry for domain: ${argDomain}` : 'No entries selected');
  process.exit(1);
}

function writeCert(domain, certPem, keyPem) {
  const certPath = path.join(storeDir, `${domain}.crt`);
  const keyPath = path.join(storeDir, `${domain}.key`);
  const jsonPath = path.join(storeDir, `${domain}_selfsigned.json`);
  fs.writeFileSync(certPath, certPem);
  fs.writeFileSync(keyPath, keyPem);
  fs.writeFileSync(jsonPath, JSON.stringify({ cert: certPem, key: keyPem }));
  console.log(`Generated: ${certPath}`);
}

for (const e of selected) {
  const domain = (e.domain || '').toLowerCase();
  if (!domain) continue;
  const altNames = Array.isArray(e.altNames) && e.altNames.length ? e.altNames : [domain];
  const attrs = [{ name: 'commonName', value: domain }];
  if (e.organization) attrs.push({ name: 'organizationName', value: e.organization });
  if (e.organizationalUnit) attrs.push({ name: 'organizationalUnitName', value: e.organizationalUnit });
  if (e.email) attrs.push({ name: 'emailAddress', value: e.email });
  // fallback to gateway email if not provided
  if (!e.email && cfg.email) attrs.push({ name: 'emailAddress', value: cfg.email });

  const extensions = [{ name: 'subjectAltName', altNames: altNames.map(n => ({ type: 2, value: n })) }];
  const pems = selfsigned.generate(attrs, { days: e.days || 1365, extensions });
  writeCert(domain, pems.cert, pems.private);
}

console.log('Done.');
