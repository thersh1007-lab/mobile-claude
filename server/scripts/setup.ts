#!/usr/bin/env ts-node

import * as readline from 'readline';
import * as crypto from 'crypto';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

function ask(question: string, defaultVal?: string): Promise<string> {
  const suffix = defaultVal ? ` [${defaultVal}]` : '';
  return new Promise(resolve => {
    rl.question(`  ${question}${suffix}: `, answer => {
      resolve(answer.trim() || defaultVal || '');
    });
  });
}

function detectLocalIP(): string {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
}

function checkCommand(cmd: string): string | null {
  try {
    return execSync(cmd, { encoding: 'utf-8', timeout: 5000 }).trim().split('\n')[0];
  } catch {
    return null;
  }
}

async function main() {
  console.log('');
  console.log('  ╔══════════════════════════════════╗');
  console.log('  ║     Mobile Claude — Setup         ║');
  console.log('  ╚══════════════════════════════════╝');
  console.log('');

  // Check prerequisites
  const nodeVersion = process.version;
  const nodeMajor = parseInt(nodeVersion.slice(1));
  console.log(`  Node.js:    ${nodeVersion} ${nodeMajor >= 18 ? '✓' : '✗ (need 18+)'}`);

  const claudeCmd = process.platform === 'win32' ? 'where claude' : 'which claude';
  const claudePath = checkCommand(claudeCmd);
  console.log(`  Claude CLI: ${claudePath ? claudePath + ' ✓' : 'not found (CC Bridge mode will be unavailable)'}`);

  const bashPath = checkCommand(process.platform === 'win32' ? 'where bash' : 'which bash');
  console.log(`  Bash:       ${bashPath ? '✓' : 'not found (needed for CC Bridge on Windows — install Git for Windows)'}`);

  console.log(`  Platform:   ${process.platform} (${os.arch()})`);
  console.log(`  IP:         ${detectLocalIP()}`);
  console.log('');

  if (nodeMajor < 18) {
    console.log('  ERROR: Node.js 18+ is required. Please upgrade.');
    rl.close();
    process.exit(1);
  }

  // Check for existing .env
  const envPath = path.join(__dirname, '..', '.env');
  if (fs.existsSync(envPath)) {
    const overwrite = await ask('Existing .env found. Overwrite? (y/N)', 'N');
    if (overwrite.toLowerCase() !== 'y') {
      console.log('\n  Setup cancelled. Your .env is unchanged.\n');
      rl.close();
      return;
    }
    console.log('');
  }

  // Gather config
  const apiKey = await ask('Anthropic API key (sk-ant-...)');
  if (!apiKey.startsWith('sk-ant-')) {
    console.log('\n  WARNING: Key doesn\'t start with sk-ant- — double check it.\n');
  }

  const token = crypto.randomBytes(32).toString('base64url');
  const port = await ask('Port', '3456');

  const defaultWorkspace = path.resolve(__dirname, '..', '..', '..');
  const workspace = await ask('Workspace root (parent folder of your repos)', defaultWorkspace);

  const openaiKey = await ask('OpenAI API key for voice transcription (Enter to skip)');

  // Write .env
  const lines = [
    `ANTHROPIC_API_KEY=${apiKey}`,
    `AUTH_TOKEN=${token}`,
    `PORT=${port}`,
    `WORKSPACE_ROOT=${workspace}`,
  ];
  if (openaiKey) lines.push(`OPENAI_API_KEY=${openaiKey}`);
  if (claudePath) lines.push(`CLAUDE_PATH=${claudePath}`);

  fs.writeFileSync(envPath, lines.join('\n') + '\n');

  // Always build
  console.log('\n  Building TypeScript...');
  try {
    execSync('npx tsc', { cwd: path.join(__dirname, '..'), stdio: 'inherit' });
    console.log('  Build: OK');
  } catch {
    console.log('  Build failed — run `npm run build` manually.');
  }

  // Generate HTTPS certs if openssl is available
  const certsDir = path.join(__dirname, '..', 'certs');
  if (!fs.existsSync(path.join(certsDir, 'server.cert'))) {
    try {
      fs.mkdirSync(certsDir, { recursive: true });
      const ip = detectLocalIP();
      const certCmd = `openssl req -x509 -newkey rsa:2048 -keyout "${certsDir}/server.key" -out "${certsDir}/server.cert" -days 365 -nodes -subj "/CN=Mobile Claude" -addext "subjectAltName=IP:${ip},IP:127.0.0.1,DNS:localhost"`;
      execSync(certCmd, { stdio: 'pipe', timeout: 15000, env: { ...process.env, MSYS_NO_PATHCONV: '1' } });
      console.log('  HTTPS cert: generated');
    } catch {
      console.log('  HTTPS cert: skipped (install OpenSSL for voice input)');
    }
  }

  const ip = detectLocalIP();
  const httpsPort = parseInt(port) + 100;
  console.log('');
  console.log('  ╔══════════════════════════════════╗');
  console.log('  ║          Setup Complete!          ║');
  console.log('  ╚══════════════════════════════════╝');
  console.log('');
  console.log(`  HTTP:        http://${ip}:${port}`);
  console.log(`  HTTPS:       https://${ip}:${httpsPort}`);
  console.log(`  Auth Token:  ${token}`);
  console.log('');
  console.log('  Start the server:');
  console.log('    npm start');
  console.log('');
  console.log(`  Then open http://${ip}:${port} on your phone (same WiFi).`);
  console.log(`  Scan the QR code that appears in the terminal.`);
  console.log('');

  rl.close();
}

main().catch(err => {
  console.error('Setup error:', err);
  rl.close();
  process.exit(1);
});
