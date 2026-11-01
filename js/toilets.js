// lunamap - toilets.js: public toilets (Layers > Infrastructure > Toilets).
//   data/toilets-tas.json, harvested monthly by a GitHub Action from the National Public Toilet
//   Map (Australian Government, data.gov.au) plus OpenStreetMap toilets not already on it.
//   Symbols from zoom 10, in view; tap one for its details. With the layer on, the pin panel
//   gets a "Nearest toilet" row (straight-line distance). Works offline once loaded.
// ---------------------------------------------------------------------------
(function () {
  var data = null, on = false, group = L.layerGroup(), btn = document.getElementById("toilets"), MINZ = 10;
  var FLAG = { A: "accessible", B: "baby change", S: "shower", W: "drinking water", U: "unisex", P: "accessible parking" };
  function load() {
    if (!data) data = fetch("data/toilets-tas.json").then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
      .then(function (d) { return d.toilets; }).catch(function (e) { data = null; throw e; });
    return data;
  }
  function detail(t) {
    var f = t[4].split("").map(function (c) { return FLAG[c]; }).filter(Boolean);
    return joinBits([f.join(", "), t[5] ? "open " + t[5].replace(/^\s*open:?\s*/i, "").toLowerCase() : null, t[3] === "o" ? "OpenStreetMap" : "National Public Toilet Map"]);
  }
  function draw() {
    group.clearLayers();
    if (!on || map.getZoom() < MINZ) return;
    load().then(function (ts) {
      if (!on) return;
      group.clearLayers();
      var b = map.getBounds().pad(0.2);
      ts.forEach(function (t) {
        var ll = L.latLng(t[0], t[1]); if (!b.contains(ll)) return;
        var info = { what: "Toilet: " + t[2], detail: detail(t) };
        L.marker(ll, { icon: symIcon("wc", t[4].indexOf("A") >= 0 ? "A" : "T"), title: info.what + (info.detail ? " - " + info.detail : ""), zIndexOffset: 150 })
          .on("click", function () { pickFeature(ll, info); }).addTo(group);
      });
    }).catch(function (e) { toast("Toilets unavailable: " + e.message); });
  }
  var nearest = null, seq = 0;
  window.toiletRows = function () { return on && nearest ? [{ k: "Nearest toilet", v: nearest }] : []; };
  window.lookupToilet = function (ll) {
    nearest = null; if (!on) return;
    var s = ++seq;
    load().then(function (ts) {
      if (s !== seq) return;
      var best = null, bd = Infinity;
      ts.forEach(function (t) { var d = map.distance(ll, [t[0], t[1]]); if (d < bd) { bd = d; best = t; } });
      if (!best) return;
      var dir = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][Math.round(bearing([ll.lng, ll.lat], [best[1], best[0]]) / 45) % 8];
      nearest = best[2] + ", " + fmtDist(bd) + " " + dir + (best[4] || best[5] ? " (" + detail(best).split(", OpenStreetMap")[0].split(", National")[0] + ")" : "");
      if (pin) showCoords(pin.getLatLng());
    }).catch(function () {});
  };
  function setToilets(v) {
    on = v; btn.classList.toggle("on", on);
    if (on) { group.addTo(map); draw(); if (pin) lookupToilet(pin.getLatLng()); if (map.getZoom() < MINZ) toast("Zoom in to see toilets"); }
    else { map.removeLayer(group); group.clearLayers(); nearest = null; if (pin) showCoords(pin.getLatLng()); }
    writeHash();
  }
  window.setToilets = setToilets;
  window.toiletFlag = function () { return on ? ",wc" : ""; };
  btn.onclick = function () { setToilets(!on); };
  map.on("moveend", draw);
})();
