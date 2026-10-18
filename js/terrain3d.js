// lunamap - terrain3d.js: the 3D switch. Tapping 3D swaps the Leaflet map for a tilted
// MapLibre GL view of the same place, basemap and zoom, draped over terrain; tapping 2D
// swaps back to where you have panned to. Loaded on first use.
// Terrain: a raster-dem source whose tiles are made in the browser (MapLibre custom
// protocol "lunadem://"): inside the Tasmania 2 m DEM's extent, heights are read from
// that cloud-optimised GeoTIFF (via js/profile.js) and encoded as Terrarium RGB PNG;
// elsewhere, or if the DEM cannot be read, the public AWS Terrain Tiles (about 30 m)
// are used. Sea and no-data are set to 0 m so coasts stay at sea level.
// The pin and drawings are shown; tapping the 3D map moves the pin.
// ---------------------------------------------------------------------------
(function () {
  var ML_JS = "https://cdn.jsdelivr.net/npm/maplibre-gl@5.6.0/dist/maplibre-gl.js";
  var ML_CSS = "https://cdn.jsdelivr.net/npm/maplibre-gl@5.6.0/dist/maplibre-gl.css";
  var GEOTIFF_URL = "https://cdn.jsdelivr.net/npm/geotiff@3.0.5/dist-browser/geotiff.js";
  var AWS = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/";
  var TILE = 256, EXAG = 1.5;
  var ml = null, box = null, pinMarker = null, on = false, demInfo = null, ready = null;

  function lon2x(lon, z) { return (lon + 180) / 360 * Math.pow(2, z); }
  function lat2y(lat, z) { var r = lat * Math.PI / 180; return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * Math.pow(2, z); }
  function x2lon(x, z) { return x / Math.pow(2, z) * 360 - 180; }
  function y2lat(y, z) { var n = Math.PI - 2 * Math.PI * y / Math.pow(2, z); return 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n))); }

  // the DEM's extent in lon/lat, from its header
  function demExtent() {
    if (!demInfo) demInfo = openDEM().then(function (dem) {
      var def = mgaDefs(55).mga94, x1 = dem.x0 + dem.W * dem.dx, y1 = dem.y0 - dem.H * dem.dy, pts = [];
      [[dem.x0, dem.y0], [x1, dem.y0], [x1, y1], [dem.x0, y1]].forEach(function (p) { pts.push(proj4(def, "EPSG:4326", p)); });
      return { dem: dem, def: def, w: Math.min.apply(null, pts.map(function (p) { return p[0]; })), e: Math.max.apply(null, pts.map(function (p) { return p[0]; })),
               s: Math.min.apply(null, pts.map(function (p) { return p[1]; })), n: Math.max.apply(null, pts.map(function (p) { return p[1]; })) };
    }).catch(function (e) { demInfo = null; throw e; });
    return demInfo;
  }

  function awsTile(z, x, y, signal) {
    return fetch(AWS + z + "/" + x + "/" + y + ".png", { signal: signal }).then(function (r) {
      if (!r.ok) throw new Error("terrain tile " + r.status); return r.arrayBuffer();
    });
  }

  // one Terrarium PNG tile from the 2 m DEM, or null if the tile is outside it
  function demTile(z, x, y) {
    var w = x2lon(x, z), e = x2lon(x + 1, z), n = y2lat(y, z), s = y2lat(y + 1, z);
    return demExtent().then(function (X) {
      if (e < X.w || w > X.e || n < X.s || s > X.n) return null;
      var dem = X.dem, G = 17, grid = [];                    // MGA coordinates on a coarse grid, interpolated per pixel
      for (var j = 0; j < G; j++) for (var i = 0; i < G; i++)
        grid.push(proj4("EPSG:4326", X.def, [x2lon(x + i / (G - 1), z), y2lat(y + j / (G - 1), z)]));
      var spanE = Math.abs(grid[G - 1][0] - grid[0][0]), spacing = spanE / TILE, k = 0;
      while (k + 1 < dem.count && dem.dx * Math.pow(2, k + 1) <= spacing) k++;
      return demLevel(dem, k).then(function (lv) {
        var cell = dem.dx * lv.sx, minE = Infinity, maxE = -Infinity, minN = Infinity, maxN = -Infinity;
        grid.forEach(function (p) { minE = Math.min(minE, p[0]); maxE = Math.max(maxE, p[0]); minN = Math.min(minN, p[1]); maxN = Math.max(maxN, p[1]); });
        var c0 = Math.max(0, Math.floor((minE - dem.x0) / cell) - 1), c1 = Math.min(lv.w, Math.ceil((maxE - dem.x0) / cell) + 2);
        var r0 = Math.max(0, Math.floor((dem.y0 - maxN) / cell) - 1), r1 = Math.min(lv.h, Math.ceil((dem.y0 - minN) / cell) + 2);
        if (c1 <= c0 || r1 <= r0) return null;
        return lv.img.readRasters({ window: [c0, r0, c1, r1], samples: [0], interleave: false }).then(function (rr) {
          var band = rr[0], ww = c1 - c0, wh = r1 - r0;
          var cv = document.createElement("canvas"); cv.width = TILE; cv.height = TILE;
          var g = cv.getContext("2d"), img = g.createImageData(TILE, TILE), px = img.data;
          function val(cc, rw) { var v = band[rw * ww + cc]; return (v === undefined || isNaN(v) || v < -1000 || v > 10000) ? null : v; }
          for (var py = 0; py < TILE; py++) {
            var fy = py / (TILE - 1) * (G - 1), gj = Math.min(G - 2, Math.floor(fy)), ty = fy - gj;
            for (var pxi = 0; pxi < TILE; pxi++) {
              var fx = pxi / (TILE - 1) * (G - 1), gi = Math.min(G - 2, Math.floor(fx)), tx = fx - gi;
              var a = grid[gj * G + gi], b = grid[gj * G + gi + 1], c = grid[(gj + 1) * G + gi], d = grid[(gj + 1) * G + gi + 1];
              var E = (a[0] * (1 - tx) + b[0] * tx) * (1 - ty) + (c[0] * (1 - tx) + d[0] * tx) * ty;
              var N = (a[1] * (1 - tx) + b[1] * tx) * (1 - ty) + (c[1] * (1 - tx) + d[1] * tx) * ty;
              var fc = (E - dem.x0) / cell - 0.5 - c0, fr = (dem.y0 - N) / cell - 0.5 - r0;
              var ci = Math.max(0, Math.min(ww - 2, Math.floor(fc))), ri = Math.max(0, Math.min(wh - 2, Math.floor(fr)));
              var u = Math.max(0, Math.min(1, fc - ci)), v = Math.max(0, Math.min(1, fr - ri));
              var z00 = val(ci, ri), z10 = val(ci + 1, ri), z01 = val(ci, ri + 1), z11 = val(ci + 1, ri + 1), h;
              if (z00 === null || z10 === null || z01 === null || z11 === null) h = Math.max(0, z00 || z10 || z01 || z11 || 0);
              else h = Math.max(0, (z00 * (1 - u) + z10 * u) * (1 - v) + (z01 * (1 - u) + z11 * u) * v);
              var t = h + 32768, o = 4 * (py * TILE + pxi);          // Terrarium: height = R*256 + G + B/256 - 32768
              px[o] = Math.floor(t / 256); px[o + 1] = Math.floor(t) % 256; px[o + 2] = Math.floor((t - Math.floor(t)) * 256); px[o + 3] = 255;
            }
          }
          g.putImageData(img, 0, 0);
          return new Promise(function (res) { cv.toBlob(function (bl) { res(bl.arrayBuffer()); }, "image/png"); });
        });
      });
    });
  }

  function demProtocol(params, abort) {
    var m = /lunadem:\/\/(\d+)\/(\d+)\/(\d+)/.exec(params.url), z = +m[1], x = +m[2], y = +m[3];
    var signal = abort && abort.signal;
    return demTile(z, x, y).catch(function () { return null; })
      .then(function (buf) { return buf || awsTile(z, x, y, signal); })
      .then(function (buf) { return { data: buf }; });
  }

  function rasterSource() {
    var id = sel.value, url = basemapTileUrl(id, "{z}", "{x}", "{y}");
    if (!url) { id = "topo"; url = basemapTileUrl(id, "{z}", "{x}", "{y}"); }
    var c = id.charAt(0) === "c" && customMaps[+id.slice(1)];
    var attr = isListBase(id) ? "&copy; State of Tasmania (theLIST)" : ((EXTERNAL.filter(function (e) { return e.id === id; })[0] || {}).attr || (c && c.name) || "");
    return { type: "raster", tiles: [url], tileSize: 256, maxzoom: basemapMaxZoom(id), attribution: attr };
  }
  function setBase() {
    if (!ml || !ml.isStyleLoaded()) return;
    if (ml.getLayer("base")) ml.removeLayer("base");
    if (ml.getSource("base")) ml.removeSource("base");
    ml.addSource("base", rasterSource());
    ml.addLayer({ id: "base", type: "raster", source: "base" }, ml.getLayer("drawn-fill") ? "drawn-fill" : undefined);
  }
  function syncOverlays() {
    if (!ml || !ml.isStyleLoaded()) return;
    if (pin) {
      var p = pin.getLatLng();
      if (!pinMarker) pinMarker = new maplibregl.Marker({ color: "#c62828" });
      pinMarker.setLngLat([p.lng, p.lat]).addTo(ml);
    } else if (pinMarker) pinMarker.remove();
    var gj = typeof drawingsGeoJSON === "function" ? drawingsGeoJSON() : { type: "FeatureCollection", features: [] };
    if (ml.getSource("drawn")) ml.getSource("drawn").setData(gj);
    var rt = typeof routeInfo !== "undefined" && routeInfo && routeInfo.ok && routeInfo.path ?
      { type: "Feature", geometry: { type: "LineString", coordinates: routeInfo.path }, properties: {} } : { type: "FeatureCollection", features: [] };
    if (ml.getSource("route")) ml.getSource("route").setData(rt);
  }

  function build() {
    box = document.createElement("div"); box.id = "map3d";
    document.body.appendChild(box);
    maplibregl.addProtocol("lunadem", demProtocol);
    var c = map.getCenter();
    ml = new maplibregl.Map({
      container: box, center: [c.lng, c.lat], zoom: Math.max(0, map.getZoom() - 1), pitch: 60, bearing: 0, maxPitch: 85,
      attributionControl: { compact: true },
      canvasContextAttributes: { preserveDrawingBuffer: true },     // so Print and screenshots capture the 3D view
      style: { version: 8, sources: {
          dem: { type: "raster-dem", tiles: ["lunadem://{z}/{x}/{y}"], tileSize: TILE, maxzoom: 14, encoding: "terrarium",
                 attribution: "Terrain: Tasmania 2 m DEM (MRT / theLIST) and AWS Terrain Tiles (Tilezen Joerd)" },
          drawn: { type: "geojson", data: { type: "FeatureCollection", features: [] } },
          route: { type: "geojson", data: { type: "FeatureCollection", features: [] } } },
        layers: [
          { id: "drawn-fill", type: "fill", source: "drawn", filter: ["==", ["geometry-type"], "Polygon"], paint: { "fill-color": "#8e24aa", "fill-opacity": 0.15 } },
          { id: "drawn-line", type: "line", source: "drawn", filter: ["!=", ["geometry-type"], "Point"], paint: { "line-color": "#6a1b9a", "line-width": 3 } },
          { id: "drawn-pt", type: "circle", source: "drawn", filter: ["==", ["geometry-type"], "Point"], paint: { "circle-color": "#6a1b9a", "circle-radius": 6, "circle-stroke-color": "#fff", "circle-stroke-width": 2 } },
          { id: "route", type: "line", source: "route", paint: { "line-color": "#d81b60", "line-width": 5, "line-opacity": 0.85 } }
        ],
        sky: { "sky-color": "#9ec7e8", "horizon-color": "#f0f6fb", "fog-color": "#ffffff", "fog-ground-blend": 0.5, "sky-horizon-blend": 0.5 },
        terrain: { source: "dem", exaggeration: EXAG } }
    });
    ml.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-left");
    ml.addControl(new maplibregl.TerrainControl({ source: "dem", exaggeration: EXAG }), "top-left");
    ml.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "bottom-right");
    ml.on("click", function (e) { setPin(L.latLng(e.lngLat.lat, e.lngLat.lng)); syncOverlays(); });
    ready = new Promise(function (res) { ml.on("load", function () { setBase(); syncOverlays(); res(); }); });
    sel.addEventListener("change", function () { if (on) setBase(); });
    return ready;
  }

  function show(flag) {
    on = flag;
    document.body.classList.toggle("in3d", flag);
    document.getElementById("view3d").textContent = flag ? "2D" : "3D";
    document.getElementById("view3d").classList.toggle("on", flag);
    if (flag) {
      var c = map.getCenter();
      box.style.display = "block"; ml.resize();
      ml.jumpTo({ center: [c.lng, c.lat], zoom: Math.max(0, map.getZoom() - 1) });
      if (ml.getPitch() < 20) ml.easeTo({ pitch: 60, duration: 600 });
      syncOverlays();
    } else {
      var mc = ml.getCenter();
      box.style.display = "none";
      map.setView([mc.lat, mc.lng], Math.round(ml.getZoom() + 1), { animate: false });
    }
  }

  window.toggle3D = function () {
    if (ml) { show(!on); return Promise.resolve(); }
    toast("Loading 3D...");
    loadCSS(ML_CSS);
    return loadScript(ML_JS)
      .then(function () { return loadScript(GEOTIFF_URL); }).then(function () { return loadScript("js/profile.js"); })
      .then(function () { var r = build(); show(true); return r; })
      .catch(function (e) { toast("3D view unavailable: " + e.message); });
  };
  window.in3D = function () { return on; };
  window.map3D = function () { return ml; };
})();
