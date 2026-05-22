'use strict';

// Throughline Web server — does two jobs:
//   1. Serves the accessible web app (public/).
//   2. Acts as a WebSocket relay between the web app and the Figma Bridge
//      plugin, so navigation in one drives the canvas in the other.

const path = require('path');
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');

const { buildA11yTree } = require('./build-a11y-tree');

const PORT = process.env.PORT || 4400;

const app = express();
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
console.log('Loaded ' + base.meta.source + ' design: ' + currentTree.title);

app.get('/api/design', (_req, res) => res.json(currentTree));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

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

      default:
        break;
    }
  });

  socket.on('close', () => {
    // wss.clients no longer includes this socket by the time this fires.
    broadcast('web', { type: 'bridge', connected: countRole('plugin') > 0 });
  });
});

server.listen(PORT, () => {
  console.log(`Throughline Web running at http://localhost:${PORT}`);
});
