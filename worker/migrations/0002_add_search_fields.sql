-- Search-intent logging: what someone typed into the city search, which place
-- the geocoder matched it to, which of our curated cells we actually served,
-- and how far apart those two points are. Lets the owner see queries that snap
-- a long way from anything we serve (missing coverage) or never match at all.
--
-- Apply:
--   npx wrangler d1 execute howhotwasit-analytics --remote --file=migrations/0002_add_search_fields.sql
ALTER TABLE hits ADD COLUMN query   TEXT; -- raw text typed into the search box (kind='search')
ALTER TABLE hits ADD COLUMN matched TEXT; -- geocoder place name the query matched
ALTER TABLE hits ADD COLUMN served  TEXT; -- our curated cell's name — what we actually served
ALTER TABLE hits ADD COLUMN dist_km REAL; -- great-circle km between matched place and served cell
