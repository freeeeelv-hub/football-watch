/**
 * Football Watch Party — Mediasoup SFU Server
 * Runs on VPS (124.220.81.3:8000)
 *
 * Architecture:
 * - Host produces video track → SFU distributes to all viewers in room
 * - One mediasoup Router per room
 * - WebSocket for SFU signaling (separate from Socket.IO)
 */

const mediasoup = require('mediasoup');
const { WebSocketServer } = require('ws');
const http = require('http');

// ----- Config -----
const PORT = process.env.SFU_PORT || 8000;
const ANNOUNCED_IP = process.env.ANNOUNCED_IP || '124.220.81.3';
const MEDIA_MIN = 20000;
const MEDIA_MAX = 21000;

// ----- State -----
let worker = null;
const rooms = new Map();

// ----- Helper: get/create room -----
async function getRoom(roomId) {
  if (!rooms.has(roomId)) {
    const router = await worker.createRouter({
      mediaCodecs: [
        { kind: 'video', mimeType: 'video/VP8', clockRate: 90000, parameters: { 'x-google-start-bitrate': 1000 } },
        { kind: 'video', mimeType: 'video/H264', clockRate: 90000, parameters: { 'packetization-mode': 1, 'profile-level-id': '42e01f', 'level-asymmetry-allowed': 1 } },
        { kind: 'audio', mimeType: 'audio/opus', clockRate: 48000, channels: 2 }
      ]
    });
    rooms.set(roomId, { router, producers: new Map(), consumers: new Map(), pendingTransports: new Map() });
    console.log(`[ROOM] Created: ${roomId}`);
  }
  return rooms.get(roomId);
}

// ----- Broadcast to room (except sender) -----
function broadcast(roomId, msg, excludeWs) {
  wss.clients.forEach(c => {
    if (c._roomId === roomId && c !== excludeWs && c.readyState === 1) {
      c.send(JSON.stringify(msg));
    }
  });
}

// ----- Cleanup client -----
function cleanupClient(ws) {
  const { _roomId, _clientId } = ws;
  if (!_roomId || !_clientId) return;
  const room = rooms.get(_roomId);
  if (!room) return;

  // Close producer
  const producer = room.producers.get(_clientId);
  if (producer) {
    producer.close();
    room.producers.delete(_clientId);
    broadcast(_roomId, { type: 'producer-closed', fromClientId: _clientId }, ws);
  }

  // Close consumers
  for (const [key, c] of room.consumers) {
    if (key.startsWith(`${_clientId}_`)) { c.close(); room.consumers.delete(key); }
  }

  // Clean pending transports
  for (const [key, t] of room.pendingTransports) {
    if (key.startsWith(`${_clientId}_`)) { t.close(); room.pendingTransports.delete(key); }
  }

  // Clean empty room
  if (room.producers.size === 0 && room.consumers.size === 0) {
    room.router.close();
    rooms.delete(_roomId);
    console.log(`[ROOM] Removed: ${_roomId}`);
  }
}

// ==================== START ====================
async function main() {
  worker = await mediasoup.createWorker({ logLevel: 'warn', rtcMinPort: MEDIA_MIN, rtcMaxPort: MEDIA_MAX });
  console.log(`[WORKER] PID: ${worker.pid}`);
  worker.on('died', () => { console.error('[WORKER] Died!'); process.exit(1); });

  const server = http.createServer((_req, res) => { res.writeHead(200); res.end('SFU OK'); });
  const wss = new WebSocketServer({ server });

  wss.on('connection', (ws) => {
    console.log('[WS] Connected');

    ws.on('message', async (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }

      try {
        switch (msg.type) {

          case 'sfu-join': {
            ws._roomId = msg.roomId;
            ws._clientId = msg.clientId;
            await getRoom(msg.roomId);
            ws.send(JSON.stringify({ type: 'sfu-joined' }));
            console.log(`[JOIN] ${msg.clientId} -> ${msg.roomId}`);
            break;
          }

          case 'create-producer-transport': {
            const room = await getRoom(ws._roomId);
            const transport = await room.router.createWebRtcTransport({
              listenIps: [{ ip: '0.0.0.0', announcedIp: ANNOUNCED_IP }],
              enableUdp: true, enableTcp: true, preferUdp: true,
              initialAvailableOutgoingBitrate: 15000000
            });
            room.pendingTransports.set(`${ws._clientId}_producer`, transport);
            ws.send(JSON.stringify({
              type: 'producer-transport-created',
              id: transport.id,
              iceParameters: transport.iceParameters,
              iceCandidates: transport.iceCandidates,
              dtlsParameters: transport.dtlsParameters
            }));
            break;
          }

          case 'connect-producer-transport': {
            const room = rooms.get(ws._roomId);
            const transport = room.pendingTransports.get(`${ws._clientId}_producer`);
            await transport.connect({ dtlsParameters: msg.dtlsParameters });
            ws.send(JSON.stringify({ type: 'producer-transport-connected' }));
            break;
          }

          case 'produce': {
            const room = rooms.get(ws._roomId);
            const transport = room.pendingTransports.get(`${ws._clientId}_producer`);
            const producer = await transport.produce({ kind: msg.kind, rtpParameters: msg.rtpParameters });
            room.producers.set(ws._clientId, producer);
            room.pendingTransports.delete(`${ws._clientId}_producer`);
            ws.send(JSON.stringify({ type: 'produced', producerId: producer.id }));
            broadcast(ws._roomId, { type: 'new-producer', producerId: producer.id, kind: msg.kind, fromClientId: ws._clientId }, ws);
            console.log(`[PRODUCE] ${ws._clientId} producing ${msg.kind}`);
            break;
          }

          case 'create-consumer-transport': {
            const room = await getRoom(ws._roomId);
            const transport = await room.router.createWebRtcTransport({
              listenIps: [{ ip: '0.0.0.0', announcedIp: ANNOUNCED_IP }],
              enableUdp: true, enableTcp: true, preferUdp: true
            });
            const key = `${ws._clientId}_${msg.transportTag}`;
            room.pendingTransports.set(key, transport);
            ws.send(JSON.stringify({
              type: 'consumer-transport-created',
              id: transport.id,
              transportTag: msg.transportTag,
              iceParameters: transport.iceParameters,
              iceCandidates: transport.iceCandidates,
              dtlsParameters: transport.dtlsParameters
            }));
            break;
          }

          case 'connect-consumer-transport': {
            const room = rooms.get(ws._roomId);
            const key = `${ws._clientId}_${msg.transportTag}`;
            const transport = room.pendingTransports.get(key);
            await transport.connect({ dtlsParameters: msg.dtlsParameters });
            ws.send(JSON.stringify({ type: 'consumer-transport-connected', transportTag: msg.transportTag }));
            break;
          }

          case 'consume': {
            const room = rooms.get(ws._roomId);
            const producer = room.producers.get(msg.producerClientId);
            if (!producer) { ws.send(JSON.stringify({ type: 'error', message: 'Producer not found' })); break; }
            const key = `${ws._clientId}_${msg.transportTag}`;
            const transport = room.pendingTransports.get(key);
            const consumer = await transport.consume({
              producerId: producer.id,
              rtpCapabilities: msg.rtpCapabilities,
              paused: false
            });
            room.consumers.set(`${ws._clientId}_${consumer.id}`, consumer);
            room.pendingTransports.delete(key);
            ws.send(JSON.stringify({
              type: 'consumed',
              consumerId: consumer.id,
              producerId: producer.id,
              kind: consumer.kind,
              rtpParameters: consumer.rtpParameters
            }));
            console.log(`[CONSUME] ${ws._clientId} consuming from ${msg.producerClientId}`);
            break;
          }

          case 'resume-consumer': {
            const room = rooms.get(ws._roomId);
            const consumer = room.consumers.get(`${ws._clientId}_${msg.consumerId}`);
            if (consumer) { await consumer.resume(); }
            break;
          }

          default:
            ws.send(JSON.stringify({ type: 'error', message: `Unknown: ${msg.type}` }));
        }
      } catch (err) {
        console.error(`[ERR] ${msg.type}:`, err.message);
        ws.send(JSON.stringify({ type: 'error', message: err.message }));
      }
    });

    ws.on('close', () => { cleanupClient(ws); console.log('[WS] Disconnected'); });
    ws.on('error', () => { cleanupClient(ws); });
  });

  server.listen(PORT, () => console.log(`[SFU] Listening on :${PORT}`));
}

main().catch(err => { console.error(err); process.exit(1); });
