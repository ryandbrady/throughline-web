// Throughline Web Bridge — runs inside Figma.
//
// This sandbox half walks the document and drives canvas selection. It has no
// network access; the UI iframe (ui.html) owns the WebSocket and relays
// messages here via postMessage.

figma.showUI(__html__, { width: 340, height: 260 });

// --- Snapshot the document into the lightweight raw-node shape ------------
// (matches what server/build-a11y-tree.js consumes).

function rawNode(node) {
  const out = {
    id: node.id,
    name: node.name,
    type: node.type,
    visible: node.visible !== false,
  };
  if (node.type === 'TEXT') {
    out.characters = node.characters;
    if (typeof node.fontSize === 'number') out.fontSize = node.fontSize;
  }
  if ('fills' in node && Array.isArray(node.fills)) {
    out.hasImageFill = node.fills.some(function (f) {
      return f.type === 'IMAGE' && f.visible !== false;
    });
  }
  if ('children' in node) {
    out.children = node.children.map(rawNode);
  }
  return out;
}

function snapshotDocument() {
  return {
    id: figma.root.id,
    name: figma.root.name,
    type: 'DOCUMENT',
    fileKey: figma.fileKey, // lets the web app render REST image previews
    children: figma.root.children.map(function (page) {
      return {
        id: page.id,
        name: page.name,
        type: 'CANVAS',
        visible: true,
        children: page.children.map(rawNode),
      };
    }),
  };
}

// --- Reveal a node on the canvas -----------------------------------------

async function revealNode(nodeId) {
  const node = await figma.getNodeByIdAsync(nodeId);
  if (!node) {
    figma.ui.postMessage({ type: 'reveal-result', ok: false, nodeId: nodeId });
    return;
  }

  // Switch to the page that owns the node, if it isn't the current one.
  let page = node;
  while (page && page.type !== 'PAGE') page = page.parent;
  if (page && page.type === 'PAGE' && page !== figma.currentPage) {
    await figma.setCurrentPageAsync(page);
  }

  if (node.type !== 'PAGE' && node.type !== 'DOCUMENT') {
    figma.currentPage.selection = [node];
    figma.viewport.scrollAndZoomIntoView([node]);
  }
  figma.ui.postMessage({ type: 'reveal-result', ok: true, nodeId: nodeId, name: node.name });
}

// --- Wiring --------------------------------------------------------------

figma.ui.onmessage = function (msg) {
  if (msg.type === 'request-document' || msg.type === 'rescan') {
    figma.ui.postMessage({ type: 'document', document: snapshotDocument() });
  } else if (msg.type === 'reveal') {
    revealNode(msg.nodeId);
  }
};

// Mirror canvas selection back out to the web app.
figma.on('selectionchange', function () {
  const sel = figma.currentPage.selection;
  if (sel.length > 0) {
    figma.ui.postMessage({ type: 'selection', nodeId: sel[0].id, name: sel[0].name });
  }
});
