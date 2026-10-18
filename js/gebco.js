// lunamap - gebco.js: GEBCO 2026 global bathymetry and land heights as a basemap, drawn
// in the browser straight from a cloud-optimised GeoTIFF (no tile server). Each 256 px
// map tile reads only the COG blocks it needs, from the overview that matches the zoom,
// samples them per pixel (the COG is in longitude/latitude, the map in Web Mercator),
// and colours the heights: blues below sea level, greens to browns to white above, with
// a light hillshade. Also gives a fallback elevation at the pin (see extras.js) where the
// Tasmania 2 m DEM has no data, such as Macquarie Island or offshore.
// geotiff.js is loaded on first use.
// ---------------------------------------------------------------------------
(function () {
  var GEBCO_URL = "https://data.source.coop/ausantarctic/gebco/GEBCO_2026.tif";
  var GEOTIFF_URL = "https://cdn.jsdelivr.net/npm/geotiff@3.0.5/dist-browser/geotiff.js";
  var ATTR = "Bathymetry and land heights: GEBCO Compilation Group (2026) GEBCO 2026 Grid";
  var cog = null;

  function openCog() {
    if (!cog) cog = loadScript(GEOTIFF_URL).then(function () { return GeoTIFF.fromUrl(GEBCO_URL, { allowFullFile: false }); })
      .then(function (tiff) {
        return tiff.getImageCount().then(function (n) {
          var ims = []; for (var i = 0; i < n; i++) ims.push(tiff.getImage(i));
          return Promise.all(ims);
        }).then(function (ims) {
          var im0 = ims[0], o = im0.getOrigin(), r = im0.getResolution(), W = im0.getWidth();
          var nd = im0.getGDALNoData ? im0.getGDALNoData() : null;
          // full-resolution image first, then overviews (geotiff.js may also list masks; keep same-band images)
          var levels = ims.filter(function (im) { return im.getSamplesPerPixel() === im0.getSamplesPerPixel(); })
            .map(function (im) { return { im: im, w: im.getWidth(), h: im.getHeight(), res: r[0] * W / im.getWidth() }; })
            .sort(function (a, b) { return a.res - b.res; });
          return { x0: o[0], y0: o[1], levels: levels, nodata: nd };
        });
      }).catch(function (e) { cog = null; throw e; });
    return cog;
  }
  function pickLevel(c, degPerPx) {
    var lv = c.levels[0];
    c.levels.forEach(function (l) { if (l.res <= degPerPx * 1.01) lv = l; });
    return lv;
  }

  // colour ramps: [height m, r, g, b]
  var SEA = [[-8000, 8, 29, 88], [-5000, 20, 60, 140], [-3000, 34, 94, 168], [-1000, 65, 140, 200], [-200, 120, 190, 225], [0, 190, 230, 245]];
  var LAND = [[0, 90, 150, 90], [300, 150, 180, 100], [800, 200, 190, 120], [1500, 170, 130, 90], [2500, 150, 120, 110], [4000, 240, 240, 240]];
  function ramp(stops, z) {
    if (z <= stops[0][0]) return stops[0];
    for (var i = 1; i < stops.length; i++) if (z <= stops[i][0]) {
      var a = stops[i - 1], b = stops[i], t = (z - a[0]) / (b[0] - a[0]);
      return [z, a[1] + t * (b[1] - a[1]), a[2] + t * (b[2] - a[2]), a[3] + t * (b[3] - a[3])];
    }
    return stops[stops.length - 1];
  }

  function mercLat(y) { return 180 / Math.PI * Math.atan(Math.sinh(Math.PI * (1 - 2 * y))); }   // y in 0..1

  var GebcoLayer = L.GridLayer.extend({
    createTile: function (coords, done) {
      var tile = document.createElement("canvas"), size = this.getTileSize();
      tile.width = size.x; tile.height = size.y;
      var n = Math.pow(2, coords.z), W = size.x, H = size.y;
      var west = coords.x / n * 360 - 180, east = (coords.x + 1) / n * 360 - 180;
      var north = mercLat(coords.y / n), south = mercLat((coords.y + 1) / n);
      openCog().then(function (c) {
        var lv = pickLevel(c, (east - west) / W);
        var cx0 = Math.floor((west - c.x0) / lv.res), cx1 = Math.ceil((east - c.x0) / lv.res);
        var cy0 = Math.floor((c.y0 - north) / lv.res), cy1 = Math.ceil((c.y0 - south) / lv.res);
        var wx0 = Math.max(0, cx0 - 1), wy0 = Math.max(0, cy0 - 1), wx1 = Math.min(lv.w, cx1 + 1), wy1 = Math.min(lv.h, cy1 + 1);
        if (wx1 <= wx0 || wy1 <= wy0) return null;
        return lv.im.readRasters({ window: [wx0, wy0, wx1, wy1], samples: [0], interleave: false }).then(function (r) {
          return { band: r[0], ww: wx1 - wx0, wh: wy1 - wy0, wx0: wx0, wy0: wy0, lv: lv, c: c };
        });
      }).then(function (d) {
        if (!d) { done(null, tile); return; }
        var g = tile.getContext("2d"), img = g.createImageData(W, H), px = img.data;
        // bilinear sampling, so zoomed-in views are smooth rather than blocky
        var z = new Float32Array(W * H), c0 = new Int32Array(W), cf = new Float32Array(W), x, y, nd = d.c.nodata;
        for (x = 0; x < W; x++) {
          var lon = west + (x + 0.5) / W * (east - west);
          var fx = Math.min(d.ww - 1.001, Math.max(0, (lon - d.c.x0) / d.lv.res - 0.5 - d.wx0));
          c0[x] = Math.floor(fx); cf[x] = fx - c0[x];
        }
        for (y = 0; y < H; y++) {
          var lat = mercLat((coords.y + (y + 0.5) / H) / n);
          var fy = Math.min(d.wh - 1.001, Math.max(0, (d.c.y0 - lat) / d.lv.res - 0.5 - d.wy0));
          var r0 = Math.floor(fy), rf = fy - r0, o0 = r0 * d.ww, o1 = Math.min(d.wh - 1, r0 + 1) * d.ww;
          for (x = 0; x < W; x++) {
            var a0 = d.band[o0 + c0[x]], a1 = d.band[o0 + c0[x] + 1], b0 = d.band[o1 + c0[x]], b1 = d.band[o1 + c0[x] + 1];
            if (nd !== null && (a0 === nd || a1 === nd || b0 === nd || b1 === nd)) { z[y * W + x] = NaN; continue; }
            var t = cf[x];
            z[y * W + x] = (a0 + t * (a1 - a0)) * (1 - rf) + (b0 + t * (b1 - b0)) * rf;
          }
        }
        // light hillshade from the NW, scaled to the ground size of a pixel
        var mpp = 40075016 * Math.cos((north + south) / 2 * Math.PI / 180) / (n * W);
        var k = 3 / (2 * mpp);                         // vertical exaggeration 3
        for (y = 0; y < H; y++) for (x = 0; x < W; x++) {
          var i = y * W + x, v = z[i], o = 4 * i;
          if (isNaN(v)) { px[o + 3] = 0; continue; }
          var c3 = v < 0 ? ramp(SEA, v) : ramp(LAND, v);
          var zl = z[y * W + Math.max(0, x - 1)], zr = z[y * W + Math.min(W - 1, x + 1)];
          var zu = z[Math.max(0, y - 1) * W + x], zd = z[Math.min(H - 1, y + 1) * W + x];
          var gx = ((zr - zl) || 0) * k, gy = ((zu - zd) || 0) * k;      // slope east, slope north
          // light from the NW at 45 degrees: L = (-0.5, 0.5, 0.707); flat ground gives 1
          var shade = (0.5 * gx - 0.5 * gy + 0.7071) / Math.sqrt(1 + gx * gx + gy * gy) / 0.7071;
          shade = Math.max(0.55, Math.min(1.25, 0.35 + 0.65 * shade));
          px[o] = Math.min(255, c3[1] * shade); px[o + 1] = Math.min(255, c3[2] * shade); px[o + 2] = Math.min(255, c3[3] * shade); px[o + 3] = 255;
        }
        g.putImageData(img, 0, 0);
        done(null, tile);
      }).catch(function (e) { done(e, tile); });
      return tile;
    }
  });

  // height at a point from the finest level, or null
  window.gebcoHeight = function (lon, lat) {
    return openCog().then(function (c) {
      var lv = c.levels[0], col = Math.floor((lon - c.x0) / lv.res), row = Math.floor((c.y0 - lat) / lv.res);
      if (col < 0 || row < 0 || col >= lv.w || row >= lv.h) return null;
      return lv.im.readRasters({ window: [col, row, col + 1, row + 1], samples: [0], interleave: false }).then(function (r) {
        var v = r[0][0]; return (c.nodata !== null && v === c.nodata) ? null : v;
      });
    });
  };

  EXTERNAL.push({ id: "gebco", name: "GEBCO 2026 bathymetry", max: 12, attr: ATTR,
    make: function () { return new GebcoLayer({ maxNativeZoom: 12, maxZoom: 19, attribution: ATTR, keepBuffer: 1 }); } });
  buildBasemapMenu();
})();
