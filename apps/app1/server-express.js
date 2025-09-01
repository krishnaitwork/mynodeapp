const express = require('express');
const swaggerUi = require('swagger-ui-express');
const swaggerJSDoc = require('swagger-jsdoc');

const app = express();
const PORT = 3000;

const path = require('path');
const fs = require('fs');
const http = require('http');

app.use(express.json());

// Directory where media files live for app1
const mediaDir = path.join(__dirname, 'media');
fs.mkdirSync(mediaDir, { recursive: true });

/**
 * GET /img/:file - proxy authentication to app2 and serve file when authorized
 */
app.get('/img/:file', (req, res) => {
  const file = req.params.file;
  const imgPath = `/img/${file}`;
  // Redirect browser to the public auth host (app2) so gateway routes correctly.
  const callback = `https://local.console:4443/auth-callback`;
  const u = new URL('https://app.local.console:4443/auth');
  u.searchParams.set('path', imgPath);
  u.searchParams.set('callback', callback);
  // Redirect browser to auth provider (app2). It will redirect back to /auth-callback
  res.redirect(302, u.toString());
});

/**
 * GET /auth-callback?path=/media/1.jpg&auth=true
 * Receives callback from app2 and serves the media if auth=true
 */
app.get('/auth-callback', (req, res) => {
  const { path: mediaPath, auth } = req.query;
  if (auth !== 'true' || !mediaPath) return res.status(403).send('Forbidden');
  const filename = path.basename(mediaPath);
  let full = path.join(mediaDir, filename);
  if (!fs.existsSync(full)) {
    const base = path.parse(filename).name;
    const svgAlt = path.join(mediaDir, `${base}.svg`);
    if (fs.existsSync(svgAlt)) {
      res.type('image/svg+xml');
      return res.sendFile(svgAlt);
    }
    return res.status(404).send('Not found');
  }
  return res.sendFile(full);
});

const swaggerSpec = swaggerJSDoc({
  definition: {
    openapi: '3.0.0',
    info: { title: 'App 1 API', version: '1.0.0', description: 'Minimal API with one method' }
  },
  apis: ['./server-express.js']
});

/**
 * @swagger
 * /health:
 *   get:
 *     summary: Health check
 *     responses:
 *       200:
 *         description: OK
 */
app.get('/health', (req, res) => res.send('OK'));

app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));

app.listen(PORT, () => console.log(`App 1 listening on port ${PORT} - Swagger UI: http://127.0.0.1:${PORT}/api-docs`));
