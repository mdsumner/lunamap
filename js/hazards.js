// lunamap - hazards.js: fire danger rating, TasALERT warnings and fire history,
// all from theLIST Public/EmergencyManagementPublic (replicated from BOM, TasALERT
// and TFS/agency fire records). Each is a toggle; when one is on, the pin panel
// also gets a row for the pin.
//   Danger    BOM fire danger rating districts, today (layer 73) on the map;
//             days 0-3 (layers 73-76) in the panel
//   Warnings  TasALERT warnings: points (72) and incident areas (81), refreshed
//             every 5 minutes while on
//   History   fire history, last impacted in 10 seasons (14) drawn by the server
//             from zoom 10; all recorded fires at the pin (1) in the panel
// ---------------------------------------------------------------------------
var EM = LISTPUB + "EmergencyManagementPublic/MapServer/";
var FDR_COL = { "Catastrophic": "#ad0909", "Extreme": "#f78100", "High": "#fedd3a", "Moderate": "#64bf30", "No Rating": "#ffffff" };
map.createPane("hazardPane"); map.getPane("hazardPane").style.zIndex = 380;   // above tiles and parcels, below markers

var HAZ = {
  danger:   { btn: "danger", flag: "fd", on: false, group: L.layerGroup() },
  warnings: { btn: "warnings", flag: "tw", on: false, group: L.layerGroup(), timer: null },
  history:  { btn: "history", flag: "fh", on: false, group: L.layerGroup() }
};
var hazInfo = {}, hazSeq = 0;

function emQuery(layer, params) {
  var q = Object.keys(params).map(function (k) { return k + "=" + encodeURIComponent(params[k]); }).join("&");
  return fetch(EM + layer + "/query?" + q).then(function (r) { return r.json(); }).then(function (j) {
    if (j.error) throw new Error(j.error.message || "query failed"); return j;
  });
}
function atPoint(ll) {
  return { geometry: ll.lng.toFixed(6) + "," + ll.lat.toFixed(6), geometryType: "esriGeometryPoint", inSR: 4326,
           spatialRel: "esriSpatialRelIntersects", returnGeometry: false, f: "json" };
}
function dayName(ms, i) {
  if (!ms) return ["Today", "Tomorrow", "Day 3", "Day 4"][i];
  var d = new Date(ms), now = new Date();
  if (d.toDateString() === now.toDateString()) return "Today";
  return d.toLocaleDateString("en-AU", { weekday: "short" });
}
function fmtDate(ms) { return ms ? new Date(ms).toLocaleDateString("en-AU", { day: "numeric", month: "short", year: "numeric" }) : ""; }
function warnColour(t) { t = String(t || ""); return /emergency/i.test(t) ? "#d50000" : /watch/i.test(t) ? "#ff6d00" : "#ffd600"; }

// ---- Danger ------------------------------------------------------------------
function loadDanger() {
  var h = HAZ.danger;
  emQuery(73, { where: "1=1", outFields: "BOM_NAME,BOM_FIRE_DANGER,BOM_START_TIME_LOCAL", outSR: 4326,
                maxAllowableOffset: 0.003, geometryPrecision: 4, f: "geojson" }).then(function (gj) {
    if (!h.on) return;
    h.group.clearLayers();
    h.group.addLayer(L.geoJSON(gj, { pane: "hazardPane", interactive: false, style: function (f) {
      var c = FDR_COL[f.properties.BOM_FIRE_DANGER] || "#b2b2b2";
      return { color: "#555", weight: 1, opacity: 0.6, fillColor: c, fillOpacity: f.properties.BOM_FIRE_DANGER === "No Rating" ? 0 : 0.28 };
    } }));
    var n = {}; (gj.features || []).forEach(function (f) { var r = f.properties.BOM_FIRE_DANGER; n[r] = (n[r] || 0) + 1; });
    var worst = ["Catastrophic", "Extreme", "High", "Moderate", "No Rating"].filter(function (r) { return n[r]; })[0];
    toast("Fire danger today: " + (worst ? "highest " + worst : "not issued"));
  }).catch(function (e) { toast("Fire danger unavailable: " + e.message); });
}
function lookupDanger(ll, seq) {
  return Promise.all([73, 74, 75, 76].map(function (l) {
    var q = atPoint(ll); q.outFields = "BOM_NAME,BOM_FIRE_DANGER,BOM_START_TIME_LOCAL";
    return emQuery(l, q).then(function (j) { return (j.features || [])[0]; }).catch(function () { return null; });
  })).then(function (fs) {
    if (seq !== hazSeq) return;
    var parts = [], name = null;
    fs.forEach(function (f, i) { if (!f) return; var a = f.attributes; name = name || a.BOM_NAME;
      parts.push(dayName(a.BOM_START_TIME_LOCAL, i) + " " + (a.BOM_FIRE_DANGER || "not issued")); });
    hazInfo.danger = parts.length ? parts.join(", ") + (name ? " (" + name + ")" : "") : "(no rating here)";
  });
}

// ---- Warnings ----------------------------------------------------------------
function warnIcon(col) {
  return L.divIcon({ className: "", iconSize: [20, 20], iconAnchor: [10, 10],
    html: "<div class='wsym' style='width:20px;height:20px;border-radius:50%;background:" + col + ";color:" +
          (col === "#ffd600" ? "#000" : "#fff") + "'><span>!</span></div>" });
}
function loadWarnings() {
  var h = HAZ.warnings;
  Promise.all([
    emQuery(72, { where: "1=1", outFields: "ALERT_TYPE,ALERT_SUMMARY,AREA_DESCRIPTION,EVENT,TASALERT_LINK,EFFECTIVE_FROM_DATE",
                  outSR: 4326, f: "geojson" }),
    emQuery(81, { where: "1=1", outFields: "NAME,TYPE,STATUS,INCIDENT_LEVEL,ADDRESS,UPDATED", outSR: 4326,
                  maxAllowableOffset: 0.0003, geometryPrecision: 5, f: "geojson" })
  ]).then(function (r) {
    if (!h.on) return;
    h.group.clearLayers();
    var pts = r[0].features || [], areas = r[1].features || [];
    h.group.addLayer(L.geoJSON(r[1], { pane: "hazardPane", style: function (f) {
      var c = warnColour(f.properties.INCIDENT_LEVEL); return { color: c, weight: 2, fillColor: c, fillOpacity: 0.15 };
    }, onEachFeature: function (f, lyr) {
      var p = f.properties;
      lyr.on("click", function (e) { pickFeature(e.latlng, { what: joinBits([p.TYPE, p.INCIDENT_LEVEL]) || "TasALERT incident",
        detail: joinBits([p.NAME, p.STATUS, p.ADDRESS, p.UPDATED ? "updated " + fmtDate(p.UPDATED) : null]) }); });
    } }));
    pts.forEach(function (f) {
      if (!f.geometry) return;
      var p = f.properties, c = f.geometry.coordinates, ll = L.latLng(c[1], c[0]);
      var m = L.marker(ll, { icon: warnIcon(warnColour(p.ALERT_TYPE)), zIndexOffset: 400,
                             title: joinBits([p.ALERT_TYPE, p.AREA_DESCRIPTION]) });
      m.on("click", function () { pickFeature(ll, { what: p.ALERT_TYPE || "TasALERT warning",
        detail: joinBits([p.EVENT, p.AREA_DESCRIPTION, p.ALERT_SUMMARY]) }); });
      h.group.addLayer(m);
    });
    var n = pts.length + areas.length;
    toast(n ? n + " TasALERT warning" + (n === 1 ? "" : "s") + " statewide - check alert.tas.gov.au" : "No current TasALERT warnings");
  }).catch(function (e) { toast("Warnings unavailable: " + e.message); });
}

// ---- Fire history ----------------------------------------------------------------
var HistoryTiles = L.TileLayer.extend({
  getTileUrl: function (c) {
    var ts = this.getTileSize(), nw = c.scaleBy(ts), se = nw.add(ts);
    var a = L.CRS.EPSG3857.project(this._map.unproject(nw, c.z)), b = L.CRS.EPSG3857.project(this._map.unproject(se, c.z));
    return EM + "export?bbox=" + [a.x, b.y, b.x, a.y].map(function (v) { return v.toFixed(2); }).join(",") +
      "&bboxSR=3857&imageSR=3857&size=" + ts.x + "," + ts.y + "&format=png32&transparent=true&layers=show:14&dpi=96&f=image";
  }
});
HAZ.history.group.addLayer(new HistoryTiles("", { tileSize: 512, minZoom: 10, maxZoom: 19, zIndex: 4, opacity: 0.45,
  attribution: "Fire history &copy; State of Tasmania" }));
function lookupHistory(ll, seq) {
  var q = atPoint(ll); q.outFields = "FIRE_NAME,FIRE_TYPE,IGN_DATE,IGN_SEASON,FIRE_AR_HA";
  return emQuery(1, q).then(function (j) {
    if (seq !== hazSeq) return;
    var fs = (j.features || []).map(function (f) { return f.attributes; })
      .sort(function (x, y) { return (y.IGN_DATE || 0) - (x.IGN_DATE || 0); });
    hazInfo.history = fs.length ? fs.slice(0, 4).map(function (a) {
      var yr = a.IGN_DATE ? new Date(a.IGN_DATE).getFullYear() : (a.IGN_SEASON || "?");
      return yr + " " + (a.FIRE_TYPE || "fire") + (a.FIRE_NAME ? " '" + titleCase(a.FIRE_NAME) + "'" : "") +
             (a.FIRE_AR_HA ? " (" + Math.round(a.FIRE_AR_HA).toLocaleString("en-AU") + " ha)" : "");
    }).join("; ") + (fs.length > 4 ? "; and " + (fs.length - 4) + " earlier" : "") : "(no fires recorded here)";
  }).catch(function () { if (seq === hazSeq) hazInfo.history = "(lookup failed)"; });
}

// ---- panel + toggles -------------------------------------------------------------
function lookupHazards(ll) {
  var seq = ++hazSeq; hazInfo = {};
  var jobs = [];
  if (HAZ.danger.on) { hazInfo.danger = "..."; jobs.push(lookupDanger(ll, seq)); }
  if (HAZ.history.on) { hazInfo.history = "..."; jobs.push(lookupHistory(ll, seq)); }
  if (!jobs.length) return;
  Promise.all(jobs).then(function () { if (seq === hazSeq && pin) showCoords(pin.getLatLng()); });
}
function hazardRows() {
  var rows = [];
  if (HAZ.danger.on && hazInfo.danger) rows.push({ k: "Fire danger", v: hazInfo.danger });
  if (HAZ.history.on && hazInfo.history) rows.push({ k: "Fire history", v: hazInfo.history });
  return rows;
}
function hazardFlags() {
  return Object.keys(HAZ).map(function (k) { return HAZ[k].on ? "," + HAZ[k].flag : ""; }).join("");
}
function setHazard(name, on) {
  var h = HAZ[name]; h.on = on;
  document.getElementById(h.btn).classList.toggle("on", on);
  if (on) {
    h.group.addTo(map);
    if (name === "danger") loadDanger();
    if (name === "warnings") { loadWarnings(); h.timer = setInterval(loadWarnings, 5 * 60 * 1000); }
    if (name === "history" && map.getZoom() < 10) toast("Fire history shows from zoom 10 - tap the map for the record at a spot");
  } else {
    map.removeLayer(h.group);
    if (name !== "history") h.group.clearLayers();
    if (h.timer) { clearInterval(h.timer); h.timer = null; }
  }
  if (pin) lookupHazards(pin.getLatLng());
  if (pin) showCoords(pin.getLatLng());
  writeHash();
}
Object.keys(HAZ).forEach(function (k) {
  document.getElementById(HAZ[k].btn).onclick = function () { setHazard(k, !HAZ[k].on); };
});
