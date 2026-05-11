import { SupabaseClient } from '@supabase/supabase-js';
import { logger } from './logger';
import { TelemetryPacket } from './types';

export class TelemetryWriter {
  private readonly supabase: SupabaseClient;
  private readonly queueMaxSize: number;
  private queue: TelemetryPacket[] = [];
  private consecutiveFailures = 0;
  private retryCount = 0;
  private lastPushTimestamp: string | null = null;
  private retryTimer: NodeJS.Timeout | null = null;

  constructor(supabase: SupabaseClient) {
    this.supabase = supabase;
    this.queueMaxSize = parseInt(process.env.SUPABASE_QUEUE_MAX_SIZE || '1000', 10);
  }

  get queueDepth(): number {
    return this.queue.length;
  }

  get lastSupabasePush(): string | null {
    return this.lastPushTimestamp;
  }

  get degraded(): boolean {
    return this.consecutiveFailures >= 3;
  }

  async write(record: TelemetryPacket): Promise<void> {
    const { error } = await this.supabase
      .from('telemetry_logs')
      .insert({
        vehicle_id: record.vehicleId,
        lat: record.lat,
        lng: record.lng,
        temp: record.temp,
        voltage: record.voltage,
        rpm: record.rpm,
        dtc_codes: [],
        timestamp: record.timestamp,
      } as never);

    if (error) {
      this.consecutiveFailures++;
      this.enqueue(record);
      if (this.consecutiveFailures >= 3) {
        logger.error(
          { consecutiveFailures: this.consecutiveFailures },
          'Supabase failure alert'
        );
      }
      this.scheduleRetry();
    } else {
      this.consecutiveFailures = 0;
      this.retryCount = 0;
      this.lastPushTimestamp = new Date().toISOString();
      if (this.queue.length > 0) {
        setImmediate(() => this.drainQueue());
      }
    }
  }

  private enqueue(record: TelemetryPacket): void {
    if (this.queue.length >= this.queueMaxSize) {
      logger.warn({ queueDepth: this.queue.length }, 'Queue full — discarding oldest');
      this.queue.shift();
    }
    this.queue.push(record);
  }

  private scheduleRetry(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
    }
    const delay = Math.min(1000 * Math.pow(2, this.retryCount), 60000);
    this.retryCount++;
    this.retryTimer = setTimeout(() => this.drainQueue(), delay);
  }

  private async drainQueue(): Promise<void> {
    while (this.queue.length > 0) {
      const record = this.queue.shift()!;
      const { error } = await this.supabase
        .from('telemetry_logs')
        .insert({
          vehicle_id: record.vehicleId,
          lat: record.lat,
          lng: record.lng,
          temp: record.temp,
          voltage: record.voltage,
          rpm: record.rpm,
          dtc_codes: [],
          timestamp: record.timestamp,
        } as never);

      if (error) {
        this.queue.unshift(record);
        this.scheduleRetry();
        return;
      }

      this.lastPushTimestamp = new Date().toISOString();
    }
    this.retryCount = 0;
  }
}
