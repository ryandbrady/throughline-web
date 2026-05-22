# Throughline Web

Navigate a Figma design as an **accessible structure** from a web page — and
drive the Figma canvas from there.

This is a **separate product** from the Throughline Figma plugin in
`../throughline/`. The plugin helps *designers* audit accessibility inside
Figma. Throughline Web makes *the design itself* navigable by a screen reader
user, from an accessible space outside Figma's canvas UI.

## What this first pass does

- **Reads a design** into a page → layer accessibility tree, assigning each
  layer a screen-reader role (`heading`, `button`, `image`, `group`, …) and a
  usable name. Generically-named layers ("Frame 12") get a heuristic name and
  are flagged `auto-named`.
- **Presents it as a real ARIA tree** — full keyboard navigation (arrow keys,
  Home/End, expand/collapse), roving tabindex, live-region announcements,
  visible focus, dark-mode and reduced-motion support.
- **Live two-way canvas sync** — activating an item in the web tree selects and
  zooms to it on the Figma canvas; selecting something on the canvas moves the
  web tree's focus to match.
- **Live visual preview** — selecting an item renders that node as an image (via
  the Figma REST API) in a side panel, so the design sits next to its accessible
  structure.

## Architecture

```
  Web app  ⇄  WebSocket relay (server/)  ⇄  Figma Bridge plugin  ⇄  Figma canvas
 (public/)                                    (figma-bridge/)
```

- `server/` — Express static host + WebSocket relay. `build-a11y-tree.js` turns
  raw Figma nodes into the accessibility tree; `figma-images.js` renders nodes
  via the Figma REST API; `mock-design.js` lets the app run with zero setup.
- `public/` — the accessible web app (plain HTML/CSS/JS, no build step).
- `figma-bridge/` — a companion Figma plugin. Its sandbox walks the document and
  drives canvas selection; its UI iframe owns the WebSocket.

## Prerequisites

- **Node.js 18 or newer** — check with `node --version`. (The server relies on
  built-in `fetch`, `node --watch`, and `WebSocketServer`.)
- **Git** — to clone the repo.
- **Figma desktop app** — only needed for the optional live canvas sync (step 6).

No API keys are needed to run the app. The optional **visual preview** feature
needs a free Figma token — see *Visual previews* below.

## Run it — step by step

Each teammate runs their own copy locally; the server is localhost-only.

1. **Clone the repo**

   ```bash
   git clone https://github.com/ryandbrady/throughline-web.git
   cd throughline-web
   ```

2. **Install dependencies**

   ```bash
   npm install
   ```

3. **Start the server**

   ```bash
   npm start
   ```

   You should see `Throughline Web running at http://localhost:4400`.
   If port 4400 is taken, run `PORT=5000 npm start` and use that port below.

4. **Open the app** — visit **http://localhost:4400** in a browser.

   It loads the bundled **mock design** immediately, so keyboard navigation
   works with no Figma running. (If you have generated `server/real-design.js`
   locally, it loads that real file instead.)

5. **Stop the server** when finished — press `Ctrl+C` in the terminal.

### Keyboard controls

| Key | Action |
| --- | --- |
| ↑ / ↓ | Move between items |
| → | Expand a group, or step into it |
| ← | Collapse a group, or jump to its parent |
| Home / End | First / last item |
| Enter or Space | Reveal the selected item on the Figma canvas |
| Tab | Move between the tree, the inspector, and the Reveal button |

The tree is a WAI-ARIA `tree` widget with live-region announcements — test it
with a screen reader (VoiceOver: `Cmd+F5`).

## Optional: live canvas sync with Figma — step by step

This makes the web app and the Figma canvas drive each other.

6. Keep the server running (`npm start` from step 3).
7. Open the **Figma desktop app**, then open any design file.
8. **Import the Bridge plugin** — *Plugins → Development → Import plugin from
   manifest…* and choose `figma-bridge/manifest.json` from your clone.
9. **Run it** — *Plugins → Development → Throughline Web Bridge*.
10. The plugin connects to `ws://localhost:4400` and pushes that file's
    structure. The web app's status flips to **Live** and shows the real file.
11. Try it: arrow-key to an item in the web app and press **Enter** — Figma
    selects and zooms to it. Select a layer **on the canvas** — the web tree
    moves to match.

If the plugin cannot connect, confirm `npm start` is running and that the
server address in the plugin's UI field matches your port.

## Optional: visual previews

With a Figma token, selecting a node renders it as an image beside the tree
(via the Figma REST API). Without a token the app still navigates fine — the
preview panel just shows how to switch it on.

**Setup**

1. Create a Figma personal access token at
   <https://www.figma.com/developers/api#access-tokens>. It needs only
   **File content → Read-only** — no write scopes.
2. Create your env file from the template:

   ```bash
   cp .env.example .env
   ```

   Then fill in both values in `.env`:

   ```ini
   FIGMA_TOKEN=figd_your_token_here
   FIGMA_FILE_KEY=your_file_key      # the ABC123 in figma.com/design/ABC123/...
   ```

3. Restart the server (`npm start`) — `.env` is read once at startup.

**About the file key.** Previews resolve it in this order: `FIGMA_FILE_KEY` →
the key embedded in `server/real-design.js` → the key the Bridge plugin reports.
**Set `FIGMA_FILE_KEY` explicitly** — it is the only reliable source: the Bridge
plugin often cannot read `figma.fileKey`, and a fresh clone has no
`real-design.js`. Use the key of whatever file you are reviewing.

`.env` is git-ignored — never commit your token. If a preview reports
"No Figma file key", `FIGMA_FILE_KEY` is unset.

## Where the design data comes from

`build-a11y-tree.js` is the single "parser" — every source feeds the same raw
node shape (`{ id, name, type, visible, characters?, fontSize?, hasImageFill? }`)
through it. There are three sources:

1. **Mock** (`server/mock-design.js`) — bundled sample, zero setup.
2. **MCP import** (`server/real-design.js`) — a snapshot of a real Figma file.
3. **Bridge plugin** — live data pushed over the WebSocket; also drives the
   canvas. The only source that supports two-way sync.

**For teams:** a fresh clone has no `server/real-design.js` (it is git-ignored),
so it runs on the **mock design**. To navigate a *real* file, use the **Bridge
plugin** (steps 6–11 above) — it works for anyone with the Figma desktop app and
needs no MCP access. The MCP importer below is only for whoever has Figma MCP
access set up.

### Import a real file via the Figma MCP

The Figma **MCP** is a local, Claude-side dev tool — a deployed web app can't
call it directly. Instead, Claude calls `get_metadata` for the file, and
`tools/import-figma-metadata.js` reshapes that dump into `server/real-design.js`:

```bash
node tools/import-figma-metadata.js <metadata-dump.txt> "My File Name" <fileKey>
```

The optional `<fileKey>` is embedded in the output so visual previews work
without also setting `FIGMA_FILE_KEY`. `server/real-design.js` is git-ignored —
run the importer to generate your own from any file you have MCP access to.
Without it, the bundled mock design loads.

Caveat: `get_metadata` returns structure only — node IDs, names, types,
visibility — **not text content or fills**. So TEXT layers carry their Figma
layer name, not their actual copy, and images aren't detected. The Bridge plugin
reads real `characters`; a Claude pass can infer the rest.

## Not built yet (next passes)

- **Claude-powered naming** — replace the heuristic in `synthesizeName()` with a
  `claude-sonnet-4-6` call that writes meaningful names/alt text from layer
  context and a screenshot. The `auto-named` flag already marks every spot that
  needs it; the missing text content (above) is the main thing it would fix.
- Figma REST API as a *tree-data* source too (it currently powers image
  previews only — adding it would let teammates navigate without plugin or MCP).
- Comments/feedback written back to Figma from the accessible view.
- Multi-user sessions (the relay is currently single-room).
