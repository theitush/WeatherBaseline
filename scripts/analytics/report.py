#!/usr/bin/env python3
"""Cloudflare zone analytics report. Reads creds from cloudflare.env (gitignored)."""
import json, os, urllib.request, collections, datetime

here = os.path.dirname(os.path.abspath(__file__))
env = {}
with open(os.path.join(here, "cloudflare.env")) as f:
    for line in f:
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            env[k] = v
TOKEN = env["CLOUDFLARE_ANALYTICS_TOKEN"]
ZONE = env["CLOUDFLARE_ZONE_ID"]
URL = "https://api.cloudflare.com/client/v4/graphql"


def gql(query):
    req = urllib.request.Request(
        URL,
        data=json.dumps({"query": query}).encode(),
        headers={"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req) as r:
        d = json.load(r)
    if d.get("errors"):
        raise RuntimeError(json.dumps(d["errors"], indent=2))
    return d["data"]


DAYS = ["2026-06-12", "2026-06-13", "2026-06-14", "2026-06-15", "2026-06-16"]

# --- Countries + unique IPs: aggregate the unsampled daily groups ---
# uniq{uniques} is Cloudflare's own zone-wide distinct-IP count per day. We store
# nothing — it's CF's standard aggregate, server-side (so adblock-proof) and not
# per-person tracking. It's the honest "roughly how many unique visitors" number,
# though it still counts bot IPs (compare against the RUM beacon below for humans).
q = f'''{{ viewer {{ zones(filter: {{zoneTag: "{ZONE}"}}) {{
  httpRequests1dGroups(limit: 31, filter: {{date_geq: "{DAYS[0]}", date_leq: "{DAYS[-1]}"}}) {{
    dimensions {{ date }}
    uniq {{ uniques }}
    sum {{ countryMap {{ clientCountryName requests }} }}
  }} }} }} }}'''
country = collections.Counter()
uniq_by_day = {}
for day in gql(q)["viewer"]["zones"][0]["httpRequests1dGroups"]:
    uniq_by_day[day["dimensions"]["date"]] = day["uniq"]["uniques"]
    for c in day["sum"]["countryMap"]:
        country[c["clientCountryName"]] += c["requests"]

print("=" * 52)
print("UNIQUE VISITORS  (Cloudflare zone-wide distinct IPs / day)")
print("=" * 52)
for d in sorted(uniq_by_day):
    print(f"  {d}: {uniq_by_day[d]:>6} unique IPs")
print("  (daily distinct IPs — not additive across days; includes bot IPs)")
print()

print("=" * 52)
print("TOP COUNTRIES  (requests, all 5 days, unsampled)")
print("=" * 52)
total_req = sum(country.values())
for name, reqs in country.most_common(20):
    print(f"{reqs:>8}  {reqs/total_req*100:5.1f}%  {name}")

# --- Paths: adaptive, per-day (1d max window), summed ---
path = collections.Counter()
status_path = collections.Counter()
for day in DAYS:
    nxt = (datetime.date.fromisoformat(day) + datetime.timedelta(days=1)).isoformat()
    q = f'''{{ viewer {{ zones(filter: {{zoneTag: "{ZONE}"}}) {{
      httpRequestsAdaptiveGroups(limit: 100,
        filter: {{datetime_geq: "{day}T00:00:00Z", datetime_lt: "{nxt}T00:00:00Z"}},
        orderBy: [count_DESC]) {{
        count dimensions {{ clientRequestPath edgeResponseStatus }} }} }} }} }}'''
    rows = gql(q)["viewer"]["zones"][0]["httpRequestsAdaptiveGroups"]
    for r in rows:
        p = r["dimensions"]["clientRequestPath"]
        path[p] += r["count"]

print()
print("=" * 52)
print("TOP URLs / PATHS  (sampled request count, all days)")
print("=" * 52)
total_p = sum(path.values())
for p, c in path.most_common(25):
    print(f"{c:>8}  {c/total_p*100:5.1f}%  {p}")

# --- "Real users": RUM beacon (/cdn-cgi/rum) only fires from real JS browsers ---
rum_country = collections.Counter()
rum_by_day = {}
for day in DAYS:
    nxt = (datetime.date.fromisoformat(day) + datetime.timedelta(days=1)).isoformat()
    q = f'''{{ viewer {{ zones(filter: {{zoneTag: "{ZONE}"}}) {{
      httpRequestsAdaptiveGroups(limit: 100,
        filter: {{datetime_geq: "{day}T00:00:00Z", datetime_lt: "{nxt}T00:00:00Z",
                  clientRequestPath: "/cdn-cgi/rum"}},
        orderBy: [count_DESC]) {{
        count dimensions {{ clientCountryName }} }} }} }} }}'''
    rows = gql(q)["viewer"]["zones"][0]["httpRequestsAdaptiveGroups"]
    rum_by_day[day] = sum(r["count"] for r in rows)
    for r in rows:
        rum_country[r["dimensions"]["clientCountryName"]] += r["count"]

print()
print("=" * 52)
print("REAL USERS  (Web Analytics beacon hits = real browsers)")
print("=" * 52)
print("Per day:")
for day in DAYS:
    print(f"  {day}: {rum_by_day[day]:>5} page loads")
print(f"  TOTAL: {sum(rum_by_day.values())} real-browser page loads")
print()
print("Real users by country:")
total_r = sum(rum_country.values()) or 1
for name, c in rum_country.most_common(15):
    print(f"{c:>6}  {c/total_r*100:5.1f}%  {name}")
