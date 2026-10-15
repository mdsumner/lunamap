// lunamap - model3d.js: a 3D model of the area in view (loaded on demand from Tools).
// Terrain: the Tasmania 2 m DEM (via js/profile.js and geotiff.js), sampled on a
// grid in MGA94 zone 55 over a disc centred on the view. The disc circumscribes the
// largest square in the view (radius = half the square's diagonal), so the corners of
// the view are inside the model. Grid nodes outside the disc are pulled in to its edge,
// which gives a round model without trimming triangles; a wall closes the side.
// Drape: the current basemap's tiles, stitched into one image. Pin shown in red.
// Rendered with three.js (r147, the last release with a plain script build).
// ---------------------------------------------------------------------------
(function () {
  var THREE_URL = "https://cdn.jsdelivr.net/npm/three@0.147.0/build/three.min.js";
  var ORBIT_URL = "https://cdn.jsdelivr.net/npm/three@0.147.0/examples/js/controls/OrbitControls.js";
  var GEOTIFF_URL = "https://cdn.jsdelivr.net/npm/geotiff@3.0.5/dist-browser/geotiff.js";
  var GRID = 241, RING = 360, TEX_PX = 2048;
  var ov = null, renderer = null, scene = null, camera = null, controls = null, group = null, raf = 0, exag = 1.5;

  function el(tag, attrs, html) { var e = document.createElement(tag); for (var k in attrs) e.setAttribute(k, attrs[k]); if (html) e.innerHTML = html; return e; }

  function overlay() {
    if (ov) return ov;
    ov = el("div", { id: "m3d" });
    ov.innerHTML = "<div class='m3dbar'><b>3D view</b><span class='seg' id='m3dex'></span>" +
      "<button id='m3dsave' type='button'>Save image</button><button id='m3dclose' type='button' aria-label='Close'>x</button></div>" +
      "<div id='m3dstage'></div><div id='m3dnorth' title='North'><span>N</span></div>" +
      "<div id='m3dmsg' class='small'></div>" +
      "<div class='m3dfoot small'>Drag to turn, pinch or scroll to zoom, two fingers or right-drag to pan. " +
      "Heights exaggerated as shown. Elevation: Tasmania 2 m DEM (MRT / theLIST, CC BY 3.0 AU) via Source Cooperative; map &copy; State of Tasmania (theLIST).</div>";
    document.body.appendChild(ov);
    var ex = ov.querySelector("#m3dex");
    [1, 1.5, 2, 3].forEach(function (v) {
      var b = el("button", { type: "button" }, v + "x"); if (v === exag) b.className = "on";
      b.onclick = function () { exag = v; [].forEach.call(ex.children, function (c) { c.className = c === b ? "on" : ""; });
        if (group) group.scale.y = exag; };
      ex.appendChild(b);
    });
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
  function close() {
    if (!ov) return;
    cancelAnimationFrame(raf); raf = 0;
    if (renderer) { renderer.dispose(); renderer.forceContextLoss && renderer.forceContextLoss(); renderer.domElement.remove(); renderer = null; }
    if (controls) { controls.dispose(); controls = null; }
    scene = null; group = null; ov.style.display = "none";
  }
  function resize() {
    if (!renderer || !ov) return;
    var st = ov.querySelector("#m3dstage"), w = st.clientWidth, h = st.clientHeight;
    renderer.setSize(w, h); camera.aspect = w / h; camera.updateProjectionMatrix();
  }

  // the model footprint: centre and radius in MGA94 zone 55 metres
  function footprint() {
    var def = mgaDefs(55).mga94, b = map.getBounds(), c = map.getCenter();
    var sw = proj4("EPSG:4326", def, [b.getWest(), b.getSouth()]), ne = proj4("EPSG:4326", def, [b.getEast(), b.getNorth()]);
    var cen = proj4("EPSG:4326", def, [c.lng, c.lat]);
    var side = Math.min(ne[0] - sw[0], ne[1] - sw[1]);
    return { def: def, E: cen[0], N: cen[1], R: side / 2 * Math.SQRT2 };
  }

  // stitch basemap tiles covering the disc into one canvas; resolves {canvas, z, px0, py0} or null
  function drape(lonlats) {
    var id = (document.getElementById("layer") || {}).value || "topo";
    var b = BASEMAPS.filter(function (x) { return x.id === id; })[0] || BASEMAPS[0];
    var bounds = L.latLngBounds(lonlats.map(function (q) { return [q[1], q[0]]; }));
    var z = Math.min(b.max || 18, 18);
    while (z > 1) {
      var p0 = map.project(bounds.getNorthWest(), z), p1 = map.project(bounds.getSouthEast(), z);
      if (p1.x - p0.x <= TEX_PX && p1.y - p0.y <= TEX_PX) break;
      z--;
    }
    p0 = map.project(bounds.getNorthWest(), z); p1 = map.project(bounds.getSouthEast(), z);
    var tx0 = Math.floor(p0.x / 256), ty0 = Math.floor(p0.y / 256), tx1 = Math.floor(p1.x / 256), ty1 = Math.floor(p1.y / 256);
    var cv = document.createElement("canvas");
    cv.width = (tx1 - tx0 + 1) * 256; cv.height = (ty1 - ty0 + 1) * 256;
    var g = cv.getContext("2d"); g.fillStyle = "#dde3e6"; g.fillRect(0, 0, cv.width, cv.height);
    var jobs = [], ok = 0;
    for (var ty = ty0; ty <= ty1; ty++) for (var tx = tx0; tx <= tx1; tx++) jobs.push([tx, ty]);
    var next = 0;
    function worker() {
      if (next >= jobs.length) return Promise.resolve();
      var t = jobs[next++], u = LIST + b.svc + "/MapServer/tile/" + z + "/" + t[1] + "/" + t[0];
      return fetch(u, { mode: "cors", credentials: "omit" }).then(function (r) { if (!r.ok) throw new Error(r.status); return r.blob(); })
        .then(function (bl) { return createImageBitmap(bl); })
        .then(function (im) { g.drawImage(im, (t[0] - tx0) * 256, (t[1] - ty0) * 256); ok++; })
        .catch(function () {}).then(worker);
    }
    var ws = []; for (var i = 0; i < 6; i++) ws.push(worker());
    return Promise.all(ws).then(function () {
      return ok ? { canvas: cv, z: z, px0: tx0 * 256, py0: ty0 * 256 } : null;
    });
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

  function build(fp, pts, nGrid, tex) {
    var T = window.THREE, n = GRID, zs = pts.map(function (p) { return p.z === null ? 0 : p.z; });
    var gridZ = zs.slice(0, nGrid), z0 = Math.min.apply(null, gridZ), z1 = Math.max.apply(null, gridZ);
    var base = z0 - Math.max(20, 0.12 * (z1 - z0));
    var pos = new Float32Array(nGrid * 3), uv = new Float32Array(nGrid * 2), col = tex ? null : new Float32Array(nGrid * 3);
    function uvOf(p) {
      var q = map.project(L.latLng(p.lat, p.lon), tex.z);
      return [(q.x - tex.px0) / tex.canvas.width, 1 - (q.y - tex.py0) / tex.canvas.height];
    }
    for (var i = 0; i < nGrid; i++) {
      var p = pts[i];
      pos[3 * i] = p.E - fp.E; pos[3 * i + 1] = zs[i] - base; pos[3 * i + 2] = -(p.N - fp.N);
      if (tex) { var u = uvOf(p); uv[2 * i] = u[0]; uv[2 * i + 1] = u[1]; }
      else { var c = hypso(zs[i], z0, z1); col[3 * i] = c[0]; col[3 * i + 1] = c[1]; col[3 * i + 2] = c[2]; }
    }
    var idx = [];
    for (var r = 0; r < n - 1; r++) for (var c2 = 0; c2 < n - 1; c2++) {
      var a = r * n + c2, b = a + 1, d = a + n, e = d + 1;
      idx.push(a, d, b, b, d, e);
    }
    var geo = new T.BufferGeometry();
    geo.setAttribute("position", new T.BufferAttribute(pos, 3));
    if (tex) geo.setAttribute("uv", new T.BufferAttribute(uv, 2)); else geo.setAttribute("color", new T.BufferAttribute(col, 3));
    geo.setIndex(idx); geo.computeVertexNormals();
    var mat;
    if (tex) {
      var t = new T.CanvasTexture(tex.canvas); t.encoding = T.sRGBEncoding; t.anisotropy = 4;
      mat = new T.MeshLambertMaterial({ map: t });
    } else mat = new T.MeshLambertMaterial({ vertexColors: true });
    group = new T.Group();
    group.add(new T.Mesh(geo, mat));

    // wall around the disc edge, and a base
    var ring = pts.slice(nGrid), wp = [], wi = [];
    ring.forEach(function (p, k) {
      var x = p.E - fp.E, y = (p.z === null ? 0 : p.z) - base, zz = -(p.N - fp.N);
      wp.push(x, y, zz, x, 0, zz);
      var a = 2 * k, b = 2 * ((k + 1) % ring.length);
      wi.push(a, a + 1, b, b, a + 1, b + 1);
    });
    var wg = new T.BufferGeometry();
    wg.setAttribute("position", new T.Float32BufferAttribute(wp, 3)); wg.setIndex(wi); wg.computeVertexNormals();
    group.add(new T.Mesh(wg, new T.MeshLambertMaterial({ color: 0x8d7b68, side: T.DoubleSide })));
    var disc = new T.Mesh(new T.CircleGeometry(fp.R, 128), new T.MeshLambertMaterial({ color: 0x6d5f50, side: T.DoubleSide }));
    disc.rotation.x = Math.PI / 2; group.add(disc);

    // the pin, if inside the disc
    if (pin) {
      var pl = pin.getLatLng(), pe = proj4("EPSG:4326", fp.def, [pl.lng, pl.lat]), dx = pe[0] - fp.E, dn = pe[1] - fp.N;
      if (Math.hypot(dx, dn) < fp.R) {
        var ci = Math.round(dn / (2 * fp.R / (n - 1)) * -1 + (n - 1) / 2), cj = Math.round(dx / (2 * fp.R / (n - 1)) + (n - 1) / 2);
        var pz = zs[Math.max(0, Math.min(nGrid - 1, ci * n + cj))] - base, h = fp.R * 0.08;
        var stick = new T.Mesh(new T.CylinderGeometry(fp.R * 0.003, fp.R * 0.003, h, 8), new T.MeshBasicMaterial({ color: 0xc62828 }));
        stick.position.set(dx, pz + h / 2, -dn);
        var ball = new T.Mesh(new T.SphereGeometry(fp.R * 0.012, 16, 12), new T.MeshBasicMaterial({ color: 0xc62828 }));
        ball.position.set(dx, pz + h, -dn);
        group.add(stick, ball);
      }
    }
    group.scale.y = exag;
    return { relief: z1 - z0, z0: z0, z1: z1 };
  }

  function render(fp, info) {
    var T = window.THREE, st = ov.querySelector("#m3dstage");
    renderer = new T.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputEncoding = T.sRGBEncoding;
    st.appendChild(renderer.domElement);
    scene = new T.Scene(); scene.background = new T.Color(0xe8eef2);
    scene.add(new T.HemisphereLight(0xffffff, 0x8899aa, 0.75));
    var sun = new T.DirectionalLight(0xffffff, 0.55); sun.position.set(-fp.R, fp.R * 1.5, -fp.R * 0.6); scene.add(sun);  // from the NW
    scene.add(group);
    camera = new T.PerspectiveCamera(40, 1, fp.R / 1000, fp.R * 40);
    var mid = info.relief * exag / 2;
    controls = new T.OrbitControls(camera, renderer.domElement);
    resize();
    // stand far enough back to see the whole disc at this screen shape, looking down at about 35 degrees
    var vf = camera.fov * Math.PI / 360, hf = Math.atan(Math.tan(vf) * camera.aspect);
    var D = 1.15 * fp.R / Math.tan(Math.min(vf, hf)), el = 35 * Math.PI / 180;
    camera.position.set(0, mid + D * Math.sin(el), D * Math.cos(el));
    controls.target.set(0, mid, 0); controls.enableDamping = true; controls.maxPolarAngle = Math.PI * 0.49;
    controls.minDistance = fp.R * 0.05; controls.maxDistance = fp.R * 8;
    var north = ov.querySelector("#m3dnorth span");
    (function loop() {
      raf = requestAnimationFrame(loop);
      controls.update(); renderer.render(scene, camera);
      north.parentNode.style.transform = "rotate(" + (controls.getAzimuthalAngle() * 180 / Math.PI).toFixed(1) + "deg)";
    })();
  }

  window.open3D = function () {
    var fp = footprint();
    if (fp.R > 40000) { toast("Zoom in closer for a 3D view (up to about 80 km across)"); return; }
    overlay().style.display = "flex"; close(); ov.style.display = "flex";
    msg("Loading 3D tools...");
    var P;
    loadScript(THREE_URL).then(function () { return loadScript(ORBIT_URL); })
      .then(function () { return loadScript(GEOTIFF_URL); }).then(function () { return loadScript("js/profile.js"); })
      .then(function () {
        P = window.lunamapProfile;
        var n = GRID, sp = 2 * fp.R / (n - 1), pts = [];
        for (var r = 0; r < n; r++) for (var c = 0; c < n; c++) {
          var dx = (c - (n - 1) / 2) * sp, dn = ((n - 1) / 2 - r) * sp, d = Math.hypot(dx, dn);
          if (d > fp.R) { dx *= fp.R / d; dn *= fp.R / d; }            // pull outside nodes in to the disc edge
          pts.push({ E: fp.E + dx, N: fp.N + dn });
        }
        for (var k = 0; k < RING; k++) {
          var a = 2 * Math.PI * k / RING;
          pts.push({ E: fp.E + fp.R * Math.sin(a), N: fp.N + fp.R * Math.cos(a) });
        }
        pts.forEach(function (p) { var ll = proj4(fp.def, "EPSG:4326", [p.E, p.N]); p.lon = ll[0]; p.lat = ll[1]; });
        msg("Reading elevation (" + Math.round(sp) + " m spacing) and map...");
        var ring = pts.slice(n * n).map(function (p) { return [p.lon, p.lat]; });
        return Promise.all([P.sampleDEM(pts, sp), drape(ring)]).then(function (r) {
          if (ov.style.display === "none") return;
          var valid = pts.some(function (p) { return p.z !== null; });
          if (!valid) { msg("No elevation here (outside the Tasmania DEM)."); return; }
          var info = build(fp, pts, n * n, r[1]);
          render(fp, info);
          msg(Math.round(2 * fp.R).toLocaleString("en-AU") + " m across, " + Math.round(info.z0) + " to " + Math.round(info.z1) +
              " m elevation, " + Math.round(sp) + " m grid" + (r[1] ? "" : " (map drape unavailable - coloured by height)") + ".");
        });
      })
      .catch(function (e) { msg("3D view failed: " + e.message); });
  };
})();
