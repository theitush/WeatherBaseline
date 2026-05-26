/**
 * GeoNames search API client.
 *
 * GeoNames (https://www.geonames.org/) requires a free registered username,
 * and that account must have web-services enabled (do it on the account page
 * after confirming the email). Put the username below or in VITE_GEONAMES_USER.
 *
 * Endpoint docs: https://www.geonames.org/export/geonames-search.html
 */

// Set your registered GeoNames username here, or via a .env: VITE_GEONAMES_USER=...
export const GEONAMES_USER: string =
  (import.meta.env.VITE_GEONAMES_USER as string | undefined) ?? 'itush';

export interface GeoNamesPlace {
  geonameId: number;
  name: string;
  /** Higher-level admin name, e.g. region/state. */
  adminName1?: string;
  countryName?: string;
  /** Feature class+code, e.g. "P" / "PPL" for a populated place. */
  fcode?: string;
  fcodeName?: string;
  population?: number;
  lat: number;
  lng: number;
}

interface RawGeoNamesPlace {
  geonameId: number;
  name: string;
  adminName1?: string;
  countryName?: string;
  fcode?: string;
  fcodeName?: string;
  population?: number;
  lat: string;
  lng: string;
}

interface SearchResponse {
  geonames?: RawGeoNamesPlace[];
  status?: { message: string; value: number };
}

/**
 * Search GeoNames for places matching `query`. Returns up to `maxRows`
 * populated places, ordered by GeoNames relevance.
 */
export async function searchGeoNames(
  query: string,
  maxRows = 10,
): Promise<GeoNamesPlace[]> {
  const params = new URLSearchParams({
    q: query,
    maxRows: String(maxRows),
    featureClass: 'P', // populated places only — matches our city use case
    orderby: 'relevance',
    style: 'MEDIUM', // include population + admin names
    username: GEONAMES_USER,
  });

  const url = `https://secure.geonames.org/searchJSON?${params}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`GeoNames HTTP ${res.status}`);
  }
  const data: SearchResponse = await res.json();

  // GeoNames returns HTTP 200 even for auth/quota errors — the failure is
  // carried in a `status` object instead.
  if (data.status) {
    throw new Error(`GeoNames: ${data.status.message}`);
  }

  return (data.geonames ?? []).map((p) => ({
    geonameId: p.geonameId,
    name: p.name,
    adminName1: p.adminName1,
    countryName: p.countryName,
    fcode: p.fcode,
    fcodeName: p.fcodeName,
    population: p.population,
    lat: parseFloat(p.lat),
    lng: parseFloat(p.lng),
  }));
}
