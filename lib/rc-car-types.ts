export type ScopeMeasurement = {
  kind: 'switching' | 'analog' | 'flat';
  windowMs: number;
  vminV: number;
  vmaxV: number;
  vppV: number;
  vmeanV: number;
  baselineV: number | null;
  sagV: number | null;
  freqHz: number | null;
  rippleFreqHz: number | null;
  dutyPct: number | null;
  highLevelV: number | null;
  lowLevelV: number | null;
};

export type ScopeCapture = {
  channel: number;
  label: string;
  probe: string;
  trigger: string;
  measurement: ScopeMeasurement;
  points: Array<{ tMs: number; minV: number; maxV: number }>;
};

export type RcCarTelemetry = {
  raw: string;
  frontCm: number;
  rearCm: number;
  motorLeft: number;
  motorRight: number;
};

export type RcCarSnapshot = {
  source: string;
  telemetry: RcCarTelemetry;
  captures: ScopeCapture[];
};

export const RC_CAR_SYMPTOMS = [
  'Моторы пищат и почти не крутят, иногда одна сторона не может стартовать',
  'Машинка перезагружается при старте моторов',
  'Какие измерения стоит сделать при первом включении?',
] as const;

export function rcCarCommand(symptom: string) {
  return `/diagnose ${symptom}`.replace(/\s+/gu, ' ').trim();
}
