#!/usr/bin/env node
//@ order = $SERVER01, $CLIENT01
const http = require('http');
const fs = require('fs');
const path = require('path');

//{ 01:Server @high #core $1D04407FA
const { execSync } = require('child_process');

const BASE_PORT = parseInt(process.env.PORT) || 3000;
const MAX_PORT_TRIES = 10;
const LOG_FILE = process.env.LOG_FILE || 'error.log';
const STATIC_DIR = process.env.STATIC_DIR || '.';
const SNAPSHOT_DIR = process.env.SNAPSHOT_DIR || './snapshots';
const AUTO_KILL = process.argv.includes('--kill');

const MIME_TYPES = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

// Ensure snapshot directory exists
if (!fs.existsSync(SNAPSHOT_DIR)) {
  fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
}

function findProcessOnPort(port) {
  try {
    const result = execSync(`lsof -ti:${port}`, { encoding: 'utf8' }).trim();
    return result ? result.split('\n').map(p => parseInt(p)) : [];
  } catch {
    return [];
  }
}

function killProcessOnPort(port) {
  const pids = findProcessOnPort(port);
  if (pids.length === 0) return false;
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGTERM');
      console.log(`Killed process ${pid} on port ${port}`);
    } catch (e) {
      console.error(`Failed to kill ${pid}: ${e.message}`);
    }
  }
  return true;
}

function logError(entry) {
  const timestamp = new Date().toISOString();
  const line = JSON.stringify({ timestamp, ...entry }) + '\n';
  fs.appendFileSync(LOG_FILE, line);
  console.error(`[${timestamp}] ${entry.type}: ${entry.message}`);
}

function serveStatic(req, res) {
  const urlPath = req.url.split('?')[0];
  let filePath = path.join(STATIC_DIR, urlPath === '/' ? 'index.html' : urlPath);
  const ext = path.extname(filePath);
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
}

function handleErrorPost(req, res) {
  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', () => {
    try {
      const entry = JSON.parse(body);
      logError(entry);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    } catch (e) {
      res.writeHead(400);
      res.end('Invalid JSON');
    }
  });
}

function handleSnapshotPost(req, res) {
  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', () => {
    try {
      const data = JSON.parse(body);
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const filename = `snapshot_${timestamp}.html`;
      const filepath = path.join(SNAPSHOT_DIR, filename);

      // Save HTML with inline styles
      const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Snapshot ${timestamp}</title>
  <style>${data.styles || ''}</style>
</head>
<body>
  <!-- Snapshot taken at ${data.timestamp || timestamp} -->
  <!-- Error: ${data.error || 'N/A'} -->
  <!-- URL: ${data.url || 'N/A'} -->
  ${data.html || ''}
</body>
</html>`;

      fs.writeFileSync(filepath, html);
      console.error(`[${timestamp}] snapshot: Saved ${filename}`);

      // Also log the snapshot event
      logError({
        type: 'snapshot',
        message: `Snapshot saved: ${filename}`,
        file: filepath,
        error: data.error || null,
        url: data.url || null
      });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, file: filename }));
    } catch (e) {
      res.writeHead(400);
      res.end('Invalid JSON');
    }
  });
}

function handleSnapshotList(req, res) {
  if (!fs.existsSync(SNAPSHOT_DIR)) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('[]');
    return;
  }
  const files = fs.readdirSync(SNAPSHOT_DIR)
    .filter(f => f.endsWith('.html'))
    .map(f => ({
      name: f,
      path: `/snapshots/${f}`,
      time: fs.statSync(path.join(SNAPSHOT_DIR, f)).mtime
    }))
    .sort((a, b) => b.time - a.time);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(files, null, 2));
}

function handleLogGet(req, res) {
  if (!fs.existsSync(LOG_FILE)) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('[]');
    return;
  }
  const content = fs.readFileSync(LOG_FILE, 'utf8');
  const lines = content.trim().split('\n').filter(l => l);
  const entries = lines.map(l => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(e => e);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(entries, null, 2));
}

function handleLogClear(req, res) {
  fs.writeFileSync(LOG_FILE, '');
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end('{"ok":true,"message":"Log cleared"}');
}

function handleStatusGet(req, res) {
  const snapshots = fs.existsSync(SNAPSHOT_DIR)
    ? fs.readdirSync(SNAPSHOT_DIR).filter(f => f.endsWith('.html')).length
    : 0;
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    ok: true,
    port: currentPort,
    staticDir: path.resolve(STATIC_DIR),
    logFile: path.resolve(LOG_FILE),
    snapshotDir: path.resolve(SNAPSHOT_DIR),
    snapshotCount: snapshots,
    uptime: process.uptime()
  }, null, 2));
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  const urlPath = req.url.split('?')[0];

  if (req.method === 'POST' && urlPath === '/error') {
    handleErrorPost(req, res);
  } else if (req.method === 'POST' && urlPath === '/snapshot') {
    handleSnapshotPost(req, res);
  } else if (req.method === 'GET' && urlPath === '/snapshots') {
    handleSnapshotList(req, res);
  } else if (req.method === 'GET' && urlPath.startsWith('/snapshots/')) {
    // Serve snapshot files
    const file = urlPath.replace('/snapshots/', '');
    const filepath = path.join(SNAPSHOT_DIR, file);
    if (fs.existsSync(filepath)) {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(fs.readFileSync(filepath));
    } else {
      res.writeHead(404);
      res.end('Not Found');
    }
  } else if (req.method === 'GET' && urlPath === '/log') {
    handleLogGet(req, res);
  } else if (req.method === 'DELETE' && urlPath === '/log') {
    handleLogClear(req, res);
  } else if (req.method === 'GET' && urlPath === '/status') {
    handleStatusGet(req, res);
  } else if (req.method === 'GET') {
    serveStatic(req, res);
  } else {
    res.writeHead(405);
    res.end('Method Not Allowed');
  }
});

let currentPort = BASE_PORT;

function tryListen(port, attempt = 1) {
  if (attempt > MAX_PORT_TRIES) {
    console.error(`ERROR: Could not find open port after ${MAX_PORT_TRIES} attempts (tried ${BASE_PORT}-${port - 1})`);
    console.error(`Try: node ai_dev_server.js --kill`);
    process.exit(1);
  }

  const pids = findProcessOnPort(port);
  if (pids.length > 0) {
    if (AUTO_KILL) {
      killProcessOnPort(port);
      setTimeout(() => tryListen(port, attempt), 500);
      return;
    }
    console.error(`Port ${port} in use by PID: ${pids.join(', ')}`);
    console.log(`Trying port ${port + 1}...`);
    tryListen(port + 1, attempt + 1);
    return;
  }

  server.listen(port, () => {
    currentPort = port;
    console.log(`\n✓ ai-dev-server running on http://localhost:${port}`);
    console.log(`  Static:    ${path.resolve(STATIC_DIR)}`);
    console.log(`  Log:       ${path.resolve(LOG_FILE)}`);
    console.log(`  Snapshots: ${path.resolve(SNAPSHOT_DIR)}`);
    console.log(`\nEndpoints:`);
    console.log(`  POST /error     - Log error`);
    console.log(`  POST /snapshot  - Save HTML snapshot`);
    console.log(`  GET  /log       - Get errors`);
    console.log(`  GET  /snapshots - List snapshots`);
    console.log(`  GET  /status    - Server status`);
    if (port !== BASE_PORT) {
      console.log(`\n⚠ Note: Using port ${port} instead of ${BASE_PORT}`);
    }
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`Port ${port} already in use`);
      tryListen(port + 1, attempt + 1);
    } else {
      console.error(`Server error: ${err.message}`);
      process.exit(1);
    }
  });
}

tryListen(BASE_PORT);
//}

//{ 02:ClientSnippet @mid #docs $166FC3643
/*
 * ブラウザ側に貼るコード (コピペ用)
 *
 * <script>
 * (function() {
 *   const SERVER = 'http://localhost:3000';
 *
 *   function sendError(entry) {
 *     fetch(SERVER + '/error', {
 *       method: 'POST',
 *       headers: { 'Content-Type': 'application/json' },
 *       body: JSON.stringify(entry)
 *     }).catch(() => {});
 *   }
 *
 *   window.onerror = function(msg, src, line, col, err) {
 *     sendError({
 *       type: 'error',
 *       message: msg,
 *       source: src,
 *       line: line,
 *       column: col,
 *       stack: err?.stack || ''
 *     });
 *   };
 *
 *   window.onunhandledrejection = function(e) {
 *     sendError({
 *       type: 'unhandledrejection',
 *       message: e.reason?.message || String(e.reason),
 *       stack: e.reason?.stack || ''
 *     });
 *   };
 *
 *   const origConsoleError = console.error;
 *   console.error = function(...args) {
 *     sendError({
 *       type: 'console.error',
 *       message: args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ')
 *     });
 *     origConsoleError.apply(console, args);
 *   };
 * })();
 * </script>
 */
//}
