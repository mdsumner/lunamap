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
function fmtDist(m) { return m < 995 ? Math.round(m / 10) * 10 + " m" : (m / 1000).toFixed(m < 10000 ? 1 : 0) + " km"; }

// fetch segments in a box; split into quarters when the server truncates
function fetchSegmentsOnline(layer, w, s, e, n, depth) {
  var url = TOPO + layer + "/query?geometry=" + [w, s, e, n].map(function (v) { return v.toFixed(6); }).join(",") +
    "&geometryType=esriGeometryEnvelope&inSR=4326&outSR=4326&spatialRel=esriSpatialRelIntersects" +
    "&outFields=OBJECTID,PRI_NAME,TRAN_CLASS,SURFACE_TY,STATUS,TSEG_FEAT&returnGeometry=true&geometryPrecision=7&f=json";
  return fetch(url).then(function (r) { return r.json(); }).then(function (j) {
    if (j.error) throw new Error(j.error.message || "road query failed");
    var feats = j.features || [];
    if (j.exceededTransferLimit) {
      if (depth >= 6) throw new Error("too much road data - try a smaller road size");
      var mx = (w + e) / 2, my = (s + n) / 2;
      return Promise.all([fetchSegmentsOnline(layer, w, s, mx, my, depth + 1), fetchSegmentsOnline(layer, mx, s, e, my, depth + 1),
                          fetchSegmentsOnline(layer, w, my, mx, n, depth + 1), fetchSegmentsOnline(layer, mx, my, e, n, depth + 1)])
        .then(function (parts) { return [].concat.apply([], parts); });
    }
    return feats;
  });
}

// road segments for a box: from theLIST, or from a saved road pack (roadpack.js)
// when there is no signal or the request fails
function fetchSegments(layer, w, s, e, n, depth) {
  function fromPack(err) {
    if (typeof offlineSegments !== "function") return Promise.reject(err);
    return offlineSegments(layer, w, s, e, n).then(function (fs) {
      if (!fs) throw err || new Error("no signal and no saved roads here");
      return fs;
    });
  }
  if (navigator.onLine === false) return fromPack(new Error("no signal and no saved roads here"));
  return fetchSegmentsOnline(layer, w, s, e, n, depth).catch(fromPack);
}

// Routes are chosen by rough travel time, not distance, so a main road beats a
// shorter dirt track: nominal speeds (km/h) by LIST transport class, slowed for
// unsealed and 4WD surfaces. Distances in the directions are still real metres.
var CLASS_KMH = { "National/State Highway": 90, "Arterial Road": 70, "Sub Arterial Road": 60, "Collector Road": 50,
  "Local Road": 40, "Access Road": 25, "Vehicular Track": 12, "Arcade": 5, "Mall": 5 };
function roadSpeed(ed) {
  var v = CLASS_KMH[ed.cls] || 20;
  if (ed.surf === "4WD required") v = Math.min(v, 8);
  else if (ed.surf === "Unsealed") v *= 0.6;
  return v / 3.6;                                    // metres per second
}

// Gates and barriers (TopographyAndRelief layer 59) on the network: crossing one
// costs extra time, so routes avoid gated tracks unless there is no other way.
var GATE_PENALTY_S = { "IMMOVABLE BARRIER": 7200, "BOLLARD": 7200, "FENCE BARRIER": 7200, "GATE": 900, "BOOM GATE": 900,
  "REMOVABLE BARRIER": 900, "UNKNOWN BARRIER": 600, "STOCK GRID": 0 };
function fetchGates(w, s, e, n) {
  var url = TOPO + "59/query?geometry=" + [w, s, e, n].map(function (v) { return v.toFixed(6); }).join(",") +
    "&geometryType=esriGeometryEnvelope&inSR=4326&outSR=4326&spatialRel=esriSpatialRelIntersects" +
    "&outFields=OBJECTID,BARRIER_TY&returnGeometry=true&geometryPrecision=7&f=json";
  var online = navigator.onLine === false ? Promise.reject(new Error("offline")) :
    fetch(url).then(function (r) { return r.json(); }).then(function (j) {
      if (j.error) throw new Error(j.error.message);
      return (j.features || []).filter(function (f) { return f.geometry; }).map(function (f) {
        return [f.geometry.x, f.geometry.y, String(f.attributes.BARRIER_TY || "Unknown Barrier").toUpperCase(), f.attributes.OBJECTID]; });
    });
  return online.catch(function () { return typeof offlineGates === "function" ? offlineGates(w, s, e, n) : []; });
}
// widen the road cache for a pin: segments for a tier, plus gates with the local tier
function growRoads(cache, P, tier, r) {
  var dLat = r / 111320, dLon = r / (111320 * Math.cos(P[1] * Math.PI / 180));
  var w = P[0] - dLon, s = P[1] - dLat, e = P[0] + dLon, n = P[1] + dLat;
  return Promise.all([fetchSegments(TIERS[tier].layer, w, s, e, n, 0),
                      tier === "local" ? fetchGates(w, s, e, n).catch(function () { return []; }) : Promise.resolve([])])
  .then(function (r2) {
    r2[0].forEach(function (f) {
      var id = f.attributes && f.attributes.OBJECTID;
      if (id == null || !cache.ids[id]) { if (id != null) cache.ids[id] = 1; cache.feats.push(f); }
    });
    cache.gates = cache.gates || []; cache.gateIds = cache.gateIds || {};
    r2[1].forEach(function (g) { var k = g[3] != null ? g[3] : g[0] + "," + g[1]; if (!cache.gateIds[k]) { cache.gateIds[k] = 1; cache.gates.push(g); } });
    cache.r[tier] = r;
    return cache;
  });
}

function markGates(G, gates) {
  if (!gates || !gates.length) return;
  var cell = 1e-4, grid = {};
  function key(x, y) { return Math.floor(x / cell) + "," + Math.floor(y / cell); }
  G.edges.forEach(function (ed, ei) { ed.c.forEach(function (p, vi) {
    var k = key(p[0], p[1]); (grid[k] = grid[k] || []).push([ei, vi]); }); });
  gates.forEach(function (g) {
    var pen = GATE_PENALTY_S[g[2]]; if (pen === undefined) pen = 600;
    var gx = Math.floor(g[0] / cell), gy = Math.floor(g[1] / cell), best = null, bd = 6;   // within 6 m
    for (var dx = -1; dx <= 1; dx++) for (var dy = -1; dy <= 1; dy++) (grid[(gx + dx) + "," + (gy + dy)] || []).forEach(function (h) {
      var ed = G.edges[h[0]], d = hav([g[0], g[1]], ed.c[h[1]]); if (d < bd) { bd = d; best = h; } });
    if (!best) return;
    var ed = G.edges[best[0]], vi = best[1], info = { type: g[2], pen: pen };
    if (typeof gateNoteAdjust === "function") info = gateNoteAdjust(info, g);   // brigade gate notes (gatenotes.js)
    if (vi === 0 || vi === ed.c.length - 1) { var nd = vi === 0 ? ed.u : ed.v; G.meta[nd].gate = info; }
    else ed.gate = info;
  });
}

function buildGraph(feats, gates) {
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
      ed.cost = ed.len / roadSpeed(ed);
      edges.push(ed);
      adj[u].push({ to: v, e: ed, fwd: true }); adj[v].push({ to: u, e: ed, fwd: false });
      meta[u].inc.push(ed); if (v !== u) meta[v].inc.push(ed);
    });
  });
  var G = { adj: adj, meta: meta, edges: edges };
  markGates(G, gates);
  return G;
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
  // Dijkstra on travel time (edge.cost); metres travelled kept alongside in len[]
  var n = G.adj.length, dist = new Float64Array(n).fill(Infinity), len = new Float64Array(n), prev = new Array(n), done = new Uint8Array(n);
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
  var e = sn.ed, rate = e.len > 0 ? e.cost / e.len : 0;
  [[e.u, sn.toU], [e.v, sn.toV]].forEach(function (x) {
    var c = x[1].len * rate;
    if (c < dist[x[0]]) { dist[x[0]] = c; len[x[0]] = x[1].len; prev[x[0]] = { start: true, c: x[1].c, e: e }; push(c, x[0]); }
  });
  while (heap.length) {
    var u = pop()[1];
    if (done[u]) continue; done[u] = 1;
    if (typeof L === "function" ? L(u) : isJunction(G.meta[u], L)) return { node: u, dist: len[u], time: dist[u], prev: prev };
    G.adj[u].forEach(function (a) {
      var nd = dist[u] + a.e.cost + (a.e.gate ? a.e.gate.pen : 0) + (G.meta[a.to].gate ? G.meta[a.to].gate.pen : 0);
      if (nd < dist[a.to]) { dist[a.to] = nd; len[a.to] = len[u] + a.e.len; prev[a.to] = { from: u, e: a.e, fwd: a.fwd }; push(nd, a.to); }
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
  var gates = {}, nGates = 0;
  legsFromJunction(res).forEach(function (l, i, arr) {
    if (l.e.gate && l.e.gate.pen > 0) { nGates++; gates[l.e.gate.label || l.e.gate.type] = 1; }
  });
  (function () {                                                   // gated nodes along the path
    var k = res.node;
    while (res.prev[k] && !res.prev[k].start) { if (G.meta[k].gate && G.meta[k].gate.pen > 0) { nGates++; gates[G.meta[k].gate.label || G.meta[k].gate.type] = 1; } k = res.prev[k].from; }
    if (G.meta[k] && G.meta[k].gate && G.meta[k].gate.pen > 0) { nGates++; gates[G.meta[k].gate.label || G.meta[k].gate.type] = 1; }
  })();
  if (nGates) text += "; passes " + nGates + " " + (nGates === 1 ? "gate or barrier" : "gates or barriers") +
    " (" + Object.keys(gates).map(function (t) { return t.indexOf(" - ") > 0 ? t : t.toLowerCase(); }).join(", ") + ")";
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
    var hit = solve();
    if (hit) {
      // no second way yet: load the local roads a step wider (up to 7 km) and look again
      var wider = TIERS.local.radii.filter(function (x) { return x > cache.r.local && x <= Math.min(7000, L.reach.local || 0); })[0];
      if (hit.second && !hit.second.ok && wider) return growRoads(cache, P, "local", wider).then(attempt);
      return Promise.resolve(hit);
    }
    // next fetch: the innermost tier this level may still widen
    var tier = null, r = null;
    ["local", "major", "hwy"].some(function (t) {
      var max = L.reach[t]; if (!max) return false;
      var nr = TIERS[t].radii.filter(function (x) { return x > cache.r[t] && x <= max; })[0];
      if (nr) { tier = t; r = nr; return true; }
      return false;
    });
    if (!tier) return Promise.resolve(null);
    return growRoads(cache, P, tier, r).then(attempt);
  }
  function solve() {
    if (!cache.feats.length) return null;
    var G = buildGraph(cache.feats, cache.gates), sn = snapTo(G, P);
    if (!sn) return null;
    var res = nearestJunction(G, sn, L);
    if (!res) return null;
    var info = describeRoute(G, res, sn, level);
    info.second = secondWay(G, res, sn, L, level);
    info.short += info.second.ok ? "; second way " + fmtDist(info.second.total) + " (" + info.second.junction + ")" : "; no second way found";
    return info;
  }
  return attempt();
}

// A second way: the route again with every road piece of the first one costing ten times
// as much, so it leaves by a different road where there is one. What it still shares with
// the first route is reported, so a single road in shows up as "no second way".
var SECOND_FACTOR = 10;
function secondWay(G, res, sn, L, level) {
  var used = new Set(legsFromJunction(res).map(function (l) { return l.e; }));
  var saved = [];
  used.forEach(function (e) { saved.push([e, e.cost]); e.cost *= SECOND_FACTOR; });
  var r2 = null;
  try { r2 = nearestJunction(G, sn, L); } finally { saved.forEach(function (x) { x[0].cost = x[1]; }); }
  if (!r2) return { ok: false, text: "none found in the roads loaded around the pin" };
  var d2 = describeRoute(G, r2, sn, level), shared = 0, names = {};
  legsFromJunction(r2).forEach(function (l) { if (used.has(l.e)) { shared += lineLen(l.c); if (l.e.name) names[l.e.name] = 1; } });
  var nm = Object.keys(names).join(", ");
  d2.shared = shared;
  if (d2.total > 0 && shared / d2.total > 0.85)
    return { ok: false, text: "no separate second way: every way out found uses the same roads" + (nm ? " (" + nm + ")" : "") };
  d2.text = d2.text.replace(/\. Total ([^.]*)\.$/, ". Total $1") +
    (shared > 50 ? "; shares " + fmtDist(shared) + " with the first route" + (nm ? " (" + nm + ")" : "") : "; no roads shared with the first route") + ".";
  return d2;
}

function drawRoute(r, fit) {
  routeLayer.clearLayers();
  var ll = r.path.map(function (c) { return L.latLng(c[1], c[0]); });
  if (r.second && r.second.ok) {
    var l2 = r.second.path.map(function (c) { return L.latLng(c[1], c[0]); });
    routeLayer.addLayer(L.polyline(l2, { color: "#fff", weight: 7, opacity: 0.8, interactive: false }));
    routeLayer.addLayer(L.polyline(l2, { color: "#00838f", weight: 3.5, opacity: 0.95, dashArray: "8 5", interactive: false }));
    routeLayer.addLayer(L.marker(L.latLng(r.second.jc[1], r.second.jc[0]), { interactive: false,
      icon: L.divIcon({ className: "", iconSize: [20, 20], iconAnchor: [10, 10],
        html: "<div class='wsym' style='width:20px;height:20px;background:#00838f;border-radius:3px'><span>2</span></div>" }) }));
  }
  routeLayer.addLayer(L.polyline(ll, { color: "#fff", weight: 8, opacity: 0.9, interactive: false }));
  routeLayer.addLayer(L.polyline(ll, { color: "#d84315", weight: 4.5, opacity: 0.95, interactive: false }));
  if (pin && r.snap) routeLayer.addLayer(L.polyline([L.latLng(r.snap[1], r.snap[0]), pin.getLatLng()],
    { color: "#d84315", weight: 3, dashArray: "4 6", interactive: false }));
  routeLayer.addLayer(L.marker(L.latLng(r.jc[1], r.jc[0]), { interactive: false,
    icon: L.divIcon({ className: "", iconSize: [20, 20], iconAnchor: [10, 10],
      html: "<div class='wsym' style='width:20px;height:20px;background:#d84315;border-radius:3px'><span>J</span></div>" }) }));
  if (fit) {
    var b = L.latLngBounds(ll); if (pin) b.extend(pin.getLatLng());
    if (r.second && r.second.ok) r.second.path.forEach(function (c) { b.extend([c[1], c[0]]); });
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
  var rows = [{ k: "Route", v: routeInfo.ok ? routeInfo.text : routeInfo.msg }];
  if (routeInfo.ok && routeInfo.second) rows.push({ k: "Second way", v: routeInfo.second.text });
  return rows;
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
