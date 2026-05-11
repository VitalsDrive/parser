import 'dotenv/config';
import * as net from 'net';
import { createClient } from '@supabase/supabase-js';
import { DeviceAuth } from './device-auth';
import { TelemetryWriter } from './telemetry-writer';
import { ConnectionHandler } from './connection-handler';
import { createHealthServer } from './health';
import { logger } from './logger';

const supabase = createClient(
  process.env.SUPABASE_URL || '',
  process.env.SUPABASE_SERVICE_ROLE_KEY || ''
);

const deviceAuth = new DeviceAuth(supabase);
const telemetryWriter = new TelemetryWriter(supabase);
const handler = new ConnectionHandler(deviceAuth, telemetryWriter);

const tcpPort = parseInt(process.env.PARSER_PORT || '5050', 10);
const tcpServer = net.createServer((s) => handler.handleConnection(s));
tcpServer.listen(tcpPort, () => {
  logger.info({ port: tcpPort }, 'OBD2 parser TCP listening');
});

const healthPort = parseInt(process.env.HEALTH_PORT || '8080', 10);
const healthServer = createHealthServer(() => {
  const degraded = telemetryWriter.degraded;
  return {
    status: degraded ? 'degraded' : 'ok',
    activeConnections: handler.activeConnections,
    queueDepth: telemetryWriter.queueDepth,
    lastSupabasePush: telemetryWriter.lastSupabasePush,
    degraded,
  };
});
healthServer.listen(healthPort, () => {
  logger.info({ port: healthPort }, 'health HTTP listening');
});
