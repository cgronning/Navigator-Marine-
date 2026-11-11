/**
 * Shared domain types used by the apps, the API and the data workers.
 * Every externally sourced record carries provenance so the UI can show
 * how fresh and how trustworthy it is.
 */

export interface LatLon {
  lat: number; // decimal degrees, WGS84, -90..90
  lon: number; // decimal degrees, WGS84, -180..180
}

export interface BBox {
  south: number;
  west: number;
  north: number;
  east: number;
}

export interface Provenance {
  provider: string;   // key in app.data_providers
  fetchedAt: string;  // ISO time we received it
  attribution?: string;
}

export type PositionSource =
  | 'ais_terrestrial'
  | 'ais_satellite'
  | 'own_receiver'
  | 'app_gps'
  | 'onboard_gateway'
  | 'manual';

/** How the UI must label a position. Never shown as "live" unless it is. */
export type Freshness = 'live' | 'delayed' | 'stale' | 'unknown';

export interface VesselPosition extends Provenance {
  mmsi: string;
  position: LatLon;
  sogKn?: number;
  cogDeg?: number;
  headingDeg?: number;
  navStatus?: number;
  reportedAt: string; // when the vessel transmitted it
  source: PositionSource;
  /** Always false for raw data. True only for display-time estimates. */
  isInterpolated: false;
}

export interface VesselStatic extends Provenance {
  mmsi: string;
  imo?: string;
  name?: string;
  callSign?: string;
  aisShipType?: number;
  lengthM?: number;
  beamM?: number;
  destination?: string;
  etaReported?: string;
}

/** Freshness thresholds in seconds; tuned per source later. */
export const FRESHNESS_THRESHOLDS = { live: 180, delayed: 1800 } as const;

export function freshnessOf(reportedAt: string, now: Date = new Date()): Freshness {
  const t = Date.parse(reportedAt);
  if (Number.isNaN(t)) return 'unknown';
  const ageS = (now.getTime() - t) / 1000;
  if (ageS < 0) return 'unknown'; // clock skew or bad data: don't claim live
  if (ageS <= FRESHNESS_THRESHOLDS.live) return 'live';
  if (ageS <= FRESHNESS_THRESHOLDS.delayed) return 'delayed';
  return 'stale';
}
