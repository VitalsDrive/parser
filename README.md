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

## Protocol (Teltonika Codec 8 Extended)

1. Device sends raw 15-digit IMEI as ASCII → server responds `0x01`
2. Device sends Codec 8 Extended AVL packets → server validates CRC-16, parses IO elements, responds with 4-byte record count ACK

See [docs/PRD-Layer1-Ingestion-Server.md](../../docs/PRD-Layer1-Ingestion-Server.md) for full protocol specification.

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