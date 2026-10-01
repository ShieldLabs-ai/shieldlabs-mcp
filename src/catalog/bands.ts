import { riskBand, type RiskBand } from '@shieldlabs-ai/node';

export type BandOrMarker = RiskBand | 'rate_limited';

export interface RiskBandInfo {
  band: RiskBand;
  label: string;
  min: number;
  max: number;
  meaning: string;
  typical_handling: string;
}

/** The three risk bands. The band is a client-side label: no band field exists on the wire. */
export const RISK_BAND_CATALOG: readonly RiskBandInfo[] = [
  {
    band: 'trusted',
    label: 'Trusted',
    min: 0,
    max: 29,
    meaning: 'No meaningful risk signals, or one minor risk signal.',
    typical_handling: 'Allow without friction.',
  },
  {
    band: 'suspicious',
    label: 'Suspicious',
    min: 30,
    max: 59,
    meaning: 'Several overlapping risk signals, or one moderate risk signal.',
    typical_handling: 'A step-up challenge, a second look or a review.',
  },
  {
    band: 'dangerous',
    label: 'Dangerous',
    min: 60,
    max: 100,
    meaning: 'Strong risk signals.',
    typical_handling: 'Block, review or require verification.',
  },
];

export const RATE_LIMIT_MARKER_NOTE =
  'A value above 100 (sent as 999) is the rate-limit marker: the visitor IP was temporarily banned after too many identifications. It is not a Risk Score and not a band.';

export const ENTITY_BAND_NOTE =
  'A user, device, visitor or IP address carries the worst band among its identifications in the period you look at.';

const BAND_ORDER: Record<RiskBand, number> = { trusted: 0, suspicious: 1, dangerous: 2 };

export function bandOf(score: number): BandOrMarker {
  return riskBand(score);
}

export function bandInfo(band: RiskBand): RiskBandInfo {
  return RISK_BAND_CATALOG.find((info) => info.band === band) as RiskBandInfo;
}

/** The worse of two bands (null counts as no band yet). */
export function worseBand(a: RiskBand | null, b: RiskBand): RiskBand {
  return a === null || BAND_ORDER[b] > BAND_ORDER[a] ? b : a;
}

/** "60-100" for a band, "above 100" for the marker. */
export function bandRange(band: BandOrMarker): string {
  if (band === 'rate_limited') return 'above 100 (999)';
  const info = bandInfo(band);
  return `${info.min}-${info.max}`;
}
