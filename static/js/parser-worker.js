"use strict";

importScripts("https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js");

const DATE_RE = /(\d{2}\.\d{2}\.\d{4})/;
const TIMESERIES_LIMIT = 500;

// Parse European "DD.MM.YYYY [HH:mm:ss[.SSS]]" or fall back to native Date.parse.
// Returns { ms, iso } where ms is milliseconds and iso is a local ISO-8601 string
// (no trailing Z, so downstream new Date(iso) treats it as local time).
function parseDateParts(str) {
  const m = str.match(/^(\d{2})\.(\d{2})\.(\d{4})(?:[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?)?\s*$/);
  if (m) {
    const iso = `${m[3]}-${m[2]}-${m[1]}` +
      (m[4] !== undefined ? `T${m[4]}:${m[5]}:${m[6]}.${(m[7] || '000').padEnd(3, '0')}` : 'T00:00:00.000');
    return { ms: new Date(iso).getTime(), iso };
  }
  // Naive ISO-like "YYYY-MM-DD HH:MM:SS[.SSS]" — preserve the wall-clock so
  // the displayed time matches what the rider actually saw at ride time. Going
  // via Date.parse + toISOString would round-trip through UTC and shift hours
  // when the browser timezone differs from the ride timezone. A trailing
  // timezone offset (euc.world writes "+0200") is deliberately dropped for
  // the same reason: the local part IS the ride wall-clock.
  const iso = str.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(?:Z|[+-]\d{2}:?\d{2})?\s*$/);
  if (iso) {
    const naive = `${iso[1]}-${iso[2]}-${iso[3]}T${iso[4]}:${iso[5]}:${iso[6]}.${(iso[7] || '000').padEnd(3, '0')}`;
    return { ms: new Date(naive).getTime(), iso: naive };
  }
  const ms = Date.parse(str);
  return { ms, iso: isNaN(ms) ? str : new Date(ms).toISOString().slice(0, 23) };
}

function parseDateMs(str) {
  return parseDateParts(str).ms;
}

self.addEventListener("message", async (event) => {
  const { type, file } = event.data || {};
  if (type !== "parse" || !file) return;

  try {
    const name = String(file.name || "");
    const lowerName = name.toLowerCase();

    if (lowerName.endsWith(".csv")) {
      self.postMessage({ type: "progress", current: 1, total: 1, name });
      const text = await file.text();
      const track = parseCsvText(text, name);
      if (track) self.postMessage({ type: "track", track });
      self.postMessage({ type: "done" });
      return;
    }

    if (lowerName.endsWith(".gpx")) {
      self.postMessage({ type: "progress", current: 1, total: 1, name });
      const text = await file.text();
      const track = parseGpxText(text, name);
      if (track) self.postMessage({ type: "track", track });
      self.postMessage({ type: "done" });
      return;
    }

    if (lowerName.endsWith(".xlsx")) {
      self.postMessage({ type: "progress", current: 1, total: 1, name });
      const buf = await file.arrayBuffer();
      const track = await parseXlsxBuffer(buf, name);
      if (track) self.postMessage({ type: "track", track });
      self.postMessage({ type: "done" });
      return;
    }

    if (!lowerName.endsWith(".dbb") && !lowerName.endsWith(".zip")) {
      throw new Error("Please upload a .zip, .dbb, .csv, .gpx or .xlsx file");
    }

    if (!self.JSZip) {
      throw new Error("JSZip is not available in the parser worker");
    }

    const zip = await self.JSZip.loadAsync(file);
    const entryNames = Object.keys(zip.files)
      .filter((entryName) => {
        if (entryName.startsWith("__MACOSX")) return false;
        const lower = entryName.toLowerCase();
        return lower.endsWith(".csv") || lower.endsWith(".gpx") || lower.endsWith(".xlsx");
      })
      .sort();

    if (!entryNames.length) {
      throw new Error("No CSV, GPX or XLSX files found in archive");
    }

    for (let index = 0; index < entryNames.length; index += 1) {
      const entryName = entryNames[index];
      self.postMessage({ type: "progress", current: index + 1, total: entryNames.length, name: entryName });

      try {
        const lower = entryName.toLowerCase();
        let track;
        if (lower.endsWith(".gpx")) {
          const text = await zip.files[entryName].async("string");
          track = parseGpxText(text, entryName);
        } else if (lower.endsWith(".xlsx")) {
          const buf = await zip.files[entryName].async("arraybuffer");
          track = await parseXlsxBuffer(buf, entryName);
        } else {
          const text = await zip.files[entryName].async("string");
          track = parseCsvText(text, entryName);
        }
        if (track) self.postMessage({ type: "track", track });
      } catch {
        // Skip invalid files to match the previous server behavior.
      }
    }

    self.postMessage({ type: "done" });
  } catch (error) {
    self.postMessage({ type: "error", error: error instanceof Error ? error.message : String(error) });
  }
});

// Wheel identity from the filename, for files whose content carries none
// (web XLSX and DarknessBot CSVs). Recognized shapes:
//   <Name>_<MAC12>_DD.MM.YYYY_HH-MM-SS.*        eucviewer bookmarklet
//   <Name>_DD.MM.YYYY_HH-MM-SS.*                bookmarklet, MAC unknown
//   <MAC12>_DD.MM.YYYY*.csv                     DarknessBot
//   EUC_data_log_<identity>_YYYY_MM_DD_HHMMSS   euc.world app export
function wheelFromFileName(name) {
  const base = String(name || "").replace(/\.[A-Za-z0-9]+$/, "");
  let m = base.match(/^EUC_data_log_(.+)_\d{4}_\d{2}_\d{2}_\d{6}$/);
  if (m) return { name: m[1].replace(/_/g, " ") };
  m = base.match(/^(.*?)_?([0-9A-Fa-f]{12})_\d{2}\.\d{2}\.\d{4}/);
  if (m) {
    const out = { mac: m[2].toUpperCase() };
    if (m[1]) out.name = m[1].replace(/_/g, " ");
    return out;
  }
  m = base.match(/^(.+?)_\d{2}\.\d{2}\.\d{4}_\d{2}-\d{2}-\d{2}/);
  if (m) return { name: m[1].replace(/_/g, " ") };
  return null;
}

function parseCsvText(text, name) {
  const rows = parseCsvRows(text);
  if (!rows.length) return null;
  const wheel = normalizeEucWorldRows(rows);
  const track = buildTrackFromRows(rows, name.replace(/\.csv$/i, ""));
  // Optional wheel identity: in-file metadata (euc.world's extra column,
  // or the Wheel / Wheel MAC trailing columns EUC Planet is adopting)
  // wins over the filename. New optional track field; readers guard,
  // cached tracks simply lack it.
  if (track) {
    const w = wheel || wheelFromExtraColumn(rows) || wheelFromFileName(name);
    if (w) {
      if (w.all) { track.wheels = w.all; delete w.all; }
      track.wheel = w;
    }
  }
  return track;
}

// EUC Planet's recorder appends a trailing "Extra" event column: empty on
// normal rows, one key=value pair per event row. Identity keys
// (wheel.name / wheel.mac / wheel.model / wheel.adapter / wheel.firmware)
// are re-emitted on every (re)connect, so a trip that switched wheels
// mid-ride holds several identity blocks. The trip is attributed to the
// wheel covering the most rows (`track.wheel`), and when more than one
// wheel rode it the full list lands in `track.wheels` so filters can
// count the trip under each of them.
function wheelFromExtraColumn(rows) {
  if (!rows.length) return null;
  const col = rows[0].Extra !== undefined ? "Extra" : (rows[0].extra !== undefined ? "extra" : null);
  if (!col) return null;
  // Collect identity blocks: a block starts when name/mac re-appears
  // (reconnect or a different wheel) and closes on wheel.disconnected.
  const blocks = [];
  let current = null;
  for (let i = 0; i < rows.length; i++) {
    const raw = rows[i][col];
    if (!raw) continue;
    const eq = raw.indexOf("=");
    if (eq <= 0) continue;
    const key = raw.slice(0, eq).trim();
    if (!/^wheel\./.test(key)) continue;
    const field = key.slice(6);
    const value = raw.slice(eq + 1).trim();
    if (field === "disconnected") { current = null; continue; }
    if (!value) continue;
    if (!current || ((field === "name" || field === "mac") && current[field] !== undefined)) {
      current = { startRow: i };
      blocks.push(current);
    }
    if (field === "name") current.name = value;
    else if (field === "mac") current.mac = value.replace(/[:\-]/g, "").toUpperCase();
    else if (field === "model") current.model = value;
    else if (field === "brand") current.make = value;
    else if (field === "serial") current.serial = value;
  }
  const named = blocks.filter((b) => b.name || b.mac || b.model);
  if (!named.length) return null;
  // Majority attribution when a trip switched wheels mid-ride: sum the
  // row span of each distinct identity, biggest total wins.
  for (let i = 0; i < named.length; i++) {
    const end = i + 1 < named.length ? named[i + 1].startRow : rows.length;
    named[i].span = Math.max(1, end - named[i].startRow);
  }
  const byId = new Map();
  for (const b of named) {
    const id = (b.name || "") + "|" + (b.mac || "") + "|" + (b.model || "");
    const agg = byId.get(id);
    if (agg) agg.span += b.span;
    else byId.set(id, { name: b.name, mac: b.mac, model: b.model, make: b.make, serial: b.serial, span: b.span });
  }
  const strip = (w) => ({ name: w.name, mac: w.mac, model: w.model, make: w.make, serial: w.serial });
  const ids = [...byId.values()];
  let best = ids[0];
  for (const w of ids) if (w.span > best.span) best = w;
  const res = strip(best);
  // A trip that switched wheels mid-ride: `all` lists every distinct
  // identity in ride order so it can appear under each of its wheels.
  if (ids.length > 1) res.all = ids.map(strip);
  return res;
}

// euc.world's native app export ("EUC data <date>.csv") uses its own
// lowercase header (datetime, speed, gps_lat, ...). Remap in place to the
// canonical DarknessBot-style names the row reader expects. Detection
// requires both `datetime` and `gps_lat`, so no ordinary export can match.
// PWM is left empty on purpose: euc.world logs safety_margin, which is
// related but not the same signal.
const EUC_WORLD_COLS = {
  datetime: "Date",
  speed: "Speed",
  voltage: "Voltage",
  current: "Current",
  power: "Power",
  battery: "Battery level",
  temp: "Temperature",
  gps_lat: "Latitude",
  gps_lon: "Longitude",
  gps_alt: "Altitude",
  gps_speed: "GPS speed",
  distance_total: "Total mileage",
};
function normalizeEucWorldRows(rows) {
  const first = rows[0];
  if (!first || first.datetime === undefined || first.gps_lat === undefined) return null;
  // Wheel identity rides in the `extra` column as key=value pairs spread
  // over the first rows. Key spelling changed across euc.world versions:
  // 2023-era "eucModel=KS-14S", current "euc.model=KS-16SZ".
  const wheel = {};
  const WHEEL_KEYS = {
    "euc.make": "make",
    "euc.model": "model", "eucModel": "model",
    "euc.name": "name", "eucBluetoothName": "name",
    "euc.serial": "serial", "eucSerial": "serial",
  };
  const scanMax = Math.min(rows.length, 400);
  for (let i = 0; i < scanMax; i++) {
    const extra = rows[i].extra;
    if (!extra) continue;
    const eq = extra.indexOf("=");
    if (eq <= 0) continue;
    const key = WHEEL_KEYS[extra.slice(0, eq).trim()];
    if (key && !wheel[key]) wheel[key] = extra.slice(eq + 1).trim();
  }
  for (const row of rows) {
    for (const src in EUC_WORLD_COLS) {
      if (row[src] !== undefined) row[EUC_WORLD_COLS[src]] = row[src];
    }
  }
  return (wheel.make || wheel.model || wheel.name) ? wheel : null;
}

// BLE glitches leave "speed islands" in real exports: rows whose value
// leaps up from the neighborhood AND drops back with jumps no wheel can
// physically produce (0 → 244.2 → 0 across ~2s samples, or a frozen
// 176.8 repeated six times between 0.5 and 0). One such row used to own
// stats.maxSpeed and poison the library-wide "top speed". Repair rule:
// an island bounded by an impossible up-jump and an impossible down-jump
// within MAX_RUN rows is replaced by linear interpolation between its
// neighbors. Genuine sprints survive because a real ramp is gradual on
// at least one side; jump limits scale with the sample gap so logging
// pauses (parked, tunnel) never count as jumps.
function despikeRows(rows) {
  const n = rows.length;
  if (n < 3) return;
  const secs = new Array(n);
  let t0 = null, last = 0;
  for (let i = 0; i < n; i += 1) {
    const d = rows[i].Date ? parseDateMs(rows[i].Date) : NaN;
    if (!Number.isNaN(d)) {
      if (t0 === null) t0 = d;
      last = (d - t0) / 1000;
    }
    secs[i] = last;
  }
  const JUMP_PER_SEC = 12; // km/h of gain per second still considered real
  const JUMP_MIN = 30;     // ignore small wobble outright
  const MAX_RUN = 12;      // longest island we repair
  for (const col of ["Speed", "GPS speed"]) {
    if (rows[0][col] === undefined) continue;
    const v = new Array(n);
    for (let i = 0; i < n; i += 1) v[i] = safeFloat(rows[i][col]);
    let i = 1;
    while (i < n - 1) {
      const dtIn = Math.max(0.5, secs[i] - secs[i - 1]);
      const limitIn = Math.max(JUMP_MIN, JUMP_PER_SEC * dtIn);
      if (v[i] - v[i - 1] > limitIn) {
        const base = v[i - 1];
        let j = i;
        let closed = false;
        while (j < n - 1 && j - i < MAX_RUN) {
          const dtOut = Math.max(0.5, secs[j + 1] - secs[j]);
          const limitOut = Math.max(JUMP_MIN, JUMP_PER_SEC * dtOut);
          if (v[j] - v[j + 1] > limitOut && v[j + 1] < base + JUMP_MIN) {
            closed = true;
            break;
          }
          j += 1;
        }
        if (closed) {
          const after = v[j + 1];
          for (let m = i; m <= j; m += 1) {
            const t = (m - i + 1) / (j - i + 2);
            const fixed = roundTo(base + (after - base) * t, 1);
            v[m] = fixed;
            rows[m][col] = fixed;
          }
          i = j + 1;
          continue;
        }
      }
      i += 1;
    }
    // Second pass: lone samples an impossible jump away from BOTH
    // neighbors, in either direction. Catches a frozen feed that
    // unfreezes with a catch-up burst (1.3 → 109.4 → 66.4 → …): the
    // burst row is fake, the decay after it is real, so the island rule
    // above never closes on it.
    for (let s = 1; s < n - 1; s += 1) {
      const limA = Math.max(JUMP_MIN, JUMP_PER_SEC * Math.max(0.5, secs[s] - secs[s - 1]));
      const limB = Math.max(JUMP_MIN, JUMP_PER_SEC * Math.max(0.5, secs[s + 1] - secs[s]));
      if ((v[s] - v[s - 1] > limA && v[s] - v[s + 1] > limB) ||
          (v[s - 1] - v[s] > limA && v[s + 1] - v[s] > limB)) {
        const fixed = roundTo((v[s - 1] + v[s + 1]) / 2, 1);
        v[s] = fixed;
        rows[s][col] = fixed;
      }
    }
    // Final sanity: nobody rides an EUC backwards at 30+ km/h. Deeply
    // negative speeds are frozen-feed garbage (seen: a decaying
    // −48 → −95 → −78 → −58 run) that survives the island rule because
    // it recovers gradually. Zero is the honest "unknown" here.
    for (let s = 0; s < n; s += 1) {
      if (v[s] < -30) {
        v[s] = 0;
        rows[s][col] = 0;
      }
    }
  }
}

function buildTrackFromRows(rows, displayName) {
  despikeRows(rows);
  const points = [];
  let timeseries = [];
  const speeds = [];
  const altitudes = [];
  const voltages = [];
  const temperatures = [];
  let dateStart = "";
  let dateEnd = "";
  let t0 = null;
  let mileage0 = null;
  let mileageLast = 0;
  let hasMileage = false;

  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    const speed = safeFloat(row.Speed);
    const volt = safeFloat(row.Voltage);
    const temp = safeFloat(row.Temperature);
    const batt = safeFloat(row["Battery level"]);
    const alt = safeFloat(row.Altitude);
    const pwm = safeFloat(row.PWM);
    const current = safeFloat(row.Current);
    // EUC Planet exports often leave Power empty while logging Voltage and
    // Current; electrical power is their product (sign follows the current,
    // so regen stays negative).
    let power = safeFloat(row.Power);
    if (power === 0 && volt !== 0 && current !== 0) power = volt * current;
    // Optional columns — absent on most wheels / older exports (safeFloat → 0).
    // "Ext GPS speed" is deliberately ignored: it has been folded into "GPS speed".
    const gpsSpeed = safeFloat(row["GPS speed"]);
    const gForce = safeFloat(row["G-Force"]);
    const gForceX = safeFloat(row["G-Force X"]);
    const gForceY = safeFloat(row["G-Force Y"]);
    const lat = safeFloat(row.Latitude);
    const lon = safeFloat(row.Longitude);
    const date = row.Date || "";
    const mileageRaw = row["Total mileage"];
    const mileage = mileageRaw !== undefined && mileageRaw !== "" ? safeFloat(mileageRaw) : null;
    if (mileage !== null && mileage > 0) {
      hasMileage = true;
      if (mileage0 === null) mileage0 = mileage;
      if (mileage >= mileage0) mileageLast = mileage;
    }

    if (date) {
      const { iso } = parseDateParts(date);
      if (!dateStart) dateStart = iso;
      dateEnd = iso;
    }

    let sec = 0;
    if (date) {
      const dt = parseDateMs(date);
      if (!Number.isNaN(dt)) {
        if (t0 === null) t0 = dt;
        sec = (dt - t0) / 1000;
      }
    }

    const hasGps = !(lat === 0 && lon === 0);
    const mileageDelta = (mileage !== null && mileage0 !== null && mileage >= mileage0)
      ? mileage - mileage0
      : 0;
    timeseries.push([
      roundTo(sec, 1),
      roundTo(speed, 1),
      roundTo(volt, 1),
      roundTo(temp, 1),
      roundTo(batt, 1),
      roundTo(alt, 1),
      hasGps ? roundTo(lat, 6) : 0,
      hasGps ? roundTo(lon, 6) : 0,
      roundTo(mileageDelta, 3),
      roundTo(pwm, 1),
      roundTo(current, 1),
      roundTo(power, 0),
      roundTo(gpsSpeed, 1),
      roundTo(gForce, 3),
      roundTo(gForceX, 3),
      roundTo(gForceY, 3),
    ]);

    if (speed > 0) speeds.push(speed);
    if (volt !== 0) voltages.push(volt);
    if (temp !== 0) temperatures.push(temp);
    if (alt !== 0) altitudes.push(alt);

    if (lat !== 0 || lon !== 0) {
      points.push([
        roundTo(lat, 6),
        roundTo(lon, 6),
        roundTo(speed, 1),
        roundTo(alt, 1),
        roundTo(volt, 1),
        roundTo(temp, 1),
        roundTo(batt, 1),
        roundTo(pwm, 1),
        roundTo(current, 1),
        roundTo(power, 0),
        roundTo(gpsSpeed, 1),
      ]);
    }
  }

  if (!timeseries.length) return null;

  if (timeseries.length > TIMESERIES_LIMIT) {
    const step = timeseries.length / TIMESERIES_LIMIT;
    const sampled = [];
    for (let idx = 0; idx < timeseries.length; idx += step) {
      sampled.push(timeseries[Math.floor(idx)]);
    }
    timeseries = sampled;
  }

  let dist = 0;
  for (let i = 1; i < points.length; i += 1) {
    dist += haversine(points[i - 1][0], points[i - 1][1], points[i][0], points[i][1]);
  }
  let distanceKm = roundTo(dist / 1000, 2);
  if (distanceKm === 0 && hasMileage && mileage0 !== null) {
    distanceKm = roundTo(Math.max(0, mileageLast - mileage0), 2);
  }

  const dateMatch = displayName.match(DATE_RE);
  return {
    points,
    timeseries,
    name: displayName,
    date: dateMatch ? dateMatch[1] : "",
    dateStart,
    dateEnd,
    stats: {
      points: points.length,
      rows: rows.length,
      distanceKm,
      maxSpeed: maxRounded(speeds),
      avgSpeed: speeds.length ? roundTo(speeds.reduce((sum, value) => sum + value, 0) / speeds.length, 1) : 0,
      maxAlt: maxRounded(altitudes),
      minAlt: minRounded(altitudes),
      maxVoltage: maxRounded(voltages),
      minVoltage: minRounded(voltages),
      maxTemp: maxRounded(temperatures),
    },
  };
}

// GPX (from euc.world / generic GPS apps). Has only lat/lon/speed(m/s)/ele/time.
// PWM, voltage, current, temp, battery are absent → recorded as 0. Schema stays
// identical to CSV-derived tracks so existing readers don't need to change.
function parseGpxText(text, name) {
  if (!text || typeof text !== "string") return null;
  const trkptRe = /<trkpt\b([^>]*)>([\s\S]*?)<\/trkpt>/g;
  const latRe = /\blat\s*=\s*"([^"]+)"/;
  const lonRe = /\blon\s*=\s*"([^"]+)"/;
  const speedRe = /<speed[^>]*>\s*([-\d.eE+]+)\s*<\/speed>/;
  const eleRe = /<ele[^>]*>\s*([-\d.eE+]+)\s*<\/ele>/;
  const timeRe = /<time[^>]*>\s*([^<]+?)\s*<\/time>/;

  const points = [];
  const timeseries = [];
  const speeds = [];
  const altitudes = [];
  let dateStart = "";
  let dateEnd = "";
  let t0 = null;
  let rowCount = 0;

  let m;
  while ((m = trkptRe.exec(text)) !== null) {
    rowCount += 1;
    const attrs = m[1] || "";
    const body = m[2] || "";
    const latMatch = latRe.exec(attrs);
    const lonMatch = lonRe.exec(attrs);
    if (!latMatch || !lonMatch) continue;
    const lat = safeFloat(latMatch[1]);
    const lon = safeFloat(lonMatch[1]);
    const speedMatch = speedRe.exec(body);
    const eleMatch = eleRe.exec(body);
    const timeMatch = timeRe.exec(body);
    // GPX <speed> is meters/second per spec; convert to km/h to match CSV.
    const speed = speedMatch ? safeFloat(speedMatch[1]) * 3.6 : 0;
    const alt = eleMatch ? safeFloat(eleMatch[1]) : 0;
    const timeStr = timeMatch ? timeMatch[1] : "";

    let sec = 0;
    if (timeStr) {
      const ms = Date.parse(timeStr);
      if (!Number.isNaN(ms)) {
        if (t0 === null) t0 = ms;
        sec = (ms - t0) / 1000;
        if (!dateStart) {
          const isoLocal = new Date(ms).toISOString().slice(0, 23);
          dateStart = isoLocal;
        }
        dateEnd = new Date(ms).toISOString().slice(0, 23);
      }
    }

    const hasGps = !(lat === 0 && lon === 0);
    timeseries.push([
      roundTo(sec, 1),
      roundTo(speed, 1),
      0, // voltage
      0, // temp
      0, // battery
      roundTo(alt, 1),
      hasGps ? roundTo(lat, 6) : 0,
      hasGps ? roundTo(lon, 6) : 0,
      0, // mileage delta — derived from haversine below for stats
      0, // pwm
      0, // current
      0, // power
      0, // gpsSpeed (we already put it in speed slot since wheel speed is unknown)
      0, // gForce
      0, // gForceX
      0, // gForceY
    ]);

    if (speed > 0) speeds.push(speed);
    if (alt !== 0) altitudes.push(alt);

    if (hasGps) {
      points.push([
        roundTo(lat, 6),
        roundTo(lon, 6),
        roundTo(speed, 1),
        roundTo(alt, 1),
        0, // voltage
        0, // temp
        0, // battery
        0, // pwm
        0, // current
        0, // power
        0, // gpsSpeed
      ]);
    }
  }

  if (!timeseries.length) return null;

  let downsampled = timeseries;
  if (timeseries.length > TIMESERIES_LIMIT) {
    const step = timeseries.length / TIMESERIES_LIMIT;
    const sampled = [];
    for (let idx = 0; idx < timeseries.length; idx += step) {
      sampled.push(timeseries[Math.floor(idx)]);
    }
    downsampled = sampled;
  }

  // GPX has no Total mileage column — derive distance purely from GPS haversine.
  let dist = 0;
  for (let i = 1; i < points.length; i += 1) {
    dist += haversine(points[i - 1][0], points[i - 1][1], points[i][0], points[i][1]);
  }
  const distanceKm = roundTo(dist / 1000, 2);

  // Backfill mileage-delta column on the downsampled timeseries by integrating
  // haversine between successive lat/lon pairs (col 6 / 7 of the row).
  let cumKm = 0;
  for (let i = 0; i < downsampled.length; i += 1) {
    if (i > 0) {
      const prev = downsampled[i - 1];
      const cur = downsampled[i];
      if (prev[6] && prev[7] && cur[6] && cur[7]) {
        cumKm += haversine(prev[6], prev[7], cur[6], cur[7]) / 1000;
      }
    }
    downsampled[i][8] = roundTo(cumKm, 3);
  }

  const dateMatch = name.match(DATE_RE);
  return {
    points,
    timeseries: downsampled,
    name: name.replace(/\.gpx$/i, ""),
    date: dateMatch ? dateMatch[1] : "",
    dateStart,
    dateEnd,
    stats: {
      points: points.length,
      rows: rowCount,
      distanceKm,
      maxSpeed: maxRounded(speeds),
      avgSpeed: speeds.length ? roundTo(speeds.reduce((sum, v) => sum + v, 0) / speeds.length, 1) : 0,
      maxAlt: maxRounded(altitudes),
      minAlt: minRounded(altitudes),
      maxVoltage: 0,
      minVoltage: 0,
      maxTemp: 0,
    },
  };
}

// XLSX (from euc.world). Carries 15 columns including wheel speed, voltage,
// current, power, battery, temperature - the rich variant. SheetJS is
// lazy-loaded the first time an XLSX file is seen so the worker stays cheap
// for the common CSV/GPX cases.
let sheetJsPromise = null;
function ensureSheetJs() {
  if (self.XLSX) return Promise.resolve();
  if (!sheetJsPromise) {
    sheetJsPromise = new Promise((resolve, reject) => {
      try {
        importScripts("https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js");
        if (!self.XLSX) reject(new Error("SheetJS failed to load"));
        else resolve();
      } catch (e) {
        reject(e);
      }
    });
  }
  return sheetJsPromise;
}

// Excel cell dates come back as JS Date objects whose UTC fields match the
// cell's visible wall-clock time (SheetJS quirk). Format as a naive ISO
// string so the CSV-side parser (which treats unsuffixed ISO as local time)
// renders the same instant the user saw in their export.
function dateToLocalIso(d) {
  const pad = (n) => String(n).padStart(2, "0");
  return d.getUTCFullYear() + "-" + pad(d.getUTCMonth() + 1) + "-" + pad(d.getUTCDate()) +
    "T" + pad(d.getUTCHours()) + ":" + pad(d.getUTCMinutes()) + ":" + pad(d.getUTCSeconds()) + ".000";
}

async function parseXlsxBuffer(buffer, name) {
  await ensureSheetJs();
  const wb = self.XLSX.read(buffer, { type: "array", cellDates: true });
  const sheetName = wb.SheetNames[0];
  if (!sheetName) return null;
  const ws = wb.Sheets[sheetName];
  const rows2d = self.XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: "" });
  if (rows2d.length < 2) return null;

  const headers = (rows2d[0] || []).map((h) => String(h || "").trim().toLowerCase());
  const colMap = {};
  for (let i = 0; i < headers.length; i += 1) {
    const h = headers[i];
    if (!h) continue;
    if (h.includes("date") && h.includes("time")) colMap[i] = "Date";
    else if (h.startsWith("gps latitude")) colMap[i] = "Latitude";
    else if (h.startsWith("gps longitude")) colMap[i] = "Longitude";
    else if (h.startsWith("gps altitude")) colMap[i] = "Altitude";
    else if (h.startsWith("gps speed")) colMap[i] = "GPS speed";
    else if (h === "speed" || h.startsWith("speed [")) colMap[i] = "Speed";
    else if (h.startsWith("battery [%]") || h === "battery") colMap[i] = "Battery level";
    else if (h.startsWith("voltage")) colMap[i] = "Voltage";
    else if (h.startsWith("current")) colMap[i] = "Current";
    else if (h.startsWith("power")) colMap[i] = "Power";
    else if (h.startsWith("temperature")) colMap[i] = "Temperature";
    else if (h.startsWith("distance [")) colMap[i] = "Total mileage";
  }

  const rows = [];
  for (let r = 1; r < rows2d.length; r += 1) {
    const arr = rows2d[r];
    if (!arr || !arr.length) continue;
    const obj = {};
    for (const idx in colMap) {
      const key = colMap[idx];
      let val = arr[idx];
      if (val === undefined || val === null) val = "";
      if (key === "Date") {
        if (val instanceof Date) val = dateToLocalIso(val);
        else val = String(val);
      }
      obj[key] = val;
    }
    rows.push(obj);
  }
  if (!rows.length) return null;
  const track = buildTrackFromRows(rows, name.replace(/\.xlsx$/i, ""));
  if (track) {
    const w = wheelFromExtraColumn(rows) || wheelFromFileName(name);
    if (w) {
      if (w.all) { track.wheels = w.all; delete w.all; }
      track.wheel = w;
    }
  }
  return track;
}

function parseCsvRows(text) {
  const rows = [];
  const data = String(text || "").replace(/^\uFEFF/, "");
  const length = data.length;
  let index = 0;
  let current = [];
  let field = "";
  let headers = null;
  let inQuotes = false;

  while (index < length) {
    const char = data[index];

    if (inQuotes) {
      if (char === '"') {
        if (data[index + 1] === '"') {
          field += '"';
          index += 2;
          continue;
        }
        inQuotes = false;
        index += 1;
        continue;
      }
      field += char;
      index += 1;
      continue;
    }

    if (char === '"') {
      inQuotes = true;
      index += 1;
      continue;
    }

    if (char === ",") {
      current.push(field);
      field = "";
      index += 1;
      continue;
    }

    if (char === "\n" || char === "\r") {
      current.push(field);
      field = "";

      if (char === "\r" && data[index + 1] === "\n") index += 1;

      if (current.some((value) => value !== "")) {
        if (!headers) {
          headers = current.map((value) => value.trim());
        } else {
          rows.push(toRow(headers, current));
        }
      }

      current = [];
      index += 1;
      continue;
    }

    field += char;
    index += 1;
  }

  if (field !== "" || current.length) {
    current.push(field);
    if (!headers) headers = current.map((value) => value.trim());
    else if (current.some((value) => value !== "")) rows.push(toRow(headers, current));
  }

  return rows;
}

function toRow(headers, values) {
  const row = {};
  for (let i = 0; i < headers.length; i += 1) {
    row[headers[i]] = values[i] || "";
  }
  return row;
}

function safeFloat(value) {
  const parsed = Number.parseFloat(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function roundTo(value, digits) {
  return Number(value.toFixed(digits));
}

function maxRounded(values) {
  if (!values.length) return 0;
  let max = values[0];
  for (let i = 1; i < values.length; i += 1) {
    if (values[i] > max) max = values[i];
  }
  return roundTo(max, 1);
}

function minRounded(values) {
  if (!values.length) return 0;
  let min = values[0];
  for (let i = 1; i < values.length; i += 1) {
    if (values[i] < min) min = values[i];
  }
  return roundTo(min, 1);
}

function haversine(lat1, lon1, lat2, lon2) {
  const radius = 6371000;
  const phi1 = (lat1 * Math.PI) / 180;
  const phi2 = (lat2 * Math.PI) / 180;
  const dPhi = ((lat2 - lat1) * Math.PI) / 180;
  const dLam = ((lon2 - lon1) * Math.PI) / 180;
  const a = Math.sin(dPhi / 2) ** 2 + Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLam / 2) ** 2;
  return radius * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
