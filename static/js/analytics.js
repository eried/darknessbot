(async function () {
  "use strict";

  // Imperial unit toggle — drives display labels and converters everywhere
  // values are shown. Timezone-based: imperial only when the OS timezone is
  // in the US, US territories, Liberia or Myanmar. navigator.language is
  // unreliable because English Windows defaults to en-US worldwide.
  // Keep in sync with app.js / inspector.js.
  const UNITS_STORAGE_KEY = "eucviewer-units";
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
  // Temperature *differences* scale by 9/5 but must not get the +32 offset.
  const tempDelta = (c) => (UNITS.imperial ? c * 9 / 5 : c);

  // Static HTML copy carries metric units in chart subtitles, hints,
  // tooltips and select labels. Data values convert at render time; this
  // one-time pass converts the fixed strings around them for imperial
  // users. The anomaly threshold inputs stay km/h on purpose (their
  // stored values are metric).
  if (UNITS.imperial) {
    const conv = (s) => s
      // innerHTML serializes U+00A0 back to the &nbsp; entity, which \s
      // can't match; normalize before converting.
      .replace(/&nbsp;/g, " ")
      .replace(/(\d+(?:\.\d+)?)\s*km\/h/g, (_, n) => `${Math.round(n * 0.621371)} mph`)
      .replace(/km\/h/g, "mph")
      .replace(/(\d+(?:\.\d+)?)\s*°C/g, (_, n) => `${Math.round(n * 9 / 5 + 32)} °F`)
      .replace(/°C/g, "°F")
      .replace(/Wh\/km/g, "Wh/mi")
      .replace(/km\/%/g, "mi/%")
      .replace(/meters of altitude gain per km/g, "feet of altitude gain per mi")
      .replace(/(\d+(?:\.\d+)?)\s*km\b/g, (_, n) => `${Math.round(n * 0.621371)} mi`);
    document.querySelectorAll(
      ".sec-hint, .chart-explainer, .chart-title, #group-select option, .controls .check-label > span"
    ).forEach((el) => {
      if (el.children.length === 0) el.textContent = conv(el.textContent);
      else el.innerHTML = conv(el.innerHTML);
    });
    document.querySelectorAll("#lifetime-bar .stat-card[title], .controls .info-icon[title]").forEach((el) => {
      el.setAttribute("title", conv(el.getAttribute("title") || ""));
    });
    const accelCard = document.getElementById("lf-accel40");
    if (accelCard) {
      const lbl = accelCard.parentElement.querySelector(".sl");
      if (lbl) lbl.innerHTML = conv(lbl.innerHTML);
    }
  }

  // ---------- DOM ----------
  const errorBanner = document.getElementById("error-banner");
  const subtitleEl = document.getElementById("page-subtitle");
  const groupSel = document.getElementById("group-select");
  const battMinSel = document.getElementById("batt-min-select");
  const minBinSel = document.getElementById("minbin-select");
  const rollingCheck = document.getElementById("rolling-check");
  const normalizeCheck = document.getElementById("normalize-check");
  const weatherBtn = document.getElementById("weather-btn");
  const weatherStatus = document.getElementById("weather-status");
  const progressStrip = document.getElementById("progress-strip");
  const progressFill = document.getElementById("progress-strip-fill");
  const insightsBox = document.getElementById("insights");
  const insightsList = document.getElementById("insights-list");
  const rangeTempHost = document.getElementById("range-temp-host");

  // Anomaly detector settings - persisted per-browser so the user can
  // tune them once for their wheel/loadout and keep the result.
  const ANOM_STORAGE_KEY = "wheel-forensics-anom-settings";
  const ANOM_DEFAULTS = { gpsThresh: 2, accelThresh: 6, preFallSpd: 12, postStopStreak: 5, minEventLen: 2, motorActiveA: 1 };
  let anomalySettings = (() => {
    try {
      const raw = localStorage.getItem(ANOM_STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        return Object.assign({}, ANOM_DEFAULTS, parsed);
      }
    } catch (_) {}
    return Object.assign({}, ANOM_DEFAULTS);
  })();
  function saveAnomSettings() {
    try { localStorage.setItem(ANOM_STORAGE_KEY, JSON.stringify(anomalySettings)); } catch (_) {}
  }
  function bindAnomSettings() {
    const inputs = [
      ["anom-gps-thresh", "gpsThresh"],
      ["anom-accel-thresh", "accelThresh"],
      ["anom-prefall-spd", "preFallSpd"],
      ["anom-poststop", "postStopStreak"],
      ["anom-min-event-len", "minEventLen"],
      ["anom-motor-active", "motorActiveA"],
    ];
    for (const [id, key] of inputs) {
      const el = document.getElementById(id);
      if (!el) continue;
      el.value = anomalySettings[key];
      el.addEventListener("change", () => {
        const v = Number(el.value);
        if (!isNaN(v)) {
          anomalySettings[key] = v;
          saveAnomSettings();
          recomputeAnomalies();
        }
      });
    }
    const reset = document.getElementById("anom-reset");
    if (reset) {
      reset.addEventListener("click", () => {
        anomalySettings = Object.assign({}, ANOM_DEFAULTS);
        saveAnomSettings();
        for (const [id, key] of inputs) {
          const el = document.getElementById(id);
          if (el) el.value = anomalySettings[key];
        }
        recomputeAnomalies();
      });
    }
  }
  // Re-run anomaly detection on every loaded trip without re-parsing the
  // .dbb. Fast enough at 200+ trips.
  let tracksRef = null;
  let metricsRef = null;
  function recomputeAnomalies() {
    if (!tracksRef || !metricsRef) return;
    for (let i = 0; i < tracksRef.length; i++) {
      const t = tracksRef[i];
      const rawTs = Array.isArray(t.timeseries) ? t.timeseries : [];
      const la = lastAliveIndex(rawTs);
      const ts = la >= 0 ? rawTs.slice(0, la + 1) : rawTs;
      const { indices: anomIdx, events: anomEvents } = detectAnomalies(ts, anomalySettings);
      metricsRef[i].anomalies = anomEvents;
      // Recompute the affected metrics
      let maxV = 0;
      for (let k = 0; k < ts.length; k++) {
        if (anomIdx.has(k)) continue;
        const v = ts[k][SPD] || 0;
        if (v > maxV && v <= 100) maxV = v;
      }
      metricsRef[i].topSpeedKmh = maxV > 0 ? maxV : null;
      const a25 = bestAccelTime(ts, 25, anomIdx);
      metricsRef[i].accel25 = a25 ? a25.dur : null;
      const a40 = bestAccelTime(ts, 40, anomIdx);
      metricsRef[i].accel40 = a40 ? a40.dur : null;
      const a60 = bestAccelTime(ts, 60, anomIdx);
      metricsRef[i].accel60 = a60 ? a60.dur : null;
    }
    if (typeof renderAll === "function") renderAll();
  }

  function showError(msg) {
    errorBanner.textContent = msg;
    errorBanner.classList.remove("hidden");
  }

  // ---------- Tabs / layout ----------
  // Tab membership comes from data-tab attributes on sections. The active tab
  // gets a `.tab-active` class so CSS in [data-tab]:not(.tab-active) hides the
  // siblings in tabs mode. Single-page mode shows everything.
  const LAYOUT_KEY = "wheel-forensics-layout";
  let activeTab = "overview";
  function applyLayout(layout) {
    document.body.setAttribute("data-layout", layout);
    const btn = document.getElementById("layout-toggle");
    if (btn) btn.title = layout === "tabs" ? "Switch to one-page layout" : "Switch to tabbed layout";
    try { localStorage.setItem(LAYOUT_KEY, layout); } catch (_) {}
    if (typeof renderAll === "function") renderAll();
  }
  function applyTab(tab) {
    activeTab = tab;
    document.querySelectorAll(".tab-btn").forEach((b) => {
      b.classList.toggle("active", b.dataset.tab === tab);
    });
    document.querySelectorAll("[data-tab]").forEach((el) => {
      if (el.classList.contains("tab-btn")) return;
      el.classList.toggle("tab-active", el.dataset.tab === tab);
    });
    if (typeof renderAll === "function") renderAll();
  }
  // `renderAll` is a function declaration further down — it's hoisted into
  // this scope already, so applyTab/applyLayout above can reference it.
  (function initLayoutControls() {
    let saved = "tabs";
    try { saved = localStorage.getItem(LAYOUT_KEY) || "tabs"; } catch (_) {}
    document.body.setAttribute("data-layout", saved);
    const btn = document.getElementById("layout-toggle");
    if (btn) {
      btn.title = saved === "tabs" ? "Switch to one-page layout" : "Switch to tabbed layout";
      btn.addEventListener("click", () => {
        const current = document.body.getAttribute("data-layout") || "tabs";
        applyLayout(current === "tabs" ? "single" : "tabs");
      });
    }
    document.querySelectorAll("[data-tab]").forEach((el) => {
      if (el.classList.contains("tab-btn")) return;
      el.classList.toggle("tab-active", el.dataset.tab === activeTab);
    });
    document.querySelectorAll(".tab-btn").forEach((b) => {
      b.classList.toggle("active", b.dataset.tab === activeTab);
      b.addEventListener("click", () => applyTab(b.dataset.tab));
    });
  })();

  // ---------- Load tracks (IndexedDB first — see CLAUDE.md) ----------
  const DB_NAME = "eucplanet-trip-viewer";
  const RECENT_STORE_NAME = "recentFiles";
  const SESSION_STORE_NAME = "currentSession";
  const WEATHER_STORE_NAME = "weatherCache";
  const SESSION_KEY = "tracks";

  // Same v3 schema as openRecentDb() in app.js — whichever page opens the DB
  // first creates the weatherCache store; the upgrade blocks must match.
  let dbPromise = null;
  function openDb() {
    if (!("indexedDB" in window)) return Promise.resolve(null);
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, 3);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains(RECENT_STORE_NAME)) {
            db.createObjectStore(RECENT_STORE_NAME, { keyPath: "id" });
          }
          if (!db.objectStoreNames.contains(SESSION_STORE_NAME)) {
            db.createObjectStore(SESSION_STORE_NAME);
          }
          if (!db.objectStoreNames.contains(WEATHER_STORE_NAME)) {
            db.createObjectStore(WEATHER_STORE_NAME);
          }
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error("Failed to open database"));
      }).catch((e) => { dbPromise = null; throw e; });
    }
    return dbPromise;
  }

  async function loadFromIDB() {
    try {
      const db = await openDb();
      if (!db) return null;
      return await new Promise((resolve) => {
        try {
          const tx = db.transaction(SESSION_STORE_NAME, "readonly");
          const getReq = tx.objectStore(SESSION_STORE_NAME).get(SESSION_KEY);
          getReq.onsuccess = () => resolve(getReq.result || null);
          getReq.onerror = () => resolve(null);
        } catch { resolve(null); }
      });
    } catch { return null; }
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
  if (!tracks || !Array.isArray(tracks) || !tracks.length) {
    showError("No trips found. Open the main viewer, load your trips, then come back here.");
    return;
  }

  // Timeseries layout: [sec, speed, voltage, temp, battery, altitude, lat, lon, mileageKm,
  //                     pwm, current, power, gpsSpeed, gForce, gForceX, gForceY]
  const SEC = 0, SPD = 1, VOLT = 2, TEMP = 3, BATT = 4, ALT = 5, LAT = 6, LON = 7, MILEAGE = 8;
  const PWM = 9, CURRENT = 10, POWER = 11, GPSSPD = 12, GFORCE = 13;

  // ---------- Small stats helpers ----------
  function median(values) {
    if (!values.length) return null;
    const s = values.slice().sort((a, b) => a - b);
    const mid = s.length >> 1;
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  }
  function percentile(values, p) {
    if (!values.length) return null;
    const s = values.slice().sort((a, b) => a - b);
    const idx = (s.length - 1) * p;
    const lo = Math.floor(idx), hi = Math.ceil(idx);
    return s[lo] + (s[hi] - s[lo]) * (idx - lo);
  }
  // Median of `values` where each value carries a weight (we weight trips by
  // distance so one long ride counts more than five around-the-block hops).
  function weightedMedian(values, weights) {
    if (!values.length) return null;
    const order = values.map((v, i) => i).sort((a, b) => values[a] - values[b]);
    let total = 0;
    for (const w of weights) total += w;
    if (total <= 0) return median(values);
    let acc = 0;
    for (const i of order) {
      acc += weights[i];
      if (acc >= total / 2) return values[i];
    }
    return values[order[order.length - 1]];
  }
  // Theil–Sen robust regression: slope = median of pairwise slopes. Resistant
  // to outliers, no library needed. Caps the sample so n² stays bounded.
  function theilSen(xs, ys) {
    let n = xs.length;
    if (n < 8) return null;
    let ix = xs.map((_, i) => i);
    if (n > 400) {
      for (let i = ix.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [ix[i], ix[j]] = [ix[j], ix[i]];
      }
      ix = ix.slice(0, 400);
      n = 400;
    }
    const slopes = [];
    for (let a = 0; a < n; a++) {
      for (let b = a + 1; b < n; b++) {
        const dx = xs[ix[b]] - xs[ix[a]];
        if (dx === 0) continue;
        slopes.push((ys[ix[b]] - ys[ix[a]]) / dx);
      }
    }
    const slope = median(slopes);
    if (slope == null) return null;
    const intercept = median(ix.map((i) => ys[i] - slope * xs[i]));
    return { slope, intercept };
  }
  // Multiple linear regression by normal equations + Gaussian elimination.
  // Returns { beta, rss, ssTot, n, r2 } so callers can gauge fit quality.
  // Works for the small (n, p ≤ 6) problems we have: range vs (speed,
  // temp, climb) etc.
  function multipleLinearRegression(X, y) {
    const n = X.length; if (!n) return null;
    const p = X[0].length;
    const XtX = [];
    const Xty = [];
    for (let i = 0; i < p; i++) { XtX.push(new Array(p).fill(0)); Xty.push(0); }
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < p; j++) {
        Xty[j] += X[i][j] * y[i];
        for (let k = 0; k < p; k++) XtX[j][k] += X[i][j] * X[i][k];
      }
    }
    // Augmented matrix [XtX | Xty]
    const aug = XtX.map((row, i) => row.concat(Xty[i]));
    for (let i = 0; i < p; i++) {
      // partial pivot
      let maxRow = i;
      for (let k = i + 1; k < p; k++) if (Math.abs(aug[k][i]) > Math.abs(aug[maxRow][i])) maxRow = k;
      [aug[i], aug[maxRow]] = [aug[maxRow], aug[i]];
      if (Math.abs(aug[i][i]) < 1e-10) return null; // singular
      for (let k = i + 1; k < p; k++) {
        const f = aug[k][i] / aug[i][i];
        for (let j = i; j <= p; j++) aug[k][j] -= f * aug[i][j];
      }
    }
    const beta = new Array(p).fill(0);
    for (let i = p - 1; i >= 0; i--) {
      let s = aug[i][p];
      for (let j = i + 1; j < p; j++) s -= aug[i][j] * beta[j];
      beta[i] = s / aug[i][i];
    }
    // R² = 1 - (Σ(y_i - ŷ_i)²) / (Σ(y_i - ȳ)²). Compute both sums in one
    // pass alongside the fitted predictions for downstream display.
    let yMean = 0;
    for (let i = 0; i < n; i++) yMean += y[i];
    yMean /= n;
    let rss = 0, ssTot = 0;
    for (let i = 0; i < n; i++) {
      let yHat = 0;
      for (let j = 0; j < p; j++) yHat += X[i][j] * beta[j];
      const r = y[i] - yHat;
      rss += r * r;
      const d = y[i] - yMean;
      ssTot += d * d;
    }
    const r2 = ssTot > 0 ? 1 - rss / ssTot : 0;
    return { beta, rss, ssTot, n, r2 };
  }

  // Ordinary least-squares slope (used per trip for the V~I sag fit, where
  // n is small and the samples are already filtered).
  function lsSlope(xs, ys) {
    const n = xs.length;
    let sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (let i = 0; i < n; i++) {
      sx += xs[i]; sy += ys[i];
      sxx += xs[i] * xs[i]; sxy += xs[i] * ys[i];
    }
    const denom = n * sxx - sx * sx;
    if (denom === 0) return null;
    return (n * sxy - sx * sy) / denom;
  }

  // ---------- Per-trip metric extraction ----------
  function parseTripDate(t) {
    const ds = t.dateStart || "";
    if (ds) {
      const d = new Date(ds);
      if (!isNaN(d.getTime())) return d;
    }
    if (t.date) {
      // "DD.MM.YYYY" filename-derived date — same fallback app.js sorting uses.
      const parts = t.date.split(".");
      if (parts.length === 3) {
        const d = new Date(`${parts[2]}-${parts[1]}-${parts[0]}`);
        if (!isNaN(d.getTime())) return d;
      }
    }
    return null;
  }

  function tripDistanceKm(t) {
    if (t.stats && t.stats.distanceKm > 0) return t.stats.distanceKm;
    const ts = t.timeseries;
    if (!Array.isArray(ts) || ts.length < 2) return 0;
    // Mileage odometer column if present, else integrate speed over time —
    // the same fallbacks loadTracks() in app.js applies for legacy tracks.
    if (ts[0].length > MILEAGE) {
      let last = 0;
      for (let i = 0; i < ts.length; i++) { const mi = ts[i][MILEAGE] || 0; if (mi > last) last = mi; }
      if (last > 0) return Math.round(last * 100) / 100;
    }
    let running = 0;
    for (let i = 1; i < ts.length; i++) {
      const dtSec = Math.max(0, ts[i][SEC] - ts[i - 1][SEC]);
      const avgSpd = ((ts[i][SPD] || 0) + (ts[i - 1][SPD] || 0)) / 2;
      running += (avgSpd * dtSec) / 3600;
    }
    return Math.round(running * 100) / 100;
  }

  // Some EUC loggers keep writing samples after the wheel powers off — the
  // voltage column snaps to a constant low value (e.g. 13.1 V) and the
  // battery % freezes at whatever it last saw, while real samples sit safely
  // above 60 V for any pack still in use. Find the last "alive" index so
  // every downstream computation (battery delta, IR fit, temp max, etc.)
  // skips that junk tail. Threshold of 50 V is below any modern EUC pack
  // (lowest is 67 V at 0% for InMotion V8) yet well above the typical
  // corrupted-tail readings (10–20 V).
  function lastAliveIndex(ts) {
    for (let i = ts.length - 1; i >= 0; i--) {
      const v = ts[i][VOLT];
      if (typeof v === "number" && v >= 50) return i;
    }
    return -1;
  }

  // Detect "anomaly" samples: free spins (wheel spinning without ground
  // contact, e.g. pick-up tests or falls) and physics-impossible accelerations.
  //
  //   Free spin = wheel speed > 5 km/h while GPS speed < 2 km/h
  //   Impossible accel = > 6 m/s² (real-world EUC peak accel is ~3 m/s²)
  //
  // Each anomaly carries `kind`: "lift" if the wheel returned to rest
  // cleanly without a preceding high-speed run, "fall" if it followed a
  // sustained high-speed window (suggesting an unplanned dismount).
  // Returns { indices: Set, events: [{kind, sec, peakSpd, durS}] }.
  function detectAnomalies(ts, opts) {
    opts = opts || {};
    const gpsThresh = opts.gpsThresh != null ? opts.gpsThresh : 2;
    const accelThresh = opts.accelThresh != null ? opts.accelThresh : 6;
    const preFallSpd = opts.preFallSpd != null ? opts.preFallSpd : 12;
    const postStopStreak = opts.postStopStreak != null ? opts.postStopStreak : 5;
    const minEventLen = opts.minEventLen != null ? opts.minEventLen : 2;
    // Motor "doing work" threshold. The watts cutoff scales with amps so the
    // pair stays in step: bumping amps to 2 also bumps power to 200 W.
    const motorActiveA = opts.motorActiveA != null ? opts.motorActiveA : 1;
    const motorActiveW = motorActiveA * 100;
    const indices = new Set();
    const events = [];
    if (ts.length < 4) return { indices, events };
    // First pass: per-sample anomaly flagging
    const flags = new Array(ts.length).fill(false);
    for (let i = 1; i < ts.length; i++) {
      const dt = ts[i][SEC] - ts[i - 1][SEC];
      if (dt <= 0 || dt > 5) continue;
      const w = ts[i][SPD] || 0;
      const g = ts[i][GPSSPD];
      const prevG = ts[i - 1][GPSSPD];
      // Free spin detection requires GPS data to be present (>0 on either
      // side of the window — otherwise we'd flag wheels parked indoors).
      const hasGps = (typeof g === "number" && g > 0.3) || (typeof prevG === "number" && prevG > 0.3);
      if (hasGps && w > 5 && typeof g === "number" && g < gpsThresh) {
        flags[i] = true;
        indices.add(i);
      }
      // Impossible-accel sanity check. dV in m/s over dt seconds.
      const dV = ((w || 0) - (ts[i - 1][SPD] || 0)) / 3.6;
      if (dV / dt > accelThresh && w > 10) {
        flags[i] = true;
        indices.add(i);
      }
      // Phantom-speed check: a wheel reading 25+ km/h while the motor was
      // completely idle is physics-impossible. A real EUC at that speed
      // pulls amps. Loggers entering shutdown often emit phantom speed
      // values with current = 0 / power = 0 — this catches them even
      // when the GPS column was already corrupted (so the regular
      // free-spin check would have missed them).
      if (w >= 25) {
        const cur = Math.abs(ts[i][CURRENT] || 0);
        const pwr = Math.abs(ts[i][POWER] || 0);
        if (cur < motorActiveA && pwr < motorActiveW) {
          // Sample wasn't pulling current. Did at least one neighbour
          // in ±2 samples? Sustained riding at high speed almost always
          // has *some* sample drawing current.
          let neighborWorked = false;
          for (let k = Math.max(0, i - 2); k <= Math.min(ts.length - 1, i + 2); k++) {
            if (k === i) continue;
            const c = Math.abs(ts[k][CURRENT] || 0);
            const p = Math.abs(ts[k][POWER] || 0);
            if (c >= motorActiveA || p >= motorActiveW) { neighborWorked = true; break; }
          }
          if (!neighborWorked) {
            flags[i] = true;
            indices.add(i);
          }
        }
      }
    }
    // Second pass: group contiguous flagged samples into events.
    let i = 0;
    while (i < ts.length) {
      if (!flags[i]) { i++; continue; }
      const startI = i;
      let peakSpd = ts[i][SPD] || 0;
      // Extend through the contiguous flagged window, allowing 1 gap.
      let gap = 0;
      let j = i;
      while (j < ts.length && (flags[j] || gap < 2)) {
        if (flags[j]) { gap = 0; if ((ts[j][SPD] || 0) > peakSpd) peakSpd = ts[j][SPD]; }
        else gap++;
        j++;
      }
      const endI = Math.min(ts.length - 1, j - 1);
      const durS = (ts[endI][SEC] || 0) - (ts[startI][SEC] || 0);
      // Classify the event into one of three kinds:
      //   GLITCH - logger malfunction (cascade of bad samples in a zero-motor
      //            window). Not a rider event.
      //   FALL   - the rider was *actually* riding fast (motor working AND
      //            wheel/GPS agreed), then the wheel cut out and the rider's
      //            ground speed crashed and stayed low.
      //   LIFT   - everything else (pickup tests, brief GPS dropouts in
      //            tunnels / turns, momentary safety beeps).
      // A real fall requires BOTH the apparent ride speed and proof that the
      // motor was doing work in the pre-window. A logger that reports fake
      // 60 km/h with current = 0 can no longer fake a fall.
      let preFastCount = 0;
      let preWorked = 0;
      let prePeakGps = 0;
      for (let k = Math.max(0, startI - 12); k < startI; k++) {
        const w = ts[k][SPD] || 0, g = ts[k][GPSSPD];
        if (typeof g === "number" && g >= preFallSpd && w >= preFallSpd) preFastCount++;
        if (typeof g === "number" && g > prePeakGps) prePeakGps = g;
        const cur = Math.abs(ts[k][CURRENT] || 0);
        const pwr = Math.abs(ts[k][POWER] || 0);
        if (cur >= motorActiveA || pwr >= motorActiveW) preWorked++;
      }
      // Logger-glitch: nothing in the surrounding ±8 sample window was
      // actually driving the wheel — current and power were both flat.
      // This is a cascade of phantom readings, not a rider event.
      let surroundingWorked = false;
      for (let k = Math.max(0, startI - 8); k <= Math.min(ts.length - 1, endI + 8); k++) {
        if (k >= startI && k <= endI) continue;
        const cur = Math.abs(ts[k][CURRENT] || 0);
        const pwr = Math.abs(ts[k][POWER] || 0);
        if (cur >= motorActiveA || pwr >= motorActiveW) { surroundingWorked = true; break; }
      }
      // Stricter pre-window check: a real fall happens AFTER the rider was
      // genuinely cruising, not after a 12 km/h hop. Require at least half
      // of the pre-window samples to show riding speed + motor work, AND a
      // peak GPS speed that crosses the pre-fall threshold (not just a few
      // borderline samples averaging up).
      const PRE_REQUIRED = Math.max(6, Math.ceil((preFallSpd >= 20 ? 8 : 6)));
      const preLooksLikeRiding = preFastCount >= PRE_REQUIRED
        && preWorked >= PRE_REQUIRED
        && prePeakGps >= preFallSpd + 5;
      // Stricter post-window: stay still for a sustained stretch (default
      // 12 samples, roughly 40-60 s on most loggers). Real falls don't
      // recover that fast. The old "scanned >= 6" fallback was too loose
      // and let brief 4-5 sample GPS dropouts count.
      const POST_REQUIRED = Math.max(postStopStreak, 12);
      let postCrashed = false;
      if (preLooksLikeRiding) {
        // Look further ahead too: 40 samples = ~3 minutes on a 4 s logger.
        let lowStreak = 0;
        for (let k = endI + 1; k < Math.min(ts.length, endI + 41); k++) {
          const g = ts[k][GPSSPD];
          if (typeof g === "number" && g < 3) lowStreak++; else lowStreak = 0;
          if (lowStreak >= POST_REQUIRED) { postCrashed = true; break; }
        }
      }
      // Strict LIFT: GPS confirms the wheel didn't move AND the motor was
      // idle (no current / power being delivered) for the bulk of the
      // event AND it lasted long enough that a hand-spinning rider could
      // have actually triggered it. Otherwise it's just a sensor blip
      // during normal riding (GPS dropout, brief noise).
      let gpsLow = 0, gpsTotal = 0, motorIdle = 0;
      const eventLen = endI - startI + 1;
      for (let k = startI; k <= endI; k++) {
        const g = ts[k][GPSSPD];
        if (typeof g === "number") { gpsTotal++; if (g < 2) gpsLow++; }
        const cur = Math.abs(ts[k][CURRENT] || 0);
        const pwr = Math.abs(ts[k][POWER] || 0);
        if (cur < motorActiveA && pwr < motorActiveW) motorIdle++;
      }
      const gpsStationaryRatio = gpsTotal > 0 ? gpsLow / gpsTotal : 0;
      const motorIdleRatio = motorIdle / eventLen;
      // Fall events have to LOOK like a fall: the wheel reached freespin
      // speed during the event (>= 20 km/h) AND the rider was clearly
      // cruising before (peak GPS >= 18 km/h). A 6 km/h peak event isn't
      // a fall, and a fall after a 12 km/h hop isn't credible either.
      const peakLooksLikeFall = peakSpd >= 20 && prePeakGps >= 18;
      let kind;
      if (!surroundingWorked) {
        kind = "glitch";
      } else if (preLooksLikeRiding && postCrashed && peakLooksLikeFall) {
        kind = "fall";
      } else if (gpsStationaryRatio >= 0.7 && motorIdleRatio >= 0.7 && eventLen >= minEventLen) {
        kind = "lift";
      } else {
        kind = "spike";
      }
      events.push({
        kind,
        sec: ts[startI][SEC],
        peakSpd,
        durS,
        preFastCount,
        preWorked,
      });
      i = j;
    }
    return { indices, events };
  }

  // Walk through `ts` looking for the fastest acceleration runs from at-rest
  // up to `targetKmh`. Returns the best (shortest) time achieved, plus the
  // start-second so the UI can locate it. Excludes samples in `skipSet`.
  function bestAccelTime(ts, targetKmh, skipSet) {
    let best = null;
    let i = 0;
    while (i < ts.length) {
      // Start: speed below 3 km/h (effectively stopped)
      while (i < ts.length && (ts[i][SPD] || 0) >= 3) i++;
      if (i >= ts.length) break;
      const startI = i;
      // Skip leading at-rest samples
      while (i < ts.length && (ts[i][SPD] || 0) < 3) i++;
      // Now scan up to target
      let aborted = false;
      while (i < ts.length && (ts[i][SPD] || 0) < targetKmh) {
        if (skipSet.has(i)) { aborted = true; break; }
        i++;
      }
      if (!aborted && i < ts.length && (ts[i][SPD] || 0) >= targetKmh && !skipSet.has(i)) {
        // First moving sample (>= 3 km/h) defines the start time
        let firstMoveI = startI;
        while (firstMoveI < i && (ts[firstMoveI][SPD] || 0) < 3) firstMoveI++;
        const dur = (ts[i][SEC] || 0) - (ts[firstMoveI][SEC] || 0);
        if (dur > 0 && dur < 60) {
          if (best == null || dur < best.dur) best = { dur, atSec: ts[firstMoveI][SEC] };
        }
      }
      // Continue past current point
      while (i < ts.length && (ts[i][SPD] || 0) >= 3) i++;
    }
    return best;
  }

  // Return the slice of `gs` covering at least `seconds` worth of samples
  // starting at index `startI`. Used to compute "sustained G": the lowest
  // |G| value sustained over a 1-second window starting at a given sample.
  function sliceFloor(gs, ts, startI, seconds) {
    const t0 = ts[startI][SEC] || 0;
    const out = [gs[startI]];
    for (let j = startI + 1; j < ts.length; j++) {
      const dt = (ts[j][SEC] || 0) - t0;
      if (dt > seconds) break;
      out.push(gs[j]);
    }
    return out;
  }

  // Display label for a trip. The parser only fills t.date when the
  // filename carries a date (old "MAC_dd.MM.yyyy_n" exports); new-style
  // "trip_YYYYMMDD_HHMMSS" names don't match, so fall back to formatting
  // the first-sample timestamp instead of showing the raw filename.
  function fmtTripLabel(d) {
    const p = (n) => String(n).padStart(2, "0");
    return `${p(d.getDate())}.${p(d.getMonth() + 1)}.${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }
  // Real wheel identity only (no voltage guessing): euc.world CSVs carry
  // make/model/serial in their extra column, attached at parse as
  // track.wheel. Trips without it stay unattributed.
  function wheelKeyOf(t) {
    const w = t && t.wheel;
    if (!w) return null;
    // Some wheels report the brand inside the model ("InMotion P6"); don't
    // double it up in the label.
    const modelHasMake = w.make && w.model &&
      w.model.toLowerCase().startsWith(w.make.toLowerCase());
    const label = (modelHasMake ? w.model : [w.make, w.model].filter(Boolean).join(" "))
      || w.name || (w.mac ? "Wheel " + w.mac : null);
    return label ? { key: label + "|" + (w.serial || w.mac || ""), label } : null;
  }

  function computeTripMetrics(t) {
    const rawTs = Array.isArray(t.timeseries) ? t.timeseries : [];
    const lastAlive = lastAliveIndex(rawTs);
    const ts = lastAlive >= 0 ? rawTs.slice(0, lastAlive + 1) : rawTs;
    const date = parseTripDate(t);
    const m = {
      date,
      wheel: wheelKeyOf(t),
      dateStr: date ? localDateStr(date) : null,
      label: t.date || (date ? fmtTripLabel(date) : (t.name || "Trip")),
      distKm: tripDistanceKm(t),
      durH: 0,
      battStart: null, battEnd: null, battDelta: null,
      kmPerPct: null,
      energyWh: null, whPerKm: null,
      driveWh: null,           // Wh drawn from the battery (positive power)
      regenWh: null,           // Wh fed back into the battery (negative power)
      regenPct: null,          // regenWh / driveWh * 100
      avgMovingSpeed: null, avgCurrent: null, avgPower: null,
      ohmIR: null,
      tempMax: null, tempStart: null,
      ambientC: null,
      centroid: null,
      // Forensic adds
      voltSagPct: null,         // (Vmax - Vmin under load) / Vmax * 100
      gPeak: null,              // instantaneous peak |G| (estimated from speed if needed)
      gSustained: null,         // peak |G| held continuously for >= 1s
      gAvg: null,               // mean |G| while moving (>3 km/h)
      gLatPeak: null,           // peak lateral |G| (steady cornering)
      gLongPeak: null,          // peak longitudinal |G| (braking / launch)
      gFromImu: false,          // true if the IMU logged real G, false = estimated
      gripScatter: null,        // [ [speedKmh, latG], ... ] for the grip chart
      // Wheel vs GPS speed agreement
      gpsMeanDiff: null,        // mean (wheel - gps) km/h, positive = wheel reads higher
      gpsMeanAbsDiff: null,     // mean |wheel - gps|, typical disagreement
      gpsP90AbsDiff: null,      // 90th percentile of |wheel - gps|, the spike tail
      gpsSpikeCount: 0,         // count of samples where |wheel - gps| > 5 km/h
      gpsLagSec: null,          // signed lag of GPS behind wheel (positive = GPS later)
      gpsAgreementSamples: 0,   // count of samples where both > thresholds
      topSpeedKmh: null,        // verified max speed (excludes free spins)
      anomalies: [],            // free spins + falls detected within this trip
      accel25: null,            // best 0->25 km/h time (universally achievable)
      accel40: null,            // best 0->40 km/h time
      accel60: null,            // best 0->60 km/h time
      climbM: 0,                // cumulative ascent
      descentM: 0,              // cumulative descent
      stationaryS: 0,           // seconds with speed < 1 km/h while logger alive
      maxGForce: 0,             // peak g-force magnitude (where logged)
    };
    if (t.dateStart && t.dateEnd) {
      const s = new Date(t.dateStart).getTime();
      const e = new Date(t.dateEnd).getTime();
      if (s && e && e > s) m.durH = (e - s) / 3600000;
    }
    if (!m.durH && ts.length > 1) {
      m.durH = Math.max(0, (ts[ts.length - 1][SEC] - ts[0][SEC]) / 3600);
    }
    if (ts.length < 2) return m;

    // Battery start/end: median of the first/last 10 alive-tail samples.
    // Robust against load-sag dips and against logger-tail corruption.
    const battSamples = [];
    for (const row of ts) {
      const v = row[BATT];
      if (typeof v === "number" && v > 0) battSamples.push(v);
    }
    if (battSamples.length >= 4) {
      m.battStart = median(battSamples.slice(0, 10));
      m.battEnd = median(battSamples.slice(-10));
      m.battDelta = m.battStart - m.battEnd;
    }

    // In-ride cost of speed: file every sample-to-sample segment under the
    // speed band it was ridden at (5 km/h buckets) and accumulate battery
    // drop + distance. Aggregated across trips at render time this gives
    // consumption vs speed with trip mix held constant, which is what the
    // range-vs-average-speed scatter can't show. Distance comes from the
    // cumulative mileage column when the logger filled it, else from the
    // GPS track; tracks with neither just skip.
    m.spdCost = null;
    {
      const buckets = Object.create(null);
      let any = false;
      for (let i = 1; i < ts.length; i++) {
        const a = ts[i - 1], b = ts[i];
        const s0 = a[SPD], s1 = b[SPD];
        if (typeof s0 !== "number" || typeof s1 !== "number" || s0 < 3 || s1 < 3) continue;
        let dk = null;
        const k0 = a[MILEAGE], k1 = b[MILEAGE];
        if (typeof k0 === "number" && typeof k1 === "number" && k1 > k0) {
          dk = k1 - k0;
        } else if (typeof a[LAT] === "number" && typeof b[LAT] === "number" &&
                   Math.abs(a[LAT]) > 0.01 && Math.abs(b[LAT]) > 0.01) {
          dk = haversineKm(a[LAT], a[LON], b[LAT], b[LON]);
        }
        if (dk == null || !(dk > 0) || dk > 3) continue;
        const b0 = a[BATT], b1 = b[BATT];
        if (typeof b0 !== "number" || typeof b1 !== "number" || b0 <= 0 || b1 <= 0) continue;
        const db = b0 - b1;
        if (db < -0.5 || db > 5) continue; // charge jump / BMS reset
        const key = Math.floor(((s0 + s1) / 2) / 5) * 5;
        const acc = buckets[key] || (buckets[key] = [0, 0, 0]); // [batt %, km, segments]
        acc[0] += db; acc[1] += dk; acc[2]++;
        any = true;
      }
      if (any) m.spdCost = buckets;
    }

    // Slow-state ledger: time + battery flow at standstill, balancing,
    // walking and slow-riding paces, with cruise as reference. Battery
    // gauges rebound upward right after load disappears (voltage-derived
    // gauges especially), so drops and rises are kept separate and netted
    // at render time. The honest standstill number comes from m.idleStops:
    // contiguous stops of 2+ minutes with stable voltage, where the
    // rebound has settled and charging breaks or power-offs are excluded.
    m.stateCost = null;
    m.idleStops = null;
    {
      const states = { stopped: [0, 0, 0], balance: [0, 0, 0], walk: [0, 0, 0], slowride: [0, 0, 0], cruise: [0, 0, 0] };
      let any = false;
      for (let i = 1; i < ts.length; i++) {
        const a = ts[i - 1], b = ts[i];
        const dt = b[SEC] - a[SEC];
        if (!(dt > 0) || dt > 60) continue;
        const s0 = a[SPD], s1 = b[SPD];
        if (typeof s0 !== "number" || typeof s1 !== "number") continue;
        const v = (s0 + s1) / 2;
        const key = v < 0.5 ? "stopped" : v < 3 ? "balance" : v < 7 ? "walk"
                  : v < 12 ? "slowride" : (v >= 20 && v < 30) ? "cruise" : null;
        if (!key) continue;
        const acc = states[key];
        acc[0] += dt; // [seconds, batt % dropped, batt % risen]
        const b0 = a[BATT], b1 = b[BATT];
        if (typeof b0 === "number" && typeof b1 === "number" && b0 > 0 && b1 > 0) {
          const d = b0 - b1;
          if (d >= 0 && d <= 5) acc[1] += d;
          else if (d < 0 && d >= -5) acc[2] += -d;
        }
        any = true;
      }
      if (any) m.stateCost = states;

      const runs = [0, 0, 0]; // [seconds, batt % dropped, stop count]
      let i0 = -1;
      const flushRun = (iEnd) => {
        if (i0 < 0 || iEnd <= i0) { i0 = -1; return; }
        const dur = ts[iEnd][SEC] - ts[i0][SEC];
        if (dur >= 120) {
          const b0 = ts[i0][BATT], b1 = ts[iEnd][BATT];
          const v0 = ts[i0][VOLT], v1 = ts[iEnd][VOLT];
          if (typeof b0 === "number" && typeof b1 === "number" &&
              typeof v0 === "number" && typeof v1 === "number" &&
              Math.abs(b0 - b1) <= 3 && Math.abs(v1 - v0) <= 3) {
            runs[0] += dur; runs[1] += b0 - b1; runs[2]++;
          }
        }
        i0 = -1;
      };
      for (let i = 0; i < ts.length; i++) {
        const spd = ts[i][SPD];
        const stopped = typeof spd === "number" && spd < 0.5;
        const gapOk = i === 0 || (ts[i][SEC] - ts[i - 1][SEC]) <= 60;
        if (stopped && gapOk) {
          if (i0 < 0) i0 = i;
        } else {
          flushRun(i - 1);
          if (stopped) i0 = i; // gap split: start a fresh run here
        }
      }
      flushRun(ts.length - 1);
      if (runs[2] > 0) m.idleStops = runs;
    }

    // Energy: prefer the logged power column, else reconstruct V×I.
    let hasPower = false, hasVolt = false, hasCurrent = false;
    for (const row of ts) {
      if ((row[POWER] || 0) !== 0) hasPower = true;
      if ((row[VOLT] || 0) !== 0) hasVolt = true;
      if ((row[CURRENT] || 0) !== 0) hasCurrent = true;
    }
    // Detect "stuck current sensor" — runs of 8+ consecutive identical
    // non-zero current readings while the wheel is moving. Real motor
    // current varies sample-to-sample from balance pulses + road texture;
    // a flat-line stretch like that is the logger freezing, not real regen.
    // Skipping these samples from energy integration prevents fake "regen"
    // from inflating the totals (one trip had 11 minutes stuck at -6.2 A,
    // worth ~157 fake Wh).
    const stuck = new Set();
    if (hasCurrent) {
      let runVal = null, runStart = 0, runLen = 0;
      const flushRun = () => {
        if (runLen < 8 || runVal == null || Math.abs(runVal) < 0.1) return;
        let moving = 0;
        for (let k = runStart; k < runStart + runLen; k++) {
          if ((ts[k][SPD] || 0) > 5) moving++;
        }
        if (moving / runLen < 0.7) return;
        for (let k = runStart; k < runStart + runLen; k++) stuck.add(k);
      };
      for (let i = 0; i < ts.length; i++) {
        const cur = ts[i][CURRENT];
        if (typeof cur !== "number") { flushRun(); runVal = null; runLen = 0; continue; }
        if (cur === runVal) { runLen++; }
        else { flushRun(); runVal = cur; runStart = i; runLen = 1; }
      }
      flushRun();
    }
    m.stuckCurrentSamples = stuck.size;

    if (hasPower || (hasVolt && hasCurrent)) {
      let wh = 0, drive = 0, regen = 0;
      for (let i = 1; i < ts.length; i++) {
        const dtSec = Math.max(0, ts[i][SEC] - ts[i - 1][SEC]);
        if (dtSec === 0 || dtSec > 300) continue; // gap in the log — skip
        if (stuck.has(i) || stuck.has(i - 1)) continue; // sensor frozen — discard
        const pNow = hasPower ? (ts[i][POWER] || 0) : (ts[i][VOLT] || 0) * (ts[i][CURRENT] || 0);
        const pPrev = hasPower ? (ts[i - 1][POWER] || 0) : (ts[i - 1][VOLT] || 0) * (ts[i - 1][CURRENT] || 0);
        wh += ((pNow + pPrev) / 2) * dtSec / 3600;
        const whThis = (pNow * dtSec) / 3600;
        if (pNow > 0) drive += whThis;
        else if (pNow < 0) regen += -whThis;
      }
      if (wh > 0) {
        m.energyWh = wh;
        if (m.distKm >= 1) m.whPerKm = wh / m.distKm;
      }
      if (drive > 0 || regen > 0) {
        m.driveWh = drive;
        // The motor's POWER column logs gross battery flow (V x I), which on
        // a descent includes huge brake pulses that mostly become heat in the
        // motor windings / FETs. A single trip can't physically recover more
        // than it drew, so we cap regen at the drive total. This keeps the
        // metric honest as "share of drive energy that was braked back" rather
        // than the raw integral (which can balloon past 100% on big descents).
        m.regenWh = Math.min(regen, drive);
        m.regenWhRaw = regen;
        m.regenPct = drive > 0 ? (m.regenWh / drive) * 100 : 0;
      }
    }

    // Averages over "moving" samples.
    let spdSum = 0, spdCnt = 0, curSum = 0, curCnt = 0, powSum = 0, powCnt = 0;
    for (const row of ts) {
      const s = row[SPD] || 0;
      if (s > 2) { spdSum += s; spdCnt++; }
      const c = row[CURRENT] || 0;
      if (c > 0) { curSum += c; curCnt++; }
      const p = row[POWER] || 0;
      if (p > 0) { powSum += p; powCnt++; }
    }
    if (spdCnt >= 10) m.avgMovingSpeed = spdSum / spdCnt;
    if (curCnt >= 10) m.avgCurrent = curSum / curCnt;
    if (powCnt >= 10) m.avgPower = powSum / powCnt;

    // Voltage sag %: how far the pack droops between unloaded peak and
    // loaded trough during the ride. Useful as a battery-aging proxy
    // alongside the IR delta-method.
    if (hasVolt) {
      let vMax = 0, vMin = Infinity;
      for (const row of ts) {
        const v = row[VOLT] || 0;
        if (v < 50) continue; // alive-only
        if (v > vMax) vMax = v;
        if (v < vMin) vMin = v;
      }
      if (vMax > 0 && vMin < Infinity && vMax > vMin) {
        m.voltSagPct = (vMax - vMin) / vMax * 100;
      }
    }

    // Internal-resistance proxy via the delta method: regress dV vs dI over
    // short timesteps so SoC drift across the trip cancels out (each pair only
    // spans ~1-2 seconds). Only sample pairs with a meaningful load step
    // contribute — small noise around steady cruising adds variance without
    // information. -slope is the effective IR (positive = ohms).
    if (hasVolt && hasCurrent) {
      const dXs = [], dYs = [];
      for (let i = 1; i < ts.length; i++) {
        const dt = ts[i][SEC] - ts[i - 1][SEC];
        if (dt <= 0 || dt > 3) continue;
        const v0 = ts[i - 1][VOLT] || 0, v1 = ts[i][VOLT] || 0;
        const c0 = ts[i - 1][CURRENT] || 0, c1 = ts[i][CURRENT] || 0;
        if (v0 < 10 || v1 < 10) continue;
        const dI = c1 - c0;
        if (Math.abs(dI) < 2) continue;
        dXs.push(dI);
        dYs.push(v1 - v0);
      }
      if (dXs.length >= 30) {
        const slope = lsSlope(dXs, dYs);
        // Real EUC pack IR seen at the wheel is typically 30–150 mΩ.
        // Anything > 0.2 Ω means the fit is dominated by something other
        // than true load response (noise, gear changes, etc).
        if (slope != null && slope < 0 && -slope < 0.2) m.ohmIR = -slope;
      }
    }

    // Temperatures.
    const temps = [];
    for (const row of ts) {
      const v = row[TEMP];
      if (typeof v === "number" && v !== 0) temps.push(v);
    }
    if (temps.length >= 4) {
      m.tempMax = Math.max(...temps);
      m.tempStart = median(temps.slice(0, 5));
    }

    // Anomaly detection: free spins + falls. Drives verified-max-speed and
    // gates the acceleration runs so a free-spin spike doesn't count as
    // "0 to 60 in 4 seconds." Opts read from the saved settings panel.
    const { indices: anomIdx, events: anomEvents } = detectAnomalies(ts, anomalySettings);
    m.anomalies = anomEvents;

    // Verified top speed: highest wheel speed excluding any anomaly sample.
    // Also clamp the absolute ceiling at 100 km/h (no production EUC).
    let maxV = 0;
    for (let i = 0; i < ts.length; i++) {
      if (anomIdx.has(i)) continue;
      const v = ts[i][SPD] || 0;
      if (v > maxV && v <= 100) maxV = v;
    }
    if (maxV > 0) m.topSpeedKmh = maxV;

    // Acceleration: best 0->target time per common thresholds, skipping
    // anomalies. 25 km/h is the most universally-reached, gives every
    // trip a comparable metric; 40/60 surface on the longer/faster rides.
    const a25 = bestAccelTime(ts, 25, anomIdx);
    if (a25) m.accel25 = a25.dur;
    const a40 = bestAccelTime(ts, 40, anomIdx);
    if (a40) m.accel40 = a40.dur;
    const a60 = bestAccelTime(ts, 60, anomIdx);
    if (a60) m.accel60 = a60.dur;

    // Altitude: integrate up/down deltas. Skip noisy single-sample bumps by
    // requiring at least 0.5 m change between samples.
    for (let i = 1; i < ts.length; i++) {
      const a0 = ts[i - 1][ALT], a1 = ts[i][ALT];
      if (typeof a0 !== "number" || typeof a1 !== "number") continue;
      const d = a1 - a0;
      if (Math.abs(d) < 0.5) continue;
      if (d > 0) m.climbM += d; else m.descentM += -d;
    }

    // Stationary time: speed < 1 km/h.
    for (let i = 1; i < ts.length; i++) {
      const v = ts[i][SPD] || 0;
      const dt = (ts[i][SEC] || 0) - (ts[i - 1][SEC] || 0);
      if (v < 1 && dt > 0 && dt < 30) m.stationaryS += dt;
    }

    // Max g-force (column may be 0 on older exports).
    for (const row of ts) {
      const g = row[GFORCE];
      if (typeof g === "number" && g > m.maxGForce) m.maxGForce = g;
    }

    // ---- G-force forensic profile, maneuver-aware ----
    // We don't want raw IMU peaks - a pothole spike or a pickup test reads
    // 2 G but it's noise, not a riding skill. Instead we identify *real
    // maneuvers* and only score those:
    //
    //   CORNER  - GPS heading rate above 8 °/s sustained ≥ 1 s, at >15 km/h.
    //             Lateral G here is real cornering (centripetal force the
    //             tire/rider is keeping the wheel under).
    //   BRAKE   - Negative longitudinal G ≤ -0.15 sustained ≥ 1 s, at >15 km/h.
    //   LAUNCH  - Positive longitudinal G ≥ 0.15 sustained ≥ 1 s, from <5 km/h.
    //
    // If the IMU columns are empty we estimate centripetal lateral G from
    //   a_lat = v × ω      (ω = heading rate in rad/s, v = m/s)
    // and longitudinal G from dV/dt. Both are noisier than IMU but they
    // recover useful maneuver data on GPS-only logs.
    {
      const G_LAT = 14, G_LONG = 15, G_TOTAL = GFORCE;
      let hasImuG = false;
      for (const row of ts) {
        if ((row[G_TOTAL] || 0) !== 0 || (row[G_LAT] || 0) !== 0 || (row[G_LONG] || 0) !== 0) { hasImuG = true; break; }
      }
      m.gFromImu = hasImuG;

      // 1. Compute heading per sample from GPS bearing.
      const headings = new Array(ts.length).fill(null);
      for (let i = 1; i < ts.length; i++) {
        const a = ts[i - 1], b = ts[i];
        const lat1 = a[LAT] || 0, lon1 = a[LON] || 0, lat2 = b[LAT] || 0, lon2 = b[LON] || 0;
        if (!lat1 || !lat2) continue;
        const φ1 = lat1 * Math.PI / 180, φ2 = lat2 * Math.PI / 180;
        const Δλ = (lon2 - lon1) * Math.PI / 180;
        const y = Math.sin(Δλ) * Math.cos(φ2);
        const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
        headings[i] = Math.atan2(y, x); // radians
      }
      // Heading rate (rad/s), smoothed across 3 consecutive samples.
      const headingRate = new Array(ts.length).fill(0);
      function angDiff(a, b) {
        let d = b - a;
        while (d > Math.PI) d -= 2 * Math.PI;
        while (d < -Math.PI) d += 2 * Math.PI;
        return d;
      }
      for (let i = 2; i < ts.length; i++) {
        const h0 = headings[i - 1], h1 = headings[i];
        if (h0 == null || h1 == null) continue;
        const dt = (ts[i][SEC] || 0) - (ts[i - 1][SEC] || 0);
        if (dt <= 0 || dt > 3) continue;
        headingRate[i] = angDiff(h0, h1) / dt;
      }

      // 2. Per-sample lateral / longitudinal G profile.
      const lat = new Array(ts.length).fill(0);
      const lng = new Array(ts.length).fill(0);
      for (let i = 1; i < ts.length; i++) {
        const row = ts[i];
        if (hasImuG) {
          lat[i] = Math.abs(row[G_LAT] || 0);
          lng[i] = row[G_LONG] || 0;
        } else {
          // Estimated: a_lat = v × ω,  a_long = dV/dt
          const v = (row[SPD] || 0) / 3.6;
          const ω = headingRate[i];
          if (v > 0 && ω) lat[i] = Math.abs(v * ω) / 9.81;
          const dt = (row[SEC] || 0) - (ts[i - 1][SEC] || 0);
          if (dt > 0 && dt < 5) {
            const dV = ((row[SPD] || 0) - (ts[i - 1][SPD] || 0)) / 3.6;
            lng[i] = (dV / dt) / 9.81;
          }
        }
      }

      // 3. Maneuver detection. Walk through samples flagging which are
      //    "in a corner", "in a brake", "in a launch". Then group contiguous
      //    runs of the same flag into events.
      const CORNER_RATE_THRESH = 8 * Math.PI / 180; // rad/s = 8 deg/sec
      const SPD_FAST = 15; // km/h - real riding, not walking
      const flag = new Array(ts.length).fill(0); // 0=none, 1=corner, 2=brake, 3=launch
      for (let i = 1; i < ts.length; i++) {
        if (anomIdx.has(i)) continue;
        const spd = ts[i][SPD] || 0;
        const prevSpd = ts[i - 1][SPD] || 0;
        const ω = Math.abs(headingRate[i]);
        if (spd >= SPD_FAST && ω >= CORNER_RATE_THRESH) flag[i] = 1;
        else if (spd >= SPD_FAST && lng[i] <= -0.15) flag[i] = 2;
        else if (prevSpd < 5 && lng[i] >= 0.15 && spd > prevSpd) flag[i] = 3;
      }
      // Group into events: contiguous samples of the same flag lasting ≥1 s.
      const corners = [], brakes = [], launches = [];
      let i0 = 0;
      while (i0 < ts.length) {
        const f = flag[i0];
        if (!f) { i0++; continue; }
        let i1 = i0;
        while (i1 < ts.length && flag[i1] === f) i1++;
        const dur = (ts[i1 - 1][SEC] || 0) - (ts[i0][SEC] || 0);
        if (dur >= 1) {
          // Aggregate the event
          let peakLat = 0, peakLng = 0, maxSpd = 0, sumSpd = 0;
          for (let k = i0; k < i1; k++) {
            if (lat[k] > peakLat) peakLat = lat[k];
            if (Math.abs(lng[k]) > Math.abs(peakLng)) peakLng = lng[k];
            const s = ts[k][SPD] || 0;
            if (s > maxSpd) maxSpd = s;
            sumSpd += s;
          }
          const avgSpd = sumSpd / (i1 - i0);
          const ev = { dur, avgSpd, maxSpd, peakLat, peakLng, sec: ts[i0][SEC] };
          if (f === 1) corners.push(ev);
          else if (f === 2) brakes.push(ev);
          else launches.push(ev);
        }
        i0 = i1;
      }

      // 4. Roll up to the trip-level forensic metrics. These are now
      //    maneuver-only: a one-off pothole spike no longer counts.
      function maxField(arr, key) {
        let v = 0;
        for (const e of arr) if (e[key] > v) v = e[key];
        return v;
      }
      const allEvents = corners.concat(brakes).concat(launches);
      m.gPeak = allEvents.length ? Math.max(maxField(corners, "peakLat"), maxField(brakes, "peakLng") ? -(-Math.abs(maxField(brakes, "peakLng"))) : 0, maxField(launches, "peakLng")) : null;
      // Sustained: highest |G| held for ≥1 s in a maneuver
      // (we already filter to ≥1 s, so the peak across events is "sustained")
      m.gSustained = m.gPeak;
      m.gLatPeak = maxField(corners, "peakLat") || null;
      m.gLongPeak = Math.max(
        maxField(brakes, "peakLng") ? Math.abs(maxField(brakes, "peakLng")) : 0,
        maxField(launches, "peakLng")
      ) || null;
      // Average G during maneuvers only (skill measure, not noise)
      let sumG = 0, nG = 0;
      for (const e of corners) { sumG += e.peakLat; nG++; }
      for (const e of brakes) { sumG += Math.abs(e.peakLng); nG++; }
      for (const e of launches) { sumG += e.peakLng; nG++; }
      m.gAvg = nG > 0 ? sumG / nG : null;

      // 5. Grip envelope: only sustained-cornering events. Each event
      //    contributes one dot at (avg speed during corner, peak lat G).
      m.gripScatter = corners
        .filter((c) => c.peakLat > 0.1 && c.avgSpd > SPD_FAST)
        .map((c) => [c.avgSpd, c.peakLat])
        .slice(0, 200);
      // Headline counts so the section can tell the user what we found.
      m.gforceCounts = { corners: corners.length, brakes: brakes.length, launches: launches.length };
    }

    // ---- Wheel speed vs GPS speed agreement ----
    // Compare the wheel's reported speed against the ground-truth GPS speed
    // sample-by-sample. Surfaces three things the rider/diagnostician cares about:
    //   bias   - does the wheel typically read higher or lower than GPS?
    //   spread - how far apart are they on a typical sample (mean and p90 |Δ|)?
    //   lag    - which one is leading? GPS is normally a hair behind because
    //            of the receiver's filtering. We cross-correlate ±3 samples
    //            and pick the offset that minimises mean squared error.
    {
      const diffs = [];
      let sumDt = 0, dtN = 0;
      for (let i = 0; i < ts.length; i++) {
        if (anomIdx.has(i)) continue;
        const w = ts[i][SPD] || 0, g = ts[i][GPSSPD];
        // Both must be plausibly moving so we don't compare 0 vs 0.
        if (typeof g !== "number" || g < 0.5 || w < 5) continue;
        diffs.push(w - g);
        if (Math.abs(w - g) > 5) m.gpsSpikeCount++;
        if (i > 0) {
          const dt = (ts[i][SEC] || 0) - (ts[i - 1][SEC] || 0);
          if (dt > 0 && dt < 5) { sumDt += dt; dtN++; }
        }
      }
      if (diffs.length >= 10) {
        let sum = 0, sumAbs = 0;
        for (const d of diffs) { sum += d; sumAbs += Math.abs(d); }
        m.gpsMeanDiff = sum / diffs.length;
        m.gpsMeanAbsDiff = sumAbs / diffs.length;
        const sortedAbs = diffs.map(Math.abs).sort((a, b) => a - b);
        m.gpsP90AbsDiff = sortedAbs[Math.floor(sortedAbs.length * 0.9)];
        m.gpsAgreementSamples = diffs.length;
      }
      // Lag: shift the GPS series by k samples and pick the k that lines up
      // best with the wheel speed. Positive k means GPS arrives k samples
      // *after* the wheel reading, i.e. GPS lags. Window: ±3 samples.
      //
      // Sample rate is coarse on most loggers (2-4 s), so a purely integer-k
      // result quantises every trip to either 0 or ±sample_interval. We fit
      // a parabola through the three MSE values around the integer minimum
      // to recover sub-sample precision (typical receiver lag is 0.3-1.5 s,
      // well below one sample).
      if (diffs.length >= 30 && dtN > 0) {
        const mses = [];
        for (let k = -3; k <= 3; k++) {
          let mse = 0, n = 0;
          const start = Math.max(0, -k);
          const end = ts.length - Math.max(0, k);
          for (let i = start; i < end; i++) {
            if (anomIdx.has(i)) continue;
            const w = ts[i][SPD] || 0;
            const g = ts[i + k] ? ts[i + k][GPSSPD] : null;
            if (typeof g !== "number" || g < 0.5 || w < 5) continue;
            const d = w - g; mse += d * d; n++;
          }
          mses.push({ k, mse: n >= 10 ? mse / n : Infinity });
        }
        let bestIdx = 0;
        for (let i = 1; i < mses.length; i++) if (mses[i].mse < mses[bestIdx].mse) bestIdx = i;
        let kFine = mses[bestIdx].k;
        if (bestIdx > 0 && bestIdx < mses.length - 1) {
          const y0 = mses[bestIdx - 1].mse, y1 = mses[bestIdx].mse, y2 = mses[bestIdx + 1].mse;
          const denom = y0 - 2 * y1 + y2;
          if (denom > 0 && isFinite(y0) && isFinite(y2)) {
            const offset = (y0 - y2) / (2 * denom);
            // Clamp to ±1 sample so a noisy parabola can't fling us out of range.
            kFine = mses[bestIdx].k + Math.max(-1, Math.min(1, offset));
          }
        }
        const meanDt = sumDt / dtN;
        m.gpsLagSec = kFine * meanDt;
      }
    }

    // GPS centroid rounded to 0.1° (~11 km) — coarse on purpose, both for
    // weather-cache hits and so precise locations never leave the browser.
    let latSum = 0, lonSum = 0, gpsCnt = 0;
    for (const row of ts) {
      const lat = row[LAT] || 0, lon = row[LON] || 0;
      if (lat !== 0 || lon !== 0) { latSum += lat; lonSum += lon; gpsCnt++; }
    }
    if (gpsCnt >= 3) {
      m.centroid = [Math.round((latSum / gpsCnt) * 10) / 10, Math.round((lonSum / gpsCnt) * 10) / 10];
    }
    return m;
  }

  function localDateStr(d) {
    const p = (n) => String(n).padStart(2, "0");
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
  }

  // Gated derivations that depend on the "min battery use" control.
  function applyRangeGating(m, minBattUse) {
    if (m.battDelta != null && m.battDelta >= minBattUse && m.distKm >= 2) {
      m.kmPerPct = m.distKm / m.battDelta;
      m.estRangeKm = m.kmPerPct * 100;
    } else {
      m.kmPerPct = null;
      m.estRangeKm = null;
    }
  }

  // ---------- Compute all metrics (chunked so the UI paints) ----------
  progressStrip.classList.remove("hidden");
  const tripMetrics = [];
  for (let i = 0; i < tracks.length; i++) {
    const m = computeTripMetrics(tracks[i]);
    m.tripIdx = i; // position in tracksRef so the regen card can link to inspector
    tripMetrics.push(m);
    if (i % 200 === 199) {
      progressFill.style.width = Math.round((i / tracks.length) * 100) + "%";
      await new Promise((r) => setTimeout(r, 0));
    }
  }
  progressStrip.classList.add("hidden");

  // Expose for anomaly-settings recompute (lets the panel re-flag events
  // without re-parsing the .dbb).
  tracksRef = tracks;
  metricsRef = tripMetrics;
  bindAnomSettings();

  // Analysis works oldest → newest; undated trips can't be placed on a
  // timeline, so they're dropped (counted in the subtitle).
  const dated = tripMetrics.filter((m) => m.date).sort((a, b) => a.date - b.date);
  const undatedCount = tripMetrics.length - dated.length;
  if (!dated.length) {
    showError("None of the loaded trips carry a date, so a history timeline can't be built.");
    return;
  }
  // Epoch position 0..1 for the old→new colour ramp on scatter charts.
  dated.forEach((m, i) => { m.epoch = dated.length > 1 ? i / (dated.length - 1) : 0.5; });

  // Keep the unfiltered set: the date-range slider operates by replacing
  // `dated` with a sub-slice of `datedFull`, then re-running renderAll().
  const datedFull = dated.slice();

  // Wheel groups from real identity only: metrics with the same wheel
  // key share a group, everything unattributed lands in "Generic wheel".
  // Each metric gets its group index in m.wheelGi.
  const wheelGroups = (() => {
    const byKey = new Map();
    const unknown = [];
    for (const m of datedFull) {
      if (m.wheel) {
        if (!byKey.has(m.wheel.key)) byKey.set(m.wheel.key, { key: m.wheel.key, label: m.wheel.label, members: [] });
        byKey.get(m.wheel.key).members.push(m);
      } else {
        unknown.push(m);
      }
    }
    const groups = [...byKey.values()];
    const counts = {};
    for (const g of groups) counts[g.label] = (counts[g.label] || 0) + 1;
    const seen = {};
    for (const g of groups) {
      if (counts[g.label] > 1) {
        seen[g.label] = (seen[g.label] || 0) + 1;
        g.label += " #" + seen[g.label];
      }
    }
    if (unknown.length && groups.length) groups.push({ label: "Generic wheel", members: unknown, unknown: true });
    groups.forEach((g, gi) => { for (const m of g.members) m.wheelGi = gi; });
    return groups.map((g) => ({ label: g.label, count: g.members.length, key: g.key, unknown: g.unknown }));
  })();
  const wheelScopeSel = document.getElementById("scope-wheel");
  if (wheelScopeSel && wheelGroups.length > 1) {
    document.getElementById("scope-wheel-row").classList.remove("hidden");
    wheelScopeSel.innerHTML = '<option value="-1">All wheels (' + datedFull.length + ")</option>" +
      wheelGroups.map((g, gi) => '<option value="' + gi + '">' + g.label + " (" + g.count + ")</option>").join("");
    // The viewer's Forensics button hands over its wheel-filter pick via
    // ?wheel=<key> (same key formula both sides; __unknown__ = the
    // unattributed group). Preselect it before the first render.
    const wantKey = new URLSearchParams(location.search).get("wheel");
    if (wantKey) {
      const gi = wheelGroups.findIndex((g) => wantKey === "__unknown__" ? g.unknown : g.key === wantKey);
      if (gi >= 0) wheelScopeSel.value = String(gi);
    }
  }
  const subtitleFmt = new Intl.DateTimeFormat(undefined, { month: "short", year: "numeric" });
  function refreshSubtitle() {
    let totalKm = 0;
    for (const m of dated) totalKm += m.distKm;
    const lo = dated[0] ? dated[0].date : datedFull[0].date;
    const hi = dated[dated.length - 1] ? dated[dated.length - 1].date : datedFull[datedFull.length - 1].date;
    let sub = `${dated.length} trips · ${UNITS.dist(totalKm).toFixed(0)} ${UNITS.distUnit} · ` +
              `${subtitleFmt.format(lo)} – ${subtitleFmt.format(hi)}`;
    if (dated.length < datedFull.length) sub += ` · scoped from ${datedFull.length}`;
    if (undatedCount) sub += ` · ${undatedCount} undated skipped`;
    subtitleEl.textContent = sub;
  }
  let dateRangeStart = datedFull[0].date;
  let dateRangeEnd = datedFull[datedFull.length - 1].date;
  const drSummary = document.getElementById("dr-summary");
  const drMin = document.getElementById("dr-min");
  const drMax = document.getElementById("dr-max");
  const drFill = document.getElementById("dr-fill");
  const drLo = document.getElementById("dr-lo");
  const drHi = document.getElementById("dr-hi");
  const drReset = document.getElementById("dr-reset");
  const drFmt = new Intl.DateTimeFormat(undefined, { month: "short", year: "2-digit", day: "numeric" });
  // "All wheels" over a multi-wheel library blends per-wheel physics:
  // range, efficiency, regen, motor sag, thermals and battery health only
  // mean something per wheel, so those sections carry a MIXED flag until
  // the scope narrows to one wheel.
  const MIXED_WHEEL_SECTIONS = ["range", "efficiency", "regen", "motor", "thermal", "health"];
  function updateMixedTags(wheelGi) {
    const mixed = wheelGi < 0 && wheelGroups.length > 1;
    document.querySelectorAll(".chart-section").forEach((sec) => {
      const want = mixed && MIXED_WHEEL_SECTIONS.includes(sec.dataset.section);
      let tag = sec.querySelector(".mixed-tag");
      if (want && !tag) {
        const h2 = sec.querySelector("h2");
        if (!h2) return;
        tag = document.createElement("span");
        tag.className = "forensic-tag mixed-tag";
        tag.textContent = "⚠ MIXED WHEELS";
        tag.title = "All wheels are in scope, so this metric blends different wheels (battery, motor and range differ per wheel). Pick one wheel in Scope for a clean read.";
        h2.insertBefore(tag, h2.querySelector(".sec-meta"));
      } else if (!want && tag) {
        tag.remove();
      }
    });
  }

  function applyDateRange() {
    const fullStart = datedFull[0].date.getTime();
    const fullEnd = datedFull[datedFull.length - 1].date.getTime();
    const span = Math.max(1, fullEnd - fullStart);
    const minV = Math.min(Number(drMin.value), Number(drMax.value));
    const maxV = Math.max(Number(drMin.value), Number(drMax.value));
    dateRangeStart = new Date(fullStart + (minV / 100) * span);
    dateRangeEnd = new Date(fullStart + (maxV / 100) * span);
    drFill.style.left = minV + "%";
    drFill.style.width = (maxV - minV) + "%";
    drLo.textContent = drFmt.format(dateRangeStart);
    drHi.textContent = drFmt.format(dateRangeEnd);
    const wheelGi = wheelScopeSel ? Number(wheelScopeSel.value) : -1;
    updateMixedTags(wheelGi);
    const sub = datedFull.filter((m) =>
      m.date >= dateRangeStart && m.date <= dateRangeEnd &&
      (wheelGi < 0 || m.wheelGi === wheelGi));
    dated.length = 0;
    Array.prototype.push.apply(dated, sub);
    dated.forEach((m, i) => { m.epoch = dated.length > 1 ? i / (dated.length - 1) : 0.5; });
    const all = minV === 0 && maxV === 100 && wheelGi < 0;
    drSummary.textContent = all
      ? "All trips (" + datedFull.length + ")"
      : sub.length + " of " + datedFull.length + " trips";
    if (typeof renderAll === "function") renderAll();
  }
  function debounce(fn, ms) {
    let id = null;
    return function () { clearTimeout(id); id = setTimeout(fn, ms); };
  }
  const applyDateRangeDebounced = debounce(applyDateRange, 60);
  drMin.addEventListener("input", () => {
    if (Number(drMin.value) > Number(drMax.value) - 1) drMin.value = Number(drMax.value) - 1;
    applyDateRangeDebounced();
  });
  drMax.addEventListener("input", () => {
    if (Number(drMax.value) < Number(drMin.value) + 1) drMax.value = Number(drMin.value) + 1;
    applyDateRangeDebounced();
  });
  drReset.addEventListener("click", () => {
    drMin.value = 0; drMax.value = 100;
    if (wheelScopeSel) wheelScopeSel.value = "-1";
    applyDateRange();
  });
  if (wheelScopeSel) wheelScopeSel.addEventListener("change", applyDateRange);
  // Initial visual sync (don't run renderAll yet, it isn't defined at this point)
  drFill.style.left = "0%";
  drFill.style.width = "100%";
  drLo.textContent = drFmt.format(datedFull[0].date);
  drHi.textContent = drFmt.format(datedFull[datedFull.length - 1].date);
  drSummary.textContent = "All trips (" + datedFull.length + ")";
  // A ?wheel= preselect must scope the very first render too; renderAll
  // isn't defined yet, so filter `dated` directly (the date range is
  // still full-width here).
  const initWheelGi = wheelScopeSel ? Number(wheelScopeSel.value) : -1;
  updateMixedTags(initWheelGi);
  if (initWheelGi >= 0) {
    const sub = datedFull.filter((m) => m.wheelGi === initWheelGi);
    dated.length = 0;
    Array.prototype.push.apply(dated, sub);
    dated.forEach((m, i) => { m.epoch = dated.length > 1 ? i / (dated.length - 1) : 0.5; });
    drSummary.textContent = sub.length + " of " + datedFull.length + " trips";
  }

  // Scope: a modal dialog behind a small button near the page title.
  // The button glows whenever a sub-range is active so the user can't
  // forget the analyses are scoped.
  const scopeToggle = document.getElementById("scope-toggle");
  const scopePanel = document.getElementById("date-range-panel");
  if (scopeToggle && scopePanel) {
    scopeToggle.addEventListener("click", () => {
      scopePanel.classList.remove("hidden");
    });
    scopePanel.querySelectorAll("[data-scope-close]").forEach((el) => {
      el.addEventListener("click", () => scopePanel.classList.add("hidden"));
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !scopePanel.classList.contains("hidden")) {
        scopePanel.classList.add("hidden");
      }
    });
  }
  function refreshScopeButton() {
    if (!scopeToggle) return;
    const active = dated.length !== datedFull.length;
    scopeToggle.classList.toggle("active", active);
    const span = scopeToggle.querySelector("span");
    if (span) span.textContent = active ? "Scoped (" + dated.length + ")" : "Scope";
  }

  // Print: switch to a light-on-white theme, force single-page layout so
  // every section renders, redraw every canvas with the light palette,
  // then open the browser print dialog. Pick "Save as PDF" in the dialog
  // for an exported report.
  const printBtn = document.getElementById("print-btn");
  if (printBtn) {
    printBtn.addEventListener("click", () => {
      const prevLayout = document.body.getAttribute("data-layout");
      document.body.classList.add("print-mode");
      document.body.setAttribute("data-layout", "single");
      applyChartTheme(true);
      if (typeof renderAll === "function") renderAll();
      // Let the browser re-lay and paint before the print dialog grabs
      // its snapshot; some browsers race window.print() against layout.
      setTimeout(() => {
        try { window.print(); } finally {
          document.body.classList.remove("print-mode");
          if (prevLayout) document.body.setAttribute("data-layout", prevLayout);
          applyChartTheme(false);
          if (typeof renderAll === "function") renderAll();
        }
      }, 350);
    });
  }

  // Charging events: a charge is detected when consecutive (date-sorted) trips
  // show the battery jumping back up between rides. Threshold of 5% suppresses
  // sensor noise / partial top-ups that aren't real plug-in events.
  const charges = [];
  for (let i = 1; i < dated.length; i++) {
    const prev = dated[i - 1], cur = dated[i];
    if (prev.battEnd == null || cur.battStart == null) continue;
    const gain = cur.battStart - prev.battEnd;
    if (gain < 5) continue;
    // Skip the implausible (driver was wearing a fresh pack from another wheel?)
    if (gain > 100) continue;
    charges.push({
      // The charge happened between prev and cur — attribute it to cur's date.
      date: cur.date,
      from: prev.battEnd,
      to: cur.battStart,
      gain,
    });
  }
  // Quick lookup: count charges per bin key when we render the section.

  // Subtitle now refreshes inside renderAll() so it tracks the current scope.

  // ---------- Binning ----------
  const MONTH_FMT = new Intl.DateTimeFormat(undefined, { month: "short", year: "2-digit" });
  const WEEK_FMT = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "2-digit" });
  // Monday-anchored week start; ISO style so a Sunday ride doesn't span two
  // years of labels when it sits on the Dec/Jan boundary.
  function weekStart(d) {
    const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const day = (x.getDay() + 6) % 7; // Mon=0, Sun=6
    x.setDate(x.getDate() - day);
    return x;
  }
  function weekKey(d) {
    const ws = weekStart(d);
    return ws.getFullYear() + "-W" + String(ws.getMonth()).padStart(2, "0") + "-" + String(ws.getDate()).padStart(2, "0");
  }
  function weekLabel(d) {
    return WEEK_FMT.format(weekStart(d));
  }
  function binKeyAndLabel(mode, d) {
    const y = d.getFullYear(), mo = d.getMonth();
    if (mode === "week") return { key: weekKey(d), label: weekLabel(d) };
    if (mode === "month") return { key: y + "-" + String(mo).padStart(2, "0"), label: MONTH_FMT.format(d) };
    if (mode === "quarter") { const q = Math.floor(mo / 3) + 1; return { key: y + "-Q" + q, label: "Q" + q + " '" + String(y).slice(2) }; }
    return { key: String(y), label: String(y) };
  }
  function nextCalendarKey(mode, key) {
    if (mode === "week") {
      const [y, mPart, dPart] = key.split("-W").join("-").split("-");
      const d = new Date(Number(y), Number(mPart), Number(dPart) + 7);
      return weekKey(d);
    }
    if (mode === "month") {
      let [y, m] = key.split("-").map(Number);
      m++; if (m > 11) { m = 0; y++; }
      return y + "-" + String(m).padStart(2, "0");
    }
    if (mode === "quarter") {
      let [y, q] = key.split("-Q").map(Number);
      q++; if (q > 4) { q = 1; y++; }
      return y + "-Q" + q;
    }
    return String(Number(key) + 1);
  }
  function calendarKeyToLabel(mode, key) {
    if (mode === "week") {
      const [y, mPart, dPart] = key.split("-W").join("-").split("-");
      return WEEK_FMT.format(new Date(Number(y), Number(mPart), Number(dPart)));
    }
    if (mode === "month") {
      const [y, m] = key.split("-").map(Number);
      return MONTH_FMT.format(new Date(y, m, 1));
    }
    if (mode === "quarter") {
      const [y, q] = key.split("-Q");
      return "Q" + q + " '" + String(y).slice(2);
    }
    return key;
  }

  function makeBins(metrics, mode) {
    const bins = [];
    if (mode === "week" || mode === "month" || mode === "quarter" || mode === "year") {
      const map = new Map();
      for (const m of metrics) {
        const { key, label } = binKeyAndLabel(mode, m.date);
        if (!map.has(key)) map.set(key, { key, label, trips: [] });
        map.get(key).trips.push(m);
      }
      // Contiguous calendar axis: empty periods stay visible as gaps so a
      // winter pause doesn't get visually stitched out of the trend.
      const keys = [...map.keys()].sort();
      let key = keys[0];
      const last = keys[keys.length - 1];
      let guard = 0;
      while (guard++ < 1000) {
        bins.push(map.get(key) || { key, label: calendarKeyToLabel(mode, key), trips: [] });
        if (key === last) break;
        key = nextCalendarKey(mode, key);
      }
      return bins;
    }
    // Cumulative odometer / riding-hours bins, oldest → newest.
    const byKm = mode.startsWith("km");
    const size = Number(mode.replace(/^(km|h)/, ""));
    let acc = 0, edge = size, cur = { key: "0", label: "", trips: [], from: 0 };
    const unitTotal = (m) => (byKm ? m.distKm : m.durH);
    for (const m of metrics) {
      cur.trips.push(m);
      acc += unitTotal(m);
      if (acc >= edge) {
        cur.to = acc;
        bins.push(cur);
        cur = { key: String(bins.length), label: "", trips: [], from: acc };
        while (edge <= acc) edge += size;
      }
    }
    if (cur.trips.length) { cur.to = acc; bins.push(cur); }
    for (const b of bins) {
      const from = byKm ? UNITS.dist(b.from) : b.from;
      const to = byKm ? UNITS.dist(b.to) : b.to;
      b.label = Math.round(from) + "–" + Math.round(to) + (byKm ? " " + UNITS.distUnit : " h");
    }
    return bins;
  }

  // Per-bin robust summary of one metric: distance-weighted median + IQR.
  // `minN` drops bins that don't have enough samples to be trustworthy — single
  // unusual trips otherwise create huge whipsaw spikes in the trend.
  function binStats(bins, getter, minN) {
    if (minN == null) minN = 1;
    return bins.map((b) => {
      const vals = [], weights = [];
      for (const m of b.trips) {
        const v = getter(m);
        if (v != null && isFinite(v)) { vals.push(v); weights.push(Math.max(0.1, m.distKm)); }
      }
      if (vals.length < minN) return null;
      return {
        med: weightedMedian(vals, weights),
        p25: percentile(vals, 0.25),
        p75: percentile(vals, 0.75),
        n: vals.length,
      };
    });
  }
  function rollingMedians(stats, win) {
    const half = Math.floor(win / 2);
    return stats.map((_, i) => {
      const window = [];
      for (let j = i - half; j <= i + half; j++) {
        if (stats[j] && stats[j].med != null) window.push(stats[j].med);
      }
      return window.length ? window.reduce((a, b) => a + b, 0) / window.length : null;
    });
  }

  // ---------- Weather (Open-Meteo archive, free, no key) ----------
  async function readWeatherCache(key) {
    try {
      const db = await openDb();
      if (!db) return null;
      return await new Promise((resolve) => {
        try {
          const tx = db.transaction(WEATHER_STORE_NAME, "readonly");
          const req = tx.objectStore(WEATHER_STORE_NAME).get(key);
          req.onsuccess = () => resolve(req.result || null);
          req.onerror = () => resolve(null);
        } catch { resolve(null); }
      });
    } catch { return null; }
  }
  async function writeWeatherCache(key, value) {
    try {
      const db = await openDb();
      if (!db) return;
      await new Promise((resolve) => {
        try {
          const tx = db.transaction(WEATHER_STORE_NAME, "readwrite");
          tx.objectStore(WEATHER_STORE_NAME).put(value, key);
          tx.oncomplete = resolve;
          tx.onabort = resolve;
          tx.onerror = resolve;
        } catch { resolve(); }
      });
    } catch {}
  }

  let weatherLoaded = false;

  function weatherClusters() {
    // One cluster per rounded 0.1° centroid; a single archive request spans
    // that cluster's whole date range at daily resolution.
    const map = new Map();
    for (const m of dated) {
      if (!m.centroid || !m.dateStr) continue;
      const key = m.centroid[0] + "|" + m.centroid[1];
      if (!map.has(key)) map.set(key, { key, lat: m.centroid[0], lon: m.centroid[1], dates: new Set(), trips: [] });
      const c = map.get(key);
      c.dates.add(m.dateStr);
      c.trips.push(m);
    }
    return [...map.values()];
  }

  async function fetchWeather() {
    const clusters = weatherClusters();
    if (!clusters.length) {
      weatherStatus.textContent = "No GPS data in these trips.";
      weatherStatus.className = "error";
      return;
    }
    weatherBtn.disabled = true;
    weatherStatus.className = "";
    let done = 0, failed = 0;
    for (const c of clusters) {
      weatherStatus.textContent = `Fetching ${++done}/${clusters.length}…`;
      const cached = (await readWeatherCache(c.key)) || { days: {} };
      const missing = [...c.dates].filter((d) => !(d in cached.days));
      if (missing.length) {
        missing.sort();
        // The ERA5 archive lags ~5 days; clamp so the request never 400s.
        const maxDate = localDateStr(new Date(Date.now() - 6 * 86400000));
        const start = missing[0];
        const end = missing[missing.length - 1] < maxDate ? missing[missing.length - 1] : maxDate;
        if (start <= end) {
          try {
            const url = "https://archive-api.open-meteo.com/v1/archive" +
              `?latitude=${c.lat}&longitude=${c.lon}` +
              `&start_date=${start}&end_date=${end}` +
              "&daily=temperature_2m_mean,temperature_2m_max&timezone=auto";
            const resp = await fetch(url);
            if (!resp.ok) throw new Error("HTTP " + resp.status);
            const data = await resp.json();
            const times = (data.daily && data.daily.time) || [];
            const means = (data.daily && data.daily.temperature_2m_mean) || [];
            const maxes = (data.daily && data.daily.temperature_2m_max) || [];
            for (let i = 0; i < times.length; i++) {
              if (means[i] != null) cached.days[times[i]] = { mean: means[i], max: maxes[i] != null ? maxes[i] : means[i] };
            }
            cached.fetchedAt = new Date().toISOString();
            await writeWeatherCache(c.key, cached);
          } catch (e) {
            failed++;
          }
        }
      }
      for (const m of c.trips) {
        const day = cached.days[m.dateStr];
        if (day) m.ambientC = day.mean;
      }
    }
    const withAmbient = dated.filter((m) => m.ambientC != null).length;
    if (withAmbient) {
      weatherLoaded = true;
      document.body.classList.add("weather-loaded");
    }
    updateWeatherUi(failed);
    renderAll();
  }

  // Centralised weather button + status state. Distinguishes:
  //   - covered     = trips with ambient temp already loaded
  //   - obtainable  = trips with GPS + date AND old enough for the archive
  //   - unobtainable= trips after the ~6-day ERA5 cutoff or with no GPS
  // The button only stays enabled when there are still OBTAINABLE missing
  // trips — so a recent-rides-only mismatch doesn't make the button spin
  // forever after every reload.
  // ERA5 archive lag is ~5 days; we keep a 6-day safety margin to match
  // the same cutoff fetchWeather() applies when picking the end_date.
  function archiveCutoffDate() {
    const d = new Date(Date.now() - 6 * 86400000);
    return localDateStr(d);
  }
  function updateWeatherUi(failedClusters) {
    const cutoff = archiveCutoffDate();
    let obtainable = 0, covered = 0, tooRecent = 0, noGps = 0;
    for (const m of dated) {
      if (m.ambientC != null) covered++;
      if (!m.centroid || !m.dateStr) { if (!m.centroid) noGps++; continue; }
      if (m.dateStr > cutoff) { tooRecent++; continue; }
      obtainable++;
    }
    const missingObtainable = Math.max(0, obtainable - (covered - tooRecent /* covered count may include some out-of-range, keep conservative */));
    // Cleaner missing count: count obtainable trips still lacking ambient.
    let missing = 0;
    for (const m of dated) {
      if (m.ambientC != null) continue;
      if (!m.centroid || !m.dateStr) continue;
      if (m.dateStr > cutoff) continue;
      missing++;
    }
    if (covered === 0 && missing === 0) {
      weatherBtn.textContent = "Add weather data";
      weatherBtn.disabled = noGps === dated.length;
      weatherStatus.textContent = failedClusters
        ? "Couldn't reach the weather service"
        : (tooRecent ? tooRecent + " recent trip" + (tooRecent === 1 ? "" : "s") + " not in the archive yet" : "");
      weatherStatus.className = failedClusters ? "error" : "";
      return;
    }
    if (covered === 0) {
      weatherBtn.textContent = "Add weather data";
      weatherBtn.disabled = false;
      weatherStatus.textContent = failedClusters ? "Couldn't reach the weather service" : "";
      weatherStatus.className = failedClusters ? "error" : "";
      return;
    }
    weatherStatus.className = failedClusters ? "error" : "ok";
    // Show / hide the refresh segment based on whether there are recent
    // trips that could land in the archive on a later attempt.
    document.body.classList.toggle("weather-has-pending", tooRecent > 0);
    const refreshBtn = document.getElementById("weather-refresh-btn");
    if (refreshBtn) {
      refreshBtn.title = tooRecent
        ? tooRecent + " trip" + (tooRecent === 1 ? "" : "s") + " from the last few days isn't in the archive yet. Open-Meteo's historical data lags about 5 days. Click to try again."
        : "";
    }
    function setWeatherStatus(mainText, extras) {
      weatherStatus.textContent = "";
      if (mainText) weatherStatus.appendChild(document.createTextNode(mainText));
      if (extras && extras.length) {
        const icon = document.createElement("span");
        icon.className = "info-icon";
        icon.title = extras.join("\n");
        icon.textContent = "i";
        if (mainText) weatherStatus.appendChild(document.createTextNode(" "));
        weatherStatus.appendChild(icon);
      }
    }
    if (missing > 0) {
      weatherBtn.textContent = "Add weather for " + missing + " more";
      weatherBtn.disabled = false;
      const extras = [];
      if (tooRecent) extras.push(tooRecent + " from the last few days — Open-Meteo archive lags ~5 days");
      if (noGps) extras.push(noGps + " without GPS");
      if (failedClusters) extras.push(failedClusters + " location" + (failedClusters > 1 ? "s" : "") + " failed to fetch");
      setWeatherStatus(covered + " of " + dated.length + " trips ready", extras);
    } else {
      weatherBtn.textContent = "Weather added · " + covered + " of " + dated.length + " trips";
      weatherBtn.disabled = true;
      const extras = [];
      if (tooRecent) extras.push(tooRecent + " from the last few days — Open-Meteo archive lags ~5 days");
      if (noGps) extras.push(noGps + " without GPS");
      setWeatherStatus("", extras);
    }
  }
  weatherBtn.addEventListener("click", fetchWeather);

  // "Remove weather" - keeps the IDB cache (so re-adding is instant) but
  // clears the in-memory ambient temps and turns off the body class so every
  // weather-dependent analysis falls back to its no-weather state.
  const weatherRemoveBtn = document.getElementById("weather-remove-btn");
  if (weatherRemoveBtn) {
    weatherRemoveBtn.addEventListener("click", () => {
      for (const m of dated) m.ambientC = null;
      weatherLoaded = false;
      document.body.classList.remove("weather-loaded");
      updateWeatherUi(0);
      renderAll();
    });
  }
  // "Refresh" - re-runs the fetch so any trips that have aged past the
  // ERA5 cutoff since the previous attempt finally pick up their weather.
  const weatherRefreshBtn = document.getElementById("weather-refresh-btn");
  if (weatherRefreshBtn) {
    weatherRefreshBtn.addEventListener("click", fetchWeather);
  }

  // ---------- Chart drawing ----------
  const COLORS = {
    range: "#69f0ae",
    rangeNorm: "#fff176",
    whPerKm: "#7c4dff",
    kmPerPct: "#00e5ff",
    ampsPerKmh: "#ffd740",
    tempRise: "#ffa000",
    ohmIR: "#ff5252",
    rolling: "#ffffff",
  };
  // Dynamic theme: the canvases use these resolved colors. When the user
  // enters print mode we swap them for a dark-on-white palette so axis
  // labels and grid lines stay readable on paper.
  const FONT = "10px -apple-system, sans-serif";
  let AXIS_COLOR = "rgba(255,255,255,0.35)";
  let GRID_COLOR = "rgba(255,255,255,0.06)";
  let GRID_MINOR_COLOR = "rgba(255,255,255,0.025)";
  let CHART_BG = null; // null = leave canvas transparent (dark theme); set to "white" in print mode
  function applyChartTheme(printing) {
    if (printing) {
      AXIS_COLOR = "rgba(0,0,0,0.6)";
      GRID_COLOR = "rgba(0,0,0,0.10)";
      GRID_MINOR_COLOR = "rgba(0,0,0,0.045)";
      CHART_BG = "#ffffff";
    } else {
      AXIS_COLOR = "rgba(255,255,255,0.35)";
      GRID_COLOR = "rgba(255,255,255,0.06)";
      GRID_MINOR_COLOR = "rgba(255,255,255,0.025)";
      CHART_BG = null;
    }
  }

  const tooltip = document.createElement("div");
  tooltip.id = "an-tooltip";
  tooltip.style.display = "none";
  document.body.appendChild(tooltip);
  function showTooltip(html, x, y) {
    tooltip.innerHTML = html;
    tooltip.style.display = "block";
    const w = tooltip.offsetWidth, h = tooltip.offsetHeight, m = 8;
    let left = x + 14, top = y - 10;
    if (left + w + m > window.innerWidth) left = x - w - 14;
    if (top + h + m > window.innerHeight) top = window.innerHeight - h - m;
    if (top < m) top = m;
    tooltip.style.left = left + "px";
    tooltip.style.top = top + "px";
  }
  function hideTooltip() { tooltip.style.display = "none"; }

  function setupCanvas(canvas) {
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    const ctx = canvas.getContext("2d");
    ctx.scale(dpr, dpr);
    if (CHART_BG) {
      ctx.fillStyle = CHART_BG;
      ctx.fillRect(0, 0, rect.width, rect.height);
    }
    return { ctx, w: rect.width, h: rect.height };
  }

  function niceTicks(min, max, count) {
    const span = max - min || 1;
    const step0 = span / count;
    const mag = Math.pow(10, Math.floor(Math.log10(step0)));
    let step = mag;
    for (const k of [1, 2, 2.5, 5, 10]) {
      if (mag * k >= step0) { step = mag * k; break; }
    }
    const ticks = [];
    for (let v = Math.ceil(min / step) * step; v <= max + step * 0.001; v += step) ticks.push(v);
    return ticks;
  }

  function fmtVal(v, dp) {
    if (v == null || !isFinite(v)) return "—";
    if (dp != null) return v.toFixed(dp);
    const a = Math.abs(v);
    return v.toFixed(a >= 100 ? 0 : a >= 10 ? 1 : 2);
  }

  // Map an ambient temperature (°C) to a blue→green→red gradient color used
  // as the per-bin background fill on the range chart. Cold = blue, hot = red.
  // The opacity is the same across the range so the bars stay subtle.
  function tempBandColor(c) {
    // Cold -10°C, comfortable 20°C, hot 35°C
    const t = Math.max(0, Math.min(1, (c - -10) / 45));
    // 3-stop ramp: cyan -> green -> orange
    let r, g, b;
    if (t < 0.5) {
      const k = t / 0.5;
      r = Math.round(50  * (1 - k) + 80  * k);
      g = Math.round(180 * (1 - k) + 220 * k);
      b = Math.round(220 * (1 - k) + 110 * k);
    } else {
      const k = (t - 0.5) / 0.5;
      r = Math.round(80  * (1 - k) + 240 * k);
      g = Math.round(220 * (1 - k) + 110 * k);
      b = Math.round(110 * (1 - k) + 40  * k);
    }
    return [r, g, b];
  }

  // Trend chart over bins: each series is {stats, color, label, unit, band}.
  // `rolling` adds a white moving-average overlay per series.
  // Legend chips. Wide canvases fit one row at the very top, left of the
  // title; on narrow canvases the (wrapped) HTML title spans the whole
  // width, so the entries stack below it inside the reserved band. The
  // caller must size pad.top with legendPadTop() so the rows fit.
  function legendPadTop(w, count) {
    return w < 480 ? 48 + count * 13 : 42;
  }
  function drawLegend(ctx, w, padTop, padLeft, items) {
    ctx.font = FONT;
    ctx.textBaseline = "alphabetic";
    ctx.textAlign = "left";
    if (w >= 480) {
      let lx = padLeft + 4;
      for (const it of items) {
        ctx.fillStyle = it.color;
        ctx.fillRect(lx, 6, 8, 3);
        ctx.fillStyle = "rgba(255,255,255,0.6)";
        ctx.fillText(it.label, lx + 12, 11);
        lx += 12 + ctx.measureText(it.label).width + 16;
      }
    } else {
      let y = padTop - 8 - (items.length - 1) * 13;
      for (const it of items) {
        ctx.fillStyle = it.color;
        ctx.fillRect(padLeft + 4, y - 5, 8, 3);
        ctx.fillStyle = "rgba(255,255,255,0.6)";
        ctx.fillText(it.label, padLeft + 16, y);
        y += 13;
      }
    }
  }

  function drawTrendChart(canvas, bins, series, opts = {}) {
    const cv = setupCanvas(canvas);
    if (!cv) return;
    const { ctx, w, h } = cv;
    // top: 42 leaves a clear band under the HTML chart-title overlay
    // (title + italic axes hint, ~36 px tall) so data lines never sit
    // behind the heading text; narrow canvases add room for stacked
    // legend rows. Same logic on every chart below.
    const pad = { top: legendPadTop(w, series.length), bottom: 22, left: 44, right: series.length > 1 ? 44 : 14 };
    const cw = w - pad.left - pad.right;
    const ch = h - pad.top - pad.bottom;
    const n = bins.length;
    const xAt = (i) => pad.left + (n > 1 ? (i / (n - 1)) * cw : cw / 2);

    // Each series gets its own y-scale (left axis = first, right = second).
    const scales = series.map((s) => {
      let min = Infinity, max = -Infinity;
      for (const st of s.stats) {
        if (!st) continue;
        const lo = s.band && st.p25 != null ? st.p25 : st.med;
        const hi = s.band && st.p75 != null ? st.p75 : st.med;
        if (lo < min) min = lo;
        if (hi > max) max = hi;
      }
      if (s.extra) {
        for (const v of s.extra) {
          if (v == null) continue;
          if (v < min) min = v;
          if (v > max) max = v;
        }
      }
      if (!isFinite(min)) return null;
      const span = max - min || Math.abs(max) || 1;
      min -= span * 0.12; max += span * 0.12;
      if (opts.zeroBase && min > 0) min = 0;
      return { min, max };
    });

    ctx.font = FONT;

    // Optional weather gradient strip painted *behind* the chart contents:
    // each bin's plot column gets a translucent fill in a blue→red ramp
    // based on the mean ambient temperature of trips in that bin. Lets
    // the user see seasons at a glance.
    if (opts.weatherGradient) {
      const colW = cw / Math.max(1, n);
      for (let i = 0; i < n; i++) {
        const trips = bins[i].trips || [];
        let temps = 0, tn = 0;
        for (const m of trips) if (m.ambientC != null) { temps += m.ambientC; tn++; }
        if (!tn) continue;
        const [r, g, b] = tempBandColor(temps / tn);
        ctx.fillStyle = "rgba(" + r + "," + g + "," + b + ",0.10)";
        ctx.fillRect(pad.left + i * colW, pad.top, colW, ch);
      }
    }

    // Grid + left axis labels off the first series' scale.
    const s0 = scales.find((s) => s);
    if (s0) {
      const ticks = niceTicks(s0.min, s0.max, 4);
      const minorTicks = niceTicks(s0.min, s0.max, 16);
      ctx.fillStyle = AXIS_COLOR;
      const majorSet = new Set(ticks.map((v) => v.toFixed(6)));
      // Minor gridlines first (so major lines paint on top).
      ctx.strokeStyle = GRID_MINOR_COLOR;
      for (const tv of minorTicks) {
        if (majorSet.has(tv.toFixed(6))) continue;
        const y = pad.top + ch - ((tv - s0.min) / (s0.max - s0.min)) * ch;
        ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(w - pad.right, y); ctx.stroke();
      }
      ctx.strokeStyle = GRID_COLOR;
      ctx.textAlign = "right";
      ctx.textBaseline = "middle";
      const i0 = scales.indexOf(s0);
      for (const tv of ticks) {
        const y = pad.top + ch - ((tv - s0.min) / (s0.max - s0.min)) * ch;
        ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(w - pad.right, y); ctx.stroke();
        ctx.fillStyle = series[i0].color;
        ctx.fillText(fmtVal(tv), pad.left - 6, y);
      }
      // Right axis for a second scaled series.
      if (scales.length > 1 && scales[1] && scales[1] !== s0) {
        const t2 = niceTicks(scales[1].min, scales[1].max, 4);
        ctx.textAlign = "left";
        ctx.fillStyle = series[1].color;
        for (const tv of t2) {
          const y = pad.top + ch - ((tv - scales[1].min) / (scales[1].max - scales[1].min)) * ch;
          ctx.fillText(fmtVal(tv), w - pad.right + 6, y);
        }
      }
    }

    // X labels — thin to at most ~8.
    ctx.fillStyle = AXIS_COLOR;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    const labelStep = Math.max(1, Math.ceil(n / 8));
    for (let i = 0; i < n; i += labelStep) {
      ctx.fillText(bins[i].label, xAt(i), pad.top + ch + 6);
    }

    series.forEach((s, si) => {
      const sc = scales[si];
      if (!sc) return;
      const yAt = (v) => pad.top + ch - ((v - sc.min) / (sc.max - sc.min)) * ch;

      // IQR band.
      if (s.band) {
        ctx.beginPath();
        let started = false;
        for (let i = 0; i < n; i++) {
          const st = s.stats[i];
          if (!st || st.p25 == null) { started = false; continue; }
          const x = xAt(i), y = yAt(st.p75);
          if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
        }
        for (let i = n - 1; i >= 0; i--) {
          const st = s.stats[i];
          if (!st || st.p25 == null) continue;
          ctx.lineTo(xAt(i), yAt(st.p25));
        }
        ctx.closePath();
        ctx.fillStyle = s.color + "22";
        ctx.fill();
      }

      // Median line (broken across empty bins) + dots.
      ctx.strokeStyle = s.color;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      let started = false;
      for (let i = 0; i < n; i++) {
        const st = s.stats[i];
        if (!st || st.med == null) { started = false; continue; }
        const x = xAt(i), y = yAt(st.med);
        if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
      }
      ctx.stroke();
      ctx.fillStyle = s.color;
      for (let i = 0; i < n; i++) {
        const st = s.stats[i];
        if (!st || st.med == null) continue;
        ctx.beginPath();
        ctx.arc(xAt(i), yAt(st.med), 2.5, 0, Math.PI * 2);
        ctx.fill();
      }

      if (opts.rolling) {
        const roll = rollingMedians(s.stats, 3);
        ctx.strokeStyle = COLORS.rolling;
        ctx.globalAlpha = 0.65;
        ctx.lineWidth = 1.2;
        ctx.setLineDash([5, 3]);
        ctx.beginPath();
        started = false;
        for (let i = 0; i < n; i++) {
          if (roll[i] == null) { started = false; continue; }
          const x = xAt(i), y = yAt(roll[i]);
          if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
        }
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
      }
    });

    // Legend.
    drawLegend(ctx, w, pad.top, pad.left, series.map((s) => ({ color: s.color, label: s.label })));

    canvas._an = { type: "trend", bins, series, pad, cw, ch, w, h, xAt };
  }

  // Scatter: points {x, y, epoch, meta}; old→new colour ramp.
  function epochColor(t) {
    const r = Math.round(70 + (255 - 70) * t);
    const g = Math.round(130 + (90 - 130) * t);
    const b = Math.round(255 + (70 - 255) * t);
    return `rgb(${r},${g},${b})`;
  }
  function drawScatter(canvas, pts, opts) {
    const cv = setupCanvas(canvas);
    if (!cv) return;
    const { ctx, w, h } = cv;
    // Narrow canvases: the HTML title wraps onto two lines, so reserve a
    // taller band before the plot begins.
    const pad = { top: w < 480 ? 58 : 42, bottom: 26, left: 44, right: 14 };
    const cw = w - pad.left - pad.right;
    const ch = h - pad.top - pad.bottom;
    let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
    for (const p of pts) {
      if (p.x < xMin) xMin = p.x;
      if (p.x > xMax) xMax = p.x;
      if (p.y < yMin) yMin = p.y;
      if (p.y > yMax) yMax = p.y;
    }
    const xSpan = (xMax - xMin) || 1, ySpan = (yMax - yMin) || 1;
    xMin -= xSpan * 0.06; xMax += xSpan * 0.06;
    yMin -= ySpan * 0.1; yMax += ySpan * 0.1;
    const xAt = (v) => pad.left + ((v - xMin) / (xMax - xMin)) * cw;
    const yAt = (v) => pad.top + ch - ((v - yMin) / (yMax - yMin)) * ch;
    // Expose the transform so other code can overlay fit lines / annotations.
    canvas._scatterMap = { xAt, yAt, xMin, xMax, yMin, yMax };

    ctx.font = FONT;
    ctx.fillStyle = AXIS_COLOR;
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    // Minor (faint) gridlines first, then major over the top.
    const yMajor = niceTicks(yMin, yMax, 4);
    const yMinor = niceTicks(yMin, yMax, 16);
    const yMajorSet = new Set(yMajor.map((v) => v.toFixed(6)));
    ctx.strokeStyle = GRID_MINOR_COLOR;
    for (const tv of yMinor) {
      if (yMajorSet.has(tv.toFixed(6))) continue;
      const y = yAt(tv);
      ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(w - pad.right, y); ctx.stroke();
    }
    ctx.strokeStyle = GRID_COLOR;
    for (const tv of yMajor) {
      const y = yAt(tv);
      ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(w - pad.right, y); ctx.stroke();
      ctx.fillText(fmtVal(tv), pad.left - 6, y);
    }
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    const xMajor = niceTicks(xMin, xMax, 6);
    const xMinor = niceTicks(xMin, xMax, 24);
    const xMajorSet = new Set(xMajor.map((v) => v.toFixed(6)));
    ctx.strokeStyle = GRID_MINOR_COLOR;
    for (const tv of xMinor) {
      if (xMajorSet.has(tv.toFixed(6))) continue;
      const x = xAt(tv);
      ctx.beginPath(); ctx.moveTo(x, pad.top); ctx.lineTo(x, pad.top + ch); ctx.stroke();
    }
    ctx.strokeStyle = GRID_COLOR;
    // The x-axis title sits on the same line at the right edge — skip tick
    // labels that would collide with it.
    const xTitleW = ctx.measureText(opts.xLabel).width;
    for (const tv of xMajor) {
      const x = xAt(tv);
      ctx.beginPath(); ctx.moveTo(x, pad.top); ctx.lineTo(x, pad.top + ch); ctx.stroke();
      if (x < w - pad.right - xTitleW - 16) ctx.fillText(fmtVal(tv), x, pad.top + ch + 6);
    }
    // Axis titles.
    ctx.fillStyle = "rgba(255,255,255,0.55)";
    ctx.textAlign = "left";
    ctx.fillText(opts.yLabel, pad.left + 4, 2);
    ctx.textAlign = "right";
    ctx.fillText(opts.xLabel, w - pad.right, pad.top + ch + 6);

    const drawn = [];
    for (const p of pts) {
      const x = xAt(p.x), y = yAt(p.y);
      ctx.fillStyle = epochColor(p.epoch);
      ctx.globalAlpha = 0.82;
      ctx.beginPath();
      ctx.arc(x, y, 4.6, 0, Math.PI * 2);
      ctx.fill();
      // Outline for better contrast on busy scatters
      ctx.globalAlpha = 0.55;
      ctx.strokeStyle = "rgba(0,0,0,0.4)";
      ctx.lineWidth = 0.8;
      ctx.stroke();
      drawn.push({ x, y, p });
    }
    ctx.globalAlpha = 1;

    // Old→new ramp legend: right-aligned so "new" ends inside the canvas,
    // sitting just above the plot (below the HTML title band) instead of
    // at the very top where the title used to overlap and clip it.
    ctx.font = FONT;
    const newW = ctx.measureText("new").width;
    const lw = 60, lx = w - pad.right - newW - 6 - lw, ly = pad.top - 12;
    for (let i = 0; i < lw; i++) {
      ctx.fillStyle = epochColor(i / lw);
      ctx.fillRect(lx + i, ly, 1, 4);
    }
    ctx.fillStyle = "rgba(255,255,255,0.55)";
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    ctx.fillText("old", lx - 4, ly + 2);
    ctx.textAlign = "left";
    ctx.fillText("new", lx + lw + 4, ly + 2);

    canvas._an = { type: "scatter", drawn, opts };
  }

  // Ensure every chart-host gets a single crosshair overlay element.
  function ensureCrosshair(host) {
    let ch = host.querySelector(".chart-crosshair");
    if (!ch) {
      ch = document.createElement("div");
      ch.className = "chart-crosshair";
      host.appendChild(ch);
    }
    return ch;
  }
  function hideAllCrosshairs() {
    document.querySelectorAll(".chart-crosshair").forEach((el) => (el.style.display = "none"));
  }
  // Position the crosshair on every trend chart at the given bin index, so
  // the user can read across all time-series at once.
  function syncCrosshair(binIdx) {
    document.querySelectorAll("canvas").forEach((cv) => {
      const an = cv._an;
      if (!an || an.type !== "trend") return;
      const host = cv.parentElement;
      if (!host) return;
      const ch = ensureCrosshair(host);
      if (binIdx == null || binIdx < 0 || binIdx >= an.bins.length) { ch.style.display = "none"; return; }
      // an.xAt is in CSS pixels relative to the canvas, and canvas fills
      // the host, so the chart-host-relative x is the same value.
      const x = an.xAt(binIdx);
      ch.style.display = "block";
      ch.style.left = Math.round(x) + "px";
    });
  }

  // One delegated hover handler for all charts.
  document.addEventListener("mousemove", (e) => {
    const canvas = e.target.closest && e.target.closest("canvas");
    if (!canvas || !canvas._an) { hideTooltip(); hideAllCrosshairs(); return; }
    const an = canvas._an;
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    if (an.type === "trend") {
      const n = an.bins.length;
      let best = -1, bestD = Infinity;
      for (let i = 0; i < n; i++) {
        const d = Math.abs(an.xAt(i) - mx);
        if (d < bestD) { bestD = d; best = i; }
      }
      if (best < 0 || bestD > 40) { hideTooltip(); hideAllCrosshairs(); return; }
      syncCrosshair(best);
      const bin = an.bins[best];
      const totalKmIn = bin.trips.reduce((s, m) => s + (m.distKm || 0), 0);
      let html = `<b>${bin.label}</b> · ${bin.trips.length} trip${bin.trips.length === 1 ? "" : "s"}`;
      if (totalKmIn > 0) html += ` · ${UNITS.dist(totalKmIn).toFixed(0)} ${UNITS.distUnit}`;
      for (const s of an.series) {
        const st = s.stats[best];
        if (!st || st.med == null) continue;
        html += `<br>${s.label}: <b>${fmtVal(st.med, s.dp)}</b> ${s.unit || ""}`;
        if (s.band && st.p25 != null) html += ` <span style="color:#888">(IQR ${fmtVal(st.p25, s.dp)}–${fmtVal(st.p75, s.dp)})</span>`;
        if (st.n != null) html += ` <span style="color:#666">n=${st.n}</span>`;
      }
      showTooltip(html, e.clientX, e.clientY);
    } else if (an.type === "hist") {
      hideAllCrosshairs();
      const idx = an.xToBin(mx);
      if (idx < 0 || idx >= an.bins.length) { hideTooltip(); return; }
      const b = an.bins[idx];
      if (b.count === 0) { hideTooltip(); return; }
      // Range readout uses the unit baked in by the histogram caller.
      const html = `<b>${fmtVal(b.from)}</b>–<b>${fmtVal(b.to)}</b> ${an.unit || ""}<br>` +
                   `<b>${b.count}</b> trip${b.count === 1 ? "" : "s"}`;
      showTooltip(html, e.clientX, e.clientY);
    } else if (an.type === "bars") {
      hideAllCrosshairs();
      const idx = an.xToBin(mx);
      const b = idx >= 0 && idx < an.bins.length ? an.bins[idx] : null;
      if (!b || !b.html) { hideTooltip(); return; }
      showTooltip(b.html, e.clientX, e.clientY);
    } else if (an.type === "hbars") {
      hideAllCrosshairs();
      const idx = an.yToBin(my);
      const b = idx >= 0 && idx < an.bins.length ? an.bins[idx] : null;
      if (!b || !b.html) { hideTooltip(); return; }
      showTooltip(b.html, e.clientX, e.clientY);
    } else {
      hideAllCrosshairs();
      let best = null, bestD = Infinity;
      for (const d of an.drawn) {
        const dx = d.x - mx, dy = d.y - my;
        const dist = dx * dx + dy * dy;
        if (dist < bestD) { bestD = dist; best = d; }
      }
      if (!best || bestD > 18 * 18) { hideTooltip(); return; }
      showTooltip(best.p.meta, e.clientX, e.clientY);
    }
  });
  document.addEventListener("mouseleave", () => { hideTooltip(); hideAllCrosshairs(); }, true);

  // ---------- Sections ----------
  function sectionEl(name) { return document.querySelector(`.chart-section[data-section="${name}"]`); }
  function setSectionEmpty(name, msg) {
    const sec = sectionEl(name);
    sec.classList.add("no-data");
    let note = sec.querySelector(".no-data-msg");
    if (!note) {
      note = document.createElement("div");
      note.className = "no-data-msg";
      sec.querySelector("h2").after(note);
    }
    note.textContent = msg;
  }
  function setSectionActive(name) {
    const sec = sectionEl(name);
    sec.classList.remove("no-data");
    const note = sec.querySelector(".no-data-msg");
    if (note) note.remove();
  }

  // Theil–Sen range-vs-ambient fit, recomputed whenever weather lands.
  let tempFit = null;
  // Range vs avg ride speed: cruising at 20 km/h is a totally different
  // load on the pack than pushing 40+ km/h. The slope tells you how many
  // km of range you lose per 1 km/h faster you ride on average.
  let speedFit = null;
  // Range vs climb per km: hilly trips drain the pack faster. The slope
  // tells you how many km of range you lose per meter of climbing per km.
  let climbFit = null;
  function computeTempFit() {
    const xs = [], ys = [];
    for (const m of dated) {
      if (m.estRangeKm != null && m.ambientC != null) { xs.push(m.ambientC); ys.push(m.estRangeKm); }
    }
    tempFit = xs.length >= 10 ? theilSen(xs, ys) : null;
    normalizeCheck.disabled = !tempFit;
    if (!tempFit) normalizeCheck.checked = false;
  }
  function computeSpeedFit() {
    const xs = [], ys = [];
    for (const m of dated) {
      if (m.estRangeKm != null && m.avgMovingSpeed != null && m.avgMovingSpeed > 5) {
        xs.push(m.avgMovingSpeed); ys.push(m.estRangeKm);
      }
    }
    speedFit = xs.length >= 10 ? theilSen(xs, ys) : null;
  }
  function computeClimbFit() {
    const xs = [], ys = [];
    for (const m of dated) {
      if (m.estRangeKm != null && m.distKm >= 2 && m.climbM != null && m.climbM >= 0) {
        xs.push(m.climbM / m.distKm); ys.push(m.estRangeKm);
      }
    }
    climbFit = xs.length >= 10 ? theilSen(xs, ys) : null;
  }

  // Multivariate fit: range as a function of avg speed, ambient temp, and
  // climb rate, all at once. The univariate slopes above are confounded
  // (faster trips tend to be longer cruise rides which also have higher
  // estimated range). The multivariate slopes isolate each effect.
  // Falls back to univariate fits for headlines when the multivariate
  // fit isn't available (need all three features per trip + n ≥ 20).
  let multiFit = null;
  function computeMultiFit() {
    const X = [], y = [];
    const speeds = [], temps = [], climbs = [];
    for (const m of dated) {
      if (m.estRangeKm == null) continue;
      if (m.avgMovingSpeed == null || m.avgMovingSpeed <= 5) continue;
      if (m.ambientC == null) continue;
      if (m.climbM == null || m.distKm < 2) continue;
      const climbPerKm = m.climbM / m.distKm;
      if (climbPerKm < 0) continue;
      X.push([1, m.avgMovingSpeed, m.ambientC, climbPerKm]);
      y.push(m.estRangeKm);
      speeds.push(m.avgMovingSpeed);
      temps.push(m.ambientC);
      climbs.push(climbPerKm);
    }
    if (X.length < 20) { multiFit = null; return; }
    const fit = multipleLinearRegression(X, y);
    if (!fit) { multiFit = null; return; }
    multiFit = {
      intercept: fit.beta[0],
      speedSlope: fit.beta[1],   // km of range per km/h
      tempSlope:  fit.beta[2],   // km of range per °C
      climbSlope: fit.beta[3],   // km of range per (m climbed / km ridden)
      n: fit.n,
      r2: fit.r2,
      rss: fit.rss,
      ssTot: fit.ssTot,
      medSpeedKmh: median(speeds),
      medTempC:    median(temps),
      medClimbMperKm: median(climbs),
      // Envelope of trip-average speeds the fit actually saw. Outside it
      // the linear speed term is extrapolation; the hybrid model in
      // calcRangeKm switches to the in-ride cost curve there.
      sLoKmh: percentile(speeds, 0.05),
      sHiKmh: percentile(speeds, 0.95),
    };
  }

  function normalizedRange(m) {
    if (m.estRangeKm == null) return null;
    if (!normalizeCheck.checked || !tempFit || m.ambientC == null) return m.estRangeKm;
    return m.estRangeKm + tempFit.slope * (20 - m.ambientC);
  }

  // ---------- What-if range calculator ----------
  // Three sliders drive a live prediction from `multiFit` (the multivariate
  // OLS). Sliders are calibrated in the user's unit system; values are
  // converted back to internal km/h, °C, m/km before plugging into the
  // model. Hidden when there's no fit (too few usable trips).
  const whatIfEls = {
    panel:   document.getElementById("range-whatif"),
    speed:   document.getElementById("rw-speed"),
    temp:    document.getElementById("rw-temp"),
    climb:   document.getElementById("rw-climb"),
    speedO:  document.getElementById("rw-speed-out"),
    tempO:   document.getElementById("rw-temp-out"),
    climbO:  document.getElementById("rw-climb-out"),
    result:  document.getElementById("rw-result"),
  };
  let whatIfInit = false;
  function whatIfPredKm() {
    if (!multiFit) return null;
    const sKmh = Number(whatIfEls.speed.dataset.km);
    const tC = Number(whatIfEls.temp.dataset.c);
    const cMperKm = Number(whatIfEls.climb.dataset.mperkm);
    if (!isFinite(sKmh) || !isFinite(tC) || !isFinite(cMperKm)) return null;
    return calcRangeKm(sKmh, tC, cMperKm);
  }
  function fmtSpeedOut(kmh) {
    return `${UNITS.speed(kmh).toFixed(0)} ${UNITS.speedUnit}`;
  }
  function fmtTempOut(c) {
    const v = UNITS.temp(c);
    return `${v >= 0 ? "" : ""}${v.toFixed(0)} ${UNITS.tempUnit}`;
  }
  function fmtClimbOut(mPerKm) {
    if (UNITS.imperial) return `${(mPerKm * 5.2808).toFixed(0)} ft/mi`;
    return `${mPerKm.toFixed(0)} m/km`;
  }
  function refreshWhatIf() {
    const r = whatIfPredKm();
    if (r == null || !isFinite(r)) {
      whatIfEls.result.innerHTML = "&mdash;";
      return;
    }
    const v = UNITS.dist(r);
    whatIfEls.result.innerHTML = `${v.toFixed(1)}<small>${UNITS.distUnit}</small>`;
  }
  function bindWhatIf() {
    const onSpeed = () => {
      const display = Number(whatIfEls.speed.value);
      // Slider stores user-units; convert to km/h internal.
      const km = UNITS.imperial ? display / 0.621371 : display;
      whatIfEls.speed.dataset.km = km.toFixed(2);
      whatIfEls.speedO.value = `${display} ${UNITS.speedUnit}`;
      refreshWhatIf();
    };
    const onTemp = () => {
      const display = Number(whatIfEls.temp.value);
      const c = UNITS.imperial ? (display - 32) * 5 / 9 : display;
      whatIfEls.temp.dataset.c = c.toFixed(2);
      whatIfEls.tempO.value = `${display} ${UNITS.tempUnit}`;
      refreshWhatIf();
    };
    const onClimb = () => {
      const display = Number(whatIfEls.climb.value);
      const mPerKm = UNITS.imperial ? display / 5.2808 : display;
      whatIfEls.climb.dataset.mperkm = mPerKm.toFixed(3);
      whatIfEls.climbO.value = UNITS.imperial ? `${display} ft/mi` : `${display} m/km`;
      refreshWhatIf();
    };
    whatIfEls.speed.addEventListener("input", onSpeed);
    whatIfEls.temp.addEventListener("input", onTemp);
    whatIfEls.climb.addEventListener("input", onClimb);
    whatIfEls._onSpeed = onSpeed;
    whatIfEls._onTemp = onTemp;
    whatIfEls._onClimb = onClimb;
  }
  function updateWhatIf() {
    if (!whatIfEls.panel) return;
    if (!multiFit) { whatIfEls.panel.classList.add("hidden"); return; }
    whatIfEls.panel.classList.remove("hidden");
    if (!whatIfInit) { bindWhatIf(); whatIfInit = true; }
    // Calibrate slider ranges + defaults to the user's data + units.
    const speeds = dated.filter((m) => m.avgMovingSpeed != null).map((m) => m.avgMovingSpeed);
    const temps  = dated.filter((m) => m.ambientC != null).map((m) => m.ambientC);
    const climbs = dated.filter((m) => m.climbM != null && m.distKm >= 2).map((m) => m.climbM / m.distKm);
    const medS = speeds.length ? median(speeds) : 25;
    const medT = temps.length  ? median(temps)  : 20;
    const medC = climbs.length ? median(climbs) : 0;
    // Range bounds widen 30% beyond data range, clamped to physical limits.
    const sMin = 10, sMax = 55; // km/h sensible bounds
    const tMin = -15, tMax = 40; // °C
    const cMin = 0, cMax = 40;   // m/km
    const sDispMin = Math.round(UNITS.speed(sMin));
    const sDispMax = Math.round(UNITS.speed(sMax));
    const tDispMin = Math.round(UNITS.temp(tMin));
    const tDispMax = Math.round(UNITS.temp(tMax));
    const cDispMax = UNITS.imperial ? Math.round(cMax * 5.2808) : cMax;
    const sDispDef = Math.max(sDispMin, Math.min(sDispMax, Math.round(UNITS.speed(medS))));
    const tDispDef = Math.max(tDispMin, Math.min(tDispMax, Math.round(UNITS.temp(medT))));
    const cDispDef = Math.max(0, Math.min(cDispMax, Math.round(UNITS.imperial ? medC * 5.2808 : medC)));
    whatIfEls.speed.min = String(sDispMin);
    whatIfEls.speed.max = String(sDispMax);
    whatIfEls.temp.min  = String(tDispMin);
    whatIfEls.temp.max  = String(tDispMax);
    whatIfEls.climb.min = "0";
    whatIfEls.climb.max = String(cDispMax);
    // Only seed defaults on first show, so the user's drag isn't reset
    // every re-render. Detect "first show" by an empty dataset cache.
    if (!whatIfEls.speed.dataset.km) {
      whatIfEls.speed.value = String(sDispDef);
      whatIfEls.temp.value  = String(tDispDef);
      whatIfEls.climb.value = String(cDispDef);
    }
    whatIfEls._onSpeed();
    whatIfEls._onTemp();
    whatIfEls._onClimb();
  }

  // ---------- Lifetime / insights / activity ----------
  function fmtCompact(v, unit) {
    if (v == null || !isFinite(v)) return { v: "—", u: unit };
    const a = Math.abs(v);
    if (a >= 1000) return { v: (v / 1000).toFixed(a >= 10000 ? 1 : 2) + "k", u: unit };
    if (a >= 100) return { v: v.toFixed(0), u: unit };
    // Drop the .0 on whole-number values (counts like Trips, Charges,
    // Free spins/falls etc.). Floats keep their single decimal.
    if (Number.isInteger(v)) return { v: String(v), u: unit };
    return { v: v.toFixed(1), u: unit };
  }
  function setStat(id, value, unit) {
    const el = document.getElementById(id);
    if (!el) return;
    if (value == null || !isFinite(value)) { el.textContent = "—"; return; }
    const f = fmtCompact(value, unit);
    el.innerHTML = `${f.v}<small>${unit ? " " + unit : ""}</small>`;
  }

  function renderLifetime() {
    let totalKm = 0, totalH = 0, totalWh = 0;
    let topSpd = 0, maxRangeKm = 0;
    let totalClimb = 0, anomCount = 0, bestAccel = null, bestAccelTarget = 0;
    const days = new Set();
    for (const m of dated) {
      totalKm += m.distKm;
      totalH += m.durH || 0;
      if (m.energyWh) totalWh += m.energyWh;
      if (m.dateStr) days.add(m.dateStr);
      if (m.estRangeKm != null && m.estRangeKm > maxRangeKm) maxRangeKm = m.estRangeKm;
      if (m.topSpeedKmh != null && m.topSpeedKmh > topSpd) topSpd = m.topSpeedKmh;
      totalClimb += m.climbM || 0;
      // Only count rider events (lift / fall), not logger glitches.
      if (m.anomalies) {
        for (const ev of m.anomalies) {
          if (ev.kind === "lift" || ev.kind === "fall") anomCount++;
        }
      }
      // Prefer to headline the 40 km/h time when achievable, else 25 km/h.
      if (m.accel40 != null && (bestAccelTarget < 40 || m.accel40 < bestAccel)) { bestAccel = m.accel40; bestAccelTarget = 40; }
      else if (bestAccelTarget < 40 && m.accel25 != null && (bestAccel == null || m.accel25 < bestAccel)) { bestAccel = m.accel25; bestAccelTarget = 25; }
    }
    setStat("lf-trips", dated.length, "");
    setStat("lf-dist", UNITS.dist(totalKm), UNITS.distUnit);
    setStat("lf-hours", totalH, "h");
    setStat("lf-energy", totalWh / 1000, "kWh");
    setStat("lf-topspd", UNITS.speed(topSpd), UNITS.speedUnit);
    setStat("lf-maxrange", maxRangeKm ? UNITS.dist(maxRangeKm) : null, UNITS.distUnit);
    setStat("lf-days", days.size, "");
    // Average rides/month over the active span.
    const spanMs = dated[dated.length - 1].date - dated[0].date;
    const spanMonths = Math.max(1, spanMs / (1000 * 60 * 60 * 24 * 30.44));
    setStat("lf-cadence", dated.length / spanMonths, "");
    setStat("lf-charges", charges.length, "");
    setStat("lf-chargedpct", charges.reduce((s, c) => s + c.gain, 0), "%");
    setStat("lf-accel40", bestAccel, bestAccelTarget ? "s" : "");
    {
      const lbl = document.querySelector("#lf-accel40 + .sl");
      if (lbl && bestAccelTarget) {
        lbl.textContent = `Best 0 → ${Math.round(UNITS.speed(bestAccelTarget))} ${UNITS.speedUnit}`;
      }
    }
    setStat("lf-anomalies", anomCount, "");
    setStat("lf-climb", UNITS.alt(totalClimb), UNITS.altUnit);
  }

  // Insight generation. Compares the first vs last third of dated trips so a
  // single noisy bin can't dominate the headline. Each item is { kind, html }.
  // User-facing copy on these reads as "old vs new" so the rider can tell
  // we're not comparing best vs worst trips, we're tracking drift over time.
  function computeInsights() {
    const out = [];
    if (dated.length < 6) return out;
    const third = Math.max(2, Math.floor(dated.length / 3));
    const early = dated.slice(0, third);
    const late = dated.slice(-third);

    function pick(arr, getter, w) {
      const vs = [], ws = [];
      for (const m of arr) {
        const v = getter(m);
        if (v != null && isFinite(v)) { vs.push(v); ws.push(w ? Math.max(0.1, w(m)) : 1); }
      }
      if (!vs.length) return null;
      return weightedMedian(vs, ws);
    }
    const fmtPct = (a, b) => ((b - a) / a) * 100;

    // Range drift, ideally on temp-normalized values so a winter/summer mix
    // doesn't masquerade as battery health.
    const useNorm = !!tempFit;
    const rangeGetter = (m) => {
      if (m.estRangeKm == null) return null;
      if (useNorm && m.ambientC != null) return m.estRangeKm + tempFit.slope * (20 - m.ambientC);
      return m.estRangeKm;
    };
    const r0 = pick(early, rangeGetter, (m) => m.distKm);
    const r1 = pick(late, rangeGetter, (m) => m.distKm);
    if (r0 && r1) {
      const pct = fmtPct(r0, r1);
      const dispA = UNITS.dist(r0), dispB = UNITS.dist(r1);
      out.push({
        kind: pct < -5 ? "warn" : pct > 5 ? "good" : "info",
        html: `Estimated range ${pct >= 0 ? "up" : "down"} <b>${Math.abs(pct).toFixed(0)}%</b> ` +
              `from your first third of trips (<b>${dispA.toFixed(1)} ${UNITS.distUnit}</b>) ` +
              `to your last third (<b>${dispB.toFixed(1)} ${UNITS.distUnit}</b>)` +
              (useNorm ? `, normalized to ${UNITS.temp(20).toFixed(0)} ${UNITS.tempUnit}.` : ". Add weather to factor out temperature."),
      });
    }

    // Internal resistance drift. Changes inside the measurement noise
    // (a few %) read as aging when they're nothing; call them flat.
    const ir0 = pick(early, (m) => m.ohmIR);
    const ir1 = pick(late, (m) => m.ohmIR);
    if (ir0 && ir1) {
      const pct = fmtPct(ir0, ir1);
      out.push({
        kind: pct > 15 ? "warn" : pct < -10 ? "good" : "info",
        html: Math.abs(pct) < 4
          ? `Internal resistance is holding steady: <b>${(ir0 * 1000).toFixed(0)} mΩ</b> in your first third of trips vs <b>${(ir1 * 1000).toFixed(0)} mΩ</b> in your last third. No aging signal.`
          : `Internal resistance ${pct >= 0 ? "rose" : "fell"} from <b>${(ir0 * 1000).toFixed(0)} mΩ</b> ` +
            `in your first third of trips to <b>${(ir1 * 1000).toFixed(0)} mΩ</b> in your last third (${pct >= 0 ? "+" : ""}${pct.toFixed(0)}%).`,
      });
    }

    // Efficiency drift (Wh/km).
    const e0 = pick(early, (m) => m.whPerKm, (m) => m.distKm);
    const e1 = pick(late, (m) => m.whPerKm, (m) => m.distKm);
    if (e0 && e1) {
      const pct = fmtPct(e0, e1);
      const dA = e0 / UNITS.dist(1), dB = e1 / UNITS.dist(1);
      out.push({
        kind: pct > 8 ? "warn" : pct < -5 ? "good" : "info",
        html: `Energy use ${pct >= 0 ? "up" : "down"} <b>${Math.abs(pct).toFixed(0)}%</b> ` +
              `from <b>${dA.toFixed(1)} Wh/${UNITS.distUnit}</b> in your first third of trips ` +
              `to <b>${dB.toFixed(1)} Wh/${UNITS.distUnit}</b> in your last third.`,
      });
    }

    // Temperature sensitivity. Same source the Range tab uses (multivariate
    // when available, univariate fallback) so both places quote one number,
    // and bounded to the ambient range actually ridden — the slope says
    // nothing about temperatures outside it.
    const tempSlopeKm = multiFit ? multiFit.tempSlope : (tempFit ? tempFit.slope : null);
    if (tempSlopeKm != null) {
      const slopeDisp = UNITS.dist(tempSlopeKm) / (UNITS.imperial ? 1.8 : 1);
      const ambients = dated.map((m) => m.ambientC).filter((v) => v != null).sort((a, b) => a - b);
      let envTxt = "";
      if (ambients.length >= 10) {
        const lo = ambients[Math.floor(ambients.length * 0.05)];
        const hi = ambients[Math.floor(ambients.length * 0.95)];
        envTxt = `, measured between <b>${Math.round(UNITS.temp(lo))}</b> and <b>${Math.round(UNITS.temp(hi))} ${UNITS.tempUnit}</b> ambient`;
      }
      out.push({
        kind: "info",
        html: `Every <b>10 ${UNITS.tempUnit}</b> drop in ambient costs about ` +
              `<b>${Math.abs(slopeDisp * 10).toFixed(1)}</b> ${UNITS.distUnit} of range${envTxt}` +
              (multiFit ? ` (speed and climb factored out).` : `.`),
      });
    }
    // Speed sensitivity (multivariate slope — isolated effect). A positive
    // slope is trip mix, not physics: faster trip averages mean less time
    // in the expensive crawl zone. Bound the claim to the trip averages the
    // fit actually saw and point at the in-ride curve for what lies beyond.
    const speedSlopeKm = multiFit ? multiFit.speedSlope : (speedFit ? speedFit.slope : null);
    if (speedSlopeKm != null) {
      const slopeDisp = UNITS.dist(speedSlopeKm) / UNITS.speed(1);
      const sign = slopeDisp >= 0 ? "gain" : "lose";
      let loK = multiFit ? multiFit.sLoKmh : null;
      let hiK = multiFit ? multiFit.sHiKmh : null;
      if (loK == null) {
        const sp = dated.map((m) => m.avgMovingSpeed).filter((v) => v != null && v > 5).sort((a, b) => a - b);
        if (sp.length >= 10) {
          loK = sp[Math.floor(sp.length * 0.05)];
          hiK = sp[Math.floor(sp.length * 0.95)];
        }
      }
      const env = loK != null
        ? ` inside your usual <b>${Math.round(UNITS.speed(loK))}–${Math.round(UNITS.speed(hiK))} ${UNITS.speedUnit}</b> trip averages`
        : "";
      const why = slopeDisp >= 0
        ? ` That is trip mix (less time crawling), not free speed; the in-ride cost curve on the Range tab shows the price of actually riding faster.`
        : "";
      out.push({
        kind: slopeDisp < -0.5 ? "warn" : "info",
        html: `Trips with a <b>5 ${UNITS.speedUnit}</b> faster average ${sign} about ` +
              `<b>${Math.abs(slopeDisp * 5).toFixed(1)}</b> ${UNITS.distUnit} of range${env}.${why}`,
      });
    }
    // Climb sensitivity (multivariate slope, isolated effect). Anchor the
    // example to a climb rate the user actually rides instead of an
    // arbitrary 10% grade extrapolation that may sit far outside the
    // training data. We use the 90th percentile climb rate so the example
    // is "your steepest typical trip", well within the model's fit region.
    const climbSlopeKmPerMperKm = multiFit ? multiFit.climbSlope : (climbFit ? climbFit.slope : null);
    if (climbSlopeKmPerMperKm != null) {
      const climbs = dated.map((m) => (m.climbM != null && m.distKm >= 2) ? m.climbM / m.distKm : null).filter((v) => v != null);
      const sortedC = climbs.slice().sort((a, b) => a - b);
      const p90Climb = sortedC.length ? sortedC[Math.floor(sortedC.length * 0.9)] : 50;
      const exampleClimbMperKm = Math.max(20, Math.round(p90Climb / 5) * 5);
      const exampleDispRate = UNITS.imperial ? exampleClimbMperKm * 3.28084 : exampleClimbMperKm;
      const exampleUnit = UNITS.imperial ? "ft/mi" : "m/km";
      const examplePctGrade = (exampleClimbMperKm / 10).toFixed(1);
      const slopePerMperKm = climbSlopeKmPerMperKm;
      const lossKm = -slopePerMperKm * exampleClimbMperKm;
      const lossDisp = UNITS.dist(Math.abs(lossKm));
      const r2 = Math.max(0, Math.min(1, multiFit ? multiFit.r2 : 0));
      const trustNote = r2 < 0.3 ? " Model fit is loose (R²=" + r2.toFixed(2) + "), so treat this as a ballpark." : "";
      out.push({
        kind: lossKm > 1 ? "warn" : "info",
        html: `Climbing at your steepest typical rate (<b>${exampleDispRate.toFixed(0)} ${exampleUnit}</b>, about <b>${examplePctGrade}%</b> grade) ` +
              `costs about <b>${lossDisp.toFixed(1)} ${UNITS.distUnit}</b> of full-charge range.${trustNote}`,
      });
    }
    // Model sanity check at the user's own MEDIAN conditions, with the
    // residual band. The old version predicted an idealized "25 km/h,
    // 20 °C, flat" ride — every factor more favorable than any real trip,
    // so the number always beat the Range chart and read as nonsense.
    // Predicting at median conditions must land near the observed median;
    // showing both makes the model audit itself.
    if (multiFit) {
      const predKm = multiFit.intercept
                   + multiFit.speedSlope * multiFit.medSpeedKmh
                   + multiFit.tempSlope * multiFit.medTempC
                   + multiFit.climbSlope * multiFit.medClimbMperKm;
      const obs = dated
        .filter((m) => m.estRangeKm != null && m.avgMovingSpeed > 5 && m.ambientC != null && m.climbM != null && m.distKm >= 2)
        .map((m) => m.estRangeKm)
        .sort((a, b) => a - b);
      const obsMed = obs.length ? obs[Math.floor(obs.length / 2)] : null;
      const sigma = Math.sqrt(multiFit.rss / Math.max(1, multiFit.n - 4));
      if (isFinite(predKm) && predKm > 0 && obsMed != null) {
        const conds = `${UNITS.speed(multiFit.medSpeedKmh).toFixed(0)} ${UNITS.speedUnit}, ` +
                      `${UNITS.temp(multiFit.medTempC).toFixed(0)} ${UNITS.tempUnit}, ` +
                      `${(UNITS.imperial ? multiFit.medClimbMperKm * 3.28084 : multiFit.medClimbMperKm).toFixed(0)} ${UNITS.imperial ? "ft/mi" : "m/km"}`;
        const r2 = Math.max(0, Math.min(1, multiFit.r2 || 0));
        const agree = Math.abs(predKm - obsMed) <= sigma;
        const tag = ` <span class="model-quality">(n=${multiFit.n} · R²=${r2.toFixed(2)})</span>`;
        out.push({
          kind: agree ? "info" : "warn",
          html: `Range model check: at your median conditions (<i>${conds}</i>) it predicts ` +
                `<b>${UNITS.dist(predKm).toFixed(0)} ± ${UNITS.dist(sigma).toFixed(0)} ${UNITS.distUnit}</b>, ` +
                `and your trips actually delivered a median of <b>${UNITS.dist(obsMed).toFixed(0)} ${UNITS.distUnit}</b>` +
                (agree ? `.` : ` — outside the band, so treat the model's slopes with care.`) + tag,
        });
      }
    }

    // Best month by distance.
    {
      const months = new Map();
      for (const m of dated) {
        const k = m.date.getFullYear() + "-" + String(m.date.getMonth()).padStart(2, "0");
        months.set(k, (months.get(k) || 0) + m.distKm);
      }
      let best = null;
      for (const [k, v] of months) if (!best || v > best.v) best = { k, v };
      if (best) {
        const [y, mo] = best.k.split("-").map(Number);
        const label = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" }).format(new Date(y, mo, 1));
        out.push({
          kind: "info",
          html: `Most active month: <b>${label}</b> with <b>${UNITS.dist(best.v).toFixed(0)}</b> ${UNITS.distUnit}.`,
        });
      }
    }

    return out;
  }

  function renderInsights() {
    const items = computeInsights();
    if (!items.length) { insightsBox.classList.add("hidden"); insightsList.innerHTML = ""; return; }
    insightsBox.classList.remove("hidden");
    insightsList.innerHTML = items.map((i) =>
      `<div class="insight ${i.kind}"><span class="ico"></span><div>${i.html}</div></div>`
    ).join("");
  }

  // Populate the green-bordered takeaway strip below a chart with the
  // headline number for that chart. `parts` is an array of HTML strings
  // joined with a visual separator.
  // Wraps a label (e.g. "Jan 25", "trip_20260604_190757") in an inspector
  // link when we have a representative trip index. Falls back to the plain
  // label otherwise so the takeaway still reads cleanly without "view →"
  // suffixes that look odd in a report.
  function tripLink(label, tripIdx) {
    if (tripIdx == null || !isFinite(tripIdx)) return label;
    return `<a class="ta-link-inline" href="inspector.html?i=${tripIdx}" target="_blank" rel="noopener" title="Open this ride in the inspector">${label}</a>`;
  }
  function setTakeaway(id, parts, kind) {
    const el = document.getElementById(id);
    if (!el) return;
    el.classList.remove("warn");
    if (kind === "warn") el.classList.add("warn");
    const filtered = (parts || []).filter(Boolean);
    el.innerHTML = filtered.length ? filtered.join('<span class="ta-sep">·</span>') : "";
  }
  // Find peak / trough labels in a stats array (skipping null bins).
  // When `metricFn` is provided, also locate a representative trip inside
  // the peak/trough bin (max for peak, min for trough) so the caller can
  // turn the group label into a clickable inspector link.
  function statsPeakTrough(stats, bins, label, metricFn) {
    let peak = null, trough = null;
    for (let i = 0; i < stats.length; i++) {
      const st = stats[i];
      if (!st || st.med == null) continue;
      if (!peak || st.med > peak.v) peak = { v: st.med, label: bins[i].label, binIdx: i };
      if (!trough || st.med < trough.v) trough = { v: st.med, label: bins[i].label, binIdx: i };
    }
    if (metricFn) {
      const pickRep = (binIdx, maximize) => {
        const trips = (bins[binIdx] && bins[binIdx].trips) || [];
        let best = null, bestV = null;
        for (const t of trips) {
          const v = metricFn(t);
          if (v == null || !isFinite(v)) continue;
          if (best == null || (maximize ? v > bestV : v < bestV)) { best = t; bestV = v; }
        }
        return best ? best.tripIdx : null;
      };
      if (peak)   peak.tripIdx   = pickRep(peak.binIdx, true);
      if (trough) trough.tripIdx = pickRep(trough.binIdx, false);
    }
    return { peak, trough };
  }

  // Riding activity: bar = distance per bin, line = cumulative lifetime.
  function drawActivityChart(canvas, bins) {
    const cv = setupCanvas(canvas);
    if (!cv) return;
    const { ctx, w, h } = cv;
    const pad = { top: legendPadTop(w, 2), bottom: 24, left: 46, right: 52 };
    const cw = w - pad.left - pad.right;
    const ch = h - pad.top - pad.bottom;
    const n = bins.length;
    if (!n) return;

    const distPerBin = bins.map((b) => b.trips.reduce((s, m) => s + m.distKm, 0));
    const cum = [];
    let acc = 0;
    for (const d of distPerBin) { acc += d; cum.push(acc); }
    const maxDist = Math.max(1, ...distPerBin);
    const maxCum = cum[cum.length - 1] || 1;

    const xAt = (i) => pad.left + (n > 1 ? (i / (n - 1)) * cw : cw / 2);
    const barW = n > 1 ? Math.max(2, (cw / n) * 0.7) : Math.max(8, cw * 0.3);

    ctx.font = FONT;
    // Grid + left axis (distance per bin).
    const leftTicks = niceTicks(0, UNITS.dist(maxDist), 4);
    ctx.fillStyle = AXIS_COLOR;
    ctx.strokeStyle = GRID_COLOR;
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    for (const tv of leftTicks) {
      const y = pad.top + ch - (tv / UNITS.dist(maxDist)) * ch;
      ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(w - pad.right, y); ctx.stroke();
      ctx.fillStyle = "#b388ff";
      ctx.fillText(fmtVal(tv), pad.left - 6, y);
    }
    // Right axis (cumulative).
    const rightTicks = niceTicks(0, UNITS.dist(maxCum), 4);
    ctx.textAlign = "left";
    ctx.fillStyle = "#69f0ae";
    for (const tv of rightTicks) {
      const y = pad.top + ch - (tv / UNITS.dist(maxCum)) * ch;
      ctx.fillText(fmtVal(tv), w - pad.right + 6, y);
    }

    // X labels.
    ctx.fillStyle = AXIS_COLOR;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    const labelStep = Math.max(1, Math.ceil(n / 8));
    for (let i = 0; i < n; i += labelStep) {
      ctx.fillText(bins[i].label, xAt(i), pad.top + ch + 6);
    }

    // Bars.
    for (let i = 0; i < n; i++) {
      const v = distPerBin[i];
      if (v <= 0) continue;
      const x = xAt(i) - barW / 2;
      const yTop = pad.top + ch - (v / maxDist) * ch;
      const grad = ctx.createLinearGradient(0, yTop, 0, pad.top + ch);
      grad.addColorStop(0, "rgba(179,136,255,0.85)");
      grad.addColorStop(1, "rgba(179,136,255,0.25)");
      ctx.fillStyle = grad;
      ctx.fillRect(x, yTop, barW, pad.top + ch - yTop);
    }

    // Cumulative line.
    ctx.strokeStyle = "#69f0ae";
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const y = pad.top + ch - (cum[i] / maxCum) * ch;
      const x = xAt(i);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
    ctx.fillStyle = "#69f0ae";
    for (let i = 0; i < n; i++) {
      ctx.beginPath();
      ctx.arc(xAt(i), pad.top + ch - (cum[i] / maxCum) * ch, 2.5, 0, Math.PI * 2);
      ctx.fill();
    }

    // Legend.
    drawLegend(ctx, w, pad.top, pad.left, [
      { color: "rgba(179,136,255,0.85)", label: "Distance per group (" + UNITS.distUnit + ")" },
      { color: "#69f0ae", label: "Cumulative (" + UNITS.distUnit + ")" },
    ]);

    // Hover.
    canvas._an = {
      type: "trend",
      bins,
      pad, cw, ch, w, h, xAt,
      series: [
        { stats: distPerBin.map((v, i) => ({ med: v, n: bins[i].trips.length })), label: "Distance", unit: UNITS.distUnit, dp: 1, color: "#b388ff" },
        { stats: cum.map((v, i) => ({ med: v, n: bins[i].trips.length })), label: "Cumulative", unit: UNITS.distUnit, dp: 1, color: "#69f0ae" },
      ],
    };
    // Swap the getter so we report metric units.
    canvas._an.series[0].stats = distPerBin.map((v) => ({ med: UNITS.dist(v) }));
    canvas._an.series[1].stats = cum.map((v) => ({ med: UNITS.dist(v) }));
  }

  // Plain histogram with bin labels under each bar; opts.color picks the fill.
  // Used for distance / speed / power distributions.
  function drawHistogram(canvas, values, opts) {
    const cv = setupCanvas(canvas);
    if (!cv || !values.length) return;
    const { ctx, w, h } = cv;
    const pad = { top: 42, bottom: 28, left: 44, right: 14 };
    const cw = w - pad.left - pad.right;
    const ch = h - pad.top - pad.bottom;
    const nBins = opts.nBins || 16;
    let lo = opts.min != null ? opts.min : Math.min.apply(null, values);
    let hi = opts.max != null ? opts.max : Math.max.apply(null, values);
    if (hi <= lo) hi = lo + 1;
    // Snap to a clean bin width: round up to a "nice" number close to (hi-lo)/nBins.
    const targetW = (hi - lo) / nBins;
    const mag = Math.pow(10, Math.floor(Math.log10(targetW)));
    let step = mag;
    for (const k of [1, 2, 2.5, 5, 10]) {
      if (mag * k >= targetW) { step = mag * k; break; }
    }
    lo = Math.floor(lo / step) * step;
    hi = Math.ceil(hi / step) * step;
    const realBins = Math.max(1, Math.round((hi - lo) / step));
    const counts = new Array(realBins).fill(0);
    for (const v of values) {
      let idx = Math.floor((v - lo) / step);
      if (idx < 0) idx = 0;
      if (idx >= realBins) idx = realBins - 1;
      counts[idx]++;
    }
    const maxCount = Math.max(1, ...counts);

    ctx.font = FONT;
    ctx.strokeStyle = GRID_COLOR;
    ctx.fillStyle = AXIS_COLOR;
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    const yTicks = niceTicks(0, maxCount, 4);
    for (const tv of yTicks) {
      const y = pad.top + ch - (tv / maxCount) * ch;
      ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(w - pad.right, y); ctx.stroke();
      ctx.fillText(String(Math.round(tv)), pad.left - 6, y);
    }

    const barW = cw / realBins;
    for (let i = 0; i < realBins; i++) {
      const c = counts[i];
      if (c <= 0) continue;
      const x = pad.left + i * barW;
      const yTop = pad.top + ch - (c / maxCount) * ch;
      const grad = ctx.createLinearGradient(0, yTop, 0, pad.top + ch);
      grad.addColorStop(0, opts.colorTop || "rgba(179,136,255,0.95)");
      grad.addColorStop(1, opts.colorBot || "rgba(179,136,255,0.25)");
      ctx.fillStyle = grad;
      ctx.fillRect(x + 1, yTop, barW - 2, pad.top + ch - yTop);
    }

    // X labels at bin edges (sparse to avoid collision)
    ctx.fillStyle = AXIS_COLOR;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    const labelEvery = Math.max(1, Math.ceil(realBins / 8));
    for (let i = 0; i <= realBins; i += labelEvery) {
      const tv = lo + i * step;
      const x = pad.left + i * barW;
      ctx.fillText(fmtVal(tv), x, pad.top + ch + 6);
    }
    // Axis title (top-left)
    ctx.fillStyle = "rgba(255,255,255,0.55)";
    ctx.textAlign = "left";
    ctx.fillText(opts.yLabel || "trips", pad.left + 4, 4);
    ctx.textAlign = "right";
    ctx.fillText(opts.xLabel || "", w - pad.right, pad.top + ch + 6);

    // Hover state: closest bin
    canvas._an = {
      type: "hist",
      pad, cw, ch, w, h,
      bins: counts.map((c, i) => ({ from: lo + i * step, to: lo + (i + 1) * step, count: c })),
      xToBin: (mx) => Math.floor((mx - pad.left) / barW),
      unit: opts.unit || "",
    };
  }

  // Charge-event bar chart: counts charges per calendar bin, like the activity
  // chart but only counting plug-in moments.
  function drawChargesBar(canvas, bins, perBin) {
    const cv = setupCanvas(canvas);
    if (!cv) return;
    const { ctx, w, h } = cv;
    const pad = { top: 42, bottom: 24, left: 40, right: 14 };
    const cw = w - pad.left - pad.right;
    const ch = h - pad.top - pad.bottom;
    const n = bins.length;
    if (!n) return;
    const xAt = (i) => pad.left + (n > 1 ? (i / (n - 1)) * cw : cw / 2);
    const barW = n > 1 ? Math.max(2, (cw / n) * 0.7) : Math.max(8, cw * 0.3);
    const max = Math.max(1, ...perBin);
    ctx.font = FONT;
    ctx.fillStyle = AXIS_COLOR;
    ctx.strokeStyle = GRID_COLOR;
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    for (const tv of niceTicks(0, max, 4)) {
      const y = pad.top + ch - (tv / max) * ch;
      ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(w - pad.right, y); ctx.stroke();
      ctx.fillText(String(Math.round(tv)), pad.left - 6, y);
    }
    for (let i = 0; i < n; i++) {
      const v = perBin[i];
      if (v <= 0) continue;
      const x = xAt(i) - barW / 2;
      const yTop = pad.top + ch - (v / max) * ch;
      const grad = ctx.createLinearGradient(0, yTop, 0, pad.top + ch);
      grad.addColorStop(0, "rgba(0,229,255,0.85)");
      grad.addColorStop(1, "rgba(0,229,255,0.18)");
      ctx.fillStyle = grad;
      ctx.fillRect(x, yTop, barW, pad.top + ch - yTop);
    }
    ctx.fillStyle = AXIS_COLOR;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    const labelStep = Math.max(1, Math.ceil(n / 8));
    for (let i = 0; i < n; i += labelStep) {
      ctx.fillText(bins[i].label, xAt(i), pad.top + ch + 6);
    }
    canvas._an = {
      type: "trend",
      bins,
      pad, cw, ch, w, h, xAt,
      series: [{ stats: perBin.map((v) => ({ med: v })), label: "Charges", unit: "", dp: 0, color: "#00e5ff" }],
    };
  }

  // Charge windows: for each charge, draw a vertical segment from `from` to
  // `to` along the X = trip-date axis. Visually shows the band of state-of-
  // charge each plug-in covered. X axis gets month tick labels so the user
  // can locate a charging pattern in a specific season.
  function drawChargeWindows(canvas, list) {
    const cv = setupCanvas(canvas);
    if (!cv || !list.length) return;
    const { ctx, w, h } = cv;
    const pad = { top: legendPadTop(w, 3), bottom: 28, left: 42, right: 14 };
    const cw = w - pad.left - pad.right;
    const ch = h - pad.top - pad.bottom;
    const t0 = list[0].date.getTime();
    const t1 = list[list.length - 1].date.getTime();
    const span = Math.max(1, t1 - t0);
    const xAt = (d) => pad.left + ((d.getTime() - t0) / span) * cw;
    const yAt = (pct) => pad.top + ch - (pct / 100) * ch;
    ctx.font = FONT;
    ctx.fillStyle = AXIS_COLOR;
    ctx.strokeStyle = GRID_COLOR;
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    // Major y gridlines
    for (const tv of [0, 25, 50, 75, 100]) {
      const y = yAt(tv);
      ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(w - pad.right, y); ctx.stroke();
      ctx.fillText(tv + "%", pad.left - 6, y);
    }
    // Minor y gridlines (every 12.5%)
    ctx.strokeStyle = GRID_MINOR_COLOR;
    for (const tv of [12.5, 37.5, 62.5, 87.5]) {
      const y = yAt(tv);
      ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(w - pad.right, y); ctx.stroke();
    }
    // X axis: walk through months of the span and place a tick wherever a
    // month boundary lands. Pick a step that yields ~6-8 labels regardless
    // of span (months, quarters, years).
    const spanDays = span / 86400000;
    const startD = new Date(t0);
    const endD = new Date(t1);
    let xfmt, stepMonths;
    if (spanDays <= 120) { xfmt = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }); stepMonths = 1; }
    else if (spanDays <= 800) { xfmt = new Intl.DateTimeFormat(undefined, { month: "short", year: "2-digit" }); stepMonths = 2; }
    else if (spanDays <= 2000) { xfmt = new Intl.DateTimeFormat(undefined, { month: "short", year: "2-digit" }); stepMonths = 3; }
    else { xfmt = new Intl.DateTimeFormat(undefined, { year: "numeric" }); stepMonths = 6; }
    const xLabels = [];
    const cursor = new Date(startD.getFullYear(), startD.getMonth(), 1);
    while (cursor.getTime() <= endD.getTime()) {
      if (cursor.getTime() >= startD.getTime()) xLabels.push(new Date(cursor));
      cursor.setMonth(cursor.getMonth() + stepMonths);
    }
    ctx.strokeStyle = GRID_MINOR_COLOR;
    ctx.textBaseline = "top";
    ctx.textAlign = "center";
    ctx.fillStyle = AXIS_COLOR;
    for (const d of xLabels) {
      const x = xAt(d);
      ctx.beginPath(); ctx.moveTo(x, pad.top); ctx.lineTo(x, pad.top + ch); ctx.stroke();
      ctx.fillText(xfmt.format(d), x, pad.top + ch + 6);
    }
    // Each charge: vertical line from `from` to `to` at its date
    for (const c of list) {
      const x = xAt(c.date);
      ctx.strokeStyle = c.from <= 20 ? "#ff5252" : c.from <= 50 ? "#ffd740" : "#69f0ae";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x, yAt(c.from));
      ctx.lineTo(x, yAt(c.to));
      ctx.stroke();
      // Endpoint dots — small at start, larger at end so it reads as
      // "charged FROM here UP TO there".
      ctx.fillStyle = ctx.strokeStyle;
      ctx.beginPath(); ctx.arc(x, yAt(c.from), 1.6, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(x, yAt(c.to), 2.6, 0, Math.PI * 2); ctx.fill();
    }
    // Legend: greener = healthier
    drawLegend(ctx, w, pad.top, pad.left, [
      { color: "#69f0ae", label: "Gentle (started >50%)" },
      { color: "#ffd740", label: "Mid (20–50%)" },
      { color: "#ff5252", label: "Deep (below 20%)" },
    ]);
    // Y-axis title
    ctx.save();
    ctx.translate(14, pad.top + ch / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillStyle = "rgba(255,255,255,0.45)";
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillText("state of charge", 0, 0);
    ctx.restore();
  }

  // Top-speed trend with both max-per-bin and median-per-bin on the same chart.
  function drawTopSpeedChart(canvas, bins) {
    const medians = bins.map((b) => {
      const vs = b.trips.map((m) => m.topSpeedKmh).filter((v) => v != null);
      return vs.length ? { med: median(vs) } : null;
    });
    const maxes = bins.map((b) => {
      const vs = b.trips.map((m) => m.topSpeedKmh).filter((v) => v != null);
      return vs.length ? { med: Math.max.apply(null, vs) } : null;
    });
    const series = [
      { stats: medians.map((s) => s ? { med: UNITS.speed(s.med) } : null),
        color: "#7cc7ff", label: "Median top speed", unit: UNITS.speedUnit, band: false, dp: 1 },
      { stats: maxes.map((s) => s ? { med: UNITS.speed(s.med) } : null),
        color: "#ff5252", label: "Max top speed", unit: UNITS.speedUnit, band: false, dp: 1 },
    ];
    drawTrendChart(canvas, bins, series, { rolling: false, zeroBase: false });
  }

  // Generic range-vs-X scatter helper.
  // - Dashed yellow Theil–Sen line: what the eye sees in this 2D slice
  //   (confounded by the other predictors).
  // - Solid purple model line: the multivariate slope, sliced through the
  //   median of the other predictors. This is the "after factoring out
  //   the others" line and matches the takeaway number.
  // A small legend in the top-left explains which is which.
  function drawRangeFactorScatter(canvas, host, pts, opts) {
    if (pts.length < 6) { host.classList.add("hidden"); return; }
    host.classList.remove("hidden");
    drawScatter(canvas, pts, { xLabel: opts.xLabel, yLabel: opts.yLabel });
    if (!canvas._scatterMap) return;
    const { xAt, yAt, xMin, xMax } = canvas._scatterMap;
    // The context is still carrying setupCanvas's dpr scale from the
    // drawScatter call, and xAt/yAt are CSS-pixel mappers — draw directly.
    // (An extra ctx.scale(dpr, dpr) here once made everything dpr²: fine at
    // dpr 1, giant legend + offscreen fit lines on phones.)
    const ctx = canvas.getContext("2d");

    const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
    const univariate = pts.length >= 10 ? theilSen(xs, ys) : null;
    const modelPredict = opts.modelLine || null;

    function drawSegmented(predictY, color, width, dashed) {
      ctx.save();
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      if (dashed) ctx.setLineDash(dashed);
      ctx.beginPath();
      const N = 32;
      let started = false;
      for (let i = 0; i <= N; i++) {
        const x = xMin + (xMax - xMin) * (i / N);
        const y = predictY(x);
        if (y == null || !isFinite(y)) { started = false; continue; }
        if (!started) { ctx.moveTo(xAt(x), yAt(y)); started = true; }
        else ctx.lineTo(xAt(x), yAt(y));
      }
      ctx.stroke();
      if (dashed) ctx.setLineDash([]);
      ctx.restore();
    }

    if (univariate) {
      // Faint dashed univariate fit so the reader can see the "naive" slope
      // and visually compare it against the multivariate model line.
      drawSegmented(
        (x) => univariate.slope * x + univariate.intercept,
        modelPredict ? "rgba(255,241,118,0.45)" : (opts.fitColor || "rgba(255,241,118,0.75)"),
        1.4,
        [4, 3],
      );
    }
    if (modelPredict) {
      drawSegmented(modelPredict, "rgba(179,136,255,0.95)", 2.2, null);
    }

    // Legend chip top-left. Drawn after the lines so it sits on top.
    if (univariate || modelPredict) {
      ctx.save();
      const lx = 12, ly = 32, lineH = 13; // below the y-axis title
      const items = [];
      if (modelPredict) items.push({ label: "model (multi)", color: "rgba(179,136,255,0.95)", width: 2.2, dash: null });
      if (univariate) items.push({ label: modelPredict ? "this view" : "fit", color: opts.fitColor || "rgba(255,241,118,0.75)", width: 1.4, dash: [4, 3] });
      // Soft background pill so the legend stays legible on dotty areas.
      ctx.font = "10px ui-monospace, SFMono-Regular, Consolas, monospace";
      let maxW = 0;
      for (const it of items) maxW = Math.max(maxW, ctx.measureText(it.label).width);
      ctx.fillStyle = "rgba(15,15,22,0.65)";
      ctx.fillRect(lx - 4, ly - 9, maxW + 32, items.length * lineH + 4);
      let y = ly;
      for (const it of items) {
        ctx.strokeStyle = it.color;
        ctx.lineWidth = it.width;
        if (it.dash) ctx.setLineDash(it.dash);
        ctx.beginPath();
        ctx.moveTo(lx, y - 3); ctx.lineTo(lx + 18, y - 3); ctx.stroke();
        if (it.dash) ctx.setLineDash([]);
        ctx.fillStyle = "rgba(220,220,230,0.85)";
        ctx.fillText(it.label, lx + 24, y);
        y += lineH;
      }
      ctx.restore();
    }
  }
  // Range vs ambient — only shown when weather is loaded.
  function drawRangeTempScatter(canvas) {
    const pts = [];
    for (const m of dated) {
      if (m.estRangeKm == null || m.ambientC == null) continue;
      pts.push({
        x: UNITS.temp(m.ambientC),
        y: UNITS.dist(m.estRangeKm),
        epoch: m.epoch,
        meta: `<b>${m.label}</b><br>Range: <b>${fmtVal(UNITS.dist(m.estRangeKm), 1)}</b> ${UNITS.distUnit}` +
              `<br>Ambient: <b>${fmtVal(UNITS.temp(m.ambientC), 1)}</b> ${UNITS.tempUnit}` +
              `<br>Battery used: <b>${fmtVal(m.battDelta, 1)}</b>%`,
      });
    }
    let modelLine = null;
    if (multiFit) {
      const sKmh = multiFit.medSpeedKmh, cMperKm = multiFit.medClimbMperKm;
      modelLine = (xDisp) => {
        const tC = UNITS.imperial ? (xDisp - 32) * 5 / 9 : xDisp;
        return UNITS.dist(calcRangeKm(sKmh, tC, cMperKm));
      };
    }
    drawRangeFactorScatter(canvas, rangeTempHost, pts, {
      xLabel: "ambient (" + UNITS.tempUnit + ")",
      yLabel: "est. range (" + UNITS.distUnit + ")",
      fitColor: "rgba(255,241,118,0.75)",
      modelLine,
    });
  }
  // Range vs avg riding speed.
  function drawRangeSpeedScatter(canvas) {
    const host = document.getElementById("range-speed-host");
    const pts = [];
    for (const m of dated) {
      if (m.estRangeKm == null || m.avgMovingSpeed == null || m.avgMovingSpeed <= 5) continue;
      pts.push({
        x: UNITS.speed(m.avgMovingSpeed),
        y: UNITS.dist(m.estRangeKm),
        epoch: m.epoch,
        meta: `<b>${m.label}</b><br>Range: <b>${fmtVal(UNITS.dist(m.estRangeKm), 1)}</b> ${UNITS.distUnit}` +
              `<br>Avg speed: <b>${fmtVal(UNITS.speed(m.avgMovingSpeed), 1)}</b> ${UNITS.speedUnit}` +
              `<br>Battery used: <b>${fmtVal(m.battDelta, 1)}</b>%`,
      });
    }
    let modelLine = null;
    if (multiFit) {
      const tC = multiFit.medTempC, cMperKm = multiFit.medClimbMperKm;
      modelLine = (xDisp) => {
        const sKmh = UNITS.imperial ? xDisp / 0.621371 : xDisp;
        return UNITS.dist(calcRangeKm(sKmh, tC, cMperKm));
      };
    }
    drawRangeFactorScatter(canvas, host, pts, {
      xLabel: "avg speed (" + UNITS.speedUnit + ")",
      yLabel: "est. range (" + UNITS.distUnit + ")",
      fitColor: "rgba(124,199,255,0.8)",
      modelLine,
    });
  }
  // Range vs climb rate (meters of altitude gain per km of ride).
  function drawRangeClimbScatter(canvas) {
    const host = document.getElementById("range-climb-host");
    const pts = [];
    for (const m of dated) {
      if (m.estRangeKm == null || m.distKm < 2 || m.climbM == null) continue;
      const climbPerKm = m.climbM / m.distKm;
      if (climbPerKm < 0) continue;
      pts.push({
        x: UNITS.imperial ? climbPerKm * 3.28084 : climbPerKm,
        y: UNITS.dist(m.estRangeKm),
        epoch: m.epoch,
        meta: `<b>${m.label}</b><br>Range: <b>${fmtVal(UNITS.dist(m.estRangeKm), 1)}</b> ${UNITS.distUnit}` +
              `<br>Climb rate: <b>${fmtVal(UNITS.imperial ? climbPerKm * 3.28084 : climbPerKm, 1)}</b> ${UNITS.imperial ? "ft" : "m"}/${UNITS.distUnit}` +
              `<br>Total climb: <b>${fmtVal(UNITS.alt(m.climbM), 0)}</b> ${UNITS.altUnit}` +
              `<br>Battery used: <b>${fmtVal(m.battDelta, 1)}</b>%`,
      });
    }
    let modelLine = null;
    if (multiFit) {
      const sKmh = multiFit.medSpeedKmh, tC = multiFit.medTempC;
      modelLine = (xDisp) => {
        const mPerKm = UNITS.imperial ? xDisp / 3.28084 : xDisp;
        return UNITS.dist(calcRangeKm(sKmh, tC, mPerKm));
      };
    }
    drawRangeFactorScatter(canvas, host, pts, {
      xLabel: (UNITS.imperial ? "ft" : "m") + "/" + UNITS.distUnit,
      yLabel: "est. range (" + UNITS.distUnit + ")",
      fitColor: "rgba(255,160,0,0.8)",
      modelLine,
    });
  }

  // In-ride cost of speed: aggregate the per-trip 5 km/h buckets over the
  // scoped trips. Bands need enough riding behind them (20+ km, 50+
  // segments) or one downhill burst would fabricate a cheap band.
  function computeSpeedCostRows() {
    const agg = Object.create(null);
    for (const m of dated) {
      const bk = m.spdCost;
      if (!bk) continue;
      for (const k in bk) {
        const a = agg[k] || (agg[k] = [0, 0, 0]);
        a[0] += bk[k][0]; a[1] += bk[k][1]; a[2] += bk[k][2];
      }
    }
    const rows = [];
    for (const k in agg) {
      const db = agg[k][0], km = agg[k][1], n = agg[k][2];
      if (km < 20 || n < 50 || db <= 0) continue;
      rows.push({ from: +k, to: +k + 5, pctPerKm: db / km, rangeKm: (100 * km) / db, km, n });
    }
    rows.sort((a, b) => a.from - b.from);
    return rows;
  }

  // One bar per speed band: how far a full charge goes if the whole ride
  // sits in that band. Sweet-spot bands (within 3% of the cheapest) are
  // green. Returns true when the chart drew so the caller can set the
  // takeaway from the same rows.
  function drawSpeedCostBars(canvas, rows) {
    const host = document.getElementById("speed-cost-host");
    const explainer = document.getElementById("speed-cost-explainer");
    if (!host || !canvas) return false;
    if (rows.length < 3) {
      host.classList.add("hidden");
      if (explainer) explainer.classList.add("hidden");
      return false;
    }
    host.classList.remove("hidden");
    if (explainer) explainer.classList.remove("hidden");
    const cv = setupCanvas(canvas);
    if (!cv) return false;
    const { ctx, w, h } = cv;
    const pad = { top: 42, bottom: 28, left: 44, right: 14 };
    const cw = w - pad.left - pad.right;
    const chh = h - pad.top - pad.bottom;
    const vals = rows.map((r) => UNITS.dist(r.rangeKm));
    const yMax = Math.max(...vals) * 1.14; // headroom for the value labels
    ctx.font = FONT;
    ctx.strokeStyle = GRID_COLOR;
    ctx.fillStyle = AXIS_COLOR;
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    for (const tv of niceTicks(0, yMax, 4)) {
      if (tv > yMax) continue;
      const y = pad.top + chh - (tv / yMax) * chh;
      ctx.beginPath(); ctx.moveTo(pad.left, y); ctx.lineTo(w - pad.right, y); ctx.stroke();
      ctx.fillText(String(Math.round(tv)), pad.left - 6, y);
    }
    const n = rows.length;
    const barW = cw / n;
    const bestPct = Math.min(...rows.map((r) => r.pctPerKm));
    const sweet = rows.map((r) => r.pctPerKm <= bestPct * 1.03);
    rows.forEach((r, i) => {
      const v = vals[i];
      const x = pad.left + i * barW;
      const yTop = pad.top + chh - (v / yMax) * chh;
      const grad = ctx.createLinearGradient(0, yTop, 0, pad.top + chh);
      if (sweet[i]) {
        grad.addColorStop(0, "rgba(105,240,174,0.95)");
        grad.addColorStop(1, "rgba(105,240,174,0.2)");
      } else {
        grad.addColorStop(0, "rgba(179,136,255,0.9)");
        grad.addColorStop(1, "rgba(179,136,255,0.18)");
      }
      ctx.fillStyle = grad;
      ctx.fillRect(x + 2, yTop, barW - 4, pad.top + chh - yTop);
      ctx.fillStyle = sweet[i] ? "rgba(105,240,174,0.95)" : "rgba(255,255,255,0.7)";
      ctx.textAlign = "center";
      ctx.textBaseline = "bottom";
      ctx.fillText(String(Math.round(v)), x + barW / 2, yTop - 2);
    });
    // Band edges along the x axis, unit on the last edge.
    ctx.fillStyle = AXIS_COLOR;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    rows.forEach((r, i) => {
      ctx.fillText(String(Math.round(UNITS.speed(r.from))), pad.left + i * barW, pad.top + chh + 6);
    });
    ctx.textAlign = "right";
    ctx.fillText(Math.round(UNITS.speed(rows[n - 1].to)) + " " + UNITS.speedUnit, w - pad.right, pad.top + chh + 6);
    // Titles + sweet-spot legend chip (left side, clear of the HTML title
    // overlay that lives in the top-right corner).
    ctx.fillStyle = "rgba(255,255,255,0.55)";
    ctx.textAlign = "left";
    ctx.fillText("est. full-charge range (" + UNITS.distUnit + ")", pad.left + 4, 4);
    ctx.fillStyle = "rgba(105,240,174,0.9)";
    ctx.fillRect(pad.left + 4, 21, 8, 8);
    ctx.fillStyle = "rgba(255,255,255,0.65)";
    ctx.fillText("sweet spot", pad.left + 16, 20);
    canvas._an = {
      type: "bars",
      pad, w, h,
      xToBin: (mx) => Math.floor((mx - pad.left) / barW),
      bins: rows.map((r, i) => ({
        html: `<b>${Math.round(UNITS.speed(r.from))}–${Math.round(UNITS.speed(r.to))} ${UNITS.speedUnit}</b>` +
              `<br>Full charge at this pace: <b>${Math.round(vals[i])} ${UNITS.distUnit}</b>` +
              `<br>Battery cost: <b>${(r.pctPerKm / UNITS.dist(1)).toFixed(2)}</b> %/${UNITS.distUnit}` +
              `<br>Sampled from <b>${Math.round(UNITS.dist(r.km))} ${UNITS.distUnit}</b> of riding`,
      })),
    };
    return true;
  }

  // Cost of standing still: aggregate the per-trip slow-state ledgers.
  // Standstill uses the long-stop method (see computeTripMetrics); the
  // moving states net drops against gauge-rebound rises. States need 1+
  // hour of samples to show; standstill additionally needs 10+ stops.
  function computeIdleCostRows() {
    const keys = ["stopped", "balance", "walk", "slowride", "cruise"];
    const agg = {};
    keys.forEach((k) => { agg[k] = [0, 0, 0]; });
    const idle = [0, 0, 0];
    for (const m of dated) {
      if (m.stateCost) {
        for (const k of keys) {
          const s = m.stateCost[k];
          if (s) { agg[k][0] += s[0]; agg[k][1] += s[1]; agg[k][2] += s[2]; }
        }
      }
      if (m.idleStops) { idle[0] += m.idleStops[0]; idle[1] += m.idleStops[1]; idle[2] += m.idleStops[2]; }
    }
    const defs = [
      { key: "stopped",  label: "standing still", midKmh: 0 },
      { key: "balance",  label: "balancing",      loK: 0.5, hiK: 3,  midKmh: 1.75 },
      { key: "walk",     label: "walking pace",   loK: 3,   hiK: 7,  midKmh: 5 },
      { key: "slowride", label: "slow riding",    loK: 7,   hiK: 12, midKmh: 9.5 },
      { key: "cruise",   label: `cruise ${Math.round(UNITS.speed(20))}–${Math.round(UNITS.speed(30))} ${UNITS.speedUnit}`, loK: 20, hiK: 30, midKmh: 25 },
    ];
    const rows = [];
    for (const d of defs) {
      if (d.key === "stopped") {
        const h = idle[0] / 3600;
        if (h < 1 || idle[2] < 10) continue;
        // Keep the raw net: gauge rebound can push it to ~0 or below,
        // which should read as "too small to measure", not "0.0%".
        rows.push({ ...d, pctPerH: idle[1] / h, hours: h, stops: idle[2] });
      } else {
        const a = agg[d.key];
        const h = a[0] / 3600;
        if (h < 1) continue;
        rows.push({ ...d, pctPerH: Math.max(0, (a[1] - a[2]) / h), hours: h });
      }
    }
    return rows;
  }

  // Horizontal bars: battery % per hour for each slow state, cruise as the
  // dim reference bar. Returns true when the chart drew.
  function drawIdleCostBars(canvas, rows) {
    const host = document.getElementById("idle-cost-host");
    const explainer = document.getElementById("idle-cost-explainer");
    if (!host || !canvas) return false;
    const cruise = rows.find((r) => r.key === "cruise");
    if (rows.length < 3 || !cruise) {
      host.classList.add("hidden");
      if (explainer) explainer.classList.add("hidden");
      return false;
    }
    host.classList.remove("hidden");
    if (explainer) explainer.classList.remove("hidden");
    const cv = setupCanvas(canvas);
    if (!cv) return false;
    const { ctx, w, h } = cv;
    const pad = { top: 42, bottom: 26, left: 158, right: 60 };
    const cw = w - pad.left - pad.right;
    const chh = h - pad.top - pad.bottom;
    const xMax = Math.max(...rows.map((r) => r.pctPerH)) * 1.05 || 1;
    ctx.font = FONT;
    // Vertical grid + x ticks.
    ctx.strokeStyle = GRID_COLOR;
    ctx.fillStyle = AXIS_COLOR;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    for (const tv of niceTicks(0, xMax, 5)) {
      if (tv > xMax) continue;
      const x = pad.left + (tv / xMax) * cw;
      ctx.beginPath(); ctx.moveTo(x, pad.top); ctx.lineTo(x, pad.top + chh); ctx.stroke();
      ctx.fillText(String(Math.round(tv)), x, pad.top + chh + 6);
    }
    const n = rows.length;
    const rowH = chh / n;
    const barH = Math.min(26, rowH * 0.62);
    const speedBand = (r) => r.loK == null ? "" :
      ` (${Math.round(UNITS.speed(r.loK))}–${Math.round(UNITS.speed(r.hiK))} ${UNITS.speedUnit})`;
    rows.forEach((r, i) => {
      const y = pad.top + i * rowH + (rowH - barH) / 2;
      const bw = Math.max(2, (Math.max(0, r.pctPerH) / xMax) * cw);
      const isRef = r.key === "cruise";
      const grad = ctx.createLinearGradient(pad.left, 0, pad.left + bw, 0);
      if (isRef) {
        grad.addColorStop(0, "rgba(255,255,255,0.16)");
        grad.addColorStop(1, "rgba(255,255,255,0.34)");
      } else {
        grad.addColorStop(0, "rgba(179,136,255,0.25)");
        grad.addColorStop(1, "rgba(179,136,255,0.9)");
      }
      ctx.fillStyle = grad;
      ctx.fillRect(pad.left, y, bw, barH);
      // State label on the left.
      ctx.fillStyle = isRef ? "rgba(255,255,255,0.5)" : "#ccc";
      ctx.textAlign = "right";
      ctx.textBaseline = "middle";
      ctx.fillText(r.label, pad.left - 8, y + barH / 2);
      // Value at the bar end. Sub-noise readings say so instead of "0.0".
      ctx.fillStyle = isRef ? "rgba(255,255,255,0.55)" : "rgba(255,255,255,0.85)";
      ctx.textAlign = "left";
      const valText = r.pctPerH < 0.2 ? "< 0.2 %/h" : r.pctPerH.toFixed(r.pctPerH < 5 ? 1 : 0) + " %/h";
      ctx.fillText(valText, pad.left + bw + 6, y + barH / 2);
    });
    // Axis title.
    ctx.fillStyle = "rgba(255,255,255,0.55)";
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillText("battery % per hour", pad.left + 4, 4);
    canvas._an = {
      type: "hbars",
      pad, w, h,
      yToBin: (my) => Math.floor((my - pad.top) / rowH),
      bins: rows.map((r) => {
        const perKm = r.midKmh > 0 ? (r.pctPerH / r.midKmh / UNITS.dist(1)).toFixed(2) + " %/" + UNITS.distUnit : null;
        const battTxt = r.pctPerH < 0.2
          ? "<b>&lt; 0.2 %/h</b> (below gauge noise)"
          : `<b>${r.pctPerH.toFixed(2)} %/h</b>`;
        return {
          html: `<b>${r.label}${r.key === "cruise" ? "" : speedBand(r)}</b>` +
                `<br>Battery: ${battTxt}` +
                (perKm ? `<br>Per distance: <b>${perKm}</b>` : "") +
                `<br>Sampled: <b>${r.hours.toFixed(1)} h</b>` +
                (r.stops ? ` across <b>${r.stops}</b> stops of 2+ min` : ""),
        };
      }),
    };
    return true;
  }

  // ---------- Ride planner (modal calculator) ----------
  // Lives in the topbar; takes battery / distance / speed / climb / ambient
  // and plays them through the same `multiFit` that drives the what-if panel.
  // Outputs pessimistic / neutral / optimistic bands derived from the OLS
  // residual standard error so the user sees how much wiggle the prediction has.
  const calcEls = {
    btn:      document.getElementById("calc-btn"),
    modal:    document.getElementById("calc-modal"),
    batt:     document.getElementById("calc-batt"),
    dist:     document.getElementById("calc-dist"),
    speed:    document.getElementById("calc-speed"),
    climb:    document.getElementById("calc-climb"),
    temp:     document.getElementById("calc-temp"),
    roundtrip: document.getElementById("calc-roundtrip"),
    battOut:  document.getElementById("calc-batt-out"),
    distOut:  document.getElementById("calc-dist-out"),
    speedOut: document.getElementById("calc-speed-out"),
    climbOut: document.getElementById("calc-climb-out"),
    tempOut:  document.getElementById("calc-temp-out"),
    time:     document.getElementById("calc-time"),
    battUse:  document.getElementById("calc-batt-use"),
    battArr:  document.getElementById("calc-batt-arr"),
    legBack:  document.getElementById("calc-leg-back"),
    timeTotal: document.getElementById("calc-time-total"),
    battUseTotal: document.getElementById("calc-batt-use-total"),
    battArrTotal: document.getElementById("calc-batt-arr-total"),
    verdict:  document.getElementById("calc-verdict"),
    canvas:   document.getElementById("calc-canvas"),
  };
  let calcWired = false;
  function calcModelSigmaKm() {
    if (!multiFit) return 0;
    const dof = Math.max(1, multiFit.n - 4);
    return Math.sqrt(multiFit.rss / dof);
  }
  // Cached in-ride cost curve for the hybrid range model. Rebuilt when the
  // scope changes (renderAll clears it). Points are band centers paired
  // with the full-charge range equivalent of that band's battery cost.
  let speedCurveCache; // undefined = stale, null = not enough band data
  function getSpeedCurve() {
    if (speedCurveCache !== undefined) return speedCurveCache;
    const rows = computeSpeedCostRows();
    speedCurveCache = rows.length >= 3
      ? { pts: rows.map((r) => ({ s: (r.from + r.to) / 2, r: r.rangeKm })), sMax: rows[rows.length - 1].to }
      : null;
    return speedCurveCache;
  }
  function speedCurveRangeAt(curve, sKmh) {
    const p = curve.pts;
    if (sKmh <= p[0].s) return p[0].r;
    for (let i = 1; i < p.length; i++) {
      if (sKmh <= p[i].s) {
        const k = (sKmh - p[i - 1].s) / (p[i].s - p[i - 1].s);
        return p[i - 1].r + k * (p[i].r - p[i - 1].r);
      }
    }
    return p[p.length - 1].r;
  }
  // Hybrid range model. Inside the envelope of observed trip-average speeds
  // the trip-level OLS applies (that's where it was trained). Outside it the
  // prediction continues along the measured in-ride cost-of-speed curve, so
  // pushing the speed slider past your data bends the estimate down with
  // drag instead of riding the positive linear speed term into fantasy.
  function calcRangeKm(sKmh, tC, climbMperKm) {
    if (!multiFit) return null;
    const lin = (s) => multiFit.intercept
                     + multiFit.speedSlope * s
                     + multiFit.tempSlope  * tC
                     + multiFit.climbSlope * climbMperKm;
    const curve = getSpeedCurve();
    if (!curve || multiFit.sLoKmh == null) return lin(sKmh);
    if (sKmh > multiFit.sHiKmh) {
      return lin(multiFit.sHiKmh) + speedCurveRangeAt(curve, sKmh) - speedCurveRangeAt(curve, multiFit.sHiKmh);
    }
    if (sKmh < multiFit.sLoKmh) {
      return lin(multiFit.sLoKmh) + speedCurveRangeAt(curve, sKmh) - speedCurveRangeAt(curve, multiFit.sLoKmh);
    }
    return lin(sKmh);
  }
  // True when the speed input sits meaningfully outside the trip-average
  // envelope (2 km/h grace so the note doesn't nag at the boundary), i.e.
  // the prediction is riding the in-ride curve extension.
  function calcSpeedBeyondData(sKmh) {
    if (!multiFit || multiFit.sLoKmh == null || !getSpeedCurve()) return false;
    return sKmh > multiFit.sHiKmh + 2 || sKmh < multiFit.sLoKmh - 2;
  }
  // Battery-used (pess / neut / opt) for a single leg of distance D km,
  // given internal-units inputs. Pessimistic = the worst (largest) battery
  // draw, derived from the shorter range that sits at neutral - sigma.
  function calcLegBatt(distKm, sKmh, tC, climbMperKm, sigmaKm) {
    const rangeNeutral = calcRangeKm(sKmh, tC, climbMperKm);
    if (rangeNeutral == null || !isFinite(rangeNeutral)) return null;
    const rangeOpt  = rangeNeutral + sigmaKm;
    const rangePess = Math.max(0.5, rangeNeutral - sigmaKm);
    return {
      rangeNeutral, rangeOpt, rangePess,
      battPess: 100 * distKm / rangePess,
      battNeut: 100 * distKm / Math.max(0.5, rangeNeutral),
      battOpt:  100 * distKm / rangeOpt,
    };
  }
  function calcFmtBand(pess, neut, opt, unit) {
    const u = unit || "";
    return `<span class="calc-pess">${pess.toFixed(0)}${u}</span>` +
           `<span class="calc-sep">·</span>` +
           `<span class="calc-neut">${neut.toFixed(0)}${u}</span>` +
           `<span class="calc-sep">·</span>` +
           `<span class="calc-opt">${opt.toFixed(0)}${u}</span>`;
  }
  function calcDistKm(d)  { return UNITS.imperial ? d / 0.621371 : d; }
  function calcClimbM(c)  { return UNITS.imperial ? c / 3.28084  : c; }
  function calcSpeedKmh(s){ return UNITS.imperial ? s / 0.621371 : s; }
  function calcTempC(t)   { return UNITS.imperial ? (t - 32) * 5 / 9 : t; }
  function updateCalculator(srcEvt) {
    if (!calcEls.modal || !multiFit) return;
    const B = Number(calcEls.batt.value);
    let dDisp = Number(calcEls.dist.value);
    const sDisp = Number(calcEls.speed.value);
    const cDisp = Number(calcEls.climb.value);
    const tDisp = Number(calcEls.temp.value);
    const sKmh = calcSpeedKmh(sDisp);
    const tC = calcTempC(tDisp);
    // Dynamic distance-slider ceiling: a bit beyond the optimistic max range
    // for the *current* battery + speed + temp + climb. We don't know the
    // climb-per-km until we know distance, so use the user's current climb
    // total at the prevailing rate (or flat = 0) for the projection.
    const climbMTotal = calcClimbM(cDisp);
    const climbProjPerKm = dDisp > 0 ? climbMTotal / calcDistKm(dDisp) : 0;
    const rangeOptKm = calcRangeKm(sKmh, tC, climbProjPerKm) + calcModelSigmaKm();
    const maxOptKm = Math.max(2, (B / 100) * Math.max(0.5, rangeOptKm));
    const newMaxDisp = Math.max(5, Math.ceil(UNITS.dist(maxOptKm) * 1.15));
    const srcId = srcEvt && srcEvt.target && srcEvt.target.id;
    // Don't move the ceiling while the user is dragging the distance slider —
    // that would force the thumb to jump under their finger. Also leave the
    // slider alone when a route lock pinned it to a real-world distance.
    if (srcId !== "calc-dist" && !routeLocked) {
      calcEls.dist.max = String(newMaxDisp);
      if (Number(calcEls.dist.value) > newMaxDisp) {
        calcEls.dist.value = String(newMaxDisp);
        dDisp = newMaxDisp;
      }
    }
    const distKm = calcDistKm(dDisp);
    const climbM = climbMTotal;
    const climbMperKm = distKm > 0 ? climbM / distKm : 0;
    // Slider labels in user units.
    calcEls.battOut.textContent = `${B}%`;
    calcEls.distOut.textContent = `${dDisp} ${UNITS.distUnit}`;
    calcEls.speedOut.textContent = `${sDisp} ${UNITS.speedUnit}`;
    const altUnit = UNITS.imperial ? "ft" : "m";
    const signC = cDisp >= 0 ? "+" : "";
    calcEls.climbOut.textContent = `${signC}${cDisp} ${altUnit}`;
    calcEls.tempOut.textContent = `${tDisp} ${UNITS.tempUnit}`;

    const sigma = calcModelSigmaKm();
    const legA = calcLegBatt(distKm, sKmh, tC, climbMperKm, sigma);
    if (!legA) { calcEls.verdict.textContent = "Model not ready."; return; }
    const fmtDur = (h) => {
      if (!isFinite(h) || h <= 0) return "—";
      const totalMin = Math.round(h * 60);
      const hh = Math.floor(totalMin / 60);
      const mm = totalMin % 60;
      return hh > 0 ? `${hh}h ${String(mm).padStart(2, "0")}m` : `${mm} min`;
    };
    const timeH = sKmh > 0 ? distKm / sKmh : 0;
    calcEls.time.textContent = fmtDur(timeH);
    calcEls.battUse.innerHTML = calcFmtBand(legA.battPess, legA.battNeut, legA.battOpt, " %");
    const arrPess = B - legA.battPess;
    const arrNeut = B - legA.battNeut;
    const arrOpt  = B - legA.battOpt;
    calcEls.battArr.innerHTML = calcFmtBand(arrPess, arrNeut, arrOpt, " %");

    let totalPess = legA.battPess, totalNeut = legA.battNeut, totalOpt = legA.battOpt;
    if (calcEls.roundtrip.checked) {
      const legB = calcLegBatt(distKm, sKmh, tC, -climbMperKm, sigma);
      calcEls.legBack.classList.remove("hidden");
      if (legB) {
        calcEls.timeTotal.textContent = fmtDur(timeH * 2);
        totalPess = legA.battPess + legB.battPess;
        totalNeut = legA.battNeut + legB.battNeut;
        totalOpt  = legA.battOpt  + legB.battOpt;
        calcEls.battUseTotal.innerHTML = calcFmtBand(totalPess, totalNeut, totalOpt, " %");
        calcEls.battArrTotal.innerHTML = calcFmtBand(B - totalPess, B - totalNeut, B - totalOpt, " %");
      }
    } else {
      calcEls.legBack.classList.add("hidden");
    }

    const arrTotalPess = B - totalPess;
    let cls = "", msg = "";
    if (arrTotalPess >= 25) {
      msg = `You'll make it with margin to spare &mdash; <b>${arrTotalPess.toFixed(0)}%</b> left in the pessimistic case.`;
    } else if (arrTotalPess >= 10) {
      cls = "warn";
      msg = `Tight: pessimistic arrival is only <b>${arrTotalPess.toFixed(0)}%</b>. Slower speed or a flatter route helps.`;
    } else if (arrTotalPess >= 0) {
      cls = "warn";
      msg = `Very thin margin: pessimistic arrival is <b>${arrTotalPess.toFixed(0)}%</b>.`;
    } else {
      cls = "bad";
      msg = `Won't make it in the pessimistic case &mdash; short by <b>${Math.abs(arrTotalPess).toFixed(0)}%</b>. ` +
            `Neutral needs <b>${totalNeut.toFixed(0)}%</b> vs your <b>${B}%</b> on hand.`;
    }
    calcEls.verdict.className = "calc-verdict" + (cls ? " " + cls : "");
    calcEls.verdict.innerHTML = msg;

    // Extrapolation flag: the chosen pace sits outside the trip averages the
    // model was trained on, so the estimate rides the in-ride curve instead.
    const noteEl = document.getElementById("calc-model-note");
    if (noteEl) {
      if (calcSpeedBeyondData(sKmh)) {
        const loD = Math.round(UNITS.speed(multiFit.sLoKmh));
        const hiD = Math.round(UNITS.speed(multiFit.sHiKmh));
        noteEl.innerHTML = `Your trips average ${loD}&ndash;${hiD} ${UNITS.speedUnit}. Beyond that the estimate follows your in-ride cost-of-speed curve, thinner data.`;
        noteEl.classList.remove("hidden");
      } else {
        noteEl.classList.add("hidden");
      }
    }

    drawCalcChart(B, distKm, sKmh, tC, climbMperKm, calcEls.roundtrip.checked);
  }
  // Stash the chart state so the mouseover handler can recompute battery,
  // distance, and time at the hovered X without re-reading sliders.
  let calcChartState = null;
  // Battery depletion curve: 3 lines (pess/neut/opt) descending from the
  // starting battery, slope = battery used per km in each scenario.
  // The band between pessimistic and optimistic is hatched so the
  // uncertainty range reads at a glance. Hovering shows a vertical
  // crosshair with battery, time, and range remaining at that distance.
  function drawCalcChart(B, distKm, sKmh, tC, climbMperKm, isRound) {
    const c = calcEls.canvas;
    if (!c || !multiFit) return;
    calcChartLastArgs = [B, distKm, sKmh, tC, climbMperKm, isRound];
    const dpr = window.devicePixelRatio || 1;
    const cssW = c.clientWidth || c.width;
    const cssH = c.clientHeight || c.height;
    c.width = Math.round(cssW * dpr);
    c.height = Math.round(cssH * dpr);
    const ctx = c.getContext("2d");
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, cssW, cssH);

    // padT matches the trend / scatter / histogram offsets so the HTML
    // "Battery depletion" title + axes hint sits in a clear band.
    const padL = 38, padR = 14, padT = 42, padB = 28;
    const W = cssW - padL - padR, H = cssH - padT - padB;
    if (W <= 0 || H <= 0) return;

    const sigma = calcModelSigmaKm();
    // Battery-used-per-km for the three scenarios at each leg's climb.
    const legBattPerKm = (climbMperKm_) => {
      const rN = calcRangeKm(sKmh, tC, climbMperKm_);
      if (rN == null || !isFinite(rN)) return null;
      const rO = rN + sigma, rP = Math.max(0.5, rN - sigma);
      return { pess: 100 / rP, neut: 100 / rN, opt: 100 / rO };
    };
    const legA = legBattPerKm(climbMperKm);
    const legB = isRound ? legBattPerKm(-climbMperKm) : null;
    if (!legA) return;

    const totalDist = distKm * (isRound ? 2 : 1);
    // Domain: 0 .. max(plannedDist × 1.15, "where opt hits 0").
    const xToWhereZero = (slope, start) => start / slope; // km until 0%
    const exhaustOpt = xToWhereZero(legA.opt, B);
    const xMin = 0;
    const xMax = Math.max(totalDist * 1.15, Math.min(exhaustOpt * 1.1, totalDist * 2.5), 1);
    const xToPx = (x) => padL + ((x - xMin) / (xMax - xMin)) * W;
    const yToPx = (y) => padT + (1 - (y / 100)) * H;

    // Grid + axes.
    ctx.strokeStyle = "rgba(255,255,255,0.07)";
    ctx.lineWidth = 1;
    ctx.font = "10px ui-monospace, SFMono-Regular, Consolas, monospace";
    ctx.fillStyle = "#888";
    // Horizontal grid every 25%.
    for (let p = 0; p <= 100; p += 25) {
      const y = yToPx(p);
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + W, y); ctx.stroke();
      ctx.textAlign = "right"; ctx.textBaseline = "middle";
      ctx.fillText(p + "%", padL - 4, y);
    }
    // Vertical grid at quarters of xMax.
    const xStep = niceStep(xMax / 4);
    ctx.textAlign = "center"; ctx.textBaseline = "top";
    for (let x = 0; x <= xMax; x += xStep) {
      const px = xToPx(x);
      ctx.strokeStyle = "rgba(255,255,255,0.04)";
      ctx.beginPath(); ctx.moveTo(px, padT); ctx.lineTo(px, padT + H); ctx.stroke();
      ctx.fillStyle = "#888";
      ctx.fillText(Math.round(UNITS.dist(x)) + " " + UNITS.distUnit, px, padT + H + 4);
    }

    // Planned-distance marker (vertical accent line).
    {
      const px = xToPx(totalDist);
      ctx.strokeStyle = "rgba(255,255,255,0.32)";
      ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(px, padT); ctx.lineTo(px, padT + H); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = "#ddd"; ctx.textAlign = "center"; ctx.textBaseline = "bottom";
      ctx.fillText(isRound ? "round-trip end" : "destination", px, padT + 12);
    }
    // Turnaround marker (vertical at plannedDist for round trip).
    if (isRound) {
      const px = xToPx(distKm);
      ctx.strokeStyle = "rgba(124,199,255,0.4)";
      ctx.setLineDash([2, 4]);
      ctx.beginPath(); ctx.moveTo(px, padT); ctx.lineTo(px, padT + H); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = "#7cc7ff"; ctx.textAlign = "center"; ctx.textBaseline = "bottom";
      ctx.fillText("turn around", px, padT + 12);
    }
    // Zero-battery axis line.
    ctx.strokeStyle = "rgba(255,82,82,0.4)";
    ctx.beginPath(); ctx.moveTo(padL, yToPx(0)); ctx.lineTo(padL + W, yToPx(0)); ctx.stroke();

    // Pure-math battery curve evaluator (no canvas). Returns battery % at
    // a given distance for one scenario, accounting for the turnaround
    // when the trip is a round trip.
    function batteryAt(x, slope1, slope2) {
      const xTurn = legB ? distKm : Infinity;
      if (x <= xTurn) {
        return Math.max(0, B - slope1 * x);
      }
      const yTurn = Math.max(0, B - slope1 * xTurn);
      return Math.max(0, yTurn - slope2 * (x - xTurn));
    }
    function polylineFor(key) {
      // Build the (x, y) sequence for plotting / hit-testing
      const slope1 = legA[key];
      const slope2 = legB ? legB[key] : slope1;
      const pts = [];
      const N = 64;
      for (let i = 0; i <= N; i++) {
        const x = xMin + (xMax - xMin) * (i / N);
        pts.push({ x, y: batteryAt(x, slope1, slope2) });
      }
      return pts;
    }
    const pessPts = polylineFor("pess");
    const neutPts = polylineFor("neut");
    const optPts  = polylineFor("opt");

    // Helper that draws diagonal hatching inside an arbitrary clip path.
    // Step and angle are tuned so the textures read as distinct without
    // muddying the foreground lines.
    function hatchClip(buildPath, lineColor, fillColor, step, dirDown) {
      ctx.save();
      ctx.beginPath();
      buildPath();
      if (fillColor) { ctx.fillStyle = fillColor; ctx.fill(); }
      ctx.clip();
      ctx.strokeStyle = lineColor;
      ctx.lineWidth = 1;
      ctx.beginPath();
      const maxDiag = cssW + cssH;
      for (let d = -cssH; d < maxDiag; d += step) {
        if (dirDown) { ctx.moveTo(d, 0); ctx.lineTo(d + cssH, cssH); }
        else         { ctx.moveTo(d + cssH, 0); ctx.lineTo(d, cssH); }
      }
      ctx.stroke();
      ctx.restore();
    }

    // 1) Faint hatched fill under the optimistic line (down to the 0% axis).
    //    Reads as "battery the route could plausibly leave in the tank."
    //    Direction is opposite to the band so the textures don't merge.
    hatchClip(() => {
      ctx.moveTo(xToPx(optPts[0].x), yToPx(0));
      for (const p of optPts) ctx.lineTo(xToPx(p.x), yToPx(p.y));
      ctx.lineTo(xToPx(optPts[optPts.length - 1].x), yToPx(0));
      ctx.closePath();
    }, "rgba(105, 240, 174, 0.10)", "rgba(105, 240, 174, 0.03)", 10, false);

    // 2) Denser hatched band between pess and opt. The uncertainty region.
    hatchClip(() => {
      ctx.moveTo(xToPx(optPts[0].x), yToPx(optPts[0].y));
      for (const p of optPts) ctx.lineTo(xToPx(p.x), yToPx(p.y));
      for (let i = pessPts.length - 1; i >= 0; i--) ctx.lineTo(xToPx(pessPts[i].x), yToPx(pessPts[i].y));
      ctx.closePath();
    }, "rgba(179, 136, 255, 0.22)", "rgba(179, 136, 255, 0.07)", 8, true);

    // Plot the three lines.
    function strokePolyline(pts, color, width) {
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.beginPath();
      pts.forEach((p, i) => { if (i === 0) ctx.moveTo(xToPx(p.x), yToPx(p.y)); else ctx.lineTo(xToPx(p.x), yToPx(p.y)); });
      ctx.stroke();
    }
    strokePolyline(pessPts, "#ffa000", 2);
    strokePolyline(optPts,  "#69f0ae", 2);
    strokePolyline(neutPts, "#ffffff", 2.4);

    // Mini legend top-left.
    const legend = [
      { lbl: "optimistic", color: "#69f0ae" },
      { lbl: "neutral",    color: "#ffffff" },
      { lbl: "pessimistic",color: "#ffa000" },
    ];
    ctx.font = "10px ui-monospace, SFMono-Regular, Consolas, monospace";
    ctx.textAlign = "left"; ctx.textBaseline = "middle";
    let ly = padT + 12;
    for (const l of legend) {
      ctx.strokeStyle = l.color; ctx.lineWidth = 2.2;
      ctx.beginPath(); ctx.moveTo(padL + 8, ly); ctx.lineTo(padL + 22, ly); ctx.stroke();
      ctx.fillStyle = "rgba(220,220,230,0.9)";
      ctx.fillText(l.lbl, padL + 28, ly);
      ly += 14;
    }
    // Save state for the mouseover handler.
    calcChartState = {
      B, distKm, sKmh, isRound,
      legA, legB,
      xMin, xMax, padL, padR, padT, padB, W, H, cssW, cssH, dpr,
      batteryAt,
    };
  }
  // Crosshair + tooltip on hover. Paints on top of the existing chart so
  // we don't repaint the (expensive) base every mousemove. When the cursor
  // leaves the canvas, a single redraw clears the overlay.
  let lastCrosshairX = null;
  function onCalcChartMove(e) {
    const c = calcEls.canvas;
    const tip = document.getElementById("calc-canvas-tooltip");
    const state = calcChartState;
    if (!c || !state || !tip) return;
    const rect = c.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    if (mx < state.padL || mx > state.cssW - state.padR || my < state.padT || my > state.padT + state.H) {
      onCalcChartLeave();
      return;
    }
    // Distance at cursor
    const xRange = state.xMax - state.xMin;
    const xVal = state.xMin + ((mx - state.padL) / state.W) * xRange;
    const slopePess2 = state.legB ? state.legB.pess : state.legA.pess;
    const slopeNeut2 = state.legB ? state.legB.neut : state.legA.neut;
    const slopeOpt2  = state.legB ? state.legB.opt  : state.legA.opt;
    const pess = state.batteryAt(xVal, state.legA.pess, slopePess2);
    const neut = state.batteryAt(xVal, state.legA.neut, slopeNeut2);
    const opt  = state.batteryAt(xVal, state.legA.opt,  slopeOpt2);
    // Repaint: redraw base then overlay crosshair. Lightweight enough for
    // 60Hz hover; expensive elevation/route fetches don't re-trigger.
    redrawCalcChartBase();
    drawCalcCrosshair(mx, [pess, neut, opt]);
    lastCrosshairX = mx;
    // Compute remaining range for each scenario (km from cursor until 0%)
    const yToKm = (y0, slope1, slope2) => {
      // From current x to end-of-curve (battery hits 0)
      const xTurn = state.isRound ? state.distKm : Infinity;
      if (xVal <= xTurn) {
        const xZero1 = xVal + y0 / slope1;
        if (xZero1 <= xTurn) return xZero1 - xVal;
        const yAtTurn = y0 - slope1 * (xTurn - xVal);
        if (yAtTurn <= 0) return xTurn - xVal;
        return (xTurn - xVal) + yAtTurn / slope2;
      }
      return y0 / slope2;
    };
    const remPess = yToKm(pess, state.legA.pess, slopePess2);
    const remNeut = yToKm(neut, state.legA.neut, slopeNeut2);
    const remOpt  = yToKm(opt,  state.legA.opt,  slopeOpt2);
    const timeH = state.sKmh > 0 ? xVal / state.sKmh : 0;
    const tipHtml = `
      <div class="ctt-head">at ${UNITS.dist(xVal).toFixed(1)} ${UNITS.distUnit} (${formatRideTime(timeH)})</div>
      <div class="ctt-row"><span class="ctt-key">battery</span>
        <span><span class="ctt-pess">${pess.toFixed(0)}%</span> <span class="ctt-neut">${neut.toFixed(0)}%</span> <span class="ctt-opt">${opt.toFixed(0)}%</span></span></div>
      <div class="ctt-row"><span class="ctt-key">range left</span>
        <span><span class="ctt-pess">${UNITS.dist(remPess).toFixed(1)}</span> <span class="ctt-neut">${UNITS.dist(remNeut).toFixed(1)}</span> <span class="ctt-opt">${UNITS.dist(remOpt).toFixed(1)} ${UNITS.distUnit}</span></span></div>
    `;
    tip.innerHTML = tipHtml;
    tip.classList.remove("hidden");
    // Position tooltip near the cursor (offset so it doesn't sit under the mouse)
    const containerRect = c.parentElement.getBoundingClientRect();
    const tipRect = tip.getBoundingClientRect();
    let tipX = mx + 14;
    let tipY = my - 16;
    if (mx + 14 + tipRect.width > state.cssW) tipX = mx - 14 - tipRect.width;
    if (tipY < 0) tipY = 0;
    tip.style.left = tipX + "px";
    tip.style.top  = tipY + "px";
  }
  function onCalcChartLeave() {
    const tip = document.getElementById("calc-canvas-tooltip");
    if (tip) tip.classList.add("hidden");
    if (lastCrosshairX != null) {
      redrawCalcChartBase();
      lastCrosshairX = null;
    }
  }
  function formatRideTime(h) {
    if (!isFinite(h) || h <= 0) return "0 min";
    const totalMin = Math.round(h * 60);
    const hh = Math.floor(totalMin / 60);
    const mm = totalMin % 60;
    return hh > 0 ? `${hh}h ${String(mm).padStart(2, "0")}m` : `${mm} min`;
  }
  function drawCalcCrosshair(mx, [pess, neut, opt]) {
    const c = calcEls.canvas;
    if (!c || !calcChartState) return;
    const state = calcChartState;
    const ctx = c.getContext("2d");
    ctx.save();
    ctx.scale(state.dpr, state.dpr);
    // Vertical line
    ctx.strokeStyle = "rgba(255,255,255,0.4)";
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(mx, state.padT);
    ctx.lineTo(mx, state.padT + state.H);
    ctx.stroke();
    ctx.setLineDash([]);
    // Dots on each line
    const yToPx = (y) => state.padT + (1 - (y / 100)) * state.H;
    const drawDot = (y, color) => {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(mx, yToPx(Math.max(0, Math.min(100, y))), 4, 0, Math.PI * 2);
      ctx.fill();
    };
    drawDot(pess, "#ffa000");
    drawDot(opt,  "#69f0ae");
    drawDot(neut, "#ffffff");
    ctx.restore();
  }
  // Re-runs only the canvas draw using stashed state. Avoids touching sliders.
  let calcChartLastArgs = null;
  function redrawCalcChartBase() {
    if (!calcChartLastArgs) return;
    drawCalcChart(...calcChartLastArgs);
  }
  function niceStep(rough) {
    if (rough <= 0) return 1;
    const pow = Math.pow(10, Math.floor(Math.log10(rough)));
    const m = rough / pow;
    if (m < 1.5) return pow;
    if (m < 3) return 2 * pow;
    if (m < 7) return 5 * pow;
    return 10 * pow;
  }
  function calcSetSliderRanges() {
    if (!calcEls.modal) return;
    const speeds = dated.filter((m) => m.avgMovingSpeed != null).map((m) => m.avgMovingSpeed);
    const dists  = dated.map((m) => m.distKm).filter((d) => d > 0);
    const temps  = dated.filter((m) => m.ambientC != null).map((m) => m.ambientC);
    const climbs = dated.filter((m) => m.climbM != null).map((m) => m.climbM);
    const medS = speeds.length ? median(speeds) : 25;
    const medD = dists.length  ? median(dists)  : 10;
    const medT = temps.length  ? median(temps)  : 20;
    const maxD = dists.length ? percentile(dists, 0.99) * 1.5 : 50;
    const maxC = climbs.length ? Math.max(500, percentile(climbs.map(Math.abs), 0.95) * 1.5) : 500;
    // Speed ceiling: the fastest in-ride band with real data behind it
    // (hybrid model territory), not an arbitrary constant. Falls back to
    // 55 when there aren't enough bands to build the curve.
    const curve = getSpeedCurve();
    const sMin = 10, sMax = curve ? Math.max(30, curve.sMax) : 55, tMin = -15, tMax = 40;
    const sMinD = Math.round(UNITS.speed(sMin));
    const sMaxD = Math.round(UNITS.speed(sMax));
    const tMinD = Math.round(UNITS.temp(tMin));
    const tMaxD = Math.round(UNITS.temp(tMax));
    const dMaxD = Math.max(5, Math.round(UNITS.dist(maxD)));
    // Round to a multiple of the slider step (10) so 0 lands on a valid stop.
    const cMaxD = Math.ceil(UNITS.alt(maxC) / 100) * 100;
    calcEls.speed.min = String(sMinD);
    calcEls.speed.max = String(sMaxD);
    calcEls.temp.min  = String(tMinD);
    calcEls.temp.max  = String(tMaxD);
    calcEls.dist.min  = "1";
    calcEls.dist.max  = String(dMaxD);
    calcEls.climb.min = String(-cMaxD);
    calcEls.climb.max = String(cMaxD);
    if (!calcEls.batt.dataset.seeded) {
      calcEls.batt.value = "100";
      calcEls.dist.value = String(Math.max(1, Math.min(dMaxD, Math.round(UNITS.dist(medD)))));
      calcEls.speed.value = String(Math.max(sMinD, Math.min(sMaxD, Math.round(UNITS.speed(medS)))));
      calcEls.climb.value = "0";
      calcEls.temp.value = String(Math.max(tMinD, Math.min(tMaxD, Math.round(UNITS.temp(medT)))));
      calcEls.batt.dataset.seeded = "1";
    }
  }
  function openCalc() {
    if (!calcEls.modal) return;
    calcSetSliderRanges();
    calcEls.modal.classList.remove("hidden");
    updateCalculator();
  }
  function closeCalc() {
    if (!calcEls.modal) return;
    calcEls.modal.classList.add("hidden");
    // Reset to the main calc view so the next open isn't stranded in a
    // subview (map / weather). Doesn't clear locked state or user inputs.
    if (calcMode !== "calc") setCalcMode("calc");
  }
  function wireCalculator() {
    if (calcWired || !calcEls.modal) return;
    calcWired = true;
    ["batt", "dist", "speed", "climb", "temp"].forEach((k) => {
      calcEls[k].addEventListener("input", updateCalculator);
    });
    calcEls.roundtrip.addEventListener("change", updateCalculator);
    if (calcEls.btn) calcEls.btn.addEventListener("click", openCalc);
    calcEls.modal.querySelectorAll("[data-calc-close]").forEach((el) => {
      el.addEventListener("click", closeCalc);
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && calcEls.modal && !calcEls.modal.classList.contains("hidden")) {
        if (calcMode !== "calc") setCalcMode("calc"); else closeCalc();
      }
    });
    // Source buttons (route / weather)
    calcEls.modal.querySelectorAll(".calc-source-btn").forEach((b) => {
      b.addEventListener("click", () => setCalcMode(b.dataset.source === "route" ? "map" : "weather"));
    });
    calcEls.modal.querySelectorAll(".calc-source-reset").forEach((b) => {
      b.addEventListener("click", () => {
        const src = b.dataset.source || b.dataset.cancel;
        if (b.dataset.cancel) {
          // Cancel a sub-view without changing state.
          if (src === "route") clearMapPicks();
          if (src === "weather") { pendingWeather = null; document.getElementById("calc-weather-apply").disabled = true; }
          setCalcMode("calc");
        } else {
          if (src === "route") resetRoute();
          if (src === "weather") resetWeather();
        }
      });
    });
    const mapApply = document.getElementById("calc-map-apply");
    if (mapApply) mapApply.addEventListener("click", applyRoute);
    const weatherApply = document.getElementById("calc-weather-apply");
    if (weatherApply) weatherApply.addEventListener("click", applyWeather);
    const weatherRefresh = document.getElementById("calc-weather-refresh");
    if (weatherRefresh) weatherRefresh.addEventListener("click", () => fetchForecast(true));
    // Auto-fetch when date / location / custom-latlon change. Debounced
    // shortly so a date picker click or a paste-typed latlon doesn't fire
    // 8 requests, but tight enough that the user sees results without a
    // manual Refresh.
    let fetchDebounce = null;
    const queueFetch = () => {
      clearTimeout(fetchDebounce);
      fetchDebounce = setTimeout(() => fetchForecast(false), 250);
    };
    // Both `change` (date picker confirm, select choice) and `input`
    // (every keystroke in lat/lon) cover the typical interaction modes.
    ["calc-weather-date", "calc-weather-loc", "calc-weather-latlon"].forEach((id) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.addEventListener("change", queueFetch);
      el.addEventListener("input", queueFetch);
    });
    const weatherLoc = document.getElementById("calc-weather-loc");
    if (weatherLoc) weatherLoc.addEventListener("change", () => {
      // Once the user picks a location explicitly, don't auto-snap back
      // to "From picked route" on the next open.
      weatherLoc.dataset.userPicked = "1";
      syncWeatherLocUI();
    });
    ["calc-weather-autoend", "calc-weather-start"].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.addEventListener("change", syncEndTime);
    });
    if (calcEls.canvas) {
      calcEls.canvas.addEventListener("mousemove", onCalcChartMove);
      calcEls.canvas.addEventListener("mouseleave", onCalcChartLeave);
    }
    refreshLockUI();
  }
  // ---------- Calculator: map + weather sub-views ----------
  // Mode state: "calc" (normal), "map" (route picker), "weather" (forecast).
  let calcMode = "calc";
  let routeLocked = null;   // when locked: { distKm, climbM, profile: [{km, alt}], coords }
  let weatherLocked = null; // when locked: { ambientC, label }
  let leafletMap = null;
  let leafletStart = null, leafletEnd = null;
  let leafletStartMarker = null, leafletEndMarker = null;
  let leafletRouteLine = null;
  let pendingRoute = null; // { distKm, climbM, profile, coords } before Apply
  let pendingWeather = null; // { ambientC, label } before Apply
  let lastForecastCells = null; // [{ h, t, inRide }] for the current fetch, lets us re-render without re-fetching

  function setCalcMode(mode) {
    calcMode = mode;
    const inputs = document.querySelector("#calc-modal .calc-inputs");
    const results = document.querySelector("#calc-modal .calc-results");
    const chart = document.querySelector("#calc-modal .calc-chart");
    const foot = document.querySelector("#calc-modal .calc-foot");
    const mapView = document.getElementById("calc-mapview");
    const weatherView = document.getElementById("calc-weatherview");
    const normalVisible = mode === "calc";
    if (inputs)  inputs.classList.toggle("hidden",  !normalVisible);
    if (results) results.classList.toggle("hidden", !normalVisible);
    if (chart)   chart.classList.toggle("hidden",   !normalVisible);
    if (foot)    foot.classList.toggle("hidden",    !normalVisible);
    if (mapView) mapView.classList.toggle("hidden", mode !== "map");
    if (weatherView) weatherView.classList.toggle("hidden", mode !== "weather");
    if (mode === "map") setTimeout(initLeafletMap, 50);
    if (mode === "weather") initWeatherForm();
  }

  function refreshLockUI() {
    document.querySelectorAll('.calc-group').forEach((g) => {
      const src = g.querySelector('[data-group]')?.dataset?.group || g.dataset.group;
      const locked = (src === "route" && routeLocked) || (src === "weather" && weatherLocked);
      g.classList.toggle("is-locked", !!locked);
      g.querySelectorAll('.calc-row[data-locked-group]').forEach((r) => r.classList.toggle("is-locked", !!locked));
      g.querySelectorAll('.calc-source-btn').forEach((b) => b.classList.toggle("hidden", !!locked));
      g.querySelectorAll('.calc-source-reset').forEach((b) => b.classList.toggle("hidden", !locked));
      // Badge dropped: the Unlock button + green border + lock icon on the
      // value already communicate the locked state. A redundant "FROM ROUTE"
      // chip on the right was noisy.
      g.querySelectorAll('.calc-locked-badge').forEach((b) => b.classList.add("hidden"));
    });
  }

  // -- Map / route picker --
  function initLeafletMap() {
    if (typeof L === "undefined") return;
    const el = document.getElementById("calc-map");
    if (!el) return;
    if (leafletMap) { leafletMap.invalidateSize(); return; }
    // Start centered on the user's most-used trip area (centroid of trip
    // starts) so a click lands somewhere meaningful, with a wide fallback.
    let center = [48.8566, 2.3522]; // Paris fallback
    let zoom = 5;
    const startsLat = [], startsLon = [];
    for (const m of dated) {
      if (m.centroid) { startsLat.push(m.centroid[0]); startsLon.push(m.centroid[1]); }
    }
    if (startsLat.length) {
      center = [median(startsLat), median(startsLon)];
      zoom = 12;
    }
    leafletMap = L.map(el, { zoomControl: true }).setView(center, zoom);
    if (typeof window !== "undefined") window._calcMap = leafletMap;
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: "© OpenStreetMap",
    }).addTo(leafletMap);
    leafletMap.on("click", onMapClick);
    setTimeout(() => leafletMap.invalidateSize(), 100);
  }
  function clearMapPicks() {
    leafletStart = null; leafletEnd = null;
    if (leafletStartMarker) { leafletMap.removeLayer(leafletStartMarker); leafletStartMarker = null; }
    if (leafletEndMarker)   { leafletMap.removeLayer(leafletEndMarker);   leafletEndMarker   = null; }
    if (leafletRouteLine)   { leafletMap.removeLayer(leafletRouteLine);   leafletRouteLine   = null; }
    pendingRoute = null;
    document.getElementById("calc-map-apply").disabled = true;
    document.getElementById("calc-map-status").textContent = "Click the start point on the map.";
    ["cms-distance", "cms-ascent", "cms-descent", "cms-net"].forEach((id) => { document.getElementById(id).textContent = "—"; });
    const c = document.getElementById("cms-profile").getContext("2d");
    c.clearRect(0, 0, 300, 200);
  }
  function onMapClick(e) {
    if (!leafletStart) {
      leafletStart = e.latlng;
      // White ring + bold inner colour reads on both dark and light tiles.
      leafletStartMarker = L.layerGroup([
        L.circleMarker(e.latlng, { radius: 10, color: "#ffffff", weight: 3, opacity: 0.95, fillColor: "#1b8a5a", fillOpacity: 1 }),
        L.circleMarker(e.latlng, { radius: 3.5, color: "#ffffff", weight: 0, fillColor: "#ffffff", fillOpacity: 1 }),
      ]).addTo(leafletMap);
      document.getElementById("calc-map-status").textContent = "Click the destination point.";
    } else if (!leafletEnd) {
      leafletEnd = e.latlng;
      leafletEndMarker = L.layerGroup([
        L.circleMarker(e.latlng, { radius: 10, color: "#ffffff", weight: 3, opacity: 0.95, fillColor: "#c14b00", fillOpacity: 1 }),
        L.circleMarker(e.latlng, { radius: 3.5, color: "#ffffff", weight: 0, fillColor: "#ffffff", fillOpacity: 1 }),
      ]).addTo(leafletMap);
      document.getElementById("calc-map-status").textContent = "Fetching route…";
      fetchRoute(leafletStart, leafletEnd);
    } else {
      // Third click resets and starts over.
      clearMapPicks();
      onMapClick(e);
    }
  }
  async function fetchRoute(a, b) {
    try {
      // OSRM public demo (driving profile is the only one always available;
      // it's a reasonable approximation of urban roads an EUC can ride).
      const url = `https://router.project-osrm.org/route/v1/driving/${a.lng},${a.lat};${b.lng},${b.lat}?overview=full&geometries=geojson&steps=false`;
      const r = await fetch(url);
      const j = await r.json();
      if (!j.routes || !j.routes.length) throw new Error("No route");
      const coords = j.routes[0].geometry.coordinates; // [[lon,lat], ...]
      const distM = j.routes[0].distance;
      const distKm = distM / 1000;
      // Two-layer polyline: dark outer halo for contrast on light tiles,
      // bright inner line for the main colour.
      const latLngs = coords.map(([lon, lat]) => [lat, lon]);
      const inner = L.polyline(latLngs, { color: "#7c4dff", weight: 4, opacity: 1 });
      leafletRouteLine = L.layerGroup([
        L.polyline(latLngs, { color: "#0a0a12", weight: 7, opacity: 0.55 }),
        inner,
      ]).addTo(leafletMap);
      leafletMap.fitBounds(inner.getBounds(), { padding: [20, 20] });
      document.getElementById("calc-map-status").textContent = "Sampling elevation…";
      // Downsample to ≤ 80 points for elevation lookup (open-meteo elevation
      // accepts a batch via repeated lat/lon params).
      const N = Math.min(80, coords.length);
      const stride = Math.max(1, Math.floor(coords.length / N));
      const sampled = [];
      for (let i = 0; i < coords.length; i += stride) sampled.push(coords[i]);
      if (sampled[sampled.length - 1] !== coords[coords.length - 1]) sampled.push(coords[coords.length - 1]);
      const lats = sampled.map((c) => c[1]).join(",");
      const lons = sampled.map((c) => c[0]).join(",");
      const eUrl = `https://api.open-meteo.com/v1/elevation?latitude=${lats}&longitude=${lons}`;
      const eR = await fetch(eUrl);
      const eJ = await eR.json();
      const elevs = Array.isArray(eJ.elevation) ? eJ.elevation : [];
      // Compute cumulative km along the sampled polyline + ascent / descent.
      // Defensive against null/undefined entries — Open-Meteo can return
      // nulls over water or for invalid points, which would poison the sum
      // with NaN. We track the last valid altitude and skip gaps.
      let asc = 0, des = 0;
      const profile = [];
      let cumKm = 0;
      let prevAlt = null;
      let firstValid = null, lastValid = null;
      for (let i = 0; i < sampled.length; i++) {
        if (i > 0) {
          const [lon1, lat1] = sampled[i - 1];
          const [lon2, lat2] = sampled[i];
          cumKm += haversineKm(lat1, lon1, lat2, lon2);
        }
        const raw = elevs[i];
        const alt = (typeof raw === "number" && isFinite(raw)) ? raw : null;
        if (alt != null) {
          if (firstValid == null) firstValid = alt;
          lastValid = alt;
          if (prevAlt != null) {
            const d = alt - prevAlt;
            if (d > 0) asc += d; else des += -d;
          }
          prevAlt = alt;
        }
        profile.push({ km: cumKm, alt });
      }
      const netClimb = (firstValid != null && lastValid != null) ? (lastValid - firstValid) : 0;
      pendingRoute = { distKm, climbM: netClimb, ascentM: asc, descentM: des, profile, coords };
      document.getElementById("cms-distance").textContent = `${UNITS.dist(distKm).toFixed(1)} ${UNITS.distUnit}`;
      document.getElementById("cms-ascent").textContent = `${UNITS.alt(asc).toFixed(0)} ${UNITS.altUnit}`;
      document.getElementById("cms-descent").textContent = `${UNITS.alt(des).toFixed(0)} ${UNITS.altUnit}`;
      document.getElementById("cms-net").textContent = `${netClimb >= 0 ? "+" : ""}${UNITS.alt(netClimb).toFixed(0)} ${UNITS.altUnit}`;
      drawElevationProfile(profile);
      document.getElementById("calc-map-status").textContent = "Press Apply to lock these values into the calculator.";
      document.getElementById("calc-map-apply").disabled = false;
    } catch (err) {
      console.warn("Route fetch failed:", err);
      document.getElementById("calc-map-status").textContent = "Couldn't fetch the route. Try two nearby points or check your connection.";
    }
  }
  function haversineKm(lat1, lon1, lat2, lon2) {
    const R = 6371;
    const toRad = (d) => d * Math.PI / 180;
    const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  }
  function drawElevationProfile(profile) {
    const c = document.getElementById("cms-profile");
    if (!c || profile.length < 2) return;
    const dpr = window.devicePixelRatio || 1;
    const cssW = c.clientWidth, cssH = c.clientHeight;
    c.width = Math.round(cssW * dpr); c.height = Math.round(cssH * dpr);
    const ctx = c.getContext("2d");
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, cssW, cssH);
    const padL = 4, padR = 4, padT = 4, padB = 14;
    const W = cssW - padL - padR, H = cssH - padT - padB;
    const validPoints = profile.filter((p) => typeof p.alt === "number" && isFinite(p.alt));
    if (validPoints.length < 2) {
      ctx.fillStyle = "#888";
      ctx.font = "10px ui-monospace, SFMono-Regular, Consolas, monospace";
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText("Elevation data unavailable for this route", cssW / 2, cssH / 2);
      return;
    }
    const xMin = profile[0].km, xMax = profile[profile.length - 1].km;
    const ys = validPoints.map((p) => p.alt);
    const yMin = Math.min.apply(null, ys), yMax = Math.max.apply(null, ys);
    const ySpan = Math.max(1, yMax - yMin);
    const xToPx = (x) => padL + ((x - xMin) / (xMax - xMin || 1)) * W;
    const yToPx = (y) => padT + (1 - (y - yMin) / ySpan) * H;
    // Build a segmented path so null gaps don't bridge across the chart.
    const segments = [];
    let cur = [];
    for (const p of profile) {
      if (p.alt == null) { if (cur.length) { segments.push(cur); cur = []; } continue; }
      cur.push(p);
    }
    if (cur.length) segments.push(cur);
    // Filled areas (per segment)
    ctx.fillStyle = "rgba(179, 136, 255, 0.20)";
    for (const seg of segments) {
      if (seg.length < 2) continue;
      ctx.beginPath();
      ctx.moveTo(xToPx(seg[0].km), padT + H);
      for (const p of seg) ctx.lineTo(xToPx(p.km), yToPx(p.alt));
      ctx.lineTo(xToPx(seg[seg.length - 1].km), padT + H);
      ctx.closePath();
      ctx.fill();
    }
    // Lines
    ctx.strokeStyle = "#b388ff"; ctx.lineWidth = 1.6;
    for (const seg of segments) {
      if (seg.length < 2) continue;
      ctx.beginPath();
      seg.forEach((p, i) => { if (i === 0) ctx.moveTo(xToPx(p.km), yToPx(p.alt)); else ctx.lineTo(xToPx(p.km), yToPx(p.alt)); });
      ctx.stroke();
    }
    // Labels
    ctx.font = "9px ui-monospace, SFMono-Regular, Consolas, monospace";
    ctx.fillStyle = "#888";
    ctx.textAlign = "left"; ctx.textBaseline = "top";
    ctx.fillText(`${UNITS.alt(yMin).toFixed(0)} ${UNITS.altUnit}`, padL, padT + H + 2);
    ctx.textAlign = "right";
    ctx.fillText(`${UNITS.alt(yMax).toFixed(0)} ${UNITS.altUnit}`, cssW - padR, padT + H + 2);
  }
  function applyRoute() {
    if (!pendingRoute) return;
    routeLocked = { ...pendingRoute };
    // Push values into the sliders (so display matches, even though they
    // become read-only). Update unit-aware display.
    const dDisp = Math.round(UNITS.dist(routeLocked.distKm));
    const cDisp = Math.round(UNITS.alt(routeLocked.climbM));
    // Ensure slider range can hold the value.
    calcEls.dist.max = String(Math.max(Number(calcEls.dist.max), dDisp + 5));
    const cBound = Math.max(Math.abs(cDisp) + 100, Number(calcEls.climb.max));
    calcEls.climb.min = String(-cBound);
    calcEls.climb.max = String(cBound);
    calcEls.dist.value = String(dDisp);
    calcEls.climb.value = String(cDisp);
    refreshLockUI();
    setCalcMode("calc");
    updateCalculator();
  }
  function resetRoute() {
    routeLocked = null;
    clearMapPicks();
    refreshLockUI();
    updateCalculator();
  }

  // -- Weather / forecast --
  function pickRecentCenter() {
    const lats = [], lons = [];
    for (const m of dated) {
      if (m.centroid) { lats.push(m.centroid[0]); lons.push(m.centroid[1]); }
    }
    if (!lats.length) return null;
    return [median(lats), median(lons)];
  }
  // Make every location-dependent UI piece reflect the current dropdown
  // value (custom row visibility, mini-map host visibility, route option
  // enabled state). Called both on explicit user change and on reopen so
  // the modal never lands in a half-stale state.
  function syncWeatherLocUI() {
    const locSel = document.getElementById("calc-weather-loc");
    if (!locSel) return;
    const isCustom = locSel.value === "custom";
    document.getElementById("calc-weather-custom-row").classList.toggle("hidden", !isCustom);
    const mapHost = document.getElementById("calc-weather-map-host");
    if (mapHost) mapHost.classList.toggle("hidden", !isCustom);
    const routeOpt = locSel.querySelector('option[value="route"]');
    if (routeOpt) routeOpt.disabled = !routeLocked;
    if (isCustom) setTimeout(initWeatherMiniMap, 50);
  }
  function initWeatherForm() {
    const dateEl = document.getElementById("calc-weather-date");
    if (!dateEl.value) {
      const d = new Date();
      d.setDate(d.getDate() + 1);
      dateEl.value = d.toISOString().slice(0, 10);
    }
    const locSel = document.getElementById("calc-weather-loc");
    const routeOpt = locSel?.querySelector('option[value="route"]');
    if (routeOpt) {
      routeOpt.disabled = !routeLocked;
      // First open with a locked route and no prior user pick: auto-select
      // "From picked route" so the user doesn't have to choose it manually.
      if (routeLocked && locSel.value !== "route" && !locSel.dataset.userPicked) {
        locSel.value = "route";
      }
    }
    // Make the dependent UI match whatever's now selected.
    syncWeatherLocUI();
    syncEndTime();
    if (!lastForecastCells) fetchForecast(false);
  }
  let weatherMiniMap = null;
  let weatherMiniMarker = null;
  function initWeatherMiniMap() {
    if (typeof L === "undefined") return;
    const el = document.getElementById("calc-weather-map");
    if (!el) return;
    if (!weatherMiniMap) {
      let center = pickRecentCenter() || [48.8566, 2.3522];
      const zoom = pickRecentCenter() ? 9 : 4;
      weatherMiniMap = L.map(el, { zoomControl: true }).setView(center, zoom);
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: "© OpenStreetMap",
      }).addTo(weatherMiniMap);
      weatherMiniMap.on("click", (e) => {
        const lat = e.latlng.lat, lon = e.latlng.lng;
        document.getElementById("calc-weather-latlon").value = `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
        if (weatherMiniMarker) weatherMiniMap.removeLayer(weatherMiniMarker);
        weatherMiniMarker = L.layerGroup([
          L.circleMarker(e.latlng, { radius: 10, color: "#ffffff", weight: 3, opacity: 0.95, fillColor: "#7c4dff", fillOpacity: 1 }),
          L.circleMarker(e.latlng, { radius: 3.5, color: "#ffffff", weight: 0, fillColor: "#ffffff", fillOpacity: 1 }),
        ]).addTo(weatherMiniMap);
        // Kick a fetch immediately (Skip the debounced queueFetch so the
        // marker click feels responsive).
        fetchForecast(false);
      });
    }
    setTimeout(() => weatherMiniMap.invalidateSize(), 50);
  }
  function syncEndTime() {
    const autoEl = document.getElementById("calc-weather-autoend");
    const startEl = document.getElementById("calc-weather-start");
    const endEl = document.getElementById("calc-weather-end");
    if (!autoEl.checked) { endEl.disabled = false; return; }
    endEl.disabled = true;
    const distKm = calcDistKm(Number(calcEls.dist.value));
    const sKmh = calcSpeedKmh(Number(calcEls.speed.value));
    const isRound = calcEls.roundtrip.checked;
    const durH = sKmh > 0 ? (distKm * (isRound ? 2 : 1)) / sKmh : 1;
    const [h, m] = startEl.value.split(":").map(Number);
    const total = (h || 0) * 60 + (m || 0) + Math.round(durH * 60);
    const eh = String(Math.floor(total / 60) % 24).padStart(2, "0");
    const em = String(total % 60).padStart(2, "0");
    endEl.value = `${eh}:${em}`;
  }
  async function fetchForecast(force) {
    const dateEl = document.getElementById("calc-weather-date");
    const startEl = document.getElementById("calc-weather-start");
    const endEl = document.getElementById("calc-weather-end");
    const locSel = document.getElementById("calc-weather-loc");
    const customRow = document.getElementById("calc-weather-custom-row");
    const status = document.getElementById("calc-weather-status");
    const resultBox = document.getElementById("calc-weather-result");
    const refreshBtn = document.getElementById("calc-weather-refresh");
    if (refreshBtn) refreshBtn.classList.add("is-loading");
    let lat, lon, locLabel = "";
    if (locSel.value === "route" && routeLocked) {
      const mid = routeLocked.coords[Math.floor(routeLocked.coords.length / 2)];
      lon = mid[0]; lat = mid[1]; locLabel = "route midpoint";
    } else if (locSel.value === "custom") {
      const v = document.getElementById("calc-weather-latlon").value.split(/[\s,]+/).map(Number);
      if (v.length < 2 || !isFinite(v[0]) || !isFinite(v[1])) { status.textContent = "Enter a valid lat, lon."; if (refreshBtn) refreshBtn.classList.remove("is-loading"); return; }
      lat = v[0]; lon = v[1]; locLabel = `${lat.toFixed(2)}, ${lon.toFixed(2)}`;
    } else {
      const c = pickRecentCenter();
      if (!c) { status.textContent = "No trip location found, pick custom lat/lon."; if (refreshBtn) refreshBtn.classList.remove("is-loading"); return; }
      lat = c[0]; lon = c[1]; locLabel = "most-used trip area";
    }
    status.textContent = "Fetching forecast…";
    try {
      const date = dateEl.value;
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}&hourly=temperature_2m&start_date=${date}&end_date=${date}&timezone=auto`;
      const r = await fetch(url);
      const j = await r.json();
      const times = (j.hourly && j.hourly.time) || [];
      const temps = (j.hourly && j.hourly.temperature_2m) || [];
      if (!temps.length) throw new Error("No hourly forecast for that date (max +14 days).");
      const [sh, sm] = startEl.value.split(":").map(Number);
      const [eh, em] = endEl.value.split(":").map(Number);
      const sMin = (sh || 0) * 60 + (sm || 0);
      const eMin = (eh || 0) * 60 + (em || 0);
      // Each hourly forecast at hour H represents the slot [H:00, H+1:00).
      // The ride window [sMin, eMin] overlaps with the slot if their ranges
      // intersect. If the end time is before the start (e.g. 23:30 → 01:15)
      // the window wraps midnight and we accept either side.
      const inRide = (h) => {
        const pS = h * 60, pE = (h + 1) * 60;
        if (eMin >= sMin) return pE > sMin && pS < eMin;
        return pE > sMin || pS < eMin;
      };
      let sum = 0, n = 0;
      const cells = [];
      for (let i = 0; i < temps.length; i++) {
        const h = Number(times[i].slice(11, 13));
        const inside = inRide(h);
        if (inside) { sum += temps[i]; n++; }
        cells.push({ h, t: temps[i], inRide: inside });
      }
      if (!n) { status.textContent = "Ride window outside forecast hours."; return; }
      const avg = sum / n;
      pendingWeather = { ambientC: avg, label: `${date} ${startEl.value}–${endEl.value} @ ${locLabel} (avg ${avg.toFixed(1)} °C)` };
      // Stash the cells so we can re-render highlighting without re-fetching.
      lastForecastCells = cells;
      renderForecastCells();
      status.textContent = "Click an hour to set start time. Press Apply to lock the temperature.";
      document.getElementById("calc-weather-apply").disabled = false;
    } catch (err) {
      console.warn("Forecast fetch failed:", err);
      status.textContent = "Couldn't fetch the forecast: " + (err.message || err);
    } finally {
      if (refreshBtn) refreshBtn.classList.remove("is-loading");
    }
  }
  // Re-render the forecast hour grid using the cached cells. Updates the
  // in-ride highlighting + the average based on the current start/end time
  // (which may have moved after a cell click).
  function renderForecastCells() {
    if (!lastForecastCells) return;
    const startEl = document.getElementById("calc-weather-start");
    const endEl = document.getElementById("calc-weather-end");
    const resultBox = document.getElementById("calc-weather-result");
    const [sh, sm] = startEl.value.split(":").map(Number);
    const [eh, em] = endEl.value.split(":").map(Number);
    const sMin = (sh || 0) * 60 + (sm || 0);
    const eMin = (eh || 0) * 60 + (em || 0);
    const inRide = (h) => {
      const pS = h * 60, pE = (h + 1) * 60;
      if (eMin >= sMin) return pE > sMin && pS < eMin;
      return pE > sMin || pS < eMin;
    };
    let sum = 0, n = 0;
    const cells = lastForecastCells.map((c) => {
      const inside = inRide(c.h);
      if (inside) { sum += c.t; n++; }
      return { ...c, inRide: inside };
    });
    lastForecastCells = cells;
    const avg = n ? sum / n : 0;
    if (n) {
      pendingWeather = { ambientC: avg, label: `${startEl.value}-${endEl.value} avg ${avg.toFixed(1)} °C` };
      document.getElementById("calc-weather-apply").disabled = false;
    }
    const cellsHtml = cells.map((c) => {
      const cls = ["wh-cell"];
      if (c.inRide) cls.push("in-ride");
      if (c.h === sh) cls.push("is-start");
      return `<div class="${cls.join(" ")}" data-hour="${c.h}" title="Set start time to ${String(c.h).padStart(2, "0")}:00"><div>${String(c.h).padStart(2, "0")}h</div><div>${UNITS.temp(c.t).toFixed(0)}${UNITS.tempUnit}</div></div>`;
    }).join("");
    resultBox.innerHTML = `<div>Average over ride window: <b style="color:#fff">${UNITS.temp(avg).toFixed(1)} ${UNITS.tempUnit}</b> (${n} ${n === 1 ? "hour" : "hours"})</div><div class="calc-weather-hours">${cellsHtml}</div>`;
    resultBox.querySelectorAll(".wh-cell").forEach((el) => {
      el.addEventListener("click", () => {
        const h = Number(el.dataset.hour);
        const startEl2 = document.getElementById("calc-weather-start");
        startEl2.value = `${String(h).padStart(2, "0")}:00`;
        // Move end time to match the new start if auto-end is on.
        syncEndTime();
        renderForecastCells();
      });
    });
  }
  function applyWeather() {
    if (!pendingWeather) return;
    weatherLocked = { ...pendingWeather };
    const tDisp = Math.round(UNITS.temp(weatherLocked.ambientC));
    calcEls.temp.min = String(Math.min(Number(calcEls.temp.min), tDisp - 5));
    calcEls.temp.max = String(Math.max(Number(calcEls.temp.max), tDisp + 5));
    calcEls.temp.value = String(tDisp);
    refreshLockUI();
    setCalcMode("calc");
    updateCalculator();
  }
  function resetWeather() {
    weatherLocked = null;
    pendingWeather = null;
    document.getElementById("calc-weather-apply").disabled = true;
    document.getElementById("calc-weather-result").innerHTML = '<div class="calc-weather-empty">Forecast preview will appear here.</div>';
    refreshLockUI();
    updateCalculator();
  }

  function refreshCalcButton() {
    if (!calcEls.btn) return;
    if (multiFit) {
      calcEls.btn.classList.remove("hidden");
      calcEls.btn.removeAttribute("disabled");
      calcEls.btn.title = `Range calculator. Pessimistic, neutral, optimistic forecast from your own history (n=${multiFit.n}, R²=${multiFit.r2.toFixed(2)}).`;
      wireCalculator();
    } else {
      // Keep the button visible so the user knows the feature exists,
      // but disable it and explain what's missing. Avoids the silent
      // disappearance that left users wondering where it went.
      calcEls.btn.classList.remove("hidden");
      calcEls.btn.setAttribute("disabled", "");
      const needed = 20;
      const have = dated.filter((m) => m.estRangeKm != null
        && m.avgMovingSpeed != null && m.avgMovingSpeed > 5
        && m.ambientC != null && m.climbM != null && m.distKm >= 2).length;
      calcEls.btn.title = `Range calculator unavailable: need ${needed} rides with range + speed + ambient + climb data, you have ${have}. Add weather (top right) so trips can contribute ambient temperature.`;
      if (calcEls.modal) calcEls.modal.classList.add("hidden");
    }
  }

  // ---------- Render pipeline ----------
  function renderAll() {
    if (!dated.length) return;
    refreshSubtitle();
    refreshScopeButton();
    speedCurveCache = undefined; // scope may have changed; rebuild on demand
    const minBattUse = Number(battMinSel.value);
    const minPerBin = Number(minBinSel.value);
    for (const m of dated) applyRangeGating(m, minBattUse);
    computeTempFit();
    computeSpeedFit();
    computeClimbFit();
    computeMultiFit();
    refreshCalcButton();

    const bins = makeBins(dated, groupSel.value);
    const rolling = rollingCheck.checked;

    renderLifetime();
    renderInsights();

    // Activity (cumulative + per-period distance).
    {
      const totalKm = bins.reduce((s, b) => s + b.trips.reduce((ss, m) => ss + m.distKm, 0), 0);
      document.getElementById("activity-meta").textContent =
        `${bins.length} groups · ${UNITS.dist(totalKm).toFixed(0)} ${UNITS.distUnit} total`;
      drawActivityChart(document.getElementById("chart-activity"), bins);
      // Headline numbers under the chart: biggest group + average pace.
      let peak = null;
      for (const b of bins) {
        const km = b.trips.reduce((s, m) => s + m.distKm, 0);
        if (km > 0 && (!peak || km > peak.km)) peak = { km, label: b.label };
      }
      const nonEmpty = bins.filter((b) => b.trips.length > 0).length;
      const parts = [];
      // No link on this one: 241 km in a month is a SUM across many trips,
      // pointing at a single ride misrepresents what's being said.
      if (peak) parts.push(`Biggest group: <b>${peak.label}</b> with <b>${UNITS.dist(peak.km).toFixed(0)}</b> ${UNITS.distUnit}`);
      if (nonEmpty) parts.push(`Active in <b>${nonEmpty}</b> of ${bins.length} groups (avg <b>${UNITS.dist(totalKm / nonEmpty).toFixed(0)}</b> ${UNITS.distUnit} per active group)`);
      setTakeaway("activity-takeaway", parts);
    }

    // 1. Range.
    {
      const usable = dated.filter((m) => m.estRangeKm != null).length;
      const meta = document.getElementById("range-meta");
      if (!usable) {
        setSectionEmpty("range", "No trips used at least " + minBattUse + "% battery. Lower the threshold, or these exports may carry no battery level.");
        meta.textContent = "";
        rangeTempHost.classList.add("hidden");
        setTakeaway("range-takeaway", []);
        setTakeaway("range-temp-takeaway", []);
      } else {
        setSectionActive("range");
        const rangeStats = binStats(bins, (m) => m.estRangeKm == null ? null : UNITS.dist(normalizedRange(m)), minPerBin);
        const series = [{
          stats: rangeStats,
          color: normalizeCheck.checked ? COLORS.rangeNorm : COLORS.range,
          label: normalizeCheck.checked ? "Est. range (20 °C norm.)" : "Est. full range",
          unit: UNITS.distUnit, band: true, dp: 1,
        }];
        drawTrendChart(document.getElementById("chart-range"), bins, series, { rolling, zeroBase: false, weatherGradient: weatherLoaded });
        let metaTxt = usable + " of " + dated.length + " trips usable";
        if (tempFit) {
          const slopeDisp = UNITS.dist(tempFit.slope) / (UNITS.imperial ? 1.8 : 1);
          metaTxt += ` · temp sensitivity ${fmtVal(slopeDisp, 2)} ${UNITS.distUnit}/${UNITS.tempUnit}`;
        }
        meta.textContent = metaTxt;
        // Takeaway: peak / trough range by group.
        const rangeMetric = (m) => m.estRangeKm == null ? null : UNITS.dist(normalizedRange(m));
        const { peak, trough } = statsPeakTrough(rangeStats, bins, null, rangeMetric);
        const trendParts = [];
        if (peak) trendParts.push(`Best range: <b>${peak.v.toFixed(0)} ${UNITS.distUnit}</b> in <b>${tripLink(peak.label, peak.tripIdx)}</b>`);
        if (trough && peak && trough.label !== peak.label) trendParts.push(`Lowest: <b>${trough.v.toFixed(0)} ${UNITS.distUnit}</b> in <b>${tripLink(trough.label, trough.tripIdx)}</b>`);
        if (!normalizeCheck.checked && !tempFit) trendParts.push('Enrich with weather to control for temperature');
        setTakeaway("range-takeaway", trendParts);
        if (weatherLoaded) {
          drawRangeTempScatter(document.getElementById("chart-range-temp"));
          // Same slope source as the Overview insight (multivariate when
          // available) so both places quote one number.
          const tempSlopeKm2 = multiFit ? multiFit.tempSlope : (tempFit ? tempFit.slope : null);
          if (tempSlopeKm2 != null) {
            const slopeDisp = UNITS.dist(tempSlopeKm2) / (UNITS.imperial ? 1.8 : 1);
            // Show the per-degree cost and the 10-degree headline so readers
            // who think in big swings get the practical number too.
            const perStep = Math.abs(slopeDisp);
            const tag = multiFit ? " (after factoring out speed + climb)" : "";
            setTakeaway("range-temp-takeaway", [
              `Each <b>1 ${UNITS.tempUnit}</b> colder costs about <b>${perStep.toFixed(2)} ${UNITS.distUnit}</b> of range${tag}`,
              `A <b>10 ${UNITS.tempUnit}</b> swing is worth <b>${(perStep * 10).toFixed(1)} ${UNITS.distUnit}</b>`,
            ]);
          } else {
            setTakeaway("range-temp-takeaway", ["Not enough trips with both battery use and ambient temp to fit a slope yet"]);
          }
        } else {
          rangeTempHost.classList.add("hidden");
          setTakeaway("range-temp-takeaway", []);
        }
        // Range vs avg riding speed. The chart's dashed yellow line is the
        // univariate fit (what the eye sees), but the takeaway reports the
        // multivariate slope (the conditional effect, holding temp+climb
        // constant) — that's the one with the right sign and magnitude.
        drawRangeSpeedScatter(document.getElementById("chart-range-speed"));
        const speedCostRows = computeSpeedCostRows();
        const speedSlopeKm = multiFit ? multiFit.speedSlope : (speedFit ? speedFit.slope : null);
        if (speedSlopeKm != null) {
          const slopeDisp = UNITS.dist(speedSlopeKm) / UNITS.speed(1);
          const sign = slopeDisp < 0 ? "loses" : "gains";
          const perStep = Math.abs(slopeDisp);
          const tag = multiFit ? " (after factoring out temperature + climb)" : "";
          const parts = [
            `Across whole trips, each <b>1 ${UNITS.speedUnit}</b> faster average ${sign} about <b>${perStep.toFixed(2)} ${UNITS.distUnit}</b> of range${tag}`,
          ];
          if (slopeDisp > 0) {
            parts.push(speedCostRows.length >= 3
              ? `That is trip mix, not free speed: a faster average means less time crawling. The in-ride chart below shows the real cost per band`
              : `That is trip mix, not free speed: a faster average usually means less time in the expensive stop-and-go zone`);
          } else {
            parts.push(`Going <b>5 ${UNITS.speedUnit}</b> harder is worth −<b>${(perStep * 5).toFixed(1)} ${UNITS.distUnit}</b>`);
          }
          setTakeaway("range-speed-takeaway", parts, slopeDisp < 0 ? "warn" : null);
        } else {
          setTakeaway("range-speed-takeaway", []);
        }

        // In-ride cost of speed: the segment-level curve that answers the
        // question the scatter above raises. Green bands are the cheapest
        // cruise, the tails show why crawling and hammering both cost range.
        if (drawSpeedCostBars(document.getElementById("chart-speed-cost"), speedCostRows)) {
          const bestIdx = speedCostRows.reduce((bi, r, i, a) => (r.pctPerKm < a[bi].pctPerKm ? i : bi), 0);
          const bestPct = speedCostRows[bestIdx].pctPerKm;
          let lo = bestIdx, hi = bestIdx;
          while (lo > 0 && speedCostRows[lo - 1].pctPerKm <= bestPct * 1.03) lo--;
          while (hi < speedCostRows.length - 1 && speedCostRows[hi + 1].pctPerKm <= bestPct * 1.03) hi++;
          const parts = [
            `Sweet spot: <b>${Math.round(UNITS.speed(speedCostRows[lo].from))}–${Math.round(UNITS.speed(speedCostRows[hi].to))} ${UNITS.speedUnit}</b>, a full charge is good for about <b>${Math.round(UNITS.dist(speedCostRows[bestIdx].rangeKm))} ${UNITS.distUnit}</b>`,
          ];
          if (lo > 0) {
            const slow = speedCostRows[0];
            parts.push(`Below <b>${Math.round(UNITS.speed(slow.to))} ${UNITS.speedUnit}</b> each ${UNITS.distUnit} costs <b>${Math.round((slow.pctPerKm / bestPct - 1) * 100)}%</b> more battery`);
          }
          if (hi < speedCostRows.length - 1) {
            const fast = speedCostRows[speedCostRows.length - 1];
            parts.push(`Above <b>${Math.round(UNITS.speed(fast.from))} ${UNITS.speedUnit}</b> drag adds <b>${Math.round((fast.pctPerKm / bestPct - 1) * 100)}%</b>`);
          }
          setTakeaway("speed-cost-takeaway", parts);
        } else {
          setTakeaway("speed-cost-takeaway", []);
        }

        // Range vs climb rate. Same logic: multivariate slope for the
        // takeaway, univariate for the visible fit line.
        drawRangeClimbScatter(document.getElementById("chart-range-climb"));
        const climbSlopeKmPerMperKm = multiFit ? multiFit.climbSlope : (climbFit ? climbFit.slope : null);
        if (climbSlopeKmPerMperKm != null) {
          const slope = UNITS.dist(climbSlopeKmPerMperKm) / (UNITS.imperial ? 3.28084 : 1);
          const perStep = Math.abs(slope);
          const unit = UNITS.imperial ? "ft/mi" : "m/km";
          const tag = multiFit ? " (after factoring out temperature + speed)" : "";
          setTakeaway("range-climb-takeaway", [
            `Each <b>1 ${unit}</b> of climbing costs about <b>${perStep.toFixed(3)} ${UNITS.distUnit}</b> of range${tag}`,
            `A <b>100 ${unit}</b> climb rate costs <b>${(perStep * 100).toFixed(1)} ${UNITS.distUnit}</b> of range`,
          ], slope < 0 ? "warn" : null);
        } else {
          setTakeaway("range-climb-takeaway", []);
        }
      }
    }

    // Distance distribution on Overview tab.
    {
      const dists = dated.map((m) => UNITS.dist(m.distKm)).filter((v) => v > 0);
      if (dists.length >= 5) {
        drawHistogram(document.getElementById("chart-dist-hist"), dists, {
          xLabel: UNITS.distUnit,
          yLabel: "trips",
          nBins: 18,
          colorTop: "rgba(179,136,255,0.9)",
          colorBot: "rgba(179,136,255,0.18)",
        });
        const sorted = dists.slice().sort((a, b) => a - b);
        const med = sorted[Math.floor(sorted.length / 2)];
        const p90 = sorted[Math.floor(sorted.length * 0.9)];
        const max = sorted[sorted.length - 1];
        // Resolve actual trips for the median / longest values so the takeaway
        // can link to the specific rides.
        const dateFmt2 = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" });
        const closestTo = (target) => dated.filter((m) => m.distKm > 0).reduce((best, m) => {
          const diff = Math.abs(UNITS.dist(m.distKm) - target);
          if (!best || diff < best.diff) return { m, diff };
          return best;
        }, null);
        const longestTrip = dated.filter((m) => m.distKm > 0).reduce((best, m) => (!best || m.distKm > best.distKm) ? m : best, null);
        const medTrip = closestTo(med)?.m;
        const longestLabel = longestTrip && longestTrip.date ? dateFmt2.format(longestTrip.date) : `${max.toFixed(1)} ${UNITS.distUnit}`;
        const medSuffix = medTrip && medTrip.date ? ` (e.g. ${tripLink(dateFmt2.format(medTrip.date), medTrip.tripIdx)})` : "";
        setTakeaway("dist-hist-takeaway", [
          `Median ride: <b>${med.toFixed(1)} ${UNITS.distUnit}</b>${medSuffix}`,
          `Top 10% beyond: <b>${p90.toFixed(1)} ${UNITS.distUnit}</b>`,
          `Longest: <b>${max.toFixed(1)} ${UNITS.distUnit}</b>` + (longestTrip ? ` on <b>${tripLink(longestLabel, longestTrip.tripIdx)}</b>` : ""),
        ]);
        document.getElementById("dist-hist-meta").textContent = dists.length + " trips";
      } else {
        setTakeaway("dist-hist-takeaway", []);
      }
    }

    // Charging section.
    {
      const meta = document.getElementById("charging-meta");
      if (!charges.length) {
        setSectionEmpty("charging", "No charging events detected. Either you charge after every trip (so no battery jump between rides) or trips lack battery data.");
        meta.textContent = "";
        setTakeaway("charging-takeaway", []);
        setTakeaway("charge-window-takeaway", []);
      } else {
        setSectionActive("charging");
        meta.textContent = charges.length + " charges detected";
        // Count charges per calendar/cumulative bin
        const perBin = bins.map((b) => 0);
        for (const c of charges) {
          for (let i = 0; i < bins.length; i++) {
            // Match by date for calendar bins; for cumulative bins, match by trip membership.
            // Trips already carry their bin assignment via the dated array, so we use date overlap.
            const tripsInBin = bins[i].trips;
            if (!tripsInBin.length) continue;
            // The charge is attributed to cur.date; find which bin holds a trip on that day.
            const matchingTrip = tripsInBin.find((m) => m.date && c.date && m.date.getTime() === c.date.getTime());
            if (matchingTrip) { perBin[i]++; break; }
          }
        }
        drawChargesBar(document.getElementById("chart-charges"), bins, perBin);
        // Aggregates
        const totalCharged = charges.reduce((s, c) => s + c.gain, 0);
        const gentle = charges.filter((c) => c.from > 50).length;
        const deep = charges.filter((c) => c.from <= 20).length;
        const medGain = median(charges.map((c) => c.gain));
        const medFrom = median(charges.map((c) => c.from));
        const medTo = median(charges.map((c) => c.to));
        // Express the cumulative % as "equivalent full charges" because
        // "2475%" reads as a typo without context.
        const fullCharges = (totalCharged / 100).toFixed(1);
        setTakeaway("charging-takeaway", [
          `Typical top-up: <b>${medFrom.toFixed(0)}%</b> &rarr; <b>${medTo.toFixed(0)}%</b> (adds <b>${medGain.toFixed(0)}%</b>)`,
          `<b>${charges.length}</b> sessions logged &middot; total energy added ≈ <b>${fullCharges}</b> full charges`,
          `<b>${gentle}</b> gentle (from &gt;50%) &middot; <b>${deep}</b> deep (from &le;20%)`,
        ], deep > gentle ? "warn" : null);
        drawChargeWindows(document.getElementById("chart-charge-window"), charges);
        // Trailing window of recent charges as the takeaway
        const recent = charges.slice(-10);
        const recentMedFrom = median(recent.map((c) => c.from));
        const recentMedTo = median(recent.map((c) => c.to));
        setTakeaway("charge-window-takeaway", [
          `Last 10 charges: typically <b>${recentMedFrom.toFixed(0)}%</b> &rarr; <b>${recentMedTo.toFixed(0)}%</b>`,
          `Lowest start of any charge: <b>${Math.min.apply(null, charges.map((c) => c.from)).toFixed(0)}%</b>`,
        ]);
      }
    }

    // Speed section: top-speed trend + speed distribution.
    {
      const meta = document.getElementById("speed-meta");
      const tops = dated.map((m) => m.topSpeedKmh).filter((v) => v != null);
      if (tops.length < 5) {
        setSectionEmpty("speed", "Not enough trips with top-speed data.");
        meta.textContent = "";
        setTakeaway("topspeed-takeaway", []);
        setTakeaway("speed-hist-takeaway", []);
      } else {
        setSectionActive("speed");
        meta.textContent = tops.length + " trips with top-speed data";
        drawTopSpeedChart(document.getElementById("chart-topspeed"), bins);
        const lifeTop = Math.max.apply(null, tops);
        const lifeTopTrip = dated.find((m) => m.topSpeedKmh === lifeTop);
        const medTop = median(tops);
        const lifeTopLabel = lifeTopTrip && lifeTopTrip.date
          ? new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(lifeTopTrip.date)
          : null;
        setTakeaway("topspeed-takeaway", [
          `All-time top: <b>${UNITS.speed(lifeTop).toFixed(1)} ${UNITS.speedUnit}</b>` +
            (lifeTopLabel ? ` on <b>${tripLink(lifeTopLabel, lifeTopTrip ? lifeTopTrip.tripIdx : null)}</b>` : ""),
          `Median peak per ride: <b>${UNITS.speed(medTop).toFixed(1)} ${UNITS.speedUnit}</b>`,
        ]);
        // Speed histogram
        const topsDisp = tops.map((v) => UNITS.speed(v));
        drawHistogram(document.getElementById("chart-speed-hist"), topsDisp, {
          xLabel: UNITS.speedUnit,
          yLabel: "trips",
          nBins: 16,
          colorTop: "rgba(255,82,82,0.9)",
          colorBot: "rgba(255,82,82,0.18)",
        });
        const sorted = topsDisp.slice().sort((a, b) => a - b);
        const p25 = sorted[Math.floor(sorted.length * 0.25)];
        const p75 = sorted[Math.floor(sorted.length * 0.75)];
        const lifeTopDisp = UNITS.speed(lifeTop);
        setTakeaway("speed-hist-takeaway", [
          `Comfort zone: <b>${p25.toFixed(0)}</b>&ndash;<b>${p75.toFixed(0)} ${UNITS.speedUnit}</b>`,
          `Hot threshold (max ever): <b>${lifeTopDisp.toFixed(1)} ${UNITS.speedUnit}</b>`,
        ]);
      }
    }

    // Acceleration trend: pick whichever threshold (25 / 40 / 60 km/h) the
    // user actually hits often. 25 km/h is the universal floor; the 40 / 60
    // numbers tag along in the takeaway when achievable.
    {
      const meta = document.getElementById("accel-meta");
      const usable25 = dated.filter((m) => m.accel25 != null).length;
      const usable40 = dated.filter((m) => m.accel40 != null).length;
      const usable60 = dated.filter((m) => m.accel60 != null).length;
      const useTarget = usable40 >= 10 ? 40 : (usable25 >= 5 ? 25 : null);
      if (!useTarget) {
        setSectionEmpty("accel", "Not enough trips with valid acceleration runs to compute a trend.");
        meta.textContent = "";
        setTakeaway("accel40-takeaway", []);
      } else {
        setSectionActive("accel");
        const field = useTarget === 40 ? "accel40" : "accel25";
        const usable = useTarget === 40 ? usable40 : usable25;
        // Thresholds are defined in km/h; show them in the user's units
        // (40 km/h reads as 25 mph for imperial riders).
        const spdLabel = (kmh) => `${Math.round(UNITS.speed(kmh))} ${UNITS.speedUnit}`;
        meta.textContent = `${usable} trips with 0 to ${spdLabel(useTarget)} runs`;
        const stats = binStats(bins, (m) => m[field], minPerBin);
        const series = [{
          stats, color: "#ffd740",
          label: "Best 0 to " + spdLabel(useTarget),
          unit: "s", band: true, dp: 2,
        }];
        drawTrendChart(document.getElementById("chart-accel40"), bins, series, { rolling });
        const dateFmt = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" });
        const parts = [];
        const findFastest = (field) => {
          const trip = dated.filter((m) => m[field] != null).sort((a, b) => a[field] - b[field])[0];
          return trip ? { v: trip[field], idx: trip.tripIdx, date: trip.date } : null;
        };
        if (usable25) {
          const all = dated.map((m) => m.accel25).filter((v) => v != null).sort((a, b) => a - b);
          const med = all[Math.floor(all.length / 2)];
          const f = findFastest("accel25");
          parts.push(`Fastest 0&hairsp;&rarr;&hairsp;${spdLabel(25)}: <b>${f.v.toFixed(2)} s</b>` + (f.date ? ` on <b>${tripLink(dateFmt.format(f.date), f.idx)}</b>` : ""));
          parts.push(`Typical: <b>${med.toFixed(2)} s</b>`);
        }
        if (usable40) {
          const f = findFastest("accel40");
          parts.push(`Fastest 0&hairsp;&rarr;&hairsp;${spdLabel(40)}: <b>${f.v.toFixed(2)} s</b>` + (f.date ? ` on <b>${tripLink(dateFmt.format(f.date), f.idx)}</b>` : ""));
        }
        if (usable60) {
          const f = findFastest("accel60");
          parts.push(`Fastest 0&hairsp;&rarr;&hairsp;${spdLabel(60)}: <b>${f.v.toFixed(2)} s</b>` + (f.date ? ` on <b>${tripLink(dateFmt.format(f.date), f.idx)}</b>` : ""));
        }
        setTakeaway("accel40-takeaway", parts);
      }
    }

    // Anomalies: list every free spin, fall, or logger glitch.
    {
      const events = [];
      for (const m of dated) {
        for (const ev of m.anomalies || []) {
          events.push({ ...ev, date: m.date, label: m.label, tripIdx: m.tripIdx });
        }
      }
      const meta = document.getElementById("anomalies-meta");
      const list = document.getElementById("anomalies-list");
      const falls = events.filter((e) => e.kind === "fall");
      const lifts = events.filter((e) => e.kind === "lift");
      const glitches = events.filter((e) => e.kind === "glitch");
      const spikes = events.filter((e) => e.kind === "spike");
      meta.textContent = events.length + " events (" + lifts.length + " lifts / " + falls.length + " falls / " + spikes.length + " sensor spikes / " + glitches.length + " logger glitches)";
      setTakeaway("anomalies-takeaway", events.length ? [
        `Lifts / pickup tests: <b>${lifts.length}</b>`,
        `Suspected falls: <b>${falls.length}</b>`,
        `Sensor spikes during riding: <b>${spikes.length}</b>`,
        `Logger glitches: <b>${glitches.length}</b>`,
      ] : ["No anomaly samples detected"], falls.length > 0 ? "warn" : null);
      // Render most recent 200 lifts + falls (the rider-event types).
      const riderEvents = events.filter((e) => e.kind === "lift" || e.kind === "fall");
      riderEvents.sort((a, b) => (b.date?.getTime() || 0) - (a.date?.getTime() || 0));
      const top = riderEvents.slice(0, 200);
      const fmt = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" });
      list.innerHTML = top.map((e) => {
        const peak = UNITS.speed(e.peakSpd).toFixed(0);
        const dur = e.durS != null ? e.durS.toFixed(1) : "—";
        // Link to the inspector with a small offset so the playback starts
        // a few seconds before the event (so the user sees the lead-in).
        const startSec = Math.max(0, (e.sec || 0) - 6);
        const dateLabel = e.date ? fmt.format(e.date) : "?";
        const dateHtml = e.tripIdx != null
          ? `<a class="anom-link" href="inspector.html?i=${e.tripIdx}&t=${startSec}" target="_blank" rel="noopener" title="Open this ride in the inspector starting 6 s before the event">${dateLabel}</a>`
          : dateLabel;
        return `<div class="anomaly-row ${e.kind}">` +
          `<span class="anom-kind">${e.kind.toUpperCase()}</span>` +
          `<span class="anom-date">${dateHtml}</span>` +
          `<span class="anom-peak">${peak} ${UNITS.speedUnit}</span>` +
          `<span style="color:#888">${dur}s</span>` +
        `</div>`;
      }).join("");
    }

    // Wheel vs GPS speed diagnostic.
    {
      const meta = document.getElementById("gpsdelta-meta");
      const usable = dated.filter((m) => m.gpsMeanAbsDiff != null).length;
      if (usable < 3) {
        setSectionEmpty("gpsdelta", "Not enough trips with both wheel speed and GPS speed to compare.");
        meta.textContent = "";
        setTakeaway("gpsdelta-trend-takeaway", []);
        setTakeaway("gpsdelta-lag-takeaway", []);
        setTakeaway("gpsdelta-hist-takeaway", []);
      } else {
        setSectionActive("gpsdelta");
        const totalSamples = dated.reduce((s, m) => s + (m.gpsAgreementSamples || 0), 0);
        const totalSpikes = dated.reduce((s, m) => s + (m.gpsSpikeCount || 0), 0);
        meta.textContent = usable + " trips · " + totalSamples.toLocaleString() + " comparable samples · " + totalSpikes + " spikes";
        // Trend: typical disagreement
        const diffStats = binStats(bins, (m) => m.gpsMeanAbsDiff, minPerBin);
        drawTrendChart(document.getElementById("chart-gpsdelta-trend"), bins, [{
          stats: diffStats, color: "#7cc7ff", label: "Typical |wheel − GPS|", unit: "km/h", band: true, dp: 2,
        }], { rolling, zeroBase: true });
        const { peak: dPeak, trough: dTrough } = statsPeakTrough(diffStats, bins, null, (m) => m.gpsMeanAbsDiff);
        const allDiffs = dated.map((m) => m.gpsMeanAbsDiff).filter((v) => v != null);
        const allBias = dated.map((m) => m.gpsMeanDiff).filter((v) => v != null);
        const sortedDiffs = allDiffs.slice().sort((a, b) => a - b);
        const medDiff = sortedDiffs[Math.floor(sortedDiffs.length / 2)];
        const sortedBias = allBias.slice().sort((a, b) => a - b);
        const medBias = sortedBias[Math.floor(sortedBias.length / 2)];
        const trendParts = [
          `Typical gap: <b>${medDiff.toFixed(2)} km/h</b>`,
          `Wheel reads <b>${Math.abs(medBias).toFixed(2)} km/h ${medBias >= 0 ? "higher" : "lower"}</b> than GPS on average`,
        ];
        if (dPeak && dTrough && dPeak.label !== dTrough.label) {
          trendParts.push(`Best: <b>${dTrough.v.toFixed(2)}</b> in <b>${tripLink(dTrough.label, dTrough.tripIdx)}</b> · worst: <b>${dPeak.v.toFixed(2)}</b> in <b>${tripLink(dPeak.label, dPeak.tripIdx)}</b>`);
        }
        setTakeaway("gpsdelta-trend-takeaway", trendParts);

        // Trend: GPS lag (signed)
        const lagStats = binStats(bins, (m) => m.gpsLagSec, minPerBin);
        drawTrendChart(document.getElementById("chart-gpsdelta-lag"), bins, [{
          stats: lagStats, color: "#ffd740", label: "GPS lag", unit: "s", band: true, dp: 2,
        }], { rolling });
        const allLags = dated.map((m) => m.gpsLagSec).filter((v) => v != null);
        if (allLags.length) {
          // Mean is more meaningful than median here because individual trips
          // round to a few sub-sample values; mean recovers the central trend.
          const meanLag = allLags.reduce((a, b) => a + b, 0) / allLags.length;
          const absLags = allLags.map(Math.abs).sort((a, b) => a - b);
          const medAbs = absLags[Math.floor(absLags.length / 2)];
          const p90Abs = absLags[Math.floor(absLags.length * 0.9)];
          const parts = [];
          if (Math.abs(meanLag) < 0.15) {
            parts.push(`On average GPS and wheel are <b>essentially in sync</b> (mean offset ${meanLag >= 0 ? "+" : ""}<b>${meanLag.toFixed(2)} s</b>)`);
          } else {
            parts.push(`On average GPS arrives <b>${Math.abs(meanLag).toFixed(2)} s ${meanLag > 0 ? "behind" : "ahead of"}</b> the wheel reading`);
          }
          parts.push(`Per-trip offset is typically <b>${medAbs.toFixed(2)} s</b>, top 10% beyond <b>${p90Abs.toFixed(2)} s</b>`);
          const sortedByDate = dated.filter((m) => m.gpsLagSec != null).slice().sort((a, b) => a.date - b.date);
          if (sortedByDate.length >= 12) {
            const third = Math.floor(sortedByDate.length / 3);
            const earlyAbs = sortedByDate.slice(0, third).map((m) => Math.abs(m.gpsLagSec)).reduce((a, b) => a + b, 0) / third;
            const lateAbs  = sortedByDate.slice(-third).map((m) => Math.abs(m.gpsLagSec)).reduce((a, b) => a + b, 0) / third;
            const change = ((lateAbs - earlyAbs) / Math.max(0.01, earlyAbs)) * 100;
            if (Math.abs(change) >= 15) {
              parts.push(`Offset has ${change < 0 ? "tightened" : "widened"} by <b>${Math.abs(change).toFixed(0)}%</b> from your first third to your last third`);
            } else {
              parts.push("Offset is stable across your history");
            }
          }
          setTakeaway("gpsdelta-lag-takeaway", parts);
        } else {
          setTakeaway("gpsdelta-lag-takeaway", []);
        }

        // Histogram of per-trip mean |wheel − GPS|
        drawHistogram(document.getElementById("chart-gpsdelta-hist"), allDiffs, {
          xLabel: "km/h", yLabel: "trips", nBins: 16,
          colorTop: "rgba(124,199,255,0.9)", colorBot: "rgba(124,199,255,0.18)",
        });
        const p25 = sortedDiffs[Math.floor(sortedDiffs.length * 0.25)];
        const p75 = sortedDiffs[Math.floor(sortedDiffs.length * 0.75)];
        const max = sortedDiffs[sortedDiffs.length - 1];
        const worstTrip = dated.find((m) => m.gpsMeanAbsDiff === max);
        setTakeaway("gpsdelta-hist-takeaway", [
          `Most rides land in the <b>${p25.toFixed(2)} − ${p75.toFixed(2)} km/h</b> band`,
          `Worst trip: <b>${max.toFixed(2)} km/h</b> typical gap` +
            (worstTrip ? ` on <b>${tripLink(worstTrip.label, worstTrip.tripIdx)}</b>` : ""),
        ]);
      }
    }

    // G-Force section: now scored only on real maneuvers (corners, hard
    // brakes, hard launches). A pothole spike or a pickup test no longer
    // shows up as your "peak G".
    {
      const meta = document.getElementById("gforce-meta");
      let totalCorners = 0, totalBrakes = 0, totalLaunches = 0;
      for (const m of dated) {
        if (!m.gforceCounts) continue;
        totalCorners += m.gforceCounts.corners;
        totalBrakes += m.gforceCounts.brakes;
        totalLaunches += m.gforceCounts.launches;
      }
      const usable = dated.filter((m) => m.gLatPeak != null || m.gLongPeak != null).length;
      if (usable < 3 || (totalCorners + totalBrakes + totalLaunches) === 0) {
        setSectionEmpty("gforce", "No real cornering or braking maneuvers found yet. Need rides with GPS at speed.");
        meta.textContent = "";
        setTakeaway("gforce-trend-takeaway", []);
        setTakeaway("gforce-hist-takeaway", []);
        setTakeaway("grip-takeaway", []);
      } else {
        setSectionActive("gforce");
        const anyImu = dated.some((m) => m.gFromImu);
        meta.textContent = usable + " trips · " + totalCorners + " corners · " + totalBrakes + " hard brakes · " + totalLaunches + " launches · " + (anyImu ? "IMU" : "GPS-estimated");
        // Trend: lateral peak (from corners) + longitudinal peak (brake/launch)
        const latStats = binStats(bins, (m) => m.gLatPeak, minPerBin);
        const lngStats = binStats(bins, (m) => m.gLongPeak, minPerBin);
        drawTrendChart(document.getElementById("chart-gforce-trend"), bins, [
          { stats: latStats, color: "#ff5252", label: "Cornering G", unit: "G", band: false, dp: 2 },
          { stats: lngStats, color: "#ffd740", label: "Brake / launch G", unit: "G", band: false, dp: 2 },
        ], { rolling });
        const allLat = dated.map((m) => m.gLatPeak).filter((v) => v != null);
        const allLng = dated.map((m) => m.gLongPeak).filter((v) => v != null);
        allLat.sort((a, b) => b - a);
        allLng.sort((a, b) => b - a);
        const dateFmt = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" });
        const latTrip = allLat.length ? dated.find((m) => m.gLatPeak === allLat[0]) : null;
        const lngTrip = allLng.length ? dated.find((m) => m.gLongPeak === allLng[0]) : null;
        const trendParts = [];
        if (allLat.length) trendParts.push(`Hardest cornering G: <b>${allLat[0].toFixed(2)} G</b>` + (latTrip && latTrip.date ? ` on <b>${tripLink(dateFmt.format(latTrip.date), latTrip.tripIdx)}</b>` : ""));
        if (allLng.length) trendParts.push(`Hardest braking / launch G: <b>${allLng[0].toFixed(2)} G</b>` + (lngTrip && lngTrip.date ? ` on <b>${tripLink(dateFmt.format(lngTrip.date), lngTrip.tripIdx)}</b>` : ""));
        if (!anyImu) trendParts.push("Source: <b>GPS-estimated</b> centripetal G");
        setTakeaway("gforce-trend-takeaway", trendParts);
        // Histogram of peak corner G across trips
        if (allLat.length >= 5) {
          drawHistogram(document.getElementById("chart-gforce-hist"), allLat, {
            xLabel: "G", yLabel: "trips", nBins: 12,
            colorTop: "rgba(255,82,82,0.9)", colorBot: "rgba(255,82,82,0.18)",
          });
          const sortedAsc = allLat.slice().sort((a, b) => a - b);
          const med = sortedAsc[Math.floor(sortedAsc.length / 2)];
          const p90 = sortedAsc[Math.floor(sortedAsc.length * 0.9)];
          setTakeaway("gforce-hist-takeaway", [
            `Typical hardest corner per ride: <b>${med.toFixed(2)} G</b>`,
            `Top 10% beyond: <b>${p90.toFixed(2)} G</b>`,
            `Hardest ever: <b>${sortedAsc[sortedAsc.length - 1].toFixed(2)} G</b>` +
              (latTrip ? ` on <b>${tripLink(latTrip.label, latTrip.tripIdx)}</b>` : ""),
          ]);
        } else {
          setTakeaway("gforce-hist-takeaway", []);
        }
        // Grip envelope: one dot per detected corner (avg speed, peak lat G).
        const grip = [];
        for (const m of dated) {
          if (!m.gripScatter || !m.gripScatter.length) continue;
          for (const [spd, latG] of m.gripScatter) {
            grip.push({
              x: UNITS.speed(spd),
              y: latG,
              epoch: m.epoch,
              label: m.label,
              tripIdx: m.tripIdx,
              meta: `<b>${m.label}</b><br>Avg speed in corner: <b>${fmtVal(UNITS.speed(spd), 1)}</b> ${UNITS.speedUnit}<br>Peak lateral G: <b>${latG.toFixed(2)}</b>`,
            });
          }
        }
        const gripHost = document.getElementById("grip-host");
        if (grip.length >= 8) {
          gripHost.classList.remove("hidden");
          drawScatter(document.getElementById("chart-grip"), grip, {
            xLabel: "corner speed (" + UNITS.speedUnit + ")", yLabel: "lateral G",
          });
          // "Best grip" = highest lateral G held in a corner, with the speed.
          let best = grip[0];
          for (const g of grip) if (g.y > best.y) best = g;
          // "Fastest gripping corner" = highest speed where lat G ≥ 0.3
          let fastestGrip = null;
          for (const g of grip) {
            if (g.y >= 0.3 && (!fastestGrip || g.x > fastestGrip.x)) fastestGrip = g;
          }
          const parts = [
            `Hardest held: <b>${best.y.toFixed(2)} G</b> at <b>${best.x.toFixed(0)} ${UNITS.speedUnit}</b>` +
              (best.tripIdx != null ? ` on <b>${tripLink(best.label, best.tripIdx)}</b>` : ""),
            `<b>${grip.length}</b> sustained corners across <b>${dated.filter((m) => m.gripScatter && m.gripScatter.length).length}</b> rides`,
          ];
          if (fastestGrip) {
            parts.push(`Fastest hard corner (≥0.3 G): <b>${fastestGrip.x.toFixed(0)} ${UNITS.speedUnit}</b>` +
              (fastestGrip.tripIdx != null ? ` on <b>${tripLink(fastestGrip.label, fastestGrip.tripIdx)}</b>` : ""));
          }
          setTakeaway("grip-takeaway", parts);
        } else {
          gripHost.classList.add("hidden");
          setTakeaway("grip-takeaway", []);
        }
      }
    }

    // 2. Efficiency.
    {
      const hasWh = dated.some((m) => m.whPerKm != null);
      const hasKmPct = dated.some((m) => m.kmPerPct != null);
      const meta = document.getElementById("efficiency-meta");
      if (!hasWh && !hasKmPct) {
        setSectionEmpty("efficiency", "These exports carry no power/current or battery columns, so efficiency can't be computed.");
        meta.textContent = "";
        setTakeaway("efficiency-takeaway", []);
      } else {
        setSectionActive("efficiency");
        const series = [];
        let whStats = null;
        if (hasWh) {
          whStats = binStats(bins, (m) => m.whPerKm == null ? null : m.whPerKm / UNITS.dist(1), minPerBin);
          series.push({
            stats: whStats,
            color: COLORS.whPerKm, label: "Wh/" + UNITS.distUnit, unit: "Wh/" + UNITS.distUnit, band: true, dp: 1,
          });
        }
        if (hasKmPct) series.push({
          stats: binStats(bins, (m) => m.kmPerPct == null ? null : UNITS.dist(m.kmPerPct), minPerBin),
          color: COLORS.kmPerPct, label: UNITS.distUnit + "/%", unit: UNITS.distUnit + "/%", band: false, dp: 2,
        });
        drawTrendChart(document.getElementById("chart-efficiency"), bins, series, { rolling });
        meta.textContent = "";
        if (whStats) {
          const whMetric = (m) => m.whPerKm == null ? null : m.whPerKm / UNITS.dist(1);
          const { peak, trough } = statsPeakTrough(whStats, bins, null, whMetric);
          const parts = [];
          if (peak && trough && peak.label !== trough.label) {
            parts.push(`Best: <b>${trough.v.toFixed(1)} Wh/${UNITS.distUnit}</b> in <b>${tripLink(trough.label, trough.tripIdx)}</b>`);
            parts.push(`Worst: <b>${peak.v.toFixed(1)} Wh/${UNITS.distUnit}</b> in <b>${tripLink(peak.label, peak.tripIdx)}</b>`);
          }
          setTakeaway("efficiency-takeaway", parts);
        }
        // Power-draw histogram (host hidden when the exports carry no power)
        const powers = dated.map((m) => m.avgPower).filter((v) => v != null && v > 0);
        const powerHost = document.getElementById("power-hist-host");
        if (powerHost) powerHost.classList.toggle("hidden", powers.length < 5);
        if (powers.length >= 5) {
          drawHistogram(document.getElementById("chart-power-hist"), powers, {
            xLabel: "W",
            yLabel: "trips",
            nBins: 16,
            colorTop: "rgba(124,77,255,0.9)",
            colorBot: "rgba(124,77,255,0.18)",
          });
          const sortedP = powers.slice().sort((a, b) => a - b);
          const medP = sortedP[Math.floor(sortedP.length / 2)];
          const p90P = sortedP[Math.floor(sortedP.length * 0.9)];
          const maxP = sortedP[sortedP.length - 1];
          const hardTrip = dated.reduce((best, m) =>
            (m.avgPower != null && (!best || m.avgPower > best.avgPower)) ? m : best, null);
          setTakeaway("power-hist-takeaway", [
            `Median ride pulls <b>${medP.toFixed(0)} W</b>`,
            `Top 10% beyond: <b>${p90P.toFixed(0)} W</b>`,
            `Hardest ride: <b>${maxP.toFixed(0)} W</b> avg` +
              (hardTrip ? ` on <b>${tripLink(hardTrip.label, hardTrip.tripIdx)}</b>` : ""),
          ]);
        } else {
          setTakeaway("power-hist-takeaway", []);
        }
      }
    }

    // 2a. Cost of standing still: battery per hour at walking-and-below
    // paces, standstill from long stops so gauge rebound can't fake it.
    {
      const rows = computeIdleCostRows();
      if (drawIdleCostBars(document.getElementById("chart-idle-cost"), rows)) {
        const cruise = rows.find((r) => r.key === "cruise");
        const stopped = rows.find((r) => r.key === "stopped");
        const walk = rows.find((r) => r.key === "walk");
        const parts = [];
        const cruisePctPerKm = cruise ? cruise.pctPerH / cruise.midKmh : null;
        const cruiseBand = `${Math.round(UNITS.speed(20))}–${Math.round(UNITS.speed(30))} ${UNITS.speedUnit}`;
        if (stopped && cruisePctPerKm > 0) {
          if (stopped.pctPerH < 0.2) {
            // Gauge rebound eats the signal: the honest answer is a bound.
            const kmBound = UNITS.dist(0.2 / cruisePctPerKm).toFixed(1);
            parts.push(`Standing still is effectively free: under <b>0.2%</b> per hour, less than <b>${kmBound} ${UNITS.distUnit}</b> of range at cruise pace (${cruiseBand})`);
          } else {
            const kmEquiv = stopped.pctPerH / cruisePctPerKm;
            parts.push(`An hour of standing costs about <b>${stopped.pctPerH.toFixed(1)}%</b>, roughly <b>${UNITS.dist(kmEquiv).toFixed(1)} ${UNITS.distUnit}</b> of range at cruise pace (${cruiseBand})`);
          }
        }
        if (walk && cruisePctPerKm > 0) {
          const walkPctPerKm = walk.pctPerH / walk.midKmh;
          const ratio = walkPctPerKm / cruisePctPerKm;
          if (ratio >= 0.7 && ratio <= 1.6) {
            parts.push(`Walking the wheel costs about as much per ${UNITS.distUnit} as cruising at ${cruiseBand} (<b>${(walkPctPerKm / UNITS.dist(1)).toFixed(2)}</b> vs <b>${(cruisePctPerKm / UNITS.dist(1)).toFixed(2)} %/${UNITS.distUnit}</b>)`);
          } else {
            parts.push(`Walking the wheel: <b>${walk.pctPerH.toFixed(1)} %/h</b>, ${ratio > 1.6 ? "pricier" : "cheaper"} per ${UNITS.distUnit} than cruising at ${cruiseBand}`);
          }
        }
        setTakeaway("idle-cost-takeaway", parts);
      } else {
        setTakeaway("idle-cost-takeaway", []);
      }
    }

    // 2b. Regen: trend, descent scatter, share histogram.
    {
      const tripsWithRegen = dated.filter((m) => m.driveWh != null && m.driveWh > 0);
      const meta = document.getElementById("regen-meta");
      if (tripsWithRegen.length < 5) {
        // Tell the user exactly what's missing: "0 of 276" means the export's
        // Current/Power columns are empty, not that the history is too short.
        const msg = tripsWithRegen.length === 0
          ? `None of the ${dated.length} loaded trips carry motor current or power samples ` +
            `(the export's Current/Power columns are empty), so drive vs regen can't be split. ` +
            `If your wheel reports amps, check the logger app's export settings.`
          : `Only ${tripsWithRegen.length} of ${dated.length} trips carry sample-level power data; ` +
            `at least 5 are needed to split drive vs regen.`;
        setSectionEmpty("regen", msg);
        if (meta) meta.textContent = "";
        setTakeaway("regen-trend-takeaway", []);
        setTakeaway("regen-scatter-takeaway", []);
        setTakeaway("regen-hist-takeaway", []);
      } else {
        setSectionActive("regen");
        // Lifetime totals so the takeaway can say "9.6% of all energy".
        let totDrive = 0, totRegen = 0;
        for (const m of tripsWithRegen) { totDrive += m.driveWh; totRegen += m.regenWh; }
        const lifetimePct = totDrive > 0 ? (totRegen / totDrive) * 100 : 0;
        if (meta) meta.textContent = `${tripsWithRegen.length} trips · ${totRegen.toFixed(0)} Wh recovered of ${totDrive.toFixed(0)} Wh drawn`;

        // Trend: median regen % per group.
        const regenStats = binStats(bins, (m) => (m.driveWh != null && m.driveWh > 0) ? m.regenPct : null, minPerBin);
        const trendSeries = [{
          stats: regenStats,
          color: "rgba(105,240,174,0.95)",
          label: "regen %",
          unit: "%",
          band: true, dp: 1,
        }];
        drawTrendChart(document.getElementById("chart-regen-trend"), bins, trendSeries, { rolling });
        const regenMetric = (m) => (m.driveWh != null && m.driveWh > 0) ? m.regenPct : null;
        const { peak, trough } = statsPeakTrough(regenStats, bins, null, regenMetric);
        const trendParts = [];
        trendParts.push(`Lifetime: <b>${lifetimePct.toFixed(1)}%</b> of drive energy recovered`);
        if (peak && trough && peak.label !== trough.label) {
          trendParts.push(`Best month: <b>${peak.v.toFixed(1)}%</b> in <b>${tripLink(peak.label, peak.tripIdx)}</b>`);
          trendParts.push(`Lowest: <b>${trough.v.toFixed(1)}%</b> in <b>${tripLink(trough.label, trough.tripIdx)}</b>`);
        }
        setTakeaway("regen-trend-takeaway", trendParts);

        // Scatter: descent vs regen recovered.
        const pts = [];
        for (const m of tripsWithRegen) {
          const descent = m.descentM || 0;
          if (descent <= 0 && m.regenWh <= 0) continue;
          pts.push({
            x: UNITS.alt(descent),
            y: m.regenWh,
            epoch: m.epoch,
            meta: `<b>${m.label}</b><br>Descent: <b>${fmtVal(UNITS.alt(descent), 0)}</b> ${UNITS.altUnit}` +
                  `<br>Regen: <b>${fmtVal(m.regenWh, 0)}</b> Wh` +
                  `<br>Drive: <b>${fmtVal(m.driveWh, 0)}</b> Wh` +
                  `<br>Share: <b>${fmtVal(m.regenPct, 1)}</b>%`,
          });
        }
        if (pts.length >= 5) {
          drawScatter(document.getElementById("chart-regen-scatter"), pts, {
            xLabel: "descent (" + UNITS.altUnit + ")",
            yLabel: "regen recovered (Wh)",
          });
          const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
          const fit = theilSen(xs, ys);
          const scatterParts = [];
          if (fit) {
            scatterParts.push(`<b>${fit.slope.toFixed(2)} Wh</b> recovered per ${UNITS.altUnit} descended`);
          }
          // Find a peak-regen trip to make the chart memorable. The trip name
          // itself becomes the link so the line still reads like a report
          // sentence — no "view →" suffix.
          const sortedByPct = tripsWithRegen.slice().sort((a, b) => b.regenPct - a.regenPct);
          const topTrip = sortedByPct[0];
          if (topTrip && topTrip.regenPct >= 10) {
            scatterParts.push(`Best ride: <b>${topTrip.regenPct.toFixed(0)}%</b> regen on <b>${tripLink(topTrip.label, topTrip.tripIdx)}</b>`);
          }
          setTakeaway("regen-scatter-takeaway", scatterParts);
        } else {
          setTakeaway("regen-scatter-takeaway", []);
        }

        // Histogram: distribution of regen %.
        // A handful of descent-dominant rides reach >100%, which crushes the
        // bulk of the distribution into one column. Clip the histogram to a
        // sensible top so the typical band stays legible; mention any
        // clipped trips in the takeaway so the outliers aren't silently lost.
        const sharesAll = tripsWithRegen.map((m) => m.regenPct).filter((v) => isFinite(v));
        const HIST_CAP = 50;
        const sharesClipped = sharesAll.map((v) => Math.min(v, HIST_CAP));
        const clippedCount = sharesAll.filter((v) => v > HIST_CAP).length;
        if (sharesAll.length >= 5) {
          drawHistogram(document.getElementById("chart-regen-hist"), sharesClipped, {
            xLabel: "regen % (clipped at " + HIST_CAP + ")",
            yLabel: "trips",
            nBins: 16,
            colorTop: "rgba(105,240,174,0.9)",
            colorBot: "rgba(105,240,174,0.18)",
          });
          const sortedS = sharesAll.slice().sort((a, b) => a - b);
          const medS = sortedS[Math.floor(sortedS.length / 2)];
          const flat = sharesAll.filter((v) => v < 2).length;
          const heavy = sharesAll.filter((v) => v >= 10).length;
          const histParts = [];
          histParts.push(`Median trip recovers <b>${medS.toFixed(1)}%</b>`);
          histParts.push(`<b>${flat}</b> flat rides (&lt;2%)`);
          histParts.push(`<b>${heavy}</b> descent-heavy (&ge;10%)`);
          if (clippedCount > 0) histParts.push(`<b>${clippedCount}</b> beyond ${HIST_CAP}%`);
          setTakeaway("regen-hist-takeaway", histParts);
        } else {
          setTakeaway("regen-hist-takeaway", []);
        }
      }
    }

    // 3. Motor: speed vs current scatter + amps-per-km/h trend.
    {
      const pts = [];
      for (const m of dated) {
        if (m.avgMovingSpeed == null || m.avgCurrent == null) continue;
        pts.push({
          x: UNITS.speed(m.avgMovingSpeed),
          y: m.avgCurrent,
          epoch: m.epoch,
          meta: `<b>${m.label}</b><br>Avg speed: <b>${fmtVal(UNITS.speed(m.avgMovingSpeed), 1)}</b> ${UNITS.speedUnit}` +
                `<br>Avg current: <b>${fmtVal(m.avgCurrent, 1)}</b> A` +
                `<br>Distance: <b>${fmtVal(UNITS.dist(m.distKm), 1)}</b> ${UNITS.distUnit}`,
        });
      }
      const meta = document.getElementById("motor-meta");
      if (pts.length < 5) {
        setSectionEmpty("motor", pts.length === 0
          ? `None of the ${dated.length} loaded trips carry motor current samples (the export's Current column is empty), so speed vs amps can't be analyzed.`
          : `Only ${pts.length} of ${dated.length} trips carry current data; at least 5 are needed.`);
        meta.textContent = "";
        setTakeaway("motor-takeaway", []);
        setTakeaway("motor-trend-takeaway", []);
      } else {
        setSectionActive("motor");
        drawScatter(document.getElementById("chart-motor"), pts, {
          xLabel: "avg speed (" + UNITS.speedUnit + ")", yLabel: "avg current (A)",
        });
        // Slope of current vs speed across all trips (single fit).
        const xsAll = pts.map((p) => p.x), ysAll = pts.map((p) => p.y);
        const fit = theilSen(xsAll, ysAll);
        const scatterParts = [];
        if (fit) scatterParts.push(`Slope: <b>${fit.slope.toFixed(2)} A per ${UNITS.speedUnit}</b>`);
        scatterParts.push(`<b>${pts.length}</b> trips plotted`);
        setTakeaway("motor-takeaway", scatterParts);
        const trendStats = binStats(bins, (m) => (m.avgMovingSpeed != null && m.avgCurrent != null && m.avgMovingSpeed > 5)
          ? m.avgCurrent / UNITS.speed(m.avgMovingSpeed) : null, minPerBin);
        const series = [{
          stats: trendStats,
          color: COLORS.ampsPerKmh, label: "A per " + UNITS.speedUnit, unit: "A/(" + UNITS.speedUnit + ")", band: true, dp: 3,
        }];
        drawTrendChart(document.getElementById("chart-motor-trend"), bins, series, { rolling });
        meta.textContent = pts.length + " trips";
        const motorMetric = (m) => (m.avgMovingSpeed != null && m.avgCurrent != null && m.avgMovingSpeed > 5) ? m.avgCurrent / UNITS.speed(m.avgMovingSpeed) : null;
        const { peak, trough } = statsPeakTrough(trendStats, bins, null, motorMetric);
        const trendParts = [];
        if (peak && trough && peak.label !== trough.label) {
          const pct = ((peak.v - trough.v) / trough.v) * 100;
          trendParts.push(`Lowest draw: <b>${trough.v.toFixed(3)} A/${UNITS.speedUnit}</b> in <b>${tripLink(trough.label, trough.tripIdx)}</b>`);
          trendParts.push(`Highest: <b>${peak.v.toFixed(3)}</b> in <b>${tripLink(peak.label, peak.tripIdx)}</b> (+${pct.toFixed(0)}%)`);
        }
        setTakeaway("motor-trend-takeaway", trendParts);
      }
    }

    // 4. Thermal.
    {
      const useAmbient = weatherLoaded && dated.some((m) => m.ambientC != null && m.tempMax != null);
      const tempRiseOf = (m) => {
        if (m.tempMax == null) return null;
        if (useAmbient) return m.ambientC != null ? m.tempMax - m.ambientC : null;
        return m.tempStart != null ? m.tempMax - m.tempStart : null;
      };
      const pts = [];
      for (const m of dated) {
        const rise = tempRiseOf(m);
        if (rise == null || m.avgPower == null) continue;
        pts.push({
          x: m.avgPower,
          y: tempDelta(rise),
          epoch: m.epoch,
          meta: `<b>${m.label}</b><br>Temp rise: <b>${fmtVal(tempDelta(rise), 1)}</b> ${UNITS.tempUnit}` +
                `<br>Avg power: <b>${fmtVal(m.avgPower, 0)}</b> W` +
                (m.ambientC != null ? `<br>Ambient: <b>${fmtVal(UNITS.temp(m.ambientC), 1)}</b> ${UNITS.tempUnit}` : ""),
        });
      }
      const meta = document.getElementById("thermal-meta");
      if (pts.length < 5) {
        setSectionEmpty("thermal", "Not enough trips with temperature + power data for this analysis.");
        meta.textContent = "";
        setTakeaway("thermal-takeaway", []);
        setTakeaway("thermal-trend-takeaway", []);
      } else {
        setSectionActive("thermal");
        drawScatter(document.getElementById("chart-thermal"), pts, {
          xLabel: "avg power (W)", yLabel: "temp rise (" + UNITS.tempUnit + ")",
        });
        const xsAll = pts.map((p) => p.x), ysAll = pts.map((p) => p.y);
        const fit = theilSen(xsAll, ysAll);
        const scatterParts = [];
        if (fit) scatterParts.push(`Slope: <b>${(fit.slope * 1000).toFixed(2)} ${UNITS.tempUnit} per kW</b>`);
        scatterParts.push(useAmbient ? "Rise measured vs ambient" : "Rise measured vs trip-start temp");
        setTakeaway("thermal-takeaway", scatterParts);
        const trendStats = binStats(bins, (m) => {
          const r = tempRiseOf(m);
          return r == null ? null : tempDelta(r);
        }, minPerBin);
        const series = [{
          stats: trendStats,
          color: COLORS.tempRise, label: "Median temp rise", unit: UNITS.tempUnit, band: true, dp: 1,
        }];
        drawTrendChart(document.getElementById("chart-thermal-trend"), bins, series, { rolling });
        meta.textContent = useAmbient ? "vs ambient (weather)" : "vs trip-start temp. Add weather for an ambient baseline.";
        const thermalMetric = (m) => {
          const r = tempRiseOf(m);
          return r == null ? null : tempDelta(r);
        };
        const { peak, trough } = statsPeakTrough(trendStats, bins, null, thermalMetric);
        const trendParts = [];
        if (peak && trough && peak.label !== trough.label) {
          trendParts.push(`Coolest: <b>${trough.v.toFixed(1)} ${UNITS.tempUnit}</b> in <b>${tripLink(trough.label, trough.tripIdx)}</b>`);
          trendParts.push(`Hottest: <b>${peak.v.toFixed(1)} ${UNITS.tempUnit}</b> in <b>${tripLink(peak.label, peak.tripIdx)}</b>`);
        }
        setTakeaway("thermal-trend-takeaway", trendParts);
      }
    }

    // 5. Battery health (IR).
    {
      const usable = dated.filter((m) => m.ohmIR != null).length;
      const meta = document.getElementById("health-meta");
      if (usable < 5) {
        setSectionEmpty("health", "Not enough trips with voltage + current data to estimate internal resistance.");
        meta.textContent = "";
        setTakeaway("health-takeaway", []);
      } else {
        setSectionActive("health");
        const irStats = binStats(bins, (m) => m.ohmIR == null ? null : m.ohmIR * 1000, Math.max(2, minPerBin));
        const series = [{
          stats: irStats,
          color: COLORS.ohmIR, label: "Effective IR", unit: "mΩ", band: true, dp: 0,
        }];
        // Let the y-axis fit the actual data range — IR sits around 180 mΩ,
        // forcing the axis to zero compressed the variation into the top sliver.
        drawTrendChart(document.getElementById("chart-health"), bins, series, { rolling });
        meta.textContent = usable + " trips";
        const irMetric = (m) => m.ohmIR == null ? null : m.ohmIR * 1000;
        const { peak, trough } = statsPeakTrough(irStats, bins, null, irMetric);
        const parts = [];
        if (peak && trough && peak.label !== trough.label) {
          const pct = ((peak.v - trough.v) / trough.v) * 100;
          parts.push(`Lowest IR: <b>${trough.v.toFixed(0)} mΩ</b> in <b>${tripLink(trough.label, trough.tripIdx)}</b>`);
          parts.push(`Highest: <b>${peak.v.toFixed(0)} mΩ</b> in <b>${tripLink(peak.label, peak.tripIdx)}</b> (+${pct.toFixed(0)}%)`);
        }
        setTakeaway("health-takeaway", parts, peak && trough && ((peak.v - trough.v) / trough.v) > 0.25 ? "warn" : null);

        // Second chart: voltage droop %, independent battery-aging proxy.
        const sagStats = binStats(bins, (m) => m.voltSagPct, Math.max(2, minPerBin));
        const usableSag = dated.filter((m) => m.voltSagPct != null).length;
        if (usableSag >= 5) {
          const sagSeries = [{
            stats: sagStats, color: "#ff7043", label: "Voltage droop", unit: "%", band: true, dp: 1,
          }];
          drawTrendChart(document.getElementById("chart-health-sag"), bins, sagSeries, { rolling });
          const sagMetric = (m) => m.voltSagPct;
          const { peak: sp, trough: st } = statsPeakTrough(sagStats, bins, null, sagMetric);
          const sagParts = [];
          if (sp && st && sp.label !== st.label) {
            sagParts.push(`Smallest droop: <b>${st.v.toFixed(1)}%</b> in <b>${tripLink(st.label, st.tripIdx)}</b>`);
            sagParts.push(`Largest: <b>${sp.v.toFixed(1)}%</b> in <b>${tripLink(sp.label, sp.tripIdx)}</b>`);
          }
          setTakeaway("health-sag-takeaway", sagParts);
        } else {
          setTakeaway("health-sag-takeaway", []);
        }
      }
    }
  }

  // Make each lifetime stat card a click target. Jumps to the related
  // tab + scrolls to the matching section. In one-page layout the tab
  // switch is a no-op, the scroll still lands on the right chart.
  document.querySelectorAll('#lifetime-bar .stat-card[data-jump-tab]').forEach((card) => {
    card.addEventListener('click', () => {
      const tab = card.dataset.jumpTab;
      const section = card.dataset.jumpSection;
      if (tab && tab !== activeTab) applyTab(tab);
      if (section) {
        // Wait one frame so the tab content is laid out before scrolling.
        requestAnimationFrame(() => {
          const target = document.querySelector(`section[data-section="${section}"]`);
          if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
      }
    });
  });

  groupSel.addEventListener("change", renderAll);
  battMinSel.addEventListener("change", renderAll);
  minBinSel.addEventListener("change", renderAll);
  rollingCheck.addEventListener("change", renderAll);
  normalizeCheck.addEventListener("change", renderAll);
  let resizeTimer = null;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(renderAll, 150);
  });

  renderAll();

  // Pre-fill ambient temps from the cache (no network) so a returning user
  // gets the weather-based view without pressing the button again.
  (async () => {
    const clusters = weatherClusters();
    let hits = 0;
    for (const c of clusters) {
      const cached = await readWeatherCache(c.key);
      if (!cached) continue;
      for (const m of c.trips) {
        const day = cached.days[m.dateStr];
        if (day) { m.ambientC = day.mean; hits++; }
      }
    }
    if (hits) {
      weatherLoaded = true;
      document.body.classList.add("weather-loaded");
    }
    updateWeatherUi(0);
    renderAll();
  })();
})();
