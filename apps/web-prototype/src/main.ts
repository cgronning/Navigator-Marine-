import maplibregl, { type GeoJSONSource, type MapMouseEvent } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import './styles.css';
import { inverse, METRES_PER_NM, etaHours } from '../../../packages/core/src/geo/nav.ts';
import {
  fetchConditions, nearestTideStation, tidePredictions, fetchPlaces, placesSnapshot,
  KIND_LABEL, type Place, type PlaceKind, type LatLon, type HourRow,
} from './data.ts';
import { rocksInView, depthAt, WATLEV_LABEL, type Rock } from './enc.ts';
import { WindLayer, fetchWindGrid, speedColor, LEGEND_STOPS } from './wind.ts';
import { BoatTracker } from './boat.ts';
import { coastalRoute, RouteError } from './router-coastal.ts';
import { passageRoute } from './router-weather.ts';
import { fetchCurrentGrid, currentColor, CURRENT_LEGEND, nearestCurrent } from './currents.ts';

// ------------------------------------------------------------------ helpers
const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector(sel) as T;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const fmt = (v: number | null | undefined, d = 0) => (v === null || v === undefined || Number.isNaN(v) ? '—' : v.toFixed(d));
const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
const compass = (deg: number | null) => (deg === null ? '—' : COMPASS.at(Math.round(deg / 22.5) % 16)!);
const store = {
  get<T>(k: string): T | null { try { const v = localStorage.getItem(k); return v ? (JSON.parse(v) as T) : null; } catch { return null; } },
  set(k: string, v: unknown) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};

const KIND_COLOR: Record<PlaceKind, string> = { marina: '#1F7A8C', fuel: '#E0A100', pumpout: '#6B5CA5', anchorage: '#1E8E5A', ramp: '#C8322B' };

// ------------------------------------------------------------------ map
// Modern vector base map (OpenFreeMap, no key) restyled in Navigator colors,
// with NOAA's official electronic chart (ENC) drawn on top: soundings, depth
// contours, rocks, wrecks, buoys, lights, channels, restricted areas.
const BASE_STYLE = 'https://tiles.openfreemap.org/styles/positron';
const NOAA_CHART_WMS = 'https://gis.charttools.noaa.gov/arcgis/rest/services/MCS/NOAAChartDisplay/MapServer/exts/MaritimeChartService/WMSServer'
  + '?SERVICE=WMS&VERSION=1.3.0&REQUEST=GetMap&LAYERS=0,1,2,3,4,5,6,7&STYLES=&CRS=EPSG:3857'
  + '&BBOX={bbox-epsg-3857}&WIDTH=512&HEIGHT=512&FORMAT=image/png&TRANSPARENT=TRUE';


const saved = store.get<{ center: [number, number]; zoom: number }>('nav.view');
function fatal(msg: string) {
  const d = document.createElement('div'); d.className = 'status error'; d.textContent = msg; document.body.appendChild(d);
}
if (!document.createElement('canvas').getContext('webgl2') && !document.createElement('canvas').getContext('webgl')) {
  fatal('This browser can’t draw the map (WebGL is off). Try opening the link in Safari or Chrome.');
}
const map = new maplibregl.Map({
  container: 'map',
  style: BASE_STYLE,
  center: saved?.center ?? [-71.33, 41.47], // Newport / Narragansett Bay
  zoom: saved?.zoom ?? 12,
  attributionControl: false,
  maxPitch: 0,
  dragRotate: false,
  fadeDuration: 150,
});
map.touchZoomRotate.disableRotation();
(window as unknown as { __navMap: unknown }).__navMap = map;
(window as unknown as { __navDebug: unknown }).__navDebug = { coastalRoute: (a: LatLon, b: LatLon, o: Parameters<typeof coastalRoute>[2]) => coastalRoute(a, b, o, (m) => console.log('[route]', m)) };

function restyleBase() {
  for (const l of map.getStyle().layers ?? []) {
    try {
      if (l.type === 'background') map.setPaintProperty(l.id, 'background-color', '#F4F0E6');
      else if (l.type === 'fill' && /water|ocean|sea/.test(l.id)) map.setPaintProperty(l.id, 'fill-color', '#CFE2EA');
      else if (l.type === 'line' && /waterway|river/.test(l.id)) map.setPaintProperty(l.id, 'line-color', '#AFCFDC');
      else if (l.type === 'fill' && /park|wood|grass|landcover/.test(l.id)) map.setPaintProperty(l.id, 'fill-color', '#E9E8D8');
      else if (l.type === 'symbol' && /water|ocean|sea|bay|marine/.test(l.id)) map.setPaintProperty(l.id, 'text-color', '#3A6F86');
    } catch { /* layer without that property */ }
  }
}

// ------------------------------------------------------------------ map health: show problems instead of a silent blank map
let chartErrors = 0;
let baseLoaded = false;
map.on('error', (e) => {
  const msg = (e as { error?: Error }).error?.message ?? 'unknown error';
  const srcId = (e as { sourceId?: string }).sourceId;
  if (srcId === 'seamarks') return; // optional overlay
  if (srcId === 'chart') {
    chartErrors++;
    if (chartErrors === 6) setStatus('NOAA chart service is slow right now; some chart areas may be missing.', true);
    return;
  }
  setStatus(`Map problem: ${msg}`, true);
});
map.on('sourcedata', (e) => { if (e.isSourceLoaded && e.sourceId !== 'places' && e.sourceId !== 'route') baseLoaded = true; });
map.on('webglcontextlost', () => setStatus('The map display was interrupted. Reload the page.', true));
window.setTimeout(() => { if (!baseLoaded) setStatus('The map hasn’t loaded yet. Check your connection or reload.', true); }, 12000);

map.addControl(new maplibregl.AttributionControl({ compact: true, customAttribution: 'Chart: NOAA ENC® (not for navigation) · Weather: <a href="https://open-meteo.com">Open-Meteo</a> · Tides: NOAA' }), 'bottom-left');
if (window.matchMedia('(pointer: fine)').matches) map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');
map.addControl(new maplibregl.ScaleControl({ unit: 'nautical' }), 'bottom-right');


// ------------------------------------------------------------------ search (OpenStreetMap Nominatim + loaded places)
const searchInput = $('#search') as HTMLInputElement;
const searchResults = $('#search-results');
let searchTimer: number | undefined;
let searchSeq = 0;
async function runSearch(q: string) {
  const seq = ++searchSeq;
  if (q.trim().length < 3) { searchResults.hidden = true; return; }
  const ql = q.toLowerCase();
  const local = places.filter((p) => p.name.toLowerCase().includes(ql)).slice(0, 4)
    .map((p) => ({ label: p.name, sub: KIND_LABEL[p.kind], lat: p.lat, lon: p.lon, place: p as Place | null }));
  let remote: { label: string; sub: string; lat: number; lon: number; place: Place | null }[] = [];
  try {
    const c = map.getCenter();
    const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&q=${encodeURIComponent(q)}&viewbox=${c.lng - 3},${c.lat + 2},${c.lng + 3},${c.lat - 2}`;
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    const rows = (await res.json()) as { display_name: string; lat: string; lon: string; type: string }[];
    remote = rows.map((r) => ({ label: r.display_name.split(',')[0] ?? r.display_name, sub: r.display_name.split(',').slice(1, 3).join(',').trim(), lat: Number(r.lat), lon: Number(r.lon), place: null }));
  } catch { /* show local results only */ }
  if (seq !== searchSeq) return;
  const all = [...local, ...remote];
  searchResults.innerHTML = all.length
    ? all.map((r, i) => `<button class="result" data-i="${i}"><b>${esc(r.label)}</b><small>${esc(r.sub)}</small></button>`).join('')
    : `<p class="fine pad">No results.</p>`;
  searchResults.hidden = false;
  searchResults.querySelectorAll<HTMLButtonElement>('.result').forEach((b) => b.addEventListener('click', () => {
    const r = all.at(Number(b.dataset.i)); if (!r) return;
    searchResults.hidden = true; searchInput.blur();
    setTab('explore');
    map.flyTo({ center: [r.lon, r.lat], zoom: Math.max(map.getZoom(), 13), speed: 1.4 });
    if (r.place) showPlace(r.place);
  }));
}
searchInput.addEventListener('input', () => { window.clearTimeout(searchTimer); searchTimer = window.setTimeout(() => runSearch(searchInput.value), 450); });
($('#search-form') as HTMLFormElement).addEventListener('submit', (e) => { e.preventDefault(); runSearch(searchInput.value); });
searchInput.addEventListener('focus', () => { if (searchResults.innerHTML && searchInput.value.length >= 3) searchResults.hidden = false; });
map.on('movestart', () => { searchResults.hidden = true; });

// ------------------------------------------------------------------ state
type Tab = 'explore' | 'navigate' | 'vessels' | 'services' | 'boat';
let tab: Tab = 'explore';
const enabledKinds = new Set<PlaceKind>(['marina', 'fuel']);
let places: Place[] = [];
let route: LatLon[] = store.get<LatLon[]>('nav.route') ?? [];
let svcFilter: PlaceKind | 'all' = 'all';
let tapMarker: maplibregl.Marker | null = null;

// ------------------------------------------------------------------ sheets
function openSheet(id: string) {
  document.querySelectorAll<HTMLElement>('.sheet').forEach((s) => { s.hidden = s.id !== id; });
  $('#hint').hidden = true;
}
function closeSheet(id: string) { $(`#${id}`).hidden = true; if (id === 'sheet-detail') { tapMarker?.remove(); tapMarker = null; } }
document.querySelectorAll<HTMLButtonElement>('[data-close]').forEach((b) => b.addEventListener('click', () => closeSheet(b.dataset.close!)));
$('#btn-layers').addEventListener('click', () => { const s = $('#sheet-layers'); if (s.hidden) openSheet('sheet-layers'); else s.hidden = true; });

// ------------------------------------------------------------------ tabs
function setTab(t: Tab) {
  tab = t;
  document.querySelectorAll<HTMLButtonElement>('.tabbar button').forEach((b) => b.classList.toggle('active', b.dataset.tab === t));
  document.querySelectorAll<HTMLElement>('.panel').forEach((p) => { p.hidden = p.id !== `panel-${t}`; });
  closeSheet('sheet-layers'); closeSheet('sheet-detail');
  $('#hint').hidden = !(t === 'explore' || t === 'navigate');
  $('#hint').textContent = t === 'navigate' ? 'Tap the map to add waypoints' : 'Tap the water for conditions';
  document.body.dataset.tab = t;
  if (t === 'services') renderServices();
  if (t === 'navigate') { renderRoute(); setRMode(rmode); }
  else drawEnds();
  const manualVisible = t === 'navigate' && rmode === 'manual';
  if (map.getLayer('route-line')) { map.setLayoutProperty('route-line', 'visibility', manualVisible ? 'visible' : 'none'); map.setLayoutProperty('route-pts', 'visibility', manualVisible ? 'visible' : 'none'); }
  setTimeout(() => map.resize(), 0);
}
document.querySelectorAll<HTMLButtonElement>('.tabbar button').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab as Tab)));

// ------------------------------------------------------------------ layers
document.querySelectorAll<HTMLInputElement>('[data-layer]').forEach((cb) => {
  const key = cb.dataset.layer!;
  cb.addEventListener('change', () => {
    if (key === 'seamarks') { map.setLayoutProperty('seamarks', 'visibility', cb.checked ? 'visible' : 'none'); return; }
    if (key === 'wind') { setWind(cb.checked); return; }
    if (key === 'currents') { setCurrents(cb.checked); return; }
    if (key === 'rocks') { setRocks(cb.checked); return; }
    const k = key as PlaceKind;
    if (cb.checked) enabledKinds.add(k); else enabledKinds.delete(k);
    loadPlaces(true);
  });
});

// ------------------------------------------------------------------ places
const placeCache = new Map<string, Place[]>();
let placeTimer: number | undefined;
let placeReq = 0;
const MIN_PLACE_ZOOM = 10;
const SNAP = { s: 40.4, w: -74.5, n: 43.1, e: -69.8 }; // must match scripts/fetch-places.mjs

function setPlacesData() {
  const src = map.getSource('places') as GeoJSONSource | undefined;
  if (!src) return;
  src.setData({
    type: 'FeatureCollection',
    features: places.filter((p) => enabledKinds.has(p.kind)).map((p) => ({
      type: 'Feature', id: undefined, properties: { id: p.id, kind: p.kind, color: KIND_COLOR[p.kind] },
      geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
    })),
  });
}

function loadPlaces(immediate = false) {
  window.clearTimeout(placeTimer);
  placeTimer = window.setTimeout(async () => {
    if (map.getZoom() < MIN_PLACE_ZOOM || enabledKinds.size === 0) { places = []; setPlacesData(); if (tab === 'services') renderServices(); return; }
    const b = map.getBounds();
    // snap to a 0.1° grid so small pans reuse the cache
    const snap = (v: number, up: boolean) => (up ? Math.ceil(v * 10) : Math.floor(v * 10)) / 10;
    const box = { s: snap(b.getSouth(), false), w: snap(b.getWest(), false), n: snap(b.getNorth(), true), e: snap(b.getEast(), true) };
    const kinds = [...enabledKinds].sort();
    const key = `${box.s},${box.w},${box.n},${box.e}|${kinds.join(',')}`;
    const req = ++placeReq;
    try {
      let result = placeCache.get(key);
      if (!result) {
        const snap = await placesSnapshot();
        const inSnap = snap && SNAP.s <= box.s && SNAP.w <= box.w && SNAP.n >= box.n && SNAP.e >= box.e;
        if (snap && (inSnap || !navigator.onLine)) {
          result = snap.places.filter((p) => kinds.includes(p.kind) && p.lat >= box.s && p.lat <= box.n && p.lon >= box.w && p.lon <= box.e);
        } else {
          setStatus('Loading places…');
          result = await fetchPlaces(box, kinds);
        }
        placeCache.set(key, result);
      }
      if (req !== placeReq) return;
      places = result;
      setStatus('');
      setPlacesData();
      if (tab === 'services') renderServices();
    } catch {
      if (req === placeReq) setStatus('Couldn’t load places (OpenStreetMap busy). Pan to retry.', true);
    }
  }, immediate ? 0 : 600);
}

let statusEl: HTMLDivElement | null = null;
function setStatus(msg: string, isError = false) {
  if (!statusEl) { statusEl = document.createElement('div'); statusEl.className = 'status'; document.body.appendChild(statusEl); }
  statusEl.textContent = msg;
  statusEl.classList.toggle('error', isError);
  statusEl.hidden = !msg;
}

// ------------------------------------------------------------------ map layers on load
map.once('style.load', () => {
  restyleBase();
  map.addSource('chart', { type: 'raster', tiles: [NOAA_CHART_WMS], tileSize: 256, minzoom: 6, maxzoom: 19, attribution: 'Chart: NOAA ENC®' });
  map.addLayer({ id: 'chart', type: 'raster', source: 'chart', minzoom: 7, paint: { 'raster-fade-duration': 150 }, layout: { visibility: 'visible' } });
  map.addSource('seamarks', { type: 'raster', tiles: ['https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png'], tileSize: 256, minzoom: 6, maxzoom: 18, attribution: 'Marks © OpenSeaMap' });
  map.addLayer({ id: 'seamarks', type: 'raster', source: 'seamarks', layout: { visibility: 'none' } });
  map.addSource('places', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addLayer({
    id: 'places', type: 'circle', source: 'places',
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 5, 15, 9],
      'circle-color': ['get', 'color'],
      'circle-stroke-color': '#FFFFFF', 'circle-stroke-width': 2,
    },
  });
  map.addSource('rocks', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addLayer({
    id: 'rocks', type: 'circle', source: 'rocks', layout: { visibility: 'none' },
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 11, 3, 14, 5.5, 17, 8],
      'circle-color': '#F26B1D', 'circle-stroke-color': '#FFFFFF', 'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 11, 0.5, 15, 1.5],
    },
  }, 'places');
  map.addSource('course', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addLayer({ id: 'course', type: 'line', source: 'course', layout: { 'line-cap': 'round' }, paint: { 'line-color': '#0B1F3F', 'line-width': 3 } });
  map.addSource('autoroute', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addLayer({ id: 'autoroute-casing', type: 'line', source: 'autoroute', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#FFFFFF', 'line-width': 7, 'line-opacity': 0.9 } });
  map.addLayer({ id: 'autoroute', type: 'line', source: 'autoroute', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': ['get', 'color'], 'line-width': 4 } });
  map.addSource('ends', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addLayer({ id: 'ends', type: 'circle', source: 'ends', paint: { 'circle-radius': 9, 'circle-color': ['match', ['get', 'role'], 'start', '#1E8E5A', '#C8322B'], 'circle-stroke-color': '#FFFFFF', 'circle-stroke-width': 3 } });
  map.addSource('route', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addLayer({ id: 'route-line', type: 'line', source: 'route', filter: ['==', '$type', 'LineString'], paint: { 'line-color': '#0B1F3F', 'line-width': 3, 'line-dasharray': [2, 1.5] } });
  map.addLayer({ id: 'route-pts', type: 'circle', source: 'route', filter: ['==', '$type', 'Point'], paint: { 'circle-radius': 7, 'circle-color': '#FBF8F1', 'circle-stroke-color': '#0B1F3F', 'circle-stroke-width': 3 } });
  drawRoute();
  loadPlaces(true);
});
map.once('idle', () => { document.querySelector('.maplibregl-ctrl-attrib')?.classList.remove('maplibregl-compact-show'); });
map.once('dragstart', () => { $('#hint').hidden = true; });
map.on('moveend', () => {
  const c = map.getCenter();
  store.set('nav.view', { center: [c.lng, c.lat], zoom: map.getZoom() });
  loadPlaces();
});
map.on('mouseenter', 'places', () => { map.getCanvas().style.cursor = 'pointer'; });
map.on('mouseleave', 'places', () => { map.getCanvas().style.cursor = ''; });

map.on('click', (e: MapMouseEvent) => {
  const rockHit = map.getLayer('rocks') && rocksOn ? map.queryRenderedFeatures([[e.point.x - 10, e.point.y - 10], [e.point.x + 10, e.point.y + 10]], { layers: ['rocks'] }).at(0) : undefined;
  if (rockHit && tab !== 'navigate') { const r = rocks.find((x) => x.id === rockHit.properties?.['id']); if (r) { showRock(r); return; } }
  const hits = map.queryRenderedFeatures(e.point, { layers: ['places'] });
  const first = hits.at(0);
  if (first && tab !== 'navigate') {
    const p = places.find((x) => x.id === first.properties?.['id']);
    if (p) { showPlace(p); return; }
  }
  const pt = { lat: e.lngLat.lat, lon: e.lngLat.lng };
  if (tab === 'navigate') {
    if (rmode === 'manual') { route.push(pt); store.set('nav.route', route); drawRoute(); renderRoute(); }
    else addEnd(pt);
    return;
  }
  if (tab === 'explore') showConditions(pt);
});

// ------------------------------------------------------------------ conditions sheet
async function showConditions(p: LatLon) {
  tapMarker?.remove();
  const el = document.createElement('div'); el.className = 'tap-pin';
  tapMarker = new maplibregl.Marker({ element: el }).setLngLat([p.lon, p.lat]).addTo(map);
  const coord = `${Math.abs(p.lat).toFixed(3)}°${p.lat >= 0 ? 'N' : 'S'}  ${Math.abs(p.lon).toFixed(3)}°${p.lon >= 0 ? 'E' : 'W'}`;
  $('#detail-title').textContent = 'Conditions here';
  $('#detail-body').innerHTML = `<p class="coord">${coord}</p><div class="loading">Loading live forecast…</div>`;
  openSheet('sheet-detail');

  let depthDone = false;
  depthAt(p).then((d) => {
    depthDone = true;
    const el = document.getElementById('depth-block'); if (!el) return;
    if (d.onLand) { el.innerHTML = `<div class="depth-main"><small>Charted depth</small><b>No chart depth here</b><span class="fine">Land, or outside NOAA chart coverage</span></div>`; return; }
    const range = d.areaMinFt !== null && d.areaMaxFt !== null ? `${Math.round(d.areaMinFt)}–${Math.round(d.areaMaxFt)} ft` : null;
    const shallow = (d.areaMinFt ?? 99) < 6;
    el.innerHTML = `<div class="depth-main ${shallow ? 'shallow' : ''}"><small>Charted depth</small><b>${range ?? (d.sounding ? `${d.sounding.ft.toFixed(0)} ft` : '—')}</b>
      ${d.sounding ? `<span>Nearest sounding <b>${d.sounding.ft.toFixed(0)} ft</b>, ${Math.round(d.sounding.distYd)} yd away</span>` : ''}</div>
      <p class="src">NOAA chart (${esc(d.scale ?? '')} scale), depths below mean lower low water. Actual depth varies with tide. Not for navigation.</p>`;
  }).catch(() => { depthDone = true; const el = document.getElementById('depth-block'); if (el) el.innerHTML = `<p class="err">Couldn’t load chart depth right now.</p>`; });

  const body = $('#detail-body');
  let html = `<p class="coord">${coord}</p><div id="depth-block" class="depth"><div class="loading">Checking charted depth…</div></div>`;
  try {
    const c = await fetchConditions(p);
    const nowIdx = Math.max(0, c.hours.findIndex((h) => Date.parse(h.time) >= Date.now() - 30 * 60e3));
    const now = c.hours.at(nowIdx)!;
    html += `<div class="now">
      <div class="big"><div class="arrow" style="--r:${(now.windDir ?? 0) + 180}deg" aria-hidden="true">↑</div>
        <div><div class="val">${fmt(now.windKn)}<span>kn</span></div><div class="sub">${compass(now.windDir)} wind · gusts ${fmt(now.gustKn)} kn</div></div></div>
      <div class="stats">
        ${c.marineAvailable ? `<div><b>${fmt(now.waveFt, 1)} ft</b><small>Waves${now.wavePeriod ? ` · ${fmt(now.wavePeriod)}s` : ''}</small></div>
        <div><b>${fmt(now.swellFt, 1)} ft</b><small>Swell ${compass(now.waveDir)}</small></div>
        <div><b>${fmt(now.waterF)}°F</b><small>Water</small></div>` : `<div class="wide"><small>No wave data at this spot (inland or sheltered water)</small></div>`}
        <div><b>${fmt(now.airF)}°F</b><small>Air</small></div>
      </div></div>`;
    html += renderHourly(c.hours.slice(nowIdx, nowIdx + 24));
    html += `<p class="src">Forecast model data from Open-Meteo, updated hourly. Times are local to the point.</p>`;
  } catch {
    html += `<p class="err">Couldn’t load the forecast right now. Check your connection and tap again.</p>`;
  }
  const depthHtml = document.getElementById('depth-block')?.outerHTML;
  body.innerHTML = html + `<div id="tides"><div class="loading">Finding nearest NOAA tide station…</div></div><div id="tcurrents"></div>`;
  nearestCurrent(p).then((c) => {
    const el = document.getElementById('tcurrents'); if (!el || !c) return;
    const up = c.events.filter((x) => Date.parse(x.time.replace(' ', 'T')) >= Date.now() - 30 * 60e3).slice(0, 4);
    el.innerHTML = `<h3>Tidal current · ${esc(c.station.name)} <small>${c.distNm.toFixed(1)} nm away</small></h3>
      <div class="tides">${up.map((x) => `<div class="tide cur-${x.type}"><small>${x.type === 'slack' ? 'Slack' : x.type === 'flood' ? 'Max flood' : 'Max ebb'}</small><b>${new Date(x.time.replace(' ', 'T')).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</b><small>${x.type === 'slack' ? '&nbsp;' : `${x.speedKn.toFixed(1)} kn${x.dirDeg !== null ? ` → ${Math.round(x.dirDeg)}°` : ''}`}</small></div>`).join('')}</div>
      <p class="src">NOAA tidal current predictions (station ${esc(c.station.id)}).</p>`;
  }).catch(() => { /* no station nearby or service down: show nothing */ });
  if (depthHtml && depthDone) { const el = document.getElementById('depth-block'); if (el) el.outerHTML = depthHtml; }

  const tidesEl = $('#tides');
  try {
    const near = await nearestTideStation(p);
    if (!near) { tidesEl.innerHTML = `<p class="fine">No NOAA tide station within 25 nm.</p>`; return; }
    const ev = await tidePredictions(near.station.id);
    const upcoming = ev.sort((a, b) => a.time.localeCompare(b.time)).filter((x) => Date.parse(x.time.replace(' ', 'T')) >= Date.now() - 60 * 60e3).slice(0, 4);
    tidesEl.innerHTML = `<h3>Tides · ${esc(near.station.name)}${near.station.state ? `, ${esc(near.station.state)}` : ''} <small>${near.distNm.toFixed(1)} nm away</small></h3>
      <div class="tides">${upcoming.map((x) => `<div class="tide ${x.type.toLowerCase()}"><small>${x.type}</small><b>${new Date(x.time.replace(' ', 'T')).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</b><small>${new Date(x.time.replace(' ', 'T')).toLocaleDateString([], { weekday: 'short' })} · ${x.heightFt.toFixed(1)} ft</small></div>`).join('')}</div>
      <p class="src">NOAA tide predictions (station ${esc(near.station.id)}, MLLW datum, station local time).</p>`;
  } catch {
    tidesEl.innerHTML = `<p class="err">Couldn’t load NOAA tides right now.</p>`;
  }
}

function renderHourly(rows: HourRow[]): string {
  const every3 = rows.filter((_, i) => i % 3 === 0).slice(0, 8);
  return `<div class="hourly" role="table" aria-label="Next 24 hours">${every3.map((h) => `
    <div class="h" role="row"><small>${new Date(h.time).toLocaleTimeString([], { hour: 'numeric' })}</small>
      <div class="arrow sm" style="--r:${(h.windDir ?? 0) + 180}deg" aria-hidden="true">↑</div>
      <b>${fmt(h.windKn)}</b><small>g${fmt(h.gustKn)}</small>
      <small class="w">${h.waveFt === null ? '' : `${fmt(h.waveFt, 1)}′`}</small></div>`).join('')}</div>`;
}

// ------------------------------------------------------------------ place sheet
function showPlace(p: Place) {
  const t = p.tags;
  const lines: string[] = [];
  const addr = [t['addr:housenumber'], t['addr:street'], t['addr:city']].filter(Boolean).join(' ');
  if (addr) lines.push(`<div class="kv"><small>Address</small><span>${esc(addr)}</span></div>`);
  const phone = t['phone'] ?? t['contact:phone'];
  if (phone) lines.push(`<div class="kv"><small>Phone</small><span>${esc(phone)}</span></div>`);
  const web = t['website'] ?? t['contact:website'];
  if (web && /^https?:\/\//.test(web)) lines.push(`<div class="kv"><small>Website</small><a href="${esc(web)}" target="_blank" rel="noopener">${esc(web.replace(/^https?:\/\//, ''))}</a></div>`);
  if (t['seamark:radio_station:channel'] || t['vhf']) lines.push(`<div class="kv"><small>VHF</small><span>${esc(t['vhf'] ?? t['seamark:radio_station:channel'] ?? '')}</span></div>`);
  if (t['opening_hours']) lines.push(`<div class="kv"><small>Hours</small><span>${esc(t['opening_hours'])}</span></div>`);
  const fuels = Object.keys(t).filter((k) => k.startsWith('fuel:') && t[k] === 'yes').map((k) => k.slice(5));
  if (fuels.length) lines.push(`<div class="kv"><small>Fuel</small><span>${esc(fuels.join(', '))}</span></div>`);
  if (t['capacity']) lines.push(`<div class="kv"><small>Berths</small><span>${esc(t['capacity'])}</span></div>`);
  $('#detail-title').textContent = p.name;
  $('#detail-body').innerHTML = `
    <div class="pill-row"><span class="pill" style="--c:${KIND_COLOR[p.kind]}">${KIND_LABEL[p.kind]}</span><span class="badge">Unverified</span></div>
    ${lines.join('') || '<p class="fine">No further details in OpenStreetMap yet.</p>'}
    <div class="row"><button class="btn ghost" id="place-wx">Conditions here</button></div>
    <p class="src">Community data from <a href="https://www.openstreetmap.org/${esc(p.id)}" target="_blank" rel="noopener">OpenStreetMap</a>. Not verified by Navigator or the business. Call ahead.</p>`;
  $('#place-wx').addEventListener('click', () => showConditions({ lat: p.lat, lon: p.lon }));
  openSheet('sheet-detail');
}

// ------------------------------------------------------------------ route planning (real WGS84 math)
function drawRoute() {
  const src = map.getSource('route') as GeoJSONSource | undefined;
  if (!src) return;
  const features: GeoJSON.Feature[] = route.map((p, i) => ({ type: 'Feature', properties: { i }, geometry: { type: 'Point', coordinates: [p.lon, p.lat] } }));
  if (route.length > 1) features.push({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: route.map((p) => [p.lon, p.lat]) } });
  src.setData({ type: 'FeatureCollection', features });
}

function renderRoute() {
  const el = $('#route-summary');
  if (route.length < 2) { el.innerHTML = `<p class="fine">${route.length === 0 ? 'No waypoints yet.' : 'Add one more waypoint.'}</p>`; return; }
  const speed = Number(($('#route-speed') as HTMLInputElement).value);
  let total = 0;
  const legs = route.slice(1).map((p, i) => {
    const r = inverse(route.at(i)!, p);
    const nm = r.distanceM / METRES_PER_NM;
    total += nm;
    return `<tr><td>${i + 1}→${i + 2}</td><td>${nm.toFixed(2)} nm</td><td>${Math.round(r.initialBearingDeg).toString().padStart(3, '0')}° T</td></tr>`;
  }).join('');
  let eta = '—';
  try { const h = etaHours(total, speed); eta = `${Math.floor(h)} h ${Math.round((h % 1) * 60)} min`; } catch { /* invalid speed */ }
  el.innerHTML = `<div class="totals"><div><b>${total.toFixed(1)} nm</b><small>Total</small></div><div><b>${eta}</b><small>at ${fmt(speed, 1)} kn</small></div><div><b>${route.length}</b><small>Waypoints</small></div></div>
    <table class="legs"><thead><tr><th>Leg</th><th>Distance</th><th>Bearing</th></tr></thead><tbody>${legs}</tbody></table>
    <p class="fine">Straight-line (great-circle) distances on the WGS84 ellipsoid. Bearings are true, not magnetic. Does not account for land, depth, current or hazards.</p>`;
}
$('#route-speed').addEventListener('input', renderRoute);
$('#route-undo').addEventListener('click', () => { route.pop(); store.set('nav.route', route); drawRoute(); renderRoute(); });
$('#route-clear').addEventListener('click', () => { route = []; store.set('nav.route', route); drawRoute(); renderRoute(); });

// ------------------------------------------------------------------ services list
function renderServices() {
  const chips = $('#svc-chips');
  const kinds: (PlaceKind | 'all')[] = ['all', 'marina', 'fuel', 'pumpout', 'anchorage', 'ramp'];
  chips.innerHTML = kinds.map((k) => `<button class="chip ${svcFilter === k ? 'on' : ''}" data-k="${k}">${k === 'all' ? 'All' : KIND_LABEL[k]}</button>`).join('');
  chips.querySelectorAll<HTMLButtonElement>('button').forEach((b) => b.addEventListener('click', () => {
    svcFilter = b.dataset.k as PlaceKind | 'all';
    if (svcFilter !== 'all' && !enabledKinds.has(svcFilter)) {
      enabledKinds.add(svcFilter);
      const cb = document.querySelector<HTMLInputElement>(`[data-layer="${svcFilter}"]`); if (cb) cb.checked = true;
      loadPlaces(true);
    }
    renderServices();
  }));
  const list = $('#svc-list');
  if (map.getZoom() < MIN_PLACE_ZOOM) { list.innerHTML = `<p class="fine">Zoom the map in to a harbor to see places.</p>`; return; }
  const c = map.getCenter();
  const center = { lat: c.lat, lon: c.lng };
  const rows = places
    .filter((p) => enabledKinds.has(p.kind) && (svcFilter === 'all' || p.kind === svcFilter))
    .map((p) => ({ p, d: inverse(center, p).distanceM / METRES_PER_NM }))
    .sort((a, b) => a.d - b.d).slice(0, 60);
  if (!rows.length) { list.innerHTML = `<p class="fine">Nothing found in this area for the selected types.</p>`; return; }
  list.innerHTML = rows.map(({ p, d }) => `<button class="svc" data-id="${esc(p.id)}"><i class="dot" style="--c:${KIND_COLOR[p.kind]}"></i><span><b>${esc(p.name)}</b><small>${KIND_LABEL[p.kind]} · ${d.toFixed(1)} nm from map center</small></span><span class="chev">›</span></button>`).join('');
  list.querySelectorAll<HTMLButtonElement>('.svc').forEach((b) => b.addEventListener('click', () => {
    const p = places.find((x) => x.id === b.dataset.id); if (!p) return;
    setTab('explore'); map.flyTo({ center: [p.lon, p.lat], zoom: Math.max(map.getZoom(), 14) }); showPlace(p);
  }));
}

// ------------------------------------------------------------------ my boat (device storage)
interface Boat { name: string; builder?: string; model?: string; year?: string; loa?: string; beam?: string; draft?: string; engine?: string; speed?: string }
const form = $('#boat-form') as HTMLFormElement;
function renderBoat() {
  const b = store.get<Boat>('nav.boat');
  const card = $('#boat-card');
  if (!b) { card.innerHTML = ''; return; }
  for (const [k, v] of Object.entries(b)) { const inp = form.elements.namedItem(k) as HTMLInputElement | null; if (inp) inp.value = v ?? ''; }
  const spec = [b.loa && `${b.loa} ft LOA`, b.beam && `${b.beam} ft beam`, b.draft && `${b.draft} ft draft`].filter(Boolean).join(' · ');
  card.innerHTML = `<div class="boat-card"><small>${esc([b.year, b.builder, b.model].filter(Boolean).join(' '))}</small><h3>${esc(b.name)}</h3><p>${esc(spec)}</p>${b.engine ? `<p>${esc(b.engine)}</p>` : ''}</div>`;
  if (b.speed) ($('#route-speed') as HTMLInputElement).value = b.speed;
}
form.addEventListener('submit', (e) => {
  e.preventDefault();
  const data = Object.fromEntries(new FormData(form).entries()) as unknown as Boat;
  store.set('nav.boat', data);
  renderBoat();
});

// ------------------------------------------------------------------ rocks (orange, NOAA ENC)
let rocksOn = store.get<boolean>('nav.rocks') ?? false;
let rocks: Rock[] = [];
let rockTimer: number | undefined;
const rockCache = new Map<string, Rock[]>();
function setRocks(on: boolean) {
  rocksOn = on; store.set('nav.rocks', on);
  syncToggles();
  if (map.getLayer('rocks')) map.setLayoutProperty('rocks', 'visibility', on ? 'visible' : 'none');
  if (on) loadRocks(true);
}
function loadRocks(immediate = false) {
  window.clearTimeout(rockTimer);
  if (!rocksOn) return;
  rockTimer = window.setTimeout(async () => {
    if (map.getZoom() < 11) { setStatus('Zoom in closer to see rocks', false); window.setTimeout(() => setStatus(''), 2500); return; }
    const b = map.getBounds(); const z = Math.round(map.getZoom());
    const snap = (v: number, up: boolean) => (up ? Math.ceil(v * 50) : Math.floor(v * 50)) / 50;
    const box = { s: snap(b.getSouth(), false), w: snap(b.getWest(), false), n: snap(b.getNorth(), true), e: snap(b.getEast(), true) };
    const key = `${box.s},${box.w},${box.n},${box.e},${z >= 13 ? 'h' : 'a'}`;
    try {
      rocks = rockCache.get(key) ?? await rocksInView(box, z);
      rockCache.set(key, rocks);
      (map.getSource('rocks') as GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: rocks.map((r) => ({ type: 'Feature', properties: { id: r.id }, geometry: { type: 'Point', coordinates: [r.lon, r.lat] } })) });
    } catch { setStatus('Couldn’t load rocks from NOAA right now.', true); }
  }, immediate ? 0 : 500);
}
map.on('moveend', () => loadRocks());
function showRock(r: Rock) {
  $('#detail-title').textContent = r.name ?? 'Rock';
  $('#detail-body').innerHTML = `<div class="pill-row"><span class="pill" style="--c:#F26B1D">Rock</span><span class="badge">NOAA chart</span></div>
    <div class="kv"><small>Status</small><span>${esc(r.watlev ? WATLEV_LABEL[r.watlev] ?? 'Unknown' : 'Not stated on chart')}</span></div>
    ${r.valsouFt !== null ? `<div class="kv"><small>Depth over</small><span>${r.valsouFt.toFixed(1)} ft below MLLW</span></div>` : ''}
    <div class="row"><button class="btn ghost" id="rock-wx">Conditions here</button></div>
    <p class="src">From NOAA electronic chart data. Not for navigation; give charted hazards a wide berth.</p>`;
  $('#rock-wx').addEventListener('click', () => showConditions({ lat: r.lat, lon: r.lon }));
  openSheet('sheet-detail');
}

// ------------------------------------------------------------------ wind + currents (animated, PredictWind-style), one shared time slider
let windOn = false, curOn = false;
let wind: WindLayer | null = null, cur: WindLayer | null = null;
let flowTimer: number | undefined;
let windKey = '', curKey = '';
const windSlider = $('#wind-slider') as HTMLInputElement;
function renderLegends() {
  const parts: string[] = [];
  if (windOn) parts.push(`<div class="legend"><b class="lg-l">Wind</b>${LEGEND_STOPS.map((k) => `<span style="--c:${speedColor(k)}">${k}</span>`).join('')}<em>kn</em></div>`);
  if (curOn) parts.push(`<div class="legend"><b class="lg-l">Current</b>${CURRENT_LEGEND.map((k) => `<span style="--c:${currentColor(k)}">${k}</span>`).join('')}<em>kn</em></div>`);
  $('#wind-legend').innerHTML = parts.join('');
  $('#wind-src').textContent = [windOn && 'Wind', curOn && 'Currents'].filter(Boolean).join(' + ') + ' · Open-Meteo forecast';
}
function windLabel(iso: string) {
  const d = new Date(iso);
  if (Math.abs(d.getTime() - Date.now()) < 45 * 60e3) return 'Now';
  return d.toLocaleString([], { weekday: 'short', hour: 'numeric' });
}
const flowTimes = () => (windOn && wind?.times.length ? wind.times : curOn && cur?.times.length ? cur.times : []);
function applyTime() {
  const i = Number(windSlider.value);
  wind?.setTime(i); cur?.setTime(i);
  const t = flowTimes().at(i); $('#wind-time').textContent = t ? windLabel(t) : 'Now';
}
function setTimeIndexToNow() {
  const times = flowTimes(); if (!times.length) return;
  let idx = times.findIndex((t) => Date.parse(t) >= Date.now() - 30 * 60e3); if (idx < 0) idx = 0;
  windSlider.min = String(idx); windSlider.max = String(Math.min(times.length - 1, idx + 47));
  if (Number(windSlider.value) < idx || Number(windSlider.value) > Number(windSlider.max)) windSlider.value = String(idx);
  applyTime();
}
windSlider.addEventListener('input', applyTime);
const viewKey = () => { const b = map.getBounds(); return [b.getSouth(), b.getWest(), b.getNorth(), b.getEast()].map((v) => v.toFixed(1)).join(',') + Math.round(map.getZoom()); };
const viewBox = () => { const b = map.getBounds(); return { s: b.getSouth(), w: b.getWest(), n: b.getNorth(), e: b.getEast() }; };
async function loadFlows() {
  const key = viewKey();
  if (windOn && key !== windKey) {
    try { const g = await fetchWindGrid(viewBox()); windKey = key; wind?.setGrid(g); setTimeIndexToNow(); }
    catch { $('#wind-src').textContent = 'Couldn’t load wind forecast'; }
  }
  if (curOn && key !== curKey) {
    try { const g = await fetchCurrentGrid(viewBox()); curKey = key; cur?.setGrid(g); setTimeIndexToNow(); }
    catch { $('#wind-src').textContent = 'Couldn’t load current forecast'; }
  }
}
function updateFlowUi() {
  const any = windOn || curOn;
  $('#wind-bar').hidden = !any;
  document.body.classList.toggle('wind-on', any);
  renderLegends(); syncToggles();
}
function setWind(on: boolean) {
  windOn = on;
  if (on) { if (!wind) wind = new WindLayer(map, $('#map')); wind.start(); windKey = ''; loadFlows(); } else wind?.stop();
  updateFlowUi();
}
function setCurrents(on: boolean) {
  curOn = on;
  if (on) { if (!cur) cur = new WindLayer(map, $('#map'), { color: currentColor, pxPerKn: 1.1, density: 0.8 }); cur.start(); curKey = ''; loadFlows(); } else cur?.stop();
  updateFlowUi();
}
map.on('moveend', () => { window.clearTimeout(flowTimer); if (windOn || curOn) flowTimer = window.setTimeout(loadFlows, 700); });

// ------------------------------------------------------------------ quick toggles
let placesOn = true;
function syncToggles() {
  const state: Record<string, boolean> = { wind: windOn, currents: curOn, rocks: rocksOn, places: placesOn };
  document.querySelectorAll<HTMLButtonElement>('[data-quick]').forEach((b) => { const on = state[b.dataset.quick!] ?? false; b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); });
  for (const k of ['wind', 'currents', 'rocks'] as const) { const el = document.querySelector<HTMLInputElement>(`[data-layer="${k}"]`); if (el) el.checked = state[k]!; }
}
document.querySelectorAll<HTMLButtonElement>('[data-quick]').forEach((b) => b.addEventListener('click', () => {
  const k = b.dataset.quick!;
  if (k === 'wind') setWind(!windOn);
  else if (k === 'currents') setCurrents(!curOn);
  else if (k === 'rocks') setRocks(!rocksOn);
  else if (k === 'places') { placesOn = !placesOn; if (map.getLayer('places')) map.setLayoutProperty('places', 'visibility', placesOn ? 'visible' : 'none'); syncToggles(); }
}));
map.once('style.load', () => { if (rocksOn) setRocks(true); });

// ------------------------------------------------------------------ auto routing (hazard-avoiding) and passage weather routing
type RMode = 'manual' | 'auto' | 'passage';
let rmode: RMode = (store.get<RMode>('nav.rmode') ?? 'auto');
let ends: LatLon[] = [];
let routeBusy = false;
function setRMode(m: RMode) {
  rmode = m; store.set('nav.rmode', m);
  document.querySelectorAll<HTMLButtonElement>('[data-rmode]').forEach((b) => b.classList.toggle('on', b.dataset.rmode === m));
  document.querySelectorAll<HTMLElement>('[data-rpane]').forEach((el) => { el.hidden = el.dataset.rpane !== m && !(el.dataset.rpane === 'ends' && m !== 'manual'); });
  $('#hint').textContent = m === 'manual' ? 'Tap the map to add waypoints' : ends.length === 0 ? 'Tap your starting point' : ends.length === 1 ? 'Now tap your destination' : 'Tap to set a new start';
  drawEnds();
}
document.querySelectorAll<HTMLButtonElement>('[data-rmode]').forEach((b) => b.addEventListener('click', () => setRMode(b.dataset.rmode as RMode)));
function drawEnds() {
  const src = map.getSource('ends') as GeoJSONSource | undefined; if (!src) return;
  const show = tab === 'navigate' && rmode !== 'manual';
  src.setData({ type: 'FeatureCollection', features: show ? ends.map((p, i) => ({ type: 'Feature', properties: { role: i === 0 ? 'start' : 'end' }, geometry: { type: 'Point', coordinates: [p.lon, p.lat] } })) : [] });
  $('#ends-text').textContent = ends.length === 0 ? 'Tap the map to set your start.' : ends.length === 1 ? 'Start set. Now tap your destination.' : `Start → destination: ${distanceNmShort(ends[0]!, ends[1]!)} nm straight line.`;
}
const distanceNmShort = (a: LatLon, b: LatLon) => (inverse(a, b).distanceM / METRES_PER_NM).toFixed(1);
function setAutoRoute(fc: GeoJSON.FeatureCollection) { (map.getSource('autoroute') as GeoJSONSource | undefined)?.setData(fc); }
function clearAuto() { ends = []; setAutoRoute({ type: 'FeatureCollection', features: [] }); $('#auto-result').innerHTML = ''; $('#passage-result').innerHTML = ''; drawEnds(); setRMode(rmode); }
document.querySelectorAll<HTMLButtonElement>('[data-clear-ends]').forEach((b) => b.addEventListener('click', clearAuto));
function addEnd(p: LatLon) {
  if (ends.length >= 2) { ends = []; setAutoRoute({ type: 'FeatureCollection', features: [] }); }
  ends.push(p); drawEnds(); setRMode(rmode);
  if (ends.length === 2) { if (rmode === 'auto') runAuto(); }
}
function fitTo(points: LatLon[]) {
  const lats = points.map((p) => p.lat), lons = points.map((p) => p.lon);
  map.fitBounds([[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]], { padding: { top: 140, bottom: window.innerHeight * 0.5, left: 40, right: 40 }, duration: 800, maxZoom: 14 });
}
function boatDraftFt(): number { const b = store.get<{ draft?: string }>('nav.boat'); const d = Number(b?.draft); return d > 0 ? d : 6; }
($('#auto-draft') as HTMLInputElement).value = String(boatDraftFt());

async function runAuto() {
  if (ends.length < 2 || routeBusy) return;
  routeBusy = true;
  const out = $('#auto-result');
  const draftFt = Number(($('#auto-draft') as HTMLInputElement).value) || 6;
  const marginFt = Number(($('#auto-margin') as HTMLInputElement).value) || 0;
  out.innerHTML = `<div class="loading" id="auto-progress">Starting…</div>`;
  try {
    const r = await coastalRoute(ends[0]!, ends[1]!, { draftFt, marginFt, hazardBufferM: 50 }, (m) => { const el = document.getElementById('auto-progress'); if (el) el.textContent = m; });
    setAutoRoute({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: { color: '#0B1F3F' }, geometry: { type: 'LineString', coordinates: r.path.map((p) => [p.lon, p.lat]) } }] });
    fitTo(r.path);
    const speed = Number(($('#route-speed') as HTMLInputElement).value) || 6;
    const h = r.distanceNm / speed;
    out.innerHTML = `<div class="totals"><div><b>${r.distanceNm.toFixed(1)} nm</b><small>Route</small></div><div><b>${Math.floor(h)} h ${Math.round((h % 1) * 60)} m</b><small>at ${speed} kn</small></div><div><b>${r.shallowestFt === null ? '—' : `${Math.round(r.shallowestFt)} ft`}</b><small>Shallowest area</small></div></div>
      <p class="fine">Keeps water at least ${draftFt + marginFt} ft deep on the chart (your ${draftFt} ft draft + ${marginFt} ft margin) and stays about 50 m clear of charted rocks, wrecks and obstructions. ${r.path.length - 1} legs.
      ${r.snapped.start > 30 || r.snapped.end > 30 ? `<br>Start/end were ${Math.round(Math.max(r.snapped.start, r.snapped.end))} m from deep-enough water; the dashed-in final stretch isn't checked.` : ''}</p>
      <p class="fine warn-text">Planning aid only. Charted depths are at low tide and can be out of date. Check the route against the chart and keep watch.</p>`;
  } catch (e) {
    out.innerHTML = `<p class="err">${esc(e instanceof RouteError || e instanceof Error ? e.message : 'Routing failed')}</p>`;
  } finally { routeBusy = false; }
}
$('#auto-go').addEventListener('click', runAuto);

const dep = $('#passage-depart') as HTMLInputElement;
{ const d = new Date(Date.now() + 3600e3); d.setMinutes(0, 0, 0); dep.value = new Date(d.getTime() - d.getTimezoneOffset() * 60e3).toISOString().slice(0, 16); }
async function runPassage() {
  if (ends.length < 2) { $('#passage-result').innerHTML = `<p class="fine">Tap a start and a destination first. Use search to jump to far-away places.</p>`; return; }
  if (routeBusy) return;
  routeBusy = true;
  const out = $('#passage-result');
  out.innerHTML = `<div class="loading" id="passage-progress">Starting…</div>`;
  const motorOn = ($('#passage-motor') as HTMLInputElement).checked;
  const opt = { departure: new Date(dep.value), motorBelowKn: motorOn ? Number(($('#passage-motor-kn') as HTMLInputElement).value) || 6 : null, motorSpeedKn: 6.5, efficiency: 0.85, maxWindKn: 25 };
  try {
    const r = await passageRoute(ends[0]!, ends[1]!, opt, (m) => { const el = document.getElementById('passage-progress'); if (el) el.textContent = m; });
    const feats: GeoJSON.Feature[] = [];
    for (let i = 1; i < r.points.length; i++) {
      const a = r.points[i - 1]!, b = r.points[i]!;
      feats.push({ type: 'Feature', properties: { color: speedColor(a.twsKn) }, geometry: { type: 'LineString', coordinates: [[a.lon, a.lat], [b.lon, b.lat]] } });
    }
    setAutoRoute({ type: 'FeatureCollection', features: feats });
    fitTo(r.points);
    const arrive = new Date(r.points.at(-1)!.t);
    const days = r.hours / 24;
    const rows = r.points.filter((_, i) => i % Math.max(1, Math.round(12 / Math.max(1, r.hours / Math.max(1, r.points.length - 1)))) === 0 || i === r.points.length - 1);
    out.innerHTML = `<div class="totals"><div><b>${days >= 1 ? `${days.toFixed(1)} days` : `${r.hours.toFixed(1)} h`}</b><small>${r.arrived ? 'Passage time' : 'Partial'}</small></div><div><b>${Math.round(r.distanceNm)} nm</b><small>Sailed</small></div><div><b>${Math.round(r.maxTws)} kn</b><small>Max wind</small></div></div>
      ${r.arrived ? `<p class="fine">Arrive about <b>${arrive.toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric' })}</b>. ${r.strongHours ? `<span class="warn-text">About ${r.strongHours} h in 25+ kn wind.</span>` : 'No forecast winds of 25 kn or more along the route.'} ${r.motorHours ? `Motoring about ${r.motorHours} h in light air.` : ''}</p>` : `<p class="err">${esc(r.note ?? '')}</p>`}
      <table class="legs"><thead><tr><th>When</th><th>Wind</th><th>Angle</th><th>Boat</th><th>Current</th></tr></thead><tbody>
      ${rows.map((p) => `<tr><td>${new Date(p.t).toLocaleString([], { weekday: 'short', hour: 'numeric' })}</td><td>${Math.round(p.twsKn)} kn ${compass(p.twdDeg)}</td><td>${Math.round(p.twaDeg)}°${p.twaDeg < 60 ? ' up' : p.twaDeg > 130 ? ' down' : ''}</td><td>${p.motoring ? 'motor' : `${p.boatKn.toFixed(1)} kn`}</td><td>${p.curKn.toFixed(1)} kn</td></tr>`).join('')}
      </tbody></table>
      <p class="fine">Route line is coloured by wind speed. Uses a generic 50 ft cruising sailboat performance table at 85%, ${r.currentIncluded ? 'ocean currents (incl. Gulf Stream)' : 'no currents (unavailable)'}, and avoids land. Forecasts beyond 5–7 days are uncertain: recheck before departure.</p>
      <p class="fine warn-text">Planning aid only. Not a substitute for a professional weather router, official forecasts, or skipper judgement.</p>`;
  } catch (e) {
    out.innerHTML = `<p class="err">${esc(e instanceof Error ? e.message : 'Routing failed')}</p>`;
  } finally { routeBusy = false; }
}
$('#passage-go').addEventListener('click', runPassage);

// ------------------------------------------------------------------ my boat (triangle + course line)
const boat = new BoatTracker(map);
const readout = $('#boat-readout');
boat.onUpdate = (s) => {
  readout.hidden = false; $('#hint').hidden = true;
  const hdg = s.headingDeg === null ? '—' : `${Math.round(s.headingDeg).toString().padStart(3, '0')}°`;
  const src = s.source === 'gps' ? 'COG' : s.source === 'compass' ? 'HDG' : 'HDG';
  readout.innerHTML = `<span><small>${src}</small><b>${hdg}</b></span><span><small>SOG</small><b>${s.sogKn === null ? '—' : s.sogKn.toFixed(1)} kn</b></span>`;
};
boat.onError = (msg) => setStatus(msg, true);
$('#btn-boat').addEventListener('click', async () => {
  if (boat.active) { boat.recenter(); return; }
  $('#btn-boat').classList.add('on');
  await boat.start();
});

renderBoat();
syncToggles();
setRMode(rmode);
setTab('explore');
