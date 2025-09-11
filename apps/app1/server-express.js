const express = require("express");
const swaggerUi = require("swagger-ui-express");
const swaggerJSDoc = require("swagger-jsdoc");

const app = express();
const PORT = 3000;

const path = require("path");
const fs = require("fs");
const http = require("http");

app.use(express.json());

// Directory where media files live for app1
const mediaDir = path.join(__dirname, "media");
fs.mkdirSync(mediaDir, { recursive: true });

/**
 * GET /img/:file - proxy authentication to app2 and serve file when authorized
 */
app.get("/img/:file", (req, res) => {
  try {
    const file = req.params.file;
    const imgPath = `/img/${file}`;

    // Build callback and auth URLs dynamically from incoming request headers
    // Use X-Forwarded-* headers when available (set by gateway), fallback to direct headers
    const forwardedProto =
      req.headers["x-forwarded-proto"] || req.protocol || "https";
    const forwardedHost =
      req.headers["x-forwarded-host"] || req.headers.host || "127.0.0.1:3000";

    // Extract the scheme and use the first one if comma-separated
    const scheme = forwardedProto.split(",")[0].trim();

    // Build callback URL using the same host/port that the browser used
    const callback = `${scheme}://${forwardedHost}/auth-callback`;

    // For auth host, try to derive the auth domain:
    // - If host is an IP (127.0.0.1, localhost), use the same host but different port/path
    // - If host is a domain (local.console), prefix with 'app.'
    const hostOnly = forwardedHost.split(":")[0];
    let authHost;

    if (
      hostOnly === "127.0.0.1" ||
      hostOnly === "localhost" ||
      /^\d+\.\d+\.\d+\.\d+$/.test(hostOnly)
    ) {
      // For IP addresses, we can't do subdomain routing, so use same host
      // You'll need to configure your gateway to route based on path or port
      authHost = forwardedHost;
    } else {
      // For domain names, prefix with 'app.' for auth service
      authHost = hostOnly.startsWith("app.") ? hostOnly : `app.${hostOnly}`;
      // Preserve port if present in original host
      const portMatch = forwardedHost.match(/:(\d+)$/);
      if (portMatch) authHost += portMatch[0];
    }

    const authUrl = `${scheme}://${authHost}/auth`;
    const u = new URL(authUrl);
    u.searchParams.set("path", imgPath);
    u.searchParams.set("callback", callback);

    console.log(`[app1] Redirecting to auth: ${u.toString()}`);
    console.log(`[app1] Callback will be: ${callback}`);

    // Redirect browser to auth provider (app2). It will redirect back to /auth-callback
    res.redirect(302, u.toString());
  } catch (err) {
    console.error("[app1] /img handler error:", err);
    res.status(500).send("Internal Server Error");
  }
});

/**
 * GET /auth-callback?path=/media/1.jpg&auth=true
 * Receives callback from app2 and serves the media if auth=true
 */
app.get("/auth-callback", (req, res) => {
  const { path: mediaPath, auth } = req.query;
  if (auth !== "true" || !mediaPath) return res.status(403).send("Forbidden");
  const filename = path.basename(mediaPath);
  let full = path.join(mediaDir, filename);
  if (!fs.existsSync(full)) {
    const base = path.parse(filename).name;
    const svgAlt = path.join(mediaDir, `${base}.svg`);
    if (fs.existsSync(svgAlt)) {
      res.type("image/svg+xml");
      return res.sendFile(svgAlt);
    }
    return res.status(404).send("Not found");
  }
  return res.sendFile(full);
});

const swaggerSpec = swaggerJSDoc({
  definition: {
    openapi: "3.0.0",
    info: {
      title: "App 1 API",
      version: "1.0.0",
      description: "Minimal API with one method",
    },
  },
  apis: ["./server-express.js"],
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
app.get("/health", (req, res) =>{
    console.log('Health is okay');
    res.send("OK");
});

app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(swaggerSpec));

app.listen(PORT, () =>
  console.log(
    `App 1 listening on port ${PORT} - Swagger UI: http://127.0.0.1:${PORT}/api-docs`
  )
);
