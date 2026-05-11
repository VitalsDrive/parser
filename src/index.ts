import * as net from 'net';
import { createClient } from '@supabase/supabase-js';
import 'dotenv/config';

interface TelemetryPacket {
  vehicleId: string;
  imei: string;
  lat: number;
  lng: number;
  speed: number;
  temp: number;
  voltage: number;
  rpm: number;
  dtcCodes: string[];
  timestamp: string;
}

interface DeviceLookup {
  id: string;
  vehicle_id: string | null;
  fleet_id: string;
  status: 'unassigned' | 'active' | 'inactive';
}

interface ConnectionState {
  imei: string | null;
  authenticated: boolean;
}

// CRC-16-IBM (polynomial 0x1021, initial 0x0000)
function crc16(data: Buffer): number {
  let crc = 0x0000;
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i] << 8;
    for (let j = 0; j < 8; j++) {
      if (crc & 0x8000) {
        crc = (crc << 1) ^ 0x1021;
      } else {
        crc = crc << 1;
      }
    }
  }
  return crc & 0xFFFF;
}

class OBD2Parser {
  private supabase: ReturnType<typeof createClient>;
  private server: net.Server;
  private readonly PORT: number;

  constructor() {
    this.PORT = parseInt(process.env.PARSER_PORT || '5050', 10);

    this.supabase = createClient(
      process.env.SUPABASE_URL || '',
      process.env.SUPABASE_SERVICE_ROLE_KEY || ''
    );

    this.server = net.createServer(this.handleConnection.bind(this));
  }

  start(): void {
    this.server.listen(this.PORT, () => {
      console.log(`OBD2 Parser (Codec 8 Extended) listening on port ${this.PORT}`);
    });
  }

  private handleConnection(socket: net.Socket): void {
    const remoteAddress = `${socket.remoteAddress}:${socket.remotePort}`;
    console.log(`New connection from ${remoteAddress}`);

    let buffer: Buffer = Buffer.alloc(0);
    const state: ConnectionState = { imei: null, authenticated: false };

    socket.on('data', async (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);

      const result = await this.processBuffer(buffer, remoteAddress, socket, state);

      if (result.buffer) {
        buffer = result.buffer;
      }
    });

    socket.on('close', () => {
      console.log(`Connection closed: ${remoteAddress}${state.imei ? ` (IMEI: ${state.imei})` : ''}`);
    });

    socket.on('error', (err) => {
      console.error(`Socket error (${remoteAddress}):`, err.message);
    });
  }

  private async processBuffer(
    buffer: Buffer,
    remoteAddress: string,
    socket: net.Socket,
    state: ConnectionState
  ): Promise<{ buffer: Buffer | null }> {

    // Phase 1: Wait for IMEI login (raw 15-digit ASCII)
    if (!state.authenticated) {
      // IMEI is 15 ASCII digits — wait until we have at least 15 bytes
      if (buffer.length < 15) {
        return { buffer: null };
      }

      const imeiStr = buffer.slice(0, 15).toString('ascii');
      const imeiMatch = imeiStr.match(/^\d{15}$/);

      if (imeiMatch) {
        state.imei = imeiStr;
        state.authenticated = true;

        // Send single byte ACK: 0x01
        socket.write(Buffer.from([0x01]));
        console.log(`[${remoteAddress}] Device IMEI: ${state.imei} — authenticated`);

        return { buffer: buffer.slice(15) };
      }

      // Not a valid IMEI yet — could be partial, keep accumulating
      // If we have >15 bytes and first 15 aren't a valid IMEI, discard and wait for new data
      if (buffer.length > 15) {
        console.error(`[${remoteAddress}] Invalid IMEI prefix: ${buffer.slice(0, 15).toString('ascii')}`);
        return { buffer: buffer.slice(15) };
      }

      return { buffer: null };
    }

    // Phase 2: Parse Codec 8 Extended data packets
    if (!state.imei) {
      return { buffer: null };
    }

    // Look for preamble: 0x00 0x00 0x00 0x00
    let preambleIndex = -1;
    for (let i = 0; i <= buffer.length - 4; i++) {
      if (buffer[i] === 0x00 && buffer[i + 1] === 0x00 && buffer[i + 2] === 0x00 && buffer[i + 3] === 0x00) {
        preambleIndex = i;
        break;
      }
    }

    if (preambleIndex === -1) {
      // No preamble found — discard buffer to avoid memory growth
      if (buffer.length > 100) {
        console.error(`[${remoteAddress}] Discarding ${buffer.length} bytes with no valid preamble`);
        return { buffer: null };
      }
      return { buffer: null };
    }

    if (preambleIndex > 0) {
      buffer = buffer.slice(preambleIndex);
    }

    // Need at least preamble(4) + length(4) + codec(1) + numRecords(2) = 11 bytes
    if (buffer.length < 11) {
      return { buffer: null };
    }

    const dataLength = buffer.readUInt32BE(4);
    const totalPacketSize = 4 + 4 + dataLength;

    if (buffer.length < totalPacketSize) {
      return { buffer: null };
    }

    const packet = buffer.slice(0, totalPacketSize);
    const remaining = buffer.slice(totalPacketSize);

    // Parse Codec 8 Extended payload
    const payload = packet.slice(8); // skip preamble + length
    const codecId = payload[0];

    if (codecId !== 0x8E) {
      console.error(`[${remoteAddress}] Unknown codec ID: 0x${codecId.toString(16).padStart(2, '0')}`);
      return { buffer: remaining.length > 0 ? (remaining as Buffer) : null };
    }

    const numRecords = payload.readUInt16BE(1);

    // Validate CRC: from codec ID (byte 0 of payload) through second num records
    const crcEndOffset = 1 + 2 + this.getAVLRecordSize(payload, numRecords) + 2;
    if (crcEndOffset > payload.length) {
      console.error(`[${remoteAddress}] Packet too short for declared records`);
      return { buffer: remaining.length > 0 ? (remaining as Buffer) : null };
    }

    const crcData = payload.slice(0, crcEndOffset);
    const expectedCrc = payload.readUInt16BE(crcEndOffset);
    const calculatedCrc = crc16(crcData);

    if (expectedCrc !== calculatedCrc) {
      console.error(`[${remoteAddress}] CRC mismatch: expected 0x${expectedCrc.toString(16).padStart(4, '0')}, got 0x${calculatedCrc.toString(16).padStart(4, '0')}`);
      return { buffer: remaining.length > 0 ? (remaining as Buffer) : null };
    }

    // Parse AVL records
    let offset = 3; // skip codec ID + num records
    for (let i = 0; i < numRecords; i++) {
      const telemetry = this.parseAVLRecord(payload, offset, state.imei, remoteAddress);
      if (telemetry) {
        this.processTelemetry(telemetry);
      }
      offset += this.getAVLRecordSizeAt(payload, offset);
    }

    // Send ACK: 4-byte big-endian record count
    const ack = Buffer.alloc(4);
    ack.writeUInt32BE(numRecords, 0);
    socket.write(ack);

    return { buffer: remaining.length > 0 ? (remaining as Buffer) : null };
  }

  private getAVLRecordSize(payload: Buffer, numRecords: number): number {
    // Calculate total size of all AVL records + repeated num records
    // We need to parse through to find where records end
    let offset = 3; // skip codec ID + num records
    for (let i = 0; i < numRecords; i++) {
      offset += this.getAVLRecordSizeAt(payload, offset);
    }
    offset += 2; // repeated num records
    return offset - 3; // subtract the header bytes
  }

  private getAVLRecordSizeAt(payload: Buffer, offset: number): number {
    const fixedSize = 28; // fixed part of AVL record
    if (offset + fixedSize > payload.length) return payload.length - offset;

    const ioCount = payload.readUInt16BE(offset + 27);
    let ioOffset = offset + 29; // skip fixed part

    for (let i = 0; i < ioCount; i++) {
      if (ioOffset + 3 > payload.length) break;
      const ioType = payload[ioOffset + 2];
      let valueSize = 1;
      switch (ioType) {
        case 1: valueSize = 1; break;
        case 2: valueSize = 2; break;
        case 3: valueSize = 4; break;
        case 4: valueSize = 8; break;
        case 5: valueSize = 4; break;
        case 6: valueSize = 8; break;
        case 0xFF: valueSize = payload[ioOffset + 3] || 0; break; // string type
        default: valueSize = 1;
      }
      ioOffset += 3 + valueSize; // ID(2) + type(1) + value
    }

    return ioOffset - offset;
  }

  private parseAVLRecord(
    payload: Buffer,
    offset: number,
    imei: string,
    remoteAddress: string
  ): TelemetryPacket | null {
    if (offset + 28 > payload.length) {
      console.error(`[${remoteAddress}] AVL record too short at offset ${offset}`);
      return null;
    }

    const timestamp = payload.readBigUInt64BE(offset);
    // priority: payload[offset + 8]
    const lngRaw = payload.readInt32BE(offset + 9);
    const latRaw = payload.readInt32BE(offset + 13);
    // altitude: payload.readInt16BE(offset + 17)
    // angle: payload.readUInt16BE(offset + 19)
    // satellites: payload.readUInt16BE(offset + 21)
    const speedRaw = payload.readUInt16BE(offset + 23);
    // event ID: payload.readUInt16BE(offset + 25)

    const ioCount = payload.readUInt16BE(offset + 27);
    let ioOffset = offset + 29;

    let voltage = 0;
    let temp = 0;
    let rpm = 0;
    let speed = speedRaw / 10; // km/h × 10 → km/h

    for (let i = 0; i < ioCount; i++) {
      if (ioOffset + 3 > payload.length) break;

      const ioId = payload.readUInt16BE(ioOffset);
      const ioType = payload[ioOffset + 2];
      ioOffset += 3;

      switch (ioId) {
        case 67: // Battery Voltage (uint16 BE, mV)
          voltage = payload.readUInt16BE(ioOffset) / 1000;
          break;
        case 128: // Engine Temperature (uint16 BE, °C×10)
          temp = payload.readUInt16BE(ioOffset) / 10;
          break;
        case 179: // Engine RPM (uint32 BE)
          rpm = payload.readUInt32BE(ioOffset);
          break;
        case 5: // Speed (uint8, km/h) — redundant but use if present
          speed = payload[ioOffset];
          break;
      }

      let valueSize = 1;
      switch (ioType) {
        case 1: valueSize = 1; break;
        case 2: valueSize = 2; break;
        case 3: valueSize = 4; break;
        case 4: valueSize = 8; break;
        case 5: valueSize = 4; break;
        case 6: valueSize = 8; break;
        default: valueSize = 1;
      }
      ioOffset += valueSize;
    }

    return {
      vehicleId: '', // Filled by processTelemetry
      imei,
      lat: latRaw / 10_000_000,
      lng: lngRaw / 10_000_000,
      speed: Math.round(speed),
      temp: Math.round(temp),
      voltage: Math.round(voltage * 100) / 100,
      rpm,
      dtcCodes: [],
      timestamp: new Date().toISOString()
    };
  }

  private async processTelemetry(telemetry: TelemetryPacket): Promise<void> {
    if (!telemetry.imei) {
      console.warn(`No IMEI for telemetry, skipping`);
      return;
    }

    try {
      const { data, error } = await this.supabase
        .from('devices')
        .select('id, vehicle_id, fleet_id, status')
        .eq('imei', telemetry.imei)
        .single() as { data: DeviceLookup | null; error: any };

      if (error || !data) {
        console.warn(`[${telemetry.imei}] Unknown device IMEI — not pre-provisioned, skipping telemetry`);
        return;
      }

      // Update last_seen on every packet
      await this.updateDeviceLastSeen(telemetry.imei);

      // Reject inactive devices
      if (data.status === 'inactive') {
        console.warn(`[${telemetry.imei}] Inactive device — skipping telemetry`);
        return;
      }

      // Reject unassigned devices
      if (!data.vehicle_id) {
        console.warn(`[${telemetry.imei}] Device not assigned to vehicle (status=${data.status}) — skipping telemetry`);
        return;
      }

      // Valid — write telemetry
      await this.writeToSupabase({
        ...telemetry,
        vehicleId: data.vehicle_id
      });

    } catch (err) {
      console.error(`[${telemetry.imei}] Failed to process telemetry:`, err);
    }
  }

  private async updateDeviceLastSeen(imei: string): Promise<void> {
    const { error } = await (this.supabase
      .from('devices') as any)
      .update({ last_seen: new Date().toISOString() })
      .eq('imei', imei);

    if (error) {
      console.error('Failed to update device last_seen:', error);
    }
  }

  private async writeToSupabase(telemetry: TelemetryPacket): Promise<void> {
    const { error } = await this.supabase
      .from('telemetry_logs')
      .insert({
        vehicle_id: telemetry.vehicleId,
        lat: telemetry.lat,
        lng: telemetry.lng,
        temp: telemetry.temp,
        voltage: telemetry.voltage,
        rpm: telemetry.rpm,
        dtc_codes: telemetry.dtcCodes,
        timestamp: telemetry.timestamp
      } as any);

    if (error) {
      console.error('Failed to write to Supabase:', error);
    } else {
      console.log(`[telemetry] Written: vehicle=${telemetry.vehicleId}, temp=${telemetry.temp}°C, voltage=${telemetry.voltage}V, rpm=${telemetry.rpm}`);
    }
  }
}

const parser = new OBD2Parser();
parser.start();

export { OBD2Parser, TelemetryPacket };
