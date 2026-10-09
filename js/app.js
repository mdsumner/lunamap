// lunamap - app.js (classic script; shares globals with the other js/ files, loaded in order)
// ---------------------------------------------------------------------------
// Toolbar: secondary buttons fold away behind "More" on narrow screens
// ---------------------------------------------------------------------------
var barEl = document.querySelector(".bar"), moreBtn = document.getElementById("moretools");
function setToolsOpen(open) {
  barEl.classList.toggle("collapsed", !open);
  moreBtn.textContent = open ? "Less" : "More";
  try { localStorage.setItem("lunamap.tools", open ? "1" : "0"); } catch (e) {}
  fitControls(); placeLabels();
}
moreBtn.onclick = function () { setToolsOpen(barEl.classList.contains("collapsed")); };
(function () {
  var saved = null; try { saved = localStorage.getItem("lunamap.tools"); } catch (e) {}
  setToolsOpen(saved !== null ? saved === "1" : window.innerWidth >= 700);
})();

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
  caches.open(TILE_CACHE).then(function (c) { return c.keys(); }).then(function (k) {
    var txt = "Saved on this device: " + k.length + " tiles";
    if (navigator.storage && navigator.storage.estimate) {
      navigator.storage.estimate().then(function (e) {
        el.textContent = txt + " (" + (e.usage / 1048576).toFixed(0) + " MB used by this site)";
      });
    } else el.textContent = txt;
  }).catch(function () {});
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
    offEstimate(); offStatus();
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
  if (!window.caches || !confirm("Remove all saved map tiles from this device?")) return;
  offSaving = false;
  caches.delete(TILE_CACHE).then(function () { document.getElementById("offprog").textContent = "Cleared"; offStatus(); });
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
setParcels(!st.noParcels);
setGrid(!!st.grid);
setLayer(st.layer || "topo");
if (st.pin) { setPin(L.latLng(st.pin[0], st.pin[1])); if (st.route) findRoute({ fit: false, level: st.routeLevel }); }
