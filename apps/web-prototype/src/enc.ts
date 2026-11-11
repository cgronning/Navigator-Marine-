/**
 * NOAA ENC Direct (official electronic chart data as GIS layers).
 * Used for: rock positions (drawn orange) and depth at a tapped point.
 * Depths in NOAA ENCs are metres below chart datum (MLLW); converted to feet here.
 */
import { distanceNm, METRES_PER_NM } from '../../../packages/core/src/geo/nav.ts';
import type { LatLon } from './data.ts';

const BASE = 'https://encdirect.noaa.gov/arcgis/rest/services/encdirect';
const FT_PER_M = 3.28084;

// Layer ids per chart scale (from each service's /layers listing)
const SCALES = [
  { svc: 'enc_harbour', rock: 34, sounding: 76, depthArea: 227 },
  { svc: 'enc_approach', rock: 37, sounding: 80, depthArea: 232 },
  { svc: 'enc_coastal', rock: 31, sounding: 61, depthArea: 166 },
] as const;

async function query<T>(svc: string, layer: number, params: Record<string, string>, timeoutMs = 15000): Promise<T> {
  const qs = new URLSearchParams({ inSR: '4326', outSR: '4326', spatialRel: 'esriSpatialRelIntersects', f: 'json', ...params });
  const res = await fetch(`${BASE}/${svc}/MapServer/${layer}/query?${qs}`, { signal: AbortSignal.timeout(timeoutMs) });
  const j = await res.json();
  if (j.error) throw new Error(j.error.message ?? 'ENC query failed');
  return j as T;
}

interface EsriPoint { attributes: Record<string, unknown>; geometry?: { x: number; y: number; z?: number } }

// ---------------------------------------------------------------- rocks
export interface Rock { id: string; lat: number; lon: number; watlev: number | null; valsouFt: number | null; name: string | null }

export const WATLEV_LABEL: Record<number, string> = {
  1: 'Partly submerged at high water', 2: 'Always dry', 3: 'Always underwater',
  4: 'Covers and uncovers with the tide', 5: 'Awash', 6: 'Subject to flooding', 7: 'Floating',
};

export async function rocksInView(b: { s: number; w: number; n: number; e: number }, zoom: number): Promise<Rock[]> {
  const scale = zoom >= 13 ? SCALES[0] : SCALES[1];
  const env = JSON.stringify({ xmin: b.w, ymin: b.s, xmax: b.e, ymax: b.n, spatialReference: { wkid: 4326 } });
  const tryScales = scale === SCALES[0] ? [SCALES[0], SCALES[1]] : [SCALES[1], SCALES[2]];
  let lastErr: unknown;
  for (const sc of tryScales) {
    try {
      const j = await query<{ features: EsriPoint[] }>(sc.svc, sc.rock, {
        where: '1=1', geometry: env, geometryType: 'esriGeometryEnvelope',
        outFields: 'WATLEV,VALSOU,OBJNAM', returnGeometry: 'true', resultRecordCount: '2000',
      });
      return j.features.filter((f) => f.geometry).map((f, i) => {
        const a = f.attributes;
        const valsou = typeof a['VALSOU'] === 'number' ? (a['VALSOU'] as number) : null;
        return {
          id: `${sc.svc}-${i}-${f.geometry!.x.toFixed(5)}-${f.geometry!.y.toFixed(5)}`,
          lat: f.geometry!.y, lon: f.geometry!.x,
          watlev: typeof a['WATLEV'] === 'number' ? (a['WATLEV'] as number) : null,
          valsouFt: valsou === null ? null : valsou * FT_PER_M,
          name: typeof a['OBJNAM'] === 'string' && a['OBJNAM'] ? (a['OBJNAM'] as string) : null,
        };
      });
    } catch (e) { lastErr = e; }
  }
  throw lastErr ?? new Error('Rocks unavailable');
}

// ---------------------------------------------------------------- depth at a point
export interface DepthInfo {
  areaMinFt: number | null;   // depth area range (DRVAL1..DRVAL2)
  areaMaxFt: number | null;
  sounding: { ft: number; distYd: number } | null; // nearest charted sounding
  onLand: boolean;
  scale: string | null;
}

export async function depthAt(p: LatLon): Promise<DepthInfo> {
  const pt = JSON.stringify({ x: p.lon, y: p.lat, spatialReference: { wkid: 4326 } });
  // soundings within ~250 m
  const d = 0.0035;
  const env = JSON.stringify({ xmin: p.lon - d * 1.35, ymin: p.lat - d, xmax: p.lon + d * 1.35, ymax: p.lat + d, spatialReference: { wkid: 4326 } });

  let anyAnswered = false;
  for (const sc of SCALES) {
    const [area, snd] = await Promise.all([
      query<{ features: EsriPoint[] }>(sc.svc, sc.depthArea, { geometry: pt, geometryType: 'esriGeometryPoint', outFields: 'DRVAL1,DRVAL2', returnGeometry: 'false' }).catch(() => null),
      query<{ features: EsriPoint[] }>(sc.svc, sc.sounding, { where: '1=1', geometry: env, geometryType: 'esriGeometryEnvelope', outFields: 'Z', returnGeometry: 'true', returnZ: 'true', resultRecordCount: '300' }).catch(() => null),
    ]);
    if (area || snd) anyAnswered = true;
    const a = area?.features.at(0)?.attributes;
    let sounding: DepthInfo['sounding'] = null;
    for (const f of snd?.features ?? []) {
      const z = typeof f.attributes['Z'] === 'number' ? (f.attributes['Z'] as number) : f.geometry?.z;
      if (z === undefined || z === null || !f.geometry) continue;
      const distYd = (distanceNm(p, { lat: f.geometry.y, lon: f.geometry.x }) * METRES_PER_NM) / 0.9144;
      if (!sounding || distYd < sounding.distYd) sounding = { ft: z * FT_PER_M, distYd };
    }
    if (a || sounding) {
      const d1 = typeof a?.['DRVAL1'] === 'number' ? (a['DRVAL1'] as number) : null;
      const d2 = typeof a?.['DRVAL2'] === 'number' ? (a['DRVAL2'] as number) : null;
      return { areaMinFt: d1 === null ? null : d1 * FT_PER_M, areaMaxFt: d2 === null ? null : d2 * FT_PER_M, sounding, onLand: false, scale: sc.svc.replace('enc_', '') };
    }
  }
  if (!anyAnswered) throw new Error('NOAA chart data unavailable');
  return { areaMinFt: null, areaMaxFt: null, sounding: null, onLand: true, scale: null };
}
