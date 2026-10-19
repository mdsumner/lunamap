// lunamap - aerials.js (Explore): historical aerial photos from the NRE / theLIST frame
// index (Public/Indexes, one layer per decade, 1930s-2010s). Lists the frames covering the
// pin (or the middle of the map), and lays a chosen frame's thumbnail over the map with a
// flat affine guess:
//   centre   = centre of the frame's index footprint (the server gives it in lon/lat)
//   size     = the footprint's side (film format x scale)
//   rotation = heading between the neighbouring frames on the same run, snapped so the
//              picture starts as near north-up as the run allows
// Tilt and relief are not corrected, and which way is "up" on the film is not in the
// index, so the panel has rotate 90 / flip / opacity buttons.
// ---------------------------------------------------------------------------
(function () {
  var IDX = LISTPUB + "Indexes/MapServer/";
  var DECADES = [[67, "1930s"], [68, "1940s"], [69, "1950s"], [70, "1960s"], [72, "1970s"], [82, "1980s"], [22, "1990s"], [32, "2000s"], [51, "2010s"]];
  var FIELDS = "OBJECTID,IMAGE_NAME,FILM_NO,RUN_NO,FRAME,FLY_DATE,FLY_SEASON,SCALE,PROJ_NAME,IMAGE_TYPE,DOWNLOAD_LINK,THUMBNAIL_LINK";
  var sheet = null, overlay = null, cur = null, badge = null, outline = null, extras = [], curLayer = null;
  // orientation shared by every frame on the map: s = the quarter-turn offset from the flight line that starts the
  // chosen frame nearest north-up (the camera is fixed in the aircraft, so it holds for the whole film); turns and
  // flip = the hand corrections
  var orient = { s: 0, hd: 0, turns: 0, flip: false };
  function redrawAll() { if (overlay) overlay.redraw(); extras.forEach(function (o) { o.redraw(); }); }
  // on-map reminder whenever an old frame is showing: it is a raw photo fitted roughly,
  // unlike the Aerial photo basemap (theLIST orthophoto, properly rectified)
  function showBadge(a, more) {
    if (!badge) {
      badge = L.control({ position: "topright" });
      badge.onAdd = function () { var d = L.DomUtil.create("div", "airbadge"); L.DomEvent.disableClickPropagation(d); return d; };
      badge.addTo(map);
    }
    badge.getContainer().innerHTML = "<b>" + esc(when(a)) + " photo</b> - rough fit, not orthorectified" +
      "<br><span>Raw frame " + esc(a.FILM_NO) + "/" + esc(a.FRAME) + (more ? " + " + more + " more from the same film" : "") +
      "; dashed box = index footprint</span>";
  }
  function hideBadge() { if (badge) { map.removeControl(badge); badge = null; } if (outline) { map.removeLayer(outline); outline = null; } }


  function q(layer, params) {
    var s = Object.keys(params).map(function (k) { return k + "=" + encodeURIComponent(params[k]); }).join("&");
    return fetch(IDX + layer + "/query?" + s).then(function (r) { return r.json(); }).then(function (j) {
      if (j.error) throw new Error(j.error.message || "query failed"); return j.features || [];
    });
  }
  function when(a) {
    if (a.FLY_DATE) { var d = new Date(a.FLY_DATE); return d.toLocaleDateString("en-AU", { month: "short", year: "numeric", timeZone: "UTC" }); }
    return a.FLY_SEASON || "";
  }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return "&#" + c.charCodeAt(0) + ";"; }); }

  function ensureSheet() {
    if (sheet) return sheet;
    sheet = document.createElement("div"); sheet.id = "airsheet"; sheet.className = "sheet";
    sheet.innerHTML = "<h2><span>Old aerial photos</span><button id='airclose' aria-label='Close'>x</button></h2>" +
      "<div id='aircur' class='small'></div><div id='airctl' class='acts' style='display:none'>" +
      "<button id='airrot' type='button' title='Turn the photo a quarter turn'>Rotate 90</button>" +
      "<button id='airflip' type='button' title='Mirror the photo'>Flip</button>" +
      "<label class='small'>Opacity <input id='airop' type='range' min='0.2' max='1' step='0.05' value='0.85'></label>" +
      "<button id='airreset' type='button' title='Back to the original guess (undo rotate and flip)'>Reset</button>" +
      "<button id='airfill' type='button' title='Add the other frames from the same film that fall in the view'>Fill view</button>" +
      "<button id='airoff' type='button'>Remove</button>" +
      "<button id='airgeo' type='button' title='Download this placement (corner coordinates) to load the photo in R, Python or QGIS'>Georef (JSON)</button></div>" +
      "<div id='airlist' class='small'></div>" +
      "<p class='small' style='color:#666'>Photos and index: Department of Natural Resources and Environment Tasmania, via theLIST. " +
      "These are raw frames from the film library, placed by a rough flat fit from the index - not orthorectified, so hills " +
      "and tilt shift things by tens of metres or more. The <b>Aerial photo</b> basemap is different: theLIST's orthophoto, " +
      "corrected to the ground.</p>";
    document.body.appendChild(sheet);
    sheet.querySelector("#airclose").onclick = function () { sheet.style.display = "none"; };
    sheet.querySelector("#airrot").onclick = function () { orient.turns = (orient.turns + 1) % 4; redrawAll(); };
    sheet.querySelector("#airflip").onclick = function () { orient.flip = !orient.flip; redrawAll(); };
    sheet.querySelector("#airreset").onclick = function () { orient.turns = 0; orient.flip = false; redrawAll(); };
    sheet.querySelector("#airfill").onclick = function () { if (overlay && cur) fillView(); };
    sheet.querySelector("#airop").oninput = function (e) { if (overlay) overlay.setOpacity(+e.target.value); extras.forEach(function (o) { o.setOpacity(+e.target.value); }); };
    sheet.querySelector("#airoff").onclick = function () { removeOverlay(); };
    sheet.querySelector("#airgeo").onclick = function () { if (overlay && cur) downloadGeoref(cur); };
    return sheet;
  }
  function removeOverlay() {
    if (overlay) { map.removeLayer(overlay); overlay = null; }
    clearExtras();
    hideBadge();
    cur = null; sheet.querySelector("#airctl").style.display = "none"; sheet.querySelector("#aircur").textContent = "";
  }

  // ---- the overlay: an <img> placed with a CSS affine matrix from three ground corners
  var AffineImage = L.Layer.extend({
    initialize: function (url, centre, axisU, half) { this.url = url; this.c = centre; this.u = axisU; this.half = half; this.op = 0.85; },
    onAdd: function (m) {
      this.img = L.DomUtil.create("img", "leaflet-zoom-hide airimg");
      this.img.src = this.url; this.img.style.opacity = this.op;
      var self = this; this.img.onload = function () { self.redraw(); };
      this.img.onerror = function () { toast("The photo thumbnail did not load"); };
      m.getPanes().overlayPane.appendChild(this.img);
      m.on("zoomend viewreset moveend", this.redraw, this);
      this.redraw();
    },
    onRemove: function (m) { m.off("zoomend viewreset moveend", this.redraw, this); L.DomUtil.remove(this.img); },
    setOpacity: function (o) { this.op = o; if (this.img) this.img.style.opacity = o; },
    corner: function (a, b) {                          // ground point at (a, b) half-widths along u and v
      var u = this.u, v = [-u[1], u[0]];
      return L.latLng(this.c[1] + (a * u[1] + b * v[1]) * this.half[1], this.c[0] + (a * u[0] + b * v[0]) * this.half[0]);
    },
    // ground positions of the picture's own corners: top-left, top-right, bottom-right, bottom-left
    imageCorners: function () {
      var t = orient.turns, f = orient.flip;
      var rot = function (p) { var x = f ? -p[0] : p[0], y = p[1]; for (var i = 0; i < t; i++) { var nx = y, ny = -x; x = nx; y = ny; } return [x, y]; };
      return [[-1, 1], [1, 1], [1, -1], [-1, -1]].map(function (p) { var r = rot(p); return this.corner(r[0], r[1]); }, this);
    },
    redraw: function () {
      if (!this._map || !this.img || !this.img.naturalWidth) return;
      var C = this.imageCorners();
      var P = [C[0], C[1], C[3]].map(function (ll) { return this._map.latLngToLayerPoint(ll); }, this);
      var w = this.img.naturalWidth, h = this.img.naturalHeight;
      var a = (P[1].x - P[0].x) / w, b = (P[1].y - P[0].y) / w, c = (P[2].x - P[0].x) / h, d = (P[2].y - P[0].y) / h;
      this.img.style.transformOrigin = "0 0";
      this.img.style.transform = "matrix(" + [a, b, c, d, P[0].x, P[0].y].map(function (v) { return v.toFixed(6); }).join(",") + ")";
    }
  });

  // the placement as JSON: picture corners in GDA2020 / MGA (and lon/lat), for R, Python or QGIS
  // (see docs/aerial-georef.md in the lunamap repository)
  function downloadGeoref(a) {
    var C = overlay.imageCorners(), lon = (C[0].lng + C[2].lng) / 2, zone = Math.floor((lon + 180) / 6) + 1;
    var def = mgaDefs(zone).mga2020, names = ["top_left", "top_right", "bottom_right", "bottom_left"], mga = {}, ll = {};
    C.forEach(function (c, i) {
      var p = proj4("EPSG:4326", def, [c.lng, c.lat]);
      mga[names[i]] = [Math.round(p[0] * 10) / 10, Math.round(p[1] * 10) / 10];
      ll[names[i]] = [+c.lng.toFixed(7), +c.lat.toFixed(7)];
    });
    var out = {
      note: "Rough flat placement of a raw aerial photo frame - NOT orthorectified. Centre and size from the frame's index " +
            "footprint, turned to the run's flight line, then rotated/flipped by hand in lunamap. Expect offsets of tens of " +
            "metres or more (tilt, relief, lens). Corners are the picture's outer pixel edges.",
      guide: "https://github.com/mdsumner/lunamap/blob/main/docs/aerial-georef.md",
      image: a.DOWNLOAD_LINK, thumbnail: a.THUMBNAIL_LINK,
      frame: { name: a.IMAGE_NAME, film: a.FILM_NO, run: a.RUN_NO, frame: a.FRAME, flown: when(a), season: a.FLY_SEASON,
               scale: a.SCALE, project: a.PROJ_NAME, type: a.IMAGE_TYPE },
      crs: "EPSG:" + (7800 + zone), corners: mga, crs_lonlat: "EPSG:7844", corners_lonlat: ll,
      quarter_turns: orient.turns, flipped: orient.flip,
      source: "Photos and index: Department of Natural Resources and Environment Tasmania, via theLIST"
    };
    var blob = new Blob([JSON.stringify(out, null, 1)], { type: "application/json" });
    var link = document.createElement("a"); link.href = URL.createObjectURL(blob);
    link.download = String(a.IMAGE_NAME || "frame").replace(/\.[a-z]+$/i, "") + "_rough_georef.json";
    document.body.appendChild(link); link.click(); setTimeout(function () { URL.revokeObjectURL(link.href); link.remove(); }, 1000);
  }

  // heading (radians east of north) of the flight at frame fr from its run neighbours, or null
  function heading(fr, c, nbs) {
    var prev = nbs.filter(function (n) { return n.fr === fr - 1; })[0], next = nbs.filter(function (n) { return n.fr === fr + 1; })[0];
    var p0 = prev ? prev.c : c, p1 = next ? next.c : c;
    if (!prev && !next) return null;
    var kx = Math.cos(c[1] * Math.PI / 180) * 111320, ky = 110574;
    return Math.atan2((p1[0] - p0[0]) * kx, (p1[1] - p0[1]) * ky);
  }
  // centre, image x-axis and half size (degrees) of a frame from its index footprint and flight heading
  function placement(ring, hd) {
    var c = centroid(ring), kx = Math.cos(c[1] * Math.PI / 180) * 111320, ky = 110574;   // metres per degree here
    var side = Math.hypot((ring[1][0] - ring[0][0]) * kx, (ring[1][1] - ring[0][1]) * ky);
    var ang = hd + orient.s;                                         // image x-axis turned from east by this, clockwise
    return { c: c, u: [Math.cos(ang), -Math.sin(ang)], half: [side / 2 / kx, side / 2 / ky] };
  }
  function clearExtras() { extras.forEach(function (o) { map.removeLayer(o); }); extras = []; }
  // the other frames of the same film that fall in the view, each turned to its own run's flight line
  function fillView() {
    var a = cur, b = map.getBounds(), btn = sheet.querySelector("#airfill");
    btn.disabled = true; btn.textContent = "Filling...";
    q(curLayer, { where: "FILM_NO='" + String(a.FILM_NO).replace(/'/g, "") + "'",
                  geometry: [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].map(function (v) { return v.toFixed(5); }).join(","),
                  geometryType: "esriGeometryEnvelope", inSR: 4326, spatialRel: "esriSpatialRelIntersects",
                  outFields: "OBJECTID,FRAME,RUN_NO,THUMBNAIL_LINK", returnGeometry: true, outSR: 4326, f: "json" })
    .then(function (fs) {
      if (cur !== a) return;
      clearExtras();
      var mid = map.getCenter();
      fs = fs.filter(function (f) { return f.geometry && f.attributes.OBJECTID !== a.OBJECTID; })
        .map(function (f) { var c = centroid(f.geometry.rings[0]); return { f: f, c: c, d: map.distance(mid, [c[1], c[0]]) }; })
        .sort(function (x, y) { return x.d - y.d; }).slice(0, 40);
      var byRun = {};
      fs.forEach(function (x) { (byRun[x.f.attributes.RUN_NO] = byRun[x.f.attributes.RUN_NO] || []).push({ fr: +x.f.attributes.FRAME, c: x.c }); });
      fs.forEach(function (x) {
        var at = x.f.attributes, hd = heading(+at.FRAME, x.c, byRun[at.RUN_NO] || []);
        var pl = placement(x.f.geometry.rings[0], hd === null ? orient.hd : hd);
        var o = new AffineImage(at.THUMBNAIL_LINK, pl.c, pl.u, pl.half).addTo(map);
        o.setOpacity(+sheet.querySelector("#airop").value);
        extras.push(o);
      });
      if (overlay && overlay.img) overlay.img.parentNode.appendChild(overlay.img);     // the chosen frame stays on top
      btn.textContent = "Fill view (" + fs.length + ")";
      showBadge(a, fs.length);
    }).catch(function (e) { btn.textContent = "Fill view"; toast("Could not fill the view: " + e.message); })
      .then(function () { btn.disabled = false; });
  }

  function centroid(ring) { var x = 0, y = 0, n = ring.length - 1; for (var i = 0; i < n; i++) { x += ring[i][0]; y += ring[i][1]; } return [x / n, y / n]; }

  function showFrame(layer, a) {
    cur = a;
    sheet.querySelector("#aircur").textContent = "Placing " + a.IMAGE_NAME + "...";
    var where = "FILM_NO='" + String(a.FILM_NO).replace(/'/g, "") + "' AND RUN_NO=" + (+a.RUN_NO || 0);
    Promise.all([
      q(layer, { objectIds: a.OBJECTID, outFields: "OBJECTID", returnGeometry: true, outSR: 4326, f: "json" }),
      q(layer, { where: where, outFields: "OBJECTID,FRAME", returnGeometry: true, outSR: 4326, f: "json" }).catch(function () { return []; })
    ]).then(function (r) {
      if (cur !== a) return;
      var ring = r[0][0] && r[0][0].geometry && r[0][0].geometry.rings[0];
      if (!ring) throw new Error("no footprint");
      // flight direction from the frames before and after on this run (frame numbers rise along the flight)
      var nbs = r[1].filter(function (f) { return f.geometry; }).map(function (f) { return { fr: +f.attributes.FRAME, c: centroid(f.geometry.rings[0]) }; });
      var hd = heading(+a.FRAME, centroid(ring), nbs);
      orient.hd = hd === null ? 0 : hd;
      orient.s = -Math.round(orient.hd / (Math.PI / 2)) * (Math.PI / 2);   // start nearest north-up
      orient.turns = 0; orient.flip = false;
      var pl = placement(ring, orient.hd), nb = hd !== null;
      removeOverlay(); cur = a;
      curLayer = layer;
      overlay = new AffineImage(a.THUMBNAIL_LINK, pl.c, pl.u, pl.half).addTo(map);
      outline = L.polygon(ring.map(function (p) { return [p[1], p[0]]; }), { color: "#6d4c41", weight: 1.5, dashArray: "6 5", fill: false, interactive: false }).addTo(map);
      showBadge(a);
      overlay.setOpacity(+sheet.querySelector("#airop").value);
      sheet.querySelector("#airctl").style.display = "flex";
      sheet.querySelector("#aircur").innerHTML = "<b>" + esc(a.IMAGE_NAME) + "</b> - " + esc(when(a)) + ", " + esc(a.PROJ_NAME) +
        ", 1:" + esc(a.SCALE) + (nb ? "" : " (no neighbouring frames: placed north-up)") +
        ". <a href='" + esc(a.DOWNLOAD_LINK) + "' target='_blank' rel='noopener'>Full scan (large TIFF)</a>";
    }).catch(function (e) { if (cur === a) sheet.querySelector("#aircur").textContent = "Could not place this frame: " + e.message; });
  }

  function list(ll) {
    var el = sheet.querySelector("#airlist");
    el.innerHTML = "Looking for photos at " + ll.lat.toFixed(4) + ", " + ll.lng.toFixed(4) + "...";
    Promise.all(DECADES.map(function (d) {
      return q(d[0], { geometry: ll.lng.toFixed(6) + "," + ll.lat.toFixed(6), geometryType: "esriGeometryPoint", inSR: 4326,
                       spatialRel: "esriSpatialRelIntersects", outFields: FIELDS, returnGeometry: false, f: "json" })
        .then(function (fs) { return { d: d, fs: fs }; }).catch(function () { return { d: d, fs: [], err: true }; });
    })).then(function (res) {
      var n = 0, html = [];
      res.forEach(function (g) {
        if (!g.fs.length) return;
        var fs = g.fs.map(function (f) { return f.attributes; }).sort(function (x, y) { return (x.FLY_DATE || 0) - (y.FLY_DATE || 0); });
        n += fs.length;
        html.push("<div class='airdec'><b>" + g.d[1] + "</b> (" + fs.length + ")</div><div class='airrow'>" + fs.map(function (a) {
          return "<button type='button' class='airitem' data-l='" + g.d[0] + "' data-o='" + a.OBJECTID + "' title='" + esc(a.PROJ_NAME) + "'>" +
            "<img loading='lazy' src='" + esc(a.THUMBNAIL_LINK) + "' alt=''><span>" + esc(when(a)) + "<br>" + esc(a.FILM_NO) + "/" + esc(a.FRAME) + "</span></button>";
        }).join("") + "</div>");
      });
      var failed = res.filter(function (g) { return g.err; }).length;
      el.innerHTML = (n ? n + (n === 1 ? " frame covers" : " frames cover") + " this spot. Tap one to lay it over the map." : "No indexed frames cover this spot.") +
        (failed ? " (" + failed + " decades could not be searched.)" : "") + html.join("");
      var byKey = {}; res.forEach(function (g) { g.fs.forEach(function (f) { byKey[g.d[0] + ":" + f.attributes.OBJECTID] = f.attributes; }); });
      [].forEach.call(el.querySelectorAll(".airitem"), function (b) {
        b.onclick = function () { showFrame(+b.getAttribute("data-l"), byKey[b.getAttribute("data-l") + ":" + b.getAttribute("data-o")]); };
      });
    });
  }

  window.openAerials = function () {
    ensureSheet().style.display = "block";
    list(pin ? pin.getLatLng() : map.getCenter());
  };
})();
