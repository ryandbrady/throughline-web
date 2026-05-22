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
  let describeToken = 0; // guards against a stale AI response overwriting a newer
  let pendingDescribe = null; // a describe request waiting on an API key
  let ws = null;

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
        if (res.ok) showPreviewImage(res.url, name);
        else setPreviewMessage(previewErrorText(res.reason), true);
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

  function setAiMessage(text, isError) {
    aiDescEl.innerHTML = '';
    const p = document.createElement('p');
    p.className = 'ai-msg' + (isError ? ' error' : '');
    p.textContent = text;
    aiDescEl.append(p);
  }

  // Called on every focus change — show the describe affordance, don't call AI.
  function resetAiPanel(li) {
    describeToken += 1; // cancel any in-flight description
    aiActionsEl.hidden = true;
    aiKeyForm.hidden = true;
    describeBtn.hidden = false;
    describeBtn.textContent = 'Describe “' + li.dataset.name + '” with AI';
    setAiMessage('Press Describe — or Enter on a page or screen — for an AI description.');
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

  function loadDescription(nodeId, name, topic) {
    const key = getStoredKey();
    if (!key) {
      pendingDescribe = { nodeId: nodeId, name: name, topic: topic };
      showKeyForm(false);
      return;
    }
    const token = ++describeToken;
    describeBtn.hidden = true;
    aiKeyForm.hidden = true;
    setAiMessage(topic ? 'Looking at ' + topic + '…' : 'Describing “' + name + '”…');
    const url = '/api/describe?nodeId=' + encodeURIComponent(nodeId) + (topic ? '&topic=' + topic : '');
    fetch(url, { headers: { 'X-Anthropic-Key': key } })
      .then((r) => r.json())
      .then((res) => {
        if (token !== describeToken) return; // a newer selection has taken over
        if (res.ok) {
          aiDescEl.innerHTML = '';
          const p = document.createElement('p');
          p.className = 'ai-text';
          p.textContent = res.description;
          aiDescEl.append(p);
          aiActionsEl.hidden = false;
          announce('AI description of ' + name + '. ' + res.description);
        } else if (res.reason === 'no-api-key' || res.reason === 'bad-api-key') {
          if (res.reason === 'bad-api-key') localStorage.removeItem(KEY_STORAGE);
          pendingDescribe = { nodeId: nodeId, name: name, topic: topic };
          updateKeyEditVisibility();
          showKeyForm(res.reason === 'bad-api-key');
        } else {
          setAiMessage(describeErrorText(res.reason), true);
        }
      })
      .catch(() => {
        if (token === describeToken) setAiMessage('Could not reach the server.', true);
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
    return 'Comment failed (' + reason + ').';
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
          setCommentStatus('Comment posted to Figma.', 'ok');
        } else {
          setCommentStatus(commentStatusText(res.reason), 'error');
        }
      })
      .catch(() => {
        commentBtn.disabled = false;
        setCommentStatus('Could not reach the server.', 'error');
      });
  }

  function setCommentStatus(text, state) {
    commentStatus.textContent = text;
    commentStatus.dataset.state = state;
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
