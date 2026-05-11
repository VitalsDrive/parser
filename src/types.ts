export interface TelemetryPacket {
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

export interface DeviceLookup {
  id: string;
  vehicle_id: string | null;
  fleet_id: string;
  status: 'unassigned' | 'active' | 'inactive';
}

export interface ConnectionState {
  imei: string | null;
  authenticated: boolean;
}

export interface HealthStatus {
  status: 'ok' | 'degraded';
  activeConnections: number;
  queueDepth: number;
  lastSupabasePush: string | null;
  degraded: boolean;
}

export interface ParsedAVLRecord {
  timestamp: string;
  lat: number;
  lng: number;
  speed: number;
  temp: number;
  voltage: number;
  rpm: number;
  dtcCount: number;
}
