// lunamap - track.js: Record track (Tools > Record track).
//   Records your position from the phone's location while lunamap is open, and keeps the tracks
//   on this device. A fix is kept when it is accurate enough and has moved far enough (or a minute
//   has passed), and a gap of more than two minutes starts a new segment. Tracks export as GPX,
//   GeoJSON or CSV, copy as R / Python code, or become a drawing (for measuring and profiles).
//   Optionally each kept fix is also sent to your own OwnTracks Recorder (HTTP mode), and a saved
//   track can be sent there afterwards. Nothing is sent anywhere unless you set that up.
//   Web pages only get location while they are open: keep the screen on (the sheet asks the phone
//   to, where it can) or use the OwnTracks app for background logging.
// ---------------------------------------------------------------------------
(function () {
  var IDX = "lunamap-tracks", PRE = "lunamap-track-", SKEY = "lunamap-track-settings", OUT = "lunamap-track-outbox";
  var DEF = { maxAcc: 50, minDist: 5, beat: 60, gap: 120, wake: true, send: false, url: "", user: "", device: "lunamap", pass: "" };
  var S = {}; Object.keys(DEF).forEach(function (k) { S[k] = DEF[k]; });
  try { var sv = JSON.parse(localStorage.getItem(SKEY) || "null"); if (sv) Object.keys(S).forEach(function (k) { if (sv[k] !== undefined) S[k] = sv[k]; }); } catch (e) {}
  function storeS() { try { localStorage.setItem(SKEY, JSON.stringify(S)); } catch (e) {} }

  // a track: { id, name, segs: [[fix, ...], ...] }, fix = [t ms, lat, lon, acc m, ele m|null, speed m/s|null, heading deg|null]
  var cur = null, watch = null, paused = false, lastRx = 0, wake = null, saveT = null, sheet = null, badge = null;
  var liveLine = null, head = null, shown = {}, lastAcc = null, tick = null;

  function index() { try { return JSON.parse(localStorage.getItem(IDX) || "[]"); } catch (e) { return []; } }
  function setIndex(a) { try { localStorage.setItem(IDX, JSON.stringify(a)); } catch (e) {} }
  function loadT(id) { try { return JSON.parse(localStorage.getItem(PRE + id) || "null"); } catch (e) { return null; } }
  function saveT_(t) {
    try { localStorage.setItem(PRE + t.id, JSON.stringify(t)); }
    catch (e) { toast("This device is out of room for tracks: export and delete some"); return false; }
    var a = index().filter(function (x) { return x.id !== t.id; });
    a.unshift({ id: t.id, name: t.name, n: count(t), km: dist(t) / 1000, s: span(t) });
    a.sort(function (p, q) { return q.id - p.id; }); setIndex(a); return true;
  }
  function count(t) { return t.segs.reduce(function (s, g) { return s + g.length; }, 0); }
  function hav(a, b) {
    var R = 6371008.8, r = Math.PI / 180, dl = (b[1] - a[1]) * r, dn = (b[2] - a[2]) * r;
    var h = Math.sin(dl / 2) * Math.sin(dl / 2) + Math.cos(a[1] * r) * Math.cos(b[1] * r) * Math.sin(dn / 2) * Math.sin(dn / 2);
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }
  function dist(t) { var d = 0; t.segs.forEach(function (g) { for (var i = 1; i < g.length; i++) d += hav(g[i - 1], g[i]); }); return d; }
  function span(t) { var f = t.segs.filter(function (g) { return g.length; }); if (!f.length) return 0;
    var a = f[0][0][0], z = f[f.length - 1]; return (z[z.length - 1][0] - a) / 1000; }
  function hms(s) { s = Math.round(s); var h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60;
    return (h ? h + ":" + String(m).padStart(2, "0") : m) + ":" + String(x).padStart(2, "0"); }
  function km(d) { return d < 1000 ? Math.round(d) + " m" : (d / 1000).toFixed(2) + " km"; }
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return "&#" + c.charCodeAt(0) + ";"; }); }
  function r7(v) { return Math.round(v * 1e7) / 1e7; }
  function nameFor(ms) { var d = new Date(ms); return d.toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short" }) + " " +
    d.toLocaleTimeString("en-AU", { hour: "2-digit", minute: "2-digit", hour12: false }); }

  // ---- recording ------------------------------------------------------------------------
  function onFix(p) {
    var c = p.coords, now = p.timestamp || Date.now();
    lastAcc = c.accuracy;
    if (paused || !cur) { status(); return; }
    var f = [now, r7(c.latitude), r7(c.longitude), Math.round(c.accuracy * 10) / 10,
      c.altitude === null || c.altitude === undefined ? null : Math.round(c.altitude * 10) / 10,
      c.speed === null || c.speed === undefined || isNaN(c.speed) ? null : Math.round(c.speed * 100) / 100,
      c.heading === null || c.heading === undefined || isNaN(c.heading) ? null : Math.round(c.heading)];
    var gapped = lastRx && now - lastRx > S.gap * 1000; lastRx = now;
    if (c.accuracy > S.maxAcc) { status(); return; }
    var seg = cur.segs[cur.segs.length - 1];
    if (gapped && seg.length) { seg = []; cur.segs.push(seg); }
    var prev = seg[seg.length - 1];
    if (prev && hav(prev, f) < Math.max(S.minDist, c.accuracy / 2) && now - prev[0] < S.beat * 1000) { moveHead(f); status(); return; }
    seg.push(f); drawLive(); moveHead(f); queueSend(f); status();
    clearTimeout(saveT); saveT = setTimeout(function () { if (cur) saveT_(cur); }, 10000);
  }
  function onErr(e) { toast("Location: " + e.message); status(); }
  function start() {
    if (!navigator.geolocation) { toast("No location in this browser"); return; }
    if (!cur) { var id = Date.now(); cur = { id: id, name: nameFor(id), segs: [[]] }; }
    paused = false; lastRx = 0;
    if (watch === null) watch = navigator.geolocation.watchPosition(onFix, onErr, { enableHighAccuracy: true, maximumAge: 0, timeout: 60000 });
    if (S.wake) keepAwake();
    if (!tick) tick = setInterval(status, 1000);
    live(cur.id);
    status(); render();
  }
  function pause() { if (!cur) return; paused = true; var g = cur.segs[cur.segs.length - 1]; if (g.length) cur.segs.push([]); saveT_(cur); status(); render(); }
  function stop() {
    if (watch !== null) navigator.geolocation.clearWatch(watch); watch = null;
    clearInterval(tick); tick = null; release();
    if (cur) {
      cur.segs = cur.segs.filter(function (g) { return g.length; });
      if (count(cur)) { saveT_(cur); shown[cur.id] = true; toast("Saved: " + cur.name + ", " + km(dist(cur))); }
      else { try { localStorage.removeItem(PRE + cur.id); } catch (e) {} setIndex(index().filter(function (x) { return x.id !== cur.id; })); toast("Nothing recorded"); }
    }
    cur = null; paused = false; live("");
    if (liveLine) { map.removeLayer(liveLine); liveLine = null; } if (head) { map.removeLayer(head); head = null; }
    status(); render(); refreshShown();
  }
  function drawLive() {
    var lls = cur.segs.map(function (g) { return g.map(function (f) { return [f[1], f[2]]; }); });
    if (!liveLine) liveLine = L.polyline(lls, { color: "#ef6c00", weight: 4, opacity: 0.9, interactive: false }).addTo(map);
    else liveLine.setLatLngs(lls);
  }
  function moveHead(f) {
    if (!head) head = L.circleMarker([f[1], f[2]], { radius: 6, color: "#fff", weight: 2, fillColor: "#ef6c00", fillOpacity: 1, interactive: false }).addTo(map);
    else head.setLatLng([f[1], f[2]]);
  }
  function keepAwake() {
    if (!("wakeLock" in navigator) || wake) return;
    navigator.wakeLock.request("screen").then(function (w) { wake = w; w.addEventListener("release", function () { wake = null; status(); }); status(); })
      .catch(function () { status(); });
  }
  function live(v) { try { localStorage.setItem("lunamap-track-live", String(v)); } catch (e) {} }
  function release() { if (wake) { try { wake.release(); } catch (e) {} wake = null; } }
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible") { if (cur && !paused && S.wake) keepAwake(); }
    else if (cur) saveT_(cur);
  });
  window.addEventListener("pagehide", function () { if (cur) saveT_(cur); });

  function status() {
    var t = cur ? (cur.segs.some(function (g) { return g.length; }) ? (Date.now() - cur.segs.filter(function (g) { return g.length; })[0][0][0]) / 1000 : 0) : 0;
    var txt = !cur ? "Not recording." :
      (paused ? "Paused" : "Recording") + " " + hms(t) + ", " + km(dist(cur)) + ", " + count(cur) + " fixes" +
      (lastAcc !== null ? ", accuracy " + Math.round(lastAcc) + " m" + (lastAcc > S.maxAcc ? " (too coarse, waiting)" : "") : ", waiting for a fix") +
      (S.wake && !paused ? (wake ? ". Screen kept on." : ". Keep the screen on.") : ".");
    var el = document.getElementById("trstat"); if (el) el.textContent = txt;
    var ob = outbox().length, oe = document.getElementById("trout");
    if (oe) oe.textContent = S.send || ob ? (ob ? ob + " fix" + (ob === 1 ? "" : "es") + " waiting to send" : "All sent") + (sendErr ? " (" + sendErr + ")" : "") : "";
    if (!badge) {
      badge = document.createElement("button"); badge.id = "trbadge"; badge.type = "button"; badge.onclick = openSheet;
      document.body.appendChild(badge);
    }
    badge.style.display = cur ? "block" : "none";
    if (cur) badge.textContent = (paused ? "II " : "REC ") + km(dist(cur));
    badge.classList.toggle("paused", paused);
  }

  // ---- showing saved tracks -------------------------------------------------------------
  var shownLayers = {};
  function refreshShown() {
    Object.keys(shownLayers).forEach(function (id) { if (!shown[id]) { map.removeLayer(shownLayers[id]); delete shownLayers[id]; } });
    Object.keys(shown).forEach(function (id) {
      if (!shown[id] || shownLayers[id]) return;
      var t = loadT(id); if (!t) { delete shown[id]; return; }
      shownLayers[id] = L.polyline(t.segs.map(function (g) { return g.map(function (f) { return [f[1], f[2]]; }); }),
        { color: "#6a1b9a", weight: 3, opacity: 0.85 }).bindTooltip(esc(t.name) + ", " + km(dist(t)), { sticky: true }).addTo(map);
    });
  }

  // ---- export -------------------------------------------------------------------------------
  function iso(ms) { return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z"); }
  function fileName(t, ext) { var d = new Date(t.id); return "lunamap-track-" + d.getFullYear() + String(d.getMonth() + 1).padStart(2, "0") +
    String(d.getDate()).padStart(2, "0") + "-" + String(d.getHours()).padStart(2, "0") + String(d.getMinutes()).padStart(2, "0") + "." + ext; }
  function save(text, name, mime) {
    var url = URL.createObjectURL(new Blob([text], { type: mime })), a = document.createElement("a");
    a.href = url; a.download = name; document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
  }
  function ascii(s) { return String(s).replace(/[^\x20-\x7e]/g, "-"); }
  function gpx(t) {
    return '<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="lunamap" xmlns="http://www.topografix.com/GPX/1/1">\n<trk><name>' +
      ascii(t.name).replace(/[&<>]/g, "") + "</name>\n" + t.segs.map(function (g) {
        return "<trkseg>\n" + g.map(function (f) { return '<trkpt lat="' + f[1] + '" lon="' + f[2] + '">' + (f[4] !== null ? "<ele>" + f[4] + "</ele>" : "") +
          "<time>" + iso(f[0]) + "</time><hdop>" + Math.max(0.1, Math.round(f[3] / 5 * 10) / 10) + "</hdop></trkpt>"; }).join("\n") + "\n</trkseg>";
      }).join("\n") + "\n</trk>\n</gpx>\n";
  }
  function csv(t) {
    var rows = ["time,lon,lat,accuracy_m,ele_m,speed_ms,heading_deg,segment"];
    t.segs.forEach(function (g, s) { g.forEach(function (f) { rows.push([iso(f[0]), f[2], f[1], f[3], f[4] === null ? "" : f[4],
      f[5] === null ? "" : f[5], f[6] === null ? "" : f[6], s + 1].join(",")); }); });
    return rows.join("\n") + "\n";
  }
  function geojson(t) {
    return JSON.stringify({ type: "FeatureCollection", features: [{ type: "Feature",
      properties: { name: ascii(t.name), start: iso(t.segs[0][0][0]), length_m: Math.round(dist(t)),
        times: t.segs.map(function (g) { return g.map(function (f) { return iso(f[0]); }); }) },
      geometry: { type: "MultiLineString", coordinates: t.segs.map(function (g) { return g.map(function (f) {
        return f[4] !== null ? [f[2], f[1], f[4]] : [f[2], f[1]]; }); }) } }] }) + "\n";
  }
  function code(t, fmt) {
    var data = csv(t).trim();
    if (fmt === "csv") return data + "\n";
    if (fmt === "py") return "import io\nimport pandas as pd\nimport geopandas as gpd\nfrom shapely.geometry import LineString\n" +
      'x = pd.read_csv(io.StringIO("""' + data + '\n"""), parse_dates=["time"])\n' +
      'pts = gpd.GeoDataFrame(x, geometry=gpd.points_from_xy(x.lon, x.lat), crs="EPSG:4326")\n' +
      'segs = [(k, g) for k, g in x.groupby("segment") if len(g) > 1]\n' +
      'line = gpd.GeoDataFrame({"segment": [k for k, _ in segs]}, geometry=[LineString(g[["lon", "lat"]].values) for _, g in segs], crs="EPSG:4326")\n';
    var head = 'x <- read.csv(text = "' + data + '\n")\nx$time <- as.POSIXct(x$time, tz = "UTC", format = "%Y-%m-%dT%H:%M:%SZ")\n' +
      's <- x[x$segment %in% names(which(table(x$segment) > 1)), ]   # segments with a line\n';
    if (fmt === "sf") return head + 'pts <- sf::st_as_sf(x, coords = c("lon", "lat"), crs = 4326)\n' +
      'line <- sf::st_sf(segment = unique(s$segment), geometry = sf::st_sfc(lapply(split(s, s$segment), function(g)\n' +
      '  sf::st_linestring(as.matrix(g[c("lon", "lat")]))), crs = 4326))\n';
    return head + 'pts <- terra::vect(x, geom = c("lon", "lat"), crs = "EPSG:4326")\n' +
      'line <- terra::vect(as.matrix(cbind(id = s$segment, part = 1, s[c("lon", "lat")])), type = "lines", crs = "EPSG:4326")\n';
  }
  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text).then(function () { toast("Copied"); }, function () { fallback(); });
    fallback();
    function fallback() { var ta = document.createElement("textarea"); ta.value = text; document.body.appendChild(ta); ta.select();
      try { document.execCommand("copy"); toast("Copied"); } catch (e) { toast("Copy failed"); } document.body.removeChild(ta); }
  }
  function toDrawing(t) {
    var gj = { type: "FeatureCollection", features: t.segs.filter(function (g) { return g.length > 1; }).map(function (g, i) {
      return { type: "Feature", properties: { label: t.name + (t.segs.length > 1 ? " (" + (i + 1) + ")" : "") },
        geometry: { type: "LineString", coordinates: g.map(function (f) { return [f[2], f[1]]; }) } }; }) };
    if (!gj.features.length) { toast("Too few points for a line"); return; }
    loadDraw().then(function () {
      if (!drawOn) window.toggleDraw();
      var before = drawn.getLayers().length; addGeoJSON(gj); saveDrawings();
      var lyr = drawn.getLayers()[before]; if (lyr) selectDrawn(lyr);
      if (sheet) sheet.style.display = "none";
      toast("Added as a drawing: the Draw panel measures it and draws its profile");
    }).catch(function (e) { toast("Could not open the drawing tools: " + e.message); });
  }

  // ---- import GPX (any logger, or an OwnTracks Recorder export) ------------------------------
  function importGPX(text, fname) {
    var doc = new DOMParser().parseFromString(text, "application/xml"), segs = [];
    var trk = doc.getElementsByTagName("trkseg");
    var groups = trk.length ? [].slice.call(trk) : [doc.documentElement];
    groups.forEach(function (sg) {
      var pts = sg.getElementsByTagName(trk.length ? "trkpt" : "wpt"), g = [];
      [].forEach.call(pts, function (p) {
        var tm = p.getElementsByTagName("time")[0], el = p.getElementsByTagName("ele")[0];
        var t = tm ? Date.parse(tm.textContent) : NaN;
        g.push([isNaN(t) ? 0 : t, r7(+p.getAttribute("lat")), r7(+p.getAttribute("lon")), 0, el ? +el.textContent : null, null, null]);
      });
      if (g.length) segs.push(g);
    });
    if (!segs.length) { toast("No track points in " + fname); return; }
    var t0 = segs[0][0][0] || Date.now(), id = t0, a = index(), n0 = segs.reduce(function (q, g) { return q + g.length; }, 0);
    if (segs[0][0][0] && a.some(function (x) { var o = loadT(x.id); return o && o.segs.length && Math.floor(o.segs[0][0][0] / 1000) === Math.floor(t0 / 1000) && count(o) === n0; })) {
      toast("Already have that track"); return; }
    while (a.some(function (x) { return x.id === id; })) id++;
    var nm = doc.getElementsByTagName("name")[0];
    var t = { id: id, name: (nm && nm.textContent.trim()) || fname.replace(/\.gpx$/i, ""), segs: segs };
    if (saveT_(t)) { shown[id] = true; refreshShown(); render(); toast("Imported " + count(t) + " points");
      try { map.fitBounds(shownLayers[id].getBounds(), { maxZoom: 16 }); } catch (e) {} }
  }

  // ---- OwnTracks Recorder (HTTP mode) --------------------------------------------------------
  var sending = false, sendErr = "";
  function outbox() { try { return JSON.parse(localStorage.getItem(OUT) || "[]"); } catch (e) { return []; } }
  function setOutbox(a) { try { localStorage.setItem(OUT, JSON.stringify(a.slice(-20000))); } catch (e) {} }
  function payload(f) {
    var p = { _type: "location", lat: f[1], lon: f[2], tst: Math.round(f[0] / 1000), acc: Math.round(f[3]), tid: "lm" };
    if (f[4] !== null) p.alt = Math.round(f[4]);
    if (f[5] !== null) p.vel = Math.round(f[5] * 3.6);
    if (f[6] !== null) p.cog = f[6];
    return p;
  }
  function queueSend(f) { if (!S.send || !S.url) return; var a = outbox(); a.push(payload(f)); setOutbox(a); pump(); }
  function headers() {
    var h = { "Content-Type": "application/json", "X-Limit-U": S.user || "me", "X-Limit-D": S.device || "lunamap" };
    if (S.user && S.pass) h.Authorization = "Basic " + btoa(S.user + ":" + S.pass);
    return h;
  }
  function post(p) {
    return fetch(S.url, { method: "POST", headers: headers(), body: JSON.stringify(p), credentials: "omit" })
      .then(function (r) { if (!r.ok) throw new Error("server said " + r.status); });
  }
  function pump() {
    if (sending || !S.url || !navigator.onLine) return;
    var a = outbox(); if (!a.length) { status(); return; }
    sending = true;
    post(a[0]).then(function () {
      sendErr = ""; var b = outbox(); b.shift(); setOutbox(b); sending = false; status(); pump();
    }).catch(function (e) {
      sending = false; sendErr = e.message === "Failed to fetch" ? "can't reach the server" : e.message; status();
      setTimeout(pump, 30000);
    });
  }
  window.addEventListener("online", pump);
  setTimeout(pump, 3000);
  function sendTrack(t) {
    if (!S.url) { toast("Set your server under Send to my server first"); return; }
    var a = outbox(); t.segs.forEach(function (g) { g.forEach(function (f) { if (f[0]) a.push(payload(f)); }); });
    setOutbox(a); toast("Sending " + count(t) + " fixes"); pump();
  }

  // ---- sheet -------------------------------------------------------------------------------
  function render() {
    if (!sheet) return;
    document.getElementById("trrec").textContent = !cur ? "Record" : paused ? "Resume" : "Pause";
    document.getElementById("trstop").style.display = cur ? "" : "none";
    var a = index().filter(function (x) { return !cur || x.id !== cur.id; });
    document.getElementById("trlist").innerHTML = a.length ? a.map(function (x) {
      return "<div class='trrow' data-id='" + x.id + "'><label><input type='checkbox' data-a='show'" + (shown[x.id] ? " checked" : "") + "> " +
        "<b>" + esc(x.name) + "</b></label> <span class='trmeta'>" + km(x.km * 1000) + (x.s ? ", " + hms(x.s) : "") + ", " + x.n + " pts</span><br>" +
        "<button data-a='gpx'>GPX</button><button data-a='geojson'>GeoJSON</button><button data-a='csv'>CSV</button>" +
        "<button data-a='copy'>Copy</button><button data-a='draw'>To drawing</button>" +
        (S.url ? "<button data-a='send'>Send</button>" : "") + "<button data-a='del'>Delete</button></div>";
    }).join("") : "<p class='small' style='color:#666'>No saved tracks yet.</p>";
    status();
  }
  function openSheet() {
    if (typeof setMenu === "function") setMenu(null);
    if (!sheet) {
      sheet = document.createElement("div"); sheet.id = "trsheet"; sheet.className = "sheet";
      sheet.innerHTML = "<h2><span>Track</span><button id='trclose' aria-label='Close'>x</button></h2>" +
        "<div id='trstat' class='small'></div>" +
        "<div class='acts'><button id='trrec' type='button'>Record</button><button id='trstop' type='button'>Stop and save</button>" +
        "<button id='trimp' type='button'>Import GPX...</button></div>" +
        "<input id='trfile' type='file' accept='.gpx,application/gpx+xml' hidden>" +
        "<p class='small' style='color:#666'>Kept on this device. The phone only gives a web page its location while the page is open, " +
        "so leave lunamap on screen while recording (for all-day or background logging use the OwnTracks app).</p>" +
        "<div id='trlist' class='small'></div>" +
        "<label class='small dfield'>Copy as <select id='trfmt'><option value='terra'>R: terra</option><option value='sf'>R: sf</option>" +
        "<option value='py'>Python: geopandas</option><option value='csv'>CSV</option></select></label>" +
        "<details><summary class='small'><b>Settings</b></summary><div class='small trset'>" +
        "<label class='bwf'>Skip fixes worse than <input data-k='maxAcc' inputmode='decimal'> m</label><br>" +
        "<label class='bwf'>Keep a fix every <input data-k='minDist' inputmode='decimal'> m moved, or every <input data-k='beat' inputmode='decimal'> s</label><br>" +
        "<label class='bwf'>New segment after a gap of <input data-k='gap' inputmode='decimal'> s</label><br>" +
        "<label class='bwf'><input type='checkbox' data-c='wake'> Keep the screen on while recording</label></div></details>" +
        "<details><summary class='small'><b>Send to my server</b> (OwnTracks Recorder)</summary><div class='small trset'>" +
        "<label class='bwf'>URL <input data-k='url' placeholder='https://track.example.org/pub' style='width:16em'></label><br>" +
        "<label class='bwf'>User <input data-k='user' style='width:7em'></label> <label class='bwf'>Device <input data-k='device' style='width:7em'></label><br>" +
        "<label class='bwf'>Password <input data-k='pass' type='password' style='width:9em'></label><br>" +
        "<label class='bwf'><input type='checkbox' data-c='send'> Send each fix while recording</label> <button id='trtest' type='button'>Test</button>" +
        "<div id='trout'></div>" +
        "<p style='color:#666'>Posts OwnTracks location messages to your own Recorder, which has to allow this site (CORS); fixes made offline wait " +
        "and go when there is signal. The password is kept on this device only.</p></div></details>";
      document.body.appendChild(sheet); L.DomEvent.disableClickPropagation(sheet); L.DomEvent.disableScrollPropagation(sheet);
      sheet.querySelector("#trclose").onclick = function () { sheet.style.display = "none"; };
      sheet.querySelector("#trrec").onclick = function () { if (!cur || paused) start(); else pause(); };
      sheet.querySelector("#trstop").onclick = stop;
      sheet.querySelector("#trimp").onclick = function () { sheet.querySelector("#trfile").click(); };
      sheet.querySelector("#trfile").onchange = function () {
        var f = this.files && this.files[0]; this.value = ""; if (!f) return;
        f.text().then(function (t) { importGPX(t, f.name); });
      };
      [].forEach.call(sheet.querySelectorAll("input[data-k]"), function (inp) {
        var k = inp.getAttribute("data-k"); inp.value = S[k];
        inp.oninput = function () { S[k] = typeof DEF[k] === "number" ? (+inp.value > 0 ? +inp.value : DEF[k]) : inp.value.trim(); storeS(); if (k === "url") render(); };
      });
      [].forEach.call(sheet.querySelectorAll("input[data-c]"), function (inp) {
        var k = inp.getAttribute("data-c"); inp.checked = !!S[k];
        inp.onchange = function () { S[k] = inp.checked; storeS(); if (k === "wake") { if (S.wake && cur && !paused) keepAwake(); else if (!S.wake) release(); } status(); };
      });
      try { var cf = localStorage.getItem("lunamap-track-copy"); if (cf) sheet.querySelector("#trfmt").value = cf; } catch (e) {}
      sheet.querySelector("#trfmt").onchange = function (e) { try { localStorage.setItem("lunamap-track-copy", e.target.value); } catch (er) {} };
      sheet.querySelector("#trtest").onclick = function () {
        if (!S.url) { toast("Enter the URL first"); return; }
        var c = lastAcc !== null && head ? head.getLatLng() : map.getCenter();
        post({ _type: "location", lat: r7(c.lat), lon: r7(c.lng), tst: Math.round(Date.now() / 1000), acc: 999, tid: "lm" })
          .then(function () { sendErr = ""; toast("The server took it"); status(); })
          .catch(function (e) { sendErr = e.message === "Failed to fetch" ? "can't reach the server (address, or it doesn't allow this site)" : e.message; status(); toast("Test failed: " + sendErr); });
      };
      sheet.querySelector("#trlist").onclick = function (e) {
        var a = e.target.getAttribute("data-a"), row = e.target.closest(".trrow"); if (!a || !row) return;
        var id = +row.getAttribute("data-id");
        if (a === "show") { shown[id] = e.target.checked; refreshShown();
          if (e.target.checked && shownLayers[id]) try { map.fitBounds(shownLayers[id].getBounds(), { maxZoom: 16 }); } catch (er) {} return; }
        var t = loadT(id); if (!t) return;
        if (a === "gpx") save(gpx(t), fileName(t, "gpx"), "application/gpx+xml");
        else if (a === "geojson") save(geojson(t), fileName(t, "geojson"), "application/geo+json");
        else if (a === "csv") save(csv(t), fileName(t, "csv"), "text/csv");
        else if (a === "copy") copyText(code(t, sheet.querySelector("#trfmt").value));
        else if (a === "draw") toDrawing(t);
        else if (a === "send") sendTrack(t);
        else if (a === "del" && confirm("Delete the track " + t.name + " from this device?")) {
          try { localStorage.removeItem(PRE + id); } catch (er) {} setIndex(index().filter(function (x) { return x.id !== id; }));
          shown[id] = false; refreshShown(); render();
        }
      };
    }
    sheet.style.display = "block"; setFolded(true); render();
  }
  document.getElementById("track").onclick = openSheet;

  // a recording left running when the page was closed: offer to carry on
  var open_ = index().filter(function (x) { return Date.now() - x.id < 12 * 3600e3; })[0];
  try { var lr = localStorage.getItem("lunamap-track-live"); if (lr && open_ && +lr === open_.id) {
    var t0 = loadT(open_.id); if (t0) { cur = t0; paused = true; cur.segs.push([]); drawLive(); status(); toast("A track was still recording: open Track to resume or stop it"); }
  } } catch (e) {}

  window.lunamapTrack = { gpx: gpx, csv: csv, geojson: geojson, code: code, importGPX: importGPX, payload: payload, hav: hav,   // for testing
    _set: function (t) { cur = t; }, _onFix: onFix, _cur: function () { return cur; }, stop: stop, start: start, settings: S };
})();
