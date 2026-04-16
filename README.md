# DarknessBot Trip Viewer

Fully client-side web viewer for DarknessBot scooter trip logs (`.dbb` / `.csv`).
Runs as static pages, no backend.

## Structure

```
index.html                 Main map + trip list
inspector.html             Single-trip inspector (3D map + playback)
static/
  favicon.svg
  css/style.css            Main app styles
  css/inspector.css        Inspector styles
  js/app.js                Main app (Leaflet map, trip tree, recent files)
  js/inspector.js          Inspector (MapLibre GL 3D map, charts, playback)
  js/parser-worker.js      Web Worker: parses .dbb/.csv client-side with JSZip
```

External libraries (all loaded from CDN):
- Leaflet 1.9.4 (main map)
- MapLibre GL 4.7.1 (inspector 3D map with terrain)
- JSZip 3.10.1 (in worker, unpacks `.dbb` zip archives)
- AWS terrarium DEM tiles (elevation): `s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png`

## Data storage

- **IndexedDB** `darknessbot-trip-viewer` — primary storage
  - `recentFiles` store: up to 5 recently uploaded files with their parsed tracks
  - `currentSession` store: last-loaded `allTracks` array (key `"tracks"`)
- **localStorage** `dbb_tracks` — fallback/fast cache for small datasets (silently fails over quota)

The inspector (`inspector.html?i=<index>`) reads from IndexedDB first, then falls back to localStorage.

## Track data shape

Each track object:
```
{
  name, date, dateStart, dateEnd,
  points: [[lat, lon, speed, alt, volt, temp, battery], ...],   // only GPS-bearing rows
  timeseries: [[sec, speed, voltage, temp, battery, altitude, lat, lon], ...],  // max 500 rows
  stats: { points, rows, distanceKm, maxSpeed, avgSpeed, maxAlt, minAlt, maxVoltage, minVoltage, maxTemp }
}
```

## Android / WebView integration

The viewer can be loaded programmatically from an Android WebView (or any embedded browser). A JavaScript API (`window.loadDbbFromBase64`) accepts base64-encoded `.dbb` or `.csv` data and displays it on the map without manual upload. See [INTEGRATION.md](INTEGRATION.md) for details and code examples.

## Local development

It's static — any static file server works:
```
python -m http.server 8000
# then open http://localhost:8000/
```
Note: `inspector.html` uses a Web Worker, which requires serving via `http://` (not `file://`).
