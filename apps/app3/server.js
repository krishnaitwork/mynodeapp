const express = require('express');
const swaggerUi = require('swagger-ui-express');
const swaggerJsdoc = require('swagger-jsdoc');

const app = express();
const PORT = 3002;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
// Serve static public files (db browser UI)
app.use('/public', express.static(__dirname + '/public'));

// Ensure uploads directory exists for uploaded sqlite files
const fs = require('fs');
const path = require('path');
const uploadsDir = path.join(__dirname, 'uploads');
fs.mkdirSync(uploadsDir, { recursive: true });
// Config file to persist saved DB entries
const configPath = path.join(__dirname, 'config.json');
function loadConfig(){
  try {
    if (!fs.existsSync(configPath)) return { databases: [] };
    const txt = fs.readFileSync(configPath, 'utf8');
    return JSON.parse(txt || '{"databases":[]}');
  } catch (e) { console.error('Failed to load config.json', e); return { databases: [] }; }
}
function saveConfig(cfg){
  try { fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2), 'utf8'); return true; }
  catch(e){ console.error('Failed to save config.json', e); return false; }
}
const config = loadConfig();

// File upload handling
const multer = require('multer');
const upload = multer({ dest: uploadsDir });
// SQLite access
const sqlite3 = require('sqlite3').verbose();

// Simple in-memory map of uploaded DBs (id -> filepath)
const dbMap = new Map();
// Load saved db entries from config into dbMap (only if path exists)
for (const entry of (config.databases||[])){
  try{
    if (entry.path && fs.existsSync(entry.path)){
      dbMap.set(entry.id, { path: entry.path, name: entry.label || path.basename(entry.path), meta: entry });
    }
  }catch(e){/* ignore */}
}

// Upload endpoint: accepts multipart form field 'dbfile'
app.post('/db/upload', upload.single('dbfile'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'no file uploaded' });
    // Assign an id for this upload (use filename + timestamp)
    const id = `${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
    const safeName = path.basename(req.file.originalname);
    const dest = path.join(uploadsDir, id + path.extname(safeName));
    // Move the uploaded temp file to our assigned name
    fs.renameSync(req.file.path, dest);
    dbMap.set(id, { path: dest, name: safeName });
    // persist to config
    const dbEntry = { id, label: safeName, path: dest, addedAt: new Date().toISOString(), lastOpened: new Date().toISOString() };
    config.databases = config.databases || [];
    config.databases.push(dbEntry);
    saveConfig(config);
    res.json({ id, name: safeName });
  } catch (e) {
    console.error('upload error', e);
    res.status(500).json({ error: e.message });
  }
});

// GET saved databases
app.get('/api/databases', (req, res) => {
  res.json({ databases: config.databases || [] });
});

// Add an existing DB by path (server-side), or create metadata record
app.post('/api/databases', (req, res) => {
  const { id, path: p, label } = req.body;
  if (!p) return res.status(400).json({ error: 'path required' });
  const realPath = path.isAbsolute(p) ? p : path.join(__dirname, p);
  if (!fs.existsSync(realPath)) return res.status(400).json({ error: 'file not found' });
  const nid = id || `${Date.now()}-${Math.random().toString(36).slice(2,8)}`;
  const entry = { id: nid, label: label || path.basename(realPath), path: realPath, addedAt: new Date().toISOString() };
  config.databases = config.databases || [];
  config.databases.push(entry);
  saveConfig(config);
  dbMap.set(nid, { path: realPath, name: entry.label });
  res.json({ ok: true, entry });
});

// Update metadata (label) for a saved DB
app.put('/api/databases/:id', (req, res) => {
  const id = req.params.id; const { label } = req.body;
  const idx = (config.databases||[]).findIndex(d => d.id === id);
  if (idx === -1) return res.status(404).json({ error: 'not found' });
  if (label) config.databases[idx].label = label;
  config.databases[idx].lastOpened = new Date().toISOString();
  saveConfig(config);
  const entry = config.databases[idx];
  if (dbMap.has(id)) dbMap.get(id).name = entry.label;
  res.json({ ok: true, entry });
});

// Delete saved DB entry (only remove file if inside uploadsDir)
app.delete('/api/databases/:id', (req, res) => {
  const id = req.params.id;
  const idx = (config.databases||[]).findIndex(d => d.id === id);
  if (idx === -1) return res.status(404).json({ error: 'not found' });
  const entry = config.databases[idx];
  // remove file if it's inside uploadsDir
  try{
    if (entry.path && path.resolve(entry.path).startsWith(path.resolve(uploadsDir))) {
      try { fs.unlinkSync(entry.path); } catch(e) { /* ignore unlink errors */ }
    }
  }catch(e){ /* ignore */ }
  config.databases.splice(idx,1);
  saveConfig(config);
  dbMap.delete(id);
  res.json({ ok: true });
});

// List tables for uploaded DB
app.get('/db/:id/tables', (req, res) => {
  const id = req.params.id;
  const entry = dbMap.get(id);
  if (!entry) return res.status(404).json({ error: 'db not found' });
  const db = new sqlite3.Database(entry.path, sqlite3.OPEN_READONLY, (err) => {
    if (err) return res.status(500).json({ error: err.message });
    db.all("SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name", (err2, rows) => {
      if (err2) { db.close(); return res.status(500).json({ error: err2.message }); }
      // For each table, try to fetch a count (best-effort; ignore errors for views)
      const tables = [];
      let pending = rows.length;
      if (pending === 0) { res.json({ tables: [] }); db.close(); return; }
      rows.forEach(r => {
        const tbl = { name: r.name, type: r.type, rowCount: null };
        db.get(`SELECT COUNT(*) as c FROM "${r.name.replace(/"/g,'"')}"`, (err3, cRow) => {
          if (!err3 && cRow) tbl.rowCount = cRow.c;
          tables.push(tbl);
          pending -= 1;
          if (pending === 0) {
            // sort by name to preserve ordering
            tables.sort((a,b)=> a.name.localeCompare(b.name));
            res.json({ tables });
            db.close();
          }
        });
      });
    });
  });
});

// Get table schema + rows (limit)
app.get('/db/:id/table/:table', (req, res) => {
  const id = req.params.id;
  const table = req.params.table;
  // pagination and sorting params
  const limit = Math.min(Math.max(parseInt(req.query.limit || '200', 10), 1), 2000);
  const offset = Math.max(parseInt(req.query.offset || '0', 10), 0);
  const orderBy = req.query.order_by || null;
  const orderDir = (req.query.order_dir || 'ASC').toUpperCase() === 'DESC' ? 'DESC' : 'ASC';
  const entry = dbMap.get(id);
  if (!entry) return res.status(404).json({ error: 'db not found' });
  const db = new sqlite3.Database(entry.path, sqlite3.OPEN_READONLY, (err) => {
    if (err) return res.status(500).json({ error: err.message });
    // pragma table_info to get column info
    db.all(`PRAGMA table_info("${table.replace(/"/g,'"')}")`, (err2, cols) => {
      if (err2) { db.close(); return res.status(500).json({ error: err2.message }); }
      const columns = cols.map(c => ({ name: c.name, type: c.type }));
      const validCols = new Set(columns.map(c=>c.name));
      // build ORDER BY if requested and valid
      let orderClause = '';
      if (orderBy && validCols.has(orderBy)) {
        orderClause = ` ORDER BY "${orderBy.replace(/"/g,'"')}" ${orderDir}`;
      }
      // fetch rows
      const sql = `SELECT * FROM "${table.replace(/"/g,'"')}"${orderClause} LIMIT ? OFFSET ?`;
      db.all(sql, [limit, offset], (err3, rows) => {
        if (err3) { db.close(); return res.status(500).json({ error: err3.message }); }
        // also fetch total count
        db.get(`SELECT COUNT(*) as c FROM "${table.replace(/"/g,'"')}"`, (err4, cntRow) => {
          const total = (!err4 && cntRow) ? cntRow.c : null;
          res.json({ columns, rows, rowCount: rows.length, totalRows: total, limitedTo: limit, offset, orderBy: orderBy || null, orderDir });
          db.close();
        });
      });
    });
  });
});

// Run a safe SELECT query against the DB (advanced feature)
app.post('/db/:id/query', express.json(), (req, res) => {
  const id = req.params.id;
  const entry = dbMap.get(id);
  if (!entry) return res.status(404).json({ error: 'db not found' });
  const sql = (req.body && req.body.sql) ? String(req.body.sql) : '';
  const limit = Math.min(Math.max(parseInt(req.body.limit || '200', 10), 1), 2000);
  const offset = Math.max(parseInt(req.body.offset || '0', 10), 0);
  if (!sql) return res.status(400).json({ error: 'sql required' });
  // Basic safety checks: only allow SELECT, disallow semicolons and dangerous keywords
  const banned = /\b(insert|update|delete|drop|create|alter|attach|detach|pragma|replace|merge|begin|commit)\b/i;
  if (!/^\s*select\b/i.test(sql) || /;/.test(sql) || banned.test(sql) || /\blimit\b/i.test(sql)) {
    return res.status(400).json({ error: 'only simple SELECT queries without LIMIT or semicolons are allowed' });
  }
  const db = new sqlite3.Database(entry.path, sqlite3.OPEN_READONLY, (err) => {
    if (err) return res.status(500).json({ error: err.message });
    // Append LIMIT/OFFSET safely as parameters
    const q = sql + ` LIMIT ? OFFSET ?`;
    db.all(q, [limit, offset], (err2, rows) => {
      if (err2) { db.close(); return res.status(500).json({ error: err2.message }); }
      const cols = [];
      if (rows && rows.length > 0) cols.push(...Object.keys(rows[0]));
      // also fetch total count if possible (best-effort by wrapping as count)
      // This is expensive; we skip unless client requested total
      res.json({ columns: cols, rows, rowCount: rows.length, limitedTo: limit, offset });
      db.close();
    });
  });
});

// Serve DB browser UI
app.get('/db-browser', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'db-browser.html'));
});

// Swagger configuration
const swaggerOptions = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'App 3 API',
      version: '1.0.0',
      description: 'A comprehensive API for App 3 with Swagger documentation',
      contact: {
        name: 'API Support',
        email: 'support@example.com'
      },
    },
    servers: [
      {
        url: 'http://localhost:3002',
        description: 'Development server',
      },
      {
        url: 'https://app3.yourdomain.com',
        description: 'Production server',
      },
    ],
    components: {
      schemas: {
        User: {
          type: 'object',
          properties: {
            id: {
              type: 'integer',
              example: 1
            },
            name: {
              type: 'string',
              example: 'John Doe'
            },
            email: {
              type: 'string',
              format: 'email',
              example: 'john.doe@example.com'
            },
            createdAt: {
              type: 'string',
              format: 'date-time',
              example: '2025-01-29T10:00:00Z'
            }
          }
        },
        Product: {
          type: 'object',
          properties: {
            id: {
              type: 'integer',
              example: 1
            },
            name: {
              type: 'string',
              example: 'Laptop'
            },
            price: {
              type: 'number',
              format: 'float',
              example: 999.99
            },
            category: {
              type: 'string',
              example: 'Electronics'
            }
          }
        },
        Error: {
          type: 'object',
          properties: {
            error: {
              type: 'string',
              example: 'Error message'
            },
            code: {
              type: 'integer',
              example: 400
            }
          }
        }
      }
    }
  },
  apis: ['./server.js'], // Path to the API docs
};

const swaggerSpec = swaggerJsdoc(swaggerOptions);

// Serve Swagger UI
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));

// In-memory data storage (for demo purposes)
let users = [
  { id: 1, name: 'John Doe', email: 'john@example.com', createdAt: new Date().toISOString() },
  { id: 2, name: 'Jane Smith', email: 'jane@example.com', createdAt: new Date().toISOString() }
];

let products = [
  { id: 1, name: 'Laptop', price: 999.99, category: 'Electronics' },
  { id: 2, name: 'Book', price: 19.99, category: 'Education' }
];

// Health check endpoint
/**
 * @swagger
 * /health:
 *   get:
 *     summary: Health check endpoint
 *     description: Check if the API is running
 *     responses:
 *       200:
 *         description: API is healthy
 *         content:
 *           text/plain:
 *             schema:
 *               type: string
 *               example: OK
 */
app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    message: 'Welcome to App 3 API',
    version: '1.0.0',
    documentation: '/api-docs',
    endpoints: {
      users: '/api/users',
      products: '/api/products'
    }
  });
});

// Users API
/**
 * @swagger
 * /api/users:
 *   get:
 *     summary: Get all users
 *     description: Retrieve a list of all users
 *     responses:
 *       200:
 *         description: List of users
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/User'
 */
app.get('/api/users', (req, res) => {
  res.json(users);
});

/**
 * @swagger
 * /api/users/{id}:
 *   get:
 *     summary: Get user by ID
 *     description: Retrieve a single user by their ID
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *         description: User ID
 *     responses:
 *       200:
 *         description: User found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/User'
 *       404:
 *         description: User not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
app.get('/api/users/:id', (req, res) => {
  const user = users.find(u => u.id === parseInt(req.params.id));
  if (!user) {
    return res.status(404).json({ error: 'User not found', code: 404 });
  }
  res.json(user);
});

/**
 * @swagger
 * /api/users:
 *   post:
 *     summary: Create a new user
 *     description: Add a new user to the system
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - name
 *               - email
 *             properties:
 *               name:
 *                 type: string
 *                 example: 'Alice Johnson'
 *               email:
 *                 type: string
 *                 format: email
 *                 example: 'alice@example.com'
 *     responses:
 *       201:
 *         description: User created successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/User'
 *       400:
 *         description: Invalid input
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
app.post('/api/users', (req, res) => {
  const { name, email } = req.body;

  if (!name || !email) {
    return res.status(400).json({ error: 'Name and email are required', code: 400 });
  }

  const newUser = {
    id: users.length + 1,
    name,
    email,
    createdAt: new Date().toISOString()
  };

  users.push(newUser);
  res.status(201).json(newUser);
});

/**
 * @swagger
 * /api/users/{id}:
 *   put:
 *     summary: Update user
 *     description: Update an existing user's information
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *         description: User ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name:
 *                 type: string
 *                 example: 'Updated Name'
 *               email:
 *                 type: string
 *                 format: email
 *                 example: 'updated@example.com'
 *     responses:
 *       200:
 *         description: User updated successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/User'
 *       404:
 *         description: User not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
app.put('/api/users/:id', (req, res) => {
  const user = users.find(u => u.id === parseInt(req.params.id));
  if (!user) {
    return res.status(404).json({ error: 'User not found', code: 404 });
  }

  const { name, email } = req.body;
  if (name) user.name = name;
  if (email) user.email = email;

  res.json(user);
});

/**
 * @swagger
 * /api/users/{id}:
 *   delete:
 *     summary: Delete user
 *     description: Remove a user from the system
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *         description: User ID
 *     responses:
 *       200:
 *         description: User deleted successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 message:
 *                   type: string
 *                   example: 'User deleted successfully'
 *       404:
 *         description: User not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 */
app.delete('/api/users/:id', (req, res) => {
  const userIndex = users.findIndex(u => u.id === parseInt(req.params.id));
  if (userIndex === -1) {
    return res.status(404).json({ error: 'User not found', code: 404 });
  }

  users.splice(userIndex, 1);
  res.json({ message: 'User deleted successfully' });
});

// Products API
/**
 * @swagger
 * /api/products:
 *   get:
 *     summary: Get all products
 *     description: Retrieve a list of all products
 *     responses:
 *       200:
 *         description: List of products
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/Product'
 */
app.get('/api/products', (req, res) => {
  res.json(products);
});

/**
 * @swagger
 * /api/products:
 *   post:
 *     summary: Create a new product
 *     description: Add a new product to the catalog
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - name
 *               - price
 *               - category
 *             properties:
 *               name:
 *                 type: string
 *                 example: 'Smartphone'
 *               price:
 *                 type: number
 *                 format: float
 *                 example: 599.99
 *               category:
 *                 type: string
 *                 example: 'Electronics'
 *     responses:
 *       201:
 *         description: Product created successfully
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Product'
 */
app.post('/api/products', (req, res) => {
  const { name, price, category } = req.body;

  if (!name || !price || !category) {
    return res.status(400).json({ error: 'Name, price, and category are required', code: 400 });
  }

  const newProduct = {
    id: products.length + 1,
    name,
    price: parseFloat(price),
    category
  };

  products.push(newProduct);
  res.status(201).json(newProduct);
});

// API info endpoint
app.get('/api', (req, res) => {
  res.json({
    name: 'App 3 API',
    version: '1.0.0',
    description: 'A comprehensive REST API with Swagger documentation',
    endpoints: {
      users: '/api/users',
      products: '/api/products',
      docs: '/api-docs'
    },
    swagger: {
      url: '/api-docs',
      json: '/api-docs.json'
    }
  });
});

// Swagger JSON endpoint
app.get('/api-docs.json', (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.send(swaggerSpec);
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: 'Something went wrong!', code: 500 });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint not found', code: 404 });
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 App 3 API Server running on port ${PORT}`);
  console.log(`📊 Health check: http://127.0.0.1:${PORT}/health`);
  console.log(`📖 API Documentation: http://127.0.0.1:${PORT}/api-docs`);
  console.log(`🔗 API Base URL: http://127.0.0.1:${PORT}/api`);
});
