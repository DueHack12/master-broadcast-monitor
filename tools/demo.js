#!/usr/bin/env node
/**
 * npm run demo — the simulator plus the monitor, wired together.
 * Uses config.demo.json and a separate data-demo/ folder, so it never touches
 * your real config or YouTube sign-in.
 */
import path from 'node:path';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startSimulator, PORTS } from './simulator.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.join(root, 'data-demo');
fs.mkdirSync(dataDir, { recursive: true });

// Start "signed in" to the fake YouTube; Disconnect → Connect shows the sign-in flow.
const tokenFile = path.join(dataDir, 'youtube-token.json');
if (!fs.existsSync(tokenFile)) fs.writeFileSync(tokenFile, JSON.stringify({ refresh_token: 'demo-refresh', channel: 'Demo Sports Network' }));

console.log('\n  Simulator');
const sim = startSimulator();
await sim.ready;

const child = spawn(process.execPath, [path.join(root, 'server.js'), '--config', path.join(root, 'config.demo.json'), '--data', dataDir], { stdio: 'inherit' });
console.log(`\n  Simulator control page: http://localhost:${PORTS.control}`);

const stop = () => { child.kill(); sim.close(); process.exit(0); };
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
child.on('exit', (code) => { sim.close(); process.exit(code ?? 0); });
