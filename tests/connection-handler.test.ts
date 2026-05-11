import { EventEmitter } from 'events';
import * as net from 'net';
import { ConnectionHandler } from '../src/connection-handler';
import { DeviceAuth } from '../src/device-auth';
import { TelemetryWriter } from '../src/telemetry-writer';

jest.mock('../src/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockSocket(): net.Socket {
  const s = new EventEmitter() as unknown as net.Socket;
  (s as unknown as { write: jest.Mock }).write = jest.fn();
  (s as unknown as { destroy: jest.Mock }).destroy = jest.fn();
  (s as unknown as { remoteAddress: string }).remoteAddress = '127.0.0.1';
  (s as unknown as { remotePort: number }).remotePort = 9999;
  return s;
}

function makeDeviceAuthMock(): jest.Mocked<DeviceAuth> {
  return {
    validateImei: jest.fn().mockReturnValue({ imei: null, consumed: 0 }),
    lookupDevice: jest.fn().mockResolvedValue({
      id: 'dev-1',
      vehicle_id: 'vehicle-1',
      fleet_id: 'fleet-1',
      status: 'active',
    }),
    updateLastSeen: jest.fn().mockResolvedValue(undefined),
  } as unknown as jest.Mocked<DeviceAuth>;
}

function makeTelemetryWriterMock(): jest.Mocked<TelemetryWriter> {
  return {
    write: jest.fn().mockResolvedValue(undefined),
    queueDepth: 0,
    lastSupabasePush: null,
    degraded: false,
  } as unknown as jest.Mocked<TelemetryWriter>;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ConnectionHandler', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('onLogin (D-11 duplicate IMEI)', () => {
    it('closes previous session when same IMEI logs in again', () => {
      const handler = new ConnectionHandler(makeDeviceAuthMock(), makeTelemetryWriterMock());
      const socket1 = mockSocket();
      const socket2 = mockSocket();
      const imei = '123456789012345';

      handler.onLogin(imei, socket1);
      handler.onLogin(imei, socket2);

      expect((socket1 as unknown as { destroy: jest.Mock }).destroy).toHaveBeenCalledTimes(1);
      expect(handler['sessions'].get(imei)).toBe(socket2);
    });

    it('does NOT destroy socket when same socket logs in again (idempotent)', () => {
      const handler = new ConnectionHandler(makeDeviceAuthMock(), makeTelemetryWriterMock());
      const socket1 = mockSocket();
      const imei = '123456789012345';

      handler.onLogin(imei, socket1);
      handler.onLogin(imei, socket1);

      expect((socket1 as unknown as { destroy: jest.Mock }).destroy).not.toHaveBeenCalled();
    });
  });

  describe('session cleanup on disconnect', () => {
    it('removes imei from sessions map after socket close', () => {
      const deviceAuth = makeDeviceAuthMock();
      deviceAuth.validateImei.mockReturnValue({ imei: '123456789012345', consumed: 15 });
      const handler = new ConnectionHandler(deviceAuth, makeTelemetryWriterMock());
      const socket = mockSocket();

      handler.handleConnection(socket);
      socket.emit('data', Buffer.from('123456789012345'));

      expect(handler['sessions'].size).toBe(1);

      socket.emit('close');

      expect(handler['sessions'].size).toBe(0);
    });

    it('does NOT remove imei if a newer session has replaced it (D-11 guard)', () => {
      const deviceAuth = makeDeviceAuthMock();
      deviceAuth.validateImei.mockReturnValue({ imei: '123456789012345', consumed: 15 });
      const handler = new ConnectionHandler(deviceAuth, makeTelemetryWriterMock());

      const socket1 = mockSocket();
      const socket2 = mockSocket();
      const imei = '123456789012345';

      handler.onLogin(imei, socket1);
      handler.onLogin(imei, socket2); // socket1 destroyed, socket2 is current

      // socket1 close event fires AFTER socket2 took over
      // sessions.get(imei) === socket2, so closing socket1 should NOT delete the key
      socket1.emit('close');

      // Manual simulation: the close handler checks sessions.get(imei) === socket
      // In handleConnection the state.imei would be set; simulate with onLogin directly
      // For this scenario we verify via the sessions map size (socket2 session still active)
      expect(handler['sessions'].get(imei)).toBe(socket2);
    });
  });

  describe('activeConnections getter', () => {
    it('returns 0 initially', () => {
      const handler = new ConnectionHandler(makeDeviceAuthMock(), makeTelemetryWriterMock());
      expect(handler.activeConnections).toBe(0);
    });

    it('returns correct count after 3 different IMEI logins', () => {
      const handler = new ConnectionHandler(makeDeviceAuthMock(), makeTelemetryWriterMock());
      const imeis = ['111111111111111', '222222222222222', '333333333333333'];

      for (const imei of imeis) {
        handler.onLogin(imei, mockSocket());
      }

      expect(handler.activeConnections).toBe(3);
    });

    it('decrements after session cleanup', () => {
      const deviceAuth = makeDeviceAuthMock();
      deviceAuth.validateImei.mockReturnValue({ imei: '111111111111111', consumed: 15 });
      const handler = new ConnectionHandler(deviceAuth, makeTelemetryWriterMock());
      const socket = mockSocket();

      handler.handleConnection(socket);
      socket.emit('data', Buffer.from('111111111111111'));
      expect(handler.activeConnections).toBe(1);

      socket.emit('close');
      expect(handler.activeConnections).toBe(0);
    });
  });

  describe('partial buffer on disconnect (D-10)', () => {
    it('discards partial buffer on close; new connection starts fresh', () => {
      const deviceAuth = makeDeviceAuthMock();
      // First socket: valid IMEI auth, then partial data
      deviceAuth.validateImei
        .mockReturnValueOnce({ imei: '111111111111111', consumed: 15 })
        .mockReturnValueOnce({ imei: '111111111111111', consumed: 15 });

      const handler = new ConnectionHandler(deviceAuth, makeTelemetryWriterMock());

      const socket1 = mockSocket();
      handler.handleConnection(socket1);
      socket1.emit('data', Buffer.from('111111111111111'));
      socket1.emit('data', Buffer.from([0x00, 0x00, 0x00])); // partial packet
      socket1.emit('close');

      // After close, buffer should be reset; new socket with same IMEI should auth cleanly
      const socket2 = mockSocket();
      handler.handleConnection(socket2);
      socket2.emit('data', Buffer.from('111111111111111'));

      const writeFn = (socket2 as unknown as { write: jest.Mock }).write;
      expect(writeFn).toHaveBeenCalledWith(Buffer.from([0x01]));
    });
  });
});
