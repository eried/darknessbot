document.addEventListener("DOMContentLoaded", function () {
  // Imperial unit toggle — drives display labels and converters everywhere
  // values are shown. Resolution order: ?units= URL param, then localStorage
  // (the cogwheel toggle persists here), then timezone-based inference.
  //
  // We deliberately do NOT use navigator.language any more: English Windows
  // installations everywhere — including all of Europe — send en-US by
  // default, so language was misclassifying metric users as imperial.
  // Timezone is OS-set from the user's actual location and is the strongest
  // signal we can get without geolocation. Imperial is opt-in: it only
  // fires when the timezone is unambiguously in the US, a US territory,
  // Liberia or Myanmar. Anything else (including unknown / missing tz)
  // falls through to metric so a European never sees miles by accident.
  const UNITS_STORAGE_KEY = "eucviewer-units";

  // Graph resolution: samples kept per trip after downsampling. Chosen in
  // the settings cogwheel, applied at parse time (see the worker). Higher =
  // finer graphs/gauges, more memory. Standard 2000 · High 4000 · Max 8000.
  const GRAPHRES_KEY = "eucviewer-graph-res";
  const GRAPHRES_VALUES = [2000, 4000, 8000];
  const GRAPHRES_DEFAULT = 2000;
  function currentGraphRes() {
    const v = parseInt(localStorage.getItem(GRAPHRES_KEY), 10);
    return GRAPHRES_VALUES.includes(v) ? v : GRAPHRES_DEFAULT;
  }

  const IMPERIAL_TZ_RE = new RegExp("^(?:" +
    "America/(?:Adak|Anchorage|Boise|Chicago|Denver|Detroit|Indiana/[^/]+|Juneau|Kentucky/[^/]+|Los_Angeles|Menominee|Metlakatla|New_York|Nome|North_Dakota/[^/]+|Phoenix|Puerto_Rico|Sitka|St_Thomas|Yakutat)" +
    "|Pacific/(?:Honolulu|Pago_Pago|Guam|Saipan|Midway|Wake)" +
    "|Africa/Monrovia" +
    "|Asia/(?:Yangon|Rangoon)" +
    ")$");
  function detectUnits() {
    try {
      const force = new URLSearchParams(location.search).get("units");
      if (force === "imperial" || force === "metric") return force;
    } catch (_) {}
    try {
      const stored = localStorage.getItem(UNITS_STORAGE_KEY);
      if (stored === "imperial" || stored === "metric") return stored;
    } catch (_) {}
    try {
      const tz = (Intl.DateTimeFormat().resolvedOptions().timeZone || "").trim();
      if (IMPERIAL_TZ_RE.test(tz)) return "imperial";
    } catch (_) {}
    return "metric";
  }
  const UNITS = (() => {
    const imperial = detectUnits() === "imperial";
    return imperial
      ? {
          imperial: true,
          dist:  (km) => km * 0.621371,
          speed: (kmh) => kmh * 0.621371,
          temp:  (c) => c * 9 / 5 + 32,
          alt:   (m) => m * 3.28084,
          distUnit: "mi", speedUnit: "mph", tempUnit: "°F", altUnit: "ft",
        }
      : {
          imperial: false,
          dist:  (km) => km, speed: (kmh) => kmh, temp: (c) => c, alt: (m) => m,
          distUnit: "km", speedUnit: "km/h", tempUnit: "°C", altUnit: "m",
        };
  })();

  // Wire up the cogwheel's Metric/Imperial toggle. Persists to localStorage
  // and reloads — UNITS is captured into countless render closures, so a
  // hot-swap would mean re-rendering everything; reload is simpler & cleaner.
  (function setupUnitsToggle() {
    const current = UNITS.imperial ? "imperial" : "metric";
    document.querySelectorAll(".units-btn").forEach((btn) => {
      if (btn.dataset.units === current) btn.classList.add("active");
      btn.addEventListener("click", () => {
        const next = btn.dataset.units;
        if (next === current) return;
        try { localStorage.setItem(UNITS_STORAGE_KEY, next); } catch (_) {}
        location.reload();
      });
    });
  })();

  // Graph resolution picker. Resolution is baked in at parse time and the
  // raw samples are discarded, so an already-loaded trip can't be upscaled —
  // switching clears the current session and the user re-imports at the new
  // resolution. With nothing loaded, it just takes effect on the next load.
  (function setupGraphResToggle() {
    const sel = document.getElementById("graph-res-select");
    if (!sel) return;
    sel.value = String(currentGraphRes());
    sel.addEventListener("change", async () => {
      const next = parseInt(sel.value, 10);
      if (next === currentGraphRes()) return;
      const hasTrips = Array.isArray(allTracks) && allTracks.length > 0;
      if (hasTrips && !window.confirm(
        "Switching graph resolution clears your loaded trips (they were parsed at the old resolution). Re-import to load them at the new one. Continue?")) {
        sel.value = String(currentGraphRes());
        return;
      }
      try { localStorage.setItem(GRAPHRES_KEY, String(next)); } catch (_) {}
      if (!hasTrips) return;
      try {
        const db = await openRecentDb();
        if (db) {
          const tx = db.transaction(SESSION_STORE_NAME, "readwrite");
          tx.objectStore(SESSION_STORE_NAME).delete(SESSION_KEY);
          await transactionDone(tx);
        }
      } catch (_) {}
      try { localStorage.removeItem("dbb_tracks"); sessionStorage.removeItem("dbb_tracks"); } catch (_) {}
      location.reload();
    });
  })();

  // --- Map setup with multiple tile layers ---
  // Seven free (no-key) basemaps. `light` marks pale basemaps so the trace glow
  // can pick a colour that reads on them. (EUC Planet still ships the two Carto
  // styles; swap those there too once Carto's key requirement bites the app.)
  const standardLayer = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19, attribution: "© OpenStreetMap contributors",
  });
  const cyclosmLayer = L.tileLayer("https://{s}.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png", {
    subdomains: "abc", maxZoom: 20, attribution: "© OpenStreetMap contributors, tiles CyclOSM / OSM France",
  });
  const topoLayer = L.tileLayer("https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png", {
    subdomains: "abc", maxZoom: 17, attribution: "© OpenStreetMap, SRTM; style © OpenTopoMap (CC-BY-SA)",
  });
  const hotLayer = L.tileLayer("https://{s}.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png", {
    subdomains: "ab", maxZoom: 20, attribution: "© OpenStreetMap contributors, tiles HOT / OSM France",
  });
  // Esri keyless basemaps replace the two Carto styles: Carto deprecated its
  // free no-key tiles and now stamps an "API KEY REQUIRED" watermark on tiles
  // outside its cached set. Esri's Street / Dark Gray canvases are keyless and
  // reliable. Dark Gray is only cached to ~z16, so cap the native level and let
  // Leaflet upscale beyond (same trick as satellite).
  const esriStreetsLayer = L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}",
    { maxZoom: 19, maxNativeZoom: 18, attribution: "Esri, HERE, Garmin, © OpenStreetMap contributors" }
  );
  const esriDarkLayer = L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}",
    { maxZoom: 19, maxNativeZoom: 16, attribution: "Esri, HERE, Garmin, © OpenStreetMap contributors" }
  );
  const satelliteLayer = L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    // Esri's hi-res coverage ends early outside metros and serves "Map Data
    // Not Available" placeholder tiles (HTTP 200) beyond it. Capping the
    // native level makes Leaflet upscale the last real imagery instead.
    { maxZoom: 19, maxNativeZoom: 18, attribution: "Esri, Maxar, Earthstar Geographics" }
  );
  // Map style is chosen in the #map-controls panel and persisted to localStorage.
  const MAP_LAYER_KEY = "dbb_map_layer";
  const BASE_STYLES = {
    standard:  { layer: standardLayer,  light: true,  label: "Standard" },
    cyclosm:   { layer: cyclosmLayer,   light: true,  label: "CyclOSM" },
    topo:      { layer: topoLayer,      light: true,  label: "OpenTopoMap" },
    hot:       { layer: hotLayer,       light: true,  label: "Humanitarian" },
    voyager:   { layer: esriStreetsLayer, light: true,  label: "Streets" },
    cartodark: { layer: esriDarkLayer,    light: false, label: "Dark" },
    satellite: { layer: satelliteLayer, light: false, label: "Satellite" },
  };
  let selectedStyle = "satellite"; // default for new users
  try {
    let saved = (localStorage.getItem(MAP_LAYER_KEY) || "").toLowerCase();
    if (saved === "dark") saved = "cartodark"; // migrate the old CSS-inverted dark
    if (BASE_STYLES[saved]) selectedStyle = saved;
  } catch (_) {}
  let glowLayer;

  // Trace style: how the track lines are painted. "neon" is the layered
  // glow, "normal" is flat solid lines, "dark" adds a dark casing under a
  // saturated core so traces stay readable on whitish tiles. Unless the
  // user picks one explicitly, the style follows the basemap (satellite →
  // normal, dark → neon, standard/topo → dark); switching basemap returns
  // to that automatic pairing.
  const TRACE_STYLE_KEY = "eucviewer-trace-style";
  let traceStyleUser = null;
  try {
    const savedTs = (localStorage.getItem(TRACE_STYLE_KEY) || "").toLowerCase();
    if (savedTs === "normal" || savedTs === "neon" || savedTs === "dark") traceStyleUser = savedTs;
  } catch (_) {}
  function defaultTraceStyle(styleName) {
    if (styleName === "satellite") return "normal";
    if (styleName === "cartodark") return "neon"; // dark basemap
    return "dark"; // light basemaps need the dark casing
  }
  function effectiveTraceStyle() { return traceStyleUser || defaultTraceStyle(selectedStyle); }

  const map = L.map("map", {
    center: [65, 15],
    zoom: 5,
    zoomControl: false,
    preferCanvas: true,
    // Fractional zoom: settle on quarter levels, half a level per +/-
    // press, and twice the scroll distance per level, so zooming stops
    // jumping 2x at a time. Raster tiles scale between integer levels.
    zoomSnap: 0.25,
    zoomDelta: 0.5,
    wheelPxPerZoomLevel: 120,
    layers: [BASE_STYLES[selectedStyle].layer],
  });

  // Base layer is driven by the #map-controls panel (see setBaseStyle below);
  // the bottom-left control is just zoom now.
  L.control.zoom({ position: "bottomleft" }).addTo(map);

  // --- State ---
  let allTracks = [];
  let selectedIdx = -1;
  let traceColor = "speed"; // "solid" | speed | battery | voltage | temp | altitude | distance
  let trackVisible = new Set();

  function haversineKm(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const toRad = Math.PI / 180;
    const dLat = (lat2 - lat1) * toRad;
    const dLon = (lon2 - lon1) * toRad;
    const a = Math.sin(dLat / 2) ** 2 +
              Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  // Compact trip label for the list. Uses the browser's locale so US users see
  // "11/5/2025, 7:08 PM" while NO/DE/UK users see "05.11.2025, 19:08" etc.
  // Falls back to the filename-derived date or raw name if dateStart is bad.
  const TRIP_LABEL_FMT = new Intl.DateTimeFormat(undefined, {
    year: "numeric", month: "numeric", day: "numeric",
    hour: "numeric", minute: "2-digit",
  });
  function formatTripLabel(t) {
    if (t.customName) return t.customName;
    const iso = t.dateStart || "";
    if (iso) {
      const d = new Date(iso);
      if (!isNaN(d.getTime())) return TRIP_LABEL_FMT.format(d);
    }
    return t.date || t.name || "Trip";
  }
  // The date/time label on its own, ignoring any custom name — used as the
  // rename field's placeholder so blanking it shows what you'll fall back to.
  function tripDateLabel(t) {
    const iso = t.dateStart || "";
    if (iso) {
      const d = new Date(iso);
      if (!isNaN(d.getTime())) return TRIP_LABEL_FMT.format(d);
    }
    return t.date || t.name || "Trip";
  }

  // Trip duration in hours from the ISO timestamps, falling back to the
  // timeseries span for tracks without dateStart/dateEnd.
  function tripDurH(t) {
    if (t.dateStart && t.dateEnd) {
      const s = Date.parse(t.dateStart), e = Date.parse(t.dateEnd);
      if (isFinite(s) && isFinite(e) && e > s) return (e - s) / 3600000;
    }
    const ts = t.timeseries;
    if (Array.isArray(ts) && ts.length > 1) {
      const span = ts[ts.length - 1][0] - ts[0][0];
      if (span > 0) return span / 3600;
    }
    return 0;
  }
  function fmtDurH(h) {
    const totalMin = Math.round(h * 60);
    if (totalMin < 1) return "";
    const hh = Math.floor(totalMin / 60), mm = totalMin % 60;
    return hh > 0 ? `${hh}h ${mm}m` : `${mm}m`;
  }

  // Cumulative distance arrays (km) cached per track
  function getCumDistPts(track) {
    if (track._cumDistPts) return track._cumDistPts;
    const arr = new Float32Array(track.points.length);
    let d = 0;
    for (let i = 1; i < track.points.length; i++) {
      const a = track.points[i - 1], b = track.points[i];
      d += haversineKm(a[0], a[1], b[0], b[1]);
      arr[i] = d;
    }
    track._cumDistPts = arr;
    return arr;
  }

  function getCumDistTs(track) {
    if (track._cumDistTs) return track._cumDistTs;
    const ts = track.timeseries;
    const arr = new Float32Array(ts.length);
    let d = 0, lastLat = 0, lastLon = 0, started = false;
    for (let i = 0; i < ts.length; i++) {
      const lat = ts[i][6], lon = ts[i][7];
      if (lat || lon) {
        if (started) d += haversineKm(lastLat, lastLon, lat, lon);
        lastLat = lat; lastLon = lon; started = true;
      }
      arr[i] = d;
    }
    track._cumDistTs = arr;
    return arr;
  }

  function heatColor(t) {
    t = Math.max(0, Math.min(1, t));
    let r, g, b;
    if (t < 0.25)      { const f = t / 0.25;          r = 0;   g = Math.round(255 * f); b = 255; }
    else if (t < 0.5)  { const f = (t - 0.25) / 0.25; r = 0;   g = 255; b = Math.round(255 * (1 - f)); }
    else if (t < 0.75) { const f = (t - 0.5) / 0.25;  r = Math.round(255 * f); g = 255; b = 0; }
    else                { const f = (t - 0.75) / 0.25; r = 255; g = Math.round(255 * (1 - f)); b = 0; }
    return `${r},${g},${b}`;
  }

  // Per-metric colour ramps (low → high), interpolated across evenly-spaced
  // rgb stops. Each metric reads sensibly instead of one shared rainbow:
  // speed green→red through orange, battery/power/current blue→red through
  // purple, temp cold→hot, altitude valley→peak, distance a vivid violet→green.
  // Kept identical in inspector.js for trace-colour parity.
  const RAMP_STOPS = {
    speed:    [[47, 216, 90], [255, 155, 31], [255, 43, 43]],
    gpsspeed: [[47, 216, 90], [255, 155, 31], [255, 43, 43]],
    pwm:      [[47, 216, 90], [255, 155, 31], [255, 43, 43]],
    power:    [[43, 140, 255], [161, 59, 255], [255, 59, 59]],
    current:  [[43, 140, 255], [161, 59, 255], [255, 59, 59]],
    torque:   [[43, 140, 255], [161, 59, 255], [255, 59, 59]],
    phase:    [[43, 140, 255], [161, 59, 255], [255, 59, 59]],
    battery:  [[43, 140, 255], [161, 59, 255], [255, 59, 59]],
    voltage:  [[43, 140, 255], [161, 59, 255], [255, 59, 59]],
    temp:     [[51, 181, 255], [255, 138, 31], [255, 43, 43]],
    altitude: [[23, 192, 180], [216, 178, 74], [242, 242, 242]],
    distance: [[176, 32, 255], [255, 45, 214], [0, 230, 118]],
  };
  function rampColor(stops, t) {
    t = Math.max(0, Math.min(1, t));
    const n = stops.length - 1;
    let seg = Math.floor(t * n); if (seg >= n) seg = n - 1;
    const f = t * n - seg, a = stops[seg], b = stops[seg + 1];
    return `${Math.round(a[0] + (b[0] - a[0]) * f)},${Math.round(a[1] + (b[1] - a[1]) * f)},${Math.round(a[2] + (b[2] - a[2]) * f)}`;
  }
  // Palette selector: a global override of how the per-metric ramps are
  // coloured, saved per browser and shared with the inspector. "default" keeps
  // each metric's own ramp; "reverse" flips it; the rest replace every metric
  // with one shared ramp (legacy = the original blue→green→red rainbow, etc.).
  const PALETTE_SINGLE = {
    legacy:  [[0, 0, 255], [0, 255, 255], [0, 255, 0], [255, 255, 0], [255, 0, 0]],
    rainbow: [[132, 0, 255], [0, 96, 255], [0, 210, 210], [0, 210, 60], [240, 220, 0], [255, 130, 0], [255, 0, 0]],
    viridis: [[68, 1, 84], [59, 82, 139], [33, 145, 140], [94, 201, 98], [253, 231, 37]],
  };
  const PALETTE_KEY = "dbb_trace_palette";
  let paletteMode = "default";
  try { const s = (localStorage.getItem(PALETTE_KEY) || "").toLowerCase(); if (s) paletteMode = s; } catch (_) {}
  function stopsFor(key) {
    const base = RAMP_STOPS[key] || RAMP_STOPS.speed;
    switch (paletteMode) {
      case "reverse": return base.slice().reverse();
      case "legacy": return PALETTE_SINGLE.legacy;
      case "rainbow": return PALETTE_SINGLE.rainbow;
      case "reverse-rainbow": return PALETTE_SINGLE.rainbow.slice().reverse();
      case "viridis": return PALETTE_SINGLE.viridis;
      default: return base;
    }
  }
  function metricColorFn(key) {
    const stops = stopsFor(key);
    return (t) => rampColor(stops, t);
  }
  function distanceColor(t) { return rampColor(stopsFor("distance"), t); }

  // Movement / stillness modes: a drastic red ramp over the "on" band,
  // transparent (undrawn) outside it. Wheel speed (km/h) drives the mask;
  // the mask returns null for segments that should not be painted.
  const RED_RAMP = [[255, 45, 45], [90, 0, 0]]; // bright → dark red
  const MOVE_TH = 5;   // km/h — moving / still boundary
  const MOVE_MAX = 50; // km/h — top of the moving ramp
  function movingMask(kmh) {
    if (!(kmh >= MOVE_TH)) return null;                          // still / no data
    return Math.min(1, (kmh - MOVE_TH) / (MOVE_MAX - MOVE_TH));  // bright at TH → dark toward MAX
  }
  function stillMask(kmh) {
    if (!(kmh < MOVE_TH)) return null;                           // moving
    return Math.min(1, (MOVE_TH - kmh) / MOVE_TH);               // bright near TH → dark toward 0
  }
  // Movement modes colour by wheel speed through the SELECTED palette (so
  // Rainbow etc. carry through) instead of a fixed red, keeping their masks.
  // Factory captures the current palette once per draw.
  function moveColorFn() {
    const stops = stopsFor("speed");
    return (t) => rampColor(stops, t);
  }

  // Mix mode: a trip-structure view. Colour follows wheel speed through the
  // palette; the band sets the style — stops (<4 km/h) thick + solid, walk
  // (4–8) dashed and fading toward 8 (the mount/dismount points), riding (>8) a
  // faint dashed ghost. MIX_COLOR_MAX spreads the palette over the low/mid
  // speeds so stops and walk actually vary. Returns {color, alpha, width, dash}.
  const MIX_STOP = 4, MIX_WALK = 8, MIX_COLOR_MAX = 15;
  function makeMixSegStyle() {
    // Reversed speed ramp: Mix emphasises stops, so the stopped/slow parts take
    // the hot end and riding fades to the cold end — matching Stopped mode
    // (where a dead stop is also the hot colour) instead of contradicting it.
    const stops = stopsFor("speed").slice().reverse();
    return (kmh) => {
      if (typeof kmh !== "number" || !(kmh >= 0)) return null;
      const color = rampColor(stops, Math.min(1, kmh / MIX_COLOR_MAX));
      if (kmh < MIX_STOP) return { color, alpha: 1, width: 6, dash: null };
      if (kmh < MIX_WALK) {
        const a = 0.65 * (MIX_WALK - kmh) / (MIX_WALK - MIX_STOP); // fades to 0 at 8 km/h
        return { color, alpha: a, width: 3, dash: [5, 4] };
      }
      return { color, alpha: 0.16, width: 2.5, dash: [2, 6] }; // riding ghost
    };
  }

  const PAINT_METRICS = {
    distance: { pointIdx: -1 },
    speed:    { pointIdx: 2 },
    gpsspeed: { pointIdx: 10 },
    pwm:      { pointIdx: 7 },
    power:    { pointIdx: 9 },
    current:  { pointIdx: 8 },
    torque:   { pointIdx: 11 },
    phase:    { pointIdx: 12 },
    battery:  { pointIdx: 6 },
    voltage:  { pointIdx: 4 },
    temp:     { pointIdx: 5 },
    altitude: { pointIdx: 3 },
  };

  // --- Glow canvas overlay ---
  const GlowLayer = L.Layer.extend({
    onAdd(map) {
      this._map = map;
      // leaflet-zoom-animated: during a zoom animation the map container
      // carries .leaflet-zoom-anim, whose CSS transitions the transform we
      // set in _updateTransform, so the trace scales WITH the tiles
      // instead of freezing until zoomend repaints it.
      this._canvas = L.DomUtil.create("canvas", "glow-canvas leaflet-zoom-animated");
      this._canvas.style.pointerEvents = "none";
      map.getPane("overlayPane").appendChild(this._canvas);
      this._ctx = this._canvas.getContext("2d");
      this._latLngs = [];
      this._selected = -1;
      this._visible = null;
      this._onViewChange = this._onViewChange.bind(this);
      map.on("moveend zoomend viewreset resize", this._onViewChange);
      map.on("zoomanim", this._onZoomAnim, this);
      map.on("zoom", this._onZoom, this);
      this._onViewChange();
    },
    onRemove(map) {
      L.DomUtil.remove(this._canvas);
      map.off("moveend zoomend viewreset resize", this._onViewChange);
      map.off("zoomanim", this._onZoomAnim, this);
      map.off("zoom", this._onZoom, this);
    },
    // Zoom-follow, same scheme as L.Renderer: transform the already-drawn
    // canvas to where its content lands under the new (center, zoom); the
    // zoomend redraw then repaints it crisp and setPosition clears the
    // scale. "zoomanim" covers the animated wheel/button zoom, "zoom" the
    // per-frame pinch and flyTo updates.
    _onZoomAnim(e) { this._updateTransform(e.center, e.zoom); },
    _onZoom() { this._updateTransform(this._map.getCenter(), this._map.getZoom()); },
    _updateTransform(center, zoom) {
      if (!this._drawnCenter) return;
      const map = this._map;
      const scale = map.getZoomScale(zoom, this._drawnZoom);
      const currentCenterPoint = map.project(this._drawnCenter, zoom);
      const topLeftOffset = this._drawnViewHalf.multiplyBy(-scale)
        .add(currentCenterPoint)
        .subtract(map._getNewPixelOrigin(center, zoom));
      L.DomUtil.setTransform(this._canvas, topLeftOffset, scale);
    },
    setData(latLngs, selected) {
      this._latLngs = latLngs;
      this._selected = selected;
      this._draw();
    },
    setPaint(data) {
      this._paintData = data;
      this._draw();
    },
    setVisible(vis) {
      this._visible = vis;
      this._draw();
    },
    // Batched state write with a single redraw. The individual setters
    // each trigger a full draw; updateGlow uses this so one interaction
    // costs one draw instead of three.
    update(opts) {
      if ("latLngs" in opts) this._latLngs = opts.latLngs;
      if ("selected" in opts) this._selected = opts.selected;
      if ("visible" in opts) this._visible = opts.visible;
      if ("paint" in opts) this._paintData = opts.paint;
      this._draw();
    },
    redraw() { this._draw(); },
    _onViewChange() { this._draw(); },
    _perf(label, t0) {
      try {
        if (localStorage.getItem("eucviewer-perf") === "1") {
          console.log("[perf] " + label + " " + (performance.now() - t0).toFixed(1) + "ms");
        }
      } catch (_) {}
    },
    // Layer-point projections for every track, cached per map view.
    // Layer coordinates are stable across pans (they only reset on zoom /
    // viewreset), so checkbox toggles and selection changes redraw without
    // re-projecting ~140k points; only the canvas offset (ox/oy) shifts.
    _projectAll() {
      const map = this._map;
      const o = map.getPixelOrigin();
      const key = map.getZoom() + "|" + o.x + "|" + o.y;
      if (this._proj && this._proj.key === key && this._proj.src === this._latLngs) {
        return this._proj.tracks;
      }
      const __t0 = performance.now();
      const tracks = this._latLngs.map((lls) => {
        const n = lls.length;
        const xs = new Float64Array(n), ys = new Float64Array(n);
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (let i = 0; i < n; i++) {
          const p = map.latLngToLayerPoint(lls[i]);
          xs[i] = p.x;
          ys[i] = p.y;
          if (p.x < minX) minX = p.x;
          if (p.x > maxX) maxX = p.x;
          if (p.y < minY) minY = p.y;
          if (p.y > maxY) maxY = p.y;
        }
        return { xs, ys, n, minX, minY, maxX, maxY };
      });
      this._proj = { key, src: this._latLngs, tracks };
      this._perf("reproject", __t0);
      return tracks;
    },
    _draw() {
      if (!this._map) return;
      const __t0 = performance.now();
      const map = this._map;
      const size = map.getSize();
      const pad = 512;
      const w = size.x + pad * 2;
      const h = size.y + pad * 2;
      this._canvas.width = w;
      this._canvas.height = h;
      const topLeft = map.containerPointToLayerPoint([-pad, -pad]);
      L.DomUtil.setPosition(this._canvas, topLeft);
      // Reference view for the zoom-follow transform (_updateTransform).
      this._drawnCenter = map.getCenter();
      this._drawnZoom = map.getZoom();
      this._drawnViewHalf = L.point(size.x / 2 + pad, size.y / 2 + pad);
      const ctx = this._ctx;
      ctx.clearRect(0, 0, w, h);
      if (!this._latLngs.length) return;

      const sel = this._selected;
      const vis = this._visible;
      const ox = topLeft.x;
      const oy = topLeft.y;

      // Pass sets per trace style. "neon" keeps the layered glow, "normal"
      // is flat solid lines, "dark" draws a near-black casing under a
      // saturated core so colors read on whitish tiles.
      const styleMode = effectiveTraceStyle();
      const isLightMap = !!(BASE_STYLES[selectedStyle] && BASE_STYLES[selectedStyle].light);
      const dimBase = sel >= 0 ? 0.35 : 1;
      let basePasses, selectedPasses, heatPasses, heatCasing = null;
      if (styleMode === "neon") {
        const cyanPasses = [
          { width: 8, alpha: 0.04, color: "0,229,255" },
          { width: 4, alpha: 0.08, color: "0,229,255" },
          { width: 2, alpha: 0.25, color: "0,255,200" },
          { width: 1, alpha: 0.5,  color: "200,255,255" },
        ];
        const orangePasses = [
          { width: 18, alpha: 0.05, color: "255,160,0" },
          { width: 12, alpha: 0.1,  color: "255,160,0" },
          { width: 7,  alpha: 0.2,  color: "255,180,30" },
          { width: 4,  alpha: 0.5,  color: "255,200,50" },
          { width: 2,  alpha: 0.9,  color: "255,240,180" },
        ];
        const fuchsiaAlphaPasses = [
          { width: 16, alpha: 0.02, color: "230, 0, 126" },
          { width: 10, alpha: 0.04, color: "230, 0, 126" },
          { width: 6,  alpha: 0.08, color: "230, 0, 126" },
          { width: 3,  alpha: 0.16, color: "230, 0, 126" },
          { width: 2,  alpha: 0.3, color: "230, 0, 126" },
        ];
        const fuchsiaPasses = [
          { width: 16, alpha: 0.08, color: "230, 0, 126" },
          { width: 10, alpha: 0.16, color: "230, 0, 126" },
          { width: 6,  alpha: 0.35, color: "230, 0, 126" },
          { width: 3,  alpha: 0.65, color: "230, 0, 126" },
          { width: 2,  alpha: 0.95, color: "230, 0, 126" },
        ];
        basePasses = (isLightMap ? fuchsiaAlphaPasses : cyanPasses).map((p) => ({
          ...p, alpha: sel >= 0 ? p.alpha * 0.3 : p.alpha, comp: "lighter",
        }));
        selectedPasses = (isLightMap ? fuchsiaPasses : orangePasses).map((p) => ({
          ...p, comp: isLightMap || p.width <= 4 ? "source-over" : "lighter",
        }));
        heatPasses = [
          { width: 12, alpha: 0.1,  comp: "lighter" },
          { width: 6,  alpha: 0.3,  comp: "lighter" },
          { width: 3,  alpha: 0.9,  comp: "source-over" },
        ];
      } else if (styleMode === "normal") {
        basePasses = [
          { width: 2, alpha: 0.8 * dimBase, color: "0,229,255", comp: "source-over" },
        ];
        selectedPasses = [
          { width: 3.5, alpha: 0.95, color: "255,170,0", comp: "source-over" },
        ];
        heatPasses = [{ width: 3.5, alpha: 1, comp: "source-over" }];
      } else { // dark casing
        basePasses = [
          { width: 4.5, alpha: 0.85 * dimBase, color: "10,10,18", comp: "source-over" },
          { width: 2,   alpha: 0.95 * dimBase, color: "0,229,255", comp: "source-over" },
        ];
        selectedPasses = [
          { width: 6.5, alpha: 0.9, color: "10,10,18", comp: "source-over" },
          { width: 3,   alpha: 1,   color: "255,170,0", comp: "source-over" },
        ];
        heatCasing = { width: 6, alpha: 0.9, color: "10,10,18" };
        heatPasses = [{ width: 3, alpha: 1, comp: "source-over" }];
      }

      const proj = this._projectAll();
      // Viewport culling (per-track bbox vs the padded canvas) plus
      // sub-pixel decimation: consecutive projected points that land on
      // the same pixel add raster cost without adding pixels. Chained
      // from the last emitted point, so a zoomed-out 500-point trip
      // collapses to a handful of segments; zoomed in, offscreen trips
      // skip entirely. Both matter on software-rasterized canvases where
      // stroke cost lands on the main thread.
      const vMinX = ox - 30, vMinY = oy - 30, vMaxX = ox + w + 30, vMaxY = oy + h + 30;
      const offscreen = (tr) => tr.maxX < vMinX || tr.minX > vMaxX || tr.maxY < vMinY || tr.minY > vMaxY;
      const MIN_PX = 1.3;
      function drawTrack(t) {
        const tr = proj[t];
        if (!tr || tr.n < 2 || offscreen(tr)) return;
        const { xs, ys, n } = tr;
        ctx.beginPath();
        ctx.moveTo(xs[0] - ox, ys[0] - oy);
        let lx = xs[0], ly = ys[0];
        for (let i = 1; i < n; i++) {
          const dx = xs[i] - lx, dy = ys[i] - ly;
          if (i < n - 1 && dx < MIN_PX && dx > -MIN_PX && dy < MIN_PX && dy > -MIN_PX) continue;
          ctx.lineTo(xs[i] - ox, ys[i] - oy);
          lx = xs[i]; ly = ys[i];
        }
        ctx.stroke();
      }

      // All-tracks heat: nothing selected, every visible track coloured by
      // the metric on a shared scale. Segments are clustered into colour
      // buckets and stroked as batched Path2Ds — ~32 strokes per pass
      // instead of one per segment (~140k for a 300-trip library).
      if (this._paintData && this._paintData.all) {
        const pd = this._paintData;
        if (pd.segStyle) {
          // Per-segment styled draw (Mix) across every visible track. No
          // bucket batching — each segment sets its own colour/width/dash.
          ctx.lineJoin = "round";
          ctx.lineCap = "round";
          ctx.globalCompositeOperation = "source-over";
          for (let t = 0; t < this._latLngs.length; t++) {
            if (vis && !vis.has(t)) continue;
            const tr = proj[t];
            if (!tr || tr.n < 2 || offscreen(tr)) continue;
            const pts = pd.tracks[t].points;
            const { xs, ys, n } = tr;
            let lx = xs[0], ly = ys[0];
            for (let i = 1; i < n; i++) {
              const dx = xs[i] - lx, dy = ys[i] - ly;
              if (i < n - 1 && dx < MIN_PX && dx > -MIN_PX && dy < MIN_PX && dy > -MIN_PX) continue;
              const st = pd.segStyle(pts[i][pd.pointIdx]);
              if (!st) { lx = xs[i]; ly = ys[i]; continue; }
              ctx.setLineDash(st.dash || []);
              ctx.lineWidth = st.width;
              ctx.strokeStyle = `rgba(${st.color},${st.alpha})`;
              ctx.beginPath();
              ctx.moveTo(lx - ox, ly - oy);
              ctx.lineTo(xs[i] - ox, ys[i] - oy);
              ctx.stroke();
              lx = xs[i]; ly = ys[i];
            }
          }
          ctx.setLineDash([]);
          this._perf("draw(all-seg)", __t0);
          return;
        }
        const BUCKETS = 32;
        const buckets = new Array(BUCKETS).fill(null);
        // Threshold modes (moving / still) leave gaps where the mask is null,
        // so a whole-path casing under them would fill those gaps — skip it.
        const casingPath = (heatCasing && !pd.mask) ? new Path2D() : null;
        const flatTracks = [];
        for (let t = 0; t < this._latLngs.length; t++) {
          if (vis && !vis.has(t)) continue;
          const tr = proj[t];
          if (!tr || tr.n < 2 || offscreen(tr)) continue;
          // Metric values are read straight out of the track's points
          // (no per-track value clones); absent-metric trips fall back
          // to the flat base style.
          const pts = pd.mode === "progress" ? null : pd.tracks[t].points;
          if (pd.mode !== "progress" && pd.absent && pd.absent[t]) { flatTracks.push(t); continue; }
          const { xs, ys, n } = tr;
          if (casingPath) {
            casingPath.moveTo(xs[0] - ox, ys[0] - oy);
            let cx = xs[0], cy = ys[0];
            for (let i = 1; i < n; i++) {
              const dx = xs[i] - cx, dy = ys[i] - cy;
              if (i < n - 1 && dx < MIN_PX && dx > -MIN_PX && dy < MIN_PX && dy > -MIN_PX) continue;
              casingPath.lineTo(xs[i] - ox, ys[i] - oy);
              cx = xs[i]; cy = ys[i];
            }
          }
          let lx = xs[0], ly = ys[0];
          // Mask modes: carry the strongest qualifying value across a decimated
          // run so a stop that collapses under MIN_PX still paints (judged by
          // its best point, not just the segment's far endpoint).
          let bestT = null;
          for (let i = 1; i < n; i++) {
            if (pd.mask) {
              const m = pd.mask(pts[i][pd.pointIdx]);
              if (m !== null && (bestT === null || m > bestT)) bestT = m;
            }
            const dx = xs[i] - lx, dy = ys[i] - ly;
            if (i < n - 1 && dx < MIN_PX && dx > -MIN_PX && dy < MIN_PX && dy > -MIN_PX) continue;
            let t01;
            if (pd.mode === "progress") {
              t01 = i / (n - 1);
            } else if (pd.mask) {
              t01 = bestT; bestT = null;
              if (t01 === null) { lx = xs[i]; ly = ys[i]; continue; } // no qualifying point in run
            } else {
              const v = pts[i][pd.pointIdx];
              t01 = typeof v === "number" ? (v - pd.min) / pd.span : 0;
            }
            let b = Math.floor(t01 * BUCKETS);
            if (b < 0) b = 0; else if (b >= BUCKETS) b = BUCKETS - 1;
            let path = buckets[b];
            if (!path) path = buckets[b] = new Path2D();
            path.moveTo(lx - ox, ly - oy);
            path.lineTo(xs[i] - ox, ys[i] - oy);
            lx = xs[i]; ly = ys[i];
          }
        }
        ctx.lineJoin = "round";
        ctx.lineCap = "round";
        if (casingPath) {
          ctx.strokeStyle = `rgba(${heatCasing.color},${heatCasing.alpha})`;
          ctx.lineWidth = heatCasing.width - 1.5;
          ctx.globalCompositeOperation = "source-over";
          ctx.stroke(casingPath);
        }
        // Slimmer pass sets than the selected-track ones so hundreds of
        // overlapping trips stay readable in every style.
        const allPasses = styleMode === "neon"
          ? [{ width: 7, alpha: 0.08, comp: "lighter" }, { width: 2.5, alpha: 0.75, comp: "source-over" }]
          : styleMode === "normal"
            ? [{ width: 2.5, alpha: 0.9, comp: "source-over" }]
            : [{ width: 2, alpha: 0.95, comp: "source-over" }];
        const colorFn = pd.colorFn || heatColor;
        for (const pass of allPasses) {
          ctx.lineWidth = pass.width + (pd.widthBoost || 0);
          ctx.globalCompositeOperation = pass.comp;
          for (let b = 0; b < BUCKETS; b++) {
            if (!buckets[b]) continue;
            ctx.strokeStyle = `rgba(${colorFn((b + 0.5) / BUCKETS)},${pass.alpha})`;
            ctx.stroke(buckets[b]);
          }
        }
        // Trips without the metric keep the flat base look underneath.
        for (const pass of basePasses) {
          ctx.strokeStyle = `rgba(${pass.color},${pass.alpha})`;
          ctx.lineWidth = pass.width;
          ctx.globalCompositeOperation = pass.comp;
          for (const t of flatTracks) drawTrack(t);
        }
        this._perf("draw(all)", __t0);
        return;
      }

      // Draw non-selected visible tracks
      for (const pass of basePasses) {
        ctx.strokeStyle = `rgba(${pass.color},${pass.alpha})`;
        ctx.lineWidth = pass.width;
        ctx.lineJoin = "round";
        ctx.lineCap = "round";
        ctx.globalCompositeOperation = pass.comp;
        for (let t = 0; t < this._latLngs.length; t++) {
          if (t === sel) continue;
          if (vis && !vis.has(t)) continue;
          drawTrack(t);
        }
      }

      // Draw selected track on top
      if (sel >= 0 && sel < this._latLngs.length) {
        const tr = proj[sel];
        if (tr && tr.n >= 2) {
          if (this._paintData && this._paintData.trackIdx === sel) {
            const pd = this._paintData;
            const { xs, ys, n } = tr;
            if (pd.segStyle) {
              // Per-segment styled draw (Mix): colour, alpha, width and dash
              // vary by speed band; null segments are skipped (transparent).
              ctx.lineJoin = "round";
              ctx.lineCap = "round";
              ctx.globalCompositeOperation = "source-over";
              let lx = xs[0], ly = ys[0];
              for (let i = 1; i < n; i++) {
                const dx = xs[i] - lx, dy = ys[i] - ly;
                if (i < n - 1 && dx < MIN_PX && dx > -MIN_PX && dy < MIN_PX && dy > -MIN_PX) continue;
                const st = pd.segStyle(pd.values[i]);
                if (!st) { lx = xs[i]; ly = ys[i]; continue; }
                ctx.setLineDash(st.dash || []);
                ctx.lineWidth = st.width;
                ctx.strokeStyle = `rgba(${st.color},${st.alpha})`;
                ctx.beginPath();
                ctx.moveTo(lx - ox, ly - oy);
                ctx.lineTo(xs[i] - ox, ys[i] - oy);
                ctx.stroke();
                lx = xs[i]; ly = ys[i];
              }
              ctx.setLineDash([]);
            } else {
            if (heatCasing && !pd.mask) {
              // Whole path once in the dark casing, colors on top. Threshold
              // modes skip it so their transparent gaps stay open.
              ctx.strokeStyle = `rgba(${heatCasing.color},${heatCasing.alpha})`;
              ctx.lineWidth = heatCasing.width;
              ctx.lineJoin = "round";
              ctx.lineCap = "round";
              ctx.globalCompositeOperation = "source-over";
              ctx.beginPath();
              ctx.moveTo(xs[0] - ox, ys[0] - oy);
              for (let i = 1; i < n; i++) ctx.lineTo(xs[i] - ox, ys[i] - oy);
              ctx.stroke();
            }
            for (const pass of heatPasses) {
              ctx.lineWidth = pass.width + (pd.widthBoost || 0);
              ctx.lineJoin = "round";
              ctx.lineCap = "round";
              ctx.globalCompositeOperation = pass.comp;
              let lx = xs[0], ly = ys[0];
              let bestT = null; // strongest qualifying mask value across a decimated run
              for (let i = 1; i < n; i++) {
                if (pd.mask) {
                  const m = pd.mask(pd.values[i]);
                  if (m !== null && (bestT === null || m > bestT)) bestT = m;
                }
                const dx = xs[i] - lx, dy = ys[i] - ly;
                if (i < n - 1 && dx < MIN_PX && dx > -MIN_PX && dy < MIN_PX && dy > -MIN_PX) continue;
                let color;
                if (pd.mask) {
                  const t01 = bestT; bestT = null;
                  if (t01 === null) { lx = xs[i]; ly = ys[i]; continue; } // no qualifying point in run
                  color = pd.colorFn(t01);
                } else {
                  const t = pd.span ? (pd.values[i] - pd.min) / pd.span : 0.5;
                  color = (pd.colorFn || heatColor)(t);
                }
                ctx.strokeStyle = `rgba(${color},${pass.alpha})`;
                ctx.beginPath();
                ctx.moveTo(lx - ox, ly - oy);
                ctx.lineTo(xs[i] - ox, ys[i] - oy);
                ctx.stroke();
                lx = xs[i]; ly = ys[i];
              }
            }
            }
          } else {
            for (const pass of selectedPasses) {
              ctx.strokeStyle = `rgba(${pass.color},${pass.alpha})`;
              ctx.lineWidth = pass.width;
              ctx.lineJoin = "round";
              ctx.lineCap = "round";
              ctx.globalCompositeOperation = pass.comp;
              drawTrack(sel);
            }
          }
        }
      }
      this._perf("draw(base+sel)", __t0);
    },
  });

  glowLayer = new GlowLayer();
  glowLayer.addTo(map);

  // Greys out trace-colour options with no data behind them, and labels the
  // wheel-speed option "Wheel speed" when GPS speed is also there. With a
  // trip selected only that trip counts; with nothing selected any trip in
  // the library counts, since the colour then paints every visible track.
  // Library-wide metric availability, cached per allTracks identity — the
  // unselected state needs it on every updateGlow, and rescanning ~140k
  // points for each absent metric was part of the per-click hang.
  let libAvailCache = { for: null, byIdx: null };
  function libraryHasMetric(idx) {
    if (libAvailCache.for !== allTracks) {
      libAvailCache = { for: allTracks, byIdx: {} };
    }
    const byIdx = libAvailCache.byIdx;
    if (byIdx[idx] === undefined) {
      byIdx[idx] = false;
      outer: for (const tr of allTracks) {
        if (!tr || !tr.points) continue;
        for (const p of tr.points) {
          const v = p[idx];
          if (typeof v === "number" && v !== 0) { byIdx[idx] = true; break outer; }
        }
      }
    }
    return byIdx[idx];
  }

  function updateTraceColorOptions() {
    const sel = document.getElementById("trace-color-select");
    if (!sel) return;
    const track = selectedIdx >= 0 ? allTracks[selectedIdx] : null;
    const hasMetric = (idx) => {
      if (!track) return libraryHasMetric(idx);
      if (!track.points) return false;
      for (const p of track.points) {
        const v = p[idx];
        if (typeof v === "number" && v !== 0) return true;
      }
      return false;
    };
    for (const opt of sel.options) {
      const key = opt.value;
      if (key === "solid") { opt.disabled = false; continue; }
      // Torque / phase stay selectable even when the loaded trips lack them
      // (absent trips just fall back to the base style), so the choice sticks.
      if (key === "torque" || key === "phase") { opt.disabled = false; continue; }
      let hasData = false;
      if (key === "distance") {
        hasData = (track ? [track] : allTracks).some((tr) => tr && tr.points && tr.points.length);
      } else if (key === "moving" || key === "still" || key === "mix") {
        hasData = hasMetric(2); // all keyed off wheel speed
      } else {
        const m = PAINT_METRICS[key];
        if (m) hasData = hasMetric(m.pointIdx);
      }
      opt.disabled = !hasData;
    }
    const speedOpt = sel.querySelector('option[value="speed"]');
    if (speedOpt) speedOpt.textContent = hasMetric(10) ? "Wheel speed" : "Speed";
    // Only drop the preference when a *selected* trip genuinely lacks the
    // metric. With nothing selected every option reads disabled, and
    // resetting then would wipe the wheel-speed default before the
    // auto-select even runs.
    const active = sel.querySelector(`option[value="${traceColor}"]`);
    if (track && traceColor !== "solid" && active && active.disabled) {
      traceColor = "solid";
      sel.value = "solid";
    }
  }

  // latLng objects for the glow layer, cached per library. Rebuilding
  // 140k L.LatLng allocations on every interaction was a visible chunk
  // of the old per-click hang.
  let glowLatLngs = null, glowLatLngsFor = null;
  function trackLatLngs() {
    if (glowLatLngsFor !== allTracks) {
      glowLatLngs = allTracks.map((t) => t.points.map((p) => L.latLng(p[0], p[1])));
      glowLatLngsFor = allTracks;
    }
    return glowLatLngs;
  }

  function updateGlow() {
    const __t0 = performance.now();
    updateTraceColorOptions();
    glowLayer._perf("options", __t0);
    // One batched write + one draw. The paint object is computed first;
    // legend updates ride along with each branch.
    const push = (paint) => {
      const __t1 = performance.now();
      glowLayer.update({
        latLngs: trackLatLngs(), selected: selectedIdx, visible: trackVisible, paint,
      });
      glowLayer._perf("push+draw", __t1);
      glowLayer._perf("updateGlow total", __t0);
    };

    // Movement modes (speed-driven). Moving / Still mask a red ramp; Mix draws
    // a per-segment styled trip-structure view. All paint the selected track,
    // or every track when none is selected.
    if (traceColor === "moving" || traceColor === "still" || traceColor === "mix") {
      const selTrack = selectedIdx >= 0 ? allTracks[selectedIdx] : null;
      const values = (selTrack && selTrack.points.length >= 2) ? selTrack.points.map((p) => p[2]) : null;
      if (traceColor === "mix") {
        const segStyle = makeMixSegStyle();
        if (values) push({ trackIdx: selectedIdx, values, segStyle });
        else if (allTracks.length) push({ all: true, tracks: allTracks, pointIdx: 2, segStyle });
        else push(null);
        updateTraceLegend("mix", 0, 1, { min: "Stops", max: "Riding" });
        return;
      }
      const mask = traceColor === "moving" ? movingMask : stillMask;
      const widthBoost = traceColor === "still" ? 2.5 : 0; // stopped lines read thicker
      const colorFn = moveColorFn();
      if (values) push({ trackIdx: selectedIdx, values, mask, colorFn, widthBoost });
      else if (allTracks.length) push({ all: true, tracks: allTracks, pointIdx: 2, mask, colorFn, widthBoost });
      else { push(null); }
      updateTraceLegend(traceColor, 0, 1,
        traceColor === "moving" ? { min: "Slow", max: "Fast" } : { min: "Slow", max: "Still" });
      return;
    }

    // Trace color paints the selected track — or, with nothing selected,
    // every visible track on a shared global scale so trips compare.
    const metric = traceColor !== "solid" ? PAINT_METRICS[traceColor] : null;
    const track = selectedIdx >= 0 ? allTracks[selectedIdx] : null;
    if (metric && !track && allTracks.length) {
      if (metric.pointIdx === -1) {
        // Distance with no selection: colour each trip by its own progress
        // (start → end). A shared km number is meaningless across trips, so
        // the legend shows the ramp direction (Start → End) instead.
        push({ all: true, mode: "progress", colorFn: distanceColor });
        updateTraceLegend("distance", 0, 1, { min: "Start", max: "End" });
        return;
      }
      // The draw reads values straight from track points (pd.tracks +
      // pd.pointIdx); here we only need the range and an absent-flag per
      // trip. A Dropbox-loaded library holds full-resolution tracks
      // (~1.4M points total), so the scan result is cached per
      // (metric, library, visible-set) — selection toggles and repeat
      // draws reuse it, and only checkbox changes rescan.
      let sig = traceColor + "|" + (trackVisible ? trackVisible.size : -1);
      if (trackVisible) {
        let h = 0;
        for (const i of trackVisible) h = (h + (i + 1) * 2654435761) | 0;
        sig += "|" + h;
      }
      let sc = updateGlow._scaleCache;
      if (!sc || sc.tracks !== allTracks || sc.sig !== sig) {
        const absent = new Array(allTracks.length).fill(false);
        const pool = [];
        const stride = 7; // percentile sampling; extremes tracked exactly
        let trueMin = Infinity, trueMax = -Infinity, seen = 0;
        for (let t = 0; t < allTracks.length; t++) {
          if (trackVisible && !trackVisible.has(t)) continue;
          const pts = allTracks[t].points;
          if (!pts || pts.length < 2) continue;
          let has = false;
          for (let i = 0; i < pts.length; i++) {
            const v = pts[i][metric.pointIdx];
            if (!v) continue; // 0 / undefined / NaN → no sample
            has = true;
            if (v < trueMin) trueMin = v;
            if (v > trueMax) trueMax = v;
            if (seen++ % stride === 0) pool.push(v);
          }
          // All-zero column = metric absent on this trip (legacy cache);
          // it renders in the flat base style instead of pretending
          // everything happened at value zero.
          absent[t] = !has;
        }
        let valid = pool.length >= 2 && isFinite(trueMin) && trueMin !== trueMax;
        let min = 0, max = 0;
        if (valid) {
          // The raw min/max over huge sample counts is an extreme-order
          // statistic: one glitch row in one stale cached trip (parsed
          // before the despike existed) stretches the whole ramp. Trust
          // the true extremes when they sit near the bulk of the data;
          // clamp them to the sampled 0.01% percentiles only when they're
          // glitch-far outside it, so a real 67.6 km/h record still tops
          // the legend.
          pool.sort((a, b) => a - b);
          const n = pool.length;
          const pLo = pool[Math.floor(n * 0.0001)];
          const pHi = pool[Math.min(n - 1, Math.floor(n * 0.9999))];
          const guard = Math.max((pHi - pLo) * 0.5, 1e-9);
          min = trueMin >= pLo - guard ? trueMin : pLo;
          max = trueMax <= pHi + guard ? trueMax : pHi;
          valid = min !== max;
        }
        sc = updateGlow._scaleCache = { tracks: allTracks, sig, absent, min, max, valid };
      }
      if (!sc.valid) {
        push(null);
        updateTraceLegend(null);
        return;
      }
      push({ all: true, tracks: allTracks, pointIdx: metric.pointIdx, absent: sc.absent, min: sc.min, max: sc.max, span: sc.max - sc.min, colorFn: metricColorFn(traceColor) });
      updateTraceLegend(traceColor, sc.min, sc.max);
      return;
    }
    if (metric && track && track.points.length >= 2) {
      const pts = track.points;
      let values, min, max, colorFn, legMin, legMax;
      if (metric.pointIdx === -1) {
        // Distance: colour by progress along the route; legend shows km.
        values = pts.map((_, idx) => idx);
        min = 0; max = pts.length - 1;
        colorFn = distanceColor;
        const cum = getCumDistPts(track);
        legMin = 0; legMax = cum[cum.length - 1] || 0;
      } else {
        values = pts.map((p) => p[metric.pointIdx]);
        min = Infinity; max = -Infinity;
        for (const v of values) {
          if (typeof v !== "number") continue;
          if (v < min) min = v;
          if (v > max) max = v;
        }
        colorFn = metricColorFn(traceColor);
        legMin = min; legMax = max;
      }
      if (!isFinite(min) || !isFinite(max) || min === max) {
        // Metric absent for this trip (legacy track or an empty column).
        push(null);
        updateTraceLegend(null);
        return;
      }
      push({ trackIdx: selectedIdx, values, min, max, span: max - min, colorFn });
      updateTraceLegend(traceColor, legMin, legMax);
    } else {
      push(null);
      updateTraceLegend(null);
    }
  }

  // --- Map controls overlay: map style + trace colour ---
  const mapControlsEl = document.getElementById("map-controls");

  function setBaseStyle(name) {
    const style = BASE_STYLES[name];
    if (!style) return;
    const current = BASE_STYLES[selectedStyle];
    if (style.layer !== current.layer) {
      map.removeLayer(current.layer);
      map.addLayer(style.layer);
    }
    selectedStyle = name;
    try { localStorage.setItem(MAP_LAYER_KEY, name); } catch (_) {}
    // Changing basemap returns the trace style to that map's automatic
    // pairing (a manual pick applies until the next basemap switch).
    traceStyleUser = null;
    try { localStorage.removeItem(TRACE_STYLE_KEY); } catch (_) {}
    syncTraceStyleSelect();
    // Track colours + style depend on the basemap — repaint.
    if (glowLayer) glowLayer.redraw();
  }

  // Legend label per metric — the value gets converted via UNITS for the
  // distance / speed / temp / altitude rows so the units match the rest of UI.
  const TRACE_UNIT_KIND = { speed: "speed", gpsspeed: "speed", temp: "temp", altitude: "alt", distance: "dist" };
  const TRACE_STATIC_UNIT = { pwm: "%", power: "W", current: "A", torque: "Nm", phase: "A", battery: "%", voltage: "V" };
  const legendEl = document.getElementById("color-legend");
  function legendGradientCss(key) {
    // Movement modes colour by speed, so they show the speed palette; metrics
    // show their own (palette-adjusted) ramp.
    const stops = key === "mix"
      ? stopsFor("speed").slice().reverse() // Mix: stops on the hot end (see makeMixSegStyle)
      : (key === "moving" || key === "still")
        ? stopsFor("speed")
        : (RAMP_STOPS[key] ? stopsFor(key) : null);
    if (!stops) return "linear-gradient(90deg, rgb(0,229,255), rgb(255,43,43))";
    const parts = stops.map((s, i) => `rgb(${s[0]},${s[1]},${s[2]}) ${Math.round((i / (stops.length - 1)) * 100)}%`);
    return "linear-gradient(90deg, " + parts.join(", ") + ")";
  }
  // labels (optional) overrides the numeric min/max readout with plain text,
  // for ramps where a number is meaningless (distance across many trips is
  // per-trip progress, so it shows "Start" → "End").
  function updateTraceLegend(key, min, max, labels) {
    if (!legendEl) return;
    if (!key || key === "solid") { legendEl.classList.add("hidden"); return; }
    // Set backgroundImage, not the `background` shorthand — the shorthand
    // resets background-repeat to `repeat`, which re-introduces the red fleck
    // the .legend-bar CSS (background-repeat: no-repeat) exists to prevent.
    legendEl.querySelector(".legend-bar").style.backgroundImage = legendGradientCss(key);
    const kind = TRACE_UNIT_KIND[key];
    const unit = kind ? unitForKind(kind) : (TRACE_STATIC_UNIT[key] || "");
    const conv = (v) => kind ? convertByKind(kind, v) : v;
    const fmt = (v) => {
      const c = conv(v);
      return (Math.abs(c) >= 100 ? c.toFixed(0) : c.toFixed(1)) + " " + unit;
    };
    legendEl.querySelector("[data-legend-min]").textContent = labels ? labels.min : fmt(min);
    legendEl.querySelector("[data-legend-max]").textContent = labels ? labels.max : fmt(max);
    legendEl.classList.remove("hidden");
  }

  const styleSelEl = document.getElementById("map-style-select");
  const colorSelEl = document.getElementById("trace-color-select");
  const traceStyleSelEl = document.getElementById("trace-style-select");
  const mapControlsToggle = document.getElementById("map-controls-toggle");
  function syncTraceStyleSelect() {
    if (traceStyleSelEl) traceStyleSelEl.value = effectiveTraceStyle();
  }
  if (styleSelEl) {
    styleSelEl.value = selectedStyle;
    styleSelEl.addEventListener("change", (e) => setBaseStyle(e.target.value));
  }
  if (colorSelEl) {
    colorSelEl.value = traceColor;
    colorSelEl.addEventListener("change", (e) => { traceColor = e.target.value; updateGlow(); });
  }
  const paletteSelEl = document.getElementById("palette-select");
  if (paletteSelEl) {
    paletteSelEl.value = paletteMode;
    paletteSelEl.addEventListener("change", (e) => {
      paletteMode = e.target.value;
      try { localStorage.setItem(PALETTE_KEY, paletteMode); } catch (_) {}
      updateGlow();
    });
  }
  if (traceStyleSelEl) {
    syncTraceStyleSelect();
    traceStyleSelEl.addEventListener("change", (e) => {
      traceStyleUser = e.target.value;
      try { localStorage.setItem(TRACE_STYLE_KEY, traceStyleUser); } catch (_) {}
      if (glowLayer) glowLayer.redraw();
    });
  }
  if (mapControlsToggle) mapControlsToggle.addEventListener("click", () => mapControlsEl.classList.toggle("collapsed"));

  // --- Hover tooltip for selected track ---
  const tooltip = document.createElement("div");
  tooltip.id = "track-tooltip";
  tooltip.className = "hidden";
  document.body.appendChild(tooltip);

  map.getContainer().addEventListener("mousemove", (e) => {
    if (selectedIdx < 0 || !allTracks[selectedIdx]) {
      tooltip.classList.add("hidden");
      syncChartCrosshair(-1, null);
      return;
    }

    const rect = map.getContainer().getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    const pts = allTracks[selectedIdx].points;
    let bestDist = Infinity;
    let bestPt = null;
    let bestIdx = -1;

    const step = pts.length > 2000 ? Math.floor(pts.length / 1000) : 1;
    for (let i = 0; i < pts.length; i += step) {
      const cp = map.latLngToContainerPoint([pts[i][0], pts[i][1]]);
      const dx = cp.x - mx;
      const dy = cp.y - my;
      const d = dx * dx + dy * dy;
      if (d < bestDist) { bestDist = d; bestPt = pts[i]; bestIdx = i; }
    }

    if (step > 1 && bestIdx >= 0) {
      const lo = Math.max(0, bestIdx - step);
      const hi = Math.min(pts.length - 1, bestIdx + step);
      for (let i = lo; i <= hi; i++) {
        const cp = map.latLngToContainerPoint([pts[i][0], pts[i][1]]);
        const dx = cp.x - mx;
        const dy = cp.y - my;
        const d = dx * dx + dy * dy;
        if (d < bestDist) { bestDist = d; bestPt = pts[i]; bestIdx = i; }
      }
    }

    const distPx = Math.sqrt(bestDist);
    if (distPx > 30 || !bestPt) {
      tooltip.classList.add("hidden");
      syncChartCrosshair(-1, null);
      return;
    }

    const speed = bestPt[2];
    const alt = bestPt[3] || 0;
    const volt = bestPt[4] || 0;
    const temp = bestPt[5] || 0;
    const batt = bestPt[6] || 0;
    const pwm = bestPt[7] || 0;
    const current = bestPt[8] || 0;
    const power = bestPt[9] || 0;
    const gpsSpeed = bestPt[10] || 0;
    const cumKm = getCumDistPts(allTracks[selectedIdx])[bestIdx] || 0;

    // When GPS speed is present, the wheel value is "Wheel speed" / GPS is
    // "GPS speed" — same wording the inspector and detail rows use.
    const speedLabel = gpsSpeed ? "Wheel speed" : "Speed";
    let html = `<i class="clr" style="background:#66bb6a"></i>Dist: <b>${UNITS.dist(cumKm).toFixed(2)}</b> ${UNITS.distUnit}`;
    html += `<br><i class="clr" style="background:#00e5ff"></i>${speedLabel}: <b>${UNITS.speed(speed).toFixed(1)}</b> ${UNITS.speedUnit}`;
    if (gpsSpeed) html += `<br><i class="clr" style="background:${GPS_SPEED_COLOR}"></i>GPS speed: <b>${UNITS.speed(gpsSpeed).toFixed(1)}</b> ${UNITS.speedUnit}`;
    if (pwm)     html += `<br><i class="clr" style="background:#ff4081"></i>PWM: <b>${pwm.toFixed(1)}</b> %`;
    if (power)   html += `<br><i class="clr" style="background:#7c4dff"></i>Power: <b>${power.toFixed(0)}</b> W`;
    if (current) html += `<br><i class="clr" style="background:#ffd740"></i>Current: <b>${current.toFixed(1)}</b> A`;
    if (volt) html += `<br><i class="clr" style="background:#ff5252"></i>Voltage: <b>${volt.toFixed(1)}</b> V`;
    if (temp) html += `<br><i class="clr" style="background:#ffa000"></i>Temp: <b>${UNITS.temp(temp).toFixed(0)}</b> ${UNITS.tempUnit}`;
    if (batt) html += `<br><i class="clr" style="background:#69f0ae"></i>Battery: <b>${batt.toFixed(0)}</b>%`;
    if (alt)  html += `<br><i class="clr" style="background:#ce93d8"></i>Alt: <b>${UNITS.alt(alt).toFixed(0)}</b> ${UNITS.altUnit}`;

    tooltip.innerHTML = html;
    tooltip.classList.remove("hidden");
    // Clamp inside the viewport — at the right/bottom edge the tooltip would
    // otherwise be clipped off-screen.
    {
      const w = tooltip.offsetWidth, h = tooltip.offsetHeight;
      const W = window.innerWidth, H = window.innerHeight, m = 6;
      let left = e.clientX + 14;
      let top  = e.clientY - 10;
      if (left + w + m > W) left = e.clientX - w - 14;
      if (top  + h + m > H) top  = H - h - m;
      if (left < m) left = m;
      if (top  < m) top  = m;
      tooltip.style.left = left + "px";
      tooltip.style.top  = top + "px";
    }

    syncChartCrosshair(selectedIdx, bestPt);
  });

  map.getContainer().addEventListener("mouseleave", () => {
    tooltip.classList.add("hidden");
    syncChartCrosshair(-1, null);
  });

  // --- Map click: list overlapping tracks ---
  map.on("click", function (e) {
    const mx = e.containerPoint.x;
    const my = e.containerPoint.y;
    const threshold = 20;
    const nearTracks = [];

    for (let t = 0; t < allTracks.length; t++) {
      if (!trackVisible.has(t)) continue;
      const pts = allTracks[t].points;
      const sampleStep = Math.max(1, Math.floor(pts.length / 300));
      for (let i = 0; i < pts.length; i += sampleStep) {
        const cp = map.latLngToContainerPoint([pts[i][0], pts[i][1]]);
        if (Math.abs(cp.x - mx) < threshold && Math.abs(cp.y - my) < threshold) {
          nearTracks.push(t);
          break;
        }
      }
    }

    if (nearTracks.length === 0) return;
    if (nearTracks.length === 1) {
      selectTrip(nearTracks[0]);
      return;
    }

    let popupHtml = '<div class="track-popup">';
    for (const t of nearTracks) {
      const tr = allTracks[t];
      const label = tr.date || tr.name;
      popupHtml += `<div class="track-popup-item" data-tidx="${t}">${label} <span>${tr.stats.distanceKm} km</span></div>`;
    }
    popupHtml += "</div>";

    let previewLine = null;
    function clearPreview() {
      if (previewLine) { map.removeLayer(previewLine); previewLine = null; }
    }

    const popup = L.popup({ closeButton: true, className: "track-list-popup" })
      .setLatLng(e.latlng)
      .setContent(popupHtml)
      .openOn(map);

    map.once("popupclose", clearPreview);

    setTimeout(() => {
      const el = popup.getElement();
      if (!el) return;
      el.querySelectorAll(".track-popup-item").forEach(item => {
        item.addEventListener("mouseenter", () => {
          clearPreview();
          const tidx = parseInt(item.dataset.tidx);
          const pts = allTracks[tidx].points;
          if (pts.length < 2) return;
          const latlngs = pts.map(p => [p[0], p[1]]);
          previewLine = L.polyline(latlngs, {
            color: "#fff", weight: 3, opacity: 0.6,
            dashArray: "8, 8", interactive: false,
          }).addTo(map);
        });
        item.addEventListener("mouseleave", clearPreview);
        item.addEventListener("click", () => {
          clearPreview();
          map.closePopup();
          selectTrip(parseInt(item.dataset.tidx));
        });
      });
    }, 50);
  });

  // --- UI elements ---
  const overlay = document.getElementById("upload-overlay");
  const uploadBox = document.getElementById("upload-box");
  const fileInput = document.getElementById("file-input");
  const uploadLabel = document.getElementById("upload-label");
  const uploadActions = document.getElementById("upload-actions");
  const progressArea = document.getElementById("progress-area");
  const progressFill = document.getElementById("progress-fill");
  const progressText = document.getElementById("progress-text");
  const panel = document.getElementById("trip-panel");
  const panelTab = document.getElementById("panel-tab");
  const panelTabText = document.getElementById("panel-tab-text");
  const tripList = document.getElementById("trip-list");
  const tripDetail = document.getElementById("trip-detail");
  const parserWorker = createParserWorker();
  const RECENT_DB_NAME = "eucplanet-trip-viewer";
  const RECENT_STORE_NAME = "recentFiles";
  const SESSION_STORE_NAME = "currentSession";
  const WEATHER_STORE_NAME = "weatherCache";
  const SESSION_KEY = "tracks";
  const MAX_RECENT_FILES = 5;
  let recentDbPromise = null;
  const recentUi = createRecentFilesUi();

  // Stash a filename → dropbox path map. Set by the Dropbox source right
  // before it calls handleFile so we can re-attach a sharable origin to
  // each track once the parser hands them back. Cleared as soon as it's
  // been consumed so a regular drag-and-drop afterwards doesn't inherit it.
  let pendingDropboxMap = null;
  // Same idea for the source tag — "dropbox" so the Recents row can show
  // the little badge instead of the literal filename giving it away.
  let pendingSource = null;

  // --- Upload with client-side parsing ---
  async function handleFile(file, appendOrOpts) {
    // Back-compat: callers used to pass a plain boolean for append. Now they
    // can pass an options object {append, progressStart} so a wrapping
    // loader (URL fetch) can map parse to a sub-range like 50–100 % and
    // keep one continuous progress bar.
    const opts = (typeof appendOrOpts === "object" && appendOrOpts) ? appendOrOpts : {};
    const append = typeof appendOrOpts === "boolean" ? appendOrOpts : !!opts.append;
    const progressStart = Math.max(0, Math.min(99, Number(opts.progressStart) || 0));
    const progressScale = (100 - progressStart) / 100;
    const lname = file.name.toLowerCase();
    if (!lname.endsWith(".dbb") && !lname.endsWith(".zip") && !lname.endsWith(".csv") && !lname.endsWith(".gpx") && !lname.endsWith(".xlsx")) return;

    const addBtn = append ? document.querySelector("#panel-footer .add-more-btn") : null;
    const setProgress = (text, error) => {
      if (append && addBtn) {
        addBtn.textContent = text;
        addBtn.style.color = error ? "#ffa000" : "";
      } else {
        progressText.textContent = text;
        if (error) progressText.classList.add("error");
      }
    };
    // While the post-parse IDB write churns, swap the determinate progress bar
    // for a shimmering "almost ready" marquee so it doesn't feel like a hang.
    const setProgressMarquee = (text) => {
      if (append && addBtn) { addBtn.textContent = text; return; }
      progressText.textContent = text;
      progressFill.classList.add("marquee");
      progressFill.style.width = "100%";
    };
    const clearProgressMarquee = () => {
      if (append) return;
      progressFill.classList.remove("marquee");
      progressArea.classList.add("hidden");
    };

    if (!append) {
      if (uploadActions) uploadActions.classList.add("hidden");
      uploadLabel.classList.add("hidden");
      const hint = document.getElementById("upload-hint");
      if (hint) hint.classList.add("hidden");
      if (recentUi && recentUi.section) recentUi.section.classList.add("hidden");
      progressArea.classList.remove("hidden");
      // Only zero the bar when there's no upstream pre-fetch already
      // showing partial progress; otherwise resume from progressStart.
      progressFill.style.width = progressStart + "%";
    }
    setProgress("Loading...");

    try {
      const parsedTracks = await parseFileLocally(parserWorker, file, (msg) => {
        if (msg.type === "progress") {
          const pct = Math.round((msg.current / msg.total) * 100);
          const display = Math.round(progressStart + pct * progressScale);
          if (!append) progressFill.style.width = display + "%";
          setProgress(`Parsing trip ${msg.current} of ${msg.total}`);
        }
      });

      if (!parsedTracks.length) {
        setProgress(
          lname.endsWith(".zip") || lname.endsWith(".dbb")
            ? "No trips inside this archive. It should contain .csv, .gpx or .xlsx trip files."
            : "No trip data found in file",
          true
        );
        if (!append) {
          if (uploadActions) uploadActions.classList.remove("hidden");
          uploadLabel.classList.remove("hidden");
          const hint = document.getElementById("upload-hint");
          if (hint) hint.classList.remove("hidden");
          if (recentUi && recentUi.section && recentUi.list.children.length) {
            recentUi.section.classList.remove("hidden");
          }
        }
        return;
      }

      // If the loader handed us a Dropbox path map, attach each track's
      // origin path so the trip list can offer a Share button later.
      if (pendingDropboxMap) {
        const m = pendingDropboxMap;
        pendingDropboxMap = null;
        for (const t of parsedTracks) {
          const direct = m[t.name];
          const fromCsv = m[t.name + ".csv"];
          const fromXlsx = m[t.name + ".xlsx"];
          const fromGpx = m[t.name + ".gpx"];
          const path = direct || fromCsv || fromXlsx || fromGpx;
          if (path) t.dropboxPath = path;
        }
      }

      // Show the trip list immediately so the post-parse IDB write doesn't
      // look like the parser hung at "trip N of N" — for 100+ trips the
      // synchronous JSON.stringify + IDB put can take several seconds.
      setProgressMarquee("Almost ready, finishing up…");
      loadTracks(append ? [...allTracks, ...parsedTracks] : parsedTracks);
      saveTracks(allTracks);
      const recentSource = pendingSource;
      pendingSource = null;
      saveRecentFile(file.name, parsedTracks, recentSource)
        .then(() => clearProgressMarquee())
        .catch((err) => {
          console.warn("Failed to save recent file:", err);
          clearProgressMarquee();
        });
    } catch (e) {
      setProgress("Error: " + e.message, true);
      if (!append) {
        if (uploadActions) uploadActions.classList.remove("hidden");
        uploadLabel.classList.remove("hidden");
        const hint = document.getElementById("upload-hint");
        if (hint) hint.classList.remove("hidden");
        if (recentUi && recentUi.section && recentUi.list.children.length) {
          recentUi.section.classList.remove("hidden");
        }
      }
    }
  }

  function createParserWorker() {
    return new Worker("static/js/parser-worker.js?v=25");
  }

  function createRecentFilesUi() {
    const section = document.createElement("section");
    section.id = "recent-files";
    section.className = "hidden";
    section.innerHTML = `
      <div class="recent-files-header">
        <span>Recent files</span>
        <button type="button" class="recent-clear hidden">Clear</button>
      </div>
      <div class="recent-files-empty">No recent parsed files yet.</div>
      <div class="recent-files-list hidden"></div>
    `;
    uploadBox.appendChild(section);

    const clearBtn = section.querySelector(".recent-clear");
    clearBtn.addEventListener("click", async () => {
      await clearRecentFiles();
      await renderRecentFiles();
      // Belt-and-braces: if a previous load left the actions row hidden,
      // make sure Upload trips + Dropbox come back. Recents going away
      // shouldn't strand the user without entry points.
      const actions = document.getElementById("upload-actions");
      if (actions) actions.classList.remove("hidden");
      uploadLabel.classList.remove("hidden");
    });

    return {
      section,
      list: section.querySelector(".recent-files-list"),
      empty: section.querySelector(".recent-files-empty"),
      clearBtn,
    };
  }

  function parseFileLocally(worker, file, onMessage) {
    return new Promise((resolve, reject) => {
      const tracks = [];

      const handleMessage = (event) => {
        const msg = event.data || {};
        if (onMessage) onMessage(msg);

        if (msg.type === "track") {
          tracks.push(msg.track);
          return;
        }

        if (msg.type === "done") {
          cleanup();
          resolve(tracks);
          return;
        }

        if (msg.type === "error") {
          cleanup();
          reject(new Error(msg.error || "Failed to parse file"));
        }
      };

      const handleError = (event) => {
        cleanup();
        reject(new Error(event.message || "Failed to parse file"));
      };

      function cleanup() {
        worker.removeEventListener("message", handleMessage);
        worker.removeEventListener("error", handleError);
      }

      worker.addEventListener("message", handleMessage);
      worker.addEventListener("error", handleError);
      worker.postMessage({ type: "parse", file, limit: currentGraphRes() });
    });
  }

  function requestToPromise(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("IndexedDB request failed"));
    });
  }

  function transactionDone(transaction) {
    return new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error || new Error("IndexedDB transaction failed"));
      transaction.onerror = () => reject(transaction.error || new Error("IndexedDB transaction failed"));
    });
  }

  function openRecentDb() {
    if (!("indexedDB" in window)) return Promise.resolve(null);
    if (!recentDbPromise) {
      recentDbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(RECENT_DB_NAME, 3);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains(RECENT_STORE_NAME)) {
            db.createObjectStore(RECENT_STORE_NAME, { keyPath: "id" });
          }
          if (!db.objectStoreNames.contains(SESSION_STORE_NAME)) {
            db.createObjectStore(SESSION_STORE_NAME);
          }
          // v3: per-location historical weather cache used by analytics.html.
          // Upgrade logic must stay in sync with openWeatherDb() in analytics.js.
          if (!db.objectStoreNames.contains(WEATHER_STORE_NAME)) {
            db.createObjectStore(WEATHER_STORE_NAME);
          }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error("Failed to open recent files database"));
        // If another tab still holds the DB at the old version, the upgrade
        // would hang silently — surface it so the user can close the other tab.
        request.onblocked = () => reject(new Error("Another tab is holding an older database version. Close other tabs to this site and reload."));
      }).catch((error) => {
        recentDbPromise = null;
        throw error;
      });
    }
    return recentDbPromise;
  }

  async function getRecentFiles() {
    const db = await openRecentDb();
    if (!db) return [];
    const tx = db.transaction(RECENT_STORE_NAME, "readonly");
    const items = await requestToPromise(tx.objectStore(RECENT_STORE_NAME).getAll());
    await transactionDone(tx);
    return items.sort((a, b) => new Date(b.loadedAt).getTime() - new Date(a.loadedAt).getTime());
  }

  async function getRecentFile(id) {
    const db = await openRecentDb();
    if (!db) return null;
    const tx = db.transaction(RECENT_STORE_NAME, "readonly");
    const item = await requestToPromise(tx.objectStore(RECENT_STORE_NAME).get(id));
    await transactionDone(tx);
    return item || null;
  }

  async function saveRecentFile(fileName, tracks, source) {
    if (!tracks || !tracks.length) return;
    const db = await openRecentDb();
    if (!db) return;

    const existing = await getRecentFiles();
    const totalKm = tracks.reduce((sum, track) => sum + (track.stats?.distanceKm || 0), 0);
    const entry = {
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      fileName,
      loadedAt: new Date().toISOString(),
      tripCount: tracks.length,
      totalKm: Number(totalKm.toFixed(1)),
      tracks,
      source: source || null,
    };

    const tx = db.transaction(RECENT_STORE_NAME, "readwrite");
    const store = tx.objectStore(RECENT_STORE_NAME);
    store.put(entry);

    // Dropbox bulk loads collapse to a single row even if previous saves
    // used the legacy "Dropbox N trips YYYY-MM-DD.dbb" name. Match by
    // source + multi-trip shape so repeated Dropbox button presses
    // overwrite the same entry instead of piling up "all_trips" rows.
    const isDropboxMulti = source === "dropbox" && tracks.length > 1;
    const isDupe = (item) => isDropboxMulti
      ? (item.source === "dropbox" && (item.tripCount || 0) > 1)
      : (item.fileName === fileName);
    const duplicates = existing.filter(isDupe);
    duplicates.forEach((item) => store.delete(item.id));

    const nextItems = [entry].concat(existing.filter((item) => !isDupe(item)));
    nextItems.sort((a, b) => new Date(b.loadedAt).getTime() - new Date(a.loadedAt).getTime());
    nextItems.slice(MAX_RECENT_FILES).forEach((item) => store.delete(item.id));

    await transactionDone(tx);
    await renderRecentFiles();
  }

  async function clearRecentFiles() {
    const db = await openRecentDb();
    if (!db) return;
    const tx = db.transaction(RECENT_STORE_NAME, "readwrite");
    tx.objectStore(RECENT_STORE_NAME).clear();
    await transactionDone(tx);
  }

  async function removeRecentFile(id) {
    const db = await openRecentDb();
    if (!db) return;
    const tx = db.transaction(RECENT_STORE_NAME, "readwrite");
    tx.objectStore(RECENT_STORE_NAME).delete(id);
    await transactionDone(tx);
    await renderRecentFiles();
  }

  async function loadRecentFile(id) {
    // Same UI choreography as a fresh upload so 200-trip libraries don't
    // look frozen: hide the entry surfaces, show the indeterminate
    // progress bar with a "Loading recent…" caption, then yield twice so
    // the paint actually lands before the synchronous loadTracks() that
    // builds hundreds of DOM nodes blocks the main thread.
    if (uploadActions) uploadActions.classList.add("hidden");
    uploadLabel.classList.add("hidden");
    const hint = document.getElementById("upload-hint");
    if (hint) hint.classList.add("hidden");
    if (recentUi && recentUi.section) recentUi.section.classList.add("hidden");
    progressArea.classList.remove("hidden");
    progressText.classList.remove("error");
    progressText.textContent = "Loading…";
    progressFill.classList.add("marquee");
    progressFill.style.width = "100%";
    try {
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const entry = await getRecentFile(id);
      if (!entry || !entry.tracks || !entry.tracks.length) {
        progressText.textContent = "Recent entry was empty";
        progressText.classList.add("error");
        progressFill.classList.remove("marquee");
        if (uploadActions) uploadActions.classList.remove("hidden");
        uploadLabel.classList.remove("hidden");
        if (hint) hint.classList.remove("hidden");
        if (recentUi && recentUi.section && recentUi.list.children.length) {
          recentUi.section.classList.remove("hidden");
        }
        return;
      }
      saveTracks(entry.tracks);
      loadTracks(entry.tracks);
    } finally {
      progressFill.classList.remove("marquee");
      progressArea.classList.add("hidden");
    }
  }

  function formatRecentTime(isoString) {
    const dt = new Date(isoString);
    if (Number.isNaN(dt.getTime())) return "";
    return dt.toLocaleString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  async function renderRecentFiles() {
    try {
      const items = await getRecentFiles();
      recentUi.list.innerHTML = "";

      if (!items.length) {
        recentUi.section.classList.add("hidden");
        recentUi.list.classList.add("hidden");
        recentUi.empty.classList.add("hidden");
        recentUi.clearBtn.classList.add("hidden");
        return;
      }

      recentUi.section.classList.remove("hidden");
      recentUi.empty.classList.add("hidden");
      recentUi.list.classList.remove("hidden");
      recentUi.clearBtn.classList.remove("hidden");

      const dropboxGlyph = `<svg class="recent-file-source" viewBox="0 0 24 24" width="11" height="11" aria-hidden="true" title="From Dropbox"><path fill="currentColor" d="M6 2 0 6l6 4 6-4-6-4zm12 0-6 4 6 4 6-4-6-4zM0 14l6 4 6-4-6-4-6 4zm18-4-6 4 6 4 6-4-6-4zM6 19l6 4 6-4-6-4-6 4z"/></svg>`;
      const stripExt = (n) => (n || "").replace(/\.(dbb|csv|gpx|xlsx)$/i, "");
      items.forEach((item) => {
        const row = document.createElement("div");
        row.className = "recent-file-item";
        const sourceGlyph = item.source === "dropbox" ? dropboxGlyph : "";
        // Dropbox multi-trip bundles get a stable label so older entries
        // saved before the rename ("Dropbox 244 trips 2026-06-22.dbb")
        // don't repeat info already shown by the glyph and meta line.
        const isMultiDropbox = item.source === "dropbox" && (item.tripCount || 0) > 1;
        const displayName = isMultiDropbox ? "all_trips" : stripExt(item.fileName);
        row.innerHTML = `
          <button type="button" class="recent-file-load">
            <span class="recent-file-name"><span class="recent-file-nametext">${escapeHtml(displayName)}</span>${sourceGlyph}</span>
            <span class="recent-file-meta">${item.tripCount} trips &middot; ${item.totalKm.toFixed(1)} km &middot; ${escapeHtml(formatRecentTime(item.loadedAt))}</span>
          </button>
        `;

        row.querySelector(".recent-file-load").addEventListener("click", () => {
          loadRecentFile(item.id);
        });
        recentUi.list.appendChild(row);
      });
    } catch {
      recentUi.section.classList.add("hidden");
    }
  }

  function escapeHtml(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  // --- Storage cache (IndexedDB primary, localStorage fallback) ---
  // The Wheel Forensics button awaits `pendingSessionWrite` so it doesn't
  // start a duplicate transaction behind the one already in flight from
  // saveTracks(). For a 169-trip library each round trip is ~15 MB of IDB
  // serialization — serialising them was making "Preparing…" take 5–10 s.
  let pendingSessionWrite = Promise.resolve();
  function saveTracks(tracks) {
    const data = JSON.stringify(tracks);
    // Best-effort localStorage. For libraries > ~5 MB this throws
    // QuotaExceededError — if it does, wipe any old smaller payload that
    // would otherwise survive and get loaded back on refresh as "1 trip".
    try {
      localStorage.setItem("dbb_tracks", data);
    } catch {
      try { localStorage.removeItem("dbb_tracks"); } catch {}
    }
    try {
      sessionStorage.setItem("dbb_tracks", data);
    } catch {
      try { sessionStorage.removeItem("dbb_tracks"); } catch {}
    }
    pendingSessionWrite = saveSessionTracks(tracks).catch((err) => {
      console.warn("Failed to write session tracks:", err);
    });
  }

  async function saveSessionTracks(tracks) {
    const db = await openRecentDb();
    if (!db) return;
    const tx = db.transaction(SESSION_STORE_NAME, "readwrite");
    tx.objectStore(SESSION_STORE_NAME).put(tracks, SESSION_KEY);
    await transactionDone(tx);
  }

  async function loadSessionTracks() {
    try {
      const db = await openRecentDb();
      if (!db) return null;
      const tx = db.transaction(SESSION_STORE_NAME, "readonly");
      const data = await requestToPromise(tx.objectStore(SESSION_STORE_NAME).get(SESSION_KEY));
      await transactionDone(tx);
      return data || null;
    } catch {
      return null;
    }
  }

  function loadCachedTracks() {
    try {
      const raw = localStorage.getItem("dbb_tracks") || sessionStorage.getItem("dbb_tracks");
      if (raw) return JSON.parse(raw);
    } catch {}
    return null;
  }

  // --- Hash routing ---
  function navigate(hash, replace) {
    if (replace) history.replaceState(null, "", hash);
    else history.pushState(null, "", hash);
    applyRoute();
  }

  // Fetch a trip file from a URL (e.g. a Dropbox dl.dropboxusercontent.com
  // link with `dl=1`) and load it through the standard parser pipeline.
  // Used by the `?file=<url>` query and the legacy `#trip=<url>` hash that
  // EUC Planet's "Inspect online" / Copy link actions fire.
  async function loadTripFromUrl(rawUrl) {
    overlay.classList.remove("hidden");
    panel.classList.add("hidden");
    progressArea.classList.remove("hidden");
    progressText.textContent = "Downloading trip…";
    progressText.classList.remove("error");
    try {
      const resp = await fetch(rawUrl, { redirect: "follow" });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const blob = await resp.blob();
      // The URL may end in .csv?dl=1; strip the query string when
      // deriving the filename so the extension check in handleFile
      // recognises it.
      const fname = (rawUrl.split("/").pop() || "trip.csv").split("?")[0];
      const file = new File([blob], fname, { type: blob.type || "text/csv" });
      await handleFile(file, false);
    } catch (e) {
      progressText.textContent = "Couldn’t fetch the shared trip: " + (e.message || e);
      progressText.classList.add("error");
    }
  }

  // --- Short share links (#d-…) ---------------------------------------
  // Compresses the one Dropbox direct-link shape our own share flow mints:
  //   https://dl.dropboxusercontent.com/scl/fi/<fileId>/trip_YYYYMMDD_HHMMSS.csv?rlkey=<rlkey>&dl=1
  // into a hash token:
  //   #d-<fileId>-<base36(YYYYMMDDHHMMSS)>-<rlkey>
  // The timestamp digits are treated as an opaque number (never parsed as a
  // date — the filename is wall-clock local time). Anything that deviates
  // from the template (extra params like st=, other hosts, other filenames,
  // uppercase ids) must NOT be compressed; callers fall back to ?file=.
  // Full grammar + rationale: SHORTLINK.md.
  const SHORT_TOKEN_RE = /^d-([a-z0-9]{1,64})-([a-z0-9]{1,9})-([a-z0-9]{1,64})$/;

  function encodeShortLink(directUrl) {
    let u;
    try { u = new URL(directUrl); } catch (_) { return null; }
    if (u.protocol !== "https:" || u.hostname !== "dl.dropboxusercontent.com" || u.hash) return null;
    const pm = /^\/scl\/fi\/([a-z0-9]{1,64})\/trip_(\d{8})_(\d{6})\.csv$/.exec(u.pathname);
    if (!pm) return null;
    const keys = Array.from(u.searchParams.keys());
    if (keys.length !== 2 || u.searchParams.get("dl") !== "1") return null;
    const rlkey = u.searchParams.get("rlkey") || "";
    if (!/^[a-z0-9]{1,64}$/.test(rlkey)) return null;
    return "d-" + pm[1] + "-" + Number(pm[2] + pm[3]).toString(36) + "-" + rlkey;
  }

  function decodeShortLink(token) {
    const m = SHORT_TOKEN_RE.exec(token || "");
    if (!m) return null;
    const n = parseInt(m[2], 36);
    if (!Number.isSafeInteger(n)) return null;
    const digits = String(n).padStart(14, "0");
    if (digits.length !== 14) return null;
    return "https://dl.dropboxusercontent.com/scl/fi/" + m[1] +
      "/trip_" + digits.slice(0, 8) + "_" + digits.slice(8, 14) +
      ".csv?rlkey=" + m[3] + "&dl=1";
  }

  // Reference implementation for other link producers (see SHORTLINK.md):
  // both return null when the input doesn't fit the template.
  window.eucViewerShortLink = { encode: encodeShortLink, decode: decodeShortLink };

  function applyRoute() {
    // `?file=<encoded-url>` is the share-style entry point: EUC Planet's
    // Inspect online / Copy eucviewer link actions build it from a
    // dl.dropboxusercontent.com direct CSV. Strip the query before
    // continuing so the rest of the route logic operates on a clean URL.
    const fileParam = new URLSearchParams(location.search).get("file");
    if (fileParam) {
      const url = fileParam;
      history.replaceState(null, "", location.pathname);
      loadTripFromUrl(url);
      return;
    }
    const hash = location.hash;
    // Legacy `#trip=<encoded-url>` deep link kept for any links shared
    // before the move to `?file=`.
    if (hash.startsWith("#trip=")) {
      const url = decodeURIComponent(hash.substring("#trip=".length));
      loadTripFromUrl(url);
      return;
    }
    // `#d-…` short share token: the whole hash is a compressed Dropbox
    // direct link. Decode + fetch exactly like ?file=. This branch covers
    // popstate / manual hash edits; the boot path handles it in init.
    const shortUrl = decodeShortLink(hash.slice(1));
    if (shortUrl) {
      history.replaceState(null, "", location.pathname);
      loadTripFromUrl(shortUrl);
      return;
    }
    if (hash === "#view" && allTracks.length) {
      overlay.classList.add("hidden");
      panel.classList.remove("hidden");
      updateGlow();
    } else if (hash === "#view") {
      // IndexedDB is the source of truth — for libraries > ~5 MB the
      // localStorage cache silently truncated (or got wiped) and would
      // otherwise show a stale 1-trip remnant on refresh.
      loadSessionTracks().then((idbTracks) => {
        if (idbTracks && idbTracks.length) { loadTracks(idbTracks, true); return; }
        const cached = loadCachedTracks();
        if (cached && cached.length) loadTracks(cached, true);
        else navigate("#load", true);
      });
    } else {
      overlay.classList.remove("hidden");
      panel.classList.add("hidden");
      setPanelOpen(false);
      resetUploadUI();
      // Re-render the recent files panel each time we land here. The
      // background saveRecentFile() from the previous upload may have
      // completed after we navigated away, so the cached panel state is
      // stale until we refresh it.
      renderRecentFiles().catch((err) => console.warn("renderRecentFiles:", err));
    }
  }

  function resetUploadUI() {
    if (uploadActions) uploadActions.classList.remove("hidden");
    uploadLabel.classList.remove("hidden");
    const hint = document.getElementById("upload-hint");
    if (hint) hint.classList.remove("hidden");
    progressArea.classList.add("hidden");
    progressText.classList.remove("error");
    fileInput.value = "";
    const inlineStatus = document.getElementById("dropbox-inline-status");
    if (inlineStatus) inlineStatus.remove();
  }

  window.addEventListener("popstate", applyRoute);

  // --- Load tracks into UI ---
  function loadTracks(tracks, skipNav) {
    tracks.sort((a, b) => {
      const pa = (a.dateStart || a.date.split(".").reverse().join("-"));
      const pb = (b.dateStart || b.date.split(".").reverse().join("-"));
      return pb.localeCompare(pa);
    });
    // Patch distanceKm for legacy tracks with no GPS (and no cached mileage column):
    // integrate speed (km/h) over elapsed seconds from timeseries.
    for (const t of tracks) {
      if (!t || !t.stats || t.stats.distanceKm > 0) continue;
      const ts = t.timeseries;
      if (!Array.isArray(ts) || ts.length < 2) continue;
      // Prefer mileage column if present (index 8).
      if (ts[0].length > 8) {
        let last = 0;
        for (let i = 0; i < ts.length; i++) { const mi = ts[i][8] || 0; if (mi > last) last = mi; }
        if (last > 0) { t.stats.distanceKm = Math.round(last * 100) / 100; continue; }
      }
      let running = 0;
      for (let i = 1; i < ts.length; i++) {
        const dtSec = Math.max(0, ts[i][0] - ts[i - 1][0]);
        const avgSpd = (ts[i][1] + ts[i - 1][1]) / 2;
        running += (avgSpd * dtSec) / 3600;
      }
      if (running > 0) t.stats.distanceKm = Math.round(running * 100) / 100;
    }
    allTracks = tracks;
    selectedIdx = -1;
    trackVisible = new Set(tracks.map((_, i) => i));
    updateGlow();
    // No fitAll() here — the auto-select below zooms to track 0. Calling both
    // raced two zoom animations and could leave the map un-zoomed on start.

    panelTabText.textContent = `Trip Explorer (${tracks.length})`;
    buildTripList();
    mapControlsEl.classList.remove("hidden");

    if (!skipNav) navigate("#view", false);
    else {
      overlay.classList.add("hidden");
      panel.classList.remove("hidden");
    }

    // Auto-open the panel on every load, portrait included: a taller-than-
    // wide window (phone, snapped half-screen, vertical monitor) used to
    // skip this, which read as "sometimes it starts collapsed". setPanelOpen
    // drives the position with an inline transform (see its comment for the
    // Chromium compositor story); the double-rAF lets the closed state paint
    // first so the open transition animates from the right start point.
    setPanelOpen(false);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        setPanelOpen(true);
      });
    });

    // Auto-select the first (newest) track so the map & details aren't empty.
    if (tracks.length > 0) {
      // Guard against a second auto-select racing this one: selectTrip on an
      // already-selected index toggles the selection off.
      setTimeout(() => { if (selectedIdx !== 0) selectTrip(0); }, 200);
    }
  }

  function fitAll() {
    let minLat = 90, maxLat = -90, minLon = 180, maxLon = -180;
    let hasGps = false;
    for (let i = 0; i < allTracks.length; i++) {
      if (!trackVisible.has(i)) continue;
      for (const p of allTracks[i].points) {
        hasGps = true;
        if (p[0] < minLat) minLat = p[0];
        if (p[0] > maxLat) maxLat = p[0];
        if (p[1] < minLon) minLon = p[1];
        if (p[1] > maxLon) maxLon = p[1];
      }
    }
    if (hasGps) {
      map.fitBounds([[minLat, minLon], [maxLat, maxLon]], {
        padding: [40, 40], animate: true, duration: 1.0,
      });
    }
  }

  function fitTrack(idx) {
    const pts = allTracks[idx].points;
    if (!pts.length) return;
    let minLat = 90, maxLat = -90, minLon = 180, maxLon = -180;
    for (const p of pts) {
      if (p[0] < minLat) minLat = p[0];
      if (p[0] > maxLat) maxLat = p[0];
      if (p[1] < minLon) minLon = p[1];
      if (p[1] > maxLon) maxLon = p[1];
    }
    map.fitBounds([[minLat, minLon], [maxLat, maxLon]], {
      padding: [60, 60], animate: true, duration: 0.8,
    });
  }

  // --- Visibility UI helpers ---
  function updateVisibilityUI() {
    const total = allTracks.length;
    const checked = trackVisible.size;
    const allCheck = document.querySelector(".all-check");
    if (allCheck) {
      allCheck.checked = checked === total;
      allCheck.indeterminate = checked > 0 && checked < total;
    }
    // Update panel tab text based on selection state
    if (total > 0) {
      if (checked === 0) {
        panelTabText.textContent = `Trip Explorer (${total} trips parsed)`;
      } else if (checked === total) {
        panelTabText.textContent = `Trip Explorer (${total} trips)`;
      } else {
        panelTabText.textContent = `Trip Explorer (${checked} displayed of ${total} trips)`;
      }
    }
    const footer = document.getElementById("panel-footer");
    if (!footer) return;
    const exportBtn = footer.querySelector(".export-btn");
    if (exportBtn) renderExportButton(exportBtn);
    // Update selected summary — hide if all or none selected
    const selSummary = footer.querySelector(".selected-summary");
    if (selSummary) {
      const selCount = trackVisible.size;
      const isPartial = selCount > 0 && selCount < allTracks.length;
      if (!isPartial) {
        selSummary.classList.add("hidden");
      } else {
        selSummary.classList.remove("hidden");
        let selKm = 0, selSec = 0, selTop = 0;
        for (const i of trackVisible) {
          const t = allTracks[i];
          if (!t) continue;
          selKm += t.stats.distanceKm;
          if (t.stats.maxSpeed > selTop) selTop = t.stats.maxSpeed;
          if (t.dateStart && t.dateEnd) {
            const s = new Date(t.dateStart).getTime();
            const e = new Date(t.dateEnd).getTime();
            if (s && e && e > s) selSec += (e - s) / 1000;
          }
        }
        const hrs = Math.floor(selSec / 3600);
        const mins = Math.round((selSec % 3600) / 60);
        selSummary.innerHTML = `
          <div class="summary-row"><span>${selCount}</span> trips</div>
          <div class="summary-row"><span>${UNITS.dist(selKm).toFixed(1)}</span> ${UNITS.distUnit}</div>
          <div class="summary-row"><span>${hrs}h ${mins}m</span> riding</div>
          <div class="summary-row"><span>${UNITS.speed(selTop).toFixed(0)}</span> ${UNITS.speedUnit} top</div>
        `;
      }
    }
  }

  // --- Build trip list ---
  // --- Wheel grouping --------------------------------------------------
  // Real identity only, no guessing: euc.world CSVs carry the wheel's
  // make/model/serial in their extra column (attached at parse as
  // track.wheel). EUC Planet and DarknessBot files record nothing about
  // the wheel, so those trips group as "Generic wheel" until their
  // recorder starts writing identity.
  function labelOfWheel(w) {
    if (!w) return null;
    // Some wheels report the brand inside the model ("InMotion P6"); don't
    // double it up in the label.
    const modelHasMake = w.make && w.model &&
      w.model.toLowerCase().startsWith(w.make.toLowerCase());
    const label = modelHasMake ? w.model : [w.make, w.model].filter(Boolean).join(" ");
    return label || w.name || (w.mac ? "Wheel " + w.mac : null);
  }
  function wheelLabelOf(t) {
    return labelOfWheel(t && t.wheel);
  }
  // Every identity a trip carries: multi-wheel trips (mid-ride switch)
  // list them all, ride order; single-wheel trips list just the one.
  function wheelIdsOf(t) {
    if (!t) return [];
    if (t.wheels && t.wheels.length) return t.wheels;
    return t.wheel ? [t.wheel] : [];
  }
  function computeWheelGroups() {
    const byKey = new Map();
    const unknown = [];
    for (let i = 0; i < allTracks.length; i++) {
      // A multi-wheel trip counts under EVERY wheel it contains, so
      // filtering by either wheel shows it.
      const ids = wheelIdsOf(allTracks[i]).filter((w) => labelOfWheel(w));
      if (!ids.length) { unknown.push(i); continue; }
      for (const w of ids) {
        const label = labelOfWheel(w);
        // Same key formula as analytics wheelKeyOf, so a wheel picked here
        // can be handed to Forensics via ?wheel= and match there.
        const key = label + "|" + (w.serial || w.mac || "");
        if (!byKey.has(key)) byKey.set(key, { label, key, wheel: w, indices: [] });
        const g = byKey.get(key);
        if (g.indices[g.indices.length - 1] !== i) g.indices.push(i);
      }
    }
    const groups = [...byKey.values()];
    // Two wheels of the same model (different serials): number them.
    const counts = {};
    for (const g of groups) counts[g.label] = (counts[g.label] || 0) + 1;
    const seen = {};
    for (const g of groups) {
      if (counts[g.label] > 1) {
        seen[g.label] = (seen[g.label] || 0) + 1;
        g.label += " #" + seen[g.label];
      }
    }
    // Newest first (allTracks is sorted newest-first).
    groups.sort((a, b) => Math.min(...a.indices) - Math.min(...b.indices));
    if (unknown.length) groups.push({ label: "Generic wheel", indices: unknown, unknown: true });
    return groups;
  }

  // --- Trip manager ----------------------------------------------------
  // Works on the LOADED library, whatever the sources (upload, Dropbox,
  // euc.world, share links), so wheels can be uniformed across all of
  // them: remove trips, or assign/clear the wheel on any selection. Edits
  // persist to the session and flow out through the normal exports.
  const tmRoot = document.getElementById("trip-manager");
  function tmClose() { if (tmRoot) tmRoot.classList.add("hidden"); }
  if (tmRoot) {
    tmRoot.querySelectorAll("[data-tm-close]").forEach((el) => el.addEventListener("click", tmClose));
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !tmRoot.classList.contains("hidden")) tmClose();
    });
  }

  function openTripManager() {
    if (!tmRoot || !allTracks.length) return;
    tmRoot.classList.remove("hidden");
    // Mirror the main window's selection ON OPEN only; re-renders from
    // inside the manager (Set wheel) pass their own selection instead,
    // so applying an action never shuffles the checkboxes under you.
    renderTripManager(new Set(trackVisible));
  }

  function renderTripManager(preChecked = new Set()) {
    const list = document.getElementById("tm-list");
    const selAll = document.getElementById("tm-select-all");
    const selWheel = document.getElementById("tm-select-wheel");
    const target = document.getElementById("tm-wheel-target");
    const applyBtn = document.getElementById("tm-apply-wheel");
    const delBtn = document.getElementById("tm-delete");
    const countEl = document.getElementById("tm-count");
    const groups = computeWheelGroups();

    list.innerHTML = allTracks.map((t, i) => {
      // Multi-wheel trips (mid-ride switch) show every wheel they carry.
      const label = wheelIdsOf(t).map(labelOfWheel).filter(Boolean).join(" + ") || null;
      const km = t.stats ? UNITS.dist(t.stats.distanceKm).toFixed(1) + " " + UNITS.distUnit : "";
      return `<label class="tm-row"><input type="checkbox" data-idx="${i}"${preChecked.has(i) ? " checked" : ""}>` +
        `<span class="tm-date">${formatTripLabel(t)}</span>` +
        `<span class="tm-km">${km}</span>` +
        `<span class="tm-wheel${label ? "" : " tm-unknown"}">${label || "Generic wheel"}</span></label>`;
    }).join("");

    selWheel.innerHTML = '<option value="">Select by wheel…</option>' +
      groups.map((g, gi) => `<option value="${gi}">${g.label} (${g.indices.length})</option>`).join("");

    // Assignable wheels: every named identity in the library, plus a
    // custom one, plus clearing. Values carry the identity as JSON.
    const named = groups.filter((g) => !g.unknown).map((g) => {
      const w = g.wheel || {};
      return { label: g.label, wheel: { name: w.name, mac: w.mac, make: w.make, model: w.model, serial: w.serial } };
    });
    target.innerHTML = named.map((n, i) => `<option value="${i}">→ ${n.label}</option>`).join("") +
      '<option value="custom">→ New wheel…</option>' +
      '<option value="clear">→ No wheel (clear)</option>';
    target._named = named;

    const checkedIdx = () => [...list.querySelectorAll("input:checked")].map((c) => parseInt(c.dataset.idx));
    const refresh = () => {
      const n = checkedIdx().length;
      countEl.textContent = n ? n + " selected" : allTracks.length + " trips";
      applyBtn.disabled = !n;
      delBtn.disabled = !n;
      selAll.checked = n === allTracks.length;
    };
    list.addEventListener("change", refresh);
    selAll.onchange = () => {
      list.querySelectorAll("input").forEach((c) => { c.checked = selAll.checked; });
      refresh();
    };
    selWheel.onchange = () => {
      const gi = selWheel.value;
      if (gi === "") return;
      const wanted = new Set(groups[parseInt(gi)].indices);
      list.querySelectorAll("input").forEach((c) => { c.checked = wanted.has(parseInt(c.dataset.idx)); });
      selWheel.value = "";
      refresh();
    };
    applyBtn.onclick = () => {
      const idxs = checkedIdx();
      if (!idxs.length) return;
      let wheel;
      const v = target.value;
      if (v === "clear") {
        wheel = null;
      } else if (v === "custom") {
        const name = (window.prompt("Wheel name (e.g. KS-16SZ or Lynx-2317):") || "").trim();
        if (!name) return;
        wheel = { name };
      } else {
        wheel = { ...target._named[parseInt(v)].wheel };
      }
      for (const i of idxs) {
        // Manual assignment is a uniform identity: it also drops any
        // multi-wheel list the parser attached.
        if (wheel) allTracks[i].wheel = { ...wheel };
        else delete allTracks[i].wheel;
        delete allTracks[i].wheels;
      }
      saveTracks(allTracks);
      buildTripList();
      updateGlow();
      updateVisibilityUI();
      renderTripManager(new Set(idxs));
    };
    delBtn.onclick = () => {
      const idxs = new Set(checkedIdx());
      if (!idxs.size) return;
      if (!window.confirm("Remove " + idxs.size + " trip(s) from the loaded library? The original files are not touched.")) return;
      const remaining = allTracks.filter((_, i) => !idxs.has(i));
      loadTracks(remaining, true);
      saveTracks(allTracks);
      if (!allTracks.length) { tmClose(); return; }
      renderTripManager();
    };
    refresh();
  }

  // Per-trip "Tools" popover. A single floating menu reused by every row
  // and positioned next to the clicked button, so it's never clipped by
  // the scrolling trip list. Two main actions on top, then per-trip edits.
  const ICON = {
    video: `<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M2.5 11.5 A6 6 0 1 1 13.5 11.5"/><line x1="8" y1="11" x2="11.2" y2="6.2"/><circle cx="8" cy="11" r="1.2" fill="currentColor" stroke="none"/></svg>`,
    inspect: `<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="7" cy="7" r="4.5"/><line x1="10.4" y1="10.4" x2="14" y2="14"/></svg>`,
    wheel: `<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.4"><circle cx="8" cy="8" r="6"/><circle cx="8" cy="8" r="1.6"/><path d="M8 2v2M8 12v2M2 8h2M12 8h2"/></svg>`,
    back: `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 3 5 8 9 13"/></svg>`,
    split: `<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><circle cx="4" cy="4" r="2"/><circle cx="4" cy="12" r="2"/><line x1="5.6" y1="5.4" x2="14" y2="11.5"/><line x1="5.6" y1="10.6" x2="14" y2="4.5"/></svg>`,
    extend: `<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M2 5h6M2 11h6"/><path d="M8 5v6"/><polyline points="10.5 6 13.5 8 10.5 10"/><line x1="8" y1="8" x2="13.5" y2="8"/></svg>`,
    rename: `<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M10.5 2.5l3 3M3 13l.6-2.6 7-7 2 2-7 7L3 13z"/></svg>`,
    share: `<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="3.5" r="2"/><circle cx="4" cy="8" r="2"/><circle cx="12" cy="12.5" r="2"/><line x1="5.7" y1="7" x2="10.3" y2="4.5"/><line x1="5.7" y1="9" x2="10.3" y2="11.5"/></svg>`,
    file: `<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M9 1.8H4.5a1 1 0 0 0-1 1v10.4a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1V5.3z"/><path d="M9 1.8V5.3h3.5"/></svg>`,
    archive: `<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4.5" width="12" height="9" rx="1"/><path d="M1.5 4.5 3 2h10l1.5 2.5"/><path d="M6.3 8h3.4"/></svg>`,
    remove: `<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M3 4h10M6.5 4V2.5h3V4M5 4l.5 9a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1l.5-9"/></svg>`,
  };
  let toolsMenu = null, toolsOpenFor = -1, toolsBtnEl = null;
  function ensureToolsMenu() {
    if (toolsMenu) return toolsMenu;
    toolsMenu = document.createElement("div");
    toolsMenu.id = "trip-tools-menu";
    toolsMenu.className = "hidden";
    document.body.appendChild(toolsMenu);
    document.addEventListener("click", (e) => {
      if (toolsOpenFor < 0) return;
      if (!toolsMenu.contains(e.target) && !e.target.closest(".tools-btn")) closeToolsMenu();
    });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeToolsMenu(); });
    window.addEventListener("resize", closeToolsMenu);
    const list = document.getElementById("trip-list");
    if (list) list.addEventListener("scroll", closeToolsMenu, true);
    return toolsMenu;
  }
  function closeToolsMenu() {
    if (toolsMenu) toolsMenu.classList.add("hidden");
    if (toolsBtnEl) toolsBtnEl.classList.remove("active");
    toolsOpenFor = -1; toolsBtnEl = null;
  }
  function positionToolsMenu() {
    const m = toolsMenu, btn = toolsBtnEl;
    if (!m || !btn) return;
    const r = btn.getBoundingClientRect();
    let top = r.bottom + 4;
    if (top + m.offsetHeight > window.innerHeight - 8) top = Math.max(8, r.top - m.offsetHeight - 4);
    m.style.left = Math.max(8, r.right - m.offsetWidth) + "px";
    m.style.top = top + "px";
  }
  function toolsMenuMain(i) {
    const m = toolsMenu;
    const t = allTracks[i] || {};
    // Sharing needs a Dropbox origin; the archive toggle also shows for a trip
    // already marked (so it can be unmarked) even if it has no Dropbox path.
    const canShare = !!t.dropboxPath;
    const canArchive = !!(t.dropboxPath || t._archive);
    m.innerHTML =
      `<a class="ttm-item" href="video.html?i=${i}" target="_blank" rel="noopener">${ICON.video}Make video</a>` +
      `<a class="ttm-item" href="inspector.html?i=${i}" target="_blank" rel="noopener">${ICON.inspect}Inspector</a>` +
      `<div class="ttm-sep"></div>` +
      `<button type="button" class="ttm-item" data-act="rename">${ICON.rename}Rename trip…</button>` +
      `<button type="button" class="ttm-item" data-act="wheel">${ICON.wheel}Change wheel…</button>` +
      `<button type="button" class="ttm-item" data-act="split">${ICON.split}Split trip…</button>` +
      `<button type="button" class="ttm-item" data-act="extend">${ICON.extend}Extend trip…</button>` +
      ((canShare || canArchive) ? `<div class="ttm-sep"></div>` : "") +
      (canShare ? `<button type="button" class="ttm-item" data-act="sharelink">${ICON.share}Share with viewer</button>` : "") +
      (canShare ? `<button type="button" class="ttm-item" data-act="sharefile">${ICON.share}Share file</button>` : "") +
      (canArchive ? `<button type="button" class="ttm-item" data-act="archive">${ICON.archive}${t._archive ? "Unmark archive" : "Mark for archive"}</button>` : "") +
      `<div class="ttm-sep"></div>` +
      `<button type="button" class="ttm-item ttm-danger" data-act="remove">${ICON.remove}Remove</button>`;
    m.querySelectorAll("a.ttm-item").forEach((a) => a.addEventListener("click", () => closeToolsMenu()));
    // Null-safe: the Dropbox-only items aren't always present.
    const wire = (act, fn) => { const el = m.querySelector(`[data-act="${act}"]`); if (el) el.addEventListener("click", (e) => { e.stopPropagation(); closeToolsMenu(); fn(i); }); };
    wire("rename", openRenameDialog);
    wire("wheel", openChangeWheelDialog);
    wire("split", openSplitDialog);
    wire("extend", openExtendDialog);
    wire("sharelink", (idx) => shareTripLink(idx, "viewer"));
    wire("sharefile", (idx) => shareTripLink(idx, "file"));
    wire("archive", toggleArchiveMark);
    wire("remove", removeTrip);
  }
  // Share a Dropbox trip: "viewer" copies a link that opens it in this viewer
  // (short #d-… token when the Dropbox link is standard-shaped), "file" copies
  // the raw Dropbox file link. Feedback is a toast, not an inline flash.
  async function shareTripLink(i, mode) {
    const t = allTracks[i];
    if (!t || !t.dropboxPath) return;
    const DS = window.DropboxSource;
    // Spinner on the row's share icon while the link is minted — this is the
    // feedback for both the icon itself and the tools-menu share items (which
    // close the menu, then trigger this).
    const btn = document.querySelector(`.trip-item[data-idx="${i}"] .share-btn`);
    const restore = btn ? btn.innerHTML : null;
    const setBusy = (on) => {
      if (!btn) return;
      btn.classList.toggle("is-busy", on);
      if (on) btn.innerHTML = '<span class="share-spinner"></span>';
      else if (restore != null) btn.innerHTML = restore;
    };
    if (!DS || !DS.isAuthenticated || !DS.isAuthenticated()) { appToast("Sign in to Dropbox first."); return; }
    setBusy(true);
    try {
      const direct = await DS.getOrCreateShareLink(t.dropboxPath);
      let url, label;
      if (mode === "file") { url = direct; label = "File link copied"; }
      else {
        const short = encodeShortLink(direct);
        url = location.origin + location.pathname + (short ? "#" + short : "?file=" + encodeURIComponent(direct));
        label = "Viewer link copied";
      }
      await navigator.clipboard.writeText(url);
      appToast(label);
    } catch (err) {
      const msg = String(err && err.message || err);
      if (/session expired|not signed in/i.test(msg)) {
        appToast("Dropbox session expired.");
        setTimeout(() => {
          const ok = window.confirm("Your Dropbox session has expired.\n\nReconnect now to share this trip? You'll come back to the viewer after sign-in.");
          if (ok && DS.startOAuth) DS.startOAuth();
        }, 250);
      } else {
        appToast(/sharing\.write/i.test(msg) ? "Enable sharing.write in Dropbox App Console"
          : /sharing\.read/i.test(msg) ? "Enable sharing.read in Dropbox App Console"
          : "Share failed");
      }
      console.warn("Share link error:", err);
    } finally {
      setBusy(false);
    }
  }
  // Flag / unflag a trip for archive (the Sync dialog then moves it into
  // /trips/archive and drops it locally). The list strikes marked trips out.
  function toggleArchiveMark(i) {
    const t = allTracks[i];
    if (!t) return;
    if (t._archive) delete t._archive; else t._archive = true;
    saveTracks(allTracks);
    buildTripList();
    appToast(t._archive ? "Marked for archive." : "Archive mark removed.");
  }
  // Remove a trip from the loaded library (local only — the source file, and
  // any Dropbox copy, are untouched). Mirrors the batch editor's Remove.
  function removeTrip(i) {
    const t = allTracks[i];
    if (!t) return;
    if (!window.confirm("Remove this trip from the loaded library? The original file is not touched.")) return;
    const remaining = allTracks.filter((_, idx) => idx !== i);
    loadTracks(remaining, true);
    saveTracks(allTracks);
    if (!allTracks.length) navigate("#load", true);
  }
  function applyWheelToTrip(i, wheel) {
    const t = allTracks[i];
    if (!t._dirty) t._preEdit = { customName: t.customName, wheel: t.wheel, wheels: t.wheels };
    if (wheel) t.wheel = { ...wheel }; else delete t.wheel;
    delete t.wheels;
    t._dirty = true; // wheel now differs from the Dropbox copy
    saveTracks(allTracks);
    buildTripList();
    updateGlow();
    updateVisibilityUI();
  }
  // Discard local name/wheel edits. Fast path: restore the values snapshotted
  // on the first edit this session. Fallback (older edits with no snapshot):
  // re-download the file from Dropbox and re-parse it in place, so the trip
  // returns to exactly the server version.
  async function revertTrip(t) {
    if (!t) return;
    if (t._preEdit) {
      const o = t._preEdit;
      if (o.customName) t.customName = o.customName; else delete t.customName;
      if (o.wheel) t.wheel = o.wheel; else delete t.wheel;
      if (o.wheels) t.wheels = o.wheels; else delete t.wheels;
      delete t._preEdit;
      delete t._dirty;
      saveTracks(allTracks);
      buildTripList();
      updateGlow();
      return;
    }
    const DS = window.DropboxSource;
    if (!t.dropboxPath || !DS || !DS.isAuthenticated || !DS.isAuthenticated()) return;
    const idx = allTracks.indexOf(t);
    if (idx < 0) return;
    const path = t.dropboxPath;
    const blob = await DS.downloadBlob(path);
    const fname = String(path).split("/").pop() || "trip.csv";
    const file = new File([blob], fname, { type: blob.type || "text/csv" });
    const parsed = await parseFileLocally(parserWorker, file, () => {});
    if (!parsed || !parsed.length) return;
    const fresh = parsed[0];
    fresh.dropboxPath = path; // keep its origin; it's clean now (no _dirty)
    const next = allTracks.slice();
    next[idx] = fresh;
    allTracks = next; // new reference so the geometry cache invalidates
    saveTracks(allTracks);
    buildTripList();
    updateGlow();
  }
  // Custom trip name (stored on the track like the wheel). Blank clears it,
  // falling back to the date/time. Only the label changes — points/stats are
  // untouched, so the cached geometry stays valid (no new array needed).
  function renameTrip(i, name) {
    const t = allTracks[i];
    if (!t) return;
    const prev = t.customName || "";
    if ((name || "") !== prev) {
      if (!t._dirty) t._preEdit = { customName: t.customName, wheel: t.wheel, wheels: t.wheels };
      t._dirty = true; // needs a re-sync to Dropbox
    }
    if (name) t.customName = name; else delete t.customName;
    saveTracks(allTracks);
    buildTripList();
  }
  function openRenameDialog(i) {
    const t = allTracks[i];
    if (!t) return;
    const dateLabel = tripDateLabel(t);
    const body =
      `<div class="tt-newrow" style="padding-left:8px"><input type="text" id="rn-name" maxlength="60" value="${escapeHtml(t.customName || "")}" placeholder="${escapeHtml(dateLabel)}"></div>` +
      `<div class="tt-hint" style="padding:0 8px">Leave blank to use the date.</div>`;
    const cancel = ttBtn("Cancel", "tt-ghost"); cancel.addEventListener("click", ttmodClose);
    const save = ttBtn("Save", "tt-primary");
    ttmodShow("NAME", "Rename trip",
      `<div class="tt-trip">${escapeHtml(dateLabel)}</div>`, body, [cancel, save]);
    const inp = ttmod.querySelector("#rn-name");
    setTimeout(() => { inp.focus(); inp.select(); }, 0);
    const commit = () => {
      const nm = (inp.value || "").trim();
      renameTrip(i, nm);
      ttmodClose();
      appToast(nm ? `Renamed to "${nm}".` : "Name cleared.");
    };
    save.addEventListener("click", commit);
    inp.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); commit(); } });
  }

  // ===================================================================
  // Sync with Dropbox. A trip's custom name and wheel live inside its own
  // CSV (the Extra column), so there's no separate metadata file: new trips
  // upload as CSV, and a renamed / re-wheeled trip (flagged _dirty) has its
  // file rewritten. Needs the Dropbox app's files.content.write scope (added
  // in the App Console, then reconnect).
  // ===================================================================
  const DBX_ICON = '<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><path fill="currentColor" d="M6 2 0 6l6 4 6-4-6-4zm12 0-6 4 6 4 6-4-6-4zM0 14l6 4 6-4-6-4-6 4zm18-4-6 4 6 4 6-4-6-4zM6 19l6 4 6-4-6-4-6 4z"/></svg>';

  function sanitizeFileName(s) {
    return String(s || "").replace(/[\/\\:*?"<>|]+/g, "-").replace(/\s+/g, " ").trim().slice(0, 80);
  }

  // --- Sync dialog: one list like the load modal. Local trips (with a
  // New / Changed / In-sync badge, changed ones on top) plus trips that are
  // on Dropbox but not loaded here (with a per-row Load). Sync uploads the
  // new ones + writes the name/wheel sidecar; Load pulls remote ones in.
  let dbxSyncRoot = null;
  function ensureSyncModal() {
    if (dbxSyncRoot) return dbxSyncRoot;
    dbxSyncRoot = document.createElement("div");
    dbxSyncRoot.id = "dbx-sync-modal";
    dbxSyncRoot.className = "hidden";
    document.body.appendChild(dbxSyncRoot);
    dbxSyncRoot.addEventListener("click", (e) => { if (e.target === dbxSyncRoot) closeSyncModal(); });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && dbxSyncRoot && !dbxSyncRoot.classList.contains("hidden")) closeSyncModal();
    });
    return dbxSyncRoot;
  }
  function closeSyncModal() { if (dbxSyncRoot) dbxSyncRoot.classList.add("hidden"); }

  // Connect from the sync dialog. Dropbox's OAuth redirect can't carry our
  // #view hash, so stash the intent first; resumeSyncAfterOAuth() restores the
  // view and reopens this dialog when we land back here.
  function connectDropbox(autoLoadAll) {
    const DS = window.DropboxSource;
    if (!DS) return;
    try { localStorage.setItem("eucviewer-post-oauth", JSON.stringify({ action: "sync", hadTrips: allTracks.length > 0, autoLoadAll: !!autoLoadAll })); } catch (_) {}
    DS.startOAuth();
  }

  // Called on boot: if we just came back from a sync-dialog connect, restore
  // the trip view (cached locally) instead of the load screen and reopen the
  // dialog once the token exchange settles. Returns true if it handled boot.
  function resumeSyncAfterOAuth() {
    let intent = null;
    try { intent = JSON.parse(localStorage.getItem("eucviewer-post-oauth") || "null"); } catch (_) {}
    if (!intent || intent.action !== "sync") return false;
    try { localStorage.removeItem("eucviewer-post-oauth"); } catch (_) {}
    // Restore the trip view only if we had trips before connecting; a first
    // connect from the upload screen has none, so stay there and open straight.
    navigate(intent.hadTrips ? "#view" : "#load", true);
    const done = (window.DropboxSource && DropboxSource.maybeHandleCallback)
      ? DropboxSource.maybeHandleCallback() : Promise.resolve();
    Promise.resolve(done).then(() => {
      const openIt = () => openDropboxSyncDialog({ autoLoadAll: intent.autoLoadAll });
      if (!intent.hadTrips) { openIt(); return; }
      let tries = 0;
      const openWhenReady = () => {
        if (allTracks && allTracks.length) { openIt(); return; }
        if (tries++ < 15) { setTimeout(openWhenReady, 150); return; }
        openIt();
      };
      setTimeout(openWhenReady, 150);
    });
    return true;
  }
  // The one Dropbox dialog for the whole app — the upload screen's Dropbox
  // buttons (source-hints.js) call this too, so there's a single shared UI.
  window.eucViewerOpenDropbox = openDropboxSyncDialog;

  function openDropboxSyncDialog(opts) {
    opts = opts || {};
    const DS = window.DropboxSource;
    if (!DS) { appToast("Dropbox is not available."); return; }
    const root = ensureSyncModal();
    root.classList.remove("hidden");
    root.innerHTML =
      `<div class="src-card is-dropbox" role="dialog" aria-modal="true">` +
        `<header class="src-head">` +
          `<svg class="dbx-brand" viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M6 2 0 6l6 4 6-4-6-4zm12 0-6 4 6 4 6-4-6-4zM0 14l6 4 6-4-6-4-6 4zm18-4-6 4 6 4 6-4-6-4zM6 19l6 4 6-4-6-4-6 4z"/></svg>` +
          `<h3>Sync with Dropbox</h3>` +
          `<button type="button" class="src-close" aria-label="Close">&times;</button>` +
        `</header>` +
        `<div class="dbx-sync-main"><div class="dbx-sync-loading"><span class="dbx-spinner"></span></div></div>` +
      `</div>`;
    root.querySelector(".src-close").addEventListener("click", closeSyncModal);
    const main = root.querySelector(".dbx-sync-main");
    if (!DS.isAuthenticated()) {
      main.innerHTML =
        `<div class="dbx-listing"><div class="dbx-empty">Connect your Dropbox to sync trips with <code>Apps/EUC Planet/trips/</code>.</div></div>` +
        `<div class="src-action"><div class="src-action-row"><button type="button" class="src-primary-btn" id="dbx-sync-connect">Connect Dropbox</button></div></div>`;
      main.querySelector("#dbx-sync-connect").addEventListener("click", () => connectDropbox(opts.autoLoadAll));
      return;
    }
    gatherSyncState()
      .then((state) => {
        renderSyncState(state, main);
        // Main Dropbox button: kick off "Load all" as soon as the list is up.
        if (opts.autoLoadAll) {
          const btn = main.querySelector("#dbx-load-remote");
          if (btn) btn.click();
        }
      })
      .catch((e) => { main.innerHTML = `<div class="dbx-listing"><div class="dbx-err">Couldn't reach Dropbox: ${escapeHtml(e.message || String(e))}</div></div>`; });
  }

  async function gatherSyncState() {
    const DS = window.DropboxSource;
    const remote = await DS.listTripFiles().catch(() => []);
    const totalBytes = remote.reduce((s, f) => s + (f.size || 0), 0);
    let cacheStats = { count: 0, bytes: 0 };
    try { if (DS.cache && DS.cache.stats) cacheStats = await DS.cache.stats(); } catch (_) {}
    const localPaths = new Set();
    const rows = [];
    for (const t of allTracks) {
      const path = t.dropboxPath ? String(t.dropboxPath).toLowerCase() : null;
      if (path) localPaths.add(path);
      // Archive wins over every other state: a superseded source (an extended
      // piece or a split original) is on its way out, so even a local rename
      // ("changed") shouldn't tempt an upload — it gets moved out instead.
      let cat = "synced";
      if (t._archive) cat = "archive";
      else if (!path) cat = "new";
      else if (t._dirty) cat = "edited";
      rows.push({ kind: "local", cat, track: t, label: formatTripLabel(t) });
    }
    for (const f of remote) {
      if (localPaths.has(String(f.path).toLowerCase())) continue;
      rows.push({ kind: "remote", cat: "remote", file: f, label: f.name });
    }
    const order = { archive: 0, edited: 1, new: 2, remote: 3, synced: 4 };
    rows.sort((a, b) => (order[a.cat] - order[b.cat]) || String(a.label).localeCompare(String(b.label)));
    return { rows, account: DS.accountName(), totalBytes, cacheStats };
  }

  // Round icon per row, matching the load dialog's cached/remote tags.
  const DBX_TAG_ICONS = {
    synced: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M2 8.5l4 4 8-9"/></svg>',
    new: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M8 10.5V2.5"/><path d="M4.5 6 8 2.5 11.5 6"/><path d="M2.5 13.5h11"/></svg>',
    edited: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>',
    remote: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 11.5h6a3 3 0 0 0 .3-5.97A4.5 4.5 0 0 0 2.5 7.7a2.7 2.7 0 0 0 2 3.8z"/><path d="M8 8v4"/><path d="M6 10l2 2 2-2"/></svg>',
    archive: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4.5" width="12" height="9" rx="1"/><path d="M1.5 4.5 3 2h10l1.5 2.5"/><path d="M6.3 8h3.4"/></svg>',
  };
  const DBX_TAG_TIP = { new: "Not on Dropbox yet", edited: "Changed, its file will be updated", synced: "In sync", remote: "On Dropbox, not loaded here", archive: "Superseded — moves to /trips/archive and leaves here" };
  // Local status shows in the meta text; the in-sync state is carried by its
  // (disabled) button instead, so it isn't said twice.
  const DBX_META = { new: "New", edited: "Changed", archive: "Archive" };
  function dbxFmtBytes(n) {
    if (!n) return "";
    const u = ["B", "KB", "MB", "GB"]; let i = 0, v = n;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return v.toFixed(v >= 100 || i === 0 ? 0 : 1) + " " + u[i];
  }
  // Stable per-row key so an upload can find + spinner the right local row
  // (new trips have no dropboxPath yet, so fall back to identity fields).
  function dbxTrackKey(t) {
    if (t.dropboxPath) return String(t.dropboxPath).toLowerCase();
    return "local:" + (t.dateStart || t.date || "") + "|" + (t.name || "") + "|" + (t.customName || "");
  }

  function renderSyncState(state, main) {
    const DS = window.DropboxSource;
    const uploadTracks = state.rows.filter((r) => r.kind === "local" && (r.cat === "new" || r.cat === "edited")).map((r) => r.track);
    const archiveTracks = state.rows.filter((r) => r.kind === "local" && r.cat === "archive").map((r) => r.track);
    const remoteFiles = state.rows.filter((r) => r.kind === "remote").map((r) => r.file);
    const nTrips = state.rows.length;
    // Upstream (send to Dropbox) is one control: a Synchronize button that does
    // upload + archive together, with a caret for the individual actions when
    // both apply. Downstream (Load) stays its own button.
    const up = uploadTracks.length, arch = archiveTracks.length, upstream = up + arch;
    const bothUpstream = up > 0 && arch > 0;
    const subParts = [];
    if (up) subParts.push(`upload ${up}`);
    if (arch) subParts.push(`archive ${arch}`);
    const syncMainLabel = `<span class="dbx-sync-title">Synchronize</span>` +
      (subParts.length ? `<span class="dbx-sync-sub">(${subParts.join(", ")})</span>` : "");

    const rowsHtml = state.rows.map((r, i) => {
      const meta = r.kind === "remote"
        ? [String(r.file.modified || "").slice(0, 10), dbxFmtBytes(r.file.size || 0)].filter(Boolean).join(" · ")
        : DBX_META[r.cat];
      // Remote rows load into the viewer; new/changed local rows upload just
      // themselves; in-sync rows need no action.
      const rowBtn = r.kind === "remote"
        ? `<button type="button" class="dbx-row-open" data-i="${i}">Load</button>`
        : r.cat === "archive"
          ? `<button type="button" class="dbx-row-arch" data-i="${i}">Archive</button>`
          : (r.cat === "new" || r.cat === "edited")
            ? `<button type="button" class="dbx-row-sync" data-i="${i}">Upload</button>`
            : `<button type="button" class="dbx-row-done" disabled>Loaded</button>`;
      // Changed rows: the amber icon is a one-click undo (revert). Archive
      // rows: the icon cancels the archive (keep the trip). Others are static.
      const tag = r.cat === "edited"
        ? `<button type="button" class="dbx-row-tag dbx-row-revert" data-i="${i}" title="Undo changes (revert to the Dropbox version)">${DBX_TAG_ICONS.edited}</button>`
        : r.cat === "archive"
          ? `<button type="button" class="dbx-row-tag dbx-row-unarchive" data-i="${i}" title="Keep this trip (cancel archive)">${DBX_TAG_ICONS.archive}</button>`
          : `<span class="dbx-row-tag" title="${DBX_TAG_TIP[r.cat]}">${DBX_TAG_ICONS[r.cat]}</span>`;
      const dataPath = r.kind === "remote" ? ` data-path="${escapeHtml(r.file.path)}"` : ` data-key="${escapeHtml(dbxTrackKey(r.track))}"`;
      return `<li class="dbx-row cat-${r.cat}"${dataPath}>` +
        `<span class="dbx-row-name" title="${escapeHtml(r.label)}">${escapeHtml(r.label)}</span>` +
        `<span class="dbx-row-meta">${escapeHtml(meta || "")}</span>` +
        tag +
        rowBtn +
      `</li>`;
    }).join("");

    const sizeBit = state.totalBytes ? ` · ${dbxFmtBytes(state.totalBytes)}` : "";
    const cache = state.cacheStats || { count: 0, bytes: 0 };
    main.innerHTML =
      `<details class="dbx-conn">` +
        `<summary>` +
          `<svg viewBox="0 0 16 16" width="10" height="10" class="dbx-conn-caret" aria-hidden="true"><path fill="currentColor" d="M5 3l5 5-5 5z"/></svg>` +
          `<span class="dbx-conn-trips">${nTrips} ${nTrips === 1 ? "trip" : "trips"}${sizeBit}</span>` +
          `<span class="dbx-conn-account">Connected as ${escapeHtml(state.account || "Dropbox")}</span>` +
        `</summary>` +
        `<div class="dbx-conn-body">` +
          `<div class="dbx-conn-row"><span class="dbx-conn-key">Folder</span><code>Apps/EUC Planet/trips/</code></div>` +
          `<div class="dbx-conn-row"><span class="dbx-conn-key">Cache</span><span>${cache.count} file${cache.count === 1 ? "" : "s"} · ${dbxFmtBytes(cache.bytes) || "0 KB"}</span></div>` +
          `<div class="dbx-conn-actions">` +
            (cache.count ? `<button type="button" class="src-link-btn" id="dbx-clear-cache">Clear cache</button>` : "") +
            `<button type="button" class="src-link-btn dbx-signout">Sign out of Dropbox</button>` +
          `</div>` +
        `</div>` +
      `</details>` +
      `<div class="dbx-listing"><ul class="dbx-rows">${rowsHtml || '<li class="dbx-empty">No trips.</li>'}</ul></div>` +
      `<div class="src-action"><div class="src-action-row">` +
        // Upstream: one Synchronize button (upload + archive). When both apply,
        // a caret splits it into the individual Upload / Archive actions.
        (upstream ? (bothUpstream
          ? `<div class="dbx-sync-split">` +
              `<button type="button" class="src-primary-btn dbx-sync-main" id="dbx-do-all" title="Upload ${up} and archive ${arch}">${syncMainLabel}</button>` +
              `<button type="button" class="src-primary-btn dbx-sync-caret" id="dbx-sync-menu-btn" aria-label="Individual sync actions"><svg viewBox="0 0 16 16" width="10" height="10" aria-hidden="true"><path fill="currentColor" d="M3 5l5 6 5-6z"/></svg></button>` +
              `<div class="dbx-sync-menu hidden" id="dbx-sync-menu">` +
                `<button type="button" class="dbx-sync-menu-item" id="dbx-do-sync">Upload ${up}</button>` +
                `<button type="button" class="dbx-sync-menu-item" id="dbx-do-archive">Archive ${arch}</button>` +
              `</div>` +
            `</div>`
          : `<button type="button" class="src-primary-btn dbx-sync-main" id="dbx-do-all">${syncMainLabel}</button>`) : "") +
        (remoteFiles.length ? `<button type="button" class="${upstream ? "src-secondary-btn" : "src-primary-btn"}" id="dbx-load-remote">Load ${remoteFiles.length} from Dropbox</button>` : "") +
      `</div></div>` +
      `<div class="dbx-status"></div>`;

    const ui = { main, status: main.querySelector(".dbx-status") };
    const signout = main.querySelector(".dbx-signout");
    if (signout) signout.addEventListener("click", () => { DS.signOut(); openDropboxSyncDialog(); });
    const clearCache = main.querySelector("#dbx-clear-cache");
    if (clearCache) clearCache.addEventListener("click", async () => {
      try { if (DS.cache && DS.cache.clear) await DS.cache.clear(); } catch (_) {}
      const s2 = await gatherSyncState().catch(() => null);
      if (s2) renderSyncState(s2, ui.main);
    });
    main.querySelectorAll(".dbx-row-open").forEach((btn) => {
      const r = state.rows[parseInt(btn.dataset.i)];
      if (r && r.file) btn.addEventListener("click", () => loadRemoteTrips([r.file], ui));
    });
    main.querySelectorAll(".dbx-row-sync").forEach((btn) => {
      const r = state.rows[parseInt(btn.dataset.i)];
      if (r && r.track) btn.addEventListener("click", () => runSync([r.track], ui));
    });
    main.querySelectorAll(".dbx-row-revert").forEach((btn) => {
      const r = state.rows[parseInt(btn.dataset.i)];
      if (r && r.track) btn.addEventListener("click", async () => {
        // Dim + lock the dialog during the 1-2s reload instead of adding a
        // status line (which would resize the card). Re-render when done.
        ui.main.classList.add("dbx-busy");
        try { await revertTrip(r.track); } catch (e) { console.warn("Revert failed:", e); }
        const s = await gatherSyncState().catch(() => null);
        if (s) renderSyncState(s, ui.main);
        ui.main.classList.remove("dbx-busy");
      });
    });
    main.querySelectorAll(".dbx-row-arch").forEach((btn) => {
      const r = state.rows[parseInt(btn.dataset.i)];
      if (r && r.track) btn.addEventListener("click", () => runArchive([r.track], ui));
    });
    main.querySelectorAll(".dbx-row-unarchive").forEach((btn) => {
      const r = state.rows[parseInt(btn.dataset.i)];
      if (r && r.track) btn.addEventListener("click", async () => {
        delete r.track._archive; // keep it: back to its normal state
        saveTracks(allTracks);
        const s = await gatherSyncState().catch(() => null);
        if (s) renderSyncState(s, ui.main);
      });
    });
    const loadBtn = main.querySelector("#dbx-load-remote");
    if (loadBtn) loadBtn.addEventListener("click", () => loadRemoteTrips(remoteFiles, ui));
    // Synchronize = upload then archive in one pass.
    const allBtn = main.querySelector("#dbx-do-all");
    if (allBtn && upstream) allBtn.addEventListener("click", () => runSyncAndArchive(uploadTracks, archiveTracks, ui));
    // Caret splits it into the individual actions.
    const menu = main.querySelector("#dbx-sync-menu");
    const menuBtn = main.querySelector("#dbx-sync-menu-btn");
    if (menuBtn && menu) {
      menuBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        menu.classList.toggle("hidden");
        if (!menu.classList.contains("hidden")) {
          const close = (ev) => {
            if (ev.target.closest("#dbx-sync-menu") || ev.target.closest("#dbx-sync-menu-btn")) return;
            menu.classList.add("hidden");
            document.removeEventListener("mousedown", close, true);
          };
          document.addEventListener("mousedown", close, true);
        }
      });
    }
    const syncBtn = main.querySelector("#dbx-do-sync");
    if (syncBtn && uploadTracks.length) syncBtn.addEventListener("click", () => runSync(uploadTracks, ui));
    const archiveBtn = main.querySelector("#dbx-do-archive");
    if (archiveBtn && archiveTracks.length) archiveBtn.addEventListener("click", () => runArchive(archiveTracks, ui));

    // Responsive action labels: when the Synchronize and Load buttons can't
    // share one row, drop to compact text ("Upload 1" / "Load 353") so they fit
    // on a line instead of wrapping. Full text returns when there's room again.
    const actionRow = main.querySelector(".src-action-row");
    if (actionRow) {
      const syncMainEl = actionRow.querySelector(".dbx-sync-main");
      const compactBits = [];
      if (up) compactBits.push("Upload " + up);
      if (arch) compactBits.push("Archive " + arch);
      const compactSyncLabel = compactBits.join(", ");
      const fitActions = () => {
        // Restore full labels first so a widened dialog can re-expand them.
        if (syncMainEl) syncMainEl.innerHTML = syncMainLabel;
        if (loadBtn) loadBtn.textContent = "Load " + remoteFiles.length + " from Dropbox";
        const kids = [...actionRow.children];
        if (kids.length < 2) return; // only one button, nothing to trade off
        if (new Set(kids.map((k) => k.offsetTop)).size === 1) return; // already fits
        if (syncMainEl && compactSyncLabel) syncMainEl.textContent = compactSyncLabel;
        if (loadBtn) loadBtn.textContent = "Load " + remoteFiles.length;
      };
      fitActions();
      renderSyncState._lastFit = fitActions;
      if (!renderSyncState._resizeBound) {
        renderSyncState._resizeBound = true;
        window.addEventListener("resize", () => {
          if (dbxSyncRoot && !dbxSyncRoot.classList.contains("hidden") && renderSyncState._lastFit) {
            renderSyncState._lastFit();
          }
        });
      }
    }
  }

  // One-pass upstream sync: upload first (so a combined trip is safely on
  // Dropbox before its sources leave), then archive the superseded ones.
  async function runSyncAndArchive(uploadTracks, archiveTracks, ui) {
    if (uploadTracks && uploadTracks.length) await runSync(uploadTracks, ui);
    if (archiveTracks && archiveTracks.length) await runArchive(archiveTracks, ui);
  }

  async function runSync(uploadTracks, ui) {
    const DS = window.DropboxSource;
    const main = ui.main;
    // Lock the dialog (no resizing status line) and spinner each row as it
    // uploads, matching the fetch behaviour.
    main.classList.add("dbx-locked");
    const rowSyncBtn = (key) => {
      const li = main.querySelector(`.dbx-row[data-key="${String(key).replace(/["\\]/g, "\\$&")}"]`);
      return li ? li.querySelector(".dbx-row-sync") : null;
    };
    const keyOf = new Map();
    uploadTracks.forEach((t) => {
      const k = dbxTrackKey(t); keyOf.set(t, k);
      const b = rowSyncBtn(k); if (b) { b.disabled = true; b.innerHTML = '<span class="dbx-spinner sm"></span>'; }
    });
    main.querySelectorAll(".src-action-row button").forEach((b) => { b.disabled = true; });
    try {
      for (const t of uploadTracks) {
        const isNew = !t.dropboxPath;
        const blob = new Blob([trackToCSV(t)], { type: "text/csv" });
        let path, mode;
        if (isNew) {
          const base = sanitizeFileName(formatTripLabel(t)) || (t.name || "trip");
          path = DS.TRIPS_PATH + "/" + base.replace(/\.(csv|gpx|xlsx|dbb)$/i, "") + ".csv";
          mode = "add";
        } else {
          path = t.dropboxPath; // rewrite the existing file in place
          mode = "overwrite";
        }
        const res = await DS.uploadFile(path, blob, mode);
        if (isNew) t.dropboxPath = (res && (res.path_lower || res.path_display)) || path.toLowerCase();
        t._dirty = false;
        delete t._preEdit; // synced: current state is the new baseline
        const b = rowSyncBtn(keyOf.get(t)); if (b) b.innerHTML = "✓";
      }
      saveTracks(allTracks);
      buildTripList();
      const s = await gatherSyncState();
      main.classList.remove("dbx-locked");
      renderSyncState(s, main);
    } catch (e) {
      main.classList.remove("dbx-locked");
      const s = await gatherSyncState().catch(() => null);
      if (s) renderSyncState(s, main);
      const st = main.querySelector(".dbx-status");
      const msg = String(e.message || e);
      if (st) {
        if (/missing_scope/.test(msg)) {
          st.classList.add("dbx-err");
          st.innerHTML = `Enable <code>files.content.write</code> in your Dropbox App Console, then reconnect.`;
          const sb = main.querySelector("#dbx-do-sync");
          if (sb) { sb.disabled = false; sb.textContent = "Reconnect"; sb.onclick = () => connectDropbox(); }
        } else {
          st.textContent = "Upload failed: " + msg;
        }
      }
    }
  }

  // Archive superseded source trips: move each Dropbox file into /trips/archive
  // (out of EUC Planet's /trips listing) and drop it from the local library.
  // Trips with no Dropbox origin just leave locally — there's nothing to move.
  async function runArchive(archiveTracks, ui) {
    const DS = window.DropboxSource;
    const main = ui.main;
    main.classList.add("dbx-locked");
    const rowArchBtn = (key) => {
      const li = main.querySelector(`.dbx-row[data-key="${String(key).replace(/["\\]/g, "\\$&")}"]`);
      return li ? li.querySelector(".dbx-row-arch") : null;
    };
    const keyOf = new Map();
    archiveTracks.forEach((t) => {
      const k = dbxTrackKey(t); keyOf.set(t, k);
      const b = rowArchBtn(k); if (b) { b.disabled = true; b.innerHTML = '<span class="dbx-spinner sm"></span>'; }
    });
    main.querySelectorAll(".src-action-row button").forEach((b) => { b.disabled = true; });
    const removed = new Set();
    let err = null;
    try {
      for (const t of archiveTracks) {
        const li = main.querySelector(`.dbx-row[data-key="${String(keyOf.get(t)).replace(/["\\]/g, "\\$&")}"]`);
        if (li) li.scrollIntoView({ block: "nearest" });
        if (t.dropboxPath) {
          const base = String(t.dropboxPath).split("/").pop() || "trip.csv";
          await DS.moveFile(t.dropboxPath, DS.TRIPS_PATH + "/archive/" + base);
        }
        removed.add(t);
        const b = rowArchBtn(keyOf.get(t)); if (b) b.innerHTML = "✓";
      }
    } catch (e) { err = e; }
    // Apply whatever succeeded (partial failure keeps the un-moved ones).
    if (removed.size) {
      // New array so the reference-keyed geometry/scale caches recompute.
      allTracks = allTracks.filter((t) => !removed.has(t));
      trackVisible = new Set(allTracks.map((_, i) => i));
      selectedIdx = -1;
      saveTracks(allTracks);
      buildTripList();
      updateGlow();
      updateVisibilityUI();
    }
    main.classList.remove("dbx-locked");
    const s = await gatherSyncState().catch(() => null);
    if (s) renderSyncState(s, main);
    if (err) {
      const st = main.querySelector(".dbx-status");
      const msg = String(err.message || err);
      if (st) {
        st.classList.add("dbx-err");
        st.innerHTML = /missing_scope/.test(msg)
          ? `Enable <code>files.content.write</code> in your Dropbox App Console, then reconnect.`
          : "Archive failed: " + escapeHtml(msg);
      }
    }
  }

  async function loadRemoteTrips(files, ui) {
    const DS = window.DropboxSource;
    if (!files.length || typeof window.JSZip === "undefined") return;
    const main = ui.main;
    // Lock the dialog (no resizing status line) and spinner each row as it's
    // fetched, so the list itself shows progress. Then close + hand off.
    main.classList.add("dbx-locked");
    const rowEl = (path) => main.querySelector(`.dbx-row[data-path="${String(path || "").replace(/["\\]/g, "\\$&")}"]`);
    files.forEach((f) => { const li = rowEl(f.path); const b = li && li.querySelector(".dbx-row-open"); if (b) { b.disabled = true; b.innerHTML = '<span class="dbx-spinner sm"></span>'; } });
    main.querySelectorAll(".src-action-row button").forEach((b) => { b.disabled = true; });
    try {
      const zip = new window.JSZip();
      const used = new Set();
      const map = {};
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        const li = rowEl(f.path);
        // Follow the loading down the list so the pending rows scroll into
        // view page by page, even though the form is locked. Instant, not
        // smooth: rapid successive smooth scrolls cancel each other and never
        // advance.
        if (li) li.scrollIntoView({ block: "nearest" });
        const blob = await DS.downloadBlob(f.path);
        const b = li && li.querySelector(".dbx-row-open"); if (b) b.innerHTML = "✓"; // this one landed
        let name = f.name;
        if (used.has(name)) {
          const d = name.lastIndexOf(".");
          name = (d > 0 ? name.slice(0, d) : name) + "_" + (i + 1) + (d > 0 ? name.slice(d) : "");
        }
        used.add(name);
        zip.file(name, blob);
        map[name] = f.path;
      }
      const out = await zip.generateAsync({ type: "blob", compression: "STORE" });
      closeSyncModal();
      if (typeof window.eucViewerLoadFile === "function") {
        window.eucViewerLoadFile(new File([out], "dropbox_new.zip", { type: "application/zip" }),
          { append: true, dropboxMap: map, source: "dropbox" });
      }
    } catch (e) {
      main.classList.remove("dbx-locked");
      const s = await gatherSyncState().catch(() => null);
      if (s) renderSyncState(s, main);
    }
  }
  function toggleToolsMenu(btn, i) {
    if (toolsOpenFor === i) { closeToolsMenu(); return; }
    ensureToolsMenu();
    toolsOpenFor = i; toolsBtnEl = btn;
    toolsMenu.classList.remove("hidden");
    toolsMenuMain(i);
    positionToolsMenu();
    btn.classList.add("active");
  }

  // ===================================================================
  // Trip tool dialogs: Change wheel / Split trip / Extend trip.
  // All three are modal (eucplanet-style), sharing one reusable panel.
  // Split and Extend re-derive tracks from the stored timeseries (the
  // time-authoritative array), rebuild points from its GPS rows, and
  // recompute stats with the same formulas the parser uses, so the
  // results are indistinguishable from freshly-parsed trips.
  // ===================================================================
  const ttmod = document.getElementById("trip-tool-modal");
  function ttmodClose() { if (ttmod) ttmod.classList.add("hidden"); }
  if (ttmod) {
    ttmod.querySelectorAll("[data-ttmod-close]").forEach((el) => el.addEventListener("click", ttmodClose));
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !ttmod.classList.contains("hidden")) ttmodClose();
    });
  }
  function ttmodShow(tag, title, subHtml, bodyHtml, footNodes) {
    if (!ttmod) return null;
    const tagEl = ttmod.querySelector("#ttmod-tag");
    tagEl.textContent = tag || "";
    tagEl.classList.toggle("hidden", !tag); // no chip when the caller omits a tag
    ttmod.querySelector("#ttmod-title").textContent = title;
    ttmod.querySelector("#ttmod-sub").innerHTML = subHtml || "";
    ttmod.querySelector("#ttmod-body").innerHTML = bodyHtml || "";
    const foot = ttmod.querySelector("#ttmod-foot");
    foot.innerHTML = "";
    (footNodes || []).forEach((n) => foot.appendChild(n));
    ttmod.classList.remove("hidden");
    return ttmod;
  }
  function ttBtn(label, cls) {
    const b = document.createElement("button");
    b.type = "button"; b.textContent = label; if (cls) b.className = cls;
    return b;
  }

  // Lightweight toast (bottom-center, auto-dismiss).
  let _toastEl = null, _toastT = null;
  function appToast(msg) {
    if (!_toastEl) {
      _toastEl = document.createElement("div");
      _toastEl.id = "app-toast";
      document.body.appendChild(_toastEl);
    }
    _toastEl.textContent = msg;
    _toastEl.classList.add("show");
    clearTimeout(_toastT);
    _toastT = setTimeout(() => _toastEl.classList.remove("show"), 3200);
  }

  // --- track math (mirrors parser-worker.js so re-derived tracks match) ---
  const _rn = (v, d) => Number(v.toFixed(d));
  function _hav(lat1, lon1, lat2, lon2) {
    const R = 6371000, p1 = lat1 * Math.PI / 180, p2 = lat2 * Math.PI / 180;
    const dP = (lat2 - lat1) * Math.PI / 180, dL = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dP / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dL / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }
  function _maxOf(a) { if (!a.length) return 0; let m = a[0]; for (const v of a) if (v > m) m = v; return _rn(m, 1); }
  function _minOf(a) { if (!a.length) return 0; let m = a[0]; for (const v of a) if (v < m) m = v; return _rn(m, 1); }
  // timeseries row -> points row (schema in CLAUDE.md).
  function _pointFromRow(r) { return [r[6], r[7], r[1], r[5], r[2], r[3], r[4], r[9], r[10], r[11], r[12], r[16], r[17]]; }
  function _statsFrom(points, ts) {
    const speeds = [], volts = [], temps = [], alts = [];
    for (const r of ts) {
      if (r[1] > 0) speeds.push(r[1]);
      if (r[2] !== 0) volts.push(r[2]);
      if (r[3] !== 0) temps.push(r[3]);
      if (r[5] !== 0) alts.push(r[5]);
    }
    let dist = 0;
    for (let i = 1; i < points.length; i++) dist += _hav(points[i - 1][0], points[i - 1][1], points[i][0], points[i][1]);
    let distanceKm = _rn(dist / 1000, 2);
    if (distanceKm === 0 && ts.length) {
      const m0 = ts[0][8] || 0, m1 = ts[ts.length - 1][8] || 0;
      if (m1 > m0) distanceKm = _rn(m1 - m0, 2);
    }
    return {
      points: points.length, rows: ts.length, distanceKm,
      maxSpeed: _maxOf(speeds),
      avgSpeed: speeds.length ? _rn(speeds.reduce((s, v) => s + v, 0) / speeds.length, 1) : 0,
      maxAlt: _maxOf(alts), minAlt: _minOf(alts),
      maxVoltage: _maxOf(volts), minVoltage: _minOf(volts),
      maxTemp: _maxOf(temps),
    };
  }
  function _downsampleTs(ts, limit) {
    limit = limit || 500;
    if (ts.length <= limit) return ts;
    const step = ts.length / limit, out = [];
    for (let i = 0; i < ts.length; i += step) out.push(ts[Math.floor(i)]);
    return out;
  }
  // The parser stores dateStart/dateEnd as naive local wall-clock ISO
  // strings (no Z) and reads them back with Date.parse (browser-local).
  // Re-derived pieces must match that convention, so format with LOCAL
  // components — toISOString() would round-trip through UTC and shift hours.
  function _localIso(ms) {
    const d = new Date(ms), p = (n, w) => String(n).padStart(w || 2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T` +
      `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
  }
  const _isoAt = (baseMs, ts0, sec) =>
    isFinite(baseMs) ? _localIso(baseMs + (sec - ts0) * 1000) : undefined;

  // Slice one track to [aSec, bSec) in its own timeseries clock. sec and
  // mileage columns are rebased to start at 0 so each piece looks native.
  function sliceTrackByTime(track, aSec, bSec, name) {
    const ts = track.timeseries;
    if (!Array.isArray(ts) || !ts.length) return null;
    const ts0 = ts[0][0];
    const rows = ts.filter((r) => r[0] >= aSec && r[0] < bSec);
    if (rows.length < 2) return null;
    const firstSec = rows[0][0], firstMile = rows[0][8] || 0;
    const outTs = rows.map((r) => {
      const c = r.slice();
      c[0] = _rn(r[0] - firstSec, 1);
      c[8] = _rn((r[8] || 0) - firstMile, 3);
      return c;
    });
    const outPoints = [];
    for (const r of rows) if (r[6] !== 0 || r[7] !== 0) outPoints.push(_pointFromRow(r));
    const baseMs = Date.parse(track.dateStart || "");
    const out = {
      name,
      date: track.date || (_isoAt(baseMs, ts0, firstSec) || "").slice(0, 10),
      dateStart: _isoAt(baseMs, ts0, rows[0][0]),
      dateEnd: _isoAt(baseMs, ts0, rows[rows.length - 1][0]),
      points: outPoints,
      timeseries: outTs,
      stats: _statsFrom(outPoints, outTs),
    };
    if (track.wheel) out.wheel = JSON.parse(JSON.stringify(track.wheel));
    if (track.wheels) out.wheels = JSON.parse(JSON.stringify(track.wheels));
    return out;
  }

  // Merge tracks (passed oldest->newest) into one continuous track. The
  // global clock preserves real wall-time gaps between rides; per-track
  // mileage accumulates across (never the straight-line hop between one
  // ride's end and the next's start — that's distance nobody rode); the
  // result is re-downsampled to the 500-row cap.
  function mergeTracksInTime(tracks, name) {
    const full = [];
    const base0 = Date.parse(tracks[0].dateStart || "");
    let cumMile = 0, sumDist = 0;
    tracks.forEach((tk, ti) => {
      const ts = tk.timeseries;
      if (!Array.isArray(ts) || !ts.length) return;
      const ts0 = ts[0][0], mile0 = ts[0][8] || 0;
      const tkMs = Date.parse(tk.dateStart || "");
      let baseSec;
      if (ti === 0) baseSec = 0;
      else if (isFinite(tkMs) && isFinite(base0)) baseSec = (tkMs - base0) / 1000;
      else baseSec = full.length ? full[full.length - 1][0] : 0;
      for (const r of ts) {
        const c = r.slice();
        c[0] = _rn(baseSec + (r[0] - ts0), 1);
        c[8] = _rn(cumMile + ((r[8] || 0) - mile0), 3);
        full.push(c);
      }
      cumMile += (ts[ts.length - 1][8] || 0) - mile0;
      sumDist += (tk.stats && tk.stats.distanceKm) || 0;
    });
    if (full.length < 2) return null;
    full.sort((a, b) => a[0] - b[0]);
    // Mileage was assigned in ride order; the clock sort keeps it monotonic
    // for adjacent rides, but combining time-overlapping rides (a trip plus
    // its own split parts) would interleave rows — clamp to non-decreasing.
    let mx = 0;
    for (const r of full) { if (r[8] < mx) r[8] = mx; else mx = r[8]; }
    const dsTs = _downsampleTs(full, currentGraphRes());
    const outPoints = [];
    for (const r of dsTs) if (r[6] !== 0 || r[7] !== 0) outPoints.push(_pointFromRow(r));
    const last = tracks[tracks.length - 1];
    const stats = _statsFrom(outPoints, dsTs);
    // The GPS-summed distance over the merged path would count the hop
    // between rides; the true ridden distance is the sum of the parts.
    stats.distanceKm = _rn(sumDist, 2);
    const out = {
      name,
      date: tracks[0].date || (tracks[0].dateStart || "").slice(0, 10),
      dateStart: tracks[0].dateStart,
      dateEnd: last.dateEnd || tracks[0].dateEnd,
      points: outPoints,
      timeseries: dsTs,
      stats,
    };
    const ids = [];
    for (const tk of tracks) for (const w of (wheelIdsOf(tk) || [])) {
      if (labelOfWheel(w) && !ids.some((x) => labelOfWheel(x) === labelOfWheel(w))) ids.push(w);
    }
    if (ids.length === 1) out.wheel = JSON.parse(JSON.stringify(ids[0]));
    else if (ids.length > 1) out.wheels = JSON.parse(JSON.stringify(ids));
    return out;
  }

  // Natural split points: recording gaps (time discontinuities) and long
  // stops (sustained near-zero speed). Wheel-change boundaries aren't
  // recoverable from the viewer's downsampled data, so they aren't offered.
  function detectCutPoints(track) {
    const ts = track.timeseries;
    const cuts = [];
    if (!Array.isArray(ts) || ts.length < 6) return cuts;
    const dts = [];
    for (let i = 1; i < ts.length; i++) dts.push(ts[i][0] - ts[i - 1][0]);
    const srt = dts.slice().sort((a, b) => a - b);
    const medDt = srt[Math.floor(srt.length / 2)] || 1;
    const gapTh = Math.max(60, medDt * 8);
    for (let i = 1; i < ts.length; i++) {
      const dt = ts[i][0] - ts[i - 1][0];
      if (dt > gapTh) cuts.push({ sec: (ts[i - 1][0] + ts[i][0]) / 2, kind: "gap", dur: dt });
    }
    const STOP_KMH = 1.5, STOP_SEC = 300;
    let runStart = null;
    for (let i = 0; i <= ts.length; i++) {
      const stopped = i < ts.length && (ts[i][1] || 0) < STOP_KMH;
      if (stopped && runStart === null) runStart = i;
      if ((!stopped || i === ts.length) && runStart !== null) {
        const a = ts[runStart][0], b = ts[Math.min(i, ts.length - 1)][0];
        if (b - a > STOP_SEC && !cuts.some((c) => Math.abs(c.sec - (a + b) / 2) < gapTh)) {
          cuts.push({ sec: (a + b) / 2, kind: "stop", dur: b - a });
        }
        runStart = null;
      }
    }
    cuts.sort((a, b) => a.sec - b.sec);
    return cuts;
  }

  // After structurally editing allTracks: re-sort newest-first (matching
  // loadTracks so inspector/studio indices line up), persist, and refresh
  // the panel + map without the full first-load choreography.
  function commitEditedTracks(toastMsg) {
    // Assign a NEW array (never mutate in place): the map's geometry and
    // metric-scale caches are keyed on the allTracks reference, so an
    // in-place sort/push would leave them stale and mis-indexed. This
    // mirrors loadTracks, which also replaces the reference.
    const next = allTracks.slice().sort((a, b) => {
      const pa = a.dateStart || ((a.date || "").split(".").reverse().join("-"));
      const pb = b.dateStart || ((b.date || "").split(".").reverse().join("-"));
      return String(pb).localeCompare(String(pa));
    });
    allTracks = next;
    trackVisible = new Set(allTracks.map((_, i) => i));
    selectedIdx = -1;
    document.querySelectorAll(".trip-item.active").forEach((el) => el.classList.remove("active"));
    if (tooltip) tooltip.classList.add("hidden");
    if (typeof hideChartMarker === "function") hideChartMarker();
    saveTracks(allTracks);
    buildTripList();
    updateGlow();
    updateVisibilityUI();
    fitAll();
    if (toastMsg) appToast(toastMsg);
  }

  // Highlight a freshly created trip (extend / split). buildTripList renders
  // cards in async idle chunks, so the row may not exist yet — poll a few
  // frames for it, then optionally select it (zooms the map, opens its group,
  // scrolls it in) and run the one-shot .trip-flash fade.
  function highlightNewTrip(track, doSelect) {
    let tries = 0;
    const step = () => {
      const idx = allTracks.indexOf(track);
      if (idx < 0) return;
      const li = document.querySelector(`.trip-item[data-idx="${idx}"]`);
      if (!li) { if (tries++ < 30) requestAnimationFrame(step); return; }
      if (doSelect) selectTrip(idx);
      li.classList.remove("trip-flash");
      void li.offsetWidth; // reflow so the animation restarts on re-flash
      li.classList.add("trip-flash");
      if (!doSelect) li.scrollIntoView({ block: "nearest" });
    };
    requestAnimationFrame(step);
  }

  // --- small time formatters for the dialogs ---
  function fmtClock(sec) {
    sec = Math.max(0, Math.round(sec));
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    const pad = (n) => String(n).padStart(2, "0");
    return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
  }
  function fmtGap(sec) {
    sec = Math.round(sec);
    if (sec < 90) return `${sec}s`;
    const m = Math.round(sec / 60);
    if (m < 60) return `${m} min`;
    const h = Math.floor(m / 60), mm = m % 60;
    return `${h}h ${String(mm).padStart(2, "0")}m`;
  }

  // --- Change wheel dialog ---
  function openChangeWheelDialog(i) {
    const t = allTracks[i];
    const groups = computeWheelGroups().filter((g) => !g.unknown);
    const cur = wheelLabelOf(t);
    let body = '<div class="tt-radios">';
    groups.forEach((g, gi) => {
      const on = g.label === cur ? " checked" : "";
      body += `<label class="tt-radio"><input type="radio" name="cw" value="g:${gi}"${on}><span>${escapeHtml(g.label)}</span></label>`;
    });
    body += `<label class="tt-radio"><input type="radio" name="cw" value="new"><span>New wheel…</span></label>`;
    body += `<div class="tt-newrow hidden"><input type="text" id="cw-name" placeholder="e.g. KS-16SZ or Lynx-2317" maxlength="60"></div>`;
    body += `<label class="tt-radio"><input type="radio" name="cw" value="none"${cur ? "" : " checked"}><span>No wheel</span></label>`;
    body += "</div>";
    const cancel = ttBtn("Cancel", "tt-ghost"); cancel.addEventListener("click", ttmodClose);
    const apply = ttBtn("Apply", "tt-primary");
    ttmodShow("WHEEL", "Change wheel",
      `<div class="tt-trip">${escapeHtml(formatTripLabel(t))}</div>`, body, [cancel, apply]);
    const nameRow = ttmod.querySelector(".tt-newrow"), nameInp = ttmod.querySelector("#cw-name");
    const sync = () => {
      const v = (ttmod.querySelector('input[name="cw"]:checked') || {}).value;
      nameRow.classList.toggle("hidden", v !== "new");
      if (v === "new") setTimeout(() => nameInp.focus(), 0);
    };
    ttmod.querySelectorAll('input[name="cw"]').forEach((r) => r.addEventListener("change", sync));
    sync();
    apply.addEventListener("click", () => {
      const v = (ttmod.querySelector('input[name="cw"]:checked') || {}).value;
      if (!v) return;
      let wheel = null;
      if (v === "none") wheel = null;
      else if (v === "new") {
        const nm = (nameInp.value || "").trim();
        if (!nm) { nameInp.focus(); return; }
        wheel = { name: nm };
      } else {
        const w = (groups[parseInt(v.slice(2))] || {}).wheel || {};
        wheel = { name: w.name, mac: w.mac, make: w.make, model: w.model, serial: w.serial };
      }
      applyWheelToTrip(i, wheel);
      ttmodClose();
      appToast(wheel ? `Wheel set to ${wheel.name || "wheel"}.` : "Wheel cleared.");
    });
  }

  // --- Split trip dialog ---
  function openSplitDialog(i) {
    const t = allTracks[i];
    const cuts = detectCutPoints(t);
    const sub = `<div class="tt-trip">${escapeHtml(formatTripLabel(t))}</div>` +
      `<div class="tt-facts">${fmtDurH(tripDurH(t))} · ${UNITS.dist(t.stats.distanceKm).toFixed(1)} ${UNITS.distUnit}</div>`;
    const cancel = ttBtn("Cancel", "tt-ghost"); cancel.addEventListener("click", ttmodClose);
    if (!cuts.length) {
      ttmodShow("SPLIT", "Split trip", sub,
        `<div class="tt-empty">No recording gaps or long stops to split on.</div>`,
        [cancel]);
      return;
    }
    const ts0 = t.timeseries[0][0];
    let body = `<div class="tt-hint">Cut the ride at these points. The original stays.</div><div class="tt-cuts">`;
    cuts.forEach((c) => {
      const why = c.kind === "gap" ? `recording gap of ${fmtGap(c.dur)}` : `stopped for ${fmtGap(c.dur)}`;
      body += `<label class="tt-cut"><input type="checkbox" class="tt-cutcb" data-sec="${c.sec}" checked>` +
        `<span class="tt-cut-when">${fmtClock(c.sec - ts0)}</span><span class="tt-cut-why">${why}</span></label>`;
    });
    body += "</div>";
    const go = ttBtn("Split", "tt-primary");
    ttmodShow("SPLIT", "Split trip", sub, body, [cancel, go]);
    const cbs = [...ttmod.querySelectorAll(".tt-cutcb")];
    const sync = () => {
      const n = cbs.filter((c) => c.checked).length;
      go.textContent = n ? `Split into ${n + 1} trips` : "Split";
      go.disabled = !n;
    };
    cbs.forEach((c) => c.addEventListener("change", sync));
    sync();
    go.addEventListener("click", () => {
      const secs = cbs.filter((c) => c.checked).map((c) => parseFloat(c.dataset.sec)).sort((a, b) => a - b);
      if (!secs.length) return;
      const bounds = [-Infinity, ...secs, Infinity];
      const segs = [];
      for (let k = 0; k < bounds.length - 1; k++) {
        const seg = sliceTrackByTime(t, bounds[k], bounds[k + 1], `${t.name || "Trip"} · part ${k + 1}`);
        if (seg) segs.push(seg);
      }
      if (segs.length < 2) { appToast("Couldn't split (segments too short)."); return; }
      // Split leaves the original untouched. Flag it for archive only when it's
      // Dropbox-backed, so the Sync dialog can move it out of /trips; otherwise
      // it just stays (remove it by hand if you want).
      if (t.dropboxPath) t._archive = true;
      allTracks.push(...segs);
      ttmodClose();
      commitEditedTracks(`Split into ${segs.length} trips.`);
      segs.forEach((s) => highlightNewTrip(s, false)); // highlight the fresh parts
    });
  }

  // --- Extend trip dialog ---
  function openExtendDialog(i) {
    const t = allTracks[i];
    // Chronological order (oldest -> newest). Extend spans a range around
    // "this trip": the From combo reaches BACK into older rides, the To
    // combo reaches FORWARD into newer ones, and "this trip" is the anchor
    // in both. Any span that includes this trip is valid — older→this,
    // this→newer, or older→newer.
    //
    // Hard guard against re-merging already-merged data. Two rules, both
    // filtering the picker's candidates (so no range can sweep them up either):
    //   1. Overlap: hide trips whose time overlaps THIS trip — the pieces
    //      already inside an extended trip, or the extended trip when the
    //      anchor is a piece.
    //   2. Containment: hide trips strictly inside a container that is ITSELF
    //      still selectable (doesn't overlap the anchor) — that's the combined
    //      parent of an unrelated third trip's range. When you split a trip the
    //      original overlaps every piece, so it's excluded by rule 1 and its
    //      pieces stay selectable — you can still recombine them even though the
    //      original is loaded.
    // Real rides never overlap in time, so this only removes combine/split
    // leftovers. Strict containment keeps duplicate-span imports from both
    // vanishing. The anchor is always kept (it shows as "This trip").
    const spanOf = (idx) => {
      const o = allTracks[idx];
      return [Date.parse(o.dateStart || ""), Date.parse(o.dateEnd || o.dateStart || "")];
    };
    const [aS, aE] = spanOf(i);
    const overlapsAnchor = (idx) => {
      if (idx === i) return false;
      const [s, e] = spanOf(idx);
      if (![s, e, aS, aE].every(isFinite)) return false;
      return s < aE && e > aS;
    };
    const containedInAnother = (idx) => {
      if (idx === i) return false;
      const [s, e] = spanOf(idx);
      if (!isFinite(s) || !isFinite(e)) return false;
      for (let j = 0; j < allTracks.length; j++) {
        if (j === idx || j === i) continue;
        if (overlapsAnchor(j)) continue; // container already excluded → its pieces are safe to show
        const [us, ue] = spanOf(j);
        if (!isFinite(us) || !isFinite(ue)) continue;
        if (us <= s && ue >= e && (us < s || ue > e)) return true; // strictly larger
      }
      return false;
    };
    const order = allTracks.map((_, idx) => idx)
      .filter((idx) => !overlapsAnchor(idx) && !containedInAnother(idx))
      .sort((a, b) => (Date.parse(allTracks[a].dateStart || "") || 0) - (Date.parse(allTracks[b].dateStart || "") || 0));
    const pos = order.indexOf(i); // this trip's chronological position
    const cancel = ttBtn("Cancel", "tt-ghost"); cancel.addEventListener("click", ttmodClose);
    const sub =
      `<div class="tt-trip">This trip <span class="tt-when">· ${escapeHtml(formatTripLabel(t))}</span></div>` +
      `<div class="tt-facts">${fmtDurH(tripDurH(t))} · ${UNITS.dist(t.stats.distanceKm).toFixed(1)} ${UNITS.distUnit}</div>`;
    if (order.length < 2) {
      ttmodShow("EXTEND", "Extend trip", sub,
        `<div class="tt-empty">No other trips to combine with.</div>`, [cancel]);
      return;
    }
    const hasOlder = pos > 0, hasNewer = pos < order.length - 1;
    // From = this trip then progressively older; To = this trip then newer.
    // Cap each direction so a big library doesn't make a giant dropdown.
    const MAX_EACH = 8;
    const fromPos = [pos]; for (let p = pos - 1; p >= 0 && fromPos.length <= MAX_EACH; p--) fromPos.push(p);
    const toPos = [pos]; for (let p = pos + 1; p < order.length && toPos.length <= MAX_EACH; p++) toPos.push(p);
    const optOf = (p) => `<option value="${p}">${p === pos ? "This trip" : escapeHtml(formatTripLabel(allTracks[order[p]]))}</option>`;
    const body =
      `<div class="tt-hint">Combine this trip with older or newer rides into one. Everything between comes along. Originals stay.</div>` +
      `<div class="tt-range">` +
        `<label>To (newer)<select id="ex-to"${hasNewer ? "" : " disabled"}>${toPos.map(optOf).join("")}</select></label>` +
        `<label>From (older)<select id="ex-from"${hasOlder ? "" : " disabled"}>${fromPos.map(optOf).join("")}</select></label>` +
      `</div><div class="tt-preview" id="ex-preview"></div>`;
    const go = ttBtn("Combine", "tt-primary");
    ttmodShow("EXTEND", "Extend trip", sub, body, [cancel, go]);
    const fromSel = ttmod.querySelector("#ex-from"), toSel = ttmod.querySelector("#ex-to");
    const preview = ttmod.querySelector("#ex-preview");
    const sync = () => {
      // From is this-trip-or-older, To is this-trip-or-newer, so a<=pos<=b
      // always holds and the span [a..b] always contains this trip.
      const a = parseInt(fromSel.value), b = parseInt(toSel.value);
      const idxs = [];
      for (let p = a; p <= b; p++) idxs.push(order[p]);
      let km = 0; idxs.forEach((idx) => { km += allTracks[idx].stats.distanceKm || 0; });
      const spanH = (Date.parse(allTracks[order[b]].dateEnd || allTracks[order[b]].dateStart || "") -
        Date.parse(allTracks[order[a]].dateStart || "")) / 3600000;
      preview.textContent = idxs.length < 2
        ? "Pick an older or newer trip."
        : `${idxs.length} trips → ${UNITS.dist(km).toFixed(1)} ${UNITS.distUnit}${isFinite(spanH) && spanH > 0 ? `, ${fmtDurH(spanH)} span` : ""}.`;
      go.disabled = idxs.length < 2;
      go._idxs = idxs;
    };
    fromSel.addEventListener("change", sync);
    toSel.addEventListener("change", sync);
    sync();
    go.addEventListener("click", () => {
      const idxs = (go._idxs || []).slice();
      if (idxs.length < 2) return;
      idxs.sort((a, b) => (Date.parse(allTracks[a].dateStart || "") || 0) - (Date.parse(allTracks[b].dateStart || "") || 0));
      const sources = idxs.map((idx) => allTracks[idx]);
      const merged = mergeTracksInTime(sources, "Combined ride");
      if (!merged) { appToast("Couldn't combine those trips."); return; }
      // The pieces are now redundant (their data lives in `merged`). Flag the
      // Dropbox-backed ones so the Sync dialog offers to archive them out of
      // /trips (a piece with no Dropbox origin has nothing to move).
      sources.forEach((t) => { if (t.dropboxPath) t._archive = true; });
      allTracks.push(merged);
      ttmodClose();
      commitEditedTracks(`Combined ${idxs.length} trips.`);
      // Select the new trip (zooms the map to it) and flash its row.
      highlightNewTrip(merged, true);
    });
  }

  function buildTripList() {
    tripList.innerHTML = "";
    const header = document.getElementById("panel-header");
    header.innerHTML = "";

    // Summary. Trips marked for archive are superseded (a combined trip's
    // pieces, or a split original) so they'd double-count — leave them out of
    // every total, including the count.
    let totalKm = 0, totalSec = 0, topSpeed = 0, activeTrips = 0;
    for (const t of allTracks) {
      if (t._archive) continue;
      activeTrips++;
      totalKm += t.stats.distanceKm;
      if (t.stats.maxSpeed > topSpeed) topSpeed = t.stats.maxSpeed;
      if (t.dateStart && t.dateEnd) {
        const s = new Date(t.dateStart).getTime();
        const e = new Date(t.dateEnd).getTime();
        if (s && e && e > s) totalSec += (e - s) / 1000;
      }
    }
    const hrs = Math.floor(totalSec / 3600);
    const mins = Math.round((totalSec % 3600) / 60);

    const summary = document.createElement("div");
    summary.className = "trip-summary";
    summary.innerHTML = `
      <div class="summary-row"><span>${activeTrips}</span> trips</div>
      <div class="summary-row"><span>${UNITS.dist(totalKm).toFixed(1)}</span> ${UNITS.distUnit}</div>
      <div class="summary-row"><span>${hrs}h ${mins}m</span> riding</div>
      <div class="summary-row"><span>${UNITS.speed(topSpeed).toFixed(0)}</span> ${UNITS.speedUnit} top</div>
    `;
    header.appendChild(summary);

    // One row: wheel selector on the left, Forensics on the right.
    // Forensics opens in a new tab (viewer state survives) scoped to the
    // selected wheel; "All wheels" opens the whole history. A library
    // with a single wheel, or none recorded at all, gets a disabled
    // selector that just states what's loaded, and Forensics opens
    // unscoped (it IS the whole history then).
    const wheelGroups = computeWheelGroups();
    let forensicsWheel = null; // null = whole library
    const wheelRow = document.createElement("div");
    wheelRow.className = "wheel-filter-row";
    const wheelSel = document.createElement("select");
    wheelSel.className = "wheel-filter";
    if (wheelGroups.length > 1) {
      wheelSel.innerHTML = '<option value="-1">All wheels (' + allTracks.length + ")</option>" +
        wheelGroups.map((g, gi) =>
          '<option value="' + gi + '">' + g.label + " (" + g.indices.length + ")</option>").join("");
      // Picking a wheel drives the same visibility set as the checkboxes,
      // so the map, summary, exports, trace colors and Forensics follow.
      wheelSel.addEventListener("change", (e) => {
        const gi = parseInt(e.target.value);
        forensicsWheel = gi < 0 ? null : wheelGroups[gi];
        trackVisible = gi < 0
          ? new Set(allTracks.map((_, i) => i))
          : new Set(wheelGroups[gi].indices);
        if (selectedIdx >= 0 && !trackVisible.has(selectedIdx)) {
          selectedIdx = -1;
          tooltip.classList.add("hidden");
          hideChartMarker();
          document.querySelectorAll(".trip-item.active").forEach(el => el.classList.remove("active"));
        }
        tripList.querySelectorAll(".trip-check").forEach(cb => {
          cb.checked = trackVisible.has(parseInt(cb.dataset.idx));
        });
        tripList.querySelectorAll(".month-group").forEach(g => updateGroupCheckbox(g));
        tripList.querySelectorAll(".year-group").forEach(g => updateYearCheckbox(g));
        updateGlow();
        updateVisibilityUI();
        fitAll();
      });
    } else {
      const only = wheelGroups[0];
      const label = only && !only.unknown ? only.label : "Generic wheel";
      wheelSel.innerHTML = "<option>" + label + " (" + allTracks.length + ")</option>";
      wheelSel.disabled = true;
      wheelSel.title = only && !only.unknown
        ? "Every loaded trip is from this wheel"
        : "None of the loaded trips carry a wheel identity; assign one in Batch edit";
    }
    const analyticsBtn = document.createElement("a");
    analyticsBtn.className = "forensics-btn";
    analyticsBtn.href = "analytics.html";
    analyticsBtn.target = "_blank";
    analyticsBtn.rel = "noopener";
    analyticsBtn.innerHTML = `
      <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" d="M1.5 13.5 5.5 8l3 3 6-8"/><circle cx="5.5" cy="8" r="1.2" fill="currentColor"/><circle cx="8.5" cy="11" r="1.2" fill="currentColor"/></svg>
      <span class="analytics-label">Forensics</span>`;
    // The whole-history analysis needs a real sample of rides before its
    // trends and fits mean anything; below the floor the button explains
    // itself instead of opening a page of empty sections.
    const MIN_FORENSICS_TRIPS = 5;
    if (allTracks.length < MIN_FORENSICS_TRIPS) {
      analyticsBtn.classList.add("disabled");
      analyticsBtn.removeAttribute("href");
      analyticsBtn.title = `${MIN_FORENSICS_TRIPS} trips required for the whole-history analysis (you have ${allTracks.length})`;
    }
    analyticsBtn.addEventListener("click", async (e) => {
      if (allTracks.length < MIN_FORENSICS_TRIPS) { e.preventDefault(); return; }
      if (!allTracks.length) return;
      // The IDB write started by handleFile() may not have landed yet,
      // and the new tab would open against an empty currentSession.
      // Block the native target=_blank, await the write, then open it
      // ourselves so the analytics page always sees fresh state.
      e.preventDefault();
      const label = analyticsBtn.querySelector(".analytics-label");
      const orig = label.textContent;
      label.textContent = "Preparing…";
      analyticsBtn.style.pointerEvents = "none";
      try { await pendingSessionWrite; } catch (_) {}
      const scope = forensicsWheel
        ? "?wheel=" + encodeURIComponent(forensicsWheel.unknown ? "__unknown__" : forensicsWheel.key)
        : "";
      window.open("analytics.html" + scope, "_blank", "noopener");
      label.textContent = orig;
      analyticsBtn.style.pointerEvents = "";
    });
    wheelRow.appendChild(wheelSel);
    wheelRow.appendChild(analyticsBtn);
    header.appendChild(wheelRow);

    // "All trips" checkbox row with expand/collapse buttons
    const allRow = document.createElement("div");
    allRow.className = "all-trips-row";
    allRow.innerHTML = `
      <label title="Show or hide every trip"><input type="checkbox" class="all-check" checked> All</label>
      <div class="tree-actions">
        <span class="tree-btn manage-trips" title="Batch edit: assign wheels or remove across many trips at once">
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <rect x="2" y="2.5" width="5" height="5" rx="1"/><rect x="9" y="2.5" width="5" height="5" rx="1"/><rect x="2" y="9.5" width="5" height="5" rx="1"/><rect x="9" y="9.5" width="5" height="5" rx="1"/>
          </svg>
          Batch
        </span>
        <span class="tree-btn customize-detail" title="Customize which details show under a trip (reorder / hide)">
          <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true">
            <path d="M2 4h9M2 8h6M2 12h9"/><circle cx="13" cy="4" r="1.6"/><circle cx="10" cy="8" r="1.6"/><circle cx="13" cy="12" r="1.6"/>
          </svg>
          Customize
        </span>
        <span class="tree-btn expand-all" title="Expand all">
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <polyline points="4 6 8 2 12 6"/>
            <polyline points="4 10 8 14 12 10"/>
          </svg>
        </span>
        <span class="tree-btn collapse-all" title="Collapse all">
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <polyline points="4 2 8 6 12 2"/>
            <polyline points="4 14 8 10 12 14"/>
          </svg>
        </span>
      </div>
    `;
    allRow.querySelector(".all-check").addEventListener("change", (e) => {
      if (e.target.checked) {
        trackVisible = new Set(allTracks.map((_, i) => i));
      } else {
        trackVisible = new Set();
        if (selectedIdx >= 0) {
          selectedIdx = -1;
          tooltip.classList.add("hidden");
          hideChartMarker();
          document.querySelectorAll(".trip-item.active").forEach(el => el.classList.remove("active"));
        }
      }
      tripList.querySelectorAll(".trip-check").forEach(cb => {
        const idx = parseInt(cb.dataset.idx);
        cb.checked = trackVisible.has(idx);
      });
      // Sync month and year checkboxes
      tripList.querySelectorAll(".month-group").forEach(g => updateGroupCheckbox(g));
      tripList.querySelectorAll(".year-group").forEach(g => updateYearCheckbox(g));
      updateGlow();
      updateVisibilityUI();
    });
    allRow.querySelector(".manage-trips").addEventListener("click", openTripManager);
    allRow.querySelector(".customize-detail").addEventListener("click", openDetailCustomize);
    allRow.querySelector(".expand-all").addEventListener("click", () => {
      tripList.querySelectorAll(".year-group, .month-group").forEach(g => g.classList.add("expanded"));
    });
    allRow.querySelector(".collapse-all").addEventListener("click", () => {
      tripList.querySelectorAll(".year-group, .month-group").forEach(g => g.classList.remove("expanded"));
      deselectIfHidden();
    });
    header.appendChild(allRow);

    // Group trips by year > month
    const MONTH_NAMES = ["January","February","March","April","May","June","July","August","September","October","November","December"];
    const yearOrder = [];
    const yearMap = {};
    allTracks.forEach((t, i) => {
      let year = "Unknown", month = "Unknown";
      const ds = t.dateStart || "";
      if (ds) {
        const d = new Date(ds);
        if (!isNaN(d)) { year = String(d.getFullYear()); month = MONTH_NAMES[d.getMonth()]; }
      } else if (t.date) {
        const parts = t.date.split(".");
        if (parts.length === 3) { year = parts[2]; month = MONTH_NAMES[parseInt(parts[1], 10) - 1]; }
      }
      if (!yearMap[year]) { yearMap[year] = { year, monthOrder: [], monthMap: {} }; yearOrder.push(yearMap[year]); }
      const ym = yearMap[year];
      if (!ym.monthMap[month]) { ym.monthMap[month] = { month, indices: [] }; ym.monthOrder.push(ym.monthMap[month]); }
      ym.monthMap[month].indices.push(i);
    });

    const COLORS = {
      distance: "#66bb6a", speed: "#00e5ff", voltage: "#ff5252",
      temp: "#ffa000", battery: "#69f0ae", altitude: "#ce93d8",
    };

    function buildTripItem(t, i) {
      const li = document.createElement("div");
      li.className = "trip-item" + (t._archive ? " trip-archived" : "");
      li.dataset.idx = i;
      const s = t.stats;

      let detailHtml = buildDetailHtml(t);
      detailHtml += `<div class="chart-wrap"><canvas class="trip-chart" data-idx="${i}"></canvas></div>`;

      const dur = fmtDurH(tripDurH(t));
      const durBit = dur ? ` &middot; ${dur}` : "";
      const meta = s.points > 0
        ? `${UNITS.dist(s.distanceKm).toFixed(2)} ${UNITS.distUnit} &middot; ${UNITS.speed(s.maxSpeed).toFixed(0)} ${UNITS.speedUnit} max${durBit}`
        : `No GPS &middot; ${UNITS.speed(s.maxSpeed).toFixed(0)} ${UNITS.speedUnit} max${durBit} &middot; ${(s.rows || 0).toLocaleString()} samples`;

      li.innerHTML = `
        <div class="trip-header">
          <input type="checkbox" class="trip-check" data-idx="${i}" ${trackVisible.has(i) ? "checked" : ""}>
          <div class="trip-info">
            <div class="trip-title-row">
              <div class="trip-date">${formatTripLabel(t)}</div>
              ${t.dropboxPath ? `
              <button type="button" class="share-btn" data-idx="${i}" title="Copy a shareable viewer link">
                <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="3.5" r="2"/><circle cx="4" cy="8" r="2"/><circle cx="12" cy="12.5" r="2"/><line x1="5.7" y1="7" x2="10.3" y2="4.5"/><line x1="5.7" y1="9" x2="10.3" y2="11.5"/></svg>
              </button>` : ""}
              <button type="button" class="tools-btn" data-idx="${i}" aria-label="Trip tools" title="Trip tools: share, inspect, change wheel, split, extend, remove">
                <svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor"><path d="M22.7 19l-9.1-9.1c.9-2.3.4-5-1.5-6.9-2-2-5-2.4-7.4-1.3L9 6 6 9 1.6 4.7C.4 7.1.9 10.1 2.9 12.1c1.9 1.9 4.6 2.4 6.9 1.5l9.1 9.1c.4.4 1 .4 1.4 0l2.3-2.3c.5-.4.5-1.1.1-1.4z"/></svg>
                <svg class="tools-caret" viewBox="0 0 16 16" width="9" height="9" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 6 8 10 12 6"/></svg>
              </button>
            </div>
            <div class="trip-meta">${meta}</div>
          </div>
        </div>
        <div class="trip-detail-inline">${detailHtml}</div>
      `;

      li.querySelector(".trip-check").addEventListener("change", (e) => {
        e.stopPropagation();
        const idx = parseInt(e.target.dataset.idx);
        if (e.target.checked) {
          trackVisible.add(idx);
        } else {
          trackVisible.delete(idx);
          if (selectedIdx === idx) {
            selectedIdx = -1;
            tooltip.classList.add("hidden");
            hideChartMarker();
            li.classList.remove("active");
          }
        }
        updateGlow();
        updateVisibilityUI();
        updateGroupCheckbox(li.closest(".month-group"));
      });

      // Click a togglable detail-row name to hide / re-show that series on
      // the mini chart. Click is stopped so it doesn't bubble to selectTrip.
      li.querySelectorAll('.detail-row[data-toggle="1"]').forEach(row => {
        row.addEventListener("click", (e) => {
          e.stopPropagation();
          row.classList.toggle("series-off");
          const canvas = li.querySelector(".trip-chart");
          if (canvas && canvas.offsetWidth > 0) {
            drawChart(canvas, parseInt(canvas.dataset.idx));
            if (canvas._persistCrosshair != null) drawCrosshair(canvas, canvas._persistCrosshair);
          }
        });
      });

      const toolsBtn = li.querySelector(".tools-btn");
      if (toolsBtn) {
        toolsBtn.addEventListener("click", (e) => {
          e.stopPropagation();
          toggleToolsMenu(toolsBtn, i);
        });
      }

      // Quick share icon (Dropbox trips) — copies the viewer link; the tools
      // menu's "Share with viewer" is the same action, kept as an extra.
      const shareBtn = li.querySelector(".share-btn");
      if (shareBtn) {
        shareBtn.addEventListener("click", (e) => { e.stopPropagation(); shareTripLink(i, "viewer"); });
      }

      li.addEventListener("click", (e) => {
        if (e.target.closest(".trip-check")) return;
        if (e.target.closest(".inspect-btn")) { e.stopPropagation(); return; }
        if (e.target.closest(".share-btn")) { e.stopPropagation(); return; }
        if (e.target.closest(".tools-btn")) { e.stopPropagation(); return; }
        if (e.target.closest(".chart-wrap")) return;
        if (e.target.closest('.detail-row[data-toggle="1"]')) return;
        selectTrip(i);
      });
      return li;
    }

    function updateGroupCheckbox(groupEl) {
      if (!groupEl) return;
      const cb = groupEl.querySelector(":scope > .month-header > .month-check");
      if (!cb) return;
      const checks = groupEl.querySelectorAll(".trip-check");
      const total = checks.length;
      let checked = 0;
      checks.forEach(c => { if (c.checked) checked++; });
      cb.checked = checked === total;
      cb.indeterminate = checked > 0 && checked < total;
      // Bubble up to year group
      const yearEl = groupEl.closest(".year-group");
      if (yearEl) updateYearCheckbox(yearEl);
    }

    function updateYearCheckbox(yearEl) {
      if (!yearEl) return;
      const cb = yearEl.querySelector(":scope > .year-header > .year-check");
      if (!cb) return;
      const checks = yearEl.querySelectorAll(".trip-check");
      const total = checks.length;
      let checked = 0;
      checks.forEach(c => { if (c.checked) checked++; });
      cb.checked = checked === total;
      cb.indeterminate = checked > 0 && checked < total;
    }

    function setGroupChecked(container, checked) {
      // Collect every month body inside this container (yearbody contains
      // several, monthbody is itself one). Update trackVisible from the
      // stashed index list so unbuilt cards toggle too.
      const bodies = container.classList.contains("month-body")
        ? [container]
        : Array.from(container.querySelectorAll(".month-body"));
      for (const body of bodies) {
        const indices = body._tripIndices || [];
        for (const idx of indices) {
          if (checked) trackVisible.add(idx);
          else {
            trackVisible.delete(idx);
            if (selectedIdx === idx) {
              selectedIdx = -1;
              const item = body.querySelector(`.trip-item[data-idx="${idx}"]`);
              if (item) item.classList.remove("active");
            }
          }
        }
      }
      // Sync any already-built checkboxes inside the container.
      container.querySelectorAll(".trip-check").forEach(cb => { cb.checked = checked; });
      container.querySelectorAll(".month-group").forEach(g => updateGroupCheckbox(g));
    }

    // Render year > month groups
    const singleYear = yearOrder.length === 1;
    let firstMonth = true;

    yearOrder.forEach((yg, yi) => {
      const yearEl = document.createElement("div");
      yearEl.className = "year-group";

      // If multiple years, render a year header
      if (!singleYear) {
        // Archived (superseded) trips don't count toward the group totals.
        const activeOf = (idxs) => idxs.filter((i) => !allTracks[i]._archive);
        const yearKm = yg.monthOrder.reduce((s, mg) => s + activeOf(mg.indices).reduce((s2, i) => s2 + allTracks[i].stats.distanceKm, 0), 0);
        const yearTrips = yg.monthOrder.reduce((s, mg) => s + activeOf(mg.indices).length, 0);

        const yHeader = document.createElement("div");
        yHeader.className = "year-header";
        yHeader.innerHTML = `
          <input type="checkbox" class="year-check" checked>
          <span class="year-label">${yg.year}</span>
          <span class="year-meta">${yearTrips} trips &middot; ${UNITS.dist(yearKm).toFixed(1)} ${UNITS.distUnit}</span>
          <span class="year-chevron">&#9662;</span>
        `;

        const yBody = document.createElement("div");
        yBody.className = "year-body";
        // Expand the first (latest) year
        if (yi === 0) yearEl.classList.add("expanded");

        yHeader.querySelector(".year-check").addEventListener("change", (e) => {
          e.stopPropagation();
          setGroupChecked(yBody, e.target.checked);
          updateGlow();
          updateVisibilityUI();
        });

        yHeader.addEventListener("click", (e) => {
          if (e.target.closest(".year-check")) return;
          yearEl.classList.toggle("expanded");
          deselectIfHidden();
        });

        // Build months inside year body
        yg.monthOrder.forEach(mg => {
          yBody.appendChild(buildMonthGroup(mg, firstMonth));
          firstMonth = false;
        });

        yearEl.appendChild(yHeader);
        yearEl.appendChild(yBody);
      } else {
        // Single year: just render months directly
        yg.monthOrder.forEach(mg => {
          yearEl.appendChild(buildMonthGroup(mg, firstMonth));
          firstMonth = false;
        });
      }

      tripList.appendChild(yearEl);
    });

    function buildMonthGroup(mg, expandByDefault) {
      const groupEl = document.createElement("div");
      groupEl.className = "month-group";
      // Archived (superseded) trips don't count toward the group totals.
      const activeMonthIdx = mg.indices.filter((i) => !allTracks[i]._archive);
      const groupKm = activeMonthIdx.reduce((sum, i) => sum + allTracks[i].stats.distanceKm, 0);
      const groupDur = fmtDurH(activeMonthIdx.reduce((sum, i) => sum + tripDurH(allTracks[i]), 0));

      const header = document.createElement("div");
      header.className = "month-header";
      header.innerHTML = `
        <input type="checkbox" class="month-check" checked>
        <span class="month-label">${mg.month}</span>
        <span class="month-meta">${activeMonthIdx.length} trips &middot; ${UNITS.dist(groupKm).toFixed(1)} ${UNITS.distUnit}${groupDur ? ` &middot; ${groupDur}` : ""}</span>
        <span class="month-chevron">&#9662;</span>
      `;

      const body = document.createElement("div");
      body.className = "month-body";
      // Stash the index list so setGroupChecked can toggle visibility
      // even before the chunked card build has materialised the .trip-check
      // checkboxes for this month.
      body._tripIndices = mg.indices.slice();
      if (expandByDefault) groupEl.classList.add("expanded");

      header.querySelector(".month-check").addEventListener("change", (e) => {
        e.stopPropagation();
        setGroupChecked(body, e.target.checked);
        const yearEl = groupEl.closest(".year-group");
        if (yearEl) updateYearCheckbox(yearEl);
        updateGlow();
        updateVisibilityUI();
      });

      header.addEventListener("click", (e) => {
        if (e.target.closest(".month-check")) return;
        groupEl.classList.toggle("expanded");
        deselectIfHidden();
      });

      // Build only the first few cards synchronously so the panel feels
      // instant; queue the rest in idle chunks. For 244-trip libraries
      // this drops the single 500–900 ms long-task warning to a series
      // of short yields without changing the final DOM.
      const SYNC_FIRST = expandByDefault ? 8 : 0;
      for (let k = 0; k < Math.min(SYNC_FIRST, mg.indices.length); k += 1) {
        body.appendChild(buildTripItem(allTracks[mg.indices[k]], mg.indices[k]));
      }
      if (SYNC_FIRST < mg.indices.length) {
        scheduleCardChunks(body, mg.indices.slice(SYNC_FIRST));
      }
      groupEl.appendChild(header);
      groupEl.appendChild(body);
      return groupEl;
    }

    // Chunked card builder: appends ~20 cards per idle slice so a 244-trip
    // library never blocks the main thread for more than a few frames.
    // Falls back to setTimeout(0) on browsers without requestIdleCallback.
    function scheduleCardChunks(body, indices) {
      const CHUNK = 20;
      let i = 0;
      const step = () => {
        // A later buildTripList() clears the list (detaching this body) and may
        // shrink allTracks (archive/remove). Bail so stale chunks don't build
        // against indices that no longer exist.
        if (!body.isConnected) return;
        const end = Math.min(i + CHUNK, indices.length);
        for (let j = i; j < end; j += 1) {
          const tk = allTracks[indices[j]];
          if (!tk) continue;
          body.appendChild(buildTripItem(tk, indices[j]));
        }
        i = end;
        if (i < indices.length) {
          if (typeof requestIdleCallback === "function") {
            requestIdleCallback(step, { timeout: 250 });
          } else {
            setTimeout(step, 0);
          }
        }
      };
      // Kick off the first deferred chunk on the next macrotask so it
      // doesn't pile back onto the current call stack.
      setTimeout(step, 0);
    }

    // Footer: add more + selected summary + export
    const footer = document.getElementById("panel-footer");
    footer.innerHTML = "";

    const navRow = document.createElement("div");
    navRow.className = "footer-nav-row";

    const addBtn = document.createElement("label");
    addBtn.className = "add-more-btn";
    addBtn.innerHTML = `+ Add more <input type="file" accept=".zip,.dbb,.csv,.gpx,.xlsx" style="display:none" />`;
    addBtn.querySelector("input").addEventListener("change", (e) => {
      if (e.target.files[0]) handleFile(e.target.files[0], true);
    });
    addBtn.addEventListener("dragover", (e) => { e.preventDefault(); addBtn.classList.add("dragover"); });
    addBtn.addEventListener("dragleave", () => addBtn.classList.remove("dragover"));
    addBtn.addEventListener("drop", (e) => {
      e.preventDefault();
      addBtn.classList.remove("dragover");
      if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0], true);
    });
    navRow.appendChild(addBtn);

    const homeBtn = document.createElement("div");
    homeBtn.className = "main-screen-btn";
    // Direction-neutral: a ?file= deep link lands here without ever having
    // seen the load screen, so "Back to main screen" read strangely.
    homeBtn.textContent = "Home";
    homeBtn.addEventListener("click", () => navigate("#load"));
    navRow.appendChild(homeBtn);

    footer.appendChild(navRow);

    const selSummary = document.createElement("div");
    selSummary.className = "trip-summary selected-summary hidden";
    footer.appendChild(selSummary);

    const exportBtn = document.createElement("div");
    exportBtn.className = "export-btn";
    renderExportButton(exportBtn);
    footer.appendChild(exportBtn);

    // Save trips + edits (names, wheels, merged/split) back to Dropbox so they
    // survive a re-import. Opens a dialog that handles connect / sync.
    const dbxSaveBtn = document.createElement("button");
    dbxSaveBtn.type = "button";
    dbxSaveBtn.className = "dbx-save-btn";
    dbxSaveBtn.innerHTML = `<span class="dbx-sync-label">Synchronize with</span><span class="dbx-sync-chip">Dropbox</span>`;
    dbxSaveBtn.title = "Sync trips and your edits (names, wheels) with Dropbox, or load new ones";
    dbxSaveBtn.addEventListener("click", () => openDropboxSyncDialog());
    footer.appendChild(dbxSaveBtn);

    updateVisibilityUI();
  }

  // Selection-aware export bar. Idempotent: safe to call on every UI refresh.
  //   0 selected     → static "Export selected" label, dimmed
  //   1 selected     → "Export trip" + .csv / .xlsx / .gpx / .zip chips
  //   1<n<total      → "Export selected (N)" + .zip chip
  //   n === total    → "Export all"          + .zip chip
  function renderExportButton(exportBtn) {
    const n = trackVisible.size;
    const total = allTracks.length;
    exportBtn.onclick = null;
    if (n === 0) {
      exportBtn.classList.remove("single-mode");
      exportBtn.textContent = "Select trip(s) to export";
      exportBtn.style.opacity = "0.3";
      return;
    }
    exportBtn.style.opacity = "";
    exportBtn.classList.add("single-mode");
    let label;
    let chips;
    if (n === 1) {
      label = "Export trip";
      chips = [["csv", ".csv"], ["xlsx", ".xlsx"], ["gpx", ".gpx"], ["dbb", ".zip"]];
    } else if (n === total) {
      label = "Export all";
      chips = [["dbb", ".zip"]];
    } else {
      label = `Export selected (${n})`;
      chips = [["dbb", ".zip"]];
    }
    exportBtn.innerHTML =
      `<span class="export-label">${label}</span>` +
      chips.map(([f, lbl]) => `<span class="export-fmt" data-fmt="${f}">${lbl}</span>`).join("");
    exportBtn.querySelectorAll(".export-fmt").forEach((chip) => {
      chip.addEventListener("click", async (e) => {
        e.stopPropagation();
        if (chip.getAttribute("aria-busy") === "true") return;
        chip.setAttribute("aria-busy", "true");
        try {
          if (chip.dataset.fmt === "dbb") await exportSelected();
          else await exportSingle(chip.dataset.fmt);
        } finally {
          chip.removeAttribute("aria-busy");
        }
      });
    });
  }

  // --- Export ---
  // When the viewer is set to Imperial, CSV/XLSX exports append three
  // derived columns at the END so they can't interfere: every parser in
  // the ecosystem (this viewer, EUC Planet's importer, DarknessBot) reads
  // columns by header name and ignores trailing extras, and on re-import
  // the derived columns are simply dropped and regenerated on the next
  // export, so they never compound. Metric exports stay byte-identical
  // to before.
  const IMPERIAL_COLS = ["Speed (mph)", "Trip distance (mi)", "Temperature (F)"];
  function imperialVals(speedKmh, tripKm, tempC) {
    return [
      ((speedKmh || 0) * 0.621371).toFixed(1),
      ((tripKm || 0) * 0.621371).toFixed(3),
      ((tempC || 0) * 9 / 5 + 32).toFixed(1),
    ];
  }
  // Trip-distance source for the imperial column: the recorded mileage
  // delta when the odometer actually moves; many wheels repeat a stale
  // total for the whole ride, so fall back to cumulative GPS distance.
  function exportCumKm(track) {
    const ts = track.timeseries;
    for (const r of ts) if (r[8] > 0.001) return ts.map((r2) => r2[8] || 0);
    const cum = getCumDistTs(track);
    // Straight lines between downsampled rows cut corners, so the GPS sum
    // lands short of the trip's true length; rescale so the last value
    // matches the full-resolution distance shown everywhere else.
    const last = cum[cum.length - 1] || 0;
    const total = (track.stats && track.stats.distanceKm) || 0;
    if (last > 0 && total > 0) {
      const k = total / last;
      return Array.from(cum, (v) => v * k);
    }
    return cum;
  }

  // Wheel identity as Extra-column pairs (EUC Planet's event convention),
  // so exports keep the wheel attribution in-file, not just in the name.
  function wheelExtraPairs(track) {
    const w = track && track.wheel;
    if (!w) return [];
    const clean = (v) => String(v).replace(/[,"\r\n]+/g, " ").trim();
    const out = [];
    if (w.name) out.push("wheel.name=" + clean(w.name));
    if (w.mac) out.push("wheel.mac=" + clean(w.mac));
    if (w.make) out.push("wheel.brand=" + clean(w.make));
    if (w.model) out.push("wheel.model=" + clean(w.model));
    if (w.serial) out.push("wheel.serial=" + clean(w.serial));
    return out;
  }

  // Trip name + wheel identity as Extra-column pairs, so a user's custom name
  // and wheel ride inside the CSV/XLSX itself and survive an export or Dropbox
  // round-trip (the parser reads them back — no separate metadata file).
  function extraMetaPairs(track) {
    const clean = (v) => String(v).replace(/[,"\r\n]+/g, " ").trim();
    const out = [];
    if (track && track.customName) out.push("trip.name=" + clean(track.customName));
    return out.concat(wheelExtraPairs(track));
  }

  function trackToCSV(track) {
    const imp = UNITS.imperial;
    const wheelPairs = extraMetaPairs(track);
    // Full telemetry export: every column the viewer carries, so a .csv export
    // or Dropbox round-trip loses nothing (older exports left PWM/Current/Power/
    // mileage empty and dropped GPS speed + G-Force). Columns resolve by header
    // name on re-import, so order is free; trailing ones are absent on legacy
    // cached tracks (guarded to "").
    const header = "Date,Speed,Voltage,PWM,Current,Power,Battery level,Total mileage,Temperature,Latitude,Longitude,Altitude,GPS speed,G-Force,G-Force X,G-Force Y,Torque,Phase current"
      + (imp ? "," + IMPERIAL_COLS.join(",") : "")
      + (wheelPairs.length ? ",Extra" : "") + "\n";
    let csv = header;
    const t0 = track.dateStart ? new Date(track.dateStart).getTime() : 0;
    const cum = imp ? exportCumKm(track) : null;
    const ts = track.timeseries;
    const g = (row, k) => (row[k] === undefined ? "" : row[k]);
    for (let i = 0; i < ts.length; i++) {
      const row = ts[i];
      let dateStr = "";
      if (t0) {
        const d = new Date(t0 + row[0] * 1000);
        dateStr = d.toISOString().replace("Z", "");
      }
      const cols = [dateStr, g(row, 1), g(row, 2), g(row, 9), g(row, 10), g(row, 11),
        g(row, 4), g(row, 8), g(row, 3), g(row, 6), g(row, 7), g(row, 5),
        g(row, 12), g(row, 13), g(row, 14), g(row, 15), g(row, 16), g(row, 17)];
      if (imp) cols.push(...imperialVals(row[1], cum[i], row[3]));
      if (wheelPairs.length) cols.push(i < wheelPairs.length ? wheelPairs[i] : "");
      csv += cols.join(",") + "\n";
    }
    return csv;
  }

  // Minimal GPX 1.1: one trkseg, every point with optional time / ele / speed.
  // Drops rows without lat/lon — euc.world's first samples often lack a fix.
  function trackToGPX(track) {
    const xmlEsc = (s) => String(s).replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" }[c]));
    const name = xmlEsc(track.name || "trip");
    const t0 = track.dateStart ? new Date(track.dateStart).getTime() : 0;
    const lines = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<gpx version="1.1" creator="eucviewer" xmlns="http://www.topografix.com/GPX/1/1">',
      `<trk><name>${name}</name><trkseg>`,
    ];
    for (const row of track.timeseries) {
      const lat = row[6], lon = row[7];
      if (typeof lat !== "number" || typeof lon !== "number" || (lat === 0 && lon === 0)) continue;
      const ele = row[5];
      const speed = row[1];
      const t = t0 ? new Date(t0 + row[0] * 1000).toISOString() : null;
      lines.push(
        `<trkpt lat="${lat}" lon="${lon}">` +
          (typeof ele === "number" ? `<ele>${ele.toFixed(1)}</ele>` : "") +
          (t ? `<time>${t}</time>` : "") +
          (typeof speed === "number" ? `<extensions><speed>${(speed / 3.6).toFixed(2)}</speed></extensions>` : "") +
        "</trkpt>"
      );
    }
    lines.push("</trkseg></trk></gpx>");
    return lines.join("\n");
  }

  let xlsxLibPromise = null;
  function loadXlsxLib() {
    // SheetJS is only fetched the first time a user actually wants .xlsx out.
    if (xlsxLibPromise) return xlsxLibPromise;
    xlsxLibPromise = new Promise((resolve, reject) => {
      if (typeof XLSX !== "undefined") return resolve(XLSX);
      const s = document.createElement("script");
      s.src = "https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js";
      s.onload = () => (typeof XLSX !== "undefined" ? resolve(XLSX) : reject(new Error("xlsx not available")));
      s.onerror = () => reject(new Error("failed to load xlsx library"));
      document.head.appendChild(s);
    }).catch((e) => { xlsxLibPromise = null; throw e; });
    return xlsxLibPromise;
  }

  async function trackToXlsxBlob(track) {
    const XLSXLib = await loadXlsxLib();
    const t0 = track.dateStart ? new Date(track.dateStart).getTime() : 0;
    const imp = UNITS.imperial;
    const headerRow = ["Date", "Speed", "Voltage", "PWM", "Current", "Power", "Battery level",
                       "Total mileage", "Temperature", "Latitude", "Longitude", "Altitude", "GPS speed"];
    if (imp) headerRow.push(...IMPERIAL_COLS);
    const wheelPairs = extraMetaPairs(track);
    if (wheelPairs.length) headerRow.push("Extra");
    const rows = [headerRow];
    const cum = imp ? exportCumKm(track) : null;
    const ts = track.timeseries;
    for (let i = 0; i < ts.length; i++) {
      const r = ts[i];
      const cols = [
        t0 ? new Date(t0 + r[0] * 1000).toISOString().replace("Z", "") : "",
        r[1] || "", r[2] || "", r[9] || "", r[10] || "", r[11] || "",
        r[4] || "", r[8] || "", r[3] || "", r[6] || "", r[7] || "", r[5] || "",
        r[12] || "",
      ];
      if (imp) cols.push(...imperialVals(r[1], cum[i], r[3]));
      if (wheelPairs.length) cols.push(i < wheelPairs.length ? wheelPairs[i] : "");
      rows.push(cols);
    }
    const ws = XLSXLib.utils.aoa_to_sheet(rows);
    const wb = XLSXLib.utils.book_new();
    XLSXLib.utils.book_append_sheet(wb, ws, "trip");
    const buf = XLSXLib.write(wb, { type: "array", bookType: "xlsx" });
    return new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  async function exportSingle(format) {
    const indices = [...trackVisible];
    if (indices.length !== 1) return;
    const track = allTracks[indices[0]];
    const baseName = track.name || "trip";
    try {
      if (format === "csv") {
        downloadBlob(new Blob([trackToCSV(track)], { type: "text/csv" }), baseName + ".csv");
      } else if (format === "gpx") {
        downloadBlob(new Blob([trackToGPX(track)], { type: "application/gpx+xml" }), baseName + ".gpx");
      } else if (format === "xlsx") {
        const blob = await trackToXlsxBlob(track);
        downloadBlob(blob, baseName + ".xlsx");
      }
    } catch (e) {
      alert("Export failed: " + (e.message || e));
    }
  }

  async function exportSelected() {
    const indices = [...trackVisible];
    if (indices.length === 0) return;
    if (typeof JSZip === "undefined") {
      alert("Export library not loaded. Please refresh and try again.");
      return;
    }
    // Always a .zip — even for a single trip (the raw single-file formats
    // live on their own chips). Plain .zip: phones and desktops open it
    // natively, and unzipping straight into Dropbox/Apps/EUC Planet/trips
    // just works. The importer accepts .dbb and .zip alike.
    const zip = new JSZip();
    for (const idx of indices) {
      const track = allTracks[idx];
      zip.file((track.name || `trip_${idx}`) + ".csv", trackToCSV(track));
    }
    const blob = await zip.generateAsync({ type: "blob", compression: "DEFLATE" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = indices.length === 1
      ? ((allTracks[indices[0]].name || "trip") + ".zip")
      : "trips_export.zip";
    a.click();
    URL.revokeObjectURL(url);
  }

  // --- Mini chart rendering ---
  const CHART_COLORS = {
    speed:    "#00e5ff",
    voltage:  "#ff5252",
    temp:     "#ffa000",
    battery:  "#69f0ae",
    altitude: "#ce93d8",
    pwm:      "#ff4081",
    current:  "#ffd740",
    power:    "#7c4dff",
  };

  // GPS speed (timeseries index 12) rides on the speed line's axis as a dashed
  // companion. Absent on legacy tracks — every read of it is guarded.
  const GPS_SPEED_IDX = 12;
  const GPS_SPEED_COLOR = "#80d8ff";
  function trackHasGpsSpeed(ts) {
    if (!ts) return false;
    for (const row of ts) {
      const v = row[GPS_SPEED_IDX];
      if (typeof v === "number" && v !== 0) return true;
    }
    return false;
  }

  const SERIES = [
    { idx: 1,  key: "speed",    label: "Speed",   unit: "km/h" },
    { idx: 9,  key: "pwm",      label: "PWM",     unit: "%" },
    { idx: 11, key: "power",    label: "Power",   unit: "W" },
    { idx: 10, key: "current",  label: "Current", unit: "A" },
    { idx: 2,  key: "voltage",  label: "Voltage", unit: "V" },
    { idx: 3,  key: "temp",     label: "Temp",    unit: "\u00b0C" },
    { idx: 4,  key: "battery",  label: "Battery", unit: "%" },
    { idx: 5,  key: "altitude", label: "Alt",     unit: "m" },
  ];

  // Detail rows: a static range by default; while the cursor scrubs the mini
  // chart they switch to the live value at that sample (setDetailRowsLive) and
  // revert to the range on mouse-out (restoreDetailRows).
  // unitKind = which UNITS converter applies to this row's values (the unit
  // label itself is taken from UNITS so it follows the user's locale).
  const DETAIL_ROWS = [
    { key: "distance", label: "Distance",  color: null,      unitKind: "dist" },
    { key: "speed",    label: "Speed",     color: "#00e5ff", idx: 1,  unitKind: "speed", dp: 1 },
    { key: "gpsspeed", label: "GPS speed", color: "#80d8ff", idx: 12, unitKind: "speed", dp: 1 },
    { key: "pwm",      label: "PWM",       color: "#ff4081", idx: 9,  unit: "%",    dp: 1 },
    { key: "power",    label: "Power",     color: "#7c4dff", idx: 11, unit: "W",    dp: 0 },
    { key: "current",  label: "Current",   color: "#ffd740", idx: 10, unit: "A",    dp: 1 },
    { key: "torque",   label: "Torque",    color: "#ff7043", idx: 16, unit: "Nm",   dp: 1 },
    { key: "phase",    label: "Phase current", color: "#4db6ac", idx: 17, unit: "A", dp: 1 },
    { key: "voltage",  label: "Voltage",   color: "#ff5252", idx: 2,  unit: "V",    dp: 1 },
    { key: "temp",     label: "Temp",      color: "#ffa000", idx: 3,  unitKind: "temp", dp: 1 },
    { key: "battery",  label: "Battery",   color: "#69f0ae", idx: 4,  unit: "%",    dp: 0 },
    { key: "altitude", label: "Altitude",  color: "#ce93d8", idx: 5,  unitKind: "alt",  dp: 0 },
    { key: "time",     label: "Time",      color: null },
  ];
  // Convert a metric value for display in the user's unit system.
  function convertByKind(kind, v) {
    if (kind === "speed") return UNITS.speed(v);
    if (kind === "temp")  return UNITS.temp(v);
    if (kind === "dist")  return UNITS.dist(v);
    if (kind === "alt")   return UNITS.alt(v);
    return v;
  }
  function unitForKind(kind, fallback) {
    if (kind === "speed") return UNITS.speedUnit;
    if (kind === "temp")  return UNITS.tempUnit;
    if (kind === "dist")  return UNITS.distUnit;
    if (kind === "alt")   return UNITS.altUnit;
    return fallback || "";
  }
  // Regen (negative current) gets a distinct green, mirroring the inspector.
  const REGEN_COLOR = "#00e676";
  const DETAIL_ROW_MAP = {};
  DETAIL_ROWS.forEach(r => { DETAIL_ROW_MAP[r.key] = r; });

  // Trip-detail row layout (viewer): which rows show under an expanded trip and
  // in what order. Customised via the "Customize" toolbar button, saved per
  // browser. Distance + Time reorder but never hide. A shown row still auto-
  // skips on a trip that lacks its data (so no empty clutter).
  const DETAIL_LAYOUT_KEY = "dbb_detail_layout";
  const DETAIL_NEVER_HIDE = new Set(["distance", "time"]);
  function defaultDetailLayout() {
    return {
      order: ["distance", "speed", "pwm", "temp", "battery", "altitude", "time",
              "gpsspeed", "power", "current", "torque", "phase", "voltage"],
      hidden: ["gpsspeed", "power", "current", "torque", "phase", "voltage"],
    };
  }
  function loadDetailLayout() {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(DETAIL_LAYOUT_KEY) || "null"); } catch (_) {}
    const def = defaultDetailLayout();
    if (!saved || !Array.isArray(saved.order)) return def;
    const known = new Set(DETAIL_ROWS.map((r) => r.key));
    const order = saved.order.filter((k) => known.has(k));
    for (const k of def.order) if (!order.includes(k)) order.push(k); // new metrics appended
    const hidden = (Array.isArray(saved.hidden) ? saved.hidden : [])
      .filter((k) => known.has(k) && !DETAIL_NEVER_HIDE.has(k));
    return { order, hidden };
  }
  let detailLayout = loadDetailLayout();
  function saveDetailLayout() {
    try { localStorage.setItem(DETAIL_LAYOUT_KEY, JSON.stringify(detailLayout)); } catch (_) {}
  }
  let liveDetailIdx = -1;

  // Builds the detail rows for a trip — each shows a min–max range (total for
  // distance, start–end for time). Rows with no data are omitted.
  function buildDetailHtml(t) {
    const ts = t.timeseries || [];
    const s = t.stats || {};
    // When GPS speed is also recorded, the wheel's own dial speed is labelled
    // "Wheel speed" so it reads distinct from the "GPS speed" row.
    const hasGps = trackHasGpsSpeed(ts);
    // Speed and GPS speed both show "avg / max" so the two rows compare side
    // by side. Computed live since legacy caches don't include avgGpsSpeed.
    const avgMaxOf = (idx) => {
      let sum = 0, cnt = 0, mx = -Infinity, hasData = false;
      for (const row of ts) {
        const v = row[idx];
        if (typeof v !== "number") continue;
        if (v > 0) { sum += v; cnt++; }
        if (v > mx) mx = v;
        if (v !== 0) hasData = true;
      }
      if (!hasData) return null;
      const avg = cnt ? sum / cnt : 0;
      return { avg, max: Math.max(mx, 0) };
    };
    let html = "";
    const hiddenSet = new Set(detailLayout.hidden);
    for (const key of detailLayout.order) {
      if (hiddenSet.has(key)) continue;
      const r = DETAIL_ROW_MAP[key];
      if (!r) continue;
      let range = null;
      const unitLabel = unitForKind(r.unitKind, r.unit);
      if (r.key === "distance") {
        if (s.distanceKm > 0) range = UNITS.dist(s.distanceKm).toFixed(2) + " " + UNITS.distUnit;
      } else if (r.key === "time") {
        const start = (t.dateStart || "").split("T")[1];
        const end = (t.dateEnd || "").split("T")[1];
        if (start) {
          range = start.substring(0, 8) + " - " + (end ? end.substring(0, 8) : start.substring(0, 8));
        }
      } else if (r.key === "speed") {
        // Wheel speed: avg comes from stats; the "0/0" fallback for empty
        // stats keeps the layout stable on cached tracks without telemetry.
        const a = UNITS.speed(s.avgSpeed || 0);
        const mx = UNITS.speed(s.maxSpeed || 0);
        range = a.toFixed(1) + " / " + mx.toFixed(1) + " " + UNITS.speedUnit;
      } else if (r.key === "gpsspeed") {
        const stat = avgMaxOf(r.idx);
        if (stat) {
          const a = UNITS.speed(stat.avg);
          const mx = UNITS.speed(stat.max);
          range = a.toFixed(1) + " / " + mx.toFixed(1) + " " + UNITS.speedUnit;
        }
      } else {
        let mn = Infinity, mx = -Infinity, hasData = false;
        for (const row of ts) {
          const v = row[r.idx];
          if (typeof v !== "number") continue;
          if (v < mn) mn = v;
          if (v > mx) mx = v;
          if (v !== 0) hasData = true;
        }
        if (hasData && isFinite(mn)) {
          const lo = convertByKind(r.unitKind, mn);
          const hi = convertByKind(r.unitKind, mx);
          range = lo.toFixed(r.dp) + " - " + hi.toFixed(r.dp) + " " + unitLabel;
        }
      }
      if (range == null) continue;
      const label = (hasGps && r.key === "speed") ? "Wheel speed" : r.label;
      // The colour is exposed as the `--c` custom property so the toggled-off
      // swatch can swap fill for border with pure CSS. Distance and Time have
      // no swatch (not chart series) — a transparent placeholder keeps their
      // labels aligned with the rest.
      const dot = r.color
        ? `<i class="clr" style="--c:${r.color}"></i>`
        : `<i class="clr clr-spacer"></i>`;
      // Rows tied to a chart series (have an idx) are click-to-toggle.
      const toggleAttr = (r.idx != null) ? ' data-toggle="1"' : '';
      html += `<div class="detail-row" data-row="${r.key}"${toggleAttr}><span>${dot}${label}</span>` +
              `<span class="detail-val" data-range="${range}">${range}</span></div>`;
    }
    return html;
  }

  // Re-render the rows of any open trip detail in place (keeping its mini chart)
  // after the layout changes, and re-wire the click-to-hide-series toggles.
  function refreshOpenDetails() {
    document.querySelectorAll(".trip-item.active .trip-detail-inline").forEach((inline) => {
      const item = inline.closest(".trip-item");
      const idx = parseInt(item.dataset.idx);
      const t = allTracks[idx];
      if (!t) return;
      const chartWrap = inline.querySelector(".chart-wrap");
      inline.innerHTML = buildDetailHtml(t);
      if (chartWrap) inline.appendChild(chartWrap);
      inline.querySelectorAll('.detail-row[data-toggle="1"]').forEach((row) => {
        row.addEventListener("click", (e) => {
          e.stopPropagation();
          row.classList.toggle("series-off");
          const canvas = item.querySelector(".trip-chart");
          if (canvas && canvas.offsetWidth > 0) {
            drawChart(canvas, parseInt(canvas.dataset.idx));
            if (canvas._persistCrosshair != null) drawCrosshair(canvas, canvas._persistCrosshair);
          }
        });
      });
      // Redraw so the mini chart reflects the new visible set (Customize can
      // add or drop series, not just reorder rows).
      const canvas = inline.querySelector(".trip-chart");
      if (canvas && canvas.offsetWidth > 0) {
        drawChart(canvas, idx);
        if (canvas._persistCrosshair != null) drawCrosshair(canvas, canvas._persistCrosshair);
      }
    });
  }

  // "Customize" (trip-detail rows): drag to reorder, tick to show/hide, with
  // JSON import/export. Distance + Time are locked shown. Saved per browser.
  function openDetailCustomize() {
    const rowHtml = (key) => {
      const r = DETAIL_ROW_MAP[key];
      if (!r) return "";
      const shown = !detailLayout.hidden.includes(key);
      const locked = DETAIL_NEVER_HIDE.has(key);
      const dot = r.color ? `<i class="clr" style="--c:${r.color}"></i>` : `<i class="clr clr-spacer"></i>`;
      return `<div class="dc-row${shown ? "" : " is-hidden"}" data-key="${key}">` +
        `<span class="dc-grip" title="Drag to reorder">⠿</span>` +
        `<label class="dc-switch${locked ? " dc-locked" : ""}" title="${locked ? "Always shown" : "Show or hide"}">` +
          `<input type="checkbox"${shown ? " checked" : ""}${locked ? " disabled" : ""}>` +
          `<span class="dc-knob"></span>` +
        `</label>` +
        `<span class="dc-name">${dot}${escapeHtml(r.label)}</span>` +
      `</div>`;
    };
    const body = `<div class="dc-hint">Drag to reorder. Toggle to show or hide.</div>` +
      `<div class="dc-list">${detailLayout.order.map(rowHtml).join("")}</div>` +
      `<input type="file" id="dc-import-file" accept="application/json,.json" style="display:none">`;
    const reset = ttBtn("Reset", "tt-ghost");
    const done = ttBtn("Done", "tt-primary");
    ttmodShow("", "Customize graphs", "", body, [reset, done]);
    // Import / export as title-bar icon buttons, matching the inspector dialog.
    const header = ttmod.querySelector(".tm-header");
    const closeBtn = header.querySelector(".tm-close");
    const imp = document.createElement("button");
    imp.type = "button"; imp.className = "ttmod-icon"; imp.title = "Import layout (.json)";
    imp.innerHTML = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M8 10V2M4.5 5.5 8 2l3.5 3.5"/><path d="M2 10v3a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-3"/></svg>`;
    const exp = document.createElement("button");
    exp.type = "button"; exp.className = "ttmod-icon"; exp.title = "Export layout (.json)";
    exp.innerHTML = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2v8M4.5 6.5 8 10l3.5-3.5"/><path d="M2 10v3a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-3"/></svg>`;
    header.insertBefore(imp, closeBtn);
    header.insertBefore(exp, closeBtn);
    const listEl = ttmod.querySelector(".dc-list");
    listEl.querySelectorAll(".dc-row").forEach((row) => {
      const key = row.dataset.key;
      const cb = row.querySelector('input[type="checkbox"]');
      if (cb && !cb.disabled) cb.addEventListener("change", () => {
        const hid = new Set(detailLayout.hidden);
        if (cb.checked) hid.delete(key); else hid.add(key);
        detailLayout.hidden = [...hid];
        row.classList.toggle("is-hidden", !cb.checked);
        saveDetailLayout();
        refreshOpenDetails();
      });
      const grip = row.querySelector(".dc-grip");
      grip.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        try { grip.setPointerCapture(e.pointerId); } catch (_) {}
        row.classList.add("dc-dragging");
        const move = (ev) => {
          const others = [...listEl.querySelectorAll(".dc-row")].filter((rr) => rr !== row);
          let target = null;
          for (const other of others) { const rect = other.getBoundingClientRect(); if (ev.clientY < rect.top + rect.height / 2) { target = other; break; } }
          if (target) { if (row.nextSibling !== target) listEl.insertBefore(row, target); }
          else listEl.appendChild(row);
        };
        const up = () => {
          try { grip.releasePointerCapture(e.pointerId); } catch (_) {}
          row.classList.remove("dc-dragging");
          grip.removeEventListener("pointermove", move);
          grip.removeEventListener("pointerup", up);
          detailLayout.order = [...listEl.querySelectorAll(".dc-row")].map((rr) => rr.dataset.key);
          saveDetailLayout();
          refreshOpenDetails();
        };
        grip.addEventListener("pointermove", move);
        grip.addEventListener("pointerup", up);
      });
    });
    reset.addEventListener("click", () => { detailLayout = defaultDetailLayout(); saveDetailLayout(); refreshOpenDetails(); openDetailCustomize(); });
    exp.addEventListener("click", () => {
      const blob = new Blob([JSON.stringify(detailLayout, null, 2)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "eucviewer-trip-details.json";
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    });
    const impFile = ttmod.querySelector("#dc-import-file");
    imp.addEventListener("click", () => impFile.click());
    impFile.addEventListener("change", () => {
      const f = impFile.files && impFile.files[0];
      if (!f) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const parsed = JSON.parse(reader.result);
          if (parsed && Array.isArray(parsed.order)) {
            localStorage.setItem(DETAIL_LAYOUT_KEY, JSON.stringify(parsed));
            detailLayout = loadDetailLayout();
            saveDetailLayout();
            refreshOpenDetails();
            openDetailCustomize();
            appToast("Trip-detail layout imported.");
          } else appToast("That file isn't a trip-detail layout.");
        } catch (_) { appToast("Couldn't read that layout file."); }
      };
      reader.readAsText(f);
    });
    done.addEventListener("click", ttmodClose);
  }

  function clockAt(track, sec) {
    const baseMs = Date.parse(track.dateStart || "");
    if (isNaN(baseMs)) return "—";
    const d = new Date(baseMs + sec * 1000);
    const p = (n) => String(n).padStart(2, "0");
    return p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
  }

  // Fills a trip's detail rows with the values at one timeseries sample.
  function setDetailRowsLive(trackIdx, sampleIdx) {
    const track = allTracks[trackIdx];
    if (!track || !track.timeseries) return;
    const row = track.timeseries[sampleIdx];
    if (!row) return;
    const item = document.querySelector(`.trip-item[data-idx="${trackIdx}"]`);
    if (!item) return;
    const cumKm = getCumDistTs(track)[sampleIdx] || 0;
    item.querySelectorAll(".detail-row").forEach(rowEl => {
      const r = DETAIL_ROW_MAP[rowEl.dataset.row];
      const valEl = rowEl.querySelector(".detail-val");
      if (!r || !valEl) return;
      let txt = null;
      if (r.key === "distance") {
        txt = UNITS.dist(cumKm).toFixed(2) + " " + UNITS.distUnit;
      } else if (r.key === "time") {
        txt = clockAt(track, row[0] || 0);
      } else if (r.idx != null) {
        const v = row[r.idx];
        const num = (typeof v === "number") ? convertByKind(r.unitKind, v) : 0;
        txt = num.toFixed(r.dp) + " " + unitForKind(r.unitKind, r.unit);
      }
      if (txt != null) valEl.textContent = txt;
    });
    liveDetailIdx = trackIdx;
  }

  // Reverts the detail rows back to their static ranges.
  function restoreDetailRows() {
    if (liveDetailIdx < 0) return;
    const item = document.querySelector(`.trip-item[data-idx="${liveDetailIdx}"]`);
    liveDetailIdx = -1;
    if (!item) return;
    item.querySelectorAll(".detail-val").forEach(el => {
      if (el.dataset.range != null) el.textContent = el.dataset.range;
    });
  }

  function drawChart(canvas, trackIdx) {
    const t = allTracks[trackIdx];
    const ts = t.timeseries;
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const w = rect.width;
    const h = rect.height;
    if (w === 0 || h === 0) return;

    canvas.width = w * dpr;
    canvas.height = h * dpr;
    const ctx = canvas.getContext("2d");
    ctx.scale(dpr, dpr);

    if (!ts || ts.length < 2) {
      ctx.fillStyle = "#555";
      ctx.font = "11px -apple-system, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("No data", w / 2, h / 2 + 4);
      canvas._chartData = null;
      return;
    }

    const pad = { top: 4, bottom: 4, left: 0, right: 0 };
    const cw = w - pad.left - pad.right;
    const ch = h - pad.top - pad.bottom;

    // Which series to leave off the mini chart: metrics hidden globally in the
    // Customize dialog (their detail row isn't rendered at all), plus any the
    // user click-toggled off on this trip's rows.
    const hidden = new Set(detailLayout.hidden);
    const item = canvas.closest(".trip-item");
    if (item) {
      item.querySelectorAll(".detail-row.series-off").forEach(r => hidden.add(r.dataset.row));
    }

    const activeSeries = SERIES.filter(s => {
      if (hidden.has(s.key)) return false;
      for (const row of ts) if ((row[s.idx] || 0) !== 0) return true;
      return false;
    });

    const hasGpsSpeed = !hidden.has("gpsspeed") && trackHasGpsSpeed(ts);

    const ranges = {};
    for (const s of activeSeries) {
      let min = Infinity, max = -Infinity;
      for (const row of ts) {
        const v = row[s.idx];
        if (v < min) min = v;
        if (v > max) max = v;
      }
      // GPS speed shares the wheel-speed axis so the two lines compare directly.
      if (s.key === "speed" && hasGpsSpeed) {
        for (const row of ts) {
          const v = row[GPS_SPEED_IDX];
          if (typeof v === "number") { if (v < min) min = v; if (v > max) max = v; }
        }
      }
      const span = max - min || 1;
      ranges[s.key] = { min: min - span * 0.05, max: max + span * 0.05 };
    }
    // GPS speed present but no wheel-speed series — give it a standalone axis.
    if (hasGpsSpeed && !ranges.speed) {
      let min = Infinity, max = -Infinity;
      for (const row of ts) {
        const v = row[GPS_SPEED_IDX];
        if (typeof v === "number") { if (v < min) min = v; if (v > max) max = v; }
      }
      const span = max - min || 1;
      ranges.speed = { min: min - span * 0.05, max: max + span * 0.05 };
    }

    const tMin = ts[0][0];
    const tMax = ts[ts.length - 1][0];
    const tSpan = tMax - tMin || 1;

    for (const s of activeSeries) {
      const r = ranges[s.key];
      const rSpan = r.max - r.min || 1;
      ctx.lineWidth = 1.2;
      ctx.globalAlpha = 0.8;
      if (s.key === "current") {
        // 2-colour line: regen green where current is < 0, amber otherwise.
        // Segments that cross 0 are split at the zero point so each colour
        // stops cleanly at the baseline — no green spilling into +A and vice
        // versa.
        const yZero = pad.top + ch - ((0 - r.min) / rSpan) * ch;
        for (let i = 1; i < ts.length; i++) {
          const a = ts[i - 1][s.idx], b = ts[i][s.idx];
          const x0 = pad.left + ((ts[i - 1][0] - tMin) / tSpan) * cw;
          const y0 = pad.top + ch - ((a - r.min) / rSpan) * ch;
          const x1 = pad.left + ((ts[i][0] - tMin) / tSpan) * cw;
          const y1 = pad.top + ch - ((b - r.min) / rSpan) * ch;
          if ((a < 0) !== (b < 0) && a !== b) {
            const t = -a / (b - a);
            const xz = x0 + t * (x1 - x0);
            ctx.strokeStyle = a < 0 ? REGEN_COLOR : CHART_COLORS.current;
            ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(xz, yZero); ctx.stroke();
            ctx.strokeStyle = b < 0 ? REGEN_COLOR : CHART_COLORS.current;
            ctx.beginPath(); ctx.moveTo(xz, yZero); ctx.lineTo(x1, y1); ctx.stroke();
          } else {
            const sign = a !== 0 ? a : b;
            ctx.strokeStyle = sign < 0 ? REGEN_COLOR : CHART_COLORS.current;
            ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
          }
        }
      } else {
        ctx.beginPath();
        ctx.strokeStyle = CHART_COLORS[s.key];
        for (let i = 0; i < ts.length; i++) {
          const x = pad.left + ((ts[i][0] - tMin) / tSpan) * cw;
          const y = pad.top + ch - ((ts[i][s.idx] - r.min) / rSpan) * ch;
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;

    // GPS-speed companion line — dashed, on the wheel-speed axis.
    if (hasGpsSpeed && ranges.speed) {
      const r = ranges.speed;
      const rSpan = r.max - r.min || 1;
      ctx.save();
      ctx.beginPath();
      ctx.strokeStyle = GPS_SPEED_COLOR;
      ctx.lineWidth = 1.1;
      ctx.globalAlpha = 0.9;
      ctx.setLineDash([3, 2]);
      let started = false;
      for (let i = 0; i < ts.length; i++) {
        const v = ts[i][GPS_SPEED_IDX];
        if (typeof v !== "number") { started = false; continue; }
        const x = pad.left + ((ts[i][0] - tMin) / tSpan) * cw;
        const y = pad.top + ch - ((v - r.min) / rSpan) * ch;
        if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.restore();
    }

    canvas._chartData = { ts, activeSeries, ranges, tMin, tSpan, pad, cw, ch, w, h, hasGpsSpeed };

    // Re-apply persistent crosshair if one was stored
    if (canvas._persistCrosshair != null) {
      drawCrosshair(canvas, canvas._persistCrosshair);
    }
  }

  // --- Chart hover marker on map ---
  let chartMarker = null;
  function showChartMarker(lat, lon) {
    if (lat === 0 && lon === 0) { hideChartMarker(); return; }
    if (!chartMarker) {
      chartMarker = L.circleMarker([lat, lon], {
        radius: 4, color: "#ffa000", fillColor: "#ffa000",
        fillOpacity: 0.9, weight: 2, opacity: 1,
      }).addTo(map);
    } else {
      chartMarker.setLatLng([lat, lon]);
    }
  }
  function hideChartMarker() {
    if (chartMarker) { map.removeLayer(chartMarker); chartMarker = null; }
  }

  // Draw crosshair + dots on a chart at a given timeseries index
  function drawCrosshair(canvas, tsIndex) {
    const cd = canvas._chartData;
    if (!cd) return;
    const row = cd.ts[tsIndex];
    if (!row) return;
    const ctx = canvas.getContext("2d");
    const xPos = cd.pad.left + ((row[0] - cd.tMin) / cd.tSpan) * cd.cw;
    ctx.strokeStyle = "rgba(255,255,255,0.4)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(xPos, 0);
    ctx.lineTo(xPos, cd.h);
    ctx.stroke();
    for (const s of cd.activeSeries) {
      const r = cd.ranges[s.key];
      const rSpan = r.max - r.min || 1;
      const y = cd.pad.top + cd.ch - ((row[s.idx] - r.min) / rSpan) * cd.ch;
      ctx.fillStyle = CHART_COLORS[s.key];
      ctx.beginPath();
      ctx.arc(xPos, y, 3, 0, Math.PI * 2);
      ctx.fill();
    }
    // GPS-speed dot on the shared wheel-speed axis.
    if (cd.hasGpsSpeed && cd.ranges.speed) {
      const v = row[GPS_SPEED_IDX];
      if (typeof v === "number") {
        const r = cd.ranges.speed;
        const rSpan = r.max - r.min || 1;
        const y = cd.pad.top + cd.ch - ((v - r.min) / rSpan) * cd.ch;
        ctx.fillStyle = GPS_SPEED_COLOR;
        ctx.beginPath();
        ctx.arc(xPos, y, 3, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  // Sync crosshair on mini chart when hovering the map track
  function syncChartCrosshair(trackIdx, pt) {
    // Clear persistent crosshairs from all charts
    document.querySelectorAll(".trip-chart").forEach(c => {
      if (c._persistCrosshair != null) {
        c._persistCrosshair = null;
        if (c._chartData) drawChart(c, parseInt(c.dataset.idx));
      }
    });

    if (trackIdx < 0 || !pt) return;

    const canvas = document.querySelector(`.trip-chart[data-idx="${trackIdx}"]`);
    if (!canvas) return;

    // Ensure chart is drawn
    if (!canvas._chartData && canvas.offsetWidth > 0) {
      drawChart(canvas, trackIdx);
    }
    if (!canvas._chartData) return;

    const ts = canvas._chartData.ts;
    if (!ts || !ts.length) return;

    // Find closest timeseries point by lat/lon
    const ptLat = pt[0], ptLon = pt[1];
    let best = 0, bestD = Infinity;
    for (let i = 0; i < ts.length; i++) {
      const dlat = ts[i][6] - ptLat;
      const dlon = ts[i][7] - ptLon;
      const d = dlat * dlat + dlon * dlon;
      if (d < bestD) { bestD = d; best = i; }
    }

    // Store persistent crosshair so it survives redraws
    canvas._persistCrosshair = best;
    drawChart(canvas, trackIdx);
  }

  // Chart hover handler
  document.addEventListener("mousemove", (e) => {
    const canvas = e.target.closest(".trip-chart");
    if (!canvas || !canvas._chartData) {
      restoreDetailRows();
      hideChartMarker();
      return;
    }

    const cd = canvas._chartData;
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left;

    const tAt = cd.tMin + ((mx - cd.pad.left) / cd.cw) * cd.tSpan;
    let best = 0, bestD = Infinity;
    for (let i = 0; i < cd.ts.length; i++) {
      const d = Math.abs(cd.ts[i][0] - tAt);
      if (d < bestD) { bestD = d; best = i; }
    }

    const row = cd.ts[best];
    const trackIdx = parseInt(canvas.dataset.idx);

    // Scrubbing the chart fills the detail rows with live values (the rows
    // replace the old floating tooltip; they revert to ranges on mouse-out).
    setDetailRowsLive(trackIdx, best);

    drawChart(canvas, trackIdx);
    drawCrosshair(canvas, best);

    const lat = row[6] || 0;
    const lon = row[7] || 0;
    showChartMarker(lat, lon);
    canvas._hoverLatLon = (lat && lon) ? [lat, lon] : null;
  });

  // Click on chart centers map — keep current zoom level
  document.addEventListener("click", (e) => {
    const canvas = e.target.closest(".trip-chart");
    if (!canvas || !canvas._hoverLatLon) return;
    e.stopPropagation();
    map.setView(canvas._hoverLatLon, map.getZoom(), { animate: true });
  });

  document.addEventListener("mouseleave", () => { hideChartMarker(); restoreDetailRows(); }, true);

  function formatSec(s) {
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, "0")}`;
  }

  // Draw charts when trip becomes active (after CSS transition)
  const chartObserver = new MutationObserver(() => {
    // Small delay to let the expand animation begin so the canvas has dimensions
    setTimeout(() => {
      document.querySelectorAll(".trip-item.active .trip-chart").forEach((canvas) => {
        if (canvas.offsetWidth > 0) {
          drawChart(canvas, parseInt(canvas.dataset.idx));
        }
      });
    }, 50);
  });
  chartObserver.observe(document.getElementById("trip-list"), {
    subtree: true, attributes: true, attributeFilter: ["class"],
  });

  // Drop the current selection: clear the map focus, the active row, and any
  // hover UI, then refit to the whole library. Shared by the click-again
  // toggle and the collapse-hides-it path below.
  function deselectCurrent() {
    if (selectedIdx === -1) return;
    selectedIdx = -1;
    updateGlow();
    fitAll();
    tooltip.classList.add("hidden");
    hideChartMarker();
    document.querySelectorAll(".trip-item.active").forEach((el) => el.classList.remove("active"));
    updateVisibilityUI();
  }

  // When a group holding the selected trip is collapsed, the trip is no longer
  // on screen — drop the selection so the map matches the list. Only real
  // collapse gates count: month groups always gate; a year group gates only in
  // the multi-year layout (it then wraps a .year-body), never the single-year
  // wrapper which has no header and stays open.
  function deselectIfHidden() {
    if (selectedIdx === -1) return;
    const el = tripList.querySelector(`.trip-item[data-idx="${selectedIdx}"]`);
    if (!el) return;
    const monthGroup = el.closest(".month-group");
    const yearGroup = el.closest(".year-group");
    const monthHidden = monthGroup && !monthGroup.classList.contains("expanded");
    const yearHidden = el.closest(".year-body") && yearGroup && !yearGroup.classList.contains("expanded");
    if (monthHidden || yearHidden) deselectCurrent();
  }

  function selectTrip(idx, opts) {
    if (selectedIdx === idx) {
      deselectCurrent();
      return;
    }

    selectedIdx = idx;

    // Force selected track visible and check its checkbox
    trackVisible.add(idx);
    const cb = tripList.querySelector(`.trip-check[data-idx="${idx}"]`);
    if (cb) cb.checked = true;

    updateGlow();
    fitTrack(idx);
    // Auto-select on load doesn't want to pop the panel open on portrait —
    // it just wants the first track highlighted on the map. Other callers
    // (tooltip click, list click, search) leave keepPanelClosed unset so
    // the panel still opens like before.
    if (!(opts && opts.keepPanelClosed)) setPanelOpen(true);

    document.querySelectorAll(".trip-item.active").forEach((el) => el.classList.remove("active"));
    const el = tripList.querySelector(`.trip-item[data-idx="${idx}"]`);
    if (el) {
      // Expand parent month and year groups
      const monthGroup = el.closest(".month-group");
      if (monthGroup) monthGroup.classList.add("expanded");
      const yearGroup = el.closest(".year-group");
      if (yearGroup) yearGroup.classList.add("expanded");
      el.classList.add("active");
      // Small delay to let expand transitions start so the element is visible
      setTimeout(() => el.scrollIntoView({ behavior: "smooth", block: "nearest" }), 50);
    }
    updateVisibilityUI();
  }

  // The trip panel's slide is driven by an inline transform, not just the
  // .open class: Chromium intermittently wedges the transition on this
  // element (the backdrop-filter children promote it to its own layer) so
  // a class- or style-driven transform write never reaches the renderer
  // and the panel stays put while the inline style says otherwise. Cure:
  // write the transform inline, then verify after the 0.3s transition
  // window and snap without animation if the write didn't land.
  function setPanelOpen(open) {
    panel.classList.toggle("open", open);
    const target = open ? "translateX(0px)" : "translateX(320px)";
    panel.style.transform = target;
    clearTimeout(setPanelOpen._verify);
    setPanelOpen._verify = setTimeout(() => {
      // Compare the RENDERED position, not computed style: one wedge mode
      // freezes computed at the old value, the other updates computed but
      // never repaints. The rect catches both.
      const want = open ? 0 : 320;
      const base = window.innerWidth - panel.offsetWidth;
      const gotOffset = panel.getBoundingClientRect().left - base;
      if (Math.abs(gotOffset - want) > 4) {
        const prevTransition = panel.style.transition;
        panel.style.transition = "none";
        // Nudge through a different value first: a same-value rewrite can
        // be ignored by the wedged renderer, a changed one cannot.
        panel.style.transform = "translateX(" + (want + 1) + "px)";
        void panel.offsetWidth;
        panel.style.transform = target;
        void panel.offsetWidth;
        panel.style.transition = prevTransition;
      }
    }, 400);
  }

  panelTab.addEventListener("click", () => {
    setPanelOpen(!panel.classList.contains("open"));
  });

  fileInput.addEventListener("change", (e) => {
    if (e.target.files[0]) handleFile(e.target.files[0]);
  });

  uploadBox.addEventListener("dragover", (e) => { e.preventDefault(); uploadBox.classList.add("dragover"); });
  uploadBox.addEventListener("dragleave", () => uploadBox.classList.remove("dragover"));
  uploadBox.addEventListener("drop", (e) => {
    e.preventDefault();
    uploadBox.classList.remove("dragover");
    if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
  });

  // --- Logo: tap refreshes the page, holding it 5 s opens the runner
  // minigame (euc-game.js, lazy-loaded on first trigger). The spin-up
  // animation on hold doubles as the progress indicator. Opening the page
  // with #skills in the URL boots straight into the game (shareable link).
  (function () {
    const logo = document.getElementById("upload-icon");
    if (!logo) return;
    let holdTimer = null, downAt = 0, launched = false;
    const cancelHold = () => {
      clearTimeout(holdTimer);
      holdTimer = null;
      logo.classList.remove("logo-charging");
    };
    // Start fetching the game's display font as soon as a hold begins so
    // the 5 s wind-up hides the download (euc-game.js reuses this link by
    // its id and skips the wait when the faces are already loaded).
    const kickFont = () => {
      if (document.getElementById("eg-font")) return;
      const l = document.createElement("link");
      l.id = "eg-font";
      l.rel = "stylesheet";
      l.href = "https://fonts.googleapis.com/css2?family=Orbitron:wght@500;700;900&display=swap";
      l.onload = () => {
        if (document.fonts && document.fonts.load) {
          ["500", "700", "900"].forEach((w) => document.fonts.load(w + " 16px Orbitron"));
        }
      };
      document.head.appendChild(l);
    };
    const openGame = () => {
      if (window.eucGameOpen) { window.eucGameOpen(); return; }
      kickFont();
      const s = document.createElement("script");
      s.src = "static/js/euc-game.js?v=10";
      s.onload = () => { if (window.eucGameOpen) window.eucGameOpen(); };
      document.head.appendChild(s);
    };
    const checkHash = () => {
      if (location.hash.toLowerCase() === "#skills") openGame();
    };
    window.addEventListener("hashchange", checkHash);
    checkHash();
    logo.addEventListener("contextmenu", (e) => e.preventDefault());
    logo.addEventListener("dragstart", (e) => e.preventDefault());
    logo.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      launched = false;
      downAt = Date.now();
      kickFont();
      logo.classList.add("logo-charging");
      holdTimer = setTimeout(() => { launched = true; cancelHold(); openGame(); }, 5000);
    });
    logo.addEventListener("pointerup", () => {
      cancelHold();
      if (!launched && downAt && Date.now() - downAt < 600) location.reload();
      downAt = 0;
    });
    logo.addEventListener("pointercancel", () => { cancelHold(); downAt = 0; });
    logo.addEventListener("pointerleave", () => { cancelHold(); downAt = 0; });
  })();

  // --- Programmatic data injection (used by EvenDarkerBot Android app) ---
  // Accepts a base64-encoded .dbb (ZIP) or .csv file and loads it.
  // Does NOT save to recents or cache — keeps the viewer clean for embedded use.
  window.loadFileFromBase64 = async function (base64String, filename) {
    filename = filename || "import.dbb";
    // (zip and dbb are the same container; both accepted below)
    try {
      const binary = atob(base64String);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const file = new File([bytes], filename, { type: "application/octet-stream" });
      const lname = file.name.toLowerCase();
      if (!lname.endsWith(".dbb") && !lname.endsWith(".zip") && !lname.endsWith(".csv") && !lname.endsWith(".gpx") && !lname.endsWith(".xlsx")) return { success: false, error: "Unsupported file type" };

      progressArea.classList.remove("hidden");
      progressFill.style.width = "0%";
      progressText.textContent = "Loading...";

      const parsedTracks = await parseFileLocally(parserWorker, file, (msg) => {
        if (msg.type === "progress") {
          const pct = Math.round((msg.current / msg.total) * 100);
          progressFill.style.width = pct + "%";
          progressText.textContent = "Parsing trip " + msg.current + " of " + msg.total;
        }
      });

      if (!parsedTracks.length) {
        progressText.textContent = "No trip data found";
        return { success: false, error: "No trip data found" };
      }

      // Load directly — no saveRecentFile, no saveTracks
      loadTracks(parsedTracks);
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  };

  // Exposed so the Dropbox source can hand a Blob (built from N downloaded
  // CSVs zipped into a synthetic .dbb) into the normal parse + recents flow.
  // opts.dropboxMap maps inner filename → dropbox path so tracks can later
  // generate share links pointing back at the original file.
  window.eucViewerLoadFile = function (file, opts) {
    if (opts && opts.dropboxMap) pendingDropboxMap = opts.dropboxMap;
    if (opts && opts.source) pendingSource = opts.source;
    return handleFile(file, {
      append: !!(opts && opts.append),
      progressStart: opts && typeof opts.progressStart === "number" ? opts.progressStart : 0,
    });
  };

  // Boot path: ?file=<encoded url> downloads + loads + drops the param so
  // a refresh doesn't re-fetch. Used by Dropbox share links.
  async function loadFromUrl(rawUrl) {
    if (uploadActions) uploadActions.classList.add("hidden");
    uploadLabel.classList.add("hidden");
    const hint = document.getElementById("upload-hint");
    if (hint) hint.classList.add("hidden");
    if (recentUi && recentUi.section) recentUi.section.classList.add("hidden");
    progressArea.classList.remove("hidden");
    progressText.classList.remove("error");
    progressText.textContent = "Fetching trip…";
    progressFill.style.width = "5%";
    try {
      const res = await fetch(rawUrl, { credentials: "omit" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      // Stream the response so the progress bar tracks real bytes, not
      // a jump from 5% to 50%. Falls back to res.blob() when the server
      // doesn't return a content-length (Dropbox CDN usually does).
      const total = Number(res.headers.get("content-length")) || 0;
      let blob;
      if (total && res.body && typeof res.body.getReader === "function") {
        const reader = res.body.getReader();
        const chunks = [];
        let received = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value);
          received += value.length;
          const pct = 5 + Math.round((received / total) * 45);
          progressFill.style.width = pct + "%";
          progressText.textContent = "Fetching trip… " + Math.round((received / total) * 100) + "%";
        }
        blob = new Blob(chunks);
      } else {
        blob = await res.blob();
        progressFill.style.width = "50%";
      }
      let name = "shared.csv";
      try {
        const u = new URL(rawUrl);
        const last = u.pathname.split("/").filter(Boolean).pop();
        if (last && /\.(csv|gpx|xlsx|dbb)$/i.test(last)) name = decodeURIComponent(last);
      } catch (_) {}
      const file = new File([blob], name, { type: blob.type || "application/octet-stream" });
      try {
        // Drop the share payload from the address bar once consumed; keep
        // app-route hashes (#view etc.) intact.
        const h = location.hash;
        const consumed = h.startsWith("#trip=") || !!decodeShortLink(h.slice(1));
        const clean = location.origin + location.pathname + (consumed ? "" : h);
        history.replaceState(null, "", clean);
      } catch (_) {}
      // Hand off to handleFile but keep the progress bar continuous: parse
      // maps to 50-100% instead of resetting to 0.
      await handleFile(file, { progressStart: 50 });
    } catch (e) {
      progressText.textContent = "Couldn't load trip: " + (e.message || e);
      progressText.classList.add("error");
      if (uploadActions) uploadActions.classList.remove("hidden");
      uploadLabel.classList.remove("hidden");
      if (hint) hint.classList.remove("hidden");
      if (recentUi && recentUi.section && recentUi.list.children.length) {
        recentUi.section.classList.remove("hidden");
      }
    }
  }

  // --- Init ---
  const initParams = new URLSearchParams(location.search);
  const sharedFileUrl = initParams.get("file");
  // `#d-…` short share token — the compressed form of ?file= (SHORTLINK.md).
  const shortLinkUrl = decodeShortLink(location.hash.slice(1));
  const isEmbedded = initParams.has("embedded");
  if (sharedFileUrl) {
    loadFromUrl(sharedFileUrl);
  } else if (shortLinkUrl) {
    loadFromUrl(shortLinkUrl);
  }
  if (isEmbedded) {
    // Android WebView's GPU compositor silently drops backdrop-filter
    // (verified via an in-app diagnostic: Chrome browser blurs, WebView
    // doesn't, even though CSS.supports claims it does). The frosted
    // panels rendered as missing / broken elements inside the embed.
    // Mark the body so style.css falls back to opaque panels for
    // embedded riders; Chrome users keep the frosted look.
    document.body.classList.add("embedded-no-blur");
    // Embedded mode: hide upload button and recents, keep progress visible
    uploadLabel.classList.add("hidden");
    recentUi.section.classList.add("hidden");
    document.getElementById("upload-icon").classList.add("hidden");
    document.querySelector("#upload-box h1").classList.add("hidden");
    // Show a hint after 5s if no data has arrived
    setTimeout(() => {
      if (!allTracks.length) {
        const hint = document.createElement("div");
        hint.style.cssText = "color:#888;font-size:13px;margin-top:12px;text-align:center;";
        hint.innerHTML = 'Waiting for file&hellip; see <a href="https://github.com/eried/eucviewer/blob/main/INTEGRATION.md" target="_blank" style="color:#4FC3F7;">INTEGRATION.md</a> on GitHub';
        uploadBox.appendChild(hint);
      }
    }, 5000);
  } else {
    renderRecentFiles();
    // When ?file= or a #d-… token is present, loadFromUrl() above is already
    // fetching it and only strips the payload once the download lands.
    // Running the route bootstrap here too would let applyRoute() see the
    // still-present payload and start a second download + parse, whose
    // duplicate selectTrip(0) toggled the auto-selection back off.
    if (sharedFileUrl || shortLinkUrl) { /* handled by loadFromUrl above */ }
    else if (resumeSyncAfterOAuth()) { /* restored the view + reopening sync */ }
    else if (!location.hash) navigate("#load", true);
    else applyRoute();
  }
});
