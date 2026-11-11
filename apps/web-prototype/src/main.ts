import maplibregl, { type GeoJSONSource, type MapMouseEvent, type StyleSpecification } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import './styles.css';
import { inverse, METRES_PER_NM, etaHours } from '../../../packages/core/src/geo/nav.ts';
import {
  fetchConditions, nearestTideStation, tidePredictions, fetchPlaces,
  KIND_LABEL, type Place, type PlaceKind, type LatLon, type HourRow,
} from './data.ts';

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
const style: StyleSpecification = {
  version: 8,
  sources: {
    base: {
      type: 'raster', tileSize: 256, maxzoom: 19,
      tiles: ['a', 'b', 'c', 'd'].map((s) => `https://${s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}@2x.png`),
      attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors © <a href="https://carto.com/attributions">CARTO</a>',
    },
    seamarks: {
      type: 'raster', tileSize: 256, minzoom: 6, maxzoom: 18,
      tiles: ['https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png'],
      attribution: 'Marks © <a href="https://www.openseamap.org">OpenSeaMap</a>',
    },
  },
  layers: [
    { id: 'base', type: 'raster', source: 'base' },
    { id: 'seamarks', type: 'raster', source: 'seamarks' },
  ],
};

const saved = store.get<{ center: [number, number]; zoom: number }>('nav.view');
function fatal(msg: string) {
  const d = document.createElement('div'); d.className = 'status error'; d.textContent = msg; document.body.appendChild(d);
}
if (!document.createElement('canvas').getContext('webgl2') && !document.createElement('canvas').getContext('webgl')) {
  fatal('This browser can’t draw the map (WebGL is off). Try opening the link in Safari or Chrome.');
}
const map = new maplibregl.Map({
  container: 'map',
  style,
  center: saved?.center ?? [-71.33, 41.47], // Newport / Narragansett Bay
  zoom: saved?.zoom ?? 11.5,
  attributionControl: false,
  maxPitch: 0,
  dragRotate: false,
});
map.touchZoomRotate.disableRotation();
(window as unknown as { __navMap: unknown }).__navMap = map;

// ------------------------------------------------------------------ map health: show problems instead of a silent blank map
let baseTileErrors = 0;
let baseLoaded = false;
let usingFallback = false;
map.on('error', (e) => {
  const msg = (e as { error?: Error }).error?.message ?? 'unknown error';
  const srcId = (e as { sourceId?: string }).sourceId;
  if (srcId === 'seamarks') return; // optional overlay; ignore its failures
  if (srcId === 'base') {
    baseTileErrors++;
    if (baseTileErrors >= 4 && !usingFallback) {
      usingFallback = true;
      const src = map.getSource('base') as maplibregl.RasterTileSource | undefined;
      src?.setTiles(['https://tile.openstreetmap.org/{z}/{x}/{y}.png']);
      setStatus('Switched to backup map tiles', false);
      return;
    }
  }
  setStatus(`Map problem: ${msg}`, true);
});
map.on('sourcedata', (e) => { if (e.sourceId === 'base' && e.isSourceLoaded) baseLoaded = true; });
map.on('webglcontextlost', () => setStatus('The map display was interrupted. Reload the page.', true));
window.setTimeout(() => {
  if (!baseLoaded) setStatus(`Map tiles haven't loaded yet (${baseTileErrors} errors). Check your connection or reload.`, true);
}, 10000);
map.addControl(new maplibregl.AttributionControl({ compact: true, customAttribution: 'Weather: <a href="https://open-meteo.com">Open-Meteo</a> · Tides: NOAA' }), 'bottom-left');
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
map.addControl(new maplibregl.GeolocateControl({ positionOptions: { enableHighAccuracy: true }, trackUserLocation: true }), 'top-right');
map.addControl(new maplibregl.ScaleControl({ unit: 'nautical' }), 'bottom-right');

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
  if (t === 'navigate') renderRoute();
  setTimeout(() => map.resize(), 0);
}
document.querySelectorAll<HTMLButtonElement>('.tabbar button').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab as Tab)));

// ------------------------------------------------------------------ layers
document.querySelectorAll<HTMLInputElement>('[data-layer]').forEach((cb) => {
  const key = cb.dataset.layer!;
  cb.addEventListener('change', () => {
    if (key === 'seamarks') { map.setLayoutProperty('seamarks', 'visibility', cb.checked ? 'visible' : 'none'); return; }
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
        setStatus('Loading places…');
        result = await fetchPlaces(box, kinds);
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
map.on('load', () => {
  map.addSource('places', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addLayer({
    id: 'places', type: 'circle', source: 'places',
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 5, 15, 9],
      'circle-color': ['get', 'color'],
      'circle-stroke-color': '#FFFFFF', 'circle-stroke-width': 2,
    },
  });
  map.addSource('route', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
  map.addLayer({ id: 'route-line', type: 'line', source: 'route', filter: ['==', '$type', 'LineString'], paint: { 'line-color': '#0B1F3F', 'line-width': 3, 'line-dasharray': [2, 1.5] } });
  map.addLayer({ id: 'route-pts', type: 'circle', source: 'route', filter: ['==', '$type', 'Point'], paint: { 'circle-radius': 7, 'circle-color': '#FBF8F1', 'circle-stroke-color': '#0B1F3F', 'circle-stroke-width': 3 } });
  drawRoute();
  loadPlaces(true);
});
map.on('moveend', () => {
  const c = map.getCenter();
  store.set('nav.view', { center: [c.lng, c.lat], zoom: map.getZoom() });
  loadPlaces();
});
map.on('mouseenter', 'places', () => { map.getCanvas().style.cursor = 'pointer'; });
map.on('mouseleave', 'places', () => { map.getCanvas().style.cursor = ''; });

map.on('click', (e: MapMouseEvent) => {
  const hits = map.queryRenderedFeatures(e.point, { layers: ['places'] });
  const first = hits.at(0);
  if (first && tab !== 'navigate') {
    const p = places.find((x) => x.id === first.properties?.['id']);
    if (p) { showPlace(p); return; }
  }
  const pt = { lat: e.lngLat.lat, lon: e.lngLat.lng };
  if (tab === 'navigate') { route.push(pt); store.set('nav.route', route); drawRoute(); renderRoute(); return; }
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

  const body = $('#detail-body');
  let html = `<p class="coord">${coord}</p>`;
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
  body.innerHTML = html + `<div id="tides"><div class="loading">Finding nearest NOAA tide station…</div></div>`;

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

renderBoat();
setTab('explore');
