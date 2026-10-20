// lunamap - archives.js (Explore): "Archives near here". Lists open-access photographs, maps,
// plans and films in the Libraries Tasmania / Tasmanian Archives catalogue whose titles name
// a place near the pin (or the middle of the map). Built by scripts/archives_index.py from the
// catalogue on data.gov.au (CC BY 4.0) into data/archives/. Items are placed by the place name
// in their title, so only to a town or locality; each links to its catalogue page on STORS.
// ---------------------------------------------------------------------------
(function () {
  var KINDS = [["p", "Photographs"], ["m", "Maps and plans"], ["b", "Public Works drawings"], ["f", "Film"]];
  var PAGE = 150;
  var sheet = null, index = null, marks = L.layerGroup(), here = null, curPlace = null, items = [], filter = "", onlineOnly = false;

  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return "&#" + c.charCodeAt(0) + ";"; }); }
  function loadIndex() {
    if (!index) index = fetch("data/archives/index.json").then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
      .catch(function (e) { index = null; throw e; });
    return index;
  }

  function ensureSheet() {
    if (sheet) return sheet;
    sheet = document.createElement("div"); sheet.id = "arcsheet"; sheet.className = "sheet";
    sheet.innerHTML = "<h2><span>Archives near here</span><button id='arcclose' aria-label='Close'>x</button></h2>" +
      "<div id='arcplaces' class='seg'></div>" +
      "<input id='arcfilter' type='search' placeholder='Filter titles (e.g. fire, school, 1967)' style='width:100%;margin:4px 0'>" +
      "<label class='small'><input id='arconline' type='checkbox'> Only items that may be viewable online</label>" +
      "<div id='arclist' class='small'></div>" +
      "<p class='small' style='color:#666'>From the Libraries Tasmania / Tasmanian Archives catalogue (data.gov.au, CC BY 4.0; " +
      "open-access items, catalogue as of 2021). Most items are originals you order to view in person at the History Room " +
      "(91 Murray Street, Hobart); \"online?\" marks the few without that note, which may be viewable online. Items are matched by the place named in their title, so they are near here " +
      "only in that sense; \"?\" marks a name that is also a common word or surname. Copies of archive items are for private " +
      "research; other uses need permission from Libraries Tasmania.</p>";
    document.body.appendChild(sheet);
    sheet.querySelector("#arcclose").onclick = function () { sheet.style.display = "none"; map.removeLayer(marks); };
    sheet.querySelector("#arcfilter").oninput = function (e) { filter = e.target.value.toLowerCase(); render(); };
    sheet.querySelector("#arconline").onchange = function (e) { onlineOnly = e.target.checked; render(); };
    return sheet;
  }

  function render() {
    var el = sheet.querySelector("#arclist");
    if (!curPlace) return;
    var shown = items.filter(function (it) {
      return (!filter || (it[1] + " " + it[2]).toLowerCase().indexOf(filter) >= 0) && (!onlineOnly || it[5] === 1);
    });
    var html = ["<div><b>" + esc(curPlace[1]) + "</b>: " + shown.length + (filter ? " matching" : "") + " items</div>"];
    KINDS.forEach(function (k) {
      var g = shown.filter(function (it) { return it[3] === k[0]; });
      if (!g.length) return;
      html.push("<details" + (k[0] === "p" || k[0] === "m" ? " open" : "") + "><summary><b>" + k[1] + "</b> (" + g.length + ")</summary><ul class='arcul'>" +
        g.slice(0, PAGE).map(function (it) {
          return "<li><a href='https://stors.tas.gov.au/AI/" + esc(it[0]) + "' target='_blank' rel='noopener'>" + esc(it[1]) + "</a>" +
            (it[2] ? " <span class='arcy'>" + esc(it[2]) + "</span>" : "") + (it[4] ? " <span title='The place name is also a common word or surname'>?</span>" : "") +
            (it[5] === 1 ? " <span class='arcon' title='No order-in-person note in the catalogue: may be viewable online'>online?</span>" : "") + "</li>";
        }).join("") + (g.length > PAGE ? "<li>... and " + (g.length - PAGE) + " more: use the filter</li>" : "") + "</ul></details>");
    });
    el.innerHTML = html.join("");
  }

  function choose(pl) {
    curPlace = pl;
    [].forEach.call(sheet.querySelectorAll("#arcplaces button"), function (b) { b.className = +b.getAttribute("data-id") === pl[0] ? "on" : ""; });
    sheet.querySelector("#arclist").textContent = "Loading " + pl[1] + "...";
    fetch("data/archives/p/" + pl[0] + ".json").then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
      .then(function (d) { if (curPlace !== pl) return; items = d.items; render(); })
      .catch(function (e) { sheet.querySelector("#arclist").textContent = "Could not load " + pl[1] + ": " + e.message; });
  }

  window.openArchives = function () {
    ensureSheet().style.display = "block";
    here = pin ? pin.getLatLng() : map.getCenter();
    sheet.querySelector("#arclist").textContent = "Loading the archive index...";
    loadIndex().then(function (ix) {
      var near = ix.places.map(function (p) { return { p: p, d: map.distance(here, [p[3], p[2]]) }; })
        .filter(function (x) { return x.d < 15000; }).sort(function (a, b) { return a.d - b.d; }).slice(0, 8);
      if (!near.length) {                       // nothing within 15 km: the nearest few anywhere
        near = ix.places.map(function (p) { return { p: p, d: map.distance(here, [p[3], p[2]]) }; })
          .sort(function (a, b) { return a.d - b.d; }).slice(0, 3);
      }
      var box = sheet.querySelector("#arcplaces");
      box.innerHTML = "";
      marks.clearLayers().addTo(map);
      near.forEach(function (x) {
        var p = x.p, n = p[4] + p[5] + p[6] + p[7];
        var b = document.createElement("button"); b.type = "button"; b.setAttribute("data-id", p[0]);
        b.textContent = p[1] + " (" + n + ", " + (x.d < 1000 ? Math.round(x.d) + " m" : (x.d / 1000).toFixed(1) + " km") + ")";
        b.onclick = function () { choose(p); };
        box.appendChild(b);
        L.circleMarker([p[3], p[2]], { radius: 7, color: "#5d4037", weight: 2, fillColor: "#bcaaa4", fillOpacity: 0.9 })
          .bindTooltip(p[1] + ": " + n + " archive items").on("click", function () { choose(p); }).addTo(marks);
      });
      if (near.length) choose(near[0].p);
    }).catch(function (e) { sheet.querySelector("#arclist").textContent = "Archive index not available yet (" + e.message + ")."; });
  };
})();
