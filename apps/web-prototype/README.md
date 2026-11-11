# Web prototype

A quick, test-only web version of the Explore map, built to try the experience on a phone before the full apps.

Live, real data (no invented values):
- Base map: OpenStreetMap via CARTO · Navigation marks: OpenSeaMap
- Wind, waves, water temperature: Open-Meteo · Tides: NOAA
- Marinas, fuel, pump-out, anchorages, ramps: OpenStreetMap (unverified)
- Route planning: WGS84 math from packages/core (planning aid only)

Not connected yet: AIS vessels (needs a supplier).
These free services are fine for testing, not for a public launch (usage limits and commercial terms).

Run locally: `npm install && npm run dev`. Build: `npm run build` (output in dist/, works on GitHub Pages).
