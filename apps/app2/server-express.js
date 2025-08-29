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

app.listen(PORT, () => console.log(`App 2 listening on port ${PORT} - Swagger UI: http://127.0.0.1:${PORT}/api-docs`));
