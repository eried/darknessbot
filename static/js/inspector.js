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
  const gpsPoints = ts.filter(r => r[LAT] !== 0 && r[LON] !== 0);
  const hasGps = gpsPoints.length > 1;

  let map = null, riderMarker = null, followCamera = true;
  if (hasGps) {
    const lats = gpsPoints.map(r => r[LAT]);
    const lons = gpsPoints.map(r => r[LON]);
    const center = [(Math.min(...lons) + Math.max(...lons)) / 2, (Math.min(...lats) + Math.max(...lats)) / 2];

    map = new maplibregl.Map({
      container: "map",
      style: {
        version: 8,
        glyphs: "https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf",
        sources: {
          "osm": {
            type: "raster",
            tiles: [
              "https://a.tile.openstreetmap.org/{z}/{x}/{y}.png",
              "https://b.tile.openstreetmap.org/{z}/{x}/{y}.png",
              "https://c.tile.openstreetmap.org/{z}/{x}/{y}.png"
            ],
            tileSize: 256,
            attribution: "\u00a9 OpenStreetMap"
          },
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
          { id: "osm", type: "raster", source: "osm",
            paint: { "raster-brightness-min": 0.1, "raster-brightness-max": 0.85, "raster-contrast": 0.15, "raster-saturation": -0.2 } }
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

      // Track line
      const coords = ts.filter(r => r[LAT] !== 0 && r[LON] !== 0).map(r => [r[LON], r[LAT]]);
      map.addSource("track", {
        type: "geojson",
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

      // Traveled portion (updated during playback)
      map.addSource("traveled", {
        type: "geojson",
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

      // Fit bounds
      const b = new maplibregl.LngLatBounds();
      coords.forEach(c => b.extend(c));
      map.fitBounds(b, { padding: 40, pitch: 60, duration: 0 });

      // Rider marker
      const el = document.createElement("div");
      el.className = "rider-dot";
      riderMarker = new maplibregl.Marker({ element: el })
        .setLngLat(coords[0])
        .addTo(map);

      // Disable auto-follow when user drags
      map.on("dragstart", () => { followCamera = false; });

      // Sync any scrubbing that happened before map load
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
    c.canvas.addEventListener("mousedown", e => { dragging = true; onMove(e.clientX); });
    c.canvas.addEventListener("mousemove", e => { if (dragging) onMove(e.clientX); });
    window.addEventListener("mouseup", () => { dragging = false; });
    c.canvas.addEventListener("click", e => onMove(e.clientX));
  });

  // ---------- Playback state ----------
  let currentTime = 0;   // seconds from start
  let currentSampleIdx = 0;
  let playing = false;
  let playSpeed = 16;
  let lastFrame = 0;

  const scrub = document.getElementById("scrub");
  const playBtn = document.getElementById("play-btn");
  const speedSelect = document.getElementById("speed-select");

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
      const lat = row[LAT], lon = row[LON];
      if (lat !== 0 || lon !== 0) {
        riderMarker.setLngLat([lon, lat]);
        // Build traveled coords (only GPS-bearing samples up to current)
        const traveled = [];
        for (let i = 0; i <= currentSampleIdx; i++) {
          if (ts[i][LAT] !== 0 || ts[i][LON] !== 0) traveled.push([ts[i][LON], ts[i][LAT]]);
        }
        if (traveled.length >= 2) {
          map.getSource("traveled").setData({
            type: "Feature", geometry: { type: "LineString", coordinates: traveled }
          });
        }
        if (followCamera && playing) {
          map.easeTo({ center: [lon, lat], duration: 200 });
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
