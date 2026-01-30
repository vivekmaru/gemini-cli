#!/usr/bin/env node

import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import open from 'open';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// In a real installed package, we would expect dist/ to exist.
// For dev, we might want to handle it differently, but let's assume built.
const serverPath = path.resolve(__dirname, '../dist/server/index.js');

console.log('Starting Gemini Web UI...');

// We could run "npm start" but that relies on npm being available.
// Better to run node directly if built.

// Check if built server exists, if not maybe we are in dev mode
import fs from 'fs';
if (!fs.existsSync(serverPath)) {
    console.log('Server build not found. Please run "npm run build" in packages/web-ui first.');
    // Fallback for dev environment - rely on tsx if available?
    // Or just fail.
    process.exit(1);
}

const server = spawn('node', [serverPath], {
    stdio: 'inherit',
    env: process.env
});

// Wait a bit for server to start then open browser
// Ideally the server signals readiness
setTimeout(() => {
    open('http://localhost:3000');
}, 2000);

server.on('close', (code) => {
    process.exit(code);
});
