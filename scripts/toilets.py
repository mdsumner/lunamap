#!/usr/bin/env python3
"""Public toilets in Tasmania for lunamap: the National Public Toilet Map (data.gov.au) plus
OpenStreetMap amenity=toilets not already within 60 m of one. Writes data/toilets-tas.json:
  [lat, lon, name, source, flags, hours]   flags: A accessible, B baby change, S shower,
  W drinking water, U unisex, P accessible parking, F free / no fee unknown left out
"""
import csv, io, json, math, sys, time, urllib.parse, urllib.request
UA = {"User-Agent": "lunamap (github.com/mdsumner/lunamap)"}
def get(url, data=None):
    for i in range(4):
        try:
            req = urllib.request.Request(url, data=data, headers=UA)
            with urllib.request.urlopen(req, timeout=180) as r: return r.read()
        except Exception as e:
            print("retry", url[:80], e, file=sys.stderr); time.sleep(10 * (i + 1))
    raise SystemExit("failed: " + url)

rows = []
# National Public Toilet Map: find the CSV resource through the data.gov.au catalogue
pkg = json.loads(get("https://data.gov.au/data/api/3/action/package_search?q=" + urllib.parse.quote("national public toilet map") + "&rows=5"))
csv_url = None
for p in pkg["result"]["results"]:
    for r in p.get("resources", []):
        if (r.get("format") or "").lower() == "csv" or (r.get("url") or "").lower().endswith(".csv"):
            csv_url = r["url"]; print("NPTM:", p["title"], "|", r.get("name"), "|", csv_url, file=sys.stderr); break
    if csv_url: break
nptm = 0
if csv_url:
    text = get(csv_url).decode("utf-8-sig", "replace")
    rd = csv.DictReader(io.StringIO(text))
    cols = {c.lower().replace(" ", "").replace("_", ""): c for c in rd.fieldnames}
    print("columns:", rd.fieldnames, file=sys.stderr)
    def f(rec, *names):
        for n in names:
            c = cols.get(n)
            if c and rec.get(c) not in (None, ""): return rec[c].strip()
        return ""
    def yes(v): return v.strip().lower() in ("true", "yes", "y", "1")
    for rec in rd:
        if f(rec, "state").upper() not in ("TAS", "TASMANIA"): continue
        try: lat, lon = float(f(rec, "latitude", "lat")), float(f(rec, "longitude", "lon", "long"))
        except ValueError: continue
        flags = ""
        if yes(f(rec, "accessiblemale")) or yes(f(rec, "accessiblefemale")) or yes(f(rec, "accessibleunisex")) or yes(f(rec, "accessible")): flags += "A"
        if yes(f(rec, "babychange")): flags += "B"
        if yes(f(rec, "shower")) or yes(f(rec, "showers")): flags += "S"
        if yes(f(rec, "drinkingwater")): flags += "W"
        if yes(f(rec, "unisex")): flags += "U"
        if yes(f(rec, "parkingaccessible")) or yes(f(rec, "accessibleparking")): flags += "P"
        hours = f(rec, "openinghours", "opening") or ("24 hours" if yes(f(rec, "open24hours", "isopen24hours")) else "")
        name = f(rec, "name") or f(rec, "address1", "address")
        town = f(rec, "town")
        if town and town.lower() not in name.lower(): name += ", " + town.title()
        rows.append([round(lat, 6), round(lon, 6), name.encode("ascii", "ignore").decode()[:100], "n", flags, hours.encode("ascii", "ignore").decode()[:80]])
        nptm += 1
print(nptm, "from the National Public Toilet Map", file=sys.stderr)

# OpenStreetMap
q = '[out:json][timeout:180];area["ISO3166-2"="AU-TAS"][admin_level=4]->.tas;nwr["amenity"="toilets"](area.tas);out center tags;'
osm = json.loads(get("https://overpass-api.de/api/interpreter", data=urllib.parse.urlencode({"data": q}).encode()))
def near(lat, lon):
    for r in rows:
        if r[3] == "n" and abs(r[0] - lat) < 0.001 and abs(r[1] - lon) < 0.0014:
            dy = (r[0] - lat) * 111320; dx = (r[1] - lon) * 111320 * math.cos(math.radians(lat))
            if dx * dx + dy * dy < 3600: return True
    return False
n_osm = 0
for e in osm["elements"]:
    lat = e.get("lat") or (e.get("center") or {}).get("lat"); lon = e.get("lon") or (e.get("center") or {}).get("lon")
    if lat is None or near(lat, lon): continue
    t = e.get("tags", {})
    flags = ("A" if t.get("wheelchair") == "yes" else "") + ("B" if t.get("changing_table") == "yes" else "") + \
            ("S" if t.get("shower") == "yes" else "") + ("W" if t.get("drinking_water") == "yes" else "") + ("U" if t.get("unisex") == "yes" else "")
    name = t.get("name") or t.get("description") or ("Toilet" + (" (" + t["toilets:disposal"] + ")" if t.get("toilets:disposal") else ""))
    rows.append([round(lat, 6), round(lon, 6), name.encode("ascii", "ignore").decode()[:100], "o", flags, (t.get("opening_hours") or "")[:80]])
    n_osm += 1
print(n_osm, "more from OpenStreetMap", file=sys.stderr)
out = {"sources": {"n": "National Public Toilet Map, Australian Government (data.gov.au)", "o": "OpenStreetMap contributors (ODbL)"},
       "nptm_csv": csv_url, "harvested": time.strftime("%Y-%m-%d"), "fields": ["lat", "lon", "name", "source", "flags", "hours"],
       "flags": {"A": "accessible", "B": "baby change", "S": "shower", "W": "drinking water", "U": "unisex", "P": "accessible parking"},
       "toilets": rows}
open("data/toilets-tas.json", "w").write(json.dumps(out, ensure_ascii=True, separators=(",", ":")) + "\n")
print(len(rows), "toilets")
