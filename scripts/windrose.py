#!/usr/bin/env python3
"""Seasonal wind roses for a few points around Fern Tree, from modelled history.

Fetches hourly 10 m wind, temperature and humidity from the Open-Meteo historical
weather API (ECMWF IFS 9 km, 2017 onward) and counts hours into 16 directions by
speed band, for each season and for three filters:
  all        every hour
  am         mornings, 06:00 to 10:59 local time
  pm         afternoons, 13:00 to 17:59 local time
  firewx     afternoons that are hot and dry (temperature >= 25 C, humidity <= 30 %)
Writes data/windrose-ferntree.json (counts only, a few kB).

Data: Open-Meteo.com (CC BY 4.0), ECMWF IFS. Free for non-commercial use.
"""
import datetime
import json
import sys
import time
import urllib.parse
import urllib.request

POINTS = [
    ("Fern Tree", -42.9230, 147.2600),
    ("Hobart", -42.8900, 147.3280),
    ("Grove (Huon Valley)", -42.9850, 147.0760),
]
MODEL = "ecmwf_ifs"
START, END = "2017-01-01", "2025-12-31"
DIRS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"]
BANDS = [10, 20, 30, 40]          # km/h upper edges; last band is 40 and over
CALM = 2                          # km/h, counted separately, no direction
SEASONS = {"summer": (12, 1, 2), "autumn": (3, 4, 5), "winter": (6, 7, 8), "spring": (9, 10, 11)}
WARM = (9, 10, 11, 12, 1, 2)      # spring and summer together, the fire season
FILTERS = ["all", "am", "pm", "firewx"]
VARS = "wind_speed_10m,wind_direction_10m,wind_gusts_10m,temperature_2m,relative_humidity_2m"


def fetch(lat, lon):
    q = urllib.parse.urlencode({
        "latitude": lat, "longitude": lon, "start_date": START, "end_date": END,
        "hourly": VARS, "models": MODEL, "wind_speed_unit": "kmh", "timezone": "Australia/Hobart",
    })
    url = "https://archive-api.open-meteo.com/v1/archive?" + q
    for attempt in range(5):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "lunamap (github.com/mdsumner/lunamap)"})
            with urllib.request.urlopen(req, timeout=300) as r:
                return json.load(r)
        except Exception as e:  # rate limit or network: wait and retry
            print("retry", attempt, e, file=sys.stderr)
            time.sleep(60 * (attempt + 1))
    sys.exit("fetch failed for %s,%s" % (lat, lon))


def empty():
    return {"n": 0, "calm": 0, "gust": 0.0, "counts": [[0] * (len(BANDS) + 1) for _ in DIRS]}


def band(v):
    for i, b in enumerate(BANDS):
        if v < b:
            return i
    return len(BANDS)


def roses(d):
    h = d["hourly"]
    out = {s: {f: empty() for f in FILTERS} for s in list(SEASONS) + ["warm", "year"]}
    for t, ws, wd, wg, ta, rh in zip(h["time"], h["wind_speed_10m"], h["wind_direction_10m"],
                                     h["wind_gusts_10m"], h["temperature_2m"], h["relative_humidity_2m"]):
        if ws is None or wd is None:
            continue
        month, hour = int(t[5:7]), int(t[11:13])
        season = [s for s, ms in SEASONS.items() if month in ms][0]
        am = 6 <= hour <= 10
        pm = 13 <= hour <= 17
        fire = pm and ta is not None and rh is not None and ta >= 25 and rh <= 30
        groups = (season, "year", "warm") if month in WARM else (season, "year")
        for f, keep in (("all", True), ("am", am), ("pm", pm), ("firewx", fire)):
            if not keep:
                continue
            for s in groups:
                r = out[s][f]
                r["n"] += 1
                if wg is not None and wg > r["gust"]:
                    r["gust"] = wg
                if ws < CALM:
                    r["calm"] += 1
                else:
                    r["counts"][int((wd % 360) / 22.5 + 0.5) % 16][band(ws)] += 1
    return out


def main():
    pts = []
    seen = {}
    for name, lat, lon in POINTS:
        d = fetch(lat, lon)
        cell = (round(d["latitude"], 3), round(d["longitude"], 3))
        print(name, "cell", cell, "elevation", d.get("elevation"), "hours", len(d["hourly"]["time"]))
        if cell in seen:
            print("  same model cell as", seen[cell], "- skipped")
            continue
        seen[cell] = name
        pts.append({"name": name, "lat": lat, "lon": lon, "cell_lat": cell[0], "cell_lon": cell[1],
                    "cell_elevation_m": d.get("elevation"), "roses": roses(d)})
        time.sleep(20)
    out = {
        "source": "Open-Meteo historical weather API (open-meteo.com, CC BY 4.0), model " + MODEL + " (ECMWF IFS, about 9 km)",
        "credit": "Weather data by Open-Meteo.com; ECMWF IFS. Modelled, not measured.",
        "period": [START, END],
        "built": datetime.date.today().isoformat(),
        "dirs": DIRS, "bands_kmh": BANDS, "calm_kmh": CALM,
        "filters": {"all": "all hours", "am": "mornings 06:00-10:59", "pm": "afternoons 13:00-17:59",
                    "firewx": "hot dry afternoons (25 C or more, humidity 30% or less)"},
        "points": pts,
    }
    s = json.dumps(out, ensure_ascii=True, separators=(",", ":"))
    open("data/windrose-ferntree.json", "w").write(s + "\n")
    print(len(s), "bytes")


if __name__ == "__main__":
    main()
