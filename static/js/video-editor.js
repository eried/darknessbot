// Video Overlay Studio: composites EUC telemetry over ride footage, all
// in the browser. Loads the trip from the viewer session (IndexedDB,
// same store the inspector reads), or any trip file via parser-worker.
// Optional Dragy .vbo adds GPS speed + a track map source. Export renders
// frame-by-frame through WebCodecs into an MP4 (mp4-muxer), falling back
// to MediaRecorder when WebCodecs is unavailable.
(async function () {
  "use strict";

  // --- Units: same resolution order as the viewer (?units= param, then
  // the cogwheel's localStorage key, then US-timezone inference). ---
  const IMPERIAL_TZ_RE = new RegExp("^(?:" +
    "America\\/(?:Adak|Anchorage|Boise|Chicago|Denver|Detroit|Indiana/[^/]+|Juneau|Kentucky/[^/]+|Los_Angeles|Menominee|Metlakatla|New_York|Nome|North_Dakota/[^/]+|Phoenix|Puerto_Rico|Sitka|St_Thomas|Yakutat)" +
    "|Pacific\\/(?:Honolulu|Pago_Pago|Guam|Saipan|Midway|Wake)" +
    "|Africa/Monrovia" +
    "|Asia\\/(?:Yangon|Rangoon)" +
    ")$");
  function detectUnits() {
    try {
      const force = new URLSearchParams(location.search).get("units");
      if (force === "imperial" || force === "metric") return force;
    } catch (_) {}
    try {
      const stored = localStorage.getItem("eucviewer-units");
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
      ? { imperial, dist: (km) => km * 0.621371, speed: (k) => k * 0.621371, temp: (c) => c * 9 / 5 + 32,
          distUnit: "mi", speedUnit: "mph", tempUnit: "°F" }
      : { imperial, dist: (km) => km, speed: (k) => k, temp: (c) => c,
          distUnit: "km", speedUnit: "km/h", tempUnit: "°C" };
  })();

  // --- DOM ---
  const $ = (id) => document.getElementById(id);
  const previewCanvas = $("preview"), pctx = previewCanvas.getContext("2d");
  const videoEl = document.createElement("video");
  videoEl.playsInline = true; videoEl.preload = "auto"; videoEl.crossOrigin = "anonymous";
  const toastEl = $("toast");
  let toastTimer = null;
  function toast(msg, ms = 3500) {
    toastEl.textContent = msg;
    toastEl.classList.remove("hidden");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.add("hidden"), ms);
  }

  // --- Config (everything the setup .json carries) ---
  const DEFAULT_ORDER = ["maxSpeed", "gps", "voltage", "temp", "battery", "mileage", "pwm", "power", "current", "speed", "time", "dragy"];
  const DEFAULT_CFG = {
    version: 1,
    chroma: "#0000ff",
    useIcons: false,
    debug: false,
    order: DEFAULT_ORDER.slice(),
    elements: { speed: false, maxSpeed: true, gps: true, voltage: true, temp: true, battery: true, mileage: true, pwm: true, power: true, current: true, time: false, dragy: false },
    text: { fontSize: 22, vPos: 4, hPos: 50, pad: 14, spacing: 10, radius: 13, opacity: 100, textOffset: 0, staticSize: false, vertical: false },
    gauge: { on: true, scale: 100, hPos: 48, vPos: 76, numSize: 138, unitSize: 90, numY: -15, unitY: -5 },
    map: { on: false, source: "trip", hPos: 84, vPos: 30, size: 30, opacity: 100 },
    teleOffset: 0, trimStart: 0, trimEnd: null,
  };
  let cfg = JSON.parse(JSON.stringify(DEFAULT_CFG));
  try {
    const saved = localStorage.getItem("eucviewer-video-cfg");
    if (saved) applyCfg(JSON.parse(saved));
  } catch (_) {}
  function applyCfg(c) {
    if (!c || typeof c !== "object") return;
    for (const k of ["chroma", "useIcons", "debug", "teleOffset", "trimStart", "trimEnd"])
      if (k in c) cfg[k] = c[k];
    if (Array.isArray(c.order)) cfg.order = DEFAULT_ORDER.filter((k) => c.order.includes(k))
      .sort((a, b) => c.order.indexOf(a) - c.order.indexOf(b))
      .concat(DEFAULT_ORDER.filter((k) => !c.order.includes(k)));
    for (const sect of ["elements", "text", "gauge", "map"])
      if (c[sect]) for (const k in cfg[sect]) if (k in c[sect]) cfg[sect][k] = c[sect][k];
  }
  let persistTimer = null;
  function persistCfg() {
    clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      try { localStorage.setItem("eucviewer-video-cfg", JSON.stringify(cfg)); } catch (_) {}
    }, 400);
  }

  // --- Trip loading (same session store the inspector reads) ---
  function loadFromIDB() {
    return new Promise((resolve) => {
      if (!("indexedDB" in window)) return resolve(null);
      const req = indexedDB.open("eucplanet-trip-viewer");
      req.onerror = () => resolve(null);
      req.onsuccess = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("currentSession")) { db.close(); return resolve(null); }
        try {
          const tx = db.transaction("currentSession", "readonly");
          const g = tx.objectStore("currentSession").get("tracks");
          g.onsuccess = () => { db.close(); resolve(g.result || null); };
          g.onerror = () => { db.close(); resolve(null); };
        } catch { db.close(); resolve(null); }
      };
    });
  }

  // --- State ---
  let track = null;          // active trip (viewer track schema)
  let S = null;              // resampled telemetry (see buildSamples)
  let vbo = null;            // parsed Dragy VBO {t[], spd[], lat[], lon[]}
  let videoFile = null;      // uploaded footage File
  let hasVideo = false;
  let curT = 0;              // playhead, video seconds
  let playing = false;
  let exporting = false;

  // The session track is applied at the bottom of setup: setTrack touches
  // the timeline, whose bindings don't exist yet at this point.
  const idxParam = parseInt(new URLSearchParams(location.search).get("i"));
  let pendingTrack = null;
  {
    const tracks = await loadFromIDB();
    if (tracks && Array.isArray(tracks) && !isNaN(idxParam) && tracks[idxParam]) {
      pendingTrack = tracks[idxParam];
    }
  }

  function setTrack(t) {
    track = t;
    S = buildSamples(t);
    if (cfg.trimEnd == null || cfg.trimEnd > S.dur) cfg.trimEnd = S.dur;
    if (cfg.trimStart > S.dur) cfg.trimStart = 0;
    $("tb-trip-name").textContent = t.date || t.name || "";
    setStatus("ms-trip", `${t.date || t.name || "trip"} · ${fmtT(S.dur)}`);
    $("stage-empty").classList.add("hidden");
    layoutTimeline();
    drawTeleGraph();
  }

  // Resample the track into flat arrays with a uniform-ish time base.
  // points is full row resolution but carries no per-row time; rows are
  // assumed evenly spaced across the trip duration (EUC Planet logs at a
  // fixed cadence, so this holds within a second or two). timeseries
  // (<= 500 rows) supplies mileage and the fallback when points is thin.
  function buildSamples(t) {
    // The timeseries is the time authority: every row carries a real clock
    // (SEC) and NO row is dropped. The points array is tempting for its
    // full resolution, but the parser drops no-GPS rows from it, so a
    // wheel-off / no-GPS stretch that stays in the timeseries is missing
    // from points — mapping points onto time then shifted everything after
    // the gap (the reported ~20-min offset). Drive values off ts only, the
    // same source the inspector trusts.
    const ts = t.timeseries || [];
    const t0 = ts.length ? ts[0][0] : 0;
    let dur = ts.length ? ts[ts.length - 1][0] - t0 : 0;
    if (!dur && t.dateStart && t.dateEnd) dur = (new Date(t.dateEnd) - new Date(t.dateStart)) / 1000;
    if (!dur || dur < 1) dur = Math.max(1, ts.length);
    const n = ts.length;
    const arr = () => new Float64Array(n);
    const out = { dur, n, t: arr(), spd: arr(), volt: arr(), temp: arr(), batt: arr(),
      pwm: arr(), cur: arr(), pow: arr(), gps: arr(), lat: arr(), lon: arr(), mil: arr(), maxSpd: arr() };
    for (let i = 0; i < n; i++) {
      const r = ts[i];
      out.t[i] = r[0] - t0;
      out.spd[i] = r[1] || 0; out.volt[i] = r[2] || 0; out.temp[i] = r[3] || 0;
      out.batt[i] = r[4] || 0; out.lat[i] = r[6] || 0; out.lon[i] = r[7] || 0;
      out.mil[i] = r[8] || 0;
      out.pwm[i] = r[9] || 0; out.cur[i] = r[10] || 0;
      out.pow[i] = r[11] !== undefined ? r[11] : (out.volt[i] * out.cur[i]);
      out.gps[i] = r[12] || 0;
      out.maxSpd[i] = Math.max(i ? out.maxSpd[i - 1] : 0, out.spd[i]);
    }
    out.tsT = out.t; out.tsMil = out.mil;
    out.peak = out.maxSpd[n - 1] || 30;
    out.dateStart = t.dateStart ? new Date(t.dateStart) : null;
    // GPS path for the track map (skip 0,0 rows).
    out.path = [];
    for (let i = 0; i < n; i++) if (out.lat[i] && out.lon[i]) out.path.push([out.lat[i], out.lon[i], out.t[i]]);
    // Recording holes: the overlay stays locked to the footage (it can't
    // skip like the inspector), so during a hole it must read "no data"
    // instead of freezing the last speed. Two hole shapes: the row clock
    // jumps (recording stopped and resumed), or the wheel stayed connected
    // as rows but lost GPS for a sustained stretch (lat/lon pinned at 0).
    out.gaps = [];
    for (let i = 1; i < n; i++) if (out.t[i] - out.t[i - 1] > 30) out.gaps.push([out.t[i - 1], out.t[i]]);
    let run0 = -1;
    for (let i = 0; i <= n; i++) {
      const dead = i < n && out.lat[i] === 0 && out.lon[i] === 0;
      if (dead && run0 < 0) run0 = i;
      else if (!dead && run0 >= 0) {
        if (out.t[i - 1] - out.t[run0] > 30) out.gaps.push([out.t[run0], out.t[i - 1]]);
        run0 = -1;
      }
    }
    return out;
  }

  function lerpAt(tArr, vArr, tau) {
    const n = tArr.length;
    if (!n) return 0;
    if (tau <= tArr[0]) return vArr[0];
    if (tau >= tArr[n - 1]) return vArr[n - 1];
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (tArr[m] <= tau) lo = m; else hi = m; }
    const f = (tau - tArr[lo]) / (tArr[hi] - tArr[lo] || 1);
    return vArr[lo] + (vArr[hi] - vArr[lo]) * f;
  }

  // Telemetry sample at video time t. Values hold (clamp) outside the trim.
  function sampleAt(t) {
    if (!S) return null;
    let tau = t - cfg.teleOffset;
    const s0 = cfg.trimStart, s1 = cfg.trimEnd == null ? S.dur : cfg.trimEnd;
    // Out of range = outside the trims, or inside a recording hole where
    // there is genuinely nothing to show.
    let inRange = tau >= s0 - 0.5 && tau <= s1 + 0.5;
    if (inRange) {
      for (const [a, b] of S.gaps) if (tau > a + 0.5 && tau < b - 0.5) { inRange = false; break; }
    }
    tau = Math.min(Math.max(tau, s0), s1);
    const g = (arr) => lerpAt(S.t, arr, tau);
    return {
      tau, inRange,
      speed: g(S.spd), maxSpeed: lerpAt(S.t, S.maxSpd, tau), volt: g(S.volt),
      temp: g(S.temp), batt: g(S.batt), pwm: g(S.pwm), cur: g(S.cur), pow: g(S.pow),
      gps: g(S.gps), mileage: lerpAt(S.tsT, S.tsMil, tau),
      lat: g(S.lat), lon: g(S.lon),
      dragy: vbo ? lerpAt(vbo.t, vbo.spd, tau) : 0,
      clock: S.dateStart ? new Date(S.dateStart.getTime() + tau * 1000) : null,
    };
  }

  // --- Elements (order + on/off drive the chip bar) ---
  const EL_DEFS = {
    speed:    { label: "Speed",     fmt: (s) => UNITS.speed(s.speed).toFixed(0) + " " + UNITS.speedUnit },
    maxSpeed: { label: "Max Speed", fmt: (s) => UNITS.speed(s.maxSpeed).toFixed(0) + " " + UNITS.speedUnit },
    gps:      { label: "GPS",       fmt: (s) => UNITS.speed(s.gps).toFixed(0) + " " + UNITS.speedUnit },
    voltage:  { label: "Voltage",   fmt: (s) => s.volt.toFixed(0) + " V" },
    temp:     { label: "Temp",      fmt: (s) => UNITS.temp(s.temp).toFixed(0) + " " + UNITS.tempUnit },
    battery:  { label: "Battery",   fmt: (s) => s.batt.toFixed(0) + " %" },
    mileage:  { label: "Mileage",   fmt: (s) => UNITS.dist(s.mileage).toFixed(1) + " " + UNITS.distUnit },
    pwm:      { label: "PWM",       fmt: (s) => s.pwm.toFixed(0) + " %" },
    power:    { label: "Power",     fmt: (s) => s.pow.toFixed(0) + " W" },
    current:  { label: "Current",   fmt: (s) => s.cur.toFixed(1) + " A" },
    time:     { label: "Time",      fmt: (s) => s.clock ? s.clock.toTimeString().slice(0, 8) : "--:--:--" },
    dragy:    { label: "Dragy",     fmt: (s) => UNITS.speed(s.dragy).toFixed(0) + " " + UNITS.speedUnit },
  };

  // Chip icons from EUCTelemetry (MIT, github.com/PavelDemyanov/EUCtelemetry),
  // tinted white at load because the source glyphs are black.
  const ICONS = {};
  {
    const map = { speed: "speed", maxSpeed: "max_speed", gps: "gps", voltage: "voltage",
      temp: "temp", battery: "battery", mileage: "mileage", pwm: "pwm", power: "power",
      current: "current", time: "time", dragy: "dragy_speed" };
    for (const key in map) {
      const img = new Image();
      img.onload = () => {
        const c = document.createElement("canvas");
        c.width = img.width; c.height = img.height;
        const x = c.getContext("2d");
        x.drawImage(img, 0, 0);
        x.globalCompositeOperation = "source-in";
        x.fillStyle = "#fff";
        x.fillRect(0, 0, c.width, c.height);
        ICONS[key] = c;
        requestDraw();
      };
      img.src = "static/img/telemetry-icons/" + map[key] + ".png";
    }
  }

  // --- Sidebar UI (schema-driven sliders keep the markup tiny) ---
  function slider(panel, obj, key, label, min, max, unit, step = 1) {
    const row = document.createElement("div");
    row.className = "ctl-row";
    row.innerHTML = `<label>${label}</label><input type="range" min="${min}" max="${max}" step="${step}"><span class="ctl-val"></span>`;
    const input = row.querySelector("input"), val = row.querySelector(".ctl-val");
    const show = () => {
      const v = obj[key];
      val.textContent = (Number.isInteger(v) ? v : v.toFixed(1)) + (unit || "");
    };
    input.value = obj[key]; show();
    input.addEventListener("input", () => { obj[key] = parseFloat(input.value); show(); persistCfg(); requestDraw(); });
    panel.appendChild(row);
    row._sync = () => { input.value = obj[key]; show(); };
    return row;
  }
  function checkbox(panel, obj, key, label, onChange) {
    const row = document.createElement("label");
    row.className = "ctl-check";
    row.innerHTML = `<input type="checkbox"><span>${label}</span>`;
    const input = row.querySelector("input");
    input.checked = !!obj[key];
    input.addEventListener("change", () => { obj[key] = input.checked; persistCfg(); requestDraw(); if (onChange) onChange(); });
    panel.appendChild(row);
    row._sync = () => { input.checked = !!obj[key]; };
    return row;
  }

  const syncers = [];
  function buildSidebar() {
    const textP = document.querySelector('[data-panel="text"]');
    const gaugeP = document.querySelector('[data-panel="gauge"]');
    const elemP = document.querySelector('[data-panel="elements"]');
    textP.innerHTML = ""; gaugeP.innerHTML = ""; elemP.innerHTML = "";

    for (const [k, l, mi, ma, u] of [
      ["fontSize", "Font size", 10, 48, " px"], ["vPos", "Vertical position", 0, 100, " %"],
      ["hPos", "Horizontal position", 0, 100, " %"], ["pad", "Box padding", 0, 30, " px"],
      ["spacing", "Spacing", 0, 40, " px"], ["radius", "Border radius", 0, 30, " px"],
      ["opacity", "Box opacity", 0, 100, " %"], ["textOffset", "Text offset", -20, 20, " px"],
    ]) syncers.push(slider(textP, cfg.text, k, l, mi, ma, u));
    syncers.push(checkbox(textP, cfg.text, "staticSize", "Static box size"));
    syncers.push(checkbox(textP, cfg.text, "vertical", "Vertical layout"));

    for (const [k, l, mi, ma, u] of [
      ["scale", "Scale", 40, 250, " %"], ["hPos", "Horizontal position", 0, 100, " %"],
      ["vPos", "Vertical position", 0, 100, " %"], ["numSize", "Speed number size", 50, 250, " %"],
      ["unitSize", "Unit text size", 50, 200, " %"], ["numY", "Speed Y offset", -60, 60, " px"],
      ["unitY", "Unit Y offset", -60, 60, " px"],
    ]) syncers.push(slider(gaugeP, cfg.gauge, k, l, mi, ma, u));

    // Elements: checkbox list, drag rows to reorder the chip bar.
    const list = document.createElement("div");
    list.id = "el-list";
    for (const key of cfg.order) {
      const def = EL_DEFS[key];
      const row = document.createElement("div");
      row.className = "el-row";
      row.draggable = true;
      row.dataset.key = key;
      row.innerHTML = `<span class="el-grip">⋮⋮</span><label><input type="checkbox"><span>${def.label}</span></label>`;
      const input = row.querySelector("input");
      input.checked = !!cfg.elements[key];
      input.addEventListener("change", () => { cfg.elements[key] = input.checked; persistCfg(); requestDraw(); });
      row.addEventListener("dragstart", (e) => { e.dataTransfer.setData("text/plain", key); row.classList.add("dragging"); });
      row.addEventListener("dragend", () => row.classList.remove("dragging"));
      row.addEventListener("dragover", (e) => e.preventDefault());
      row.addEventListener("drop", (e) => {
        e.preventDefault();
        const from = e.dataTransfer.getData("text/plain");
        if (!from || from === key) return;
        const o = cfg.order.filter((k) => k !== from);
        o.splice(o.indexOf(key), 0, from);
        cfg.order = o;
        persistCfg(); buildSidebar(); requestDraw();
      });
      list.appendChild(row);
    }
    elemP.appendChild(list);

    syncers.push(checkbox(elemP, cfg, "useIcons", "Use icons"));
    syncers.push(checkbox(elemP, cfg.gauge, "on", "Speed dial (arc)"));

    const mapHead = document.createElement("div");
    mapHead.className = "ctl-sep";
    mapHead.textContent = "Track map";
    elemP.appendChild(mapHead);
    syncers.push(checkbox(elemP, cfg.map, "on", "Show track map"));
    // The source picker only exists once a VBO with GPS is loaded;
    // without one, trip GPS is the only source there is.
    if (vbo && vbo.path.length > 1) {
      const srcRow = document.createElement("div");
      srcRow.className = "ctl-row";
      srcRow.innerHTML = `<label>Map source</label><select id="map-src"><option value="trip">Trip GPS</option><option value="vbo">Dragy VBO</option></select>`;
      elemP.appendChild(srcRow);
      const srcSel = srcRow.querySelector("select");
      srcSel.value = cfg.map.source;
      srcSel.addEventListener("change", () => { cfg.map.source = srcSel.value; persistCfg(); requestDraw(); });
      syncers.push({ _sync: () => { srcSel.value = cfg.map.source; } });
    } else {
      cfg.map.source = "trip";
    }
    syncers.push(slider(elemP, cfg.map, "size", "Map size", 10, 70, " %"));
    syncers.push(slider(elemP, cfg.map, "opacity", "Map opacity", 10, 100, " %"));
    const mapHint = document.createElement("div");
    mapHint.className = "ctl-hint";
    mapHint.textContent = "Drag the map on the preview to move it. Scroll over it to resize.";
    elemP.appendChild(mapHint);

    const chromaHead = document.createElement("div");
    chromaHead.className = "ctl-sep";
    chromaHead.textContent = "Chroma background";
    elemP.appendChild(chromaHead);
    // One row of color swatches: the presets plus a rainbow "custom" one
    // that opens the native picker. The active swatch carries a ring.
    const chromaRow = document.createElement("div");
    chromaRow.className = "chroma-swatches";
    // Pure blue (the default) and pure green like EUCTelemetry, plus
    // OBS-style magenta and black for luma keys or dark edits.
    chromaRow.innerHTML =
      ['#0000ff|Blue', '#00ff00|Green', '#ff00ff|Magenta', '#000000|Black']
        .map((p) => {
          const [c, name] = p.split("|");
          return `<button type="button" class="swatch" data-c="${c}" style="background:${c}" title="${name}"></button>`;
        }).join("") +
      `<label class="swatch swatch-custom" title="Custom color">
         <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="m10.5 2.7 2.8 2.8M12.6 1.9l1.5 1.5a1.1 1.1 0 0 1 0 1.6l-1.7 1.7-3.1-3.1 1.7-1.7a1.1 1.1 0 0 1 1.6 0zM9.3 3.6l3.1 3.1-6.2 6.2c-.4.4-1 .7-1.6.8l-2 .3.3-2c.1-.6.4-1.2.8-1.6z"/></svg>
         <input type="color" id="chroma-color">
       </label>
       <span id="chroma-hex"></span>`;
    elemP.appendChild(chromaRow);
    const cInput = chromaRow.querySelector("#chroma-color");
    const cHex = chromaRow.querySelector("#chroma-hex");
    const syncChroma = () => {
      cInput.value = cfg.chroma;
      cHex.textContent = cfg.chroma.toUpperCase();
      let preset = false;
      chromaRow.querySelectorAll(".swatch[data-c]").forEach((b) => {
        const on = b.dataset.c === cfg.chroma.toLowerCase();
        b.classList.toggle("active", on);
        preset = preset || on;
      });
      const custom = chromaRow.querySelector(".swatch-custom");
      custom.classList.toggle("active", !preset);
      // A picked custom color becomes the swatch face; otherwise neutral.
      custom.style.background = preset ? "" : cfg.chroma;
    };
    syncChroma();
    cInput.addEventListener("input", () => { cfg.chroma = cInput.value; syncChroma(); persistCfg(); requestDraw(); });
    chromaRow.querySelectorAll(".swatch[data-c]").forEach((b) =>
      b.addEventListener("click", () => { cfg.chroma = b.dataset.c; syncChroma(); persistCfg(); requestDraw(); }));
    syncers.push({ _sync: syncChroma });

    syncers.push(checkbox(elemP, cfg, "debug", "Debug info"));
  }
  buildSidebar();

  document.querySelectorAll(".side-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".side-tab").forEach((t) => t.classList.toggle("active", t === tab));
      document.querySelectorAll(".side-panel").forEach((p) =>
        p.classList.toggle("active", p.dataset.panel === tab.dataset.tab));
    });
  });

  // --- Overlay renderer (shared by preview and export) ---
  // Reference space is 1080p: cfg px values scale with canvas height.
  const hitBoxes = {};   // group -> {x,y,w,h} in canvas px (preview only)
  let hoverGroup = null, dragGroup = null;

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function drawFrame(ctx, W, H, t, forPreview) {
    // Background: footage where the render time falls inside the video,
    // chroma elsewhere. "Trip trim only" exports can run past the video on
    // either side (the trim is free to sit outside it); those frames get
    // the chroma fill so the overlay still renders on a keyable colour.
    const vd = videoEl.duration || 0;
    const onFootage = hasVideo && videoEl.readyState >= 2 && t >= -0.05 && t <= vd + 0.05;
    if (onFootage) {
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, W, H);
      const vw = videoEl.videoWidth, vh = videoEl.videoHeight;
      if (vw && vh) {
        const s = Math.min(W / vw, H / vh);
        const dw = vw * s, dh = vh * s;
        ctx.drawImage(videoEl, (W - dw) / 2, (H - dh) / 2, dw, dh);
      }
    } else {
      ctx.fillStyle = cfg.chroma;
      ctx.fillRect(0, 0, W, H);
    }
    if (!S) return;
    const s = sampleAt(t);
    const k = H / 1080;

    // Outside the telemetry (before the aligned start, after the trimmed
    // end): the export gets clean footage with no overlay at all; the
    // preview keeps dimmed placeholders so the groups stay positionable.
    if (!s.inRange && !forPreview) return;

    drawChips(ctx, W, H, k, s, forPreview);
    if (cfg.gauge.on) drawGauge(ctx, W, H, k, s, forPreview);
    if (cfg.map.on) drawMap(ctx, W, H, k, s, forPreview);
    if (cfg.debug) drawDebug(ctx, W, H, k, s, t);

    // Outline the hovered group, or the dragged one: touch has no hover,
    // so while a finger drags, the dashed frame follows the drag itself.
    const outlined = dragGroup || hoverGroup;
    if (forPreview && outlined && hitBoxes[outlined]) {
      const b = hitBoxes[outlined];
      ctx.save();
      ctx.strokeStyle = "rgba(255,255,255,0.75)";
      ctx.setLineDash([6 * k, 5 * k]);
      ctx.lineWidth = Math.max(1, 1.5 * k);
      ctx.strokeRect(b.x - 8 * k, b.y - 8 * k, b.w + 16 * k, b.h + 16 * k);
      ctx.restore();
    }
  }

  function drawChips(ctx, W, H, k, s, forPreview) {
    const T = cfg.text;
    const items = cfg.order.filter((key) => cfg.elements[key]).map((key) => {
      const def = EL_DEFS[key];
      const icon = cfg.useIcons ? ICONS[key] : null;
      return { icon, label: icon ? "" : def.label + ":", value: s.inRange ? def.fmt(s) : "--" };
    });
    if (!items.length) { delete hitBoxes.chips; return; }

    const fs = T.fontSize * k;
    const padX = T.pad * k, padY = T.pad * k * 0.5;
    const gap = T.spacing * k;
    const iconW = fs * 1.15;
    const labelFont = `500 ${fs}px "Segoe UI", system-ui, sans-serif`;
    const valueFont = `700 ${fs}px "Segoe UI", system-ui, sans-serif`;
    const chipH = fs + padY * 2;

    ctx.textBaseline = "middle";
    for (const it of items) {
      if (it.icon) it.lw = iconW;
      else { ctx.font = labelFont; it.lw = ctx.measureText(it.label).width; }
      ctx.font = valueFont; it.vw = ctx.measureText(it.value).width;
      it.w = padX + it.lw + fs * 0.28 + it.vw + padX;
    }
    const maxW = Math.max(...items.map((i) => i.w));
    if (T.staticSize) items.forEach((i) => { i.w = maxW; });

    const ax = W * T.hPos / 100, ay = H * T.vPos / 100;
    let bounds;
    if (T.vertical) {
      const totH = items.length * chipH + (items.length - 1) * gap;
      let y = ay;
      const x0 = ax - maxW / 2;
      bounds = { x: x0, y, w: maxW, h: totH };
      for (const it of items) { it.x = x0; it.y = y; y += chipH + gap; }
    } else {
      // Wrap into rows that fit the canvas width.
      const rows = [[]];
      let rw = 0;
      for (const it of items) {
        const need = rw ? rw + gap + it.w : it.w;
        if (rw && need > W * 0.96) { rows.push([]); rw = 0; }
        rows[rows.length - 1].push(it);
        rw = rw ? rw + gap + it.w : it.w;
      }
      let y = ay, minX = Infinity, maxX = -Infinity;
      for (const row of rows) {
        const tw = row.reduce((a, i) => a + i.w, 0) + gap * (row.length - 1);
        let x = ax - tw / 2;
        minX = Math.min(minX, x);
        for (const it of row) { it.x = x; it.y = y; x += it.w + gap; }
        maxX = Math.max(maxX, minX + tw);
        y += chipH + gap;
      }
      bounds = { x: minX, y: ay, w: maxX - minX, h: y - ay - gap };
    }

    const bgA = T.opacity / 100;
    ctx.globalAlpha = s.inRange ? 1 : 0.45;
    for (const it of items) {
      ctx.fillStyle = `rgba(0,0,0,${bgA})`;
      roundRect(ctx, it.x, it.y, it.w, chipH, Math.min(T.radius * k, chipH / 2));
      ctx.fill();
      const ty = it.y + chipH / 2 + T.textOffset * k;
      ctx.fillStyle = "#fff";
      if (it.icon) {
        ctx.drawImage(it.icon, it.x + padX, ty - iconW / 2, iconW, iconW);
      } else {
        ctx.font = labelFont;
        ctx.fillText(it.label, it.x + padX, ty);
      }
      ctx.font = valueFont;
      ctx.fillText(it.value, it.x + padX + it.lw + fs * 0.28, ty);
    }
    ctx.globalAlpha = 1;
    if (forPreview) hitBoxes.chips = bounds;
  }

  function drawGauge(ctx, W, H, k, s, forPreview) {
    const G = cfg.gauge;
    const cx = W * G.hPos / 100, cy = H * G.vPos / 100;
    const R = 120 * k * G.scale / 100;
    const lw = 12 * k * G.scale / 100;
    const spd = UNITS.speed(s.speed);
    const peak = Math.max(10, Math.ceil(UNITS.speed(S.peak) * 1.1 / 10) * 10);
    const frac = Math.min(1, spd / peak);
    const a0 = Math.PI * 0.75, sweep = Math.PI * 1.5;

    ctx.save();
    ctx.globalAlpha = s.inRange ? 1 : 0.45;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.arc(cx, cy, R, a0, a0 + sweep);
    ctx.strokeStyle = "rgba(10,14,25,0.55)";
    ctx.lineWidth = lw + 6 * k;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(cx, cy, R, a0, a0 + sweep);
    ctx.strokeStyle = "rgba(255,255,255,0.28)";
    ctx.lineWidth = lw;
    ctx.stroke();
    if (s.inRange && frac > 0.004) {
      // PWM tints the arc from cyan toward red as the wheel runs out of headroom.
      const danger = Math.min(1, Math.max(0, (s.pwm - 40) / 55));
      const hue = 187 - danger * 187;
      ctx.beginPath();
      ctx.arc(cx, cy, R, a0, a0 + sweep * frac);
      ctx.strokeStyle = `hsl(${hue} 100% 55%)`;
      ctx.lineWidth = lw;
      ctx.stroke();
    }
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#fff";
    ctx.shadowColor = "rgba(0,0,0,0.8)";
    ctx.shadowBlur = 6 * k;
    const numFs = 64 * k * G.scale / 100 * G.numSize / 100;
    ctx.font = `800 ${numFs}px "Segoe UI", system-ui, sans-serif`;
    ctx.fillText(s.inRange ? Math.round(spd) : "--", cx, cy + G.numY * k);
    const unitFs = 22 * k * G.scale / 100 * G.unitSize / 100;
    ctx.font = `600 ${unitFs}px "Segoe UI", system-ui, sans-serif`;
    ctx.fillStyle = "rgba(255,255,255,0.85)";
    ctx.fillText(UNITS.speedUnit.toUpperCase(), cx, cy + R * 0.5 + G.unitY * k);
    ctx.restore();
    ctx.textAlign = "left";
    if (forPreview) hitBoxes.gauge = { x: cx - R - lw, y: cy - R - lw, w: (R + lw) * 2, h: (R + lw) * 2 };
  }

  function mapPath() {
    if (cfg.map.source === "vbo" && vbo && vbo.path.length > 1) return vbo.path;
    if (S && S.path.length > 1) return S.path;
    return null;
  }

  function drawMap(ctx, W, H, k, s, forPreview) {
    const path = mapPath();
    if (!path) { delete hitBoxes.map; return; }
    const M = cfg.map;
    const box = H * M.size / 100;
    const bx = W * M.hPos / 100 - box / 2, by = H * M.vPos / 100 - box / 2;

    let minLa = Infinity, maxLa = -Infinity, minLo = Infinity, maxLo = -Infinity;
    for (const p of path) {
      if (p[0] < minLa) minLa = p[0]; if (p[0] > maxLa) maxLa = p[0];
      if (p[1] < minLo) minLo = p[1]; if (p[1] > maxLo) maxLo = p[1];
    }
    const midLa = (minLa + maxLa) / 2;
    const cosLat = Math.cos(midLa * Math.PI / 180) || 1;
    const spanX = (maxLo - minLo) * cosLat || 1e-6, spanY = (maxLa - minLa) || 1e-6;
    const m = box * 0.08;
    const sc = Math.min((box - m * 2) / spanX, (box - m * 2) / spanY);
    const ox = bx + box / 2 - ((minLo + maxLo) / 2) * cosLat * sc;
    const oy = by + box / 2 + midLa * sc;
    const px = (lo) => ox + lo * cosLat * sc;
    const py = (la) => oy - la * sc;

    ctx.save();
    ctx.globalAlpha = M.opacity / 100;
    ctx.lineJoin = "round"; ctx.lineCap = "round";
    ctx.beginPath();
    for (let i = 0; i < path.length; i++) {
      const X = px(path[i][1]), Y = py(path[i][0]);
      i ? ctx.lineTo(X, Y) : ctx.moveTo(X, Y);
    }
    ctx.strokeStyle = "rgba(0,0,0,0.7)";
    ctx.lineWidth = 6 * k;
    ctx.stroke();
    ctx.strokeStyle = "rgba(255,255,255,0.95)";
    ctx.lineWidth = 3 * k;
    ctx.stroke();
    // Start marker + current position (interpolate the path by time).
    ctx.fillStyle = "#66bb6a";
    ctx.beginPath(); ctx.arc(px(path[0][1]), py(path[0][0]), 5 * k, 0, 7); ctx.fill();
    const tau = s.tau;
    let lo = 0, hi = path.length - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (path[mid][2] <= tau) lo = mid; else hi = mid; }
    if (s.inRange) {
      const f = Math.min(1, Math.max(0, (tau - path[lo][2]) / ((path[hi][2] - path[lo][2]) || 1)));
      const cla = path[lo][0] + (path[hi][0] - path[lo][0]) * f;
      const clo = path[lo][1] + (path[hi][1] - path[lo][1]) * f;
      ctx.fillStyle = "#00e5ff";
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 2 * k;
      ctx.beginPath(); ctx.arc(px(clo), py(cla), 7 * k, 0, 7); ctx.fill(); ctx.stroke();
    }
    ctx.restore();
    if (forPreview) hitBoxes.map = { x: bx, y: by, w: box, h: box };
  }

  function drawDebug(ctx, W, H, k, s, t) {
    const lines = [
      `videoTime=${t.toFixed(2)}  offset=${cfg.teleOffset.toFixed(2)}  tau=${s.tau.toFixed(2)}`,
      `speed=${s.speed.toFixed(1)}  pwm=${s.pwm.toFixed(0)}  volt=${s.volt.toFixed(1)}  teleDur=${S.dur.toFixed(1)}`,
      `trim=${cfg.trimStart.toFixed(1)}..${(cfg.trimEnd == null ? S.dur : cfg.trimEnd).toFixed(1)}  samples=${S.n}  vbo=${vbo ? vbo.t.length : 0}`,
      `video=${hasVideo ? (videoEl.videoWidth + "x" + videoEl.videoHeight + " " + (videoEl.duration || 0).toFixed(1) + "s") : "none"}  units=${UNITS.imperial ? "imperial" : "metric"}`,
    ];
    // Follows the metrics font size so it reads at any output resolution.
    const fs = cfg.text.fontSize * k;
    ctx.font = `${fs}px Consolas, monospace`;
    const w = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 20 * k;
    ctx.fillStyle = "rgba(5,10,30,0.8)";
    ctx.fillRect(10 * k, H - (lines.length * fs * 1.5 + 20 * k), w, lines.length * fs * 1.5 + 12 * k);
    ctx.fillStyle = "#ffe082";
    lines.forEach((l, i) => ctx.fillText(l, 20 * k, H - (lines.length - i) * fs * 1.5 - 2 * k));
  }

  // --- Preview loop ---
  let needDraw = true;
  function requestDraw() { needDraw = true; }
  function fitPreviewCanvas() {
    const box = $("stage-box");
    const aspect = hasVideo && videoEl.videoWidth ? videoEl.videoWidth / videoEl.videoHeight : 16 / 9;
    const bw = box.clientWidth, bh = box.clientHeight;
    let w = bw, h = w / aspect;
    if (h > bh) { h = bh; w = h * aspect; }
    previewCanvas.style.width = w + "px";
    previewCanvas.style.height = h + "px";
    const iw = Math.min(1600, Math.round(w * (window.devicePixelRatio || 1)));
    const ih = Math.round(iw / aspect);
    if (previewCanvas.width !== iw || previewCanvas.height !== ih) {
      previewCanvas.width = iw; previewCanvas.height = ih;
    }
  }
  window.addEventListener("resize", () => { fitPreviewCanvas(); layoutTimeline(); drawTeleGraph(); requestDraw(); });

  let lastTick = performance.now();
  function loop(now) {
    const dt = (now - lastTick) / 1000;
    lastTick = now;
    if (playing && !exporting) {
      if (hasVideo) curT = videoEl.currentTime;
      else {
        curT += dt;
        if (curT >= playSpan()) { curT = playSpan(); setPlaying(false); }
      }
      needDraw = true;
      updatePlayhead();
    }
    if (needDraw) {
      needDraw = false;
      fitPreviewCanvas();
      drawFrame(pctx, previewCanvas.width, previewCanvas.height, curT, true);
      updateTimeLabel();
    }
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);

  function playSpan() {
    if (hasVideo) return videoEl.duration || 0;
    if (!S) return 0;
    const s1 = cfg.trimEnd == null ? S.dur : cfg.trimEnd;
    return Math.max(0.1, s1 - cfg.trimStart) + Math.max(0, cfg.teleOffset);
  }

  function setPlaying(p) {
    playing = p;
    $("ic-play").classList.toggle("hidden", p);
    $("ic-pause").classList.toggle("hidden", !p);
    if (hasVideo) { p ? videoEl.play().catch(() => {}) : videoEl.pause(); }
  }
  $("btn-play").addEventListener("click", () => setPlaying(!playing));
  // Paused seeks land asynchronously: redraw when the frame is actually
  // there, otherwise scrubbing a stopped video shows the previous frame
  // (or black right after loading).
  videoEl.addEventListener("seeked", requestDraw);
  videoEl.addEventListener("loadeddata", requestDraw);

  // Move the playhead to an absolute time (render clock) and refresh.
  const FRAME = 1 / 30; // one frame at 30 fps, the arrow-key step
  function setPlayhead(t) {
    curT = Math.min(Math.max(0, t), playSpan());
    if (hasVideo) videoEl.currentTime = curT;
    updatePlayhead(); updateTimeLabel(); requestDraw();
  }
  // In / Out set the TRIP TRIM edges at the playhead — the same trim the
  // handles drag, so there is one range, not a second marker. The trim is
  // telemetry time (tau = playhead - offset).
  function setTrimIn(t) {
    if (!S) return;
    const tau = Math.round(((t ?? curT) - cfg.teleOffset) * 1000) / 1000;
    const s1 = cfg.trimEnd == null ? S.dur : cfg.trimEnd;
    cfg.trimStart = Math.min(Math.max(0, tau), s1 - 0.1);
    afterTrimChange();
  }
  function setTrimOut(t) {
    if (!S) return;
    const tau = Math.round(((t ?? curT) - cfg.teleOffset) * 1000) / 1000;
    cfg.trimEnd = Math.max(Math.min(S.dur, tau), cfg.trimStart + 0.1);
    afterTrimChange();
  }
  function resetTrim() {
    if (!S) return;
    cfg.trimStart = 0; cfg.trimEnd = S.dur;
    afterTrimChange();
  }
  function afterTrimChange() {
    persistCfg();
    positionTrims();
    drawTeleGraph();
    requestDraw();
    updateInOutLabel();
  }

  document.addEventListener("keydown", (e) => {
    if (e.target.closest("input,select,textarea")) return;
    const k = e.key.toLowerCase();
    // Space stays a button activation when one is focused (e.g. just after
    // clicking In); arrows and I/O work no matter what has focus.
    if (e.key === " ") { if (e.target.closest("button")) return; e.preventDefault(); setPlaying(!playing); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); setPlaying(false); setPlayhead(curT - (e.shiftKey ? 1 : FRAME)); }
    else if (e.key === "ArrowRight") { e.preventDefault(); setPlaying(false); setPlayhead(curT + (e.shiftKey ? 1 : FRAME)); }
    else if (k === "i") { e.preventDefault(); setTrimIn(); }
    else if (k === "o") { e.preventDefault(); setTrimOut(); }
  });
  videoEl.addEventListener("ended", () => setPlaying(false));

  const btnIn = $("btn-in"), btnOut = $("btn-out"), btnInoutClear = $("btn-inout-clear");
  if (btnIn) btnIn.addEventListener("click", () => setTrimIn());
  if (btnOut) btnOut.addEventListener("click", () => setTrimOut());
  if (btnInoutClear) btnInoutClear.addEventListener("click", resetTrim);
  function updateInOutLabel() {
    const el = $("inout-label");
    if (!el || !S) return;
    const s1 = cfg.trimEnd == null ? S.dur : cfg.trimEnd;
    const trimmed = cfg.trimStart > 0.05 || s1 < S.dur - 0.05;
    el.classList.toggle("hidden", !trimmed);
    // Shown in video time so it lines up with the playhead readout.
    el.textContent = "Trim " + fmtT(cfg.teleOffset + cfg.trimStart) + " → " + fmtT(cfg.teleOffset + s1);
    if (btnInoutClear) btnInoutClear.classList.toggle("hidden", !trimmed);
  }

  function fmtT(sec) {
    sec = Math.max(0, sec || 0);
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = Math.floor(sec % 60);
    return (h ? h + ":" + String(m).padStart(2, "0") : String(m).padStart(2, "0")) + ":" + String(s).padStart(2, "0");
  }
  function updateTimeLabel() {
    $("time-label").textContent = fmtT(curT) + " / " + fmtT(playSpan());
  }

  // --- Preview dragging (whole groups: chip bar, dial, map) ---
  function canvasPos(e) {
    const r = previewCanvas.getBoundingClientRect();
    return {
      x: (e.clientX - r.left) * previewCanvas.width / r.width,
      y: (e.clientY - r.top) * previewCanvas.height / r.height,
    };
  }
  function hitTest(p) {
    for (const g of ["map", "gauge", "chips"]) {
      const b = hitBoxes[g];
      if (b && p.x >= b.x - 10 && p.x <= b.x + b.w + 10 && p.y >= b.y - 10 && p.y <= b.y + b.h + 10) return g;
    }
    return null;
  }
  previewCanvas.addEventListener("pointerdown", (e) => {
    const p = canvasPos(e);
    const g = hitTest(p);
    if (!g) return;
    dragGroup = g;
    previewCanvas.setPointerCapture(e.pointerId);
    requestDraw();
    e.preventDefault();
  });
  previewCanvas.addEventListener("pointermove", (e) => {
    const p = canvasPos(e);
    if (dragGroup) {
      const W = previewCanvas.width, H = previewCanvas.height;
      const dx = (e.movementX || 0) * W / previewCanvas.getBoundingClientRect().width;
      const dy = (e.movementY || 0) * H / previewCanvas.getBoundingClientRect().height;
      // Tenth-of-a-percent grid: fine enough to place precisely, coarse
      // enough that the sliders read clean numbers.
      const r1 = (v) => Math.round(Math.min(100, Math.max(0, v)) * 10) / 10;
      const tgt = dragGroup === "chips" ? cfg.text : dragGroup === "gauge" ? cfg.gauge : cfg.map;
      tgt.hPos = r1(tgt.hPos + dx / W * 100);
      tgt.vPos = r1(tgt.vPos + dy / H * 100);
      persistCfg(); requestDraw();
      syncers.forEach((s) => s._sync && s._sync());
    } else {
      const g = hitTest(p);
      if (g !== hoverGroup) { hoverGroup = g; requestDraw(); }
      previewCanvas.style.cursor = g ? "move" : "default";
    }
  });
  previewCanvas.addEventListener("pointerup", (e) => {
    dragGroup = null;
    if (e.pointerType === "touch") hoverGroup = null;
    requestDraw();
  });
  previewCanvas.addEventListener("pointerleave", () => { if (hoverGroup) { hoverGroup = null; requestDraw(); } });
  previewCanvas.addEventListener("wheel", (e) => {
    const p = canvasPos(e);
    if (hitTest(p) === "map") {
      e.preventDefault();
      cfg.map.size = Math.min(70, Math.max(10, cfg.map.size - Math.sign(e.deltaY) * 2));
      persistCfg(); requestDraw();
      syncers.forEach((s) => s._sync && s._sync());
    }
  }, { passive: false });

  // --- Timeline (virtualized: zoom + pan render a window of the span) ---
  const tlRuler = $("tl-ruler"), tlThumbs = $("tl-thumbs"), tlGraph = $("tl-graph");
  const teleTrack = $("tl-tele-track");
  let pxPerSec = 4;
  let tlZoom = 1;       // 1 = everything fits the viewport
  let tlView = 0;       // left edge of the viewport, in seconds
  let tlRowH = parseInt(localStorage.getItem("eucviewer-video-tlh")) || 46;
  // Phone: fixed finger-friendly rows, no resizing (the grip is hidden).
  const mobileMQ = window.matchMedia("(max-width: 760px)");
  const rowH = () => (mobileMQ.matches ? 48 : tlRowH);
  mobileMQ.addEventListener("change", () => { layoutTimeline(); requestDraw(); });
  let thumbCache = null; // { bmps: ImageBitmap[], dur }

  function tlSpan() {
    const vd = hasVideo ? (videoEl.duration || 0) : 0;
    const td = S ? S.dur : 0;
    return Math.max(vd, td, 30) * 1.06;
  }
  function trackW() { return $("tl-video-track").clientWidth || 0; }

  function layoutTimeline() {
    const w = trackW();
    if (!w) return;
    document.querySelectorAll(".tl-row").forEach((r) => { r.style.height = rowH() + "px"; });
    pxPerSec = (w / tlSpan()) * tlZoom;
    const maxView = Math.max(0, tlSpan() - w / pxPerSec);
    tlView = Math.min(Math.max(0, tlView), maxView);
    drawRuler(w);
    renderThumbs();
    drawTeleGraph();
    positionTrims();
    // Playhead spans the ruler + rows only, never the tools above them.
    playheadEl.style.top = tlRuler.offsetTop + "px";
    updatePlayhead();
  }

  function drawRuler(w) {
    const dpr = window.devicePixelRatio || 1;
    tlRuler.width = w * dpr; tlRuler.height = 20 * dpr;
    tlRuler.style.width = w + "px";
    const rc = tlRuler.getContext("2d");
    rc.scale(dpr, dpr);
    rc.clearRect(0, 0, w, 20);
    rc.font = "10px system-ui, sans-serif";
    rc.fillStyle = "#7a8a99";
    rc.strokeStyle = "rgba(122,138,153,0.4)";
    const steps = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1200];
    const step = steps.find((s) => s * pxPerSec > 60) || 1800;
    const t1 = tlView + w / pxPerSec;
    // Minor ticks between the labeled ones when there's room.
    const minor = step / 5;
    if (minor * pxPerSec > 7) {
      rc.strokeStyle = "rgba(122,138,153,0.18)";
      for (let t = Math.ceil(tlView / minor) * minor; t <= t1; t += minor) {
        if (Math.abs(t / step - Math.round(t / step)) < 1e-6) continue;
        const x = (t - tlView) * pxPerSec;
        rc.beginPath(); rc.moveTo(x, 17); rc.lineTo(x, 20); rc.stroke();
      }
      rc.strokeStyle = "rgba(122,138,153,0.4)";
    }
    for (let t = Math.ceil(tlView / step) * step; t <= t1; t += step) {
      const x = (t - tlView) * pxPerSec;
      rc.beginPath(); rc.moveTo(x, 14); rc.lineTo(x, 20); rc.stroke();
      rc.fillText(fmtT(t), x + 3, 10);
    }
  }

  function positionTrims() {
    if (!S) return;
    const s1 = cfg.trimEnd == null ? S.dur : cfg.trimEnd;
    $("trim-l").style.left = ((cfg.teleOffset + cfg.trimStart - tlView) * pxPerSec - 4) + "px";
    $("trim-r").style.left = ((cfg.teleOffset + s1 - tlView) * pxPerSec - 4) + "px";
  }

  // Max over [a, b] with interpolated endpoints. The strip graph uses this
  // per pixel column: point-sampling made narrow speed/PWM spikes flicker
  // while dragging (the sampling phase shifts under the data); taking the
  // column max keeps a spike lit wherever it lands inside the column.
  function rangeMax(tArr, vArr, a, b) {
    let m = Math.max(lerpAt(tArr, vArr, a), lerpAt(tArr, vArr, b));
    let lo = 0, hi = tArr.length - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (tArr[mid] <= a) lo = mid; else hi = mid; }
    for (let i = hi; i < tArr.length && tArr[i] < b; i++) if (vArr[i] > m) m = vArr[i];
    return m;
  }

  // The telemetry graph draws only the visible window, sampling per pixel
  // column, so extreme zoom levels never allocate giant canvases.
  function drawTeleGraph() {
    if (!S) return;
    const w = trackW(), h = rowH() - 2;
    if (!w) return;
    const dpr = window.devicePixelRatio || 1;
    tlGraph.width = w * dpr; tlGraph.height = h * dpr;
    tlGraph.style.width = w + "px"; tlGraph.style.height = h + "px";
    const c = tlGraph.getContext("2d");
    c.scale(dpr, dpr);
    c.clearRect(0, 0, w, h);
    const s1 = cfg.trimEnd == null ? S.dur : cfg.trimEnd;
    const tauAt = (x) => tlView + x / pxPerSec - cfg.teleOffset;
    // Strip background where telemetry exists.
    const x0 = Math.max(0, (cfg.teleOffset - tlView) * pxPerSec);
    const x1 = Math.min(w, (cfg.teleOffset + S.dur - tlView) * pxPerSec);
    if (x1 <= x0) return;
    c.fillStyle = "rgba(20,28,40,0.92)";
    c.fillRect(x0, 0, x1 - x0, h);
    // PWM area (red, behind) then speed line (blue), per pixel column.
    // Columns wider than the sample spacing aggregate by max; narrower
    // ones interpolate.
    const colSec = 1 / pxPerSec;
    const dt = S.dur / Math.max(1, S.n - 1);
    const colVal = (tArr, vArr, tau) => colSec > dt
      ? rangeMax(tArr, vArr, tau, tau + colSec)
      : lerpAt(tArr, vArr, tau);
    c.beginPath();
    c.moveTo(x0, h);
    for (let x = x0; x <= x1; x++) c.lineTo(x, h - (colVal(S.t, S.pwm, tauAt(x)) / 100) * (h - 4));
    c.lineTo(x1, h);
    c.closePath();
    // Viewer purple (the forensics/action accent) instead of alarm red.
    c.fillStyle = "rgba(155,110,255,0.38)";
    c.fill();
    c.beginPath();
    const peak = S.peak || 1;
    for (let x = x0; x <= x1; x++) {
      const y = h - (colVal(S.t, S.spd, tauAt(x)) / peak) * (h - 6) - 2;
      x > x0 ? c.lineTo(x, y) : c.moveTo(x, y);
    }
    c.strokeStyle = "#4fc3f7";
    c.lineWidth = 1.5;
    c.stroke();
    // Trimmed regions get a dark veil.
    c.fillStyle = "rgba(0,0,0,0.62)";
    const tx0 = (cfg.teleOffset + cfg.trimStart - tlView) * pxPerSec;
    const tx1 = (cfg.teleOffset + s1 - tlView) * pxPerSec;
    if (tx0 > x0) c.fillRect(x0, 0, Math.min(tx0, x1) - x0, h);
    if (tx1 < x1) c.fillRect(Math.max(tx1, x0), 0, x1 - Math.max(tx1, x0), h);
  }

  // Nearest captured frame to time t (searches outward past any that are
  // still loading).
  function thumbFor(t) {
    const bmps = thumbCache.bmps, m = bmps.length;
    let idx = Math.round(t / thumbCache.dur * (m - 1));
    idx = Math.max(0, Math.min(m - 1, idx));
    if (bmps[idx]) return bmps[idx];
    for (let d = 1; d < m; d++) {
      if (bmps[idx - d]) return bmps[idx - d];
      if (bmps[idx + d]) return bmps[idx + d];
    }
    return null;
  }

  function renderThumbs() {
    const w = trackW(), h = rowH() - 2;
    const dpr = window.devicePixelRatio || 1;
    tlThumbs.width = w * dpr; tlThumbs.height = h * dpr;
    tlThumbs.style.width = w + "px"; tlThumbs.style.height = h + "px";
    if (!thumbCache || !thumbCache.aspect) return;
    const c = tlThumbs.getContext("2d");
    c.scale(dpr, dpr);
    // Each thumbnail keeps the video's real aspect ratio; nothing stretches.
    const thumbW = Math.max(24, Math.round(h * thumbCache.aspect));
    const vx0 = (0 - tlView) * pxPerSec;                 // video start x
    const vx1 = (thumbCache.dur - tlView) * pxPerSec;     // video end x
    const vw = vx1 - vx0;
    if (vw < 4) return;
    const drawOne = (t, x) => {
      if (x + thumbW < 0 || x > w) return;
      const bmp = thumbFor(t);
      if (bmp) c.drawImage(bmp, x, 0, thumbW, h);
    };
    // How many fit side by side across the whole video span. First frame
    // flush-left, last flush-right, the rest evenly between; if two won't
    // fit, just the first frame.
    const slots = Math.floor(vw / thumbW);
    if (slots < 2) { drawOne(0, vx0); return; }
    const step = (vw - thumbW) / (slots - 1);
    // Only iterate the slots whose tiles touch the viewport.
    const kFrom = Math.max(0, Math.floor((0 - thumbW - vx0) / step));
    const kTo = Math.min(slots - 1, Math.ceil((w - vx0) / step));
    for (let k = kFrom; k <= kTo; k++) {
      drawOne((k / (slots - 1)) * thumbCache.dur, vx0 + step * k);
    }
  }

  const playheadEl = $("playhead");
  function updatePlayhead() {
    const label = document.querySelector(".tl-label");
    const off = label ? label.offsetWidth : 70;
    const x = (curT - tlView) * pxPerSec;
    // Playing past the right edge: follow like an editor, keep the head
    // at 10% and let the content scroll.
    if (playing && x > trackW() * 0.97 && tlZoom > 1) {
      tlView = curT - trackW() * 0.1 / pxPerSec;
      layoutTimeline();
      return;
    }
    playheadEl.style.opacity = x < 0 || x > trackW() ? 0 : 1;
    playheadEl.style.left = (off + x) + "px";
  }

  // Zoom: buttons and wheel (anchored at the cursor). Fit resets.
  function setZoom(z, anchorT, anchorX) {
    const w = trackW();
    tlZoom = Math.min(120, Math.max(1, z));
    if (anchorT !== undefined) {
      const pps = (w / tlSpan()) * tlZoom;
      tlView = anchorT - anchorX / pps;
    }
    layoutTimeline();
  }
  $("tlz-in").addEventListener("click", () => {
    const w = trackW();
    setZoom(tlZoom * 1.6, tlView + w / pxPerSec / 2, w / 2);
  });
  $("tlz-out").addEventListener("click", () => {
    const w = trackW();
    setZoom(tlZoom / 1.6, tlView + w / pxPerSec / 2, w / 2);
  });
  $("tlz-fit").addEventListener("click", () => { tlZoom = 1; tlView = 0; layoutTimeline(); });

  // Snap: dragging the telemetry (or its trims) sticks to the video start
  // and the playhead when close, so "align to the beginning" is a flick
  // instead of pixel hunting. Toggle lives with the zoom tools.
  let tlSnap = localStorage.getItem("eucviewer-video-snap") !== "0";
  const snapBtn = $("tlz-snap");
  snapBtn.classList.toggle("active", tlSnap);
  snapBtn.addEventListener("click", () => {
    tlSnap = !tlSnap;
    snapBtn.classList.toggle("active", tlSnap);
    try { localStorage.setItem("eucviewer-video-snap", tlSnap ? "1" : "0"); } catch (_) {}
  });
  // Reset: a small modal where the user picks what goes back to default.
  const rsModal = $("reset-modal");
  const rsApplySync = () => {
    $("rs-apply").disabled = !rsModal.querySelector("input:checked");
  };
  rsModal.querySelectorAll(".rs-opt input").forEach((i) => i.addEventListener("change", rsApplySync));
  $("tlz-reset").addEventListener("click", () => { rsApplySync(); rsModal.classList.remove("hidden"); });
  rsModal.querySelectorAll("[data-rs-close]").forEach((el) =>
    el.addEventListener("click", () => rsModal.classList.add("hidden")));
  $("rs-apply").addEventListener("click", () => {
    const picks = [...rsModal.querySelectorAll("input:checked")].map((i) => i.value);
    rsModal.classList.add("hidden");
    if (!picks.length) return;
    const clone = (o) => JSON.parse(JSON.stringify(o));
    if (picks.includes("offset")) cfg.teleOffset = 0;
    if (picks.includes("trim")) { cfg.trimStart = 0; cfg.trimEnd = S ? S.dur : null; }
    if (picks.includes("text")) cfg.text = clone(DEFAULT_CFG.text);
    if (picks.includes("gauge")) cfg.gauge = clone(DEFAULT_CFG.gauge);
    if (picks.includes("elements")) {
      cfg.elements = clone(DEFAULT_CFG.elements);
      cfg.order = DEFAULT_CFG.order.slice();
      cfg.useIcons = DEFAULT_CFG.useIcons;
      cfg.map = clone(DEFAULT_CFG.map);
      cfg.chroma = DEFAULT_CFG.chroma;
      cfg.debug = DEFAULT_CFG.debug;
    }
    persistCfg(); buildSidebar(); layoutTimeline(); drawTeleGraph(); positionTrims(); requestDraw();
    toast("Reset done.");
  });

  function snapTo(value, candidates) {
    if (!tlSnap) return value;
    const th = 12 / pxPerSec;
    for (const c of candidates) if (Math.abs(value - c) < th) return c;
    return value;
  }
  $("timeline").addEventListener("wheel", (e) => {
    e.preventDefault();
    const r = $("tl-video-track").getBoundingClientRect();
    const x = e.clientX - r.left;
    if (e.shiftKey) {
      // Shift+wheel pans.
      tlView += (e.deltaY || e.deltaX) / pxPerSec;
      layoutTimeline();
    } else {
      const tAt = tlView + x / pxPerSec;
      setZoom(tlZoom * (e.deltaY < 0 ? 1.25 : 0.8), tAt, x);
    }
  }, { passive: false });

  // Drag the grip above the ruler to make the tracks taller.
  $("tl-resize").addEventListener("pointerdown", (e) => {
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    el._y = e.clientY;
    el._h = tlRowH;
  });
  $("tl-resize").addEventListener("pointermove", (e) => {
    const el = e.currentTarget;
    if (el._y === undefined) return;
    tlRowH = Math.min(140, Math.max(30, el._h + (el._y - e.clientY)));
    try { localStorage.setItem("eucviewer-video-tlh", tlRowH); } catch (_) {}
    layoutTimeline();
  });
  $("tl-resize").addEventListener("pointerup", (e) => { e.currentTarget._y = undefined; });

  // Drag on the telemetry row = alignment offset. Handles = trims. All
  // three snap their timeline position to the video start and playhead.
  let tlDrag = null;
  teleTrack.addEventListener("pointerdown", (e) => {
    if (e.target.classList.contains("trim-handle")) {
      tlDrag = {
        kind: e.target.id === "trim-l" ? "trimL" : "trimR", x0: e.clientX,
        start: e.target.id === "trim-l" ? cfg.trimStart : (cfg.trimEnd == null ? S.dur : cfg.trimEnd),
      };
    } else {
      tlDrag = { kind: "offset", x0: e.clientX, start: cfg.teleOffset };
    }
    teleTrack.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  teleTrack.addEventListener("pointermove", (e) => {
    if (!tlDrag) return;
    const dSec = (e.clientX - tlDrag.x0) / pxPerSec;
    const vEnd = hasVideo ? (videoEl.duration || 0) : 0;
    if (tlDrag.kind === "offset") {
      const raw = snapTo(tlDrag.start + dSec, [0, curT, vEnd ? vEnd - S.dur : null].filter((v) => v !== null));
      cfg.teleOffset = Math.round(raw * 100) / 100;
      drawTeleGraph(); positionTrims();
    } else if (tlDrag.kind === "trimL") {
      // Snap the handle's absolute timeline position, then map back.
      const pos = snapTo(cfg.teleOffset + tlDrag.start + dSec, [0, curT]);
      cfg.trimStart = Math.min(Math.max(0, pos - cfg.teleOffset), (cfg.trimEnd == null ? S.dur : cfg.trimEnd) - 1);
      positionTrims(); drawTeleGraph();
    } else {
      const pos = snapTo(cfg.teleOffset + tlDrag.start + dSec, [curT, vEnd || S.dur]);
      cfg.trimEnd = Math.max(Math.min(S.dur, pos - cfg.teleOffset), cfg.trimStart + 1);
      positionTrims(); drawTeleGraph();
    }
    persistCfg(); requestDraw();
  });
  teleTrack.addEventListener("pointerup", () => { tlDrag = null; });

  // Scrub by dragging the playhead knob, the ruler, or the video row.
  function scrubTo(clientX) {
    const r = $("tl-video-track").getBoundingClientRect();
    const t = Math.min(Math.max(0, tlView + (clientX - r.left) / pxPerSec), playSpan());
    curT = t;
    if (hasVideo) videoEl.currentTime = t;
    $("ph-time").textContent = fmtT(t);
    updatePlayhead(); requestDraw();
  }
  for (const el of [tlRuler, $("tl-video-track"), $("ph-knob")]) {
    el.addEventListener("pointerdown", (e) => {
      el.setPointerCapture(e.pointerId);
      el._scrub = true;
      playheadEl.classList.add("scrubbing");
      scrubTo(e.clientX);
      e.preventDefault();
      e.stopPropagation();
    });
    el.addEventListener("pointermove", (e) => { if (el._scrub) scrubTo(e.clientX); });
    el.addEventListener("pointerup", () => {
      el._scrub = false;
      playheadEl.classList.remove("scrubbing");
    });
  }
  $("btn-restart").addEventListener("click", () => {
    curT = 0;
    if (hasVideo) videoEl.currentTime = 0;
    tlView = 0;
    layoutTimeline(); requestDraw();
  });

  // --- File loading ---
  $("btn-video").addEventListener("click", () => $("file-video").click());
  $("btn-trip").addEventListener("click", () => $("file-trip").click());
  $("btn-vbo").addEventListener("click", () => $("file-vbo").click());
  $("btn-lrv").addEventListener("click", () => $("file-lrv").click());
  $("btn-save-cfg").addEventListener("click", saveCfgFile);
  $("btn-load-cfg").addEventListener("click", () => $("file-cfg").click());

  $("file-video").addEventListener("change", (e) => {
    const f = e.target.files[0];
    if (f) loadVideoFile(f);
    e.target.value = "";
  });
  function loadVideoFile(f) {
    videoFile = f;
    hasVideo = true;
    videoEl.src = URL.createObjectURL(f);
    videoEl.muted = true;
    videoEl.addEventListener("loadedmetadata", function once() {
      videoEl.removeEventListener("loadedmetadata", once);
      $("tl-video-empty").classList.add("hidden");
      $("btn-lrv").disabled = false;
      if ($("mr-sync")) $("mr-sync").disabled = false;
      setStatus("ms-video", `${fmtT(videoEl.duration || 0)} · ${videoEl.videoWidth}x${videoEl.videoHeight}`);
      setStatus("ms-sync", "pick the full source recording (.lrv)");
      curT = 0;
      layoutTimeline(); drawTeleGraph(); buildThumbs(); requestDraw();
      toast(`Video loaded: ${(videoEl.duration || 0) > 0 ? fmtT(videoEl.duration) : "?"} at ${videoEl.videoWidth}x${videoEl.videoHeight}`);
      detectVideoFps().then((f) => {
        videoFps = f;
        if (f) setStatus("ms-video", `${fmtT(videoEl.duration || 0)} · ${videoEl.videoWidth}x${videoEl.videoHeight} · ${fmtFps(f)} fps`);
        // If the export dialog is already open (opened before detection
        // finished), refresh so the source rate appears and pre-selects.
        if (f && !xpModal.classList.contains("hidden")) buildFpsOptions();
      });
    });
  }

  // The output frame rate should be offer the source's own rate so the
  // export needs no frame duplication or dropping. HTMLVideoElement hides
  // fps, so measure it from a handful of frame timestamps and snap to the
  // nearest broadcast rate.
  let videoFps = null;
  const STD_FPS = [23.976, 24, 25, 29.97, 30, 48, 50, 59.94, 60];
  const fmtFps = (f) => (Number.isInteger(f) ? String(f) : f.toFixed(2).replace(/0$/, ""));
  async function detectVideoFps() {
    if (!("requestVideoFrameCallback" in HTMLVideoElement.prototype)) return null;
    const v = document.createElement("video");
    v.muted = true; v.preload = "auto"; v.src = videoEl.src;
    await new Promise((r) => { v.onloadedmetadata = r; v.onerror = r; });
    const times = [];
    await new Promise((res) => {
      let n = 0;
      const onF = (now, meta) => {
        times.push(meta.mediaTime);
        if (++n >= 20) return res();
        v.requestVideoFrameCallback(onF);
      };
      v.requestVideoFrameCallback(onF);
      v.play().catch(res);
      setTimeout(res, 2500);
    });
    try { v.pause(); } catch (_) {}
    v.src = "";
    const deltas = [];
    for (let i = 1; i < times.length; i++) { const d = times[i] - times[i - 1]; if (d > 5e-4) deltas.push(d); }
    if (deltas.length < 3) return null;
    deltas.sort((a, b) => a - b);
    const raw = 1 / deltas[deltas.length >> 1];
    let best = raw, bd = Infinity;
    for (const s of STD_FPS) { const d = Math.abs(s - raw); if (d < bd) { bd = d; best = s; } }
    return bd < 0.6 ? best : Math.round(raw * 100) / 100;
  }

  async function buildThumbs() {
    // Capture a fixed strip of thumbnails once (ImageBitmaps) off a second
    // muted element, so seeking never disturbs the preview. Zooming the
    // timeline just redraws slices from this cache, no re-seeking.
    const v = document.createElement("video");
    v.muted = true; v.preload = "auto";
    v.src = videoEl.src;
    await new Promise((res) => { v.onloadedmetadata = res; v.onerror = res; });
    if (!v.videoWidth || !v.duration) return;
    const count = Math.min(60, Math.max(20, Math.round(v.duration / 5)));
    const h = 72;
    const aspect = v.videoWidth / v.videoHeight;
    const w = Math.round(h * aspect);
    const cache = { dur: v.duration, aspect, bmps: new Array(count).fill(null) };
    thumbCache = cache;
    const cnv = document.createElement("canvas");
    cnv.width = w; cnv.height = h;
    const cx = cnv.getContext("2d");
    for (let i = 0; i < count; i++) {
      const t = (i + 0.5) * (v.duration / count);
      await new Promise((res) => {
        v.onseeked = res; v.onerror = res;
        try { v.currentTime = t; } catch { res(); }
        setTimeout(res, 900);
      });
      if (thumbCache !== cache) return; // a newer video replaced this run
      cx.drawImage(v, 0, 0, w, h);
      cache.bmps[i] = await createImageBitmap(cnv);
      if (i % 4 === 0) renderThumbs();
    }
    renderThumbs();
    v.src = "";
  }

  // Trip files parse through the same worker as the viewer, so every
  // supported format (and the wheel identity logic) behaves identically.
  $("file-trip").addEventListener("change", async (e) => {
    const f = e.target.files[0];
    e.target.value = "";
    if (!f) return;
    toast("Parsing trip…");
    try {
      const tracks = await new Promise((resolve, reject) => {
        const worker = new Worker("static/js/parser-worker.js?v=21");
        const acc = [];
        worker.onmessage = (ev) => {
          const m = ev.data || {};
          if (m.type === "track") acc.push(m.track);
          else if (m.type === "done") { worker.terminate(); resolve(acc); }
          else if (m.type === "error") { worker.terminate(); reject(new Error(m.message || "Parse failed")); }
        };
        worker.onerror = (err) => { worker.terminate(); reject(err); };
        worker.postMessage({ type: "parse", file: f });
      });
      if (!tracks.length) { toast("No trips found in that file."); return; }
      // Longest trip wins when an archive holds several.
      tracks.sort((a, b) => (b.stats?.rows || 0) - (a.stats?.rows || 0));
      setTrack(tracks[0]);
      cfg.trimStart = 0; cfg.trimEnd = S.dur;
      layoutTimeline(); drawTeleGraph(); requestDraw();
      toast(`Trip loaded: ${tracks[0].date || tracks[0].name}${tracks.length > 1 ? ` (+${tracks.length - 1} more ignored)` : ""}`);
    } catch (err) {
      toast("Could not parse that file: " + err.message);
    }
  });

  // --- Dragy VBO (Racelogic text format) ---
  $("file-vbo").addEventListener("change", async (e) => {
    const f = e.target.files[0];
    e.target.value = "";
    if (!f) return;
    try {
      const parsed = parseVbo(await f.text());
      if (!parsed || parsed.t.length < 2) { toast("No usable rows in that VBO."); return; }
      vbo = parsed;
      cfg.elements.dragy = true;
      if (parsed.path.length > 1) cfg.map.source = "vbo";
      buildSidebar();
      requestDraw();
      setStatus("ms-vbo", `${parsed.t.length} rows · ${fmtT(parsed.t[parsed.t.length - 1])}${parsed.path.length > 1 ? " · GPS track" : ""}`);
      toast(`VBO loaded: ${parsed.t.length} rows, ${fmtT(parsed.t[parsed.t.length - 1])}${parsed.path.length > 1 ? ", GPS track" : ""}`);
    } catch (err) {
      toast("VBO parse failed: " + err.message);
    }
  });
  function parseVbo(text) {
    const lines = text.split(/\r?\n/);
    let cols = null, inData = false;
    const rows = [];
    for (const line of lines) {
      const l = line.trim();
      if (!l) continue;
      if (/^\[column names\]/i.test(l)) { cols = "next"; continue; }
      if (/^\[data\]/i.test(l)) { inData = true; continue; }
      if (/^\[/.test(l)) { if (cols === "next") cols = null; inData = false; continue; }
      if (cols === "next") { cols = l.toLowerCase().split(/\s+/); continue; }
      if (inData) rows.push(l.split(/\s+/));
    }
    if (!cols || !rows.length) return null;
    const ci = (name) => cols.indexOf(name);
    const iT = ci("time"), iV = ci("velocity") >= 0 ? ci("velocity") : ci("velocity kmh");
    const iLa = ci("lat") >= 0 ? ci("lat") : ci("latitude");
    const iLo = ci("long") >= 0 ? ci("long") : ci("longitude");
    if (iT < 0) return null;
    const t = [], spd = [], path = [];
    let t0 = null;
    for (const r of rows) {
      const raw = r[iT];
      if (raw === undefined) continue;
      // time is HHMMSS.SS
      const num = parseFloat(raw);
      const hh = Math.floor(num / 10000), mm = Math.floor((num % 10000) / 100), ss = num % 100;
      let sec = hh * 3600 + mm * 60 + ss;
      if (t0 == null) t0 = sec;
      if (sec < t0) sec += 86400; // midnight wrap
      t.push(sec - t0);
      spd.push(iV >= 0 ? parseFloat(r[iV]) || 0 : 0);
      if (iLa >= 0 && iLo >= 0) {
        // Racelogic stores minutes, longitude positive WEST.
        const la = (parseFloat(r[iLa]) || 0) / 60;
        const lo = -((parseFloat(r[iLo]) || 0) / 60);
        if (la || lo) path.push([la, lo, sec - t0]);
      }
    }
    return { t: Float64Array.from(t), spd: Float64Array.from(spd), path };
  }

  // --- .lrv auto-sync: find where the uploaded clip sits inside the full
  // source recording by cross-correlating audio energy envelopes, then
  // anchor the telemetry offset with the source's mp4 creation time. ---
  $("file-lrv").addEventListener("change", async (e) => {
    const f = e.target.files[0];
    e.target.value = "";
    if (!f || !videoFile) return;
    toast("Analyzing audio, this can take a moment…", 15000);
    try {
      const [clipEnv, srcEnv] = await Promise.all([audioEnvelope(videoFile), audioEnvelope(f)]);
      if (!clipEnv || !srcEnv) throw new Error("could not decode audio");
      const clipStart = bestOffset(clipEnv, srcEnv);
      const created = await mp4CreationTime(f);
      if (created && S && S.dateStart) {
        const videoStartAbs = created.getTime() + clipStart * 1000;
        cfg.teleOffset = Math.round((S.dateStart.getTime() - videoStartAbs) / 1000 * 100) / 100;
        toast(`Synced: clip starts ${fmtT(clipStart)} into the source. Offset set to ${cfg.teleOffset.toFixed(1)}s.`, 6000);
      } else {
        // No absolute anchor: assume the telemetry started with the source.
        cfg.teleOffset = -clipStart;
        toast(`Clip starts ${fmtT(clipStart)} into the source. Telemetry assumed to start with it; fine-tune by dragging.`, 6000);
      }
      setStatus("ms-sync", `synced · offset ${cfg.teleOffset.toFixed(1)}s`);
      persistCfg(); layoutTimeline(); requestDraw();
    } catch (err) {
      toast("Auto-sync failed: " + err.message, 5000);
      setStatus("ms-sync", "failed, drag the trip strip to align by hand");
    }
  });

  const ENV_RATE = 25; // envelope bins per second
  async function audioEnvelope(file) {
    const buf = await file.arrayBuffer();
    const ac = new OfflineAudioContext(1, 1, 44100);
    const audio = await ac.decodeAudioData(buf).catch(() => null);
    if (!audio) return null;
    const data = audio.getChannelData(0);
    const per = Math.round(audio.sampleRate / ENV_RATE);
    const n = Math.floor(data.length / per);
    const env = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let sum = 0;
      const base = i * per;
      for (let j = 0; j < per; j += 4) { const v = data[base + j]; sum += v * v; }
      env[i] = Math.sqrt(sum / (per / 4));
    }
    return env;
  }
  function bestOffset(clip, src) {
    // Two passes: coarse at 5 Hz, then refine at full envelope rate.
    const dec = (a, f) => {
      const out = new Float64Array(Math.floor(a.length / f));
      for (let i = 0; i < out.length; i++) {
        let s = 0;
        for (let j = 0; j < f; j++) s += a[i * f + j];
        out[i] = s / f;
      }
      return out;
    };
    const norm = (a) => {
      let m = 0;
      for (const v of a) m += v;
      m /= a.length;
      const out = new Float64Array(a.length);
      for (let i = 0; i < a.length; i++) out[i] = a[i] - m;
      return out;
    };
    const corrPeak = (a, b, from, to) => {
      let best = 0, bestAt = from;
      for (let off = from; off <= to; off++) {
        let s = 0;
        for (let i = 0; i < a.length; i++) s += a[i] * b[off + i];
        if (s > best) { best = s; bestAt = off; }
      }
      return bestAt;
    };
    const f = 5;
    const ac = norm(dec(clip, f)), bc = norm(dec(src, f));
    const maxOff = bc.length - ac.length;
    if (maxOff <= 0) return 0;
    const coarse = corrPeak(ac, bc, 0, maxOff) * f;
    const a1 = norm(clip), b1 = norm(src);
    const lo = Math.max(0, coarse - 3 * ENV_RATE);
    const hi = Math.min(b1.length - a1.length, coarse + 3 * ENV_RATE);
    const fine = hi > lo ? corrPeak(a1, b1, lo, hi) : coarse;
    return fine / ENV_RATE;
  }
  async function mp4CreationTime(file) {
    // Walk the box tree for moov > mvhd; creation_time is seconds since
    // 1904-01-01 UTC. GoPro writes real wall-clock time there.
    const head = new DataView(await file.slice(0, Math.min(file.size, 8 * 1024 * 1024)).arrayBuffer());
    function walk(start, end) {
      let off = start;
      while (off + 8 <= end) {
        let size = head.getUint32(off);
        const type = String.fromCharCode(head.getUint8(off + 4), head.getUint8(off + 5), head.getUint8(off + 6), head.getUint8(off + 7));
        let body = off + 8;
        if (size === 1) { size = Number(head.getBigUint64(off + 8)); body = off + 16; }
        if (size < 8) return null;
        if (type === "moov") { const r = walk(body, Math.min(off + size, end)); if (r) return r; }
        if (type === "mvhd") {
          const ver = head.getUint8(body);
          const secs = ver === 1 ? Number(head.getBigUint64(body + 4)) : head.getUint32(body + 4);
          if (secs > 0) return new Date((secs - 2082844800) * 1000);
        }
        off += size;
      }
      return null;
    }
    try { return walk(0, head.byteLength); } catch { return null; }
  }

  // --- Setup save / load ---
  function saveCfgFile() {
    const blob = new Blob([JSON.stringify(cfg, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "overlay-config.json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }
  $("file-cfg").addEventListener("change", async (e) => {
    const f = e.target.files[0];
    e.target.value = "";
    if (!f) return;
    try {
      applyCfg(JSON.parse(await f.text()));
      persistCfg(); buildSidebar(); layoutTimeline(); drawTeleGraph(); requestDraw();
      toast("Setup loaded.");
    } catch {
      toast("Not a valid setup file.");
    }
  });

  // --- Export ---
  const xpModal = $("export-modal");
  // With footage loaded the output matches the source size by default
  // (portrait stays portrait), plus clean multiples up and down. H.264
  // needs even dimensions; huge sources skip the 2x option.
  function buildResOptions() {
    const sel = $("xp-res");
    const even = (v) => Math.max(2, Math.round(v / 2) * 2);
    let opts;
    if (hasVideo && videoEl.videoWidth) {
      const vw = videoEl.videoWidth, vh = videoEl.videoHeight;
      opts = [];
      if (vw * 2 <= 4096 && vh * 2 <= 4096) opts.push([even(vw * 2), even(vh * 2), "2x upscale"]);
      opts.push([even(vw), even(vh), "source"]);
      opts.push([even(vw / 2), even(vh / 2), "half"]);
      opts.push([even(vw / 4), even(vh / 4), "fast preview"]);
    } else {
      opts = [[1920, 1080, ""], [1280, 720, ""], [3840, 2160, ""], [854, 480, "fast preview"]];
    }
    sel.innerHTML = opts.map(([w, h, tag], i) =>
      `<option value="${w}x${h}"${(hasVideo ? tag === "source" : i === 0) ? " selected" : ""}>${w} × ${h}${tag ? " (" + tag + ")" : ""}</option>`).join("");
  }
  // Frame-rate options: the detected source rate first (so matching it is
  // one click and needs no resampling), then the common broadcast rates.
  function buildFpsOptions() {
    const sel = $("xp-fps");
    const rows = [];
    if (videoFps) rows.push([videoFps, "source"]);
    for (const f of [60, 50, 30, 25, 24]) rows.push([f, ""]);
    const seen = new Set(), opts = [];
    for (const [f, tag] of rows) {
      const key = f.toFixed(3);
      if (seen.has(key)) continue;
      seen.add(key);
      opts.push([f, tag]);
    }
    const preferred = videoFps || 30;
    sel.innerHTML = opts.map(([f, tag]) =>
      `<option value="${f}"${f === preferred ? " selected" : ""}>${fmtFps(f)} fps${tag ? " (" + tag + ")" : ""}</option>`).join("");
  }
  function openExport() {
    if (!S) { toast("Load a trip first."); return; }
    buildResOptions();
    buildFpsOptions();
    const sel = $("xp-range");
    // Without footage there is nothing to choose — the output is always
    // the trip (trimmed, if trimmed) on chroma — so the Render row is
    // hidden. With footage it defaults to the trim when one is set, else
    // the whole video.
    const s1 = cfg.trimEnd == null ? S.dur : cfg.trimEnd;
    const trimmed = cfg.trimStart > 0.05 || s1 < S.dur - 0.05;
    $("xp-range-row").classList.toggle("hidden", !hasVideo);
    sel.value = hasVideo ? (trimmed ? "trip" : "video") : "trip";
    refreshExportInfo();
    $("xp-setup").classList.remove("hidden");
    $("xp-progress").classList.add("hidden");
    xpModal.classList.remove("hidden");
  }
  $("btn-export").addEventListener("click", openExport);
  if ($("mr-generate")) $("mr-generate").addEventListener("click", openExport);
  $("xp-range").addEventListener("change", refreshExportInfo);
  xpModal.querySelectorAll("[data-xp-close]").forEach((el) =>
    el.addEventListener("click", () => { if (!exporting) xpModal.classList.add("hidden"); }));

  // The render window, in the drawFrame clock (= video time with footage,
  // = teleOffset+trim without). Three shapes:
  //   video       - the whole clip, 0..videoDur.
  //   trip        - the trim, clamped to where footage exists (no chroma).
  //   trip-chroma - the whole trim; frames past the video get chroma tails.
  function exportRange() {
    const s1 = cfg.trimEnd == null ? S.dur : cfg.trimEnd;
    const tripS = cfg.teleOffset + cfg.trimStart;
    const tripE = cfg.teleOffset + s1;
    const mode = $("xp-range") ? $("xp-range").value : (hasVideo ? "video" : "trip");
    if (!hasVideo) return { vStart: tripS, vEnd: tripE, mode: "trip" };
    const vd = videoEl.duration || 0;
    if (mode === "video") return { vStart: 0, vEnd: vd, mode };
    if (mode === "trip-chroma") return { vStart: tripS, vEnd: tripE, mode };
    return { vStart: Math.max(0, tripS), vEnd: Math.min(vd, tripE), mode: "trip" };
  }
  function exportDuration() {
    const r = exportRange();
    return Math.max(0, r.vEnd - r.vStart);
  }
  function refreshExportInfo() {
    const dur = exportDuration();
    $("xp-duration").textContent = fmtT(dur);
    // "Trip trim only" can clamp to nothing when the trim sits entirely
    // off the footage; block the export and say why.
    const empty = dur < 0.3;
    $("xp-start").disabled = empty;
    $("xp-start").textContent = empty ? "Trip trim is outside the video" : "Start";
  }

  let cancelExport = false;
  $("xp-cancel").addEventListener("click", () => { cancelExport = true; });
  $("xp-start").addEventListener("click", async () => {
    const [w, h] = $("xp-res").value.split("x").map(Number);
    const fps = parseFloat($("xp-fps").value);
    $("xp-setup").classList.add("hidden");
    $("xp-progress").classList.remove("hidden");
    cancelExport = false;
    exporting = true;
    setPlaying(false);
    try {
      if ("VideoEncoder" in window && window.Mp4Muxer) await exportWebCodecs(w, h, fps);
      else await exportMediaRecorder(w, h, fps);
      if (!cancelExport) toast("Video exported.");
    } catch (err) {
      console.error(err);
      toast("Export failed: " + err.message, 6000);
    }
    exporting = false;
    xpModal.classList.add("hidden");
  });

  function xpStatus(msg, frac) {
    $("xp-status").textContent = msg;
    $("xp-fill").style.width = Math.round((frac || 0) * 100) + "%";
  }

  async function seekVideo(t) {
    if (!hasVideo) return;
    await new Promise((res) => {
      const done = () => { videoEl.removeEventListener("seeked", done); res(); };
      videoEl.addEventListener("seeked", done);
      videoEl.currentTime = Math.min(t, Math.max(0, (videoEl.duration || t) - 0.001));
      setTimeout(done, 1200);
    });
  }

  async function exportWebCodecs(W, H, fps) {
    const { vStart, vEnd } = exportRange();
    const dur = Math.max(0.1, vEnd - vStart);
    const vd = videoEl.duration || 0;
    const total = Math.max(1, Math.floor(dur * fps));
    const canvas = document.createElement("canvas");
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext("2d");

    // Audio: keep the original when it decodes and the file is sane in size.
    let audioBuf = null;
    if (hasVideo && videoFile.size < 600e6 && dur < 2400) {
      xpStatus("Decoding audio…", 0);
      try {
        const ac = new OfflineAudioContext(2, 2, 48000);
        audioBuf = await ac.decodeAudioData(await videoFile.arrayBuffer());
      } catch { audioBuf = null; }
    }
    let audioCodec = null;
    if (audioBuf && "AudioEncoder" in window) {
      const chans = Math.min(2, audioBuf.numberOfChannels);
      for (const cand of [["mp4a.40.2", "aac"], ["opus", "opus"]]) {
        const sup = await AudioEncoder.isConfigSupported({
          codec: cand[0], sampleRate: audioBuf.sampleRate, numberOfChannels: chans, bitrate: 160000,
        }).catch(() => null);
        if (sup && sup.supported) { audioCodec = { codec: cand[0], mux: cand[1], chans }; break; }
      }
    }

    // The muxer needs an integer timescale. Broadcast rates like 29.97
    // (30000/1001) are handled by scaling the timescale ×1000 so the
    // microsecond timestamps land on whole units; integer rates pass
    // through. The encoder's framerate is only a rate-control hint.
    const muxFps = Number.isInteger(fps) ? fps : Math.round(fps) * 1000;
    const target = new Mp4Muxer.ArrayBufferTarget();
    const muxer = new Mp4Muxer.Muxer({
      target,
      video: { codec: "avc", width: W, height: H, frameRate: muxFps },
      audio: audioCodec ? { codec: audioCodec.mux, sampleRate: audioBuf.sampleRate, numberOfChannels: audioCodec.chans } : undefined,
      fastStart: "in-memory",
    });

    const codecStr = H >= 2160 ? "avc1.640033" : (fps > 30 ? "avc1.64002A" : "avc1.640028");
    const encoder = new VideoEncoder({
      output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
      error: (e) => { throw e; },
    });
    encoder.configure({
      codec: codecStr, width: W, height: H,
      bitrate: Math.min(45e6, Math.round(W * H * fps * 0.14)),
      framerate: Math.round(fps),
    });

    if (audioCodec) {
      const aEnc = new AudioEncoder({
        output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
        error: (e) => console.warn("audio encode", e),
      });
      aEnc.configure({ codec: audioCodec.codec, sampleRate: audioBuf.sampleRate, numberOfChannels: audioCodec.chans, bitrate: 160000 });
      const chunkFrames = 4800;
      const sr = audioBuf.sampleRate;
      // Only the source audio that overlaps the render window; any chroma
      // tail before/after the footage stays silent. Timestamps rebase so
      // the audio lines up with where the footage begins in the output.
      const aFrom = Math.max(0, vStart), aTo = Math.min(vd, vEnd);
      const startSample = Math.max(0, Math.floor(aFrom * sr));
      const endSample = Math.min(audioBuf.length, Math.floor(aTo * sr));
      const tsBaseUs = Math.max(0, (aFrom - vStart)) * 1e6;
      const planes = [];
      for (let c = 0; c < audioCodec.chans; c++) planes.push(audioBuf.getChannelData(c));
      for (let off = startSample; off < endSample; off += chunkFrames) {
        const nfr = Math.min(chunkFrames, endSample - off);
        const data = new Float32Array(nfr * audioCodec.chans);
        for (let c = 0; c < audioCodec.chans; c++) data.set(planes[c].subarray(off, off + nfr), c * nfr);
        aEnc.encode(new AudioData({
          format: "f32-planar", sampleRate: sr, numberOfFrames: nfr,
          numberOfChannels: audioCodec.chans, timestamp: Math.round(tsBaseUs + (off - startSample) / sr * 1e6), data,
        }));
      }
      await aEnc.flush();
      aEnc.close();
    }

    const t0 = performance.now();
    for (let i = 0; i < total; i++) {
      if (cancelExport) break;
      const rt = vStart + i / fps;
      if (hasVideo && rt >= 0 && rt <= vd) await seekVideo(rt);
      drawFrame(ctx, W, H, rt, false);
      const frame = new VideoFrame(canvas, { timestamp: Math.round(i * 1e6 / fps), duration: Math.round(1e6 / fps) });
      encoder.encode(frame, { keyFrame: i % Math.max(1, Math.round(fps * 2)) === 0 });
      frame.close();
      while (encoder.encodeQueueSize > 6) await new Promise((r) => setTimeout(r, 2));
      if (i % 10 === 0) {
        const el = (performance.now() - t0) / 1000;
        const rate = (i / fps) / (el || 1);
        const eta = el / Math.max(1, i) * (total - i);
        xpStatus(`Frame ${i + 1} / ${total} · ${rate.toFixed(1)}x realtime · ~${fmtT(eta)} left${audioCodec ? "" : hasVideo ? " · no audio" : ""}`, i / total);
        await new Promise((r) => setTimeout(r, 0));
      }
    }
    if (cancelExport) { try { encoder.close(); } catch (_) {} return; }
    xpStatus("Finalizing…", 1);
    await encoder.flush();
    encoder.close();
    muxer.finalize();
    downloadBlob(new Blob([target.buffer], { type: "video/mp4" }), exportName("mp4"));
  }

  async function exportMediaRecorder(W, H, fps) {
    // Realtime fallback: draw into a canvas while the footage plays and
    // let MediaRecorder do the encoding (audio comes along natively). It
    // renders the footage-overlapping window; chroma tails of a
    // trip-chroma export are omitted on this legacy path.
    const range = exportRange();
    const vd = videoEl.duration || 0;
    const playStart = hasVideo ? Math.max(0, range.vStart) : range.vStart;
    const playEnd = hasVideo ? Math.min(vd, range.vEnd) : range.vEnd;
    const dur = Math.max(0.1, playEnd - playStart);
    const canvas = document.createElement("canvas");
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext("2d");
    const stream = canvas.captureStream(fps);
    if (hasVideo) {
      try {
        const vs = videoEl.captureStream();
        vs.getAudioTracks().forEach((t) => stream.addTrack(t));
        videoEl.muted = false; videoEl.volume = 0;
      } catch (_) {}
    }
    const mime = ["video/mp4;codecs=\"avc1.640028,mp4a.40.2\"", "video/mp4",
      "video/webm;codecs=h264,opus", "video/webm;codecs=vp9,opus", "video/webm"]
      .find((m) => MediaRecorder.isTypeSupported(m)) || "";
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: Math.round(W * H * fps * 0.12) });
    const parts = [];
    rec.ondataavailable = (e) => { if (e.data.size) parts.push(e.data); };
    const done = new Promise((res) => { rec.onstop = res; });
    rec.start(1000);
    const t0 = performance.now();
    if (hasVideo) { videoEl.currentTime = playStart; await videoEl.play(); }
    await new Promise((res) => {
      const step = () => {
        const rt = hasVideo ? videoEl.currentTime : (playStart + (performance.now() - t0) / 1000);
        drawFrame(ctx, W, H, rt, false);
        const prog = (rt - playStart) / dur;
        xpStatus(`Recording ${fmtT(rt - playStart)} / ${fmtT(dur)} (realtime)`, prog);
        if (cancelExport || rt >= playEnd - 0.05 || (hasVideo && videoEl.ended)) return res();
        requestAnimationFrame(step);
      };
      step();
    });
    if (hasVideo) { videoEl.pause(); videoEl.muted = true; }
    rec.stop();
    await done;
    if (cancelExport) return;
    const ext = mime.startsWith("video/mp4") ? "mp4" : "webm";
    downloadBlob(new Blob(parts, { type: mime || "video/webm" }), exportName(ext));
  }

  function exportName(ext) {
    const base = (track && (track.date || track.name) || "trip").replace(/[^\w.-]+/g, "_");
    const trimmed = hasVideo && exportRange().mode !== "video";
    return base + "_overlay" + (trimmed ? "_trim" : "") + "." + ext;
  }
  function downloadBlob(blob, name) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 30000);
  }

  // --- Phone: bottom nav switches the content area (Media, Style,
  // Export); the preview and timeline stay put on top. The media and
  // export rows proxy the same inputs the desktop topbar uses. ---
  document.querySelectorAll("#mob-nav button").forEach((b) => {
    b.addEventListener("click", () => {
      document.body.dataset.mtab = b.dataset.mtab;
      document.querySelectorAll("#mob-nav button").forEach((x) =>
        x.classList.toggle("active", x === b));
    });
  });
  const mrProxy = { "mr-video": "file-video", "mr-trip": "file-trip", "mr-vbo": "file-vbo", "mr-sync": "file-lrv", "mr-load": "file-cfg" };
  for (const id in mrProxy) {
    const el = $(id);
    if (el) el.addEventListener("click", () => $(mrProxy[id]).click());
  }
  if ($("mr-save")) $("mr-save").addEventListener("click", saveCfgFile);
  function setStatus(id, text) {
    const el = $(id);
    if (el) el.textContent = text;
  }

  // First paint.
  if (pendingTrack) setTrack(pendingTrack);
  else $("stage-empty").classList.remove("hidden");
  fitPreviewCanvas();
  layoutTimeline();
  if (S) drawTeleGraph();
  updateInOutLabel();
  requestDraw();

  // Test hook (Playwright drives exports and reads state through this).
  window.__eucVideo = {
    get cfg() { return cfg; }, get samples() { return S; },
    setTrack, requestDraw, sampleAt, applyCfg,
    exportWebCodecs, exportDuration, exportRange,
    setPlayhead, setTrimIn, setTrimOut, resetTrim, exportMediaRecorder,
    renderProbe(t) {
      const c = document.createElement("canvas");
      c.width = 64; c.height = 64;
      drawFrame(c.getContext("2d"), 64, 64, t, false);
      const d = c.getContext("2d").getImageData(2, 2, 1, 1).data;
      return [d[0], d[1], d[2]];
    },
  };
})();
