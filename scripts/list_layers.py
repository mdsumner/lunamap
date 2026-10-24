#!/usr/bin/env python3
"""Catalogue every layer in theLIST's public ArcGIS map services (Public and Basemaps folders)
for lunamap's layer finder. Writes data/list-layers.json:
  services: [[path, title, description]]
  layers:   [service index, layer id, name, group path, geometry, min zoom, max zoom, description]
Group layers are kept (so the finder can show where a layer sits) but marked geometry "group".
"""
import json, math, re, sys, time, urllib.request

ROOT = "https://services.thelist.tas.gov.au/arcgis/rest/services/"
UA = {"User-Agent": "lunamap layer catalogue (github.com/mdsumner/lunamap)"}

def get(url):
    for i in range(4):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=90) as r:
                return json.load(r)
        except Exception as e:
            print("retry", url, e, file=sys.stderr); time.sleep(5 * (i + 1))
    return {}

def clean(t, n=240):
    t = re.sub(r"<[^>]+>", " ", t or ""); t = re.sub(r"&[a-z]+;", " ", t)
    t = re.sub(r"\s+", " ", t).strip()
    t = t.encode("ascii", "ignore").decode()
    return t[:n]

def zoom(scale):
    if not scale: return None
    return max(0, min(22, round(math.log2(591657527.59 / scale))))

services, layers = [], []
for folder in ["Public", "Basemaps"]:
    d = get(ROOT + folder + "?f=json")
    for s in d.get("services", []):
        if s.get("type") != "MapServer": continue
        path = s["name"] + "/MapServer"
        info = get(ROOT + path + "?f=json")
        title = info.get("documentInfo", {}).get("Title") or s["name"].split("/")[-1]
        cached = bool(info.get("singleFusedMapCache"))
        si = len(services)
        services.append([path, clean(title, 120), clean(info.get("serviceDescription") or info.get("description"), 300), 1 if cached else 0])
        if folder == "Basemaps": continue
        ls = get(ROOT + path + "/layers?f=json").get("layers", [])
        byid = {l["id"]: l for l in ls}
        for l in ls:
            grp, p = [], l.get("parentLayer")
            while p:
                pl = byid.get(p["id"]); grp.insert(0, p.get("name", "")); p = pl.get("parentLayer") if pl else None
            geom = "group" if l.get("type") == "Group Layer" else (l.get("geometryType") or l.get("type") or "").replace("esriGeometry", "").lower()
            layers.append([si, l["id"], clean(l.get("name"), 120), " / ".join(grp), geom,
                           zoom(l.get("minScale")), zoom(l.get("maxScale")), clean(l.get("description"), 240)])
        print(path, len(ls), file=sys.stderr)
json.dump({"source": "theLIST ArcGIS REST services directory (State of Tasmania)", "root": ROOT,
           "updated": time.strftime("%Y-%m-%d"), "services": services, "layers": layers},
          open("data/list-layers.json", "w"), ensure_ascii=True, separators=(",", ":"))
print(len(services), "services,", len(layers), "layers")
