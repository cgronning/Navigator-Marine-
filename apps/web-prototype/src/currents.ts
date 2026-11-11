/**
 * Currents:
 *  - Map layer: ocean current forecast grid (Open-Meteo marine; Gulf Stream, tidal and wind-driven flow).
 *  - Tap info: NOAA tidal current predictions (max flood / max ebb / slack) at the nearest station.
 */
import { distanceNm } from '../../../packages/core/src/geo/nav.ts';
import type { LatLon } from './data.ts';
import type { WindGrid } from './wind.ts';

const ROWS = 12, COLS = 9;

export async function fetchCurrentGrid(b: { s: number; w: number; n: number; e: number }): Promise<WindGrid> {
  const padLat = (b.n - b.s) * 0.15, padLon = (b.e - b.w) * 0.15;
  const s = b.s - padLat, n = b.n + padLat, w = b.w - padLon, e = b.e + padLon;
  const lats = Array.from({ length: ROWS }, (_, i) => s + ((n - s) * i) / (ROWS - 1));
  const lons = Array.from({ length: COLS }, (_, j) => w + ((e - w) * j) / (COLS - 1));
  const qLat: string[] = [], qLon: string[] = [];
  for (const la of lats) for (const lo of lons) { qLat.push(la.toFixed(3)); qLon.push(lo.toFixed(3)); }
  const url = `https://marine-api.open-meteo.com/v1/marine?latitude=${qLat.join(',')}&longitude=${qLon.join(',')}&hourly=ocean_current_velocity,ocean_current_direction&forecast_days=3&timezone=GMT`;
  const res = await fetch(url, { signal: AbortSignal.timeout(25000) });
  if (!res.ok) throw new Error(`Currents HTTP ${res.status}`);
  const arr = (await res.json()) as { hourly: { time: string[]; ocean_current_velocity: (number | null)[]; ocean_current_direction: (number | null)[] } }[];
  const times = arr.at(0)!.hourly.time.map((t) => `${t}:00Z`);
  const speed: number[][][] = [], dir: number[][][] = [];
  for (let t = 0; t < times.length; t++) {
    const sp: number[][] = [], dr: number[][] = [];
    for (let r = 0; r < ROWS; r++) {
      const rs: number[] = [], rd: number[] = [];
      for (let c = 0; c < COLS; c++) {
        const h = arr.at(r * COLS + c)!.hourly;
        rs.push((h.ocean_current_velocity.at(t) ?? 0) / 1.852); // km/h -> knots
        rd.push(((h.ocean_current_direction.at(t) ?? 0) + 180) % 360); // stored as "from" so the shared animator flows the right way
      }
      sp.push(rs); dr.push(rd);
    }
    speed.push(sp); dir.push(dr);
  }
  return { lats, lons, times, speed, dir };
}

const CSTOPS: [number, [number, number, number]][] = [[0, [140, 190, 215]], [0.5, [60, 150, 200]], [1, [40, 110, 190]], [2, [120, 60, 190]], [3, [200, 40, 150]], [4, [220, 30, 60]]];
export function currentColor(kn: number, alpha = 1): string {
  let lo = CSTOPS[0]!, hi = CSTOPS.at(-1)!;
  for (let i = 0; i < CSTOPS.length - 1; i++) if (kn >= CSTOPS[i]![0] && kn <= CSTOPS[i + 1]![0]) { lo = CSTOPS[i]!; hi = CSTOPS[i + 1]!; break; }
  if (kn > hi[0]) lo = hi;
  const f = hi[0] === lo[0] ? 0 : (kn - lo[0]) / (hi[0] - lo[0]);
  const c = lo[1].map((v, i) => Math.round(v + (hi[1][i]! - v) * f));
  return `rgba(${c[0]},${c[1]},${c[2]},${alpha})`;
}
export const CURRENT_LEGEND = [0, 0.5, 1, 2, 3, 4];

// ---------------------------------------------------------------- NOAA tidal current stations
export interface CurrentStation { id: string; name: string; lat: number; lon: number; bin: number | null }
export interface CurrentEvent { time: string; type: 'flood' | 'ebb' | 'slack'; speedKn: number; dirDeg: number | null }

let stations: Promise<CurrentStation[]> | null = null;
function currentStations(): Promise<CurrentStation[]> {
  if (!stations) {
    stations = fetch('https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi/stations.json?type=currentpredictions', { signal: AbortSignal.timeout(30000) })
      .then((r) => r.json())
      .then((j: { stations: { id: string; name: string; lat: number; lng: number; currbin?: number }[] }) => j.stations.map((s) => ({ id: s.id, name: s.name, lat: s.lat, lon: s.lng, bin: s.currbin ?? null })))
      .catch((e) => { stations = null; throw e; });
  }
  return stations;
}

export async function nearestCurrent(p: LatLon, maxNm = 10): Promise<{ station: CurrentStation; distNm: number; events: CurrentEvent[] } | null> {
  const all = await currentStations();
  let best: { station: CurrentStation; distNm: number } | null = null;
  for (const s of all) {
    if (Math.abs(s.lat - p.lat) > 0.25 || Math.abs(s.lon - p.lon) > 0.35) continue;
    const d = distanceNm(p, s);
    if (d <= maxNm && (!best || d < best.distNm)) best = { station: s, distNm: d };
  }
  if (!best) return null;
  const now = new Date();
  const ymd = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
  const url = `https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?product=currents_predictions&application=NavigatorMarinePrototype&begin_date=${ymd}&range=36&station=${encodeURIComponent(best.station.id)}${best.station.bin !== null ? `&bin=${best.station.bin}` : ''}&time_zone=lst_ldt&units=english&interval=MAX_SLACK&format=json`;
  const j = await fetch(url, { signal: AbortSignal.timeout(20000) }).then((r) => r.json());
  const list = (j.current_predictions?.cp ?? []) as { Time: string; Type: string; Velocity_Major: number; meanFloodDir?: number; meanEbbDir?: number }[];
  if (!list.length) throw new Error(j.error?.message ?? 'No current predictions');
  const events: CurrentEvent[] = list.map((x) => {
    const type = /flood/i.test(x.Type) ? 'flood' : /ebb/i.test(x.Type) ? 'ebb' : 'slack';
    return { time: x.Time, type, speedKn: Math.abs(Number(x.Velocity_Major) || 0), dirDeg: type === 'flood' ? x.meanFloodDir ?? null : type === 'ebb' ? x.meanEbbDir ?? null : null };
  });
  return { ...best, events };
}
