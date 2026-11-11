import type { LatLon, Provenance } from '../types.ts';

export interface TideStation {
  id: string;
  name: string;
  position: LatLon;
  kind: 'tide' | 'current';
}

export interface TideEvent {
  time: string;          // ISO
  type: 'high' | 'low' | 'flood_max' | 'ebb_max' | 'slack';
  heightM?: number;      // tides, relative to station datum
  speedKn?: number;      // currents
  directionDeg?: number; // currents
}

export interface TidePrediction extends Provenance {
  station: TideStation;
  datum?: string;        // e.g. 'MLLW'
  events: TideEvent[];
}

export interface TideProvider {
  readonly key: string;
  nearestStations(point: LatLon, limit?: number): Promise<TideStation[]>;
  predictions(stationId: string, from: Date, to: Date): Promise<TidePrediction>;
}
