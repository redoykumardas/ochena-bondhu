const CONFIG = {
  wsUrl: `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`,
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ]
};

let ws, localStream, pc;
let userId, partnerId, isInitiator;
let unread = 0;
let reconnectTimer = null;
let connecting = false;

const $ = id => document.getElementById(id);

function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }

  ws = new WebSocket(CONFIG.wsUrl);
  connecting = true;

  ws.onopen = () => { connecting = false; };
  ws.onmessage = e => handle(JSON.parse(e.data));
  ws.onclose = () => {
    connecting = false;
    if (document.visibilityState !== 'hidden') {
      reconnectTimer = setTimeout(connect, 3000);
    }
  };
}

function stopLocalStream() {
  if (localStream) {
    localStream.getTracks().forEach(t => t.stop());
    localStream = null;
  }
}

function handle(msg) {
  switch (msg.type) {
    case 'connected':
      userId = msg.userId;
      if (!partnerId) show('start');
      break;
    case 'waiting':
      $('status-text').textContent = 'Waiting for a partner...';
      break;
    case 'matched':
      partnerId = msg.partnerId;
      isInitiator = msg.initiator;
      show('chat');
      $('status-text').textContent = 'Connecting...';
      $('chat-input').disabled = false;
      $('send-btn').disabled = false;
      sysMsg('Connected to a stranger');
      startPeerConnection();
      break;
    case 'offer':
      if (!pc) createPC(false);
      if (pc.signalingState === 'stable') {
        pc.setRemoteDescription(new RTCSessionDescription(msg.sdp))
          .then(() => pc.createAnswer())
          .then(a => pc.setLocalDescription(a))
          .then(() => ws.send(JSON.stringify({ type: 'answer', sdp: pc.localDescription })))
          .catch(e => console.error('Answer error:', e));
      }
      break;
    case 'answer':
      if (pc && pc.signalingState === 'have-local-offer') {
        pc.setRemoteDescription(new RTCSessionDescription(msg.sdp))
          .catch(e => console.error('Set remote error:', e));
      }
      break;
    case 'ice-candidate':
      if (pc && msg.candidate && pc.remoteDescription) {
        pc.addIceCandidate(new RTCIceCandidate(msg.candidate)).catch(() => {});
      }
      break;
    case 'chat':
      addMsg(msg.text, 'other');
      if (!$('panel').classList.contains('open')) {
        unread++;
        updateBadge();
      }
      break;
    case 'partner-left':
      sysMsg('Partner disconnected');
      cleanupPC();
      $('status-text').textContent = 'Partner left - tap Next';
      $('chat-input').disabled = true;
      $('send-btn').disabled = true;
      break;
    case 'disconnected':
      cleanupPC();
      break;
  }
}

async function startLocalStream() {
  if (localStream) return localStream;
  if (!navigator.mediaDevices) throw new Error('Camera unavailable. Use http://localhost:3000');
  for (const c of [{ video: true, audio: true }, { video: true, audio: false }]) {
    try {
      localStream = await navigator.mediaDevices.getUserMedia(c);
      return localStream;
    } catch (e) {
      if (e.name === 'NotAllowedError') throw new Error('Camera access denied. Allow in browser settings.');
    }
  }
  throw new Error('No camera found on this device.');
}

async function startPeerConnection() {
  try {
    if (!localStream) localStream = await startLocalStream();
  } catch (e) {
    $('status-text').textContent = 'Camera error';
    sysMsg(e.message);
    return;
  }
  $('self-video').srcObject = localStream;
  $('placeholder').classList.remove('hidden');
  createPC(isInitiator);
  if (isInitiator) {
    try {
      const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true });
      await pc.setLocalDescription(offer);
      ws.send(JSON.stringify({ type: 'offer', sdp: pc.localDescription }));
    } catch (e) { sysMsg('Connection error - tap Next'); }
  }
}

function createPC() {
  if (pc) pc.close();
  pc = new RTCPeerConnection({ iceServers: CONFIG.iceServers });
  localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
  pc.onicecandidate = e => { if (e.candidate) ws.send(JSON.stringify({ type: 'ice-candidate', candidate: e.candidate })); };
  pc.ontrack = e => {
    $('partner-video').srcObject = e.streams[0];
    $('placeholder').classList.add('hidden');
    $('status-text').textContent = 'Connected';
  };
  pc.oniceconnectionstatechange = () => {
    if (pc.iceConnectionState === 'failed') sysMsg('Connection failed. Tap Next.');
  };
}

function cleanupPC() {
  if (pc) { pc.close(); pc = null; }
  $('partner-video').srcObject = null;
  $('placeholder').classList.remove('hidden');
  $('status-text').textContent = 'Disconnected';
  partnerId = null;
}

function show(name) {
  ['connecting','start','chat'].forEach(id => $(id).classList.toggle('hidden', id !== name));
}

function addMsg(text, who) {
  const d = document.createElement('div');
  d.className = 'msg ' + who;
  d.textContent = text;
  $('messages').appendChild(d);
  $('messages').scrollTop = $('messages').scrollHeight;
}

function sysMsg(text) {
  const d = document.createElement('div');
  d.className = 'msg sys';
  d.textContent = text;
  $('messages').appendChild(d);
  $('messages').scrollTop = $('messages').scrollHeight;
}

function clearMsgs() {
  $('messages').innerHTML = '';
}

function resetButtons() {
  $('btn-mic').classList.remove('muted');
  $('btn-cam').classList.remove('muted');
}

function updateBadge() {
  const b = $('chat-badge');
  if (unread > 0) {
    b.textContent = unread > 99 ? '99+' : unread;
    b.classList.remove('hidden');
  } else {
    b.classList.add('hidden');
  }
}

function openPanel() {
  $('panel').classList.add('open');
  unread = 0;
  updateBadge();
}

// Events
$('start-btn').addEventListener('click', async () => {
  $('start-btn').textContent = 'Starting...';
  $('start-error').classList.add('hidden');

  try {
    await startLocalStream();
    $('local-preview').srcObject = localStream;
  } catch (e) {
    $('start-error').textContent = '⚠ ' + e.message;
    $('start-error').classList.remove('hidden');
    $('start-btn').textContent = 'Start Chatting';
    return;
  }

  clearMsgs();
  resetButtons();
  ws.send(JSON.stringify({ type: 'find' }));
  show('chat');
  $('status-text').textContent = 'Finding a partner...';
});

$('btn-next').addEventListener('click', () => {
  cleanupPC();
  ws.send(JSON.stringify({ type: 'next' }));
  $('status-text').textContent = 'Finding new partner...';
});

$('btn-stop').addEventListener('click', () => {
  cleanupPC();
  ws.send(JSON.stringify({ type: 'stop' }));
  stopLocalStream();
  show('start');
  $('chat-input').disabled = true;
  $('send-btn').disabled = true;
  resetButtons();
});

$('btn-mic').addEventListener('click', () => {
  const t = localStream?.getAudioTracks()[0];
  if (t) { t.enabled = !t.enabled; $('btn-mic').classList.toggle('muted'); }
});

$('btn-cam').addEventListener('click', () => {
  const t = localStream?.getVideoTracks()[0];
  if (t) { t.enabled = !t.enabled; $('btn-cam').classList.toggle('muted'); }
});

$('btn-chat').addEventListener('click', openPanel);
$('close-panel').addEventListener('click', () => $('panel').classList.remove('open'));
$('panel').addEventListener('click', e => { if (e.target === $('panel')) $('panel').classList.remove('open'); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') $('panel').classList.remove('open'); });

$('chat-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') sendMsg();
});

$('send-btn').addEventListener('click', sendMsg);

function sendMsg() {
  const text = $('chat-input').value.trim();
  if (!text || !partnerId) return;
  ws.send(JSON.stringify({ type: 'chat', text }));
  addMsg(text, 'me');
  $('chat-input').value = '';
}

connect();
