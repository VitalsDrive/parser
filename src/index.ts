import * as net from 'net';
import { createClient } from '@supabase/supabase-js';
import 'dotenv/config';

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

interface RegistrationData {
  fleetCode: string;
  vin: string;
  make: string;
  model: string;
  year: number;
  deviceId: string;
}

class OBD2Parser {
  private supabase: ReturnType<typeof createClient>;
  private server: net.Server;
  private readonly PORT: number;
  private deviceToVehicle: Map<string, string> = new Map();

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
    let deviceId: string | null = null;

    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      
      const result = this.processBuffer(buffer, remoteAddress, socket, deviceId, (id: string) => {
        deviceId = id;
      });
      
      if (result.buffer) {
        buffer = result.buffer;
      }
      if (result.vehicleId) {
        deviceId = result.vehicleId;
      }
    });

    socket.on('close', () => {
      console.log(`Connection closed: ${remoteAddress}`);
    });

    socket.on('error', (err) => {
      console.error(`Socket error (${remoteAddress}):`, err.message);
    });
  }

  private processBuffer(
    buffer: Buffer, 
    remoteAddress: string, 
    socket: net.Socket,
    currentDeviceId: string | null,
    setDeviceId: (id: string) => void
  ): { buffer: Buffer | null; vehicleId: string | null } {
    
    // Check for registration packet first (ASCII text format)
    // Registration format: "REG|fleetCode|vin|make|model|year|deviceId\n"
    const textEnd = buffer.indexOf(10); // Look for newline
    if (textEnd !== -1 && buffer[0] === 0x52) { // 'R'
      const textPacket = buffer.slice(0, textEnd).toString('utf8');
      if (textPacket.startsWith('REG|')) {
        const parts = textPacket.split('|');
        if (parts.length >= 7) {
          const regData: RegistrationData = {
            fleetCode: parts[1],
            vin: parts[2],
            make: parts[3],
            model: parts[4],
            year: parseInt(parts[5], 10),
            deviceId: parts[6]
          };
          
          console.log(`[${remoteAddress}] Registration request:`, regData);
          
          this.registerDevice(regData)
            .then(vehicleId => {
              if (vehicleId) {
                this.deviceToVehicle.set(regData.deviceId, vehicleId);
                setDeviceId(vehicleId);
                socket.write(`ACK|${vehicleId}\n`);
                console.log(`[${remoteAddress}] Device registered, vehicleId: ${vehicleId}`);
              } else {
                socket.write(`NACK|Invalid fleet code\n`);
                console.error(`[${remoteAddress}] Registration failed: invalid fleet code`);
              }
            })
            .catch(err => {
              socket.write(`NACK|${err.message}\n`);
              console.error(`[${remoteAddress}] Registration failed:`, err);
            });
          
          return { buffer: buffer.slice(textEnd + 1), vehicleId: null };
        }
      }
    }

    // Look for binary telemetry packet start bytes (0x78 0x78)
    let startIndex = -1;
    for (let i = 0; i < buffer.length - 1; i++) {
      if (buffer[i] === 0x78 && buffer[i + 1] === 0x78) {
        startIndex = i;
        break;
      }
    }

    if (startIndex === -1) {
      return { buffer: null, vehicleId: null };
    }

    if (startIndex > 0) {
      buffer = buffer.slice(startIndex);
    }

    if (buffer.length < 4) {
      return { buffer: null, vehicleId: null };
    }

    const packetLength = buffer[2];
    const totalPacketSize = 2 + 1 + 1 + packetLength + 2;

    if (buffer.length < totalPacketSize) {
      return { buffer: null, vehicleId: null };
    }

    const packet = buffer.slice(0, totalPacketSize);
    const remaining = buffer.slice(totalPacketSize);

    try {
      const telemetry = this.parsePacket(packet, currentDeviceId, remoteAddress);
      if (telemetry) {
        console.log(`[${remoteAddress}] Parsed telemetry:`, telemetry);
        this.writeToSupabase(telemetry);
        this.updateVehicleLastSeen(telemetry.vehicleId);
      }
    } catch (err) {
      console.error(`[${remoteAddress}] Failed to parse packet:`, err);
    }

    return { buffer: remaining.length > 0 ? remaining : null, vehicleId: null };
  }

  private async registerDevice(data: RegistrationData): Promise<string | null> {
    const { data: result, error } = await this.supabase
      .rpc('register_device_and_vehicle', {
        p_fleet_code: data.fleetCode,
        p_vin: data.vin,
        p_make: data.make,
        p_model: data.model,
        p_year: data.year,
        p_device_id: data.deviceId
      }) as { data: string | null; error: any };

    if (error) {
      console.error('Failed to register device:', error);
      throw error;
    }

    return result;
  }

  private async updateVehicleLastSeen(vehicleId: string): Promise<void> {
    await this.supabase
      .from('vehicles')
      .update({ last_seen: new Date().toISOString() })
      .eq('id', vehicleId);
  }

  private parsePacket(packet: Buffer, deviceId: string | null, remoteAddress: string): TelemetryPacket | null {
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

    let vehicleId: string;
    
    if (deviceId && this.deviceToVehicle.has(deviceId)) {
      vehicleId = this.deviceToVehicle.get(deviceId)!;
    } else if (process.env.DEFAULT_VEHICLE_ID) {
      vehicleId = process.env.DEFAULT_VEHICLE_ID;
    } else {
      console.warn(`[${remoteAddress}] No vehicleId for telemetry, skipping`);
      return null;
    }

    return {
      vehicleId,
      lat: latRaw / 1_000_000,
      lng: lngRaw / 1_000_000,
      temp,
      voltage: voltageRaw / 1000,
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
      } as any);

    if (error) {
      console.error('Failed to write to Supabase:', error);
    }
  }
}

const parser = new OBD2Parser();
parser.start();

export { OBD2Parser, TelemetryPacket, RegistrationData };
