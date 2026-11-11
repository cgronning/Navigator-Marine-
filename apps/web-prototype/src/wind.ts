/**
 * Animated wind layer (PredictWind-style): forecast wind from Open-Meteo on a
 * grid over the visible map, drawn as moving streaks coloured by speed.
 * Real forecast model data; the animation only visualises it.
 */
import type maplibregl from 'maplibre-gl';

export interface WindGrid {
  lats: number[];          // rows, south -> north
  lons: number[];          // cols, west -> east
  times: string[];         // hourly, UTC ISO
  speed: number[][][];     // [t][row][col] knots
  dir: number[][][];       // [t][row][col] degrees, direction wind comes FROM
}

const ROWS = 11, COLS = 8;

export async function fetchWindGrid(b: { s: number; w: number; n: number; e: number }): Promise<WindGrid> {
  const padLat = (b.n - b.s) * 0.15, padLon = (b.e - b.w) * 0.15;
  const s = b.s - padLat, n = b.n + padLat, w = b.w - padLon, e = b.e + padLon;
  const lats = Array.from({ length: ROWS }, (_, i) => s + ((n - s) * i) / (ROWS - 1));
  const lons = Array.from({ length: COLS }, (_, j) => w + ((e - w) * j) / (COLS - 1));
  const qLat: string[] = [], qLon: string[] = [];
  for (const la of lats) for (const lo of lons) { qLat.push(la.toFixed(3)); qLon.push(lo.toFixed(3)); }
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${qLat.join(',')}&longitude=${qLon.join(',')}&hourly=wind_speed_10m,wind_direction_10m&wind_speed_unit=kn&forecast_days=3&timezone=GMT`;
  const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`Wind HTTP ${res.status}`);
  const arr = (await res.json()) as { hourly: { time: string[]; wind_speed_10m: (number | null)[]; wind_direction_10m: (number | null)[] } }[];
  const times = arr.at(0)!.hourly.time.map((t) => `${t}:00Z`);
  const speed: number[][][] = [], dir: number[][][] = [];
  for (let t = 0; t < times.length; t++) {
    const sp: number[][] = [], dr: number[][] = [];
    for (let r = 0; r < ROWS; r++) {
      const rowS: number[] = [], rowD: number[] = [];
      for (let c = 0; c < COLS; c++) {
        const h = arr.at(r * COLS + c)!.hourly;
        rowS.push(h.wind_speed_10m.at(t) ?? 0);
        rowD.push(h.wind_direction_10m.at(t) ?? 0);
      }
      sp.push(rowS); dr.push(rowD);
    }
    speed.push(sp); dir.push(dr);
  }
  return { lats, lons, times, speed, dir };
}

/** PredictWind-like speed colours (knots). */
const STOPS: [number, [number, number, number]][] = [
  [0, [120, 170, 220]], [5, [70, 160, 200]], [10, [60, 180, 120]], [15, [230, 200, 50]],
  [20, [240, 140, 40]], [25, [220, 60, 50]], [30, [170, 40, 140]], [40, [110, 30, 120]],
];
export function speedColor(kn: number, alpha = 1): string {
  let lo = STOPS[0]!, hi = STOPS.at(-1)!;
  for (let i = 0; i < STOPS.length - 1; i++) { if (kn >= STOPS[i]![0] && kn <= STOPS[i + 1]![0]) { lo = STOPS[i]!; hi = STOPS[i + 1]!; break; } }
  if (kn > hi[0]) lo = hi;
  const f = hi[0] === lo[0] ? 0 : (kn - lo[0]) / (hi[0] - lo[0]);
  const c = lo[1].map((v, i) => Math.round(v + (hi[1][i]! - v) * f));
  return `rgba(${c[0]},${c[1]},${c[2]},${alpha})`;
}
export const LEGEND_STOPS = [0, 5, 10, 15, 20, 25, 30];

function sample(g: WindGrid, t: number, lat: number, lon: number): { u: number; v: number; kn: number } | null {
  const { lats, lons } = g;
  if (lat < lats[0]! || lat > lats.at(-1)! || lon < lons[0]! || lon > lons.at(-1)!) return null;
  const fr = ((lat - lats[0]!) / (lats.at(-1)! - lats[0]!)) * (lats.length - 1);
  const fc = ((lon - lons[0]!) / (lons.at(-1)! - lons[0]!)) * (lons.length - 1);
  const r0 = Math.min(Math.floor(fr), lats.length - 2), c0 = Math.min(Math.floor(fc), lons.length - 2);
  const dr = fr - r0, dc = fc - c0;
  const sp = g.speed.at(t)!, di = g.dir.at(t)!;
  let u = 0, v = 0;
  const cells: [number, number, number][] = [[r0, c0, (1 - dr) * (1 - dc)], [r0, c0 + 1, (1 - dr) * dc], [r0 + 1, c0, dr * (1 - dc)], [r0 + 1, c0 + 1, dr * dc]];
  for (const [r, c, wgt] of cells) {
    const s = sp.at(r)!.at(c)!, d = (di.at(r)!.at(c)! * Math.PI) / 180;
    // direction is where wind comes FROM; motion is the opposite way
    u += -s * Math.sin(d) * wgt;
    v += -s * Math.cos(d) * wgt;
  }
  return { u, v, kn: Math.hypot(u, v) };
}

export class WindLayer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private grid: WindGrid | null = null;
  private t = 0;
  private particles: { x: number; y: number; age: number }[] = [];
  private raf = 0;
  private running = false;
  private moving = false;

  constructor(private map: maplibregl.Map, container: HTMLElement) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'wind-canvas';
    container.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d')!;
    map.on('movestart', () => { this.moving = true; this.clear(); });
    map.on('moveend', () => { this.moving = false; this.seed(); });
    map.on('resize', () => this.resize());
    this.resize();
  }

  setGrid(g: WindGrid) { this.grid = g; this.seed(); }
  setTime(i: number) { this.t = i; }
  get times() { return this.grid?.times ?? []; }

  start() { if (this.running) return; this.running = true; this.canvas.hidden = false; this.seed(); this.loop(); }
  stop() { this.running = false; cancelAnimationFrame(this.raf); this.clear(); this.canvas.hidden = true; }

  private resize() {
    const r = this.map.getContainer().getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = r.width * dpr; this.canvas.height = r.height * dpr;
    this.canvas.style.width = `${r.width}px`; this.canvas.style.height = `${r.height}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.seed();
  }
  private clear() { this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height); }
  private seed() {
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    const n = Math.round(Math.min(1400, (w * h) / 450));
    this.particles = Array.from({ length: n }, () => ({ x: Math.random() * w, y: Math.random() * h, age: Math.floor(Math.random() * 80) }));
  }
  private loop = () => {
    if (!this.running) return;
    this.raf = requestAnimationFrame(this.loop);
    if (this.moving || !this.grid) return;
    const ctx = this.ctx, w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    // fade old trails
    ctx.globalCompositeOperation = 'destination-in';
    ctx.fillStyle = 'rgba(0,0,0,0.94)';
    ctx.fillRect(0, 0, w, h);
    ctx.globalCompositeOperation = 'source-over';
    ctx.lineWidth = 2.2;
    ctx.lineCap = 'round';
    const k = 0.045; // pixels per frame per knot (visual only)
    for (const p of this.particles) {
      const ll = this.map.unproject([p.x, p.y]);
      const s = sample(this.grid, this.t, ll.lat, ll.lng);
      if (!s || p.age > 90) { p.x = Math.random() * w; p.y = Math.random() * h; p.age = 0; continue; }
      const nx = p.x + s.u * k * 1.6, ny = p.y - s.v * k * 1.6;
      ctx.strokeStyle = speedColor(s.kn, 0.9);
      ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(nx, ny); ctx.stroke();
      p.x = nx; p.y = ny; p.age++;
      if (p.x < 0 || p.x > w || p.y < 0 || p.y > h) { p.x = Math.random() * w; p.y = Math.random() * h; p.age = 0; }
    }
  };
}
