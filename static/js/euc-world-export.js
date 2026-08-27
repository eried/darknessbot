// Loaded as a script tag inside euc.world via the eucviewer bookmarklet.
// Same-origin context, so /webapi/userTours pagination and /xlsx/{key}
// fetches both inherit the user's session cookies. Output: a single .zip
// (of .xlsx files) that eucviewer can read directly.
(function () {
  "use strict";

  const ORIGIN = "https://euc.world";
  if (location.origin !== ORIGIN) {
    alert("Run this from a euc.world tab (log in first).");
    return;
  }

  // If the overlay is already on the page (export still running, or finished
  // but the user hasn't dismissed it), flash it to draw attention instead of
  // alert()-ing or spinning up a second run on top of the first.
  const existing = document.getElementById("eucviewer-export-overlay");
  if (existing) {
    pulse(existing);
    return;
  }
  window.__eucviewerExportRunning = true;

  const ui = buildOverlay();

  run().catch((err) => {
    ui.fail("Export failed: " + (err && err.message ? err.message : String(err)));
  }).finally(() => {
    window.__eucviewerExportRunning = false;
  });

  async function run() {
    ui.setStatus("Listing tours");
    const tours = await listAllTours(ui);
    if (!tours.length) {
      ui.fail("No tours found. Sure you're logged in?");
      return;
    }
    ui.log("Found " + tours.length + " tours.");

    const files = [];
    const usedNames = new Set();
    for (let i = 0; i < tours.length; i += 1) {
      if (ui.cancelled) { ui.log("Cancelled."); return; }
      const t = tours[i];
      ui.setProgress(i + 1, tours.length, "Tour " + t.key);
      try {
        const resp = await fetch("/xlsx/" + t.key, { credentials: "include" });
        if (!resp.ok) {
          ui.log("  skip " + t.key + " (HTTP " + resp.status + ")");
          continue;
        }
        const buf = await resp.arrayBuffer();
        if (!buf || buf.byteLength < 200) {
          ui.log("  skip " + t.key + " (empty)");
          continue;
        }
        files.push({
          name: uniqueName(filenameFor(t, ui), usedNames),
          data: new Uint8Array(buf),
        });
      } catch (e) {
        ui.log("  skip " + t.key + ": " + (e && e.message ? e.message : e));
      }
      await sleep(120);
    }

    if (!files.length) {
      ui.fail("Nothing downloaded.");
      return;
    }

    ui.setStatus("Compressing " + files.length + "-file archive");
    const blob = await makeZip(files);
    const url = URL.createObjectURL(blob);
    const stamp = new Date().toISOString().slice(0, 10);
    const a = document.createElement("a");
    a.href = url;
    a.download = "euc-world_" + stamp + ".zip";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 60000);

    ui.done(files.length, blob.size);
  }

  // Wheel identity for the filename prefix. The tour item's schema is
  // undocumented, so probe for plausible fields instead of pinning one;
  // whatever gets picked is logged, so a euc.world schema change shows up
  // in the export log instead of silently dropping the wheel. The viewer
  // parses the resulting <Name>_<MAC>_ filename prefix.
  let wheelLogged = false;
  function wheelBitsFor(tour, ui) {
    let name = null, mac = null, nameKey = null, macKey = null;
    for (const k of Object.keys(tour)) {
      const v = tour[k];
      if (typeof v !== "string" || !v.trim()) continue;
      if (!name && /model|wheel|vehicle|euc|device/i.test(k) && !/id$|^key$|url|photo|image/i.test(k)) {
        name = v.trim(); nameKey = k;
      }
      const macish = v.replace(/[:\-]/g, "");
      if (!mac && /mac|address|(^|[^a-z])bt/i.test(k) && /^[0-9A-Fa-f]{12}$/.test(macish)) {
        mac = macish.toUpperCase(); macKey = k;
      }
    }
    if (!wheelLogged) {
      wheelLogged = true;
      ui.log(name || mac
        ? "  wheel identity: " + (name ? nameKey + "=" + name : "") + (mac ? " " + macKey + "=" + mac : "")
        : "  no wheel field found on tour items; filenames stay date-only");
    }
    return { name, mac };
  }
  function sanitizeBit(s) {
    return String(s).replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);
  }

  // <Wheel>_<MAC>_DD.MM.YYYY_HH-MM-SS: the date part matches eucviewer's
  // DATE_RE so the trip still displays as the date, the time (in the
  // ride's own timezone via tzId, not the laptop's) disambiguates rides,
  // and the wheel prefix lets the viewer's per-wheel filter attribute the
  // trip. No colon; Windows treats it as drive separator.
  function filenameFor(tour, ui) {
    const bits = wheelBitsFor(tour, ui);
    let prefix = "";
    if (bits.name) prefix += sanitizeBit(bits.name) + "_";
    if (bits.mac) prefix += bits.mac + "_";
    if (!tour.dateStart) return prefix + tour.key + ".xlsx";
    const d = new Date(tour.dateStart * 1000);
    const tz = tour.tzId || undefined;
    const opts = {
      hour12: false,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    };
    let parts;
    try {
      parts = new Intl.DateTimeFormat("en-GB", Object.assign({ timeZone: tz }, opts)).formatToParts(d);
    } catch (_) {
      // Invalid tzId; fall back to laptop-local time.
      parts = new Intl.DateTimeFormat("en-GB", opts).formatToParts(d);
    }
    const get = (type) => (parts.find((p) => p.type === type) || {}).value || "00";
    return prefix + get("day") + "." + get("month") + "." + get("year") +
      "_" + get("hour") + "-" + get("minute") + "-" + get("second") + ".xlsx";
  }

  function uniqueName(base, used) {
    if (!used.has(base)) { used.add(base); return base; }
    const dot = base.lastIndexOf(".");
    const stem = dot > 0 ? base.slice(0, dot) : base;
    const ext = dot > 0 ? base.slice(dot) : "";
    for (let n = 2; n < 1000; n += 1) {
      const candidate = stem + "_" + n + ext;
      if (!used.has(candidate)) { used.add(candidate); return candidate; }
    }
    return base;
  }

  // --- tour list via JSON API ---

  async function listAllTours(ui) {
    const all = [];
    let page = 1;
    const pageSize = 100;
    let totalPages = 1;

    while (page <= totalPages) {
      const resp = await fetch("/webapi/userTours", {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          page, count: pageSize,
          sortBy: 0, sortOrder: 0,
          filterByText: "", filterByModel: "",
          filterByDateFrom: "", filterByDateTo: "",
          s: "getList",
        }),
      });
      if (!resp.ok) throw new Error("Tour list HTTP " + resp.status);
      const json = await resp.json();
      if (json.error) throw new Error("Tour list error " + json.error);
      const data = json.data || {};
      totalPages = data.pages || 1;
      const items = data.items || [];
      for (const item of items) {
        if (item.key) all.push(item);
      }
      ui.log("  page " + page + "/" + totalPages + ": +" + items.length + " (" + all.length + " total)");
      page += 1;
    }

    return all;
  }

  // --- overlay UI ---

  function buildOverlay() {
    const root = document.createElement("div");
    root.id = "eucviewer-export-overlay";
    root.style.cssText = [
      "position:fixed", "inset:0", "z-index:2147483647",
      "background:rgba(8,10,16,0.78)", "color:#e0e0e0",
      "font:14px/1.4 -apple-system,Segoe UI,Roboto,sans-serif",
      "display:flex", "align-items:center", "justify-content:center",
      "backdrop-filter:blur(4px)", "-webkit-backdrop-filter:blur(4px)",
    ].join(";");
    root.innerHTML = `
      <div style="background:linear-gradient(180deg,#1c2330,#141a26);border:1px solid rgba(255,255,255,0.1);border-radius:12px;width:min(580px,92vw);max-height:80vh;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 24px 60px -10px rgba(0,0,0,0.6),0 4px 16px rgba(0,0,0,0.4)">
        <div style="padding:16px 20px;border-bottom:1px solid rgba(255,255,255,0.06);display:flex;align-items:center;gap:14px">
          <strong style="color:#fff;font-size:15px;letter-spacing:0.01em">euc.world export</strong>
          <span data-status style="color:#9fb3c8;font-size:12px;flex:1">starting</span>
          <button data-cancel type="button" style="background:rgba(255,255,255,0.06);color:#e0e0e0;border:1px solid rgba(255,255,255,0.12);border-radius:6px;padding:5px 12px;cursor:pointer;font-size:12px;transition:background 0.15s">Cancel</button>
        </div>
        <div style="height:5px;background:rgba(0,0,0,0.35);position:relative">
          <div data-bar style="position:absolute;inset:0 100% 0 0;background:linear-gradient(90deg,#00e5ff,#80f5ff);transition:right .2s;box-shadow:0 0 8px rgba(0,229,255,0.5)"></div>
        </div>
        <pre data-log style="margin:0;padding:14px 20px;flex:1;overflow:auto;background:rgba(0,0,0,0.25);color:#7d96b3;font:12px/1.5 ui-monospace,Menlo,Consolas,monospace;white-space:pre-wrap"></pre>
      </div>
    `;
    document.documentElement.appendChild(root);

    const statusEl = root.querySelector("[data-status]");
    const barEl = root.querySelector("[data-bar]");
    const logEl = root.querySelector("[data-log]");
    const cancelBtn = root.querySelector("[data-cancel]");

    const ui = {
      cancelled: false,
      setStatus(text) { statusEl.textContent = text; this.log(text); },
      setProgress(cur, total, text) {
        statusEl.textContent = text + "  (" + cur + "/" + total + ")";
        barEl.style.right = (100 - Math.round((cur / total) * 100)) + "%";
      },
      log(line) {
        logEl.textContent += line + "\n";
        logEl.scrollTop = logEl.scrollHeight;
      },
      fail(msg) {
        statusEl.textContent = msg;
        statusEl.style.color = "#ff7676";
        cancelBtn.textContent = "Close";
      },
      done(count, bytes) {
        statusEl.textContent = "Done. " + count + " tours, " + Math.round(bytes / 1024) + " KB downloaded.";
        statusEl.style.color = "#7af2a3";
        barEl.style.right = "0%";
        cancelBtn.textContent = "Close";
      },
    };

    cancelBtn.addEventListener("click", () => {
      ui.cancelled = true;
      root.remove();
    });

    return ui;
  }

  // --- ZIP writer (store mode, no compression) ---

  let crcTable = null;
  function crc32(data) {
    if (!crcTable) {
      crcTable = new Uint32Array(256);
      for (let n = 0; n < 256; n += 1) {
        let c = n;
        for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        crcTable[n] = c >>> 0;
      }
    }
    let c = 0xffffffff;
    for (let i = 0; i < data.length; i += 1) c = crcTable[(c ^ data[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  // Deflate via the browser-native CompressionStream API. Available since
  // Chrome 80, Firefox 113, Safari 16.4. Returns the raw DEFLATE payload
  // (no zlib header) which is what the ZIP method-8 entries expect.
  async function deflateRaw(bytes) {
    if (typeof CompressionStream === "undefined") return null;
    const cs = new CompressionStream("deflate-raw");
    const writer = cs.writable.getWriter();
    writer.write(bytes);
    writer.close();
    const buf = await new Response(cs.readable).arrayBuffer();
    return new Uint8Array(buf);
  }

  async function makeZip(files) {
    const enc = new TextEncoder();
    const parts = [];
    const central = [];
    let offset = 0;

    for (const f of files) {
      const nameBytes = enc.encode(f.name);
      const crc = crc32(f.data);
      const rawSize = f.data.length;

      // Try DEFLATE; fall back to STORE if the deflate output ends up larger
      // (rare for XLSX since it's already internally compressed).
      let stored = f.data;
      let method = 0;
      const deflated = await deflateRaw(f.data);
      if (deflated && deflated.length < rawSize) {
        stored = deflated;
        method = 8;
      }
      const compSize = stored.length;

      const lfh = new Uint8Array(30 + nameBytes.length);
      const lv = new DataView(lfh.buffer);
      lv.setUint32(0, 0x04034b50, true);
      lv.setUint16(4, 20, true);
      lv.setUint16(6, 0, true);
      lv.setUint16(8, method, true);
      lv.setUint16(10, 0, true);
      lv.setUint16(12, 0x21, true);
      lv.setUint32(14, crc, true);
      lv.setUint32(18, compSize, true);
      lv.setUint32(22, rawSize, true);
      lv.setUint16(26, nameBytes.length, true);
      lv.setUint16(28, 0, true);
      lfh.set(nameBytes, 30);
      parts.push(lfh, stored);

      const cd = new Uint8Array(46 + nameBytes.length);
      const cv = new DataView(cd.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, 20, true);
      cv.setUint16(6, 20, true);
      cv.setUint16(8, 0, true);
      cv.setUint16(10, method, true);
      cv.setUint16(12, 0, true);
      cv.setUint16(14, 0x21, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, compSize, true);
      cv.setUint32(24, rawSize, true);
      cv.setUint16(28, nameBytes.length, true);
      cv.setUint32(42, offset, true);
      cd.set(nameBytes, 46);
      central.push(cd);

      offset += lfh.length + stored.length;
    }

    const cdStart = offset;
    let cdSize = 0;
    for (const c of central) { parts.push(c); cdSize += c.length; }

    const eocd = new Uint8Array(22);
    const ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, central.length, true);
    ev.setUint16(10, central.length, true);
    ev.setUint32(12, cdSize, true);
    ev.setUint32(16, cdStart, true);
    parts.push(eocd);

    return new Blob(parts, { type: "application/zip" });
  }

  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  // Briefly draw the eye to the already-open card. Plays a short border-glow
  // + scale pop animation, so re-clicking the bookmarklet feels like
  // "look here" instead of doing nothing.
  function pulse(overlayRoot) {
    const card = overlayRoot.firstElementChild;
    if (!card) return;
    if (!document.getElementById("eucviewer-pulse-style")) {
      const s = document.createElement("style");
      s.id = "eucviewer-pulse-style";
      s.textContent =
        "@keyframes eucviewerPulse{" +
          "0%{transform:scale(1);box-shadow:0 24px 60px -10px rgba(0,0,0,0.6),0 4px 16px rgba(0,0,0,0.4)}" +
          "30%{transform:scale(1.03);box-shadow:0 0 0 4px rgba(0,229,255,0.5),0 24px 60px -10px rgba(0,0,0,0.6)}" +
          "100%{transform:scale(1);box-shadow:0 24px 60px -10px rgba(0,0,0,0.6),0 4px 16px rgba(0,0,0,0.4)}" +
        "}";
      document.head.appendChild(s);
    }
    card.style.animation = "none";
    void card.offsetWidth;
    card.style.animation = "eucviewerPulse 0.55s ease-out";
  }
})();
