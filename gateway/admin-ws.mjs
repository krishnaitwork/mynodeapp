import { WebSocketServer } from 'ws';
import { URL } from 'node:url';

export function installAdminWs(server, { manager, token }) {
  const wss = new WebSocketServer({ noServer: true });

  const broadcast = (msg) => {
    const data = JSON.stringify(msg);
    for (const client of wss.clients) {
      if (client.readyState === 1) client.send(data);
    }
  };

  const forwardEvent = (type, payload) => broadcast({ type, ...payload });
  const events = ['app-start','app-stop','app-exit','app-log','app-added','app-removed','app-updated','config-saved'];

  // manager handlers map so we can detach later
  const mgrHandlers = Object.create(null);

  const attachManagerHandlers = () => {
    for (const ev of events) {
      const h = (payload) => forwardEvent(ev, payload);
      mgrHandlers[ev] = h;
      manager.on(ev, h);
    }
  };

  const detachManagerHandlers = () => {
    for (const ev of events) {
      const h = mgrHandlers[ev];
      if (h) manager.off(ev, h);
      delete mgrHandlers[ev];
    }
  };

  // Upgrade handler - kept separate so it can be added/removed from server
  const upgradeHandler = (req, socket, head) => {
    if (!req.url.startsWith('/admin/ws')) return; // ignore others
    try {
      const url = new URL(req.url, 'http://localhost');
      const qtok = url.searchParams.get('token');
      const hdr = req.headers['x-admin-token'];
      if (token && token !== qtok && token !== hdr) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
        try { ws.send(JSON.stringify({ type: 'welcome', time: Date.now(), apps: manager.listApps() })); } catch(_){}
      });
    } catch (e) {
      try { socket.destroy(); } catch(_){}
    }
  };

  let running = false;

  function start() {
    if (running) return;
    attachManagerHandlers();
    server.on('upgrade', upgradeHandler);
    running = true;
  }

  async function stop() {
    if (!running) return;
    try { server.off('upgrade', upgradeHandler); } catch(_){}
    detachManagerHandlers();
    try { wss.clients.forEach(c => { try { c.terminate(); } catch(_){} }); } catch(_){}
    try { await new Promise((resolve) => wss.close(() => resolve())); } catch(_){}
    running = false;
  }

  // Start by default to preserve existing behavior
  start();

  return { wss, start, stop, running: () => running };
}
