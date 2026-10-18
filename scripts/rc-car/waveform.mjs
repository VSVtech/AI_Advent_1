// Waveform analysis for the diagnostics assistant. The same code works for the
// mock scope and for samples from a real oscilloscope: the model gets computed
// features (levels, duty, frequency, sag), never raw sample dumps.

const round = (value, digits = 3) =>
  value === null || !Number.isFinite(value)
    ? null
    : Number(value.toFixed(digits));

function mean(samples, from, to) {
  let sum = 0;
  for (let i = from; i < to; i += 1) sum += samples[i];
  return sum / Math.max(1, to - from);
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = Float64Array.from(values).sort();
  return sorted[Math.floor(sorted.length / 2)];
}

// Duty over whole periods only (first to last rising edge), as scopes do.
function dutyOverWholePeriods(samples, rising, middle) {
  const from = rising[0];
  const to = rising.at(-1);
  let on = 0;
  for (let i = from; i < to; i += 1) if (samples[i] > middle) on += 1;
  return on / (to - from);
}

/**
 * @param {ArrayLike<number>} samples volts
 * @param {number} sampleRateHz
 */
export function analyzeWaveform(samples, sampleRateHz) {
  const count = samples.length;
  if (count < 10) throw new Error('Слишком мало отсчётов для анализа');
  let vmin = Infinity;
  let vmax = -Infinity;
  for (let i = 0; i < count; i += 1) {
    if (samples[i] < vmin) vmin = samples[i];
    if (samples[i] > vmax) vmax = samples[i];
  }
  const vpp = vmax - vmin;
  const head = Math.max(2, Math.floor(count * 0.08));
  const baselineV = mean(samples, 0, head);

  // Schmitt trigger at 40 % / 60 % of the swing counts clean edges.
  let state = samples[0] > vmin + vpp * 0.5;
  const rising = [];
  const high = vmin + vpp * 0.6;
  const low = vmin + vpp * 0.4;
  if (vpp >= 0.05) {
    for (let i = 1; i < count; i += 1) {
      if (!state && samples[i] > high) {
        state = true;
        rising.push(i);
      } else if (state && samples[i] < low) {
        state = false;
      }
    }
  }
  const windowMs = (count / sampleRateHz) * 1000;
  const edgeFreqHz =
    rising.length >= 3
      ? ((rising.length - 1) / (rising.at(-1) - rising[0])) * sampleRateHz
      : null;
  // «switching»: logic or PWM, the signal swings most of its level;
  // «analog»: a supply rail or a slow signal with ripple; «flat»: nothing happens.
  let kind = 'flat';
  if (vpp >= 0.05) {
    kind =
      edgeFreqHz !== null && vpp >= 0.5 * Math.max(Math.abs(vmax), 0.2)
        ? 'switching'
        : 'analog';
  }
  const middle = vmin + vpp * 0.5;
  const above = [];
  const below = [];
  for (let i = 0; i < count; i += 1) {
    (samples[i] > middle ? above : below).push(samples[i]);
  }
  const switching = kind === 'switching';
  return {
    kind,
    windowMs: round(windowMs, 1),
    sampleRateHz,
    vminV: round(vmin),
    vmaxV: round(vmax),
    vppV: round(vpp),
    vmeanV: round(mean(samples, 0, count)),
    // Level before the event (first 8 % of the window), for supply rails.
    baselineV: baselineV > 1 ? round(baselineV) : null,
    // Drop below that level: the main indicator for supply rails.
    sagV: baselineV > 1 ? round(Math.max(0, baselineV - vmin)) : null,
    freqHz: switching ? round(edgeFreqHz, 1) : null,
    rippleFreqHz: kind === 'analog' && vpp >= 0.15 ? round(edgeFreqHz, 1) : null,
    dutyPct: switching ? round(dutyOverWholePeriods(samples, rising, middle) * 100, 1) : null,
    highLevelV: switching ? round(median(above)) : null,
    lowLevelV: switching ? round(median(below)) : null,
  };
}

// Min/max envelope per bin keeps ripple and spikes when the trace is shortened.
export function envelope(samples, sampleRateHz, maxPoints = 40) {
  const bins = Math.max(1, Math.floor(maxPoints / 2));
  const size = Math.max(1, Math.floor(samples.length / bins));
  const points = [];
  for (let b = 0; b < bins; b += 1) {
    const from = b * size;
    const to = b === bins - 1 ? samples.length : from + size;
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = from; i < to; i += 1) {
      if (samples[i] < lo) lo = samples[i];
      if (samples[i] > hi) hi = samples[i];
    }
    const t = ((from + to) / 2 / sampleRateHz) * 1000;
    points.push({ tMs: round(t, 2), minV: round(lo, 2), maxV: round(hi, 2) });
  }
  return points;
}
