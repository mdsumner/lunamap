// lunamap - app.js (classic script; shares globals with the other js/ files, loaded in order)
// ---------------------------------------------------------------------------
// Toolbar: map layers and tools live in two drop-down boxes under the bar
// ---------------------------------------------------------------------------
var barEl = document.querySelector(".bar");
var menus = { layers: ["layersbtn", "layerbox"], tools: ["toolsbtn", "toolbox"] };
function setMenu(name) {                     // name: "layers", "tools" or null (close both)
  Object.keys(menus).forEach(function (k) {
    var open = k === name;
    document.getElementById(menus[k][1]).classList.toggle("open", open);
    document.getElementById(menus[k][0]).classList.toggle("open", open);
  });
  fitControls(); placeLabels();
}
Object.keys(menus).forEach(function (k) {
  document.getElementById(menus[k][0]).onclick = function () {
    setMenu(document.getElementById(menus[k][1]).classList.contains("open") ? null : k);
  };
});
map.on("click", function () { setMenu(null); });
// the Layers button shows how many layers are on
function updateLayerCount() {
  var n = document.querySelectorAll("#layerbox button.on").length;
  document.getElementById("layersbtn").textContent = n ? "Layers (" + n + ")" : "Layers";
}
new MutationObserver(updateLayerCount).observe(document.getElementById("layerbox"), { subtree: true, attributes: true, attributeFilter: ["class"] });
// tools close the box once chosen
["draw", "offline", "print"].forEach(function (id) {
  document.getElementById(id).addEventListener("click", function () { setMenu(null); });
});

// ---------------------------------------------------------------------------
// Offline: service worker (sw.js) serves cached tiles; this saves an area.
// ---------------------------------------------------------------------------
var TILE_CACHE = "lunamap-tiles-v1";
var swOK = "serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost");
if (swOK) navigator.serviceWorker.register("sw.js").catch(function () { swOK = false; });
window.addEventListener("offline", function () { toast("No signal - showing saved maps"); });
window.addEventListener("online", function () { toast("Back online"); });

var offSheet = document.getElementById("offsheet"), offBases = document.getElementById("offbases");
var AVG_KB = { ortho: 35, esmb: 30, tasmap: 30, hill: 20, topo: 18, grey: 15 };
var offSaving = false;
BASEMAPS.forEach(function (b) {
  var l = document.createElement("label");
  l.innerHTML = "<input type='checkbox' value='" + b.id + "'> ";
  l.appendChild(document.createTextNode(b.name));
  offBases.appendChild(l);
});
function offChosen() {
  return Array.prototype.slice.call(offBases.querySelectorAll("input:checked")).map(function (i) { return i.value; });
}
function offTiles() {
  var zmax = +document.getElementById("offz").value, bnd = map.getBounds().pad(0.25), urls = [], kb = 0;
  offChosen().forEach(function (id) {
    var b = BASEMAPS.filter(function (x) { return x.id === id; })[0];
    for (var z = 8; z <= Math.min(zmax, b.max); z++) {
      var nw = map.project(bnd.getNorthWest(), z).divideBy(256).floor(),
          se = map.project(bnd.getSouthEast(), z).divideBy(256).floor();
      for (var x = nw.x; x <= se.x; x++) for (var y = nw.y; y <= se.y; y++) {
        urls.push(LIST + b.svc + "/MapServer/tile/" + z + "/" + y + "/" + x); kb += AVG_KB[id] || 25;
      }
    }
  });
  return { urls: urls, mb: kb / 1024 };
}
function offEstimate() {
  var t = offTiles(), el = document.getElementById("offest"), btn = document.getElementById("offsave");
  if (!swOK) { el.textContent = "Offline maps need the site opened over https (for example on github.io)."; btn.disabled = true; return; }
  if (!t.urls.length) { el.textContent = "Tick at least one basemap."; btn.disabled = true; return; }
  var big = t.urls.length > 20000;
  el.textContent = t.urls.length + " tiles, about " + t.mb.toFixed(t.mb < 10 ? 1 : 0) + " MB" +
    (big ? " - too many: zoom in or choose less detail" : "");
  btn.disabled = big || offSaving;
}
function offStatus() {
  var el = document.getElementById("offstat");
  if (!window.caches) { el.textContent = ""; return; }
  Promise.all([
    caches.open(TILE_CACHE).then(function (c) { return c.keys(); }).then(function (k) { return k.length; }).catch(function () { return 0; }),
    typeof roadPackStatus === "function" ? roadPackStatus() : Promise.resolve(""),
    navigator.storage && navigator.storage.estimate ? navigator.storage.estimate().catch(function () { return null; }) : Promise.resolve(null)
  ]).then(function (r) {
    el.textContent = "Saved on this device: " + r[0] + " tiles" + (r[1] ? ", " + r[1] : "") +
      (r[2] ? " (" + (r[2].usage / 1048576).toFixed(0) + " MB used by this site)" : "");
  });
}
function offSave() {
  var t = offTiles(), done = 0, failed = 0, i = 0, prog = document.getElementById("offprog");
  if (!t.urls.length || !window.caches) return;
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist();
  offSaving = true; offEstimate();
  caches.open(TILE_CACHE).then(function (c) {
    function one() {
      if (!offSaving || i >= t.urls.length) return Promise.resolve();
      var u = t.urls[i++];
      return c.match(u).then(function (hit) {
        if (hit) return;
        return fetch(u, { mode: "cors", credentials: "omit" }).then(function (r) {
          if (!r.ok) throw new Error(r.status); return c.put(u, r);
        });
      }).catch(function () { failed++; }).then(function () {
        done++;
        if (done % 10 === 0 || done === t.urls.length)
          prog.textContent = "Saving " + done + " / " + t.urls.length + (failed ? " (" + failed + " failed)" : "");
        return one();
      });
    }
    var workers = []; for (var k = 0; k < 6; k++) workers.push(one());
    return Promise.all(workers);
  }).then(function () {
    var stopped = !offSaving; offSaving = false;
    prog.textContent = (stopped ? "Stopped after " : "Saved ") + done + " tiles" + (failed ? ", " + failed + " failed" : "");
    if (stopped || !document.getElementById("offroads").checked || typeof saveRoadPack !== "function") { offEstimate(); offStatus(); return; }
    var tilesMsg = prog.textContent;
    return saveRoadPack(map.getBounds().pad(0.25), function (m) { prog.textContent = tilesMsg + ". " + m; })
      .then(function (m) { prog.textContent = tilesMsg + ". " + m; offEstimate(); offStatus(); });
  });
}
document.getElementById("offline").onclick = function () {
  var cur = offBases.querySelector("input[value='" + (sel.value || "topo") + "']");
  if (cur && !offChosen().length) cur.checked = true;
  offSheet.style.display = "block"; offEstimate(); offStatus();
};
document.getElementById("offclose").onclick = function () { offSaving = false; offSheet.style.display = "none"; };
document.getElementById("offsave").onclick = offSave;
document.getElementById("offclear").onclick = function () {
  if (!window.caches || !confirm("Remove all saved map tiles and roads from this device?")) return;
  offSaving = false;
  (typeof clearRoadPacks === "function" ? clearRoadPacks() : Promise.resolve()).then(function () { return caches.delete(TILE_CACHE); }).then(function () { document.getElementById("offprog").textContent = "Cleared"; offStatus(); });
};
offBases.addEventListener("change", offEstimate);
document.getElementById("offz").addEventListener("change", offEstimate);
map.on("moveend", function () { if (offSheet.style.display === "block") offEstimate(); });

// ---------------------------------------------------------------------------
// Draw: loaded on first use (Leaflet-Geoman + js/draw.js); also loaded at
// start-up when this device has saved drawings, so they show on the map.
// ---------------------------------------------------------------------------
var GEOMAN = "https://cdn.jsdelivr.net/npm/@geoman-io/leaflet-geoman-free@2.20.2/dist/";
function loadScript(src) {
  return new Promise(function (ok, fail) {
    if (document.querySelector("script[src='" + src + "']")) return ok();
    var el = document.createElement("script"); el.src = src; el.onload = function () { ok(); };
    el.onerror = function () { fail(new Error("could not load " + src.split("/").pop())); };
    document.head.appendChild(el);
  });
}
function loadCSS(href) {
  if (document.querySelector("link[href='" + href + "']")) return;
  var el = document.createElement("link"); el.rel = "stylesheet"; el.href = href; document.head.appendChild(el);
}
var drawLoading = null;
function loadDraw() {
  if (!drawLoading) {
    loadCSS(GEOMAN + "leaflet-geoman.css");
    drawLoading = loadScript(GEOMAN + "leaflet-geoman.min.js").then(function () { return loadScript("js/draw.js"); });
  }
  return drawLoading;
}
// Field / Explore: Explore shows the extra tools (marked .xo); kept on this device and in links
function setExplore(on) {
  document.body.classList.toggle("explore", on);
  document.getElementById("explore").textContent = "Explore: " + (on ? "on" : "off");
  try { localStorage.setItem("lunamap-explore", on ? "1" : ""); } catch (e) {}
  writeHash();
}
document.getElementById("explore").onclick = function () { setExplore(!document.body.classList.contains("explore")); };
document.getElementById("aerials").onclick = function () {
  setMenu(null);
  loadScript("js/aerials.js").then(function () { window.openAerials(); })
    .catch(function (e) { toast("Aerial photos unavailable: " + e.message); });
};
document.getElementById("archives").onclick = function () {
  setMenu(null);
  loadScript("js/archives.js").then(function () { window.openArchives(); })
    .catch(function (e) { toast("Archives unavailable: " + e.message); });
};
document.getElementById("view3d").onclick = function () {
  setMenu(null);
  loadScript("js/terrain3d.js").then(function () { window.toggle3D(); })
    .catch(function (e) { toast("3D view unavailable: " + e.message); });
};
document.getElementById("model3d").onclick = function () {
  setMenu(null);
  loadScript("js/model3d.js").then(function () { window.open3D(); })
    .catch(function (e) { toast("3D view unavailable: " + e.message); });
};
document.getElementById("windrose").onclick = function () {
  setMenu(null);
  loadScript("js/windrose.js").then(function () { window.openWindRose(); })
    .catch(function (e) { toast("Wind rose unavailable: " + e.message); });
};
document.getElementById("draw").onclick = function () {
  loadDraw().then(function () { window.toggleDraw(); })
    .catch(function (e) { drawLoading = null; toast("Drawing tools unavailable: " + e.message); });
};
(function () {
  var saved = null; try { saved = localStorage.getItem("lunamap.drawings"); } catch (e) {}
  var sketch = new URLSearchParams(location.search).get("s");
  if (sketch) {
    // a shared sketch: add it to this device's drawings, then drop it from the
    // address so a reload does not add it again
    history.replaceState(null, "", location.pathname + location.hash);
    loadDraw().then(function () { return window.receiveSketch(sketch); })
      .catch(function (e) { drawLoading = null; toast("Could not open the sketch: " + e.message); });
  } else if (saved && saved.indexOf('"features":[]') < 0) loadDraw().catch(function () { drawLoading = null; });
})();

// ---------------------------------------------------------------------------
setOverlay("water", !!st.water);
setOverlay("gates", !!st.gates);
setOverlay("stations", !!st.stations);
if (st.danger) setHazard("danger", true);
if (st.warnings) setHazard("warnings", true);
if (st.history) setHazard("history", true);
if (st.flamm) setHazard("flamm", true);
if (st.roads && typeof setRoads === "function") setRoads(true);
if (st.contours && typeof setContours === "function") setContours(true);
(function () { var keep = ""; try { keep = localStorage.getItem("lunamap-explore") || ""; } catch (e) {} if (st.explore || keep) setExplore(true); })();
setParcels(!st.noParcels);
setGrid(!!st.grid);
setLayer(st.layer || "topo");
if (st.pin) { setPin(L.latLng(st.pin[0], st.pin[1])); if (st.route) findRoute({ fit: false, level: st.routeLevel }); }
