// lunamap - horizon.js (Explore): "What am I looking at?" - a 360 degree panorama of the skyline
// from the pin (or your location), drawn from the Tasmania 2 m DEM, with named peaks and towers
// labelled where they can be seen (OpenStreetMap names, data/osm-peaks-tas.json).
//   Terrain: a 16 m grid out to 5 km and a 64 or 128 m grid beyond (DEM overviews), sea as 0 m.
//   Rays every 0.2 degrees; earth curvature and normal atmospheric refraction (k = 0.13) applied.
//   Layers are shaded by distance (near dark, far pale) with ridge lines where the land behind is
//   much further away, like a drawn panorama. Tap a label or the land to see it on the map.
//   "Follow compass" turns the panorama with the phone (where the phone has a compass).
// Heights are AHD, the eye 1.7 m above the ground unless changed. Tasmania only.
// ---------------------------------------------------------------------------
(function () {
  var GEOTIFF = "https://cdn.jsdelivr.net/npm/geotiff@3.0.5/dist-browser/geotiff.js";
  var PX = 8, AZ_STEP = 0.2, NEAR_R = 5000, R_EARTH = 6371000, K_REFR = 0.13;
  var S = { eye: 1.7, range: 80000 };
  var sheet = null, peaksP = null, ready = null, mapLayer = L.layerGroup().addTo(map), last = null, follow = false;

  function tools() {
    if (!ready) ready = loadScript(GEOTIFF).then(function () { return loadScript("js/profile.js"); }).then(function () {
      if (typeof openDEM !== "function") return loadScript("js/profile.js?v=" + Date.now());
    }).catch(function (e) { ready = null; throw e; });
    return ready;
  }
  function loadPeaks() {
    if (!peaksP) peaksP = fetch("data/osm-peaks-tas.json").then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
      .then(function (d) { return d.peaks; }).catch(function () { peaksP = null; return []; });
    return peaksP;
  }
  function status(t) { var el = document.getElementById("hzstat"); if (el) el.textContent = t; }

  // a square window of the DEM at overview level k around (E, N), as a bilinear sampler (sea / no data = 0 m)
  function grid(dem, k, E, N, radius) {
    return demLevel(dem, k).then(function (lv) {
      var cell = dem.dx * lv.sx;
      var c0 = Math.max(0, Math.floor((E - radius - dem.x0) / cell)), c1 = Math.min(lv.w, Math.ceil((E + radius - dem.x0) / cell) + 1);
      var r0 = Math.max(0, Math.floor((dem.y0 - (N + radius)) / cell)), r1 = Math.min(lv.h, Math.ceil((dem.y0 - (N - radius)) / cell) + 1);
      if (c1 - c0 < 2 || r1 - r0 < 2) return null;
      return lv.img.readRasters({ window: [c0, r0, c1, r1], samples: [0], interleave: false }).then(function (rr) {
        var b = rr[0], w = c1 - c0, h = r1 - r0, z = new Float32Array(w * h);
        for (var i = 0; i < z.length; i++) { var v = b[i]; z[i] = (v === v && v > -1000 && v < 10000) ? v : 0; }
        return { cell: cell, at: function (e, n) {
          var fc = (e - dem.x0) / cell - 0.5 - c0, fr = (dem.y0 - n) / cell - 0.5 - r0;
          if (fc < 0 || fr < 0 || fc > w - 1.001 || fr > h - 1.001) return null;
          var ci = fc | 0, ri = fr | 0, u = fc - ci, v2 = fr - ri, o = ri * w + ci;
          return (z[o] * (1 - u) + z[o + 1] * u) * (1 - v2) + (z[o + w] * (1 - u) + z[o + w + 1] * u) * v2;
        } };
      });
    });
  }

  function compute(ll) {
    var def = mgaDefs(55).mga94, P = proj4("EPSG:4326", def, [ll.lng, ll.lat]), E = P[0], N = P[1];
    var Q = proj4("EPSG:4326", def, [ll.lng, ll.lat + 0.01]), gamma = Math.atan2(Q[0] - E, Q[1] - N);   // true north, as a grid bearing
    status("Reading the terrain (" + Math.round(S.range / 1000) + " km around)...");
    return tools().then(function () { return openDEM(); }).then(function (dem) {
      var kFar = S.range > 50000 ? 6 : 5;
      return Promise.all([grid(dem, 3, E, N, NEAR_R + 200), grid(dem, kFar, E, N, S.range + 500), loadPeaks()]);
    }).then(function (g) {
      var near = g[0], far = g[1], peaks = g[2];
      if (!near || !far) throw new Error("this spot is outside the Tasmania elevation model");
      function z(e, n, d) { var v = d < NEAR_R ? near.at(e, n) : null; if (v === null) v = far.at(e, n); return v === null ? 0 : v; }
      var h0 = z(E, N, 0) + S.eye;
      status("Tracing the skyline...");
      function drop(d) { return d * d / (2 * R_EARTH) * (1 - K_REFR); }
      // samples along a ray: fine steps near, coarser far
      var dists = [];
      for (var d = near.cell; d < NEAR_R; d += near.cell) dists.push(d);
      for (d = NEAR_R; d <= S.range; d += far.cell) dists.push(d);
      var nRay = Math.round(360 / AZ_STEP), rays = new Array(nRay), top = -90, bottom = 90, skyMin = 90;
      for (var r = 0; r < nRay; r++) {
        var b = r * AZ_STEP * Math.PI / 180 + gamma, sx = Math.sin(b), cy = Math.cos(b), mx = -90, segs = [];
        for (var i = 0; i < dists.length; i++) {
          var dd = dists[i], a = Math.atan2(z(E + sx * dd, N + cy * dd, dd) - drop(dd) - h0, dd) * 180 / Math.PI;
          if (a > mx) { segs.push([mx, a, dd]); mx = a; }          // the first one fills down to the foot of the view
        }
        rays[r] = segs;
        if (mx > top) top = mx;
        if (mx < skyMin) skyMin = mx;
        if (segs.length && segs[0][1] < bottom) bottom = segs[0][1];
      }
      // peaks: visible if nothing nearer on their own ray stands higher
      var vis = [];
      peaks.forEach(function (p) {
        if (!p[0]) return;                      // unnamed lookouts: nothing to label
        var q = proj4("EPSG:4326", def, [p[2], p[1]]), dx = q[0] - E, dy = q[1] - N, dist = Math.hypot(dx, dy);
        if (dist < 150 || dist > S.range) return;
        var zp = z(q[0], q[1], dist); if (p[3] !== null && p[3] > zp) zp = Math.max(zp, Math.min(p[3], zp + 30));
        var ang = Math.atan2(zp - drop(dist) - h0, dist) * 180 / Math.PI, bx = dx / dist, by = dy / dist, mx2 = -90;
        // nearer ground hides it - but not the peak's own upper slopes (stop short by 10% or 300 m)
        for (var j = 0; j < dists.length && dists[j] < Math.min(dist * 0.9, dist - 300); j++) {
          var dj = dists[j], aj = Math.atan2(z(E + bx * dj, N + by * dj, dj) - drop(dj) - h0, dj) * 180 / Math.PI;
          if (aj > mx2) mx2 = aj;
        }
        if (ang < mx2 - 0.03) return;
        var az = ((Math.atan2(dx, dy) - gamma) * 180 / Math.PI + 720) % 360;
        vis.push({ name: p[0], ele: p[3] !== null ? p[3] : Math.round(zp), kind: p[4], az: az, ang: ang, dist: dist, lat: p[1], lon: p[2] });
      });
      return { E: E, N: N, gamma: gamma, h0: h0, rays: rays, top: top, bottom: bottom, skyMin: skyMin, peaks: vis, ll: ll, def: def };
    });
  }

  // ---- drawing ----------------------------------------------------------------------
  function shade(d) {           // near: dark green-grey; far: pale blue-grey
    var t = Math.min(1, Math.log(1 + d / 400) / Math.log(1 + S.range / 400));
    return [Math.round(52 + t * (200 - 52)), Math.round(84 + t * (214 - 84)), Math.round(64 + t * (228 - 64))];
  }
  function draw(res) {
    var wrap = 30, W = (360 + 2 * wrap) * PX, aTop = Math.ceil(res.top + 3), aBot = Math.floor(Math.max(-8, Math.min(res.skyMin - 3, -1)));   // a little below the lowest skyline
    var LABEL = 120, H = Math.round((aTop - aBot) * PX) + LABEL + 22;
    var cv = document.getElementById("hzcanvas"); cv.width = W; cv.height = H; cv.style.width = W + "px"; cv.style.height = H + "px";
    var g = cv.getContext("2d"), y = function (a) { return LABEL + (aTop - a) * PX; };
    var sky = g.createLinearGradient(0, LABEL, 0, y(aBot)); sky.addColorStop(0, "#cfe3f5"); sky.addColorStop(1, "#f4f8fb");
    g.fillStyle = "#fff"; g.fillRect(0, 0, W, H); g.fillStyle = sky; g.fillRect(0, LABEL, W, y(aBot) - LABEL);
    var img = g.getImageData(0, 0, W, H), px = img.data, nRay = res.rays.length;
    for (var x = 0; x < W; x++) {
      var az = ((x / PX - wrap) % 360 + 360) % 360, segs = res.rays[Math.round(az / AZ_STEP) % nRay];
      for (var s = 0; s < segs.length; s++) {
        var sg = segs[s], c = shade(sg[2]), y0 = Math.max(LABEL, Math.round(y(sg[1]))), y1 = Math.min(H - 22, Math.round(y(sg[0])));
        var edge = s === segs.length - 1 || segs[s + 1][2] > sg[2] * 1.25 + 300;    // a ridge: the land behind is much further
        for (var yy = y0; yy <= y1; yy++) {
          var o = 4 * (yy * W + x), dark = edge && yy <= y0 + 1 ? 0.45 : 1;
          px[o] = c[0] * dark; px[o + 1] = c[1] * dark; px[o + 2] = c[2] * dark; px[o + 3] = 255;
        }
      }
    }
    g.putImageData(img, 0, 0);
    // compass and degree ticks
    g.fillStyle = "#333"; g.font = "600 12px system-ui, sans-serif"; g.textAlign = "center";
    var NAMES = { 0: "N", 45: "NE", 90: "E", 135: "SE", 180: "S", 225: "SW", 270: "W", 315: "NW" };
    for (var deg = -wrap; deg <= 360 + wrap; deg += 5) {
      var xx = (deg + wrap) * PX, dn = ((deg % 360) + 360) % 360;
      g.fillRect(xx, H - 22, 1, dn % 45 === 0 ? 8 : 4);
      if (dn % 15 === 0) g.fillText(NAMES[dn] || String(dn), xx, H - 4);
    }
    // horizontal reference: eye level
    g.strokeStyle = "rgba(0,0,0,0.25)"; g.setLineDash([4, 4]); g.beginPath(); g.moveTo(0, y(0)); g.lineTo(W, y(0)); g.stroke(); g.setLineDash([]);
    // peak labels, staggered so they don't overlap
    var rows = [], hits = [];
    res.peaks.sort(function (a, b) { return b.ang - a.ang; }).forEach(function (p) {
      [p.az - 360, p.az, p.az + 360].forEach(function (azx) {
        var xx2 = (azx + wrap) * PX; if (xx2 < 0 || xx2 > W) return;
        var txt = p.name + " " + p.ele + " m", tw = g.measureText(txt).width + 8, row = 0;
        while (row < 7 && (rows[row] || []).some(function (r) { return xx2 + tw > r[0] && xx2 < r[1]; })) row++;
        if (row >= 7) return;
        (rows[row] = rows[row] || []).push([xx2 - 2, xx2 + tw]);
        var ly = 14 + row * 15, py = y(p.ang);
        g.strokeStyle = p.kind === "peak" || p.kind === "volcano" ? "#6d4c41" : "#546e7a"; g.lineWidth = 1;
        g.beginPath(); g.moveTo(xx2, ly + 3); g.lineTo(xx2, py); g.stroke();
        g.fillStyle = "#3e2723"; g.textAlign = "left"; g.font = "600 11px system-ui, sans-serif"; g.fillText(txt, xx2 + 3, ly);
        g.fillStyle = "#c62828"; g.beginPath(); g.arc(xx2, py, 2.5, 0, 7); g.fill();
        hits.push({ x0: xx2 - 4, x1: xx2 + tw, y0: ly - 11, y1: py + 4, p: p });
      });
    });
    res.hits = hits; res.wrap = wrap; res.aTop = aTop; res.LABEL = LABEL; res.H = H;
  }

  // ---- interaction -------------------------------------------------------------------
  function showOnMap(lat, lon, text) {
    mapLayer.clearLayers();
    var o = last.ll;
    mapLayer.addLayer(L.polyline([o, [lat, lon]], { color: "#c62828", weight: 2.5, dashArray: "6 5", interactive: false }));
    mapLayer.addLayer(L.circleMarker([lat, lon], { radius: 6, color: "#fff", weight: 2, fillColor: "#c62828", fillOpacity: 1 }).bindTooltip(text, { permanent: true, direction: "top" }));
    map.fitBounds(L.latLngBounds([o, [lat, lon]]).pad(0.15), { maxZoom: 15 });
  }
  function onTap(ev) {
    if (!last || !last.hits) return;
    var cv = document.getElementById("hzcanvas"), rc = cv.getBoundingClientRect(), x = ev.clientX - rc.left, yv = ev.clientY - rc.top;
    var h = last.hits.filter(function (k) { return x >= k.x0 && x <= k.x1 && yv >= k.y0 && yv <= k.y1; })[0];
    var info = document.getElementById("hzinfo");
    if (h) {
      var p = h.p;
      info.textContent = p.name + " (" + (p.kind === "hill" ? "hill" : p.kind === "peak" || p.kind === "volcano" ? "peak" : p.kind === "viewpoint" ? "lookout" : p.kind.replace(/_/g, " ")) + "), " + p.ele +
        " m, " + fmtDist(p.dist) + " away, bearing " + Math.round(p.az) + " deg.";
      info.dataset.lat = p.lat; info.dataset.lon = p.lon; info.dataset.txt = p.name;
      document.getElementById("hzmap").style.display = "";
      return;
    }
    // the land under the tap: which layer of which ray
    var az = ((x / PX - last.wrap) % 360 + 360) % 360, ang = last.aTop - (yv - last.LABEL) / PX;
    var segs = last.rays[Math.round(az / AZ_STEP) % last.rays.length], sg = segs.filter(function (s) { return ang >= s[0] && ang <= s[1]; })[0];
    if (!sg) { info.textContent = "Sky - bearing " + Math.round(az) + " deg."; document.getElementById("hzmap").style.display = "none"; return; }
    var b = az * Math.PI / 180 + last.gamma, e = last.E + Math.sin(b) * sg[2], n = last.N + Math.cos(b) * sg[2], g = proj4(last.def, "EPSG:4326", [e, n]);
    info.textContent = "Land about " + fmtDist(sg[2]) + " away, bearing " + Math.round(az) + " deg.";
    info.dataset.lat = g[1]; info.dataset.lon = g[0]; info.dataset.txt = fmtDist(sg[2]) + " away";
    document.getElementById("hzmap").style.display = "";
  }
  function scrollTo(az) {
    var box = document.getElementById("hzscroll"); if (!box || !last) return;
    box.scrollLeft = (az + last.wrap) * PX - box.clientWidth / 2;
  }
  function onOrient(e) {
    if (!follow) return;
    var h = e.webkitCompassHeading !== undefined ? e.webkitCompassHeading : (e.absolute && e.alpha !== null ? (360 - e.alpha) % 360 : null);
    if (h !== null) scrollTo(h);
  }
  function toggleFollow() {
    follow = !follow; document.getElementById("hzfollow").classList.toggle("on", follow);
    if (!follow) return;
    var ask = window.DeviceOrientationEvent && DeviceOrientationEvent.requestPermission;   // iPhone asks first
    (ask ? DeviceOrientationEvent.requestPermission() : Promise.resolve("granted")).then(function (s) {
      if (s !== "granted") { follow = false; document.getElementById("hzfollow").classList.remove("on"); toast("Compass not allowed"); return; }
      window.addEventListener("deviceorientationabsolute", onOrient); window.addEventListener("deviceorientation", onOrient);
    }).catch(function () { follow = false; document.getElementById("hzfollow").classList.remove("on"); });
  }

  function run(ll) {
    mapLayer.clearLayers();
    document.getElementById("hzinfo").textContent = ""; document.getElementById("hzmap").style.display = "none";
    compute(ll).then(function (res) {
      last = res; draw(res);
      var n = res.peaks.length;
      status("From " + ll.lat.toFixed(4) + ", " + ll.lng.toFixed(4) + " (" + Math.round(res.h0 - S.eye) + " m, eye +" + S.eye + " m): " +
        n + " named peak" + (n === 1 ? "" : "s") + " in view out to " + Math.round(S.range / 1000) + " km. Swipe sideways; tap a name or the land.");
      scrollTo(0);
    }).catch(function (e) { status("Panorama failed: " + e.message); });
  }
  window.openHorizon = function () {
    if (typeof setMenu === "function") setMenu(null);
    if (!sheet) {
      sheet = document.createElement("div"); sheet.id = "hzsheet"; sheet.className = "sheet";
      function segs(id, opts) { return "<div class='seg' id='" + id + "'>" + opts.map(function (o) { return "<button type='button' data-v='" + o[0] + "'>" + o[1] + "</button>"; }).join("") + "</div>"; }
      sheet.innerHTML = "<h2><span>What am I looking at?</span><button id='hzclose' aria-label='Close'>x</button></h2>" +
        "<div id='hzstat' class='small'></div>" +
        "<div id='hzscroll' style='overflow:auto;max-height:46vh;margin:4px 0;border:1px solid #ddd;border-radius:6px'><canvas id='hzcanvas' width='10' height='10'></canvas></div>" +
        "<div id='hzinfo' class='small'></div><button id='hzmap' type='button' style='display:none;font-size:12px'>Show on map</button>" +
        "<div class='seg'><button type='button' id='hzhere'>From the pin</button><button type='button' id='hzme'>From my location</button>" +
        "<button type='button' id='hzfollow'>Follow compass</button></div>" +
        "<div class='small'>Eye height</div>" + segs("hzeye", [["1.7", "1.7 m"], ["10", "10 m"], ["30", "30 m"]]) +
        "<div class='small'>Range</div>" + segs("hzrange", [["40000", "40 km"], ["80000", "80 km"]]) +
        "<p class='small' style='color:#666'>From the Tasmania 2 m elevation model (16 m detail to 5 km, coarser beyond; first view reads " +
        "a few MB). Earth curvature and normal refraction included. Peak names from OpenStreetMap. Trees and buildings are not in the " +
        "model, so close by the view is often more open than reality.</p>";
      document.body.appendChild(sheet); L.DomEvent.disableClickPropagation(sheet); L.DomEvent.disableScrollPropagation(sheet);
      sheet.querySelector("#hzclose").onclick = function () { sheet.style.display = "none"; mapLayer.clearLayers(); follow = false; };
      sheet.querySelector("#hzcanvas").addEventListener("click", onTap);
      sheet.querySelector("#hzmap").onclick = function () { var i = document.getElementById("hzinfo").dataset; showOnMap(+i.lat, +i.lon, i.txt); };
      sheet.querySelector("#hzhere").onclick = function () { run(pin ? pin.getLatLng() : map.getCenter()); };
      sheet.querySelector("#hzme").onclick = function () {
        if (lastFix && watchId !== null) return run(lastFix);
        status("Finding your location...");
        navigator.geolocation.getCurrentPosition(function (p) { run(L.latLng(p.coords.latitude, p.coords.longitude)); },
          function (e) { status("Location unavailable: " + e.message); }, { enableHighAccuracy: true, timeout: 20000 });
      };
      sheet.querySelector("#hzfollow").onclick = toggleFollow;
      [["hzeye", "eye"], ["hzrange", "range"]].forEach(function (x) {
        sheet.querySelector("#" + x[0]).onclick = function (e) { var v = e.target.getAttribute("data-v"); if (!v) return; S[x[1]] = +v; sync(); if (last) run(last.ll); };
      });
    }
    sync(); sheet.style.display = "block";
    run(pin ? pin.getLatLng() : map.getCenter());
  };
  function sync() {
    [["hzeye", S.eye], ["hzrange", S.range]].forEach(function (x) {
      [].forEach.call(sheet.querySelectorAll("#" + x[0] + " button"), function (b) { b.classList.toggle("on", +b.getAttribute("data-v") === x[1]); });
    });
  }
  document.getElementById("horizon").onclick = window.openHorizon;
  window.lunamapHorizon = function () { return last; };      // for testing
})();
