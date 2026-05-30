/**
 * Football Watch Party — Client (Mesh P2P + VPS TURN)
 */

const $ = s => document.querySelector(s);
const lobbySection = $('#lobby-section'), roomSection = $('#room-section');
const nicknameInput = $('#nickname-input'), roomIdInput = $('#room-id-input'), lobbyError = $('#lobby-error');
const btnCreate = $('#btn-create'), btnJoin = $('#btn-join'), btnLeave = $('#btn-leave');
const btnMic = $('#btn-mic'), btnScreenShare = $('#btn-screen-share'), btnFullscreen = $('#btn-fullscreen'), btnMembers = $('#btn-members');
const roomIdDisplay = $('#room-id-display'), memberCount = $('#member-count'), memberList = $('#member-list'), memberPanel = $('#member-panel');
const screenVideo = $('#screen-video'), noScreenMsg = $('#no-screen-msg');
const localPreview = $('#local-preview'), localPreviewVideo = $('#local-preview-video');
const audioContainer = $('#audio-container'), toastContainer = $('#toast-container');

const state = {
  socket: null, nickname: '', roomId: '', socketId: '', isHost: false, roomHost: '',
  localAudioStream: null, localScreenStream: null,
  peerConnections: new Map(), remotePeers: new Map(),
  micEnabled: true, screenSharing: false, justJoined: false,
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
  reconnectAttempts: new Map(), MAX_RECONNECT: 3
};
const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || window.innerWidth < 768;

async function init() {
  try {
    const r = await fetch('/api/config'); const cfg = await r.json();
    if (cfg.iceServers?.length) state.iceServers = cfg.iceServers;
    console.log('[CONFIG] ICE servers:', state.iceServers.map(s => s.urls).join(', '));
  } catch (e) { console.warn('[CONFIG] Using default ICE'); }
  const saved = localStorage.getItem('football-watch-nickname');
  if (saved) nicknameInput.value = saved;
}

// ========== Events ==========
btnCreate.addEventListener('click', handleCreateRoom);
btnJoin.addEventListener('click', handleJoinRoom);
btnLeave.addEventListener('click', leaveRoom);
btnMic.addEventListener('click', toggleMic);
btnScreenShare.addEventListener('click', toggleScreenShare);
btnFullscreen.addEventListener('click', toggleFullscreen);
btnMembers.addEventListener('click', () => memberPanel.classList.toggle('hidden'));
nicknameInput.addEventListener('keydown', e => { if (e.key === 'Enter') roomIdInput.focus(); });
roomIdInput.addEventListener('keydown', e => { if (e.key === 'Enter') roomIdInput.value.trim() ? handleJoinRoom() : handleCreateRoom(); });
window.addEventListener('beforeunload', cleanupAll);
document.addEventListener('click', e => {
  if (!memberPanel.classList.contains('hidden') && !e.target.closest('#member-panel') && !e.target.closest('#btn-members'))
    memberPanel.classList.add('hidden');
});

// ========== Room ==========
function genRoomId() { return Math.random().toString(36).substring(2, 8); }
function showError(m) { lobbyError.textContent = m; lobbyError.classList.remove('hidden'); }
function hideError() { lobbyError.textContent = ''; lobbyError.classList.add('hidden'); }

function validate(needRoom) {
  hideError();
  const n = nicknameInput.value.trim();
  if (!n) { showError('Please enter your name.'); return null; }
  if (needRoom) { const r = roomIdInput.value.trim(); if (!r) { showError('Please enter Room ID.'); return null; } return { nickname: n, roomId: r.toLowerCase() }; }
  return { nickname: n, roomId: roomIdInput.value.trim() || genRoomId() };
}

async function handleCreateRoom() {
  const inp = validate(false); if (!inp) return;
  state.nickname = inp.nickname; state.roomId = inp.roomId; state.justJoined = true;
  localStorage.setItem('football-watch-nickname', state.nickname);
  await connectSocket();
  state.socket.emit('create-room', { roomId: state.roomId, nickname: state.nickname });
}

async function handleJoinRoom() {
  const inp = validate(true); if (!inp) return;
  state.nickname = inp.nickname; state.roomId = inp.roomId; state.justJoined = true;
  localStorage.setItem('football-watch-nickname', state.nickname);
  await connectSocket();
  state.socket.emit('join-room', { roomId: state.roomId, nickname: state.nickname });
}

function connectSocket() {
  return new Promise(resolve => {
    if (state.socket?.connected) { resolve(); return; }
    state.socket = io({ transports: ['websocket', 'polling'], reconnection: true, reconnectionAttempts: 10, reconnectionDelay: 1000 });
    state.socket.on('connect', () => { state.socketId = state.socket.id; console.log('[SOCKET]', state.socketId); resolve(); });
    state.socket.on('connect_error', err => { console.error('[SOCKET]', err); showError('Connection failed.'); });
    bindSocketEvents();
  });
}

function bindSocketEvents() {
  const s = state.socket;

  s.on('room-created', ({ roomId, members, host }) => {
    state.isHost = true; state.roomHost = host; state.roomId = roomId;
    showRoomUI(); updateMemberList(members, host);
    showToast('Room created!'); startLocalAudio(); state.justJoined = false;
  });

  s.on('room-joined', ({ roomId, members, host }) => {
    state.roomHost = host; state.roomId = roomId;
    showRoomUI(); updateMemberList(members, host);
    if (state.justJoined) {
      showToast('Joined!'); startLocalAudio(); connectToMembers(members); state.justJoined = false;
    }
  });

  s.on('peer-left', ({ socketId, members, host }) => {
    state.roomHost = host; removePeer(socketId); updateMemberList(members, host);
    showToast(getPeerName(socketId) + ' left');
    if (socketId === host || (state.isHost && host !== state.socketId)) clearScreenVideo();
  });

  s.on('signal-offer', handleSignalOffer);
  s.on('signal-answer', handleSignalAnswer);
  s.on('signal-ice', handleSignalIce);
  s.on('host-screen-stopped', () => { clearScreenVideo(); showToast('Host stopped sharing.'); });
  s.on('audio-state-changed', ({ socketId, enabled }) => {
    const p = state.remotePeers.get(socketId); if (p) p.audioEnabled = enabled;
    refreshMemberList();
  });
  s.on('error-msg', ({ message }) => showError(message));
}

// ========== UI ==========
function showRoomUI() {
  lobbySection.classList.add('hidden'); roomSection.classList.remove('hidden');
  roomIdDisplay.textContent = 'Room: ' + state.roomId;
  state.isHost ? btnScreenShare.classList.remove('hidden') : btnScreenShare.classList.add('hidden');
  hideError(); updateMicButton(); updateScreenShareButton();
}

function showLobbyUI() {
  roomSection.classList.add('hidden'); lobbySection.classList.remove('hidden');
  screenVideo.srcObject = null; screenVideo.classList.remove('has-stream');
  noScreenMsg.classList.remove('hidden'); memberPanel.classList.add('hidden');
  localPreview.classList.add('hidden'); audioContainer.innerHTML = '';
  updateMicButton(); updateScreenShareButton();
}

function updateMemberList(members, host) {
  state.remotePeers.clear(); memberList.innerHTML = '';
  memberCount.textContent = '👤 ' + members.length;

  for (const m of members) {
    if (m.socketId === state.socketId) continue;
    state.remotePeers.set(m.socketId, { nickname: m.nickname, audioEnabled: true });
    const d = document.createElement('div'); d.className = 'member-item'; d.id = 'member-' + m.socketId;
    d.innerHTML = `<span class="member-icon">${m.socketId === host ? '📡' : '👤'}</span>
      <span class="member-name">${escapeHtml(m.nickname)}</span>
      ${m.socketId === host ? '<span class="member-badge-host">HOST</span>' : ''}`;
    memberList.appendChild(d);
  }

  const self = document.createElement('div'); self.className = 'member-item';
  self.innerHTML = `<span class="member-icon">${state.isHost ? '📡' : '👤'}</span>
    <span class="member-name">${escapeHtml(state.nickname)} (You)</span>
    ${state.isHost ? '<span class="member-badge-host">HOST</span>' : ''}
    ${!state.micEnabled ? '<span class="member-muted">🔇</span>' : ''}`;
  memberList.insertBefore(self, memberList.firstChild);
}

function refreshMemberList() {
  for (const [sid, p] of state.remotePeers) {
    const el = document.getElementById('member-' + sid); if (!el) continue;
    let m = el.querySelector('.member-muted');
    if (!p.audioEnabled && !m) { m = document.createElement('span'); m.className = 'member-muted'; m.textContent = '🔇'; el.appendChild(m); }
    else if (p.audioEnabled && m) m.remove();
  }
  const self = memberList.querySelector('.member-item:first-child');
  if (self) { let sm = self.querySelector('.member-muted'); if (!state.micEnabled && !sm) { sm = document.createElement('span'); sm.className = 'member-muted'; sm.textContent = '🔇'; self.appendChild(sm); } else if (state.micEnabled && sm) sm.remove(); }
}

function showToast(msg) {
  const t = document.createElement('div'); t.className = 'toast'; t.textContent = msg;
  toastContainer.appendChild(t); setTimeout(() => t.remove(), 3000);
}

// ========== Audio ==========
async function startLocalAudio() {
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
    state.localAudioStream = s; state.micEnabled = true; updateMicButton();
    addLocalAudioToAllPeers();
  } catch (e) { console.error(e); state.micEnabled = false; updateMicButton(); showToast('⚠️ Mic unavailable.'); }
}

function addLocalAudioToAllPeers() {
  if (!state.localAudioStream) return;
  const t = state.localAudioStream.getAudioTracks()[0]; if (!t) return;
  for (const [, pc] of state.peerConnections) {
    const s = pc.getSenders().find(s => s.track?.kind === 'audio');
    if (s) s.replaceTrack(t).catch(() => {}); else pc.addTrack(t, state.localAudioStream);
  }
}

function toggleMic() {
  state.micEnabled = !state.micEnabled;
  if (state.localAudioStream) state.localAudioStream.getAudioTracks().forEach(t => t.enabled = state.micEnabled);
  updateMicButton(); refreshMemberList();
  if (state.socket && state.roomId) state.socket.emit('toggle-audio', { roomId: state.roomId, enabled: state.micEnabled });
}

function updateMicButton() {
  btnMic.className = state.micEnabled ? 'ctrl-btn mic-on' : 'ctrl-btn mic-off';
  btnMic.querySelector('.ctrl-label').textContent = state.micEnabled ? 'Mic On' : 'Mic Off';
  btnMic.querySelector('.ctrl-icon').textContent = state.micEnabled ? '🎤' : '🔇';
}

// ========== Screen Share ==========
async function toggleScreenShare() { state.screenSharing ? await stopScreenShare() : await startScreenShare(); }

async function startScreenShare() {
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { cursor: 'always', frameRate: { ideal: 60 }, width: { ideal: 2560 }, height: { ideal: 1440 } },
      audio: false
    });
    state.localScreenStream = stream; state.screenSharing = true; updateScreenShareButton();
    const vt = stream.getVideoTracks()[0];

    for (const [sid, pc] of state.peerConnections) {
      const vs = pc.getSenders().find(s => s.track?.kind === 'video');
      if (vs) { await vs.replaceTrack(vt); }
      else { pc.addTrack(vt, stream); await renegotiate(pc, sid); }
    }

    showLocalPreview(stream);
    vt.onended = () => stopScreenShare();
    stream.oninactive = () => stopScreenShare();
    showToast('Screen sharing started!');
  } catch (e) { console.error(e); showToast('Screen share failed.'); }
}

async function renegotiate(pc, peerId) {
  const offer = await pc.createOffer(); await pc.setLocalDescription(offer);
  state.socket.emit('signal-offer', { roomId: state.roomId, toSocketId: peerId, sdp: pc.localDescription });
}

async function stopScreenShare() {
  if (state.localScreenStream) { state.localScreenStream.getTracks().forEach(t => t.stop()); state.localScreenStream = null; }
  state.screenSharing = false; updateScreenShareButton(); hideLocalPreview();
  for (const [sid, pc] of state.peerConnections) {
    const vs = pc.getSenders().find(s => s.track?.kind === 'video');
    if (vs) { pc.removeTrack(vs); await renegotiate(pc, sid); }
  }
  if (state.socket) state.socket.emit('host-screen-stopped', { roomId: state.roomId });
  showToast('Screen sharing stopped.'); clearScreenVideo();
}

function updateScreenShareButton() {
  btnScreenShare.className = state.screenSharing ? 'ctrl-btn sharing-active' : 'ctrl-btn';
  btnScreenShare.querySelector('.ctrl-label').textContent = state.screenSharing ? 'Stop Share' : 'Share Screen';
}

function showLocalPreview(s) { localPreviewVideo.srcObject = s; localPreview.classList.remove('hidden'); localPreview.onclick = toggleFullscreen; }
function hideLocalPreview() { localPreviewVideo.srcObject = null; localPreview.classList.add('hidden'); localPreview.onclick = null; }
function clearScreenVideo() { screenVideo.srcObject = null; screenVideo.classList.remove('has-stream'); noScreenMsg.classList.remove('hidden'); }

// ========== Fullscreen ==========
function toggleFullscreen() {
  const ve = document.getElementById('screen-video');
  const re = document.getElementById('room-section');
  if (document.fullscreenElement || document.webkitFullscreenElement) {
    (document.exitFullscreen || document.webkitExitFullscreen).call(document);
  } else if (ve.srcObject && ve.webkitEnterFullscreen) {
    ve.webkitEnterFullscreen();
  } else if (ve.srcObject && ve.requestFullscreen) {
    ve.requestFullscreen().catch(() => re.requestFullscreen?.().catch(() => {}));
  } else if (re.requestFullscreen) {
    re.requestFullscreen().catch(() => {});
  }
}

// ========== Peer Connections (Mesh) ==========
function connectToMembers(members) {
  for (const m of members) {
    if (m.socketId === state.socketId || state.peerConnections.has(m.socketId)) continue;
    createPeerConnection(m.socketId, true);
  }
}

async function createPeerConnection(peerId, initiator) {
  if (state.peerConnections.has(peerId)) return state.peerConnections.get(peerId);

  const pc = new RTCPeerConnection({ iceServers: state.iceServers });
  state.peerConnections.set(peerId, pc);

  if (state.localAudioStream) {
    const at = state.localAudioStream.getAudioTracks()[0];
    if (at) pc.addTrack(at, state.localAudioStream);
  }

  // Viewer: receive-only video transceiver for screen share
  if (!state.isHost) pc.addTransceiver('video', { direction: 'recvonly' });

  // Host sharing screen: add video track (when initiating)
  if (state.isHost && state.localScreenStream && initiator) {
    const vt = state.localScreenStream.getVideoTracks()[0];
    if (vt && !pc.getSenders().find(s => s.track?.kind === 'video')) pc.addTrack(vt, state.localScreenStream);
  }

  pc.ontrack = (ev) => handleRemoteTrack(peerId, ev);

  pc.onicecandidate = (ev) => {
    if (ev.candidate) state.socket.emit('signal-ice', { roomId: state.roomId, toSocketId: peerId, candidate: ev.candidate });
  };

  pc.onconnectionstatechange = () => {
    console.log('[PEER]', peerId, pc.connectionState);
    if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') handlePeerDisconnect(peerId);
    if (pc.connectionState === 'connected') state.reconnectAttempts.set(peerId, 0);
  };

  pc.oniceconnectionstatechange = () => {
    console.log('[ICE]', peerId, pc.iceConnectionState);
  };

  if (initiator) {
    const offer = await pc.createOffer(); await pc.setLocalDescription(offer);
    state.socket.emit('signal-offer', { roomId: state.roomId, toSocketId: peerId, sdp: pc.localDescription });
  }

  return pc;
}

// ========== Signaling ==========
async function handleSignalOffer({ fromSocketId, sdp }) {
  let pc = state.peerConnections.get(fromSocketId);
  if (!pc) pc = await createPeerConnection(fromSocketId, false);

  await pc.setRemoteDescription(new RTCSessionDescription(sdp));

  // Host adding screen video to answer
  if (state.isHost && state.localScreenStream) {
    const vt = state.localScreenStream.getVideoTracks()[0];
    if (vt && !pc.getSenders().find(s => s.track?.kind === 'video')) {
      pc.addTrack(vt, state.localScreenStream);
      console.log('[SIGNAL] Added screen track to answer for', fromSocketId);
    }
  }

  const answer = await pc.createAnswer(); await pc.setLocalDescription(answer);
  state.socket.emit('signal-answer', { roomId: state.roomId, toSocketId: fromSocketId, sdp: pc.localDescription });
}

async function handleSignalAnswer({ fromSocketId, sdp }) {
  const pc = state.peerConnections.get(fromSocketId);
  if (pc) await pc.setRemoteDescription(new RTCSessionDescription(sdp));
}

async function handleSignalIce({ fromSocketId, candidate }) {
  const pc = state.peerConnections.get(fromSocketId);
  if (pc) await pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(() => {});
}

// ========== Remote Tracks ==========
function handleRemoteTrack(peerId, ev) {
  if (!state.remotePeers.has(peerId)) state.remotePeers.set(peerId, { nickname: 'Peer', audioEnabled: true });

  for (const stream of ev.streams) {
    stream.getTracks().forEach(track => {
      if (track.kind === 'video') {
        console.log('[TRACK] Video from', peerId);
        if (screenVideo.srcObject !== stream) {
          screenVideo.srcObject = stream; screenVideo.classList.add('has-stream'); noScreenMsg.classList.add('hidden');
        }
        track.onended = () => clearScreenVideo();
      } else if (track.kind === 'audio') {
        console.log('[TRACK] Audio from', peerId);
        let ael = document.getElementById('audio-' + peerId);
        if (!ael) {
          ael = document.createElement('audio'); ael.id = 'audio-' + peerId;
          ael.autoplay = true; ael.playsinline = true; audioContainer.appendChild(ael);
        }
        if (ael.srcObject !== stream) ael.srcObject = stream;
        ael.play().catch(() => {
          const r = () => { ael.play().catch(() => {}); document.removeEventListener('click', r); document.removeEventListener('touchend', r); };
          document.addEventListener('click', r, { once: true }); document.addEventListener('touchend', r, { once: true });
        });
      }
    });
  }
}

// ========== Disconnect & Reconnect ==========
function handlePeerDisconnect(peerId) {
  const pc = state.peerConnections.get(peerId); if (!pc) return;
  const att = state.reconnectAttempts.get(peerId) || 0;
  if (att >= state.MAX_RECONNECT) { removePeer(peerId); return; }
  state.reconnectAttempts.set(peerId, att + 1);
  setTimeout(async () => {
    if (state.peerConnections.has(peerId)) {
      state.peerConnections.get(peerId).close(); state.peerConnections.delete(peerId);
      await createPeerConnection(peerId, true);
    }
  }, 2000 * (att + 1));
}

function removePeer(pid) {
  const pc = state.peerConnections.get(pid); if (pc) { pc.close(); state.peerConnections.delete(pid); }
  state.remotePeers.delete(pid); state.reconnectAttempts.delete(pid);
  document.getElementById('audio-' + pid)?.remove();
  document.getElementById('member-' + pid)?.remove();
  if (pid === state.roomHost) clearScreenVideo();
}

function getPeerName(sid) { const p = state.remotePeers.get(sid); return p ? p.nickname : 'A peer'; }

// ========== Leave ==========
function leaveRoom() {
  for (const [, pc] of state.peerConnections) pc.close();
  state.peerConnections.clear(); state.remotePeers.clear(); state.reconnectAttempts.clear();
  if (state.localAudioStream) { state.localAudioStream.getTracks().forEach(t => t.stop()); state.localAudioStream = null; }
  if (state.localScreenStream) { state.localScreenStream.getTracks().forEach(t => t.stop()); state.localScreenStream = null; }
  if (state.socket && state.roomId) state.socket.emit('leave-room', { roomId: state.roomId });
  audioContainer.innerHTML = ''; clearScreenVideo();
  state.isHost = false; state.roomHost = ''; state.roomId = ''; state.screenSharing = false;
  showLobbyUI(); showToast('Left the room.');
}

function cleanupAll() {
  for (const [, pc] of state.peerConnections) pc.close();
  if (state.localAudioStream) state.localAudioStream.getTracks().forEach(t => t.stop());
  if (state.localScreenStream) state.localScreenStream.getTracks().forEach(t => t.stop());
}

function escapeHtml(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

init();
console.log('⚽ Ready — Mesh P2P + VPS TURN');
