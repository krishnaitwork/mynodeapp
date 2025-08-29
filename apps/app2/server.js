const http = require('http');

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('OK');
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Hello from App 2!');
});

server.listen(3001, () => {
  console.log('App 2 listening on port 3001');
});
