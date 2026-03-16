import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import http from 'http';
import https from 'https';
import path from 'path';
import fs from 'fs';
import os from 'os';
import crypto from 'crypto';
import { execSync } from 'child_process';
import { WebSocketServer } from 'ws';
import { handleConnection } from './ws-handler';
import { getWorkspaceRoot } from './tools';
import { listClaudeCodeSessions, importSession } from './session-import';
import { listConversations } from './history';

// @ts-ignore — no types for qrcode-terminal
import qrcode from 'qrcode-terminal';

/**
 * Ensure self-signed TLS certs exist for HTTPS.
 * Tries openssl first (available on most systems via Git for Windows).
 * Returns { key, cert } strings or null if generation fails.
 */
function ensureCerts(): { key: string; cert: string } | null {
  const certsDir = path.join(__dirname, '..', 'certs');
  const keyPath = path.join(certsDir, 'server.key');
  const certPath = path.join(certsDir, 'server.cert');

  // If certs already exist, just read and return them
  if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
    try {
      return {
        key: fs.readFileSync(keyPath, 'utf-8'),
        cert: fs.readFileSync(certPath, 'utf-8'),
      };
    } catch (err) {
      console.warn('[HTTPS] Failed to read existing certs:', err);
      return null;
    }
  }

  // Create certs directory
  try {
    fs.mkdirSync(certsDir, { recursive: true });
  } catch (err) {
    console.warn('[HTTPS] Failed to create certs directory:', err);
    return null;
  }

  // Try generating via openssl
  try {
    const subj = '/CN=mobile-claude';
    const cmd = [
      'openssl', 'req', '-x509',
      '-newkey', 'rsa:2048',
      '-keyout', keyPath.replace(/\\/g, '/'),
      '-out', certPath.replace(/\\/g, '/'),
      '-days', '365',
      '-nodes',
      '-subj', `"${subj}"`,
    ].join(' ');

    execSync(cmd, { stdio: 'pipe', timeout: 15000 });

    if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
      console.log('[HTTPS] Self-signed certificate generated successfully');
      return {
        key: fs.readFileSync(keyPath, 'utf-8'),
        cert: fs.readFileSync(certPath, 'utf-8'),
      };
    }
  } catch (err) {
    console.warn('[HTTPS] openssl not available or failed — HTTPS disabled');
    console.warn('[HTTPS] Install OpenSSL or Git for Windows to enable HTTPS');
  }

  return null;
}

function getLocalIP(): string {
  const interfaces = os.networkInterfaces();
  const candidates: string[] = [];
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        candidates.push(iface.address);
      }
    }
  }
  // Prefer 192.168.x.x or 10.x.x.x (LAN) over 100.x.x.x (Tailscale/CGNAT)
  const lan = candidates.find(ip => ip.startsWith('192.168.') || ip.startsWith('10.'));
  return lan || candidates[0] || 'localhost';
}

const PORT = parseInt(process.env.PORT || '3456', 10);
const AUTH_TOKEN_INITIAL = process.env.AUTH_TOKEN || 'change-this';

// AUTH_TOKEN getter — supports runtime override after first-run setup
function getAuthToken(): string {
  return (global as any).__AUTH_TOKEN_OVERRIDE || AUTH_TOKEN_INITIAL;
}

const app = express();
const server = http.createServer(app);

// Simple auth middleware for API routes
function requireAuth(req: express.Request, res: express.Response, next: express.NextFunction): void {
  const token = req.headers.authorization?.replace('Bearer ', '') || req.query.token;
  if (token !== getAuthToken()) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
}

// Serve the web app (no-cache to prevent stale client, but cache service worker properly)
app.use(express.static(path.join(__dirname, '..', 'public'), {
  etag: false,
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('sw.js')) {
      // Service workers need special cache headers
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Service-Worker-Allowed', '/');
    } else {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
  }
}));

// Health check endpoint
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// Force cache clear — visit /clear-cache on the phone to nuke old service worker
app.get('/clear-cache', (_req, res) => {
  res.send(`<!DOCTYPE html><html><head><title>Clearing cache...</title></head><body style="background:#0d1117;color:#e6edf3;font-family:sans-serif;padding:40px;text-align:center">
<h2>Clearing cache...</h2><p id="status">Working...</p>
<script>
(async function() {
  const s = document.getElementById('status');
  try {
    // Unregister all service workers
    const regs = await navigator.serviceWorker.getRegistrations();
    for (const r of regs) await r.unregister();
    s.textContent = 'Service workers cleared (' + regs.length + ')';
    // Delete all caches
    const keys = await caches.keys();
    for (const k of keys) await caches.delete(k);
    s.textContent += '. Caches cleared (' + keys.length + '). Redirecting...';
    setTimeout(() => window.location.href = '/', 1500);
  } catch(e) { s.textContent = 'Error: ' + e.message; }
})();
</script></body></html>`);
});

// Project dashboard — quick snapshot of current workspace
app.get('/api/dashboard', requireAuth, (_req, res) => {
  const root = getWorkspaceRoot();
  const name = path.basename(root);
  let gitBranch = '';
  let gitStatus = '';
  let gitLog = '';
  try {
    gitBranch = execSync('git branch --show-current', { cwd: root, encoding: 'utf-8', timeout: 5000 }).trim();
    gitStatus = execSync('git status --short', { cwd: root, encoding: 'utf-8', timeout: 5000 }).trim();
    gitLog = execSync('git log --oneline -5', { cwd: root, encoding: 'utf-8', timeout: 5000 }).trim();
  } catch { /* not a git repo */ }

  res.json({
    workspace: name,
    path: root,
    git: { branch: gitBranch, status: gitStatus, recentCommits: gitLog },
    uptime: Math.floor(process.uptime()),
  });
});

// File browser API
app.get('/api/files', requireAuth, (req, res) => {
  const root = getWorkspaceRoot();
  const relPath = (req.query.path as string) || '.';
  const absPath = path.resolve(root, relPath);

  // Security: must be within workspace
  if (!absPath.startsWith(path.resolve(root))) {
    res.status(403).json({ error: 'Path outside workspace' });
    return;
  }

  try {
    const stat = fs.statSync(absPath);
    if (stat.isFile()) {
      // Skip binary files
      const binaryExts = new Set(['.png','.jpg','.jpeg','.gif','.ico','.webp','.bmp','.svg','.pdf','.zip','.gz','.tar','.exe','.dll','.so','.dylib','.woff','.woff2','.ttf','.eot','.mp3','.mp4','.wav','.ogg','.avi','.mov','.db','.sqlite']);
      const ext = path.extname(absPath).toLowerCase();
      if (binaryExts.has(ext)) {
        res.json({ type: 'file', path: relPath, lines: 0, size: stat.size, content: `[Binary file: ${ext}, ${(stat.size / 1024).toFixed(1)}KB]` });
        return;
      }
      const content = fs.readFileSync(absPath, 'utf-8');
      const lines = content.split('\n');
      res.json({
        type: 'file',
        path: relPath,
        lines: lines.length,
        size: stat.size,
        content: lines.length > 500 ? lines.slice(0, 500).join('\n') + '\n...(truncated)' : content,
      });
    } else {
      // Return directory listing
      const entries = fs.readdirSync(absPath, { withFileTypes: true });
      const items = entries
        .filter(e => !e.name.startsWith('.') && e.name !== 'node_modules')
        .map(e => ({
          name: e.name,
          type: e.isDirectory() ? 'dir' : 'file',
          size: e.isFile() ? fs.statSync(path.join(absPath, e.name)).size : undefined,
        }))
        .sort((a, b) => {
          if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
      res.json({ type: 'directory', path: relPath, items });
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(404).json({ error: message });
  }
});

// Session import — continue Claude Code conversations
app.use(express.json());

// ── First-run onboarding setup endpoints (no auth required) ──
const envPath = path.join(__dirname, '..', '.env');

function isConfigured(): boolean {
  if (!fs.existsSync(envPath)) return false;
  const content = fs.readFileSync(envPath, 'utf-8');
  return content.includes('ANTHROPIC_API_KEY=') && !content.includes('ANTHROPIC_API_KEY=\n') && !content.includes('ANTHROPIC_API_KEY=\r');
}

app.get('/api/setup/status', (_req, res) => {
  const ip = getLocalIP();
  res.json({
    configured: isConfigured(),
    ip,
    port: PORT,
  });
});

app.post('/api/setup/configure', (req, res) => {
  const { apiKey, openaiKey, reset } = req.body;

  if (isConfigured() && !reset) {
    res.status(400).json({ error: 'Already configured. Pass reset:true to reconfigure.' });
    return;
  }

  if (!apiKey || typeof apiKey !== 'string' || !apiKey.startsWith('sk-')) {
    res.status(400).json({ error: 'Invalid API key. Must start with sk-' });
    return;
  }

  // Generate a secure auth token
  const token = crypto.randomBytes(32).toString('base64url');
  const ip = getLocalIP();

  // Build .env content
  let envContent = `ANTHROPIC_API_KEY=${apiKey}\n`;
  envContent += `AUTH_TOKEN=${token}\n`;
  envContent += `PORT=${PORT}\n`;
  envContent += `WORKSPACE_ROOT=${process.env.WORKSPACE_ROOT || path.resolve(os.homedir(), 'Documents', 'github')}\n`;
  if (openaiKey && typeof openaiKey === 'string' && openaiKey.startsWith('sk-')) {
    envContent += `OPENAI_API_KEY=${openaiKey}\n`;
  }

  try {
    fs.writeFileSync(envPath, envContent, 'utf-8');
    // Update the in-memory AUTH_TOKEN so the new token works immediately
    (global as any).__AUTH_TOKEN_OVERRIDE = token;
    console.log('[Setup] .env written successfully. New auth token generated.');
    res.json({
      token,
      wsUrl: `ws://${ip}:${PORT}`,
      ip,
      port: PORT,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: 'Failed to write .env: ' + message });
  }
});

app.get('/api/sessions', requireAuth, (_req, res) => {
  const sessions = listClaudeCodeSessions();
  res.json({ sessions });
});

app.post('/api/sessions/import', requireAuth, (req, res) => {
  const { sessionId } = req.body;
  if (!sessionId || typeof sessionId !== 'string') {
    res.status(400).json({ error: 'sessionId is required' });
    return;
  }
  const conv = importSession(sessionId);
  if (conv) {
    res.json({
      success: true,
      conversation: {
        id: conv.id,
        mode: conv.mode,
        messageCount: conv.messages.length,
        created: conv.created,
      },
    });
  } else {
    res.status(404).json({ error: 'Session not found or empty' });
  }
});

app.get('/api/conversations', requireAuth, (_req, res) => {
  const conversations = listConversations();
  res.json({ conversations });
});

// --- WebSocket setup helper ---
function setupWebSocketServer(wss: WebSocketServer, label: string): NodeJS.Timeout {
  wss.on('connection', (ws) => {
    console.log(`[${label}] New connection from client`);
    (ws as any).isAlive = true;

    ws.on('pong', () => {
      (ws as any).isAlive = true;
    });

    handleConnection(ws);
  });

  // Ping all clients every 25s to keep connections alive
  const interval = setInterval(() => {
    wss.clients.forEach((ws) => {
      if ((ws as any).isAlive === false) {
        console.log(`[${label}] Terminating dead connection`);
        return ws.terminate();
      }
      (ws as any).isAlive = false;
      ws.ping();
    });
  }, 25000);

  wss.on('close', () => clearInterval(interval));
  return interval;
}

// HTTP WebSocket server
const wss = new WebSocketServer({ server });
setupWebSocketServer(wss, 'WS');

// --- HTTPS setup ---
const HTTPS_PORT = parseInt(process.env.HTTPS_PORT || String(PORT + 100), 10); // default 3556 to avoid conflicts
let httpsServer: https.Server | null = null;
let httpsUrl: string | null = null;

const certs = ensureCerts();
if (certs) {
  try {
    httpsServer = https.createServer({ key: certs.key, cert: certs.cert }, app);
    const wssSecure = new WebSocketServer({ server: httpsServer });
    setupWebSocketServer(wssSecure, 'WSS');

    // Catch HTTPS server errors so they don't crash the process
    httpsServer.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        console.warn(`[HTTPS] Port ${HTTPS_PORT} is in use — HTTPS disabled. Set HTTPS_PORT in .env to use a different port.`);
      } else {
        console.warn('[HTTPS] Server error:', err.message);
      }
      httpsServer = null;
    });
  } catch (err) {
    console.warn('[HTTPS] Failed to create HTTPS server:', err);
    httpsServer = null;
  }
}

server.listen(PORT, '0.0.0.0', () => {
  const ip = getLocalIP();
  const httpUrl = `http://${ip}:${PORT}`;

  // Start HTTPS server if available
  if (httpsServer) {
    httpsServer.listen(HTTPS_PORT, '0.0.0.0', () => {
      httpsUrl = `https://${ip}:${HTTPS_PORT}`;
      printStartupBanner(ip, httpUrl, httpsUrl);
    });
    httpsServer.on('error', (err) => {
      console.warn('[HTTPS] Failed to start HTTPS server:', err);
      httpsUrl = null;
      printStartupBanner(ip, httpUrl, null);
    });
  } else {
    printStartupBanner(ip, httpUrl, null);
  }
});

function printStartupBanner(ip: string, httpUrl: string, httpsUrl: string | null) {
  const qrUrl = httpsUrl || httpUrl;

  console.log('');
  console.log('  Mobile Claude server running');
  console.log('');
  console.log(`  HTTP:      http://localhost:${PORT}`);
  console.log(`  Network:   ${httpUrl}`);
  if (httpsUrl) {
    console.log(`  HTTPS:     ${httpsUrl}`);
    console.log(`  WSS:       wss://${ip}:${HTTPS_PORT}`);
  }
  console.log(`  WS:        ws://${ip}:${PORT}`);
  console.log(`  Platform:  ${process.platform} (${os.arch()})`);
  console.log(`  Workspace: ${getWorkspaceRoot()}`);
  if (httpsUrl) {
    console.log('');
    console.log('  Voice input requires HTTPS. Trust the self-signed cert on your phone.');
  } else {
    console.log('');
    console.log('  HTTPS disabled — voice input only works on localhost.');
    console.log('  Install OpenSSL (or Git for Windows) and restart to enable HTTPS.');
  }
  console.log('');
  console.log('  Scan this QR code on your phone:');
  console.log('');
  qrcode.generate(qrUrl, { small: true }, (code: string) => {
    console.log(code.split('\n').map((line: string) => '  ' + line).join('\n'));
    console.log('');
  });
}
