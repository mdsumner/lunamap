// lunamap - layers.js (classic script; shares globals with the other js/ files, loaded in order)
// ---------------------------------------------------------------------------
// Cadastral parcels (theLIST Public/CadastreParcels, which already carries the
// property address on each parcel).
//   zoom >= 15  parcel outlines, drawn by the server (export as 512 px tiles)
//   zoom 18     house numbers, zoom 19 street address, at each parcel's centroid
//   any zoom    tapping a point looks up the parcel under the pin
// ---------------------------------------------------------------------------
var CAD = "https://services.thelist.tas.gov.au/arcgis/rest/services/Public/CadastreParcels/MapServer";
var parcelsOn = true, parcelInfo = null, parcelSeq = 0;
var parcelsBtn = document.getElementById("parcels");

var ExportTiles = L.TileLayer.extend({
  getTileUrl: function (c) {
    var ts = this.getTileSize(), nw = c.scaleBy(ts), se = nw.add(ts);
    var a = L.CRS.EPSG3857.project(this._map.unproject(nw, c.z)),
        b = L.CRS.EPSG3857.project(this._map.unproject(se, c.z));
    return CAD + "/export?bbox=" + [a.x, b.y, b.x, a.y].map(function (v) { return v.toFixed(2); }).join(",") +
      "&bboxSR=3857&imageSR=3857&size=" + ts.x + "," + ts.y +
      "&format=png32&transparent=true&dpi=96&f=image&dynamicLayers=" + encodeURIComponent(parcelStyle());
  }
});
// outline colour per basemap: near-white on the aerial photo, dark elsewhere
function parcelStyle() {
  var col = sel.value === "ortho" ? [255, 255, 255, 230] : [40, 40, 40, 220];
  return JSON.stringify([{ id: 0, source: { type: "mapLayer", mapLayerId: 0 }, drawingInfo: { renderer: {
    type: "simple", symbol: { type: "esriSFS", style: "esriSFSNull",
      outline: { type: "esriSLS", style: "esriSLSSolid", color: col, width: sel.value === "ortho" ? 1.2 : 1 } } } } }]);
}
var parcelTiles = new ExportTiles("", { tileSize: 512, minZoom: 15, maxZoom: 19, zIndex: 5, opacity: 0.9,
  attribution: "Parcels &copy; State of Tasmania, theLIST" });
var parcelLabels = L.layerGroup(), parcelHi = L.layerGroup().addTo(map);
var labelCache = {}, labelAbort = null;

function shortNumber(a) {           // "123-123A LIVERPOOL ST" -> "123-123A"
  var m = /^\s*([0-9][0-9A-Z\/\-]*)\s/.exec(a || ""); return m ? m[1] : null;
}
function ringCentroid(r) {          // area centroid of a lon/lat ring; falls back to vertex mean
  var A = 0, x = 0, y = 0;
  for (var i = 0, j = r.length - 1; i < r.length; j = i++) {
    var f = r[j][0] * r[i][1] - r[i][0] * r[j][1];
    A += f; x += (r[j][0] + r[i][0]) * f; y += (r[j][1] + r[i][1]) * f;
  }
  if (Math.abs(A) < 1e-14) {
    r.forEach(function (p) { x += p[0]; y += p[1]; }); return [x / r.length, y / r.length];
  }
  return [x / (3 * A), y / (3 * A)];
}
function ringArea(r) { var A = 0; for (var i = 0, j = r.length - 1; i < r.length; j = i++) A += r[j][0] * r[i][1] - r[i][0] * r[j][1]; return Math.abs(A); }
function labelPoint(geom) {
  var rings = geom.type === "Polygon" ? [geom.coordinates[0]] :
              geom.type === "MultiPolygon" ? geom.coordinates.map(function (p) { return p[0]; }) : [];
  if (!rings.length) return null;
  rings.sort(function (a, b) { return ringArea(b) - ringArea(a); });
  var c = ringCentroid(rings[0]); return L.latLng(c[1], c[0]);
}

function refreshParcelLabels() {
  parcelLabels.clearLayers();
  var z = map.getZoom();
  if (!overlayWanted() || z < 18) return;
  var b = map.getBounds();
  if (labelAbort) labelAbort.abort();
  labelAbort = window.AbortController ? new AbortController() : null;
  var url = CAD + "/0/query?geometry=" + [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].map(function (v) { return v.toFixed(6); }).join(",") +
    "&geometryType=esriGeometryEnvelope&inSR=4326&outSR=4326&spatialRel=esriSpatialRelIntersects" +
    "&outFields=OBJECTID,PROP_ADD1&returnGeometry=true&maxAllowableOffset=0.00001&geometryPrecision=6&f=geojson";
  fetch(url, labelAbort ? { signal: labelAbort.signal } : {}).then(function (r) { return r.json(); }).then(function (gj) {
    parcelLabels.clearLayers();
    var z2 = map.getZoom();
    (gj.features || []).forEach(function (ft) {
      var a = ft.properties && ft.properties.PROP_ADD1; if (!a) return;
      var id = ft.properties.OBJECTID;
      var p = labelCache[id] || (labelCache[id] = labelPoint(ft.geometry)); if (!p) return;
      var txt = z2 >= 19 ? a : shortNumber(a); if (!txt) return;
      var d = document.createElement("div"); d.textContent = txt;
      parcelLabels.addLayer(L.marker(p, { interactive: false, keyboard: false,
        icon: L.divIcon({ className: "", iconSize: null, html: "<div class='plab'>" + d.innerHTML + "</div>" }) }));
    });
  }).catch(function () {});
}

function lookupParcel(ll) {
  var seq = ++parcelSeq; parcelHi.clearLayers();
  if (!parcelsOn) return;
  var url = CAD + "/0/query?geometry=" + ll.lng.toFixed(7) + "," + ll.lat.toFixed(7) +
    "&geometryType=esriGeometryPoint&inSR=4326&outSR=4326&spatialRel=esriSpatialRelIntersects" +
    "&outFields=PID,VOLUME,FOLIO,CAD_TYPE1,TENURE_TY,FEAT_NAME,PROP_NAME,PROP_ADD,PROP_ADD2,COMP_AREA" +
    "&returnGeometry=true&geometryPrecision=7&f=geojson";
  fetch(url).then(function (r) { return r.json(); }).then(function (gj) {
    if (seq !== parcelSeq || !pin) return;
    var ft = (gj.features || [])[0];
    parcelInfo = ft ? ft.properties : { none: true };
    if (ft) { parcelHi.addLayer(L.geoJSON(ft, { interactive: false, style: parcelHiStyle() })); }
    showCoords(pin.getLatLng());
  }).catch(function () {
    if (seq !== parcelSeq || !pin) return;
    parcelInfo = { failed: true }; showCoords(pin.getLatLng());
  });
}

// parcel outline: orange normally, thick grey dashed while a route (also
// orange-red) is on the map so the two are easy to tell apart
function parcelHiStyle() {
  return (typeof routeInfo !== "undefined" && routeInfo && routeInfo.ok) ?
    { color: "#555", weight: 5, opacity: 0.85, dashArray: "10 8", fill: true, fillColor: "#777", fillOpacity: 0.06 } :
    { color: "#e65100", weight: 3, opacity: 1, dashArray: null, fill: true, fillColor: "#e65100", fillOpacity: 0.08 };
}
function restyleParcelHi() { parcelHi.eachLayer(function (g) { if (g.setStyle) g.setStyle(parcelHiStyle()); }); }
function parcelRows() {
  if (!parcelsOn || !parcelInfo) return [];
  if (parcelInfo.failed) return [{ k: "Address", v: "(parcel lookup failed)" }];
  if (parcelInfo.none) return [{ k: "Address", v: "(no parcel here)" }];
  var p = parcelInfo, rows = [];
  var name = p.PROP_NAME || p.FEAT_NAME;
  rows.push({ k: "Address", v: p.PROP_ADD || name || "(no address)" });
  if (name && p.PROP_ADD) rows.push({ k: "Name", v: name, extra: true });
  if (p.VOLUME) rows.push({ k: "Title", v: p.VOLUME + "/" + p.FOLIO, extra: true });
  if (p.PID) rows.push({ k: "PID", v: String(p.PID), extra: true });
  var t = [p.CAD_TYPE1, p.TENURE_TY].filter(function (x) { return x; }).join(", ");
  if (t) rows.push({ k: "Parcel", v: t, extra: true });
  if (p.COMP_AREA) rows.push({ k: "Area", v: p.COMP_AREA >= 10000 ? (p.COMP_AREA / 10000).toFixed(2) + " ha" :
    Math.round(p.COMP_AREA) + " m2", extra: true });
  return rows;
}

function overlayWanted() { return parcelsOn; }
function syncParcelOverlay() {
  map.getContainer().classList.toggle("on-ortho", sel.value === "ortho");
  if (map.hasLayer(parcelTiles)) parcelTiles.redraw();
  if (overlayWanted()) {
    if (!map.hasLayer(parcelTiles)) parcelTiles.addTo(map);
    if (!map.hasLayer(parcelLabels)) parcelLabels.addTo(map);
    refreshParcelLabels();
  } else { map.removeLayer(parcelTiles); map.removeLayer(parcelLabels); parcelLabels.clearLayers(); }
}
function setParcels(on) {
  parcelsOn = on; parcelsBtn.classList.toggle("on", on);
  syncParcelOverlay();
  if (on) { if (pin) lookupParcel(pin.getLatLng()); }
  else { parcelHi.clearLayers(); parcelInfo = null; if (pin) showCoords(pin.getLatLng()); }
  writeHash();
}
parcelsBtn.onclick = function () { setParcels(!parcelsOn); };
map.on("moveend", refreshParcelLabels);

// ---------------------------------------------------------------------------
// Point/polygon overlays fetched for the view as GeoJSON from theLIST.
// Tapping a symbol pins it and names it in the panel ("Feature" row).
//   Water: TasWater hydrants and network structures (dams, reservoirs, tanks,
//          pump stations, treatment plants), Tas Irrigation dams and pumps
//   Gates: gates and barriers from the Transport Node dataset
// ---------------------------------------------------------------------------
var LISTPUB = "https://services.thelist.tas.gov.au/arcgis/rest/services/Public/";
var TW_TYPES = { 1: ["Break pressure tank", "B"], 2: ["Tank", "T"], 3: ["Treatment plant", "W"], 5: ["Treatment plant", "W"],
  6: ["Dosing facility", "X"], 8: ["Pump station", "P"], 9: ["Pump station", "P"], 10: ["Pump station", "P"],
  11: ["Reservoir", "R"], 12: ["Dam (storage)", "D"] };
var GATE_SYM = { "GATE": "G", "BOOM GATE": "B", "BOLLARD": "o", "FENCE BARRIER": "F", "IMMOVABLE BARRIER": "X",
  "REMOVABLE BARRIER": "R", "STOCK GRID": "#", "UNKNOWN BARRIER": "?" };
function titleCase(t) { return String(t || "").toLowerCase().replace(/\b[a-z]/g, function (c) { return c.toUpperCase(); }); }
function joinBits(a) { return a.filter(function (x) { return x && String(x).trim(); }).join(", "); }

var OVERLAYS = {
  water: { flag: "w", btn: "water", layers: [
    { url: "Infrastructure/MapServer/2", minZoom: 16, fields: "OBJECTID,ASSETID", kind: "hyd",
      describe: function (p) { return { what: "TasWater hydrant", sym: "H", detail: p.ASSETID ? "Asset " + p.ASSETID : "" }; } },
    { url: "Infrastructure/MapServer/9", minZoom: 12, fields: "OBJECTID,NAME,SUBTYPECD,D_SUBTYPEC", kind: "tw",
      describe: function (p) { var t = TW_TYPES[p.SUBTYPECD] || [p.D_SUBTYPEC || "Structure", "?"];
        return { what: "TasWater " + t[0].toLowerCase(), sym: t[1], detail: p.NAME || "" }; } },
    { url: "Infrastructure/MapServer/26", minZoom: 11, fields: "OBJECTID,NAME,SCHEME", kind: "ti",
      describe: function (p) { return { what: "Tas Irrigation pump station", sym: "P", detail: joinBits([p.NAME, p.SCHEME]) }; } },
    { url: "Infrastructure/MapServer/35", minZoom: 11, fields: "OBJECTID,DAMNAME,RESERVOIRNAME,VOLUME,SCHEME", kind: "ti", polygon: true,
      describe: function (p) { return { what: "Tas Irrigation dam", sym: "D",
        detail: joinBits([p.DAMNAME || p.RESERVOIRNAME, p.VOLUME ? p.VOLUME + " ML" : null, p.SCHEME]) }; } }
  ] },
  stations: { flag: "s", btn: "stations", layers: [
    { url: "EmergencyManagementPublic/MapServer/6", minZoom: 8, kind: "fire",
      fields: "OBJECTID,BRIGADE,BRIG_NUMBER,STATION_TYPE,DISTRICT,ADDRESS",
      describe: function (p) { return { what: "Fire station", sym: "F",
        detail: joinBits([p.BRIGADE ? titleCase(p.BRIGADE) + (/brigade/i.test(p.BRIGADE) ? "" : " brigade") : null,
                          p.STATION_TYPE, p.ADDRESS]) }; } },
    { url: "EmergencyManagementPublic/MapServer/4", minZoom: 8, kind: "amb",
      fields: "OBJECTID,STATION,STATION_TYPE,ADDRESS",
      describe: function (p) { return { what: "Ambulance station", sym: "A", detail: joinBits([p.STATION, p.STATION_TYPE, p.ADDRESS]) }; } },
    { url: "EmergencyManagementPublic/MapServer/5", minZoom: 8, kind: "pol",
      fields: "OBJECTID,STATION,STATION_TYPE,SITE_ADDRESS",
      describe: function (p) { return { what: "Police station", sym: "P", detail: joinBits([p.STATION, p.STATION_TYPE, p.SITE_ADDRESS]) }; } },
    { url: "EmergencyManagementPublic/MapServer/20", minZoom: 10, kind: "emp",
      fields: "OBJECTID,EMP_NAME,EMP_NO,LOC_DESC,HELI_ACCESS,GSM,NEXTG",
      describe: function (p) { return { what: "Emergency meeting point", sym: "M",
        detail: joinBits([p.EMP_NAME, p.EMP_NO ? "EMP " + p.EMP_NO : null, p.LOC_DESC,
                          p.HELI_ACCESS ? "helicopter: " + p.HELI_ACCESS : null,
                          (p.GSM || p.NEXTG) ? "mobile: " + joinBits([p.GSM, p.NEXTG]) : null]) }; } },
    { url: "EmergencyManagementPublic/MapServer/63", minZoom: 6, kind: "evac",
      fields: "OBJECTID,FACILTY_NAME,FACILTY_ADDRESS,STATUS_PETS",
      describe: function (p) { return { what: "Evacuation centre (activated)", sym: "E",
        detail: joinBits([p.FACILTY_NAME, p.FACILTY_ADDRESS, p.STATUS_PETS ? "pets: " + p.STATUS_PETS : null]) }; } },
    { url: "EmergencyManagementPublic/MapServer/7", minZoom: 8, kind: "ses",
      fields: "OBJECTID,SITE_NAME,UNIT,SITE_ADDRESS",
      describe: function (p) { return { what: "SES", sym: "S", detail: joinBits([p.UNIT || p.SITE_NAME, p.SITE_ADDRESS]) }; } }
  ] },
  gates: { flag: "b", btn: "gates", layers: [
    { url: "TopographyAndRelief/MapServer/59", minZoom: 13, kind: "gate",
      fields: "OBJECTID,BARRIER_TY,STATUS,AUTHORITY,PRI_NAME,SEC_NAME",
      describe: function (p) { var t = String(p.BARRIER_TY || "Unknown Barrier").toUpperCase();
        return { what: titleCase(t), sym: GATE_SYM[t] || "?",
          detail: joinBits([p.PRI_NAME, p.SEC_NAME, p.STATUS && p.STATUS !== "Unknown" ? p.STATUS : null, p.AUTHORITY]) }; } }
  ] }
};

var featureInfo = null;
function featureRows() {
  if (!featureInfo) return [];
  return [{ k: "Feature", v: featureInfo.what + (featureInfo.detail ? " - " + featureInfo.detail : "") }];
}
function pickFeature(ll, info) {
  lastFeatureClick = Date.now();
  setPin(ll); featureInfo = info; showCoords(ll);
}
function symIcon(kind, sym) {
  var sz = kind === "hyd" ? 16 : 18;
  return L.divIcon({ className: "", iconSize: [sz, sz], iconAnchor: [sz / 2, sz / 2],
    html: "<div class='wsym " + kind + "' style='width:" + sz + "px;height:" + sz + "px'><span>" + sym + "</span></div>" });
}

Object.keys(OVERLAYS).forEach(function (name) {
  var o = OVERLAYS[name];
  o.on = false; o.group = L.layerGroup(); o.button = document.getElementById(o.btn);
  o.layers.forEach(function (w) { w.seen = {}; w.group = L.layerGroup().addTo(o.group); });
  o.button.onclick = function () { setOverlay(name, !o.on); };
});

function refreshOverlay(o) {
  if (!o.on) return;
  var z = map.getZoom(), b = map.getBounds().pad(0.2);
  var env = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].map(function (v) { return v.toFixed(6); }).join(",");
  o.layers.forEach(function (w) {
    if (z < w.minZoom) { w.group.clearLayers(); w.seen = {}; return; }
    var url = LISTPUB + w.url + "/query?geometry=" + env + "&geometryType=esriGeometryEnvelope&inSR=4326&outSR=4326" +
      "&spatialRel=esriSpatialRelIntersects&outFields=" + w.fields + "&returnGeometry=true" +
      (w.polygon ? "&maxAllowableOffset=0.00002" : "") + "&geometryPrecision=6&f=geojson";
    fetch(url).then(function (r) { return r.json(); }).then(function (gj) {
      if (!o.on || map.getZoom() < w.minZoom) return;
      (gj.features || []).forEach(function (ft) {
        var p = ft.properties || {}, key = p.OBJECTID != null ? p.OBJECTID : JSON.stringify(ft.geometry).slice(0, 80);
        if (w.seen[key] || !ft.geometry) return;
        w.seen[key] = true;
        var info = w.describe(p), lyr;
        if (w.polygon) {
          lyr = L.geoJSON(ft, { style: { color: "#00796b", weight: 2, fillColor: "#4db6ac", fillOpacity: 0.25 } });
          var c = labelPoint(ft.geometry);
          lyr.on("click", function (e) { pickFeature(c || e.latlng, info); });
        } else {
          var g = ft.geometry.type === "MultiPoint" ? ft.geometry.coordinates[0] : ft.geometry.coordinates;
          var ll = L.latLng(g[1], g[0]);
          lyr = L.marker(ll, { icon: symIcon(w.kind, info.sym), title: info.what + (info.detail ? " - " + info.detail : ""),
                               zIndexOffset: w.kind === "hyd" ? 0 : (/^(fire|amb|pol|ses|emp|evac)$/.test(w.kind) ? 300 : 100) });
          lyr.on("click", function () { pickFeature(ll, info); });
        }
        w.group.addLayer(lyr);
      });
    }).catch(function () {});
  });
}
function setOverlay(name, on) {
  var o = OVERLAYS[name];
  o.on = on; o.button.classList.toggle("on", on);
  if (on) { o.group.addTo(map); refreshOverlay(o); }
  else { map.removeLayer(o.group); o.layers.forEach(function (w) { w.group.clearLayers(); w.seen = {}; }); }
  if (name === "stations" && pin && typeof lookupExtras === "function") lookupExtras(pin.getLatLng());
  writeHash();
}
map.on("moveend", function () { Object.keys(OVERLAYS).forEach(function (n) { refreshOverlay(OVERLAYS[n]); }); });

// ---------------------------------------------------------------------------
// Street atlas and map book references (theLIST SearchService).
//   Street atlas: pages layer 5, grid layer 6, MAPREF "SA188B6" or "SA226EB6"
//                 (page, optional page suffix E/W/T, square); shown "SA-188-B6"
//   Map book:     pages layer 1, grid layer 2, MAPREF "MB356C4"; shown "MB356 C4"
// ---------------------------------------------------------------------------
var SEARCH = LISTPUB + "SearchService/MapServer/";
var BOOKS = {
  SA: { name: "Street atlas", page: 5, grid: 6 },
  MB: { name: "Map book", page: 1, grid: 2 }
};
var refInfo = { SA: null, MB: null }, refSeq = 0, mbOutline = L.layerGroup().addTo(map);
function fmtMapref(r) {
  var m = /^SA(\d+)([EWT]?)([A-Z])(\d+)$/.exec(r || "");
  if (m) return "SA-" + m[1] + m[2] + "-" + m[3] + m[4];
  m = /^SA(\d+[A-Z]?)$/.exec(r || ""); if (m) return "SA-" + m[1];
  m = /^MB(\d+)([A-Z]+)(\d+)$/.exec(r || ""); if (m) return "MB" + m[1] + " " + m[2] + m[3];
  return r;
}
function lookupMapbook(ll) {
  var seq = ++refSeq;
  refInfo = { SA: null, MB: null };
  Object.keys(BOOKS).forEach(function (k) {
    var url = SEARCH + BOOKS[k].grid + "/query?geometry=" + ll.lng.toFixed(7) + "," + ll.lat.toFixed(7) +
      "&geometryType=esriGeometryPoint&inSR=4326&spatialRel=esriSpatialRelIntersects&outFields=MAPREF&returnGeometry=false&f=json";
    fetch(url).then(function (r) { return r.json(); }).then(function (j) {
      if (seq !== refSeq || !pin) return;
      var f = (j.features || [])[0];
      refInfo[k] = f ? fmtMapref(f.attributes.MAPREF) : "(outside " + BOOKS[k].name.toLowerCase() + ")";
      showCoords(pin.getLatLng());
    }).catch(function () { if (seq === refSeq && pin) { refInfo[k] = "(lookup failed)"; showCoords(pin.getLatLng()); } });
  });
}
function mapbookRows() {
  var rows = [];
  if (refInfo.SA) rows.push({ k: "Street atlas", v: refInfo.SA });
  if (refInfo.MB) rows.push({ k: "Map book", v: refInfo.MB });
  return rows;
}

// Street atlas: "SA-188-B6", "SA188B6", "sa 188 b6", "SA 226E B6"; "SA188" = page
// Map book:     "MB356 C4", "356C4", "356 c4", "mb 356 c 4";          "MB356" = page
function parseMapbook(q) {
  var t = String(q).split(/\r?\n/)[0].replace(/^\s*(map\s*book|street\s*atlas)\s*:/i, "").trim().toUpperCase();
  var m = /^SA[\s\-]*(\d{1,3})[\s\-]*([EWT]?)[\s\-]*([A-Z])[\s\-]*(\d{1,2})$/.exec(t);
  if (m) {
    var refs = ["SA" + m[1] + m[2] + m[3] + m[4]];
    refs.push("SA" + pad(m[1], 3) + m[2] + m[3] + m[4]);           // zero-padded page, just in case
    return { book: "SA", layer: BOOKS.SA.grid, refs: refs, page: false };
  }
  m = /^SA[\s\-]*(\d{1,3})[\s\-]*([EWT]?)$/.exec(t);
  if (m) return { book: "SA", layer: BOOKS.SA.page, refs: ["SA" + m[1] + m[2], "SA" + pad(m[1], 3) + m[2]], page: true };
  m = /^MB[\s\-]*(\d{1,3})[\s\-]*([A-Z])[\s\-]*(\d{1,2})$/.exec(t) || /^(\d{1,3})\s*([A-Z])\s*(\d{1,2})$/.exec(t);
  if (m) return { book: "MB", layer: BOOKS.MB.grid, refs: ["MB" + m[1] + m[2] + m[3], "MB" + pad(m[1], 3) + m[2] + m[3]], page: false };
  m = /^MB[\s\-]*(\d{1,3})$/.exec(t);
  if (m) return { book: "MB", layer: BOOKS.MB.page, refs: ["MB" + m[1], "MB" + pad(m[1], 3)], page: true };
  return null;
}
function findMapbook(mb) {
  var where = "MAPREF IN (" + mb.refs.map(function (r) { return "'" + r + "'"; }).join(",") + ")";
  var url = SEARCH + mb.layer + "/query?where=" + encodeURIComponent(where) +
    "&outFields=MAPREF&returnGeometry=true&outSR=4326&f=geojson";
  return fetch(url).then(function (r) { return r.json(); }).then(function (gj) { return (gj.features || [])[0] || null; });
}
