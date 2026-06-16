#!/usr/bin/env python3
"""Unique-visitor report from the Worker's D1 log (the `hits` table).

Reads via the wrangler CLI (`wrangler d1 execute --remote --json`), so it uses
your existing `wrangler login` — no API token needed. Run from anywhere:

    python3 scripts/analytics/query.py

Counts are unique people PER DAY (the visitor id rotates daily for privacy, the
same as Cloudflare's own uniques). Datacenter/bot traffic is filtered out by ASN
and user-agent so the numbers reflect humans. Locations are decoded to place
names via data/cells.csv. Nothing about user behaviour is stored or shown — just
how many unique people, where, and viewing which location.
"""
import json
import os
import re
import csv
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
WORKER_DIR = os.path.join(ROOT, "worker")
DB = "howhotwasit-analytics"

# Datacenter operators → almost always bots/scanners, not humans. Matched as a
# case-insensitive substring against cf.asOrganization.
BOT_ORGS = [
    "Amazon", "Google", "Microsoft", "Azure", "OVH", "Hetzner", "DigitalOcean",
    "Linode", "Akamai", "Fastly", "Cloudflare", "Oracle", "Alibaba", "Tencent",
    "Leaseweb", "Datacamp", "M247", "Scaleway", "Censys", "Palo Alto",
    "Vultr", "Contabo", "Choopa", "GoDaddy", "Hostinger",
]
# User-agents that self-identify as automation.
BOT_UAS = ["bot", "spider", "crawl", "python", "curl", "wget", "http", "scan", "go-http"]


def bot_filter(col_org="asn_org", col_ua="ua"):
    """SQL fragment that excludes datacenter ASNs and automation user-agents."""
    parts = [f"COALESCE({col_org},'') NOT LIKE '%{o}%'" for o in BOT_ORGS]
    parts += [f"COALESCE({col_ua},'') NOT LIKE '%{u}%'" for u in BOT_UAS]
    return " AND ".join(parts)


def d1(query):
    """Run one SQL query against the remote D1 and return the list of row dicts."""
    cmd = [
        "npx", "wrangler", "d1", "execute", DB,
        "--remote", "--json", "--command", query,
    ]
    try:
        out = subprocess.run(
            cmd, cwd=WORKER_DIR, capture_output=True, text=True, timeout=120
        )
    except FileNotFoundError:
        sys.exit("npx/wrangler not found — run from a machine with the worker toolchain installed.")
    if out.returncode != 0:
        msg = (out.stderr or out.stdout).strip()
        if "no such table" in msg.lower():
            sys.exit("No `hits` table yet — apply the migration and deploy the Worker first.")
        sys.exit(f"wrangler failed:\n{msg}")
    # wrangler may print a banner before the JSON; grab from the first bracket.
    text = out.stdout
    start = min((i for i in (text.find("["), text.find("{")) if i != -1), default=-1)
    if start == -1:
        sys.exit(f"Could not parse wrangler output:\n{text}")
    data = json.loads(text[start:])
    if isinstance(data, list):
        return data[0].get("results", []) if data else []
    return data.get("results", [])


# --- decode /lat,lon → place name via cells.csv -----------------------------
cells = {}
with open(os.path.join(ROOT, "data", "cells.csv")) as f:
    for row in csv.DictReader(f):
        cells[(round(float(row["lat"]), 1), round(float(row["lon"]), 1))] = row["name"]

PAGE = re.compile(r"^/(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)")


def name_for_page(page):
    if not page:
        return "(home / bare visit)"
    m = PAGE.match(page)
    if not m:
        return page
    lat, lon = round(float(m.group(1)), 1), round(float(m.group(2)), 1)
    if (lat, lon) in cells:
        return cells[(lat, lon)]
    best, bd = None, 9e9
    for (cl, co), nm in cells.items():
        dd = (cl - lat) ** 2 + (co - lon) ** 2
        if dd < bd:
            best, bd = nm, dd
    return (best + " (nearest)") if best else page


HUMAN = bot_filter()

# --- 1. unique users per day (humans vs raw incl. bots) ---------------------
per_day = d1(
    "SELECT date(ts/1000,'unixepoch') AS d, "
    "COUNT(DISTINCT visitor) AS raw, "
    f"COUNT(DISTINCT CASE WHEN {HUMAN} THEN visitor END) AS humans "
    "FROM hits GROUP BY d ORDER BY d"
)

print("=" * 60)
print("UNIQUE USERS PER DAY  (server-side, adblock-proof)")
print("=" * 60)
if not per_day:
    print("  (no hits logged yet — comes online after deploy + first traffic)")
else:
    print(f"  {'day':<12} {'humans':>8} {'incl. bots':>12}")
    for r in per_day:
        print(f"  {r['d']:<12} {r['humans']:>8} {r['raw']:>12}")
    print("  (unique PER DAY — not additive across days; 'humans' drops datacenter/bot traffic)")

# --- 1b. new vs returning (stable id makes this possible) -------------------
overview = d1(
    "WITH vd AS (SELECT visitor, COUNT(DISTINCT date(ts/1000,'unixepoch')) AS days "
    f"FROM hits WHERE {HUMAN} GROUP BY visitor) "
    "SELECT COUNT(*) AS total, SUM(CASE WHEN days>=2 THEN 1 ELSE 0 END) AS ret FROM vd"
)
per_day_nr = d1(
    "WITH first_seen AS (SELECT visitor, MIN(date(ts/1000,'unixepoch')) AS f "
    f"FROM hits WHERE {HUMAN} GROUP BY visitor), "
    f"dv AS (SELECT DISTINCT date(ts/1000,'unixepoch') AS d, visitor FROM hits WHERE {HUMAN}) "
    "SELECT dv.d AS d, COUNT(*) AS users, "
    "SUM(CASE WHEN fs.f=dv.d THEN 1 ELSE 0 END) AS new_u, "
    "SUM(CASE WHEN fs.f<dv.d THEN 1 ELSE 0 END) AS ret_u "
    "FROM dv JOIN first_seen fs ON fs.visitor=dv.visitor GROUP BY dv.d ORDER BY dv.d"
)
print()
print("=" * 60)
print("NEW vs RETURNING  (one stable id per person across days)")
print("=" * 60)
if overview and overview[0].get("total"):
    t, r = overview[0]["total"], overview[0]["ret"] or 0
    print(f"  {t} unique people total over the window — {r} came back on 2+ days "
          f"({r / t * 100:.0f}% returning)")
    print()
    print(f"  {'day':<12} {'users':>6} {'new':>6} {'returning':>10}")
    for row in per_day_nr:
        print(f"  {row['d']:<12} {row['users']:>6} {row['new_u']:>6} {row['ret_u']:>10}")
else:
    print("  (none yet)")

# --- 2. unique users per location -------------------------------------------
per_loc = d1(
    "SELECT page, COUNT(DISTINCT visitor) AS u, COUNT(*) AS hits "
    f"FROM hits WHERE kind='view' AND {HUMAN} "
    "GROUP BY page ORDER BY u DESC LIMIT 30"
)
print()
print("=" * 60)
print("UNIQUE USERS PER LOCATION  (humans only)")
print("=" * 60)
if not per_loc:
    print("  (none yet)")
for r in per_loc:
    print(f"  {r['u']:>5} users  ({r['hits']:>4} views)  {name_for_page(r['page'])}")

# --- 2b. how many locations each person checks ------------------------------
ape = d1(
    "WITH pu AS (SELECT visitor, COUNT(DISTINCT page) AS locs "
    f"FROM hits WHERE kind='view' AND page IS NOT NULL AND {HUMAN} GROUP BY visitor) "
    "SELECT COUNT(*) AS users, ROUND(AVG(locs),2) AS avg_locs, MAX(locs) AS max_locs FROM pu"
)
print()
print("=" * 60)
print("LOCATIONS CHECKED PER USER  (engagement, no behaviour trail)")
print("=" * 60)
if ape and ape[0].get("users"):
    a = ape[0]
    print(f"  {a['users']} people checked {a['avg_locs']} locations each on average "
          f"(most by one person: {a['max_locs']})")
else:
    print("  (none yet)")

# --- 2c. which metrics people looked at -------------------------------------
# The metric is the last path segment of `page` (/lat,lon/date/metric). 'arrived'
# = the metric they landed/shared on (kind='view'); 'switched-to' = an in-app
# toggle (kind='toggle').
METRIC_EXPR = (
    "CASE WHEN page LIKE '%/tmax' THEN 'tmax' "
    "WHEN page LIKE '%/tmin' THEN 'tmin' "
    "WHEN page LIKE '%/precip' THEN 'precip' "
    "WHEN page LIKE '%/wind' THEN 'wind' END"
)
metrics = d1(
    "SELECT m, COUNT(DISTINCT visitor) AS u, "
    "SUM(CASE WHEN kind='view' THEN 1 ELSE 0 END) AS arrivals, "
    "SUM(CASE WHEN kind='toggle' THEN 1 ELSE 0 END) AS toggles "
    f"FROM (SELECT visitor, kind, {METRIC_EXPR} AS m "
    f"FROM hits WHERE page IS NOT NULL AND {HUMAN}) "
    "WHERE m IS NOT NULL GROUP BY m ORDER BY u DESC"
)
print()
print("=" * 60)
print("METRICS PEOPLE LOOKED AT")
print("=" * 60)
if not metrics:
    print("  (none yet — needs the metric-logging frontend deployed)")
else:
    print(f"  {'metric':<8} {'users':>6} {'arrived-on':>11} {'switched-to':>12}")
    for r in metrics:
        print(f"  {r['m']:<8} {r['u']:>6} {r['arrivals'] or 0:>11} {r['toggles'] or 0:>12}")

# --- 3. unique users by country ---------------------------------------------
by_country = d1(
    "SELECT COALESCE(country,'??') AS c, COUNT(DISTINCT visitor) AS u "
    f"FROM hits WHERE {HUMAN} GROUP BY c ORDER BY u DESC LIMIT 20"
)
print()
print("=" * 60)
print("UNIQUE USERS BY COUNTRY  (humans only)")
print("=" * 60)
for r in by_country:
    print(f"  {r['u']:>5}  {r['c']}")
