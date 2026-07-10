const express = require('express');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { v4: uuidv4 } = require('uuid');

const HTTP_PORT = process.env.HTTP_PORT || 3000;
const HTTPS_PORT = process.env.HTTPS_PORT || 3443;
const HOST = '0.0.0.0';
const app = express();
app.use(express.static(path.join(__dirname, '..', 'public')));

const waitingQueue = [];
const activePairs = new Map();
const wsServers = [];

function getPartnerWs(ws) {
  if (!ws.partnerId) return null;
  for (const wss of wsServers) {
    for (const client of wss.clients) {
      if (client.userId === ws.partnerId) return client;
    }
  }
  return null;
}

function cleanupPair(ws) {
  if (ws.partnerId) {
    activePairs.delete(ws.userId);
    activePairs.delete(ws.partnerId);
    ws.partnerId = null;
  }
  ws.inQueue = false;
}

function relayToPartner(ws, msg) {
  const partner = getPartnerWs(ws);
  if (partner && partner.readyState === 1) {
    partner.send(JSON.stringify(msg));
  }
}

function findPartner(ws) {
  if (ws.partnerId) return;
  if (waitingQueue.length > 0) {
    const partner = waitingQueue.shift();
    partner.inQueue = false;
    ws.partnerId = partner.userId;
    partner.partnerId = ws.userId;
    activePairs.set(ws.userId, partner.userId);
    activePairs.set(partner.userId, ws.userId);
    ws.send(JSON.stringify({ type: 'matched', partnerId: partner.userId, initiator: true }));
    partner.send(JSON.stringify({ type: 'matched', partnerId: ws.userId, initiator: false }));
    console.log(`Matched ${ws.userId} <-> ${partner.userId}`);
  } else {
    ws.inQueue = true;
    waitingQueue.push(ws);
    ws.send(JSON.stringify({ type: 'waiting' }));
  }
}

function handleNext(ws) {
  const partner = getPartnerWs(ws);
  if (partner && partner.readyState === 1) {
    partner.send(JSON.stringify({ type: 'partner-left' }));
    partner.partnerId = null;
  }
  cleanupPair(ws);
  ws.send(JSON.stringify({ type: 'disconnected' }));
  findPartner(ws);
}

function handleStop(ws) {
  const partner = getPartnerWs(ws);
  if (partner && partner.readyState === 1) {
    partner.send(JSON.stringify({ type: 'partner-left' }));
    partner.partnerId = null;
  }
  cleanupPair(ws);
  ws.send(JSON.stringify({ type: 'disconnected' }));
}

function handleDisconnect(ws) {
  const partner = getPartnerWs(ws);
  if (partner && partner.readyState === 1) {
    partner.send(JSON.stringify({ type: 'partner-left' }));
    partner.partnerId = null;
  }
  cleanupPair(ws);
  const idx = waitingQueue.indexOf(ws);
  if (idx !== -1) waitingQueue.splice(idx, 1);
}

function handleMessage(ws, msg) {
  switch (msg.type) {
    case 'find': findPartner(ws); break;
    case 'offer': case 'answer': case 'ice-candidate': relayToPartner(ws, msg); break;
    case 'chat': relayToPartner(ws, msg); break;
    case 'next': handleNext(ws); break;
    case 'stop': handleStop(ws); break;
  }
}

function createWSServer(server, name) {
  const wss = new WebSocketServer({ server });
  wsServers.push(wss);
  wss.on('connection', (ws) => {
    const userId = uuidv4();
    ws.userId = userId;
    ws.partnerId = null;
    ws.inQueue = false;
    ws.on('message', (data) => {
      try { handleMessage(ws, JSON.parse(data.toString())); }
      catch (e) { console.error('Invalid message:', e); }
    });
    ws.send(JSON.stringify({ type: 'connected', userId }));
    console.log(`[${name}] User ${userId}`);
    ws.on('close', () => {
      console.log(`[${name}] User ${userId} left`);
      handleDisconnect(ws);
    });
  });
  return wss;
}

function getLocalIP() {
  const nets = require('os').networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return 'localhost';
}

const ip = getLocalIP();

// HTTP
const httpServer = http.createServer(app);
createWSServer(httpServer, 'HTTP');
httpServer.listen(HTTP_PORT, HOST, () => {
  console.log(`\nOmeTV Clone`);
  console.log(`──────────`);
  console.log(`HTTP  (PC):   http://localhost:${HTTP_PORT}`);
  console.log(`              http://${ip}:${HTTP_PORT}`);
});

// HTTPS
const certDir = path.join(__dirname, '..', 'certs');
if (!fs.existsSync(certDir)) fs.mkdirSync(certDir, { recursive: true });

const keyPath = path.join(certDir, 'key.pem');
const certPath = path.join(certDir, 'cert.pem');

if (!fs.existsSync(keyPath) || !fs.existsSync(certPath)) {
  const { execSync } = require('child_process');
  execSync(`openssl req -x509 -newkey rsa:2048 -keyout "${keyPath}" -out "${certPath}" -days 365 -nodes -subj "/CN=${ip}"`, { stdio: 'pipe' });
  console.log('Generated self-signed SSL certificate');
}

const sslOptions = { key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) };
const httpsServer = https.createServer(sslOptions, app);
createWSServer(httpsServer, 'HTTPS');
httpsServer.listen(HTTPS_PORT, HOST, () => {
  console.log(`HTTPS (phone): https://localhost:${HTTPS_PORT}`);
  console.log(`               https://${ip}:${HTTPS_PORT}`);
  console.log(`               (accept the security warning)\n`);
});
