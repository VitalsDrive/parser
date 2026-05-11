import * as net from 'net';
import { logger } from './logger';
import { parseCodec8ExtendedPacket } from './protocol-parser';
import { DeviceAuth } from './device-auth';
import { TelemetryWriter } from './telemetry-writer';
import { ConnectionState, TelemetryPacket } from './types';

export class ConnectionHandler {
  private readonly deviceAuth: DeviceAuth;
  private readonly telemetryWriter: TelemetryWriter;
  private readonly sessions: Map<string, net.Socket> = new Map();

  constructor(deviceAuth: DeviceAuth, telemetryWriter: TelemetryWriter) {
    this.deviceAuth = deviceAuth;
    this.telemetryWriter = telemetryWriter;
  }

  get activeConnections(): number {
    return this.sessions.size;
  }

  handleConnection(socket: net.Socket): void {
    const remoteAddress = `${socket.remoteAddress}:${socket.remotePort}`;
    logger.info({ remoteAddress }, 'new connection');

    let buffer: Buffer = Buffer.alloc(0);
    const connState: ConnectionState = { imei: null, authenticated: false };

    socket.on('data', async (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      await this.processBuffer(buffer, remoteAddress, socket, connState, (updated) => {
        buffer = updated;
      });
    });

    socket.on('close', () => {
      if (connState.imei && this.sessions.get(connState.imei) === socket) {
        this.sessions.delete(connState.imei);
      }
      buffer = Buffer.alloc(0); // D-10: discard partial buffer on disconnect
      logger.info({ remoteAddress, imei: connState.imei }, 'connection closed');
    });

    socket.on('error', (err: Error) => {
      logger.error({ err: err.message, remoteAddress }, 'socket error');
    });
  }

  /** D-11: Handle duplicate IMEI login by destroying previous session. */
  onLogin(imei: string, socket: net.Socket): void {
    const existing = this.sessions.get(imei);
    if (existing && existing !== socket) {
      logger.warn({ imei }, 'duplicate login — closing previous session');
      existing.destroy();
    }
    this.sessions.set(imei, socket);
  }

  private async processBuffer(
    buffer: Buffer,
    remoteAddress: string,
    socket: net.Socket,
    connState: ConnectionState,
    updateBuffer: (b: Buffer) => void
  ): Promise<void> {
    // Phase 1: IMEI login
    if (!connState.authenticated) {
      const { imei, consumed } = this.deviceAuth.validateImei(buffer);

      if (imei) {
        connState.imei = imei;
        connState.authenticated = true;
        this.onLogin(imei, socket);
        socket.write(Buffer.from([0x01]));
        updateBuffer(buffer.slice(consumed));
        logger.info({ remoteAddress, imei }, 'device authenticated');
        return;
      }

      if (consumed === 15) {
        // Invalid 15-byte prefix — discard and log
        logger.warn({ remoteAddress }, 'invalid IMEI prefix — discarding 15 bytes');
        updateBuffer(buffer.slice(15));
        return;
      }

      // Partial — wait for more data
      return;
    }

    if (!connState.imei) {
      return;
    }

    const imei = connState.imei;

    // Phase 2: parse telemetry packets
    const result = parseCodec8ExtendedPacket(buffer, imei);

    if (result.consumed === 0) {
      // Partial packet — keep buffer
      return;
    }

    updateBuffer(buffer.slice(result.consumed));

    if (result.error) {
      logger.warn({ error: result.error, imei, remoteAddress }, 'parse error');
      return;
    }

    // Process each AVL record
    for (const record of result.records) {
      const device = await this.deviceAuth.lookupDevice(imei);
      if (!device) {
        continue;
      }

      await this.deviceAuth.updateLastSeen(imei);

      const packet: TelemetryPacket = {
        vehicleId: device.vehicle_id as string,
        imei,
        lat: record.lat,
        lng: record.lng,
        speed: record.speed,
        temp: record.temp,
        voltage: record.voltage,
        rpm: record.rpm,
        dtcCodes: [],
        timestamp: record.timestamp,
      };

      await this.telemetryWriter.write(packet);
    }

    // Send ACK: 4-byte BE record count
    const ack = Buffer.alloc(4);
    ack.writeUInt32BE(result.records.length, 0);
    socket.write(ack);
  }
}
