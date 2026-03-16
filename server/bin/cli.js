#!/usr/bin/env node

const path = require('path');
const fs = require('fs');
const { execSync, spawn } = require('child_process');

const serverDir = path.join(__dirname, '..');
const distPath = path.join(serverDir, 'dist', 'index.js');
const envPath = path.join(serverDir, '.env');

console.log('');
console.log('  Mobile Claude v1.5');
console.log('');

// Check if built
if (!fs.existsSync(distPath)) {
  console.log('  Building TypeScript...');
  try {
    execSync('npx tsc', { cwd: serverDir, stdio: 'inherit' });
  } catch {
    console.error('  Build failed. Run `cd server && npx tsc` manually.');
    process.exit(1);
  }
}

// Check if configured
if (!fs.existsSync(envPath)) {
  console.log('  No .env found — starting server with browser-based setup.');
  console.log('  Open the URL below and the setup wizard will guide you.');
  console.log('');
}

// Start server
require(distPath);
