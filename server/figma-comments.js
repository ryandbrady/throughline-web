'use strict';

// Writes a comment back to the Figma file via the REST API, pinned to a node.
// This is the write-back path: a screen reader user reviews a node, then leaves
// feedback that lands as a comment on that exact layer in Figma.
//
// Requires a Figma token with the **Comments: write** scope. A read-only token
// (enough for previews and structure) returns 403 here — see the README.

async function postComment(fileKey, nodeId, message) {
  const token = process.env.FIGMA_TOKEN;
  if (!token) return { ok: false, reason: 'no-token' };
  if (!fileKey) return { ok: false, reason: 'no-file-key' };
  if (!nodeId) return { ok: false, reason: 'no-node-id' };
  if (!message || !message.trim()) return { ok: false, reason: 'empty-message' };

  let res;
  try {
    res = await fetch('https://api.figma.com/v1/files/' + encodeURIComponent(fileKey) + '/comments', {
      method: 'POST',
      headers: { 'X-Figma-Token': token, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: message.trim(),
        // Pin the comment to the node so it appears on that layer in Figma.
        client_meta: { node_id: nodeId, node_offset: { x: 0, y: 0 } },
      }),
    });
  } catch {
    return { ok: false, reason: 'network-error' };
  }

  // 403 here almost always means the token lacks the Comments: write scope.
  if (res.status === 403) return { ok: false, reason: 'forbidden-scope' };
  if (!res.ok) return { ok: false, reason: 'http-' + res.status };

  const data = await res.json();
  return { ok: true, commentId: data.id };
}

module.exports = { postComment };
