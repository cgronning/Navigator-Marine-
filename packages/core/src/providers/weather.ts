import type { LatLon, Provenance } from '../types.ts';

/** One forecast hour at one point, in SI units (converted for display). */
export interface MarineForecastHour {
  time: string;            // ISO
  windSpeedMs?: number;
  windGustMs?: number;
  windDirDeg?: number;     // direction wind comes FROM
  waveHeightM?: number;
  wavePeriodS?: number;
  waveDirDeg?: number;
  swellHeightM?: number;
  swellPeriodS?: number;
  swellDirDeg?: number;
  precipMm?: number;
  visibilityM?: number;
  airTempC?: number;
  waterTempC?: number;
  thunderstormRisk?: number; // 0..1 where the model provides it
}

export interface MarineForecast extends Provenance {
  point: LatLon;
  model: string;           // e.g. 'gfs', 'ecmwf_ifs', 'icon'
  issuedAt?: string;
  hours: MarineForecastHour[];
}

export interface WeatherProvider {
  readonly key: string;
  listModels(): Promise<string[]>;
  forecast(point: LatLon, opts?: { model?: string; hours?: number }): Promise<MarineForecast>;
}

/** Official text forecasts and warnings (e.g. NOAA NWS). Shown verbatim, never paraphrased. */
export interface OfficialMarineForecast extends Provenance {
  zoneId: string;
  zoneName: string;
  issuedAt: string;
  text: string;
  warnings: { kind: string; headline: string; expiresAt?: string }[];
}

export interface OfficialForecastProvider {
  readonly key: string;
  forPoint(point: LatLon): Promise<OfficialMarineForecast | null>;
}
