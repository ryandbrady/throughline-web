'use strict';

// Renders a Figma node to a PNG via the Figma REST API, so the web app can
// show the visual design of whatever the user selects in the tree.
// Requires a Figma personal access token in FIGMA_TOKEN (see .env.example).

const cache = new Map(); // nodeId -> { url, at }
const TTL_MS = 4 * 60 * 1000; // Figma's rendered-image URLs are short-lived

async function renderNodeImage(nodeId, fileKey, scale) {
  const token = process.env.FIGMA_TOKEN;
  if (!token) return { ok: false, reason: 'no-token' };
  if (!fileKey) return { ok: false, reason: 'no-file-key' };

  const cached = cache.get(nodeId);
  if (cached && Date.now() - cached.at < TTL_MS) {
    return { ok: true, nodeId, url: cached.url, cached: true };
  }

  const endpoint =
    'https://api.figma.com/v1/images/' +
    encodeURIComponent(fileKey) +
    '?ids=' +
    encodeURIComponent(nodeId) +
    '&format=png&scale=' +
    (Number(scale) || 2);

  let res;
  try {
    res = await fetch(endpoint, { headers: { 'X-Figma-Token': token } });
  } catch {
    return { ok: false, reason: 'network-error' };
  }
  if (res.status === 403) return { ok: false, reason: 'forbidden' };
  if (!res.ok) return { ok: false, reason: 'http-' + res.status };

  const data = await res.json();
  if (data.err) return { ok: false, reason: String(data.err) };

  const url = data.images && data.images[nodeId];
  if (!url) return { ok: false, reason: 'not-rendered' };

  cache.set(nodeId, { url, at: Date.now() });
  return { ok: true, nodeId, url };
}

module.exports = { renderNodeImage };
