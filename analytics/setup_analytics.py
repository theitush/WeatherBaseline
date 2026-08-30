#!/usr/bin/env python3
"""One-shot setup for the unique-visitor analytics.

You run this ONCE. It does the whole Cloudflare side for you:
  1. checks you're logged in to Cloudflare
  2. creates the D1 database (a little table Cloudflare hosts for you)
  3. wires it into the Worker's config (worker/wrangler.toml)
  4. creates the `hits` table
  5. deploys the Worker (uploads the new logging version so Cloudflare runs it)

    python3 analytics/setup_analytics.py

Safe to re-run — every step skips itself if it's already done. The only thing it
can't do for you is the browser login: if you're not logged in it stops and tells
you to run `npx wrangler login` (opens a browser, one click) and re-run this.

After it finishes, see your numbers any time on the private /dashboard page
(HTTP Basic auth, password = the Worker's DASHBOARD_TOKEN secret).
"""
import json
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
WORKER = os.path.join(ROOT, "worker")
TOML = os.path.join(WORKER, "wrangler.toml")
DB = "howhotwasit-analytics"


def run(cmd, parse=False):
    """Run a wrangler command in worker/. parse=True captures output for reading;
    otherwise it streams to your terminal (and pipes a 'y' to auto-confirm)."""
    if parse:
        return subprocess.run(cmd, cwd=WORKER, text=True, capture_output=True)
    return subprocess.run(cmd, cwd=WORKER, text=True, input="y\n")


def die(msg):
    print(f"\n✗ {msg}")
    sys.exit(1)


def find_db_id():
    """Look up the database_id of an already-created database by name."""
    lst = run(["npx", "wrangler", "d1", "list", "--json"], parse=True)
    s = lst.stdout.find("[")
    if s == -1:
        return None
    for db in json.loads(lst.stdout[s:]):
        if db.get("name") == DB:
            return db.get("uuid") or db.get("database_id")
    return None


# 0. logged in? ---------------------------------------------------------------
print("▶ Checking your Cloudflare login…")
who = run(["npx", "wrangler", "whoami"], parse=True)
blob = (who.stdout + who.stderr).lower()
if who.returncode != 0 or "not authenticated" in blob or "you are not" in blob:
    die("You're not logged in to Cloudflare yet. Run this once (it opens a browser):\n"
        "    cd worker && npx wrangler login\n  then re-run this script.")
print("✓ logged in")

# 1. create (or find) the database -------------------------------------------
print(f"\n▶ Creating the D1 database '{DB}'…")
create = run(["npx", "wrangler", "d1", "create", DB], parse=True)
out = create.stdout + create.stderr
m = re.search(r'database_id\s*=\s*"([0-9a-fA-F-]+)"', out)
dbid = m.group(1) if m else find_db_id()
if not dbid:
    die(f"Couldn't create or locate the database. wrangler said:\n{out}")
print(f"✓ database ready  (id {dbid})")

# 2. wire it into wrangler.toml ----------------------------------------------
print("\n▶ Wiring the database into worker/wrangler.toml…")
toml = open(TOML).read()
block = (
    "[[d1_databases]]\n"
    'binding = "DB"\n'
    f'database_name = "{DB}"\n'
    f'database_id = "{dbid}"\n'
)
if re.search(r"^\[\[d1_databases\]\]", toml, re.M):
    toml = re.sub(r'(database_id\s*=\s*)"[^"]*"', rf'\1"{dbid}"', toml)
else:
    commented = re.compile(
        r'#\s*\[\[d1_databases\]\][\s\S]*?#\s*database_id\s*=\s*"PASTE_DATABASE_ID_HERE"\n'
    )
    toml = commented.sub(block, toml) if commented.search(toml) else toml + "\n" + block
open(TOML, "w").write(toml)
print("✓ config updated")

# 3. create the table ---------------------------------------------------------
print("\n▶ Creating the `hits` table…")
mig = run(["npx", "wrangler", "d1", "execute", DB, "--remote",
           "--file=migrations/0001_create_hits.sql"])
if mig.returncode != 0:
    die("Table creation failed (scroll up for the error). You can retry just this step:\n"
        f"    cd worker && npx wrangler d1 execute {DB} --remote --file=migrations/0001_create_hits.sql")
print("✓ table ready")

# 4. deploy the Worker --------------------------------------------------------
print("\n▶ Deploying the Worker (uploading the logging version)… ~20s")
dep = run(["npx", "wrangler", "deploy"])
if dep.returncode != 0:
    die("Deploy failed (scroll up). You can retry just this step:\n"
        "    cd worker && npx wrangler deploy")

print("\n" + "=" * 60)
print("✅ Done — your site is now logging unique visitors.")
print("=" * 60)
print("It counts from now on (no backfill). See the numbers any time on the")
print("private /dashboard page (HTTP Basic auth = the DASHBOARD_TOKEN secret).")
print("The data lives in your own Cloudflare D1 database.")
