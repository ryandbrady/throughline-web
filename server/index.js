'use strict';

// Throughline Web server — does several jobs:
//   1. Serves the accessible web app (public/).
//   2. Acts as a WebSocket relay between the web app and the Figma Bridge
//      plugin, so navigation in one drives the canvas in the other.
//   3. Renders the selected node to a PNG via the Figma REST API (/api/image).
//   4. Generates AI accessibility descriptions via Claude (/api/describe).
//   5. Writes review comments back to the Figma file (/api/comment).

require('dotenv').config();

const path = require('path');
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');

const { buildA11yTree } = require('./build-a11y-tree');
const { renderNodeImage } = require('./figma-images');
const { describeNode } = require('./describe');
const { postComment } = require('./figma-comments');

const PORT = process.env.PORT || 4400;

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

// Pick the starting design: a real Figma file imported via the MCP
// (server/real-design.js, written by tools/import-figma-metadata.js) if it
// exists, otherwise the bundled mock so the app always runs.
function loadBaseDesign() {
  try {
    const real = require('./real-design');
    return { design: real, meta: { source: 'figma', title: real.name } };
  } catch {
    const mock = require('./mock-design');
    return {
      design: mock,
      meta: { source: 'mock', title: 'Demo file — connect the Figma Bridge plugin to go live' },
    };
  }
}

// The most recent accessibility tree. Replaced when the Figma Bridge plugin
// connects and pushes a live document.
const base = loadBaseDesign();
let currentTree = buildA11yTree(base.design, base.meta);
// Last file key we've seen. The Bridge plugin can't always read figma.fileKey,
// so a plugin push may arrive without one — don't let that erase a good key.
let knownFileKey = currentTree.fileKey || null;
console.log('Loaded ' + base.meta.source + ' design: ' + currentTree.title);

app.get('/api/design', (_req, res) => res.json(currentTree));

// File key resolution: explicit env override, else the current design's key,
// else the last good key we saw (real-design.js embeds one; the plugin may not).
function resolveFileKey() {
  return process.env.FIGMA_FILE_KEY || currentTree.fileKey || knownFileKey;
}

// Find a node in the current accessibility tree, tracking its depth
// (1 = page, 2 = top-level screen, 3+ = nested element).
function findNode(nodes, id, depth) {
  for (const n of nodes) {
    if (n.id === id) return { node: n, depth };
    const found = findNode(n.children, id, depth + 1);
    if (found) return found;
  }
  return null;
}

// --- Node images -------------------------------------------------------
// Prefer the Bridge plugin: it exports whatever file is actually open, so the
// image always matches and no Figma file key is involved. The REST API is the
// fallback for snapshot mode (no plugin connected).

const pendingExports = new Map(); // requestId -> { resolve, timer }
let exportSeq = 0;

function requestPluginImage(nodeId) {
  if (countRole('plugin') === 0) return Promise.resolve(null);
  return new Promise((resolve) => {
    const requestId = 'exp' + ++exportSeq;
    const timer = setTimeout(() => {
      pendingExports.delete(requestId);
      resolve(null);
    }, 15000);
    pendingExports.set(requestId, { resolve, timer });
    broadcast('plugin', { type: 'export-request', requestId, nodeId });
  });
}

async function getNodeImage(nodeId) {
  const fromPlugin = await requestPluginImage(nodeId);
  if (fromPlugin) return { ok: true, url: fromPlugin };
  const rest = await renderNodeImage(nodeId, resolveFileKey());
  if (rest.ok) return { ok: true, url: rest.url };
  return { ok: false, reason: rest.reason };
}

// Resolve a node to base64 PNG data for Claude — handles both a data URL
// (from the plugin) and an http URL (from REST).
async function nodeImageBase64(nodeId) {
  const image = await getNodeImage(nodeId);
  if (!image.ok) return null;

  let base64 = null;
  if (image.url.startsWith('data:')) {
    const comma = image.url.indexOf(',');
    base64 = comma >= 0 ? image.url.slice(comma + 1) : null;
  } else {
    try {
      const res = await fetch(image.url);
      if (res.ok) base64 = Buffer.from(await res.arrayBuffer()).toString('base64');
    } catch {
      base64 = null;
    }
  }

  // Skip an oversized image rather than risk a Claude API rejection — the
  // description simply falls back to structure-only.
  if (base64 && base64.length > 5000000) return null;
  return base64;
}

// Live visual preview of the selected node.
app.get('/api/image', async (req, res) => {
  const nodeId = req.query.nodeId;
  if (!nodeId) return res.json({ ok: false, reason: 'no-node-id' });
  res.json(await getNodeImage(String(nodeId)));
});

// AI accessibility description. The description's angle is chosen from the
// node's depth — a page gets an overview, a screen gets design intent, a
// nested node gets an element description. `topic` requests a deep dive.
const TOPICS = ['color', 'layout', 'imagery'];
app.get('/api/describe', async (req, res) => {
  const nodeId = String(req.query.nodeId || '');
  if (!nodeId) return res.json({ ok: false, reason: 'no-node-id' });
  const found = findNode(currentTree.pages, nodeId, 1);
  if (!found) return res.json({ ok: false, reason: 'unknown-node' });

  const topic = TOPICS.includes(req.query.topic) ? req.query.topic : null;
  const mode = topic
    ? 'topic'
    : found.depth === 1
    ? 'overview'
    : found.depth === 2
    ? 'screen'
    : 'element';

  const result = await describeNode({
    node: found.node,
    mode,
    topic,
    apiKey: req.get('x-anthropic-key') || '',
    imageBase64: await nodeImageBase64(nodeId),
  });
  res.json(result);
});

// Write-back: post a review comment to the Figma file, pinned to the node.
app.post('/api/comment', async (req, res) => {
  const body = req.body || {};
  const result = await postComment(resolveFileKey(), String(body.nodeId || ''), body.message);
  res.json(result);
});

// WebSocket server in noServer mode — attached to the loopback HTTP servers
// created in listenLoopback() below.
const wss = new WebSocketServer({ noServer: true });

// Sockets are tagged 'web' or 'plugin' once they send a `hello` message.
function countRole(role) {
  let n = 0;
  for (const c of wss.clients) if (c.role === role) n += 1;
  return n;
}

function broadcast(role, payload) {
  const data = JSON.stringify(payload);
  for (const c of wss.clients) {
    if (c.role === role && c.readyState === 1) c.send(data);
  }
}

wss.on('connection', (socket) => {
  socket.role = 'unknown';

  socket.on('message', (buf) => {
    let msg;
    try {
      msg = JSON.parse(buf.toString());
    } catch {
      return;
    }

    switch (msg.type) {
      case 'hello':
        socket.role = msg.role === 'plugin' ? 'plugin' : 'web';
        socket.send(JSON.stringify({ type: 'welcome', source: currentTree.source }));
        broadcast('web', { type: 'bridge', connected: countRole('plugin') > 0 });
        break;

      case 'document':
        // The plugin pushed the live Figma document — rebuild and fan out.
        currentTree = buildA11yTree(msg.document, { source: 'figma' });
        if (currentTree.fileKey) knownFileKey = currentTree.fileKey;
        broadcast('web', { type: 'design', tree: currentTree });
        break;

      case 'focus':
        // A web user activated a node — ask the plugin to reveal it on canvas.
        broadcast('plugin', { type: 'focus', nodeId: msg.nodeId });
        break;

      case 'selection':
        // The canvas selection changed — tell web clients to follow it.
        broadcast('web', { type: 'selection', nodeId: msg.nodeId });
        break;

      case 'export-result': {
        // The plugin finished exporting a node image — resolve the waiter.
        const pending = pendingExports.get(msg.requestId);
        if (pending) {
          clearTimeout(pending.timer);
          pendingExports.delete(msg.requestId);
          pending.resolve(msg.ok ? msg.dataUrl : null);
        }
        break;
      }

      default:
        break;
    }
  });

  socket.on('close', () => {
    // wss.clients no longer includes this socket by the time this fires.
    broadcast('web', { type: 'bridge', connected: countRole('plugin') > 0 });
  });
});

// Listen on loopback only — both IPv4 (127.0.0.1) and IPv6 (::1), so the app is
// reachable as "localhost" however the OS resolves it, but never from other
// machines on the network. Keeps the Figma token and API keys on this host.
function listenLoopback(host) {
  const server = http.createServer(app);
  server.on('upgrade', (req, socket, head) => {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });
  server.on('error', (err) => {
    if (err.code === 'EADDRNOTAVAIL') return; // host lacks this loopback (e.g. no IPv6)
    if (err.code === 'EADDRINUSE') {
      console.error('Port ' + PORT + ' already in use on ' + host);
      return;
    }
    throw err;
  });
  server.listen(PORT, host);
}

listenLoopback('127.0.0.1');
listenLoopback('::1');
console.log('Throughline Web running at http://localhost:' + PORT + ' (loopback only)');
