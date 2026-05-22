'use strict';

// AI descriptions for Throughline Web — a short Claude conversation per node.
// The first call sends the node's screenshot + structure; "tell me more"
// follow-ups continue that same conversation, so each builds on the last
// instead of starting over.

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

// One running conversation per node, so "tell me more" follow-ups build on the
// description already given. Bounded so a long session can't grow unbounded.
const conversations = new Map(); // nodeId -> messages[]
const MAX_CONVERSATIONS = 25;

function rememberConversation(nodeId, messages) {
  conversations.delete(nodeId);
  conversations.set(nodeId, messages);
  while (conversations.size > MAX_CONVERSATIONS) {
    conversations.delete(conversations.keys().next().value);
  }
}

function hasConversation(nodeId) {
  return conversations.has(nodeId);
}

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

// The opening message of a node's conversation.
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

// A "tell me more" follow-up turn — continues the same conversation.
function buildTopicFollowup(topic) {
  const kind = TOPIC_KINDS[topic];
  return (
    'Now give the ' +
    kind +
    ' description of this same item, following the ' +
    kind +
    ' instructions above. Build on what you already described — go deeper on ' +
    'this angle, and do not repeat what you have already said.'
  );
}

// node: an accessibility-tree node ({ id, name, role, children }).
// mode: 'overview' | 'screen' | 'element' | 'topic'. topic: color|layout|imagery.
// apiKey: the user's Anthropic key. imageBase64: a PNG screenshot or null —
// only needed when starting a conversation (a follow-up reuses the first turn).
async function describeNode({ node, mode, topic, apiKey, imageBase64 }) {
  const anthropic = getClient(apiKey);
  if (!anthropic) return { ok: false, reason: 'no-api-key' };

  let messages;
  if (mode === 'topic' && conversations.has(node.id)) {
    // Continue this node's existing conversation — the screenshot and the
    // earlier description are already in its history.
    messages = conversations.get(node.id).slice();
    messages.push({ role: 'user', content: buildTopicFollowup(topic) });
  } else {
    // Start a fresh conversation (a primary description, or a topic with no
    // prior conversation — e.g. after a server restart).
    const userContent = [];
    if (imageBase64) {
      userContent.push({
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: imageBase64 },
      });
    }
    userContent.push({ type: 'text', text: buildRequestText(node, mode, topic, !!imageBase64) });
    messages = [{ role: 'user', content: userContent }];
  }

  try {
    const message = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 1024,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'medium' },
      system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      messages: messages,
    });
    const textBlock = message.content.find((b) => b.type === 'text');
    const description = textBlock ? textBlock.text.trim() : '';
    if (!description) return { ok: false, reason: 'empty-response' };
    // Persist the conversation so follow-ups can continue it. The full
    // assistant content (thinking blocks included) must be kept verbatim.
    messages.push({ role: 'assistant', content: message.content });
    rememberConversation(node.id, messages);
    return { ok: true, mode, topic, description };
  } catch (err) {
    console.error(
      '[describe] Claude call failed —',
      'status=' + (err && err.status),
      'name=' + (err && err.name),
      'message=' + (err && err.message)
    );
    if (err instanceof Anthropic.AuthenticationError) return { ok: false, reason: 'bad-api-key' };
    if (err instanceof Anthropic.RateLimitError) return { ok: false, reason: 'rate-limited' };
    return { ok: false, reason: 'api-error' };
  }
}

module.exports = { describeNode, hasConversation };
