#!/usr/bin/env node
/**
 * Broadcast Monitor — watches vMix, YouTube Live, audio levels, the Sportzcast
 * Scorebot, OpenStatsEngine and NDI, and shows it all on one page.
 *
 *   node server.js [--port 8090] [--config config.json] [--data data]
 */
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConfigStore } from './src/config.js';
import { App } from './src/app.js';
import { createServer } from './src/http.js';

const here = path.dirname(fileURLToPath(import.meta.url));

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const configFile = path.resolve(arg('config', path.join(here, 'config.json')));
const dataDir = path.resolve(arg('data', path.join(here, 'data')));

const config = new ConfigStore(configFile, { example: path.join(here, 'config.example.json') });
config.watch();

const app = new App({ config, dataDir });
app.start();

const port = parseInt(arg('port', config.current.port), 10) || 8090;
const server = createServer(app);

server.listen(port, () => {
  console.log(`\n  Broadcast Monitor is running\n`);
  console.log(`  Local    : http://localhost:${port}`);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if ((a.family === 'IPv4' || a.family === 4) && !a.internal) console.log(`  Network  : http://${a.address}:${port}`);
    }
  }
  console.log(`\n  Config   : ${configFile}`);
  console.log(`  Data     : ${dataDir}\n`);
});

server.on('error', (e) => {
  console.error(e.code === 'EADDRINUSE' ? `Port ${port} is already in use — run with --port <other>.` : e);
  process.exit(1);
});

const shutdown = () => { app.stop(); server.close(); process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
