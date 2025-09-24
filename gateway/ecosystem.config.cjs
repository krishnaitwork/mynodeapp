/**
 * PM2 ecosystem file (CommonJS) for environments where Node treats files as ESM.
 * This mirrors the existing ecosystem.config.js but uses CommonJS exports so PM2
 * can require it reliably even when the workspace is ESM.
 */
module.exports = {
  apps: [
    {
      name: 'gateway',
      // Run in fork mode on Windows to avoid cluster worker ESM loader path issues
      exec_mode: 'fork',
      script: 'gateway.js',
      cwd: __dirname,
      interpreter: 'node',
      env: {
        NODE_ENV: 'production',
        GATEWAY_ADMIN_TOKEN: process.env.GATEWAY_ADMIN_TOKEN || 'changeme-dev-token',
        // Default to disabled under pm2; use '1' to enable
        GATEWAY_ADMIN_WS: process.env.GATEWAY_ADMIN_WS || '0'
      },
      autorestart: true,
      watch: false,
      instances: 1,
      max_memory_restart: '200M',
      log_date_format: 'YYYY-MM-DD HH:mm Z',
      out_file: './logs/gateway-out.log',
      error_file: './logs/gateway-err.log'
    }
  ]
};
