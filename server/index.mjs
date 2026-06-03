import { createServer } from 'node:http';
import { HOST, PORT } from './config.mjs';
import { createDatabase } from './database.mjs';
import { toPublicError } from './errors.mjs';
import { json } from './http-utils.mjs';
import { attachRealtimeTranscription } from './realtime.mjs';
import { createRouteHandler } from './routes.mjs';

const database = createDatabase();
const route = createRouteHandler({ database });

const server = createServer((req, res) => {
  route(req, res).catch((error) => {
    console.error(error);
    const { statusCode, payload } = toPublicError(error);
    json(res, statusCode, payload);
  });
});

attachRealtimeTranscription(server);

server.listen(PORT, HOST, () => {
  console.log(`FactCheckMe API listening on http://${HOST}:${PORT}`);
  console.log(`SQLite database: ${database.path}`);
});
