// lunamap - extras.js: two more rows in the pin panel.
//   Elevation              height at the pin from the Tasmania 2 m DEM (reuses
//                          js/profile.js and geotiff.js, loaded on first use)
//   Nearest fire station   when Stations is on: the fire station nearest by road,
//                          using the same LIST road network and Dijkstra as Route
// ---------------------------------------------------------------------------
var EXTRA_GEOTIFF = "https://cdn.jsdelivr.net/npm/geotiff@3.0.5/dist-browser/geotiff.js";
var extraInfo = {}, extraSeq = 0;

function refreshExtras(seq) { if (seq === extraSeq && pin) showCoords(pin.getLatLng()); }

function lookupElevation(ll, seq) {
  return loadScript(EXTRA_GEOTIFF).then(function () { return loadScript("js/profile.js"); }).then(function () {
    var P = window.lunamapProfile, s = P.samplePoints([[ll.lng, ll.lat]], 2);
    return P.sampleDEM(s.pts, 2).then(function () { return s.pts[0].z; });
  }).then(function (z) {
    if (seq !== extraSeq) return;
    extraInfo.elev = z === null ? "(outside the elevation model)" : z.toFixed(1) + " m (AHD)";
  }).catch(function () { if (seq === extraSeq) extraInfo.elev = null; });
}

// Grow the shared road cache (routeCache, see route.js) for this pin to radius r on a tier.
function ensureRoads(P, tier, r) {
  var key = P[0].toFixed(6) + "," + P[1].toFixed(6);
  if (!routeCache || routeCache.key !== key) routeCache = { key: key, feats: [], ids: {}, r: { local: 0, major: 0, hwy: 0 } };
  var cache = routeCache;
  if (cache.r[tier] >= r) return Promise.resolve(cache);
  var dLat = r / 111320, dLon = r / (111320 * Math.cos(P[1] * Math.PI / 180));
  return fetchSegments(TIERS[tier].layer, P[0] - dLon, P[1] - dLat, P[0] + dLon, P[1] + dLat, 0).then(function (fs) {
    fs.forEach(function (f) {
      var id = f.attributes && f.attributes.OBJECTID;
      if (id == null || !cache.ids[id]) { if (id != null) cache.ids[id] = 1; cache.feats.push(f); }
    });
    cache.r[tier] = r; return cache;
  });
}

function nearestStation(ll) {
  var P = [ll.lng, ll.lat], dLat = 0.4, dLon = 0.55;
  var url = EM + "6/query?geometry=" + [P[0] - dLon, P[1] - dLat, P[0] + dLon, P[1] + dLat].map(function (v) { return v.toFixed(5); }).join(",") +
    "&geometryType=esriGeometryEnvelope&inSR=4326&outSR=4326&spatialRel=esriSpatialRelIntersects" +
    "&outFields=BRIGADE,STATION_TYPE&returnGeometry=true&f=geojson";
  return fetch(url).then(function (r) { return r.json(); }).then(function (gj) {
    var st = (gj.features || []).filter(function (f) { return f.geometry; }).map(function (f) {
      var c = f.geometry.coordinates; return { name: f.properties.BRIGADE, type: f.properties.STATION_TYPE, c: c, d: hav(P, c) };
    }).sort(function (a, b) { return a.d - b.d; }).slice(0, 4);
    if (!st.length) return "(none within about 40 km)";
    var R = Math.min(40000, st[st.length - 1].d * 1.3 + 1500);
    return ensureRoads(P, "local", Math.min(R, 7000)).then(function () {
      return R > 7000 ? ensureRoads(P, "major", R) : routeCache;
    }).then(function (cache) {
      var G = buildGraph(cache.feats), sn = snapTo(G, P);
      if (!sn) throw new Error("no roads");
      var target = {};
      st.forEach(function (s) {
        var t = snapTo(G, s.c); if (!t) return;
        var toU = t.toU.len, toV = t.toV.len, node = toU <= toV ? t.ed.u : t.ed.v;
        if (!target[node]) target[node] = { s: s, extra: t.off + Math.min(toU, toV) };
      });
      var res = nearestJunction(G, sn, function (u) { return !!target[u]; });
      var nm = function (s) { var n = titleCase(s.name || "fire station"); return /brigade/i.test(n) ? n : n + " brigade"; };
      if (!res) return nm(st[0]) + " - " + fmtDist(st[0].d) + " direct (no road connection found)";
      var t = target[res.node], road = res.dist + t.extra + sn.off;
      return nm(t.s) + " - " + fmtDist(road) + " by road (" + fmtDist(t.s.d) + " direct)";
    });
  });
}

function lookupExtras(ll) {
  var seq = ++extraSeq; extraInfo = { elev: "..." };
  var jobs = [lookupElevation(ll, seq)];
  if (OVERLAYS.stations && OVERLAYS.stations.on) {
    extraInfo.station = "...";
    jobs.push(nearestStation(ll).then(function (txt) { if (seq === extraSeq) extraInfo.station = txt; })
      .catch(function (e) { if (seq === extraSeq) extraInfo.station = "(lookup failed: " + e.message + ")"; }));
  }
  jobs.forEach(function (j) { j.then(function () { refreshExtras(seq); }); });
}
function extraRows() {
  var rows = [];
  if (extraInfo.elev) rows.push({ k: "Elevation", v: extraInfo.elev });
  if (extraInfo.station && OVERLAYS.stations && OVERLAYS.stations.on) rows.push({ k: "Nearest fire station", v: extraInfo.station });
  return rows;
}
