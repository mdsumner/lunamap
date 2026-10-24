// lunamap - layerfinder.js: find and add any of theLIST's ~1,150 public map layers.
//   Find a layer (Layers menu) opens a search over the catalogue in data/list-layers.json
//   (harvested monthly by a GitHub Action from theLIST's ArcGIS services directory). Words match
//   layer names first, then the group, service and description; common words are widened
//   ("fire" also finds bushfire and burn layers, "school" finds education). With no words, the
//   services are listed as themes to browse.
//   What's here? asks every theLIST service which of its layers have something at the pin (or the
//   middle of the map) and lists them, so you can find a layer by place rather than by name.
//   Added layers are drawn by theLIST server, each with its own opacity, and kept on this device.
//   With a pin down, each added layer (other than images) gets a row in the pin panel saying what
//   it has at the pin.
// ---------------------------------------------------------------------------
(function () {
  var ROOT = "https://services.thelist.tas.gov.au/arcgis/rest/services/";
  var KEY = "lunamap-list-layers";
  var cat = null, added = [], sheet = null, found = {}, foundSeq = 0, legends = {};
  var SYN = {
    fire: ["fire", "bushfire", "burn", "brmp", "tfs"], bushfire: ["bushfire", "fire", "burn"],
    water: ["water", "hydrant", "river", "catchment", "dam", "taswater", "wetland"], flood: ["flood", "inundation", "aep"],
    soil: ["soil", "geology", "geological", "land capability"], rock: ["geology", "geological", "mineral"],
    school: ["school", "education"], heritage: ["heritage", "historic", "aboriginal"], weed: ["weed", "biosecurity"],
    veg: ["vegetation", "tasveg", "veg"], vegetation: ["vegetation", "tasveg"], tree: ["vegetation", "forest", "tasveg", "plantation"],
    forest: ["forest", "plantation", "reserve", "tasveg"], road: ["road", "transport", "street"], track: ["track", "walking", "trail"],
    walk: ["walking", "track", "trail"], boundary: ["boundary", "locality", "suburb", "council", "lga", "municipal"],
    council: ["council", "lga", "municipal", "local government"], zone: ["zone", "zoning", "planning", "overlay"],
    zoning: ["zoning", "zone", "planning"], coast: ["coast", "coastal", "marine", "shoreline"], sea: ["marine", "coastal", "sea"],
    reserve: ["reserve", "park", "conservation", "protected"], park: ["park", "reserve"], slope: ["slope", "landslide", "relief"],
    landslide: ["landslide", "landslip", "slope"], power: ["power", "electricity", "transmission", "tasnetworks"],
    fuel: ["petrol", "fuel", "petroleum"], population: ["population", "people", "abs", "census"], census: ["abs", "census", "seifa"],
    animal: ["fauna", "species", "habitat", "threatened"], species: ["species", "threatened", "fauna", "flora"],
    climate: ["climate", "rainfall", "temperature"], farm: ["agriculture", "enterprise suitability", "irrigation", "land capability"],
    title: ["cadastre", "parcel", "title"], property: ["cadastre", "parcel", "property"], aerial: ["aerial", "photo", "orthophoto", "index"],
    photo: ["aerial", "photo", "index"], map: ["tasmap", "index", "sheet"]
  };
  try { added = JSON.parse(localStorage.getItem(KEY) || "[]") || []; } catch (e) { added = []; }
  function store() { try { localStorage.setItem(KEY, JSON.stringify(added.map(function (a) { return [a.svc, a.id, a.name, a.opacity, a.geom]; }))); } catch (e) {} }
  added = added.map(function (a) { return { svc: a[0], id: a[1], name: a[2], opacity: a[3] || 0.7, geom: a[4] || "" }; });
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return "&#" + c.charCodeAt(0) + ";"; }); }
  function loadCat() {
    if (!cat) cat = fetch("data/list-layers.json").then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
      .catch(function (e) { cat = null; throw e; });
    return cat;
  }
  function svcTitle(c, si) { var s = c.services[si], t = s[1] && s[1] !== s[0].split("/")[1] ? s[1] : s[0].split("/")[1].replace(/([a-z])([A-Z])/g, "$1 $2");
    return t.replace(/_/g, " "); }

  // ---- drawing -----------------------------------------------------------------------
  var ListTiles = L.TileLayer.extend({
    getTileUrl: function (c) {
      var ts = this.getTileSize(), nw = c.scaleBy(ts), se = nw.add(ts);
      var a = L.CRS.EPSG3857.project(this._map.unproject(nw, c.z)), b = L.CRS.EPSG3857.project(this._map.unproject(se, c.z));
      return ROOT + this.options.svc + "/export?bbox=" + [a.x, b.y, b.x, a.y].map(function (v) { return v.toFixed(2); }).join(",") +
        "&bboxSR=3857&imageSR=3857&size=" + ts.x + "," + ts.y + "&format=png32&transparent=true&dpi=96&layers=show:" + this.options.lid + "&f=image";
    }
  });
  function addTiles(a) {
    a.tiles = new ListTiles("", { svc: a.svc, lid: a.id, tileSize: 512, opacity: a.opacity, zIndex: 5, maxZoom: 19,
      attribution: "Layers &copy; State of Tasmania (theLIST)" }).addTo(map);
  }
  function addLayer(svc, id, name, geom) {
    if (added.some(function (a) { return a.svc === svc && a.id === id; })) { toast(name + " is already on the map"); return; }
    var a = { svc: svc, id: id, name: name, opacity: geom === "raster layer" ? 0.6 : 0.8, geom: geom };
    added.push(a); addTiles(a); store(); keys(); render(); legendFor(a);
    toast("Added " + name);
    if (pin) lookupFoundLayers(pin.getLatLng());
  }
  function removeLayer(i) {
    var a = added[i]; if (a.tiles) map.removeLayer(a.tiles);
    added.splice(i, 1); store(); keys(); render(); if (pin) showCoords(pin.getLatLng());
  }
  function keys() { window.extraShortKeys = added.filter(function (a) { return a.geom !== "raster layer"; }).map(function (a) { return a.name; }); }
  function legendFor(a) {
    if (!legends[a.svc]) legends[a.svc] = fetch(ROOT + a.svc + "/legend?f=json").then(function (r) { return r.json(); }).catch(function () { return {}; });
    legends[a.svc].then(function (j) {
      var l = (j.layers || []).filter(function (x) { return x.layerId === a.id; })[0];
      a.legend = l ? l.legend.slice(0, 12) : []; render();
    });
  }

  // ---- search ------------------------------------------------------------------------
  function words(s) { return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter(Boolean); }
  function search(c, q) {
    var qs = words(q); if (!qs.length) return [];
    var groups = qs.map(function (w) { return SYN[w] ? SYN[w] : [w]; });
    var out = [];
    c.layers.forEach(function (l, li) {
      if (l[4] === "group") return;
      var nm = l[2].toLowerCase(), grp = (l[3] || "").toLowerCase(), sv = svcTitle(c, l[0]).toLowerCase(), ds = (l[7] || "").toLowerCase();
      var score = 0, all = true;
      groups.forEach(function (alts, gi) {
        var best = 0;
        alts.forEach(function (w, ai) {
          var re = new RegExp("(^|[^a-z0-9])" + w.replace(/[^a-z0-9 ]/g, ""));
          var s = re.test(nm) ? 10 : re.test(grp) ? 5 : re.test(sv) ? 3 : re.test(ds) ? 2 : 0;
          if (ai > 0) s *= 0.7;                 // a widened word counts a little less
          best = Math.max(best, s);
        });
        if (!best) all = false; score += best;
      });
      if (!all) return;
      if (/\b(19|20)\d\d\b/.test(nm)) { var yr = +nm.match(/\b(19|20)\d\d\b/)[0]; score += (yr - 2000) / 100; }   // newer editions first
      out.push({ li: li, score: score });
    });
    return out.sort(function (a, b) { return b.score - a.score; }).slice(0, 40).map(function (x) { return c.layers[x.li]; });
  }
  function layerItem(c, l, extra) {
    var on = added.some(function (a) { return a.svc === c.services[l[0]][0] && a.id === l[1]; });
    return "<li><button type='button' class='lfadd' data-s='" + l[0] + "' data-i='" + l[1] + "'" + (on ? " disabled" : "") + ">" + (on ? "On" : "Add") + "</button> " +
      "<b>" + esc(l[2]) + "</b><br><span class='lfsub'>" + esc(svcTitle(c, l[0]) + (l[3] ? " / " + l[3] : "")) + " - " + esc(l[4] || "") +
      (l[5] ? ", from zoom " + l[5] : "") + (extra ? " - " + esc(extra) : "") + "</span>" + (l[7] ? "<br><span class='lfdesc'>" + esc(l[7].slice(0, 160)) + "</span>" : "") + "</li>";
  }

  function render() {
    if (!sheet || sheet.style.display !== "block") return;
    var ad = sheet.querySelector("#lfadded");
    ad.innerHTML = added.length ? "<div class='small'><b>On the map</b></div>" + added.map(function (a, i) {
      return "<div class='lfon'><span class='lfname'>" + esc(a.name) + "</span>" +
        "<input type='range' min='0.1' max='1' step='0.1' value='" + a.opacity + "' data-i='" + i + "' class='lfop' title='Opacity'>" +
        "<button type='button' class='lfrm' data-i='" + i + "'>Remove</button>" +
        (a.legend && a.legend.length ? "<div class='lfleg'>" + a.legend.map(function (g) {
          return "<span><img src='data:" + g.contentType + ";base64," + g.imageData + "' width='16' height='16' alt=''> " + esc(g.label || "") + "</span>"; }).join("") + "</div>" : "") +
        "</div>"; }).join("") : "";
    [].forEach.call(ad.querySelectorAll(".lfop"), function (r) { r.oninput = function () { var a = added[+r.getAttribute("data-i")]; a.opacity = +r.value; a.tiles.setOpacity(a.opacity); store(); }; });
    [].forEach.call(ad.querySelectorAll(".lfrm"), function (b) { b.onclick = function () { removeLayer(+b.getAttribute("data-i")); }; });
    loadCat().then(function (c) {
      var q = sheet.querySelector("#lfq").value, res = sheet.querySelector("#lfres"), html;
      if (sheet._here) html = sheet._here(c);
      else if (sheet._svc !== undefined) {
        var si = sheet._svc;
        html = "<div class='small'><a href='#' id='lfback'>All themes</a> / <b>" + esc(svcTitle(c, si)) + "</b></div><ul class='lful'>" +
          c.layers.filter(function (l) { return l[0] === si && l[4] !== "group"; }).map(function (l) { return layerItem(c, l); }).join("") + "</ul>";
      } else if (words(q).length) {
        var r = search(c, q);
        html = r.length ? "<ul class='lful'>" + r.map(function (l) { return layerItem(c, l); }).join("") + "</ul>" : "<p class='small'>No layers match. Try fewer or different words.</p>";
      } else {
        html = "<div class='small'>Browse by theme:</div><div class='seg'>" + c.services.map(function (s, si) {
          if (/^Basemaps\//.test(s[0]) || /SearchService|OpenDataWFS/.test(s[0])) return "";
          var n = c.layers.filter(function (l) { return l[0] === si && l[4] !== "group"; }).length;
          return n ? "<button type='button' class='lfsvc' data-s='" + si + "'>" + esc(svcTitle(c, si)) + " (" + n + ")</button>" : ""; }).join("") + "</div>";
      }
      res.innerHTML = html;
      [].forEach.call(res.querySelectorAll(".lfadd"), function (b) { b.onclick = function () {
        var l = c.layers.filter(function (x) { return x[0] === +b.getAttribute("data-s") && x[1] === +b.getAttribute("data-i"); })[0];
        addLayer(c.services[l[0]][0], l[1], l[2], l[4]); }; });
      [].forEach.call(res.querySelectorAll(".lfsvc"), function (b) { b.onclick = function () { sheet._svc = +b.getAttribute("data-s"); render(); }; });
      var back = res.querySelector("#lfback"); if (back) back.onclick = function (e) { e.preventDefault(); sheet._svc = undefined; render(); };
    }).catch(function (e) { sheet.querySelector("#lfres").textContent = "Layer catalogue unavailable (" + e.message + ")."; });
  }

  // What's here? one identify request per service, all layers, at the pin or map centre
  function whatsHere() {
    var ll = pin ? pin.getLatLng() : map.getCenter(), res = sheet.querySelector("#lfres");
    sheet._svc = undefined; res.textContent = "Asking theLIST what is at " + (pin ? "the pin" : "the middle of the map") + "...";
    loadCat().then(function (c) {
      var b = map.getBounds(), sz = map.getSize(), ext = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].join(",");
      var svcs = c.services.map(function (s, si) { return si; }).filter(function (si) { return !/^Basemaps\/|SearchService|OpenDataWFS|SES_FloodMapping_Calibration/.test(c.services[si][0]); });
      var hits = {}, done = 0;
      res.textContent = "Asking " + svcs.length + " theLIST services...";
      return Promise.all(svcs.map(function (si) {
        var url = ROOT + c.services[si][0] + "/identify?geometry=" + ll.lng.toFixed(6) + "," + ll.lat.toFixed(6) +
          "&geometryType=esriGeometryPoint&sr=4326&layers=all&tolerance=3&mapExtent=" + ext + "&imageDisplay=" + sz.x + "," + sz.y + ",96" +
          "&returnGeometry=false&f=json";
        return fetch(url).then(function (r) { return r.json(); }).then(function (j) {
          (j.results || []).forEach(function (r) { (hits[si] = hits[si] || {})[r.layerId] = summarise(r.attributes); });
        }).catch(function () {}).then(function () { done++; res.textContent = "Asked " + done + " of " + svcs.length + " services..."; });
      })).then(function () {
        var n = 0;
        sheet._here = function (c2) {
          var parts = Object.keys(hits).map(function (si) {
            var ls = c2.layers.filter(function (l) { return l[0] === +si && hits[si][l[1]] !== undefined && l[4] !== "group"; });
            n += ls.length;
            return ls.length ? "<div class='small' style='margin-top:6px'><b>" + esc(svcTitle(c2, +si)) + "</b></div><ul class='lful'>" +
              ls.map(function (l) { return layerItem(c2, l, hits[si][l[1]]); }).join("") + "</ul>" : "";
          }).join("");
          return "<div class='small'><a href='#' id='lfback'>Back</a> - layers with something " + (pin ? "at the pin" : "in the middle of the map") + "</div>" +
            (parts || "<p class='small'>Nothing found here.</p>");
        };
        render();
        var bk = sheet.querySelector("#lfback"); if (bk) bk.onclick = function (e) { e.preventDefault(); sheet._here = null; render(); };
      });
    }).catch(function (e) { res.textContent = "What's here failed: " + e.message; });
  }

  // a short readable summary of a feature's attributes
  var SKIP = /^(objectid|fid|shape|shape_.*|globalid|.*_id|id|ufi|fmp|list_guid|created_on|updated_on|shape\.(area|len)|st_area.*|st_length.*|comp_area|nom_reg_no)$/i;
  var PREF = /(name|title|desc|type|class|zone|status|category|code|label|value|rating|use|tenure)/i;
  function summarise(at) {
    if (!at) return "";
    var ks = Object.keys(at).filter(function (k) {
      var v = at[k]; return !SKIP.test(k) && v !== null && v !== "" && v !== "Null" && !/^\s*$/.test(String(v)) && String(v).length < 120; });
    ks.sort(function (a, b) { return (PREF.test(b) ? 1 : 0) - (PREF.test(a) ? 1 : 0); });
    return ks.slice(0, 4).map(function (k) { var v = at[k]; return /^(Pixel Value|Raster)/i.test(k) ? "value " + v : String(v); }).join(", ");
  }

  // pin panel rows: what each added (non-image) layer has at the pin
  window.foundLayerRows = function () {
    return added.filter(function (a) { return a.geom !== "raster layer" && found[a.svc + "|" + a.id] !== undefined; })
      .map(function (a) { return { k: a.name, v: found[a.svc + "|" + a.id] }; });
  };
  window.lookupFoundLayers = function (ll) {
    var seq = ++foundSeq; found = {};
    var ls = added.filter(function (a) { return a.geom !== "raster layer"; }); if (!ls.length) return;
    var mpp = 40075016 * Math.cos(ll.lat * Math.PI / 180) / Math.pow(2, map.getZoom() + 8);
    Promise.all(ls.map(function (a) {
      var tol = a.geom === "polygon" ? 0 : Math.max(5, Math.round(12 * mpp));
      var url = ROOT + a.svc + "/" + a.id + "/query?geometry=" + ll.lng.toFixed(6) + "," + ll.lat.toFixed(6) +
        "&geometryType=esriGeometryPoint&inSR=4326&spatialRel=esriSpatialRelIntersects" + (tol ? "&distance=" + tol + "&units=esriSRUnit_Meter" : "") +
        "&outFields=*&returnGeometry=false&resultRecordCount=3&f=json";
      return fetch(url).then(function (r) { return r.json(); }).then(function (j) {
        var fs = j.features || [];
        found[a.svc + "|" + a.id] = fs.length ? fs.map(function (f) { return summarise(f.attributes); }).join("; ") : "(nothing here)";
      }).catch(function () { found[a.svc + "|" + a.id] = "(lookup failed)"; });
    })).then(function () { if (seq === foundSeq && pin) showCoords(pin.getLatLng()); });
  };

  // ---- sheet ---------------------------------------------------------------------------
  function open() {
    if (!sheet) {
      sheet = document.createElement("div"); sheet.id = "lfsheet"; sheet.className = "sheet";
      sheet.innerHTML = "<h2><span>theLIST layers</span><button id='lfclose' aria-label='Close'>x</button></h2>" +
        "<div id='lfadded'></div>" +
        "<input id='lfq' type='search' placeholder='Find a layer: e.g. fire, soil, heritage, zoning' style='width:100%;margin:6px 0'>" +
        "<div class='seg'><button type='button' id='lfhere'>What's here?</button></div>" +
        "<div id='lfres' class='small'></div>" +
        "<p class='small' style='color:#666'>All public map layers from theLIST (State of Tasmania), drawn by theLIST's server. " +
        "Licences vary by layer; see theLIST for each dataset's terms. Layers you add are kept on this device.</p>";
      document.body.appendChild(sheet); L.DomEvent.disableClickPropagation(sheet); L.DomEvent.disableScrollPropagation(sheet);
      sheet.querySelector("#lfclose").onclick = function () { sheet.style.display = "none"; };
      var t = null;
      sheet.querySelector("#lfq").oninput = function () { clearTimeout(t); t = setTimeout(function () { sheet._svc = undefined; sheet._here = null; render(); }, 200); };
      sheet.querySelector("#lfhere").onclick = whatsHere;
    }
    sheet.style.display = "block"; render();
  }
  window.openLayerFinder = open;
  document.getElementById("layerfind").onclick = function () { if (typeof setMenu === "function") setMenu(null); open(); };
  added.forEach(function (a) { addTiles(a); legendFor(a); });
  keys();
})();
