#!/usr/bin/env python3
"""Build lunamap's "Archives near here" index from the Libraries Tasmania Digitised Archives
catalogue (data.gov.au, CC BY 4.0).

Keeps open-access photographs, maps and plans, and film whose title (or further description)
names a Tasmanian place from data/osm-places-tas.json, and files each item under the most
specific place it names (a suburb, town or locality before a city). Names that are also
common words or surnames are kept but marked "maybe".

Writes:
  data/archives/index.json        places with items: [osm id, name, lon, lat, photos, maps, plans, film]
  data/archives/p/<osm id>.json   that place's items: [catalogue id, title, years, kind, maybe]
kind: p photograph, m map, b building plan (Public Works Department drawings), f film
Items link to https://stors.tas.gov.au/AI/<catalogue id>.
Usage: python3 scripts/archives_index.py archives.csv
"""
import collections, csv, json, os, re, shutil, sys

csv.field_size_limit(10**8)
src = sys.argv[1]
places = json.load(open("data/osm-places-tas.json"))["places"]       # [id, name, lat, lon, type]
RANK = {"city": 0, "town": 2, "suburb": 3, "village": 3, "locality": 3, "hamlet": 3, "neighbourhood": 4, "isolated_dwelling": 4}
SKIP = {"road", "creek", "river", "point", "beach", "bay", "hill", "mount", "forest", "national park", "west coast",
        "east coast", "north", "south", "central"}
MAYBE = {"gordon", "franklin", "montagu", "lachlan", "swanston", "stanley", "nelson", "wilmot", "elizabeth", "hamilton",
         "york", "carrick", "penguin", "dover", "jericho", "brighton", "derby", "ross", "richmond", "kingston", "bothwell",
         "evandale", "lilydale", "forth", "mole creek", "pioneer", "nugent", "mangana", "mathinna", "osterley", "orford"}
byname = {}
for pid, name, lat, lon, typ in places:
    n = name.lower().strip()
    if len(n) < 4 or n in SKIP:
        continue
    cur = byname.get(n)
    if cur is None or RANK.get(typ, 5) < RANK.get(cur[4], 5):      # one place per name: the biggest
        byname[n] = (pid, name, lat, lon, typ)
word = re.compile(r"[a-z][a-z'\-]+")
KIND = {"photograph": "p", "map/plan": "m", "film": "f"}

items = collections.defaultdict(list)
seen = 0
with open(src, newline="", encoding="utf-8", errors="replace") as f:
    for r in csv.DictReader(f):
        kind = KIND.get(r.get("LOCAL_FORMAT", ""))
        if not kind or r.get("ACCESS", "") != "Open":
            continue
        seen += 1
        if kind == "m" and (r.get("ID", "").startswith("PWD266/") or r.get("TITLE", "").startswith("Plan - ")):
            kind = "b"
        title = (r.get("TITLE", "") or "").strip()
        text = (title + " " + (r.get("ITEM_FURTHER_DESC", "") or "")).lower()
        ws = word.findall(text)
        found = set()
        for n in (1, 2, 3):
            for i in range(len(ws) - n + 1):
                g = " ".join(ws[i:i + n])
                if g in byname:
                    found.add(g)
        # drop a name that is part of a longer one found ("hobart" inside "south hobart")
        found = {g for g in found if not any(g != h and (" " + g + " ") in (" " + h + " ") for h in found)}
        if not found:
            continue
        sure = [g for g in found if g not in MAYBE]
        pool = sure or list(found)
        best = max(RANK.get(byname[g][4], 5) for g in pool)            # the most specific kind of place named
        specific = [g for g in pool if RANK.get(byname[g][4], 5) == best]
        years = (r.get("PUBDATE_RANGE", "") or "").strip()
        rec = [r.get("ID", ""), title[:160], years, kind, 0 if sure else 1]
        for g in specific:
            items[byname[g][0]].append(rec)

out_dir = "data/archives"
shutil.rmtree(out_dir, ignore_errors=True)
os.makedirs(out_dir + "/p")
index = []
for pid, recs in items.items():
    _, name, lat, lon, typ = next(v for v in byname.values() if v[0] == pid)
    recs.sort(key=lambda x: (x[3], x[2], x[1]))
    c = collections.Counter(x[3] for x in recs)
    index.append([pid, name, round(lon, 5), round(lat, 5), c["p"], c["m"], c["b"], c["f"]])
    json.dump({"name": name, "items": recs}, open("%s/p/%s.json" % (out_dir, pid), "w"), ensure_ascii=True, separators=(",", ":"))
index.sort(key=lambda x: x[1])
json.dump({"source": "Libraries Tasmania Digitised Archives catalogue, data.gov.au (CC BY 4.0); open-access items only",
           "link": "https://stors.tas.gov.au/AI/{id}", "fields": ["osm_id", "name", "lon", "lat", "photos", "maps", "plans", "film"],
           "places": index}, open(out_dir + "/index.json", "w"), ensure_ascii=True, separators=(",", ":"))
total = sum(len(v) for v in items.values())
size = sum(os.path.getsize(os.path.join(out_dir, "p", f)) for f in os.listdir(out_dir + "/p"))
print(seen, "open items of the kinds kept;", total, "placements at", len(index), "places;", round(size / 1e6, 1), "MB")
