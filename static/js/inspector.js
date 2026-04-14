(async function () {
  "use strict";

  // ---------- Load track ----------
  const params = new URLSearchParams(location.search);
  const trackIdx = parseInt(params.get("i"));
  const errorBanner = document.getElementById("error-banner");

  function showError(msg) {
    errorBanner.textContent = msg;
    errorBanner.classList.remove("hidden");
  }

  const RECENT_DB_NAME = "darknessbot-trip-viewer";
  const SESSION_STORE_NAME = "currentSession";
  const SESSION_KEY = "tracks";

  function loadFromIDB() {
    return new Promise((resolve) => {
      if (!("indexedDB" in window)) return resolve(null);
      const req = indexedDB.open(RECENT_DB_NAME);
      req.onerror = () => resolve(null);
      req.onsuccess = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(SESSION_STORE_NAME)) { db.close(); return resolve(null); }
        try {
          const tx = db.transaction(SESSION_STORE_NAME, "readonly");
          const getReq = tx.objectStore(SESSION_STORE_NAME).get(SESSION_KEY);
          getReq.onsuccess = () => { db.close(); resolve(getReq.result || null); };
          getReq.onerror = () => { db.close(); resolve(null); };
        } catch { db.close(); resolve(null); }
      };
    });
  }

  function loadFromLocalStorage() {
    try {
      const raw = localStorage.getItem("dbb_tracks") || sessionStorage.getItem("dbb_tracks");
      if (raw) return JSON.parse(raw);
    } catch {}
    return null;
  }

  let tracks = await loadFromIDB();
  if (!tracks || !Array.isArray(tracks) || !tracks.length) {
    tracks = loadFromLocalStorage();
  }

  if (!tracks || !Array.isArray(tracks) || isNaN(trackIdx) || !tracks[trackIdx]) {
    showError("Trip not found. Open the main viewer and click a trip's inspect button.");
    return;
  }
  const track = tracks[trackIdx];
  const ts = track.timeseries || [];
  if (ts.length < 2) {
    showError("Trip has no timeseries data to play back.");
    return;
  }

  // Timeseries layout: [sec, speed, voltage, temp, battery, altitude, lat, lon]
  const SEC = 0, SPD = 1, VOLT = 2, TEMP = 3, BATT = 4, ALT = 5, LAT = 6, LON = 7;
  // Points layout: [lat, lon, speed, alt, volt, temp, battery]
  const P_LAT = 0, P_LON = 1, P_SPD = 2, P_ALT = 3, P_VOLT = 4, P_TEMP = 5, P_BATT = 6;

  const duration = ts[ts.length - 1][SEC] - ts[0][SEC];
  const t0 = ts[0][SEC];

  // Cumulative distance (km) aligned with timeseries
  const cumKm = new Float32Array(ts.length);
  function haversineKm(lat1, lon1, lat2, lon2) {
    const R = 6371, toRad = Math.PI / 180;
    const dLat = (lat2 - lat1) * toRad;
    const dLon = (lon2 - lon1) * toRad;
    const a = Math.sin(dLat / 2) ** 2 +
              Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }
  let prevLat = null, prevLon = null, total = 0;
  for (let i = 0; i < ts.length; i++) {
    const lat = ts[i][LAT], lon = ts[i][LON];
    if (lat !== 0 && lon !== 0) {
      if (prevLat !== null) total += haversineKm(prevLat, prevLon, lat, lon);
      prevLat = lat; prevLon = lon;
    }
    cumKm[i] = total;
  }
  const totalKm = total;

  // ---------- Header info ----------
  document.getElementById("trip-name").textContent = track.date || track.name;
  const subBits = [];
  if (track.stats) {
    if (track.stats.distanceKm) subBits.push(track.stats.distanceKm + " km");
    if (track.stats.maxSpeed) subBits.push(track.stats.maxSpeed + " km/h max");
    subBits.push((track.stats.rows || ts.length).toLocaleString() + " samples");
  }
  document.getElementById("trip-subtitle").textContent = subBits.join(" \u00b7 ");
  document.getElementById("odo-total").textContent = totalKm.toFixed(2);
  document.getElementById("clock-total").textContent = fmtTime(duration);

  function fmtTime(sec) {
    sec = Math.max(0, Math.floor(sec));
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    return String(h).padStart(2, "0") + ":" + String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
  }

  // ---------- MapLibre map ----------
  function hasGpsRow(row) {
    return row[LAT] !== 0 && row[LON] !== 0;
  }

  const gpsPoints = ts.filter(hasGpsRow);
  let routePoints = Array.isArray(track.points) ? track.points.filter((p) => p[P_LAT] !== 0 && p[P_LON] !== 0) : [];
  if (routePoints.length < 2) {
    // Fallback for legacy payloads: reconstruct route from timeseries GPS rows.
    routePoints = gpsPoints.map((r) => [r[LAT], r[LON], r[SPD], r[ALT], r[VOLT], r[TEMP], r[BATT]]);
  }
  const hasGps = routePoints.length > 1;

  // Basemap themes — each builds a {source, layer} pair inserted below the track.
  const MAP_THEMES = {
    dark: {
      source: {
        type: "raster",
        tiles: [
          "https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png",
          "https://b.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png",
          "https://c.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png",
          "https://d.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png"
        ],
        tileSize: 256,
        attribution: "\u00a9 OpenStreetMap contributors \u00a9 CARTO"
      },
      paint: {}
    },
    light: {
      source: {
        type: "raster",
        tiles: [
          "https://a.tile.openstreetmap.org/{z}/{x}/{y}.png",
          "https://b.tile.openstreetmap.org/{z}/{x}/{y}.png",
          "https://c.tile.openstreetmap.org/{z}/{x}/{y}.png"
        ],
        tileSize: 256,
        attribution: "\u00a9 OpenStreetMap contributors"
      },
      paint: {}
    },
    satellite: {
      source: {
        type: "raster",
        tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"],
        tileSize: 256,
        attribution: "Tiles \u00a9 Esri"
      },
      paint: {}
    }
  };

  // Color-by configs: invert=true means high value is "good" (green end of palette).
  const COLOR_MODES = {
    speed:    { pointIdx: P_SPD,  unit: "km/h", invert: false },
    battery:  { pointIdx: P_BATT, unit: "%",    invert: true  },
    voltage:  { pointIdx: P_VOLT, unit: "V",    invert: true  },
    temp:     { pointIdx: P_TEMP, unit: "\u00b0C", invert: false },
    altitude: { pointIdx: P_ALT,  unit: "m",    invert: false }
  };
  // Palette low → high; inverted modes reverse stops.
  const PALETTE = ["#2962ff", "#00e5ff", "#69f0ae", "#ffeb3b", "#ff5252"];

  let map = null, riderMarker = null, followCamera = true;
  let coords = [];
  let currentTheme = "dark";
  let currentColorMode = "solid";
  let currentRouteIdx = 0;

  function applyTheme(name) {
    if (!map || !map.isStyleLoaded()) return;
    const theme = MAP_THEMES[name];
    if (!theme) return;
    if (map.getLayer("basemap")) map.removeLayer("basemap");
    if (map.getSource("basemap")) map.removeSource("basemap");
    map.addSource("basemap", theme.source);
    const before = map.getLayer("track-line") ? "track-line" : undefined;
    map.addLayer({ id: "basemap", type: "raster", source: "basemap", paint: theme.paint }, before);
    currentTheme = name;
  }

  function buildGradientExpr(mode) {
    const cfg = COLOR_MODES[mode];
    if (!cfg || coords.length < 2) return null;
    // Cumulative distance along the GPS-filtered coords to compute line-progress per vertex.
    let total = 0;
    const cum = new Float64Array(coords.length);
    for (let i = 1; i < coords.length; i++) {
      total += haversineKm(coords[i - 1][1], coords[i - 1][0], coords[i][1], coords[i][0]);
      cum[i] = total;
    }
    if (total <= 0) return null;

    // Metric values aligned with coords (same filter: LAT/LON !== 0).
    const vals = [];
    for (let i = 0; i < ts.length; i++) {
      if (hasGpsRow(ts[i])) vals.push(ts[i][cfg.idx]);
    }
    let minV = Infinity, maxV = -Infinity;
    for (const v of vals) { if (v < minV) minV = v; if (v > maxV) maxV = v; }
    if (minV === maxV) { maxV = minV + 1; }

    const stops = cfg.invert ? PALETTE.slice().reverse() : PALETTE;
    function colorAt(v) {
      const t = Math.max(0, Math.min(1, (v - minV) / (maxV - minV)));
      const pos = t * (stops.length - 1);
      const i = Math.floor(pos);
      const f = pos - i;
      if (i >= stops.length - 1) return stops[stops.length - 1];
      return lerpColor(stops[i], stops[i + 1], f);
    }

    const expr = ["interpolate", ["linear"], ["line-progress"]];
    // Downsample to keep expression size reasonable (cap ~150 stops).
    const n = vals.length;
    const step = Math.max(1, Math.floor(n / 150));
    let lastP = -1;
    for (let i = 0; i < n; i += step) {
      const p = cum[i] / total;
      if (p <= lastP) continue;
      expr.push(p, colorAt(vals[i]));
      lastP = p;
    }
    // Always include final vertex.
    const lastIdx = n - 1;
    if (lastP < 1) {
      expr.push(1, colorAt(vals[lastIdx]));
    }
    return { expr, min: minV, max: maxV, invert: cfg.invert, unit: cfg.unit };
  }

  function metricColor(value, minV, maxV, invert) {
    const stops = invert ? PALETTE.slice().reverse() : PALETTE;
    const t = Math.max(0, Math.min(1, (value - minV) / (maxV - minV)));
    const pos = t * (stops.length - 1);
    const i = Math.floor(pos);
    const f = pos - i;
    if (i >= stops.length - 1) return stops[stops.length - 1];
    return lerpColor(stops[i], stops[i + 1], f);
  }

  function getModeStats(mode) {
    const cfg = COLOR_MODES[mode];
    if (!cfg) return null;
    let minV = Infinity, maxV = -Infinity;
    for (let i = 0; i < routePoints.length; i++) {
      const v = routePoints[i][cfg.pointIdx];
      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
    }
    if (!isFinite(minV) || !isFinite(maxV)) return null;
    if (minV === maxV) maxV = minV + 1;
    return { min: minV, max: maxV, invert: cfg.invert, unit: cfg.unit };
  }

  function buildTraveledGradientExpr(mode, routeIdx) {
    const cfg = COLOR_MODES[mode];
    const stats = getModeStats(mode);
    if (!cfg || !stats) return null;

    const vals = [];
    const end = Math.max(0, Math.min(routeIdx, routePoints.length - 1));
    for (let i = 0; i <= end; i++) {
      vals.push(routePoints[i][cfg.pointIdx]);
    }
    if (vals.length < 2) return null;

    const expr = ["interpolate", ["linear"], ["line-progress"]];
    const n = vals.length;
    const step = Math.max(1, Math.floor(n / 150));
    for (let i = 0; i < n; i += step) {
      const p = i / (n - 1);
      expr.push(p, metricColor(vals[i], stats.min, stats.max, stats.invert));
    }
    if ((n - 1) % step !== 0) {
      expr.push(1, metricColor(vals[n - 1], stats.min, stats.max, stats.invert));
    }

    return { expr, min: stats.min, max: stats.max, invert: stats.invert, unit: stats.unit };
  }

  function lerpColor(a, b, t) {
    const pa = parseHex(a), pb = parseHex(b);
    const r = Math.round(pa[0] + (pb[0] - pa[0]) * t);
    const g = Math.round(pa[1] + (pb[1] - pa[1]) * t);
    const bl = Math.round(pa[2] + (pb[2] - pa[2]) * t);
    return "rgb(" + r + "," + g + "," + bl + ")";
  }
  function parseHex(h) {
    return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  }

  function applyColorMode(mode) {
    if (!map || !map.getLayer("track-line")) return;
    if (mode === "fixed") mode = "solid";
    currentColorMode = mode;
    const legend = document.getElementById("color-legend");
    const legendBar = legend.querySelector(".legend-bar");
    const legendMin = legend.querySelector("[data-legend-min]");
    const legendMax = legend.querySelector("[data-legend-max]");

    map.setPaintProperty("track-line", "line-gradient", undefined);
    map.setPaintProperty("track-line", "line-color", "#00e5ff");
    map.setPaintProperty("track-line", "line-opacity", mode === "solid" ? 0.85 : 0.35);
    if (map.getLayer("traveled-line")) map.setLayoutProperty("traveled-line", "visibility", "visible");

    if (mode === "solid") {
      map.setPaintProperty("traveled-line", "line-gradient", undefined);
      map.setPaintProperty("traveled-line", "line-color", "#ffa000");
      map.setPaintProperty("track-line", "line-gradient", undefined);
      legend.classList.add("hidden");
      return;
    }

    const built = buildTraveledGradientExpr(mode, currentRouteIdx);
    if (!built) return;

    map.setPaintProperty("traveled-line", "line-gradient", built.expr);
    // line-gradient requires line-color to be set to a dummy value.
    map.setPaintProperty("traveled-line", "line-color", "#ffffff");

    legendBar.classList.toggle("inverted", !!built.invert);
    const fmt = (v) => (Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(1)) + " " + built.unit;
    legendMin.textContent = fmt(built.min);
    legendMax.textContent = fmt(built.max);
    legend.classList.remove("hidden");
  }

  if (hasGps) {
    const lats = routePoints.map(p => p[P_LAT]);
    const lons = routePoints.map(p => p[P_LON]);
    const center = [(Math.min(...lons) + Math.max(...lons)) / 2, (Math.min(...lats) + Math.max(...lats)) / 2];

    const initialTheme = MAP_THEMES.dark;
    map = new maplibregl.Map({
      container: "map",
      style: {
        version: 8,
        glyphs: "https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf",
        sources: {
          "basemap": initialTheme.source,
          "terrain-dem": {
            type: "raster-dem",
            tiles: ["https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"],
            tileSize: 256,
            encoding: "terrarium",
            maxzoom: 15
          }
        },
        layers: [
          { id: "bg", type: "background", paint: { "background-color": "#0a0a0a" } },
          { id: "basemap", type: "raster", source: "basemap", paint: initialTheme.paint }
        ]
      },
      center,
      zoom: 14,
      pitch: 60,
      bearing: 0,
      maxPitch: 85,
      attributionControl: false
    });

    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right");

    map.on("load", () => {
      map.setTerrain({ source: "terrain-dem", exaggeration: 1.5 });

      coords = routePoints.map((p) => [p[P_LON], p[P_LAT]]);
      map.addSource("track", {
        type: "geojson",
        lineMetrics: true,
        data: { type: "Feature", geometry: { type: "LineString", coordinates: coords } }
      });
      map.addLayer({
        id: "track-line",
        type: "line",
        source: "track",
        paint: {
          "line-color": "#00e5ff",
          "line-width": 4,
          "line-opacity": 0.85
        }
      });

      map.addSource("traveled", {
        type: "geojson",
        lineMetrics: true,
        data: { type: "Feature", geometry: { type: "LineString", coordinates: [coords[0]] } }
      });
      map.addLayer({
        id: "traveled-line",
        type: "line",
        source: "traveled",
        paint: {
          "line-color": "#ffa000",
          "line-width": 5,
          "line-opacity": 1.0
        }
      });

      const b = new maplibregl.LngLatBounds();
      coords.forEach(c => b.extend(c));
      map.fitBounds(b, { padding: 40, pitch: 60, duration: 0 });

      const el = document.createElement("div");
      el.className = "rider-dot";
      riderMarker = new maplibregl.Marker({ element: el })
        .setLngLat(coords[0])
        .addTo(map);

      map.on("dragstart", () => { followCamera = false; });

      // Show controls now that the style + track are ready.
      const controls = document.getElementById("map-controls");
      controls.classList.remove("hidden");
      document.getElementById("theme-select").addEventListener("change", (e) => applyTheme(e.target.value));
      document.getElementById("color-select").addEventListener("change", (e) => applyColorMode(e.target.value));
      applyColorMode(currentColorMode);

      updateUI();
    });
  } else {
    document.getElementById("map").innerHTML =
      '<div style="padding:40px;color:#888;text-align:center;">No GPS data for this trip.</div>';
  }

  // ---------- Charts ----------
  const CHART_CONFIG = {
    speed:    { color: "#00e5ff", idx: SPD,  unit: " km/h" },
    voltage:  { color: "#ff5252", idx: VOLT, unit: " V" },
    temp:     { color: "#ffa000", idx: TEMP, unit: " \u00b0C" },
    battery:  { color: "#69f0ae", idx: BATT, unit: " %" },
    altitude: { color: "#ce93d8", idx: ALT,  unit: " m" },
  };

  const chartBlocks = document.querySelectorAll(".chart-block");
  const charts = [];
  chartBlocks.forEach(block => {
    const key = block.dataset.key;
    const cfg = CHART_CONFIG[key];
    const canvas = block.querySelector("canvas");
    const reading = block.querySelector("[data-reading]");
    charts.push({ key, cfg, canvas, reading, block });
  });

  function resizeCharts() {
    const dpr = window.devicePixelRatio || 1;
    charts.forEach(c => {
      const rect = c.canvas.getBoundingClientRect();
      c.canvas.width = Math.max(10, rect.width * dpr);
      c.canvas.height = Math.max(10, rect.height * dpr);
    });
    drawAllCharts();
  }

  function drawAllCharts() {
    charts.forEach(drawChart);
  }

  function drawChart(c) {
    const ctx = c.canvas.getContext("2d");
    const w = c.canvas.width, h = c.canvas.height;
    ctx.clearRect(0, 0, w, h);

    let minV = Infinity, maxV = -Infinity;
    for (let i = 0; i < ts.length; i++) {
      const v = ts[i][c.cfg.idx];
      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
    }
    if (minV === maxV) { maxV = minV + 1; }
    // Pad a bit
    const range = maxV - minV;
    minV -= range * 0.08;
    maxV += range * 0.08;

    const pad = 4;
    const px = (i) => pad + (i / (ts.length - 1)) * (w - pad * 2);
    const py = (v) => h - pad - ((v - minV) / (maxV - minV)) * (h - pad * 2);

    // Fill gradient under line
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, c.cfg.color + "55");
    grad.addColorStop(1, c.cfg.color + "00");
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.moveTo(px(0), h);
    for (let i = 0; i < ts.length; i++) ctx.lineTo(px(i), py(ts[i][c.cfg.idx]));
    ctx.lineTo(px(ts.length - 1), h);
    ctx.closePath();
    ctx.fill();

    // Line
    ctx.strokeStyle = c.cfg.color;
    ctx.lineWidth = 1.6 * (window.devicePixelRatio || 1);
    ctx.beginPath();
    for (let i = 0; i < ts.length; i++) {
      const x = px(i), y = py(ts[i][c.cfg.idx]);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();

    // Cached for cursor drawing
    c._px = px; c._py = py; c._range = [minV, maxV];

    // Redraw cursor
    if (currentSampleIdx >= 0) drawCursor(c, currentSampleIdx);
  }

  function drawCursor(c, sampleIdx) {
    const ctx = c.canvas.getContext("2d");
    if (!c._px) return;
    const x = c._px(sampleIdx);
    const y = c._py(ts[sampleIdx][c.cfg.idx]);
    ctx.save();
    ctx.strokeStyle = "rgba(255, 160, 0, 0.7)";
    ctx.lineWidth = 1 * (window.devicePixelRatio || 1);
    ctx.beginPath();
    ctx.moveTo(x, 0); ctx.lineTo(x, c.canvas.height);
    ctx.stroke();
    ctx.fillStyle = "#ffa000";
    ctx.beginPath();
    ctx.arc(x, y, 3 * (window.devicePixelRatio || 1), 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // Chart drag/scrub interaction
  charts.forEach(c => {
    let dragging = false;
    const onMove = (clientX) => {
      const rect = c.canvas.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      const sample = Math.round(ratio * (ts.length - 1));
      const t = ts[sample][SEC] - t0;
      setCurrentTime(t);
    };
    const onWindowMove = e => { if (dragging) onMove(e.clientX); };
    const onWindowUp = () => { dragging = false; };
    c.canvas.addEventListener("mousedown", e => {
      dragging = true;
      onMove(e.clientX);
      e.preventDefault();
    });
    window.addEventListener("mousemove", onWindowMove);
    window.addEventListener("mouseup", onWindowUp);
  });

  // ---------- Playback state ----------
  let currentTime = 0;   // seconds from start
  let currentSampleIdx = 0;
  let playing = false;
  let lastFrame = 0;

  const scrub = document.getElementById("scrub");
  const playBtn = document.getElementById("play-btn");
  const speedSelect = document.getElementById("speed-select");

  // Pick a sensible default speed so the trip plays back in roughly 30–60 s.
  function autoPlaySpeed(dur) {
    if (dur <= 1800) return 64;   // ≤ 30 min
    if (dur <= 3600) return 128;  // ≤ 1 h
    if (dur <= 7200) return 256;  // ≤ 2 h
    return 512;                   // > 2 h
  }
  let playSpeed = autoPlaySpeed(duration);
  // Sync the <select> to the chosen default.
  speedSelect.value = String(playSpeed);

  playBtn.addEventListener("click", () => {
    playing = !playing;
    playBtn.textContent = playing ? "\u2759\u2759" : "\u25b6";
    playBtn.classList.toggle("playing", playing);
    lastFrame = performance.now();
    if (playing && currentTime >= duration) {
      setCurrentTime(0);
    }
    if (playing) requestAnimationFrame(loop);
  });

  scrub.addEventListener("input", e => {
    const t = (e.target.value / 1000) * duration;
    setCurrentTime(t);
  });

  speedSelect.addEventListener("change", e => {
    playSpeed = parseFloat(e.target.value);
  });

  function setCurrentTime(t) {
    currentTime = Math.max(0, Math.min(duration, t));
    // Find nearest sample
    const target = t0 + currentTime;
    let lo = 0, hi = ts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (ts[mid][SEC] < target) lo = mid + 1; else hi = mid;
    }
    currentSampleIdx = lo;
    updateUI();
  }

  function updateUI() {
    const row = ts[currentSampleIdx];
    // Dashboard
    const speed = row[SPD];
    const maxSpeed = Math.max(track.stats?.maxSpeed || 60, 60);
    document.getElementById("speedo-value").textContent = speed.toFixed(1);
    const ratio = Math.min(1, speed / maxSpeed);
    document.getElementById("speedo-fill").style.strokeDashoffset = (157 * (1 - ratio)).toFixed(1);
    const angle = -90 + ratio * 180;
    document.getElementById("speedo-needle").style.transform = "rotate(" + angle + "deg)";

    const batt = row[BATT];
    document.getElementById("battery-value").textContent = batt.toFixed(0) + "%";
    const bf = document.getElementById("battery-fill");
    bf.style.width = Math.max(0, Math.min(100, batt)) + "%";
    bf.classList.toggle("low", batt < 20);

    document.getElementById("odo-value").textContent = cumKm[currentSampleIdx].toFixed(2);
    document.getElementById("volt-value").textContent = row[VOLT].toFixed(1);
    document.getElementById("temp-value").textContent = row[TEMP].toFixed(1);
    document.getElementById("alt-value").textContent = row[ALT].toFixed(0);
    document.getElementById("clock-value").textContent = fmtTime(currentTime);

    // Scrub
    if (document.activeElement !== scrub) {
      scrub.value = duration > 0 ? (currentTime / duration) * 1000 : 0;
    }

    // Charts: update readings + cursors
    charts.forEach(c => {
      const v = row[c.cfg.idx];
      c.reading.textContent = v.toFixed(1) + c.cfg.unit;
      drawChart(c);
    });

    // Map marker + traveled line
    if (map && riderMarker && map.isStyleLoaded() && map.getSource("traveled")) {
      if (coords.length > 1) {
        currentRouteIdx = Math.round((currentSampleIdx / Math.max(1, ts.length - 1)) * (coords.length - 1));
        currentRouteIdx = Math.max(0, Math.min(coords.length - 1, currentRouteIdx));
        const markerPos = coords[currentRouteIdx];
        riderMarker.setLngLat(markerPos);

        const traveled = coords.slice(0, currentRouteIdx + 1);
        if (traveled.length >= 2) {
          map.getSource("traveled").setData({
            type: "Feature", geometry: { type: "LineString", coordinates: traveled }
          });

          if (currentColorMode !== "solid") {
            const built = buildTraveledGradientExpr(currentColorMode, currentRouteIdx);
            if (built) {
              map.setPaintProperty("traveled-line", "line-gradient", built.expr);
              map.setPaintProperty("traveled-line", "line-color", "#ffffff");
            }
          }
        }
        if (followCamera && playing) {
          map.easeTo({ center: markerPos, duration: 200 });
        }
      }
    }
  }

  function loop(now) {
    if (!playing) return;
    const dt = (now - lastFrame) / 1000;
    lastFrame = now;
    let nt = currentTime + dt * playSpeed;
    if (nt >= duration) {
      nt = duration;
      playing = false;
      playBtn.textContent = "\u25b6";
      playBtn.classList.remove("playing");
    }
    setCurrentTime(nt);
    if (playing) requestAnimationFrame(loop);
  }

  // ---------- Init ----------
  window.addEventListener("resize", resizeCharts);
  // Wait a frame so layout settles, then size canvases
  requestAnimationFrame(() => {
    resizeCharts();
    setCurrentTime(0);
  });
})();
