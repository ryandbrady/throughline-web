'use strict';

// Throughline Web — turns a raw Figma node tree into an *accessibility tree*:
// a structure a screen reader user can navigate page-by-page, layer-by-layer.
//
// Input nodes use a deliberately small shape so the two data sources — the
// bundled mock design and the live Figma Bridge plugin — share one builder:
//
//   { id, name, type, visible, characters?, fontSize?, hasImageFill?, children? }

const GENERIC_NAME =
  /^(frame|group|rectangle|ellipse|vector|line|component|instance|slice|star|polygon|union|subtract|section)\b[\s\d]*$/i;
const BUTTON_NAME = /\b(button|btn|cta)\b/i;
const HEADING_NAME = /\b(heading|title|headline|h[1-6])\b/i;
const DECORATIVE_NAME = /\b(decoration|decorative|divider|background|blur|shadow|gradient)\b/i;

function isGenericName(name) {
  return !name || GENERIC_NAME.test(name.trim());
}

function isHeadingText(node) {
  if (typeof node.fontSize === 'number' && node.fontSize >= 20) return true;
  return HEADING_NAME.test(node.name || '');
}

// Map a raw Figma node type onto a screen-reader-friendly role.
function roleFor(node) {
  switch (node.type) {
    case 'CANVAS':
      return 'page';
    case 'TEXT':
      return isHeadingText(node) ? 'heading' : 'text';
    case 'FRAME':
    case 'SECTION':
    case 'GROUP':
    case 'COMPONENT':
    case 'COMPONENT_SET':
    case 'INSTANCE':
      if (BUTTON_NAME.test(node.name || '')) return 'button';
      if (node.hasImageFill && !(node.children && node.children.length)) return 'image';
      return 'group';
    case 'RECTANGLE':
    case 'ELLIPSE':
    case 'POLYGON':
    case 'STAR':
    case 'VECTOR':
    case 'LINE':
    case 'BOOLEAN_OPERATION':
      return node.hasImageFill ? 'image' : 'graphic';
    default:
      return 'group';
  }
}

function collapseWhitespace(text) {
  const cleaned = String(text).replace(/\s+/g, ' ').trim();
  return cleaned.length > 120 ? cleaned.slice(0, 117) + '…' : cleaned;
}

// When a layer has only a generic name ("Frame 12"), synthesize something a
// screen reader user can actually act on — this is the heuristic stand-in for
// the Claude-powered naming pass noted in the README.
function synthesizeName(role, children) {
  if (role === 'group') {
    const heading = children.find((c) => c.role === 'heading');
    if (heading) return heading.name;
  }
  const label = role.charAt(0).toUpperCase() + role.slice(1);
  if (children.length) {
    return `${label} (${children.length} item${children.length === 1 ? '' : 's'})`;
  }
  return `Unnamed ${role}`;
}

function hintFor(role, children, decorative) {
  if (decorative) return 'decorative — likely safe to ignore';
  if (role === 'button') return 'interactive control';
  if (role === 'image') return 'image — needs alt text';
  if (role === 'heading') return 'section heading';
  if (children.length) return `contains ${children.length} item${children.length === 1 ? '' : 's'}`;
  return '';
}

function buildNode(raw) {
  if (raw.visible === false) return null;

  const role = roleFor(raw);
  const children = [];
  for (const child of raw.children || []) {
    const built = buildNode(child);
    if (built) children.push(built);
  }

  const rawName = (raw.name || '').trim();
  let name;
  let generated = false;

  if (raw.type === 'TEXT' && raw.characters) {
    name = collapseWhitespace(raw.characters);
  } else if (isGenericName(rawName)) {
    generated = true;
    name = synthesizeName(role, children);
  } else {
    name = rawName;
  }

  const decorative =
    (role === 'graphic' || role === 'image') &&
    (DECORATIVE_NAME.test(rawName) || (generated && children.length === 0));

  return {
    id: raw.id,
    role,
    name,
    generated,
    decorative,
    hint: hintFor(role, children, decorative),
    childCount: children.length,
    children,
  };
}

function countNodes(nodes) {
  return nodes.reduce((sum, n) => sum + 1 + countNodes(n.children), 0);
}

// Build the full accessibility tree from a raw DOCUMENT node.
function buildA11yTree(document, meta = {}) {
  const pages = [];
  for (const page of (document && document.children) || []) {
    const built = buildNode(page);
    if (built) pages.push(built);
  }
  return {
    title: meta.title || (document && document.name) || 'Untitled design',
    source: meta.source || 'mock',
    // File key for REST image rendering — may be absent (e.g. the mock design).
    fileKey: meta.fileKey || (document && document.fileKey) || null,
    generatedAt: new Date().toISOString(),
    pageCount: pages.length,
    nodeCount: countNodes(pages),
    pages,
  };
}

module.exports = { buildA11yTree };
