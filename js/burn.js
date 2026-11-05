// lunamap - burn.js: Burn planning (opt-in, Tools > "Burn planning: on").
//   Burn windows: from the hourly model forecast at the pin (Open-Meteo; temperature, humidity,
//   wind, gusts, direction, rain), the runs of hours over the next week that meet limits you set:
//   temperature, humidity, wind and gust speed, wind directions, rain in the hours before and after,
//   daylight only, and a minimum length. Shown as a week timeline (green = every limit met) and a
//   list of windows; tap an hour to see each value and which limit it fails. Limits are kept on this
//   device. With the suite on and a pin down, the pin panel gets a "Burn window" row.
//   The starting limits are only an example: set them from the burn plan or permit conditions.
//   A weather model is not an observation: check the official forecast and conditions on the day.
// ---------------------------------------------------------------------------
(function () {
  var KEY = "lunamap-burn", LKEY = "lunamap-burn-limits", API = "https://api.open-meteo.com/v1/forecast";
  var EXAMPLE = { tMin: "", tMax: 25, rhMin: 35, rhMax: 85, wMin: 3, wMax: 20, gMax: 35, dirs: "N,NE,E,SE,S,SW,W,NW",
                  rainBeforeH: 24, rainBeforeMax: "", rainAfterH: 12, rainAfterMax: 2, minLen: 3, daylight: true };
  var L0 = {}; Object.keys(EXAMPLE).forEach(function (k) { L0[k] = EXAMPLE[k]; });
  try { var sv = JSON.parse(localStorage.getItem(LKEY) || "null"); if (sv) Object.keys(L0).forEach(function (k) { if (sv[k] !== undefined) L0[k] = sv[k]; }); } catch (e) {}
  var LIM = L0, on = false, sheet = null, cache = {}, row = null, seq = 0;
  var SECT = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  function store() { try { localStorage.setItem(LKEY, JSON.stringify(LIM)); } catch (e) {} }
  function num(v) { return v === "" || v === null || v === undefined || isNaN(+v) ? null : +v; }
  function sector(deg) { return SECT[Math.round(((deg % 360) + 360) % 360 / 45) % 8]; }

  function forecast(ll) {
    var key = ll.lat.toFixed(3) + "," + ll.lng.toFixed(3);
    if (cache[key] && Date.now() - cache[key].t < 30 * 60000) return Promise.resolve(cache[key].d);
    var url = API + "?latitude=" + ll.lat.toFixed(4) + "&longitude=" + ll.lng.toFixed(4) +
      "&hourly=temperature_2m,relative_humidity_2m,wind_speed_10m,wind_gusts_10m,wind_direction_10m,precipitation" +
      "&daily=sunrise,sunset&timezone=Australia%2FHobart&past_days=2&forecast_days=7&wind_speed_unit=kmh";
    return fetch(url).then(function (r) { if (!r.ok) throw new Error("forecast " + r.status); return r.json(); }).then(function (j) {
      var h = j.hourly, sun = {};
      j.daily.time.forEach(function (d, i) { sun[d] = [j.daily.sunrise[i], j.daily.sunset[i]]; });
      var d = h.time.map(function (t, i) { return { t: t, T: h.temperature_2m[i], RH: h.relative_humidity_2m[i], W: h.wind_speed_10m[i],
        G: h.wind_gusts_10m[i], D: h.wind_direction_10m[i], P: h.precipitation[i] || 0, sun: sun[t.slice(0, 10)] }; });
      cache[key] = { t: Date.now(), d: d };
      return d;
    });
  }

  // check every hour against the limits; returns per-hour {ok, fails[]} and the windows
  function evaluate(hours) {
    var now = new Date(), nowKey = now.getFullYear() + "-" + ("0" + (now.getMonth() + 1)).slice(-2) + "-" + ("0" + now.getDate()).slice(-2) + "T" + ("0" + now.getHours()).slice(-2);
    var dirs = {}; String(LIM.dirs || "").split(",").forEach(function (s) { if (s) dirs[s] = 1; });
    var res = hours.map(function (h, i) {
      var f = [];
      function lo(v, lim, name) { var x = num(lim); if (x !== null && v < x) f.push(name); }
      function hi(v, lim, name) { var x = num(lim); if (x !== null && v > x) f.push(name); }
      lo(h.T, LIM.tMin, "too cold"); hi(h.T, LIM.tMax, "too hot");
      lo(h.RH, LIM.rhMin, "too dry"); hi(h.RH, LIM.rhMax, "too humid");
      lo(h.W, LIM.wMin, "too calm"); hi(h.W, LIM.wMax, "too windy"); hi(h.G, LIM.gMax, "gusts too strong");
      if (!dirs[sector(h.D)]) f.push("wind from " + sector(h.D));
      if (LIM.daylight && h.sun && (h.t < h.sun[0].slice(0, 13) || h.t >= h.sun[1].slice(0, 13))) f.push("dark");
      var bH = num(LIM.rainBeforeH) || 0, bM = num(LIM.rainBeforeMax), aH = num(LIM.rainAfterH) || 0, aM = num(LIM.rainAfterMax);
      if (bM !== null) { var s = 0; for (var k = Math.max(0, i - bH); k < i; k++) s += hours[k].P; if (s > bM) f.push("rain before " + s.toFixed(1) + " mm"); }
      if (aM !== null) { var s2 = 0; for (var k2 = i; k2 < Math.min(hours.length, i + aH); k2++) s2 += hours[k2].P; if (s2 > aM) f.push("rain after " + s2.toFixed(1) + " mm"); }
      return { h: h, ok: !f.length, fails: f, future: h.t.slice(0, 13) >= nowKey };
    });
    var wins = [], cur = null, minLen = num(LIM.minLen) || 1;
    res.forEach(function (r, i) {
      if (r.ok && r.future) { if (!cur) cur = { a: i, b: i }; else cur.b = i; }
      else { if (cur && cur.b - cur.a + 1 >= minLen) wins.push(cur); cur = null; }
    });
    if (cur && cur.b - cur.a + 1 >= minLen) wins.push(cur);
    wins.forEach(function (w) { w.len = w.b - w.a + 1; });
    return { res: res, wins: wins };
  }
  function when(t) {
    var d = new Date(t + ":00");
    return d.toLocaleDateString("en-AU", { weekday: "short", day: "numeric", month: "short" }) + " " + t.slice(11, 16);
  }
  function range(xs, unit) { var a = Math.min.apply(null, xs), b = Math.max.apply(null, xs); return Math.round(a) === Math.round(b) ? Math.round(a) + unit : Math.round(a) + "-" + Math.round(b) + unit; }
  function winText(ev, w) {
    var hs = ev.res.slice(w.a, w.b + 1).map(function (r) { return r.h; }), end = ev.res[w.b].h.t;
    var secs = {}; hs.forEach(function (h) { secs[sector(h.D)] = 1; });
    return when(hs[0].t) + "-" + String((+end.slice(11, 13) + 1) % 24).padStart(2, "0") + ":00 (" + w.len + " h): " +
      range(hs.map(function (h) { return h.T; }), " C") + ", RH " + range(hs.map(function (h) { return h.RH; }), "%") + ", " +
      Object.keys(secs).join("/") + " " + range(hs.map(function (h) { return h.W; }), " km/h") + ", gusts to " + Math.round(Math.max.apply(null, hs.map(function (h) { return h.G; }))) + " km/h";
  }

  // ---- pin panel row ------------------------------------------------------------------
  window.burnRows = function () { return on && row ? [{ k: "Burn window", v: row }] : []; };
  window.lookupBurn = function (ll) {
    row = null; if (!on) return;
    var s = ++seq;
    forecast(ll).then(function (hours) {
      if (s !== seq) return;
      var ev = evaluate(hours);
      row = ev.wins.length ? "next: " + winText(ev, ev.wins[0]) + (ev.wins.length > 1 ? "; " + (ev.wins.length - 1) + " more this week" : "") :
        "none in the next 7 days with your limits";
      if (pin) showCoords(pin.getLatLng());
      if (sheet && sheet.style.display === "block") render(ev);
    }).catch(function () { row = "(forecast unavailable)"; if (pin) showCoords(pin.getLatLng()); });
  };

  // ---- sheet ----------------------------------------------------------------------------
  var last = null;
  function render(ev) {
    last = ev;
    var cv = document.getElementById("bwcanvas"), res = ev.res.filter(function (r) { return r.future; });
    var W = Math.max(320, document.getElementById("bwsheet").clientWidth - 28), days = {}, order = [];
    res.forEach(function (r) { var d = r.h.t.slice(0, 10); if (!days[d]) { days[d] = []; order.push(d); } days[d].push(r); });
    var rowH = 18, H = order.length * rowH + 16, L = 64, cw = (W - L) / 24, dpr = window.devicePixelRatio || 1;
    cv.width = W * dpr; cv.height = H * dpr; cv.style.width = W + "px"; cv.style.height = H + "px";
    var g = cv.getContext("2d"); g.scale(dpr, dpr); g.clearRect(0, 0, W, H);
    var inWin = {}; ev.wins.forEach(function (w) { for (var i = w.a; i <= w.b; i++) inWin[ev.res[i].h.t] = 1; });
    g.font = "11px system-ui, sans-serif"; g.textBaseline = "middle";
    order.forEach(function (d, j) {
      var y = j * rowH;
      g.fillStyle = "#333"; g.fillText(new Date(d + "T12:00").toLocaleDateString("en-AU", { weekday: "short", day: "numeric" }), 2, y + rowH / 2);
      days[d].forEach(function (r) {
        var x = L + (+r.h.t.slice(11, 13)) * cw;
        g.fillStyle = inWin[r.h.t] ? "#2e7d32" : r.ok ? "#a5d6a7" : r.fails.indexOf("dark") >= 0 ? "#cfd8dc" : "#eceff1";
        g.fillRect(x + 0.5, y + 2, cw - 1, rowH - 4);
      });
    });
    g.fillStyle = "#666"; [0, 6, 12, 18].forEach(function (hh) { g.fillText(String(hh).padStart(2, "0"), L + hh * cw, H - 6); });
    document.getElementById("bwlist").innerHTML = ev.wins.length ? "<b>" + ev.wins.length + " window" + (ev.wins.length === 1 ? "" : "s") + " this week:</b><ul>" +
      ev.wins.map(function (w) { return "<li>" + esc(winText(ev, w)) + "</li>"; }).join("") + "</ul>" :
      "<b>No windows in the next 7 days with these limits.</b> Tap an hour to see what fails.";
    cv.onclick = function (e) {
      var rc = cv.getBoundingClientRect(), x = e.clientX - rc.left, y = e.clientY - rc.top, j = Math.floor(y / rowH), hh = Math.floor((x - L) / cw);
      if (j < 0 || j >= order.length || hh < 0 || hh > 23) return;
      var r = days[order[j]].filter(function (q) { return +q.h.t.slice(11, 13) === hh; })[0]; if (!r) return;
      var h = r.h;
      document.getElementById("bwhour").textContent = when(h.t) + ": " + Math.round(h.T) + " C, RH " + Math.round(h.RH) + "%, wind " + sector(h.D) + " " +
        Math.round(h.W) + " km/h gusting " + Math.round(h.G) + ", rain " + h.P.toFixed(1) + " mm. " + (r.ok ? "Meets every limit." : "Fails: " + r.fails.join(", ") + ".");
    };
  }
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return "&#" + c.charCodeAt(0) + ";"; }); }
  function field(k, label, unit) { return "<label class='bwf'>" + label + " <input data-k='" + k + "' inputmode='decimal' value='" + esc(LIM[k] === null ? "" : LIM[k]) + "'>" + (unit ? " " + unit : "") + "</label>"; }
  function run() {
    if (!pin) { document.getElementById("bwlist").textContent = "Drop a pin at the burn site first."; return; }
    document.getElementById("bwlist").textContent = "Reading the forecast...";
    forecast(pin.getLatLng()).then(function (hours) { var ev = evaluate(hours); render(ev); lookupBurn(pin.getLatLng()); })
      .catch(function (e) { document.getElementById("bwlist").textContent = "Forecast unavailable: " + e.message; });
  }
  function openSheet() {
    if (typeof setMenu === "function") setMenu(null);
    if (!sheet) {
      sheet = document.createElement("div"); sheet.id = "bwsheet"; sheet.className = "sheet";
      sheet.innerHTML = "<h2><span>Burn windows</span><button id='bwclose' aria-label='Close'>x</button></h2>" +
        "<canvas id='bwcanvas'></canvas><div id='bwhour' class='small'></div><div id='bwlist' class='small'></div>" +
        "<details><summary class='small'><b>Limits</b> (kept on this device)</summary><div class='small bwlim'>" +
        field("tMin", "Temperature from", "") + field("tMax", "to", "C") + "<br>" +
        field("rhMin", "Humidity from", "") + field("rhMax", "to", "%") + "<br>" +
        field("wMin", "Wind from", "") + field("wMax", "to", "km/h") + field("gMax", "gusts up to", "km/h") + "<br>" +
        "Wind from <span id='bwdirs' class='seg'>" + SECT.map(function (s) { return "<button type='button' data-v='" + s + "'>" + s + "</button>"; }).join("") + "</span>" +
        field("rainBeforeMax", "Rain in the previous", "mm or less over") + field("rainBeforeH", "", "h") + "<br>" +
        field("rainAfterMax", "Rain in the next", "mm or less over") + field("rainAfterH", "", "h") + "<br>" +
        field("minLen", "Windows of at least", "hours") +
        "<label class='bwf'><input type='checkbox' id='bwday'> Daylight hours only</label>" +
        "<div class='acts'><button id='bwreset' type='button'>Reset to the example</button></div>" +
        "<p style='color:#666'>Leave a box empty for no limit. The example limits are a starting point only: " +
        "set them from the burn plan or permit conditions.</p></div></details>" +
        "<p class='small' style='color:#666'>Hourly model forecast at the pin (Open-Meteo, ECMWF and other models), not observations. " +
        "Dark green: hours in a window; light green: hours that meet the limits but in a run shorter than the minimum; " +
        "grey: night. Always check the official forecast, the fire danger rating and conditions on the day.</p>";
      document.body.appendChild(sheet); L.DomEvent.disableClickPropagation(sheet); L.DomEvent.disableScrollPropagation(sheet);
      sheet.querySelector("#bwclose").onclick = function () { sheet.style.display = "none"; };
      var t = null;
      [].forEach.call(sheet.querySelectorAll("input[data-k]"), function (inp) {
        inp.oninput = function () { LIM[inp.getAttribute("data-k")] = inp.value.trim(); store(); clearTimeout(t); t = setTimeout(run, 400); };
      });
      sheet.querySelector("#bwday").onchange = function (e) { LIM.daylight = e.target.checked; store(); run(); };
      sheet.querySelector("#bwdirs").onclick = function (e) {
        var v = e.target.getAttribute("data-v"); if (!v) return;
        var s = {}; String(LIM.dirs || "").split(",").forEach(function (x) { if (x) s[x] = 1; });
        if (s[v]) delete s[v]; else s[v] = 1;
        LIM.dirs = SECT.filter(function (x) { return s[x]; }).join(","); store(); syncDirs(); run();
      };
      sheet.querySelector("#bwreset").onclick = function () {
        Object.keys(EXAMPLE).forEach(function (k) { LIM[k] = EXAMPLE[k]; }); store();
        [].forEach.call(sheet.querySelectorAll("input[data-k]"), function (inp) { inp.value = LIM[inp.getAttribute("data-k")]; });
        sheet.querySelector("#bwday").checked = !!LIM.daylight; syncDirs(); run();
      };
    }
    sheet.querySelector("#bwday").checked = !!LIM.daylight; syncDirs();
    sheet.style.display = "block"; setFolded(true); run();
  }
  function syncDirs() {
    var s = {}; String(LIM.dirs || "").split(",").forEach(function (x) { if (x) s[x] = 1; });
    [].forEach.call(sheet.querySelectorAll("#bwdirs button"), function (b) { b.classList.toggle("on", !!s[b.getAttribute("data-v")]); });
  }

  // ---- the suite switch ---------------------------------------------------------------
  function setBurn(v) {
    on = v; document.body.classList.toggle("burn", on);
    document.getElementById("burnmode").textContent = "Burn planning: " + (on ? "on" : "off");
    try { localStorage.setItem(KEY, on ? "1" : ""); } catch (e) {}
    if (on && pin) lookupBurn(pin.getLatLng());
    if (!on) { row = null; if (sheet) sheet.style.display = "none"; if (pin) showCoords(pin.getLatLng()); }
  }
  window.setBurn = setBurn;
  document.getElementById("burnmode").onclick = function () { setBurn(!on); };
  document.getElementById("burnwin").onclick = openSheet;
  try { if (localStorage.getItem(KEY)) setBurn(true); } catch (e) {}
  window.lunamapBurn = { evaluate: evaluate, limits: function () { return LIM; } };   // for testing
})();
