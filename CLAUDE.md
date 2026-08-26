# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Notes for Claude (project context)

This repo (`eucviewer`) is the canonical, authoritative source for the EUC Planet Trip Viewer
and also serves it via GitHub Pages from `main` / root. It's fully client-side: HTML, CSS, JS,
no build step.

(Historical note: a sibling `darknessbot-trip-viewer` repo used to host these assets under
`web/` while a FastAPI server fronted them. That setup is retired; if you ever see references
to mirroring into that repo, ignore them.)

## Architecture at a glance

- `app.js` boots Leaflet, loads cached tracks (IndexedDB → localStorage fallback), renders the
  trip tree. Paths are relative (`static/...`) so it works both at `/` and in a subfolder
  (`/<repo-name>/`) under GitHub Pages.
- `parser-worker.js` is a Web Worker (uses `importScripts` for JSZip). Parses `.dbb`/`.csv`/`.gpx`/`.xlsx`
  off-thread and streams `progress` / `track` / `done` / `error` messages. SheetJS is lazy-loaded
  via `importScripts` only when the first `.xlsx` (direct or inside a `.dbb`) is encountered.
- `source-hints.js` + `euc-world-export.js` power the modal "Export your trips from euc.world".
  The modal hosts a draggable `javascript:` bookmarklet; clicking it inside a logged-in euc.world
  tab loads `euc-world-export.js`, which paginates `POST /webapi/userTours` and fetches
  `/xlsx/{key}` per tour, then triggers a `.dbb` download (store-mode ZIP, no external libs).
- `source-hints.js` + `dropbox-source.js` power the "Load trips from Dropbox" modal. The viewer
  is a Dropbox **Scoped App (App Folder)** — read access is limited to `Apps/EUC Planet/`.
  OAuth uses **PKCE** (no client secret), token in localStorage, redirect back to the same
  page URL with `?code=...`. Once connected, `list_folder` enumerates the `/trips` subfolder,
  the user clicks "Load N trips" and the modal downloads every file, bundles them via JSZip
  (STORE mode) into a single synthetic `.dbb`, and hands it to `window.eucViewerLoadFile` so
  it flows through the normal `handleFile` parse + recents pipeline. The Dropbox app needs
  these redirect URIs registered in the App Console: `https://eucviewer.ried.no/` and any
  local-dev origins (e.g. `http://localhost:8000/`).
- `inspector.html` + `inspector.js` is a standalone page. It reads the `?i=<index>` query param,
  fetches tracks from IndexedDB (store `eucplanet-trip-viewer/currentSession` key `"tracks"`),
  falls back to `localStorage["dbb_tracks"]`, then drives a MapLibre terrain map + 5 canvas
  charts + SVG dashboard + playback loop.
- `analytics.html` + `analytics.js` is the whole-history analysis page ("Analyze history" in the
  trip-panel footer). Loads tracks the same way the inspector does, computes per-trip metrics
  (estimated range from battery delta, Wh/km, avg speed/current, internal-resistance proxy from
  the V~I sag slope, temp rise), groups them into bins (calendar month/quarter/year or cumulative
  km/hours), and renders hand-drawn canvas trend/scatter charts. Optional ambient temperature
  comes from the Open-Meteo archive API (free, no key, CORS) — one request per 0.1°-rounded
  location cluster at daily resolution, cached in the `weatherCache` IDB store. Range can be
  temperature-normalized to 20 °C via a Theil–Sen fit of range vs ambient.

## Storage keys (must match between app.js and inspector.js)

- IndexedDB database: `eucplanet-trip-viewer` (version 3)
  - object store `recentFiles` (keyPath `id`) — up to 5 recent uploads with full `tracks` array
  - object store `currentSession` (no keyPath; key `"tracks"`) — the most recently displayed
    `allTracks` array. **This is what the inspector reads.**
  - object store `weatherCache` (no keyPath; key `"{lat}|{lon}"` rounded to 0.1°) — value
    `{ days: { "YYYY-MM-DD": { mean, max } }, fetchedAt }`, daily temps from Open-Meteo.
    The v3 upgrade block exists in **both** `app.js openRecentDb()` and `analytics.js openDb()`
    (whichever page opens first creates the store) — keep them identical.
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
  points:     [[lat, lon, speed, alt, volt, temp, battery, pwm, current, power, gpsSpeed,
                torque, phaseCurrent], ...],
  timeseries: [[sec, speed, voltage, temp, battery, altitude, lat, lon, mileageKm,
                pwm, current, power, gpsSpeed, gForce, gForceX, gForceY,
                torque, phaseCurrent], ...],  // downsampled to <= 500
  stats:      { points, rows, distanceKm, maxSpeed, avgSpeed, maxAlt, minAlt, maxVoltage, minVoltage, maxTemp }
}
```

Columns are **append-only** — legacy cached tracks lack the trailing fields, so
every reader guards for `undefined`. `gpsSpeed` (timeseries 12 / points 10) and
the three `gForce*` columns (timeseries 13-15) come from newer EUC Planet
exports; a value of `0` for `gForce` means "no IMU sample for that row".
`torque` (Nm, signed) and `phaseCurrent` (A, signed) at timeseries 16-17 come
from EUC Planet 0.19+ (resolved by CSV header name, never fixed index). A wheel
that doesn't report one logs a constant `0`, so an **all-zero column is treated
as absent** (shown nothing, not a flat 0). The inspector's derived "…avg" spare
columns therefore live at 18-21, not 16-19. Both are also appended to `points`
(11-12) so the viewer + inspector map traces can colour by them (palette-aware,
bipolar like Current); the `_pointFromRow` split/combine mapper carries them,
and the trace-colour option is disabled when the column is absent. `trackToCSV`
now writes a **full** telemetry row
(PWM/Current/Power/mileage/GPS speed/G-Force/Torque/Phase current all included),
so a `.csv` export or Dropbox re-sync round-trips losslessly; columns resolve by
header name, and legacy 16-col tracks emit "" for the trailing ones.

Index `i` in `inspector.html?i=<i>` is the position in `allTracks` *after* sorting (newest
first, by `dateStart` / `date`). The inspector trusts this order — any change to sort logic in
`app.js` must be mirrored in how tracks are saved.

## Local development

It's all static — any HTTP server works. A `serve.cmd` is checked in for convenience:

```
serve.cmd                 # launches: python -m http.server 8000  → http://localhost:8000/
```

Worker + IndexedDB require `http(s)://`, not `file://`.

## CDN libraries (pinned versions)

- Leaflet 1.9.4 (main map)
- MapLibre GL 4.7.1 (inspector 3D map + terrain)
- JSZip 3.10.1 (loaded inside `parser-worker.js` via `importScripts`)
- SheetJS (xlsx) 0.18.5 (lazy-loaded in `parser-worker.js` only on first `.xlsx` parse)
- AWS terrarium DEM tiles for elevation: `s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png`

## Deploy

Just commit & push. GitHub Pages serves from `main` / root.
There is no build step. Bump the `?v=` query on linked JS/CSS in the HTML files when making
cache-visible changes. The footer version badge is driven by `document.lastModified`, so the
displayed date updates automatically on each deploy — no manual version bump needed for it.

## Things that tripped me before

- The inspector used to reference the FastAPI route `/trip?i=...`. In static mode it must be
  `inspector.html?i=...` (relative), and the button is in `app.js` → `buildTripItem()`.
- Web Worker `new Worker("static/js/parser-worker.js")` needs http(s), not `file://`.
- MapLibre terrain: DEM source uses `encoding: "terrarium"` and `maxzoom: 15`.

## Don't forget

- The user prefers local testing for non-trivial features before any deploy.
