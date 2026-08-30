#!/usr/bin/env python3
"""Per-location views + metrics + full shareable links + country breakdown.
Decodes lat/lon in URLs to place names via data/cells.csv."""
import json, os, re, csv, urllib.request, collections, datetime

here = os.path.dirname(os.path.abspath(__file__))
root = os.path.abspath(os.path.join(here, "..", ".."))
env = {}
with open(os.path.join(here, "cloudflare.env")) as f:
    for line in f:
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            env[k] = v
TOKEN, ZONE = env["CLOUDFLARE_ANALYTICS_TOKEN"], env["CLOUDFLARE_ZONE_ID"]
URL = "https://api.cloudflare.com/client/v4/graphql"
DAYS = ["2026-06-12", "2026-06-13", "2026-06-14", "2026-06-15", "2026-06-16"]
EXCLUDE = set()  # MX = developer's own testing — kept in as a signal


def gql(query):
    req = urllib.request.Request(URL, data=json.dumps({"query": query}).encode(),
        headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"})
    d = json.load(urllib.request.urlopen(req))
    if d.get("errors"):
        raise RuntimeError(json.dumps(d["errors"], indent=2))
    return d["data"]


cells = {}
with open(os.path.join(root, "data", "cells.csv")) as f:
    for row in csv.DictReader(f):
        cells[(round(float(row["lat"]), 1), round(float(row["lon"]), 1))] = row["name"]


def name_for(lat, lon):
    key = (round(lat, 1), round(lon, 1))
    if key in cells:
        return cells[key]
    best, bd = None, 9e9
    for (cl, co), nm in cells.items():
        d = (cl - lat) ** 2 + (co - lon) ** 2
        if d < bd:
            best, bd = nm, d
    return best + " (nearest)"


FC = re.compile(r"/forecast/forecast_(-?\d+\.\d+)_(-?\d+\.\d+)\.csv")
CARD = re.compile(r"^/(-?\d+\.\d+),(-?\d+\.\d+)/(\d{4}-\d{2}-\d{2})/(\w+)")

loc_country = collections.defaultdict(collections.Counter)
card_country = collections.defaultdict(collections.Counter)
card_meta = {}            # path -> (locname, date, metric)
card_host = {}            # path -> host
metric_total = collections.Counter()
fc_total = 0

for day in DAYS:
    nxt = (datetime.date.fromisoformat(day) + datetime.timedelta(days=1)).isoformat()
    q = f'''{{ viewer {{ zones(filter: {{zoneTag: "{ZONE}"}}) {{
      httpRequestsAdaptiveGroups(limit: 5000,
        filter: {{datetime_geq: "{day}T00:00:00Z", datetime_lt: "{nxt}T00:00:00Z"}},
        orderBy: [count_DESC]) {{
        count dimensions {{ clientRequestPath clientCountryName clientRequestHTTPHost }} }} }} }} }}'''
    for r in gql(q)["viewer"]["zones"][0]["httpRequestsAdaptiveGroups"]:
        dm = r["dimensions"]
        p, cc, host = dm["clientRequestPath"], dm["clientCountryName"], dm["clientRequestHTTPHost"]
        if cc in EXCLUDE:
            continue
        n = r["count"]
        m = FC.match(p)
        if m:
            loc_country[name_for(float(m.group(1)), float(m.group(2)))][cc] += n
            fc_total += n
            continue
        m = CARD.match(p)
        if m:
            loc = name_for(float(m.group(1)), float(m.group(2)))
            metric = m.group(4)
            card_country[p][cc] += n
            card_meta[p] = (loc, m.group(3), metric)
            card_host[p] = host
            metric_total[metric] += n


print("=" * 74)
print("METRIC POPULARITY  (from deep-link URLs — metric is a client-side toggle,")
print("so only visible when someone lands on / shares a specific card URL)")
print("=" * 74)
tot_m = sum(metric_total.values()) or 1
for metric, n in metric_total.most_common():
    print(f"  {metric:<8} {n:>5}  {n/tot_m*100:5.1f}%")
print(f"  {'TOTAL':<8} {tot_m:>5}")

print()
print("=" * 74)
print("TOP CITY VIEWS  (one forecast fetch = one view)")
print("=" * 74)
print(f"(total external+you forecast fetches: {fc_total})\n")
for loc, ctr in sorted(loc_country.items(), key=lambda kv: -sum(kv[1].values()))[:20]:
    print(f"{sum(ctr.values()):>5}  {loc:<42} {', '.join(f'{c} {v}' for c,v in ctr.most_common(5))}")

print()
print("=" * 74)
print("SHARED / DEEP-LINK CARDS  (full clickable URL + metric + countries)")
print("=" * 74)
for p, ctr in sorted(card_country.items(), key=lambda kv: -sum(kv[1].values()))[:25]:
    loc, date, metric = card_meta[p]
    total = sum(ctr.values())
    print(f"{total:>4} views  {loc}  [{metric} · {date}]")
    print(f"           https://{card_host[p]}{p}")
    print(f"           from: {', '.join(f'{c} {v}' for c,v in ctr.most_common(6))}")
