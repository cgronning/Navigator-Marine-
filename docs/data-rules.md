# Data rules

1. **Provenance.** Every outside record stores its provider and fetch time (`place_sources`, `provider` columns).
2. **Verification levels.** `unverified` → `community_confirmed` → `business_confirmed` → `staff_verified`. The UI shows the level; contact details are only badged "verified" at the top two levels.
3. **Freshness.** AIS positions are labelled live (≤3 min), delayed (≤30 min) or stale. Stale is grey, never green.
4. **No interpolation in storage.** Raw positions only. Playback may draw estimated segments between reports, dashed and labelled "estimated".
5. **Licences.**
   - Google Places, Foursquare, Mapbox Search: not used to build the directory (storage prohibited).
   - OpenStreetMap (ODbL): kept in a separate layer (`places.is_osm_derived`); legal review pending.
   - Open-Meteo (CC BY 4.0) and NOAA: attribution shown in-app (`data_providers.attribution`).
   - NOAA charts: shown with "not for navigation / not certified" notice.
6. **Privacy.** Personal locations default to private. Sharing is per person or group, can be delayed, and expires.
7. **No invented content.** No sample businesses, vessels, listings or reviews in any environment users can see. Test data is clearly named `TEST ...` and lives only in test databases.
