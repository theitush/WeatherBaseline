-- Unique-visitor logging for HowHotWasIt. One row per server-side hit, written by
-- the Worker (src/index.js → logHit). Adblock-proof: logged at the edge, not via
-- a client beacon. The visitor id is a STABLE pseudonymous hash of IP+UA+salt (no
-- raw IP is ever stored, no cookie), so COUNT(DISTINCT visitor) counts unique
-- people and returning users can be detected across days. No behaviour is
-- recorded — just which location was viewed, for per-location unique counts.
--
-- Apply (after `wrangler d1 create howhotwasit-analytics`):
--   npx wrangler d1 execute howhotwasit-analytics --remote --file=migrations/0001_create_hits.sql
CREATE TABLE IF NOT EXISTS hits (
  ts       INTEGER NOT NULL,  -- epoch ms       → per-day buckets, ordering
  visitor  TEXT    NOT NULL,  -- sha256(ip+ua+day+salt)[:16] → daily-unique, privacy-safe
  kind     TEXT    NOT NULL,  -- 'view' (a city load) | 'geo' (bare-root landing)
  page     TEXT,              -- /{lat},{lon}  → which location was viewed
  country  TEXT,              -- cf.country
  city     TEXT,              -- cf.city (approx)
  referer  TEXT,              -- acquisition source (host only)
  asn_org  TEXT,              -- cf.asOrganization  → datacenter = bot filter
  ua       TEXT               -- User-Agent  → device/browser + bot detection
);
CREATE INDEX IF NOT EXISTS hits_ts ON hits (ts);
CREATE INDEX IF NOT EXISTS hits_page ON hits (page);
CREATE INDEX IF NOT EXISTS hits_visitor ON hits (visitor);
