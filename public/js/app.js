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
let findStartTime = null;
let findTimer = null;
let noOneTimer = null;
let permGranted = localStorage.getItem('ob_perm') === '1';
let connTimeout = null;

const $ = id => document.getElementById(id);

function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  ws = new WebSocket(CONFIG.wsUrl);
  connecting = true;
  connTimeout = setTimeout(() => {
    if (connecting) {
      const s = $('conn-msg');
      if (s) s.textContent = 'Taking longer than usual. Make sure the server is running.';
    }
  }, 10000);
  ws.onopen = () => {
    connecting = false;
    if (connTimeout) { clearTimeout(connTimeout); connTimeout = null; }
  };
  ws.onmessage = e => handle(JSON.parse(e.data));
  ws.onclose = (e) => {
    connecting = false;
    if (connTimeout) { clearTimeout(connTimeout); connTimeout = null; }
    if (document.visibilityState !== 'hidden') {
      if (e.code !== 1000) {
        const m = $('conn-msg');
        if (m) m.textContent = e.code === 1006 ? 'Server unreachable. Retrying...' : 'Disconnected. Reconnecting...';
      }
      reconnectTimer = setTimeout(connect, 3000);
    }
  };
  ws.onerror = () => {
    const m = $('conn-msg');
    if (m) m.textContent = 'Connection error. Retrying...';
  };
}

function safeSend(data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
    return true;
  }
  return false;
}

function findPartner() {
  const p = getProfile();
  if (!safeSend({ type: 'find', profile: p || {} })) {
    sysMsg('Connection lost. Reconnecting...');
    const retry = setInterval(() => {
      if (safeSend({ type: 'find', profile: p || {} })) {
        clearInterval(retry);
      }
    }, 500);
  }
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

function setStatus(state) {
  const dot = $('status-dot');
  const label = $('status-label');
  dot.className = '';
  if (state === 'searching') {
    dot.classList.add('dot-yellow');
    label.textContent = 'Searching';
  } else if (state === 'connected') {
    dot.classList.add('dot-green');
    label.textContent = 'Connected';
  } else if (state === 'disconnected') {
    dot.classList.add('dot-red');
    label.textContent = 'Disconnected';
  } else {
    dot.classList.add('dot-gray');
    label.textContent = state;
  }
}

function updateWaitTime() {
  if (!findStartTime) return;
  const sec = Math.floor((Date.now() - findStartTime) / 1000);
  const el = $('status-wait');
  if (sec < 60) el.textContent = sec + 's';
  else el.textContent = Math.floor(sec / 60) + 'm ' + (sec % 60) + 's';
}

function startFindTimer() {
  findStartTime = Date.now();
  $('status-wait').textContent = '0s';
  $('btn-cancel-find').classList.remove('hidden');
  if (findTimer) clearInterval(findTimer);
  findTimer = setInterval(updateWaitTime, 1000);
  if (noOneTimer) clearTimeout(noOneTimer);
  noOneTimer = setTimeout(() => {
    sysMsg('No one online right now. Keep waiting or tap Next to try again.');
  }, 15000);
}

function stopFindTimer() {
  if (findTimer) { clearInterval(findTimer); findTimer = null; }
  if (noOneTimer) { clearTimeout(noOneTimer); noOneTimer = null; }
  $('status-wait').textContent = '';
  $('btn-cancel-find').classList.add('hidden');
  findStartTime = null;
}

// Sound effects
function playSound(type) {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    g.gain.value = 0.15;
    osc.connect(g); g.connect(ctx.destination);
    if (type === 'connect') {
      osc.frequency.setValueAtTime(660, ctx.currentTime);
      osc.frequency.setValueAtTime(880, ctx.currentTime + 0.08);
      osc.frequency.setValueAtTime(1100, ctx.currentTime + 0.16);
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35);
      osc.start(); osc.stop(ctx.currentTime + 0.35);
    } else if (type === 'disconnect') {
      osc.frequency.setValueAtTime(500, ctx.currentTime);
      osc.frequency.setValueAtTime(400, ctx.currentTime + 0.1);
      osc.frequency.setValueAtTime(300, ctx.currentTime + 0.2);
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35);
      osc.start(); osc.stop(ctx.currentTime + 0.35);
    } else if (type === 'message') {
      osc.frequency.setValueAtTime(1000, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.08);
      osc.start(); osc.stop(ctx.currentTime + 0.08);
    } else if (type === 'error') {
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(200, ctx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.25);
      osc.start(); osc.stop(ctx.currentTime + 0.25);
    }
  } catch (_) {}
}

function handle(msg) {
  switch (msg.type) {
    case 'connected':
      userId = msg.userId;
      if (!partnerId) {
        // if we were on chat screen still searching, reconnect find
        if (!$('chat').classList.contains('hidden') && permGranted && findTimer) {
          findPartner();
          return;
        }
        const p = getProfile();
        if (p && permGranted) {
          const t = document.querySelector('.hero-tag');
          if (t) t.textContent = 'Welcome back, ' + p.name;
          show('start');
        } else if (!permGranted) {
          show('perm');
        } else {
          show('profile');
        }
      }
      break;
    case 'waiting':
      $('status-text').textContent = 'Waiting for a partner...';
      if (noOneTimer) clearTimeout(noOneTimer);
      break;
    case 'matched':
      partnerId = msg.partnerId;
      isInitiator = msg.initiator;
      show('chat');
      stopFindTimer();
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
          .then(() => safeSend({ type: 'answer', sdp: pc.localDescription }))
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
      playSound('message');
      if (!$('panel').classList.contains('open')) {
        unread++;
        updateBadge();
      }
      break;
    case 'partner-left':
      sysMsg('Partner disconnected');
      cleanupPC();
      playSound('disconnect');
      $('status-text').textContent = 'Partner left - tap Next';
      $('chat-input').disabled = true;
      $('send-btn').disabled = true;
      break;
    case 'disconnected':
      cleanupPC();
      break;
    case 'online-count':
      const el = $('online-count');
      if (el) el.textContent = `🟢 ${msg.count} online now`;
      break;
  }
}

async function startLocalStream() {
  if (localStream) return localStream;
  if (!navigator.mediaDevices) throw new Error('Camera unavailable');
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
    playSound('error');
    return;
  }
  $('self-video').srcObject = localStream;
  $('placeholder').classList.remove('hidden');
  createPC(isInitiator);
  if (isInitiator) {
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      safeSend({ type: 'offer', sdp: pc.localDescription });
    } catch (e) { sysMsg('Connection error - tap Next'); }
  }
}

function createPC() {
  if (pc) pc.close();
  pc = new RTCPeerConnection({ iceServers: CONFIG.iceServers });
  localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
  if (!localStream.getAudioTracks().length) pc.addTransceiver('audio', { direction: 'recvonly' });
  if (!localStream.getVideoTracks().length) pc.addTransceiver('video', { direction: 'recvonly' });
  pc.onicecandidate = e => { if (e.candidate) safeSend({ type: 'ice-candidate', candidate: e.candidate }); };
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
    setStatus('connected');
    playSound('connect');
    try { if (navigator.vibrate) navigator.vibrate([100, 50, 100]); } catch (_) {}
  };
  pc.oniceconnectionstatechange = () => {
    if (pc.iceConnectionState === 'failed') {
      sysMsg('Connection failed. Tap Next.');
      playSound('error');
    }
  };
}

function cleanupPC() {
  if (pc) { pc.close(); pc = null; }
  $('partner-video').srcObject = null;
  $('placeholder').classList.remove('hidden');
  $('enc-badge').classList.add('hidden');
  $('status-text').textContent = 'Disconnected';
  setStatus('disconnected');
  playSound('disconnect');
  partnerId = null;
}

function show(name) {
  ['connecting','profile','start','chat','perm'].forEach(id => {
    const el = $(id);
    if (el) el.classList.toggle('hidden', id !== name);
  });
  if (name === 'chat') {
    setStatus('searching');
    startFindTimer();
  } else {
    stopFindTimer();
  }
  // stop perm preview when leaving perm screen
  if (name !== 'perm' && permStream) {
    permStream.getTracks().forEach(t => t.stop());
    permStream = null;
  }
}

// Events
let permStream = null;

$('perm-btn').addEventListener('click', async () => {
  $('perm-error').classList.add('hidden');
  $('perm-btn').textContent = 'Requesting...';
  $('perm-btn').disabled = true;
  try {
    if (permStream) permStream.getTracks().forEach(t => t.stop());
    try {
      permStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    } catch (_) {
      permStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    }
    $('perm-video').srcObject = permStream;
    localStorage.setItem('ob_perm', '1');
    permGranted = true;
    const hasAudio = permStream.getAudioTracks().length > 0;
    $('perm-btn').textContent = hasAudio ? '✅ Access Granted' : '✅ Camera Access Granted (no mic)';
    setTimeout(() => {
      const p = getProfile();
      if (p) {
        const t = document.querySelector('.hero-tag');
        if (t) t.textContent = 'Welcome back, ' + p.name;
        show('start');
      } else {
        show('profile');
      }
    }, 600);
  } catch (e) {
    const errEl = $('perm-error');
    if (e.name === 'NotAllowedError') {
      errEl.textContent = 'Camera was blocked. Please click the camera icon in your browser address bar and allow access, then try again.';
    } else if (e.name === 'NotFoundError') {
      errEl.textContent = 'No camera found. Connect a camera and try again.';
    } else {
      errEl.textContent = 'Camera access failed: ' + e.message;
    }
    errEl.classList.remove('hidden');
    $('perm-btn').textContent = 'Try Again';
    $('perm-btn').disabled = false;
  }
});

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
  findPartner();
  show('chat');
  $('enc-badge').classList.add('hidden');
  $('status-text').textContent = 'Finding a partner...';
});

$('btn-cancel-find').addEventListener('click', () => {
  cleanupPC();
  safeSend({ type: 'stop' });
  stopLocalStream();
  show('start');
  $('chat-input').disabled = true;
  $('send-btn').disabled = true;
  resetButtons();
});

$('btn-next').addEventListener('click', () => {
  cleanupPC();
  safeSend({ type: 'next' });
  $('status-text').textContent = 'Finding new partner...';
});

$('btn-stop').addEventListener('click', () => {
  cleanupPC();
  safeSend({ type: 'stop' });
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

// Report
$('btn-report').addEventListener('click', () => {
  $('report-overlay').classList.remove('hidden');
});

$('report-close').addEventListener('click', () => {
  $('report-overlay').classList.add('hidden');
  $('report-status').classList.add('hidden');
});

$('report-overlay').addEventListener('click', e => {
  if (e.target === $('report-overlay')) {
    $('report-overlay').classList.add('hidden');
    $('report-status').classList.add('hidden');
  }
});

document.querySelectorAll('.report-opt').forEach(btn => {
  btn.addEventListener('click', () => {
    const reason = btn.dataset.reason;
    safeSend({ type: 'report', reason });
    $('report-status').textContent = 'Report submitted. Thank you.';
    $('report-status').style.color = '#30d158';
    $('report-status').classList.remove('hidden');
    setTimeout(() => {
      $('report-overlay').classList.add('hidden');
      $('report-status').classList.add('hidden');
      $('report-status').style.color = '';
    }, 1500);
  });
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
  safeSend({ type: 'chat', text });
  addMsg(text, 'me');
  $('chat-input').value = '';
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

connect();
