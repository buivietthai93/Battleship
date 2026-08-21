require('dotenv').config();
const path = require('path');
const http = require('http');
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const { Server } = require('socket.io');

const db = require('./db');
const { router: authRouter, JWT_SECRET } = require('./auth');
const { SHIPS, validatePlacement, allCells } = require('./game');

const app = express();
app.use(cors());
app.use(express.json());
app.use('/api', authRouter);
app.use(express.static(path.join(__dirname, '..', 'public')));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// ---- In-memory matchmaking + game state -----------------------------
// (Fine for a single server instance. For multiple instances you'd move
// this to Redis or similar.)
let queue = []; // sockets waiting for an opponent
const rooms = new Map(); // roomId -> room state
const codeRooms = new Map(); // roomCode -> host socket (waiting for a second player)

function makeRoomId() {
  return 'room_' + Math.random().toString(36).slice(2, 10);
}

function makeRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I to avoid confusion
  let code;
  do {
    code = Array.from({ length: 5 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (codeRooms.has(code));
  return code;
}

function startGameBetween(p1, p2) {
  const roomId = makeRoomId();
  rooms.set(roomId, {
    players: [p1, p2],
    boards: [null, null],
    ready: [false, false],
    turn: 0,
  });
  p1.roomId = roomId;
  p2.roomId = roomId;

  p1.emit('matched', { roomId, ships: SHIPS, opponent: p2.user.username });
  p2.emit('matched', { roomId, ships: SHIPS, opponent: p1.user.username });
}

function tryMatch() {
  while (queue.length >= 2) {
    const p1 = queue.shift();
    const p2 = queue.shift();
    if (!p1.connected || !p2.connected) continue;
    startGameBetween(p1, p2);
  }
}

io.use((socket, next) => {
  const token = socket.handshake.auth && socket.handshake.auth.token;
  let user = null;
  if (token) {
    try {
      const payload = jwt.verify(token, JWT_SECRET);
      user = { id: payload.id, username: payload.username };
    } catch (e) {
      // invalid/expired token -> fall through to guest
    }
  }
  socket.user = user || { id: null, username: 'Khách' + Math.floor(Math.random() * 10000) };
  next();
});

io.on('connection', (socket) => {
  socket.emit('welcome', { username: socket.user.username, isGuest: !socket.user.id });

  socket.on('join_queue', () => {
    if (queue.includes(socket)) return;
    queue.push(socket);
    socket.emit('queue_joined');
    tryMatch();
  });

  socket.on('leave_queue', () => {
    queue = queue.filter((s) => s !== socket);
  });

  // ---- Play-with-a-friend via room code ----
  socket.on('create_room', () => {
    // Clean up any code this socket was already hosting.
    for (const [code, host] of codeRooms.entries()) {
      if (host === socket) codeRooms.delete(code);
    }
    const code = makeRoomCode();
    codeRooms.set(code, socket);
    socket.emit('room_created', { code });
  });

  socket.on('cancel_room', () => {
    for (const [code, host] of codeRooms.entries()) {
      if (host === socket) codeRooms.delete(code);
    }
  });

  socket.on('join_room', ({ code }) => {
    const normalized = String(code || '').trim().toUpperCase();
    const host = codeRooms.get(normalized);

    if (!host) {
      socket.emit('error_msg', { message: 'Không tìm thấy phòng với mã này.' });
      return;
    }
    if (host === socket) {
      socket.emit('error_msg', { message: 'Bạn không thể tự vào phòng của chính mình.' });
      return;
    }
    if (!host.connected) {
      codeRooms.delete(normalized);
      socket.emit('error_msg', { message: 'Chủ phòng đã rời đi. Thử tạo hoặc vào phòng khác.' });
      return;
    }

    codeRooms.delete(normalized);
    startGameBetween(host, socket);
  });

  socket.on('place_ships', ({ roomId, ships }) => {
    const room = rooms.get(roomId);
    if (!room) return;

    if (!validatePlacement(ships)) {
      socket.emit('error_msg', { message: 'Bố trí tàu không hợp lệ. Kiểm tra lại vị trí.' });
      return;
    }

    const idx = room.players.indexOf(socket);
    if (idx === -1) return;

    room.boards[idx] = {
      ships,
      shotsReceived: new Set(),
      cellsRemaining: allCells(ships),
    };
    room.ready[idx] = true;
    socket.emit('placement_ok');

    if (room.ready[0] && room.ready[1]) {
      room.turn = 0;
      room.players.forEach((p, i) => {
        p.emit('game_start', {
          yourTurn: i === room.turn,
          opponent: room.players[1 - i].user.username,
        });
      });
    }
  });

  socket.on('fire', ({ roomId, x, y }) => {
    const room = rooms.get(roomId);
    if (!room) return;

    const idx = room.players.indexOf(socket);
    if (idx === -1 || room.turn !== idx) return;

    const oppIdx = 1 - idx;
    const oppBoard = room.boards[oppIdx];
    if (!oppBoard) return;

    const key = `${x},${y}`;
    if (oppBoard.shotsReceived.has(key)) return;
    oppBoard.shotsReceived.add(key);

    const isHit = oppBoard.cellsRemaining.has(key);
    if (isHit) oppBoard.cellsRemaining.delete(key);

    let sunkShip = null;
    let sunkShipCells = null;
    if (isHit) {
      const ship = oppBoard.ships.find((s) => s.cells.some((c) => c[0] === x && c[1] === y));
      if (ship && ship.cells.every((c) => oppBoard.shotsReceived.has(`${c[0]},${c[1]}`))) {
        sunkShip = ship.name;
        sunkShipCells = ship.cells;
      }
    }

    const gameOver = oppBoard.cellsRemaining.size === 0;

    room.players.forEach((p, i) => {
      p.emit('fire_result', {
        x,
        y,
        isHit,
        sunkShip,
        sunkShipCells,
        gameOver,
        firedBy: i === idx ? 'you' : 'opponent',
        // Once the fleet is fully sunk, reveal its layout so both players
        // can see where every ship was hiding.
        revealShips: gameOver ? oppBoard.ships : null,
      });
    });

    if (gameOver) {
      const winner = room.players[idx].user;
      const loser = room.players[oppIdx].user;
      if (winner.id) db.incrementWins(winner.id);
      if (loser.id) db.incrementLosses(loser.id);
      rooms.delete(roomId);
    } else if (!isHit) {
      // Turn only passes to the opponent on a miss. A hit earns another shot.
      room.turn = oppIdx;
    }
  });

  socket.on('leave_game', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    const idx = room.players.indexOf(socket);
    if (idx === -1) return;
    room.players[1 - idx].emit('opponent_left');
    rooms.delete(roomId);
  });

  socket.on('disconnect', () => {
    queue = queue.filter((s) => s !== socket);
    for (const [code, host] of codeRooms.entries()) {
      if (host === socket) codeRooms.delete(code);
    }
    if (socket.roomId) {
      const room = rooms.get(socket.roomId);
      if (room) {
        const idx = room.players.indexOf(socket);
        if (idx !== -1) {
          room.players[1 - idx].emit('opponent_left');
        }
        rooms.delete(socket.roomId);
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Battleship server running on port ${PORT}`);
});
