import type { BBox, VesselPosition, VesselStatic } from '../types.ts';

/**
 * Every AIS supplier (aisstream.io, Spire, MarineTraffic/Kpler, VesselFinder,
 * our own receivers) is wrapped in this one interface. The rest of the
 * system never talks to a supplier directly, so suppliers can be swapped or
 * combined without touching the apps.
 */
export interface AisProvider {
  readonly key: string; // matches app.data_providers.key
  readonly coverage: 'terrestrial' | 'satellite' | 'hybrid';

  /** Open a live stream for an area. Returns a function that stops it. */
  stream(area: BBox[], handlers: AisStreamHandlers): Promise<() => void>;

  /** One-off lookups; optional because free feeds often lack them. */
  searchByName?(query: string, limit?: number): Promise<VesselStatic[]>;
  getByMmsi?(mmsi: string): Promise<VesselStatic | null>;
  getByImo?(imo: string): Promise<VesselStatic | null>;
  history?(mmsi: string, from: Date, to: Date): Promise<VesselPosition[]>;
}

export interface AisStreamHandlers {
  onPosition(p: VesselPosition): void;
  onStatic(s: VesselStatic): void;
  onError(err: Error): void;
}

/** Combines several providers; when two report the same ship, the newest report wins. */
export function newestWins(a: VesselPosition, b: VesselPosition): VesselPosition {
  return Date.parse(a.reportedAt) >= Date.parse(b.reportedAt) ? a : b;
}

const MMSI_RE = /^[0-9]{9}$/;
const IMO_RE = /^[0-9]{7}$/;

export function isValidMmsi(v: string): boolean {
  return MMSI_RE.test(v);
}

/** IMO numbers carry a check digit: digits 1-6 weighted 7..2, sum mod 10 = digit 7. */
export function isValidImo(v: string): boolean {
  if (!IMO_RE.test(v)) return false;
  const d = v.split('').map(Number);
  const sum = d.slice(0, 6).reduce((acc, n, i) => acc + n * (7 - i), 0);
  return sum % 10 === d[6];
}

/** Rejects positions AIS uses as "not available" and impossible values. */
export function isPlausiblePosition(p: Pick<VesselPosition, 'position' | 'sogKn'>): boolean {
  const { lat, lon } = p.position;
  if (lat === 91 || lon === 181) return false; // AIS "not available" sentinels
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return false;
  if (lat === 0 && lon === 0) return false; // common GPS failure
  if (p.sogKn !== undefined && (p.sogKn < 0 || p.sogKn > 102.2)) return false; // 102.3 = n/a
  return true;
}
