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
        // Player switched sectors via jump gate
        case 'SECTOR_CHANGE': {
          const oldSector = clientData.sector;
          const newSector = data.newSector;
          if (oldSector !== newSector) {
            broadcastToSector(ws, oldSector, {
              type: 'PLAYER_LEFT',
              id: clientData.id
            });
            clientData.sector = newSector;
          }
          break;
        }

        // Player broadcast text message to current sector
        case 'PLAYER_CHAT': {
          const rawText = String(data.text || '').trim().slice(0, 140);
          if (rawText.length > 0) {
            broadcastToSector(ws, clientData.sector, {
              type: 'REMOTE_CHAT_MESSAGE',
              senderId: clientData.id,
              callsign: clientData.callsign || 'Unknown Pilot',
              text: rawText
            });
          }
          break;
        }

        // Player respawned in a fresh vessel
        case 'PLAYER_RESPAWNED': {
          const oldSector = clientData.sector;
          const newSector = data.sector || 'alpha';
          if (oldSector !== newSector) {
            broadcastToSector(ws, oldSector, {
              type: 'PLAYER_LEFT',
              id: clientData.id
            });
          }
          clientData.isDead = false;
          clientData.sector = newSector;
          clientData.callsign = data.callsign || clientData.callsign;
          clientData.shipClass = data.shipClass || 'shuttle';
          clientData.liveryIndex = data.liveryIndex !== undefined ? data.liveryIndex : clientData.liveryIndex;
          clientData.turretAngles = [];
          clientData.criminalRating = data.criminalRating !== undefined ? data.criminalRating : 0;
          clientData.isDocked = true;
          clientData.dockedStationId = data.dockedStationId || null;
          clientData.dockedPortId = data.dockedPortId || null;
          clientData.x = data.x;
          clientData.y = data.y;
          clientData.vx = 0;
          clientData.vy = 0;
          clientData.angle = data.angle || 0;
          clientData.thrusting = false;
          clientData.hp = data.hp;
          clientData.maxHp = data.maxHp;
          clientData.shieldPercent = 100;
          clientData.hullPercent = 100;
          break;
        }

        // Player sends their position/velocity/sector/telemetry
        case 'PLAYER_UPDATE':
          clientData.sector = data.sector || clientData.sector;
          clientData.callsign = data.callsign || clientData.callsign;
          clientData.shipClass = data.shipClass || clientData.shipClass;
          clientData.liveryIndex = data.liveryIndex !== undefined ? data.liveryIndex : clientData.liveryIndex;
          clientData.turretAngles = Array.isArray(data.turretAngles) ? data.turretAngles : [];
          clientData.criminalRating = data.criminalRating !== undefined ? data.criminalRating : clientData.criminalRating;
          clientData.isDocked = Boolean(data.isDocked);
          clientData.dockedStationId = data.dockedStationId || null;
          clientData.dockedPortId = data.dockedPortId || null;
          clientData.x = data.x;
          clientData.y = data.y;
          clientData.vx = data.vx;
          clientData.vy = data.vy;
          clientData.angle = data.angle;
          clientData.thrusting = data.thrusting;
          clientData.hp = data.hp;
          clientData.maxHp = data.maxHp;
          clientData.shieldPercent = data.shieldPercent;
          clientData.hullPercent = data.hullPercent;
          clientData.isDead = (data.hp !== undefined && data.hp <= 0) || (data.hullPercent !== undefined && data.hullPercent <= 0);
          break;

        // Player fires a weapon or launches ordnance
        case 'WEAPON_FIRED':
          broadcastToSector(ws, clientData.sector, {
            type: 'REMOTE_WEAPON_FIRED',
            sourceId: clientData.id,
            targetId: data.targetId || null,
            hardpointIndex: data.hardpointIndex,
            originX: data.originX,
            originY: data.originY,
            angle: data.angle,
            weaponKey: data.weaponKey
          });
          break;

        // Player hits another player with weapon fire
           case 'PLAYER_HIT':
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
             // Broadcast hit flash to EVERYONE in sector (including the shooter!)
             for (const [socket, peer] of clients.entries()) {
               if (peer.sector === clientData.sector && socket.readyState === WebSocket.OPEN) {
                 socket.send(JSON.stringify({
                   type: 'REMOTE_PEER_HIT',
                   targetId: data.targetId,
                   hitX: data.hitX,
                   hitY: data.hitY
                 }));
               }
             }
             break;

           // Player ship destroyed in combat
        case 'PLAYER_EXPLODED':
          clientData.isDead = true;
          clientData.hp = 0;
          clientData.hullPercent = 0;
          clientData.shieldPercent = 0;
          broadcastToSector(ws, clientData.sector, {
            type: 'REMOTE_PEER_EXPLODED',
            victimId: clientData.id,
            victimCallsign: clientData.callsign || 'Unknown Pilot',
            killerCallsign: data.killerCallsign || null,
            x: data.x,
            y: data.y,
            radius: data.radius,
            cargoDrops: Array.isArray(data.cargoDrops) ? data.cargoDrops : []
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
    delta: [],
    echo: [],
    epsilon: []
  };

  for (const clientData of clients.values()) {
       if (clientData.isDead) continue; // Skip destroyed ships
       if (sectorSnapshots[clientData.sector]) {
         sectorSnapshots[clientData.sector].push({
           id: clientData.id,
           callsign: clientData.callsign,
           shipClass: clientData.shipClass,
           liveryIndex: clientData.liveryIndex !== undefined ? clientData.liveryIndex : 0,
           turretAngles: clientData.turretAngles || [],
           criminalRating: clientData.criminalRating || 0,
           isDocked: Boolean(clientData.isDocked),
           dockedStationId: clientData.dockedStationId || null,
           dockedPortId: clientData.dockedPortId || null,
           x: Math.round(clientData.x),
           y: Math.round(clientData.y),
           vx: Math.round(clientData.vx),
           vy: Math.round(clientData.vy),
           angle: Math.round(clientData.angle * 100) / 100,
           thrusting: clientData.thrusting,
           hp: clientData.hp,
           maxHp: clientData.maxHp,
           shieldPercent: clientData.shieldPercent,
           hullPercent: clientData.hullPercent
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