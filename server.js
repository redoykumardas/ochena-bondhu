const express = require('express');
const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.static(path.join(__dirname, 'public')));

const waitingQueue = [];
const activePairs = new Map();

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

  ws.on('close', () => handleDisconnect(ws));
});

function handleMessage(ws, msg) {
  switch (msg.type) {
    case 'find': findPartner(ws); break;
    case 'offer': case 'answer': case 'ice-candidate': relay(ws, msg); break;
    case 'chat': relay(ws, msg); break;
    case 'next': handleNext(ws); break;
    case 'stop': handleStop(ws); break;
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
  } else {
    ws.inQueue = true;
    waitingQueue.push(ws);
    ws.send(JSON.stringify({ type: 'waiting' }));
  }
}

function relay(ws, msg) {
  if (!ws.partnerId) return;
  for (const client of wss.clients) {
    if (client.userId === ws.partnerId && client.readyState === 1) {
      client.send(JSON.stringify(msg));
      break;
    }
  }
}

function handleNext(ws) {
  const partner = getPartner(ws);
  if (partner && partner.readyState === 1) {
    partner.send(JSON.stringify({ type: 'partner-left' }));
    partner.partnerId = null;
  }
  cleanup(ws);
  ws.send(JSON.stringify({ type: 'disconnected' }));
  findPartner(ws);
}

function handleStop(ws) {
  const partner = getPartner(ws);
  if (partner && partner.readyState === 1) {
    partner.send(JSON.stringify({ type: 'partner-left' }));
    partner.partnerId = null;
  }
  cleanup(ws);
  ws.send(JSON.stringify({ type: 'disconnected' }));
}

function handleDisconnect(ws) {
  const partner = getPartner(ws);
  if (partner && partner.readyState === 1) {
    partner.send(JSON.stringify({ type: 'partner-left' }));
    partner.partnerId = null;
  }
  cleanup(ws);
  const idx = waitingQueue.indexOf(ws);
  if (idx !== -1) waitingQueue.splice(idx, 1);
}

function getPartner(ws) {
  if (!ws.partnerId) return null;
  for (const client of wss.clients) {
    if (client.userId === ws.partnerId) return client;
  }
  return null;
}

function cleanup(ws) {
  if (ws.partnerId) {
    activePairs.delete(ws.userId);
    activePairs.delete(ws.partnerId);
    ws.partnerId = null;
  }
  ws.inQueue = false;
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
