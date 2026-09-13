const { WebSocketServer, WebSocket } = require('ws');

// Render and other cloud hosts provide the port via process.env.PORT
const PORT = process.env.PORT || 8080;
const wss = new WebSocketServer({ port: PORT });

// Store active player sessions in memory: socket -> player data
const clients = new Map();

// Track host election timestamps per sector to prevent rapid migration thrashing
const sectorElectionTimes = new Map();

console.log(`[Universe Relay] Starting WebSocket server on port ${PORT}...`);

wss.on('connection', (ws) => {
  // Generate a quick random ID for this connected player
  const clientId = 'ply_' + Math.random().toString(36).substring(2, 9);

  // Determine if this connection is the first active player in the starting sector
  let existingAlphaHost = false;
  for (const c of clients.values()) {
    if (c.sector === 'alpha' && c.isSectorHost) {
      existingAlphaHost = true;
      break;
    }
  }
  const isInitialHost = !existingAlphaHost;

  // Initialize client record
  clients.set(ws, {
    id: clientId,
    sector: 'alpha',
    isSectorHost: isInitialHost,
    lastAiSnapshotTime: Date.now(),
    isTabHidden: false,
    callsign: 'Unknown Vessel',
    shipClass: 'shuttle',
    fps: 60,
    ping: 30,
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    angle: 0,
    thrusting: false
  });

  console.log(`[Connect] Player connected: ${clientId} (Host: ${isInitialHost}). Total online: ${clients.size}`);

  // Send the new player their assigned ID and explicit authority flag
  ws.send(JSON.stringify({
    type: 'WELCOME',
    id: clientId,
    isHost: isInitialHost
  }));

  // Handle incoming messages from this browser
  ws.on('message', (rawMessage) => {
    try {
      const data = JSON.parse(rawMessage);
      const clientData = clients.get(ws);
      if (!clientData) return;

      switch (data.type) {
        case 'ATC_REQUEST':
        case 'ATC_RESPONSE': {
          if (data.type === 'ATC_RESPONSE' && data.targetId === 'HOST') {
            let targetSector = 'alpha';
            for (const c of clients.values()) {
              if (c.id === data.hostId) { targetSector = c.sector; break; }
            }
            for (const [targetWs, targetClient] of clients.entries()) {
              if (targetClient.sector === targetSector && targetClient.isSectorHost && targetWs.readyState === WebSocket.OPEN) {
                targetWs.send(JSON.stringify(data));
                break;
              }
            }
          } else {
            for (const [targetWs, targetClient] of clients.entries()) {
              if (targetClient.id === data.targetId && targetWs.readyState === WebSocket.OPEN) {
                targetWs.send(JSON.stringify(data));
                break;
              }
            }
          }
          break;
        }

        case 'PING': {
          ws.send(JSON.stringify({ type: 'PONG', clientTime: data.clientTime }));
          break;
        }

        // Player switched sectors via jump gate
        case 'SECTOR_CHANGE': {
          const oldSector = clientData.sector;
          const newSector = data.newSector;
          if (oldSector !== newSector) {
            const wasHost = clientData.isSectorHost;
            clientData.isSectorHost = false;
            broadcastToSector(ws, oldSector, {
              type: 'PLAYER_LEFT',
              id: clientData.id
            });
            clientData.sector = newSector;
            if (wasHost) {
              electSectorHost(oldSector);
            }
            electSectorHost(newSector);
          }
          break;
        }

        // Authority Host streams live sector AI state snapshot, station rotation, and ports
        case 'HOST_AI_SNAPSHOT': {
          if (clientData.isSectorHost) {
            clientData.lastAiSnapshotTime = Date.now();
            broadcastToSector(ws, clientData.sector, {
              type: 'REMOTE_AI_SNAPSHOT',
              stationAngle: data.stationAngle,
              stationRotSpeed: data.stationRotSpeed,
              stationPorts: Array.isArray(data.stationPorts) ? data.stationPorts : [],
              ships: Array.isArray(data.ships) ? data.ships : [],
              asteroids: Array.isArray(data.asteroids) ? data.asteroids : []
            });
          }
          break;
        }

        // Host relays AI weapon discharges (lasers, turrets, missiles) to sector peers
        case 'HOST_AI_FIRE': {
          // Allow replicas to broadcast weapon fire for their own local hired escorts
          broadcastToSector(ws, clientData.sector, {
            ...data,
            type: 'REMOTE_AI_FIRE'
          });
          break;
        }

        // Host broadcasts spawned cargo crates from destroyed vessels
        case 'HOST_CARGO_SPAWN': {
          if (clientData.isSectorHost) {
            broadcastToSector(ws, clientData.sector, {
              ...data,
              type: 'REMOTE_CARGO_SPAWN'
            });
          }
          break;
        }

        // Capital ship jumping to a new sector instructs its passengers to jump with it
        case 'CARRIER_JUMP_PASSENGERS': {
          const passengers = data.passengerIds || [];
          for (const [targetWs, targetClient] of clients.entries()) {
            if (passengers.includes(targetClient.id) && targetWs.readyState === WebSocket.OPEN) {
              targetWs.send(JSON.stringify({
                type: 'HOST_CARRIER_JUMPED',
                targetSector: data.targetSector,
                carrierId: clientData.id
              }));
            }
          }
          break;
        }

        // Host broadcasts NPC messages/scan results to non-host players
        case 'HOST_NPC_MESSAGE': {
          if (clientData.isSectorHost) {
            broadcastToSector(ws, clientData.sector, {
              ...data,
              type: 'REMOTE_NPC_MESSAGE'
            });
          }
          break;
        }

        // Host broadcasts shattered asteroid destruction event
        case 'HOST_ASTEROID_DESTROYED': {
          if (clientData.isSectorHost) {
            broadcastToSector(ws, clientData.sector, {
              ...data,
              type: 'REMOTE_ASTEROID_DESTROYED'
            });
          }
          break;
        }

        // Any player scoops a cargo crate
        case 'PLAYER_COLLECT_CARGO': {
          broadcastToSector(ws, clientData.sector, {
            ...data,
            type: 'REMOTE_CARGO_COLLECTED'
          });
          break;
        }

        // Host voluntarily yields authority (e.g. tab minimized or backgrounded)
        case 'HOST_YIELD': {
          if (clientData.isSectorHost) {
            console.log(`[Host Migration] Host ${clientData.id} yielded authority (tab blurred/hidden).`);
            clientData.isSectorHost = false;
            clientData.isTabHidden = true;
            ws.send(JSON.stringify({ type: 'HOST_DEMOTED', sector: clientData.sector }));
            electSectorHost(clientData.sector);
          } else {
            clientData.isTabHidden = true;
          }
          break;
        }

        // Client returned to focus
        case 'HOST_RESUME': {
          clientData.isTabHidden = false;
          // If sector currently lacks an active host, elect immediately
          electSectorHost(clientData.sector);
          break;
        }

        // Player broadcast text message globally across all sectors 💬✨
        case 'PLAYER_CHAT': {
          const rawText = String(data.text || '').trim().slice(0, 140);
          if (rawText.length > 0) {
            broadcastGlobal(ws, {
              type: 'REMOTE_CHAT_MESSAGE',
              senderId: clientData.id,
              callsign: clientData.callsign || 'Unknown Pilot',
              liveryIndex: clientData.liveryIndex !== undefined ? clientData.liveryIndex : 0,
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
          clientData.weaponKeys = Array.isArray(data.weaponKeys) ? data.weaponKeys : clientData.weaponKeys;
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

          if (!clientData.hasAnnouncedJoin && clientData.callsign && clientData.callsign !== 'Unknown Vessel') {
            clientData.hasAnnouncedJoin = true;
            broadcastGlobal(ws, {
              type: 'SYSTEM_ANNOUNCEMENT',
              text: `${clientData.callsign} joined the universe`
            });
          }
          break;
        }

        // Player sends their position/velocity/sector/telemetry
        case 'PLAYER_UPDATE': {
          const prevSector = clientData.sector;
          clientData.sector = data.sector || clientData.sector;
          clientData.callsign = data.callsign || clientData.callsign;
          clientData.weaponKeys = Array.isArray(data.weaponKeys) ? data.weaponKeys : clientData.weaponKeys;

          if (!clientData.hasAnnouncedJoin && clientData.callsign && clientData.callsign !== 'Unknown Vessel') {
            clientData.hasAnnouncedJoin = true;
            broadcastGlobal(ws, {
              type: 'SYSTEM_ANNOUNCEMENT',
              text: `${clientData.callsign} joined the universe`
            });
          }
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
          clientData.ports = Array.isArray(data.ports) ? data.ports : clientData.ports;
          clientData.escorts = Array.isArray(data.escorts) ? data.escorts : [];
          if (data.fps !== undefined) clientData.fps = Number(data.fps) || 60;
          if (data.ping !== undefined) clientData.ping = Number(data.ping) || 30;
          clientData.isDead = (data.hp !== undefined && data.hp <= 0) || (data.hullPercent !== undefined && data.hullPercent <= 0);

          // Verify sector host authority election
          if (!clientData.hasRegistered) {
            clientData.hasRegistered = true;
            electSectorHost(clientData.sector);
          } else if (prevSector !== clientData.sector) {
            electSectorHost(prevSector);
            electSectorHost(clientData.sector);
          }
          break;
        }

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
      const departedSector = clientData.sector;
      console.log(`[Disconnect] Player departed: ${clientData.id}`);
      
      if (clientData.hasAnnouncedJoin && clientData.callsign) {
        broadcastGlobal(ws, {
          type: 'SYSTEM_ANNOUNCEMENT',
          text: `${clientData.callsign} left the universe`
        });
      }

      // Notify other players in that sector so they remove the ghost ship
      broadcastToSector(ws, departedSector, {
        type: 'PLAYER_LEFT',
        id: clientData.id
      });
      clients.delete(ws);
      electSectorHost(departedSector);
    }
  });

  ws.on('error', () => {
    ws.close();
  });
});

// Calculate connection quality score (Higher FPS + Lower Ping = Better Host Authority)
function calculateHostFitness(client) {
  const fps = Math.max(10, Math.min(144, client.fps || 60));
  const ping = Math.max(1, Math.min(800, client.ping || 40));
  return (fps * 2.0) - ping;
}

// Helper: Elect or migrate AI authority host based on lowest ping & highest stable framerate
function electSectorHost(sectorId) {
  const sectorClients = [];
  let currentHost = null;

  for (const [socket, clientData] of clients.entries()) {
    if (clientData.sector === sectorId && socket.readyState === WebSocket.OPEN && !clientData.isTabHidden && !clientData.isDead) {
      sectorClients.push({ socket, clientData });
      if (clientData.isSectorHost) {
        currentHost = clientData;
      }
    }
  }

  if (sectorClients.length === 0) {
    sectorElectionTimes.delete(sectorId);
    return;
  }

  // Rank clients by fitness score (highest FPS, lowest ping first)
  sectorClients.sort((a, b) => calculateHostFitness(b.clientData) - calculateHostFitness(a.clientData));
  const optimalCandidate = sectorClients[0];

  const now = Date.now();
  const lastElection = sectorElectionTimes.get(sectorId) || 0;

  // If a healthy host is active, enforce a 50-point hysteresis buffer and a 20-second migration cooldown
  if (currentHost && !currentHost.isTabHidden && !currentHost.isDead) {
    const currentScore = calculateHostFitness(currentHost);
    const optimalScore = calculateHostFitness(optimalCandidate.clientData);

    if (optimalCandidate.clientData !== currentHost) {
      const scoreLead = optimalScore - currentScore;
      const isCooldownActive = (now - lastElection) < 20000;

      if (scoreLead < 50 || isCooldownActive) {
        return;
      }
    }
  }

  const newHost = optimalCandidate;
  if (currentHost !== newHost.clientData) {
    sectorElectionTimes.set(sectorId, now);
    if (currentHost) currentHost.isSectorHost = false;
    newHost.clientData.isSectorHost = true;
    console.log(`[Host Migration] Promoted ${newHost.clientData.id} to AI authority for sector ${sectorId} (FPS: ${newHost.clientData.fps}, Ping: ${newHost.clientData.ping}ms)`);
    newHost.socket.send(JSON.stringify({
      type: 'HOST_PROMOTED',
      sector: sectorId
    }));
  }

  // Demote any duplicate host nodes
  for (let i = 0; i < sectorClients.length; i++) {
    const item = sectorClients[i];
    if (item.clientData !== newHost.clientData && item.clientData.isSectorHost) {
      item.clientData.isSectorHost = false;
      item.socket.send(JSON.stringify({
        type: 'HOST_DEMOTED',
        sector: sectorId
      }));
    }
  }
}

// Helper: Send a packet to EVERY connected client EXCEPT the sender, globally across all sectors 🌐✨
function broadcastGlobal(senderWs, packet) {
  const payload = JSON.stringify(packet);
  for (const [socket, clientData] of clients.entries()) {
    if (socket !== senderWs && socket.readyState === WebSocket.OPEN) {
      socket.send(payload);
    }
  }
}

// Helper: Send a packet to everyone in the same sector EXCEPT the sender
function broadcastToSector(senderWs, sectorId, packet) {
  const payload = JSON.stringify(packet);
  for (const [socket, clientData] of clients.entries()) {
    if (socket !== senderWs && clientData.sector === sectorId && socket.readyState === WebSocket.OPEN) {
      socket.send(payload);
    }
  }
}

// Watchdog: detect if active sector host stalled or tab-throttled (>3.0s without AI snapshot)
setInterval(() => {
  const now = Date.now();
  for (const [socket, clientData] of clients.entries()) {
    if (clientData.isSectorHost && !clientData.isTabHidden) {
      if (now - (clientData.lastAiSnapshotTime || now) > 3000) {
        console.log(`[Host Watchdog] Host ${clientData.id} stalled in sector ${clientData.sector}. Migrating...`);
        clientData.isSectorHost = false;
        socket.send(JSON.stringify({ type: 'HOST_DEMOTED', sector: clientData.sector }));
        electSectorHost(clientData.sector);
      }
    }
  }
}, 1000);

// 15 Hz sector telemetry broadcast loop
setInterval(() => {
  if (clients.size === 0) return;

  // Group player snapshots dynamically by active sector
  const sectorSnapshots = new Map();

  for (const clientData of clients.values()) {
    if (clientData.isDead) continue; // Skip destroyed ships
    const sec = clientData.sector || 'alpha';
    let bucket = sectorSnapshots.get(sec);
    if (!bucket) {
      bucket = [];
      sectorSnapshots.set(sec, bucket);
    }
    bucket.push({
      id: clientData.id,
      callsign: clientData.callsign,
      shipClass: clientData.shipClass,
      liveryIndex: clientData.liveryIndex !== undefined ? clientData.liveryIndex : 0,
      weaponKeys: clientData.weaponKeys || [],
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
      hullPercent: clientData.hullPercent,
      ports: clientData.ports || null,
      escorts: clientData.escorts || []
    });
  }

  // Compile a global list of all online pilots for the Universe Roster
    const universeRoster = [];
    for (const cData of clients.values()) {
      if (cData.callsign && cData.callsign !== 'Unknown Vessel') {
        universeRoster.push(cData.callsign);
      }
    }

    // Send each player only the ships in their active sector + global roster
    for (const [socket, clientData] of clients.entries()) {
      if (socket.readyState === WebSocket.OPEN) {
        const sectorPlayers = sectorSnapshots.get(clientData.sector) || [];
        const peers = sectorPlayers.filter(p => p.id !== clientData.id);
        socket.send(JSON.stringify({
          type: 'SECTOR_SNAPSHOT',
          players: peers,
          universeRoster: universeRoster
        }));
      }
    }
}, 66); // ~15 times per second 