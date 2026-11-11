/**
 * Coastal auto-routing that avoids rocks, shallow water and land.
 *
 * 1. Fetch NOAA chart depth areas, land, rocks, obstructions and wrecks for the area.
 * 2. Paint them onto a fine grid: a cell is navigable only if its charted depth
 *    (shallowest value of the depth area) is at least draft + safety margin,
 *    and it's outside a buffer around every hazard that could be too shallow.
 * 3. Find the shortest path with A*, keeping a little extra distance from hazards.
 * 4. Straighten the path into a few legs, only where the straight line is clear.
 *
 * Planning aid only. Charts can be wrong or out of date.
 */
import { distanceNm } from '../../../packages/core/src/geo/nav.ts';
import type { LatLon } from './data.ts';

const BASE = 'https://encdirect.noaa.gov/arcgis/rest/services/encdirect';
// Chart scales, least detailed first so detailed charts are painted on top.
const SCALES = ['enc_coastal', 'enc_approach', 'enc_harbour'] as const;
const KNOWN: Record<string, Partial<Record<LayerKey, number>>> = {
  enc_coastal: { depth: 166, dredged: 167, land: 171, shore: 105, rock: 31, obst: 30, wreck: 33 },
  enc_approach: { depth: 232, dredged: 233, land: 238, shore: 143, rock: 37, obst: 36, wreck: 39 },
  enc_harbour: { depth: 227, rock: 34, obst: 33, wreck: 36 },
};
type LayerKey = 'depth' | 'dredged' | 'land' | 'shore' | 'rock' | 'obst' | 'wreck';
const PATTERNS: Record<LayerKey, RegExp> = {
  depth: /\.Depth_Area$/, dredged: /\.Dredged_Area$/, land: /\.Land_Area$/, shore: /\.Shoreline_Construction_area$/,
  rock: /\.Underwater_Awash_Rock_point$/, obst: /\.Obstruction_point$/, wreck: /\.Wreck_point$/,
};
const idCache = new Map<string, Promise<Partial<Record<LayerKey, number>>>>();
function layerIds(svc: string): Promise<Partial<Record<LayerKey, number>>> {
  if (!idCache.has(svc)) {
    idCache.set(svc, (async () => {
      for (let a = 0; a < 6; a++) {
        try {
          const j = await fetch(`${BASE}/${svc}/MapServer/layers?f=json`, { signal: AbortSignal.timeout(10000) }).then((r) => r.json());
          if (!j.layers) throw new Error('no layers');
          const ids: Partial<Record<LayerKey, number>> = {};
          for (const l of j.layers as { id: number; name: string }[]) for (const k of Object.keys(PATTERNS) as LayerKey[]) if (ids[k] === undefined && PATTERNS[k].test(l.name)) ids[k] = l.id;
          return { ...KNOWN[svc], ...ids };
        } catch { await new Promise((r) => setTimeout(r, 250 * (a + 1))); }
      }
      return KNOWN[svc] ?? {};
    })());
  }
  return idCache.get(svc)!;
}

interface EsriFeature { attributes: Record<string, unknown>; geometry?: { rings?: number[][][]; x?: number; y?: number } }

async function query(svc: string, layer: number, env: string, fields: string, offset: number): Promise<EsriFeature[]> {
  const all: EsriFeature[] = [];
  // NOAA caps each response (typically 1000-2000 features); page through until complete
  for (let page = 0; page < 20; page++) {
    const qs = new URLSearchParams({
      where: '1=1', geometry: env, geometryType: 'esriGeometryEnvelope', inSR: '4326', outSR: '4326',
      spatialRel: 'esriSpatialRelIntersects', outFields: fields, returnGeometry: 'true',
      maxAllowableOffset: String(offset), geometryPrecision: '6', resultOffset: String(all.length), resultRecordCount: '1000',
      orderByFields: 'OBJECTID', f: 'json',
    });
    let j: { features: EsriFeature[]; exceededTransferLimit?: boolean } | null = null;
    let lastErr: unknown;
    for (let a = 0; a < 5 && !j; a++) {
      try {
        const r = await fetch(`${BASE}/${svc}/MapServer/${layer}/query?${qs}`, { signal: AbortSignal.timeout(25000) }).then((x) => x.json());
        if (r.error) throw new Error(r.error.message);
        j = r;
      } catch (e) { lastErr = e; await new Promise((res) => setTimeout(res, 200 * (a + 1))); }
    }
    if (!j) throw lastErr;
    all.push(...j.features);
    if (!j.exceededTransferLimit || j.features.length === 0) break;
  }
  return all;
}

export interface CoastalOptions { draftFt: number; marginFt: number; hazardBufferM: number }
export interface CoastalResult {
  path: LatLon[];               // smoothed legs, start -> end
  distanceNm: number;
  shallowestFt: number | null;  // shallowest charted depth area the route crosses
  snapped: { start: number; end: number }; // metres moved to reach navigable water
  gridCellM: number;
}

export class RouteError extends Error {}

/** Route through several points in order (start, any waypoints, destination). */
export async function coastalRouteVia(points: LatLon[], opt: CoastalOptions, onProgress: (msg: string) => void): Promise<CoastalResult> {
  const path: LatLon[] = []; let dist = 0; let shallow: number | null = null; let snapped = { start: 0, end: 0 }; let cell = 0;
  for (let i = 1; i < points.length; i++) {
    const legName = points.length > 2 ? `Leg ${i} of ${points.length - 1}: ` : '';
    let r: CoastalResult;
    try { r = await coastalRoute(points[i - 1]!, points[i]!, opt, (m) => onProgress(legName + m)); }
    catch (e) { throw new RouteError(legName + (e instanceof Error ? e.message : 'failed')); }
    path.push(...(i === 1 ? r.path : r.path.slice(1)));
    dist += r.distanceNm; cell = Math.max(cell, r.gridCellM);
    if (r.shallowestFt !== null) shallow = shallow === null ? r.shallowestFt : Math.min(shallow, r.shallowestFt);
    if (i === 1) snapped.start = r.snapped.start;
    snapped.end = r.snapped.end;
  }
  return { path, distanceNm: dist, shallowestFt: shallow, snapped, gridCellM: cell };
}

export async function coastalRoute(start: LatLon, end: LatLon, opt: CoastalOptions, onProgress: (msg: string) => void): Promise<CoastalResult> {
  const span = distanceNm(start, end);
  if (span > 60) throw new RouteError('That’s more than 60 nm. Use Passage routing for longer trips.');
  // Try a tight search area first; if land (e.g. an island) forces a detour outside it, widen and retry.
  const spanDeg = Math.max(Math.abs(start.lat - end.lat), Math.abs(start.lon - end.lon));
  const pads = [Math.max(0.03, spanDeg * 0.3), Math.max(0.08, spanDeg * 0.8), Math.max(0.16, spanDeg * 1.5)];
  let lastErr: unknown = null;
  for (let i = 0; i < pads.length; i++) {
    try { return await coastalRouteOnce(start, end, opt, pads[i]!, (m) => onProgress(i ? `${m} (wider search)` : m)); }
    catch (e) {
      lastErr = e;
      if (!(e instanceof NoPathError)) throw e;
    }
  }
  throw lastErr instanceof Error ? new RouteError(lastErr.message) : new RouteError('No safe route found.');
}

class NoPathError extends RouteError {}

async function coastalRouteOnce(start: LatLon, end: LatLon, opt: CoastalOptions, pad: number, onProgress: (msg: string) => void): Promise<CoastalResult> {
  const needM = (opt.draftFt + opt.marginFt) / 3.28084;

  // ---- area and grid
  const padLat = pad;
  const padLon = pad * 1.3;
  const s = Math.min(start.lat, end.lat) - padLat, n = Math.max(start.lat, end.lat) + padLat;
  const w = Math.min(start.lon, end.lon) - padLon, e = Math.max(start.lon, end.lon) + padLon;
  const midLat = (s + n) / 2;
  const mPerDegLat = 111_320, mPerDegLon = 111_320 * Math.cos((midLat * Math.PI) / 180);
  const widthM = (e - w) * mPerDegLon, heightM = (n - s) * mPerDegLat;
  const cell = Math.max(25, Math.max(widthM, heightM) / 1400);
  const W = Math.ceil(widthM / cell), H = Math.ceil(heightM / cell);
  const toPx = (lat: number, lon: number): [number, number] => [((lon - w) * mPerDegLon) / cell, ((n - lat) * mPerDegLat) / cell];
  const toLL = (x: number, y: number): LatLon => ({ lat: n - ((y + 0.5) * cell) / mPerDegLat, lon: w + ((x + 0.5) * cell) / mPerDegLon });

  // ---- fetch chart data
  onProgress('Loading NOAA chart depths and hazards…');
  const env = JSON.stringify({ xmin: w, ymin: s, xmax: e, ymax: n, spatialReference: { wkid: 4326 } });
  const offset = (cell / mPerDegLat) * 0.5;
  const perScale = await Promise.all(SCALES.map(async (svc) => {
    const ids = await layerIds(svc);
    const get = (k: LayerKey, fields: string, off: number) => (ids[k] !== undefined ? query(svc, ids[k]!, env, fields, off) : Promise.resolve([] as EsriFeature[]));
    const [depth, dredged, land, shore, rock, obst, wreck] = await Promise.all([
      get('depth', 'DRVAL1,OBJECTID', offset).catch(() => null),
      get('dredged', 'DRVAL1,OBJECTID', offset).catch(() => []),
      get('land', 'OBJECTID', offset).catch(() => []),
      get('shore', 'OBJECTID', offset).catch(() => []),
      get('rock', 'VALSOU,WATLEV,OBJECTID', 0).catch(() => []),
      get('obst', 'VALSOU,WATLEV,OBJECTID', 0).catch(() => []),
      get('wreck', 'VALSOU,WATLEV,OBJECTID', 0).catch(() => []),
    ]);
    return { depth, dredged, land: [...land, ...shore], hazards: [...rock, ...obst, ...wreck] };
  }));
  if (perScale.every((p) => !p.depth || p.depth.length === 0)) throw new RouteError('No NOAA chart depth data for this area (or the chart server is down). Try again in a moment.');

  // ---- paint the grid: R = navigable, G = shallowest depth (dm, capped)
  onProgress('Mapping safe water…');
  const cv = new OffscreenCanvas(W, H);
  const ctx = cv.getContext('2d', { willReadFrequently: true })!;
  ctx.fillStyle = 'rgb(0,0,0)'; ctx.fillRect(0, 0, W, H);
  // Chart cells meet along shared edges; filling each polygon separately leaves hairline
  // anti-aliased seams that would look like walls. So: paint deep-enough areas with a thin
  // matching outline (closes seams), then paint too-shallow areas on top without one
  // (keeps every shallow boundary conservative), then land.
  const ringPath = (rings: number[][][]) => {
    ctx.beginPath();
    for (const ring of rings) ring.forEach(([lon, lat], i) => { const [x, y] = toPx(lat!, lon!); if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); });
  };
  for (const sc of perScale) {
    const areas = [...(sc.depth ?? []), ...sc.dredged].map((f) => ({ f, d1: typeof f.attributes['DRVAL1'] === 'number' ? (f.attributes['DRVAL1'] as number) : -1 }));
    ctx.lineWidth = 1.6; ctx.lineJoin = 'round';
    for (const { f, d1 } of areas) {
      if (d1 < needM || !f.geometry?.rings) continue;
      const g = Math.max(0, Math.min(255, Math.round(d1 * 10)));
      ringPath(f.geometry.rings); ctx.fillStyle = ctx.strokeStyle = `rgb(255,${g},0)`; ctx.fill('evenodd'); ctx.stroke();
    }
    for (const { f, d1 } of areas) {
      if (d1 >= needM || !f.geometry?.rings) continue;
      const g = Math.max(0, Math.min(255, Math.round(Math.max(0, d1) * 10)));
      ringPath(f.geometry.rings); ctx.fillStyle = `rgb(0,${g},0)`; ctx.fill('evenodd');
    }
    for (const f of sc.land) if (f.geometry?.rings) { ringPath(f.geometry.rings); ctx.fillStyle = 'rgb(0,0,0)'; ctx.fill('evenodd'); }
  }
  // hazards: buffer around anything not known to be deep enough
  const bufPx = Math.max(1.5, opt.hazardBufferM / cell);
  ctx.fillStyle = 'rgb(0,0,0)';
  let hazardCount = 0;
  for (const sc of perScale) for (const f of sc.hazards) {
    const v = typeof f.attributes['VALSOU'] === 'number' ? (f.attributes['VALSOU'] as number) : null;
    if (v !== null && v >= needM + 1) continue; // charted well below our draft
    if (f.geometry?.x === undefined || f.geometry.y === undefined) continue;
    const [x, y] = toPx(f.geometry.y, f.geometry.x);
    ctx.beginPath(); ctx.arc(x, y, bufPx, 0, Math.PI * 2); ctx.fill(); hazardCount++;
  }
  const px = ctx.getImageData(0, 0, W, H).data;
  const N = W * H;
  const free = new Uint8Array(N), depthDm = new Uint8Array(N);
  for (let i = 0; i < N; i++) { free[i] = px[i * 4]! > 200 ? 1 : 0; depthDm[i] = px[i * 4 + 1]!; }

  // ---- clearance (cells to nearest blocked), two-pass chamfer
  const clr = new Float32Array(N).fill(1e9);
  for (let i = 0; i < N; i++) if (!free[i]) clr[i] = 0;
  const D1 = 1, D2 = Math.SQRT2;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x; let v = clr[i]!;
    if (x > 0) v = Math.min(v, clr[i - 1]! + D1);
    if (y > 0) { v = Math.min(v, clr[i - W]! + D1); if (x > 0) v = Math.min(v, clr[i - W - 1]! + D2); if (x < W - 1) v = Math.min(v, clr[i - W + 1]! + D2); }
    clr[i] = v;
  }
  for (let y = H - 1; y >= 0; y--) for (let x = W - 1; x >= 0; x--) {
    const i = y * W + x; let v = clr[i]!;
    if (x < W - 1) v = Math.min(v, clr[i + 1]! + D1);
    if (y < H - 1) { v = Math.min(v, clr[i + W]! + D1); if (x < W - 1) v = Math.min(v, clr[i + W + 1]! + D2); if (x > 0) v = Math.min(v, clr[i + W - 1]! + D2); }
    clr[i] = v;
  }

  // ---- snap start/end to nearest navigable cell (within 600 m)
  const snap = (p: LatLon): { idx: number; movedM: number } => {
    const [fx, fy] = toPx(p.lat, p.lon); const cx = Math.floor(fx), cy = Math.floor(fy);
    const maxR = Math.ceil(600 / cell);
    let best = -1, bestD = Infinity;
    for (let r = 0; r <= maxR && best < 0; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
      const x = cx + dx, y = cy + dy; if (x < 0 || y < 0 || x >= W || y >= H) continue;
      const i = y * W + x; if (!free[i] || clr[i]! < 1.5) continue;
      const d = Math.hypot(dx, dy); if (d < bestD) { bestD = d; best = i; }
    }
    if (best < 0) throw new RouteError('A start or end point is more than 600 m from water deep enough for your boat. Move it out into the channel.');
    return { idx: best, movedM: bestD * cell };
  };
  const a = snap(start), b = snap(end);
  const dbg = (globalThis as unknown as { __routeDebug?: unknown[] }).__routeDebug;
  if (dbg) dbg.push({ W, H, cell, free: free.slice(), clr: clr.slice(), a: a.idx, b: b.idx, counts: perScale.map((p) => [p.depth?.length ?? -1, p.dredged.length, p.land.length, p.hazards.length]) });

  // ---- A* (8-connected) with a penalty for hugging hazards
  onProgress('Finding the shortest safe route…');
  const g = new Float32Array(N).fill(Infinity), came = new Int32Array(N).fill(-1), closed = new Uint8Array(N);
  const bx = b.idx % W, by = (b.idx / W) | 0;
  const h = (i: number) => { const dx = Math.abs((i % W) - bx), dy = Math.abs(((i / W) | 0) - by); return (dx + dy) + (Math.SQRT2 - 2) * Math.min(dx, dy); };
  const keepOff = Math.max(2, 60 / cell); // prefer ~60 m from hazards
  const heap = new MinHeap(); g[a.idx] = 0; heap.push(a.idx, h(a.idx));
  const nb = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2]] as const;
  let found = false, iter = 0;
  while (heap.size) {
    const cur = heap.pop(); if (closed[cur]) continue; closed[cur] = 1;
    if (cur === b.idx) { found = true; break; }
    if (++iter > 4_000_000) break;
    const x = cur % W, y = (cur / W) | 0;
    for (const [dx, dy, c] of nb) {
      const nx = x + dx, ny = y + dy; if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const ni = ny * W + nx; if (!free[ni] || closed[ni]) continue;
      if (dx && dy && (!free[y * W + nx] || !free[ny * W + x])) continue; // no corner cutting
      const pen = clr[ni]! < keepOff ? (keepOff - clr[ni]!) * 0.6 : 0;
      const ng = g[cur]! + c * (1 + pen);
      if (ng < g[ni]!) { g[ni] = ng; came[ni] = cur; heap.push(ni, ng + h(ni)); }
    }
  }
  if (!found) throw new NoPathError('No safe route found at this draft. The only ways through may be too shallow, or blocked by charted hazards.');

  const cells: number[] = []; for (let c = b.idx; c !== -1; c = came[c]!) cells.push(c); cells.reverse();

  // ---- straighten: keep a leg only if the straight line stays in clear water
  const clearLine = (i0: number, i1: number) => {
    let x0 = i0 % W, y0 = (i0 / W) | 0; const x1 = i1 % W, y1 = (i1 / W) | 0;
    const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1; let err = dx + dy;
    for (;;) {
      const i = y0 * W + x0; if (!free[i] || clr[i]! < Math.min(keepOff, 2)) return false;
      if (x0 === x1 && y0 === y1) return true;
      const e2 = 2 * err; if (e2 >= dy) { err += dy; x0 += sx; } if (e2 <= dx) { err += dx; y0 += sy; }
    }
  };
  const legs: number[] = [cells[0]!]; let anchor = 0;
  for (let k = 2; k < cells.length; k++) if (!clearLine(cells[anchor]!, cells[k]!)) { legs.push(cells[k - 1]!); anchor = k - 1; }
  legs.push(cells.at(-1)!);

  let shallow = 255;
  for (const c of cells) if (depthDm[c]! < shallow) shallow = depthDm[c]!;
  const path = legs.map((c) => toLL(c % W, (c / W) | 0));
  if (a.movedM > cell) path.unshift(start);
  if (b.movedM > cell) path.push(end);
  let dist = 0; for (let k = 1; k < path.length; k++) dist += distanceNm(path[k - 1]!, path[k]!);
  void hazardCount;
  return { path, distanceNm: dist, shallowestFt: shallow >= 255 ? null : (shallow / 10) * 3.28084, snapped: { start: a.movedM, end: b.movedM }, gridCellM: cell };
}

class MinHeap {
  private ids: number[] = []; private keys: number[] = [];
  get size() { return this.ids.length; }
  push(id: number, k: number) {
    const ids = this.ids, keys = this.keys; let i = ids.length; ids.push(id); keys.push(k);
    while (i > 0) { const p = (i - 1) >> 1; if (keys[p]! <= k) break; ids[i] = ids[p]!; keys[i] = keys[p]!; i = p; }
    ids[i] = id; keys[i] = k;
  }
  pop(): number {
    const ids = this.ids, keys = this.keys; const top = ids[0]!; const lastId = ids.pop()!, lastK = keys.pop()!;
    if (ids.length) {
      let i = 0; const n = ids.length;
      for (;;) { let l = 2 * i + 1; if (l >= n) break; const r = l + 1; if (r < n && keys[r]! < keys[l]!) l = r; if (keys[l]! >= lastK) break; ids[i] = ids[l]!; keys[i] = keys[l]!; i = l; }
      ids[i] = lastId; keys[i] = lastK;
    }
    return top;
  }
}
