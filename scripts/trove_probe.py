#!/usr/bin/env python3
"""Probe Trove (National Library of Australia) for Libraries Tasmania items that are online
with images, to see whether lunamap could show photo previews for "Archives near here".

Needs TROVE_API_KEY in the environment (a free key from Trove). Writes research/trove-probe.json:
  - facet counts: which contributors (partner NUCs) dominate Tasmanian online images
  - totals for a few candidate filters for Libraries Tasmania
  - a sample of records: titles, dates, links (thumbnail / item), and how many name a
    Tasmanian place from data/osm-places-tas.json
Polite: a few dozen requests, paced.
"""
import json, os, re, sys, time, urllib.parse, urllib.request

KEY = os.environ.get("TROVE_API_KEY")
if not KEY:
    sys.exit("TROVE_API_KEY is not set (add it as a repository secret)")
BASE = "https://api.trove.nla.gov.au/v3/result"
log = []

def get(params):
    q = dict(params, encoding="json")
    url = BASE + "?" + urllib.parse.urlencode(q, doseq=True)
    req = urllib.request.Request(url, headers={"X-API-KEY": KEY, "User-Agent": "lunamap probe (github.com/mdsumner/lunamap)"})
    time.sleep(1.5)
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            d = json.load(r)
        log.append({"params": params, "ok": True})
        return d
    except Exception as e:
        body = getattr(e, "read", lambda: b"")()[:300]
        log.append({"params": params, "ok": False, "error": str(e), "body": body.decode("utf-8", "replace")})
        return None

def total(d):
    try: return int(d["category"][0]["records"]["total"])
    except Exception: return None

def facets(d):
    out = {}
    try:
        for f in d["category"][0]["facets"]["facet"]:
            out[f["name"]] = [[t.get("display") or t.get("search"), int(t["count"])] for t in f.get("term", [])][:40]
    except Exception:
        pass
    return out

out = {"about": "Trove API v3 probe for Libraries Tasmania online images", "requests": log}

# 1. which contributors hold online Tasmanian images, and what formats
d = get({"category": "image", "q": "tasmania", "l-availability": "y", "facet": ["partnerNuc", "format", "availability"], "n": 0})
out["tasmania_online_images"] = {"total": total(d), "facets": facets(d)}

# 2. candidate filters for Libraries Tasmania (NUC guesses, then the top partner from step 1)
cands = ["TSL", "TL", "TAS:LT", "TLIB"]
for name, terms in out["tasmania_online_images"]["facets"].items():
    if name.lower().startswith("partner"):
        cands += [t[0] for t in terms[:5] if t[0]]
seen = set(); out["filters"] = []
for nuc in cands:
    if nuc in seen: continue
    seen.add(nuc)
    d = get({"category": "image", "l-partnerNuc": nuc, "l-availability": "y", "facet": ["format"], "n": 0})
    out["filters"].append({"l-partnerNuc": nuc, "total_online_images": total(d), "facets": facets(d)})

# 3. sample records from the best filter
best = max((f for f in out["filters"] if f["total_online_images"]), key=lambda f: f["total_online_images"], default=None)
places = json.load(open("data/osm-places-tas.json"))["places"]
names = {p[1].lower() for p in places if len(p[1]) >= 4}
word = re.compile(r"[a-z][a-z'\-]+")
sample = []
if best:
    start = "*"
    for _ in range(3):
        d = get({"category": "image", "l-partnerNuc": best["l-partnerNuc"], "l-availability": "y", "n": 100,
                 "bulkHarvest": "true", "s": start, "reclevel": "full", "include": ["links", "workversions"]})
        if not d: break
        recs = d["category"][0]["records"]
        sample += recs.get("work", [])
        start = recs.get("nextStart")
        if not start: break
def placed(t):
    ws = word.findall((t or "").lower())
    return sorted({" ".join(ws[i:i + n]) for n in (1, 2, 3) for i in range(len(ws) - n + 1)} & names)
out["best_filter"] = best and best["l-partnerNuc"]
out["sample_size"] = len(sample)
out["sample_with_place"] = sum(1 for w in sample if placed(w.get("title")))
out["sample"] = [{"title": w.get("title"), "date": w.get("issued"), "places": placed(w.get("title")),
                  "identifier": w.get("identifier"), "troveUrl": w.get("troveUrl")} for w in sample[:60]]
out["sample_raw_first"] = sample[:2]
os.makedirs("research", exist_ok=True)
json.dump(out, open("research/trove-probe.json", "w"), indent=1, ensure_ascii=True)
print("tasmania online images:", out["tasmania_online_images"]["total"], "| best filter:", out["best_filter"],
      "| sample", len(sample), "with place", out["sample_with_place"])
