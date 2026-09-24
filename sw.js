// lunamap service worker: offline app shell, map tiles and last-seen data.
//   app page       network first, cached copy when offline
//   CDN libraries  cache first
//   LIST tiles     cache first (includes areas saved with "Save area offline"
//                  and anything viewed while online)
//   LIST queries   network first, cached answer when offline
var SHELL = "lunamap-shell-v1";
var TILES = "lunamap-tiles-v1";
var DATA = "lunamap-data-v1";
var CDN = [
  "https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.css",
  "https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.js",
  "https://cdn.jsdelivr.net/npm/proj4@2.12.1/dist/proj4.js"
];

self.addEventListener("install", function (e) {
  self.skipWaiting();
  e.waitUntil(caches.open(SHELL).then(function (c) {
    return c.addAll(["./", "help.html"].concat(CDN)).catch(function () {});
  }));
});

self.addEventListener("activate", function (e) {
  e.waitUntil(self.clients.claim());
});

function isTile(u) {
  return /\/MapServer\/tile\/\d+\/\d+\/\d+$/.test(u.pathname) || /\/MapServer\/export$/.test(u.pathname);
}

function tileFirst(req) {
  return caches.open(TILES).then(function (c) {
    return c.match(req.url).then(function (hit) {
      if (hit) return hit;
      return fetch(req.url, { mode: "cors", credentials: "omit" }).then(function (res) {
        if (res.ok) c.put(req.url, res.clone());
        return res;
      }).catch(function () {
        return fetch(req);   // server without CORS: plain request, not cached
      });
    });
  });
}

function networkFirst(req, name) {
  return fetch(req).then(function (res) {
    if (res.ok && res.type !== "opaque") {
      var copy = res.clone();
      caches.open(name).then(function (c) { c.put(req, copy); });
    }
    return res;
  }).catch(function () {
    return caches.open(name).then(function (c) {
      return c.match(req, { ignoreSearch: false }).then(function (hit) {
        if (hit) return hit;
        if (req.mode === "navigate") return c.match("./");
        return Response.error();
      });
    });
  });
}

function cacheFirst(req, name) {
  return caches.open(name).then(function (c) {
    return c.match(req).then(function (hit) {
      return hit || fetch(req).then(function (res) { if (res.ok) c.put(req, res.clone()); return res; });
    });
  });
}

self.addEventListener("fetch", function (e) {
  var req = e.request;
  if (req.method !== "GET") return;
  var u = new URL(req.url);
  if (u.hostname === "services.thelist.tas.gov.au") {
    if (isTile(u)) { e.respondWith(tileFirst(req)); return; }
    if (/\/query$/.test(u.pathname)) { e.respondWith(networkFirst(req, DATA)); return; }
    return;
  }
  if (u.hostname === "cdn.jsdelivr.net") { e.respondWith(cacheFirst(req, SHELL)); return; }
  if (u.origin === self.location.origin) { e.respondWith(networkFirst(req, SHELL)); return; }
});
