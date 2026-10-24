// Probe the Tasmania 2 m DEM COG the way contours.js does: open it, list images, then read
// tile windows at several zooms around a few places and report errors, empty tiles and timing.
import { fromUrl } from "geotiff";
import proj4 from "proj4";
const URL = "https://data.source.coop/alexgleith/tasmania-dem-2m/Tasmania_Statewide_2m_DEM_14-08-2021.tif";
proj4.defs("MGA94z55", "+proj=utm +zone=55 +south +ellps=GRS80 +units=m +no_defs");
const t0 = Date.now();
const tiff = await fromUrl(URL, { allowFullFile: false });
const n = await tiff.getImageCount();
const ims = [];
for (let i = 0; i < n; i++) { const im = await tiff.getImage(i); ims.push(im);
  console.log("image", i, im.getWidth(), "x", im.getHeight(), "tile", im.getTileWidth(), "spp", im.getSamplesPerPixel(),
    "bps", im.fileDirectory.BitsPerSample, "subfile", im.fileDirectory.NewSubfileType, "nodata", im.getGDALNoData && im.getGDALNoData()); }
const im0 = ims[0], o = im0.getOrigin(), r = im0.getResolution();
console.log("origin", o, "res", r, "open+list", Date.now() - t0, "ms");
const W = im0.getWidth(), H = im0.getHeight(), dx = r[0], dy = -r[1];
function x2lon(x, z) { return x / 2 ** z * 360 - 180; }
function y2lat(y, z) { const t = Math.PI - 2 * Math.PI * y / 2 ** z; return 180 / Math.PI * Math.atan(Math.sinh(t)); }
function lon2x(lon, z) { return (lon + 180) / 360 * 2 ** z; }
function lat2y(lat, z) { const a = lat * Math.PI / 180; return (1 - Math.log(Math.tan(a) + 1 / Math.cos(a)) / Math.PI) / 2 * 2 ** z; }
const places = [["Fern Tree", -42.922, 147.26], ["Styx", -42.80, 146.70], ["Ben Lomond", -41.54, 147.66], ["Strahan", -42.15, 145.33]];
for (const [nm, lat, lon] of places) for (const z of [11, 12, 13, 14, 15, 16, 17]) {
  const x = Math.floor(lon2x(lon, z)), y = Math.floor(lat2y(lat, z));
  const corners = [[x, y], [x + 1, y], [x, y + 1], [x + 1, y + 1]].map(([a, b]) => proj4("EPSG:4326", "MGA94z55", [x2lon(a, z), y2lat(b, z)]));
  const minE = Math.min(...corners.map(c => c[0])), maxE = Math.max(...corners.map(c => c[0])), minN = Math.min(...corners.map(c => c[1])), maxN = Math.max(...corners.map(c => c[1]));
  const spacing = (maxE - minE) / 128; let k = 0;
  while (k + 1 < n && dx * 2 ** (k + 1) <= spacing) k++;
  const lv = ims[k], sx = W / lv.getWidth(), cell = dx * sx;
  const c0 = Math.max(0, Math.floor((minE - o[0]) / cell) - 1), c1 = Math.min(lv.getWidth(), Math.ceil((maxE - o[0]) / cell) + 2);
  const r0 = Math.max(0, Math.floor((o[1] - maxN) / cell) - 1), r1 = Math.min(lv.getHeight(), Math.ceil((o[1] - minN) / cell) + 2);
  const t = Date.now();
  try {
    const rr = await lv.readRasters({ window: [c0, r0, c1, r1], samples: [0], interleave: false });
    const b = rr[0]; let ok = 0, mn = Infinity, mx = -Infinity;
    for (const v of b) if (!isNaN(v) && v > -1000 && v < 10000) { ok++; mn = Math.min(mn, v); mx = Math.max(mx, v); }
    console.log(nm, "z" + z, "level", k, "cell", cell.toFixed(1), "window", (c1 - c0) + "x" + (r1 - r0), "valid", ok + "/" + b.length,
      "range", mn.toFixed(1), mx.toFixed(1), Date.now() - t, "ms");
  } catch (e) { console.log(nm, "z" + z, "level", k, "ERROR", e.message, Date.now() - t, "ms"); }
}
