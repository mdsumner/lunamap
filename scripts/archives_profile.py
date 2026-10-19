#!/usr/bin/env python3
"""Profile the Libraries Tasmania 'Digitised Archives' CSV (data.gov.au, CC BY 4.0) to see
how much of it could be placed on a map.

Streams the file once and writes research/archives-profile.json:
  - columns, non-empty counts, max length, sample values, top values (low-cardinality columns)
  - links: how many values look like URLs, and to which hosts
  - places: rows whose text mentions a Tasmanian place name from data/osm-places-tas.json
    (1-3 word phrases matched against OSM place names; a rough upper bound, with examples)
  - dates: years found in text, by decade
Usage: python3 scripts/archives_profile.py archives.csv
"""
import collections, csv, json, re, sys

csv.field_size_limit(10**8)
path = sys.argv[1]
places = json.load(open("data/osm-places-tas.json"))["places"]
pnames = {}
for p in places:
    n = p[1].lower().strip()
    if len(n) >= 4 and n not in ("road", "creek", "river", "point", "beach", "bay", "hill", "mount"):
        pnames.setdefault(n, (p[1], p[2], p[3], p[4]))
word = re.compile(r"[a-z][a-z'\-]+")
url_re = re.compile(r"https?://([^/\s\"']+)")
year_re = re.compile(r"\b(1[789]\d\d|20[012]\d)\b")

AMBIG = {"forest", "gordon", "franklin", "montagu", "lachlan", "swanston", "stanley", "richmond", "lilydale", "carrick",
         "penguin", "nelson", "wilmot", "dover", "jericho", "bridport", "york", "brighton", "kingston", "elizabeth", "hamilton",
         "west coast", "mount direction", "gordon river", "huon", "derby", "bothwell", "colebrook", "ross", "evandale"}
KEYWORDS = ["parish of", "town of", "land district", "county of", "survey", "plan of", "map of", "subdivision",
            "road", "bridge", "jetty", "school", "railway", "station", "aerial", "street", "lot ", "allotment", "bushfire", "fire"]
fmt_rows = collections.Counter(); fmt_place = collections.Counter(); fmt_place_ambig = collections.Counter(); fmt_open = collections.Counter()
fmt_place_names = collections.defaultdict(collections.Counter); fmt_kw = collections.defaultdict(collections.Counter)
fmt_samples = collections.defaultdict(list)
cols = None
stats = {}
rows = 0
url_hosts = collections.Counter()
place_hits = collections.Counter()
rows_with_place = 0
place_examples = []
decades = collections.Counter()
rows_with_url = 0
examples = []

with open(path, newline="", encoding="utf-8", errors="replace") as f:
    rd = csv.reader(f)
    cols = next(rd)
    for c in cols:
        stats[c] = {"nonempty": 0, "maxlen": 0, "samples": [], "top": collections.Counter(), "distinct_capped": set()}
    for r in rd:
        rows += 1
        if len(examples) < 5:
            examples.append(dict(zip(cols, r)))
        text = []
        has_url = False
        for c, v in zip(cols, r):
            s = stats[c]
            v = v.strip()
            if not v:
                continue
            s["nonempty"] += 1
            s["maxlen"] = max(s["maxlen"], len(v))
            if len(s["samples"]) < 6 and v not in s["samples"]:
                s["samples"].append(v[:200])
            if len(s["distinct_capped"]) < 2000:
                s["distinct_capped"].add(v[:200])
            if len(v) <= 80:
                s["top"][v] += 1
            for h in url_re.findall(v):
                url_hosts[h.lower()] += 1
                has_url = True
            text.append(v.lower())
        if has_url:
            rows_with_url += 1
        t = " ".join(text)
        rec = dict(zip(cols, r))
        fmt = rec.get("LOCAL_FORMAT", "") or "?"
        fmt_rows[fmt] += 1
        title = " ".join([rec.get("TITLE", ""), rec.get("ITEM_FURTHER_DESC", ""), rec.get("SUBJECT", "")]).lower()
        if len(fmt_samples[fmt]) < 40 and fmt_rows[fmt] % 2311 == 1:
            fmt_samples[fmt].append(rec.get("TITLE", "")[:160] + "  [" + rec.get("PUBDATE_RANGE", "") + "] " + rec.get("RECORD_URL", ""))
        tw = word.findall(title)
        tfound = set()
        for n in (1, 2, 3):
            for i in range(len(tw) - n + 1):
                g = " ".join(tw[i:i + n])
                if g in pnames:
                    tfound.add(g)
        if tfound:
            fmt_place[fmt] += 1
            if all(g in AMBIG for g in tfound):
                fmt_place_ambig[fmt] += 1
            for g in tfound:
                fmt_place_names[fmt][g] += 1
        for kw in KEYWORDS:
            if kw in title:
                fmt_kw[fmt][kw] += 1
        if rec.get("ACCESS", "") == "Open":
            fmt_open[fmt] += 1
        for y in set(year_re.findall(t)):
            decades[y[:3] + "0s"] += 1
        ws = word.findall(t)
        found = set()
        for n in (1, 2, 3):
            for i in range(len(ws) - n + 1):
                g = " ".join(ws[i:i + n])
                if g in pnames:
                    found.add(g)
        if found:
            rows_with_place += 1
            for g in found:
                place_hits[g] += 1
            if len(place_examples) < 25 and rows % 997 == 0:
                place_examples.append({"places": sorted(found)[:5], "text": t[:300]})

out = {
    "source": "Libraries Tasmania Digitised Archives CSV, data.gov.au (CC BY 4.0)",
    "rows": rows,
    "columns": [],
    "rows_with_url": rows_with_url,
    "url_hosts": url_hosts.most_common(20),
    "rows_with_place_name_any_column": rows_with_place,
    "top_place_names": [[g, n, pnames[g][3]] for g, n in place_hits.most_common(60)],
    "place_examples": place_examples,
    "years_by_decade": sorted(decades.items()),
    "example_rows": examples,
}
for c in cols:
    s = stats[c]
    d = len(s["distinct_capped"])
    out["columns"].append({
        "name": c, "nonempty": s["nonempty"], "maxlen": s["maxlen"],
        "distinct": d if d < 2000 else "2000+", "samples": s["samples"],
        "top": s["top"].most_common(15) if d < 2000 else s["top"].most_common(8),
    })
out["by_format"] = {f: {"rows": fmt_rows[f], "open_access": fmt_open[f], "title_has_place": fmt_place[f],
                        "title_place_only_ambiguous": fmt_place_ambig[f], "top_title_places": fmt_place_names[f].most_common(40),
                        "keywords": fmt_kw[f].most_common(), "sample_titles": fmt_samples[f]} for f in fmt_rows}
json.dump(out, open("research/archives-profile.json", "w"), indent=1, ensure_ascii=True)
print(rows, "rows;", rows_with_place, "with a place name;", rows_with_url, "with a URL")
