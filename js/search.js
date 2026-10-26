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
  var datum = /2020/.test(hint) ? "mga2020" : /94/.test(hint) ? "mga94" : datumKey();
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
      var cm = proj4("EPSG:4326", defs[datum], [c.lng, c.lat]);
      function near(r, cv) {           // candidate in the 100 km square closest to the view centre
        var best = null;
        for (var k = Math.floor(cv / 1e5) - 1; k <= Math.floor(cv / 1e5) + 1; k++) {
          var v = k * 1e5 + r + unit / 2;
          if (best === null || Math.abs(v - cv) < Math.abs(best - cv)) best = v;
        }
        return best;
      }
      return fromMGA(near(er, cm[0]), near(nr, cm[1]), defs[datum],
        "Grid ref " + digits.slice(0, h) + " " + digits.slice(h) + " (" + (datum === "mga94" ? "MGA94" : "MGA2020") + " z" + zone + ", centre of " + unit + " m square)");
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

// Road and place names, alongside addresses: "Styx Road", "styx rd", "mount lloyd", "Uxbridge".
// Roads come from theLIST transport network (layer 8, the routing data), one entry per stretch
// of a name (pieces within about 2 km of each other join up), so a remote road with no
// addresses on it is still found. Places come from the OpenStreetMap place list in data/.
var ROAD_WORDS = { RD: "ROAD", ST: "STREET", AVE: "AVENUE", AV: "AVENUE", DR: "DRIVE", CRES: "CRESCENT", CR: "CRESCENT",
  CT: "COURT", PL: "PLACE", LN: "LANE", HWY: "HIGHWAY", PDE: "PARADE", TCE: "TERRACE", CL: "CLOSE", GR: "GROVE",
  TRK: "TRACK", BVD: "BOULEVARD", BLVD: "BOULEVARD", CCT: "CIRCUIT", ESP: "ESPLANADE", MT: "MOUNT", "MT.": "MOUNT", STH: "SOUTH", NTH: "NORTH" };
var roadHi = L.layerGroup().addTo(map);
function nameWords(raw) {
  var s = String(raw).split(/\r?\n/)[0].toUpperCase().replace(/[^A-Z0-9' ]+/g, " ").replace(/\s+/g, " ").trim();
  return s ? s.split(" ").map(function (w) { return ROAD_WORDS[w] || w; }).join(" ") : "";
}
// "browns road fern tree", "styx rd", "browns fern tree": split off a locality after the road
// type word, or a trailing place name, so it can rank and filter results
var ROAD_TYPE_FULL = {};
Object.keys(ROAD_WORDS).forEach(function (k) { ROAD_TYPE_FULL[ROAD_WORDS[k]] = 1; });
["WAY", "RISE", "VIEW", "WALK", "ROW", "MEWS", "HILL", "PATH", "LINK", "TRACK", "GARDENS", "SQUARE", "RIDGE", "GLADE", "BYPASS"]
  .forEach(function (w) { ROAD_TYPE_FULL[w] = 1; });
delete ROAD_TYPE_FULL.MOUNT; delete ROAD_TYPE_FULL.SOUTH; delete ROAD_TYPE_FULL.NORTH;
var allPlaces = null;
function loadAllPlaces() {
  if (!allPlaces) allPlaces = fetch("data/osm-places-tas.json").then(function (r) { return r.json(); })
    .then(function (d) { return d.places; }).catch(function () { allPlaces = null; return []; });
  return allPlaces;
}
var LOC_TYPES = { city: 1, town: 1, village: 1, suburb: 1, hamlet: 1, locality: 1, neighbourhood: 1 };
function nearestLocality(ps, lat, lon) {
  var best = null, bd = 15000;
  ps.forEach(function (p) { if (!LOC_TYPES[p[4]]) return; var d = map.distance([lat, lon], [p[2], p[3]]); if (d < bd) { bd = d; best = p[1]; } });
  return best;
}
function splitQuery(raw, ps) {
  var words = nameWords(raw).split(" ").filter(Boolean), c = map.getCenter();
  var out = { name: words.join(" "), loc: "", locPt: null };
  var i, k;
  for (i = 1; i < words.length - 1; i++) if (ROAD_TYPE_FULL[words[i]]) { out.name = words.slice(0, i + 1).join(" "); out.loc = words.slice(i + 1).join(" "); break; }
  if (!out.loc) for (k = 1; k < words.length; k++) {
    var tail = words.slice(k).join(" ");
    if (ps.some(function (p) { return String(p[1]).toUpperCase() === tail; })) { out.name = words.slice(0, k).join(" "); out.loc = tail; break; }
  }
  if (out.loc) {                      // the place of that name nearest the view
    ps.forEach(function (p) {
      if (String(p[1]).toUpperCase().indexOf(out.loc) !== 0) return;
      var d = map.distance(c, [p[2], p[3]]);
      if (!out.locPt || d < out.locPt.d) out.locPt = { d: d, ll: L.latLng(p[2], p[3]), name: p[1] };
    });
  }
  return out;
}
function roadSearch(q, ps) {
  var name = q.name;
  if (!name || name.length < 3 || /^[0-9]/.test(name)) return Promise.resolve([]);
  var url = LISTPUB + "TopographyAndRelief/MapServer/8/query?where=" + encodeURIComponent("UPPER(PRI_NAME) LIKE " + sqlq(name + "%")) +
    "&outFields=OBJECTID,PRI_NAME,TRAN_CLASS,SURFACE_TY&returnGeometry=true&outSR=4326&maxAllowableOffset=0.0002&geometryPrecision=5&f=json";
  return fetch(url).then(function (r) { return r.json(); }).then(function (j) {
    if (j.error) throw new Error(j.error.message);
    var byName = {};
    (j.features || []).forEach(function (f) {
      if (!f.geometry || !f.geometry.paths) return;
      var nm = f.attributes.PRI_NAME; (byName[nm] = byName[nm] || []).push(f);
    });
    var items = [];
    Object.keys(byName).forEach(function (nm) {
      // join pieces whose ends come within ~2 km into stretches (same name, different places stay apart)
      var fs = byName[nm], grp = fs.map(function (_, i) { return i; });
      function root(i) { while (grp[i] !== i) i = grp[i] = grp[grp[i]]; return i; }
      var ends = fs.map(function (f) { var ps2 = f.geometry.paths; return [ps2[0][0], ps2[ps2.length - 1][ps2[ps2.length - 1].length - 1]]; });
      for (var a = 0; a < fs.length; a++) for (var b = a + 1; b < fs.length; b++) {
        if (root(a) === root(b)) continue;
        var near = ends[a].some(function (p) { return ends[b].some(function (q2) { return map.distance([p[1], p[0]], [q2[1], q2[0]]) < 2000; }); });
        if (near) grp[root(a)] = root(b);
      }
      var clusters = {};
      fs.forEach(function (f, i) { (clusters[root(i)] = clusters[root(i)] || []).push(f); });
      Object.keys(clusters).forEach(function (k) {
        var cf = clusters[k], len = 0, surf = {}, lines = [], bb = L.latLngBounds([]);
        cf.forEach(function (f) { surf[f.attributes.SURFACE_TY] = 1; f.geometry.paths.forEach(function (p) {
          var ll = p.map(function (c) { return [c[1], c[0]]; }); lines.push(ll); ll.forEach(function (x) { bb.extend(x); });
          for (var i = 1; i < ll.length; i++) len += map.distance(ll[i - 1], ll[i]); }); });
        var mid = bb.getCenter(), best = null;           // a point on the road near its middle
        lines.forEach(function (l) { l.forEach(function (x) { var d = map.distance(x, mid); if (!best || d < best.d) best = { d: d, x: x }; }); });
        var loc = nearestLocality(ps, best.x[0], best.x[1]);
        items.push({ label: titleCase(nm), kind: "road", lat: best.x[0], lon: best.x[1], lines: lines, bounds: bb, locality: loc,
          sub: (loc ? loc + ", " : "") + "road, " + fmtDist(len) + (surf.Unsealed || surf["4WD required"] ? (surf.Sealed ? ", partly unsealed" : ", unsealed") : "") });
      });
    });
    return items;
  }).catch(function () { return []; });
}
function placeSearch(raw, ps) {
  var name = nameWords(raw).toLowerCase();
  if (!name || name.length < 3) return [];
  return ps.filter(function (p) { return String(p[1]).toLowerCase().indexOf(name) === 0; }).slice(0, 8)
    .map(function (p) { return { label: p[1], kind: "place", sub: String(p[4]).replace(/_/g, " "), lat: p[2], lon: p[3], locality: p[1] }; });
}
// Property names from the cadastre (PROP_NAME, e.g. a farm or homestead name; FEAT_NAME for some
// reserves), used when nothing else matches. Matches the start of the name or of any word in it;
// with a locality typed, also the name part within that locality.
function propertySearch(text, qq) {
  var raw = String(text).split(/\r?\n/)[0].toUpperCase().replace(/[^A-Z0-9'. &-]+/g, " ").replace(/\s+/g, " ").trim();
  if (raw.length < 3) return Promise.resolve([]);
  function q(name, loc) {
    var w = "(UPPER(PROP_NAME) LIKE " + sqlq(name + "%") + " OR UPPER(PROP_NAME) LIKE " + sqlq("% " + name + "%") +
            " OR UPPER(FEAT_NAME) LIKE " + sqlq(name + "%") + ")" + (loc ? " AND UPPER(PROP_ADD2) LIKE " + sqlq(loc + "%") : "");
    return fetch(CAD + "/0/query?where=" + encodeURIComponent(w) + "&outFields=PID,PROP_NAME,FEAT_NAME,PROP_ADD,PROP_ADD2" +
      "&returnGeometry=true&outSR=4326&maxAllowableOffset=0.0001&geometryPrecision=6&resultRecordCount=60&f=geojson")
      .then(function (r) { return r.json(); }).then(function (j) { return j.features || []; });
  }
  var first = q(raw, "");
  return first.then(function (fs) { return fs.length || !qq.loc ? fs : q(qq.name, qq.loc); }).then(function (fs) {
    var g = {};
    fs.forEach(function (f) {
      var p = f.properties || {}, nm = p.PROP_NAME || p.FEAT_NAME; if (!nm || !f.geometry) return;
      var k = nm + "|" + (p.PROP_ADD2 || ""); if (g[k]) return;
      var ll = labelPoint(f.geometry); if (!ll) return;
      g[k] = { label: titleCase(nm), kind: "property", lat: ll.lat, lon: ll.lng,
        locality: String(p.PROP_ADD2 || "").replace(/\s+TAS\s+\d{4}$/, ""),
        sub: "property" + (p.PROP_ADD ? ", " + titleCase(p.PROP_ADD.replace(/\s+TAS\s+\d{4}$/, "")) : "") };
    });
    return Object.keys(g).map(function (k) { return g[k]; });
  }).catch(function () { return []; });
}
// order results: those in the locality asked for first (nearest to it), then nearest to the view
function rankResults(items, q) {
  var c = map.getCenter(), want = q.loc;
  items.forEach(function (it) {
    var ll = L.latLng(it.lat, it.lon);
    it.d = map.distance(c, ll);
    var loc = String(it.locality || (it.kind ? "" : String(it.label).split(",").slice(1).join(",")) || "").trim().toUpperCase();
    it.inLoc = want ? (loc.indexOf(want) === 0 || (q.locPt && map.distance(q.locPt.ll, ll) < 4000)) : false;
    it.key = q.locPt ? map.distance(q.locPt.ll, ll) : it.d;
  });
  return items.sort(function (x, y) { return (x.inLoc === y.inLoc ? 0 : x.inLoc ? -1 : 1) || x.key - y.key; });
}
function showRoad(it) {
  hideResults(); document.getElementById("q").blur();
  roadHi.clearLayers();
  roadHi.addLayer(L.polyline(it.lines, { color: "#ffeb3b", weight: 10, opacity: 0.7, interactive: false }));
  roadHi.addLayer(L.polyline(it.lines, { color: "#e65100", weight: 3, opacity: 0.9, interactive: false }));
  var topPad = document.querySelector(".bar").getBoundingClientRect().bottom + 10;
  map.fitBounds(it.bounds, { paddingTopLeft: [30, topPad], paddingBottomRight: [30, 30], maxZoom: 16 });
  toast(it.label + " (" + it.sub + ") - tap the map to pin a spot");
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
    b.onclick = function () { if (it.kind === "road") showRoad(it); else goTo(L.latLng(it.lat, it.lon), null, it.kind === "place" ? 14 : 17); };
    resultsEl.appendChild(b);
  });
  resultsEl.style.display = "block"; fitControls();
}

// Named places outside theLIST's coverage, found by name in Go to (and from Tools).
// theLIST basemaps stop at Tasmania, so these switch to a worldwide basemap.
var PLACES = [
  { re: /^\s*(macquarie(\s+is(land|\.)?)?|macca|mi\s+station)\s*$/i, name: "Macquarie Island",
    bounds: [[-54.79, 158.80], [-54.48, 158.98]], base: "s2",
    note: "Macquarie Island (station at the isthmus, north end). theLIST maps stop at Tasmania, so the basemap is satellite; " +
          "grid references here are UTM zone 57.",
    marker: [-54.5, 158.94], label: "Macquarie Island station", bomWmo: 94998,
    links: [["Station webcam (AAD)", "https://www.antarctica.gov.au/antarctic-operations/webcams/macquarie-island/"],
            ["Daily weather observations (BOM)", "https://www.bom.gov.au/climate/dwo/IDCJDW9204.latest.shtml"],
            ["About the station (AAD)", "https://www.antarctica.gov.au/living-and-working/stations/macquarie-island/"]] }
];
// a marker for each named place, with its links; the BOM latest-observations link uses the
// station list (data/bom-stations-tas.json) when it has the station
PLACES.forEach(function (pl) {
  if (!pl.marker) return;
  var icon = L.divIcon({ className: "", iconSize: [18, 18], iconAnchor: [9, 9],
    html: "<div style='width:14px;height:14px;border-radius:50%;background:#1565c0;border:2px solid #fff;box-shadow:0 0 3px rgba(0,0,0,.5)'></div>" });
  var m = L.marker(pl.marker, { icon: icon, title: pl.label, zIndexOffset: 300 }).addTo(map);
  m.bindPopup(function () {
    var html = "<b>" + pl.label + "</b><br>" + pl.links.map(function (l) {
      return "<a href='" + l[1] + "' target='_blank' rel='noopener'>" + l[0] + "</a>"; }).join("<br>");
    if (pl.bomWmo) html += "<br><a href='https://www.bom.gov.au/products/IDT60801/IDT60801." + pl.bomWmo +
      ".shtml' target='_blank' rel='noopener'>Latest observations (BOM)</a>";
    return html;
  });
});
function showPlace(pl) {
  hideResults(); document.getElementById("q").blur();
  if (isListBase(sel.value)) setLayer(pl.base);
  map.fitBounds(pl.bounds);
  toast(pl.note);
}
window.goToPlace = function (name) { var pl = PLACES.filter(function (x) { return x.name === name; })[0]; if (pl) showPlace(pl); };
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
  var place = PLACES.filter(function (x) { return x.re.test(q.value); })[0];
  if (place) { showPlace(place); return; }
  try { r = parseLocation(q.value); } catch (e) { r = null; }
  if (r) { goTo(r.latlng, r.kind, 15); return; }
  if (!/[A-Za-z]{2,}/.test(q.value)) { toast("Could not read that location"); return; }
  toast("Searching...");
  var text = q.value;
  loadAllPlaces().then(function (ps) {
    var qq = splitQuery(text, ps);
    return Promise.all([addressSearch(text).catch(function () { return null; }), roadSearch(qq, ps), placeSearch(text, ps)])
      .then(function (r3) { r3.push(qq); return r3; });
  }).then(function (r3) {
    var res = r3[0] || { items: [] }, qq = r3[3];
    // a numbered address that matched wins; otherwise places, roads and streets together
    if (!(res.numMatched && res.items.length)) {
      var roads = r3[1];
      // a street from the address search that is also a road found here: keep the road (it shows the whole road)
      var streets = res.items.filter(function (it) {
        var nm = String(it.label).split(",")[0].toUpperCase(), base = nameWords(nm);
        return !roads.some(function (r) { return r.label.toUpperCase() === base && map.distance([r.lat, r.lon], [it.lat, it.lon]) < 3000; });
      });
      res.items = rankResults(r3[2].concat(roads, streets), qq);
      if (!r3[0] || !r3[0].numMatched) res.wanted = r3[0] && r3[0].numMatched === false ? r3[0].wanted : null;
      // a locality was given and exactly one result is in it: go straight there
      var inLoc = res.items.filter(function (it) { return it.inLoc && it.kind !== "place"; });
      if (qq.loc && inLoc.length === 1 && res.wanted === null) res.items = inLoc;
    }
    if (res.items.length) return res;
    // nothing else: try property names
    toast("Searching property names...");
    return propertySearch(text, qq).then(function (props) { res.items = rankResults(props, qq); res.wanted = null; res.props = true; return res; });
  }).then(function (res) {
    if (!res) return;
    if (!res.items.length) { toast("Nothing found for \"" + text + "\""); return; }
    var one = res.items.length === 1 && (res.numMatched || res.wanted === null || res.wanted === undefined);
    if (one) { var it = res.items[0];
      if (it.kind === "road") showRoad(it); else goTo(L.latLng(it.lat, it.lon), it.label, res.numMatched ? 17 : it.kind === "place" ? 14 : 16); return; }
    document.getElementById("toast").style.display = "none";
    showResults(res);
  }).catch(function (e) { toast("Search failed: " + e.message); });
});
document.getElementById("q").addEventListener("input", function () { if (!this.value) hideResults(); });
map.on("click", hideResults);
