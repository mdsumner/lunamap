// lunamap - route.js (classic script; shares globals with the other js/ files, loaded in order)
// ---------------------------------------------------------------------------
// Route: from the nearest road junction of a chosen size to the pin, along
// theLIST transport network (TopographyAndRelief "All Transport", layer 8),
// which includes vehicular tracks and fire trails and is noded at intersections.
// Junction sizes ("Bigger road" steps up):
//   0 collector road or bigger, 1 sub-arterial/arterial/highway (default),
//   2 highway, 3 two highways meeting
// A junction is a node on a road of that size where at least two differently
// named roads meet. Segments are fetched for a box around the pin that grows
// until one is reachable; Dijkstra runs in the browser. Traffic direction is
// ignored, so the same route serves "to here" and "from here".
// ---------------------------------------------------------------------------
var TOPO = LISTPUB + "TopographyAndRelief/MapServer/";
var HWY = { "National/State Highway": 1 };
var ART = { "National/State Highway": 1, "Arterial Road": 1, "Sub Arterial Road": 1 };
var COL = { "National/State Highway": 1, "Arterial Road": 1, "Sub Arterial Road": 1, "Collector Road": 1 };
// Road data comes in three tiers, all views of the same LIST transport segments
// (same OBJECTIDs and vertices, so they join up): every road and track near the
// pin, highways + arterials further out, and highways only for the long reach.
var TIERS = {
  local: { layer: 8, radii: [1200, 3000, 7000, 15000] },
  major: { layer: 5, radii: [15000, 30000, 60000] },
  hwy:   { layer: 4, radii: [60000, 100000, 150000] }
};
// Highway "intersection": a node where three or more highway segments meet,
// so a highway that only changes its name through a town does not count.
var ROUTE_LEVELS = [
  { label: "collector road", cls: COL, reach: { local: 15000 } },
  { label: "main road", cls: ART, reach: { local: 15000 } },
  { label: "highway", cls: HWY, reach: { local: 7000, major: 60000 } },
  { label: "highway intersection", cls: HWY, three: true, reach: { local: 7000, major: 30000, hwy: 150000 } }
];
var routeInfo = null, routeSeq = 0, routeLayer = L.layerGroup().addTo(map), routeCache = null;
var routeBtn = document.getElementById("route"), biggerBtn = document.getElementById("bigger");

function hav(a, b) {                       // metres between [lon, lat] points
  var R = 6371008.8, r = Math.PI / 180, dLat = (b[1] - a[1]) * r, dLon = (b[0] - a[0]) * r;
  var h = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
          Math.cos(a[1] * r) * Math.cos(b[1] * r) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return 2 * R * Math.asin(Math.sqrt(h));
}
function bearing(a, b) {
  var r = Math.PI / 180, y = Math.sin((b[0] - a[0]) * r) * Math.cos(b[1] * r),
      x = Math.cos(a[1] * r) * Math.sin(b[1] * r) - Math.sin(a[1] * r) * Math.cos(b[1] * r) * Math.cos((b[0] - a[0]) * r);
  return (Math.atan2(y, x) / r + 360) % 360;
}
function lineLen(c) { var d = 0; for (var i = 1; i < c.length; i++) d += hav(c[i - 1], c[i]); return d; }
function fmtDist(m) { return m < 1000 ? Math.round(m / 10) * 10 + " m" : (m / 1000).toFixed(m < 10000 ? 1 : 0) + " km"; }

// fetch segments in a box; split into quarters when the server truncates
function fetchSegments(layer, w, s, e, n, depth) {
  var url = TOPO + layer + "/query?geometry=" + [w, s, e, n].map(function (v) { return v.toFixed(6); }).join(",") +
    "&geometryType=esriGeometryEnvelope&inSR=4326&outSR=4326&spatialRel=esriSpatialRelIntersects" +
    "&outFields=OBJECTID,PRI_NAME,TRAN_CLASS,SURFACE_TY,STATUS,TSEG_FEAT&returnGeometry=true&geometryPrecision=7&f=json";
  return fetch(url).then(function (r) { return r.json(); }).then(function (j) {
    if (j.error) throw new Error(j.error.message || "road query failed");
    var feats = j.features || [];
    if (j.exceededTransferLimit) {
      if (depth >= 6) throw new Error("too much road data - try a smaller road size");
      var mx = (w + e) / 2, my = (s + n) / 2;
      return Promise.all([fetchSegments(layer, w, s, mx, my, depth + 1), fetchSegments(layer, mx, s, e, my, depth + 1),
                          fetchSegments(layer, w, my, mx, n, depth + 1), fetchSegments(layer, mx, my, e, n, depth + 1)])
        .then(function (parts) { return [].concat.apply([], parts); });
    }
    return feats;
  });
}

function buildGraph(feats) {
  var nodes = {}, adj = [], meta = [], seen = {}, edges = [];
  function node(c) {
    var k = c[0].toFixed(7) + "," + c[1].toFixed(7);
    if (nodes[k] === undefined) { nodes[k] = adj.length; adj.push([]); meta.push({ c: c, k: k, inc: [] }); }
    return nodes[k];
  }
  feats.forEach(function (f) {
    var a = f.attributes || {}, g = f.geometry;
    if (!g || !g.paths || seen[a.OBJECTID]) return;
    seen[a.OBJECTID] = true;
    if (/closed|proposed/i.test(String(a.STATUS || "")) || /ferry/i.test(String(a.TSEG_FEAT || ""))) return;
    g.paths.forEach(function (c) {
      if (c.length < 2) return;
      var u = node(c[0]), v = node(c[c.length - 1]);
      var ed = { u: u, v: v, c: c, len: lineLen(c), name: a.PRI_NAME || null, cls: a.TRAN_CLASS || "", surf: a.SURFACE_TY || "" };
      edges.push(ed);
      adj[u].push({ to: v, e: ed, fwd: true }); adj[v].push({ to: u, e: ed, fwd: false });
      meta[u].inc.push(ed); if (v !== u) meta[v].inc.push(ed);
    });
  });
  return { adj: adj, meta: meta, edges: edges };
}
function junctionNames(m) {
  var n = {}; m.inc.forEach(function (e) { if (e.name) n[e.name] = 1; }); return Object.keys(n).sort();
}
function isJunction(m, L) {
  if (junctionNames(m).length < 2) return false;
  var n = 0;
  m.inc.forEach(function (e) { if (L.cls[e.cls]) n++; });
  return L.three ? n >= 3 : n > 0;
}

// nearest point on the network to p ([lon, lat])
function snapTo(G, p) {
  var kx = Math.cos(p[1] * Math.PI / 180), best = null;
  G.edges.forEach(function (ed) {
    for (var i = 1; i < ed.c.length; i++) {
      var a = ed.c[i - 1], b = ed.c[i];
      var ax = (a[0] - p[0]) * kx, ay = a[1] - p[1], bx = (b[0] - p[0]) * kx, by = b[1] - p[1];
      var dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
      var t = L2 > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L2)) : 0;
      var qx = ax + t * dx, qy = ay + t * dy, d2 = qx * qx + qy * qy;
      if (!best || d2 < best.d2) best = { d2: d2, ed: ed, i: i, pt: [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])] };
    }
  });
  if (!best) return null;
  var ed = best.ed, head = ed.c.slice(0, best.i).concat([best.pt]), tail = [best.pt].concat(ed.c.slice(best.i));
  best.toU = { c: head.slice().reverse(), len: lineLen(head) };     // snap point -> ed.u
  best.toV = { c: tail, len: lineLen(tail) };                       // snap point -> ed.v
  best.off = hav(p, best.pt);
  return best;
}

// Dijkstra from the snap point to the first junction of level L
function nearestJunction(G, sn, L) {
  var n = G.adj.length, dist = new Float64Array(n).fill(Infinity), prev = new Array(n), done = new Uint8Array(n);
  var heap = [];
  function push(d, i) { heap.push([d, i]); var k = heap.length - 1;
    while (k > 0) { var p = (k - 1) >> 1; if (heap[p][0] <= heap[k][0]) break; var t = heap[p]; heap[p] = heap[k]; heap[k] = t; k = p; } }
  function pop() { var top = heap[0], last = heap.pop();
    if (heap.length) { heap[0] = last; var k = 0;
      for (;;) { var l = 2 * k + 1, r = l + 1, m = k;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
        if (m === k) break; var t = heap[m]; heap[m] = heap[k]; heap[k] = t; k = m; } }
    return top; }
  var e = sn.ed;
  [[e.u, sn.toU], [e.v, sn.toV]].forEach(function (x) {
    if (x[1].len < dist[x[0]]) { dist[x[0]] = x[1].len; prev[x[0]] = { start: true, c: x[1].c, e: e }; push(dist[x[0]], x[0]); }
  });
  while (heap.length) {
    var u = pop()[1];
    if (done[u]) continue; done[u] = 1;
    if (typeof L === "function" ? L(u) : isJunction(G.meta[u], L)) return { node: u, dist: dist[u], prev: prev };
    G.adj[u].forEach(function (a) {
      var nd = dist[u] + a.e.len;
      if (nd < dist[a.to]) { dist[a.to] = nd; prev[a.to] = { from: u, e: a.e, fwd: a.fwd }; push(nd, a.to); }
    });
  }
  return null;
}

// legs from the junction to the pin, as edges oriented in travel direction
function legsFromJunction(res) {
  var legs = [], k = res.node;
  for (;;) {
    var p = res.prev[k];
    if (p.start) { legs.push({ c: p.c.slice().reverse(), e: p.e }); break; }   // node -> snap point
    legs.push({ c: p.fwd ? p.e.c.slice().reverse() : p.e.c.slice(), e: p.e }); // k -> p.from
    k = p.from;
  }
  return legs;
}

function unnamedLabel(cls) {
  var c = String(cls || "road").toLowerCase();
  return "unnamed " + (c === "vehicular track" ? "track" : c);
}
function describeRoute(G, res, sn, level) {
  var groups = [];
  legsFromJunction(res).forEach(function (l) {
    var e = l.e, g = groups[groups.length - 1], len = lineLen(l.c);
    var same = g && (e.name ? g.name === e.name : !g.name);          // consecutive unnamed pieces merge
    if (same) {
      g.c = g.c.concat(l.c.slice(1)); g.len += len; g.cls[e.cls] = 1; g.surf[e.surf] = 1;
      if (!e.name && g.label !== unnamedLabel(e.cls)) g.label = "unnamed tracks and roads";
    } else {
      var cls = {}, surf = {}; cls[e.cls] = 1; surf[e.surf] = 1;
      groups.push({ name: e.name, label: e.name || unnamedLabel(e.cls), c: l.c.slice(), len: len, cls: cls, surf: surf });
    }
  });
  var jm = G.meta[res.node], jnames = junctionNames(jm);
  var parts = [], total = 0;
  groups.forEach(function (g, i) {
    total += g.len;
    var note = [];
    if (g.cls["Vehicular Track"] && g.name) note.push("track");
    if (g.surf["4WD required"]) note.push("4WD");
    else if (g.surf["Unsealed"]) note.push("unsealed");
    var what = g.label + (note.length ? " (" + note.join(", ") + ")" : "") + " " + fmtDist(g.len);
    if (i === 0) { parts.push("take " + what); return; }
    var pc = groups[i - 1].c, a = pc[Math.max(0, pc.length - 2)], b = pc[pc.length - 1], c2 = g.c[Math.min(1, g.c.length - 1)];
    var d = ((bearing(b, c2) - bearing(a, b) + 540) % 360) - 180;
    var turn = Math.abs(d) < 30 ? "continue onto" : Math.abs(d) > 150 ? "turn back onto" :
               (d > 0 ? (d > 110 ? "sharp right onto" : "right onto") : (d < -110 ? "sharp left onto" : "left onto"));
    parts.push(turn + " " + what);
  });
  var jlabel = jnames.join(" / ");
  var text = "From " + jlabel + ": " + parts.join(", then ");
  if (sn.off > 25) text += "; the pin is " + fmtDist(sn.off) + " off the road";
  text += ". Total " + fmtDist(total + sn.off) + ".";
  var path = []; groups.forEach(function (g, i) { path = path.concat(i ? g.c.slice(1) : g.c); });
  return { ok: true, level: level, junction: jlabel, jkey: jm.k, jc: jm.c, text: text, path: path, snap: sn.pt,
           total: total + sn.off,
           short: fmtDist(total + sn.off) + " by road from " + jlabel + " (" + ROUTE_LEVELS[level].label + ")" };
}

// find the route for one level; reuses segments already fetched for this pin
function computeRoute(P, level) {
  var L = ROUTE_LEVELS[level], key = P[0].toFixed(6) + "," + P[1].toFixed(6);
  if (!routeCache || routeCache.key !== key) routeCache = { key: key, feats: [], ids: {}, r: { local: 0, major: 0, hwy: 0 } };
  var cache = routeCache;
  function attempt() {
    var hit = solve(); if (hit) return Promise.resolve(hit);
    // next fetch: the innermost tier this level may still widen
    var tier = null, r = null;
    ["local", "major", "hwy"].some(function (t) {
      var max = L.reach[t]; if (!max) return false;
      var nr = TIERS[t].radii.filter(function (x) { return x > cache.r[t] && x <= max; })[0];
      if (nr) { tier = t; r = nr; return true; }
      return false;
    });
    if (!tier) return Promise.resolve(null);
    var dLat = r / 111320, dLon = r / (111320 * Math.cos(P[1] * Math.PI / 180));
    return fetchSegments(TIERS[tier].layer, P[0] - dLon, P[1] - dLat, P[0] + dLon, P[1] + dLat, 0).then(function (fs) {
      fs.forEach(function (f) {
        var id = f.attributes && f.attributes.OBJECTID;
        if (id == null || !cache.ids[id]) { if (id != null) cache.ids[id] = 1; cache.feats.push(f); }
      });
      cache.r[tier] = r;
      return attempt();
    });
  }
  function solve() {
    if (!cache.feats.length) return null;
    var G = buildGraph(cache.feats), sn = snapTo(G, P);
    if (!sn) return null;
    var res = nearestJunction(G, sn, L);
    return res ? describeRoute(G, res, sn, level) : null;
  }
  return attempt();
}

function drawRoute(r, fit) {
  routeLayer.clearLayers();
  var ll = r.path.map(function (c) { return L.latLng(c[1], c[0]); });
  routeLayer.addLayer(L.polyline(ll, { color: "#fff", weight: 8, opacity: 0.9, interactive: false }));
  routeLayer.addLayer(L.polyline(ll, { color: "#d84315", weight: 4.5, opacity: 0.95, interactive: false }));
  if (pin && r.snap) routeLayer.addLayer(L.polyline([L.latLng(r.snap[1], r.snap[0]), pin.getLatLng()],
    { color: "#d84315", weight: 3, dashArray: "4 6", interactive: false }));
  routeLayer.addLayer(L.marker(L.latLng(r.jc[1], r.jc[0]), { interactive: false,
    icon: L.divIcon({ className: "", iconSize: [20, 20], iconAnchor: [10, 10],
      html: "<div class='wsym' style='width:20px;height:20px;background:#d84315;border-radius:3px'><span>J</span></div>" }) }));
  if (fit) {
    var b = L.latLngBounds(ll); if (pin) b.extend(pin.getLatLng());
    var bottomPad = panel.style.display === "block" ? Math.min(panel.offsetHeight + 30, map.getSize().y * 0.6) : 30;
    var topPad = document.querySelector(".bar").getBoundingClientRect().bottom + 10;
    map.fitBounds(b, { paddingTopLeft: [30, topPad], paddingBottomRight: [30, bottomPad], maxZoom: 17 });
  }
}

function clearRoute() {
  routeSeq++; routeInfo = null; routeLayer.clearLayers();
  if (routeBtn) routeBtn.textContent = "Route";
  restyleParcelHi();
}
function routeRows() {
  if (!routeInfo) return [];
  return [{ k: "Route", v: routeInfo.ok ? routeInfo.text : routeInfo.msg }];
}
function applyRoute(info, fit) {
  routeInfo = info; routeBtn.textContent = "Clear route"; restyleParcelHi();
  setFolded(true);                       // keep the map visible; "Show" brings the directions back
  showCoords(pin.getLatLng());           // panel at its final height before fitting
  drawRoute(info, fit); writeHash();
}

function findRoute(opts) {
  if (!pin) return;
  opts = opts || {};
  var fit = opts.fit !== false, level = opts.level !== undefined ? opts.level : 1;
  var seq = ++routeSeq, P = [pin.getLatLng().lng, pin.getLatLng().lat];
  routeInfo = { ok: false, msg: "finding the nearest " + ROUTE_LEVELS[level].label + " junction..." };
  showCoords(pin.getLatLng());
  computeRoute(P, level).then(function (info) {
    if (seq !== routeSeq) return;
    if (!info) { routeInfo = { ok: false, msg: "(no " + ROUTE_LEVELS[level].label + " junction within reach)" };
      showCoords(pin.getLatLng()); return; }
    applyRoute(info, fit);
  }).catch(function (e) {
    if (seq !== routeSeq) return;
    routeInfo = { ok: false, msg: "(route lookup failed: " + e.message + ")" }; showCoords(pin.getLatLng());
  });
}

// step out to the next bigger road whose junction differs from the current one
function seekBigger() {
  if (!pin || !routeInfo || !routeInfo.ok) return;
  var cur = routeInfo, seq = ++routeSeq, P = [pin.getLatLng().lng, pin.getLatLng().lat];
  toast("Looking for a bigger road...");
  function next(level) {
    if (level >= ROUTE_LEVELS.length) { routeSeq = seq; toast("No bigger road junction within reach"); return; }
    computeRoute(P, level).then(function (info) {
      if (seq !== routeSeq) return;
      if (info && info.jkey !== cur.jkey) { applyRoute(info, true); toast("From the nearest " + ROUTE_LEVELS[level].label); return; }
      next(level + 1);
    }).catch(function (e) { if (seq === routeSeq) toast("Route lookup failed: " + e.message); });
  }
  next(cur.level + 1);
}

routeBtn.onclick = function () {
  if (routeInfo && routeInfo.ok) { clearRoute(); setFolded(false); showCoords(pin.getLatLng()); writeHash(); }
  else findRoute();
};
biggerBtn.onclick = seekBigger;

// Google Maps directions: from the route's junction to the pin when a route is
// shown, otherwise from wherever the phone is (Google's default) to the pin.
// Uses the documented Maps URLs format, which opens the app on phones.
// BOM weather: the Bureau's location pages are keyed by OpenStreetMap node id,
// bom.gov.au/location/australia/tasmania/<district>/o<node id>-<name>, and the
// district part is not checked. data/osm-places-tas.json (harvested monthly by
// a GitHub Action, ODbL) gives the nearest town / suburb / village / hamlet to
// the pin. No BOM data is fetched. If the list cannot be loaded, fall back to
// the Bureau's site search for the pin's locality.
var BOM_TYPES = { city: 1, town: 1, village: 1, suburb: 1, hamlet: 1 };
var osmPlaces = null;
function loadPlaces() {
  if (!osmPlaces) osmPlaces = fetch("data/osm-places-tas.json").then(function (r) { return r.json(); })
    .then(function (d) { return d.places.filter(function (p) { return BOM_TYPES[p[4]]; }); })
    .catch(function (e) { osmPlaces = null; throw e; });
  return osmPlaces;
}
function nearestPlace(places, p) {
  var best = null, bd = Infinity, here = [p.lng, p.lat];
  places.forEach(function (q) { var d = hav(here, [q[3], q[2]]); if (d < bd) { bd = d; best = q; } });
  return best ? { id: best[0], name: best[1], dist: bd } : null;
}
function bomSlug(name) { return String(name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""); }
function pinLocality(p) {
  var a2 = parcelInfo && parcelInfo.PROP_ADD2, m = a2 && /^(.*?)\s+TAS\b/.exec(String(a2));
  if (m && m[1]) return Promise.resolve(m[1]);
  var url = LISTPUB + "SearchService/MapServer/7/query?geometry=" + p.lng.toFixed(6) + "," + p.lat.toFixed(6) +
    "&geometryType=esriGeometryPoint&inSR=4326&distance=5000&units=esriSRUnit_Meter&spatialRel=esriSpatialRelIntersects" +
    "&outFields=LOCALITY&returnGeometry=false&f=json";
  return fetch(url).then(function (r) { return r.json(); }).then(function (j) {
    var n = {}; (j.features || []).forEach(function (f) { var l = f.attributes.LOCALITY; if (l) n[l] = (n[l] || 0) + 1; });
    return Object.keys(n).sort(function (x, y) { return n[y] - n[x]; })[0] || null;
  }).catch(function () { return null; });
}
function titleWords(s) { return String(s).toLowerCase().replace(/\b[a-z]/g, function (c) { return c.toUpperCase(); }); }
document.getElementById("bom").onclick = function () {
  if (!pin) return;
  var p = pin.getLatLng(), w = window.open("about:blank", "_blank");   // open now so pop-up blockers allow it
  function go(url, msg) {
    if (w) { try { w.opener = null; } catch (e) {} w.location.href = url; } else location.href = url;
    toast(msg);
  }
  loadPlaces().then(function (places) {
    var n = nearestPlace(places, p);
    if (!n) throw new Error("no places");
    go("https://www.bom.gov.au/location/australia/tasmania/local/o" + n.id + "-" + bomSlug(n.name),
       "BOM forecast for " + n.name + " (" + fmtDist(n.dist) + " away)");
  }).catch(function () {
    pinLocality(p).then(function (loc) {
      var q = loc ? titleWords(loc) : "Tasmania";
      go("https://www.bom.gov.au/search?query=" + encodeURIComponent(q), "BOM search for " + q);
    });
  });
};

document.getElementById("gmaps").onclick = function () {
  if (!pin) return;
  var p = pin.getLatLng(), url = "https://www.google.com/maps/dir/?api=1&travelmode=driving" +
    "&destination=" + p.lat.toFixed(6) + "," + p.lng.toFixed(6);
  if (routeInfo && routeInfo.ok) url += "&origin=" + routeInfo.jc[1].toFixed(6) + "," + routeInfo.jc[0].toFixed(6);
  window.open(url, "_blank", "noopener");
};
