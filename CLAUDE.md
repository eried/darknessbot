# Notes for Claude (project context)

This repo is the **GitHub Pages deployment target** for the DarknessBot Trip Viewer.
The *working / development* repo is at `D:\GitHub\darknessbot-trip-viewer\` (FastAPI scaffold
remnants + `web/` assets). Historically that repo was deployed as a Python server; it has since
been converted to fully client-side, with the static assets living under `web/`.

When the user asks for changes here, they usually mean: edit the originals in
`darknessbot-trip-viewer/web/`, then mirror the files into this repo's root. Keep the two in
sync unless told otherwise.

## File correspondence

| This repo (GitHub Pages) | Source (dev repo)                                           |
|--------------------------|-------------------------------------------------------------|
| `index.html`             | `darknessbot-trip-viewer/web/index.html`                    |
| `inspector.html`         | `darknessbot-trip-viewer/web/inspector.html`                |
| `static/favicon.svg`     | `darknessbot-trip-viewer/web/static/favicon.svg`            |
| `static/css/style.css`   | `darknessbot-trip-viewer/web/static/css/style.css`          |
| `static/css/inspector.css` | `darknessbot-trip-viewer/web/static/css/inspector.css`    |
| `static/js/app.js`       | `darknessbot-trip-viewer/web/static/js/app.js`              |
| `static/js/parser-worker.js` | `darknessbot-trip-viewer/web/static/js/parser-worker.js` |
| `static/js/inspector.js` | `darknessbot-trip-viewer/web/static/js/inspector.js`        |

## Architecture at a glance

- `app.js` boots Leaflet, loads cached tracks (IndexedDB → localStorage fallback), renders the
  trip tree. Paths are relative (`static/...`) so it works both at `/` and in a subfolder
  (`/<repo-name>/`) under GitHub Pages.
- `parser-worker.js` is a Web Worker (uses `importScripts` for JSZip). Parses `.dbb`/`.csv`
  off-thread and streams `progress` / `track` / `done` / `error` messages.
- `inspector.html` + `inspector.js` is a standalone page. It reads the `?i=<index>` query param,
  fetches tracks from IndexedDB (store `darknessbot-trip-viewer/currentSession` key `"tracks"`),
  falls back to `localStorage["dbb_tracks"]`, then drives a MapLibre terrain map + 5 canvas
  charts + SVG dashboard + playback loop.

## Storage keys (must match between app.js and inspector.js)

- IndexedDB database: `darknessbot-trip-viewer` (version 2)
  - object store `recentFiles` (keyPath `id`) — up to 5 recent uploads with full `tracks` array
  - object store `currentSession` (no keyPath; key `"tracks"`) — the most recently displayed
    `allTracks` array. **This is what the inspector reads.**
- localStorage `dbb_tracks` — same data, but silently dropped when it exceeds the browser quota
  for large multi-file datasets. IndexedDB is the reliable path.

## Why the inspector needs IndexedDB

For users with many trips, `JSON.stringify(allTracks)` exceeds the ~5 MB localStorage limit
and `setItem` throws. `app.js` catches silently. If the inspector only reads `localStorage`, it
shows **"Trip not found"**. Always read IndexedDB first in the inspector.

## Track schema (stable)

```
{
  name, date, dateStart, dateEnd,
  points:     [[lat, lon, speed, alt, volt, temp, battery], ...],
  timeseries: [[sec, speed, voltage, temp, battery, altitude, lat, lon], ...],  // downsampled to <= 500
  stats:      { points, rows, distanceKm, maxSpeed, avgSpeed, maxAlt, minAlt, maxVoltage, minVoltage, maxTemp }
}
```

Index `i` in `inspector.html?i=<i>` is the position in `allTracks` *after* sorting (newest
first, by `dateStart` / `date`). The inspector trusts this order — any change to sort logic in
`app.js` must be mirrored in how tracks are saved.

## Deploy

Just commit & push. GitHub Pages serves from `main` / root.
There is no build step. Bump the `?v=` query on linked JS/CSS in the HTML files when making
cache-visible changes.

## Things that tripped me before

- The inspector used to reference the FastAPI route `/trip?i=...`. In static mode it must be
  `inspector.html?i=...` (relative), and the button is in `app.js` → `buildTripItem()`.
- Web Worker `new Worker("static/js/parser-worker.js")` needs http(s), not `file://`.
- MapLibre terrain: DEM source uses `encoding: "terrarium"` and `maxzoom: 15`.

## Don't forget

- The dev repo also has `deploy_all.py` / DigitalOcean config — that path is now legacy
  (pre-GitHub-Pages). Don't deploy there unless asked.
- The user prefers local testing for non-trivial features before any deploy.
