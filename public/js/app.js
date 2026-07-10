const CONFIG = {
  wsUrl: `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`,
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' }
  ]
};

let ws, localStream, pc;
let remoteStream = null;
let userId, partnerId, isInitiator;
let pendingCandidates = [];
let pendingIceBeforePC = [];
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
let currentStatus = '';

let currentLocale = 'bn';
function onLangChange() {
  currentLocale = I18n.locale;
  if (findTimer) {
    startSearchMessages();
    const st = $('status-text');
    if (st) { /* will be reset by setStatus etc. */ }
  }
}

const $ = id => document.getElementById(id);

// ===== Toast Notifications =====
function toast(msg, type = 'info', duration = 3500) {
  const container = $('toast-container');
  if (!container) return;
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  const icons = {
    info: '<svg class="toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>',
    success: '<svg class="toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>',
    error: '<svg class="toast-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>'
  };
  el.innerHTML = icons[type] || icons.info;
  el.insertAdjacentHTML('beforeend', '<span>' + msg + '</span>');
  container.appendChild(el);
  setTimeout(() => { if (el.parentNode) el.remove(); }, duration);
}

// ===== Sound Toggle =====
let soundEnabled = localStorage.getItem('ob_sound') !== '0';
function isSoundEnabled() { return soundEnabled; }
function toggleSound() {
  soundEnabled = !soundEnabled;
  localStorage.setItem('ob_sound', soundEnabled ? '1' : '0');
  const btn = $('sound-toggle');
  if (btn) btn.checked = soundEnabled;
}

function showReconnectBanner(text) {
  const banner = $('reconnect-banner');
  if (!banner) return;
  banner.textContent = text;
  banner.classList.add('show');
}
function hideReconnectBanner() {
  const banner = $('reconnect-banner');
  if (banner) banner.classList.remove('show');
}

function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  ws = new WebSocket(CONFIG.wsUrl);
  connecting = true;
  const connMsg = $('conn-msg');
  if (connMsg) connMsg.textContent = __('overlay.connecting');
  connTimeout = setTimeout(() => {
    if (connecting) {
      const s = $('conn-msg');
      if (s) {
        s.innerHTML = __('overlay.timeout');
        s.onclick = (e) => {
          if (e.target.id === 'conn-retry') { e.preventDefault(); ws.close(); connect(); }
        };
      }
    }
  }, 10000);
  ws.onopen = () => {
    connecting = false;
    hideReconnectBanner();
    if (connTimeout) { clearTimeout(connTimeout); connTimeout = null; }
  };
  ws.onmessage = e => {
    try {
      const data = JSON.parse(e.data);
      if (data && typeof data.type === 'string') handle(data);
    } catch (_) { /* ignore malformed messages */ }
  };
  ws.onclose = (e) => {
    connecting = false;
    if (connTimeout) { clearTimeout(connTimeout); connTimeout = null; }
    if (document.visibilityState !== 'hidden') {
      if (e.code !== 1000) {
        const msg = e.code === 1006 ? __('overlay.server_unreachable') : __('overlay.disconnected_reconnect');
        const m = $('conn-msg');
        if (m) m.textContent = msg;
        showReconnectBanner(msg);
      }
      reconnectTimer = setTimeout(connect, 3000);
    }
  };
  ws.onerror = () => {
    const m = $('conn-msg');
    if (m) m.textContent = __('overlay.conn_error');
  };
}

function safeSend(data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify(data));
      return true;
    } catch (_) { return false; }
  }
  return false;
}

function findPartner() {
  const p = getProfile();
  if (!safeSend({ type: 'find', profile: p || {} })) {
    sysMsg(__('sys.conn_lost_reconnect'));
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
  currentStatus = state;
  const dot = $('status-dot');
  const label = $('status-label');
  dot.className = '';
  if (state === 'searching') {
    dot.classList.add('dot-yellow');
    label.textContent = __('status.searching');
  } else if (state === 'connected') {
    dot.classList.add('dot-green');
    label.textContent = __('status.connected');
  } else if (state === 'disconnected') {
    dot.classList.add('dot-red');
    label.textContent = __('status.disconnected');
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

function getSearchMessages() {
  return [__('search.msg1'), __('search.msg2'), __('search.msg3'), __('search.msg4')];
}

function startSearchMessages() {
  searchMsgIndex = 0;
  $('status-text').textContent = __('search.msg1');
  if (searchMsgTimer) clearInterval(searchMsgTimer);
  searchMsgTimer = setInterval(() => {
    const msgs = getSearchMessages();
    searchMsgIndex = (searchMsgIndex + 1) % msgs.length;
    $('status-text').textContent = msgs[searchMsgIndex];
  }, 3000);
}

function showEmptyState() {
  $('status-text').innerHTML = __('status.empty_title');
  $('btn-cancel-find').textContent = __('status.try_again');
}

// Reusable AudioContext — created once on first user gesture
let audioCtx = null;
function getAudioCtx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}

// Mic audio level meter
let micAnalyser = null;
let micMeterInterval = null;
function startMicMeter(stream) {
  stopMicMeter();
  const audioTrack = stream.getAudioTracks()[0];
  if (!audioTrack) return;
  try {
    const ctx = getAudioCtx();
    const source = ctx.createMediaStreamSource(stream);
    micAnalyser = ctx.createAnalyser();
    micAnalyser.fftSize = 256;
    source.connect(micAnalyser);
    const meterEl = $('mic-meter');
    if (!meterEl) return;
    micMeterInterval = setInterval(() => {
      if (!micAnalyser) return;
      const data = new Uint8Array(micAnalyser.frequencyBinCount);
      micAnalyser.getByteFrequencyData(data);
      const avg = data.reduce((a, b) => a + b, 0) / data.length;
      const pct = Math.min(avg / 128, 1);
      meterEl.style.setProperty('--level', pct);
      meterEl.classList.toggle('active', pct > 0.05);
    }, 100);
  } catch (_) {}
}
function stopMicMeter() {
  if (micMeterInterval) { clearInterval(micMeterInterval); micMeterInterval = null; }
  micAnalyser = null;
  const meterEl = $('mic-meter');
  if (meterEl) { meterEl.style.setProperty('--level', '0'); meterEl.classList.remove('active'); }
}

// Sound effects — shares the reused AudioContext
function playSound(type) {
  if (!isSoundEnabled()) return;
  try {
    const ctx = getAudioCtx();
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

  const current = document.querySelector('.screen-fade.visible');
  if (!current || current.id === targetId) {
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

  // Fade out current
  current.classList.remove('visible');
  current.classList.add('fade-out');

  // Hide nav/footer immediately when going to chat
  if (targetId === 'chat') {
    if (landing) landing.classList.add('hidden');
    if (nav) nav.classList.add('hidden');
    if (footer) footer.classList.add('hidden');
    setStatus('searching');
    startFindTimer();
    startSearchMessages();
  } else {
    stopFindTimer();
  }

  setTimeout(() => {
    current.classList.add('hidden');
    current.classList.remove('fade-out');
    const target = $(targetId);
    if (target) {
      target.classList.remove('hidden');
      target.classList.add('fade-in');
      requestAnimationFrame(() => {
        target.classList.remove('fade-in');
        target.classList.add('visible');
      });
    }
    transitioning = false;
  }, 250);
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
  // Auto-focus first input in the modal
  requestAnimationFrame(() => {
    const active = document.querySelector('#modal-overlay > .modal:not(.hidden)');
    if (active) {
      const input = active.querySelector('input:not([type="checkbox"]):not([type="hidden"]), select, textarea');
      if (input) setTimeout(() => input.focus(), 100);
    }
  });
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
        sysMsg(__('sys.conn_lost_next'));
        cleanupPC();
        $('status-text').textContent = __('status.conn_lost_tap');
        $('chat-input').disabled = true;
        $('send-btn').disabled = true;
        return;
      }
      if (!$('chat').classList.contains('hidden') && permGranted && findTimer) {
        findPartner();
        return;
      }
      const wasConnecting = !$('connecting').classList.contains('hidden');
      show('landing');
      const p = getProfile();
      const doModal = () => {
        if (!p) openModal('profile');
        else if (!permGranted) openModal('perm');
      };
      if (wasConnecting) setTimeout(doModal, 250);
      else doModal();
      break;
    case 'waiting':
      $('status-text').textContent = __('status.waiting');
      if (noOneTimer) clearTimeout(noOneTimer);
      break;
    case 'matched':
      partnerId = msg.partnerId;
      isInitiator = msg.initiator;
      show('chat');
      stopFindTimer();
      const partnerName = msg.partnerName || __('sys.a_stranger');
      const partnerGender = msg.partnerGender || '';
      const label = partnerGender ? `${partnerName} (${partnerGender})` : partnerName;
      // Show match animation
      const overlay = $('match-overlay');
      if (overlay) {
        overlay.querySelector('.match-name').textContent = label;
        overlay.classList.remove('hidden');
        setTimeout(() => {
          overlay.classList.add('hidden');
          $('status-text').textContent = __('status.connecting_ellipsis');
          $('chat-input').disabled = false;
          $('send-btn').disabled = false;
          sysMsg(__('sys.connected_with', { label }));
          startPeerConnection();
        }, 800);
      } else {
        $('status-text').textContent = __('status.connecting_ellipsis');
        $('chat-input').disabled = false;
        $('send-btn').disabled = false;
        sysMsg(__('sys.connected_with', { label }));
        startPeerConnection();
      }
      break;
    case 'offer':
      if (!pc) createPC(false);
      if (!pc) break;
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
      if (msg.candidate) {
        if (pc) {
          if (pc.remoteDescription) {
            pc.addIceCandidate(new RTCIceCandidate(msg.candidate)).catch(() => {});
          } else {
            pendingCandidates.push(msg.candidate);
          }
        } else {
          pendingIceBeforePC.push(msg.candidate);
        }
      }
      break;
    case 'chat':
      addMsg(msg.text, 'other');
      playSound('message');
      if (!$('panel').classList.contains('open')) {
        unread++;
        updateBadge();
        if (unread <= 3) toast(msg.text, 'info', 3000);
      }
      break;
    case 'partner-left':
      sysMsg(__('sys.partner_disconnected'));
      cleanupPC();
      playSound('disconnect');
      $('status-text').textContent = __('status.partner_left');
      $('chat-input').disabled = true;
      $('send-btn').disabled = true;
      $('btn-next').classList.add('urgent');
      break;
    case 'disconnected':
      cleanupPC();
      break;
    case 'online-count':
      const el = $('online-count');
      if (el) {
        const count = msg.count;
        el.textContent = __('online.now', { count });
        el.style.color = count > 0 ? 'var(--success)' : 'var(--text-muted)';
      }
      const lc = $('live-count');
      if (lc) lc.textContent = msg.count || 0;
      const co = $('cta-online');
      if (co) {
        const c = msg.count || 0;
        co.textContent = __('online.people', { count: c });
      }
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
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const hasMic = devices.some(d => d.kind === 'audioinput');
      if (!hasMic) {
        localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        sysMsg(__('sys.no_mic_video'));
        return localStream;
      }
    } catch (_) {}
  }
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: getAudioConstraints() });
    return localStream;
  } catch (e) {
    if (e.name === 'NotAllowedError') throw new Error(__('sys.camera_settings'));
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    sysMsg(__('sys.mic_unavailable'));
    return localStream;
  }
}

async function startPeerConnection() {
  try {
    if (!localStream) localStream = await startLocalStream();
  } catch (e) {
    $('status-text').textContent = __('status.camera_error');
    sysMsg(e.message);
    playSound('error');
    return;
  }
  $('self-video').srcObject = localStream;
  startMicMeter(localStream);
  $('placeholder').classList.remove('hidden');
  if (!pc) createPC(isInitiator);
  if (!pc) return;
  if (isInitiator && !pc.localDescription) {
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      safeSend({ type: 'offer', sdp: pc.localDescription });
    } catch (e) { sysMsg(__('status.conn_error_tap')); }
  }
  // Resume video/audio on first user click (autoplay policy workaround)
  document.addEventListener('click', function resumeAudio() {
    const pv = $('partner-video');
    if (pv && pv.paused) pv.play().catch(() => {});
    document.removeEventListener('click', resumeAudio);
  }, { once: true });
}

function createPC() {
  if (pc) pc.close();
  remoteStream = null;
  if (!localStream) { sysMsg(__('status.no_camera')); return; }
  // Flush any ICE candidates that arrived before pc existed
  while (pendingIceBeforePC.length) {
    pendingCandidates.push(pendingIceBeforePC.shift());
  }
  pc = new RTCPeerConnection({ iceServers: CONFIG.iceServers });
  localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
  if (!localStream.getAudioTracks().length) pc.addTransceiver('audio', { direction: 'recvonly' });
  if (!localStream.getVideoTracks().length) pc.addTransceiver('video', { direction: 'recvonly' });
  pc.onicecandidate = e => { if (e.candidate) safeSend({ type: 'ice-candidate', candidate: e.candidate }); };
  pc.ontrack = e => {
    if (e.track) {
      if (!remoteStream) remoteStream = new MediaStream();
      if (!remoteStream.getTrackById(e.track.id)) {
        remoteStream.addTrack(e.track);
      }
      $('partner-video').srcObject = remoteStream;
      $('partner-video').play().catch(() => {});
    }
    $('placeholder').classList.add('hidden');
    $('enc-badge').classList.remove('hidden');
    $('status-text').textContent = __('status.connected');
    setStatus('connected');
    startCallTimer();
    startQualityMonitor();
    playSound('connect');
    try { if (navigator.vibrate) navigator.vibrate([100, 50, 100]); } catch (_) {}
  };
  pc.oniceconnectionstatechange = () => {
    const q = $('quality-indicator');
    if (pc.iceConnectionState === 'failed') {
      sysMsg(__('status.conn_failed'));
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
      const labels = { good: __('quality.excellent'), fair: __('quality.good'), poor: __('quality.poor') };
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
  remoteStream = null;
  pendingIceBeforePC = [];
  $('placeholder').classList.remove('hidden');
  $('enc-badge').classList.add('hidden');
  $('status-text').textContent = __('status.disconnected');
  setStatus('disconnected');
  stopQualityMonitor();
  stopCallTimer();
  playSound('disconnect');
  partnerId = null;
}

// ===== Navbar scroll (debounced) =====
let navScrolled = false;
let scrollRaf = null;
window.addEventListener('scroll', () => {
  if (scrollRaf) return;
  scrollRaf = requestAnimationFrame(() => {
    scrollRaf = null;
    const nav = $('navbar');
    if (!nav) return;
    const shouldScroll = window.scrollY > 50;
    if (shouldScroll !== navScrolled) {
      navScrolled = shouldScroll;
      nav.classList.toggle('scrolled', shouldScroll);
    }
  });
}, { passive: true });

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
    if (errEl) { errEl.textContent = __('errors.prefix') + e.message; errEl.classList.remove('hidden'); }
    return;
  }
  clearMsgs();
  resetButtons();
  closeModal();
  findPartner();
  show('chat');
  $('enc-badge').classList.add('hidden');
}

document.querySelectorAll('#start-btn, #hero-cta, #hero-cta-2').forEach(btn => {
  btn.addEventListener('click', startButtonHandler);
});

function submitProfile() {
  const name = $('profile-name').value.trim();
  const age = $('profile-age').value.trim();
  const gender = $('profile-gender').value;
  const is18 = $('profile-18').checked;
  const err = $('profile-error');
  err.classList.add('hidden');
  if (!name) { err.textContent = __('validation.name_required'); err.classList.remove('hidden'); return; }
  if (!age || isNaN(age) || parseInt(age) < 13 || parseInt(age) > 120) { err.textContent = __('validation.valid_age'); err.classList.remove('hidden'); return; }
  if (!is18) { err.textContent = __('validation.age_consent'); err.classList.remove('hidden'); return; }
  setProfile({ name, age: parseInt(age), gender });
  if (permGranted) {
    showPreviewStep();
  } else {
    openModal('perm');
  }
}
$('profile-submit').addEventListener('click', submitProfile);
// Enter key submits profile form
document.querySelectorAll('#profile-name, #profile-age, #profile-gender').forEach(el => {
  el.addEventListener('keydown', e => { if (e.key === 'Enter') submitProfile(); });
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
  $('perm-btn').textContent = __('perm.requesting');
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
    $('perm-btn').textContent = hasAudio ? __('perm.granted') : __('perm.granted_no_mic');
    setTimeout(showPreviewStep, 600);
  } catch (e) {
    const errEl = $('perm-error');
    if (e.name === 'NotAllowedError') {
      errEl.textContent = __('perm.blocked');
    } else if (e.name === 'NotFoundError') {
      errEl.textContent = __('perm.not_found');
    } else {
      errEl.textContent = __('perm.failed', { msg: e.message });
    }
    errEl.classList.remove('hidden');
    $('perm-btn').textContent = __('perm.try_again');
    $('perm-btn').disabled = false;
  }
});

// Preview start
$('preview-start').addEventListener('click', async () => {
  $('preview-start').textContent = __('search.btn_searching');
  $('preview-start').disabled = true;
  // Stop perm preview
  if (permStream) {
    permStream.getTracks().forEach(t => t.stop());
    permStream = null;
  }
  await doStartSearch();
  $('preview-start').textContent = __('search.btn_start');
  $('preview-start').disabled = false;
});

// Cancel find
$('btn-cancel-find').addEventListener('click', () => {
  cleanupPC();
  safeSend({ type: 'stop' });
  stopLocalStream();
  show('landing');
  $('btn-cancel-find').textContent = __('chat.cancel');
  $('chat-input').disabled = true;
  $('send-btn').disabled = true;
  resetButtons();
});

$('btn-next').addEventListener('click', () => {
  cleanupPC();
  safeSend({ type: 'next' });
  $('status-text').textContent = __('status.finding_new');
  startFindTimer();
  startSearchMessages();
  $('btn-next').classList.remove('urgent');
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
    $('report-status').textContent = __('sys.report_submitted');
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
    navigator.share({ title: __('sys.share_title'), url }).catch(() => {});
  } else {
    navigator.clipboard.writeText(url).then(() => {
      sysMsg(__('sys.link_copied'));
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
// Sound toggle
if ($('sound-toggle')) {
  $('sound-toggle').checked = soundEnabled;
  $('sound-toggle').addEventListener('change', toggleSound);
}
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
  const now = new Date();
  const time = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
  d.innerHTML = '<span class="msg-text">' + escapeHtml(text) + '</span><span class="msg-time">' + time + '</span>';
  $('messages').appendChild(d);
  $('messages').scrollTop = $('messages').scrollHeight;
}

function escapeHtml(s) {
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
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

// Initialize language
I18n.init().then(() => {
  currentLocale = I18n.locale;
  document.querySelectorAll('.lang-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.lang === I18n.locale);
  });
  connect();
});
window.__onLangChange = (locale) => {
  currentLocale = locale;
  setStatus(currentStatus || 'disconnected');
  if (currentStatus === 'searching') {
    if (searchMsgTimer) { clearInterval(searchMsgTimer); searchMsgTimer = null; }
    startSearchMessages();
  }
};

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
