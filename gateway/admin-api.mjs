import fs from 'node:fs';
import path from 'node:path';
import { URL, fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

// Minimal router without external deps
export function installAdminApi(server, { manager, token, certInstaller, adminWs }) {
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

  // Resolve __dirname and storage directory once for consistent file operations
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const storageDir = path.join(__dirname, 'storage');

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
        // Basic validation: host is required and must be a non-empty string
        if (!data || typeof data.host !== 'string' || !data.host.trim()) {
          return json(res, 400, { error: 'missing required field: host' });
        }
        data.host = String(data.host).trim();
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
        // Disallow changing the host identifier via patch
        if (partial && Object.prototype.hasOwnProperty.call(partial, 'host')) {
          return json(res, 400, { error: 'cannot change host via patch' });
        }
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

  // Start/stop admin WebSocket runtime control (requires auth)
  add('POST', /^\/admin\/ws\/start$/i, async (req, res) => {
    try {
      if (!auth(req, res)) return;
      if (!('adminWs' in arguments.callee)) {
        // adminWs passed via options is available as closure var `adminWs` below
      }
      if (typeof adminWs === 'object' && adminWs && typeof adminWs.start === 'function') {
        adminWs.start();
        return json(res, 200, { running: adminWs.running ? adminWs.running() : true });
      }
      return json(res, 400, { error: 'adminWs not available' });
    } catch (e) { json(res, 500, { error: e.message }); }
  });

  add('POST', /^\/admin\/ws\/stop$/i, async (req, res) => {
    try {
      if (!auth(req, res)) return;
      if (typeof adminWs === 'object' && adminWs && typeof adminWs.stop === 'function') {
        await adminWs.stop();
        return json(res, 200, { running: adminWs.running ? adminWs.running() : false });
      }
      return json(res, 400, { error: 'adminWs not available' });
    } catch (e) { json(res, 500, { error: e.message }); }
  });

  // Trigger certificate installation/generation for a single host (sync to ensureCert in gateway)
  add('POST', /^\/admin\/apps\/([^/]+)\/install-cert$/i, async (req, res, m) => {
    try {
      const host = decodeURIComponent(m[1]);
      if (typeof certInstaller !== 'function') return json(res, 400, { error: 'cert installer not available' });
      // If this is a local-like host, ensure any existing combined cert on disk has the expected CN
      const storeDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../storage');
      const combinedCertPath = path.join(storeDir, 'local-gateway.crt');
      const combinedKeyPath = path.join(storeDir, 'local-gateway.key');
      // Helper to extract CN robustly from subject strings that may use
      // commas or newlines as separators. Stops at comma, newline, carriage
      // return, or slash.
      const extractCN = (subject) => {
        if (!subject) return null;
        const mm = String(subject).match(/CN=([^,\n\r\\/]+)/i);
        return mm && mm[1] ? mm[1].trim() : null;
      };

      try {
        if (fs.existsSync(combinedCertPath)) {
          try {
            const pem = fs.readFileSync(combinedCertPath, 'utf8');
            const cert = new crypto.X509Certificate(pem);
            const subj = cert.subject || '';
            const mcn = extractCN(subj);
            if (mcn && mcn.toLowerCase() !== 'local-gateway') {
              // Remove mismatched combined cert files so ensureCert will regenerate with correct CN
              try { fs.unlinkSync(combinedCertPath); } catch(_){}
              try { fs.unlinkSync(combinedKeyPath); } catch(_){}
              console.log('[cert] removed mismatched combined cert to force regeneration (found CN=' + (mcn[1]||'') + ')');
            }
          } catch (e) { /* ignore parse errors and regenerate anyway */ }
        }
      } catch (e) { /* ignore fs errors */ }

      // call the installer which returns {key, cert, certPath} or throws
      const result = await certInstaller(host);

      // parse the produced certificate (if present) to get subject and SANs
      let producedCertCN = null;
      const producedSans = [];
      let producedSubject = '';
      try {
        if (result && result.certPath && fs.existsSync(result.certPath)) {
          const pemTxt = fs.readFileSync(result.certPath, 'utf8');
          try {
            const newCert = new crypto.X509Certificate(pemTxt);
            producedSubject = newCert.subject || '';
            const mcn = extractCN(producedSubject);
            if (mcn) producedCertCN = String(mcn).trim().toLowerCase();
            const sanRaw = newCert.subjectAltName || '';
            const dnsRe = /DNS:([^,\s]+)/g;
            let mm;
            while ((mm = dnsRe.exec(sanRaw)) !== null) producedSans.push(mm[1].toLowerCase());
          } catch (e) {
            // ignore parse errors and treat as unknown CN (no deletion)
          }
        }
      } catch (e) { /* ignore fs errors */ }

      // If on Windows, try to import into CurrentUser Root using certutil.exe
      const isWin = process.platform === 'win32';
      if (isWin && result && result.certPath) {
        try {
          const { spawn } = await import('node:child_process');
          // First, list store to find matching thumbprints for subjects that match host or SANs and delete them
          // Use certutil -user -store Root to list and then remove matching entries
          const list = spawn('certutil.exe', ['-user', '-store', 'Root'], { stdio: ['ignore', 'pipe', 'pipe'] });
          let out = '';
          for await (const chunk of list.stdout) out += chunk.toString('utf8');
          for await (const chunk of list.stderr) out += chunk.toString('utf8');

          console.log('[cert] certutil list output length:', out.length, 'first 500 chars:', out.substring(0, 500));

          // Search for entries where Subject contains CN=<host> or SANs contain host
          const reThumb = /Cert Hash\(sha1\):\s*([0-9A-Fa-f]+)/g;
          const entries = [];
          const lines = out.split(/\r?\n/);
          let current = null;
          for (const line of lines) {
            const mthumb = line.match(/Cert Hash\(sha1\):\s*([0-9A-Fa-f]+)/);
            if (mthumb) {
              if (current) entries.push(current);
              current = { thumbprint: mthumb[1], subject: '', san: '' };
              continue;
            }
            // Capture Subject line
            const sm = line.match(/^\s*Subject:\s*(.*)$/);
            if (sm && current) {
              current.subject = sm[1].trim();
              continue;
            }
            // Capture SAN-related lines. certutil output varies by system and locale; look
            // for common markers like 'DNS Name=' or 'DNS:' or 'Subject Alternative Name:'
            if (current && /DNS\s*Name=|DNS:|Subject Alternative Name:/i.test(line)) {
              current.san += (line.trim() + ' ');
            }
          }
          if (current) entries.push(current);

          // Parse DNS names from each entry's accumulated SAN text to make matching easier
          const parseDnsFromSanText = (text) => {
            if (!text) return [];
            const out = new Set();
            const dnsRe1 = /DNS[:=]\s*([^,;\s]+)/ig; // matches 'DNS:example' or 'DNS=example'
            const dnsRe2 = /DNS\s*Name=([^,;\s]+)/ig; // matches 'DNS Name=example'
            let mm;
            while ((mm = dnsRe1.exec(text)) !== null) out.add(mm[1].toLowerCase());
            while ((mm = dnsRe2.exec(text)) !== null) out.add(mm[1].toLowerCase());
            return Array.from(out);
          };

          for (const e of entries) {
            e.sans = parseDnsFromSanText(e.san || '');
          }

          // If any entry doesn't include parsed SANs, query the store for that
          // specific certificate to get full details (some certutil outputs omit SANs
          // in the summary listing). This avoids missing wildcard SANs.
          const fillEntrySans = async (thumb) => {
            try {
              const p = spawn('certutil.exe', ['-user', '-store', 'Root', thumb], { stdio: ['ignore', 'pipe', 'pipe'] });
              let out = '';
              for await (const c of p.stdout) out += c.toString('utf8');
              for await (const c of p.stderr) out += c.toString('utf8');
              // Look for DNS: or DNS Name= occurrences
              const dns = [];
              const dnsRe1 = /DNS[:=]\s*([^,;\s]+)/ig;
              const dnsRe2 = /DNS\s*Name=([^,;\s]+)/ig;
              let mm;
              while ((mm = dnsRe1.exec(out)) !== null) dns.push(mm[1].toLowerCase());
              while ((mm = dnsRe2.exec(out)) !== null) dns.push(mm[1].toLowerCase());
              return Array.from(new Set(dns));
            } catch (e) {
              return [];
            }
          };

          // If certutil summary omitted Subject or SANs, fetch full details for the thumb
          const fillEntryDetails = async (thumb) => {
            try {
              const p = spawn('certutil.exe', ['-user', '-store', 'Root', thumb], { stdio: ['ignore', 'pipe', 'pipe'] });
              let out = '';
              for await (const c of p.stdout) out += c.toString('utf8');
              for await (const c of p.stderr) out += c.toString('utf8');
              // Extract Subject line
              const sm = out.match(/Subject:\s*(.*)/i);
              const subject = sm ? (sm[1] || '').trim() : '';
              // Extract SANs as before
              const dns = [];
              const dnsRe1 = /DNS[:=]\s*([^,;\s]+)/ig;
              const dnsRe2 = /DNS\s*Name=([^,;\s]+)/ig;
              let mm;
              while ((mm = dnsRe1.exec(out)) !== null) dns.push(mm[1].toLowerCase());
              while ((mm = dnsRe2.exec(out)) !== null) dns.push(mm[1].toLowerCase());
              return { subject, sans: Array.from(new Set(dns)) };
            } catch (e) {
              return { subject: '', sans: [] };
            }
          };

          for (const e of entries) {
            if (e.thumbprint) {
              // If subject is missing or CN couldn't be extracted, or SANs are empty, fetch full details
              const needSubject = !e.subject || !extractCN(e.subject);
              const needSans = (!e.sans || e.sans.length === 0);
              if (needSubject || needSans) {
                try {
                  const details = await fillEntryDetails(e.thumbprint);
                  if (details) {
                    if (details.subject) e.subject = details.subject;
                    if (Array.isArray(details.sans) && details.sans.length) e.sans = details.sans;
                  }
                } catch (ee) { /* ignore per-thumb failures */ }
              }
            }
          }

          console.log('[cert] store entries:', entries.map(e => ({ thumb: e.thumbprint, subj: e.subject, sans: e.sans })));

          // Decide whether we should attempt to delete existing combined certs.
          // Only do so when either the produced cert CN is 'local-gateway' (installer
          // produced the combined cert) OR the caller explicitly confirmed deletion
          // via the query param `confirm=1` and the produced cert would otherwise
          // conflict with the combined cert coverage.
          const urlObj = new URL(req.url, 'http://localhost');
          const confirm = urlObj.searchParams.get('confirm') === '1';
          // lightweight, wildcard-aware pattern matcher (used below)
          const matchesPatternSimple = (pattern, hostnameToCheck) => {
            if (!pattern || !hostnameToCheck) return false;
            const p = String(pattern).toLowerCase();
            const h = String(hostnameToCheck).toLowerCase();
            if (p === h) return true;
            if (p.startsWith('*.')) {
              const base = p.slice(2);
              if (h === base) return true;
              if (h.endsWith('.' + base)) return true;
            }
            return false;
          };

          // Detect whether the produced certificate is a combined/wildcard certificate.
          const producedIsCombined = (producedCertCN === 'local-gateway') || producedSans.some(s => typeof s === 'string' && String(s).startsWith('*.'));
          // Only treat this as a replacement for the combined 'local-gateway' cert when
          // the produced cert is itself combined (CN=local-gateway or contains wildcards)
          // or when the caller explicitly confirmed via ?confirm=1. Non-combined (normal)
          // certificates like CN=abc.com must not cause the local combined cert to be
          // deleted.
          let shouldDeleteCombined = producedIsCombined || confirm;
          console.log('[cert] host:', host, 'producedCertCN:', producedCertCN, 'produedIsCombined:', producedIsCombined, 'shouldDeleteCombined:', shouldDeleteCombined, 'confirm:', confirm);

          // Build a conservative target set: prefer SANs from existing combined cert (if present),
          // otherwise compute what SANs the new combined cert would include based on configured apps + host.
          const targetNames = new Set();
          const combinedCertPath = path.join(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../storage'), 'local-gateway.crt');
          try {
            var combinedSansFromDisk = [];
            if (fs.existsSync(combinedCertPath)) {
              const pem = fs.readFileSync(combinedCertPath, 'utf8');
              try {
                const cert = new crypto.X509Certificate(pem);
                const sanRaw = cert.subjectAltName || '';
                const dnsRe = /DNS:([^,\s]+)/g;
                let mm;
                while ((mm = dnsRe.exec(sanRaw)) !== null) {
                  const v = mm[1].toLowerCase();
                  targetNames.add(v);
                  combinedSansFromDisk.push(v);
                }
              } catch (e) {
                // parsing failed - fall back to computed names
              }
            }
          } catch (e) { /* ignore */ }

          // If we couldn't derive SANs from disk, compute expected local names similar to ensureCert
          const isLocalLike = (h) => {
            if (!h) return false;
            const s = String(h).toLowerCase();
            return s.includes('.local') || s.includes('local.') || s.includes('localhost') || s.includes('.console') || s.includes('local');
          };

          if (targetNames.size === 0) {
            try {
              const localNames = new Set();
              // Only include the installing host in the combined-local target set
              // when it is local-like (contains 'local' or similar). Non-local
              // hosts (like 'abc.com') should not cause the local-gateway
              // certificate to be replaced.
              if (isLocalLike(host)) localNames.add(host.toLowerCase());
              for (const a of manager.listApps()) {
                if (!a || !a.host) continue;
                const h = String(a.host).toLowerCase();
                if (isLocalLike(h)) localNames.add(h);
                if (Array.isArray(a.altNames)) for (const alt of a.altNames) {
                  const altS = String(alt).toLowerCase();
                  if (isLocalLike(altS)) localNames.add(altS);
                }
              }
              const namesArr = Array.from(localNames);
              // add wildcard SANs for base domains
              const wildcardSet = new Set();
              for (const n of namesArr) {
                const parts = n.split('.');
                if (parts.length >= 2 && !n.includes('localhost')) {
                  const base = parts.slice(-2).join('.');
                  if (base && base !== 'localhost') wildcardSet.add(`*.${base}`);
                }
              }
              for (const x of namesArr) targetNames.add(x);
              for (const w of wildcardSet) targetNames.add(w);
            } catch (e) { /* ignore */ }
          }

          // Always include combinedName as a possible target (harmless if not used)
          targetNames.add('local-gateway');

          // If the produced cert looks like a combined cert and an identical combined
          // certificate is already present on disk or in the store, consider the
          // host already covered and skip importing to avoid duplicate installs.
          if (producedIsCombined) {
            // compute existing combined SANs from store entries (CN=local-gateway)
            const combinedSansFromStore = [];
            for (const e of entries) {
              try {
                const ecns = extractCN(e.subject);
                if (ecns && ecns.toLowerCase() === 'local-gateway' && Array.isArray(e.sans) && e.sans.length) {
                  for (const s of e.sans) combinedSansFromStore.push(String(s).toLowerCase());
                }
              } catch (err) {}
            }
            const existingCombinedSans = Array.from(new Set([...(combinedSansFromDisk||[]), ...combinedSansFromStore]));
            // If produced combined cert has identical SANs to existing combined cert on disk or in store, skip import
            const normProducedSans = producedSans.map(s => String(s).toLowerCase()).sort();
            const normDisk = (combinedSansFromDisk || []).map(s => String(s).toLowerCase()).sort();
            const equalArrays = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
            if (combinedSansFromDisk.length > 0 && equalArrays(normProducedSans, normDisk)) {
              return json(res, 200, { installed: false, ok: true, reason: 'Combined certificate already present on disk with identical SANs.' });
            }
            // check store entries for a matching CN=local-gateway with same SANs
            for (const e of entries) {
              try {
                const ecns = extractCN(e.subject);
                if (ecns && ecns.toLowerCase() === 'local-gateway') {
                  const esans = Array.isArray(e.sans) ? e.sans.map(x => String(x).toLowerCase()).sort() : [];
                  if (equalArrays(normProducedSans, esans)) {
                    return json(res, 200, { installed: false, ok: true, reason: 'Combined certificate already present in store with identical SANs.' });
                  }
                }
              } catch (err) { /* ignore per-entry parse errors */ }
            }
            // otherwise fallthrough: if producedIsCombined and produced SANs include the host
            // we already set shouldDeleteCombined above and will delete/import later.
          }

          // wildcard-aware matcher: supports entries like '*.example.com' and exact match
          const hostMatches = (pattern, hostToCheck) => {
            if (!pattern || !hostToCheck) return false;
            const p = String(pattern).toLowerCase();
            const h = String(hostToCheck).toLowerCase();
            if (p === h) return true;
            if (p.startsWith('*.')) {
              const base = p.slice(2);
              if (h === base) return true;
              if (h.endsWith('.' + base)) return true;
            }
            return false;
          };

          // matchesTarget checks whether any of the computed targetNames would match the given name
          const matchesTarget = (name) => {
            if (!name) return false;
            const n = name.toLowerCase();
            if (targetNames.has(n)) return true;
            for (const t of targetNames) {
              if (!t) continue;
              if (hostMatches(t, n)) return true;
            }
            return false;
          };

          // Check if any existing store entry (CN or SANs) already covers the host.
          const storeCoversHost = (() => {
            for (const e of entries) {
              try {
                const cn = extractCN(e.subject);
                if (cn && hostMatches(cn, host)) return true;
                if (Array.isArray(e.sans)) {
                  for (const s of e.sans) if (hostMatches(s, host)) return true;
                }
              } catch (err) { /* ignore entry parse errors */ }
            }
            return false;
          })();

          if (storeCoversHost) {
            return json(res, 200, {
              installed: false,
              ok: true,
              reason: 'An existing certificate in the store already covers this host (CN or SAN).',
              combinedSans: Array.from(targetNames)
            });
          }

          // --- Simplified CN/SAN flow per request ---
          // Find any existing combined certificate entries (CN=local-gateway)
          const combinedEntry = entries.find(e => {
            try { const c = extractCN(e.subject); return c && String(c).toLowerCase() === 'local-gateway'; } catch (e) { return false; }
          });

          // Helper to collect combined SANs from store/disk.
          // IMPORTANT: prefer SANs from the Windows store (combinedEntry.sans) if present
          // because the on-disk combined certificate may have been regenerated already
          // (e.g. when adding a new app) and we should not trust disk to decide whether
          // the store already contains the new SANs.
          const existingCombinedSans = new Set();
          if (combinedEntry && Array.isArray(combinedEntry.sans) && combinedEntry.sans.length > 0) {
            for (const s of combinedEntry.sans) existingCombinedSans.add(String(s).toLowerCase());
          } else if (Array.isArray(combinedSansFromDisk)) {
            for (const s of combinedSansFromDisk) existingCombinedSans.add(String(s).toLowerCase());
          }

          // If combined CN exists
          if (combinedEntry) {
            // Check whether the existing combined cert already contains the installing host
            let hostCovered = false;
            for (const s of existingCombinedSans) {
              if (hostMatches(s, host)) { hostCovered = true; break; }
            }
            if (producedIsCombined) {
              // compute existing combined SANs from store entries (CN=local-gateway)
              const combinedSansFromStore = [];
              for (const e of entries) {
                try {
                  const ecns = extractCN(e.subject);
                  if (ecns && ecns.toLowerCase() === 'local-gateway' && Array.isArray(e.sans) && e.sans.length) {
                    for (const s of e.sans) combinedSansFromStore.push(String(s).toLowerCase());
                  }
                } catch (err) {}
              }
              // Prefer store SANs if present (we set existingCombinedSans earlier from combinedEntry)
              const existingCombinedSans = new Set();
              if (combinedEntry && Array.isArray(combinedEntry.sans) && combinedEntry.sans.length > 0) {
                for (const s of combinedEntry.sans) existingCombinedSans.add(String(s).toLowerCase());
              } else if (Array.isArray(combinedSansFromDisk)) {
                for (const s of combinedSansFromDisk) existingCombinedSans.add(String(s).toLowerCase());
              } else if (combinedSansFromStore.length > 0) {
                for (const s of combinedSansFromStore) existingCombinedSans.add(String(s).toLowerCase());
              }

              // Only check whether the installing host is present in existing combined SANs.
              const hostLower = String(host).toLowerCase();
              const hostAlreadyCovered = Array.from(existingCombinedSans).some(s => hostMatches(s, hostLower));
              if (hostAlreadyCovered) {
                return json(res, 200, { installed: false, ok: true, reason: 'Combined certificate in store already contains this host.' });
              }

              // If produced SANs include the host and store does not, we'll replace the store entry (shouldDeleteCombined was set earlier)
              // Otherwise fall through and continue with deletion/import logic below.
            }
            // Only consider existing entries as 'subsumed by combined' when the
            // produced certificate itself is a combined/wildcard certificate. A
            // non-combined produced cert (e.g., CN=abc.com) should not cause the
            // UI to prompt for deleting the combined local-gateway certificate.
            if (producedIsCombined) {
              const subsumedByCombined = entries.some(e => {
                try {
                  const subj = (e.subject || '').toLowerCase();
                  const mcn = extractCN(subj);
                  const cnName = mcn ? String(mcn).trim().toLowerCase() : null;
                  if (cnName && matchesTarget(cnName)) return true;
                  if (Array.isArray(e.sans)) {
                    for (const s of e.sans) if (matchesTarget(s)) return true;
                  }
                } catch (ee) { /* ignore per-entry parse errors */ }
                return false;
              });
              if (subsumedByCombined && !confirm) {
                return json(res, 200, {
                  installed: false,
                  needsConfirmation: true,
                  reason: 'Delete Certificate',
                  producedCert: { subject: producedSubject, sans: producedSans },
                  combinedSans: Array.from(targetNames)
                });
              }
            }
          }

          if (!combinedEntry) {
            await new Promise((resolve, reject) => {
              const args = ['-user', '-addstore', 'Root', result.certPath];
              const p = spawn('certutil.exe', args, { stdio: 'inherit' });
              p.on('exit', (code) => code === 0 ? resolve() : reject(new Error('certutil exit code '+code)));
              p.on('error', (err) => reject(err));
            });
            return json(res, 200, { installed: true, host, importedToStore: true, deleted: 0, deletedThumbs: [] });
          }

          // If the produced certificate is NOT the combined cert and we have not been
          // explicitly confirmed, check whether a combined cert exists (CN first) or
          // whether any existing per-host certificates in the store would be subsumed
          // by the computed combined SANs. If so, require explicit confirmation before
          // replacing them with a single combined cert.
          const toDelete = [];
          if (!shouldDeleteCombined) {
            const combinedOnDisk = fs.existsSync(combinedCertPath);
            if (combinedOnDisk) {
              const hostLower = host.toLowerCase();
              // If we were able to parse SANs from disk, use that to decide coverage.
              // If SANs from disk are missing (combinedSansFromDisk empty), require explicit confirmation
              // so the user can choose to replace the existing combined cert with an updated one.
              const combinedHasDiskSans = Array.isArray(combinedSansFromDisk) && combinedSansFromDisk.length > 0;
              const combinedAlreadyCovers = combinedHasDiskSans && (matchesTarget(hostLower) || producedSans.some(s => matchesTarget(s)));
              if (combinedAlreadyCovers) {
                // Combined cert already covers this host — no replacement needed.
                return json(res, 200, {
                  installed: false,
                  ok: true,
                  reason: 'Existing combined certificate already covers this host; no replacement required.',
                  combinedSans: Array.from(targetNames)
                });
              }
              // Only ask for confirmation to replace the combined cert when the produced
              // certificate is itself combined. Non-combined produced certs (normal
              // per-host certificates) should not prompt to replace the combined cert.
              if (producedIsCombined) {
                return json(res, 200, {
                  installed: false,
                  needsConfirmation: true,
                  reason: combinedHasDiskSans ? 'A combined local certificate (CN=local-gateway) exists but does not include this host in its SANs. Confirm deletion to replace it.' : 'A combined local certificate (CN=local-gateway) exists but its SANs could not be determined. Confirm deletion to replace it with an updated combined cert.',
                  producedCert: { subject: producedSubject, sans: producedSans },
                  combinedSans: Array.from(targetNames)
                });
              }
              // If produced cert is NOT combined, fall through and continue (we will
              // handle per-host replacement below without prompting the user).
            }

            // No combined cert on disk. Look for existing per-host certs in the store
            // that would be subsumed by the new combined SANs (for example,
            // 'local.console' would be subsumed by a '*.local.console' wildcard).
            const subsumed = [];
            for (const e of entries) {
              try {
                const subj = (e.subject || '').toLowerCase();
                const mcn = extractCN(subj);
                const cnName = mcn ? String(mcn).trim().toLowerCase() : null;
                if (!cnName) continue;
                // If the produced cert is combined, then existing per-host certs that
                // would be covered by the combined targets are considered subsumed.
                // If produced cert is NOT combined, only consider exact CN matches to
                // avoid deleting unrelated entries (particularly the local-gateway).
                if (producedIsCombined) {
                  if (matchesTarget(cnName)) subsumed.push({ thumb: e.thumbprint, cn: cnName });
                } else {
                  if (producedCertCN && cnName === String(producedCertCN).toLowerCase()) subsumed.push({ thumb: e.thumbprint, cn: cnName });
                }
              } catch (ee) { /* ignore per-entry parse errors */ }
            }
            if (subsumed.length > 0) {
              if (producedIsCombined) {
                // There are existing per-host certs that would be replaced by a combined cert.
                // Ask the user to confirm replacement rather than silently importing a new
                // per-host cert which would later cause duplicate installs.
                return json(res, 200, {
                  installed: false,
                  needsConfirmation: true,
                  reason: 'Existing per-host certificates found that would be subsumed by a combined wildcard certificate. Confirm replacement to update to a combined cert.',
                  producedCert: { subject: producedSubject, sans: producedSans },
                  combinedSans: Array.from(targetNames),
                  subsumed: subsumed
                });
              } else {
                // Produced cert is non-combined (per-host). Automatically delete exact-CN duplicates
                // (subsumed contains only exact-CN matches in this case) and proceed to import.
                for (const s of subsumed) {
                  try {
                    await new Promise((resolve, reject) => {
                      const p = spawn('certutil.exe', ['-user', '-delstore', 'Root', s.thumb], { stdio: 'inherit' });
                      p.on('exit', c => c === 0 ? resolve() : reject(new Error('delstore exit '+c)));
                      p.on('error', err => reject(err));
                    });
                  } catch (e) {
                    // ignore deletion failures and proceed to import; user can manually clean up
                  }
                }
                // fall through to import below
              }
            }
            // otherwise fall through and import without deleting
          } else {
            // When updating the combined cert (or user confirmed), delete any existing
            // combined cert entries (CN=local-gateway) AND any per-host entries that
            // would be subsumed by the new combined/wildcard cert. This is conservative
            // and only runs when the installer produced a combined cert (or the user
            // explicitly confirmed replacement).
            for (const e of entries) {
              try {
                const subj = (e.subject || '').toLowerCase();
                const mcn = extractCN(subj);
                const cnName = mcn ? String(mcn).trim().toLowerCase() : null;
                if (!cnName) continue;
                // Always delete existing combined certs with CN=local-gateway
                if (cnName === 'local-gateway') {
                  toDelete.push(e.thumbprint);
                  continue;
                }
                // If the produced cert is combined (or user confirmed), also delete
                // per-host certs whose CN would be covered by the new combined SANs.
                if (producedIsCombined) {
                  const matchesTarget = (name) => {
                    if (!name) return false;
                    const n = name.toLowerCase();
                    if (targetNames.has(n)) return true;
                    for (const t of targetNames) {
                      if (!t) continue;
                      if (t.startsWith('*.')) {
                        const base = t.slice(2).toLowerCase();
                        if (n === base) return true;
                        if (n.endsWith('.' + base)) return true;
                      }
                    }
                    return false;
                  };
                  if (matchesTarget(cnName)) {
                    toDelete.push(e.thumbprint);
                    continue;
                  }
                }
              } catch (ee) {
                // ignore per-entry parse errors
              }
            }
            console.log('[cert] toDelete for combined update (including per-host):', toDelete);
          }

          // Attempt deletion from both CurrentUser and machine stores for each matching thumbprint
          const deletedThumbs = [];
          for (const t of toDelete) {
            try {
              // Try user store
              await new Promise((resolve, reject) => {
                const p = spawn('certutil.exe', ['-user', '-delstore', 'Root', t], { stdio: 'inherit' });
                p.on('exit', c => c === 0 ? resolve() : reject(new Error('delstore exit '+c)));
                p.on('error', err => reject(err));
              });
              deletedThumbs.push(t);
            } catch (e2) {
              // give up on this thumbprint
            }
          }
          console.log('[cert] deletedThumbs:', deletedThumbs);

          // Now add new cert (always attempt import even if we didn't delete anything)
          await new Promise((resolve, reject) => {
            const args = ['-user', '-addstore', 'Root', result.certPath];
            const p = spawn('certutil.exe', args, { stdio: 'inherit' });
            p.on('exit', (code) => code === 0 ? resolve() : reject(new Error('certutil exit code '+code)));
            p.on('error', (err) => reject(err));
          });
          json(res, 200, { installed: true, host, importedToStore: true, deleted: deletedThumbs.length, deletedThumbs, deletionAttempted: shouldDeleteCombined });
        } catch (e) {
          console.error('certutil import failed', e);
          json(res, 200, { installed: true, host, importedToStore: false, importError: e.message, deletionAttempted: false });
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

  // Return combined local certificate SANs (if present) so UI can check coverage
  add('GET', /^\/admin\/cert\/sans$/i, async (req, res) => {
    try {
      const combinedCertPath = path.join(storageDir, 'local-gateway.crt');
      if (!fs.existsSync(combinedCertPath)) return json(res, 200, { sans: [] });
      const pem = fs.readFileSync(combinedCertPath, 'utf8');
      const { X509Certificate } = crypto;
      const x = new X509Certificate(pem);
      const sanRaw = x.subjectAltName || '';
      const sans = [];
      const dnsRe = /DNS:([^,\s]+)/g;
      let m;
      while ((m = dnsRe.exec(sanRaw)) !== null) sans.push(m[1]);
      json(res, 200, { sans });
    } catch (e) {
      json(res, 500, { error: e.message });
    }
  });

  // List certificate files in storage (for UI management)
  add('GET', /^\/admin\/certs$/i, async (req, res) => {
    try {
      const storeDir = storageDir;
      if (!fs.existsSync(storeDir)) return json(res, 200, { certs: [] });
      const files = fs.readdirSync(storeDir, { withFileTypes: true });
      const certFiles = files.filter(f => f.isFile() && /\.(crt|pem|cer)$/i.test(f.name)).map(f => f.name);
      const certs = [];
      for (const name of certFiles) {
        try {
          const p = path.join(storeDir, name);
          const txt = fs.readFileSync(p, 'utf8');
          let subject = '';
          const sans = [];
          try {
            const cert = new crypto.X509Certificate(txt);
            subject = cert.subject || '';
            const sanRaw = cert.subjectAltName || '';
            const dnsRe = /DNS:([^,\s]+)/g;
            let m;
            while ((m = dnsRe.exec(sanRaw)) !== null) sans.push(m[1]);
          } catch (e) {
            // ignore parse errors
          }
          certs.push({ name, subject, sans });
        } catch (e) {
          // ignore file read errors
        }
      }
      return json(res, 200, { certs });
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  });

  // Delete selected certificate files from storage. Expects JSON body { names: ["file.crt"] }
  add('POST', /^\/admin\/certs\/delete$/i, (req, res) => {
    let body = '';
    req.on('data', d => body += d);
    req.on('end', () => {
      try {
        const data = JSON.parse(body || '{}');
        const names = Array.isArray(data.names) ? data.names : [];
        const storeDir = storageDir;
        const deleted = [];
        const errors = [];
        for (const name of names) {
          try {
            if (typeof name !== 'string' || name.includes('..') || name.includes('/') || name.includes('\\')) {
              errors.push({ name, error: 'invalid name' });
              continue;
            }
            const p = path.join(storeDir, name);
            if (fs.existsSync(p)) {
              fs.unlinkSync(p);
              deleted.push(name);
            }
            // attempt to delete matching .key with same basename
            try {
              const base = name.replace(/\.(crt|pem|cer)$/i, '');
              const keyPath = path.join(storeDir, base + '.key');
              if (fs.existsSync(keyPath)) { fs.unlinkSync(keyPath); deleted.push(path.basename(keyPath)); }
            } catch (ee) { /* ignore */ }
          } catch (e) {
            errors.push({ name, error: e.message });
          }
        }
        return json(res, 200, { deleted, errors });
      } catch (e) { return json(res, 400, { error: e.message }); }
    });
  });

  // Serve static admin UI (single file) at /admin (HTML) and /admin/app.js
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
