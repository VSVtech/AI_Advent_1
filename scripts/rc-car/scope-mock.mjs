// Mock oscilloscope and car for the diagnostics demo. It synthesizes the
// waveforms a 4-channel scope would show on the RC car in two scenarios:
// a healthy car and a car with a discharged 6 V battery. Everything is
// deterministic (seeded noise) so that tests and demos repeat exactly.

export const SCENARIOS = {
  healthy: {
    description: 'исправная сборка, аккумулятор заряжен',
    idleV: 6.3,
    internalOhm: 0.3,
    peakA: 2.4,
    steadyA: 1.0,
    spinUpTauS: 0.012,
  },
  low_battery: {
    description: 'аккумулятор 6 В сильно разряжен',
    idleV: 5.1,
    internalOhm: 0.85,
    peakA: 2.0,
    // Motors that cannot turn keep drawing current instead of settling down.
    steadyA: 1.7,
    spinUpTauS: 0.03,
  },
};

export const SCOPE_CHANNELS = [
  { id: 1, label: 'VM: питание драйвера L293D', probe: '10x', coupling: 'DC', unit: 'V' },
  { id: 2, label: 'OUT левого борта: выход L293D на моторы', probe: '10x', coupling: 'DC', unit: 'V' },
  { id: 3, label: '5V: линия питания Nano', probe: '10x', coupling: 'DC', unit: 'V' },
  { id: 4, label: 'ECHO: выход переднего HC-SR04', probe: '10x', coupling: 'DC', unit: 'V' },
];

export const MOCK_SAMPLE_RATE_HZ = 100_000;
const STEADY_SPEED = 160;
const MIN_PWM = 90;
const LEFT_PWM_HZ = 490.2;
const RIGHT_PWM_HZ = 976.6;

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(random) {
  const u = Math.max(random(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * random());
}

// Same integer arithmetic as the sketch: map(s, 1, 255, MIN_PWM, 255).
export function speedToPwm(speed) {
  if (speed <= 0) return 0;
  return Math.trunc(((speed - 1) * (255 - MIN_PWM)) / (255 - 1)) + MIN_PWM;
}

function simulate(scenario, windowMs, sampleRateHz, seed) {
  const params = SCENARIOS[scenario];
  const count = Math.round((windowMs * sampleRateHz) / 1000);
  const startS = (windowMs / 1000) * 0.1;
  const random = mulberry32(seed);
  const vm = new Float64Array(count);
  const outLeft = new Float64Array(count);
  const rail5 = new Float64Array(count);
  const echo = new Float64Array(count);
  let slowSag = 0;
  for (let i = 0; i < count; i += 1) {
    const t = i / sampleRateHz;
    let currentLeft = 0;
    let currentRight = 0;
    let onLeft = false;
    let driverDrop = 0;
    if (t >= startS) {
      const since = t - startS;
      // The scope sees the car already at the commanded speed, like the telemetry.
      const duty = speedToPwm(STEADY_SPEED) / 255;
      const perSide =
        (params.steadyA +
          (params.peakA - params.steadyA) * Math.exp(-since / params.spinUpTauS)) /
        2;
      onLeft = (since * LEFT_PWM_HZ) % 1 < duty;
      const onRight = (since * RIGHT_PWM_HZ) % 1 < duty;
      currentLeft = onLeft ? perSide : 0;
      currentRight = onRight ? perSide : 0;
      driverDrop = 1.2 + 1.3 * perSide;
    }
    const supply = params.idleV - params.internalOhm * (currentLeft + currentRight);
    vm[i] = supply + 0.012 * gaussian(random);
    outLeft[i] = onLeft
      ? Math.max(0, supply - driverDrop) + 0.02 * gaussian(random)
      : 0.01 * gaussian(random);
    slowSag += (params.idleV - supply - slowSag) * 0.01;
    rail5[i] = 5.0 - 0.15 * slowSag + 0.012 * gaussian(random);
    echo[i] = Math.abs(0.005 * gaussian(random));
  }
  return { 1: vm, 2: outLeft, 3: rail5, 4: echo };
}

export function createMockScope({ scenario = 'low_battery', seed = 7 } = {}) {
  if (!SCENARIOS[scenario]) {
    throw new Error(`Неизвестный сценарий: ${scenario}`);
  }
  return {
    scenario,
    identify: () => ({
      source: 'mock',
      vendor: 'MOCK',
      model: 'Симулятор 4-канального осциллографа',
      note: 'Данные синтезируются; реальный прибор подключается тем же интерфейсом',
    }),
    channels: () => SCOPE_CHANNELS,
    capture(channel, windowMs = 60) {
      if (!SCOPE_CHANNELS.some((item) => item.id === channel)) {
        throw new Error('channel: от 1 до 4');
      }
      if (!Number.isFinite(windowMs) || windowMs < 5 || windowMs > 200) {
        throw new Error('windowMs: от 5 до 200');
      }
      const traces = simulate(scenario, windowMs, MOCK_SAMPLE_RATE_HZ, seed);
      return {
        samples: traces[channel],
        sampleRateHz: MOCK_SAMPLE_RATE_HZ,
        windowMs,
        trigger: 'момент подачи команды на скорость 160/160, 10 % окна от начала',
      };
    },
    // What the firmware reports: it cannot see the battery, so both scenarios
    // look the same in telemetry.
    telemetry: () => ({
      source: 'mock',
      raw: `TLM_200_200_${STEADY_SPEED}_${STEADY_SPEED}`,
      frontCm: 200,
      rearCm: 200,
      motorLeft: STEADY_SPEED,
      motorRight: STEADY_SPEED,
      note: '200 см в поле дальности означает «препятствия нет»',
    }),
  };
}
