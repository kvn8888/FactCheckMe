import { createServer } from 'node:http';
import { attachMaiStreamingUpgrade } from '../../server/mai-streaming.mjs';

const server = createServer((_req, res) => {
  res.writeHead(426, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify({ error: 'WebSocket upgrade required.', code: 'upgrade_required' }));
});

attachMaiStreamingUpgrade(server, { acceptAnyPath: true });

export default server;
