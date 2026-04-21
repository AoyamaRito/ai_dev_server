#!/usr/bin/env node
//@ order = $1D04407FA, $166FC3643, $E2E0TEST1, $MAIN00001
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

let lastError = { message: '', time: 0, count: 0 };
const DEDUP_WINDOW_MS = 5000; // 5秒以内の同一エラーは集約

function logError(entry) {
  const now = Date.now();
  const key = `${entry.type}:${entry.message}`;

  // 同一エラーが5秒以内に再発 → カウントのみ
  if (lastError.message === key && (now - lastError.time) < DEDUP_WINDOW_MS) {
    lastError.count++;
    lastError.time = now;
    return; // ログ書き込みスキップ
  }

  // 前の重複エラーがあれば書き出し
  if (lastError.count > 0) {
    const dupLine = JSON.stringify({
      timestamp: new Date(lastError.time).toISOString(),
      type: 'repeated',
      message: `Previous error repeated ${lastError.count} more times`
    }) + '\n';
    fs.appendFileSync(LOG_FILE, dupLine);
    console.error(`[repeated] Previous error x${lastError.count}`);
  }

  // 新規エラー記録
  lastError = { message: key, time: now, count: 0 };
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

//{ 03:E2ETest @mid #test $E2E0TEST1
const { spawn } = require('child_process');

const TEST_PORT = 3099;
const TEST_LOG = 'test_error.log';
const TEST_SNAPSHOTS = './test_snapshots';

function testFetch(urlPath, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, `http://localhost:${TEST_PORT}`);
    const req = http.request(url, {
      method: options.method || 'GET',
      headers: options.headers || {}
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, data, headers: res.headers }));
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

function testCleanup() {
  if (fs.existsSync(TEST_LOG)) fs.unlinkSync(TEST_LOG);
  if (fs.existsSync(TEST_SNAPSHOTS)) {
    fs.readdirSync(TEST_SNAPSHOTS).forEach(f => fs.unlinkSync(path.join(TEST_SNAPSHOTS, f)));
    fs.rmdirSync(TEST_SNAPSHOTS);
  }
}

async function runE2ETests() {
  console.log('=== ai_dev_server E2E Test ===\n');
  testCleanup();

  let passed = 0, failed = 0;
  const assert = (cond, msg) => {
    if (cond) { passed++; console.log(`  ✓ ${msg}`); }
    else { failed++; console.log(`  ✗ ${msg}`); }
  };

  // Start test server
  console.log('Starting test server...');
  const serverProc = spawn(process.execPath, [__filename], {
    env: { ...process.env, PORT: TEST_PORT, LOG_FILE: TEST_LOG, SNAPSHOT_DIR: TEST_SNAPSHOTS },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Server start timeout')), 5000);
    serverProc.stdout.on('data', (d) => {
      if (d.toString().includes('ai-dev-server running')) { clearTimeout(timeout); resolve(); }
    });
    serverProc.on('error', reject);
  });
  console.log(`Server started on port ${TEST_PORT}\n`);

  try {
    // GET /status
    console.log('[Test: GET /status]');
    let res = await testFetch('/status');
    assert(res.status === 200, 'Status 200');
    let data = JSON.parse(res.data);
    assert(data.ok === true, 'ok: true');
    assert(data.port === TEST_PORT, `port: ${TEST_PORT}`);

    // POST /error
    console.log('\n[Test: POST /error]');
    res = await testFetch('/error', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'test', message: 'E2E test error' })
    });
    assert(res.status === 200, 'Status 200');
    assert(JSON.parse(res.data).ok === true, 'ok: true');

    // GET /log
    console.log('\n[Test: GET /log]');
    res = await testFetch('/log');
    assert(res.status === 200, 'Status 200');
    data = JSON.parse(res.data);
    assert(Array.isArray(data) && data.length > 0, 'Has entries');
    assert(data.some(e => e.message === 'E2E test error'), 'Contains test error');

    // POST /snapshot
    console.log('\n[Test: POST /snapshot]');
    res = await testFetch('/snapshot', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ html: '<div>E2E Test</div>', styles: '.t{color:red}', error: 'Test error', url: 'http://test/' })
    });
    assert(res.status === 200, 'Status 200');
    data = JSON.parse(res.data);
    assert(data.ok && data.file.endsWith('.html'), 'Returns filename');

    // GET /snapshots
    console.log('\n[Test: GET /snapshots]');
    res = await testFetch('/snapshots');
    assert(res.status === 200, 'Status 200');
    data = JSON.parse(res.data);
    assert(Array.isArray(data) && data.length > 0, 'Has snapshots');

    // GET /snapshots/:file
    console.log('\n[Test: GET /snapshots/:file]');
    res = await testFetch(data[0].path);
    assert(res.status === 200, 'Status 200');
    assert(res.data.includes('E2E Test'), 'Contains content');

    // Static serving
    console.log('\n[Test: Static serving]');
    res = await testFetch('/');
    assert(res.status === 200, 'Status 200');

    // CORS
    console.log('\n[Test: CORS]');
    res = await testFetch('/status', { method: 'OPTIONS' });
    assert(res.headers['access-control-allow-origin'] === '*', 'Allow-Origin: *');

    // Invalid JSON
    console.log('\n[Test: Invalid JSON]');
    res = await testFetch('/error', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'bad' });
    assert(res.status === 400, 'Status 400');

    // 404
    console.log('\n[Test: 404]');
    res = await testFetch('/nonexistent.xyz');
    assert(res.status === 404, 'Status 404');

    // DELETE /log
    console.log('\n[Test: DELETE /log]');
    res = await testFetch('/log', { method: 'DELETE' });
    assert(res.status === 200, 'Status 200');
    res = await testFetch('/log');
    assert(JSON.parse(res.data).length === 0, 'Log cleared');

  } catch (e) {
    console.error('\nTest error:', e.message);
    failed++;
  }

  console.log('\n=== Results ===');
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);

  serverProc.kill();
  await new Promise(r => setTimeout(r, 300));
  testCleanup();
  process.exit(failed > 0 ? 1 : 0);
}
//}

//{ 04:Main @high #entry $MAIN00001
function showHelp() {
  console.log(`
ai-dev-server v0.3.0 - Zero-dependency dev server for AI coders

USAGE:
  node ai_dev_server.js [OPTIONS]

OPTIONS:
  --help     Show this help
  --test     Run E2E tests (20 tests)
  --kill     Kill existing process on port before starting

ENVIRONMENT:
  PORT          Server port (default: 3000)
  LOG_FILE      Error log path (default: error.log)
  STATIC_DIR    Static files directory (default: .)
  SNAPSHOT_DIR  Snapshot directory (default: ./snapshots)

ENDPOINTS:
  POST /error      Log browser error (JSON body)
  POST /snapshot   Save HTML snapshot (JSON: html, styles, error, url)
  GET  /log        Get all logged errors
  DELETE /log      Clear error log
  GET  /snapshots  List saved snapshots
  GET  /snapshots/:file  View snapshot
  GET  /status     Server status

BROWSER SNIPPET (paste in your HTML):
  <script>
  (function(){
    const S='http://localhost:3000';
    window.onerror=(m,s,l,c,e)=>{
      fetch(S+'/error',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({type:'error',message:m,source:s,line:l,column:c,stack:e?.stack||''})});
      fetch(S+'/snapshot',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({html:document.body.innerHTML,error:m,url:location.href})});
    };
  })();
  </script>

FOR AI CODERS (token-efficient):
  tail -1 error.log                  # Last error (1 line, minimal tokens)
  tail -5 error.log                  # Last 5 errors
  ls snapshots/                      # List snapshots
  head snapshots/snapshot_*.html     # View snapshot

FOR HUMANS (full JSON):
  curl localhost:3000/log            # All errors as JSON array
  curl localhost:3000/snapshots      # Snapshots with metadata

EXAMPLES:
  node ai_dev_server.js              # Start server on port 3000
  PORT=8080 node ai_dev_server.js    # Start on port 8080
  node ai_dev_server.js --kill       # Kill existing & start
  node ai_dev_server.js --test       # Run E2E tests
`);
}

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  showHelp();
} else if (process.argv.includes('--test')) {
  runE2ETests();
} else {
  tryListen(BASE_PORT);
}
//}
