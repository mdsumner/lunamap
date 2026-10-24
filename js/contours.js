// lunamap - contours.js: contour lines drawn on the phone from the Tasmania 2 m DEM, at any
// interval, with the rules set in the Contours sheet:
//   interval     auto (by zoom) or fixed 1, 2, 5, 10, 20, 25, 50, 100 m
//   index        every Nth line bold and labelled (or none)
//   colour       brown, black, blue, white (for aerial photos), red
//   highlight    particular heights drawn thick red and always labelled, e.g. "300, 550"
//   shade        tint the ground between two heights, e.g. 400 to 600 m
//   labels       on or off
// Each 256 px map tile samples the DEM on a 129 x 129 grid (shared edges, so lines join across
// tiles) and runs marching squares. Settings are kept on this device. Tasmania only (the DEM),
// from zoom 11. Heights are metres above sea level (AHD).
// ---------------------------------------------------------------------------
(function () {
  var KEY = "lunamap-contours", GEOTIFF = "https://cdn.jsdelivr.net/npm/geotiff@3.0.5/dist-browser/geotiff.js";
  var COLOURS = { brown: "#8d5524", black: "#222222", blue: "#1565c0", white: "#ffffff", red: "#c62828" };
  var AUTO = { 11: 100, 12: 50, 13: 20, 14: 10, 15: 10, 16: 5, 17: 2, 18: 1, 19: 1 };
  var S = { interval: "auto", index: 5, colour: "brown", labels: true, highlight: "", shadeLo: "", shadeHi: "" };
  try { var saved = JSON.parse(localStorage.getItem(KEY) || "null"); if (saved) Object.keys(S).forEach(function (k) { if (saved[k] !== undefined) S[k] = saved[k]; }); } catch (e) {}
  function store() { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) {} }
  var N = 128, on = false, ready = null, layer = null;

  function interval(z) { return S.interval === "auto" ? (AUTO[Math.max(11, Math.min(19, z))] || 10) : +S.interval; }
  function highlights() { return String(S.highlight || "").split(/[ ,;]+/).filter(function (t) { return t !== ""; }).map(Number).filter(function (v) { return v === v; }); }
  // geotiff.js and profile.js (which reads the DEM); waits until tileHeights is really there, since
  // another module may have added the script tag without it having run yet
  function tools() {
    if (!ready) ready = loadScript(GEOTIFF).then(function () { return loadScript("js/profile.js"); }).then(function () {
      // an older copy of profile.js (browser cache) has no tileHeights: load a fresh one
      if (!(window.lunamapProfile && window.lunamapProfile.tileHeights)) return loadScript("js/profile.js?v=" + Date.now());
    }).then(function () {
      return new Promise(function (ok, fail) {
        var t0 = Date.now();
        (function wait() {
          if (window.lunamapProfile && window.lunamapProfile.tileHeights) return ok();
          if (Date.now() - t0 > 15000) return fail(new Error("elevation reader did not load"));
          setTimeout(wait, 50);
        })();
      });
    }).catch(function (e) { ready = null; throw e; });
    return ready;
  }
  // DEM reads, a few at a time, each retried twice; tiles that still fail are counted in the status box
  var active = 0, queue = [], failed = 0, MAXQ = 4, memo = {}, memoKeys = [];
  function heights(c) {
    var key = c.z + "/" + c.x + "/" + c.y;
    if (memo[key] !== undefined) return Promise.resolve(memo[key]);   // already read: settings changes redraw without re-reading
    return new Promise(function (ok, fail) {
      queue.push({ c: c, key: key, ok: function (t) {
        memo[key] = t; memoKeys.push(key); if (memoKeys.length > 300) delete memo[memoKeys.shift()]; ok(t); }, fail: fail, tries: 0 });
      setTimeout(pump, 0);       // after Leaflet has registered the tile, so wanted() can see it
    });
  }
  function wanted(c) { return layer && map.hasLayer(layer) && !!layer._tiles[layer._tileCoordsToKey(c)]; }
  function pump() {
    while (active < MAXQ && queue.length) (function (job) {
      if (!wanted(job.c)) { job.fail(new Error("not needed")); return; }   // panned away before its turn
      active++;
      tools().then(function () { return window.lunamapProfile.tileHeights(job.c.z, job.c.x, job.c.y, N); })
        .then(function (t) { active--; job.ok(t); pump(); }, function (e) {
          active--;
          if (++job.tries <= 2) setTimeout(function () { queue.push(job); pump(); }, 800 * job.tries);
          else { failed++; status(); job.fail(e); }
          pump();
        });
    })(queue.shift());
  }

  // marching squares on the (N+1)^2 grid for one level -> polylines in grid units
  function trace(h, n, L) {
    var N1 = n + 1, segs = [];
    for (var j = 0; j < n; j++) for (var i = 0; i < n; i++) {
      var a = h[j * N1 + i], b = h[j * N1 + i + 1], c = h[(j + 1) * N1 + i + 1], d = h[(j + 1) * N1 + i];
      if (!(a === a && b === b && c === c && d === d)) continue;
      var idx = (a >= L ? 8 : 0) | (b >= L ? 4 : 0) | (c >= L ? 2 : 0) | (d >= L ? 1 : 0);
      if (idx === 0 || idx === 15) continue;
      var top = [i + (L - a) / (b - a), j], right = [i + 1, j + (L - b) / (c - b)],
          bottom = [i + (L - d) / (c - d), j + 1], left = [i, j + (L - a) / (d - a)];
      switch (idx) {
        case 1: case 14: segs.push([left, bottom]); break;
        case 2: case 13: segs.push([bottom, right]); break;
        case 3: case 12: segs.push([left, right]); break;
        case 4: case 11: segs.push([top, right]); break;
        case 6: case 9: segs.push([top, bottom]); break;
        case 7: case 8: segs.push([left, top]); break;
        case 5: case 10:
          var mid = (a + b + c + d) / 4;
          if ((idx === 5) === (mid >= L)) { segs.push([left, top]); segs.push([bottom, right]); }
          else { segs.push([top, right]); segs.push([left, bottom]); }
      }
    }
    // join segments into lines
    function k(p) { return Math.round(p[0] * 1000) + "," + Math.round(p[1] * 1000); }
    var ends = {}, used = new Uint8Array(segs.length);
    segs.forEach(function (s, si) { [k(s[0]), k(s[1])].forEach(function (kk) { (ends[kk] = ends[kk] || []).push(si); }); });
    var lines = [];
    for (var s0 = 0; s0 < segs.length; s0++) {
      if (used[s0]) continue; used[s0] = 1;
      var line = [segs[s0][0], segs[s0][1]];
      [true, false].forEach(function (fwd) {
        for (;;) {
          var tip = fwd ? line[line.length - 1] : line[0], cand = (ends[k(tip)] || []).filter(function (x) { return !used[x]; })[0];
          if (cand === undefined) break;
          used[cand] = 1;
          var sg = segs[cand], nxt = k(sg[0]) === k(tip) ? sg[1] : sg[0];
          if (fwd) line.push(nxt); else line.unshift(nxt);
        }
      });
      lines.push(line);
    }
    return lines;
  }

  var ContourLayer = L.GridLayer.extend({
    createTile: function (c, done) {
      var cv = document.createElement("canvas"), sz = this.getTileSize(), r = window.devicePixelRatio > 1 ? 2 : 1;
      cv.width = sz.x * r; cv.height = sz.y * r; cv.style.width = sz.x + "px"; cv.style.height = sz.y + "px";
      heights(c).then(function (t) {
        if (t) draw(cv.getContext("2d"), t, c.z, sz.x, r);
        done(null, cv);
      }).catch(function (e) { done(e, cv); });
      return cv;
    }
  });

  function draw(g, t, z, size, r) {
    var h = t.h, n = t.n, sc = size / n, step = interval(z), col = COLOURS[S.colour] || COLOURS.brown;
    g.scale(r, r);
    // shade a band of heights
    var lo = parseFloat(S.shadeLo), hi = parseFloat(S.shadeHi);
    if (lo === lo || hi === hi) {
      if (!(lo === lo)) lo = -1e9; if (!(hi === hi)) hi = 1e9;
      g.fillStyle = "rgba(255,111,0,0.22)";
      for (var j = 0; j < n; j++) for (var i = 0; i < n; i++) {
        var v = h[j * (n + 1) + i] + h[(j + 1) * (n + 1) + i + 1];
        v = v / 2; if (v >= lo && v <= hi) g.fillRect(i * sc, j * sc, sc + 0.5, sc + 0.5);
      }
    }
    var min = Infinity, max = -Infinity;
    for (var q = 0; q < h.length; q++) { var hv = h[q]; if (hv === hv) { if (hv < min) min = hv; if (hv > max) max = hv; } }
    if (!(min < max)) return;
    var levels = [];
    for (var L0 = Math.ceil(min / step) * step; L0 <= max; L0 += step) levels.push({ v: L0, kind: S.index > 0 && Math.round(L0 / step) % S.index === 0 ? "index" : "plain" });
    highlights().forEach(function (v) { if (v >= min && v <= max) levels.push({ v: v, kind: "hi" }); });
    if (levels.length > 400) levels = levels.filter(function (l) { return l.kind !== "plain"; });   // too steep for this interval
    var labels = [];
    levels.forEach(function (lv) {
      if (lv.v <= 0) return;                                  // sea level and below: the DEM has no sea floor
      var lines = trace(h, n, lv.v + (lv.v === Math.round(lv.v) ? 1e-4 : 0));
      g.beginPath();
      lines.forEach(function (ln) { ln.forEach(function (p, i) { if (i) g.lineTo(p[0] * sc, p[1] * sc); else g.moveTo(p[0] * sc, p[1] * sc); }); });
      g.strokeStyle = lv.kind === "hi" ? "#c62828" : col;
      g.lineWidth = lv.kind === "hi" ? 2.6 : lv.kind === "index" ? 1.6 : 0.8;
      g.globalAlpha = lv.kind === "plain" ? 0.75 : 0.95;
      g.stroke(); g.globalAlpha = 1;
      if (S.labels && lv.kind !== "plain") lines.forEach(function (ln) { labels.push({ ln: ln, v: lv.v, hi: lv.kind === "hi" }); });
    });
    // labels along the line, upright, not too close to the tile edge or each other
    var placed = [];
    g.font = "600 10px system-ui, sans-serif"; g.textAlign = "center"; g.textBaseline = "middle";
    labels.forEach(function (lb) {
      var pts = lb.ln.map(function (p) { return [p[0] * sc, p[1] * sc]; }), len = 0;
      for (var i = 1; i < pts.length; i++) len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
      if (len < 70) return;
      var target = len / 2, acc = 0;
      for (i = 1; i < pts.length; i++) {
        var dl = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
        if (acc + dl >= target) break; acc += dl;
      }
      i = Math.min(i, pts.length - 1);
      var a = pts[Math.max(0, i - 3)], b = pts[Math.min(pts.length - 1, i + 3)], m = pts[i];
      if (m[0] < 18 || m[1] < 10 || m[0] > size - 18 || m[1] > size - 10) return;
      if (placed.some(function (p) { return Math.hypot(p[0] - m[0], p[1] - m[1]) < 45; })) return;
      placed.push(m);
      var ang = Math.atan2(b[1] - a[1], b[0] - a[0]); if (ang > Math.PI / 2) ang -= Math.PI; if (ang < -Math.PI / 2) ang += Math.PI;
      var txt = String(Math.round(lb.v * 10) / 10);
      g.save(); g.translate(m[0], m[1]); g.rotate(ang);
      g.lineWidth = 3; g.strokeStyle = S.colour === "white" ? "rgba(0,0,0,0.7)" : "rgba(255,255,255,0.9)"; g.strokeText(txt, 0, 0);
      g.fillStyle = lb.hi ? "#c62828" : (S.colour === "white" ? "#fff" : col); g.fillText(txt, 0, 0);
      g.restore();
    });
  }

  // ---- toggle, status control, settings sheet ------------------------------------------
  var ctl = L.control({ position: "topright" });
  ctl.onAdd = function () {
    var d = L.DomUtil.create("div", "rtlegend ctstat");
    d.innerHTML = "<a href='#' id='ctset' title='Contour settings'></a>";
    L.DomEvent.disableClickPropagation(d);
    d.querySelector("#ctset").onclick = function (e) { e.preventDefault(); if (failed) { failed = 0; rebuild(); return; } openSheet(); };
    return d;
  };
  function status() {
    var el = document.getElementById("ctset"); if (!el) return;
    var z = map.getZoom();
    el.textContent = z < 11 ? "Contours: zoom in (from zoom 11)" : "Contours " + interval(z) + " m" + (S.interval === "auto" ? " (auto)" : "") +
      (highlights().length ? ", highlight " + highlights().join(", ") : "") + (failed ? ", " + failed + " tiles failed (tap to retry)" : "") + " - settings";
  }
  map.on("zoomend", status);
  function rebuild() { if (layer) layer.redraw(); status(); }

  function setContours(v) {
    on = v; document.getElementById("contours").classList.toggle("on", on);
    if (on) {
      if (!layer) layer = new ContourLayer({ minZoom: 11, maxZoom: 19, zIndex: 4, keepBuffer: 1,
        attribution: "Contours from the Tasmania 2 m DEM, Mineral Resources Tasmania / theLIST (CC BY 3.0 AU)" });
      layer.addTo(map); ctl.addTo(map); status();
    } else { if (layer) map.removeLayer(layer); ctl.remove(); }
    writeHash();
  }
  window.setContours = setContours;
  window.contourFlag = function () { return on ? ",ct" : ""; };
  document.getElementById("contours").onclick = function () { setContours(!on); };

  var sheet = null;
  function openSheet() {
    if (!sheet) {
      sheet = document.createElement("div"); sheet.id = "ctsheet"; sheet.className = "sheet";
      function segs(id, opts) { return "<div class='seg' id='" + id + "'>" + opts.map(function (o) { return "<button type='button' data-v='" + o[0] + "'>" + o[1] + "</button>"; }).join("") + "</div>"; }
      sheet.innerHTML = "<h2><span>Contours</span><button id='ctclose' aria-label='Close'>x</button></h2>" +
        "<div class='small'>Interval</div>" + segs("ctint", [["auto", "Auto"], ["1", "1 m"], ["2", "2"], ["5", "5"], ["10", "10"], ["20", "20"], ["25", "25"], ["50", "50"], ["100", "100"]]) +
        "<div class='small'>Bold and labelled every</div>" + segs("ctidx", [["0", "None"], ["2", "2nd"], ["4", "4th"], ["5", "5th"], ["10", "10th"]]) +
        "<div class='small'>Colour</div>" + segs("ctcol", [["brown", "Brown"], ["black", "Black"], ["blue", "Blue"], ["white", "White"], ["red", "Red"]]) +
        "<div class='small'>Highlight heights (m), red and always labelled</div><input id='cthi' placeholder='e.g. 300, 550' style='width:100%'>" +
        "<div class='small' style='margin-top:6px'>Shade ground between <input id='ctlo' inputmode='decimal' style='width:5em'> and <input id='cthb' inputmode='decimal' style='width:5em'> m</div>" +
        "<label style='display:block;margin-top:6px'><input type='checkbox' id='ctlab'> Labels</label>" +
        "<p class='small' style='color:#666'>Drawn from the Tasmania 2 m elevation model (heights above sea level, AHD), Tasmania only, from zoom 11. " +
        "Auto interval: 100 m zoomed out down to 1 m at street level. Settings are kept on this device.</p>";
      document.body.appendChild(sheet); L.DomEvent.disableClickPropagation(sheet);
      sheet.querySelector("#ctclose").onclick = function () { sheet.style.display = "none"; };
      [["ctint", "interval"], ["ctidx", "index"], ["ctcol", "colour"]].forEach(function (x) {
        sheet.querySelector("#" + x[0]).onclick = function (e) {
          var v = e.target.getAttribute("data-v"); if (v === null) return;
          S[x[1]] = x[1] === "index" ? +v : v; store(); sync(); rebuild();
        };
      });
      var tm = null;
      function later() { clearTimeout(tm); tm = setTimeout(function () { store(); rebuild(); }, 500); }
      sheet.querySelector("#cthi").oninput = function (e) { S.highlight = e.target.value; later(); };
      sheet.querySelector("#ctlo").oninput = function (e) { S.shadeLo = e.target.value; later(); };
      sheet.querySelector("#cthb").oninput = function (e) { S.shadeHi = e.target.value; later(); };
      sheet.querySelector("#ctlab").onchange = function (e) { S.labels = e.target.checked; store(); rebuild(); };
    }
    sync(); sheet.style.display = "block";
  }
  function sync() {
    function seg(id, v) { [].forEach.call(sheet.querySelectorAll("#" + id + " button"), function (b) { b.classList.toggle("on", b.getAttribute("data-v") === String(v)); }); }
    seg("ctint", S.interval); seg("ctidx", S.index); seg("ctcol", S.colour);
    sheet.querySelector("#cthi").value = S.highlight; sheet.querySelector("#ctlo").value = S.shadeLo;
    sheet.querySelector("#cthb").value = S.shadeHi; sheet.querySelector("#ctlab").checked = !!S.labels;
  }
  window.openContourSettings = openSheet;
})();
