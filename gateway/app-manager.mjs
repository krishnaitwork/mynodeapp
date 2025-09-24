import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { request } from 'undici';

export class AppManager extends EventEmitter {
  constructor(options) {
    super();
    this.apps = new Map(); // host -> app config
    this.children = new Map(); // host -> child process
    this.logBuffers = new Map(); // host -> ring buffer array
    this.maxLogs = options?.maxLogs || 500;
    this.configPath = options?.configPath;
    this.rawConfig = null; // original JSON object
  this.startTimes = new Map(); // host -> timestamp
  this.restartCounts = new Map(); // host -> number
  this.healthState = new Map(); // host -> { healthy, statusCode, lastChecked, error }
  this.healthIntervals = new Map(); // host -> interval id
  this.defaultHealthInterval = options?.healthIntervalMs || 15000; // Increased from 5s to 15s
  this.manualStops = new Set(); // hosts intentionally stopped by user
  }

  loadConfig(obj) {
    this.rawConfig = obj;
    (obj.apps || []).forEach(app => {
      if (app && app.host) this.apps.set(app.host.toLowerCase(), { ...app });
    });
    this.emit('config-loaded', { appCount: this.apps.size });
  }

  listApps() { return Array.from(this.apps.values()); }
  getApp(host) { return this.apps.get(host.toLowerCase()); }

  addApp(app) {
    if (!app || !app.host) throw new Error('host required');
    const key = app.host.toLowerCase();
    if (this.apps.has(key)) throw new Error('host already exists');
    this.apps.set(key, { ...app });
    this._persist();
    this.emit('app-added', { host: key, app });
    if (app.start) this.start(key);
    this._scheduleHealth(key);
    return this.getApp(key);
  }

  updateApp(host, partial) {
    const key = host.toLowerCase();
    if (!this.apps.has(key)) throw new Error('not found');
    const merged = { ...this.apps.get(key), ...partial };
    this.apps.set(key, merged);
    this._persist();
    this.emit('app-updated', { host: key, app: merged });
  // Reschedule health if interval or healthUrl changed
  this._clearHealth(key);
  this._scheduleHealth(key);
    return merged;
  }

  removeApp(host) {
    const key = host.toLowerCase();
    const app = this.apps.get(key);
    if (!app) throw new Error('not found');
    this.stop(key, { restart: false });
    this.apps.delete(key);
  this._clearHealth(key);
    this._persist();
    this.emit('app-removed', { host: key });
    return true;
  }

  // Check for port conflicts before starting
  _checkPortConflicts(app) {
    if (!app.port) return true;
    const conflicting = this.listApps().filter(other => 
      other.host !== app.host && 
      other.port === app.port && 
      this.children.has(other.host.toLowerCase())
    );
    if (conflicting.length > 0) {
      this.emit('app-log', { host: app.host, stream: 'stderr', line: `[port-conflict] Port ${app.port} already used by: ${conflicting.map(a => a.host).join(', ')}` });
      return false;
    }
    return true;
  }

  start(host) {
    const key = host.toLowerCase();
    const app = this.apps.get(key);
    if (!app) throw new Error('not found');
    if (!app.start) throw new Error('start command missing');
  if (app.disabled) throw new Error('app disabled');
    if (this.children.has(key)) return { already: true };
    if (!this._checkPortConflicts(app)) throw new Error('port conflict');

    // Optional auto-install: if package.json exists and node_modules missing, run npm install
    try {
      const pkgPath = path.join(app.cwd || '.', 'package.json');
      const nodeModulesPath = path.join(app.cwd || '.', 'node_modules');
      if (app.autoInstall !== false && fs.existsSync(pkgPath) && !fs.existsSync(nodeModulesPath)) {
        this.emit('app-log', { host: key, stream: 'stdout', line: '[auto-install] Running npm install (first start)...' });
        const r = spawnSync('npm', ['install', '--no-audit', '--no-fund'], { cwd: app.cwd, shell: true, env: process.env, stdio: 'inherit', windowsHide: process.platform === 'win32' });
        if (r.error) {
          this.emit('app-log', { host: key, stream: 'stderr', line: `[auto-install] failed: ${r.error.message}` });
        } else {
          this.emit('app-log', { host: key, stream: 'stdout', line: '[auto-install] npm install completed' });
        }
      }
    } catch (e) {
      this.emit('app-log', { host: key, stream: 'stderr', line: `[auto-install] error: ${e.message}` });
    }
    let startStr = app.start.trim();
    // Optimization: if command is 'npm start' (or 'npm run start'), resolve actual script and run underlying command directly
    try {
      const npmStartRx = /^npm\s+(run\s+)?start$/i;
      if (npmStartRx.test(startStr)) {
        const pkgPath = path.join(app.cwd || '.', 'package.json');
        if (fs.existsSync(pkgPath)) {
          const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
          if (pkg.scripts && pkg.scripts.start) {
            const scriptCmd = pkg.scripts.start.trim();
            // Only resolve if script is simple (no shell operators) to avoid complexity
            if (!/[&|><;`$(){}[\]\\]/.test(scriptCmd) && !scriptCmd.includes('&&') && !scriptCmd.includes('||')) {
              this.emit('app-log', { host: key, stream: 'stdout', line: `[resolve] npm start → ${scriptCmd}` });
              startStr = scriptCmd;
            } else {
              this.emit('app-log', { host: key, stream: 'stdout', line: '[resolve] script contains shell operators; keeping npm wrapper' });
            }
          } else {
            this.emit('app-log', { host: key, stream: 'stderr', line: '[resolve] no start script found in package.json' });
          }
        } else {
          this.emit('app-log', { host: key, stream: 'stderr', line: '[resolve] package.json not found' });
        }
      }
    } catch (e) {
      this.emit('app-log', { host: key, stream: 'stderr', line: `[resolve-error] ${e.message}` });
    }
    const parts = startStr.match(/(?:"[^"]+"|'[^']+'|\S+)/g) || [];
    const cleaned = parts.map(p => p.replace(/^['"]|['"]$/g, ''));
    const cmd = cleaned[0];
    const args = cleaned.slice(1);
    const wantShell = app.shell === true; // allow explicit opt-in
    let child;
    const spawnOptsBase = {
      cwd: app.cwd,
      env: { ...process.env, NODE_ENV: process.env.NODE_ENV || 'production' }
    };
    // Ensure Node install dir is on PATH (helps find npm.cmd when service/user PATH trimmed)
    try {
      const nodeDir = path.dirname(process.execPath);
      if (spawnOptsBase.env && spawnOptsBase.env.PATH && !spawnOptsBase.env.PATH.split(path.delimiter).some(p => p.toLowerCase() === nodeDir.toLowerCase())) {
        spawnOptsBase.env.PATH = nodeDir + path.delimiter + spawnOptsBase.env.PATH;
      }
    } catch {}
    const needsShellAuto = /^(npm|yarn|pnpm)(\.cmd)?$/i.test(cmd);
    const doSpawn = (useShell) => {
      this.emit('app-log', { host: key, stream: 'stdout', line: `[spawn] ${cmd} ${args.join(' ')} (shell=${useShell}) cwd=${app.cwd}` });
      return spawn(cmd, args, { ...spawnOptsBase, shell: useShell, windowsHide: process.platform === 'win32' });
    };
    try {
      child = doSpawn(wantShell || needsShellAuto);
    } catch (e) {
      if (wantShell) throw e;
      // fallback: try without shell if initial attempt somehow failed (rare synchronously)
      child = doSpawn(false);
    }

    // runtime error fallback (e.g., ENOENT for cmd.exe when shell=true)
    child.on('error', (err) => {
      this.emit('app-log', { host: key, stream: 'stderr', line: `[spawn-error] ${err.message}` });
      if ((wantShell || needsShellAuto) && (err.code === 'ENOENT')) {
        this.emit('app-log', { host: key, stream: 'stderr', line: `Shell spawn failed (${err.message}); retrying without shell` });
        try {
          const retry = doSpawn(false);
          this.children.set(key, retry);
          this._wireChild(key, app, retry);
        } catch (e2) {
          this.emit('app-exit', { host: key, code: -1, signal: null, error: e2.message });
        }
      }
      // Additional Windows fallback for npm: invoke npm-cli.js directly via node if still ENOENT
      if (err.code === 'ENOENT' && /^(npm|npm\.cmd)$/i.test(cmd)) {
        try {
          const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
          if (fs.existsSync(npmCli)) {
            this.emit('app-log', { host: key, stream: 'stderr', line: `[spawn-fallback] using node ${npmCli}` });
            const retry = spawn(process.execPath, [npmCli, ...args], { cwd: app.cwd, env: spawnOptsBase.env, windowsHide: process.platform === 'win32' });
            this.children.set(key, retry);
            this._wireChild(key, app, retry);
          }
        } catch (e3) {
          this.emit('app-log', { host: key, stream: 'stderr', line: `[spawn-fallback-error] ${e3.message}` });
        }
      }
    });
    this.children.set(key, child);
  this.startTimes.set(key, Date.now());
  if (!this.restartCounts.has(key)) this.restartCounts.set(key, 0);
    this.emit('app-start', { host: key, pid: child.pid });

    const appendLog = (line, stream) => {
      if (!this.logBuffers.has(key)) this.logBuffers.set(key, []);
      const buf = this.logBuffers.get(key);
      buf.push({ ts: Date.now(), stream, line: line.toString() });
      if (buf.length > this.maxLogs) buf.splice(0, buf.length - this.maxLogs);
      this.emit('app-log', { host: key, stream, line: line.toString() });
    };

    this._wireChild(key, app, child);
    return { started: true, pid: child.pid };
  }

  _wireChild(key, app, child) {
    const appendLog = (line, stream) => {
      if (!this.logBuffers.has(key)) this.logBuffers.set(key, []);
      const buf = this.logBuffers.get(key);
      buf.push({ ts: Date.now(), stream, line: line.toString() });
      if (buf.length > this.maxLogs) buf.splice(0, buf.length - this.maxLogs);
      this.emit('app-log', { host: key, stream, line: line.toString() });
    };
    child.stdout?.on('data', d => appendLog(d, 'stdout'));
    child.stderr?.on('data', d => appendLog(d, 'stderr'));
    child.on('exit', (code, signal) => {
      this.children.delete(key);
      this.emit('app-exit', { host: key, code, signal });
      const wasManual = this.manualStops.has(key);
      if (wasManual) this.manualStops.delete(key);
      // Don't auto-restart on clean exit (code 0) unless it was unexpected
      const shouldRestart = !wasManual && app.autoRestart !== false && !app.disabled && code !== 0;
      if (shouldRestart) {
        this.restartCounts.set(key, (this.restartCounts.get(key) || 0) + 1);
        const restarts = this.restartCounts.get(key);
        // Back off restart delay if too many failures
        const delay = Math.min(2000 + (restarts * 1000), 30000);
        this.emit('app-log', { host: key, stream: 'stderr', line: `[restart] attempt ${restarts} in ${delay}ms` });
        setTimeout(() => { if (this.apps.has(key)) this.start(key); }, delay);
      } else if (code === 0) {
        this.emit('app-log', { host: key, stream: 'stdout', line: '[exit] clean exit (code 0) - not restarting' });
      }
    });
  }

  stop(host, opts = {}) {
    const key = host.toLowerCase();
    const child = this.children.get(key);
    if (!child) return { running: false };
  this.manualStops.add(key); // mark manual stop
    child.kill();
    this.children.delete(key);
    this.emit('app-stop', { host: key });
    if (opts.restart) {
      setTimeout(() => this.start(key), 500);
    }
    return { stopped: true };
  }

  restart(host) {
    const key = host.toLowerCase();
    const wasRunning = this.children.has(key);
    this.stop(key);
    return this.start(key) || { restarted: wasRunning };
  }

  tail(host, limit = 200) {
    const key = host.toLowerCase();
    const buf = this.logBuffers.get(key) || [];
    return buf.slice(-limit);
  }

  runtime(host) {
    const key = host.toLowerCase();
    const child = this.children.get(key);
    const started = this.startTimes.get(key);
    const uptimeMs = started ? Date.now() - started : 0;
    const restarts = this.restartCounts.get(key) || 0;
    const health = this.healthState.get(key) || null;
    return { running: !!child, pid: child?.pid, uptimeMs, restarts, health };
  }

  enable(host) {
    const key = host.toLowerCase();
    const app = this.apps.get(key); if (!app) throw new Error('not found');
    if (!app.disabled) return { already: true };
    app.disabled = false;
    this.updateApp(key, { disabled: false });
    if (app.start) this.start(key);
    return { enabled: true };
  }

  disable(host) {
    const key = host.toLowerCase();
    const app = this.apps.get(key); if (!app) throw new Error('not found');
    if (app.disabled) return { already: true };
    app.disabled = true;
    this.updateApp(key, { disabled: true });
    this.stop(key, { restart: false });
    return { disabled: true };
  }

  _scheduleHealth(key) {
    const app = this.apps.get(key);
    if (!app || !app.healthUrl) return;
    const intervalMs = app.healthIntervalMs || this.defaultHealthInterval;
    const run = async () => {
      const started = Date.now();
      let state;
      try {
        const res = await request(app.healthUrl, { method: 'GET', maxRedirections: 1 });
        const healthy = res.statusCode >= 200 && res.statusCode < 400;
        state = { healthy, statusCode: res.statusCode, lastChecked: Date.now(), latencyMs: Date.now() - started };
      } catch (e) {
        state = { healthy: false, statusCode: 0, lastChecked: Date.now(), error: e.message };
      }
      this.healthState.set(key, state);
      this.emit('app-health', { host: key, ...state });
    };
    run(); // initial
    const id = setInterval(run, intervalMs);
    this.healthIntervals.set(key, id);
  }

  _clearHealth(key) {
    const id = this.healthIntervals.get(key);
    if (id) clearInterval(id);
    this.healthIntervals.delete(key);
    this.healthState.delete(key);
  }

  _persist() {
    if (!this.configPath || !this.rawConfig) return;
    // Write apps back preserving other top-level keys
    const out = { ...this.rawConfig, apps: this.listApps() };
    const tmp = this.configPath + '.tmp';
    // Use async I/O to avoid blocking event loop
    fs.promises.writeFile(tmp, JSON.stringify(out, null, 2))
      .then(() => fs.promises.rename(tmp, this.configPath))
      .then(() => this.emit('config-saved', { path: this.configPath }))
      .catch(err => console.error('Config save failed:', err));
  }
}

export function createAppManagerFromFile(configPath, options = {}) {
  const text = fs.readFileSync(configPath, 'utf8');
  const obj = JSON.parse(text);
  const mgr = new AppManager({ ...options, configPath });
  mgr.loadConfig(obj);
  return mgr;
}
