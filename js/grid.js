// lunamap - grid.js (classic script; shares globals with the other js/ files, loaded in order)
// ---------------------------------------------------------------------------
// MGA2020 grid, labelled where each line meets the edge of the current view
// (the view is the "margin"). Labels follow the printed-map style: small
// leading digits, bold 2-digit km value, so a 6-figure grid ref reads straight off.
// ---------------------------------------------------------------------------
var gridOn = false, gridLines = [], gridLayer = L.layerGroup().addTo(map);
var glabels = document.createElement("div"); glabels.id = "glabels";
map.getContainer().appendChild(glabels);
var gridBtn = document.getElementById("grid");

function gridLabel(v) {
  var km = Math.round(v / 1000);
  var pre = Math.floor(km / 100), main = pad(km % 100, 2);
  return (pre ? "<small>" + pre + "</small>" : "") + main;
}

function buildGrid() {
  gridLayer.clearLayers(); gridLines = [];
  if (!gridOn) { glabels.innerHTML = ""; return; }
  var c = map.getCenter();
  var zone = Math.floor((c.lng + 180) / 6) + 1;
  var def = mgaDefs(zone).mga2020;
  var b = map.getBounds().pad(0.5), sz = map.getSize();
  // MGA extent of the (padded) view from a ring of edge samples
  var minE = Infinity, maxE = -Infinity, minN = Infinity, maxN = -Infinity;
  for (var i = 0; i <= 8; i++) {
    var f = i / 8, lat = b.getSouth() + f * (b.getNorth() - b.getSouth()),
        lon = b.getWest() + f * (b.getEast() - b.getWest());
    [[b.getWest(), lat], [b.getEast(), lat], [lon, b.getSouth()], [lon, b.getNorth()]].forEach(function (q) {
      var m = proj4("EPSG:4326", def, q);
      minE = Math.min(minE, m[0]); maxE = Math.max(maxE, m[0]);
      minN = Math.min(minN, m[1]); maxN = Math.max(maxN, m[1]);
    });
  }
  // spacing: 1 km unless lines would be closer than ~45 px
  var mpp = (maxE - minE) / (sz.x * 2), s = null;
  [1000, 10000, 100000].some(function (x) { if (x / mpp >= 45) { s = x; return true; } return false; });
  if (!s) { glabels.innerHTML = ""; return; }
  var style = { color: "#0d47a1", weight: s === 1000 ? 1 : 1.5, opacity: 0.75, interactive: false };
  function line(kind, v) {
    var ll = [];
    for (var j = 0; j <= 16; j++) {
      var t = (kind === "E") ? [v, minN + j / 16 * (maxN - minN)] : [minE + j / 16 * (maxE - minE), v];
      var g = proj4(def, "EPSG:4326", t); ll.push(L.latLng(g[1], g[0]));
    }
    gridLayer.addLayer(L.polyline(ll, style));
    gridLines.push({ kind: kind, v: v, ll: ll });
  }
  for (var e = Math.ceil(minE / s) * s; e <= maxE; e += s) line("E", e);
  for (var n = Math.ceil(minN / s) * s; n <= maxN; n += s) line("N", n);
  gridLayer.spacing = s; gridLayer.zone = zone;
  placeLabels();
}

// where a polyline (container px) crosses x = c or y = c
function crossing(pts, axis, c) {
  for (var i = 1; i < pts.length; i++) {
    var a = pts[i - 1][axis] - c, b = pts[i][axis] - c;
    if (a === 0) return pts[i - 1];
    if (a * b < 0) { var t = a / (a - b);
      return L.point(pts[i - 1].x + t * (pts[i].x - pts[i - 1].x), pts[i - 1].y + t * (pts[i].y - pts[i - 1].y)); }
  }
  return null;
}

function placeLabels() {
  glabels.innerHTML = "";
  if (!gridOn) return;
  var sz = map.getSize();
  var bar = document.querySelector(".bar").getBoundingClientRect();
  var top = bar.bottom - map.getContainer().getBoundingClientRect().top + 4;
  // bottom margin sits just above whatever occupies the bottom edge:
  // the attribution/scale controls, and the coordinate panel when it is open
  var mapTop = map.getContainer().getBoundingClientRect().top, bottom = sz.y - 4;
  var occ = Array.prototype.slice.call(document.querySelectorAll(".leaflet-bottom .leaflet-control"));
  if (panel.style.display === "block") occ.push(panel);
  occ.forEach(function (el) {
    var r = el.getBoundingClientRect();
    if (r.height > 0) bottom = Math.min(bottom, r.top - mapTop - 3);
  });
  var left = 4, right = sz.x - 4;
  var html = [];
  function add(cls, p, txt) {
    html.push("<div class='glab " + cls + "' style='left:" + p.x.toFixed(1) + "px;top:" + p.y.toFixed(1) + "px'>" + txt + "</div>");
  }
  gridLines.forEach(function (g) {
    var pts = g.ll.map(function (x) { return map.latLngToContainerPoint(x); });
    var txt = gridLabel(g.v);
    if (g.kind === "E") {
      var p1 = crossing(pts, "y", top);    if (p1 && p1.x > 20 && p1.x < sz.x - 20) add("t", p1, txt);
      var p2 = crossing(pts, "y", bottom); if (p2 && p2.x > 20 && p2.x < sz.x - 20) add("b", p2, txt);
    } else {
      var p3 = crossing(pts, "x", left);  if (p3 && p3.y > top + 20 && p3.y < bottom - 20) add("l", p3, txt);
      var p4 = crossing(pts, "x", right); if (p4 && p4.y > top + 20 && p4.y < bottom - 20) add("r", p4, txt);
    }
  });
  glabels.innerHTML = html.join("");
}

// keep Leaflet's top controls clear of the toolbar, however it wraps
function fitControls() {
  var bar = document.querySelector(".bar").getBoundingClientRect();
  document.querySelectorAll(".leaflet-top").forEach(function (el) { el.style.top = (bar.bottom + 2) + "px"; });
}
window.addEventListener("resize", fitControls); fitControls();

function setGrid(on) {
  gridOn = on; gridBtn.classList.toggle("on", on); buildGrid(); writeHash();
}
gridBtn.onclick = function () { setGrid(!gridOn); };
map.on("moveend", buildGrid);
map.on("move", placeLabels);
map.on("zoomstart", function () { glabels.innerHTML = ""; });
map.on("resize", buildGrid);
window.addEventListener("beforeprint", placeLabels);
window.addEventListener("afterprint", placeLabels);
