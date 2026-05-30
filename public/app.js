/* ===================================================================
   Football Watch Party — Client Application Logic
   WebRTC screen sharing + mesh audio via Socket.IO signaling
   =================================================================== */

// ----- DOM References -----
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const lobbySection = $('#lobby-section');
const roomSection = $('#room-section');
const nicknameInput = $('#nickname-input');
const roomIdInput = $('#room-id-input');
const lobbyError = $('#lobby-error');
const btnCreate = $('#btn-create');
const btnJoin = $('#btn-join');
const btnLeave = $('#btn-leave');
const btnMic = $('#btn-mic');
const btnScreenShare = $('#btn-screen-share');
const btnFullscreen = $('#btn-fullscreen');
const btnMembers = $('#btn-members');
const roomIdDisplay = $('#room-id-display');
const memberCount = $('#member-count');
const memberList = $('#member-list');
const memberPanel = $('#member-panel');
const screenVideo = $('#screen-video');
const noScreenMsg = $('#no-screen-msg');
const localPreview = $('#local-preview');
const localPreviewVideo = $('#local-preview-video');
const audioContainer = $('#audio-container');
const toastContainer = $('#toast-container');

// ----- State -----
const state = {
  socket: null,
  nickname: '',
  roomId: '',
  socketId: '',
  isHost: false,
  roomHost: '',         // socketId of the host
  localAudioStream: null,
  localScreenStream: null,
  peerConnections: new Map(),   // Map<peerSocketId, RTCPeerConnection>
  remotePeers: new Map(),       // Map<peerSocketId, { nickname, audioEnabled }>
  micEnabled: true,
  screenSharing: false,
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ],
  reconnectAttempts: new Map(), // Map<peerSocketId, number>
  MAX_RECONNECT_ATTEMPTS: 3
};

// ----- Mobile Detection -----
const isMobile = /Android|iPhone|iPad|iPod|webOS/i.test(navigator.userAgent)
              || window.innerWidth < 768;

// ----- Initialize -----
async function init() {
  // Fetch ICE config from server (includes TURN if configured)
  try {
    const resp = await fetch('/api/config');
    const config = await resp.json();
    if (config.iceServers && config.iceServers.length > 0) {
      state.iceServers = config.iceServers;
    }
  } catch (e) {
    console.warn('Could not fetch ICE config, using defaults:', e);
  }

  // Set a random default nickname
  const savedNick = localStorage.getItem('football-watch-nickname');
  if (savedNick) {
    nicknameInput.value = savedNick;
  }
}

// ----- Event Binding -----
btnCreate.addEventListener('click', () => handleCreateRoom());
btnJoin.addEventListener('click', () => handleJoinRoom());
btnLeave.addEventListener('click', () => leaveRoom());
btnMic.addEventListener('click', () => toggleMic());
btnScreenShare.addEventListener('click', () => toggleScreenShare());
btnFullscreen.addEventListener('click', () => toggleFullscreen());
btnMembers.addEventListener('click', () => toggleMemberPanel());

// Enter key in inputs
nicknameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') roomIdInput.focus();
});
roomIdInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    if (roomIdInput.value.trim()) {
      handleJoinRoom();
    } else {
      handleCreateRoom();
    }
  }
});

// Page unload cleanup
window.addEventListener('beforeunload', () => {
  cleanupAll();
});

// Click outside member panel to close
document.addEventListener('click', (e) => {
  if (!memberPanel.classList.contains('hidden') &&
      !e.target.closest('#member-panel') &&
      !e.target.closest('#btn-members')) {
    memberPanel.classList.add('hidden');
  }
});

// ===================================================================
//  ROOM MANAGEMENT
// ===================================================================

function generateRoomId() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < 6; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
}

function showError(msg) {
  lobbyError.textContent = msg;
  lobbyError.classList.remove('hidden');
}

function hideError() {
  lobbyError.textContent = '';
  lobbyError.classList.add('hidden');
}

function validateInputs(requireRoomId) {
  hideError();
  const nickname = nicknameInput.value.trim();
  if (!nickname) {
    showError('Please enter your name.');
    return null;
  }
  if (requireRoomId) {
    const roomId = roomIdInput.value.trim();
    if (!roomId) {
      showError('Please enter a Room ID to join.');
      return null;
    }
    return { nickname, roomId: roomId.toLowerCase() };
  }
  const roomId = roomIdInput.value.trim() || generateRoomId();
  return { nickname, roomId: roomId.toLowerCase() };
}

async function handleCreateRoom() {
  const inputs = validateInputs(false);
  if (!inputs) return;

  state.nickname = inputs.nickname;
  state.roomId = inputs.roomId;
  state.justJoined = true;  // Mark as new joiner to initiate connections
  localStorage.setItem('football-watch-nickname', state.nickname);

  // Connect socket
  await connectSocket();

  // Emit create-room
  state.socket.emit('create-room', {
    roomId: state.roomId,
    nickname: state.nickname
  });
}

async function handleJoinRoom() {
  const inputs = validateInputs(true);
  if (!inputs) return;

  state.nickname = inputs.nickname;
  state.roomId = inputs.roomId;
  state.justJoined = true;  // Mark as new joiner to initiate connections
  localStorage.setItem('football-watch-nickname', state.nickname);

  // Connect socket
  await connectSocket();

  // Emit join-room
  state.socket.emit('join-room', {
    roomId: state.roomId,
    nickname: state.nickname
  });
}

function connectSocket() {
  return new Promise((resolve) => {
    if (state.socket && state.socket.connected) {
      resolve();
      return;
    }

    state.socket = io({
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: 10,
      reconnectionDelay: 1000
    });

    state.socket.on('connect', () => {
      state.socketId = state.socket.id;
      console.log('[SOCKET] Connected:', state.socketId);
      resolve();
    });

    state.socket.on('connect_error', (err) => {
      console.error('[SOCKET] Connection error:', err);
      showError('Connection failed. Please check your network.');
    });

    // Bind all signaling handlers
    bindSocketEvents();
  });
}

function bindSocketEvents() {
  const socket = state.socket;

  // Room created (host)
  socket.on('room-created', ({ roomId, members, host }) => {
    console.log('[ROOM] Created:', roomId);
    state.isHost = true;
    state.roomHost = host;
    state.roomId = roomId;
    showRoomUI();
    updateMemberList(members, host);
    showToast('Room created! Share the Room ID with friends.');
    startLocalAudio();
    // Host is the only member, no connections to make
    state.justJoined = false;
  });

  // Room joined (all members)
  socket.on('room-joined', ({ roomId, members, host }) => {
    console.log('[ROOM] Joined:', roomId, members.length, 'members');
    state.roomHost = host;
    state.roomId = roomId;
    showRoomUI();
    updateMemberList(members, host);

    if (state.justJoined) {
      // We are the new joiner → initiate connections to all existing peers
      showToast('You joined the room!');
      startLocalAudio();
      connectToMembers(members);
      state.justJoined = false;
    }
    // Existing members: just update UI, they will receive offers from the new joiner
  });

  // Peer left
  socket.on('peer-left', ({ socketId, members, host }) => {
    console.log('[ROOM] Peer left:', socketId);
    state.roomHost = host;
    removePeer(socketId);
    updateMemberList(members, host);
    showToast(getPeerName(socketId) + ' left the room');

    // If host left, clean up screen
    if (socketId === state.roomHost || (state.isHost && host !== state.socketId)) {
      // Host changed or left
      clearScreenVideo();
    }
  });

  // Signaling events
  socket.on('signal-offer', handleSignalOffer);
  socket.on('signal-answer', handleSignalAnswer);
  socket.on('signal-ice', handleSignalIce);

  // Host stopped screen sharing
  socket.on('host-screen-stopped', ({ roomId }) => {
    console.log('[SCREEN] Host stopped sharing');
    clearScreenVideo();
    showToast('Host stopped screen sharing');
  });

  // Audio state changed
  socket.on('audio-state-changed', ({ socketId, nickname, enabled }) => {
    const peer = state.remotePeers.get(socketId);
    if (peer) {
      peer.audioEnabled = enabled;
    }
    // Refresh member list to show mute icons
    refreshMemberList();
  });

  // Error message
  socket.on('error-msg', ({ message }) => {
    showError(message);
  });
}

// ===================================================================
//  UI TRANSITIONS
// ===================================================================

function showRoomUI() {
  lobbySection.classList.add('hidden');
  roomSection.classList.remove('hidden');
  roomIdDisplay.textContent = 'Room: ' + state.roomId;

  // Show host controls
  if (state.isHost) {
    btnScreenShare.classList.remove('hidden');
  } else {
    btnScreenShare.classList.add('hidden');
  }

  hideError();
  updateMicButton();
  updateScreenShareButton();
}

function showLobbyUI() {
  roomSection.classList.add('hidden');
  lobbySection.classList.remove('hidden');
  screenVideo.srcObject = null;
  noScreenMsg.classList.remove('hidden');
  memberPanel.classList.add('hidden');
  localPreview.classList.add('hidden');
  audioContainer.innerHTML = '';

  updateMicButton();
  updateScreenShareButton();
}

function updateMemberList(members, host) {
  state.remotePeers.clear();
  memberList.innerHTML = '';
  memberCount.textContent = '👤 ' + members.length;

  for (const m of members) {
    if (m.socketId === state.socketId) continue; // Skip self

    state.remotePeers.set(m.socketId, {
      nickname: m.nickname,
      audioEnabled: true
    });

    const item = createMemberElement(m, host);
    memberList.appendChild(item);
  }

  // Also add self to the top
  const selfItem = document.createElement('div');
  selfItem.className = 'member-item';
  selfItem.innerHTML = `
    <span class="member-icon">${state.isHost ? '📡' : '👤'}</span>
    <span class="member-name">${escapeHtml(state.nickname)} (You)</span>
    ${state.isHost ? '<span class="member-badge-host">HOST</span>' : ''}
    ${!state.micEnabled ? '<span class="member-muted">🔇</span>' : ''}
  `;
  memberList.insertBefore(selfItem, memberList.firstChild);
}

function createMemberElement(member, host) {
  const div = document.createElement('div');
  div.className = 'member-item';
  div.id = 'member-' + member.socketId;
  const isHost = member.socketId === host;
  div.innerHTML = `
    <span class="member-icon">${isHost ? '📡' : '👤'}</span>
    <span class="member-name">${escapeHtml(member.nickname)}</span>
    ${isHost ? '<span class="member-badge-host">HOST</span>' : ''}
  `;
  return div;
}

function refreshMemberList() {
  // Update mute icons on member items
  for (const [socketId, peer] of state.remotePeers) {
    const item = document.getElementById('member-' + socketId);
    if (item) {
      const existingMute = item.querySelector('.member-muted');
      if (!peer.audioEnabled) {
        if (!existingMute) {
          const muteSpan = document.createElement('span');
          muteSpan.className = 'member-muted';
          muteSpan.textContent = '🔇';
          item.appendChild(muteSpan);
        }
      } else {
        if (existingMute) existingMute.remove();
      }
    }
  }

  // Update self mute icon
  const selfItem = memberList.querySelector('.member-item:first-child');
  if (selfItem) {
    const selfMute = selfItem.querySelector('.member-muted');
    if (!state.micEnabled) {
      if (!selfMute) {
        const muteSpan = document.createElement('span');
        muteSpan.className = 'member-muted';
        muteSpan.textContent = '🔇';
        selfItem.appendChild(muteSpan);
      }
    } else {
      if (selfMute) selfMute.remove();
    }
  }
}

function toggleMemberPanel() {
  memberPanel.classList.toggle('hidden');
  // Refresh list when opening
  if (!memberPanel.classList.contains('hidden')) {
    refreshMemberList();
  }
}

// ===================================================================
//  TOAST NOTIFICATIONS
// ===================================================================

function showToast(message) {
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = message;
  toastContainer.appendChild(toast);

  // Auto-remove after animation
  setTimeout(() => {
    if (toast.parentNode) {
      toast.remove();
    }
  }, 3000);
}

// ===================================================================
//  LOCAL MEDIA
// ===================================================================

async function startLocalAudio() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      },
      video: false
    });
    state.localAudioStream = stream;
    state.micEnabled = true;
    updateMicButton();
    console.log('[AUDIO] Local microphone acquired');

    // If we already have peer connections, add the audio track
    addLocalAudioToAllPeers();
  } catch (err) {
    console.error('[AUDIO] Microphone access denied:', err);
    state.micEnabled = false;
    updateMicButton();
    showToast('⚠️ Microphone not available. You are listen-only.');
  }
}

function addLocalAudioToAllPeers() {
  if (!state.localAudioStream) return;
  const audioTrack = state.localAudioStream.getAudioTracks()[0];
  if (!audioTrack) return;

  for (const [peerSocketId, pc] of state.peerConnections) {
    const senders = pc.getSenders();
    const audioSender = senders.find(s => s.track?.kind === 'audio');
    if (audioSender) {
      audioSender.replaceTrack(audioTrack).catch(e => console.warn('replaceTrack error:', e));
    } else {
      pc.addTrack(audioTrack, state.localAudioStream);
    }
  }
}

function toggleMic() {
  state.micEnabled = !state.micEnabled;
  if (state.localAudioStream) {
    state.localAudioStream.getAudioTracks().forEach(track => {
      track.enabled = state.micEnabled;
    });
  }
  updateMicButton();
  refreshMemberList();

  if (state.socket && state.roomId) {
    state.socket.emit('toggle-audio', {
      roomId: state.roomId,
      enabled: state.micEnabled
    });
  }
}

function updateMicButton() {
  if (state.micEnabled) {
    btnMic.className = 'ctrl-btn mic-on';
    btnMic.querySelector('.ctrl-label').textContent = 'Mic On';
    btnMic.querySelector('.ctrl-icon').textContent = '🎤';
  } else {
    btnMic.className = 'ctrl-btn mic-off';
    btnMic.querySelector('.ctrl-label').textContent = 'Mic Off';
    btnMic.querySelector('.ctrl-icon').textContent = '🔇';
  }
}

// ===================================================================
//  SCREEN SHARING (HOST ONLY)
// ===================================================================

async function toggleScreenShare() {
  if (!state.isHost) return;

  if (state.screenSharing) {
    await stopScreenShare();
  } else {
    await startScreenShare();
  }
}

async function startScreenShare() {
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        cursor: 'always',
        frameRate: { ideal: 30 },
        width: { ideal: 1920 },
        height: { ideal: 1080 }
      },
      audio: false  // System audio adds complexity; host mic picks up game sound
    });

    state.localScreenStream = stream;
    state.screenSharing = true;
    updateScreenShareButton();

    const videoTrack = stream.getVideoTracks()[0];
    console.log('[SCREEN] Sharing started, track:', videoTrack.label);

    // Add screen video track to all existing peer connections
    for (const [peerSocketId, pc] of state.peerConnections) {
      await addScreenTrackToPeer(pc, videoTrack, stream, peerSocketId);
    }

    // Show local preview (PiP)
    showLocalPreview(stream);

    // Handle user stopping via browser UI (Chrome "Stop Sharing" button)
    videoTrack.onended = () => {
      console.log('[SCREEN] Track ended (user stopped via browser)');
      stopScreenShare();
    };

    // Handle stream inactive
    stream.oninactive = () => {
      console.log('[SCREEN] Stream inactive');
      stopScreenShare();
    };

    showToast('Screen sharing started!');
  } catch (err) {
    console.error('[SCREEN] Share failed:', err);
    if (err.name === 'NotAllowedError') {
      showToast('Screen sharing was cancelled. Please try again.');
    } else if (err.name === 'NotFoundError') {
      showToast('No screen found to share.');
    } else {
      showToast('Screen sharing failed: ' + err.message);
    }
  }
}

async function addScreenTrackToPeer(pc, videoTrack, stream, peerSocketId) {
  try {
    const senders = pc.getSenders();
    const videoSender = senders.find(s => s.track?.kind === 'video');

    if (videoSender) {
      // Replace existing track (no renegotiation)
      await videoSender.replaceTrack(videoTrack);
    } else {
      // Add new track (triggers renegotiation)
      pc.addTrack(videoTrack, stream);
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      state.socket.emit('signal-offer', {
        roomId: state.roomId,
        toSocketId: peerSocketId,
        sdp: pc.localDescription
      });
    }
  } catch (e) {
    console.error('[SCREEN] Failed to add screen track to peer', peerSocketId, e);
  }
}

async function stopScreenShare() {
  if (state.localScreenStream) {
    state.localScreenStream.getTracks().forEach(t => t.stop());
    state.localScreenStream = null;
  }
  state.screenSharing = false;
  updateScreenShareButton();
  hideLocalPreview();

  // Remove video track from all peers
  for (const [peerSocketId, pc] of state.peerConnections) {
    const senders = pc.getSenders();
    const videoSender = senders.find(s => s.track?.kind === 'video');
    if (videoSender) {
      pc.removeTrack(videoSender);
      // Renegotiate
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        state.socket.emit('signal-offer', {
          roomId: state.roomId,
          toSocketId: peerSocketId,
          sdp: pc.localDescription
        });
      } catch (e) {
        console.warn('[SCREEN] Renegotiation error:', e);
      }
    }
  }

  if (state.socket && state.roomId) {
    state.socket.emit('host-screen-stopped', { roomId: state.roomId });
  }

  showToast('Screen sharing stopped.');
  clearScreenVideo();
}

function updateScreenShareButton() {
  if (state.screenSharing) {
    btnScreenShare.className = 'ctrl-btn sharing-active';
    btnScreenShare.querySelector('.ctrl-label').textContent = 'Stop Share';
  } else {
    btnScreenShare.className = 'ctrl-btn';
    btnScreenShare.querySelector('.ctrl-label').textContent = 'Share Screen';
  }
}

function showLocalPreview(stream) {
  localPreviewVideo.srcObject = stream;
  localPreview.classList.remove('hidden');

  // Tap to toggle fullscreen on mobile
  localPreview.onclick = () => {
    toggleFullscreen();
  };
}

function hideLocalPreview() {
  localPreviewVideo.srcObject = null;
  localPreview.classList.add('hidden');
  localPreview.onclick = null;
}

function clearScreenVideo() {
  screenVideo.srcObject = null;
  noScreenMsg.classList.remove('hidden');
}

// ===================================================================
//  FULLSCREEN
// ===================================================================

function toggleFullscreen() {
  const el = document.getElementById('video-area');
  if (!document.fullscreenElement && !document.webkitFullscreenElement) {
    if (el.requestFullscreen) {
      el.requestFullscreen().catch(() => {});
    } else if (el.webkitRequestFullscreen) {
      el.webkitRequestFullscreen();
    }
  } else {
    if (document.exitFullscreen) {
      document.exitFullscreen();
    } else if (document.webkitExitFullscreen) {
      document.webkitExitFullscreen();
    }
  }
}

// ===================================================================
//  PEER CONNECTION MANAGEMENT
// ===================================================================

function connectToMembers(members) {
  for (const m of members) {
    if (m.socketId === state.socketId) continue; // skip self
    if (state.peerConnections.has(m.socketId)) continue; // already connected

    // New joiner always initiates offers to all existing peers
    console.log('[PEER] Creating connection to:', m.socketId, m.nickname);
    createPeerConnection(m.socketId, true);
  }
}

async function createPeerConnection(peerSocketId, isInitiator) {
  // Avoid duplicate connections
  if (state.peerConnections.has(peerSocketId)) {
    console.warn('[PEER] Connection to', peerSocketId, 'already exists');
    return state.peerConnections.get(peerSocketId);
  }

  console.log('[PEER] Creating PC for', peerSocketId, 'initiator:', isInitiator);

  // 1. Create RTCPeerConnection
  const pc = new RTCPeerConnection({ iceServers: state.iceServers });

  // 2. Store
  state.peerConnections.set(peerSocketId, pc);

  // 3. Add local audio track
  if (state.localAudioStream) {
    const audioTrack = state.localAudioStream.getAudioTracks()[0];
    if (audioTrack) {
      pc.addTrack(audioTrack, state.localAudioStream);
    }
  }

  // 4. If host and sharing screen, add screen video track
  if (state.isHost && state.localScreenStream) {
    const videoTrack = state.localScreenStream.getVideoTracks()[0];
    if (videoTrack) {
      pc.addTrack(videoTrack, state.localScreenStream);
    }
  }

  // 5. Handle remote tracks
  pc.ontrack = (event) => {
    handleRemoteTrack(peerSocketId, event);
  };

  // 6. ICE candidate handler
  pc.onicecandidate = (event) => {
    if (event.candidate && state.socket && state.roomId) {
      state.socket.emit('signal-ice', {
        roomId: state.roomId,
        toSocketId: peerSocketId,
        candidate: event.candidate
      });
    }
  };

  // 7. Connection state monitoring
  pc.onconnectionstatechange = () => {
    const connState = pc.connectionState;
    console.log('[PEER] Connection state for', peerSocketId, ':', connState);
    updatePeerStatusUI(peerSocketId, connState);

    if (connState === 'failed' || connState === 'disconnected') {
      handlePeerDisconnect(peerSocketId);
    }
    if (connState === 'connected') {
      // Reset reconnect attempts on successful connection
      state.reconnectAttempts.set(peerSocketId, 0);
    }
  };

  // 8. ICE connection state
  pc.oniceconnectionstatechange = () => {
    console.log('[PEER] ICE state for', peerSocketId, ':', pc.iceConnectionState);
  };

  // 9. If initiator, create and send offer
  if (isInitiator) {
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      if (state.socket && state.roomId) {
        state.socket.emit('signal-offer', {
          roomId: state.roomId,
          toSocketId: peerSocketId,
          sdp: pc.localDescription
        });
      }
    } catch (e) {
      console.error('[PEER] Failed to create offer for', peerSocketId, e);
    }
  }

  return pc;
}

// ===================================================================
//  SIGNALING HANDLERS
// ===================================================================

async function handleSignalOffer({ fromSocketId, sdp }) {
  console.log('[SIGNAL] Received offer from', fromSocketId);

  let pc = state.peerConnections.get(fromSocketId);
  if (!pc) {
    // First contact from this peer — create PC (non-initiating)
    pc = await createPeerConnection(fromSocketId, false);
  }

  try {
    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    state.socket.emit('signal-answer', {
      roomId: state.roomId,
      toSocketId: fromSocketId,
      sdp: pc.localDescription
    });
  } catch (e) {
    console.error('[SIGNAL] Error handling offer from', fromSocketId, e);
  }
}

async function handleSignalAnswer({ fromSocketId, sdp }) {
  console.log('[SIGNAL] Received answer from', fromSocketId);

  const pc = state.peerConnections.get(fromSocketId);
  if (!pc) {
    console.warn('[SIGNAL] No PC found for answer from', fromSocketId);
    return;
  }

  try {
    await pc.setRemoteDescription(new RTCSessionDescription(sdp));
  } catch (e) {
    console.error('[SIGNAL] Error handling answer from', fromSocketId, e);
  }
}

async function handleSignalIce({ fromSocketId, candidate }) {
  const pc = state.peerConnections.get(fromSocketId);
  if (!pc) {
    // May arrive slightly before PC is fully set up; ignore
    return;
  }

  try {
    await pc.addIceCandidate(new RTCIceCandidate(candidate));
  } catch (e) {
    console.error('[SIGNAL] Error adding ICE candidate from', fromSocketId, e);
  }
}

// ===================================================================
//  REMOTE TRACK RENDERING
// ===================================================================

function handleRemoteTrack(peerSocketId, event) {
  console.log('[TRACK] Remote track from', peerSocketId, 'streams:', event.streams.length);

  // Ensure peer info exists
  if (!state.remotePeers.has(peerSocketId)) {
    state.remotePeers.set(peerSocketId, {
      nickname: 'Peer',
      audioEnabled: true
    });
  }

  for (const stream of event.streams) {
    stream.getTracks().forEach((track) => {
      if (track.kind === 'video') {
        // SCREEN SHARE from host
        console.log('[TRACK] Video track from', peerSocketId);
        if (screenVideo.srcObject !== stream) {
          screenVideo.srcObject = stream;
          noScreenMsg.classList.add('hidden');
        }

        // If this track ends (host stopped sharing)
        track.onended = () => {
          console.log('[TRACK] Video track ended from', peerSocketId);
          clearScreenVideo();
        };
      } else if (track.kind === 'audio') {
        // AUDIO from peer
        console.log('[TRACK] Audio track from', peerSocketId);
        let audioEl = document.getElementById('audio-' + peerSocketId);
        if (!audioEl) {
          audioEl = document.createElement('audio');
          audioEl.id = 'audio-' + peerSocketId;
          audioEl.autoplay = true;
          audioEl.playsinline = true;
          audioContainer.appendChild(audioEl);
        }
        if (audioEl.srcObject !== stream) {
          audioEl.srcObject = stream;
        }

        // Play on user interaction if blocked
        audioEl.play().catch(() => {
          // Autoplay blocked; will retry on user click
          const resumeAudio = () => {
            audioEl.play().catch(() => {});
            document.removeEventListener('click', resumeAudio);
            document.removeEventListener('touchend', resumeAudio);
          };
          document.addEventListener('click', resumeAudio, { once: true });
          document.addEventListener('touchend', resumeAudio, { once: true });
        });
      }
    });
  }
}

// ===================================================================
//  PEER DISCONNECT & RECONNECT
// ===================================================================

function handlePeerDisconnect(peerSocketId) {
  const pc = state.peerConnections.get(peerSocketId);
  if (!pc) return;

  const attempts = state.reconnectAttempts.get(peerSocketId) || 0;

  if (attempts >= state.MAX_RECONNECT_ATTEMPTS) {
    console.log('[PEER] Max reconnect attempts reached for', peerSocketId);
    removePeer(peerSocketId);
    return;
  }

  state.reconnectAttempts.set(peerSocketId, attempts + 1);
  const delay = 2000 * (attempts + 1); // Exponential backoff

  console.log('[PEER] Reconnecting to', peerSocketId, 'attempt', attempts + 1, 'in', delay, 'ms');

  setTimeout(async () => {
    // Check if this peer is still supposed to be in our room
    // (they might have genuinely left)
    if (state.peerConnections.has(peerSocketId)) {
      const oldPc = state.peerConnections.get(peerSocketId);
      oldPc.close();
      state.peerConnections.delete(peerSocketId);

      // Recreate connection as initiator
      try {
        await createPeerConnection(peerSocketId, true);
        console.log('[PEER] Reconnected to', peerSocketId);
      } catch (e) {
        console.error('[PEER] Reconnection failed for', peerSocketId, e);
        removePeer(peerSocketId);
      }
    }
  }, delay);
}

function removePeer(peerSocketId) {
  // Close PC
  const pc = state.peerConnections.get(peerSocketId);
  if (pc) {
    pc.close();
    state.peerConnections.delete(peerSocketId);
  }

  state.remotePeers.delete(peerSocketId);
  state.reconnectAttempts.delete(peerSocketId);

  // Remove audio element
  const audioEl = document.getElementById('audio-' + peerSocketId);
  if (audioEl) audioEl.remove();

  // Remove member element
  const memberEl = document.getElementById('member-' + peerSocketId);
  if (memberEl) memberEl.remove();

  // Check if screen video came from this peer (host left)
  if (peerSocketId === state.roomHost) {
    clearScreenVideo();
  }
}

function updatePeerStatusUI(peerSocketId, connectionState) {
  const memberEl = document.getElementById('member-' + peerSocketId);
  if (!memberEl) return;

  const statusEl = memberEl.querySelector('.member-status');
  if (connectionState === 'connected') {
    if (statusEl) statusEl.remove();
  } else if (connectionState === 'connecting' || connectionState === 'new') {
    if (!statusEl) {
      const span = document.createElement('span');
      span.className = 'member-status';
      span.textContent = '⏳';
      span.title = 'Connecting...';
      memberEl.appendChild(span);
    }
  } else {
    if (!statusEl) {
      const span = document.createElement('span');
      span.className = 'member-status';
      span.textContent = '⚠️';
      span.title = 'Connection issue';
      memberEl.appendChild(span);
    }
  }
}

function getPeerName(socketId) {
  const peer = state.remotePeers.get(socketId);
  return peer ? peer.nickname : 'A peer';
}

// ===================================================================
//  LEAVE ROOM / CLEANUP
// ===================================================================

function leaveRoom() {
  // 1. Close all peer connections
  for (const [peerSocketId, pc] of state.peerConnections) {
    pc.close();
    removePeerUIElements(peerSocketId);
  }
  state.peerConnections.clear();
  state.remotePeers.clear();
  state.reconnectAttempts.clear();

  // 2. Stop local streams
  stopLocalStreams();

  // 3. Leave signaling room
  if (state.socket && state.roomId) {
    state.socket.emit('leave-room', { roomId: state.roomId });
  }

  // 4. Clean audio elements
  audioContainer.innerHTML = '';

  // 5. Reset screen video
  clearScreenVideo();

  // 6. Reset state
  state.isHost = false;
  state.roomHost = '';
  state.roomId = '';
  state.screenSharing = false;

  // 7. Show lobby
  showLobbyUI();

  showToast('You left the room.');
}

function cleanupAll() {
  // Quick cleanup on page close (don't bother with signaling)
  for (const [, pc] of state.peerConnections) {
    pc.close();
  }
  stopLocalStreams();
}

function stopLocalStreams() {
  if (state.localAudioStream) {
    state.localAudioStream.getTracks().forEach(t => t.stop());
    state.localAudioStream = null;
  }
  if (state.localScreenStream) {
    state.localScreenStream.getTracks().forEach(t => t.stop());
    state.localScreenStream = null;
  }
}

function removePeerUIElements(peerSocketId) {
  const audioEl = document.getElementById('audio-' + peerSocketId);
  if (audioEl) audioEl.remove();
  const memberEl = document.getElementById('member-' + peerSocketId);
  if (memberEl) memberEl.remove();
}

// ===================================================================
//  UTILITY
// ===================================================================

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ===================================================================
//  STARTUP
// ===================================================================
init();
console.log('⚽ Football Watch Party — Ready');
console.log('   Open this page in two tabs to test:');
console.log('   1. Create a room in tab 1');
console.log('   2. Join the room in tab 2');
