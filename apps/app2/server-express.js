const express = require('express');
const swaggerUi = require('swagger-ui-express');
const swaggerJSDoc = require('swagger-jsdoc');

const app = express();
const PORT = 3001;


const swaggerSpec = swaggerJSDoc({
  definition: {
    openapi: '3.0.0',
    info: { title: 'App 2 API', version: '1.0.0', description: 'Minimal API with one method' }
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

/**
 * Simple authentication endpoint used by the gateway/app1.
 * Expects JSON: { path: '/img/1.jpg' }
 * If the path starts with /img/ it will respond with a mapped media path and auth:true
 */
// Accept GET /auth?path=/img/1.jpg
app.get('/auth', (req, res) => {
  try {
    const pathParam = req.query.path;
    const callback = req.query.callback;
    if (!pathParam || typeof pathParam !== 'string') return res.status(400).json({ auth: false, error: 'missing path' });
    if (pathParam.startsWith('/img/')) {
      const filename = pathParam.split('/').pop();
      const mediaPath = `/media/${filename}`;
      // If a callback URL is provided, redirect the browser back to the callback with auth result
      if (callback && typeof callback === 'string') {
        try {
          // DEV: allow arbitrary callbacks for local testing. In production
          // this should be restricted to trusted hosts only.
          const url = new URL(callback);
          url.searchParams.set('path', mediaPath);
          url.searchParams.set('auth', 'true');
          return res.redirect(302, url.toString());
        } catch (e) {
          return res.status(400).send('Invalid callback URL');
        }
      }
      return res.json({ auth: true, path: mediaPath });
    }
    return res.json({ auth: false });
  } catch (err) {
    console.error('auth error', err);
    return res.status(500).json({ auth: false });
  }
});

app.listen(PORT, () => console.log(`App 2 listening on port ${PORT} - Swagger UI: http://127.0.0.1:${PORT}/api-docs`));
