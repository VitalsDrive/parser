# VitalsDrive Parser

TCP Ingestion Server for receiving and parsing 4G OBD2 telemetry data.

## Overview

Receives raw hex packets from 4G OBD2 devices via TCP, parses the protocol, and writes normalized JSON to Supabase.

## Protocol

See [docs/PRD-Layer1-Ingestion-Server.md](../../docs/PRD-Layer1-Ingestion-Server.md) for full protocol specification.

## Quick Start

```bash
npm install
cp .env.example .env
npm run dev
```

## Environment Variables

```bash
SUPABASE_URL=https://odwctmlawibhaclptsew.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
PARSER_PORT=5050
LOG_LEVEL=info
```

## Packet Structure

```
[0-1]   Start bytes: 0x78 0x78
[2]     Packet length
[3]     Protocol number (0x22 = data packet)
[4-7]   Latitude (int32, degrees * 1,000,000)
[8-11]  Longitude (int32, degrees * 1,000,000)
[12]    Speed (uint8, km/h)
[13-14] Voltage (uint16, millivolts)
[15]    Coolant temp (uint8, °C)
[16-17] RPM (uint16)
[18-19] CRC (uint16)
[20-21] Stop bytes: 0x0D 0x0A
```

## Output JSON

```json
{
  "vehicle_id": "uuid",
  "lat": 37.7749,
  "lng": -122.4194,
  "temp": 92,
  "voltage": 12.6,
  "rpm": 1450,
  "dtc_codes": [],
  "timestamp": "2026-03-29T14:32:00Z"
}
```

## Testing

```bash
# Test with telnet
telnet localhost 5050

# Or use the Ghost Fleet simulator
cd ../simulator && npm run dev
```