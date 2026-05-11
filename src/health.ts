import * as http from 'http';
import { HealthStatus } from './types';

export function createHealthServer(getStatus: () => HealthStatus): http.Server {
  return http.createServer((req, res) => {
    if (req.url === '/health' && req.method === 'GET') {
      const status = getStatus();
      const code = status.degraded ? 503 : 200;
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(status));
    } else {
      res.writeHead(404).end();
    }
  });
}
