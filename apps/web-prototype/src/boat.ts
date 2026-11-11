/**
 * Your boat on the chart: a triangle pointing the way you're heading, with a
 * course line projected ahead (10 minutes at current speed, minimum 0.5 nm).
 * Heading comes from GPS course when moving, otherwise from the phone compass.
 */
import maplibregl, { type GeoJSONSource } from 'maplibre-gl';

const R_NM = 3440.065;
function destination(lat: number, lon: number, bearingDeg: number, distNm: number): [number, number] {
  const d = distNm / R_NM, b = (bearingDeg * Math.PI) / 180, p1 = (lat * Math.PI) / 180, l1 = (lon * Math.PI) / 180;
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b));
  const l2 = l1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return [(l2 * 180) / Math.PI, (p2 * 180) / Math.PI];
}

export interface BoatState { lat: number; lon: number; headingDeg: number | null; sogKn: number | null; source: 'gps' | 'compass' | null; accuracyM: number }

export class BoatTracker {
  private marker: maplibregl.Marker | null = null;
  private el: HTMLDivElement;
  private watchId: number | null = null;
  private compass: number | null = null;
  state: BoatState | null = null;
  private first = true;
  onUpdate: (s: BoatState) => void = () => {};
  onError: (msg: string) => void = () => {};

  constructor(private map: maplibregl.Map) {
    this.el = document.createElement('div');
    this.el.className = 'boat';
    this.el.innerHTML = `<svg viewBox="0 0 40 40" width="40" height="40" aria-hidden="true"><path d="M20 3 L33 35 L20 28 L7 35 Z" fill="#0B1F3F" stroke="#FBF8F1" stroke-width="2.5" stroke-linejoin="round"/></svg>`;
  }

  get active() { return this.watchId !== null; }

  async start() {
    if (!('geolocation' in navigator)) { this.onError('This browser can’t share your location.'); return; }
    // iOS needs a permission tap for the compass
    const DOE = (window as unknown as { DeviceOrientationEvent?: { requestPermission?: () => Promise<string> } }).DeviceOrientationEvent;
    try { if (DOE?.requestPermission) await DOE.requestPermission(); } catch { /* compass optional */ }
    window.addEventListener('deviceorientation', this.onOrient, true);
    this.watchId = navigator.geolocation.watchPosition(this.onPos, (e) => {
      this.onError(e.code === 1 ? 'Location permission was declined. Enable it in Settings > Safari > Location.' : 'Couldn’t get your location.');
      this.stop();
    }, { enableHighAccuracy: true, maximumAge: 2000, timeout: 20000 });
  }

  stop() {
    if (this.watchId !== null) navigator.geolocation.clearWatch(this.watchId);
    this.watchId = null;
    window.removeEventListener('deviceorientation', this.onOrient, true);
    this.marker?.remove(); this.marker = null; this.first = true; this.state = null;
    (this.map.getSource('course') as GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: [] });
  }

  recenter() { if (this.state) this.map.flyTo({ center: [this.state.lon, this.state.lat], zoom: Math.max(this.map.getZoom(), 14) }); }

  private onOrient = (e: DeviceOrientationEvent) => {
    const wk = (e as unknown as { webkitCompassHeading?: number }).webkitCompassHeading;
    if (typeof wk === 'number') this.compass = wk;
    else if (e.absolute && e.alpha !== null) this.compass = (360 - e.alpha) % 360;
    if (this.state && this.state.source !== 'gps' && this.compass !== null) { this.state.headingDeg = this.compass; this.state.source = 'compass'; this.render(); }
  };

  private onPos = (pos: GeolocationPosition) => {
    const c = pos.coords;
    const sogKn = c.speed !== null && c.speed >= 0 ? c.speed * 1.943844 : null;
    const moving = sogKn !== null && sogKn > 0.8 && c.heading !== null && !Number.isNaN(c.heading);
    this.state = {
      lat: c.latitude, lon: c.longitude, sogKn, accuracyM: c.accuracy,
      headingDeg: moving ? c.heading : this.compass,
      source: moving ? 'gps' : this.compass !== null ? 'compass' : null,
    };
    this.render();
    if (this.first) { this.first = false; this.recenter(); }
  };

  private render() {
    const s = this.state; if (!s) return;
    if (!this.marker) this.marker = new maplibregl.Marker({ element: this.el, rotationAlignment: 'map' }).setLngLat([s.lon, s.lat]).addTo(this.map);
    this.marker.setLngLat([s.lon, s.lat]);
    this.marker.setRotation(s.headingDeg ?? 0);
    this.el.classList.toggle('no-heading', s.headingDeg === null);
    const src = this.map.getSource('course') as GeoJSONSource | undefined;
    if (src) {
      if (s.headingDeg === null) src.setData({ type: 'FeatureCollection', features: [] });
      else {
        const dist = Math.max(0.5, (s.sogKn ?? 0) * (10 / 60));
        const end = destination(s.lat, s.lon, s.headingDeg, dist);
        src.setData({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [[s.lon, s.lat], end] } }] });
      }
    }
    this.onUpdate(s);
  }
}
