// lunamap - wind.js: wind at the pin, shown in the pin panel (Fire group).
//   Wind            forecast wind now at 10 m from the Open-Meteo forecast API
//                   (open-meteo.com, free for non-commercial use; a weather model,
//                   not a measurement - local terrain can make real wind very different)
//   Wind next 12 h  the same every 3 hours: direction, mean / gust km/h
//   Wind observed   link to the nearest BOM weather station's latest observations
//                   page. The station list is data/bom-stations-tas.json, harvested
//                   monthly by .github/workflows/bom-stations.yml. No BOM observations
//                   are fetched by the map.
// A blue arrow through the pin points the way the wind is blowing (downwind).
// ---------------------------------------------------------------------------
var WIND_API = "https://api.open-meteo.com/v1/forecast";
var WIND_VARS = "wind_speed_10m,wind_direction_10m,wind_gusts_10m";
var COMPASS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
var windArrow = null, bomStations = null;

function compass(deg) { return COMPASS[Math.round(((deg % 360) + 360) % 360 / 22.5) % 16]; }
function hhmm(t) { return String(t || "").slice(11, 16); }

function windIcon(dir, kmh) {
  var len = kmh >= 40 ? 34 : kmh >= 20 ? 30 : 26;             // a longer arrow for stronger wind
  return L.divIcon({ className: "windarrow", iconSize: [80, 80], iconAnchor: [40, 40],
    html: "<svg width='80' height='80' viewBox='-40 -40 80 80' style='transform:rotate(" + Math.round(dir + 180) + "deg)'>" +
          "<g stroke='#fff' stroke-width='6' stroke-linecap='round' stroke-linejoin='round' fill='none'>" +
          "<path d='M0 " + len + " L0 -" + len + " M-7 -" + (len - 9) + " L0 -" + len + " L7 -" + (len - 9) + "'/></g>" +
          "<g stroke='#1565c0' stroke-width='3' stroke-linecap='round' stroke-linejoin='round' fill='none'>" +
          "<path d='M0 " + len + " L0 -" + len + " M-7 -" + (len - 9) + " L0 -" + len + " L7 -" + (len - 9) + "'/></g></svg>" });
}
function clearWindArrow() { if (windArrow) { map.removeLayer(windArrow); windArrow = null; } }
function showWindArrow(ll, dir, kmh) {
  clearWindArrow();
  windArrow = L.marker(ll, { icon: windIcon(dir, kmh), interactive: false, keyboard: false, zIndexOffset: -500 }).addTo(map);
}
function moveWindArrow(ll) { if (windArrow) windArrow.setLatLng(ll); }

function lookupWind(ll, seq) {
  clearWindArrow();
  var url = WIND_API + "?latitude=" + ll.lat.toFixed(4) + "&longitude=" + ll.lng.toFixed(4) +
    "&current=" + WIND_VARS + "&hourly=" + WIND_VARS + "&forecast_hours=13&wind_speed_unit=kmh&timezone=Australia%2FHobart";
  var get = navigator.onLine === false ? Promise.reject(new Error("offline")) :
    fetch(url).then(function (r) { return r.json(); });
  return get.then(function (j) {
    if (seq !== extraSeq) return;
    if (j.error || !j.current) throw new Error(j.reason || "no data");
    var c = j.current, h = j.hourly || {};
    extraInfo.wind = compass(c.wind_direction_10m) + " " + Math.round(c.wind_speed_10m) + " km/h, gusts " +
      Math.round(c.wind_gusts_10m) + " (model forecast, " + hhmm(c.time) + ")";
    var parts = [];
    for (var i = 3; h.time && i < h.time.length; i += 3)
      parts.push(hhmm(h.time[i]) + " " + compass(h.wind_direction_10m[i]) + " " + Math.round(h.wind_speed_10m[i]) +
                 "/" + Math.round(h.wind_gusts_10m[i]));
    extraInfo.windNext = parts.length ? parts.join(", ") + " (km/h mean/gust)" : null;
    if (pin) showWindArrow(pin.getLatLng(), c.wind_direction_10m, c.wind_speed_10m);
  }).catch(function (e) {
    if (seq === extraSeq) { extraInfo.wind = "(forecast unavailable" + (e.message === "offline" ? " offline" : "") + ")"; extraInfo.windNext = null; }
  });
}

function loadBomStations() {
  if (!bomStations) bomStations = fetch("data/bom-stations-tas.json").then(function (r) { return r.json(); })
    .catch(function () { bomStations = null; return null; });
  return bomStations;
}
function lookupWindObs(ll, seq) {
  return loadBomStations().then(function (d) {
    if (seq !== extraSeq || !d || !d.stations) return;
    var P = [ll.lng, ll.lat], best = null;
    d.stations.forEach(function (s) { var dd = hav(P, [s[3], s[2]]); if (!best || dd < best.d) best = { s: s, d: dd }; });
    if (!best) return;
    extraInfo.windObs = { v: best.s[1] + " (" + fmtDist(best.d) + " away) - tap for latest BOM observations",
                          href: d.page.replace("{wmo}", best.s[0]) };
  });
}

function windRows() {
  var rows = [];
  if (extraInfo.wind) rows.push({ k: "Wind", v: extraInfo.wind });
  if (extraInfo.windNext) rows.push({ k: "Wind next 12 h", v: extraInfo.windNext });
  if (extraInfo.windObs) rows.push({ k: "Wind observed", v: extraInfo.windObs.v, href: extraInfo.windObs.href });
  return rows;
}
