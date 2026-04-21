#!/usr/bin/env node
/**
 * ai_dev_server E2E Test
 * Zero-dependency test suite
 */

const http = require('http');
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const PORT = 3099; // Test port to avoid conflicts
const BASE_URL = `http://localhost:${PORT}`;
const TEST_LOG = 'test_error.log';
const TEST_SNAPSHOTS = './test_snapshots';

let serverProcess = null;
let passed = 0;
let failed = 0;

// Helpers
function fetch(urlPath, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, BASE_URL);
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

function assert(condition, msg) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    console.log(`  ✗ ${msg}`);
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// Cleanup
function cleanup() {
  if (fs.existsSync(TEST_LOG)) fs.unlinkSync(TEST_LOG);
  if (fs.existsSync(TEST_SNAPSHOTS)) {
    fs.readdirSync(TEST_SNAPSHOTS).forEach(f => fs.unlinkSync(path.join(TEST_SNAPSHOTS, f)));
    fs.rmdirSync(TEST_SNAPSHOTS);
  }
}

// Tests
async function testStatus() {
  console.log('\n[Test: GET /status]');
  const res = await fetch('/status');
  assert(res.status === 200, 'Status 200');
  const data = JSON.parse(res.data);
  assert(data.ok === true, 'ok: true');
  assert(data.port === PORT, `port: ${PORT}`);
  assert(typeof data.uptime === 'number', 'uptime is number');
}

async function testErrorPost() {
  console.log('\n[Test: POST /error]');
  const res = await fetch('/error', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'test', message: 'E2E test error' })
  });
  assert(res.status === 200, 'Status 200');
  const data = JSON.parse(res.data);
  assert(data.ok === true, 'ok: true');
}

async function testErrorGet() {
  console.log('\n[Test: GET /log]');
  const res = await fetch('/log');
  assert(res.status === 200, 'Status 200');
  const data = JSON.parse(res.data);
  assert(Array.isArray(data), 'Returns array');
  assert(data.length > 0, 'Has entries');
  assert(data.some(e => e.message === 'E2E test error'), 'Contains test error');
}

async function testErrorClear() {
  console.log('\n[Test: DELETE /log]');
  const res = await fetch('/log', { method: 'DELETE' });
  assert(res.status === 200, 'Status 200');

  const res2 = await fetch('/log');
  const data = JSON.parse(res2.data);
  assert(data.length === 0, 'Log is empty after clear');
}

async function testSnapshotPost() {
  console.log('\n[Test: POST /snapshot]');
  const res = await fetch('/snapshot', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      html: '<div id="test">E2E Snapshot Test</div>',
      styles: '.test { color: red; }',
      error: 'Test snapshot error',
      url: 'http://test.local/'
    })
  });
  assert(res.status === 200, 'Status 200');
  const data = JSON.parse(res.data);
  assert(data.ok === true, 'ok: true');
  assert(data.file && data.file.endsWith('.html'), 'Returns filename');
}

async function testSnapshotList() {
  console.log('\n[Test: GET /snapshots]');
  const res = await fetch('/snapshots');
  assert(res.status === 200, 'Status 200');
  const data = JSON.parse(res.data);
  assert(Array.isArray(data), 'Returns array');
  assert(data.length > 0, 'Has snapshots');
  assert(data[0].name && data[0].path, 'Has name and path');
}

async function testSnapshotServe() {
  console.log('\n[Test: GET /snapshots/:file]');
  const list = await fetch('/snapshots');
  const snapshots = JSON.parse(list.data);
  if (snapshots.length === 0) {
    assert(false, 'No snapshots to test');
    return;
  }

  const res = await fetch(snapshots[0].path);
  assert(res.status === 200, 'Status 200');
  assert(res.headers['content-type'].includes('text/html'), 'Content-Type is HTML');
  assert(res.data.includes('E2E Snapshot Test'), 'Contains snapshot content');
  assert(res.data.includes('Test snapshot error'), 'Contains error in comment');
}

async function testStaticServe() {
  console.log('\n[Test: Static file serving]');
  const res = await fetch('/');
  assert(res.status === 200, 'Status 200 for index.html');
  assert(res.data.includes('Click Game'), 'Serves index.html');
}

async function testCORS() {
  console.log('\n[Test: CORS headers]');
  const res = await fetch('/status', { method: 'OPTIONS' });
  assert(res.status === 200, 'OPTIONS returns 200');
  assert(res.headers['access-control-allow-origin'] === '*', 'Allow-Origin: *');
}

async function testInvalidJSON() {
  console.log('\n[Test: Invalid JSON handling]');
  const res = await fetch('/error', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: 'not json'
  });
  assert(res.status === 400, 'Status 400 for invalid JSON');
}

async function test404() {
  console.log('\n[Test: 404 handling]');
  const res = await fetch('/nonexistent-file.xyz');
  assert(res.status === 404, 'Status 404 for missing file');
}

// Main
async function runTests() {
  console.log('=== ai_dev_server E2E Test ===\n');

  // Cleanup before
  cleanup();

  // Start server
  console.log('Starting server...');
  serverProcess = spawn('node', ['ai_dev_server.js'], {
    env: {
      ...process.env,
      PORT: PORT.toString(),
      LOG_FILE: TEST_LOG,
      SNAPSHOT_DIR: TEST_SNAPSHOTS
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  // Wait for server to start
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Server start timeout')), 5000);
    serverProcess.stdout.on('data', (data) => {
      if (data.toString().includes('ai-dev-server running')) {
        clearTimeout(timeout);
        resolve();
      }
    });
    serverProcess.on('error', reject);
  });

  console.log(`Server started on port ${PORT}\n`);

  try {
    await testStatus();
    await testErrorPost();
    await testErrorGet();
    await testSnapshotPost();
    await testSnapshotList();
    await testSnapshotServe();
    await testStaticServe();
    await testCORS();
    await testInvalidJSON();
    await test404();
    await testErrorClear();
  } catch (e) {
    console.error('\nTest error:', e.message);
    failed++;
  }

  // Summary
  console.log('\n=== Results ===');
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);

  // Cleanup
  serverProcess.kill();
  await sleep(500);
  cleanup();

  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(e => {
  console.error('Fatal error:', e);
  if (serverProcess) serverProcess.kill();
  cleanup();
  process.exit(1);
});
