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
  layer.on("pm:edit pm:dragend pm:markerdragend", function () { saveDrawings(); if (drawSel === layer) showDrawSheet(); });
  applyLabel(layer);
  drawn.addLayer(layer);
  return layer;
}
function selectDrawn(layer) {
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
    document.getElementById("dmeasure").textContent = measure(drawSel);
    var inp = document.getElementById("dlabel");
    if (document.activeElement !== inp) inp.value = drawSel.feature.properties.label || "";
  } else { sel.style.display = "none"; drawSel = null; }
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

loadDrawings();
