/**
 * Weather routing for passages (e.g. Newport to the BVI) using the isochrone method:
 * every few hours, from every point the boat could have reached, try every heading,
 * work out boat speed from the wind (polar table) plus the ocean current, and keep
 * the furthest-forward points. Repeat until the destination is reached.
 *
 * Wind: Open-Meteo global forecast (up to 16 days). Currents: Open-Meteo marine
 * (ocean model, includes the Gulf Stream). Land: Natural Earth coastline.
 * Planning aid only: forecasts change, and this does not replace a weather router or skipper judgement.
 */
import { distanceNm } from '../../../packages/core/src/geo/nav.ts';
import type { LatLon } from './data.ts';

// ---------------------------------------------------------------- polar (generic ~50 ft cruising monohull, knots)
const TWS = [4, 6, 8, 10, 12, 14, 16, 20, 25, 30, 40];
const TWA = [0, 38, 45, 52, 60, 75, 90, 110, 120, 135, 150, 165, 180];
const SPEED = [ // rows TWS, cols TWA
  [0, 0, 2.6, 3.0, 3.3, 3.6, 3.7, 3.6, 3.4, 3.1, 2.7, 2.3, 2.1],
  [0, 0, 3.9, 4.4, 4.8, 5.2, 5.4, 5.3, 5.1, 4.6, 4.0, 3.5, 3.2],
  [0, 0, 4.9, 5.5, 5.9, 6.4, 6.6, 6.6, 6.4, 5.9, 5.2, 4.6, 4.2],
  [0, 0, 5.6, 6.2, 6.7, 7.2, 7.4, 7.5, 7.3, 6.9, 6.2, 5.5, 5.1],
  [0, 0, 6.0, 6.6, 7.1, 7.6, 7.9, 8.1, 8.0, 7.6, 6.9, 6.3, 5.8],
  [0, 0, 6.2, 6.9, 7.3, 7.9, 8.2, 8.5, 8.5, 8.2, 7.6, 6.9, 6.4],
  [0, 0, 6.3, 7.0, 7.5, 8.0, 8.4, 8.8, 8.9, 8.7, 8.1, 7.4, 6.9],
  [0, 0, 6.3, 7.0, 7.5, 8.1, 8.6, 9.1, 9.4, 9.4, 8.9, 8.2, 7.7],
  [0, 0, 6.0, 6.7, 7.2, 7.9, 8.5, 9.2, 9.6, 9.8, 9.5, 8.9, 8.4],
  [0, 0, 5.2, 5.9, 6.5, 7.3, 8.0, 8.8, 9.3, 9.6, 9.5, 9.0, 8.6],
  [0, 0, 3.5, 4.2, 5.0, 6.0, 6.8, 7.6, 8.0, 8.4, 8.4, 8.0, 7.6],
];
function interp(xs: number[], x: number): [number, number, number] {
  if (x <= xs[0]!) return [0, 0, 0];
  if (x >= xs.at(-1)!) return [xs.length - 1, xs.length - 1, 0];
  let i = 0; while (xs[i + 1]! < x) i++;
  return [i, i + 1, (x - xs[i]!) / (xs[i + 1]! - xs[i]!)];
}
export function polarSpeed(tws: number, twa: number): number {
  const a = Math.abs(((twa + 540) % 360) - 180);
  const [r0, r1, fr] = interp(TWS, tws), [c0, c1, fc] = interp(TWA, a);
  const v = (r: number, c: number) => SPEED[r]![c]!;
  const top = v(r0, c0) * (1 - fc) + v(r0, c1) * fc, bot = v(r1, c0) * (1 - fc) + v(r1, c1) * fc;
  return top * (1 - fr) + bot * fr;
}

// ---------------------------------------------------------------- forecast grid
interface Grid { s: number; w: number; step: number; rows: number; cols: number; t0: number; dtH: number; nt: number; u: Float32Array; v: Float32Array }
// u,v: [t][r][c] in knots, toward east/north

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchBatches(urlFor: (lats: string, lons: string) => string, pts: [number, number][], label: string, onProgress: (m: string) => void) {
  const out: unknown[] = [];
  for (let i = 0; i < pts.length; i += 60) {
    const chunk = pts.slice(i, i + 60);
    const url = urlFor(chunk.map((p) => p[0].toFixed(2)).join(','), chunk.map((p) => p[1].toFixed(2)).join(','));
    let j: unknown = null;
    for (let a = 0; a < 4 && j === null; a++) {
      try {
        const r = await fetch(url, { signal: AbortSignal.timeout(45000) });
        if (r.status === 429) {
          // free forecast tier: per-minute limit. Wait it out instead of failing.
          for (let sec = 62; sec > 0; sec -= 2) { onProgress(`Free forecast limit reached; continuing in ${sec}s… (${label})`); await sleep(2000); }
          continue;
        }
        if (r.ok) j = await r.json();
      } catch { await sleep(1500); }
    }
    if (j === null) throw new Error(`Couldn’t download the ${label} forecast. Check your connection and try again.`);
    out.push(...(Array.isArray(j) ? j : [j]));
    onProgress(`Downloading ${label} forecast… ${Math.min(100, Math.round(((i + chunk.length) / pts.length) * 100))}%`);
  }
  return out as { hourly: Record<string, (number | null)[] | string[]> }[];
}

const gridCache = new Map<string, Promise<Awaited<ReturnType<typeof buildGridsUncached>>>>();
function buildGrids(s: number, w: number, n: number, e: number, step: number, corridor: (lat: number, lon: number) => boolean, onProgress: (m: string) => void) {
  const key = [s, w, n, e, step, new Date().toISOString().slice(0, 13)].join(',');
  if (!gridCache.has(key)) gridCache.set(key, buildGridsUncached(s, w, n, e, step, corridor, onProgress).catch((err) => { gridCache.delete(key); throw err; }));
  return gridCache.get(key)!;
}

async function buildGridsUncached(s: number, w: number, n: number, e: number, step: number, corridor: (lat: number, lon: number) => boolean, onProgress: (m: string) => void) {
  const rows = Math.round((n - s) / step) + 1, cols = Math.round((e - w) / step) + 1;
  // Only download grid points in a corridor along the route; others copy their nearest downloaded point.
  const pts: [number, number][] = [];
  const idxOf = new Int32Array(rows * cols).fill(-1);
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const la = s + r * step, lo = w + c * step;
    if (corridor(la, lo)) { idxOf[r * cols + c] = pts.length; pts.push([la, lo]); }
  }
  if (!pts.length) throw new Error('Route area too small for the forecast grid.');
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    if (idxOf[r * cols + c]! >= 0) continue;
    let best = 0, bd = Infinity;
    pts.forEach(([la, lo], k) => { const d = (la - (s + r * step)) ** 2 + (lo - (w + c * step)) ** 2; if (d < bd) { bd = d; best = k; } });
    idxOf[r * cols + c] = -2 - best; // negative: copy from point `best`
  }
  const src = (k: number) => { const v = idxOf[k]!; return v >= 0 ? v : -2 - v; };
  const wind = await fetchBatches((la, lo) => `https://api.open-meteo.com/v1/forecast?latitude=${la}&longitude=${lo}&hourly=wind_speed_10m,wind_direction_10m&wind_speed_unit=kn&forecast_days=16&timezone=GMT`, pts, 'wind', onProgress);
  const cur = await fetchBatches((la, lo) => `https://marine-api.open-meteo.com/v1/marine?latitude=${la}&longitude=${lo}&hourly=ocean_current_velocity,ocean_current_direction&forecast_days=7&timezone=GMT`, pts, 'ocean current', onProgress).catch(() => null);
  const times = wind[0]!.hourly['time'] as string[];
  const dtH = 3, nt = Math.floor(times.length / dtH);
  const t0 = Date.parse(times[0]! + ':00Z');
  const mk = () => new Float32Array(nt * rows * cols);
  const wg: Grid = { s, w, step, rows, cols, t0, dtH, nt, u: mk(), v: mk() };
  const cg: Grid = { s, w, step, rows, cols, t0, dtH, nt, u: mk(), v: mk() };
  const curTimes = cur?.[0]?.hourly['time'] as string[] | undefined;
  for (let k = 0; k < rows * cols; k++) {
    const q = src(k);
    const sp = wind[q]!.hourly['wind_speed_10m'] as (number | null)[], dr = wind[q]!.hourly['wind_direction_10m'] as (number | null)[];
    const cs = cur?.[q]?.hourly['ocean_current_velocity'] as (number | null)[] | undefined, cd = cur?.[q]?.hourly['ocean_current_direction'] as (number | null)[] | undefined;
    for (let t = 0; t < nt; t++) {
      const h = t * dtH, i = t * rows * cols + k;
      const S = sp[h] ?? 0, D = ((dr[h] ?? 0) * Math.PI) / 180; // wind FROM D
      wg.u[i] = -S * Math.sin(D); wg.v[i] = -S * Math.cos(D);
      if (cs && cd && curTimes && h < curTimes.length) {
        const CS = (cs[h] ?? 0) / 1.852, CD = ((cd[h] ?? 0) * Math.PI) / 180; // current TOWARD CD, km/h -> kn
        cg.u[i] = CS * Math.sin(CD); cg.v[i] = CS * Math.cos(CD);
      }
    }
  }
  return { wind: wg, current: cur ? cg : null, forecastEnd: t0 + (times.length - 1) * 3600e3, currentEnd: curTimes ? Date.parse(curTimes.at(-1)! + ':00Z') : null };
}

function sampleGrid(g: Grid, tMs: number, lat: number, lon: number): [number, number] {
  const ft = Math.max(0, Math.min(g.nt - 1.001, (tMs - g.t0) / (g.dtH * 3600e3)));
  const fr = Math.max(0, Math.min(g.rows - 1.001, (lat - g.s) / g.step)), fc = Math.max(0, Math.min(g.cols - 1.001, (lon - g.w) / g.step));
  const t0 = Math.floor(ft), r0 = Math.floor(fr), c0 = Math.floor(fc), dt = ft - t0, dr = fr - r0, dc = fc - c0;
  let u = 0, v = 0;
  for (const [tt, wt] of [[t0, 1 - dt], [t0 + 1, dt]] as const) for (const [rr, wr] of [[r0, 1 - dr], [r0 + 1, dr]] as const) for (const [cc, wc] of [[c0, 1 - dc], [c0 + 1, dc]] as const) {
    const i = tt * g.rows * g.cols + rr * g.cols + cc, wgt = wt * wr * wc;
    u += g.u[i]! * wgt; v += g.v[i]! * wgt;
  }
  return [u, v];
}

// ---------------------------------------------------------------- land mask
let landPolys: Promise<number[][][][]> | null = null;
function loadLand() { if (!landPolys) landPolys = fetch('./land.json').then((r) => r.json()).then((j) => j.polygons as number[][][][]); return landPolys; }

async function landMask(s: number, w: number, n: number, e: number) {
  const res = 0.03; // ~1.8 nm
  const W = Math.ceil((e - w) / res), H = Math.ceil((n - s) / res);
  const cv = new OffscreenCanvas(W, H); const ctx = cv.getContext('2d', { willReadFrequently: true })!;
  ctx.fillStyle = '#000';
  for (const poly of await loadLand()) {
    ctx.beginPath();
    for (const ring of poly) ring.forEach(([lon, lat], i) => { const x = (lon! - w) / res, y = (n - lat!) / res; if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); });
    ctx.fill('evenodd');
  }
  const a = ctx.getImageData(0, 0, W, H).data;
  return (lat: number, lon: number) => {
    const x = Math.floor((lon - w) / res), y = Math.floor((n - lat) / res);
    if (x < 0 || y < 0 || x >= W || y >= H) return false;
    return a[(y * W + x) * 4 + 3]! > 64;
  };
}

// ---------------------------------------------------------------- isochrones
export interface PassageOptions { departure: Date; motorBelowKn: number | null; motorSpeedKn: number; efficiency: number; maxWindKn: number }
export interface PassagePoint { t: number; lat: number; lon: number; twsKn: number; twdDeg: number; twaDeg: number; boatKn: number; curKn: number; motoring: boolean }
export interface PassageResult { points: PassagePoint[]; distanceNm: number; hours: number; arrived: boolean; maxTws: number; strongHours: number; motorHours: number; currentIncluded: boolean; note: string | null }

const R_NM = 3440.065;
function move(lat: number, lon: number, brgDeg: number, nm: number): [number, number] {
  const d = nm / R_NM, b = (brgDeg * Math.PI) / 180, p1 = (lat * Math.PI) / 180, l1 = (lon * Math.PI) / 180;
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b));
  const l2 = l1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return [(p2 * 180) / Math.PI, (l2 * 180) / Math.PI];
}
function bearing(a: LatLon, b: LatLon) {
  const p1 = (a.lat * Math.PI) / 180, p2 = (b.lat * Math.PI) / 180, dl = ((b.lon - a.lon) * Math.PI) / 180;
  return ((Math.atan2(Math.sin(dl) * Math.cos(p2), Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl)) * 180) / Math.PI + 360) % 360;
}

interface Node { lat: number; lon: number; t: number; parent: Node | null; info: Omit<PassagePoint, 't' | 'lat' | 'lon'> | null }

export async function passageRoute(start: LatLon, end: LatLon, opt: PassageOptions, onProgress: (m: string) => void): Promise<PassageResult> {
  const direct = distanceNm(start, end);
  if (direct < 20) throw new Error('That’s a short trip; use Auto route (avoids hazards) instead.');
  if (direct > 3000) throw new Error('Passages over 3,000 nm aren’t supported in this prototype.');
  const pad = Math.min(8, Math.max(3, direct / 250));
  const s = Math.floor(Math.min(start.lat, end.lat) - pad), n = Math.ceil(Math.max(start.lat, end.lat) + pad);
  const w = Math.floor(Math.min(start.lon, end.lon) - pad), e = Math.ceil(Math.max(start.lon, end.lon) + pad);
  const step = direct > 1200 ? 1.5 : direct > 400 ? 1 : 0.5;
  // corridor: points within this distance of the straight line between start and end
  const corridorNm = Math.max(100, Math.min(300, direct * 0.2)) + step * 30;
  // fast flat-earth distance to the start-end line (fine for a corridor test)
  const kx = 60 * Math.cos((((start.lat + end.lat) / 2) * Math.PI) / 180), ky = 60;
  const ax = start.lon * kx, ay = start.lat * ky, bx = end.lon * kx, by = end.lat * ky, abx = bx - ax, aby = by - ay, ab2 = abx * abx + aby * aby;
  const corridor = (lat: number, lon: number) => {
    const px = lon * kx - ax, py = lat * ky - ay;
    const t = Math.max(0, Math.min(1, (px * abx + py * aby) / ab2));
    return Math.hypot(px - abx * t, py - aby * t) <= corridorNm;
  };
  const [grids, isLand] = await Promise.all([buildGrids(s, w, n, e, step, corridor, onProgress), landMask(s, w, n, e)]);
  onProgress('Calculating fastest route…');

  const dtH = direct > 600 ? 3 : direct > 150 ? 2 : 1;
  const dtMs = dtH * 3600e3;
  const t0 = Math.max(opt.departure.getTime(), grids.wind.t0);
  const nearCoast = (lat: number, lon: number) => distanceNm({ lat, lon }, start) < 6 || distanceNm({ lat, lon }, end) < 6;
  const legClear = (a: [number, number], b: [number, number]) => {
    for (let k = 1; k <= 4; k++) { const la = a[0] + ((b[0] - a[0]) * k) / 4, lo = a[1] + ((b[1] - a[1]) * k) / 4; if (isLand(la, lo) && !nearCoast(la, lo)) return false; }
    return true;
  };

  let frontier: Node[] = [{ lat: start.lat, lon: start.lon, t: t0, parent: null, info: null }];
  const startBrg = bearing(start, end);
  let best: Node | null = null;
  let arrived = false;
  const maxSteps = Math.floor((grids.forecastEnd - t0) / dtMs);
  for (let stepI = 0; stepI < maxSteps && frontier.length; stepI++) {
    const bins = new Map<number, Node>();
    const binDist = new Map<number, number>();
    for (const nd of frontier) {
      const [wu, wv] = sampleGrid(grids.wind, nd.t, nd.lat, nd.lon);
      const tws = Math.hypot(wu, wv);
      const twd = ((Math.atan2(-wu, -wv) * 180) / Math.PI + 360) % 360; // wind FROM
      const [cu, cv] = grids.current && nd.t <= (grids.currentEnd ?? 0) ? sampleGrid(grids.current, nd.t, nd.lat, nd.lon) : [0, 0];
      const toDest = bearing(nd, end);
      for (let hdg = 0; hdg < 360; hdg += 7.5) {
        const twa = ((hdg - twd + 540) % 360) - 180;
        let sp = polarSpeed(tws, twa) * opt.efficiency;
        let motoring = false;
        if (opt.motorBelowKn !== null && tws < opt.motorBelowKn && sp < opt.motorSpeedKn) { sp = opt.motorSpeedKn; motoring = true; }
        if (sp <= 0.3) continue;
        const bu = sp * Math.sin((hdg * Math.PI) / 180) + cu, bv = sp * Math.cos((hdg * Math.PI) / 180) + cv;
        const sog = Math.hypot(bu, bv), cog = ((Math.atan2(bu, bv) * 180) / Math.PI + 360) % 360;
        const remaining = distanceNm(nd, end);
        const stepNm = sog * dtH;
        // close enough to finish this step: head straight in
        if (remaining <= stepNm && Math.abs(((cog - toDest + 540) % 360) - 180) < 60) {
          const tArr = nd.t + (remaining / Math.max(sog, 0.5)) * 3600e3;
          if (!best || tArr < best.t) best = { lat: end.lat, lon: end.lon, t: tArr, parent: nd, info: { twsKn: tws, twdDeg: twd, twaDeg: Math.abs(twa), boatKn: sp, curKn: Math.hypot(cu, cv), motoring } };
          continue;
        }
        const [la, lo] = move(nd.lat, nd.lon, cog, stepNm);
        if (!corridor(la, lo)) continue; // stay where we have forecast data
        if (!legClear([nd.lat, nd.lon], [la, lo])) continue;
        const dStart = distanceNm(start, { lat: la, lon: lo });
        const relBrg = ((bearing(start, { lat: la, lon: lo }) - startBrg + 540) % 360) - 180;
        if (Math.abs(relBrg) > 100 && dStart > 30) continue; // don't wander backwards
        const bin = Math.round(relBrg / 1.5);
        // classic isochrone pruning: in each bearing slice from the start, keep the furthest point
        const score = dStart;
        if ((binDist.get(bin) ?? -Infinity) < score) {
          binDist.set(bin, score);
          bins.set(bin, { lat: la, lon: lo, t: nd.t + dtMs, parent: nd, info: { twsKn: tws, twdDeg: twd, twaDeg: Math.abs(twa), boatKn: sp, curKn: Math.hypot(cu, cv), motoring } });
        }
      }
    }
    if (best && [...bins.values()].every((b) => b.t >= best!.t)) { arrived = true; break; }
    frontier = [...bins.values()];
    if (stepI % 8 === 0) { onProgress(`Calculating… ${Math.round(((stepI + 1) * dtH) / 24 * 10) / 10} days simulated`); await new Promise((r) => setTimeout(r, 0)); }
  }
  if (best) arrived = true;

  let tail: Node | null = best;
  if (!tail) {
    // didn't arrive within the forecast: show the closest point reached
    tail = frontier.reduce<Node | null>((acc, nd) => (!acc || distanceNm(nd, end) < distanceNm(acc, end) ? nd : acc), null);
  }
  if (!tail) throw new Error('No route found: land or calms may be blocking the way.');
  const chain: Node[] = []; for (let c: Node | null = tail; c; c = c.parent) chain.push(c); chain.reverse();
  const points: PassagePoint[] = chain.map((c, i) => {
    const nextInfo = chain[i + 1]?.info ?? c.info;
    return { t: c.t, lat: c.lat, lon: c.lon, twsKn: nextInfo?.twsKn ?? 0, twdDeg: nextInfo?.twdDeg ?? 0, twaDeg: nextInfo?.twaDeg ?? 0, boatKn: nextInfo?.boatKn ?? 0, curKn: nextInfo?.curKn ?? 0, motoring: nextInfo?.motoring ?? false };
  });
  let dist = 0; for (let i = 1; i < points.length; i++) dist += distanceNm(points[i - 1]!, points[i]!);
  const maxTws = Math.max(...points.map((p) => p.twsKn));
  const strongHours = points.filter((p) => p.twsKn >= opt.maxWindKn).length * dtH;
  const motorHours = points.filter((p) => p.motoring).length * dtH;
  const hours = (tail.t - t0) / 3600e3;
  return {
    points, distanceNm: dist, hours, arrived, maxTws, strongHours, motorHours, currentIncluded: !!grids.current,
    note: arrived ? null : `The forecast only runs ${Math.round((grids.forecastEnd - t0) / 86400e3)} days; the route stops where the forecast ends.`,
  };
}

/** Passage through several points; each leg departs when the previous one arrives. */
export async function passageRouteVia(points: LatLon[], opt: PassageOptions, onProgress: (m: string) => void): Promise<PassageResult> {
  let all: PassagePoint[] = []; let dist = 0; let maxTws = 0, strong = 0, motor = 0; let cur = true; let dep = opt.departure;
  for (let i = 1; i < points.length; i++) {
    const legName = points.length > 2 ? `Leg ${i} of ${points.length - 1}: ` : '';
    const r = await passageRoute(points[i - 1]!, points[i]!, { ...opt, departure: dep }, (m) => onProgress(legName + m));
    all = all.length ? [...all, ...r.points.slice(1)] : r.points;
    dist += r.distanceNm; maxTws = Math.max(maxTws, r.maxTws); strong += r.strongHours; motor += r.motorHours; cur = cur && r.currentIncluded;
    if (!r.arrived) return { points: all, distanceNm: dist, hours: (all.at(-1)!.t - all[0]!.t) / 3600e3, arrived: false, maxTws, strongHours: strong, motorHours: motor, currentIncluded: cur, note: `${legName}${r.note ?? 'Did not arrive.'}` };
    dep = new Date(r.points.at(-1)!.t);
  }
  return { points: all, distanceNm: dist, hours: (all.at(-1)!.t - all[0]!.t) / 3600e3, arrived: true, maxTws, strongHours: strong, motorHours: motor, currentIncluded: cur, note: null };
}
