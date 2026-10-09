// lunamap - search.js (classic script; shares globals with the other js/ files, loaded in order)
// ---------------------------------------------------------------------------
// Go to: parse whatever was typed or pasted.
//   grid ref   "265522", "265 522", 4/8/10 figures too (MGA2020, nearest to the view)
//   lon, lat   "147.3257, -42.8821" (default order when it cannot be told apart)
//   lat, lon   "-42.8821 147.3257" (recognised by magnitude, or a "Lat, Lon:" label)
//   MGA        "526598 E 5252225 N" or "526598 5252225" (MGA94 unless labelled MGA2020)
//   DMS / DDM  "42 52 55.6 S 147 19 32.5 E", "S42 52.926 E147 19.542"
// Lines copied from the panel ("MGA94 z55: ...", "Grid ref: ...") work as-is.
// ---------------------------------------------------------------------------
function parseLocation(raw) {
  var line = String(raw).split(/\r?\n/).filter(function (x) { return x.trim(); })[0] || "";
  var hint = "", m = line.match(/^\s*([A-Za-z][^:]*):(.*)$/);
  if (m) { hint = m[1].toLowerCase(); line = m[2]; }
  if (/[A-Za-z]{2,}/.test(line)) return null;           // words: an address, not a coordinate
  var datum = /2020/.test(hint) ? "mga2020" : "mga94";
  var zoneHint = (hint.match(/z\s*(\d{2})/) || [])[1];
  var s = line.replace(/[\u00b0\u00ba\u02da\u2032\u2033'"`:]/g, " ").replace(/[\u2212\u2013]/g, "-").toUpperCase();
  var toks = s.match(/-?\d+(?:\.\d+)?|[NSEW]/g) || [];
  var nums = toks.filter(function (t) { return !/[NSEW]/.test(t); }).map(Number);
  var hasLetters = toks.some(function (t) { return /[NSEW]/.test(t); });
  var c = map.getCenter(), zone = +zoneHint || (Math.floor((c.lng + 180) / 6) + 1), defs = mgaDefs(zone);

  function ll(lat, lon, kind) {
    if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180) || isNaN(lat) || isNaN(lon)) return null;
    return { latlng: L.latLng(lat, lon), kind: kind };
  }
  function fromMGA(e, n, def, kind) { var g = proj4(def, "EPSG:4326", [e, n]); return ll(g[1], g[0], kind); }

  // grid reference: digits only, even count 4..10
  var digits = s.replace(/\s+/g, "");
  if (/^[\d\s]+$/.test(s.trim()) && /^\d+$/.test(digits) && digits.length % 2 === 0 &&
      digits.length >= 4 && digits.length <= 10 && (nums.length === 1 ||
      (nums.length === 2 && s.trim().split(/\s+/)[0].length === digits.length / 2)) || /grid/.test(hint)) {
    if (/^\d+$/.test(digits) && digits.length % 2 === 0) {
      var h = digits.length / 2, unit = Math.pow(10, 5 - h);
      var er = +digits.slice(0, h) * unit, nr = +digits.slice(h) * unit;
      var cm = proj4("EPSG:4326", defs.mga2020, [c.lng, c.lat]);
      function near(r, cv) {           // candidate in the 100 km square closest to the view centre
        var best = null;
        for (var k = Math.floor(cv / 1e5) - 1; k <= Math.floor(cv / 1e5) + 1; k++) {
          var v = k * 1e5 + r + unit / 2;
          if (best === null || Math.abs(v - cv) < Math.abs(best - cv)) best = v;
        }
        return best;
      }
      return fromMGA(near(er, cm[0]), near(nr, cm[1]), defs.mga2020,
        "Grid ref " + digits.slice(0, h) + " " + digits.slice(h) + " (MGA2020 z" + zone + ", centre of " + unit + " m square)");
    }
  }

  // MGA easting/northing: big numbers
  var big = nums.filter(function (v) { return Math.abs(v) >= 1000; });
  if (big.length >= 2) {
    var e = big[0], n = big[1];
    if (e > n) { var t = e; e = n; n = t; }           // northing is the 7-digit one
    return fromMGA(e, n, defs[datum], (datum === "mga2020" ? "MGA2020" : "MGA94") + " z" + zone);
  }

  // angular groups
  var groups = [];
  if (hasLetters) {
    var prefix = /[NSEW]/.test(toks[0]), cur = { n: [], h: null };
    toks.forEach(function (t) {
      if (/[NSEW]/.test(t)) {
        if (prefix) { if (cur.n.length || cur.h) groups.push(cur); cur = { n: [], h: t }; }
        else { cur.h = t; groups.push(cur); cur = { n: [], h: null }; }
      } else cur.n.push(+t);
    });
    if (cur.n.length) groups.push(cur);
  } else {
    var parts = line.split(/[,;]/).filter(function (x) { return x.trim(); });
    if (parts.length === 2) {
      parts.forEach(function (p) {
        var q = (p.replace(/[\u00b0\u00ba\u02da\u2032\u2033'"`:]/g, " ").match(/-?\d+(?:\.\d+)?/g) || []).map(Number);
        groups.push({ n: q, h: null, neg: /-/.test(p) });
      });
    } else if (nums.length === 2) groups = [{ n: [nums[0]] }, { n: [nums[1]] }];
    else if (nums.length === 4) groups = [{ n: nums.slice(0, 2) }, { n: nums.slice(2) }];
    else if (nums.length === 6) groups = [{ n: nums.slice(0, 3) }, { n: nums.slice(3) }];
  }
  if (groups.length !== 2) return null;
  var vals = groups.map(function (g) {
    var d = g.n[0], neg = d < 0 || g.neg || g.h === "S" || g.h === "W";
    var v = Math.abs(d) + (g.n[1] || 0) / 60 + (g.n[2] || 0) / 3600;
    return neg ? -v : v;
  });
  var latFirst;
  if (groups[0].h || groups[1].h) latFirst = groups[0].h === "N" || groups[0].h === "S" ||
                                             groups[1].h === "E" || groups[1].h === "W";
  else if (/lat\s*,\s*lon/.test(hint)) latFirst = true;
  else if (/lon\s*,\s*lat/.test(hint)) latFirst = false;
  else if (Math.abs(vals[0]) > 90) latFirst = false;
  else if (Math.abs(vals[1]) > 90) latFirst = true;
  else latFirst = false;                                // default: lon, lat
  return latFirst ? ll(vals[0], vals[1], "Lat, Lon") : ll(vals[1], vals[0], "Lon, Lat");
}

// ---------------------------------------------------------------------------
// Address search against theLIST SearchService "Address Geocodes" (layer 7).
// Only the start of the street name is required:
//   "pillinger"  "12 pillinger"  "12 Pillinger Drive, Fern Tree"  "3/12 pillinger dr 7054"
// Number ranges ("10-14") match any number inside them; street type is optional
// and matched loosely (Road = Rd); suburb is matched by its start.
// Nearest to the current view first; one match jumps, several give a pick list.
// ---------------------------------------------------------------------------
var GEOCODE = "https://services.thelist.tas.gov.au/arcgis/rest/services/Public/SearchService/MapServer/7/query";
var STREET_TYPES = {
  ROAD: "RD", RD: "RD", STREET: "ST", ST: "ST", AVENUE: "AVE", AVE: "AVE", AV: "AVE",
  DRIVE: "DR", DR: "DR", CRESCENT: "CRES", CRES: "CRES", CR: "CRES", COURT: "CT", CT: "CT",
  PLACE: "PL", PL: "PL", LANE: "LANE", LN: "LANE", HIGHWAY: "HWY", HWY: "HWY", PARADE: "PDE", PDE: "PDE",
  TERRACE: "TCE", TCE: "TCE", CLOSE: "CL", CL: "CL", GROVE: "GR", GR: "GR", WAY: "WAY", TRACK: "TRK",
  TRK: "TRK", BOULEVARD: "BVD", BVD: "BVD", BLVD: "BVD", CIRCUIT: "CCT", CCT: "CCT", ESPLANADE: "ESP",
  ESP: "ESP", RISE: "RISE", VIEW: "VIEW", WALK: "WALK", SQUARE: "SQ", SQ: "SQ", HILL: "HILL", GLADE: "GLDE",
  PATH: "PATH", RIDGE: "RDGE", RDGE: "RDGE", MEWS: "MEWS", ROW: "ROW", GARDENS: "GDNS", GDNS: "GDNS"
};
function normType(t) { t = String(t || "").toUpperCase().replace(/\./g, ""); return STREET_TYPES[t] || t; }
function sqlq(v) { return "'" + String(v).replace(/'/g, "''") + "'"; }

function parseAddress(raw) {
  var line = String(raw).split(/\r?\n/)[0].replace(/^\s*address\s*:/i, "");
  var s = line.toUpperCase().replace(/[^A-Z0-9'\/\- ]+/g, " ").replace(/\s+/g, " ").trim();
  var a = { unit: null, num: null };
  var m = /^([0-9]+[A-Z]?)\s*\/\s*([0-9]+)[A-Z]?(?:\s*-\s*[0-9]+[A-Z]?)?\s+(.*)$/.exec(s) ||
          /^()([0-9]+)[A-Z]?(?:\s*-\s*[0-9]+[A-Z]?)?\s+(.*)$/.exec(s);
  if (m) { a.unit = m[1] || null; a.num = +m[2]; s = m[3]; }
  var words = s.split(" ").filter(function (w) { return w && w !== "TAS" && w !== "TASMANIA"; });
  var pc = words.length && /^7[0-9]{3}$/.test(words[words.length - 1]) ? +words.pop() : null;
  a.postcode = pc;
  // split street / locality at a street-type word if there is one
  // every type word after the first word is a candidate split, earliest first
  // ("MAIN RD NEW NORFOLK", and "MOUNT VIEW CRES" where VIEW is also a type)
  a.splits = [];
  for (var i = 1; i < words.length; i++) if (STREET_TYPES[words[i]])
    a.splits.push({ street: words.slice(0, i).join(" "), type: normType(words[i]), loc: words.slice(i + 1).join(" ") });
  for (var k = words.length; k >= 1; k--)            // no type word: longest street first
    a.splits.push({ street: words.slice(0, k).join(" "), type: null, loc: words.slice(k).join(" ") });
  return words.length ? a : null;
}

function geocodeQuery(where) {
  var url = GEOCODE + "?where=" + encodeURIComponent(where) +
    "&outFields=ADDRESS,UNIT_NUMBER,STREET_NUMBER_FROM,STREET_NUMBER_TO,STREET,STREET_TYPE,LOCALITY,POSTCODE" +
    "&returnGeometry=true&outSR=4326&f=json";
  return fetch(url).then(function (r) { return r.json(); }).then(function (j) {
    if (j.error) throw new Error(j.error.message || "query failed");
    return (j.features || []).filter(function (f) { return f.geometry; });
  });
}

function addressSearch(raw) {
  var a = parseAddress(raw);
  if (!a) return Promise.resolve(null);
  var c = map.getCenter();
  function where(sp, withNum) {
    var w = ["UPPER(STREET) LIKE " + sqlq(sp.street + "%")];
    if (sp.loc) w.push("UPPER(LOCALITY) LIKE " + sqlq(sp.loc + "%"));
    if (a.postcode) w.push("POSTCODE = " + a.postcode);
    if (withNum && a.num !== null)
      w.push("(STREET_NUMBER_FROM = " + a.num + " OR (STREET_NUMBER_FROM <= " + a.num +
             " AND STREET_NUMBER_TO >= " + a.num + "))");
    return w.join(" AND ");
  }
  function finish(feats, sp, numMatched) {
    if (sp.type) {                                    // loose street-type filter, dropped if it empties
      var t = feats.filter(function (f) { return normType(f.attributes.STREET_TYPE) === sp.type; });
      if (t.length) feats = t;
    }
    if (numMatched && a.unit) {
      var u = feats.filter(function (f) { return String(f.attributes.UNIT_NUMBER || "").toUpperCase() === a.unit; });
      if (u.length) feats = u;
    }
    var items;
    if (numMatched) {
      items = feats.map(function (f) { return { label: f.attributes.ADDRESS, lat: f.geometry.y, lon: f.geometry.x }; });
    } else {                                          // street only: one entry per street + locality
      var g = {};
      feats.forEach(function (f) {
        var at = f.attributes, key = [at.STREET, at.STREET_TYPE, at.LOCALITY].join("|");
        (g[key] = g[key] || { at: at, pts: [] }).pts.push(f.geometry);
      });
      items = Object.keys(g).map(function (k) {
        var e = g[k], p = e.pts.slice().sort(function (x, y) { return x.y - y.y; })[Math.floor(e.pts.length / 2)];
        return { label: [e.at.STREET, e.at.STREET_TYPE].filter(Boolean).join(" ") + ", " + e.at.LOCALITY,
                 sub: e.pts.length + (e.pts.length === 1 ? " address" : " addresses"), lat: p.y, lon: p.x };
      });
    }
    items.forEach(function (it) { it.d = map.distance(c, L.latLng(it.lat, it.lon)); });
    items.sort(function (x, y) { return x.d - y.d; });
    return { items: items, numMatched: numMatched, wanted: a.num };
  }
  // try each street/locality split: with the number, then without it
  var i = 0;
  function next() {
    if (i >= a.splits.length) return Promise.resolve({ items: [] });
    var sp = a.splits[i++];
    var p = a.num !== null ? geocodeQuery(where(sp, true)) : Promise.resolve([]);
    return p.then(function (fs) {
      if (fs.length) return finish(fs, sp, true);
      return geocodeQuery(where(sp, false)).then(function (fs2) {
        return fs2.length ? finish(fs2, sp, false) : next();
      });
    });
  }
  return next();
}

var resultsEl = document.getElementById("results");
function hideResults() { resultsEl.style.display = "none"; resultsEl.innerHTML = ""; fitControls(); }
function goTo(latlng, msg, zoom) {
  hideResults(); document.getElementById("q").blur();
  map.setView(latlng, Math.max(map.getZoom(), zoom || 17));
  setPin(latlng); if (msg) toast(msg);
}
function showResults(res) {
  resultsEl.innerHTML = "";
  if (res.wanted !== null && res.wanted !== undefined && !res.numMatched) {
    var n = document.createElement("div"); n.className = "note";
    n.textContent = "No number " + res.wanted + " found - showing streets"; resultsEl.appendChild(n);
  }
  res.items.slice(0, 12).forEach(function (it) {
    var b = document.createElement("button"); b.type = "button";
    b.textContent = it.label;
    var sm = document.createElement("small");
    sm.textContent = "  " + (it.sub ? it.sub + ", " : "") + (it.d < 1000 ? Math.round(it.d) + " m" : (it.d / 1000).toFixed(it.d < 1e4 ? 1 : 0) + " km") + " away";
    b.appendChild(sm);
    b.onclick = function () { goTo(L.latLng(it.lat, it.lon), null); };
    resultsEl.appendChild(b);
  });
  resultsEl.style.display = "block"; fitControls();
}

document.getElementById("goto").addEventListener("submit", function (ev) {
  ev.preventDefault();
  var q = document.getElementById("q"), r = null;
  var mb = parseMapbook(q.value);
  if (mb) {
    var bname = BOOKS[mb.book].name;
    findMapbook(mb).then(function (ft) {
      if (!ft) { toast("No " + bname.toLowerCase() + (mb.page ? " page " : " square ") + fmtMapref(mb.refs[0])); return; }
      var gj = L.geoJSON(ft), bb = gj.getBounds();
      if (mb.page) { hideResults(); q.blur(); map.fitBounds(bb); toast(bname + " page " + fmtMapref(ft.properties.MAPREF)); }
      else { goTo(bb.getCenter(), bname + " " + fmtMapref(ft.properties.MAPREF) + " (centre of square)", 16); }
      mbOutline.clearLayers(); mbOutline.addLayer(L.geoJSON(ft, { interactive: false,
        style: { color: "#6a1b9a", weight: 2, dashArray: "6 4", fill: false } }));
    }).catch(function (e) { toast(bname + " search failed: " + e.message); });
    return;
  }
  try { r = parseLocation(q.value); } catch (e) { r = null; }
  if (r) { goTo(r.latlng, r.kind, 15); return; }
  if (!/[A-Za-z]{2,}/.test(q.value)) { toast("Could not read that location"); return; }
  toast("Searching addresses...");
  addressSearch(q.value).then(function (res) {
    if (!res || !res.items.length) { toast("No address found"); return; }
    var one = res.items.length === 1 && (res.numMatched || res.wanted === null);
    if (one) { var it = res.items[0]; goTo(L.latLng(it.lat, it.lon), it.label, res.numMatched ? 17 : 16); return; }
    document.getElementById("toast").style.display = "none";
    showResults(res);
  }).catch(function (e) { toast("Address search failed: " + e.message); });
});
document.getElementById("q").addEventListener("input", function () { if (!this.value) hideResults(); });
map.on("click", hideResults);
