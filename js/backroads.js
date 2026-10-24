// lunamap - backroads.js: road types on the map, and routes between two points that can
// prefer back roads.
//   Road types  every road and track in view from theLIST transport network (layer 8),
//               drawn by surface and class so back roads stand out: sealed minor roads dark,
//               unsealed brown, vehicular tracks dashed brown, 4WD dashed red, main roads
//               faint; gates and barriers as small black dots. Tap a road for its details.
//   From...     a route from a second point (my location, or a tap on the map) to the pin,
//               either the fastest way or by back roads (main roads cost five times as much),
//               with gates avoided or allowed ("we have keys"). The other choice is drawn
//               faintly for comparison. Uses the same road data, gates and nominal speeds as
//               Route (route.js), so it also works offline where roads were saved.
// theLIST says which roads join up, not whether they are open: forestry and private roads
// can be gated, locked or closed.
// ---------------------------------------------------------------------------
(function () {
  // ---- road types overlay -------------------------------------------------------------
  var MAJOR = { "National/State Highway": 1, "Arterial Road": 1, "Sub Arterial Road": 1 };
  var RT = { on: false, group: L.layerGroup(), lines: L.layerGroup(), dots: L.layerGroup(), seen: {}, n: 0, seq: 0,
             renderer: L.canvas({ padding: 0.3, tolerance: 8 }) };
  RT.lines.addTo(RT.group); RT.dots.addTo(RT.group);
  var tapHi = window.roadTapHi = L.layerGroup().addTo(map);   // the road last tapped
  var RT_MINZOOM = 9, RT_VECTOR = 12;     // drawn by the server from zoom 9, as tappable lines from zoom 12

  // zoomed out: theLIST draws the roads, styled the same way (dynamicLayers); if the server
  // refuses that, its own road symbols, so the network still shows at a useful scale
  function rgba(hex, a) { return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16), Math.round(255 * a)]; }
  var RT_GROUPS = [   // drawn top first
    ["SURFACE_TY = '4WD required'", { TRAN_CLASS: "Vehicular Track", SURFACE_TY: "4WD required" }],
    ["TRAN_CLASS = 'Vehicular Track' AND SURFACE_TY <> '4WD required'", { TRAN_CLASS: "Vehicular Track", SURFACE_TY: "Unsealed" }],
    ["TRAN_CLASS IN ('Collector Road','Local Road','Access Road') AND SURFACE_TY = 'Unsealed'", { TRAN_CLASS: "Local Road", SURFACE_TY: "Unsealed" }],
    ["TRAN_CLASS IN ('Collector Road','Local Road','Access Road') AND SURFACE_TY = 'Sealed'", { TRAN_CLASS: "Local Road", SURFACE_TY: "Sealed" }],
    ["TRAN_CLASS IN ('National/State Highway','Arterial Road','Sub Arterial Road')", { TRAN_CLASS: "Arterial Road", SURFACE_TY: "Sealed" }]];
  var rtDynamic = JSON.stringify(RT_GROUPS.map(function (g, i) {
    var st = roadStyle(g[1]);
    return { id: 100 + i, source: { type: "mapLayer", mapLayerId: 8 }, definitionExpression: g[0],
      drawingInfo: { renderer: { type: "simple", symbol: { type: "esriSLS", style: st.dashArray ? "esriSLSDash" : "esriSLSSolid",
        color: rgba(st.color, st.opacity), width: Math.max(1, st.weight * 0.6) } } } };
  }));
  var RoadTiles = L.TileLayer.extend({
    dynamic: true,
    getTileUrl: function (c) {
      var ts = this.getTileSize(), nw = c.scaleBy(ts), se = nw.add(ts);
      var a = L.CRS.EPSG3857.project(this._map.unproject(nw, c.z)), b = L.CRS.EPSG3857.project(this._map.unproject(se, c.z));
      return TOPO + "export?bbox=" + [a.x, b.y, b.x, a.y].map(function (v) { return v.toFixed(2); }).join(",") +
        "&bboxSR=3857&imageSR=3857&size=" + ts.x + "," + ts.y + "&format=png32&transparent=true&dpi=96&f=image" +
        (this.dynamic ? "&dynamicLayers=" + encodeURIComponent(rtDynamic) : "&layers=show:8");
    }
  });
  var rtTiles = new RoadTiles("", { tileSize: 512, minZoom: RT_MINZOOM, maxZoom: RT_VECTOR - 1, zIndex: 3,
    attribution: "Roads &copy; State of Tasmania" });
  rtTiles.on("tileerror", function () { if (rtTiles.dynamic) { rtTiles.dynamic = false; rtTiles.redraw(); } });
  rtTiles.addTo(RT.group);

  function roadStyle(a) {
    var cls = a.TRAN_CLASS || "", surf = a.SURFACE_TY || "", st = String(a.STATUS || "");
    var s = { renderer: RT.renderer, weight: 2.5, opacity: 0.95, color: "#37474f", lineCap: "butt" };
    if (/closed|proposed/i.test(st)) { s.color = "#9e9e9e"; s.dashArray = "2 5"; s.weight = 2; return s; }
    if (MAJOR[cls]) { s.color = "#90a4ae"; s.weight = 3.5; s.opacity = 0.55; return s; }
    if (surf === "4WD required") { s.color = "#c62828"; s.dashArray = "5 4"; return s; }
    if (cls === "Vehicular Track") { s.color = "#8d5524"; s.dashArray = "7 4"; s.weight = 2; return s; }
    if (surf === "Unsealed") { s.color = "#a0632a"; s.weight = cls === "Collector Road" ? 3.2 : 2.5; return s; }
    if (cls === "Collector Road") s.weight = 3.2;
    return s;
  }
  function roadDetail(a) {
    return joinBits([a.PRI_NAME || null, a.TRAN_CLASS, a.SURFACE_TY,
      a.STATUS && !/^(open|unknown|not applicable)$/i.test(a.STATUS) ? String(a.STATUS).toLowerCase() : null]);
  }
  function refreshRoads() {
    if (!RT.on) return;
    var z = map.getZoom(), seq = ++RT.seq;
    legend(z < RT_MINZOOM);
    if (z < RT_VECTOR) { RT.lines.clearLayers(); RT.dots.clearLayers(); RT.seen = {}; RT.n = 0; return; }
    if (RT.n > 40000) { RT.lines.clearLayers(); RT.dots.clearLayers(); RT.seen = {}; RT.n = 0; }
    var b = map.getBounds().pad(0.1), w = b.getWest(), s = b.getSouth(), e = b.getEast(), n = b.getNorth();
    fetchSegments(8, w, s, e, n, 0).then(function (feats) {
      if (!RT.on || seq !== RT.seq) return;
      feats.forEach(function (f) {
        var a = f.attributes || {}, g = f.geometry;
        if (!g || !g.paths || RT.seen[a.OBJECTID]) return;
        RT.seen[a.OBJECTID] = 1; RT.n++;
        var lls = g.paths.map(function (p) { return p.map(function (c) { return [c[1], c[0]]; }); });
        var line = L.polyline(lls, roadStyle(a));
        line._rtName = a.PRI_NAME || null;
        line.on("click", function (ev) {
          if (window.mapPick(ev)) return;
          // highlight the tapped piece, and the rest of that road in view when it has a name
          tapHi.clearLayers();
          var lls = [];
          if (line._rtName) RT.lines.eachLayer(function (o) { if (o._rtName === line._rtName) lls.push(o.getLatLngs()); });
          else lls.push(line.getLatLngs());
          tapHi.addLayer(L.polyline(lls, { color: "#ffeb3b", weight: 11, opacity: 0.75, interactive: false }));
          pickFeature(ev.latlng, { what: a.PRI_NAME ? "Road" : "Unnamed road or track", detail: roadDetail(a) }, { line: true });
        });
        RT.lines.addLayer(line);
      });
    }).catch(function (err) { if (seq === RT.seq) toast("Roads unavailable: " + err.message); });
    fetchGates(w, s, e, n).then(function (gs) {
      if (!RT.on || seq !== RT.seq) return;
      gs.forEach(function (g) {
        var k = "g" + (g[3] != null ? g[3] : g[0] + "," + g[1]); if (RT.seen[k]) return; RT.seen[k] = 1;
        if (g[2] === "STOCK GRID") return;
        RT.dots.addLayer(L.circleMarker([g[1], g[0]], { renderer: RT.renderer, radius: 3.5, weight: 1.5, color: "#fff",
          fillColor: "#000", fillOpacity: 1 }).on("click", function (ev) {
            if (window.mapPick(ev)) return; pickFeature(L.latLng(g[1], g[0]), { what: titleCase(g[2]), detail: "on the road network (theLIST)", gate: { id: g[3], type: g[2], x: g[0], y: g[1] } }, { line: true }); }));
      });
    });
  }
  var legendCtl = L.control({ position: "topright" });
  legendCtl.onAdd = function () {
    var d = L.DomUtil.create("div", "rtlegend");
    function sw(st) { return "<svg width='26' height='8'><line x1='1' y1='4' x2='25' y2='4' stroke='" + st.color + "' stroke-width='" +
      Math.min(4, st.weight) + "'" + (st.dashArray ? " stroke-dasharray='" + st.dashArray + "'" : "") + " opacity='" + st.opacity + "'/></svg>"; }
    d.innerHTML = "<div id='rtzoom' style='display:none'>Zoom in to see road types</div><div id='rtkey'>" +
      [["Sealed", { TRAN_CLASS: "Local Road", SURFACE_TY: "Sealed" }], ["Unsealed", { TRAN_CLASS: "Local Road", SURFACE_TY: "Unsealed" }],
       ["Track", { TRAN_CLASS: "Vehicular Track", SURFACE_TY: "Unsealed" }], ["4WD", { TRAN_CLASS: "Vehicular Track", SURFACE_TY: "4WD required" }],
       ["Main road", { TRAN_CLASS: "Arterial Road", SURFACE_TY: "Sealed" }]].map(function (x) { return "<span>" + sw(roadStyle(x[1])) + x[0] + "</span>"; }).join("") +
      "<span><svg width='10' height='10'><circle cx='5' cy='5' r='3.5' fill='#000' stroke='#fff'/></svg> Gate</span></div>";
    L.DomEvent.disableClickPropagation(d);
    return d;
  };
  function legend(zoomIn) {
    var z = document.getElementById("rtzoom"), k = document.getElementById("rtkey");
    if (z) { z.style.display = zoomIn ? "block" : "none"; k.style.display = zoomIn ? "none" : "block"; }
  }
  function setRoads(on) {
    RT.on = on; RT.btn.classList.toggle("on", on);
    if (on) { RT.group.addTo(map); legendCtl.addTo(map); refreshRoads(); }
    else { map.removeLayer(RT.group); legendCtl.remove(); RT.lines.clearLayers(); RT.dots.clearLayers(); RT.seen = {}; RT.n = 0; RT.seq++; }
    writeHash();
  }
  RT.btn = document.getElementById("roads");
  RT.btn.onclick = function () { setRoads(!RT.on); };
  map.on("moveend", refreshRoads);
  window.roadsFlag = function () { return RT.on ? ",rd" : ""; };
  window.setRoads = setRoads;

  // ---- From... : route between two points ---------------------------------------------
  var BACK_FACTOR = 5;                      // back roads: main roads cost this many times their travel time
  var KEY_PEN_S = { "GATE": 60, "BOOM GATE": 60, "REMOVABLE BARRIER": 120, "UNKNOWN BARRIER": 60 };
  var MAX_SPAN_M = 120000;
  var AB = { from: null, marker: null, way: "back", keys: false, circuit: false, layer: L.layerGroup().addTo(map), picking: false,
             seq: 0, cache: null, sheet: null };

  window.abInvalidate = function () { AB.cache = null; if (AB.sheet && AB.sheet.style.display === "block" && AB.from) run(); };
  function gatePen(info) {
    if (!info) return 0;
    if (AB.keys && KEY_PEN_S[info.type] !== undefined) return KEY_PEN_S[info.type];
    return info.pen;
  }
  // Dijkstra from the snap point sB to either end of sA's edge, so legs run A -> B
  function solve(G, sA, sB, way, avoid) {
    var n = G.adj.length, dist = new Float64Array(n).fill(Infinity), prev = new Array(n), done = new Uint8Array(n), heap = [];
    function cost(e) { return e.cost * (way === "back" && MAJOR[e.cls] ? BACK_FACTOR : 1) * (avoid && avoid.has(e) ? 10 : 1); }
    function push(d, i) { heap.push([d, i]); var k = heap.length - 1;
      while (k > 0) { var p = (k - 1) >> 1; if (heap[p][0] <= heap[k][0]) break; var t = heap[p]; heap[p] = heap[k]; heap[k] = t; k = p; } }
    function pop() { var top = heap[0], last = heap.pop();
      if (heap.length) { heap[0] = last; var k = 0;
        for (;;) { var l = 2 * k + 1, r = l + 1, m = k;
          if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
          if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
          if (m === k) break; var t = heap[m]; heap[m] = heap[k]; heap[k] = t; k = m; } }
      return top; }
    var eB = sB.ed, rB = eB.len > 0 ? cost(eB) / eB.len : 0;
    [[eB.u, sB.toU], [eB.v, sB.toV]].forEach(function (x) {
      var c = x[1].len * rB + (eB.gate ? gatePen(eB.gate) / 2 : 0);
      if (c < dist[x[0]]) { dist[x[0]] = c; prev[x[0]] = { start: true, c: x[1].c, e: eB }; push(c, x[0]); }
    });
    var eA = sA.ed, rA = eA.len > 0 ? cost(eA) / eA.len : 0, best = null;
    var tailCost = {}; tailCost[eA.v] = sA.toV.len * rA; tailCost[eA.u] = sA.toU.len * rA;
    while (heap.length) {
      var top = pop(), u = top[1];
      if (done[u]) continue; done[u] = 1;
      if (best && top[0] >= best.c) break;
      if (tailCost[u] !== undefined) {
        var tot = dist[u] + tailCost[u] + (eA.gate ? gatePen(eA.gate) / 2 : 0);
        if (!best || tot < best.c) best = { c: tot, node: u };
      }
      G.adj[u].forEach(function (a) {
        var nd = dist[u] + cost(a.e) + gatePen(a.e.gate) + gatePen(G.meta[a.to].gate);
        if (nd < dist[a.to]) { dist[a.to] = nd; prev[a.to] = { from: u, e: a.e, fwd: a.fwd }; push(nd, a.to); }
      });
    }
    if (!best) return null;
    // legs in travel order: A's snap point -> node -> ... -> B's snap point
    var legs = [{ c: best.node === eA.u ? sA.toU.c.slice() : sA.toV.c.slice(), e: eA }];   // snap point -> node
    var k = best.node, nodes = [k];
    for (;;) {
      var p = prev[k];
      if (p.start) { legs.push({ c: p.c.slice().reverse(), e: p.e }); break; }
      legs.push({ c: p.fwd ? p.e.c.slice().reverse() : p.e.c.slice(), e: p.e });
      k = p.from; nodes.push(k);
    }
    return { legs: legs.filter(function (l) { return l.c.length > 1; }), nodes: nodes };
  }
  // both points on the same piece of road: the stretch between them
  function sameEdge(sA, sB) {
    var e = sA.ed, c = e.c, pa = { i: sA.i, pt: sA.pt }, pb = { i: sB.i, pt: sB.pt };
    function along(x) { var d = 0; for (var j = 1; j < x.i; j++) d += hav(c[j - 1], c[j]); return d + hav(c[x.i - 1], x.pt); }
    var da = along(pa), db = along(pb), lo = da <= db ? pa : pb, hi = da <= db ? pb : pa;
    var seg = [lo.pt].concat(c.slice(lo.i, hi.i)).concat([hi.pt]);
    if (da > db) seg.reverse();
    return { legs: [{ c: seg, e: e }], nodes: [] };
  }

  function describe(G, r) {
    var groups = [], unsealed = 0, track = 0, fwd = 0, time = 0, total = 0, gates = {}, nGates = 0;
    r.legs.forEach(function (l) {
      var e = l.e, len = lineLen(l.c), g = groups[groups.length - 1];
      total += len; time += len / roadSpeed(e);
      if (e.surf === "4WD required") fwd += len; else if (e.cls === "Vehicular Track") track += len; else if (e.surf === "Unsealed") unsealed += len;
      if (e.gate && e.gate.pen > 0) { nGates++; gates[e.gate.label || e.gate.type] = 1; }
      var same = g && (e.name ? g.name === e.name : !g.name);
      if (same) { g.c = g.c.concat(l.c.slice(1)); g.len += len; g.cls[e.cls] = 1; g.surf[e.surf] = 1;
        if (!e.name && g.label !== unnamedLabel(e.cls)) g.label = "unnamed tracks and roads"; }
      else { var cls = {}, surf = {}; cls[e.cls] = 1; surf[e.surf] = 1;
        groups.push({ name: e.name, label: e.name || unnamedLabel(e.cls), c: l.c.slice(), len: len, cls: cls, surf: surf }); }
    });
    r.nodes.forEach(function (k) { var gi = G.meta[k].gate; if (gi && gi.pen > 0) { nGates++; gates[gi.label || gi.type] = 1; } });
    // fold very short pieces into their neighbours so directions stay readable
    groups = groups.filter(function (g, i) { return g.len >= 120 || i === 0 || i === groups.length - 1; });
    var parts = groups.map(function (g, i) {
      var note = [];
      if (g.cls["Vehicular Track"] && g.name) note.push("track");
      if (g.surf["4WD required"]) note.push("4WD"); else if (g.surf["Unsealed"]) note.push("unsealed");
      var what = g.label + (note.length ? " (" + note.join(", ") + ")" : "") + " " + fmtDist(g.len);
      if (i === 0) return "take " + what;
      var pc = groups[i - 1].c, a = pc[Math.max(0, pc.length - 2)], b = pc[pc.length - 1], c2 = g.c[Math.min(1, g.c.length - 1)];
      var d = ((bearing(b, c2) - bearing(a, b) + 540) % 360) - 180;
      var turn = Math.abs(d) < 30 ? "continue onto" : Math.abs(d) > 150 ? "turn back onto" :
                 (d > 0 ? (d > 110 ? "sharp right onto" : "right onto") : (d < -110 ? "sharp left onto" : "left onto"));
      return turn + " " + what;
    });
    var path = []; r.legs.forEach(function (l, i) { path = path.concat(i ? l.c.slice(1) : l.c); });
    return { edges: new Set(r.legs.map(function (l) { return l.e; })), legs: r.legs, total: total, time: time, unsealed: unsealed, track: track, fwd: fwd, nGates: nGates, gateTypes: Object.keys(gates),
             parts: parts, path: path };
  }
  function fmtTime(s) { var m = Math.round(s / 60); return m < 60 ? m + " min" : Math.floor(m / 60) + " h " + (m % 60) + " min"; }
  function headline(d) {
    var bits = [fmtDist(d.total), "about " + fmtTime(d.time)];
    var dirt = [];
    if (d.unsealed > 50) dirt.push(fmtDist(d.unsealed) + " unsealed");
    if (d.track > 50) dirt.push(fmtDist(d.track) + " track");
    if (d.fwd > 50) dirt.push(fmtDist(d.fwd) + " 4WD");
    return bits.join(", ") + (dirt.length ? "; " + dirt.join(", ") : "; all sealed") +
      (d.nGates ? "; " + d.nGates + " " + (d.nGates === 1 ? "gate or barrier" : "gates or barriers") +
       " (" + d.gateTypes.map(function (t) { return t.indexOf(" - ") > 0 ? t : t.toLowerCase(); }).join(", ") + ")" : "");
  }

  function roadsFor(A, B) {
    var w = Math.min(A[0], B[0]), e = Math.max(A[0], B[0]), s = Math.min(A[1], B[1]), n = Math.max(A[1], B[1]);
    var span = hav([w, s], [e, n]), pad = Math.max(4000, span * 0.35);
    if (span > MAX_SPAN_M) return Promise.reject(new Error("the points are " + fmtDist(span) + " apart; From... works up to " + fmtDist(MAX_SPAN_M) + " (use Route or Google for longer trips)"));
    var dLat = pad / 111320, dLon = pad / (111320 * Math.cos((s + n) / 2 * Math.PI / 180));
    w -= dLon; e += dLon; s -= dLat; n += dLat;
    var c = AB.cache;
    if (c && c.w <= w && c.e >= e && c.s <= s && c.n >= n) return Promise.resolve(c.G);
    status("Fetching roads for " + fmtDist(hav([w, s], [e, n])) + " across...");
    return Promise.all([fetchSegments(8, w, s, e, n, 0), fetchGates(w, s, e, n).catch(function () { return []; })]).then(function (r) {
      var G = buildGraph(r[0], r[1]);
      AB.cache = { w: w, e: e, s: s, n: n, G: G };
      return G;
    });
  }

  function status(t) { var el = document.getElementById("abres"); if (el) el.textContent = t; }
  function clearLines() { AB.layer.clearLayers(); if (AB.marker) AB.layer.addLayer(AB.marker); }
  function run() {
    if (!AB.from || !pin) { status(!pin ? "Drop a pin first: the route goes to the pin." : "Choose where to start from."); clearLines(); return; }
    var seq = ++AB.seq, A = [AB.from.lng, AB.from.lat], B = [pin.getLatLng().lng, pin.getLatLng().lat];
    status("Finding routes...");
    roadsFor(A, B).then(function (G) {
      if (seq !== AB.seq) return;
      var sA = snapTo(G, A), sB = snapTo(G, B);
      if (!sA || !sB) throw new Error("no roads near the points");
      function one(way) { var r = sA.ed === sB.ed ? sameEdge(sA, sB) : solve(G, sA, sB, way); return r ? describe(G, r) : null; }
      var main = one(AB.way);
      if (!main) throw new Error("the roads here do not join up");
      // circuit: the way back from the pin, with the roads of the way there costing ten times as much
      var back = null, other = null;
      if (AB.circuit) {
        var rb = sA.ed === sB.ed ? null : solve(G, sB, sA, AB.way, main.edges);
        if (rb) { back = describe(G, rb); back.shared = 0; var nm = {};
          rb.legs.forEach(function (l) { if (main.edges.has(l.e)) { back.shared += lineLen(l.c); if (l.e.name) nm[l.e.name] = 1; } });
          back.sharedNames = Object.keys(nm); }
      } else other = one(AB.way === "back" ? "fast" : "back");
      clearLines();
      if (back) {
        var lb = back.path.map(function (c) { return [c[1], c[0]]; });
        AB.layer.addLayer(L.polyline(lb, { color: "#fff", weight: 7, opacity: 0.8, interactive: false }));
        AB.layer.addLayer(L.polyline(lb, { color: "#00838f", weight: 3.5, opacity: 0.95, dashArray: "8 5", interactive: false }));
      }
      var same = other && Math.abs(other.total - main.total) < 50 && Math.abs(other.time - main.time) < 30;
      if (other && !same) AB.layer.addLayer(L.polyline(other.path.map(function (c) { return [c[1], c[0]]; }),
        { color: "#5e35b1", weight: 3, opacity: 0.6, dashArray: "6 6", interactive: false }));
      var ll = main.path.map(function (c) { return [c[1], c[0]]; });
      AB.layer.addLayer(L.polyline(ll, { color: "#fff", weight: 8, opacity: 0.9, interactive: false }));
      AB.layer.addLayer(L.polyline(ll, { color: AB.way === "back" ? "#8d5524" : "#d84315", weight: 4.5, opacity: 0.95, interactive: false }));
      [[A, sA], [B, sB]].forEach(function (x) { if (x[1].off > 25) AB.layer.addLayer(L.polyline([[x[0][1], x[0][0]], [x[1].pt[1], x[1].pt[0]]],
        { color: "#555", weight: 2, dashArray: "3 5", interactive: false })); });
      var label = AB.way === "back" ? "Back roads" : "Fastest";
      var html = "<b>" + label + ":</b> " + headline(main) + ".<br>" + esc(main.parts.join(", then ")) + ".";
      if (sA.off > 25) html += "<br>The start is " + fmtDist(sA.off) + " off the road.";
      if (sB.off > 25) html += "<br>The pin is " + fmtDist(sB.off) + " off the road.";
      if (AB.circuit) {
        html = "<b>Circuit, " + label.toLowerCase() + ":</b> " + (back ? fmtDist(main.total + back.total) + " round, about " + fmtTime(main.time + back.time) + "." : "") +
          "<br><b>There:</b> " + headline(main) + ".<br>" + esc(main.parts.join(", then ")) + ".";
        if (!back) html += "<br><span style='color:#00838f'><b>Back:</b> no way back found.</span>";
        else if (back.total > 0 && back.shared / back.total > 0.85)
          html += "<br><span style='color:#00838f'><b>Back:</b> no separate way back - every way found uses the same roads" +
            (back.sharedNames.length ? " (" + esc(back.sharedNames.join(", ")) + ")" : "") + ".</span>";
        else html += "<br><span style='color:#00838f'><b>Back (dashed):</b> " + headline(back) + ".<br>" + esc(back.parts.join(", then ")) + "." +
          (back.shared > 50 ? " Shares " + fmtDist(back.shared) + " with the way there" + (back.sharedNames.length ? " (" + esc(back.sharedNames.join(", ")) + ")" : "") + "." : " No roads shared with the way there.") + "</span>";
      } else
      html += "<br><span style='color:#5e35b1'>" + (same ? (AB.way === "back" ? "The fastest way is the same route." : "The back-roads way is the same route.") :
        (AB.way === "back" ? "Fastest (dashed): " : "Back roads (dashed): ") + headline(other) + ".") + "</span>";
      html += "<div class='small' style='color:#666;margin-top:4px'>Times use nominal speeds for each road type, slower on unsealed and 4WD. " +
        "theLIST shows which roads join up, not whether they are open: forestry and private roads may be gated, locked or closed.</div>";
      document.getElementById("abres").innerHTML = html;
      var bb = L.latLngBounds(ll).extend(AB.from).extend(pin.getLatLng());
      if (back) back.path.forEach(function (c) { bb.extend([c[1], c[0]]); });
      map.fitBounds(bb, { paddingTopLeft: [30, document.querySelector(".bar").getBoundingClientRect().bottom + 10],
        paddingBottomRight: [30, Math.min(AB.sheet.offsetHeight + 30, map.getSize().y * 0.6)], maxZoom: 16 });
    }).catch(function (e) { if (seq === AB.seq) { clearLines(); status("No route: " + e.message + "."); } });
  }
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return "&#" + c.charCodeAt(0) + ";"; }); }

  function setFrom(ll, how) {
    AB.from = L.latLng(ll);
    if (AB.marker) AB.marker.setLatLng(AB.from);
    else AB.marker = L.marker(AB.from, { interactive: false, zIndexOffset: 500, icon: L.divIcon({ className: "", iconSize: [20, 20], iconAnchor: [10, 10],
      html: "<div class='wsym' style='width:20px;height:20px;background:#2e7d32;border-radius:3px'><span>A</span></div>" }) });
    document.getElementById("abfrom").textContent = how + " (" + AB.from.lat.toFixed(4) + ", " + AB.from.lng.toFixed(4) + ")";
    run();
  }
  function seg(id, val) { [].forEach.call(document.querySelectorAll("#" + id + " button"), function (b) { b.classList.toggle("on", b.getAttribute("data-v") === val); }); }
  function ensureSheet() {
    if (AB.sheet) return AB.sheet;
    var d = document.createElement("div"); d.id = "absheet"; d.className = "sheet";
    d.innerHTML = "<h2><span>Route to the pin from...</span><button id='abclose' aria-label='Close'>x</button></h2>" +
      "<div class='small'>From: <b id='abfrom'>not set</b></div>" +
      "<div class='seg'><button type='button' id='abme'>My location</button><button type='button' id='abtap'>Tap the map</button></div>" +
      "<div class='seg' id='abway'><button type='button' data-v='fast'>Fastest</button><button type='button' data-v='back'>Back roads</button></div>" +
      "<div class='seg' id='abkeys'><button type='button' data-v='avoid'>Avoid gates</button><button type='button' data-v='keys'>We have keys</button></div>" +
      "<div class='seg' id='abcirc'><button type='button' data-v='one'>One way</button><button type='button' data-v='circ'>Circuit (different way back)</button></div>" +
      "<div id='abres' class='small'></div>";
    document.body.appendChild(d); AB.sheet = d;
    L.DomEvent.disableClickPropagation(d);
    d.querySelector("#abclose").onclick = closeSheet;
    d.querySelector("#abme").onclick = function () {
      if (lastFix && watchId !== null) { setFrom(lastFix, "my location"); return; }
      status("Finding your location...");
      if (!navigator.geolocation) { status("No location in this browser."); return; }
      navigator.geolocation.getCurrentPosition(function (p) { setFrom([p.coords.latitude, p.coords.longitude], "my location"); },
        function (e) { status("Location unavailable: " + e.message); }, { enableHighAccuracy: true, timeout: 20000, maximumAge: 30000 });
    };
    d.querySelector("#abtap").onclick = function () {
      AB.picking = true; this.classList.add("on"); status("Tap the map where the route starts.");
    };
    d.querySelector("#abway").onclick = function (e) { var v = e.target.getAttribute("data-v"); if (!v) return; AB.way = v; seg("abway", v); run(); };
    d.querySelector("#abkeys").onclick = function (e) { var v = e.target.getAttribute("data-v"); if (!v) return; AB.keys = v === "keys"; seg("abkeys", v); run(); };
    d.querySelector("#abcirc").onclick = function (e) { var v = e.target.getAttribute("data-v"); if (!v) return; AB.circuit = v === "circ"; seg("abcirc", v); run(); };
    seg("abway", AB.way); seg("abkeys", AB.keys ? "keys" : "avoid"); seg("abcirc", AB.circuit ? "circ" : "one");
    return d;
  }
  function closeSheet() {
    AB.seq++; AB.picking = false; if (AB.sheet) AB.sheet.style.display = "none";
    AB.layer.clearLayers(); AB.marker = null; AB.from = null;
    if (document.getElementById("abfrom")) document.getElementById("abfrom").textContent = "not set";
  }
  // a tap while choosing the start sets the start instead of moving the pin
  window.mapPick = function (e) {
    if (!AB.picking) return false;
    AB.picking = false; lastFeatureClick = Date.now();      // so the same tap does not also move the pin
    var t = document.getElementById("abtap"); if (t) t.classList.remove("on");
    setFrom(e.latlng, "tapped point");
    return true;
  };
  // the pin moved: redo the route if the sheet is open
  window.pinMovedAB = function () {
    if (AB.sheet && AB.sheet.style.display === "block" && AB.from) { clearLines(); clearTimeout(AB.t); AB.t = setTimeout(run, 400); }
  };
  document.getElementById("routefrom").onclick = function () {
    if (!pin) return;
    ensureSheet().style.display = "block";
    setFolded(true);
    if (AB.from) run(); else status("Choose where to start from: your location, or tap the map.");
  };
})();
