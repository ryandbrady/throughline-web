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

## Architecture

```
  Web app  ⇄  WebSocket relay (server/)  ⇄  Figma Bridge plugin  ⇄  Figma canvas
 (public/)                                    (figma-bridge/)
```

- `server/` — Express static host + WebSocket relay. `build-a11y-tree.js` turns
  raw Figma nodes into the accessibility tree; `mock-design.js` lets the app run
  with zero setup.
- `public/` — the accessible web app (plain HTML/CSS/JS, no build step).
- `figma-bridge/` — a companion Figma plugin. Its sandbox walks the document and
  drives canvas selection; its UI iframe owns the WebSocket.

## Run it

```bash
npm install
npm start            # http://localhost:4400
```

Open `http://localhost:4400`. If `server/real-design.js` exists it loads that
real Figma file; otherwise it falls back to the bundled **mock design**. Either
way the keyboard navigation works with no Figma running. (Set `PORT` to use a
different port: `PORT=5000 npm start`.)

For **live canvas sync**:

1. In the Figma desktop app: *Plugins → Development → Import plugin from
   manifest…* and pick `figma-bridge/manifest.json`.
2. Run the **Throughline Web Bridge** plugin in any file. It connects to
   `ws://localhost:4400` and pushes that file's structure to the web app.
3. The web app status flips to **Live**. Press Enter on any item to reveal it
   on the canvas; select layers on the canvas to move the web tree.

## Where the design data comes from

`build-a11y-tree.js` is the single "parser" — every source feeds the same raw
node shape (`{ id, name, type, visible, characters?, fontSize?, hasImageFill? }`)
through it. There are three sources:

1. **Mock** (`server/mock-design.js`) — bundled sample, zero setup.
2. **MCP import** (`server/real-design.js`) — a snapshot of a real Figma file.
3. **Bridge plugin** — live data pushed over the WebSocket; also drives the
   canvas. The only source that supports two-way sync.

### Import a real file via the Figma MCP

The Figma **MCP** is a local, Claude-side dev tool — a deployed web app can't
call it directly. Instead, Claude calls `get_metadata` for the file, and
`tools/import-figma-metadata.js` reshapes that dump into `server/real-design.js`:

```bash
node tools/import-figma-metadata.js <metadata-dump.txt> "My File Name"
```

`server/real-design.js` is git-ignored — run the importer to generate your own
from any file you have MCP access to. Without it, the bundled mock design loads.

Caveat: `get_metadata` returns structure only — node IDs, names, types,
visibility — **not text content or fills**. So TEXT layers carry their Figma
layer name, not their actual copy, and images aren't detected. The Bridge plugin
reads real `characters`; a Claude pass can infer the rest.

## Not built yet (next passes)

- **Claude-powered naming** — replace the heuristic in `synthesizeName()` with a
  `claude-sonnet-4-6` call that writes meaningful names/alt text from layer
  context and a screenshot. The `auto-named` flag already marks every spot that
  needs it; the missing text content (above) is the main thing it would fix.
- Figma REST API as a fourth data source (navigate without plugin or MCP).
- Comments/feedback written back to Figma from the accessible view.
- Multi-user sessions (the relay is currently single-room).
