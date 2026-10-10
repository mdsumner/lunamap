# lunamap

A phone-friendly map of Tasmania for finding, describing and sharing a location quickly: tap the map
(or type an address, grid reference, street atlas square or coordinates) and get the location in every
format you might need to read out or paste, plus the property, map references, elevation and fire context.
Started for a volunteer fire brigade in Fern Tree, useful anywhere in Tasmania.

**Live:** <https://mdsumner.github.io/lunamap/> - **Help:** <https://mdsumner.github.io/lunamap/help.html>

It is a static site (plain HTML, CSS and JavaScript, no build step) on GitHub Pages. All map data is read
live from public services, mainly [theLIST](https://www.thelist.tas.gov.au) (Land Tasmania).

> Community-made and unofficial. Not a Tasmania Fire Service or State of Tasmania product. Data can be
> incomplete or out of date; warnings are a copy of TasALERT and can lag - always check
> [alert.tas.gov.au](https://alert.tas.gov.au) in an emergency.

## Features

- **Pin panel**: tap anywhere for address, lon/lat (both orders), MGA94 and MGA2020, 6-figure grid
  reference, street atlas and map book squares, elevation, DMS; copy any row, copy all, or share a link
  that reopens the same view.
- **Go to**: addresses (forgiving: `12 pillinger`), grid references, street atlas (`SA-188-B6`), map book
  (`MB356 C4`), lon/lat in either order, MGA eastings/northings, DMS and degrees-minutes.
- **Basemaps**: theLIST Topographic, Emergency Services 1:50k map book, TASMAP raster, aerial photo,
  hillshade, grey topographic. MGA grid overlay labelled at the screen edge like a printed map.
- **Layers**: parcels with house numbers and addresses; TasWater hydrants, dams, reservoirs, pump
  stations; gates and barriers; fire, ambulance, police and SES stations, emergency meeting points,
  evacuation centres; BOM fire danger ratings; TasALERT warnings; fire history.
- **Route**: from the nearest main-road junction to the pin over theLIST road network (including
  vehicular tracks), with radio-style directions; step out to bigger roads; hand off to Google Maps.
  Nearest fire station by road.
- **Draw**: points, lines and polygons with labels, length and area; elevation profiles along lines;
  export/import GeoJSON, KML and GPX; send a sketch in a link.
- **Weather**: opens the BOM forecast for the nearest place.
- **Offline**: save map tiles for an area; the map, GPS dot, grid and coordinates keep working without
  signal. Installable to the home screen.

## Files

| Path | What |
|---|---|
| `index.html` | the map page |
| `help.html` | user help |
| `app.css` | styles |
| `js/core.js` | basemaps, projections, URL state, pin panel, GPS, print |
| `js/search.js` | go-to parser, address search |
| `js/grid.js` | MGA grid with edge labels |
| `js/layers.js` | parcels, point overlays (water, gates, stations), street atlas / map book |
| `js/route.js` | routing on theLIST roads, Google and BOM hand-offs |
| `js/hazards.js` | fire danger, TasALERT warnings, fire history |
| `js/extras.js` | elevation and nearest fire station rows |
| `js/app.js` | toolbar menus, offline saving, start-up |
| `js/draw.js` | drawing, export/import, sketch links (loaded on demand) |
| `js/profile.js` | elevation sampling from the 2 m DEM (loaded on demand) |
| `sw.js` | service worker: offline page, tiles and recent data |
| `data/osm-places-tas.json` | OpenStreetMap places for BOM links (harvested monthly by `.github/workflows/osm-places.yml`) |

The scripts are classic `<script>` files sharing globals, loaded in the order in `index.html`.
Libraries come from jsDelivr: Leaflet 1.9.4, proj4js 2.12.1, and on demand Leaflet-Geoman 2.20.2,
geotiff.js 3.0.5 and @tmcw/togeojson 7.1.2.

## Running locally

Any static web server from the repo root, for example:

```sh
python3 -m http.server 8000
```

then open <http://localhost:8000/>. Opening `index.html` as a file mostly works, but the service worker
(offline maps) needs `http://localhost` or https.

## Data sources and licences

| Data | Source | Licence |
|---|---|---|
| Basemaps, cadastre, addresses, roads, gates, map book / street atlas grids | theLIST, State of Tasmania | CC BY 3.0 AU (aerial photo and TASMAP: CC BY-NC-ND 3.0 AU); LIST Web Services terms |
| Water assets | TasWater, Tasmanian Irrigation via theLIST | as published on theLIST |
| Stations, meeting points, evacuation centres, fire danger, TasALERT, fire history | theLIST EmergencyManagementPublic (replicated from TFS, BOM, TasALERT and agencies) | as published on theLIST |
| Elevation | [Tasmania 2 m DEM](https://source.coop/alexgleith/tasmania-dem-2m), Mineral Resources Tasmania / theLIST, via Source Cooperative | CC BY 3.0 AU |
| Place list for BOM links | OpenStreetMap contributors | ODbL 1.0 |

No data is copied from BOM; the weather button only links to bom.gov.au.

## Licence

Code: MIT (see `LICENSE`). Map data and other content keep their own licences (above).

`listmap-print1990700725757339362.pdf` is a LISTmap print kept as an example of its georeferenced-PDF
output (GDAL cannot derive a geotransform from it: the LPTS are transposed relative to GPTS).

## Licence

Code: MIT (see `LICENSE`). Map and other data keep their own licences (above).
`listmap-print1990700725757339362.pdf` is a sample LISTmap print kept as an example of its
non-standard geospatial PDF output.

## Notes for maintainers

- The URL hash holds the state: `#zoom/lat/lon/basemap,flags[/pinlat/pinlon]`, and `?s=` carries a
  shared sketch.
- The service worker serves the page network-first, so changes show on the next load with signal;
  cached tiles are kept separately in `lunamap-tiles-v1`.
- Keep source files ASCII (use `\u00b0` escapes and HTML entities).
