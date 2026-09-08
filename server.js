const { WebSocketServer, WebSocket } = require('ws');

// Render and other cloud hosts provide the port via process.env.PORT
const PORT = process.env.PORT || 8080;
const wss = new WebSocketServer({ port: PORT });

// Store active player sessions in memory: socket -> player data
const clients = new Map();

console.log(`[Universe Relay] Starting WebSocket server on port ${PORT}...`);

wss.on('connection', (ws) => {
  // Generate a quick random ID for this connected player
  const clientId = 'ply_' + Math.random().toString(36).substring(2, 9);

  // Initialize client record
  clients.set(ws, {
    id: clientId,
    sector: 'alpha',
    callsign: 'Unknown Vessel',
    shipClass: 'shuttle',
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    angle: 0,
    thrusting: false
  });

  console.log(`[Connect] Player connected: ${clientId}. Total online: ${clients.size}`);

  // Send the new player their assigned ID
  ws.send(JSON.stringify({
    type: 'WELCOME',
    id: clientId
  }));

  // Handle incoming messages from this browser
  ws.on('message', (rawMessage) => {
    try {
      const data = JSON.parse(rawMessage);
      const clientData = clients.get(ws);
      if (!clientData) return;

      switch (data.type) {
        // Player sends their position/velocity/sector
        case 'PLAYER_UPDATE':
          clientData.sector = data.sector || clientData.sector;
          clientData.callsign = data.callsign || clientData.callsign;
          clientData.shipClass = data.shipClass || clientData.shipClass;
          clientData.x = data.x;
          clientData.y = data.y;
          clientData.vx = data.vx;
          clientData.vy = data.vy;
          clientData.angle = data.angle;
          clientData.thrusting = data.thrusting;
          break;

        // Player fires a weapon or launches ordnance
        case 'WEAPON_FIRED':
          broadcastToSector(ws, clientData.sector, {
            type: 'REMOTE_WEAPON_FIRED',
            sourceId: clientData.id,
            hardpointIndex: data.hardpointIndex,
            originX: data.originX,
            originY: data.originY,
            angle: data.angle,
            weaponKey: data.weaponKey
          });
          break;

        // Player hits another player with weapon fire
           case 'PLAYER_HIT':
             // Forward to victim, and notify sector peers of the shield/hull hit flash
             for (const [targetWs, targetClient] of clients.entries()) {
               if (targetClient.id === data.targetId && targetWs.readyState === WebSocket.OPEN) {
                 targetWs.send(JSON.stringify({
                   type: 'REMOTE_DAMAGE_RECEIVED',
                   attackerId: clientData.id,
                   damage: data.damage,
                   weaponKey: data.weaponKey,
                   hitX: data.hitX,
                   hitY: data.hitY
                 }));
                 break;
               }
             }
             broadcastToSector(ws, clientData.sector, {
               type: 'REMOTE_PEER_HIT',
               targetId: data.targetId,
               hitX: data.hitX,
               hitY: data.hitY
             });
             break;

           // Player ship destroyed in combat
           case 'PLAYER_EXPLODED':
             broadcastToSector(ws, clientData.sector, {
               type: 'REMOTE_PEER_EXPLODED',
               victimId: clientData.id,
               x: data.x,
               y: data.y,
               radius: data.radius
             });
             break;
      }
    } catch (err) {
      // Silently ignore corrupted packets
    }
  });

  // Handle disconnects
  ws.on('close', () => {
    const clientData = clients.get(ws);
    if (clientData) {
      console.log(`[Disconnect] Player departed: ${clientData.id}`);
      // Notify other players in that sector so they remove the ghost ship
      broadcastToSector(ws, clientData.sector, {
        type: 'PLAYER_LEFT',
        id: clientData.id
      });
      clients.delete(ws);
    }
  });

  ws.on('error', () => {
    ws.close();
  });
});

// Helper: Send a packet to everyone in the same sector EXCEPT the sender
function broadcastToSector(senderWs, sectorId, packet) {
  const payload = JSON.stringify(packet);
  for (const [socket, clientData] of clients.entries()) {
    if (socket !== senderWs && clientData.sector === sectorId && socket.readyState === WebSocket.OPEN) {
      socket.send(payload);
    }
  }
}

// 15 Hz Universe Heartbeat: Broadcast sector state snapshots to all players
setInterval(() => {
  if (clients.size === 0) return;

  // Group player snapshots by sector
  const sectorSnapshots = {
    alpha: [],
    beta: [],
    gamma: [],
    delta: []
  };

  for (const clientData of clients.values()) {
       if (sectorSnapshots[clientData.sector]) {
         sectorSnapshots[clientData.sector].push({
           id: clientData.id,
           callsign: clientData.callsign,
           shipClass: clientData.shipClass,
           x: Math.round(clientData.x),
           y: Math.round(clientData.y),
           vx: Math.round(clientData.vx),
           vy: Math.round(clientData.vy),
           angle: Math.round(clientData.angle * 100) / 100,
           thrusting: clientData.thrusting,
           hp: clientData.hp,
           maxHp: clientData.maxHp,
           shieldPercent: clientData.shieldPercent
         });
       }
     }

  // Send each player only the ships in their active sector
  for (const [socket, clientData] of clients.entries()) {
    if (socket.readyState === WebSocket.OPEN) {
      const sectorPlayers = sectorSnapshots[clientData.sector] || [];
      // Filter out the player's own data so they only receive others
      const peers = sectorPlayers.filter(p => p.id !== clientData.id);
      socket.send(JSON.stringify({
        type: 'SECTOR_SNAPSHOT',
        players: peers
      }));
    }
  }
}, 66); // ~15 times per second