// Dropbox source — PKCE OAuth + listing CSV trips from the app folder.
// Static-site safe: no client secret embedded. The Dropbox app must be a
// "Scoped App (App Folder)" with redirect URIs that include this page.
(function () {
  "use strict";

  const APP_KEY = "5auhxf7gswy7j54";
  const TRIPS_PATH = "/trips";
  const ALLOWED_EXT = /\.(csv|gpx|xlsx|dbb)$/i;

  const STORE = {
    ACCESS: "dbx_access_token",
    REFRESH: "dbx_refresh_token",
    EXPIRES: "dbx_expires_at",
    VERIFIER: "dbx_pkce_verifier",
    ACCOUNT: "dbx_account",
    JUST_CONNECTED: "dbx_just_connected",
  };

  function redirectUri() {
    return location.origin + location.pathname;
  }

  function b64url(buf) {
    let s = "";
    const bytes = new Uint8Array(buf);
    for (let i = 0; i < bytes.length; i += 1) s += String.fromCharCode(bytes[i]);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  async function makePkce() {
    const arr = crypto.getRandomValues(new Uint8Array(32));
    const verifier = b64url(arr);
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
    return { verifier, challenge: b64url(hash) };
  }

  function isAuthenticated() {
    if (!localStorage.getItem(STORE.ACCESS)) return false;
    return true;
  }

  function accountName() {
    return localStorage.getItem(STORE.ACCOUNT) || "";
  }

  async function startOAuth() {
    const { verifier, challenge } = await makePkce();
    localStorage.setItem(STORE.VERIFIER, verifier);
    const params = new URLSearchParams({
      client_id: APP_KEY,
      response_type: "code",
      code_challenge: challenge,
      code_challenge_method: "S256",
      token_access_type: "offline",
      redirect_uri: redirectUri(),
    });
    location.assign("https://www.dropbox.com/oauth2/authorize?" + params.toString());
  }

  async function exchangeCode(code) {
    const verifier = localStorage.getItem(STORE.VERIFIER);
    if (!verifier) throw new Error("PKCE verifier missing");
    const body = new URLSearchParams({
      code,
      grant_type: "authorization_code",
      client_id: APP_KEY,
      code_verifier: verifier,
      redirect_uri: redirectUri(),
    });
    const res = await fetch("https://api.dropboxapi.com/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    if (!res.ok) throw new Error("token exchange " + res.status + ": " + (await res.text()));
    const data = await res.json();
    localStorage.removeItem(STORE.VERIFIER);
    localStorage.setItem(STORE.ACCESS, data.access_token);
    if (data.refresh_token) localStorage.setItem(STORE.REFRESH, data.refresh_token);
    if (data.expires_in) {
      const exp = Date.now() + Math.max(0, (data.expires_in - 60) * 1000);
      localStorage.setItem(STORE.EXPIRES, String(exp));
    }
    try {
      const acc = await rpc("/2/users/get_current_account", null);
      const name = acc && acc.name ? (acc.name.display_name || acc.name.given_name || "") : "";
      if (name) localStorage.setItem(STORE.ACCOUNT, name);
    } catch (_e) { /* non-fatal */ }
  }

  async function refresh() {
    const rt = localStorage.getItem(STORE.REFRESH);
    if (!rt) throw new Error("no refresh token");
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: rt,
      client_id: APP_KEY,
    });
    const res = await fetch("https://api.dropboxapi.com/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
    if (!res.ok) {
      if (res.status === 400 || res.status === 401) signOut();
      throw new Error("refresh " + res.status + ": " + (await res.text()));
    }
    const data = await res.json();
    localStorage.setItem(STORE.ACCESS, data.access_token);
    if (data.expires_in) {
      const exp = Date.now() + Math.max(0, (data.expires_in - 60) * 1000);
      localStorage.setItem(STORE.EXPIRES, String(exp));
    }
  }

  async function ensureToken() {
    const exp = parseInt(localStorage.getItem(STORE.EXPIRES) || "0", 10);
    const tok = localStorage.getItem(STORE.ACCESS);
    if (tok && Date.now() < exp - 30000) return tok;
    if (localStorage.getItem(STORE.REFRESH)) {
      await refresh();
      return localStorage.getItem(STORE.ACCESS);
    }
    return tok;
  }

  async function rpc(endpoint, body) {
    const token = await ensureToken();
    if (!token) throw new Error("not signed in");
    const headers = { Authorization: "Bearer " + token };
    let payload;
    if (body != null) {
      headers["Content-Type"] = "application/json";
      payload = JSON.stringify(body);
    }
    const res = await fetch("https://api.dropboxapi.com" + endpoint, {
      method: "POST", headers, body: payload,
    });
    if (res.status === 401) {
      const text = await res.text();
      // A missing scope (e.g. files.content.write not granted yet) also comes
      // back as 401 — don't sign the user out over it, just surface it so the
      // caller can prompt a reconnect rather than a full re-auth from scratch.
      if (/missing_scope/.test(text)) throw new Error("missing_scope: " + text);
      signOut();
      throw new Error("session expired, sign in again");
    }
    if (!res.ok) throw new Error(endpoint + " " + res.status + ": " + (await res.text()));
    return res.json();
  }

  async function listTripFiles() {
    const out = [];
    let cursor = null;
    try {
      while (true) {
        const data = cursor
          ? await rpc("/2/files/list_folder/continue", { cursor })
          : await rpc("/2/files/list_folder", {
              path: TRIPS_PATH, recursive: false, include_deleted: false,
            });
        for (const ent of (data.entries || [])) {
          if (ent[".tag"] === "file" && ALLOWED_EXT.test(ent.name)) {
            out.push({
              path: ent.path_lower || ent.path_display,
              name: ent.name,
              size: ent.size || 0,
              modified: ent.client_modified || ent.server_modified || "",
              contentHash: ent.content_hash || "",
            });
          }
        }
        if (data.has_more) cursor = data.cursor;
        else break;
      }
    } catch (e) {
      const msg = String(e.message || e);
      // 409 from list_folder is a path-shape problem (not_found, not_folder,
      // restricted, malformed). The user just hasn't written to /trips yet;
      // surface as "no trips found" rather than a scary fetch error.
      if (/\b409\b/.test(msg) || /not_found|not_folder|path\//i.test(msg)) return [];
      throw e;
    }
    out.sort((a, b) => (a.modified < b.modified ? 1 : -1));
    return out;
  }

  // /2/files/download uses content.dropboxapi.com and its CORS preflight
  // rejects the Dropbox-API-Arg header in some browser/extension setups.
  // Two-step via get_temporary_link is bulletproof: api.dropboxapi.com
  // (CORS-clean) hands back a short-lived presigned URL we can GET
  // straight from the CDN, no custom headers, no auth on the second hop.
  async function downloadBlob(path) {
    const meta = await rpc("/2/files/get_temporary_link", { path });
    if (!meta || !meta.link) throw new Error("no temporary link for " + path);
    const res = await fetch(meta.link);
    if (!res.ok) throw new Error("download " + path + " " + res.status);
    return await res.blob();
  }

  // Upload a blob into the app folder. Same CORS reasoning as downloadBlob:
  // get_temporary_upload_link (api.dropboxapi.com, CORS-clean) returns a
  // presigned URL we POST the bytes straight to, so no Dropbox-API-Arg header
  // on content.dropboxapi.com (which some browsers/extensions block).
  // Needs the files.content.write scope — surfaces "missing_scope" if absent.
  async function uploadFile(path, blob, mode) {
    const m = mode || "add";
    const commit_info = { path, mode: m, autorename: m !== "overwrite", mute: true };
    const meta = await rpc("/2/files/get_temporary_upload_link", { commit_info });
    if (!meta || !meta.link) throw new Error("no upload link for " + path);
    const res = await fetch(meta.link, {
      method: "POST",
      headers: { "Content-Type": "application/octet-stream" },
      body: blob,
    });
    if (!res.ok) throw new Error("upload " + path + " " + res.status + ": " + (await res.text()));
    return res.json().catch(() => ({}));
  }

  // Read + parse a small JSON file from the app folder. Returns null when the
  // file doesn't exist yet (the common first-run case), so callers can treat
  // "no sidecar" and "empty sidecar" the same.
  async function readJson(path) {
    try {
      const blob = await downloadBlob(path);
      return JSON.parse(await blob.text());
    } catch (e) {
      const msg = String(e.message || e);
      if (/\b409\b/.test(msg) || /not_found|path\//i.test(msg)) return null;
      throw e;
    }
  }

  function signOut() {
    Object.values(STORE).forEach((k) => localStorage.removeItem(k));
  }

  // Return a public direct-download URL for a file in the app folder.
  // We list existing links first so the common path (link already minted
  // on a previous share click) doesn't trip the noisy 409 + retry dance.
  // Only fall through to create_shared_link_with_settings on a clean
  // miss. Final URL is rewritten to dl.dropboxusercontent.com so a
  // browser can fetch it without CORS pain.
  async function getOrCreateShareLink(path) {
    let url = "";
    try {
      const list = await rpc("/2/sharing/list_shared_links", { path, direct_only: true });
      if (list && list.links && list.links.length) url = list.links[0].url;
    } catch (e) {
      // list endpoint returns 409 with path/not_found if the file moved
      // or was deleted; in any other shape we let the create attempt
      // give a clearer error.
    }
    if (!url) {
      const resp = await rpc("/2/sharing/create_shared_link_with_settings", {
        path,
        settings: { requested_visibility: { ".tag": "public" } },
      });
      url = resp && resp.url ? resp.url : "";
    }
    if (!url) throw new Error("Dropbox did not return a share URL");
    return toDirectLink(url);
  }

  function toDirectLink(url) {
    try {
      const u = new URL(url);
      if (u.hostname === "www.dropbox.com" || u.hostname === "dropbox.com") {
        u.hostname = "dl.dropboxusercontent.com";
      }
      u.searchParams.set("dl", "1");
      return u.toString();
    } catch (_) { return url; }
  }

  // --- Per-file blob cache --------------------------------------------
  // Trips are immutable once written. Stash each downloaded file by
  // Dropbox path; check content_hash on each list to detect rewrites.
  // Lives in its own DB so it doesn't fight the viewer's v3 schema.
  const CACHE_DB = "eucplanet-dropbox-cache";
  const CACHE_VER = 1;
  const CACHE_STORE = "files";

  function openCacheDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(CACHE_DB, CACHE_VER);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(CACHE_STORE)) db.createObjectStore(CACHE_STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function tx(db, mode) { return db.transaction(CACHE_STORE, mode).objectStore(CACHE_STORE); }
  function pr(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  const cache = {
    async get(path) {
      try {
        const db = await openCacheDb();
        return await pr(tx(db, "readonly").get(path));
      } catch (_) { return null; }
    },
    async put(path, value) {
      try {
        const db = await openCacheDb();
        await pr(tx(db, "readwrite").put(value, path));
      } catch (_) { /* quota or storage error: caching is best-effort */ }
    },
    async clear() {
      try {
        const db = await openCacheDb();
        await pr(tx(db, "readwrite").clear());
      } catch (_) {}
    },
    async stats() {
      try {
        const db = await openCacheDb();
        const t = tx(db, "readonly");
        const count = await pr(t.count());
        let bytes = 0;
        await new Promise((resolve) => {
          const req = t.openCursor();
          req.onsuccess = () => {
            const cur = req.result;
            if (!cur) return resolve();
            const v = cur.value;
            if (v && v.blob && typeof v.blob.size === "number") bytes += v.blob.size;
            cur.continue();
          };
          req.onerror = () => resolve();
        });
        return { count, bytes };
      } catch (_) { return { count: 0, bytes: 0 }; }
    },
  };

  let callbackPromise = null;
  function maybeHandleCallback() {
    if (callbackPromise) return callbackPromise;
    const params = new URLSearchParams(location.search);
    const code = params.get("code");
    const verifier = localStorage.getItem(STORE.VERIFIER);
    if (!code || !verifier) return Promise.resolve(false);
    callbackPromise = exchangeCode(code).then(() => {
      sessionStorage.setItem(STORE.JUST_CONNECTED, "1");
      const clean = location.origin + location.pathname + location.hash;
      history.replaceState(null, "", clean);
      return true;
    }).catch((e) => {
      console.warn("Dropbox auth failed:", e);
      try { history.replaceState(null, "", location.origin + location.pathname); } catch (_) {}
      return false;
    });
    return callbackPromise;
  }

  function consumeJustConnected() {
    const v = sessionStorage.getItem(STORE.JUST_CONNECTED);
    if (v) sessionStorage.removeItem(STORE.JUST_CONNECTED);
    return !!v;
  }

  window.DropboxSource = {
    APP_KEY,
    TRIPS_PATH,
    isAuthenticated,
    accountName,
    startOAuth,
    listTripFiles,
    downloadBlob,
    uploadFile,
    readJson,
    signOut,
    maybeHandleCallback,
    consumeJustConnected,
    getOrCreateShareLink,
    cache,
  };

  maybeHandleCallback();
})();
