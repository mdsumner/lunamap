// lunamap - outline.js (Explore): "Outline from photo". Tap something on the map - a shed roof,
// a dam, a clearing - and a segment-anything model (SlimSAM, via Transformers.js) running on the
// phone outlines it. The outline becomes a drawn polygon, so Draw shows its area and perimeter,
// and the best-fitting rectangle gives length x width (handy for buildings).
//   The model (about 10-40 MB) downloads on first use and is cached by the browser. It runs on the
//   graphics chip (WebGPU) where the browser has it, otherwise on the CPU (slower).
//   It reads the basemap you are looking at: a 512 x 512 pixel window around the tap, fetched as
//   tiles at the current zoom (theLIST allows this). Works best on aerial photos, zoomed in.
//   Nothing is uploaded. Accuracy is a few pixels: roofs include eaves, and tall things lean in
//   aerial photos, so treat sizes as about +/- 0.5 to 1 m at street-level zoom.
// ---------------------------------------------------------------------------
(function () {
  var TJS = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.0.2";
  var MODEL = "Xenova/slimsam-77-uniform", WIN = 512;
  var picking = false, busy = false, lib = null, sheet = null, last = null, tmpLayer = L.layerGroup().addTo(map);

  function status(t) { var el = document.getElementById("olstat"); if (el) el.textContent = t; }
  function loadModel() {
    if (!lib) lib = import(TJS).then(function (T) {
      var webgpu = !!navigator.gpu;
      function load(dev, dtype) {
        return Promise.all([T.SamModel.from_pretrained(MODEL, { device: dev, dtype: dtype }), T.AutoProcessor.from_pretrained(MODEL)])
          .then(function (r) { return { T: T, model: r[0], proc: r[1], dev: dev }; });
      }
      status("Loading the outline model (first time only, " + (webgpu ? "for the graphics chip" : "for the CPU") + ")...");
      return (webgpu ? load("webgpu", "fp32").catch(function () { return load("wasm", "q8"); }) : load("wasm", "q8"));
    }).catch(function (e) { lib = null; throw e; });
    return lib;
  }

  // a WIN x WIN canvas of the current basemap centred on the tapped point, at the current zoom
  function grab(ll) {
    var id = sel.value, z = Math.min(map.getZoom(), basemapMaxZoom(id));
    var p = map.project(ll, z).round(), x0 = p.x - WIN / 2, y0 = p.y - WIN / 2;
    var cv = document.createElement("canvas"); cv.width = WIN; cv.height = WIN;
    var g = cv.getContext("2d"), jobs = [];
    for (var ty = Math.floor(y0 / 256); ty <= Math.floor((y0 + WIN - 1) / 256); ty++)
      for (var tx = Math.floor(x0 / 256); tx <= Math.floor((x0 + WIN - 1) / 256); tx++) (function (tx, ty) {
        var url = basemapTileUrl(id, z, tx, ty);
        if (!url) throw new Error("this basemap can't be read - switch to Aerial photo");
        jobs.push(fetch(url, { mode: "cors" }).then(function (r) { if (!r.ok) throw new Error("tile " + r.status); return r.blob(); })
          .then(function (b) { return createImageBitmap(b); })
          .then(function (bm) { g.drawImage(bm, tx * 256 - x0, ty * 256 - y0, 256, 256); }));
      })(tx, ty);
    return Promise.all(jobs).then(function () { return { cv: cv, z: z, x0: x0, y0: y0 }; });
  }

  // mask (Uint8, w x h) -> outline ring in pixel coordinates around the component under (cx, cy)
  function maskRing(m, w, h, cx, cy) {
    var comp = new Uint8Array(w * h), st = [cy * w + cx];
    if (!m[cy * w + cx]) {                          // tap fell just outside the mask: take the nearest mask pixel
      var best = -1, bd = Infinity;
      for (var i = 0; i < w * h; i++) if (m[i]) { var dx = i % w - cx, dy = (i / w | 0) - cy, d = dx * dx + dy * dy; if (d < bd) { bd = d; best = i; } }
      if (best < 0) return null; st = [best];
    }
    comp[st[0]] = 1;
    while (st.length) {
      var k = st.pop(), x = k % w, y = (k / w) | 0;
      [[1, 0], [-1, 0], [0, 1], [0, -1]].forEach(function (d) {
        var nx = x + d[0], ny = y + d[1]; if (nx < 0 || ny < 0 || nx >= w || ny >= h) return;
        var nk = ny * w + nx; if (m[nk] && !comp[nk]) { comp[nk] = 1; st.push(nk); }
      });
    }
    // marching squares on the component (padded by one pixel), keep the longest ring
    var W = w + 2, H = h + 2, v = new Float32Array(W * H);
    for (var yy = 0; yy < h; yy++) for (var xx = 0; xx < w; xx++) v[(yy + 1) * W + xx + 1] = comp[yy * w + xx];
    var segs = [];
    for (var j = 0; j < H - 1; j++) for (var q = 0; q < W - 1; q++) {
      var a = v[j * W + q], b = v[j * W + q + 1], c = v[(j + 1) * W + q + 1], dd = v[(j + 1) * W + q];
      var idx = (a ? 8 : 0) | (b ? 4 : 0) | (c ? 2 : 0) | (dd ? 1 : 0); if (!idx || idx === 15) continue;
      var T = [q + 0.5, j], R = [q + 1, j + 0.5], B = [q + 0.5, j + 1], Lf = [q, j + 0.5];
      ({ 1: [[Lf, B]], 14: [[Lf, B]], 2: [[B, R]], 13: [[B, R]], 3: [[Lf, R]], 12: [[Lf, R]], 4: [[T, R]], 11: [[T, R]],
         6: [[T, B]], 9: [[T, B]], 7: [[Lf, T]], 8: [[Lf, T]], 5: [[Lf, T], [B, R]], 10: [[T, R], [Lf, B]] })[idx]
        .forEach(function (s) { segs.push(s); });
    }
    function key(p) { return p[0] * 2 + "," + p[1] * 2; }
    var ends = {}, used = new Uint8Array(segs.length), rings = [];
    segs.forEach(function (s, si) { [key(s[0]), key(s[1])].forEach(function (kk) { (ends[kk] = ends[kk] || []).push(si); }); });
    for (var s0 = 0; s0 < segs.length; s0++) {
      if (used[s0]) continue; used[s0] = 1;
      var ring = [segs[s0][0], segs[s0][1]];
      for (;;) {
        var tip = ring[ring.length - 1], nx2 = (ends[key(tip)] || []).filter(function (x) { return !used[x]; })[0];
        if (nx2 === undefined) break; used[nx2] = 1;
        var sg = segs[nx2]; ring.push(key(sg[0]) === key(tip) ? sg[1] : sg[0]);
      }
      rings.push(ring);
    }
    rings.sort(function (r1, r2) { return r2.length - r1.length; });
    return rings[0] ? rings[0].map(function (p) { return [p[0] - 1, p[1] - 1]; }) : null;
  }
  // Douglas-Peucker in pixels
  function simplify(pts, tol) {
    if (pts.length < 4) return pts;
    var keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
    (function rec(i, j) {
      var a = pts[i], b = pts[j], dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy, bi = -1, bd = tol;
      for (var k = i + 1; k < j; k++) {
        var t = L2 ? Math.max(0, Math.min(1, ((pts[k][0] - a[0]) * dx + (pts[k][1] - a[1]) * dy) / L2)) : 0;
        var d = Math.hypot(pts[k][0] - a[0] - t * dx, pts[k][1] - a[1] - t * dy); if (d > bd) { bd = d; bi = k; }
      }
      if (bi > 0) { keep[bi] = 1; rec(i, bi); rec(bi, j); }
    })(0, pts.length - 1);
    return pts.filter(function (_, i) { return keep[i]; });
  }
  // smallest rectangle around the points (rotating the convex hull's edges)
  function minRect(pts) {
    var P = pts.slice().sort(function (a, b) { return a[0] - b[0] || a[1] - b[1]; });
    function cr(o, a, b) { return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]); }
    var lo = [], up = [];
    P.forEach(function (p) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop(); lo.push(p); });
    P.slice().reverse().forEach(function (p) { while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], p) <= 0) up.pop(); up.push(p); });
    var hull = lo.slice(0, -1).concat(up.slice(0, -1)), best = null;
    for (var i = 0; i < hull.length; i++) {
      var a = hull[i], b = hull[(i + 1) % hull.length], ang = Math.atan2(b[1] - a[1], b[0] - a[0]), c = Math.cos(ang), s = Math.sin(ang);
      var mnx = Infinity, mxx = -Infinity, mny = Infinity, mxy = -Infinity;
      hull.forEach(function (p) { var u = p[0] * c + p[1] * s, v = -p[0] * s + p[1] * c;
        mnx = Math.min(mnx, u); mxx = Math.max(mxx, u); mny = Math.min(mny, v); mxy = Math.max(mxy, v); });
      var area = (mxx - mnx) * (mxy - mny);
      if (!best || area < best.area) best = { area: area, c: c, s: s, b: [mnx, mxx, mny, mxy] };
    }
    if (!best) return null;
    var c2 = best.c, s2 = best.s, bb = best.b;
    return [[bb[0], bb[2]], [bb[1], bb[2]], [bb[1], bb[3]], [bb[0], bb[3]]].map(function (q) { return [q[0] * c2 - q[1] * s2, q[0] * s2 + q[1] * c2]; });
  }

  function toLL(ring, g) { return ring.map(function (p) { var ll = map.unproject([g.x0 + p[0], g.y0 + p[1]], g.z); return [ll.lng, ll.lat]; }); }
  function sideLengths(llr) {
    var s = []; for (var i = 0; i < llr.length; i++) { var a = llr[i], b = llr[(i + 1) % llr.length]; s.push(map.distance([a[1], a[0]], [b[1], b[0]])); }
    return s;
  }
  function ringArea(r) {           // square metres, local flat approximation (fine for anything this small)
    var lat0 = r[0][1] * Math.PI / 180, kx = 111320 * Math.cos(lat0), ky = 110574, a = 0;
    for (var i = 0; i < r.length; i++) { var p = r[i], q = r[(i + 1) % r.length]; a += p[0] * kx * q[1] * ky - q[0] * kx * p[1] * ky; }
    return Math.abs(a / 2);
  }
  function fmtM(m) { return m < 100 ? m.toFixed(1) + " m" : Math.round(m) + " m"; }

  function run(ll) {
    if (busy) return; busy = true;
    tmpLayer.clearLayers();
    status("Reading the map around the tap...");
    var g;
    grab(ll).then(function (gg) { g = gg; return loadModel(); }).then(function (M) {
      status("Outlining (" + (M.dev === "webgpu" ? "graphics chip" : "CPU, may take a while") + ")...");
      return M.T.RawImage.fromURL(g.cv.toDataURL("image/png")).then(function (img) {
        var pts = [[[WIN / 2, WIN / 2]]], lbl = [[1]];
        return Promise.resolve().then(function () { return M.proc(img, { input_points: pts, input_labels: lbl }); })
          .catch(function () { return M.proc(img, pts); })
          .then(function (inputs) {
            return M.model(inputs).then(function (out) {
              return M.proc.post_process_masks(out.pred_masks, inputs.original_sizes, inputs.reshaped_input_sizes).then(function (masks) {
                return { masks: masks, scores: out.iou_scores.data };
              });
            });
          });
      });
    }).then(function (r) {
      var m = r.masks[0], dims = m.dims, n = dims[1], h = dims[2], w = dims[3], data = m.data;
      var bi = 0; for (var i = 1; i < n; i++) if (r.scores[i] > r.scores[bi]) bi = i;
      var mk = new Uint8Array(w * h), off = bi * w * h;
      for (var k = 0; k < w * h; k++) mk[k] = data[off + k] ? 1 : 0;
      var ring = maskRing(mk, w, h, Math.round(w / 2), Math.round(h / 2));
      if (!ring || ring.length < 4) throw new Error("nothing outlined there - try zooming in or tapping the middle of it");
      var mpp = 40075016 * Math.cos(ll.lat * Math.PI / 180) / Math.pow(2, g.z + 8);
      var poly = simplify(ring, Math.max(1, 0.4 / mpp)), rect = minRect(poly);
      var outline = toLL(poly, g), rll = rect ? toLL(rect, g) : null, sides = rll ? sideLengths(rll) : null;
      last = { outline: outline, rect: rll, score: r.scores[bi] };
      tmpLayer.addLayer(L.polygon(outline.map(function (p) { return [p[1], p[0]]; }), { color: "#00e5ff", weight: 2, fillOpacity: 0.15, interactive: false }));
      if (rll) tmpLayer.addLayer(L.polygon(rll.map(function (p) { return [p[1], p[0]]; }), { color: "#ff4081", weight: 1.5, dashArray: "4 4", fill: false, interactive: false }));
      var area = ringArea(outline);
      var L1 = sides ? Math.max(sides[0], sides[1]) : 0, W1 = sides ? Math.min(sides[0], sides[1]) : 0;
      status("Outlined (model confidence " + Math.round(r.scores[bi] * 100) + "%)." + (sides ? " Best-fit rectangle about " + fmtM(L1) + " x " + fmtM(W1) +
        " (" + Math.round(L1 * W1) + " m²)." : "") + (area ? " Outline area " + Math.round(area) + " m²." : "") +
        " Keep it as a drawing, or tap again.");
      document.getElementById("olkeep").style.display = ""; document.getElementById("olrect").style.display = rll ? "" : "none";
    }).catch(function (e) { status("Outline failed: " + e.message); })
      .then(function () { busy = false; picking = true; setBtn(); });
  }
  function keep(which) {
    if (!last) return;
    var ring = which === "rect" ? last.rect : last.outline; if (!ring) return;
    var gj = { type: "FeatureCollection", features: [{ type: "Feature", properties: { label: which === "rect" ? "rectangle" : "outline" },
      geometry: { type: "Polygon", coordinates: [ring.concat([ring[0]])] } }] };
    loadDraw().then(function () {            // the drawing tools load on first use
      if (!drawOn) window.toggleDraw();
      var before = drawn.getLayers().length; addGeoJSON(gj); saveDrawings();
      var lyr = drawn.getLayers()[before]; if (lyr) selectDrawn(lyr);
      tmpLayer.clearLayers(); last = null; picking = false; setBtn();
      if (sheet) sheet.style.display = "none";
      toast("Saved as a drawing: the Draw panel shows its area and perimeter");
    }).catch(function (e) { status("Could not open the drawing tools: " + e.message); });
  }
  function setBtn() { var b = document.getElementById("oltap"); if (b) b.classList.toggle("on", picking); }

  var prevPick = window.mapPick;
  window.mapPick = function (e) {
    if (picking && sheet && sheet.style.display === "block") {
      lastFeatureClick = Date.now(); picking = false; setBtn(); run(e.latlng); return true;
    }
    return prevPick ? prevPick(e) : false;
  };
  window.openOutline = function () {
    if (!sheet) {
      sheet = document.createElement("div"); sheet.id = "olsheet"; sheet.className = "sheet";
      sheet.innerHTML = "<h2><span>Outline from photo</span><button id='olclose' aria-label='Close'>x</button></h2>" +
        "<p class='small'>Tap something on the map - a roof, a dam, a clearing - and it is outlined for you. Works best on " +
        "<b>Aerial photo</b>, zoomed right in. The first time, the outline model (10-40 MB) downloads; after that it is cached.</p>" +
        "<div class='seg'><button type='button' id='oltap'>Tap the map</button><button type='button' id='olaerial'>Switch to aerial photo</button></div>" +
        "<div id='olstat' class='small' style='margin:6px 0'></div>" +
        "<div class='acts'><button id='olkeep' style='display:none'>Keep outline</button><button id='olrect' style='display:none'>Keep rectangle</button></div>" +
        "<p class='small' style='color:#666'>Runs on this phone; nothing is uploaded. Sizes are approximate (about +/- 0.5 to 1 m zoomed " +
        "in): roofs include the eaves, and tall things lean in aerial photos.</p>";
      document.body.appendChild(sheet); L.DomEvent.disableClickPropagation(sheet);
      sheet.querySelector("#olclose").onclick = function () { sheet.style.display = "none"; picking = false; tmpLayer.clearLayers(); };
      sheet.querySelector("#oltap").onclick = function () { picking = !picking; setBtn(); status(picking ? "Tap the thing to outline." : ""); };
      sheet.querySelector("#olaerial").onclick = function () { sel.value = "ortho"; sel.dispatchEvent(new Event("change")); };
      sheet.querySelector("#olkeep").onclick = function () { keep("outline"); };
      sheet.querySelector("#olrect").onclick = function () { keep("rect"); };
    }
    sheet.style.display = "block"; picking = true; setBtn();
    status(map.getZoom() < 17 ? "Zoom in close (street level or closer), then tap the thing to outline." : "Tap the thing to outline.");
    if (typeof setMenu === "function") setMenu(null);
  };
  document.getElementById("outline").onclick = window.openOutline;
  window.lunamapOutline = { maskRing: maskRing, simplify: simplify, minRect: minRect };   // for testing
})();
