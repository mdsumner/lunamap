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
  var sheet = null, overlay = null, cur = null;

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
      "<button id='airoff' type='button'>Remove</button></div>" +
      "<div id='airlist' class='small'></div>" +
      "<p class='small' style='color:#666'>Photos and index: Department of Natural Resources and Environment Tasmania, via theLIST. " +
      "Placed by a flat guess from the index - not orthorectified; hills and tilt shift things by tens of metres or more.</p>";
    document.body.appendChild(sheet);
    sheet.querySelector("#airclose").onclick = function () { sheet.style.display = "none"; };
    sheet.querySelector("#airrot").onclick = function () { if (overlay) { overlay.turns = (overlay.turns + 1) % 4; overlay.redraw(); } };
    sheet.querySelector("#airflip").onclick = function () { if (overlay) { overlay.flip = !overlay.flip; overlay.redraw(); } };
    sheet.querySelector("#airop").oninput = function (e) { if (overlay) overlay.setOpacity(+e.target.value); };
    sheet.querySelector("#airoff").onclick = function () { removeOverlay(); };
    return sheet;
  }
  function removeOverlay() {
    if (overlay) { map.removeLayer(overlay); overlay = null; }
    cur = null; sheet.querySelector("#airctl").style.display = "none"; sheet.querySelector("#aircur").textContent = "";
  }

  // ---- the overlay: an <img> placed with a CSS affine matrix from three ground corners
  var AffineImage = L.Layer.extend({
    initialize: function (url, centre, axisU, half) { this.url = url; this.c = centre; this.u = axisU; this.half = half; this.turns = 0; this.flip = false; this.op = 0.85; },
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
    redraw: function () {
      if (!this._map || !this.img || !this.img.naturalWidth) return;
      // image corners TL, TR, BL in the frame's own axes, then turned and flipped
      var k = [[-1, 1], [1, 1], [-1, -1]], t = this.turns, f = this.flip;
      var rot = function (p) { var x = f ? -p[0] : p[0], y = p[1]; for (var i = 0; i < t; i++) { var nx = y, ny = -x; x = nx; y = ny; } return [x, y]; };
      var P = k.map(function (p) { var r = rot(p); return this._map.latLngToLayerPoint(this.corner(r[0], r[1])); }, this);
      var w = this.img.naturalWidth, h = this.img.naturalHeight;
      var a = (P[1].x - P[0].x) / w, b = (P[1].y - P[0].y) / w, c = (P[2].x - P[0].x) / h, d = (P[2].y - P[0].y) / h;
      this.img.style.transformOrigin = "0 0";
      this.img.style.transform = "matrix(" + [a, b, c, d, P[0].x, P[0].y].map(function (v) { return v.toFixed(6); }).join(",") + ")";
    }
  });

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
      var c = centroid(ring), kx = Math.cos(c[1] * Math.PI / 180) * 111320, ky = 110574;   // metres per degree here
      // half side in metres from the footprint's first edge
      var side = Math.hypot((ring[1][0] - ring[0][0]) * kx, (ring[1][1] - ring[0][1]) * ky);
      // flight direction from the frames before and after on this run
      var fr = +a.FRAME, nb = r[1].filter(function (f) { return Math.abs(+f.attributes.FRAME - fr) === 1 && f.geometry; })
        .map(function (f) { return centroid(f.geometry.rings[0]); });
      var ang = 0;                                                  // radians, east of north; 0 = north-up
      if (nb.length) {
        var p0 = nb.length > 1 ? nb[0] : c, p1 = nb.length > 1 ? nb[1] : nb[0];
        var de = (p1[0] - p0[0]) * kx, dn = (p1[1] - p0[1]) * ky, hd = Math.atan2(de, dn);
        ang = hd - Math.round(hd / (Math.PI / 2)) * (Math.PI / 2);  // keep the run's axis, start nearest north-up
      }
      var u = [Math.cos(ang), -Math.sin(ang)];                      // image x-axis on the ground (east, north)
      var half = [side / 2 / kx, side / 2 / ky];                     // degrees per half side (lon, lat)
      removeOverlay(); cur = a;
      overlay = new AffineImage(a.THUMBNAIL_LINK, c, u, half).addTo(map);
      overlay.setOpacity(+sheet.querySelector("#airop").value);
      sheet.querySelector("#airctl").style.display = "flex";
      sheet.querySelector("#aircur").innerHTML = "<b>" + esc(a.IMAGE_NAME) + "</b> - " + esc(when(a)) + ", " + esc(a.PROJ_NAME) +
        ", 1:" + esc(a.SCALE) + (nb.length ? "" : " (no neighbouring frames: placed north-up)") +
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
