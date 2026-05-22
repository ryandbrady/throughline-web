'use strict';

// Throughline Web — front-end. Renders the accessibility tree as a WAI-ARIA
// tree widget (full keyboard support) and keeps it in sync with the Figma
// canvas over a WebSocket relay.

(function () {
  const treeEl = document.getElementById('tree');
  const statusEl = document.getElementById('bridge-status');
  const announcer = document.getElementById('announcer');
  const revealBtn = document.getElementById('reveal-btn');
  const previewEl = document.getElementById('preview');
  const aiDescEl = document.getElementById('ai-description');
  const describeBtn = document.getElementById('describe-btn');
  const aiActionsEl = document.getElementById('ai-actions');
  const aiKeyForm = document.getElementById('ai-key-form');
  const aiKeyInput = document.getElementById('ai-key-input');
  const aiKeyCancel = document.getElementById('ai-key-cancel');
  const aiKeyEdit = document.getElementById('ai-key-edit');
  const downloadBtn = document.getElementById('download-btn');
  const commentForm = document.getElementById('comment-form');
  const commentText = document.getElementById('comment-text');
  const commentBtn = document.getElementById('comment-btn');
  const commentStatus = document.getElementById('comment-status');
  const insp = {
    name: document.getElementById('insp-name'),
    role: document.getElementById('insp-role'),
    hint: document.getElementById('insp-hint'),
    id: document.getElementById('insp-id'),
  };

  let currentItem = null; // the treeitem that owns the roving tabindex
  let bridgeConnected = false;
  let currentSource = 'mock'; // 'mock' | 'figma'
  let currentTitle = '';
  let pendingDescribe = null; // a describe request waiting on an API key
  let ws = null;

  // Generated descriptions, cached per node — so they are not re-fetched, and
  // so every "tell me more" result accumulates instead of replacing the last.
  const descriptions = new Map(); // nodeId -> [{ kind, label, text }]
  const describeInFlight = new Set(); // `${nodeId}|${kind}` currently generating
  const imageCache = new Map(); // nodeId -> rendered image URL, for the artifact
  let treeData = null; // the most recent /api/design tree, for the artifact

  const KEY_STORAGE = 'throughline.anthropicKey';
  const getStoredKey = () => localStorage.getItem(KEY_STORAGE) || '';

  // --- Announcements -----------------------------------------------------
  // Clearing first guarantees repeated identical messages are re-announced.
  function announce(message) {
    announcer.textContent = '';
    setTimeout(() => {
      announcer.textContent = message;
    }, 60);
  }

  // --- Rendering ---------------------------------------------------------

  function makeItem(node, level, posInSet, setSize) {
    const li = document.createElement('li');
    li.setAttribute('role', 'treeitem');
    li.setAttribute('aria-level', String(level));
    li.setAttribute('aria-posinset', String(posInSet));
    li.setAttribute('aria-setsize', String(setSize));
    li.setAttribute('aria-selected', 'false');
    li.dataset.nodeId = node.id;
    li.dataset.name = node.name;

    const hasChildren = node.children && node.children.length > 0;
    // Everything starts collapsed — you expand pages, then layers, yourself.
    // A refresh or a new project always begins fully collapsed.
    const expanded = false;
    if (hasChildren) li.setAttribute('aria-expanded', String(expanded));

    const row = document.createElement('span');
    row.className = 'row';
    row.setAttribute('tabindex', '-1');

    const twisty = document.createElement('span');
    twisty.className = 'twisty';
    twisty.setAttribute('aria-hidden', 'true');
    twisty.textContent = hasChildren ? (expanded ? '▾' : '▸') : '';

    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = node.name;

    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = node.role;

    row.append(twisty, label, badge);

    // Surface the heuristic-naming and decorative flags to screen readers as
    // real text, not just colour.
    if (node.generated) {
      const gen = document.createElement('span');
      gen.className = 'badge gen';
      gen.textContent = 'auto-named';
      row.append(gen);
    }
    if (node.decorative) badge.classList.add('decorative');

    li.append(row);

    if (hasChildren) {
      const group = document.createElement('ul');
      group.setAttribute('role', 'group');
      group.hidden = !expanded;
      node.children.forEach((child, i) => {
        group.append(makeItem(child, level + 1, i + 1, node.children.length));
      });
      li.append(group);
    }
    return li;
  }

  function renderTree(tree) {
    currentSource = tree.source;
    currentTitle = tree.title;
    treeData = tree;
    // A new design means new node IDs — cached descriptions no longer apply.
    descriptions.clear();
    describeInFlight.clear();
    imageCache.clear();
    downloadBtn.disabled = false;
    treeEl.innerHTML = '';
    if (!tree.pages.length) {
      treeEl.innerHTML = '<p class="loading">This design has no visible pages.</p>';
      return;
    }
    const root = document.createElement('ul');
    root.setAttribute('role', 'group');
    tree.pages.forEach((page, i) => {
      root.append(makeItem(page, 1, i + 1, tree.pages.length));
    });
    treeEl.append(root);

    currentItem = treeEl.querySelector('li[role="treeitem"]');
    if (currentItem) setTabbable(currentItem);
    refreshStatus();
  }

  // --- Tree navigation helpers ------------------------------------------

  function rowOf(li) {
    return li.firstElementChild; // the .row span
  }

  function setTabbable(li) {
    treeEl.querySelectorAll('.row').forEach((r) => r.setAttribute('tabindex', '-1'));
    rowOf(li).setAttribute('tabindex', '0');
    currentItem = li;
    updateInspector(li);
    resetAiPanel(li);
  }

  function focusItem(li) {
    setTabbable(li);
    rowOf(li).focus();
  }

  function isItemVisible(li) {
    let p = li.parentElement;
    while (p && p !== treeEl) {
      if (p.tagName === 'UL' && p.hidden) return false;
      p = p.parentElement;
    }
    return true;
  }

  function visibleItems() {
    return Array.from(treeEl.querySelectorAll('li[role="treeitem"]')).filter(isItemVisible);
  }

  function childGroup(li) {
    const last = li.lastElementChild;
    return last && last.tagName === 'UL' ? last : null;
  }

  function parentItem(li) {
    const group = li.parentElement;
    if (group && group.tagName === 'UL') {
      const parent = group.parentElement;
      if (parent && parent.getAttribute('role') === 'treeitem') return parent;
    }
    return null;
  }

  function setExpanded(li, expanded) {
    if (!li.hasAttribute('aria-expanded')) return;
    li.setAttribute('aria-expanded', String(expanded));
    const group = childGroup(li);
    if (group) group.hidden = !expanded;
    rowOf(li).querySelector('.twisty').textContent = expanded ? '▾' : '▸';
  }

  function updateInspector(li) {
    insp.name.textContent = li.dataset.name || '—';
    insp.role.textContent = rowOf(li).querySelector('.badge').textContent || '—';
    insp.id.textContent = li.dataset.nodeId || '—';
    const badges = Array.from(rowOf(li).querySelectorAll('.badge'))
      .slice(1)
      .map((b) => b.textContent);
    insp.hint.textContent = badges.length ? badges.join(', ') : 'no notes';
    revealBtn.disabled = false;
    commentBtn.disabled = false;
  }

  // --- Visual preview ----------------------------------------------------
  // Renders the selected node via the server's /api/image route (Figma REST).

  let previewToken = 0; // guards against an older request overwriting a newer

  function setPreviewMessage(text, isError) {
    previewEl.innerHTML = '';
    const p = document.createElement('p');
    p.className = 'preview-msg' + (isError ? ' error' : '');
    p.textContent = text;
    previewEl.append(p);
  }

  function showPreviewImage(url, name) {
    previewEl.innerHTML = '';
    const img = document.createElement('img');
    img.alt = 'Rendered design of ' + name;
    img.addEventListener('error', () =>
      setPreviewMessage('The preview image could not be loaded — reselect to retry.', true)
    );
    img.src = url;
    previewEl.append(img);
  }

  function previewErrorText(reason) {
    if (reason === 'no-token') {
      return 'Live preview needs a Figma token — set FIGMA_TOKEN in a .env file (see the README).';
    }
    if (reason === 'no-file-key') {
      return 'No Figma file key for previews — set FIGMA_FILE_KEY in .env.';
    }
    if (reason === 'forbidden') {
      return 'Figma rejected the token. Check it has file read access.';
    }
    if (reason === 'not-rendered') {
      return 'Figma did not return an image for this layer.';
    }
    return 'Preview unavailable (' + reason + ').';
  }

  function loadPreview(nodeId, name) {
    if (currentSource === 'mock') {
      setPreviewMessage('Visual preview is available once a real Figma file is loaded.');
      return;
    }
    const token = ++previewToken;
    setPreviewMessage('Rendering “' + name + '”…');
    fetch('/api/image?nodeId=' + encodeURIComponent(nodeId))
      .then((r) => r.json())
      .then((res) => {
        if (token !== previewToken) return; // a newer selection has taken over
        if (res.ok) {
          imageCache.set(nodeId, res.url); // keep it for the session artifact
          showPreviewImage(res.url, name);
        } else setPreviewMessage(previewErrorText(res.reason), true);
      })
      .catch(() => {
        if (token === previewToken) {
          setPreviewMessage('Could not reach the server for a preview.', true);
        }
      });
  }

  // --- AI description ----------------------------------------------------
  // Pages and top-level screens describe themselves on activation (a screen
  // reader user has no visual reference for layout). Deeper nodes wait for an
  // explicit "Describe with AI" press.

  const SECTION_LABELS = {
    overview: 'Page overview',
    screen: 'Screen',
    element: 'Element',
    color: 'Color & contrast',
    layout: 'Layout & hierarchy',
    imagery: 'Imagery & icons',
  };

  function setAiMessage(text, isError) {
    aiDescEl.innerHTML = '';
    const p = document.createElement('p');
    p.className = 'ai-msg' + (isError ? ' error' : '');
    p.textContent = text;
    aiDescEl.append(p);
  }

  // Render every cached description for a node, stacked in generation order.
  function renderDescriptions(nodeId) {
    aiDescEl.innerHTML = '';
    const list = descriptions.get(nodeId) || [];
    list.forEach((entry) => {
      const section = document.createElement('div');
      section.className = 'ai-section';
      const label = document.createElement('p');
      label.className = 'ai-section-label';
      label.textContent = entry.label;
      const text = document.createElement('p');
      text.className = 'ai-text';
      text.textContent = entry.text;
      section.append(label, text);
      aiDescEl.append(section);
    });
  }

  // Called on every focus change — show this node's cached descriptions if it
  // has any, otherwise the describe affordance. Never calls the AI.
  function resetAiPanel(li) {
    aiKeyForm.hidden = true;
    const list = descriptions.get(li.dataset.nodeId);
    if (list && list.length) {
      renderDescriptions(li.dataset.nodeId);
      describeBtn.hidden = true;
      aiActionsEl.hidden = false;
    } else {
      describeBtn.hidden = false;
      describeBtn.textContent = 'Describe “' + li.dataset.name + '” with AI';
      aiActionsEl.hidden = true;
      setAiMessage('Press Describe — or Enter on a page or screen — for an AI description.');
    }
  }

  function describeErrorText(reason) {
    if (reason === 'rate-limited') return 'Rate limited — try again in a moment.';
    return 'Description unavailable (' + reason + ').';
  }

  // --- Anthropic API key — prompted on first use, kept in this browser ----

  function showKeyForm(wasRejected) {
    aiKeyForm.hidden = false;
    describeBtn.hidden = true;
    aiActionsEl.hidden = true;
    aiKeyInput.value = '';
    setAiMessage(
      wasRejected
        ? 'That API key was rejected. Enter a valid Anthropic API key.'
        : 'AI descriptions need your Anthropic API key — it stays in this browser.',
      wasRejected
    );
    aiKeyInput.focus();
  }

  function updateKeyEditVisibility() {
    aiKeyEdit.hidden = !getStoredKey();
  }

  aiKeyForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const key = aiKeyInput.value.trim();
    if (!key) return;
    localStorage.setItem(KEY_STORAGE, key);
    aiKeyForm.hidden = true;
    updateKeyEditVisibility();
    const next = pendingDescribe;
    pendingDescribe = null;
    if (next) loadDescription(next.nodeId, next.name, next.topic);
  });

  aiKeyCancel.addEventListener('click', () => {
    aiKeyForm.hidden = true;
    pendingDescribe = null;
    if (currentItem) resetAiPanel(currentItem);
  });

  aiKeyEdit.addEventListener('click', () => showKeyForm(false));

  // Append an error line below whatever is already shown for the node.
  function appendAiError(nodeId, text) {
    renderDescriptions(nodeId);
    const err = document.createElement('p');
    err.className = 'ai-msg error';
    err.textContent = text;
    aiDescEl.append(err);
  }

  function loadDescription(nodeId, name, topic) {
    const kind = topic || 'primary';
    const list = descriptions.get(nodeId) || [];
    const cached = list.find((e) => e.kind === kind);
    if (cached) {
      // Already generated — show it from the cache, no Claude call.
      renderDescriptions(nodeId);
      aiActionsEl.hidden = false;
      announce(cached.label + ' for ' + name + '. ' + cached.text);
      return;
    }

    const key = getStoredKey();
    if (!key) {
      pendingDescribe = { nodeId: nodeId, name: name, topic: topic };
      showKeyForm(false);
      return;
    }

    const flightKey = nodeId + '|' + kind;
    if (describeInFlight.has(flightKey)) return; // already generating this one
    describeInFlight.add(flightKey);

    describeBtn.hidden = true;
    aiKeyForm.hidden = true;
    // Keep any existing descriptions on screen; add a pending line below them.
    renderDescriptions(nodeId);
    const pending = document.createElement('p');
    pending.className = 'ai-msg';
    pending.textContent = topic
      ? 'Generating ' + (SECTION_LABELS[topic] || topic) + '…'
      : 'Describing “' + name + '”…';
    aiDescEl.append(pending);

    const url = '/api/describe?nodeId=' + encodeURIComponent(nodeId) + (topic ? '&topic=' + topic : '');
    fetch(url, { headers: { 'X-Anthropic-Key': key } })
      .then((r) => r.json())
      .then((res) => {
        describeInFlight.delete(flightKey);
        const onNode = currentItem && currentItem.dataset.nodeId === nodeId;
        if (res.ok) {
          // Cache the result (accumulating), then re-render if still on the node.
          const target = descriptions.get(nodeId) || [];
          if (!descriptions.has(nodeId)) descriptions.set(nodeId, target);
          const entry = {
            kind: kind,
            label: SECTION_LABELS[topic || res.mode] || 'Description',
            text: res.description,
          };
          const idx = target.findIndex((e) => e.kind === kind);
          if (idx >= 0) target[idx] = entry;
          else target.push(entry);
          if (onNode) {
            renderDescriptions(nodeId);
            aiActionsEl.hidden = false;
          }
          announce(entry.label + ' for ' + name + '. ' + res.description);
        } else if (res.reason === 'no-api-key' || res.reason === 'bad-api-key') {
          if (res.reason === 'bad-api-key') localStorage.removeItem(KEY_STORAGE);
          pendingDescribe = { nodeId: nodeId, name: name, topic: topic };
          updateKeyEditVisibility();
          if (onNode) showKeyForm(res.reason === 'bad-api-key');
        } else if (onNode) {
          appendAiError(nodeId, describeErrorText(res.reason));
        }
      })
      .catch(() => {
        describeInFlight.delete(flightKey);
        if (currentItem && currentItem.dataset.nodeId === nodeId) {
          appendAiError(nodeId, 'Could not reach the server.');
        }
      });
  }

  // --- Comment write-back ------------------------------------------------

  function commentStatusText(reason) {
    if (reason === 'forbidden-scope') {
      return 'Your Figma token needs the Comments: write scope.';
    }
    if (reason === 'no-token') return 'No Figma token configured.';
    if (reason === 'no-file-key') return 'No Figma file key configured.';
    if (reason === 'empty-message') return 'Write a comment first.';
    if (reason === 'cannot-annotate') {
      return 'This item type cannot be annotated — pick a frame or layer.';
    }
    if (reason === 'annotate-failed') return 'Could not write the annotation — try again.';
    return 'Feedback failed (' + reason + ').';
  }

  function submitComment(event) {
    event.preventDefault();
    if (!currentItem) return;
    const message = commentText.value.trim();
    if (!message) {
      setCommentStatus('Write a comment first.', 'error');
      return;
    }
    commentBtn.disabled = true;
    setCommentStatus('Posting…', '');
    fetch('/api/comment', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nodeId: currentItem.dataset.nodeId, message }),
    })
      .then((r) => r.json())
      .then((res) => {
        commentBtn.disabled = false;
        if (res.ok) {
          commentText.value = '';
          setCommentStatus(
            res.via === 'annotation'
              ? 'Annotation added to the node — visible in Figma Dev Mode.'
              : 'Comment posted to Figma.',
            'ok'
          );
        } else {
          setCommentStatus(commentStatusText(res.reason), 'error');
        }
      })
      .catch(() => {
        commentBtn.disabled = false;
        setCommentStatus('Could not reach the server.', 'error');
      });
  }

  // #comment-status has role="status" — a polite live region — so updating it
  // announces to a screen reader. Clearing first guarantees a repeated message
  // still re-announces; the timer dismisses the confirmation after a few seconds
  // so it never lingers from an earlier action.
  let commentStatusSetTimer = null;
  let commentStatusClearTimer = null;
  function setCommentStatus(text, state) {
    clearTimeout(commentStatusSetTimer);
    clearTimeout(commentStatusClearTimer);
    commentStatus.textContent = '';
    commentStatus.dataset.state = '';
    if (!text) return;
    commentStatusSetTimer = setTimeout(function () {
      commentStatus.textContent = text;
      commentStatus.dataset.state = state || '';
      if (state === 'ok' || state === 'error') {
        commentStatusClearTimer = setTimeout(function () {
          commentStatus.textContent = '';
          commentStatus.dataset.state = '';
        }, 6000);
      }
    }, 80);
  }

  // Activate = reveal on the Figma canvas, preview it, and (for pages and
  // top-level screens) describe it.
  function activate(li) {
    treeEl
      .querySelectorAll('[aria-selected="true"]')
      .forEach((x) => x.setAttribute('aria-selected', 'false'));
    li.setAttribute('aria-selected', 'true');
    const name = li.dataset.name;
    loadPreview(li.dataset.nodeId, name);
    if (Number(li.getAttribute('aria-level') || 99) <= 2) {
      loadDescription(li.dataset.nodeId, name, null);
    }
    if (sendMessage({ type: 'focus', nodeId: li.dataset.nodeId })) {
      announce('Revealing ' + name + ' on the Figma canvas.');
    } else {
      announce(name + ' selected. Open the Figma Bridge plugin to reveal it on the canvas.');
    }
  }

  // --- Keyboard handling -------------------------------------------------

  treeEl.addEventListener('keydown', (event) => {
    const li = event.target.closest('li[role="treeitem"]');
    if (!li) return;
    const items = visibleItems();
    const index = items.indexOf(li);
    let handled = true;

    switch (event.key) {
      case 'ArrowDown':
        if (index < items.length - 1) focusItem(items[index + 1]);
        break;
      case 'ArrowUp':
        if (index > 0) focusItem(items[index - 1]);
        break;
      case 'ArrowRight':
        if (li.getAttribute('aria-expanded') === 'false') {
          setExpanded(li, true);
        } else if (childGroup(li)) {
          focusItem(childGroup(li).querySelector('li[role="treeitem"]'));
        }
        break;
      case 'ArrowLeft':
        if (li.getAttribute('aria-expanded') === 'true') {
          setExpanded(li, false);
        } else {
          const parent = parentItem(li);
          if (parent) focusItem(parent);
        }
        break;
      case 'Home':
        if (items.length) focusItem(items[0]);
        break;
      case 'End':
        if (items.length) focusItem(items[items.length - 1]);
        break;
      case 'Enter':
      case ' ':
        activate(li);
        break;
      default:
        handled = false;
    }
    if (handled) event.preventDefault();
  });

  // Clicking a row selects it; clicking the twisty toggles expansion.
  treeEl.addEventListener('click', (event) => {
    const li = event.target.closest('li[role="treeitem"]');
    if (!li) return;
    if (event.target.classList.contains('twisty')) {
      setExpanded(li, li.getAttribute('aria-expanded') !== 'true');
      return;
    }
    focusItem(li);
  });

  // Skip-link / programmatic focus on the container redirects to an item.
  treeEl.addEventListener('focus', () => {
    if (currentItem) rowOf(currentItem).focus();
  });

  revealBtn.addEventListener('click', () => {
    if (currentItem) activate(currentItem);
  });

  describeBtn.addEventListener('click', () => {
    if (currentItem) loadDescription(currentItem.dataset.nodeId, currentItem.dataset.name, null);
  });

  // "Tell me more" deep-dive buttons.
  aiActionsEl.addEventListener('click', (event) => {
    const topic = event.target.dataset && event.target.dataset.topic;
    if (topic && currentItem) {
      loadDescription(currentItem.dataset.nodeId, currentItem.dataset.name, topic);
    }
  });

  commentForm.addEventListener('submit', submitComment);

  // --- WebSocket sync ----------------------------------------------------

  function sendMessage(payload) {
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify(payload));
      return bridgeConnected;
    }
    return false;
  }

  function setStatus(text, state) {
    statusEl.textContent = text;
    statusEl.dataset.state = state;
  }

  function refreshStatus() {
    if (!ws || ws.readyState !== 1) {
      setStatus('Offline — reconnecting to the server…', 'offline');
    } else if (bridgeConnected) {
      setStatus('Live — connected to Figma. Press Enter to drive the canvas.', 'live');
    } else if (currentSource === 'mock') {
      setStatus('Demo design — open the Figma Bridge plugin to go live.', 'demo');
    } else {
      setStatus(
        'Snapshot of “' + currentTitle + '”. Open the Figma Bridge plugin for live canvas sync.',
        'demo'
      );
    }
  }

  // Reveal a node that the canvas selected: expand its ancestors and focus it.
  function followSelection(nodeId) {
    const li = treeEl.querySelector('li[role="treeitem"][data-node-id="' + cssEscape(nodeId) + '"]');
    if (!li) return;
    let parent = parentItem(li);
    while (parent) {
      setExpanded(parent, true);
      parent = parentItem(parent);
    }
    treeEl
      .querySelectorAll('[aria-selected="true"]')
      .forEach((x) => x.setAttribute('aria-selected', 'false'));
    li.setAttribute('aria-selected', 'true');
    focusItem(li);
    loadPreview(li.dataset.nodeId, li.dataset.name);
    announce('Canvas selected ' + li.dataset.name + '.');
  }

  function cssEscape(value) {
    return window.CSS && CSS.escape ? CSS.escape(value) : value.replace(/"/g, '\\"');
  }

  function connect() {
    ws = new WebSocket('ws://' + location.host);

    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ type: 'hello', role: 'web' }));
      refreshStatus();
    });

    ws.addEventListener('message', (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (msg.type === 'bridge') {
        bridgeConnected = msg.connected;
        refreshStatus();
      } else if (msg.type === 'design') {
        renderTree(msg.tree);
        announce(
          'Live design loaded from Figma: ' +
            msg.tree.pageCount +
            ' page' +
            (msg.tree.pageCount === 1 ? '' : 's') +
            ', ' +
            msg.tree.nodeCount +
            ' items.'
        );
      } else if (msg.type === 'selection') {
        followSelection(msg.nodeId);
      }
    });

    ws.addEventListener('close', () => {
      bridgeConnected = false;
      refreshStatus();
      setTimeout(connect, 2000); // keep trying so a server restart recovers
    });

    ws.addEventListener('error', () => ws.close());
  }

  // --- Session artifact --------------------------------------------------
  // Export the session as ONE self-contained, interactive HTML file: the
  // navigable tree, the screenshots, and the AI descriptions, all embedded.

  function slug(text) {
    return (
      String(text || 'session')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'session'
    );
  }

  function fetchImageUrl(nodeId) {
    return fetch('/api/image?nodeId=' + encodeURIComponent(nodeId))
      .then((r) => r.json())
      .then((res) => (res.ok ? res.url : null))
      .catch(() => null);
  }

  // Normalise an image URL to an embeddable data URL (data URLs pass through;
  // http URLs are fetched and read as a data URL).
  function toDataUrl(url) {
    if (!url) return Promise.resolve(null);
    if (url.indexOf('data:') === 0) return Promise.resolve(url);
    return fetch(url)
      .then((r) => (r.ok ? r.blob() : null))
      .then((blob) => {
        if (!blob) return null;
        return new Promise((resolve) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.onerror = () => resolve(null);
          reader.readAsDataURL(blob);
        });
      })
      .catch(() => null);
  }

  // The AI descriptions as a readable Markdown document, in tree order.
  function buildMarkdown(reviewedNodes) {
    const lines = [
      '# Throughline Web — accessibility review',
      '',
      '**Design:** ' + treeData.title,
      '**Generated:** ' + new Date().toLocaleString(),
      '**Reviewed:** ' + reviewedNodes.length + ' of ' + treeData.nodeCount + ' nodes',
      '',
    ];
    if (!reviewedNodes.length) {
      lines.push('_No nodes were described in this session._');
    }
    reviewedNodes.forEach((node) => {
      lines.push('', '---', '', '## ' + node.name + ' (' + node.role + ')', '');
      (descriptions.get(node.id) || []).forEach((e) => {
        lines.push('### ' + e.label, '', e.text, '');
      });
    });
    return lines.join('\n');
  }

  async function buildArtifact() {
    if (!treeData) {
      announce('Nothing to download yet.');
      return;
    }
    if (typeof JSZip === 'undefined') {
      announce('Zip library failed to load.');
      return;
    }
    downloadBtn.disabled = true;
    downloadBtn.textContent = 'Building…';
    try {
      // Reviewed nodes — those with descriptions — in tree order.
      const reviewedNodes = [];
      (function walk(nodes) {
        nodes.forEach((n) => {
          const list = descriptions.get(n.id);
          if (list && list.length) reviewedNodes.push(n);
          if (n.children) walk(n.children);
        });
      })(treeData.pages || []);

      // For every reviewed node, resolve its screenshot for the HTML viewer.
      const reviewed = {};
      for (const node of reviewedNodes) {
        const list = descriptions.get(node.id) || [];
        const shot = await toDataUrl(imageCache.get(node.id) || (await fetchImageUrl(node.id)));
        reviewed[node.id] = {
          screenshot: shot,
          descriptions: list.map((e) => ({ label: e.label, text: e.text })),
        };
      }

      // The interactive HTML viewer.
      const data = { generatedAt: new Date().toLocaleString(), tree: treeData, reviewed: reviewed };
      const template = await fetch('session-template.html').then((r) => r.text());
      // Escape `<` so the embedded JSON cannot break out of the <script> tag.
      const json = JSON.stringify(data).replace(/</g, '\\u003c');
      const html = template.replace('{{DATA}}', () => json);

      // Zip the interactive viewer together with the Markdown descriptions.
      const zip = new JSZip();
      zip.file('review.html', html);
      zip.file('descriptions.md', buildMarkdown(reviewedNodes));
      const blob = await zip.generateAsync({ type: 'blob' });

      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'throughline-' + slug(treeData.title) + '-review.zip';
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
      announce(
        'Session review downloaded — ' +
          reviewedNodes.length +
          ' reviewed node' +
          (reviewedNodes.length === 1 ? '' : 's') +
          '.'
      );
    } catch (e) {
      announce('Could not build the session review.');
    } finally {
      downloadBtn.disabled = false;
      downloadBtn.textContent = 'Download session';
    }
  }

  downloadBtn.addEventListener('click', buildArtifact);

  // --- Boot --------------------------------------------------------------

  updateKeyEditVisibility();

  fetch('/api/design')
    .then((r) => r.json())
    .then((tree) => renderTree(tree))
    .catch(() => {
      treeEl.innerHTML = '<p class="loading">Could not load the design.</p>';
    });

  connect();
})();
