import { createServer } from 'node:http';
import handler from './handler.mjs';
import { attachMaiStreamingUpgrade } from './mai-streaming.mjs';

const port = Number(process.env.PORT || 8787);
const host = process.env.HOST || '127.0.0.1';
const server = createServer(handler);
attachMaiStreamingUpgrade(server);
server.listen(port, host, () => console.log(`FactCheckMe API listening on http://${host}:${port}`));
