const CONFIG = {
  wsUrl: `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`,
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' }
  ]
};

let ws, localStream, pc;
let userId, partnerId, isInitiator;
let pendingCandidates = [];
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

function getProfile() {
  try { return JSON.parse(localStorage.getItem('ob_profile')); } catch { return null; }
}

function setProfile(data) {
  localStorage.setItem('ob_profile', JSON.stringify(data));
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
      if (!partnerId) {
    const p = getProfile();
    if (p) {
      const t = document.querySelector('.hero-tag');
      if (t) t.textContent = 'Welcome back, ' + p.name;
      show('start');
    } else {
      show('profile');
    }
  }
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
      const partnerName = msg.partnerName || 'a stranger';
      const partnerGender = msg.partnerGender || '';
      const label = partnerGender ? `${partnerName} (${partnerGender})` : partnerName;
      sysMsg('Connected with ' + label);
      startPeerConnection();
      break;
    case 'offer':
      if (!pc) createPC(false);
      if (pc.signalingState === 'stable') {
        pc.setRemoteDescription(new RTCSessionDescription(msg.sdp))
          .then(() => { flushCandidates(); return pc.createAnswer(); })
          .then(a => pc.setLocalDescription(a))
          .then(() => ws.send(JSON.stringify({ type: 'answer', sdp: pc.localDescription })))
          .catch(e => console.error('Answer error:', e));
      }
      break;
    case 'answer':
      if (pc && pc.signalingState === 'have-local-offer') {
        pc.setRemoteDescription(new RTCSessionDescription(msg.sdp))
          .then(() => flushCandidates())
          .catch(e => console.error('Set remote error:', e));
      }
      break;
    case 'ice-candidate':
      if (pc && msg.candidate) {
        if (pc.remoteDescription) {
          pc.addIceCandidate(new RTCIceCandidate(msg.candidate)).catch(() => {});
        } else {
          pendingCandidates.push(msg.candidate);
        }
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

  if (navigator.mediaDevices.enumerateDevices) {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const hasMic = devices.some(d => d.kind === 'audioinput');
    if (!hasMic) {
      localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      sysMsg('No mic found — video only');
      return localStream;
    }
  }

  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    return localStream;
  } catch (e) {
    if (e.name === 'NotAllowedError') throw new Error('Allow camera AND microphone in browser settings.');
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    sysMsg('Mic unavailable — video only');
    return localStream;
  }
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
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      ws.send(JSON.stringify({ type: 'offer', sdp: pc.localDescription }));
    } catch (e) { sysMsg('Connection error - tap Next'); }
  }
}

function createPC() {
  if (pc) pc.close();
  pc = new RTCPeerConnection({ iceServers: CONFIG.iceServers });
  localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
  if (!localStream.getAudioTracks().length) pc.addTransceiver('audio', { direction: 'recvonly' });
  if (!localStream.getVideoTracks().length) pc.addTransceiver('video', { direction: 'recvonly' });
  pc.onicecandidate = e => { if (e.candidate) ws.send(JSON.stringify({ type: 'ice-candidate', candidate: e.candidate })); };
  pc.ontrack = e => {
    if (e.track.kind === 'audio') {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const src = ctx.createMediaStreamSource(e.streams[0]);
      const gain = ctx.createGain();
      gain.gain.value = 3.0;
      src.connect(gain);
      gain.connect(ctx.destination);
    } else {
      $('partner-video').srcObject = e.streams[0];
    }
    $('placeholder').classList.add('hidden');
    $('enc-badge').classList.remove('hidden');
    $('status-text').textContent = 'Connected';
    playConnectSound();
  };
  pc.oniceconnectionstatechange = () => {
    if (pc.iceConnectionState === 'failed') sysMsg('Connection failed. Tap Next.');
  };
}

function cleanupPC() {
  if (pc) { pc.close(); pc = null; }
  $('partner-video').srcObject = null;
  $('placeholder').classList.remove('hidden');
  $('enc-badge').classList.add('hidden');
  $('status-text').textContent = 'Disconnected';
  partnerId = null;
}

function show(name) {
  ['connecting','profile','start','chat'].forEach(id => $(id).classList.toggle('hidden', id !== name));
}

function playConnectSound() {
  try { if (navigator.vibrate) navigator.vibrate([100, 50, 100]); } catch (_) {}
}

function addMsg(text, who) {
  const d = document.createElement('div');
  d.className = 'msg ' + who;
  d.textContent = text;
  $('messages').appendChild(d);
  $('messages').scrollTop = $('messages').scrollHeight;
}

function flushCandidates() {
  while (pendingCandidates.length) {
    const c = pendingCandidates.shift();
    if (pc) pc.addIceCandidate(new RTCIceCandidate(c)).catch(() => {});
  }
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
$('profile-submit').addEventListener('click', () => {
  const name = $('profile-name').value.trim();
  const gender = $('profile-gender').value;
  const is18 = $('profile-18').checked;
  const err = $('profile-error');
  err.classList.add('hidden');
  if (!name) { err.textContent = 'Please enter your name'; err.classList.remove('hidden'); return; }
  if (!is18) { err.textContent = 'You must be 18 or older to use this app'; err.classList.remove('hidden'); return; }
  setProfile({ name, gender });
  const t = document.querySelector('.hero-tag');
  if (t) t.textContent = 'Welcome, ' + name;
  show('start');
});

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
  const p = getProfile();
  ws.send(JSON.stringify({ type: 'find', profile: p || {} }));
  show('chat');
  $('enc-badge').classList.add('hidden');
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
