"use strict";

importScripts("https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js");

const DATE_RE = /(\d{2}\.\d{2}\.\d{4})/;
const TIMESERIES_LIMIT = 500;

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

    if (!lowerName.endsWith(".dbb")) {
      throw new Error("Please upload a .dbb or .csv file");
    }

    if (!self.JSZip) {
      throw new Error("JSZip is not available in the parser worker");
    }

    const zip = await self.JSZip.loadAsync(file);
    const csvNames = Object.keys(zip.files)
      .filter((entryName) => entryName.endsWith(".csv") && !entryName.startsWith("__MACOSX") && !entryName.endsWith(".json"))
      .sort();

    if (!csvNames.length) {
      throw new Error("No CSV files found in archive");
    }

    for (let index = 0; index < csvNames.length; index += 1) {
      const entryName = csvNames[index];
      self.postMessage({ type: "progress", current: index + 1, total: csvNames.length, name: entryName });

      try {
        const text = await zip.files[entryName].async("string");
        const track = parseCsvText(text, entryName);
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

function parseCsvText(text, name) {
  const rows = parseCsvRows(text);
  if (!rows.length) return null;

  const points = [];
  let timeseries = [];
  const speeds = [];
  const altitudes = [];
  const voltages = [];
  const temperatures = [];
  let dateStart = "";
  let dateEnd = "";
  let t0 = null;

  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    const speed = safeFloat(row.Speed);
    const volt = safeFloat(row.Voltage);
    const temp = safeFloat(row.Temperature);
    const batt = safeFloat(row["Battery level"]);
    const alt = safeFloat(row.Altitude);
    const lat = safeFloat(row.Latitude);
    const lon = safeFloat(row.Longitude);
    const date = row.Date || "";

    if (date) {
      if (!dateStart) dateStart = date;
      dateEnd = date;
    }

    let sec = 0;
    if (date) {
      const dt = Date.parse(date);
      if (!Number.isNaN(dt)) {
        if (t0 === null) t0 = dt;
        sec = (dt - t0) / 1000;
      }
    }

    const hasGps = !(lat === 0 && lon === 0);
    timeseries.push([
      roundTo(sec, 1),
      roundTo(speed, 1),
      roundTo(volt, 1),
      roundTo(temp, 1),
      roundTo(batt, 1),
      roundTo(alt, 1),
      hasGps ? roundTo(lat, 6) : 0,
      hasGps ? roundTo(lon, 6) : 0,
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

  const dateMatch = name.match(DATE_RE);
  return {
    points,
    timeseries,
    name: name.replace(/\.csv$/i, ""),
    date: dateMatch ? dateMatch[1] : "",
    dateStart,
    dateEnd,
    stats: {
      points: points.length,
      rows: rows.length,
      distanceKm: roundTo(dist / 1000, 2),
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
  return values.length ? roundTo(Math.max(...values), 1) : 0;
}

function minRounded(values) {
  return values.length ? roundTo(Math.min(...values), 1) : 0;
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
