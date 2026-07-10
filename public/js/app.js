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
let searchMsgIndex = 0;
let searchMsgTimer = null;
let statsTimer = null;
let callTimer = null;
let callStartTime = null;
let callTimerInterval = null;
let lastMsgTime = 0;

const searchMessages = [
  'Looking for someone nearby...',
  'Finding the best match...',
  'Checking connection quality...',
  'Almost ready...'
];

const $ = id => document.getElementById(id);

function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  ws = new WebSocket(CONFIG.wsUrl);
  connecting = true;
  const connMsg = $('conn-msg');
  if (connMsg) connMsg.textContent = 'Connecting';
  connTimeout = setTimeout(() => {
    if (connecting) {
      const s = $('conn-msg');
      if (s) {
        s.innerHTML = 'Taking longer than usual. <a href="#" id="conn-retry" style="color:var(--primary)">Try again</a>';
        const retry = $('conn-retry');
        if (retry) retry.onclick = (e) => { e.preventDefault(); ws.close(); connect(); };
      }
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
  noOneTimer = setTimeout(showEmptyState, 20000);
}

function stopFindTimer() {
  if (findTimer) { clearInterval(findTimer); findTimer = null; }
  if (noOneTimer) { clearTimeout(noOneTimer); noOneTimer = null; }
  if (searchMsgTimer) { clearInterval(searchMsgTimer); searchMsgTimer = null; }
  $('status-wait').textContent = '';
  $('btn-cancel-find').classList.add('hidden');
  findStartTime = null;
}

function startSearchMessages() {
  searchMsgIndex = 0;
  $('status-text').textContent = searchMessages[0];
  if (searchMsgTimer) clearInterval(searchMsgTimer);
  searchMsgTimer = setInterval(() => {
    searchMsgIndex = (searchMsgIndex + 1) % searchMessages.length;
    $('status-text').textContent = searchMessages[searchMsgIndex];
  }, 3000);
}

function showEmptyState() {
  $('status-text').innerHTML = 'No one is available right now.<br>More people usually join during the evening.';
  $('btn-cancel-find').textContent = 'Try Again';
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

// ===== Screen / Modal system =====
let transitioning = false;

function show(name) {
  if (transitioning) return;
  const landing = $('landing');
  const nav = $('navbar');
  const footer = $('footer');

  const fullscreenMap = { connecting: 'connecting', chat: 'chat', landing: 'landing' };
  const targetId = fullscreenMap[name];
  if (!targetId) return;

  // Find current visible screen-fade element
  const current = document.querySelector('.screen-fade.visible');
  if (!current || current.id === targetId) {
    // No transition needed — first load or same screen
    document.querySelectorAll('.fullscreen').forEach(el => {
      el.classList.toggle('hidden', el.id !== targetId);
      if (el.id === targetId) { el.classList.remove('hidden'); el.classList.add('visible'); }
      else { el.classList.remove('visible'); }
    });
    if (landing) {
      landing.classList.toggle('hidden', name !== 'landing');
      if (name === 'landing') landing.classList.add('visible');
      else landing.classList.remove('visible');
    }
    if (nav) nav.classList.toggle('hidden', name === 'chat');
    if (footer) footer.classList.toggle('hidden', name !== 'landing');
    if (name === 'chat') { setStatus('searching'); startFindTimer(); startSearchMessages(); }
    else { stopFindTimer(); }
    return;
  }

  transitioning = true;

  const finish = () => {
    // Hide current
    current.classList.add('hidden');
    current.classList.remove('fade-out', 'visible');
    // Show target
    const target = $(targetId);
    if (target) {
      target.classList.remove('hidden');
      target.classList.add('visible');
    }
    transitioning = false;
  };

  // Fade out current
  if (current.id === 'landing' || current.id === 'connecting') {
    current.classList.remove('visible');
    current.classList.add('fade-out');
  } else if (current.id === 'chat') {
    current.classList.remove('visible');
    current.classList.add('fade-out');
  }

  // Sync nav/landing/footer visibility with animation
  if (targetId === 'chat') {
    // Going to chat — hide landing elements
    if (landing && !landing.classList.contains('hidden')) landing.classList.add('hidden');
    if (nav && !nav.classList.contains('hidden')) nav.classList.add('hidden');
    if (footer && !footer.classList.contains('hidden')) footer.classList.add('hidden');
  } else if (name === 'landing') {
    // Coming from chat to landing — show after transition
    setTimeout(() => {
      if (landing) landing.classList.remove('hidden');
      if (nav) nav.classList.remove('hidden');
      if (footer) footer.classList.remove('hidden');
    }, 250);
  }

  setTimeout(finish, 220);

  if (name === 'chat') {
    setStatus('searching');
    startFindTimer();
    startSearchMessages();
  } else {
    stopFindTimer();
  }
}

function openModal(step) {
  const overlay = $('modal-overlay');
  if (!overlay) return;
  overlay.classList.remove('hidden');
  let found = false;
  document.querySelectorAll('#modal-overlay > .modal').forEach(el => {
    const match = el.id === step + '-step';
    el.classList.toggle('hidden', !match);
    if (match) found = true;
  });
  if (!found) overlay.classList.add('hidden');
}

function closeModal() {
  const overlay = $('modal-overlay');
  if (overlay) overlay.classList.add('hidden');
  const settingsOpen = $('settings-step') && !$('settings-step').classList.contains('hidden');
  if (!settingsOpen && permStream) {
    permStream.getTracks().forEach(t => t.stop());
    permStream = null;
  }
}

// ===== Handler =====
function handle(msg) {
  switch (msg.type) {
    case 'connected':
      userId = msg.userId;
      if (partnerId) {
        sysMsg('Connection lost. Tap Next to find someone new.');
        cleanupPC();
        $('status-text').textContent = 'Connection lost - tap Next';
        $('chat-input').disabled = true;
        $('send-btn').disabled = true;
        return;
      }
      if (!$('chat').classList.contains('hidden') && permGranted && findTimer) {
        findPartner();
        return;
      }
      show('landing');
      const p = getProfile();
      if (!p) {
        openModal('profile');
      } else if (!permGranted) {
        openModal('perm');
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
      const partnerName = msg.partnerName || 'a stranger';
      const partnerGender = msg.partnerGender || '';
      const label = partnerGender ? `${partnerName} (${partnerGender})` : partnerName;
      // Show match animation
      const overlay = $('match-overlay');
      if (overlay) {
        overlay.querySelector('.match-name').textContent = label;
        overlay.classList.remove('hidden');
        setTimeout(() => {
          overlay.classList.add('hidden');
          $('status-text').textContent = 'Connecting...';
          $('chat-input').disabled = false;
          $('send-btn').disabled = false;
          sysMsg('Connected with ' + label);
          startPeerConnection();
        }, 800);
      } else {
        $('status-text').textContent = 'Connecting...';
        $('chat-input').disabled = false;
        $('send-btn').disabled = false;
        sysMsg('Connected with ' + label);
        startPeerConnection();
      }
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
      if (el) {
        const count = msg.count;
        el.textContent = `\u25CF ${count} online now`;
        el.style.color = count > 0 ? 'var(--success)' : 'var(--text-secondary)';
      }
      const lc = $('live-count');
      if (lc) lc.textContent = msg.count || 0;
      break;
  }
}

// ===== Media =====
function getAudioConstraints() {
  const enabled = localStorage.getItem('ob_noise') !== '0';
  return enabled ? { noiseSuppression: true, echoCancellation: true } : true;
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
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: getAudioConstraints() });
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
    startCallTimer();
    startQualityMonitor();
    playSound('connect');
    try { if (navigator.vibrate) navigator.vibrate([100, 50, 100]); } catch (_) {}
  };
  pc.oniceconnectionstatechange = () => {
    const q = $('quality-indicator');
    if (pc.iceConnectionState === 'failed') {
      sysMsg('Connection failed. Tap Next.');
      playSound('error');
      if (q) { q.textContent = '!'; q.style.color = 'var(--danger)'; }
    } else if (pc.iceConnectionState === 'disconnected') {
      if (q) { q.textContent = '!'; q.style.color = 'var(--danger)'; }
    }
  };
}

function startQualityMonitor() {
  if (statsTimer) clearInterval(statsTimer);
  statsTimer = setInterval(async () => {
    if (!pc) return;
    try {
      const stats = await pc.getStats();
      const q = $('quality-indicator');
      if (!q) return;
      let quality = 'good';
      for (const report of stats.values()) {
        if (report.type === 'candidate-pair' && report.state === 'succeeded') {
          if (report.currentRoundTripTime > 0.3) quality = 'poor';
          else if (report.currentRoundTripTime > 0.1) quality = 'fair';
          else quality = 'good';
          break;
        }
        if (report.type === 'inbound-rtp' && report.kind === 'video') {
          if (report.framesPerSecond < 10) quality = 'poor';
          else if (report.framesPerSecond < 20) quality = 'fair';
        }
      }
      const labels = { good: 'Excellent', fair: 'Good', poor: 'Poor' };
      const colors = { good: 'var(--success)', fair: 'var(--warning)', poor: 'var(--danger)' };
      q.textContent = labels[quality];
      q.style.color = colors[quality];
    } catch (_) {}
  }, 5000);
}

function stopQualityMonitor() {
  if (statsTimer) { clearInterval(statsTimer); statsTimer = null; }
  const q = $('quality-indicator');
  if (q) q.textContent = '';
}

function startCallTimer() {
  callStartTime = Date.now();
  const el = $('call-timer');
  if (el) {
    updateCallTimer();
    if (callTimerInterval) clearInterval(callTimerInterval);
    callTimerInterval = setInterval(updateCallTimer, 1000);
  }
}

function updateCallTimer() {
  const el = $('call-timer');
  if (!el || !callStartTime) return;
  const sec = Math.floor((Date.now() - callStartTime) / 1000);
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  el.textContent = m + ':' + String(s).padStart(2, '0');
}

function stopCallTimer() {
  if (callTimerInterval) { clearInterval(callTimerInterval); callTimerInterval = null; }
  const el = $('call-timer');
  if (el) el.textContent = '';
  callStartTime = null;
}

function cleanupPC() {
  if (pc) { pc.close(); pc = null; }
  $('partner-video').srcObject = null;
  $('placeholder').classList.remove('hidden');
  $('enc-badge').classList.add('hidden');
  $('status-text').textContent = 'Disconnected';
  setStatus('disconnected');
  stopQualityMonitor();
  stopCallTimer();
  playSound('disconnect');
  partnerId = null;
}

// ===== Navbar scroll =====
let navScrolled = false;
const landingEl = $('landing');
if (landingEl) {
  landingEl.addEventListener('scroll', () => {
    const nav = $('navbar');
    if (!nav) return;
    const shouldScroll = landingEl.scrollTop > 50;
    if (shouldScroll !== navScrolled) {
      navScrolled = shouldScroll;
      nav.classList.toggle('scrolled', shouldScroll);
    }
  }, { passive: true });
}

// ===== Events =====
let permStream = null;

// Modal backdrop close
$('modal-overlay').addEventListener('click', e => {
  if (e.target === $('modal-overlay')) closeModal();
});

// Start button (navbar & hero)
function startButtonHandler() {
  const p = getProfile();
  if (p && permGranted) {
    doStartSearch();
  } else if (!p) {
    openModal('profile');
  } else {
    openModal('perm');
  }
}

async function doStartSearch() {
  try {
    await startLocalStream();
  } catch (e) {
    const errEl = $('start-error');
    if (errEl) { errEl.textContent = '\u26A0 ' + e.message; errEl.classList.remove('hidden'); }
    return;
  }
  clearMsgs();
  resetButtons();
  closeModal();
  findPartner();
  show('chat');
  $('enc-badge').classList.add('hidden');
}

document.querySelectorAll('#start-btn, #hero-cta').forEach(btn => {
  btn.addEventListener('click', startButtonHandler);
});

// Profile submit
$('profile-submit').addEventListener('click', () => {
  const name = $('profile-name').value.trim();
  const age = $('profile-age').value.trim();
  const gender = $('profile-gender').value;
  const is18 = $('profile-18').checked;
  const err = $('profile-error');
  err.classList.add('hidden');
  if (!name) { err.textContent = 'Please enter your name'; err.classList.remove('hidden'); return; }
  if (!age || isNaN(age) || parseInt(age) < 13 || parseInt(age) > 120) { err.textContent = 'Please enter a valid age'; err.classList.remove('hidden'); return; }
  if (!is18) { err.textContent = 'You must be 18 or older to use this app'; err.classList.remove('hidden'); return; }
  setProfile({ name, age: parseInt(age), gender });
  if (permGranted) {
    showPreviewStep();
  } else {
    openModal('perm');
  }
});

function showPreviewStep() {
  openModal('preview');
  const p = getProfile();
  if (p) {
    $('preview-name').textContent = p.name;
    $('preview-age').textContent = p.age;
    $('preview-gender').textContent = p.gender;
  }
  // Start camera preview
  if (!permStream) {
    (async () => {
      try {
        permStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        $('preview-video').srcObject = permStream;
      } catch (_) {}
    })();
  }
}

// Permission button
$('perm-btn').addEventListener('click', async () => {
  $('perm-error').classList.add('hidden');
  $('perm-btn').textContent = 'Requesting...';
  $('perm-btn').disabled = true;
  try {
    if (permStream) permStream.getTracks().forEach(t => t.stop());
    try {
      permStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: getAudioConstraints() });
    } catch (_) {
      permStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    }
    localStorage.setItem('ob_perm', '1');
    permGranted = true;
    const hasAudio = permStream.getAudioTracks().length > 0;
    $('perm-btn').textContent = hasAudio ? '\u2705 Access Granted' : '\u2705 Camera Access Granted (no mic)';
    setTimeout(showPreviewStep, 600);
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

// Preview start
$('preview-start').addEventListener('click', async () => {
  $('preview-start').textContent = 'Searching...';
  $('preview-start').disabled = true;
  // Stop perm preview
  if (permStream) {
    permStream.getTracks().forEach(t => t.stop());
    permStream = null;
  }
  await doStartSearch();
  $('preview-start').textContent = 'Start Searching';
  $('preview-start').disabled = false;
});

// Cancel find
$('btn-cancel-find').addEventListener('click', () => {
  cleanupPC();
  safeSend({ type: 'stop' });
  stopLocalStream();
  show('landing');
  $('btn-cancel-find').textContent = 'Cancel';
  $('chat-input').disabled = true;
  $('send-btn').disabled = true;
  resetButtons();
});

$('btn-next').addEventListener('click', () => {
  cleanupPC();
  safeSend({ type: 'next' });
  $('status-text').textContent = 'Finding new partner...';
  startFindTimer();
  startSearchMessages();
});

$('btn-stop').addEventListener('click', () => {
  cleanupPC();
  safeSend({ type: 'stop' });
  stopLocalStream();
  show('landing');
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

// Double-tap self video to flip camera
let lastTapTime = 0;
$('self-box').addEventListener('click', () => {
  const now = Date.now();
  if (now - lastTapTime < 400) {
    // Double tap - flip camera
    flipCamera();
    lastTapTime = 0;
  } else {
    lastTapTime = now;
  }
});

async function flipCamera() {
  if (!localStream) return;
  const curTrack = localStream.getVideoTracks()[0];
  if (!curTrack) return;
  const facing = curTrack.getSettings().facingMode;
  const newFacing = facing === 'user' ? 'environment' : 'user';
  try {
    const newStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: newFacing }, audio: false });
    const newTrack = newStream.getVideoTracks()[0];
    if (pc) {
      const sender = pc.getSenders().find(s => s.track?.kind === 'video');
      if (sender) await sender.replaceTrack(newTrack);
    }
    localStream.removeTrack(curTrack);
    curTrack.stop();
    localStream.addTrack(newTrack);
    $('self-video').srcObject = localStream;
    $('preview-video').srcObject = localStream;
    // Update perm preview too
    if (permStream) {
      permStream.getTracks().forEach(t => t.stop());
      permStream = newStream;
    }
  } catch (_) {}
}

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
    $('report-status').style.color = '#22C55E';
    $('report-status').classList.remove('hidden');
    setTimeout(() => {
      $('report-overlay').classList.add('hidden');
      $('report-status').classList.add('hidden');
      $('report-status').style.color = '';
    }, 1500);
  });
});

$('btn-chat').addEventListener('click', openPanel);
$('btn-settings').addEventListener('click', () => openModal('settings'));
$('btn-share').addEventListener('click', () => {
  const url = window.location.href;
  if (navigator.share) {
    navigator.share({ title: 'Ochena Bondhu', url }).catch(() => {});
  } else {
    navigator.clipboard.writeText(url).then(() => {
      sysMsg('Link copied to clipboard');
    }).catch(() => {});
  }
});
$('close-panel').addEventListener('click', () => $('panel').classList.remove('open'));
$('settings-close').addEventListener('click', closeModal);
$('noise-toggle').addEventListener('change', () => {
  localStorage.setItem('ob_noise', $('noise-toggle').checked ? '1' : '0');
});
$('dark-toggle').addEventListener('change', () => {
  setTheme(!$('dark-toggle').checked);
});
// Load noise setting
const noiseVal = localStorage.getItem('ob_noise');
if (noiseVal === '0') $('noise-toggle').checked = false;
$('panel').addEventListener('click', e => { if (e.target === $('panel')) $('panel').classList.remove('open'); });
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    $('panel').classList.remove('open');
    $('report-overlay').classList.add('hidden');
    $('report-status').classList.add('hidden');
  }
});

// Keyboard shortcuts (only when no input focused)
document.addEventListener('keydown', e => {
  const tag = e.target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
  if (e.repeat) return;
  if ($('chat').classList.contains('hidden')) return;
  switch (e.key.toLowerCase()) {
    case 'n':
      e.preventDefault();
      if (!$('btn-next').disabled) $('btn-next').click();
      break;
    case 'm':
      e.preventDefault();
      $('btn-mic').click();
      break;
    case 'c':
      e.preventDefault();
      $('btn-cam').click();
      break;
  }
});

$('chat-input').addEventListener('keydown', e => {
  if (e.key === 'Enter') sendMsg();
});
$('send-btn').addEventListener('click', sendMsg);

function sendMsg() {
  const text = $('chat-input').value.trim();
  if (!text || !partnerId) return;
  const now = Date.now();
  if (now - lastMsgTime < 1000) return;
  lastMsgTime = now;
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

// Step cards scroll animation
const observer = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      entry.target.classList.add('visible');
      observer.unobserve(entry.target);
    }
  });
}, { threshold: 0.15 });
document.querySelectorAll('.step').forEach(el => observer.observe(el));

// Theme toggle
function setTheme(light) {
  document.documentElement.classList.toggle('light', light);
  localStorage.setItem('ob_theme', light ? 'light' : 'dark');
  const sun = document.querySelector('.theme-toggle .sun');
  const moon = document.querySelector('.theme-toggle .moon');
  if (sun && moon) {
    sun.classList.toggle('hidden', light);
    moon.classList.toggle('hidden', !light);
  }
  const dt = $('dark-toggle');
  if (dt) dt.checked = !light;
}
// Load saved theme
const savedTheme = localStorage.getItem('ob_theme');
if (savedTheme === 'light') setTheme(true);
else setTheme(false);
// Toggle button
$('theme-btn').addEventListener('click', () => {
  setTheme(!document.documentElement.classList.contains('light'));
});
