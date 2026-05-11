import { SupabaseClient } from '@supabase/supabase-js';
import { logger } from './logger';
import { DeviceLookup } from './types';

export class DeviceAuth {
  private readonly supabase: SupabaseClient;

  constructor(supabase: SupabaseClient) {
    this.supabase = supabase;
  }

  /**
   * Pure synchronous IMEI validation from a raw TCP buffer.
   * Returns { imei, consumed } where:
   *   - imei non-null + consumed=15  → valid IMEI, advance buffer by 15
   *   - imei null   + consumed=15    → invalid 15-byte prefix, discard
   *   - imei null   + consumed=0     → partial, wait for more data
   */
  validateImei(buffer: Buffer): { imei: string | null; consumed: number } {
    if (buffer.length < 15) {
      return { imei: null, consumed: 0 };
    }

    const candidate = buffer.slice(0, 15).toString('ascii');
    if (/^\d{15}$/.test(candidate)) {
      return { imei: candidate, consumed: 15 };
    }

    // Have >=15 bytes but prefix is invalid — discard 15 bytes
    if (buffer.length > 15) {
      return { imei: null, consumed: 15 };
    }

    return { imei: null, consumed: 0 };
  }

  /**
   * Lookup device by IMEI in Supabase devices table.
   * Returns null for: unknown IMEI, inactive device, unassigned device.
   */
  async lookupDevice(imei: string): Promise<DeviceLookup | null> {
    const { data, error } = (await this.supabase
      .from('devices')
      .select('id, vehicle_id, fleet_id, status')
      .eq('imei', imei)
      .single()) as { data: DeviceLookup | null; error: unknown };

    if (error || !data) {
      logger.warn({ imei }, 'Unknown device IMEI — not pre-provisioned, skipping telemetry');
      return null;
    }

    if (data.status === 'inactive') {
      logger.warn({ imei }, 'Inactive device — skipping telemetry');
      return null;
    }

    if (!data.vehicle_id) {
      logger.warn({ imei, status: data.status }, 'Device not assigned to vehicle — skipping telemetry');
      return null;
    }

    return data;
  }

  /**
   * Update last_seen timestamp for a device in Supabase.
   * Logs error on failure, never throws.
   */
  async updateLastSeen(imei: string): Promise<void> {
    const { error } = await (this.supabase
      .from('devices') as ReturnType<SupabaseClient['from']>)
      .update({ last_seen: new Date().toISOString() })
      .eq('imei', imei);

    if (error) {
      logger.error({ imei, error }, 'Failed to update device last_seen');
    }
  }
}
