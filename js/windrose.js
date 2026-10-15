// lunamap - windrose.js: seasonal wind roses for a few points around Fern Tree
// (proof of concept). Counts come from data/windrose-ferntree.json, built by
// scripts/windrose.py (.github/workflows/windrose.yml) from Open-Meteo's
// historical weather API (ECMWF IFS, about 9 km, modelled not measured).
// Petals point the way the wind comes FROM (the usual wind rose convention);
// petal length is the share of hours, shaded by mean speed band.
// Loaded on demand from the Tools box.
// ---------------------------------------------------------------------------
(function () {
  var ROSE_COL = ["#c6dbef", "#9ecae1", "#6baed6", "#3182bd", "#08519c"];
  var SEASON_TXT = { summer: "Summer (Dec-Feb)", autumn: "Autumn (Mar-May)", winter: "Winter (Jun-Aug)",
                     spring: "Spring (Sep-Nov)", year: "Year (all seasons)" };
  var state = { point: 0, season: "summer", filter: "firewx" };
  var data = null, sheet = document.getElementById("rosesheet");

  function btns(el, items, cur, set) {
    el.innerHTML = "";
    items.forEach(function (it) {
      var b = document.createElement("button"); b.type = "button"; b.textContent = it[1];
      if (it[0] === cur) b.className = "on";
      b.onclick = function () { set(it[0]); draw(); };
      el.appendChild(b);
    });
  }
  function pct(v) { return v >= 10 ? v.toFixed(0) : v.toFixed(1); }

  function rose(r, dirs, bands) {
    var S = 300, C = S / 2, R = 118, n = r.n || 1;
    var tot = r.counts.map(function (row) { return row.reduce(function (a, b) { return a + b; }, 0); });
    var maxp = Math.max.apply(null, tot.map(function (t) { return 100 * t / n; })) || 1;
    var step = maxp > 30 ? 10 : maxp > 12 ? 5 : maxp > 6 ? 2 : 1, top = Math.ceil(maxp / step) * step;
    var k = R / top, out = [];
    out.push("<svg viewBox='0 0 " + S + " " + S + "' width='100%' style='max-width:320px;display:block;margin:0 auto' role='img'>");
    for (var g = step; g <= top; g += step) {
      out.push("<circle cx='" + C + "' cy='" + C + "' r='" + (g * k).toFixed(1) + "' fill='none' stroke='#ddd' stroke-width='1'/>");
      out.push("<text x='" + (C + 3) + "' y='" + (C - g * k - 2).toFixed(1) + "' font-size='9' fill='#888'>" + g + "%</text>");
    }
    [0, 4, 8, 12].forEach(function (i) {
      var a = i * 22.5 * Math.PI / 180, x = C + (R + 14) * Math.sin(a), y = C - (R + 14) * Math.cos(a);
      out.push("<text x='" + x.toFixed(1) + "' y='" + (y + 4).toFixed(1) + "' font-size='12' font-weight='600' text-anchor='middle' fill='#333'>" + dirs[i] + "</text>");
    });
    var half = 22.5 * 0.42 * Math.PI / 180;
    r.counts.forEach(function (row, i) {
      var a = i * 22.5 * Math.PI / 180, r0 = 0, acc = 0;
      row.forEach(function (c, j) {
        if (!c) return;
        acc += c; var r1 = 100 * acc / n * k;
        var p = [[r0, a - half], [r1, a - half], [r1, a + half], [r0, a + half]].map(function (q) {
          return (C + q[0] * Math.sin(q[1])).toFixed(1) + "," + (C - q[0] * Math.cos(q[1])).toFixed(1); });
        var lab = j === 0 ? "under " + bands[0] : j === bands.length ? bands[j - 1] + "+" : bands[j - 1] + "-" + bands[j];
        out.push("<path d='M" + p[0] + " L" + p[1] + " A" + r1.toFixed(1) + "," + r1.toFixed(1) + " 0 0 1 " + p[2] + " L" + p[3] +
          (r0 > 0 ? " A" + r0.toFixed(1) + "," + r0.toFixed(1) + " 0 0 0 " + p[0] : "") + " Z' fill='" + ROSE_COL[j] +
          "' stroke='#fff' stroke-width='1'><title>From " + dirs[i] + ", " + lab + " km/h: " + pct(100 * c / n) + "% of hours</title></path>");
        r0 = r1;
      });
    });
    out.push("</svg>");
    return out.join("");
  }

  function summary(r, dirs) {
    if (!r.n) return "No hours match.";
    var tot = r.counts.map(function (row, i) { return [row.reduce(function (a, b) { return a + b; }, 0), dirs[i]]; })
      .sort(function (a, b) { return b[0] - a[0]; });
    var strong = r.counts.map(function (row, i) { return [row[row.length - 1] + row[row.length - 2], dirs[i]]; })
      .sort(function (a, b) { return b[0] - a[0]; });
    var s = "Most often from " + tot.slice(0, 3).map(function (t) { return t[1] + " " + pct(100 * t[0] / r.n) + "%"; }).join(", ") + ". ";
    if (strong[0][0]) s += "Winds of 30 km/h or more mostly from " + strong.slice(0, 2).filter(function (t) { return t[0]; })
      .map(function (t) { return t[1]; }).join(" and ") + ". ";
    s += "Calm " + pct(100 * r.calm / r.n) + "%. Highest gust " + Math.round(r.gust) + " km/h. " + r.n.toLocaleString("en-AU") + " hours.";
    if (r.n < 50) s += " Few hours - treat with caution.";
    return s;
  }

  function draw() {
    if (!data) return;
    var P = data.points[state.point] || data.points[0];
    btns(document.getElementById("rosepts"), data.points.map(function (p, i) { return [i, p.name]; }), state.point,
         function (v) { state.point = v; });
    btns(document.getElementById("roseseason"), Object.keys(SEASON_TXT).map(function (k) { return [k, SEASON_TXT[k].split(" ")[0]]; }),
         state.season, function (v) { state.season = v; });
    btns(document.getElementById("rosefilter"), [["all", "All hours"], ["pm", "Afternoons"], ["firewx", "Hot, dry afternoons"]],
         state.filter, function (v) { state.filter = v; });
    var r = P.roses[state.season][state.filter], b = data.bands_kmh;
    document.getElementById("rosetitle").textContent = P.name + " - " + SEASON_TXT[state.season] + ", " + data.filters[state.filter];
    document.getElementById("rosesvg").innerHTML = rose(r, data.dirs, b);
    document.getElementById("rosesum").textContent = summary(r, data.dirs);
    var keys = ["under " + b[0]].concat(b.slice(1).map(function (v, i) { return b[i] + "-" + v; }), [b[b.length - 1] + "+"]);
    document.getElementById("roselegend").innerHTML = "Mean wind, km/h: " + keys.map(function (t, i) {
      return "<span class='rkey'><i style='background:" + ROSE_COL[i] + "'></i>" + t + "</span>"; }).join(" ");
    document.getElementById("rosenote").textContent = "Petals point where the wind comes from. Modelled history, " +
      data.period[0].slice(0, 4) + "-" + data.period[1].slice(0, 4) + ", ECMWF IFS about 9 km (model cell centre " +
      P.cell_lat + ", " + P.cell_lon +
      "), via Open-Meteo.com. Real wind on slopes and in gullies can differ a lot.";
  }

  window.openWindRose = function () {
    sheet.style.display = "block";
    if (data) { draw(); return; }
    document.getElementById("rosesum").textContent = "Loading...";
    fetch("data/windrose-ferntree.json").then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
      .then(function (d) { data = d; draw(); })
      .catch(function () { document.getElementById("rosesum").textContent = "Wind rose data not available yet."; });
  };
  document.getElementById("roseclose").onclick = function () { sheet.style.display = "none"; };
})();
