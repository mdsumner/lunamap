// lunamap - profile.js (loaded on demand from draw.js): elevation profile along
// a drawn line, or the elevation of a drawn point, from the Tasmania 2 m DEM
// (Mineral Resources Tasmania / theLIST, CC BY 3.0 AU), a single cloud-optimised
// GeoTIFF on Source Cooperative. geotiff.js reads only the 512 x 512 tiles the
// samples fall in, from the overview level that matches the sample spacing.
// ---------------------------------------------------------------------------
var DEM_URL = "https://data.source.coop/alexgleith/tasmania-dem-2m/Tasmania_Statewide_2m_DEM_14-08-2021.tif";
var DEM_CREDIT = "Elevation: Tasmania 2 m DEM, Mineral Resources Tasmania / theLIST (CC BY 3.0 AU), via Source Cooperative";
var demPromise = null;

function openDEM() {
  if (!demPromise) demPromise = GeoTIFF.fromUrl(DEM_URL, { allowFullFile: false }).then(function (tiff) {
    return Promise.all([tiff.getImageCount(), tiff.getImage(0)]).then(function (r) {
      var img0 = r[1], o = img0.getOrigin(), res = img0.getResolution();
      return { tiff: tiff, count: r[0], W: img0.getWidth(), H: img0.getHeight(), x0: o[0], y0: o[1], dx: res[0], dy: -res[1],
               levels: {} };
    });
  }).catch(function (e) { demPromise = null; throw e; });
  return demPromise;
}
function demLevel(dem, k) {
  if (!dem.levels[k]) dem.levels[k] = dem.tiff.getImage(k).then(function (img) {
    return { img: img, w: img.getWidth(), h: img.getHeight(), tw: img.getTileWidth(), th: img.getTileHeight(),
             sx: dem.W / img.getWidth(), sy: dem.H / img.getHeight() };
  });
  return dem.levels[k];
}

// sample positions: [{E, N, lon, lat, d}] along the line in MGA94 zone 55 (the DEM's grid)
function samplePoints(lonlats, maxSamples) {
  var def = mgaDefs(55).mga94;
  var en = lonlats.map(function (c) { return proj4("EPSG:4326", def, c); });
  var cum = [0];
  for (var i = 1; i < en.length; i++) cum.push(cum[i - 1] + Math.hypot(en[i][0] - en[i - 1][0], en[i][1] - en[i - 1][1]));
  var L = cum[cum.length - 1];
  var spacing = Math.max(2, L / (maxSamples - 1)), n = Math.max(1, Math.floor(L / spacing)) + 1, out = [], seg = 1;
  for (var j = 0; j < n; j++) {
    var d = j === n - 1 ? L : j * spacing;
    while (seg < en.length - 1 && cum[seg] < d) seg++;
    var a = en[Math.max(0, seg - 1)], b = en[Math.min(seg, en.length - 1)], s0 = cum[Math.max(0, seg - 1)], s1 = cum[Math.min(seg, en.length - 1)];
    var t = s1 > s0 ? (d - s0) / (s1 - s0) : 0, E = a[0] + t * (b[0] - a[0]), N = a[1] + t * (b[1] - a[1]);
    var ll = proj4(def, "EPSG:4326", [E, N]);
    out.push({ E: E, N: N, lon: ll[0], lat: ll[1], d: d });
  }
  return { pts: out, spacing: spacing, length: L };
}

// elevations (metres, or null) for the samples, at the coarsest level not coarser than the spacing
function sampleDEM(pts, spacing) {
  return openDEM().then(function (dem) {
    var k = 0;
    while (k + 1 < dem.count && dem.dx * Math.pow(2, k + 1) <= spacing) k++;
    return demLevel(dem, k).then(function (lv) {
      var byTile = {};
      pts.forEach(function (p, i) {
        var col = Math.floor((p.E - dem.x0) / (dem.dx * lv.sx)), row = Math.floor((dem.y0 - p.N) / (dem.dy * lv.sy));
        p.col = col; p.row = row;
        if (col < 0 || row < 0 || col >= lv.w || row >= lv.h) { p.z = null; return; }
        var key = Math.floor(col / lv.tw) + "," + Math.floor(row / lv.th);
        (byTile[key] = byTile[key] || []).push(i);
      });
      var keys = Object.keys(byTile), next = 0;
      function worker() {
        if (next >= keys.length) return Promise.resolve();
        var key = keys[next++], tc = key.split(",").map(Number);
        var x0 = tc[0] * lv.tw, y0 = tc[1] * lv.th, x1 = Math.min(x0 + lv.tw, lv.w), y1 = Math.min(y0 + lv.th, lv.h);
        return lv.img.readRasters({ window: [x0, y0, x1, y1], samples: [0], interleave: false }).then(function (r) {
          var band = r[0], w = x1 - x0;
          byTile[key].forEach(function (i) {
            var p = pts[i], v = band[(p.row - y0) * w + (p.col - x0)];
            p.z = (v === undefined || isNaN(v) || v < -1e30 || v > 1e5) ? null : v;
          });
          return worker();
        });
      }
      var ws = []; for (var c = 0; c < Math.min(4, keys.length); c++) ws.push(worker());
      return Promise.all(ws).then(function () { return { level: k, cell: dem.dx * lv.sx, tiles: keys.length }; });
    });
  });
}

function profileStats(pts) {
  var zs = pts.filter(function (p) { return p.z !== null; });
  if (!zs.length) return null;
  var up = 0, down = 0, min = Infinity, max = -Infinity, steep = 0;
  for (var i = 0; i < pts.length; i++) {
    var z = pts[i].z; if (z === null) continue;
    min = Math.min(min, z); max = Math.max(max, z);
    if (i > 0 && pts[i - 1].z !== null) { var dz = z - pts[i - 1].z; if (dz > 0) up += dz; else down -= dz; }
  }
  // steepest grade over about 20 m (or the sample spacing if wider)
  for (var a = 0, b = 0; b < pts.length; b++) {
    while (a < b && pts[b].d - pts[a + 1].d >= 20) a++;
    if (pts[a].z !== null && pts[b].z !== null && pts[b].d - pts[a].d >= 10)
      steep = Math.max(steep, Math.abs(pts[b].z - pts[a].z) / (pts[b].d - pts[a].d));
  }
  return { min: min, max: max, up: up, down: down, steep: steep, start: pts[0].z, end: pts[pts.length - 1].z };
}

// ---- slope detail (opt in) ----------------------------------------------------------
// Grade = rise / run, where run is the horizontal (map) distance. Shown three ways:
// percent (100 x rise / run), "1 in N" (N = run / rise) and degrees (atan of rise / run).
// 100% = 1 in 1 = 45 degrees. Grades are smoothed over about 20 m (or the sample spacing,
// if wider) so 2 m DEM noise, kerbs and logs don't show up as cliffs.
var SLOPE_CLASSES = [   // upper bound in percent, label, colour
  [5, "under 5% (flat)", "#9e9e9e"], [10, "5-10% (gentle)", "#7cb342"], [20, "10-20% (moderate)", "#fdd835"],
  [30, "20-30% (steep)", "#fb8c00"], [Infinity, "over 30% (very steep)", "#c62828"]];
function slopeClass(g) { var p = Math.abs(g) * 100; for (var i = 0; i < SLOPE_CLASSES.length; i++) if (p < SLOPE_CLASSES[i][0]) return i; return SLOPE_CLASSES.length - 1; }
function fmtGrade(g, signed) {
  var p = g * 100, a = Math.abs(p), deg = Math.atan(Math.abs(g)) * 180 / Math.PI;
  var ratio = a < 0.5 ? "level" : "1 in " + (100 / a < 10 ? (100 / a).toFixed(1).replace(/\.0$/, "") : Math.round(100 / a));
  return (signed && p >= 0.5 ? "+" : signed && p <= -0.5 ? "-" : "") + Math.round(a) + "% (" + ratio + ", " +
    (deg < 10 ? deg.toFixed(1) : Math.round(deg)) + " deg)";
}
// grade at each sample along the line (signed: + is uphill in the drawn direction), or null
function slopes(pts, spacing) {
  var h = Math.max(10, spacing), n = pts.length, a = 0, b = 0;
  for (var i = 0; i < n; i++) {
    while (a < i && pts[i].d - pts[a].d > h) a++;
    if (b < i) b = i;
    while (b + 1 < n && pts[b + 1].d - pts[i].d <= h) b++;
    // least-squares slope of height against distance over the window (steadier than end points,
    // since each sample takes the height of the 2 m cell it falls in)
    var sn = 0, sd = 0, sz = 0, sdd = 0, sdz = 0, dmin = Infinity, dmax = -Infinity;
    for (var j = a; j <= b; j++) {
      var q = pts[j]; if (q.z === null) continue;
      var dx = q.d - pts[i].d;
      sn++; sd += dx; sz += q.z; sdd += dx * dx; sdz += dx * q.z; dmin = Math.min(dmin, q.d); dmax = Math.max(dmax, q.d);
    }
    var den = sn * sdd - sd * sd;
    pts[i].g = (pts[i].z !== null && sn >= 2 && dmax - dmin >= Math.min(10, h) && den > 0) ? (sn * sdz - sd * sz) / den : null;
  }
}
// distance in each class, average grades, steepest spots
function slopeStats(pts, spacing) {
  slopes(pts, spacing);
  var dist = SLOPE_CLASSES.map(function () { return 0; }), upD = 0, upZ = 0, dnD = 0, dnZ = 0, maxUp = null, maxDn = null;
  for (var i = 1; i < pts.length; i++) {
    var p = pts[i], q = pts[i - 1], dd = p.d - q.d;
    if (p.g === null || q.g === null || p.z === null || q.z === null) continue;
    var g = (p.g + q.g) / 2;
    dist[slopeClass(g)] += dd;
    if (p.z > q.z) { upD += dd; upZ += p.z - q.z; } else if (p.z < q.z) { dnD += dd; dnZ += q.z - p.z; }
    if (p.g > 0 && (!maxUp || p.g > maxUp.g)) maxUp = p;
    if (p.g < 0 && (!maxDn || p.g < maxDn.g)) maxDn = p;
  }
  // steepest sustained 100 m (only for lines long enough)
  var sus = null;
  for (var x = 0, y = 0; y < pts.length; y++) {
    while (x < y && pts[y].d - pts[x + 1].d >= 100) x++;
    if (pts[y].d - pts[x].d >= 100 && pts[x].z !== null && pts[y].z !== null) {
      var gg = (pts[y].z - pts[x].z) / (pts[y].d - pts[x].d);
      if (!sus || Math.abs(gg) > Math.abs(sus.g)) sus = { g: gg, from: pts[x].d, to: pts[y].d };
    }
  }
  return { dist: dist, upAvg: upD ? upZ / upD : null, dnAvg: dnD ? -dnZ / dnD : null, maxUp: maxUp, maxDn: maxDn, sustained: sus };
}

function profileSVG(pts, st, opt) {
  var W = 600, H = 170, L = 38, R = 8, T = 8, B = 22;
  var D = pts[pts.length - 1].d || 1, zmin = Math.floor(st.min), zmax = Math.ceil(st.max);
  if (zmax - zmin < 10) { zmax = zmin + 10; }
  var x = function (d) { return L + (W - L - R) * d / D; }, y = function (z) { return T + (H - T - B) * (zmax - z) / (zmax - zmin); };
  var path = "", fill = "", started = false;
  pts.forEach(function (p) {
    if (p.z === null) { started = false; return; }
    path += (started ? "L" : "M") + x(p.d).toFixed(1) + "," + y(p.z).toFixed(1); started = true;
  });
  var valid = pts.filter(function (p) { return p.z !== null; });
  if (valid.length > 1) fill = "M" + x(valid[0].d).toFixed(1) + "," + (H - B) + path.replace(/M/g, "L") +
    "L" + x(valid[valid.length - 1].d).toFixed(1) + "," + (H - B) + "Z";
  var g = function (z) { return "<line x1='" + L + "' x2='" + (W - R) + "' y1='" + y(z).toFixed(1) + "' y2='" + y(z).toFixed(1) +
    "' stroke='#ddd'/><text x='" + (L - 4) + "' y='" + (y(z) + 4).toFixed(1) + "' text-anchor='end'>" + Math.round(z) + "</text>"; };
  return "<svg id='dprofsvg' viewBox='0 0 " + W + " " + H + "' preserveAspectRatio='none' style='width:100%;height:120px'>" +
    "<g font-size='11' fill='#555' font-family='system-ui,sans-serif'>" + g(zmax) + g((zmin + zmax) / 2) + g(zmin) +
    "<text x='" + L + "' y='" + (H - 6) + "'>0</text><text x='" + (W - R) + "' y='" + (H - 6) + "' text-anchor='end'>" + fmtDist(D) + "</text></g>" +
    "<path d='" + fill + "' fill='#e1bee7' opacity='0.7'/>" + (opt && opt.slope ? slopeBand(pts, x, H - B) : "") +
    "<path d='" + path + "' fill='none' stroke='#6a1b9a' stroke-width='2'/>" +
    "<line id='dprofcur' x1='0' x2='0' y1='" + T + "' y2='" + (H - B) + "' stroke='#e65100' stroke-width='1.5' visibility='hidden'/></svg>";
}

// a strip along the bottom of the plot coloured by slope class
function slopeBand(pts, x, yb) {
  var out = "", run = null;
  function flush(end) {
    if (run) out += "<rect x='" + x(run.d0).toFixed(1) + "' y='" + (yb - 7) + "' width='" + Math.max(0.5, x(end) - x(run.d0)).toFixed(1) +
      "' height='7' fill='" + SLOPE_CLASSES[run.c][2] + "'/>";
  }
  for (var i = 0; i < pts.length; i++) {
    var c = pts[i].g === null || pts[i].g === undefined ? -1 : slopeClass(pts[i].g);
    if (!run || run.c !== c) { if (run && run.c >= 0) flush(pts[i].d); run = c >= 0 ? { c: c, d0: pts[i].d } : { c: -1, d0: pts[i].d }; }
  }
  if (run && run.c >= 0) flush(pts[pts.length - 1].d);
  return out;
}

function profileCSV(pts) {
  var hasG = pts.some(function (p) { return p.g !== undefined; });
  return "distance_m,lon,lat,easting_mga94_z55,northing_mga94_z55,elevation_m_ahd" + (hasG ? ",grade_pct,grade_deg" : "") + "\n" +
    pts.map(function (p) {
      var row = [p.d.toFixed(1), p.lon.toFixed(6), p.lat.toFixed(6), p.E.toFixed(1), p.N.toFixed(1), p.z === null ? "" : p.z.toFixed(2)];
      if (hasG) row.push(p.g === null || p.g === undefined ? "" : (p.g * 100).toFixed(1),
                         p.g === null || p.g === undefined ? "" : (Math.atan(p.g) * 180 / Math.PI).toFixed(1));
      return row.join(",");
    }).join("\n") + "\n";
}

window.lunamapProfile = { samplePoints: samplePoints, sampleDEM: sampleDEM, profileStats: profileStats,
  profileSVG: profileSVG, profileCSV: profileCSV, credit: DEM_CREDIT,
  slopeStats: slopeStats, slopeClass: slopeClass, fmtGrade: fmtGrade, SLOPE_CLASSES: SLOPE_CLASSES };
