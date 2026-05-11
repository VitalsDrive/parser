import { logger } from './logger';
import { ParsedAVLRecord } from './types';

// CRC-16-IBM (polynomial 0x1021, initial 0x0000)
export function crc16(data: Buffer): number {
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

function getAVLRecordSizeAt(payload: Buffer, offset: number): number {
  const fixedSize = 28;
  if (offset + fixedSize > payload.length) return payload.length - offset;

  const ioCount = payload.readUInt16BE(offset + 27);
  let ioOffset = offset + 29;

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
      case 0xFF: valueSize = payload[ioOffset + 3] || 0; break;
      default: valueSize = 1;
    }
    ioOffset += 3 + valueSize;
  }

  return ioOffset - offset;
}

function getAVLRecordSize(payload: Buffer, numRecords: number): number {
  let offset = 3;
  for (let i = 0; i < numRecords; i++) {
    offset += getAVLRecordSizeAt(payload, offset);
  }
  offset += 2;
  return offset - 3;
}

function parseAVLRecord(payload: Buffer, offset: number, imei: string): ParsedAVLRecord | null {
  if (offset + 28 > payload.length) {
    logger.warn({ imei, offset }, 'AVL record too short');
    return null;
  }

  const timestamp = payload.readBigUInt64BE(offset);
  const lngRaw = payload.readInt32BE(offset + 9);
  const latRaw = payload.readInt32BE(offset + 13);
  const speedRaw = payload.readUInt16BE(offset + 23);
  const ioCount = payload.readUInt16BE(offset + 27);
  let ioOffset = offset + 29;

  let voltage = 0;
  let temp = 0;
  let rpm = 0;
  let speed = speedRaw / 10;
  let dtcCount = 0;

  for (let i = 0; i < ioCount; i++) {
    if (ioOffset + 3 > payload.length) break;

    const ioId = payload.readUInt16BE(ioOffset);
    const ioType = payload[ioOffset + 2];
    ioOffset += 3;

    switch (ioId) {
      case 7040: // Coolant temp (uint16 BE, tenths °C)
        temp = payload.readUInt16BE(ioOffset) / 10;
        break;
      case 7044: // Engine RPM (uint32 BE)
        rpm = payload.readUInt32BE(ioOffset);
        break;
      case 7045: // Vehicle speed (uint16 BE, km/h)
        speed = payload.readUInt16BE(ioOffset);
        break;
      case 7059: // Control voltage (uint16 BE, mV)
        voltage = payload.readUInt16BE(ioOffset) / 1000;
        break;
      case 7038: // DTC count (uint16 BE) — parsed, not stored
        dtcCount = payload.readUInt16BE(ioOffset);
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
    timestamp: new Date(Number(timestamp)).toISOString(),
    lat: latRaw / 10_000_000,
    lng: lngRaw / 10_000_000,
    speed,
    temp,
    voltage,
    rpm,
    dtcCount,
  };
}

export function parseCodec8ExtendedPacket(
  buffer: Buffer,
  imei: string
): { records: ParsedAVLRecord[]; consumed: number; error?: string } {
  // Scan for 4-byte zero preamble
  let preambleIndex = -1;
  for (let i = 0; i <= buffer.length - 4; i++) {
    if (
      buffer[i] === 0x00 &&
      buffer[i + 1] === 0x00 &&
      buffer[i + 2] === 0x00 &&
      buffer[i + 3] === 0x00
    ) {
      preambleIndex = i;
      break;
    }
  }

  if (preambleIndex === -1) {
    if (buffer.length > 100) {
      logger.warn({ imei, bufLen: buffer.length }, 'No preamble found, discarding buffer');
    }
    return { records: [], consumed: 0 };
  }

  if (buffer.length < preambleIndex + 8) {
    return { records: [], consumed: 0 };
  }

  const dataLength = buffer.readUInt32BE(preambleIndex + 4);
  const totalSize = 8 + dataLength;

  if (buffer.length < preambleIndex + totalSize) {
    return { records: [], consumed: 0 };
  }

  const consumed = preambleIndex + totalSize;
  const packet = buffer.slice(preambleIndex, preambleIndex + totalSize);
  const payload = packet.slice(8);

  const codecId = payload[0];
  if (codecId !== 0x8E) {
    logger.warn({ imei, codecId }, 'unknown codec ID');
    return { records: [], consumed, error: 'unknown codec' };
  }

  const numRecords = payload.readUInt16BE(1);

  // Sum individual record sizes (getAVLRecordSize includes +2 for trailer numRecords repeat)
  // crcEndOffset = codecId(1) + numRecords(2) + sum_record_sizes + numRecords_repeat(2)
  // getAVLRecordSize already adds the +2 for trailer, so no extra +2 needed
  const recordsSize = getAVLRecordSize(payload, numRecords);
  const crcEndOffset = 1 + 2 + recordsSize;

  if (crcEndOffset > payload.length) {
    logger.warn({ imei }, 'Packet too short for declared records');
    return { records: [], consumed, error: 'packet too short' };
  }

  const expectedCrc = payload.readUInt16BE(crcEndOffset);
  const calculatedCrc = crc16(payload.slice(0, crcEndOffset));

  if (expectedCrc !== calculatedCrc) {
    logger.warn(
      { imei, expectedCrc, calculatedCrc },
      'CRC mismatch'
    );
    return { records: [], consumed, error: 'CRC mismatch' };
  }

  const records: ParsedAVLRecord[] = [];
  let offset = 3;
  for (let i = 0; i < numRecords; i++) {
    const record = parseAVLRecord(payload, offset, imei);
    if (record) {
      records.push(record);
    }
    offset += getAVLRecordSizeAt(payload, offset);
  }

  return { records, consumed };
}
