import * as net from 'net';
import { createClient } from '@supabase/supabase-js';

interface TelemetryPacket {
  vehicleId: string;
  lat: number;
  lng: number;
  temp: number;
  voltage: number;
  rpm: number;
  dtcCodes: string[];
  timestamp: string;
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
      console.log(`OBD2 Parser listening on port ${this.PORT}`);
    });
  }

  private handleConnection(socket: net.Socket): void {
    const remoteAddress = `${socket.remoteAddress}:${socket.remotePort}`;
    console.log(`New connection from ${remoteAddress}`);

    let buffer = Buffer.alloc(0);

    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      this.processBuffer(socket, buffer, remoteAddress);
    });

    socket.on('close', () => {
      console.log(`Connection closed: ${remoteAddress}`);
    });

    socket.on('error', (err) => {
      console.error(`Socket error (${remoteAddress}):`, err.message);
    });
  }

  private processBuffer(socket: net.Socket, buffer: Buffer, remoteAddress: string): void {
    // Look for packet start bytes (0x78 0x78)
    let startIndex = -1;
    for (let i = 0; i < buffer.length - 1; i++) {
      if (buffer[i] === 0x78 && buffer[i + 1] === 0x78) {
        startIndex = i;
        break;
      }
    }

    if (startIndex === -1) {
      // No start bytes found, keep waiting
      return;
    }

    // Skip to start
    if (startIndex > 0) {
      buffer = buffer.slice(startIndex);
    }

    // Need at least 4 bytes to get length
    if (buffer.length < 4) {
      return;
    }

    const packetLength = buffer[2];
    const totalPacketSize = packetLength + 4; // +4 for start bytes, length, and stop bytes

    if (buffer.length < totalPacketSize) {
      // Wait for more data
      return;
    }

    // Extract packet
    const packet = buffer.slice(0, totalPacketSize);
    buffer = buffer.slice(totalPacketSize);

    // Parse packet
    try {
      const telemetry = this.parsePacket(packet);
      console.log(`[${remoteAddress}] Parsed telemetry:`, telemetry);
      this.writeToSupabase(telemetry);
    } catch (err) {
      console.error(`[${remoteAddress}] Failed to parse packet:`, err);
    }

    // Process any remaining data
    if (buffer.length > 0) {
      this.processBuffer(socket, buffer, remoteAddress);
    }
  }

  private parsePacket(packet: Buffer): TelemetryPacket {
    // Protocol: SinoTrack/Micodus style
    // [0-1] Start: 0x78 0x78
    // [2] Length
    // [3] Protocol (0x22 = data)
    // [4-7] Latitude (int32, little endian, degrees * 1e6)
    // [8-11] Longitude (int32, little endian, degrees * 1e6)
    // [12] Speed (uint8, km/h)
    // [13-14] Voltage (uint16, little endian, mV)
    // [15] Temp (uint8, °C, signed?)
    // [16-17] RPM (uint16, little endian)
    // [18-19] CRC (uint16, little endian)
    // [20-21] Stop: 0x0D 0x0A

    const latRaw = packet.readInt32LE(4);
    const lngRaw = packet.readInt32LE(8);
    const speed = packet[12];
    const voltageRaw = packet.readUInt16LE(13);
    const temp = packet[15];
    const rpm = packet.readUInt16LE(16);

    // Vehicle ID derived from protocol - in real impl, would map device ID to vehicle
    // For now, use a placeholder that would be looked up from a devices table
    const vehicleId = process.env.DEFAULT_VEHICLE_ID || 'ghost-vehicle-01';

    return {
      vehicleId,
      lat: latRaw / 1_000_000,
      lng: lngRaw / 1_000_000,
      temp,
      voltage: voltageRaw / 1000, // Convert mV to V
      rpm,
      dtcCodes: [],
      timestamp: new Date().toISOString()
    };
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
      });

    if (error) {
      console.error('Failed to write to Supabase:', error);
    }
  }
}

// Start server
const parser = new OBD2Parser();
parser.start();

export { OBD2Parser, TelemetryPacket };
