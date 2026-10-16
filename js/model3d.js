// lunamap - model3d.js: a 3D model of the area in view (loaded on demand from Tools).
// Terrain: the Tasmania 2 m DEM (via js/profile.js and geotiff.js), sampled on a
// grid in MGA94 zone 55 over a disc. The first disc is centred on the map view and
// circumscribes the largest square in it (radius = half the square's diagonal). Grid
// nodes outside the disc are pulled in to its edge, so the model is round without
// trimming triangles. The basemap in use is draped over the disc.
// Around it, out to twice the radius, a coarser wire mesh of the terrain fades out,
// for context only (no drape, no detail).
// In the view: Detail sets the grid size; "Detail here" rebuilds the model around the
// point being looked at, sized to what is on screen, so zooming in and tapping it pulls
// finer elevation (down to the DEM's 2 m) and a sharper drape. "Wider" doubles the area.
// The scene keeps one origin and base height, so rebuilt models line up and the camera
// does not jump. Pin shown in red. three.js r147 (the last plain script build).
// ---------------------------------------------------------------------------
(function () {
  var THREE_URL = "https://cdn.jsdelivr.net/npm/three@0.147.0/build/three.min.js";
  var ORBIT_URL = "https://cdn.jsdelivr.net/npm/three@0.147.0/examples/js/controls/OrbitControls.js";
  var GEOTIFF_URL = "https://cdn.jsdelivr.net/npm/geotiff@3.0.5/dist-browser/geotiff.js";
  var DETAIL = [{ label: "Normal", n: 257, tex: 2048 }, { label: "High", n: 513, tex: 4096 }, { label: "Max", n: 769, tex: 4096 }];
  var MARGIN_N = 121, DEM_MIN = 2, R_MIN = 60, R_MAX = 40000;
  var ov = null, renderer = null, scene = null, camera = null, controls = null, raf = 0;
  var model = null, origin = null, cur = null, exag = 1.5, detail = 0, busy = false, seq = 0;

  function el(tag, attrs, html) { var e = document.createElement(tag); for (var k in attrs) e.setAttribute(k, attrs[k]); if (html) e.innerHTML = html; return e; }
  function segButtons(box, items, isOn, onPick) {
    box.innerHTML = "";
    items.forEach(function (it, i) {
      var b = el("button", { type: "button" }, it); if (isOn(i)) b.className = "on";
      b.onclick = function () { [].forEach.call(box.children, function (c) { c.className = c === b ? "on" : ""; }); onPick(i); };
      box.appendChild(b);
    });
  }

  function overlay() {
    if (ov) return ov;
    ov = el("div", { id: "m3d" });
    ov.innerHTML = "<div class='m3dbar'><b>3D view</b>" +
      "<span class='m3dgrp'>Height <span class='seg' id='m3dex'></span></span>" +
      "<span class='m3dgrp'>Detail <span class='seg' id='m3ddet'></span></span>" +
      "<button id='m3dhere' type='button' title='Rebuild around the point you are looking at, sized to the screen'>Detail here</button>" +
      "<button id='m3dwide' type='button' title='Rebuild with twice the area'>Wider</button>" +
      "<button id='m3dsave' type='button'>Save image</button><button id='m3dclose' type='button' aria-label='Close'>x</button></div>" +
      "<div id='m3dstage'><div id='m3dnorth' title='North'><span>N</span></div><div id='m3dmsg' class='small'></div></div>" +
      "<div class='m3dfoot small'>Drag to turn, pinch or scroll to zoom, two fingers or right-drag to pan. Zoom in and tap " +
      "<b>Detail here</b> for finer terrain. The faded wire mesh around the edge is context only. " +
      "Elevation: Tasmania 2 m DEM (MRT / theLIST, CC BY 3.0 AU) via Source Cooperative; map &copy; State of Tasmania (theLIST).</div>";
    document.body.appendChild(ov);
    var EX = [1, 1.5, 2, 3];
    segButtons(ov.querySelector("#m3dex"), EX.map(function (v) { return v + "x"; }), function (i) { return EX[i] === exag; },
      function (i) { exag = EX[i]; if (model) model.scale.y = exag; });
    segButtons(ov.querySelector("#m3ddet"), DETAIL.map(function (d) { return d.label; }), function (i) { return i === detail; },
      function (i) { detail = i; if (cur) load(cur); });
    ov.querySelector("#m3dhere").onclick = function () { if (cur && controls) load(hereFootprint()); };
    ov.querySelector("#m3dwide").onclick = function () {
      if (cur) load({ def: cur.def, E: cur.E, N: cur.N, R: Math.min(R_MAX, cur.R * 2) });
    };
    ov.querySelector("#m3dclose").onclick = close;
    ov.querySelector("#m3dsave").onclick = function () {
      if (!renderer) return;
      renderer.render(scene, camera);
      var a = document.createElement("a"); a.download = "lunamap-3d.png"; a.href = renderer.domElement.toDataURL("image/png"); a.click();
    };
    window.addEventListener("resize", resize);
    return ov;
  }
  function msg(t) { if (ov) ov.querySelector("#m3dmsg").textContent = t || ""; }
  function disposeTree(o) {
    o.traverse(function (c) {
      if (c.geometry) c.geometry.dispose();
      if (c.material) { if (c.material.map) c.material.map.dispose(); c.material.dispose(); }
    });
  }
  function close() {
    if (!ov) return;
    seq++; busy = false;
    cancelAnimationFrame(raf); raf = 0;
    if (model) { disposeTree(model); model = null; }
    if (renderer) { renderer.dispose(); renderer.forceContextLoss && renderer.forceContextLoss(); renderer.domElement.remove(); renderer = null; }
    if (controls) { controls.dispose(); controls = null; }
    scene = null; origin = null; cur = null; ov.style.display = "none";
  }
  function resize() {
    if (!renderer || !ov) return;
    var st = ov.querySelector("#m3dstage"), w = st.clientWidth, h = st.clientHeight;
    renderer.setSize(w, h); camera.aspect = w / h; camera.updateProjectionMatrix();
  }

  // the first footprint: centre and radius in MGA94 zone 55 metres, from the map view
  function mapFootprint() {
    var def = mgaDefs(55).mga94, b = map.getBounds(), c = map.getCenter();
    var sw = proj4("EPSG:4326", def, [b.getWest(), b.getSouth()]), ne = proj4("EPSG:4326", def, [b.getEast(), b.getNorth()]);
    var cen = proj4("EPSG:4326", def, [c.lng, c.lat]);
    var side = Math.min(ne[0] - sw[0], ne[1] - sw[1]);
    return { def: def, E: cen[0], N: cen[1], R: side / 2 * Math.SQRT2 };
  }
  // a footprint around the orbit target, big enough for what the camera sees
  function hereFootprint() {
    var t = controls.target, d = camera.position.distanceTo(t);
    var vf = camera.fov * Math.PI / 360, hf = Math.atan(Math.tan(vf) * camera.aspect);
    var R = Math.max(R_MIN, Math.min(R_MAX, d * Math.tan(Math.min(vf, hf))));
    return { def: cur.def, E: origin.E + t.x, N: origin.N - t.z, R: R };
  }

  // stitch basemap tiles covering a lon/lat box into one canvas; resolves {canvas, z, px0, py0} or null
  function drape(bounds, texPx) {
    var id = (document.getElementById("layer") || {}).value || "topo";
    var b = BASEMAPS.filter(function (x) { return x.id === id; })[0] || BASEMAPS[0];
    var maxTex = renderer ? renderer.capabilities.maxTextureSize : 4096;
    texPx = Math.min(texPx, maxTex);
    var z = Math.min(b.max || 18, 20), p0, p1;
    while (z > 1) {
      p0 = map.project(bounds.getNorthWest(), z); p1 = map.project(bounds.getSouthEast(), z);
      if ((Math.floor(p1.x / 256) - Math.floor(p0.x / 256) + 1) * 256 <= texPx &&
          (Math.floor(p1.y / 256) - Math.floor(p0.y / 256) + 1) * 256 <= texPx) break;
      z--;
    }
    p0 = map.project(bounds.getNorthWest(), z); p1 = map.project(bounds.getSouthEast(), z);
    var tx0 = Math.floor(p0.x / 256), ty0 = Math.floor(p0.y / 256), tx1 = Math.floor(p1.x / 256), ty1 = Math.floor(p1.y / 256);
    var cv = document.createElement("canvas");
    cv.width = (tx1 - tx0 + 1) * 256; cv.height = (ty1 - ty0 + 1) * 256;
    var g = cv.getContext("2d"); g.fillStyle = "#dde3e6"; g.fillRect(0, 0, cv.width, cv.height);
    var jobs = [], ok = 0, next = 0;
    for (var ty = ty0; ty <= ty1; ty++) for (var tx = tx0; tx <= tx1; tx++) jobs.push([tx, ty]);
    function worker() {
      if (next >= jobs.length) return Promise.resolve();
      var t = jobs[next++], u = LIST + b.svc + "/MapServer/tile/" + z + "/" + t[1] + "/" + t[0];
      return fetch(u, { mode: "cors", credentials: "omit" }).then(function (r) { if (!r.ok) throw new Error(r.status); return r.blob(); })
        .then(function (bl) { return createImageBitmap(bl); })
        .then(function (im) { g.drawImage(im, (t[0] - tx0) * 256, (t[1] - ty0) * 256); ok++; })
        .catch(function () {}).then(worker);
    }
    var ws = []; for (var i = 0; i < 6; i++) ws.push(worker());
    return Promise.all(ws).then(function () { return ok ? { canvas: cv, z: z, px0: tx0 * 256, py0: ty0 * 256 } : null; });
  }

  function hypso(z, z0, z1) {             // fallback colour when no basemap drape
    var t = z1 > z0 ? (z - z0) / (z1 - z0) : 0;
    var stops = [[0, [86, 140, 76]], [0.45, [160, 160, 96]], [0.75, [150, 120, 90]], [1, [240, 240, 240]]];
    for (var i = 1; i < stops.length; i++) if (t <= stops[i][0]) {
      var a = stops[i - 1], b = stops[i], f = (t - a[0]) / (b[0] - a[0]);
      return a[1].map(function (v, k) { return (v + f * (b[1][k] - v)) / 255; });
    }
    return [0.94, 0.94, 0.94];
  }
  function lonlat(fp, p) { var ll = proj4(fp.def, "EPSG:4326", [p.E, p.N]); p.lon = ll[0]; p.lat = ll[1]; return p; }

  // sample points: the core disc (n x n, clamped to radius R) and the margin grid (to 2R)
  function corePoints(fp, n) {
    var sp = 2 * fp.R / (n - 1), pts = [];
    for (var r = 0; r < n; r++) for (var c = 0; c < n; c++) {
      var dx = (c - (n - 1) / 2) * sp, dn = ((n - 1) / 2 - r) * sp, d = Math.hypot(dx, dn);
      if (d > fp.R) { dx *= fp.R / d; dn *= fp.R / d; }
      pts.push(lonlat(fp, { E: fp.E + dx, N: fp.N + dn }));
    }
    return { pts: pts, n: n, sp: sp };
  }
  function marginPoints(fp) {
    var m = MARGIN_N, sp = 4 * fp.R / (m - 1), pts = [];
    for (var r = 0; r < m; r++) for (var c = 0; c < m; c++) {
      var dx = (c - (m - 1) / 2) * sp, dn = ((m - 1) / 2 - r) * sp;
      pts.push({ E: fp.E + dx, N: fp.N + dn, d: Math.hypot(dx, dn) });
    }
    return { pts: pts, n: m, sp: sp };
  }

  function buildCore(T, fp, core, tex, base, z0, z1) {
    var n = core.n, N = n * n, pts = core.pts;
    var pos = new Float32Array(N * 3), uv = tex ? new Float32Array(N * 2) : null, col = tex ? null : new Float32Array(N * 3);
    var ox = fp.E - origin.E, oz = -(fp.N - origin.N);
    for (var i = 0; i < N; i++) {
      var p = pts[i], z = p.z === null ? 0 : p.z;
      pos[3 * i] = ox + p.E - fp.E; pos[3 * i + 1] = z - base; pos[3 * i + 2] = oz - (p.N - fp.N);
      if (tex) {
        var q = map.project(L.latLng(p.lat, p.lon), tex.z);
        uv[2 * i] = (q.x - tex.px0) / tex.canvas.width; uv[2 * i + 1] = 1 - (q.y - tex.py0) / tex.canvas.height;
      } else { var c = hypso(z, z0, z1); col[3 * i] = c[0]; col[3 * i + 1] = c[1]; col[3 * i + 2] = c[2]; }
    }
    var idx = new Uint32Array((n - 1) * (n - 1) * 6), k = 0;
    for (var r = 0; r < n - 1; r++) for (var c2 = 0; c2 < n - 1; c2++) {
      var a = r * n + c2, b = a + 1, d = a + n, e = d + 1;
      idx[k++] = a; idx[k++] = d; idx[k++] = b; idx[k++] = b; idx[k++] = d; idx[k++] = e;
    }
    var geo = new T.BufferGeometry();
    geo.setAttribute("position", new T.BufferAttribute(pos, 3));
    if (tex) geo.setAttribute("uv", new T.BufferAttribute(uv, 2)); else geo.setAttribute("color", new T.BufferAttribute(col, 3));
    geo.setIndex(new T.BufferAttribute(idx, 1)); geo.computeVertexNormals();
    var mat;
    if (tex) {
      var t = new T.CanvasTexture(tex.canvas); t.encoding = T.sRGBEncoding;
      t.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
      mat = new T.MeshLambertMaterial({ map: t });
    } else mat = new T.MeshLambertMaterial({ vertexColors: true });
    return new T.Mesh(geo, mat);
  }

  // wire mesh from R to 2R, alpha fading from the disc edge outwards
  function buildMargin(T, fp, mg, base) {
    var m = mg.n, pts = mg.pts, ox = fp.E - origin.E, oz = -(fp.N - origin.N), R = fp.R;
    var pos = [], col = [];
    function vtx(p, a) {
      pos.push(ox + p.E - fp.E, (p.z === null ? 0 : p.z) - base, oz - (p.N - fp.N));
      col.push(0.27, 0.31, 0.35, a);
    }
    function alpha(d) { var t = (d - R) / R; return t <= 0 ? 0.85 : t >= 1 ? 0 : 0.85 * Math.pow(1 - t, 1.5); }
    function seg(i, j) {
      var p = pts[i], q = pts[j];
      if (p.d > 2 * R && q.d > 2 * R) return;
      if (p.d < R * 0.98 && q.d < R * 0.98) return;          // inside the solid disc
      vtx(p, alpha(p.d)); vtx(q, alpha(q.d));
    }
    for (var r = 0; r < m; r++) for (var c = 0; c < m; c++) {
      var i = r * m + c;
      if (c < m - 1) seg(i, i + 1);
      if (r < m - 1) seg(i, i + m);
    }
    var geo = new T.BufferGeometry();
    geo.setAttribute("position", new T.Float32BufferAttribute(pos, 3));
    geo.setAttribute("color", new T.Float32BufferAttribute(col, 4));
    return new T.LineSegments(geo, new T.LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false }));
  }

  function buildPin(T, fp, core, base) {
    if (!pin) return null;
    var pl = pin.getLatLng(), pe = proj4("EPSG:4326", fp.def, [pl.lng, pl.lat]), dx = pe[0] - fp.E, dn = pe[1] - fp.N;
    if (Math.hypot(dx, dn) >= fp.R) return null;
    var n = core.n, ci = Math.round((n - 1) / 2 - dn / core.sp), cj = Math.round(dx / core.sp + (n - 1) / 2);
    var zp = core.pts[Math.max(0, Math.min(n * n - 1, ci * n + cj))].z, h = fp.R * 0.08;
    var x = fp.E - origin.E + dx, z = -(fp.N - origin.N) - dn, y = (zp === null ? 0 : zp) - base;
    var g = new T.Group(), red = new T.MeshBasicMaterial({ color: 0xc62828 });
    var stick = new T.Mesh(new T.CylinderGeometry(fp.R * 0.003, fp.R * 0.003, h, 8), red); stick.position.set(x, y + h / 2, z);
    var ball = new T.Mesh(new T.SphereGeometry(fp.R * 0.012, 16, 12), red); ball.position.set(x, y + h, z);
    g.add(stick, ball);
    return g;
  }

  function setupScene(fp, relief) {
    var T = window.THREE, st = ov.querySelector("#m3dstage");
    renderer = new T.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputEncoding = T.sRGBEncoding;
    st.appendChild(renderer.domElement);
    scene = new T.Scene(); scene.background = new T.Color(0xe8eef2);
    scene.add(new T.HemisphereLight(0xffffff, 0x8899aa, 0.75));
    var sun = new T.DirectionalLight(0xffffff, 0.55); sun.position.set(-1, 1.5, -0.6); scene.add(sun);   // from the NW
    camera = new T.PerspectiveCamera(40, 1, 1, 1e6);
    controls = new T.OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true; controls.maxPolarAngle = Math.PI * 0.49;
    resize();
    var mid = relief * exag / 2;
    var vf = camera.fov * Math.PI / 360, hf = Math.atan(Math.tan(vf) * camera.aspect);
    var D = 1.15 * fp.R / Math.tan(Math.min(vf, hf)), elv = 35 * Math.PI / 180;
    camera.position.set(0, mid + D * Math.sin(elv), D * Math.cos(elv));
    controls.target.set(0, mid, 0);
    var north = ov.querySelector("#m3dnorth");
    (function loop() {
      raf = requestAnimationFrame(loop);
      controls.update();
      var d = camera.position.distanceTo(controls.target);       // keep depth precision as the user zooms
      camera.near = Math.max(0.5, d / 500); camera.far = d * 50 + 1e4; camera.updateProjectionMatrix();
      renderer.render(scene, camera);
      north.style.transform = "rotate(" + (controls.getAzimuthalAngle() * 180 / Math.PI).toFixed(1) + "deg)";
    })();
  }

  function load(fp) {
    var my = ++seq, T = window.THREE, P = window.lunamapProfile, D = DETAIL[detail];
    var n = D.n;
    if (2 * fp.R / (n - 1) < DEM_MIN) n = Math.max(33, Math.floor(2 * fp.R / DEM_MIN) + 1);   // no finer than the DEM
    var core = corePoints(fp, n), mg = marginPoints(fp);
    busy = true;
    msg("Reading elevation (" + core.sp.toFixed(core.sp < 10 ? 1 : 0) + " m grid) and map for " +
        Math.round(2 * fp.R).toLocaleString("en-AU") + " m across...");
    var c0 = lonlat(fp, { E: fp.E - fp.R, N: fp.N + fp.R }), c1 = lonlat(fp, { E: fp.E + fp.R, N: fp.N - fp.R });
    var c2 = lonlat(fp, { E: fp.E - fp.R, N: fp.N - fp.R }), c3 = lonlat(fp, { E: fp.E + fp.R, N: fp.N + fp.R });
    var bounds = L.latLngBounds([[c0.lat, c0.lon], [c1.lat, c1.lon], [c2.lat, c2.lon], [c3.lat, c3.lon]]);
    return Promise.all([P.sampleDEM(core.pts, core.sp), P.sampleDEM(mg.pts, mg.sp), drape(bounds, D.tex)]).then(function (r) {
      if (my !== seq) return;
      busy = false;
      var zs = core.pts.filter(function (p) { return p.z !== null; }).map(function (p) { return p.z; });
      if (!zs.length) { msg("No elevation here (outside the Tasmania DEM)."); return; }
      var z0 = Infinity, z1 = -Infinity; zs.forEach(function (z) { if (z < z0) z0 = z; if (z > z1) z1 = z; });
      var first = !origin;
      if (first) origin = { E: fp.E, N: fp.N, base: z0 - Math.max(20, 0.05 * (z1 - z0)) };
      if (first) setupScene(fp, z1 - z0);
      var g = new T.Group();
      g.add(buildCore(T, fp, core, r[2], origin.base, z0, z1));
      g.add(buildMargin(T, fp, mg, origin.base));
      var pg = buildPin(T, fp, core, origin.base); if (pg) g.add(pg);
      g.scale.y = exag;
      if (model) { scene.remove(model); disposeTree(model); }
      model = g; scene.add(model); cur = fp;
      msg(Math.round(2 * fp.R).toLocaleString("en-AU") + " m across, " + Math.round(z0) + " to " + Math.round(z1) + " m, " +
          core.sp.toFixed(core.sp < 10 ? 1 : 0) + " m grid" + (core.sp <= DEM_MIN * 1.01 ? " (full DEM detail)" : "") +
          (r[2] ? ", map at zoom " + r[2].z : " (map drape unavailable - coloured by height)") + ".");
    }).catch(function (e) { if (my === seq) { busy = false; msg("3D view failed: " + e.message); } });
  }

  window.open3D = function () {
    var fp = mapFootprint();
    if (fp.R > R_MAX) { toast("Zoom in closer for a 3D view (up to about 80 km across)"); return; }
    overlay(); close(); ov.style.display = "flex";
    msg("Loading 3D tools...");
    loadScript(THREE_URL).then(function () { return loadScript(ORBIT_URL); })
      .then(function () { return loadScript(GEOTIFF_URL); }).then(function () { return loadScript("js/profile.js"); })
      .then(function () { return load(fp); })
      .catch(function (e) { msg("3D view failed: " + e.message); });
  };
})();
