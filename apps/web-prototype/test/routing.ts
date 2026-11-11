// Router scenarios run in a real browser with mocked data sources (see qa/test_routing.py).
import { coastalRoute } from '../src/router-coastal.ts';
import { passageRoute, polarSpeed } from '../src/router-weather.ts';
import { distanceNm } from '../../../packages/core/src/geo/nav.ts';

const out: Record<string, unknown> = {};
const inPoly = (lat: number, lon: number, poly: [number, number][]) => { let c = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const [xi, yi] = poly[i]!, [xj, yj] = poly[j]!; if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) c = !c; } return c; };
(async () => {
  try {
    out.polar = { upwind: polarSpeed(12, 30), close: polarSpeed(12, 50), beam: polarSpeed(12, 90), run: polarSpeed(12, 180) };
    // Coastal: deep bay with an island (in the mocked depth data as shallow) between start and end
    const island: [number, number][] = [[-71.31, 41.45], [-71.29, 41.45], [-71.29, 41.47], [-71.31, 41.47], [-71.31, 41.45]];
    const start = { lat: 41.46, lon: -71.34 }, end = { lat: 41.46, lon: -71.26 };
    const r = await coastalRoute(start, end, { draftFt: 6, marginFt: 3, hazardBufferM: 50 }, () => {});
    const dense: { lat: number; lon: number }[] = [];
    for (let i = 1; i < r.path.length; i++) { const a = r.path[i - 1]!, b = r.path[i]!; for (let k = 0; k <= 20; k++) dense.push({ lat: a.lat + (b.lat - a.lat) * k / 20, lon: a.lon + (b.lon - a.lon) * k / 20 }); }
    const rock = { lat: 41.43, lon: -71.30 };
    out.coastal = { legs: r.path.length - 1, dist: r.distanceNm, direct: distanceNm(start, end), crossesIsland: dense.some((p) => inPoly(p.lat, p.lon, island)), minRockDistM: Math.min(...dense.map((p) => distanceNm(p, rock) * 1852)), shallowestFt: r.shallowestFt };
    // a rock right on the straight line (41.40N between -71.34 and -71.26) must be avoided by the hazard buffer
    const s2 = { lat: 41.40, lon: -71.34 }, e2 = { lat: 41.40, lon: -71.26 };
    const r2 = await coastalRoute(s2, e2, { draftFt: 6, marginFt: 3, hazardBufferM: 50 }, () => {});
    const d2: { lat: number; lon: number }[] = [];
    for (let i = 1; i < r2.path.length; i++) { const a = r2.path[i - 1]!, b = r2.path[i]!; for (let k = 0; k <= 50; k++) d2.push({ lat: a.lat + (b.lat - a.lat) * k / 50, lon: a.lon + (b.lon - a.lon) * k / 50 }); }
    out.rockOnLine = { legs: r2.path.length - 1, minRockDistM: Math.min(...d2.map((p) => distanceNm(p, { lat: 41.40, lon: -71.30 }) * 1852)) };
    // enclosed basin whose only exit is a dredged channel (4 m): must route through the channel
    const r3 = await coastalRoute({ lat: 41.29, lon: -71.345 }, { lat: 41.29, lon: -71.24 }, { draftFt: 6, marginFt: 3, hazardBufferM: 50 }, () => {});
    out.dredged = { legs: r3.path.length - 1, maxLatDev: Math.max(...r3.path.map((p) => Math.abs(p.lat - 41.29))) };
    // same but too deep for the channel (12 ft + 3 ft > 4 m): must refuse
    try { await coastalRoute({ lat: 41.29, lon: -71.345 }, { lat: 41.29, lon: -71.24 }, { draftFt: 12, marginFt: 3, hazardBufferM: 50 }, () => {}); out.dredgedDeep = 'unexpected success'; } catch (e) { out.dredgedDeep = (e as Error).message.slice(0, 40); }
    // too deep a draft: should fail clearly
    try { await coastalRoute(start, end, { draftFt: 60, marginFt: 3, hazardBufferM: 50 }, () => {}); out.deepDraft = 'unexpected success'; } catch (e) { out.deepDraft = (e as Error).message; }

    // Passage: constant north wind 15 kn (mocked); downwind to the south
    const dep = new Date();
    const down = await passageRoute({ lat: 40, lon: -65 }, { lat: 37, lon: -65 }, { departure: dep, motorBelowKn: null, motorSpeedKn: 6.5, efficiency: 0.85, maxWindKn: 25 }, () => {});
    out.downwind = { arrived: down.arrived, hours: down.hours, dist: down.distanceNm, direct: distanceNm({ lat: 40, lon: -65 }, { lat: 37, lon: -65 }) };
    // upwind to the north: must tack, so sailed distance noticeably longer than direct
    const up = await passageRoute({ lat: 37, lon: -65 }, { lat: 39, lon: -65 }, { departure: dep, motorBelowKn: null, motorSpeedKn: 6.5, efficiency: 0.85, maxWindKn: 25 }, () => {});
    const maxLateral = Math.max(...up.points.map((p) => Math.abs(p.lon + 65)));
    out.upwind = { arrived: up.arrived, hours: up.hours, dist: up.distanceNm, direct: 120, maxLateralDeg: maxLateral, minTwa: Math.min(...up.points.slice(0, -1).map((p) => p.twaDeg)) };
    // land in the way (mocked land.json has a block island at 38-38.6N, 65.6-64.4W)
    const around = await passageRoute({ lat: 39.5, lon: -65 }, { lat: 37, lon: -65 }, { departure: dep, motorBelowKn: null, motorSpeedKn: 6.5, efficiency: 0.85, maxWindKn: 25 }, () => {});
    out.aroundLand = { arrived: around.arrived, onLand: around.points.some((p) => p.lat > 38.02 && p.lat < 38.58 && p.lon > -65.58 && p.lon < -64.42) };
  } catch (e) { out.error = String(e); }
  (window as unknown as { __results: unknown }).__results = out;
})();
