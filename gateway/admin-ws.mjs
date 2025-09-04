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
  events.forEach(ev => manager.on(ev, (payload) => forwardEvent(ev, payload)));

  server.on('upgrade', (req, socket, head) => {
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
        ws.send(JSON.stringify({ type: 'welcome', time: Date.now(), apps: manager.listApps() }));
      });
    } catch (e) {
      socket.destroy();
    }
  });

  return { wss };
}
