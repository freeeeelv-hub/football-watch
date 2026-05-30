const express = require('express');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { Server } = require('socket.io');

// ----- Configuration -----
const PORT = process.env.PORT || 3000;
const STALE_ROOM_TTL = 30 * 60 * 1000; // 30 minutes
const CLEANUP_INTERVAL = 5 * 60 * 1000; // 5 minutes

// ----- ICE Server Config -----
function getIceServers() {
  const servers = [
    // Public STUN servers
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun.miwifi.com:3478' },
    { urls: 'stun:stun.xten.com:3478' },
    { urls: 'stun:stun.voipbuster.com:3478' },
    // Free TURN server from Metered.ca (relays media when P2P fails)
    {
      urls: 'turn:global.metered.ca:443?transport=tcp',
      username: 'da37d1fe00331ed9b9dd6f9e',
      credential: 'HoCr7wUXlfib3mI5'
    },
    {
      urls: 'turn:global.metered.ca:3478?transport=udp',
      username: 'da37d1fe00331ed9b9dd6f9e',
      credential: 'HoCr7wUXlfib3mI5'
    }
  ];
  if (process.env.TURN_URL) {
    servers.push({
      urls: process.env.TURN_URL,
      username: process.env.TURN_USERNAME || '',
      credential: process.env.TURN_CREDENTIAL || ''
    });
  }
  return servers;
}

// ----- In-Memory Room State -----
// rooms[roomId] = { host: socketId, members: [{socketId, nickname}], createdAt: timestamp }
const rooms = {};

// ----- Express App -----
const app = express();
app.use(express.static(path.join(__dirname, 'public')));

// ICE config endpoint
app.get('/api/config', (_req, res) => {
  res.json({ iceServers: getIceServers() });
});

// SPA fallback
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ----- HTTP(S) Server -----
let server;
const certPath = path.join(__dirname, 'cert.pem');
const keyPath = path.join(__dirname, 'key.pem');

if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
  server = https.createServer({
    cert: fs.readFileSync(certPath),
    key: fs.readFileSync(keyPath)
  }, app);
  console.log('[INFO] HTTPS mode enabled (cert.pem + key.pem found)');
} else {
  server = http.createServer(app);
  console.log('[INFO] HTTP mode (localhost media APIs work on http://localhost)');
}

// ----- Socket.IO -----
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  pingTimeout: 60000,
  pingInterval: 25000
});

// ----- Socket.IO Event Handlers -----
io.on('connection', (socket) => {
  console.log(`[CONNECT] ${socket.id}`);

  // --- Create Room ---
  socket.on('create-room', ({ roomId, nickname }) => {
    // Normalize roomId
    const rid = (roomId || '').trim().toLowerCase();
    if (!rid) {
      socket.emit('error-msg', { message: 'Room ID is required.' });
      return;
    }
    if (rooms[rid]) {
      socket.emit('error-msg', { message: 'Room already exists. Try joining instead.' });
      return;
    }

    rooms[rid] = {
      host: socket.id,
      members: [{ socketId: socket.id, nickname: nickname || 'Host' }],
      createdAt: Date.now()
    };

    socket.nickname = nickname || 'Host';
    socket.currentRoom = rid;
    socket.join(rid);

    console.log(`[ROOM] Created: ${rid} by ${socket.id} (${socket.nickname})`);
    io.to(rid).emit('room-created', {
      roomId: rid,
      members: rooms[rid].members,
      host: socket.id
    });
  });

  // --- Join Room ---
  socket.on('join-room', ({ roomId, nickname }) => {
    const rid = (roomId || '').trim().toLowerCase();
    if (!rid || !rooms[rid]) {
      socket.emit('error-msg', { message: 'Room not found. Check the Room ID and try again.' });
      return;
    }

    // Prevent duplicate joins
    const alreadyIn = rooms[rid].members.find(m => m.socketId === socket.id);
    if (alreadyIn) {
      socket.emit('error-msg', { message: 'You are already in this room.' });
      return;
    }

    const member = { socketId: socket.id, nickname: nickname || 'Viewer' };
    rooms[rid].members.push(member);

    socket.nickname = nickname || 'Viewer';
    socket.currentRoom = rid;
    socket.join(rid);

    console.log(`[ROOM] ${socket.id} (${socket.nickname}) joined ${rid}`);
    io.to(rid).emit('room-joined', {
      roomId: rid,
      members: rooms[rid].members,
      host: rooms[rid].host
    });
  });

  // --- Signal Offer ---
  socket.on('signal-offer', ({ roomId, toSocketId, sdp }) => {
    if (!isInRoom(socket, roomId)) return;
    console.log(`[SIGNAL] Offer: ${socket.id} -> ${toSocketId}`);
    io.to(toSocketId).emit('signal-offer', {
      fromSocketId: socket.id,
      sdp
    });
  });

  // --- Signal Answer ---
  socket.on('signal-answer', ({ roomId, toSocketId, sdp }) => {
    if (!isInRoom(socket, roomId)) return;
    console.log(`[SIGNAL] Answer: ${socket.id} -> ${toSocketId}`);
    io.to(toSocketId).emit('signal-answer', {
      fromSocketId: socket.id,
      sdp
    });
  });

  // --- Signal ICE Candidate ---
  socket.on('signal-ice', ({ roomId, toSocketId, candidate }) => {
    if (!isInRoom(socket, roomId)) return;
    io.to(toSocketId).emit('signal-ice', {
      fromSocketId: socket.id,
      candidate
    });
  });

  // --- Toggle Audio ---
  socket.on('toggle-audio', ({ roomId, enabled }) => {
    if (!isInRoom(socket, roomId)) return;
    socket.to(roomId).emit('audio-state-changed', {
      socketId: socket.id,
      nickname: socket.nickname,
      enabled
    });
  });

  // --- Host Screen Stopped ---
  socket.on('host-screen-stopped', ({ roomId }) => {
    if (!isInRoom(socket, roomId)) return;
    const room = rooms[roomId];
    if (room && room.host === socket.id) {
      socket.to(roomId).emit('host-screen-stopped', { roomId });
    }
  });

  // --- Leave Room ---
  socket.on('leave-room', ({ roomId }) => {
    handleLeaveRoom(socket, roomId);
  });

  // --- Disconnect ---
  socket.on('disconnect', () => {
    console.log(`[DISCONNECT] ${socket.id}`);
    if (socket.currentRoom) {
      handleLeaveRoom(socket, socket.currentRoom);
    }
  });
});

// ----- Helper: Validate socket is in room -----
function isInRoom(socket, roomId) {
  const room = rooms[roomId];
  if (!room) return false;
  return room.members.some(m => m.socketId === socket.id);
}

// ----- Helper: Leave Room -----
function handleLeaveRoom(socket, roomId) {
  const room = rooms[roomId];
  if (!room) return;

  // Remove member
  room.members = room.members.filter(m => m.socketId !== socket.id);
  socket.leave(roomId);
  socket.currentRoom = null;

  console.log(`[ROOM] ${socket.id} left ${roomId}`);

  if (room.members.length === 0) {
    // No members left, delete room
    delete rooms[roomId];
    console.log(`[ROOM] Deleted empty room: ${roomId}`);
  } else {
    // If host left, promote first remaining member
    if (room.host === socket.id) {
      room.host = room.members[0].socketId;
      console.log(`[ROOM] New host for ${roomId}: ${room.host}`);
    }
    io.to(roomId).emit('peer-left', {
      socketId: socket.id,
      members: room.members,
      host: room.host
    });
  }
}

// ----- Stale Room Cleanup -----
setInterval(() => {
  const now = Date.now();
  for (const [rid, room] of Object.entries(rooms)) {
    if (room.members.length === 0 && (now - room.createdAt) > STALE_ROOM_TTL) {
      delete rooms[rid];
      console.log(`[CLEANUP] Removed stale room: ${rid}`);
    }
  }
}, CLEANUP_INTERVAL);

// ----- Start Server -----
server.listen(PORT, () => {
  console.log(`[START] Server running on port ${PORT}`);
  console.log(`[START] Open http://localhost:${PORT} to begin`);
  console.log(`[START] For mobile/LAN testing, use your local IP address`);
});
