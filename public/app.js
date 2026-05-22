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
  let ws = null;

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
    if (hasChildren) li.setAttribute('aria-expanded', 'true');

    const row = document.createElement('span');
    row.className = 'row';
    row.setAttribute('tabindex', '-1');

    const twisty = document.createElement('span');
    twisty.className = 'twisty';
    twisty.setAttribute('aria-hidden', 'true');
    twisty.textContent = hasChildren ? '▾' : '';

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

  // Activate = ask the Figma canvas to reveal this node, and preview it.
  function activate(li) {
    treeEl
      .querySelectorAll('[aria-selected="true"]')
      .forEach((x) => x.setAttribute('aria-selected', 'false'));
    li.setAttribute('aria-selected', 'true');
    const name = li.dataset.name;
    loadPreview(li.dataset.nodeId, name);
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

  fetch('/api/design')
    .then((r) => r.json())
    .then((tree) => renderTree(tree))
    .catch(() => {
      treeEl.innerHTML = '<p class="loading">Could not load the design.</p>';
    });

  connect();
})();
