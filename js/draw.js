// lunamap - draw.js (loaded on demand by the Draw button, or at start-up when
// there are saved drawings). Points, lines and polygons with an optional label,
// live length/area, kept on this device, export GeoJSON / KML / GPX, import
// GeoJSON / KML / GPX. Drawing and editing use Leaflet-Geoman (opt-in mode, so
// only drawn shapes are editable - never the map's own overlays).
// ---------------------------------------------------------------------------
var DRAW_KEY = "lunamap.drawings";
var DRAW_STYLE = { color: "#6a1b9a", weight: 3, opacity: 0.95, fillColor: "#8e24aa", fillOpacity: 0.15 };
var POINT_STYLE = { radius: 7, color: "#fff", weight: 2, fillColor: "#6a1b9a", fillOpacity: 1 };
var drawn = L.featureGroup().addTo(map);
var drawOn = false, drawSel = null;
var drawSheet = document.getElementById("drawsheet");

L.PM.setOptIn(true);
// the map was created before Geoman loaded, so attach its map handler by hand
if (!map.pm) map.pm = new L.PM.Map(map);
map.pm.setGlobalOptions({
  pathOptions: L.extend({ pmIgnore: false }, DRAW_STYLE),
  templineStyle: { color: "#6a1b9a" }, hintlineStyle: { color: "#6a1b9a", dashArray: "5,5" },
  snappable: true, snapDistance: 15
});
map.pm.addControls({
  position: "topleft", drawMarker: false, drawCircleMarker: true, drawPolyline: true, drawPolygon: true,
  drawRectangle: false, drawCircle: false, drawText: false, cutPolygon: false, rotateMode: false,
  editMode: true, dragMode: true, removalMode: true
});
map.pm.toggleControls();        // hidden until Draw is switched on

// ---- geometry helpers ----------------------------------------------------
function kindOf(layer) {
  if (layer instanceof L.CircleMarker) return "point";
  if (layer instanceof L.Polygon) return "polygon";
  return "line";
}
function ringAreaM2(ring) {      // spherical polygon area of a [lon, lat] ring
  var R = 6371008.8, r = Math.PI / 180, s = 0;
  for (var i = 0; i < ring.length; i++) {
    var a = ring[i], b = ring[(i + 1) % ring.length];
    s += (b[0] - a[0]) * r * (2 + Math.sin(a[1] * r) + Math.sin(b[1] * r));
  }
  return Math.abs(s * R * R / 2);
}
function fmtArea(m2) {
  return m2 < 10000 ? Math.round(m2) + " m2" : (m2 / 10000).toFixed(m2 < 1e6 ? 2 : 1) + " ha";
}
function llToC(ll) { return [+ll.lng.toFixed(6), +ll.lat.toFixed(6)]; }
function measure(layer) {
  var k = kindOf(layer);
  if (k === "point") {
    var p = layer.getLatLng(), rows = coords(p.lat, p.lng);
    return p.lng.toFixed(6) + ", " + p.lat.toFixed(6) + "  (grid ref " + rows[3].v + ")";
  }
  if (k === "line") {
    var lines = layer.getLatLngs(); if (!Array.isArray(lines[0])) lines = [lines];
    var len = 0; lines.forEach(function (l) { len += lineLen(l.map(llToC)); });
    return "Length " + fmtDist(len);
  }
  var polys = layer.getLatLngs(); if (!Array.isArray(polys[0][0])) polys = [polys];
  var area = 0, perim = 0;
  polys.forEach(function (rings) {
    rings.forEach(function (ring, i) {
      var c = ring.map(llToC); area += (i === 0 ? 1 : -1) * ringAreaM2(c);
      if (i === 0) perim += lineLen(c.concat([c[0]]));
    });
  });
  return "Area " + fmtArea(area) + ", perimeter " + fmtDist(perim);
}

// ---- labels, styling, selection -------------------------------------------
function applyLabel(layer) {
  var lab = (layer.feature && layer.feature.properties.label) || "";
  layer.unbindTooltip();
  if (lab) layer.bindTooltip(lab, { permanent: true, className: "dlab",
    direction: kindOf(layer) === "point" ? "right" : "center", offset: kindOf(layer) === "point" ? [8, 0] : [0, 0] });
}
function adopt(layer, props) {
  layer.feature = layer.feature || { type: "Feature", properties: {} };
  layer.feature.properties = L.extend({ label: "" }, layer.feature.properties, props || {});
  layer.options.pmIgnore = false;
  L.PM.reInitLayer(layer);
  layer.on("click", function (e) {
    lastFeatureClick = Date.now();
    if (map.pm.globalRemovalModeEnabled() || map.pm.globalEditModeEnabled() || map.pm.globalDragModeEnabled()) return;
    if (e.originalEvent) L.DomEvent.stopPropagation(e.originalEvent);
    selectDrawn(layer);
  });
  layer.on("pm:edit pm:dragend pm:markerdragend", function () {
    saveDrawings(); if (drawSel === layer) { clearProfile(); showDrawSheet(); } });
  applyLabel(layer);
  drawn.addLayer(layer);
  return layer;
}
// ---- elevation: profile along a line, height of a point -------------------------
var GEOTIFF_JS = "https://cdn.jsdelivr.net/npm/geotiff@3.0.5/dist-browser/geotiff.js";
var profCursor = L.circleMarker([0, 0], { radius: 6, color: "#fff", weight: 2, fillColor: "#e65100", fillOpacity: 1, interactive: false });
var profData = null, profSeq = 0;
function clearProfile() {
  profSeq++; profData = null;
  document.getElementById("dprof").style.display = "none";
  if (map.hasLayer(profCursor)) map.removeLayer(profCursor);
}
function loadProfileTools() {
  return loadScript(GEOTIFF_JS).then(function () { return loadScript("js/profile.js"); });
}
function lineLonLats(layer) {
  var ll = layer.getLatLngs(); if (Array.isArray(ll[0])) ll = [].concat.apply([], ll);
  return ll.map(function (p) { return [p.lng, p.lat]; });
}
function runProfile() {
  var layer = drawSel; if (!layer) return;
  var k = kindOf(layer), seq = ++profSeq, btn = document.getElementById("dprofile");
  btn.disabled = true; btn.textContent = "Reading elevation...";
  loadProfileTools().then(function () {
    var P = window.lunamapProfile;
    var ll = k === "point" ? [[layer.getLatLng().lng, layer.getLatLng().lat]] : lineLonLats(layer);
    var s = P.samplePoints(ll, 500);
    return P.sampleDEM(s.pts, s.spacing).then(function (info) {
      if (seq !== profSeq || drawSel !== layer) return;
      if (k === "point") {
        var z = s.pts[0].z;
        document.getElementById("dmeasure").textContent = measure(layer) + "  - elevation " + (z === null ? "n/a" : z.toFixed(1) + " m");
        toast(z === null ? "No elevation here (outside the DEM)" : "Elevation " + z.toFixed(1) + " m (AHD)");
        return;
      }
      var st = P.profileStats(s.pts);
      if (!st) { toast("No elevation along this line (outside the DEM)"); return; }
      profData = { pts: s.pts, layer: layer };
      document.getElementById("dprofchart").innerHTML = P.profileSVG(s.pts, st);
      document.getElementById("dprofstats").textContent =
        "Start " + (st.start === null ? "n/a" : Math.round(st.start) + " m") + ", end " + (st.end === null ? "n/a" : Math.round(st.end) + " m") +
        ". Lowest " + Math.round(st.min) + " m, highest " + Math.round(st.max) + " m. Climb +" + Math.round(st.up) +
        " m / -" + Math.round(st.down) + " m. Steepest " + Math.round(st.steep * 100) + "%. Samples every " +
        (s.spacing < 10 ? s.spacing.toFixed(1) + " m" : fmtDist(s.spacing)) + " (" + (info.cell < 2.5 ? "2 m" : Math.round(info.cell) + " m") + " cells).";
      document.getElementById("dprofcredit").textContent = P.credit;
      document.getElementById("dprofread").textContent = "Touch the profile to find a spot on the line";
      document.getElementById("dprof").style.display = "block";
      wireProfileCursor();
    });
  }).catch(function (e) { toast("Elevation unavailable: " + e.message); })
    .then(function () { btn.disabled = false; btn.textContent = kindOf(layer) === "point" ? "Elevation" : "Profile"; });
}
function wireProfileCursor() {
  var svg = document.getElementById("dprofsvg"); if (!svg || !profData) return;
  function at(ev) {
    var r = svg.getBoundingClientRect(), cx = (ev.touches ? ev.touches[0].clientX : ev.clientX) - r.left;
    var vb = 600, L0 = 38, R0 = 8, fx = (cx / r.width * vb - L0) / (vb - L0 - R0);
    var pts = profData.pts, D = pts[pts.length - 1].d, d = Math.max(0, Math.min(1, fx)) * D, best = pts[0];
    pts.forEach(function (p) { if (Math.abs(p.d - d) < Math.abs(best.d - d)) best = p; });
    var cur = document.getElementById("dprofcur"), xv = L0 + (vb - L0 - R0) * (D ? best.d / D : 0);
    cur.setAttribute("x1", xv); cur.setAttribute("x2", xv); cur.setAttribute("visibility", "visible");
    profCursor.setLatLng([best.lat, best.lon]); if (!map.hasLayer(profCursor)) profCursor.addTo(map);
    document.getElementById("dprofread").textContent = fmtDist(best.d) + " along: " + (best.z === null ? "no data" : best.z.toFixed(1) + " m");
    if (ev.cancelable) ev.preventDefault();
  }
  ["mousemove", "touchstart", "touchmove", "click"].forEach(function (t) { svg.addEventListener(t, at, { passive: false }); });
}
document.getElementById("dprofile").onclick = runProfile;
document.getElementById("dprofcsv").onclick = function () {
  if (!profData) return;
  download(window.lunamapProfile.profileCSV(profData.pts), "csv", "text/csv");
};

function selectDrawn(layer) {
  if (layer !== drawSel) clearProfile();
  if (drawSel && drawSel !== layer && drawSel.setStyle) drawSel.setStyle(kindOf(drawSel) === "point" ? POINT_STYLE : DRAW_STYLE);
  drawSel = layer;
  if (layer && layer.setStyle) layer.setStyle(kindOf(layer) === "point" ? { color: "#ffeb3b", weight: 3 } : { color: "#ffb300" });
  if (!drawOn) setDraw(true); else showDrawSheet();
}

// ---- persistence ---------------------------------------------------------
function drawingsGeoJSON() {
  var feats = [];
  drawn.eachLayer(function (l) {
    var g = l.toGeoJSON(6);
    g.properties = { label: (l.feature && l.feature.properties.label) || "", kind: kindOf(l) };
    feats.push(g);
  });
  return { type: "FeatureCollection", features: feats };
}
function saveDrawings() {
  try { localStorage.setItem(DRAW_KEY, JSON.stringify(drawingsGeoJSON())); } catch (e) {}
  refreshDrawCount();
}
function addGeoJSON(gj) {
  var n = 0;
  (gj.features || (gj.type === "Feature" ? [gj] : [])).forEach(function (f) {
    if (!f || !f.geometry) return;
    var p = f.properties || {}, label = p.label || p.name || p.title || p.Name || "";
    var g = f.geometry, t = g.type, c = g.coordinates;
    var swap = function (pt) { return [pt[1], pt[0]]; };
    function add(layer) { adopt(layer, { label: String(label) }); n++; }
    if (t === "Point") add(L.circleMarker(swap(c), POINT_STYLE));
    else if (t === "MultiPoint") c.forEach(function (pt) { add(L.circleMarker(swap(pt), POINT_STYLE)); });
    else if (t === "LineString") add(L.polyline(c.map(swap), DRAW_STYLE));
    else if (t === "MultiLineString") c.forEach(function (l) { add(L.polyline(l.map(swap), DRAW_STYLE)); });
    else if (t === "Polygon") add(L.polygon(c.map(function (r) { return r.map(swap); }), DRAW_STYLE));
    else if (t === "MultiPolygon") c.forEach(function (pg) { add(L.polygon(pg.map(function (r) { return r.map(swap); }), DRAW_STYLE)); });
    else if (t === "GeometryCollection") addGeoJSON({ features: g.geometries.map(function (gg) { return { geometry: gg, properties: p }; }) });
  });
  return n;
}
function loadDrawings() {
  var raw = null; try { raw = localStorage.getItem(DRAW_KEY); } catch (e) {}
  if (raw) { try { addGeoJSON(JSON.parse(raw)); } catch (e) {} }
  refreshDrawCount();
}

// ---- export ----------------------------------------------------------------
function xmlEsc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
function kmlGeom(g) {
  var cs = function (a) { return a.map(function (p) { return p[0] + "," + p[1]; }).join(" "); };
  var ring = function (r, inner) {
    var t = inner ? "innerBoundaryIs" : "outerBoundaryIs";
    return "<" + t + "><LinearRing><coordinates>" + cs(r) + "</coordinates></LinearRing></" + t + ">";
  };
  if (g.type === "Point") return "<Point><coordinates>" + g.coordinates[0] + "," + g.coordinates[1] + "</coordinates></Point>";
  if (g.type === "LineString") return "<LineString><tessellate>1</tessellate><coordinates>" + cs(g.coordinates) + "</coordinates></LineString>";
  if (g.type === "Polygon") return "<Polygon>" + g.coordinates.map(function (r, j) { return ring(r, j > 0); }).join("") + "</Polygon>";
  if (/^Multi/.test(g.type)) return "<MultiGeometry>" + g.coordinates.map(function (part) {
    return kmlGeom({ type: g.type.replace("Multi", ""), coordinates: part }); }).join("") + "</MultiGeometry>";
  return "";
}
function toKML(gj) {
  var pm = gj.features.map(function (f, i) {
    var name = xmlEsc(f.properties.label || (f.properties.kind + " " + (i + 1)));
    return "<Placemark><name>" + name + "</name>" + kmlGeom(f.geometry) + "</Placemark>";
  }).join("\n");
  return '<?xml version="1.0" encoding="UTF-8"?>\n<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>lunamap drawings</name>\n' +
    pm + "\n</Document></kml>\n";
}
function toGPX(gj) {
  var w = [], t = [];
  var pt = function (tag, p) { return "<" + tag + ' lat="' + p[1] + '" lon="' + p[0] + '"/>'; };
  gj.features.forEach(function (f, i) {
    var name = xmlEsc(f.properties.label || (f.properties.kind + " " + (i + 1))), g = f.geometry;
    if (g.type === "Point") w.push('<wpt lat="' + g.coordinates[1] + '" lon="' + g.coordinates[0] + '"><name>' + name + "</name></wpt>");
    var lines = g.type === "LineString" ? [g.coordinates] : g.type === "MultiLineString" ? g.coordinates :
                g.type === "Polygon" ? [g.coordinates[0]] : g.type === "MultiPolygon" ? g.coordinates.map(function (p) { return p[0]; }) : [];
    if (lines.length) t.push("<trk><name>" + name + "</name>" + lines.map(function (l) {
      return "<trkseg>" + l.map(function (p) { return pt("trkpt", p); }).join("") + "</trkseg>"; }).join("") + "</trk>");
  });
  return '<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="lunamap" xmlns="http://www.topografix.com/GPX/1/1">\n' +
    w.concat(t).join("\n") + "\n</gpx>\n";
}
function download(text, ext, mime) {
  var d = new Date(), stamp = d.getFullYear() + pad(d.getMonth() + 1, 2) + pad(d.getDate(), 2);
  var url = URL.createObjectURL(new Blob([text], { type: mime }));
  var a = document.createElement("a"); a.href = url; a.download = "lunamap-" + stamp + "." + ext;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
}
function exportAs(fmt) {
  var gj = drawingsGeoJSON();
  if (!gj.features.length) { toast("Nothing drawn yet"); return; }
  if (fmt === "geojson") download(JSON.stringify(gj, null, 1), "geojson", "application/geo+json");
  else if (fmt === "kml") download(toKML(gj), "kml", "application/vnd.google-earth.kml+xml");
  else download(toGPX(gj), "gpx", "application/gpx+xml");
}

// ---- import ----------------------------------------------------------------
var TOGEOJSON = "https://cdn.jsdelivr.net/npm/@tmcw/togeojson@7.1.2/dist/togeojson.umd.js";
function importFile(file) {
  var name = file.name.toLowerCase();
  file.text().then(function (txt) {
    if (/\.(geo)?json$/.test(name)) return JSON.parse(txt);
    var dom = new DOMParser().parseFromString(txt, "text/xml");
    return loadScript(TOGEOJSON).then(function () {
      if (/\.kml$/.test(name)) return toGeoJSON.kml(dom);
      if (/\.gpx$/.test(name)) return toGeoJSON.gpx(dom);
      throw new Error("use .geojson, .kml or .gpx");
    });
  }).then(function (gj) {
    var before = drawn.getLayers().length, n = addGeoJSON(gj);
    if (!n) { toast("No points, lines or polygons in that file"); return; }
    saveDrawings();
    var b = L.featureGroup(drawn.getLayers().slice(before)).getBounds();
    if (b.isValid()) map.fitBounds(b, { padding: [40, 40], maxZoom: 17 });
    toast("Imported " + n + (n === 1 ? " shape" : " shapes"));
  }).catch(function (e) { toast("Import failed: " + e.message); });
}

// ---- the sheet -------------------------------------------------------------
function refreshDrawCount() {
  var n = drawn.getLayers().length, el = document.getElementById("dcount");
  if (el) el.textContent = n ? n + (n === 1 ? " shape" : " shapes") + " saved on this device" : "Nothing drawn yet";
}
function showDrawSheet() {
  var sel = document.getElementById("dsel");
  if (drawSel && drawn.hasLayer(drawSel)) {
    sel.style.display = "block";
    var k = kindOf(drawSel);
    document.getElementById("dkind").textContent = k.charAt(0).toUpperCase() + k.slice(1);
    if (!profData || profData.layer !== drawSel) document.getElementById("dmeasure").textContent = measure(drawSel);
    var pb = document.getElementById("dprofile");
    pb.style.display = k === "polygon" ? "none" : "block";
    if (!pb.disabled) pb.textContent = k === "point" ? "Elevation" : "Profile";
    var inp = document.getElementById("dlabel");
    if (document.activeElement !== inp) inp.value = drawSel.feature.properties.label || "";
  } else { sel.style.display = "none"; drawSel = null; }
  document.getElementById("dintro").style.display = drawSel ? "none" : "block";   // room for the profile
  refreshDrawCount();
  drawSheet.style.display = "block";
}
function setDraw(on) {
  drawOn = on;
  document.getElementById("draw").classList.toggle("on", on);
  document.body.classList.toggle("drawing", on);
  if (on !== map.pm.controlsVisible()) map.pm.toggleControls();
  if (on) showDrawSheet();
  else {
    map.pm.disableDraw(); map.pm.disableGlobalEditMode(); map.pm.disableGlobalDragMode(); map.pm.disableGlobalRemovalMode();
    if (drawSel && drawSel.setStyle) drawSel.setStyle(kindOf(drawSel) === "point" ? POINT_STYLE : DRAW_STYLE);
    drawSel = null; drawSheet.style.display = "none";
  }
}
window.drawBusy = function () { return drawOn; };
window.toggleDraw = function () { setDraw(!drawOn); };

map.on("pm:create", function (e) {
  var layer = e.layer;
  if (layer instanceof L.CircleMarker) { layer.setStyle(POINT_STYLE); layer.setRadius(POINT_STYLE.radius); }
  adopt(layer); saveDrawings(); selectDrawn(layer);
  var inp = document.getElementById("dlabel"); if (inp) inp.focus();
});
map.on("pm:remove", function (e) {
  if (drawn.hasLayer(e.layer)) drawn.removeLayer(e.layer);
  if (drawSel === e.layer) drawSel = null;
  saveDrawings(); showDrawSheet();
});
map.on("click", function () { if (drawOn && !map.pm.globalDrawModeEnabled() && Date.now() - lastFeatureClick > 300) { selectDrawn(null); } });

document.getElementById("dlabel").addEventListener("input", function () {
  if (!drawSel) return;
  drawSel.feature.properties.label = this.value; applyLabel(drawSel); saveDrawings();
});
document.getElementById("ddelete").onclick = function () {
  if (!drawSel) return; drawn.removeLayer(drawSel); drawSel = null; saveDrawings(); showDrawSheet();
};
document.getElementById("dclose").onclick = function () { setDraw(false); };
document.getElementById("dexp-geojson").onclick = function () { exportAs("geojson"); };
document.getElementById("dexp-kml").onclick = function () { exportAs("kml"); };
document.getElementById("dexp-gpx").onclick = function () { exportAs("gpx"); };
document.getElementById("dimport").onclick = function () { document.getElementById("dfile").click(); };
document.getElementById("dfile").addEventListener("change", function () {
  if (this.files && this.files[0]) importFile(this.files[0]); this.value = "";
});
document.getElementById("dclear").onclick = function () {
  if (!drawn.getLayers().length || !confirm("Delete all drawn shapes on this device?")) return;
  drawn.clearLayers(); drawSel = null; saveDrawings(); showDrawSheet();
};

// ---- sketch in a link ------------------------------------------------------
// The drawings travel in the link as ?s=<code>, with the map view in the hash
// as usual. Code: version "1", "z" (deflate) or "r" (raw), then base64url of
//   per shape: kind (0 point, 1 line, 2 polygon outer ring), vertex count,
//   vertices as zigzag varint deltas at 1e-5 degrees (about 1 m),
//   label as UTF-8 bytes with a length prefix.
function sketchBytes(gj) {
  var out = [], last = [0, 0];
  function uv(n) { while (n > 127) { out.push((n & 127) | 128); n = Math.floor(n / 128); } out.push(n); }
  function sv(n) { uv(n < 0 ? -2 * n - 1 : 2 * n); }
  function pts(a) { uv(a.length); a.forEach(function (p) {
    var x = Math.round(p[0] * 1e5), y = Math.round(p[1] * 1e5); sv(x - last[0]); sv(y - last[1]); last = [x, y]; }); }
  gj.features.forEach(function (f) {
    var g = f.geometry, lab = new TextEncoder().encode(f.properties.label || "");
    if (g.type === "Point") { out.push(0); pts([g.coordinates]); }
    else if (g.type === "LineString") { out.push(1); pts(g.coordinates); }
    else if (g.type === "Polygon") { out.push(2); pts(g.coordinates[0].slice(0, -1)); }
    else return;
    uv(lab.length); for (var i = 0; i < lab.length; i++) out.push(lab[i]);
  });
  return new Uint8Array(out);
}
function sketchFeatures(bytes) {
  var i = 0, last = [0, 0], feats = [];
  function uv() { var n = 0, m = 1, b; do { b = bytes[i++]; if (b === undefined) throw new Error("sketch link is cut short");
    n += (b & 127) * m; m *= 128; } while (b & 128); return n; }
  function sv() { var n = uv(); return n % 2 ? -(n + 1) / 2 : n / 2; }
  function pts() { var n = uv(), a = []; for (var k = 0; k < n; k++) { last = [last[0] + sv(), last[1] + sv()];
    a.push([last[0] / 1e5, last[1] / 1e5]); } return a; }
  while (i < bytes.length) {
    var kind = bytes[i++], c = pts(), ll = uv(), label = new TextDecoder().decode(bytes.slice(i, i + ll)); i += ll;
    var geom = kind === 0 ? { type: "Point", coordinates: c[0] } : kind === 1 ? { type: "LineString", coordinates: c } :
               { type: "Polygon", coordinates: [c.concat([c[0]])] };
    feats.push({ type: "Feature", properties: { label: label }, geometry: geom });
  }
  return { type: "FeatureCollection", features: feats };
}
function b64url(bytes) { var s = ""; for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
function unb64url(t) { var s = atob(t.replace(/-/g, "+").replace(/_/g, "/")), b = new Uint8Array(s.length);
  for (var i = 0; i < s.length; i++) b[i] = s.charCodeAt(i); return b; }
function streamBytes(bytes, stream) {
  return new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer().then(function (ab) { return new Uint8Array(ab); });
}
function encodeSketch(gj) {
  var raw = sketchBytes(gj);
  if (!window.CompressionStream) return Promise.resolve("1r" + b64url(raw));
  return streamBytes(raw, new CompressionStream("deflate-raw")).then(function (z) {
    return z.length < raw.length ? "1z" + b64url(z) : "1r" + b64url(raw);
  });
}
function decodeSketch(code) {
  var v = code.slice(0, 2), bytes = unb64url(code.slice(2));
  if (v === "1r") return Promise.resolve(sketchFeatures(bytes));
  if (v !== "1z") return Promise.reject(new Error("unknown sketch format"));
  if (!window.DecompressionStream) return Promise.reject(new Error("this browser cannot open compressed sketches"));
  return streamBytes(bytes, new DecompressionStream("deflate-raw")).then(sketchFeatures);
}
function shareSketch() {
  var gj = drawingsGeoJSON();
  if (!gj.features.length) { toast("Nothing drawn yet"); return; }
  encodeSketch(gj).then(function (code) {
    var url = location.origin + location.pathname + "?s=" + code + location.hash;
    if (url.length > 8000) { toast("Sketch too big for a link (" + url.length + " characters) - export a file instead"); return; }
    var text = "Map sketch (" + gj.features.length + (gj.features.length === 1 ? " shape)" : " shapes)");
    if (navigator.share) navigator.share({ title: "Map sketch", text: text, url: url }).catch(function () {});
    else copy(url);
  }).catch(function (e) { toast("Could not make the link: " + e.message); });
}
window.receiveSketch = function (code) {
  return decodeSketch(code).then(function (gj) {
    var n = addGeoJSON(gj); saveDrawings();
    toast(n ? "Sketch received: " + n + (n === 1 ? " shape" : " shapes") + " added to your drawings" : "The sketch was empty");
    return n;
  });
};
document.getElementById("dshare").onclick = shareSketch;

loadDrawings();
