import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { inverse, distanceNm, routeDistanceNm, etaHours } from '../src/geo/nav.ts';
import { isValidImo, isValidMmsi, isPlausiblePosition } from '../src/providers/ais.ts';
import { freshnessOf } from '../src/types.ts';

// Reference values computed independently by PostGIS (GeographicLib geodesics).
const fixtures: { p1: { lat: number; lon: number }; p2: { lat: number; lon: number }; distanceM: number; bearingDeg: number }[] =
  JSON.parse(readFileSync(new URL('./postgis-geodesic-fixtures.json', import.meta.url), 'utf8'));

test('distance matches PostGIS to within 1 metre on 203 point pairs', () => {
  let worst = 0;
  for (const f of fixtures) {
    const ours = inverse(f.p1, f.p2).distanceM;
    worst = Math.max(worst, Math.abs(ours - f.distanceM));
  }
  assert.ok(worst < 1, `worst difference ${worst} m`);
});

test('initial bearing matches PostGIS to within 0.01 degree', () => {
  let worst = 0;
  for (const f of fixtures) {
    if (f.distanceM < 1) continue;
    const ours = inverse(f.p1, f.p2).initialBearingDeg;
    let diff = Math.abs(ours - f.bearingDeg);
    diff = Math.min(diff, 360 - diff);
    worst = Math.max(worst, diff);
  }
  assert.ok(worst < 0.01, `worst bearing difference ${worst} deg`);
});

test('one degree of latitude near 41N is about 59.96 nm', () => {
  assert.ok(Math.abs(distanceNm({ lat: 41, lon: -71 }, { lat: 42, lon: -71 }) - 59.96) < 0.02);
});

test('due north bearing is 0, due east near equator is 90', () => {
  assert.ok(inverse({ lat: 10, lon: 0 }, { lat: 11, lon: 0 }).initialBearingDeg < 1e-9);
  assert.ok(Math.abs(inverse({ lat: 0, lon: 0 }, { lat: 0, lon: 1 }).initialBearingDeg - 90) < 1e-9);
});

test('route distance sums legs; identical points give zero', () => {
  const a = { lat: 41, lon: -71 }, b = { lat: 41.5, lon: -71 }, c = { lat: 42, lon: -71 };
  assert.ok(Math.abs(routeDistanceNm([a, b, c]) - distanceNm(a, c)) < 0.01);
  assert.equal(distanceNm(a, a), 0);
});

test('ETA rejects zero speed and computes hours', () => {
  assert.throws(() => etaHours(10, 0));
  assert.equal(etaHours(30, 6), 5);
});

test('invalid coordinates are rejected, not silently used', () => {
  assert.throws(() => inverse({ lat: 91, lon: 0 }, { lat: 0, lon: 0 }));
  assert.throws(() => inverse({ lat: NaN, lon: 0 }, { lat: 0, lon: 0 }));
});

test('IMO check digit and MMSI format', () => {
  assert.ok(isValidImo('9074729'));   // standard published example
  assert.ok(!isValidImo('9074728'));
  assert.ok(isValidMmsi('367123450'));
  assert.ok(!isValidMmsi('36712345'));
});

test('AIS "not available" positions are rejected', () => {
  assert.ok(!isPlausiblePosition({ position: { lat: 91, lon: 181 } }));
  assert.ok(!isPlausiblePosition({ position: { lat: 0, lon: 0 } }));
  assert.ok(!isPlausiblePosition({ position: { lat: 41, lon: -71 }, sogKn: 102.3 }));
  assert.ok(isPlausiblePosition({ position: { lat: 41, lon: -71 }, sogKn: 6.5 }));
});

test('freshness labels never claim live for old or future timestamps', () => {
  const now = new Date('2026-11-11T12:00:00Z');
  assert.equal(freshnessOf('2026-11-11T11:59:00Z', now), 'live');
  assert.equal(freshnessOf('2026-11-11T11:45:00Z', now), 'delayed');
  assert.equal(freshnessOf('2026-11-11T09:00:00Z', now), 'stale');
  assert.equal(freshnessOf('2026-11-11T12:10:00Z', now), 'unknown');
  assert.equal(freshnessOf('garbage', now), 'unknown');
});
