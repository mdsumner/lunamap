# Rough georeferencing of historical aerial photo frames

lunamap (Explore > Old aerial photos) lays raw aerial photo frames from the Tasmanian
film library over the map. The placement is a light heuristic, **not orthorectification**.
This page describes the heuristic and shows how to load a frame in Python or R with the
same placement, from the "Georef (JSON)" file the app downloads.

Photos and frame index: Department of Natural Resources and Environment Tasmania, via
theLIST (`Public/Indexes` map service, "Aerial Photo Frames - Analogue" layers, one per
decade from the 1930s to the 2010s).

## The heuristic

Each frame in the index has a footprint polygon, a film, run and frame number, a scale,
and links to a thumbnail and the full scan. The footprint is a nominal square of ground
cover (film format x scale, for example 230 mm x 1:15,840 = 3.6 km), squared to the map
grid around the photo centre. It does not record which way the aircraft flew, or which way
is up on the film.

1. **Centre and size:** the centre and side length of the footprint.
2. **Turn:** the flight direction at the frame, from the centres of the frames before and
   after it on the same run (frame numbers rise along the flight). The picture is turned to
   that line, plus the quarter-turn that starts the chosen frame nearest north-up.
3. **Hand corrections:** Rotate 90 and Flip in the app, because the film's "up" is not in
   the index. Reset goes back to step 2.
4. **Fill view:** other frames from the same film use the same quarter-turn relative to their
   own run's flight line (the camera is fixed in the aircraft), so runs flown in the opposite
   direction come out turned 180 degrees, as they should.

What it ignores: camera tilt, terrain relief (hills lean away from the photo centre),
lens distortion, and the difference between the nominal and real ground cover. Expect
offsets of tens of metres, and more in steep country or near the frame edges. For accurate
work, fit ground control points to an orthophoto and use a camera model.

## The JSON

```json
{
 "note": "Rough flat placement ... NOT orthorectified ...",
 "image": "https://apimages.nre.tas.gov.au/images/LandTasFilms/<film>/Scans/<name>.tif",
 "thumbnail": "https://apimages.nre.tas.gov.au/images/LandTasFilms/<film>/Thumbnails/<name>_thumb.jpg",
 "frame": {"name": "...", "film": "...", "run": 6, "frame": "093", "flown": "...", "scale": 12672, "project": "..."},
 "crs": "EPSG:7855",
 "corners": {"top_left": [E, N], "top_right": [E, N], "bottom_right": [E, N], "bottom_left": [E, N]},
 "crs_lonlat": "EPSG:7844",
 "corners_lonlat": {"top_left": [lon, lat], "...": "..."},
 "quarter_turns": 0, "flipped": false
}
```

`corners` are the ground positions of the picture's own outer pixel edges, in GDA2020 /
MGA (the zone follows the frame: EPSG:7855 for most of Tasmania). They do not depend on the
picture's pixel size, so the same file places the thumbnail or the full scan. Three corners
define the affine transform; the fourth is a check.

## Python (GDAL)

The app names the download `<frame>_rough_georef.json`; the recipes below read it as
`frame_rough_georef.json`.

```python
import json
from osgeo import gdal
gdal.UseExceptions()

j = json.load(open("frame_rough_georef.json"))
src = j["image"] if not j["image"].startswith("http") else "/vsicurl/" + j["image"]
c = j["corners"]

info = gdal.Open(src)
W, H = info.RasterXSize, info.RasterYSize
tl, tr, bl = c["top_left"], c["top_right"], c["bottom_left"]
gt = (tl[0], (tr[0] - tl[0]) / W, (bl[0] - tl[0]) / H,
      tl[1], (tr[1] - tl[1]) / W, (bl[1] - tl[1]) / H)

# 1. a VRT pointing at the original scan, with the rough affine placement (no pixels copied)
vrt = gdal.Translate("frame_rough.vrt", src, format="VRT", outputSRS=j["crs"])
vrt.SetGeoTransform(gt)
vrt = None

# 2. optional: a north-up GeoTIFF for tools that do not handle rotated rasters
gdal.Warp("frame_rough.tif", "frame_rough.vrt", dstSRS=j["crs"], resampleAlg="bilinear",
          creationOptions=["COMPRESS=DEFLATE", "TILED=YES"])
```

`frame_rough.vrt` points at the original scan and holds the rotated affine transform, so no
pixels are copied; QGIS and GDAL-based tools open it directly. With the full scan behind
`/vsicurl/`, reading it pulls the whole TIFF (they are not cloud-optimised), so for repeated
use download it first and point `image` at the local file.

## R (sf and terra)

```r
library(jsonlite)
library(sf)      # for sf::gdal_utils (GDAL's translate and warp)

j <- fromJSON("frame_rough_georef.json")
src <- if (grepl("^http", j$image)) paste0("/vsicurl/", j$image) else j$image
cc <- j$corners

r <- terra::rast(src)                 # only to read the picture's size
W <- ncol(r); H <- nrow(r)

# the four picture corners as ground control points: pixel, line, easting, northing
gcp <- function(px, ln, xy) c("-gcp", px, ln, xy[1], xy[2])
gdal_utils("translate", src, "frame_rough.vrt",
           options = c("-of", "VRT", "-a_srs", j$crs,
                       gcp(0, 0, cc$top_left), gcp(W, 0, cc$top_right),
                       gcp(W, H, cc$bottom_right), gcp(0, H, cc$bottom_left)))

# a north-up GeoTIFF; -order 1 = a plain affine fit, exact for these four corners
gdal_utils("warp", "frame_rough.vrt", "frame_rough_R.tif",
           options = c("-order", "1", "-t_srs", j$crs, "-r", "bilinear", "-co", "COMPRESS=DEFLATE"))

terra::rast("frame_rough_R.tif")
```

terra does not handle rotated transforms, hence the ground control points and the warp to a
north-up GeoTIFF. With gdalraster you can instead open the VRT for update and set the
geotransform as in the Python version.

## Command line

```sh
# W x H from: gdalinfo scan.tif
gdal_translate -of VRT -a_srs EPSG:7855 \
  -gcp 0 0 <TL E> <TL N> -gcp W 0 <TR E> <TR N> -gcp W H <BR E> <BR N> -gcp 0 H <BL E> <BL N> \
  scan.tif frame_rough.vrt
gdalwarp -order 1 -t_srs EPSG:7855 -r bilinear frame_rough.vrt frame_rough.tif
```

## Checked

Both recipes were run (GDAL 3.8.4; R with sf 1.0-15 and terra 1.7-65) on a stand-in image
turned 12.7 degrees: the VRT's corners reproduce the JSON corners to 0.1 m, and the Python
and R warps give the same north-up extent.
