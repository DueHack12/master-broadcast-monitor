#!/usr/bin/env node
/**
 * Broadcast Monitor — watches vMix, YouTube Live, audio levels, the Sportzcast
 * Scorebot, OpenStatsEngine and NDI, and shows it all on one page.
 *
 *   node server.js [--port 8090] [--config config.json] [--data data] [--open | --no-open]
 *
 * The packaged app (BroadcastMonitor.exe) takes the same options and opens the
 * dashboard in a browser when it starts.
 */
import os from 'node:os';
import path from 'node:path';
import { ConfigStore } from './src/config.js';
import { App } from './src/app.js';
import { createServer } from './src/http.js';
import { packaged, defaultHome, readAsset, openExternal, VERSION } from './src/runtime.js';

const argv = process.argv.slice(2);
function arg(name, fallback) {
  const i = argv.indexOf(`--${name}`);
  return i > -1 && argv[i + 1] ? argv[i + 1] : fallback;
}

// Names the console window on Windows. Not on macOS: there, setting the title
// makes Node check the process in with LaunchServices as an app, and the
// server gets its own bouncing "exec" icon in the Dock.
if (packaged && process.platform === 'win32') process.title = 'Broadcast Monitor';

/** A double-clicked app's window vanishes on exit; leave time to read why. */
function fatal(msg) {
  console.error(`\n  ${msg}\n`);
  if (packaged) {
    console.error('  This window closes in 30 seconds.');
    setTimeout(() => process.exit(1), 30000);
  } else process.exit(1);
}

const home = defaultHome();
const configFile = path.resolve(arg('config', path.join(home, 'config.json')));
const dataDir = path.resolve(arg('data', path.join(path.dirname(configFile), 'data')));
const OPEN = argv.includes('--open') || (packaged && !argv.includes('--no-open'));

let config;
try {
  config = new ConfigStore(configFile, { example: readAsset('config.example.json')?.toString('utf8') });
} catch (e) {
  fatal(`Could not set up ${configFile}: ${e.message}`);
}

if (config) {
  config.watch();
  const app = new App({ config, dataDir });
  app.start();

  const port = parseInt(arg('port', config.current.port), 10) || 8090;
  const server = createServer(app);

  server.listen(port, () => {
    console.log(`\n  Broadcast Monitor ${VERSION} is running\n`);
    console.log(`  Local    : http://localhost:${port}`);
    for (const list of Object.values(os.networkInterfaces())) {
      for (const a of list || []) {
        if ((a.family === 'IPv4' || a.family === 4) && !a.internal) console.log(`  Network  : http://${a.address}:${port}`);
      }
    }
    console.log(`\n  Settings : ${configFile}${config.created ? "   (new — set it up on the dashboard's Settings page)" : ''}`);
    console.log(`  Data     : ${dataDir}`);
    console.log(packaged ? '\n  Close this window to stop the monitor.\n' : '\n  Ctrl+C to stop.\n');
    if (OPEN) openExternal(`http://localhost:${port}/${config.created ? 'settings' : ''}`);
  });

  server.on('error', (e) => {
    app.stop();
    // Double-clicked again while already running: show the running one.
    if (e.code === 'EADDRINUSE' && OPEN) openExternal(`http://localhost:${port}/`);
    fatal(e.code === 'EADDRINUSE'
      ? `Port ${port} is already in use — Broadcast Monitor may already be running (try http://localhost:${port}). Otherwise start it with --port <other>.`
      : e.message);
  });

  const shutdown = () => { app.stop(); server.close(); process.exit(0); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
