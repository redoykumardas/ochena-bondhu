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

function broadcastCount() {
  const count = wss.clients.size;
  for (const client of wss.clients) {
    if (client.readyState === 1) {
      client.send(JSON.stringify({ type: 'online-count', count }));
    }
  }
}

wss.on('connection', (ws) => {
  const userId = uuidv4();
  ws.userId = userId;
  ws.partnerId = null;
  ws.inQueue = false;
  ws.profile = null;

  ws.on('message', (data) => {
    try { handleMessage(ws, JSON.parse(data.toString())); }
    catch (e) { console.error('Invalid message:', e); }
  });

  ws.on('close', () => {
    handleDisconnect(ws);
    broadcastCount();
  });

  ws.send(JSON.stringify({ type: 'connected', userId }));
  broadcastCount();
});

function handleMessage(ws, msg) {
  switch (msg.type) {
    case 'find':
      if (msg.profile) ws.profile = msg.profile;
      findPartner(ws); break;
    case 'offer': case 'answer': case 'ice-candidate': relay(ws, msg); break;
    case 'chat': relay(ws, msg); break;
    case 'report': handleReport(ws, msg); break;
    case 'next': handleNext(ws); break;
    case 'stop': handleStop(ws); break;
  }
}

function findPartner(ws) {
  if (ws.partnerId || ws.inQueue) return;
  if (waitingQueue.length > 0) {
    const partner = waitingQueue.shift();
    partner.inQueue = false;
    ws.partnerId = partner.userId;
    partner.partnerId = ws.userId;
    activePairs.set(ws.userId, partner.userId);
    activePairs.set(partner.userId, ws.userId);

    const myInfo = ws.profile || {};
    const partnerInfo = partner.profile || {};
    console.log(`MATCH: ${ws.userId.slice(0,6)} (${myInfo.name||'?'}) <-> ${partner.userId.slice(0,6)} (${partnerInfo.name||'?'})`);

    ws.send(JSON.stringify({ type: 'matched', partnerId: partner.userId, initiator: true, partnerName: partnerInfo.name || 'a stranger', partnerGender: partnerInfo.gender || '' }));
    partner.send(JSON.stringify({ type: 'matched', partnerId: ws.userId, initiator: false, partnerName: myInfo.name || 'a stranger', partnerGender: myInfo.gender || '' }));
  } else {
    ws.inQueue = true;
    waitingQueue.push(ws);
    ws.send(JSON.stringify({ type: 'waiting' }));
    console.log(`QUEUE: ${ws.userId.slice(0,6)} waiting (total in queue: ${waitingQueue.length})`);
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
  if (ws.partnerId) {
    const partner = getPartner(ws);
    if (partner && partner.readyState === 1) {
      partner.send(JSON.stringify({ type: 'partner-left' }));
      partner.partnerId = null;
    }
    cleanup(ws);
  }
  if (ws.inQueue) {
    const idx = waitingQueue.indexOf(ws);
    if (idx !== -1) waitingQueue.splice(idx, 1);
    ws.inQueue = false;
  }
  ws.send(JSON.stringify({ type: 'disconnected' }));
  console.log(`NEXT: ${ws.userId.slice(0,6)} looking for new partner`);
  findPartner(ws);
}

function handleStop(ws) {
  if (ws.inQueue) {
    const idx = waitingQueue.indexOf(ws);
    if (idx !== -1) waitingQueue.splice(idx, 1);
    ws.inQueue = false;
    ws.send(JSON.stringify({ type: 'disconnected' }));
    console.log(`STOP from queue: ${ws.userId.slice(0,6)} removed`);
    return;
  }
  const partner = getPartner(ws);
  if (partner && partner.readyState === 1) {
    partner.send(JSON.stringify({ type: 'partner-left' }));
    partner.partnerId = null;
  }
  cleanup(ws);
  ws.send(JSON.stringify({ type: 'disconnected' }));
  console.log(`STOP: ${ws.userId.slice(0,6)} left`);
}

function handleDisconnect(ws) {
  if (ws.inQueue) {
    const idx = waitingQueue.indexOf(ws);
    if (idx !== -1) waitingQueue.splice(idx, 1);
    console.log(`DISCONNECT from queue: ${ws.userId.slice(0,6)} removed`);
  }
  const partner = getPartner(ws);
  if (partner && partner.readyState === 1) {
    partner.send(JSON.stringify({ type: 'partner-left' }));
    partner.partnerId = null;
    console.log(`DISCONNECT: ${ws.userId.slice(0,6)} left, notifying ${partner.userId.slice(0,6)}`);
  }
  cleanup(ws);
}

function handleReport(ws, msg) {
  const partner = getPartner(ws);
  console.log(`Report from ${ws.userId} against ${ws.partnerId || 'none'}: ${msg.reason}`);
  ws.send(JSON.stringify({ type: 'report-ack' }));
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

if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}
module.exports = server;
