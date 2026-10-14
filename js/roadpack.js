// lunamap - roadpack.js: roads (and fire stations) saved for routing without signal.
// "Save this area" in Offline also cuts a road pack from theLIST transport layers:
//   all roads and tracks (layer 8) for the saved area, and highways + arterials
//   (layer 5) and fire stations for 25 km around it, so Route, Bigger road and
//   Nearest fire station keep working offline.
// Packs are gzipped JSON in the Cache API ("lunamap-roads-v1"). Road fetches in
// route.js fall back to them when the network fails.
// ---------------------------------------------------------------------------
var ROADPACK_CACHE = "lunamap-roads-v1";
var roadPacks = null;            // loaded packs: [{ bbox, outer, local:[], major:[], stations:[] }]

function gzipJSON(obj) {
  var blob = new Blob([JSON.stringify(obj)]);
  if (!window.CompressionStream) return Promise.resolve({ body: blob, gz: false });
  return new Response(blob.stream().pipeThrough(new CompressionStream("gzip"))).blob()
    .then(function (b) { return { body: b, gz: true }; });
}
function gunzipJSON(resp) {
  var gz = resp.headers.get("X-Lunamap-Gzip") === "1";
  if (!gz) return resp.json();
  return new Response(resp.body.pipeThrough(new DecompressionStream("gzip"))).json();
}

// compact form: [OBJECTID, PRI_NAME, TRAN_CLASS, SURFACE_TY, STATUS, TSEG_FEAT, paths]
function packFeats(fs) {
  var seen = {}, out = [];
  fs.forEach(function (f) {
    var a = f.attributes || {}; if (!f.geometry || seen[a.OBJECTID]) return; seen[a.OBJECTID] = 1;
    out.push([a.OBJECTID, a.PRI_NAME || null, a.TRAN_CLASS || null, a.SURFACE_TY || null, a.STATUS || null, a.TSEG_FEAT || null, f.geometry.paths]);
  });
  return out;
}
function unpackFeat(r) {
  return { attributes: { OBJECTID: r[0], PRI_NAME: r[1], TRAN_CLASS: r[2], SURFACE_TY: r[3], STATUS: r[4], TSEG_FEAT: r[5] },
           geometry: { paths: r[6] } };
}

function loadRoadPacks() {
  if (roadPacks) return Promise.resolve(roadPacks);
  if (!window.caches) return Promise.resolve([]);
  return caches.open(ROADPACK_CACHE).then(function (c) {
    return c.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) { return c.match(k).then(gunzipJSON); }));
    });
  }).then(function (ps) { roadPacks = ps; return ps; }).catch(function () { return []; });
}

function bboxHit(a, b) { return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1]; }
function pathsHit(paths, q) {
  for (var i = 0; i < paths.length; i++) for (var j = 0; j < paths[i].length; j++) {
    var p = paths[i][j]; if (p[0] >= q[0] && p[0] <= q[2] && p[1] >= q[1] && p[1] <= q[3]) return true;
  }
  return false;
}

// road features from saved packs for a query box, or null when no pack covers it
function offlineSegments(layer, w, s, e, n) {
  var q = [w, s, e, n], key = layer === 8 ? "local" : "major";
  return loadRoadPacks().then(function (ps) {
    var hit = ps.filter(function (p) { return bboxHit(key === "local" ? p.bbox : p.outer, q); });
    if (!hit.length) return null;
    var out = [];
    hit.forEach(function (p) { (p[key] || []).forEach(function (r) { if (pathsHit(r[6], q)) out.push(unpackFeat(r)); }); });
    return out;
  });
}
function offlineGates(w, s, e, n) {
  return loadRoadPacks().then(function (ps) {
    var out = [];
    ps.forEach(function (p) { (p.gates || []).forEach(function (g) {
      if (g[0] >= w && g[0] <= e && g[1] >= s && g[1] <= n) out.push(g); }); });
    return out;
  });
}
function offlineStations(w, s, e, n) {
  var q = [w, s, e, n];
  return loadRoadPacks().then(function (ps) {
    var out = [], seen = {};
    ps.forEach(function (p) { (p.stations || []).forEach(function (st) {
      if (!seen[st[0] + "," + st[1]] && st[0] >= q[0] && st[0] <= q[2] && st[1] >= q[1] && st[1] <= q[3]) {
        seen[st[0] + "," + st[1]] = 1;
        out.push({ type: "Feature", properties: { BRIGADE: st[2], STATION_TYPE: st[3] }, geometry: { type: "Point", coordinates: [st[0], st[1]] } });
      } }); });
    return { type: "FeatureCollection", features: out };
  });
}

// cut and store a pack for the bounds; resolves to a short status string
function saveRoadPack(bounds, progress) {
  var w = bounds.getWest(), s = bounds.getSouth(), e = bounds.getEast(), n = bounds.getNorth();
  var widthKm = hav([w, (s + n) / 2], [e, (s + n) / 2]) / 1000;
  if (widthKm > 60) return Promise.resolve("Roads not saved: area wider than 60 km - zoom in");
  var pad = 25000, mid = (s + n) / 2, dLat = pad / 111320, dLon = pad / (111320 * Math.cos(mid * Math.PI / 180));
  var outer = [w - dLon, s - dLat, e + dLon, n + dLat];
  progress("Saving roads for routing...");
  return Promise.all([
    fetchSegmentsOnline(8, w, s, e, n, 0),
    fetch(TOPO + "59/query?geometry=" + [w, s, e, n].map(function (v) { return v.toFixed(6); }).join(",") +
      "&geometryType=esriGeometryEnvelope&inSR=4326&outSR=4326&spatialRel=esriSpatialRelIntersects" +
      "&outFields=OBJECTID,BARRIER_TY&returnGeometry=true&geometryPrecision=7&f=json").then(function (r) { return r.json(); })
      .catch(function () { return { features: [] }; }),
    fetchSegmentsOnline(5, outer[0], outer[1], outer[2], outer[3], 0),
    fetch(EM + "6/query?geometry=" + outer.map(function (v) { return v.toFixed(5); }).join(",") +
      "&geometryType=esriGeometryEnvelope&inSR=4326&outSR=4326&spatialRel=esriSpatialRelIntersects" +
      "&outFields=BRIGADE,STATION_TYPE&returnGeometry=true&f=geojson").then(function (r) { return r.json(); })
  ]).then(function (r) {
    var gates = (r[1].features || []).filter(function (f) { return f.geometry; }).map(function (f) {
      return [f.geometry.x, f.geometry.y, String(f.attributes.BARRIER_TY || "Unknown Barrier").toUpperCase(), f.attributes.OBJECTID]; });
    r.splice(1, 1);
    var pack = { bbox: [w, s, e, n], outer: outer, saved: new Date().toISOString(), local: packFeats(r[0]), major: packFeats(r[1]),
      gates: gates, stations: (r[2].features || []).filter(function (f) { return f.geometry; }).map(function (f) {
        return [f.geometry.coordinates[0], f.geometry.coordinates[1], f.properties.BRIGADE, f.properties.STATION_TYPE]; }) };
    return gzipJSON(pack).then(function (z) {
      var key = "/roadpack/" + pack.bbox.map(function (v) { return v.toFixed(4); }).join(",");
      return caches.open(ROADPACK_CACHE).then(function (c) {
        return c.put(key, new Response(z.body, { headers: { "Content-Type": "application/json", "X-Lunamap-Gzip": z.gz ? "1" : "0" } }));
      }).then(function () {
        roadPacks = null;
        return "Roads saved for routing: " + pack.local.length.toLocaleString("en-AU") + " road and track pieces, " +
          pack.stations.length + (pack.stations.length === 1 ? " fire station (" : " fire stations (") + (z.body.size / 1048576).toFixed(1) + " MB)";
      });
    });
  }).catch(function (err) { return "Roads not saved: " + err.message; });
}
function roadPackStatus() {
  return loadRoadPacks().then(function (ps) {
    return ps.length ? ps.length + (ps.length === 1 ? " road pack" : " road packs") + " for routing" : "";
  });
}
function clearRoadPacks() { roadPacks = null; return window.caches ? caches.delete(ROADPACK_CACHE) : Promise.resolve(); }
