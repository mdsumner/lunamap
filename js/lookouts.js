// lunamap - lookouts.js: lookouts (Layers > Infrastructure > Lookouts), from OpenStreetMap
//   tourism=viewpoint, named or not (data/osm-peaks-tas.json, harvested monthly with the peaks).
//   Symbols from zoom 10, in view. Tap one to pin it; then What am I looking at? (Explore) shows
//   the view from there. Named lookouts are also labelled in that view when they can be seen.
// ---------------------------------------------------------------------------
(function () {
  var data = null, on = false, group = L.layerGroup(), btn = document.getElementById("lookouts"), MINZ = 10;
  function load() {
    if (!data) data = fetch("data/osm-peaks-tas.json").then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
      .then(function (d) { return d.peaks.filter(function (p) { return p[4] === "viewpoint"; }); }).catch(function (e) { data = null; throw e; });
    return data;
  }
  function draw() {
    group.clearLayers();
    if (!on || map.getZoom() < MINZ) return;
    load().then(function (ls) {
      if (!on) return;
      group.clearLayers();
      var b = map.getBounds().pad(0.2);
      ls.forEach(function (p) {
        var ll = L.latLng(p[1], p[2]); if (!b.contains(ll)) return;
        var info = { what: "Lookout" + (p[0] ? ": " + p[0] : ""),
          detail: joinBits([p[3] !== null ? p[3] + " m" : null, "OpenStreetMap", "Explore > What am I looking at? shows the view from here"]) };
        L.marker(ll, { icon: symIcon("lk", "L"), title: info.what, zIndexOffset: 140 })
          .on("click", function () { pickFeature(ll, info); }).addTo(group);
      });
    }).catch(function (e) { toast("Lookouts unavailable: " + e.message); });
  }
  function setLookouts(v) {
    on = v; btn.classList.toggle("on", on);
    if (on) { group.addTo(map); draw(); if (map.getZoom() < MINZ) toast("Zoom in to see lookouts"); }
    else { map.removeLayer(group); group.clearLayers(); }
    writeHash();
  }
  window.setLookouts = setLookouts;
  window.lookoutFlag = function () { return on ? ",lk" : ""; };
  btn.onclick = function () { setLookouts(!on); };
  map.on("moveend", draw);
})();
