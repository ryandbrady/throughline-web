'use strict';

// AI descriptions for Throughline Web — calls Claude with a node screenshot
// (when one can be rendered) plus the design's structure, and returns a
// description pitched at a screen reader user who cannot see the design.

const Anthropic = require('@anthropic-ai/sdk');

const MODEL = process.env.DESCRIBE_MODEL || 'claude-opus-4-7';

// The API key is supplied per request (the web app prompts the user for it and
// stores it in their browser). An ANTHROPIC_API_KEY env var, if set, is a
// fallback so an operator can pre-provide one. Clients are cached per key.
const clients = new Map();
function getClient(apiKey) {
  const key = apiKey || process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  if (!clients.has(key)) clients.set(key, new Anthropic({ apiKey: key }));
  return clients.get(key);
}

// Descriptions are stable per node — cache them so repeat selections are free.
const cache = new Map(); // `${nodeId}|${mode}|${topic}` -> description

// Stable system prompt — kept byte-identical across calls so it can cache.
const SYSTEM_PROMPT = [
  'You are the description engine for Throughline Web, a tool that lets a person',
  'who uses a screen reader explore a visual Figma design they cannot see.',
  '',
  'You are given the name and structure of one node from the design, and usually',
  'a screenshot of it. Describe it for someone navigating the design as an',
  'accessibility tree with no visual reference.',
  '',
  'Write in plain, direct prose. No markdown, no headings, no bullet lists, no',
  'emoji. Complete sentences. Be concrete — name what is actually there, and do',
  'not invent content you cannot see. Never mention pixels, hex codes, or Figma',
  'layer mechanics; describe things the way a person naturally would.',
  '',
  'You will be told which kind of description to write:',
  '',
  'OVERVIEW — the request is a whole page. In 3 to 5 sentences, explain what the',
  'page contains: how many screens or sections, what each is for, and how they',
  'are arranged. Give the reader a mental map.',
  '',
  'SCREEN — the request is one full screen or frame. In 3 to 5 sentences, give',
  'its purpose and its layout from top to bottom: what is at the top, the main',
  'content, and the bottom. Convey the design intent — what the screen wants the',
  'user to do.',
  '',
  'ELEMENT — the request is a smaller element inside a screen. In 1 to 3',
  'sentences, say what it is, what it contains, and the role it plays.',
  '',
  'COLOR — focus only on color: the palette and mood, where color draws',
  'attention, and most importantly whether any meaning is carried by color alone',
  '(a red label, a green status dot) in a way a screen reader user would miss.',
  '',
  'LAYOUT — focus only on spatial layout and visual hierarchy: what sits where,',
  'what is emphasized or largest, and the order the eye is led through, which may',
  'differ from the reading order.',
  '',
  'IMAGERY — focus only on images, icons, and illustrations: what each depicts',
  'and whether it carries information not also written in text.',
  '',
  'Keep every response tight. The reader is navigating many nodes; respect their',
  'time.',
].join('\n');

const TOPIC_KINDS = { color: 'COLOR', layout: 'LAYOUT', imagery: 'IMAGERY' };

// A shallow text outline of a node and its first couple of levels of children.
function outline(node, depth) {
  let lines = ['  '.repeat(depth) + '- ' + node.name + ' [' + node.role + ']'];
  if (depth < 2) {
    for (const child of node.children || []) {
      lines = lines.concat(outline(child, depth + 1));
    }
  }
  return lines;
}

function buildRequestText(node, mode, topic, hasImage) {
  const kind =
    mode === 'topic'
      ? 'Kind of description: ' + TOPIC_KINDS[topic]
      : 'Kind of description: ' + mode.toUpperCase();
  return [
    kind,
    '',
    'Node name: "' + node.name + '"',
    'Node role: ' + node.role,
    '',
    'Structure:',
    outline(node, 0).join('\n'),
    '',
    hasImage
      ? 'A screenshot of this node is attached above.'
      : 'No screenshot is available for this node; describe it from the structure and names only.',
  ].join('\n');
}

// node: an accessibility-tree node ({ id, name, role, children }).
// mode: 'overview' | 'screen' | 'element' | 'topic'. topic: color|layout|imagery.
// apiKey: the user's Anthropic key. imageBase64: a PNG screenshot or null —
// the caller resolves it (via the Bridge plugin, else the Figma REST API).
async function describeNode({ node, mode, topic, apiKey, imageBase64 }) {
  const anthropic = getClient(apiKey);
  if (!anthropic) return { ok: false, reason: 'no-api-key' };

  // Cache by image-presence too, so a structure-only result isn't reused once
  // a screenshot becomes available (e.g. after the plugin connects).
  const cacheKey =
    node.id + '|' + mode + '|' + (topic || '') + '|' + (imageBase64 ? 'img' : 'noimg');
  if (cache.has(cacheKey)) {
    return { ok: true, mode, topic, description: cache.get(cacheKey), cached: true };
  }

  const userContent = [];
  if (imageBase64) {
    userContent.push({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: imageBase64 },
    });
  }
  userContent.push({ type: 'text', text: buildRequestText(node, mode, topic, !!imageBase64) });

  try {
    const message = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 1024,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'medium' },
      system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: userContent }],
    });
    const textBlock = message.content.find((b) => b.type === 'text');
    const description = textBlock ? textBlock.text.trim() : '';
    if (!description) return { ok: false, reason: 'empty-response' };
    cache.set(cacheKey, description);
    return { ok: true, mode, topic, description, hadImage: !!imageBase64 };
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) return { ok: false, reason: 'bad-api-key' };
    if (err instanceof Anthropic.RateLimitError) return { ok: false, reason: 'rate-limited' };
    return { ok: false, reason: 'api-error' };
  }
}

module.exports = { describeNode };
