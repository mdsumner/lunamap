// lunamap - core.js (classic script; shares globals with the other js/ files, loaded in order)
// ---------------------------------------------------------------------------
// Basemaps: theLIST ArcGIS tile caches (Web Mercator, standard XYZ 256px)
// ---------------------------------------------------------------------------
var LIST = "https://services.thelist.tas.gov.au/arcgis/rest/services/Basemaps/";
var CC_BY = "CC BY 3.0 AU";
var CC_NC = "CC BY-NC-ND 3.0 AU";
var BASEMAPS = [
  { id: "topo",   name: "Topographic",              svc: "Topographic",          max: 18, lic: CC_BY },
  { id: "esmb",   name: "Emergency Services 1:50k", svc: "ESgisMapBookPUBLIC",   max: 15, lic: "" },
  { id: "tasmap", name: "TASMAP raster",            svc: "TasmapRaster",         max: 16, lic: CC_NC },
  { id: "ortho",  name: "Aerial photo",             svc: "Orthophoto",           max: 19, lic: CC_NC },
  { id: "hill",   name: "Hillshade",                svc: "Hillshade",            max: 18, lic: CC_BY },
  { id: "grey",   name: "Topographic (grey)",       svc: "TopographicGrayScale", max: 18, lic: CC_BY }
];

// ---------------------------------------------------------------------------
// Projections. GDA2020 is treated as equal to WGS84/GPS (sub-metre, fine for this).
// MGA94 uses the ICSM 7-parameter GDA2020->GDA94 transformation (agrees with
// PROJ to ~0.15 m; the full NTv2 distortion grid is not applied).
// ---------------------------------------------------------------------------
function mgaDefs(zone) {
  return {
    mga2020: "+proj=utm +zone=" + zone + " +south +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs",
    mga94:   "+proj=utm +zone=" + zone + " +south +ellps=GRS80 " +
             "+towgs84=-0.06155,0.01087,0.04019,0.0394924,0.0327221,0.0328979,0.009994 +units=m +no_defs"
  };
}
var DEG = "\u00b0";

function pad(n, w) { var s = String(n); while (s.length < w) s = "0" + s; return s; }

function fmtDMS(v, pos, neg) {
  var h = v < 0 ? neg : pos; v = Math.abs(v);
  var d = Math.floor(v), mf = (v - d) * 60, m = Math.floor(mf), s = (mf - m) * 60;
  if (s >= 59.95) { s = 0; m += 1; } if (m >= 60) { m = 0; d += 1; }
  return d + DEG + " " + pad(m, 2) + "' " + (s < 10 ? "0" : "") + s.toFixed(1) + "\" " + h;
}
function fmtDDM(v, pos, neg) {
  var h = v < 0 ? neg : pos; v = Math.abs(v);
  var d = Math.floor(v), m = (v - d) * 60;
  if (m >= 59.9995) { m = 0; d += 1; }
  return d + DEG + " " + (m < 10 ? "0" : "") + m.toFixed(3) + "' " + h;
}

function coords(lat, lon) {
  var zone = Math.floor((lon + 180) / 6) + 1;
  var d = mgaDefs(zone);
  var g20 = proj4("EPSG:4326", d.mga2020, [lon, lat]);
  var g94 = proj4("EPSG:4326", d.mga94, [lon, lat]);
  // 6-figure grid reference: 100 m digits of easting and northing (MGA2020)
  var gr = pad(Math.floor(g20[0] / 100) % 1000, 3) + " " + pad(Math.floor(g20[1] / 100) % 1000, 3);
  return [
    { k: "Lon, Lat",   v: lon.toFixed(6) + ", " + lat.toFixed(6) },
    { k: "Lat, Lon",   v: lat.toFixed(6) + ", " + lon.toFixed(6) },
    { k: "MGA94 z" + zone,   v: Math.round(g94[0]) + " E  " + Math.round(g94[1]) + " N" },
    { k: "Grid ref",   v: gr },
    { k: "MGA2020 z" + zone, v: Math.round(g20[0]) + " E  " + Math.round(g20[1]) + " N", extra: true },
    { k: "DMS",        v: fmtDMS(lat, "N", "S") + "  " + fmtDMS(lon, "E", "W"), extra: true },
    { k: "Deg min",    v: fmtDDM(lat, "N", "S") + "  " + fmtDDM(lon, "E", "W"), extra: true }
  ];
}

// ---------------------------------------------------------------------------
// State in the URL hash: #z/lat/lon/layer[/pinlat/pinlon]
// ---------------------------------------------------------------------------
function readHash() {
  var p = location.hash.replace(/^#/, "").split("/");
  var o = {};
  if (p.length >= 3 && !isNaN(+p[0])) { o.z = +p[0]; o.lat = +p[1]; o.lon = +p[2]; }
  if (p[3]) { var t = p[3].split(","); o.layer = t[0]; o.grid = t.indexOf("g") > 0; o.noParcels = t.indexOf("np") > 0; o.water = t.indexOf("w") > 0; o.gates = t.indexOf("b") > 0; t.forEach(function (x, i) { var m = /^r(\d?)$/.exec(x); if (i > 0 && m) { o.route = true; o.routeLevel = m[1] ? +m[1] : 1; } }); }
  if (p.length >= 6) { o.pin = [+p[4], +p[5]]; }
  return o;
}

var st = readHash();
// Home view: 1.5 km either side of Fern Tree fire station (7 Summerleas Rd)
var HOME = { lat: -42.923231, lon: 147.260121, halfWidthM: 1500 };
function homeBounds() {
  var dLat = HOME.halfWidthM / 111320, dLon = HOME.halfWidthM / (111320 * Math.cos(HOME.lat * Math.PI / 180));
  return L.latLngBounds([HOME.lat - dLat, HOME.lon - dLon], [HOME.lat + dLat, HOME.lon + dLon]);
}
var map = L.map("map", { zoomControl: true, attributionControl: true, maxZoom: 19, minZoom: 6, zoomSnap: 0.25 });
// fit the home area exactly (fractional zoom), then go back to whole zoom steps
if (st.z !== undefined) map.setView([st.lat, st.lon], st.z); else map.fitBounds(homeBounds());
map.options.zoomSnap = 1;
L.control.scale({ imperial: false, position: "bottomright" }).addTo(map);

var layers = {}, current = null;
var sel = document.getElementById("layer");
BASEMAPS.forEach(function (b) {
  layers[b.id] = L.tileLayer(LIST + b.svc + "/MapServer/tile/{z}/{y}/{x}", {
    maxNativeZoom: b.max, maxZoom: 19,
    attribution: "&copy; State of Tasmania, <a href=\"https://www.thelist.tas.gov.au\">theLIST</a>" +
      (b.lic ? " (" + b.lic + ")" : "")
  });
  var o = document.createElement("option"); o.value = b.id; o.textContent = b.name; sel.appendChild(o);
});
function setLayer(id) {
  if (!layers[id]) id = "topo";
  if (current) map.removeLayer(current);
  current = layers[id].addTo(map); sel.value = id;
  if (typeof syncParcelOverlay === "function" && parcelTiles) syncParcelOverlay();
  writeHash();
}
sel.addEventListener("change", function () { setLayer(sel.value); });

var pin = null;
function writeHash() {
  var c = map.getCenter();
  var h = "#" + map.getZoom() + "/" + c.lat.toFixed(5) + "/" + c.lng.toFixed(5) + "/" +
    (sel.value || "topo") + (gridOn ? ",g" : "") + (parcelsOn ? "" : ",np") +
    (OVERLAYS && OVERLAYS.water && OVERLAYS.water.on ? ",w" : "") + (OVERLAYS && OVERLAYS.gates && OVERLAYS.gates.on ? ",b" : "") + (routeInfo && routeInfo.ok ? ",r" + routeInfo.level : "");
  if (pin) { var p = pin.getLatLng(); h += "/" + p.lat.toFixed(6) + "/" + p.lng.toFixed(6); }
  history.replaceState(null, "", h);
}
map.on("moveend", writeHash);

// ---------------------------------------------------------------------------
// Pin + coordinate panel
// ---------------------------------------------------------------------------
var panel = document.getElementById("panel"), rowsEl = document.getElementById("rows");
var lastRows = [], showMore = false;
var pinIcon = L.divIcon({ className: "", iconSize: [22, 22], iconAnchor: [11, 11],
  html: "<svg width='22' height='22' viewBox='0 0 22 22'><circle cx='11' cy='11' r='8' fill='none' " +
        "stroke='#c62828' stroke-width='3'/><circle cx='11' cy='11' r='2' fill='#c62828'/></svg>" });

function setPin(latlng) {
  if (!pin) pin = L.marker(latlng, { icon: pinIcon, draggable: true }).addTo(map)
    .on("drag", function () { showCoords(pin.getLatLng()); })
    .on("dragstart", function () { clearRoute(); })
    .on("dragend", function () { writeHash(); lookupParcel(pin.getLatLng()); lookupMapbook(pin.getLatLng()); });
  else pin.setLatLng(latlng);
  clearRoute(); setFolded(false); parcelInfo = null; featureInfo = null; showCoords(latlng); writeHash();
  lookupParcel(latlng); lookupMapbook(latlng);
}
function showCoords(ll) {
  var cr = coords(ll.lat, ll.lng), gi = 4;
  lastRows = featureRows().concat(parcelRows(), routeRows(), cr.slice(0, gi), mapbookRows(), cr.slice(gi));
  rowsEl.innerHTML = "";
  lastRows.forEach(function (r) {
    if (r.extra && !showMore) return;
    var d = document.createElement("div"); d.className = "row";
    d.innerHTML = "<span class='k'></span><span class='v'></span><button>Copy</button>";
    d.querySelector(".k").textContent = r.k;
    d.querySelector(".v").textContent = r.v;
    d.querySelector("button").onclick = function () { copy(r.v); };
    rowsEl.appendChild(d);
  });
  var m = document.createElement("button"); m.id = "more";
  m.textContent = showMore ? "Fewer formats" : "More formats (MGA2020, DMS, deg min)";
  m.onclick = function () { showMore = !showMore; showCoords(ll); };
  rowsEl.appendChild(m);
  var sum = routeInfo && routeInfo.ok ? routeInfo.short :
            routeInfo ? "Route: " + routeInfo.msg :
            lastRows.length ? lastRows[0].k + ": " + lastRows[0].v : "";
  document.getElementById("summary").textContent = sum;
  panel.classList.toggle("routed", !!(routeInfo && routeInfo.ok));
  panel.style.display = "block";
  if (typeof placeLabels === "function") placeLabels();
}
function setFolded(f) {
  panel.classList.toggle("collapsed", f);
  document.getElementById("fold").textContent = f ? "Show" : "Hide";
  if (typeof placeLabels === "function") placeLabels();
}
document.getElementById("fold").onclick = function () { setFolded(!panel.classList.contains("collapsed")); };
var lastFeatureClick = 0;
map.on("click", function (e) { if (Date.now() - lastFeatureClick < 300) return; setPin(e.latlng); });
document.getElementById("close").onclick = function () {
  panel.style.display = "none"; if (pin) { map.removeLayer(pin); pin = null; }
  clearRoute(); parcelInfo = null; parcelHi.clearLayers(); writeHash(); placeLabels();
};

function toast(msg) {
  var t = document.getElementById("toast"); t.textContent = msg; t.style.display = "block";
  t.style.top = (document.querySelector(".bar").getBoundingClientRect().bottom + 8) + "px";
  clearTimeout(toast._t); toast._t = setTimeout(function () { t.style.display = "none"; }, 2500);
}
function copy(text) {
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).then(function () { toast("Copied"); }, function () { fallback(); });
  } else fallback();
  function fallback() {
    var ta = document.createElement("textarea"); ta.value = text; document.body.appendChild(ta);
    ta.select(); try { document.execCommand("copy"); toast("Copied"); } catch (e) { toast("Copy failed"); }
    document.body.removeChild(ta);
  }
}
function allText() {
  return lastRows.filter(function (r) { return showMore || !r.extra; }).map(function (r) { return r.k + ": " + r.v; }).join("\n") + "\n" + location.href;
}
document.getElementById("copyall").onclick = function () { copy(allText()); };
document.getElementById("share").onclick = function () {
  if (navigator.share) navigator.share({ title: "Location", text: allText(), url: location.href }).catch(function () {});
  else copy(allText());
};

// ---------------------------------------------------------------------------
// GPS
// ---------------------------------------------------------------------------
var me = null, meAcc = null, watchId = null, lastFix = null, follow = false;
var locBtn = document.getElementById("locate");
function onFix(p) {
  var ll = L.latLng(p.coords.latitude, p.coords.longitude); lastFix = ll;
  if (!me) {
    meAcc = L.circle(ll, { radius: p.coords.accuracy, color: "#1565c0", weight: 1, fillOpacity: 0.12 }).addTo(map);
    me = L.circleMarker(ll, { radius: 7, color: "#fff", weight: 2, fillColor: "#1565c0", fillOpacity: 1 }).addTo(map);
  } else { me.setLatLng(ll); meAcc.setLatLng(ll).setRadius(p.coords.accuracy); }
  if (follow) { map.setView(ll, Math.max(map.getZoom(), 15)); follow = false; }
  if (pendingPin) { pendingPin = false; setPin(ll); }
}
function onErr(e) { toast("Location unavailable: " + e.message); stopWatch(); }
function startWatch() {
  if (!navigator.geolocation) { toast("No geolocation in this browser"); return; }
  watchId = navigator.geolocation.watchPosition(onFix, onErr, { enableHighAccuracy: true, maximumAge: 5000 });
  locBtn.classList.add("on");
}
function stopWatch() {
  if (watchId !== null) navigator.geolocation.clearWatch(watchId);
  watchId = null; locBtn.classList.remove("on");
  if (me) { map.removeLayer(me); map.removeLayer(meAcc); me = meAcc = null; }
}
locBtn.onclick = function () {
  if (watchId === null) { follow = true; startWatch(); } else stopWatch();
};
var pendingPin = false;
document.getElementById("pinme").onclick = function () {
  if (lastFix && watchId !== null) { setPin(lastFix); map.setView(lastFix, Math.max(map.getZoom(), 15)); }
  else { pendingPin = true; follow = true; if (watchId === null) startWatch(); }
};

// ---------------------------------------------------------------------------
// Print: browser print / save as PDF of the current view
// ---------------------------------------------------------------------------
document.getElementById("print").onclick = function () {
  var b = BASEMAPS.filter(function (x) { return x.id === sel.value; })[0];
  var bb = map.getBounds();
  document.getElementById("printhead").textContent =
    b.name + "  |  " + new Date().toLocaleString("en-AU") + "  |  view " +
    bb.getSouth().toFixed(4) + "," + bb.getWest().toFixed(4) + " to " +
    bb.getNorth().toFixed(4) + "," + bb.getEast().toFixed(4) + "  |  " + location.href;
  setTimeout(function () { window.print(); }, 50);
};
