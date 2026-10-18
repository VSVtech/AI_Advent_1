import { afterEach, describe, expect, it, vi } from 'vitest';

import { POST } from '@/app/api/chat/route';
import {
  DIAGNOSE_DEFAULT_SYMPTOM,
  parseDiagnoseCommand,
} from '@/lib/diagnose-command';
import { rcCarCommand } from '@/lib/rc-car-types';
import { measureChannel } from '@/scripts/mcp-servers/rc-car.mjs';
import {
  createMockScope,
  speedToPwm,
} from '@/scripts/rc-car/scope-mock.mjs';
import { analyzeWaveform, envelope } from '@/scripts/rc-car/waveform.mjs';

const FS = 100_000;

function square(freq: number, duty: number, high: number, seconds = 0.05) {
  const count = Math.round(FS * seconds);
  return Float64Array.from({ length: count }, (_, i) =>
    (i / FS) * freq % 1 < duty ? high : 0,
  );
}

describe('waveform analysis', () => {
  it('measures frequency, duty and levels of a PWM signal', () => {
    const result = analyzeWaveform(square(490, 0.4, 4), FS);
    expect(result.kind).toBe('switching');
    expect(result.freqHz).toBeGreaterThan(485);
    expect(result.freqHz).toBeLessThan(495);
    expect(result.dutyPct).toBeGreaterThan(38);
    expect(result.dutyPct).toBeLessThan(42);
    expect(result.highLevelV).toBe(4);
    expect(result.lowLevelV).toBe(0);
  });

  it('reports the sag of a supply rail against the pre-event level', () => {
    const rail = Float64Array.from({ length: 5000 }, (_, i) => (i < 500 ? 6 : 4.5));
    const result = analyzeWaveform(rail, FS);
    expect(result).toMatchObject({ kind: 'analog', baselineV: 6, sagV: 1.5, vminV: 4.5 });
    expect(result.dutyPct).toBeNull();
  });

  it('recognizes a flat line and rejects too few samples', () => {
    expect(analyzeWaveform(new Float64Array(100).fill(0.003), FS).kind).toBe('flat');
    expect(() => analyzeWaveform(new Float64Array(3), FS)).toThrow('мало отсчётов');
  });

  it('keeps peaks in the shortened trace', () => {
    const samples = new Float64Array(1000).fill(1);
    samples[503] = 5;
    const points = envelope(samples, FS, 10);
    expect(points).toHaveLength(5);
    expect(Math.max(...points.map((p: { maxV: number | null }) => p.maxV ?? 0))).toBe(5);
  });
});

describe('mock car and scope', () => {
  const measure = (scenario: string, channel: number) =>
    createMockScope({ scenario }).capture(channel, 60);

  it('speedToPwm repeats the sketch arithmetic', () => {
    expect(speedToPwm(0)).toBe(0);
    expect(speedToPwm(1)).toBe(90);
    expect(speedToPwm(255)).toBe(255);
    expect(speedToPwm(160)).toBe(193);
  });

  it('a discharged battery shows as a low rail, a deep sag and a weak motor output', () => {
    const healthy = createMockScope({ scenario: 'healthy' });
    const low = createMockScope({ scenario: 'low_battery' });
    const rail = (scope: ReturnType<typeof createMockScope>) => {
      const c = scope.capture(1, 60);
      return analyzeWaveform(c.samples, c.sampleRateHz);
    };
    const out = (scope: ReturnType<typeof createMockScope>) => {
      const c = scope.capture(2, 60);
      return analyzeWaveform(c.samples, c.sampleRateHz);
    };
    expect(rail(healthy).baselineV).toBeGreaterThanOrEqual(6);
    expect(rail(healthy).sagV).toBeLessThan(1);
    expect(rail(low).baselineV).toBeLessThan(5.2);
    expect(rail(low).sagV).toBeGreaterThan(1.4);
    // Below ~3 V the geared motors cannot start: this is the squeal.
    expect(out(healthy).highLevelV).toBeGreaterThan(3.5);
    expect(out(low).highLevelV).toBeLessThan(2.5);
  });

  it('is deterministic and keeps the firmware blind to the battery', () => {
    expect(Array.from(measure('low_battery', 1).samples.slice(0, 50))).toEqual(
      Array.from(measure('low_battery', 1).samples.slice(0, 50)),
    );
    expect(createMockScope({ scenario: 'healthy' }).telemetry()).toEqual(
      createMockScope({ scenario: 'low_battery' }).telemetry(),
    );
  });

  it('validates scenario, channel and window', () => {
    expect(() => createMockScope({ scenario: 'unknown' })).toThrow('сценарий');
    expect(() => measure('healthy', 5)).toThrow('channel');
    expect(() => createMockScope().capture(1, 1000)).toThrow('windowMs');
  });
});

describe('scope tool results', () => {
  const scope = createMockScope({ scenario: 'low_battery' });

  it('returns computed features and marks the data source', () => {
    const result = measureChannel(scope, 1, undefined, undefined);
    expect(result).toMatchObject({ source: 'mock', channel: 1 });
    expect(result.measurement.sagV).toBeGreaterThan(1.4);
    expect(result.points).toBeUndefined();
  });

  it('adds a bounded envelope only when asked', () => {
    const result = measureChannel(scope, 2, 60, 40);
    expect(result.points).toHaveLength(20);
    expect(() => measureChannel(scope, 2, 60, 5000)).toThrow('maxPoints');
    expect(() => measureChannel(scope, 9, 60, undefined)).toThrow('channel');
  });
});

describe('/diagnose command', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('turns the symptom into a task', () => {
    expect(parseDiagnoseCommand('/diagnose моторы пищат')).toBe('Симптом: моторы пищат');
    expect(parseDiagnoseCommand('/diagnose')).toBe(`Симптом: ${DIAGNOSE_DEFAULT_SYMPTOM}`);
    expect(parseDiagnoseCommand('/diagnosis')).toBeNull();
    expect(rcCarCommand('моторы  пищат')).toBe('/diagnose моторы пищат');
  });

  it('searches the reference and offers the measurement tools', async () => {
    vi.stubEnv('DEEPSEEK_API_KEY', 'test-secret');
    for (const name of ['CAPSULE', 'TRAVEL', 'NOTES', 'GIT', 'SUPPORT', 'FILES', 'RC_CAR']) {
      vi.stubEnv(`MCP_${name}_URL`, 'not a url');
    }
    const sse =
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"ok"}\n\nevent: response.completed\ndata: {"type":"response.completed","response":{"status":"completed","usage":{"output_tokens":1,"input_tokens":1}}}\n\n';
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          build_id: 'b1',
          hits: [
            {
              id: 'S1',
              chunk_id: 'c1',
              source: 'docs/rc-car/troubleshooting.md',
              title: 'Справочник',
              section: 'Справочник / Моторы пищат',
              start_line: 1,
              end_line: 3,
              score: 0.8,
              text: 'Разряженный аккумулятор.',
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        new Response(sse, { headers: { 'Content-Type': 'text/event-stream' } }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const response = await POST(
      new Request('http://localhost/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [{ role: 'user', content: '/diagnose моторы пищат' }],
          useRag: false,
          useMcpTools: false,
          useSystemPrompt: false,
          targetOutputTokens: 500,
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(JSON.stringify(JSON.parse(fetchMock.mock.calls[0][1].body))).toContain('Симптом: моторы пищат');
    const body = JSON.parse(fetchMock.mock.calls[1][1].body as string);
    expect(body.instructions).toContain('Команда /diagnose');
    expect(body.instructions).toContain('scope_measure');
    expect(body.max_output_tokens).toBeGreaterThanOrEqual(8000);
  });
});
