import type { LatLon } from '../types.ts';

/**
 * Navigation math on the WGS84 ellipsoid (the same model GPS and charts use).
 * Uses Vincenty's inverse formula, accurate to well under a metre.
 * Validated in tests against PostGIS's independent implementation.
 *
 * These are planning calculations. The app must not present them as a
 * replacement for certified navigation equipment.
 */

const A = 6378137.0;              // WGS84 semi-major axis (m)
const F = 1 / 298.257223563;      // WGS84 flattening
const B = (1 - F) * A;
export const METRES_PER_NM = 1852;

const toRad = (d: number) => (d * Math.PI) / 180;
const toDeg = (r: number) => (r * 180) / Math.PI;
const norm360 = (d: number) => ((d % 360) + 360) % 360;

export interface Inverse {
  distanceM: number;
  initialBearingDeg: number; // true bearing at start
  finalBearingDeg: number;   // true bearing on arrival
}

export function inverse(p1: LatLon, p2: LatLon): Inverse {
  validate(p1);
  validate(p2);
  if (p1.lat === p2.lat && p1.lon === p2.lon) {
    return { distanceM: 0, initialBearingDeg: 0, finalBearingDeg: 0 };
  }
  const L = toRad(p2.lon - p1.lon);
  const U1 = Math.atan((1 - F) * Math.tan(toRad(p1.lat)));
  const U2 = Math.atan((1 - F) * Math.tan(toRad(p2.lat)));
  const sinU1 = Math.sin(U1), cosU1 = Math.cos(U1);
  const sinU2 = Math.sin(U2), cosU2 = Math.cos(U2);

  let lambda = L;
  let sinSigma = 0, cosSigma = 0, sigma = 0, cosSqAlpha = 0, cos2SigmaM = 0;
  let sinLambda = 0, cosLambda = 0;
  let converged = false;
  for (let i = 0; i < 200; i++) {
    sinLambda = Math.sin(lambda);
    cosLambda = Math.cos(lambda);
    sinSigma = Math.sqrt(
      (cosU2 * sinLambda) ** 2 + (cosU1 * sinU2 - sinU1 * cosU2 * cosLambda) ** 2,
    );
    if (sinSigma === 0) return { distanceM: 0, initialBearingDeg: 0, finalBearingDeg: 0 };
    cosSigma = sinU1 * sinU2 + cosU1 * cosU2 * cosLambda;
    sigma = Math.atan2(sinSigma, cosSigma);
    const sinAlpha = (cosU1 * cosU2 * sinLambda) / sinSigma;
    cosSqAlpha = 1 - sinAlpha ** 2;
    cos2SigmaM = cosSqAlpha !== 0 ? cosSigma - (2 * sinU1 * sinU2) / cosSqAlpha : 0;
    const C = (F / 16) * cosSqAlpha * (4 + F * (4 - 3 * cosSqAlpha));
    const prev = lambda;
    lambda = L + (1 - C) * F * sinAlpha *
      (sigma + C * sinSigma * (cos2SigmaM + C * cosSigma * (-1 + 2 * cos2SigmaM ** 2)));
    if (Math.abs(lambda - prev) < 1e-12) { converged = true; break; }
  }
  if (!converged) {
    // Near-antipodal points: Vincenty may not converge. Refuse rather than guess.
    throw new Error('Distance calculation did not converge (near-antipodal points)');
  }
  const uSq = (cosSqAlpha * (A * A - B * B)) / (B * B);
  const bigA = 1 + (uSq / 16384) * (4096 + uSq * (-768 + uSq * (320 - 175 * uSq)));
  const bigB = (uSq / 1024) * (256 + uSq * (-128 + uSq * (74 - 47 * uSq)));
  const deltaSigma = bigB * sinSigma * (cos2SigmaM + (bigB / 4) *
    (cosSigma * (-1 + 2 * cos2SigmaM ** 2) -
      (bigB / 6) * cos2SigmaM * (-3 + 4 * sinSigma ** 2) * (-3 + 4 * cos2SigmaM ** 2)));
  const distanceM = B * bigA * (sigma - deltaSigma);
  const a1 = Math.atan2(cosU2 * sinLambda, cosU1 * sinU2 - sinU1 * cosU2 * cosLambda);
  const a2 = Math.atan2(cosU1 * sinLambda, -sinU1 * cosU2 + cosU1 * sinU2 * cosLambda);
  return { distanceM, initialBearingDeg: norm360(toDeg(a1)), finalBearingDeg: norm360(toDeg(a2)) };
}

export function distanceNm(p1: LatLon, p2: LatLon): number {
  return inverse(p1, p2).distanceM / METRES_PER_NM;
}

/** Total length of a route through waypoints, in nautical miles. */
export function routeDistanceNm(points: LatLon[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += distanceNm(points.at(i - 1)!, points.at(i)!);
  }
  return total;
}

/** Hours to cover a distance at a speed. Throws on non-positive speed. */
export function etaHours(distNm: number, speedKn: number): number {
  if (!(speedKn > 0)) throw new Error('Speed must be greater than zero');
  if (distNm < 0) throw new Error('Distance cannot be negative');
  return distNm / speedKn;
}

function validate(p: LatLon): void {
  if (!Number.isFinite(p.lat) || !Number.isFinite(p.lon) || p.lat < -90 || p.lat > 90 || p.lon < -180 || p.lon > 180) {
    throw new RangeError(`Invalid coordinate: ${p.lat}, ${p.lon}`);
  }
}
