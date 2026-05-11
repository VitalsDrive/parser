import { parseCodec8ExtendedPacket, crc16 } from '../src/protocol-parser';

jest.mock('../src/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// ---------------------------------------------------------------------------
// Local test-packet builder using FMC003 IO IDs (7040/7044/7045/7059/7038)
// Adapted from packages/simulator/src/index.ts buildCodec8ExtendedPacket
// ---------------------------------------------------------------------------

interface IOElement {
  ioId: number;
  ioType: number; // 1=uint8, 2=uint16, 3=uint32, 4=uint64
  value: number;
}

interface BuildOptions {
  ioElements?: IOElement[];
  corruptCrc?: boolean;
  lat?: number;
  lng?: number;
  speed?: number; // header speed × 10
  codecId?: number; // default 0x8E
}

function buildTestPacket(opts: BuildOptions = {}): Buffer {
  const timestamp = BigInt(Date.now());
  const latInt = Math.floor((opts.lat ?? 37.7749) * 10_000_000);
  const lngInt = Math.floor((opts.lng ?? -122.4194) * 10_000_000);
  const speedInt = opts.speed ?? 0;

  // Build IO elements buffer
  const ioBufs: Buffer[] = [];
  const elements: IOElement[] = opts.ioElements ?? [];

  for (const el of elements) {
    let valueBytes: number;
    switch (el.ioType) {
      case 1: valueBytes = 1; break;
      case 2: valueBytes = 2; break;
      case 3: valueBytes = 4; break;
      case 4: valueBytes = 8; break;
      default: valueBytes = 2;
    }
    const buf = Buffer.alloc(3 + valueBytes);
    buf.writeUInt16BE(el.ioId, 0);
    buf[2] = el.ioType;
    switch (el.ioType) {
      case 1: buf.writeUInt8(el.value & 0xFF, 3); break;
      case 2: buf.writeUInt16BE(el.value, 3); break;
      case 3: buf.writeUInt32BE(el.value >>> 0, 3); break;
      case 4:
        buf.writeUInt32BE(0, 3);
        buf.writeUInt32BE(el.value >>> 0, 7);
        break;
    }
    ioBufs.push(buf);
  }

  const ioData = Buffer.concat(ioBufs);
  const ioCount = elements.length;

  // Fixed AVL record header (29 bytes: 8 ts + 1 prio + 4 lng + 4 lat + 2 alt + 2 angle + 2 sat + 2 speed + 2 eventId + 2 ioCount)
  const avlFixed = Buffer.alloc(29);
  avlFixed.writeBigUInt64BE(timestamp, 0);
  avlFixed[8] = 0; // priority
  avlFixed.writeInt32BE(lngInt, 9);
  avlFixed.writeInt32BE(latInt, 13);
  avlFixed.writeInt16BE(0, 17); // altitude
  avlFixed.writeUInt16BE(0, 19); // angle
  avlFixed.writeUInt16BE(8, 21); // satellites
  avlFixed.writeUInt16BE(speedInt, 23);
  avlFixed.writeUInt16BE(0, 25); // event ID
  avlFixed.writeUInt16BE(ioCount, 27);

  const avlRecord = Buffer.concat([avlFixed, ioData]);

  // Payload: codecId + numRecords(1) + avlRecord + numRecords_repeat(1)
  const header = Buffer.alloc(3);
  header[0] = opts.codecId ?? 0x8E;
  header.writeUInt16BE(1, 1); // 1 record

  const trailer = Buffer.alloc(2);
  trailer.writeUInt16BE(1, 0);

  const payload = Buffer.concat([header, avlRecord, trailer]);

  // CRC over payload
  const crc = crc16(payload);
  const crcBuf = Buffer.alloc(2);
  if (opts.corruptCrc) {
    crcBuf.writeUInt16BE((crc ^ 0xFFFF) & 0xFFFF, 0);
  } else {
    crcBuf.writeUInt16BE(crc, 0);
  }

  // Full packet: preamble(4) + length(4) + payload + crc(2)
  const preamble = Buffer.from([0x00, 0x00, 0x00, 0x00]);
  const dataLength = payload.length + 2; // payload + CRC
  const lengthBuf = Buffer.alloc(4);
  lengthBuf.writeUInt32BE(dataLength, 0);

  return Buffer.concat([preamble, lengthBuf, payload, crcBuf]);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('crc16', () => {
  it('returns a 16-bit value for known buffer', () => {
    const buf = Buffer.from([0x8E, 0x00, 0x01]);
    const result = crc16(buf);
    expect(result).toBeGreaterThanOrEqual(0);
    expect(result).toBeLessThanOrEqual(0xFFFF);
  });

  it('returns same value on repeated calls (pure function)', () => {
    const buf = Buffer.from([0x8E, 0x00, 0x01]);
    expect(crc16(buf)).toBe(crc16(buf));
  });

  it('returns 0 for empty buffer', () => {
    expect(crc16(Buffer.alloc(0))).toBe(0x0000);
  });

  it('matches expected CRC for [0x8E, 0x00, 0x01]', () => {
    // Compute expected with same algorithm
    const buf = Buffer.from([0x8E, 0x00, 0x01]);
    let crc = 0x0000;
    for (let i = 0; i < buf.length; i++) {
      crc ^= buf[i] << 8;
      for (let j = 0; j < 8; j++) {
        if (crc & 0x8000) { crc = (crc << 1) ^ 0x1021; }
        else { crc = crc << 1; }
      }
    }
    expect(crc16(buf)).toBe(crc & 0xFFFF);
  });
});

describe('parseCodec8ExtendedPacket', () => {
  const IMEI = '123456789012345';

  it('extracts IO 7040 as temp (900 raw → 90.0°C)', () => {
    const packet = buildTestPacket({
      ioElements: [{ ioId: 7040, ioType: 2, value: 900 }],
    });
    const result = parseCodec8ExtendedPacket(packet, IMEI);
    expect(result.error).toBeUndefined();
    expect(result.records).toHaveLength(1);
    expect(result.records[0].temp).toBe(90);
  });

  it('extracts IO 7044 as rpm (2500 raw)', () => {
    const packet = buildTestPacket({
      ioElements: [{ ioId: 7044, ioType: 3, value: 2500 }],
    });
    const result = parseCodec8ExtendedPacket(packet, IMEI);
    expect(result.records[0].rpm).toBe(2500);
  });

  it('extracts IO 7045 as speed (65 → 65 km/h)', () => {
    const packet = buildTestPacket({
      ioElements: [{ ioId: 7045, ioType: 2, value: 65 }],
    });
    const result = parseCodec8ExtendedPacket(packet, IMEI);
    expect(result.records[0].speed).toBe(65);
  });

  it('extracts IO 7059 as voltage (12500 raw → 12.5 V)', () => {
    const packet = buildTestPacket({
      ioElements: [{ ioId: 7059, ioType: 2, value: 12500 }],
    });
    const result = parseCodec8ExtendedPacket(packet, IMEI);
    expect(result.records[0].voltage).toBeCloseTo(12.5);
  });

  it('parses IO 7038 as dtcCount (3) — not stored in record as dtcCodes', () => {
    const packet = buildTestPacket({
      ioElements: [{ ioId: 7038, ioType: 2, value: 3 }],
    });
    const result = parseCodec8ExtendedPacket(packet, IMEI);
    expect(result.records[0].dtcCount).toBe(3);
    // dtc_codes is NOT a property of ParsedAVLRecord
    expect((result.records[0] as any).dtcCodes).toBeUndefined();
    expect((result.records[0] as any).dtc_codes).toBeUndefined();
  });

  it('rejects corrupt CRC — error matches /CRC/, records is []', () => {
    const packet = buildTestPacket({ corruptCrc: true });
    const result = parseCodec8ExtendedPacket(packet, IMEI);
    expect(result.error).toMatch(/CRC/);
    expect(result.records).toEqual([]);
  });

  it('returns consumed > 0 on CRC error (advances past bad packet)', () => {
    const packet = buildTestPacket({ corruptCrc: true });
    const result = parseCodec8ExtendedPacket(packet, IMEI);
    expect(result.consumed).toBeGreaterThan(0);
  });

  it('partial buffer — consumed === 0, records: [] (caller must keep buffer)', () => {
    const full = buildTestPacket({});
    const partial = full.slice(0, full.length - 5);
    const result = parseCodec8ExtendedPacket(partial, IMEI);
    expect(result.consumed).toBe(0);
    expect(result.records).toEqual([]);
  });

  it('unknown codec 0x07 — error matches /codec/', () => {
    const packet = buildTestPacket({ codecId: 0x07 });
    const result = parseCodec8ExtendedPacket(packet, IMEI);
    expect(result.error).toMatch(/codec/i);
    expect(result.records).toEqual([]);
  });

  it('legacy IO IDs 67/128/179 produce temp/voltage/rpm all 0 (proves new IDs required)', () => {
    const packet = buildTestPacket({
      ioElements: [
        { ioId: 67, ioType: 2, value: 12500 },   // old battery voltage
        { ioId: 128, ioType: 2, value: 900 },      // old engine temp
        { ioId: 179, ioType: 3, value: 2500 },     // old engine RPM
      ],
    });
    const result = parseCodec8ExtendedPacket(packet, IMEI);
    expect(result.records[0].temp).toBe(0);
    expect(result.records[0].voltage).toBe(0);
    expect(result.records[0].rpm).toBe(0);
  });
});
