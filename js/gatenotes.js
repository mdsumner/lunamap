// lunamap - gatenotes.js: your own notes on gates - which key opens it, whether you
// have that key, anything else worth knowing, and when it was last checked.
//   Tap a gate (Gates layer, or the dots on Road types), then "Gate note" in the pin panel.
//   Notes stay on this device (localStorage) and are never uploaded. Export writes a GeoJSON
//   file to share with your group; Import merges one in (the newer note for a gate wins).
//   Gates with notes show a small key symbol from zoom 11.
//   Routing: a gate you have a key for costs about a minute instead of being avoided,
//   and directions name the key ("passes 1 gate or barrier (gate - STT key)").
// Gates are matched by theLIST Transport Node OBJECTID, or by position (within 10 m) if the
// id has changed in a later data release.
// ---------------------------------------------------------------------------
(function () {
  var KEY = "lunamap-gate-notes", KEY_PEN_S = 60;
  var notes = {};
  try { notes = JSON.parse(localStorage.getItem(KEY) || "{}") || {}; } catch (e) { notes = {}; }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(notes)); } catch (e) { toast("Could not save on this device: " + e.message); } }
  function idKey(id) { return "id" + id; }
  function today() { var d = new Date(); return d.getFullYear() + "-" + ("0" + (d.getMonth() + 1)).slice(-2) + "-" + ("0" + d.getDate()).slice(-2); }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return "&#" + c.charCodeAt(0) + ";"; }); }

  // the note for a gate, by id or (failing that) by position
  function noteFor(id, x, y) {
    if (id != null && notes[idKey(id)]) return notes[idKey(id)];
    if (x == null) return null;
    var best = null, bd = 10;
    Object.keys(notes).forEach(function (k) { var n = notes[k], d = map.distance([y, x], [n.lat, n.lon]); if (d < bd) { bd = d; best = n; } });
    return best;
  }
  function keyText(n) {
    if (!n) return "";
    return (n.key ? n.key + (n.hasKey ? " key" : " key (we don't have it)") : n.hasKey ? "we have a key" : "no key noted");
  }
  window.gateNoteFor = noteFor;
  // routing hook (route.js markGates): penalty and label for a gate, given its note
  window.gateNoteAdjust = function (info, g) {
    var n = noteFor(g[3], g[0], g[1]); if (!n) return info;
    if (n.hasKey) info.pen = Math.min(info.pen, KEY_PEN_S);
    info.label = String(info.type).toLowerCase() + " - " + keyText(n);
    return info;
  };
  function changed() {
    if (typeof routeCache !== "undefined") routeCache = null;
    if (window.abInvalidate) window.abInvalidate();
    drawMarks();
  }

  // ---- key symbols on the map ---------------------------------------------------------
  var marks = L.layerGroup().addTo(map);
  var keyIcon = L.divIcon({ className: "", iconSize: [18, 18], iconAnchor: [9, 9],
    html: "<div class='wsym gnkey' style='width:18px;height:18px'><span>K</span></div>" });
  function drawMarks() {
    marks.clearLayers();
    if (map.getZoom() < 11) return;
    var b = map.getBounds().pad(0.2);
    Object.keys(notes).forEach(function (k) {
      var n = notes[k], ll = L.latLng(n.lat, n.lon); if (!b.contains(ll)) return;
      L.marker(ll, { icon: keyIcon, zIndexOffset: 200, title: "Gate note: " + keyText(n) + (n.note ? " - " + n.note : "") })
        .on("click", function () { pickFeature(ll, { what: n.barrier ? titleCase(n.barrier) : "Gate", detail: "gate note", gate: { id: n.id, type: n.barrier || "GATE", x: n.lon, y: n.lat } }, { line: true }); })
        .addTo(marks);
    });
  }
  map.on("zoomend moveend", drawMarks);

  // the pin panel row and button
  window.gateNoteRows = function () {
    var g = featureInfo && featureInfo.gate; if (!g) return [];
    var n = noteFor(g.id, g.x, g.y);
    return [{ k: "Gate note", v: n ? joinBits([keyText(n), n.note, n.checked ? "checked " + n.checked : null]) : "(none - tap Gate note to add one)" }];
  };

  // ---- sheet --------------------------------------------------------------------------
  var sheet = null, cur = null;
  function ensureSheet() {
    if (sheet) return sheet;
    sheet = document.createElement("div"); sheet.id = "gnsheet"; sheet.className = "sheet";
    sheet.innerHTML = "<h2><span>Gate note</span><button id='gnclose' aria-label='Close'>x</button></h2>" +
      "<div id='gnwhat' class='small' style='margin-bottom:6px'></div>" +
      "<label><input type='checkbox' id='gnhas'> We have a key for this gate</label>" +
      "<div class='small' style='margin-top:6px'>Key (which one)</div>" +
      "<input id='gnkey' list='gnkeys' placeholder='e.g. STT, Parks, council, TFS master' style='width:100%'><datalist id='gnkeys'></datalist>" +
      "<div class='small' style='margin-top:6px'>Note</div>" +
      "<textarea id='gnnote' rows='3' style='width:100%' placeholder='e.g. chain and padlock, key on truck ring; ring the property owner first'></textarea>" +
      "<div class='small' style='margin-top:6px'>Last checked <input id='gnchecked' type='date'></div>" +
      "<div class='acts'><button id='gnsave'>Save</button><button id='gndel'>Delete note</button></div>" +
      "<hr><div class='small'><b id='gncount'></b> on this device. Notes are kept on this phone only and never uploaded.</div>" +
      "<div class='acts'><button id='gnexport'>Export notes</button><button id='gnimport'>Import notes</button>" +
      "<input type='file' id='gnfile' accept='.geojson,.json,application/json,application/geo+json' style='display:none'></div>" +
      "<p class='small' style='color:#666'>Export writes a GeoJSON file (it also opens in QGIS) to share with your group. " +
      "Keep it within your group: do not post it publicly. Import merges a file in; for each gate the more recently " +
      "checked note wins.</p>";
    document.body.appendChild(sheet);
    L.DomEvent.disableClickPropagation(sheet);
    sheet.querySelector("#gnclose").onclick = function () { sheet.style.display = "none"; };
    sheet.querySelector("#gnsave").onclick = saveCur;
    sheet.querySelector("#gndel").onclick = function () {
      if (!cur) return;
      var n = noteFor(cur.id, cur.x, cur.y); if (!n) { toast("No note for this gate"); return; }
      Object.keys(notes).forEach(function (k) { if (notes[k] === n) delete notes[k]; });
      save(); changed(); fill(); toast("Gate note deleted"); refreshPanel();
    };
    sheet.querySelector("#gnexport").onclick = exportNotes;
    sheet.querySelector("#gnimport").onclick = function () { sheet.querySelector("#gnfile").click(); };
    sheet.querySelector("#gnfile").onchange = function (e) {
      var f = e.target.files[0]; if (!f) return;
      f.text().then(importNotes).catch(function (err) { toast("Import failed: " + err.message); });
      e.target.value = "";
    };
    return sheet;
  }
  function fill() {
    var n = cur ? noteFor(cur.id, cur.x, cur.y) : null;
    sheet.querySelector("#gnwhat").textContent = cur ? (featureInfo ? featureInfo.what + (featureInfo.detail ? " - " + featureInfo.detail : "") : "Gate") : "Tap a gate first.";
    sheet.querySelector("#gnhas").checked = !!(n && n.hasKey);
    sheet.querySelector("#gnkey").value = n ? n.key || "" : "";
    sheet.querySelector("#gnnote").value = n ? n.note || "" : "";
    sheet.querySelector("#gnchecked").value = n && n.checked ? n.checked : today();
    var keys = {}; Object.keys(notes).forEach(function (k) { if (notes[k].key) keys[notes[k].key] = 1; });
    sheet.querySelector("#gnkeys").innerHTML = Object.keys(keys).sort().map(function (k) { return "<option value='" + esc(k) + "'>"; }).join("");
    var c = Object.keys(notes).length;
    sheet.querySelector("#gncount").textContent = c + (c === 1 ? " gate note" : " gate notes");
    sheet.querySelector("#gndel").style.display = n ? "" : "none";
  }
  function saveCur() {
    if (!cur) return;
    var old = noteFor(cur.id, cur.x, cur.y);
    if (old) Object.keys(notes).forEach(function (k) { if (notes[k] === old) delete notes[k]; });
    var n = { id: cur.id, lon: +(+cur.x).toFixed(7), lat: +(+cur.y).toFixed(7), barrier: cur.type || "GATE",
      hasKey: sheet.querySelector("#gnhas").checked, key: sheet.querySelector("#gnkey").value.trim(),
      note: sheet.querySelector("#gnnote").value.trim(), checked: sheet.querySelector("#gnchecked").value || today() };
    notes[cur.id != null ? idKey(cur.id) : "xy" + n.lon + "," + n.lat] = n;
    save(); changed(); fill(); toast("Gate note saved on this device"); refreshPanel();
  }
  function refreshPanel() { if (pin) showCoords(pin.getLatLng()); }

  function exportNotes() {
    var ks = Object.keys(notes);
    if (!ks.length) { toast("No gate notes to export"); return; }
    var gj = { type: "FeatureCollection", lunamap: "gate-notes", exported: new Date().toISOString(),
      features: ks.map(function (k) { var n = notes[k];
        return { type: "Feature", geometry: { type: "Point", coordinates: [n.lon, n.lat] },
          properties: { gate_id: n.id, barrier: n.barrier, has_key: n.hasKey, key: n.key, note: n.note, checked: n.checked } }; }) };
    var d = new Date(), stamp = d.getFullYear() + ("0" + (d.getMonth() + 1)).slice(-2) + ("0" + d.getDate()).slice(-2);
    var url = URL.createObjectURL(new Blob([JSON.stringify(gj, null, 1)], { type: "application/geo+json" }));
    var a = document.createElement("a"); a.href = url; a.download = "lunamap-gate-notes-" + stamp + ".geojson";
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
    toast("Exported " + ks.length + " gate notes");
  }
  function importNotes(text) {
    var gj = JSON.parse(text), added = 0, updated = 0, kept = 0;
    (gj.features || []).forEach(function (f) {
      var p = f.properties || {}, c = f.geometry && f.geometry.coordinates; if (!c) return;
      var n = { id: p.gate_id != null ? p.gate_id : null, lon: +c[0], lat: +c[1], barrier: p.barrier || "GATE",
        hasKey: !!p.has_key, key: p.key || "", note: p.note || "", checked: p.checked || "" };
      var old = noteFor(n.id, n.lon, n.lat);
      if (old && (old.checked || "") >= (n.checked || "")) { kept++; return; }
      if (old) { Object.keys(notes).forEach(function (k) { if (notes[k] === old) delete notes[k]; }); updated++; } else added++;
      notes[n.id != null ? idKey(n.id) : "xy" + n.lon + "," + n.lat] = n;
    });
    save(); changed(); if (sheet) fill(); refreshPanel();
    toast("Gate notes: " + added + " added, " + updated + " updated, " + kept + " kept as they were");
  }

  window.openGateNote = function () {
    var g = featureInfo && featureInfo.gate;
    if (!g) { toast("Tap a gate on the map first (Gates or Road types layer)"); return; }
    cur = { id: g.id, type: g.type, x: g.x, y: g.y };
    ensureSheet().style.display = "block"; fill(); setFolded(true);
  };
  document.getElementById("gatenote").onclick = window.openGateNote;
  drawMarks();
})();
