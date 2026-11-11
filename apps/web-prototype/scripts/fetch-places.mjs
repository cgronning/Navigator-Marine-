// Downloads a snapshot of marine places for the launch region from OpenStreetMap
// (via Overpass) at build time. Real community data, labelled unverified in the app.
// If every server fails, writes an empty file with an error so the app falls back to live queries.
import { writeFileSync } from 'node:fs';

const BBOX = '40.40,-74.50,43.10,-69.80'; // NY Harbor / Long Island Sound to Cape Cod and the Islands
const query = `[out:json][timeout:180];(
  nwr["leisure"="marina"](${BBOX});
  nwr["waterway"="fuel"](${BBOX});
  nwr["amenity"="fuel"]["boat"="yes"](${BBOX});
  nwr["waterway"="sanitary_dump_station"](${BBOX});
  nwr["amenity"="sanitary_dump_station"]["boat"="yes"](${BBOX});
  nwr["seamark:type"="anchorage"](${BBOX});
  nwr["leisure"="slipway"](${BBOX});
);out center tags;`;

const endpoints = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];
const KEEP = /^(name|seamark:name|leisure|waterway|amenity|boat|seamark:type|phone|contact:phone|website|contact:website|vhf|seamark:radio_station:channel|opening_hours|capacity|addr:housenumber|addr:street|addr:city|fuel:.*)$/;

let data = null, lastErr = null;
for (const url of endpoints) {
  try {
    const res = await fetch(url, { method: 'POST', body: new URLSearchParams({ data: query }), headers: { 'User-Agent': 'NavigatorMarinePrototype/0.1 (github.com/cgronning/Navigator-Marine-)' }, signal: AbortSignal.timeout(90000) });
    if (!res.ok) throw new Error(`${url} HTTP ${res.status}`);
    data = await res.json();
    console.log(`Got ${data.elements.length} elements from ${url}`);
    break;
  } catch (e) { lastErr = e; console.warn(String(e)); }
}

// If every server failed, keep the copy that's already live on the site
if (!data) {
  try {
    const prev = await fetch('https://cgronning.github.io/Navigator-Marine-/places.json', { signal: AbortSignal.timeout(30000) }).then((r) => r.json());
    if (prev && Array.isArray(prev.elements) && prev.elements.length) {
      writeFileSync(new URL('../public/places.json', import.meta.url), JSON.stringify(prev));
      console.log(`Servers unavailable; kept previous snapshot from ${prev.fetchedAt} (${prev.elements.length} places)`);
      process.exit(0);
    }
  } catch (e) { console.warn('No previous snapshot available: ' + e); }
}

const out = { source: 'OpenStreetMap contributors (ODbL)', region: BBOX, fetchedAt: new Date().toISOString(), error: null, elements: [] };
if (!data) out.error = String(lastErr);
else {
  out.elements = data.elements.map((el) => {
    const tags = Object.fromEntries(Object.entries(el.tags ?? {}).filter(([k]) => KEEP.test(k)));
    return { type: el.type, id: el.id, lat: el.lat ?? el.center?.lat, lon: el.lon ?? el.center?.lon, tags };
  }).filter((e) => e.lat !== undefined);
}
writeFileSync(new URL('../public/places.json', import.meta.url), JSON.stringify(out));
console.log(`Wrote ${out.elements.length} places${out.error ? ' (ERROR: ' + out.error + ')' : ''}`);
