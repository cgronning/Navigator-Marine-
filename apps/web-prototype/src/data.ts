/**
 * Live data sources for the web prototype. All are real, public APIs that
 * allow browser access. Every function either returns real data or throws;
 * nothing here invents values.
 */
import { distanceNm } from '../../../packages/core/src/geo/nav.ts';

export interface LatLon { lat: number; lon: number }

async function getJson<T>(url: string, init?: RequestInit, timeoutMs = 15000): Promise<T> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ctl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(t);
  }
}

// ---------------------------------------------------------------- Weather
export interface HourRow {
  time: string;
  windKn: number | null;
  gustKn: number | null;
  windDir: number | null;
  airF: number | null;
  precipIn: number | null;
  waveFt: number | null;
  wavePeriod: number | null;
  waveDir: number | null;
  swellFt: number | null;
  swellPeriod: number | null;
  waterF: number | null;
}

interface OmForecast { hourly: { time: string[]; wind_speed_10m: (number | null)[]; wind_gusts_10m: (number | null)[]; wind_direction_10m: (number | null)[]; temperature_2m: (number | null)[]; precipitation: (number | null)[] }; timezone: string }
interface OmMarine { hourly: { time: string[]; wave_height: (number | null)[]; wave_period: (number | null)[]; wave_direction: (number | null)[]; swell_wave_height: (number | null)[]; swell_wave_period: (number | null)[]; sea_surface_temperature?: (number | null)[] } }

export interface Conditions { hours: HourRow[]; timezone: string; marineAvailable: boolean }

export async function fetchConditions(p: LatLon): Promise<Conditions> {
  const q = `latitude=${p.lat.toFixed(4)}&longitude=${p.lon.toFixed(4)}&timezone=auto&forecast_days=2`;
  const fUrl = `https://api.open-meteo.com/v1/forecast?${q}&hourly=wind_speed_10m,wind_gusts_10m,wind_direction_10m,temperature_2m,precipitation&wind_speed_unit=kn&temperature_unit=fahrenheit&precipitation_unit=inch`;
  const mUrl = `https://marine-api.open-meteo.com/v1/marine?${q}&hourly=wave_height,wave_period,wave_direction,swell_wave_height,swell_wave_period,sea_surface_temperature&length_unit=imperial&temperature_unit=fahrenheit`;
  const [f, m] = await Promise.all([
    getJson<OmForecast>(fUrl),
    getJson<OmMarine>(mUrl).catch(() => null), // marine model has no data over land
  ]);
  const idx = new Map<string, number>();
  m?.hourly.time.forEach((t, i) => idx.set(t, i));
  const at = <T>(arr: (T | null)[] | undefined, i: number | undefined): T | null => (arr && i !== undefined ? arr.at(i) ?? null : null);
  const hours: HourRow[] = f.hourly.time.map((time, i) => {
    const j = idx.get(time);
    return {
      time,
      windKn: at(f.hourly.wind_speed_10m, i),
      gustKn: at(f.hourly.wind_gusts_10m, i),
      windDir: at(f.hourly.wind_direction_10m, i),
      airF: at(f.hourly.temperature_2m, i),
      precipIn: at(f.hourly.precipitation, i),
      waveFt: at(m?.hourly.wave_height, j),
      wavePeriod: at(m?.hourly.wave_period, j),
      waveDir: at(m?.hourly.wave_direction, j),
      swellFt: at(m?.hourly.swell_wave_height, j),
      swellPeriod: at(m?.hourly.swell_wave_period, j),
      waterF: at(m?.hourly.sea_surface_temperature, j),
    };
  });
  const marineAvailable = hours.some((h) => h.waveFt !== null);
  return { hours, timezone: f.timezone, marineAvailable };
}

// ---------------------------------------------------------------- Tides (NOAA)
export interface TideStation { id: string; name: string; state?: string; lat: number; lon: number }
export interface TideEvent { time: string; heightFt: number; type: 'High' | 'Low' }

let stationsCache: Promise<TideStation[]> | null = null;

export function tideStations(): Promise<TideStation[]> {
  if (!stationsCache) {
    stationsCache = getJson<{ stations: { id: string; name: string; state?: string; lat: number; lng: number }[] }>(
      'https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations.json?type=tidepredictions',
      undefined,
      30000,
    ).then((r) => r.stations.map((s) => ({ id: s.id, name: s.name, state: s.state, lat: s.lat, lon: s.lng })))
      .catch((e) => { stationsCache = null; throw e; });
  }
  return stationsCache;
}

export async function nearestTideStation(p: LatLon, maxNm = 25): Promise<{ station: TideStation; distNm: number } | null> {
  const all = await tideStations();
  let best: { station: TideStation; distNm: number } | null = null;
  for (const s of all) {
    // cheap prefilter: ~0.5 degree box
    if (Math.abs(s.lat - p.lat) > 0.5 || Math.abs(s.lon - p.lon) > 0.7) continue;
    const d = distanceNm(p, s);
    if (d <= maxNm && (!best || d < best.distNm)) best = { station: s, distNm: d };
  }
  return best;
}

export async function tidePredictions(stationId: string): Promise<TideEvent[]> {
  const now = new Date();
  const ymd = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
  const url = `https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?product=predictions&application=NavigatorMarinePrototype&begin_date=${ymd}&range=48&datum=MLLW&station=${encodeURIComponent(stationId)}&time_zone=lst_ldt&units=english&interval=hilo&format=json`;
  const r = await getJson<{ predictions?: { t: string; v: string; type: 'H' | 'L' }[]; error?: { message: string } }>(url);
  if (!r.predictions) throw new Error(r.error?.message ?? 'No predictions');
  return r.predictions.map((x) => ({ time: x.t, heightFt: Number(x.v), type: x.type === 'H' ? 'High' : 'Low' }));
}

// ---------------------------------------------------------------- Places (OpenStreetMap via Overpass)
export type PlaceKind = 'marina' | 'fuel' | 'pumpout' | 'anchorage' | 'ramp';
export interface Place { id: string; kind: PlaceKind; name: string; lat: number; lon: number; tags: Record<string, string> }

const KIND_QUERIES: Record<PlaceKind, string[]> = {
  marina: ['nwr["leisure"="marina"]'],
  fuel: ['nwr["waterway"="fuel"]', 'nwr["amenity"="fuel"]["boat"="yes"]'],
  pumpout: ['nwr["waterway"="sanitary_dump_station"]', 'nwr["amenity"="sanitary_dump_station"]["boat"="yes"]'],
  anchorage: ['nwr["seamark:type"="anchorage"]'],
  ramp: ['nwr["leisure"="slipway"]'],
};

export const KIND_LABEL: Record<PlaceKind, string> = { marina: 'Marina', fuel: 'Fuel dock', pumpout: 'Pump-out', anchorage: 'Anchorage', ramp: 'Boat ramp' };

interface OverpassEl { type: string; id: number; lat?: number; lon?: number; center?: { lat: number; lon: number }; tags?: Record<string, string> }

export function classify(tags: Record<string, string>): PlaceKind | null {
  if (tags['leisure'] === 'marina') return 'marina';
  if (tags['waterway'] === 'fuel' || (tags['amenity'] === 'fuel' && tags['boat'] === 'yes')) return 'fuel';
  if (tags['waterway'] === 'sanitary_dump_station' || (tags['amenity'] === 'sanitary_dump_station' && tags['boat'] === 'yes')) return 'pumpout';
  if (tags['seamark:type'] === 'anchorage') return 'anchorage';
  if (tags['leisure'] === 'slipway') return 'ramp';
  return null;
}

export async function fetchPlaces(bbox: { s: number; w: number; n: number; e: number }, kinds: PlaceKind[]): Promise<Place[]> {
  if (kinds.length === 0) return [];
  const b = `${bbox.s.toFixed(4)},${bbox.w.toFixed(4)},${bbox.n.toFixed(4)},${bbox.e.toFixed(4)}`;
  const parts = kinds.flatMap((k) => KIND_QUERIES[k]).map((q) => `${q}(${b});`).join('');
  const query = `[out:json][timeout:25];(${parts});out center tags 400;`;
  const r = await getJson<{ elements: OverpassEl[] }>('https://overpass-api.de/api/interpreter', {
    method: 'POST',
    body: new URLSearchParams({ data: query }),
  }, 30000);
  const out: Place[] = [];
  for (const el of r.elements) {
    const tags = el.tags ?? {};
    const kind = classify(tags);
    const lat = el.lat ?? el.center?.lat;
    const lon = el.lon ?? el.center?.lon;
    if (!kind || lat === undefined || lon === undefined) continue;
    out.push({ id: `${el.type}/${el.id}`, kind, name: tags['name'] ?? tags['seamark:name'] ?? `Unnamed ${KIND_LABEL[kind].toLowerCase()}`, lat, lon, tags });
  }
  return out;
}
