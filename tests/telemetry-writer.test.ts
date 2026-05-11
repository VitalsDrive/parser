import { SupabaseClient } from '@supabase/supabase-js';
import { TelemetryWriter } from '../src/telemetry-writer';
import { TelemetryPacket } from '../src/types';

jest.mock('../src/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRecord(overrides: Partial<TelemetryPacket> = {}): TelemetryPacket {
  return {
    vehicleId: 'vehicle-1',
    imei: '123456789012345',
    lat: 37.7749,
    lng: -122.4194,
    speed: 60,
    temp: 90,
    voltage: 12.5,
    rpm: 2500,
    dtcCodes: [],
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

function makeInsertMock(resolvedValue: { error: null | object }) {
  return jest.fn().mockResolvedValue(resolvedValue);
}

function makeSupabaseMock(insertFn: jest.Mock): SupabaseClient {
  return {
    from: jest.fn(() => ({ insert: insertFn })),
  } as unknown as SupabaseClient;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TelemetryWriter', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  it('successful write — insert called once with correct fields, queue stays empty, lastSupabasePush is ISO string', async () => {
    const insertFn = makeInsertMock({ error: null });
    const supabase = makeSupabaseMock(insertFn);
    const writer = new TelemetryWriter(supabase);
    const record = makeRecord();

    await writer.write(record);

    expect(insertFn).toHaveBeenCalledTimes(1);
    const payload = insertFn.mock.calls[0][0];
    expect(payload.vehicle_id).toBe('vehicle-1');
    expect(payload.lat).toBe(37.7749);
    expect(payload.lng).toBe(-122.4194);
    expect(payload.temp).toBe(90);
    expect(payload.voltage).toBe(12.5);
    expect(payload.rpm).toBe(2500);
    expect(payload.timestamp).toBe(record.timestamp);
    expect(writer.queueDepth).toBe(0);
    expect(writer.lastSupabasePush).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('dtc_codes is ALWAYS [] even when record.dtcCodes has values', async () => {
    const insertFn = makeInsertMock({ error: null });
    const supabase = makeSupabaseMock(insertFn);
    const writer = new TelemetryWriter(supabase);
    const record = makeRecord({ dtcCodes: ['P0301', 'P0420'] });

    await writer.write(record);

    const payload = insertFn.mock.calls[0][0];
    expect(payload.dtc_codes).toEqual([]);
  });

  it('Supabase insert rejects — record enqueued, consecutiveFailures === 1', async () => {
    const insertFn = makeInsertMock({ error: { message: 'DB error' } });
    const supabase = makeSupabaseMock(insertFn);
    const writer = new TelemetryWriter(supabase);

    await writer.write(makeRecord());

    expect(writer.queueDepth).toBe(1);
    // @ts-expect-error accessing private for test
    expect(writer.consecutiveFailures).toBe(1);
  });

  it('3 consecutive failures — logger.error called with consecutiveFailures: 3 and message matching /failure alert/', async () => {
    const { logger } = require('../src/logger');
    const insertFn = makeInsertMock({ error: { message: 'DB error' } });
    const supabase = makeSupabaseMock(insertFn);
    const writer = new TelemetryWriter(supabase);

    await writer.write(makeRecord());
    await writer.write(makeRecord());
    await writer.write(makeRecord());

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ consecutiveFailures: 3 }),
      expect.stringMatching(/failure alert/i)
    );
  });

  it('queue size = 1000, 1001st enqueue — logger.warn /Queue full/, queue stays 1000, oldest discarded', async () => {
    const { logger } = require('../src/logger');
    process.env.SUPABASE_QUEUE_MAX_SIZE = '1000';

    const insertFn = makeInsertMock({ error: { message: 'DB error' } });
    const supabase = makeSupabaseMock(insertFn);
    const writer = new TelemetryWriter(supabase);

    // Fill queue to max (1000 failures)
    for (let i = 0; i < 1000; i++) {
      await writer.write(makeRecord({ vehicleId: `v-${i}` }));
    }

    // @ts-expect-error accessing private
    const firstRecord = writer.queue[0];
    expect(writer.queueDepth).toBe(1000);

    // 1001st failure
    await writer.write(makeRecord({ vehicleId: 'v-overflow' }));

    expect(writer.queueDepth).toBe(1000);
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ queueDepth: 1000 }),
      expect.stringMatching(/Queue full/i)
    );
    // Oldest (first record) should be discarded
    // @ts-expect-error accessing private
    expect(writer.queue[0]).not.toEqual(firstRecord);

    delete process.env.SUPABASE_QUEUE_MAX_SIZE;
  });

  it('queue holds N records, Supabase recovers — drainQueue flushes all, queue empty', async () => {
    let callCount = 0;
    const insertFn = jest.fn().mockImplementation(() => {
      callCount++;
      if (callCount <= 3) {
        return Promise.resolve({ error: { message: 'DB down' } });
      }
      return Promise.resolve({ error: null });
    });
    const supabase = makeSupabaseMock(insertFn);
    const writer = new TelemetryWriter(supabase);

    // 3 failures enqueue 3 records
    await writer.write(makeRecord({ vehicleId: 'v1' }));
    await writer.write(makeRecord({ vehicleId: 'v2' }));
    await writer.write(makeRecord({ vehicleId: 'v3' }));
    expect(writer.queueDepth).toBe(3);

    // Advance timers to trigger retry
    jest.runAllTimers();
    // Wait for async drain
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(writer.queueDepth).toBe(0);
  });

  it('exponential backoff delays: 1000ms, 2000ms, 4000ms... capped at 60000', async () => {
    const setTimeoutSpy = jest.spyOn(global, 'setTimeout');
    const insertFn = makeInsertMock({ error: { message: 'DB error' } });
    const supabase = makeSupabaseMock(insertFn);
    const writer = new TelemetryWriter(supabase);

    await writer.write(makeRecord()); // consecutiveFailures=1, retryCount=0→1, delay=1000
    await writer.write(makeRecord()); // consecutiveFailures=2, retryCount=1→2, delay=2000
    await writer.write(makeRecord()); // consecutiveFailures=3, retryCount=2→3, delay=4000

    const timeoutCalls = setTimeoutSpy.mock.calls.map(args => args[1]);
    expect(timeoutCalls).toContain(1000);
    expect(timeoutCalls).toContain(2000);
    expect(timeoutCalls).toContain(4000);

    setTimeoutSpy.mockRestore();
  });
});
