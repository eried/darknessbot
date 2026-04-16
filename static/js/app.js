document.addEventListener("DOMContentLoaded", function () {
  // --- Map setup with multiple tile layers ---
  const osmLayer = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
  });
  const satelliteLayer = L.tileLayer(
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    { maxZoom: 19 }
  );
  const topoLayer = L.tileLayer("https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png", {
    maxZoom: 17,
  });

  const map = L.map("map", {
    center: [65, 15],
    zoom: 5,
    zoomControl: false,
    preferCanvas: true,
    zoomSnap: 1,
    layers: [osmLayer],
  });

  map.getContainer().classList.add("dark-tiles");
  map.on("baselayerchange", function (e) {
    if (e.name === "Satellite") {
      map.getContainer().classList.remove("dark-tiles");
    } else {
      map.getContainer().classList.add("dark-tiles");
    }
  });

  L.control.zoom({ position: "bottomleft" }).addTo(map);
  L.control.layers(
    { "Dark": osmLayer, "Satellite": satelliteLayer, "Topo": topoLayer },
    null,
    { position: "bottomleft" }
  ).addTo(map);

  // --- State ---
  let allTracks = [];
  let selectedIdx = -1;
  let paintMode = null;
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

  function distanceColor(t) {
    t = Math.max(0, Math.min(1, t));
    const r = Math.round(30 * t);
    const g = Math.round(220 * (1 - t * 0.7));
    const b = Math.round(100 * (1 - t * 0.8));
    return `${r},${g},${b}`;
  }

  const PAINT_METRICS = {
    distance: { pointIdx: -1, label: "Distance" },
    speed:    { pointIdx: 2, label: "Speed" },
    voltage:  { pointIdx: 4, label: "Voltage" },
    temp:     { pointIdx: 5, label: "Temp" },
    altitude: { pointIdx: 3, label: "Altitude" },
  };

  // --- Glow canvas overlay ---
  const GlowLayer = L.Layer.extend({
    onAdd(map) {
      this._map = map;
      this._canvas = L.DomUtil.create("canvas", "glow-canvas");
      this._canvas.style.pointerEvents = "none";
      map.getPane("overlayPane").appendChild(this._canvas);
      this._ctx = this._canvas.getContext("2d");
      this._latLngs = [];
      this._selected = -1;
      this._visible = null;
      this._onViewChange = this._onViewChange.bind(this);
      map.on("moveend zoomend viewreset resize", this._onViewChange);
      this._onViewChange();
    },
    onRemove(map) {
      L.DomUtil.remove(this._canvas);
      map.off("moveend zoomend viewreset resize", this._onViewChange);
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
    _onViewChange() { this._draw(); },
    _draw() {
      if (!this._map) return;
      const map = this._map;
      const size = map.getSize();
      const pad = 512;
      const w = size.x + pad * 2;
      const h = size.y + pad * 2;
      this._canvas.width = w;
      this._canvas.height = h;
      const topLeft = map.containerPointToLayerPoint([-pad, -pad]);
      L.DomUtil.setPosition(this._canvas, topLeft);
      const ctx = this._ctx;
      ctx.clearRect(0, 0, w, h);
      if (!this._latLngs.length) return;

      const sel = this._selected;
      const vis = this._visible;
      const ox = topLeft.x;
      const oy = topLeft.y;

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

      const basePasses = cyanPasses.map((p) => ({
        ...p, alpha: sel >= 0 ? p.alpha * 0.3 : p.alpha,
      }));

      function drawTrack(lls) {
        if (lls.length < 2) return;
        ctx.beginPath();
        const p0 = map.latLngToLayerPoint(lls[0]);
        ctx.moveTo(p0.x - ox, p0.y - oy);
        for (let i = 1; i < lls.length; i++) {
          const pt = map.latLngToLayerPoint(lls[i]);
          ctx.lineTo(pt.x - ox, pt.y - oy);
        }
        ctx.stroke();
      }

      // Draw non-selected visible tracks
      for (const pass of basePasses) {
        ctx.strokeStyle = `rgba(${pass.color},${pass.alpha})`;
        ctx.lineWidth = pass.width;
        ctx.lineJoin = "round";
        ctx.lineCap = "round";
        ctx.globalCompositeOperation = "lighter";
        for (let t = 0; t < this._latLngs.length; t++) {
          if (t === sel) continue;
          if (vis && !vis.has(t)) continue;
          drawTrack(this._latLngs[t]);
        }
      }

      // Draw selected track on top
      if (sel >= 0 && sel < this._latLngs.length) {
        const lls = this._latLngs[sel];
        if (lls.length >= 2) {
          if (this._paintData && this._paintData.trackIdx === sel) {
            const pd = this._paintData;
            const layerPts = lls.map(ll => {
              const p = map.latLngToLayerPoint(ll);
              return [p.x - ox, p.y - oy];
            });
            const heatPasses = [
              { width: 12, alpha: 0.1,  comp: "lighter" },
              { width: 6,  alpha: 0.3,  comp: "lighter" },
              { width: 3,  alpha: 0.9,  comp: "source-over" },
            ];
            for (const pass of heatPasses) {
              ctx.lineWidth = pass.width;
              ctx.lineJoin = "round";
              ctx.lineCap = "round";
              ctx.globalCompositeOperation = pass.comp;
              for (let i = 1; i < layerPts.length; i++) {
                const t = pd.span ? (pd.values[i] - pd.min) / pd.span : 0.5;
                ctx.strokeStyle = `rgba(${(pd.colorFn || heatColor)(t)},${pass.alpha})`;
                ctx.beginPath();
                ctx.moveTo(layerPts[i-1][0], layerPts[i-1][1]);
                ctx.lineTo(layerPts[i][0], layerPts[i][1]);
                ctx.stroke();
              }
            }
          } else {
            for (const pass of orangePasses) {
              ctx.strokeStyle = `rgba(${pass.color},${pass.alpha})`;
              ctx.lineWidth = pass.width;
              ctx.lineJoin = "round";
              ctx.lineCap = "round";
              ctx.globalCompositeOperation = pass.width <= 4 ? "source-over" : "lighter";
              drawTrack(lls);
            }
          }
        }
      }
    },
  });

  const glowLayer = new GlowLayer();
  glowLayer.addTo(map);

  function updateGlow() {
    const latLngs = allTracks.map((t) => t.points.map((p) => L.latLng(p[0], p[1])));
    glowLayer.setData(latLngs, selectedIdx);
    glowLayer.setVisible(trackVisible);
    if (paintMode && paintMode.trackIdx === selectedIdx && allTracks[paintMode.trackIdx]) {
      const pts = allTracks[paintMode.trackIdx].points;
      let values, min, max, colorFn;
      if (paintMode.pointIdx === -1) {
        values = pts.map((_, idx) => idx);
        min = 0; max = pts.length - 1;
        colorFn = distanceColor;
      } else {
        values = pts.map(p => p[paintMode.pointIdx]);
        min = Infinity; max = -Infinity;
        for (const v of values) { if (v < min) min = v; if (v > max) max = v; }
        colorFn = heatColor;
      }
      glowLayer.setPaint({ trackIdx: paintMode.trackIdx, values, min, max, span: max - min, colorFn });
    } else {
      glowLayer.setPaint(null);
    }
  }

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
    const cumKm = getCumDistPts(allTracks[selectedIdx])[bestIdx] || 0;

    let html = `<i class="clr" style="background:${"#66bb6a"}"></i>Dist: <b>${cumKm.toFixed(2)}</b> km`;
    html += `<br><i class="clr" style="background:#00e5ff"></i>Speed: <b>${speed.toFixed(1)}</b> km/h`;
    if (volt) html += `<br><i class="clr" style="background:#ff5252"></i>Voltage: <b>${volt.toFixed(1)}</b> V`;
    if (temp) html += `<br><i class="clr" style="background:#ffa000"></i>Temp: <b>${temp.toFixed(0)}</b> &deg;C`;
    if (batt) html += `<br><i class="clr" style="background:#69f0ae"></i>Battery: <b>${batt.toFixed(0)}</b>%`;
    if (alt)  html += `<br><i class="clr" style="background:#ce93d8"></i>Alt: <b>${alt.toFixed(0)}</b> m`;

    tooltip.innerHTML = html;
    tooltip.style.left = (e.clientX + 14) + "px";
    tooltip.style.top = (e.clientY - 10) + "px";
    tooltip.classList.remove("hidden");

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
  const progressArea = document.getElementById("progress-area");
  const progressFill = document.getElementById("progress-fill");
  const progressText = document.getElementById("progress-text");
  const panel = document.getElementById("trip-panel");
  const panelTab = document.getElementById("panel-tab");
  const panelTabText = document.getElementById("panel-tab-text");
  const tripList = document.getElementById("trip-list");
  const tripDetail = document.getElementById("trip-detail");
  const parserWorker = createParserWorker();
  const RECENT_DB_NAME = "darknessbot-trip-viewer";
  const RECENT_STORE_NAME = "recentFiles";
  const SESSION_STORE_NAME = "currentSession";
  const SESSION_KEY = "tracks";
  const MAX_RECENT_FILES = 5;
  let recentDbPromise = null;
  const recentUi = createRecentFilesUi();

  // --- Upload with client-side parsing ---
  async function handleFile(file, append) {
    const lname = file.name.toLowerCase();
    if (!lname.endsWith(".dbb") && !lname.endsWith(".csv")) return;

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

    if (!append) {
      uploadLabel.classList.add("hidden");
      progressArea.classList.remove("hidden");
      progressFill.style.width = "0%";
    }
    setProgress("Loading...");

    try {
      const parsedTracks = await parseFileLocally(parserWorker, file, (msg) => {
        if (msg.type === "progress") {
          const pct = Math.round((msg.current / msg.total) * 100);
          if (!append) progressFill.style.width = pct + "%";
          setProgress(`Parsing trip ${msg.current} of ${msg.total}`);
        }
      });

      if (!parsedTracks.length) {
        setProgress("No trip data found in file", true);
        if (!append) uploadLabel.classList.remove("hidden");
        return;
      }

      await saveRecentFile(file.name, parsedTracks);
      loadTracks(append ? [...allTracks, ...parsedTracks] : parsedTracks);
      saveTracks(allTracks);
    } catch (e) {
      setProgress("Error: " + e.message, true);
      if (!append) uploadLabel.classList.remove("hidden");
    }
  }

  function createParserWorker() {
    return new Worker("static/js/parser-worker.js?v=5");
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
      worker.postMessage({ type: "parse", file });
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
        const request = indexedDB.open(RECENT_DB_NAME, 2);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains(RECENT_STORE_NAME)) {
            db.createObjectStore(RECENT_STORE_NAME, { keyPath: "id" });
          }
          if (!db.objectStoreNames.contains(SESSION_STORE_NAME)) {
            db.createObjectStore(SESSION_STORE_NAME);
          }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error("Failed to open recent files database"));
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

  async function saveRecentFile(fileName, tracks) {
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
    };

    const tx = db.transaction(RECENT_STORE_NAME, "readwrite");
    const store = tx.objectStore(RECENT_STORE_NAME);
    store.put(entry);

    const duplicates = existing.filter((item) => item.fileName === fileName);
    duplicates.forEach((item) => store.delete(item.id));

    const nextItems = [entry].concat(existing.filter((item) => item.fileName !== fileName));
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
    const entry = await getRecentFile(id);
    if (!entry || !entry.tracks || !entry.tracks.length) return;
    saveTracks(entry.tracks);
    loadTracks(entry.tracks);
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

      items.forEach((item) => {
        const row = document.createElement("div");
        row.className = "recent-file-item";
        row.innerHTML = `
          <button type="button" class="recent-file-load">
            <span class="recent-file-name">${escapeHtml(item.fileName)}</span>
            <span class="recent-file-meta">${item.tripCount} trips &middot; ${item.totalKm.toFixed(1)} km &middot; ${escapeHtml(formatRecentTime(item.loadedAt))}</span>
          </button>
          <button type="button" class="recent-file-remove" title="Remove from recent">&times;</button>
        `;

        row.querySelector(".recent-file-load").addEventListener("click", () => {
          loadRecentFile(item.id);
        });
        row.querySelector(".recent-file-remove").addEventListener("click", (event) => {
          event.stopPropagation();
          removeRecentFile(item.id);
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
  function saveTracks(tracks) {
    const data = JSON.stringify(tracks);
    try { localStorage.setItem("dbb_tracks", data); } catch {}
    try { sessionStorage.setItem("dbb_tracks", data); } catch {}
    saveSessionTracks(tracks).catch(() => {});
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

  function applyRoute() {
    const hash = location.hash;
    if (hash === "#view" && allTracks.length) {
      overlay.classList.add("hidden");
      panel.classList.remove("hidden");
      updateGlow();
    } else if (hash === "#view") {
      const cached = loadCachedTracks();
      if (cached && cached.length) {
        loadTracks(cached, true);
      } else {
        loadSessionTracks().then((idbTracks) => {
          if (idbTracks && idbTracks.length) loadTracks(idbTracks, true);
          else navigate("#load", true);
        });
      }
    } else {
      overlay.classList.remove("hidden");
      panel.classList.add("hidden");
      panel.classList.remove("open");
      resetUploadUI();
    }
  }

  function resetUploadUI() {
    uploadLabel.classList.remove("hidden");
    progressArea.classList.add("hidden");
    progressText.classList.remove("error");
    fileInput.value = "";
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
    fitAll();

    panelTabText.textContent = `Trip Explorer (${tracks.length})`;
    buildTripList();

    if (!skipNav) navigate("#view", false);
    else {
      overlay.classList.add("hidden");
      panel.classList.remove("hidden");
    }

    // Auto-open panel with smooth animation
    setTimeout(() => panel.classList.add("open"), 150);

    // Auto-select the first (newest) track so the map & details aren't empty.
    if (tracks.length > 0) {
      setTimeout(() => selectTrip(0), 200);
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
    if (exportBtn) {
      const n = trackVisible.size;
      exportBtn.textContent = n > 0 ? `Export selected (${n})` : "Export selected";
      exportBtn.style.opacity = n > 0 ? "" : "0.3";
    }
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
          <div class="summary-row"><span>${selKm.toFixed(1)}</span> km</div>
          <div class="summary-row"><span>${hrs}h ${mins}m</span> riding</div>
          <div class="summary-row"><span>${selTop}</span> km/h top</div>
        `;
      }
    }
  }

  // --- Build trip list ---
  function buildTripList() {
    tripList.innerHTML = "";
    const header = document.getElementById("panel-header");
    header.innerHTML = "";

    // Summary
    let totalKm = 0, totalSec = 0, topSpeed = 0;
    for (const t of allTracks) {
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
      <div class="summary-row"><span>${allTracks.length}</span> trips</div>
      <div class="summary-row"><span>${totalKm.toFixed(1)}</span> km</div>
      <div class="summary-row"><span>${hrs}h ${mins}m</span> riding</div>
      <div class="summary-row"><span>${topSpeed}</span> km/h top</div>
    `;
    header.appendChild(summary);

    // "All trips" checkbox row with expand/collapse buttons
    const allRow = document.createElement("div");
    allRow.className = "all-trips-row";
    allRow.innerHTML = `
      <label><input type="checkbox" class="all-check" checked> All trips</label>
      <div class="tree-actions">
        <span class="tree-btn expand-all" title="Expand all">&#9662;</span>
        <span class="tree-btn collapse-all" title="Collapse all">&#9652;</span>
      </div>
    `;
    allRow.querySelector(".all-check").addEventListener("change", (e) => {
      if (e.target.checked) {
        trackVisible = new Set(allTracks.map((_, i) => i));
      } else {
        trackVisible = new Set();
        if (selectedIdx >= 0) {
          selectedIdx = -1;
          paintMode = null;
          tripList.querySelectorAll(".paint-btn.active").forEach(b => b.classList.remove("active"));
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
    allRow.querySelector(".expand-all").addEventListener("click", () => {
      tripList.querySelectorAll(".year-group, .month-group").forEach(g => g.classList.add("expanded"));
    });
    allRow.querySelector(".collapse-all").addEventListener("click", () => {
      tripList.querySelectorAll(".year-group, .month-group").forEach(g => g.classList.remove("expanded"));
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
    const brushSvg = `<svg viewBox="0 0 12 12" width="10" height="10"><path d="M8.5 1.5l2 2-5.5 5.5H3V7z" fill="currentColor"/></svg>`;
    const paintIcon = (key, ti) => `<span class="paint-btn" data-key="${key}" data-track="${ti}" style="color:${COLORS[key]}" title="Color track by ${key}">${brushSvg}</span>`;

    function buildTripItem(t, i) {
      const li = document.createElement("div");
      li.className = "trip-item";
      li.dataset.idx = i;
      const s = t.stats;

      let detailHtml = "";
      if (s.distanceKm) detailHtml += `<div class="detail-row"><span>${paintIcon("distance", i)}<i class="clr" style="background:${COLORS.distance}"></i>Distance</span><span>${s.distanceKm} km</span></div>`;
      detailHtml += `<div class="detail-row"><span>${paintIcon("speed", i)}<i class="clr" style="background:${COLORS.speed}"></i>Speed</span><span>${s.avgSpeed} / ${s.maxSpeed} km/h</span></div>`;
      if (s.maxVoltage) detailHtml += `<div class="detail-row"><span>${paintIcon("voltage", i)}<i class="clr" style="background:${COLORS.voltage}"></i>Voltage</span><span>${s.minVoltage} - ${s.maxVoltage} V</span></div>`;
      if (s.maxTemp) detailHtml += `<div class="detail-row"><span>${paintIcon("temp", i)}<i class="clr" style="background:${COLORS.temp}"></i>Temp</span><span>${s.maxTemp} &deg;C</span></div>`;
      if (s.maxAlt) detailHtml += `<div class="detail-row"><span>${paintIcon("altitude", i)}<i class="clr" style="background:${COLORS.altitude}"></i>Altitude</span><span>${s.minAlt} - ${s.maxAlt} m</span></div>`;
      if (t.dateStart) {
        const start = t.dateStart.split("T")[1]?.substring(0, 8) || "";
        const end = t.dateEnd.split("T")[1]?.substring(0, 8) || "";
        if (start) detailHtml += `<div class="detail-row"><span>Time</span><span>${start} - ${end}</span></div>`;
      }
      detailHtml += `<div class="chart-wrap"><canvas class="trip-chart" data-idx="${i}"></canvas><div class="chart-tooltip hidden"></div></div>`;

      const meta = s.points > 0
        ? `${s.distanceKm} km &middot; ${s.maxSpeed} km/h max`
        : `No GPS &middot; ${s.maxSpeed} km/h max &middot; ${(s.rows || 0).toLocaleString()} samples`;

      li.innerHTML = `
        <div class="trip-header">
          <input type="checkbox" class="trip-check" data-idx="${i}" ${trackVisible.has(i) ? "checked" : ""}>
          <div class="trip-info">
            <div class="trip-date">${t.date || t.name}</div>
            <div class="trip-meta">${meta}</div>
          </div>
          <a class="inspect-btn" href="inspector.html?i=${i}" title="Open trip inspector">
            <svg viewBox="0 0 16 16" width="14" height="14"><circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" stroke-width="1.5"/><line x1="10.5" y1="10.5" x2="14" y2="14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
          </a>
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
            paintMode = null;
            tripList.querySelectorAll(".paint-btn.active").forEach(b => b.classList.remove("active"));
            tooltip.classList.add("hidden");
            hideChartMarker();
            li.classList.remove("active");
          }
        }
        updateGlow();
        updateVisibilityUI();
        updateGroupCheckbox(li.closest(".month-group"));
      });

      li.addEventListener("click", (e) => {
        if (e.target.closest(".trip-check")) return;
        if (e.target.closest(".inspect-btn")) { e.stopPropagation(); return; }
        const pb = e.target.closest(".paint-btn");
        if (pb) {
          e.stopPropagation();
          const key = pb.dataset.key;
          const ti = parseInt(pb.dataset.track);
          if (paintMode && paintMode.trackIdx === ti && paintMode.key === key) {
            paintMode = null;
          } else {
            paintMode = { trackIdx: ti, key, pointIdx: PAINT_METRICS[key].pointIdx };
          }
          tripList.querySelectorAll(".paint-btn").forEach(b => b.classList.remove("active"));
          if (paintMode) {
            tripList.querySelectorAll(`.paint-btn[data-key="${paintMode.key}"][data-track="${paintMode.trackIdx}"]`)
              .forEach(b => b.classList.add("active"));
          }
          if (selectedIdx !== ti) { selectTrip(ti); return; }
          updateGlow();
          return;
        }
        if (e.target.closest(".chart-wrap")) return;
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
      container.querySelectorAll(".trip-check").forEach(cb => {
        const idx = parseInt(cb.dataset.idx);
        cb.checked = checked;
        if (checked) trackVisible.add(idx);
        else {
          trackVisible.delete(idx);
          if (selectedIdx === idx) {
            selectedIdx = -1;
            paintMode = null;
            tripList.querySelectorAll(".paint-btn.active").forEach(b => b.classList.remove("active"));
            const item = cb.closest(".trip-item");
            if (item) item.classList.remove("active");
          }
        }
      });
      // Sync inner month checkboxes when toggling a year
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
        const yearKm = yg.monthOrder.reduce((s, mg) => s + mg.indices.reduce((s2, i) => s2 + allTracks[i].stats.distanceKm, 0), 0);
        const yearTrips = yg.monthOrder.reduce((s, mg) => s + mg.indices.length, 0);

        const yHeader = document.createElement("div");
        yHeader.className = "year-header";
        yHeader.innerHTML = `
          <input type="checkbox" class="year-check" checked>
          <span class="year-label">${yg.year}</span>
          <span class="year-meta">${yearTrips} trips &middot; ${yearKm.toFixed(1)} km</span>
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
      const groupKm = mg.indices.reduce((sum, i) => sum + allTracks[i].stats.distanceKm, 0);

      const header = document.createElement("div");
      header.className = "month-header";
      header.innerHTML = `
        <input type="checkbox" class="month-check" checked>
        <span class="month-label">${mg.month}</span>
        <span class="month-meta">${mg.indices.length} trips &middot; ${groupKm.toFixed(1)} km</span>
        <span class="month-chevron">&#9662;</span>
      `;

      const body = document.createElement("div");
      body.className = "month-body";
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
      });

      mg.indices.forEach(i => body.appendChild(buildTripItem(allTracks[i], i)));
      groupEl.appendChild(header);
      groupEl.appendChild(body);
      return groupEl;
    }

    // Footer: add more + selected summary + export
    const footer = document.getElementById("panel-footer");
    footer.innerHTML = "";

    const navRow = document.createElement("div");
    navRow.className = "footer-nav-row";

    const addBtn = document.createElement("label");
    addBtn.className = "add-more-btn";
    addBtn.innerHTML = `+ Add more <input type="file" accept=".dbb,.csv" style="display:none" />`;
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
    homeBtn.textContent = "Back to main screen";
    homeBtn.addEventListener("click", () => navigate("#load"));
    navRow.appendChild(homeBtn);

    footer.appendChild(navRow);

    const selSummary = document.createElement("div");
    selSummary.className = "trip-summary selected-summary hidden";
    footer.appendChild(selSummary);

    const exportBtn = document.createElement("div");
    exportBtn.className = "export-btn";
    exportBtn.textContent = `Export selected (${trackVisible.size})`;
    exportBtn.addEventListener("click", exportSelected);
    footer.appendChild(exportBtn);

    updateVisibilityUI();
  }

  // --- Export ---
  function trackToCSV(track) {
    const header = "Date,Speed,Voltage,PWM,Current,Power,Battery level,Total mileage,Temperature,Pitch,Roll,Latitude,Longitude,Altitude\n";
    let csv = header;
    const t0 = track.dateStart ? new Date(track.dateStart).getTime() : 0;
    for (const row of track.timeseries) {
      let dateStr = "";
      if (t0) {
        const d = new Date(t0 + row[0] * 1000);
        dateStr = d.toISOString().replace("Z", "");
      }
      csv += [dateStr, row[1], row[2], "", "", "", row[4], "", row[3], "", "", row[6], row[7], row[5]].join(",") + "\n";
    }
    return csv;
  }

  async function exportSelected() {
    const indices = [...trackVisible];
    if (indices.length === 0) return;

    if (indices.length === 1) {
      const track = allTracks[indices[0]];
      const csv = trackToCSV(track);
      const blob = new Blob([csv], { type: "text/csv" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = (track.name || "trip") + ".csv";
      a.click();
      URL.revokeObjectURL(url);
    } else {
      if (typeof JSZip === "undefined") {
        alert("Export library not loaded. Please refresh and try again.");
        return;
      }
      const zip = new JSZip();
      for (const idx of indices) {
        const track = allTracks[idx];
        const csv = trackToCSV(track);
        zip.file((track.name || `trip_${idx}`) + ".csv", csv);
      }
      const blob = await zip.generateAsync({ type: "blob", compression: "DEFLATE" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "trips_export.dbb";
      a.click();
      URL.revokeObjectURL(url);
    }
  }

  // --- Mini chart rendering ---
  const CHART_COLORS = {
    speed:    "#00e5ff",
    voltage:  "#ff5252",
    temp:     "#ffa000",
    battery:  "#69f0ae",
    altitude: "#ce93d8",
  };

  const SERIES = [
    { idx: 1, key: "speed",    label: "Speed",   unit: "km/h" },
    { idx: 2, key: "voltage",  label: "Voltage", unit: "V" },
    { idx: 3, key: "temp",     label: "Temp",    unit: "\u00b0C" },
    { idx: 4, key: "battery",  label: "Battery", unit: "%" },
    { idx: 5, key: "altitude", label: "Alt",     unit: "m" },
  ];

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

    const activeSeries = SERIES.filter(s => {
      for (const row of ts) if (row[s.idx] !== 0) return true;
      return false;
    });

    const ranges = {};
    for (const s of activeSeries) {
      let min = Infinity, max = -Infinity;
      for (const row of ts) {
        const v = row[s.idx];
        if (v < min) min = v;
        if (v > max) max = v;
      }
      const span = max - min || 1;
      ranges[s.key] = { min: min - span * 0.05, max: max + span * 0.05 };
    }

    const tMin = ts[0][0];
    const tMax = ts[ts.length - 1][0];
    const tSpan = tMax - tMin || 1;

    for (const s of activeSeries) {
      const r = ranges[s.key];
      const rSpan = r.max - r.min || 1;
      ctx.beginPath();
      ctx.strokeStyle = CHART_COLORS[s.key];
      ctx.lineWidth = 1.2;
      ctx.globalAlpha = 0.8;
      for (let i = 0; i < ts.length; i++) {
        const x = pad.left + ((ts[i][0] - tMin) / tSpan) * cw;
        const y = pad.top + ch - ((ts[i][s.idx] - r.min) / rSpan) * ch;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    canvas._chartData = { ts, activeSeries, ranges, tMin, tSpan, pad, cw, ch, w, h };

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
      document.querySelectorAll(".chart-tooltip").forEach(t => t.classList.add("hidden"));
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
    const wrap = canvas.closest(".chart-wrap");
    const tip = wrap.querySelector(".chart-tooltip");

    const trackIdx = parseInt(canvas.dataset.idx);
    const cumKm = getCumDistTs(allTracks[trackIdx])[best] || 0;

    let html = `<span style="color:#888">${formatSec(row[0])}</span> <span style="color:#66bb6a">${cumKm.toFixed(2)} km</span>`;
    for (const s of cd.activeSeries) {
      html += `<br><i class="clr" style="background:${CHART_COLORS[s.key]}"></i>${s.label}: <b>${row[s.idx].toFixed(1)}</b> ${s.unit}`;
    }
    tip.innerHTML = html;
    tip.classList.remove("hidden");

    const tipW = tip.offsetWidth;
    let tx = mx + 10;
    if (tx + tipW > rect.width) tx = mx - tipW - 10;
    tip.style.left = tx + "px";
    tip.style.top = "4px";

    drawChart(canvas, parseInt(canvas.dataset.idx));
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

  document.addEventListener("mouseleave", () => { hideChartMarker(); }, true);

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

  function selectTrip(idx) {
    if (selectedIdx === idx) {
      selectedIdx = -1;
      paintMode = null;
      tripList.querySelectorAll(".paint-btn.active").forEach(b => b.classList.remove("active"));
      updateGlow();
      fitAll();
      tooltip.classList.add("hidden");
      hideChartMarker();
      document.querySelectorAll(".trip-item.active").forEach((el) => el.classList.remove("active"));
      updateVisibilityUI();
      return;
    }

    selectedIdx = idx;
    paintMode = null;
    tripList.querySelectorAll(".paint-btn.active").forEach(b => b.classList.remove("active"));

    // Force selected track visible and check its checkbox
    trackVisible.add(idx);
    const cb = tripList.querySelector(`.trip-check[data-idx="${idx}"]`);
    if (cb) cb.checked = true;

    updateGlow();
    fitTrack(idx);
    panel.classList.add("open");

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

  panelTab.addEventListener("click", () => panel.classList.toggle("open"));

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

  // --- Programmatic data injection (used by EvenDarkerBot Android app) ---
  // Accepts a base64-encoded .dbb (ZIP) or .csv file and loads it.
  // Does NOT save to recents or cache — keeps the viewer clean for embedded use.
  window.loadDbbFromBase64 = async function (base64String, filename) {
    filename = filename || "import.dbb";
    try {
      const binary = atob(base64String);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const file = new File([bytes], filename, { type: "application/octet-stream" });
      const lname = file.name.toLowerCase();
      if (!lname.endsWith(".dbb") && !lname.endsWith(".csv")) return { success: false, error: "Unsupported file type" };

      const parsedTracks = await parseFileLocally(parserWorker, file, () => {});

      if (!parsedTracks.length) return { success: false, error: "No trip data found" };

      // Load directly — no saveRecentFile, no saveTracks
      loadTracks(parsedTracks);
      return { success: true };
    } catch (e) {
      return { success: false, error: e.message };
    }
  };

  // --- Init ---
  const isEmbedded = new URLSearchParams(location.search).has("embedded");
  if (isEmbedded) {
    // Embedded mode: hide upload UI, wait for loadDbbFromBase64() call
    overlay.classList.add("hidden");
  } else {
    renderRecentFiles();
    if (!location.hash) navigate("#load", true);
    else applyRoute();
  }
});
