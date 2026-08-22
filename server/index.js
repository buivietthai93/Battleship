require('dotenv').config();
const path = require('path');
const http = require('http');
const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const { Server } = require('socket.io');

const db = require('./db');
const { router: authRouter, JWT_SECRET } = require('./auth');
const { SHIPS, BOARD_SIZE, validatePlacement, allCells, randomShipPlacement } = require('./game');

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

// ---- AI opponent ("play vs computer") --------------------------------
// A lightweight stand-in that behaves like a socket (has .emit/.connected)
// so it can sit in room.players alongside a real player without any of the
// existing room/turn/disconnect logic needing to special-case it.
function createBotPlayer() {
  return {
    id: 'bot-' + Math.random().toString(36).slice(2, 8),
    user: { id: null, username: 'Máy (AI)' },
    connected: true,
    emit: () => {},
  };
}

// Classic "hunt and target" Battleship AI:
// - Hunt mode: fire at a random cell nobody has fired at yet.
// - On a hit, switch to target mode and probe the four neighbours.
// - Once a second hit confirms an axis (row or column), keep firing along
//   that line in the same direction until it misses or the ship sinks.
// - On a miss while chasing a confirmed direction, jump to the opposite
//   side of the original hit and continue from there.
// - Once the ship sinks, forget everything and go back to hunting randomly.
function createBotAI() {
  return {
    mode: 'hunt',
    queue: [],
    origin: null,
    direction: null,

    chooseShot(shotsReceived) {
      const isFree = ([x, y]) =>
        x >= 0 && x < BOARD_SIZE && y >= 0 && y < BOARD_SIZE && !shotsReceived.has(`${x},${y}`);

      while (this.queue.length) {
        const next = this.queue.shift();
        if (isFree(next)) return next;
      }

      this.mode = 'hunt';
      const candidates = [];
      for (let x = 0; x < BOARD_SIZE; x++) {
        for (let y = 0; y < BOARD_SIZE; y++) {
          if (isFree([x, y])) candidates.push([x, y]);
        }
      }
      return candidates[Math.floor(Math.random() * candidates.length)];
    },

    reportResult(x, y, isHit, sunk) {
      if (sunk) {
        this.mode = 'hunt';
        this.queue = [];
        this.origin = null;
        this.direction = null;
        return;
      }

      if (!isHit) {
        if (this.mode === 'target' && this.direction && this.origin) {
          const [dx, dy] = this.direction;
          const back = [this.origin[0] - dx, this.origin[1] - dy];
          this.direction = [-dx, -dy];
          this.queue = [back];
        }
        return;
      }

      if (this.mode === 'hunt') {
        this.mode = 'target';
        this.origin = [x, y];
        this.direction = null;
        this.queue = [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]];
      } else if (!this.direction && this.origin) {
        this.direction = [x - this.origin[0], y - this.origin[1]];
        const [dx, dy] = this.direction;
        this.queue = [[x + dx, y + dy]];
      } else if (this.direction) {
        const [dx, dy] = this.direction;
        this.queue = [[x + dx, y + dy]];
      }
    },
  };
}

function scheduleBotShot(roomId) {
  const delay = process.env.BOT_DELAY_MS ? Number(process.env.BOT_DELAY_MS) : 1500;
  setTimeout(() => {
    const room = rooms.get(roomId);
    if (!room || !room.isBot || room.turn !== 1) return;
    const humanBoard = room.boards[0];
    if (!humanBoard) return;

    const [x, y] = room.botAI.chooseShot(humanBoard.shotsReceived);
    const result = resolveShot(room, roomId, 1, x, y);
    if (!result) return;
    room.botAI.reportResult(x, y, result.isHit, !!result.sunkShip);

    if (!result.gameOver && rooms.get(roomId) && rooms.get(roomId).turn === 1) {
      // The bot hit something and earns another shot.
      scheduleBotShot(roomId);
    }
  }, delay);
}

// Resolves a single shot against whichever board the shooter is targeting,
// broadcasts the result, and updates turn/DB/room bookkeeping. Shared by
// both the real 'fire' socket handler and the AI's own moves.
function resolveShot(room, roomId, shooterIdx, x, y) {
  const oppIdx = 1 - shooterIdx;
  const oppBoard = room.boards[oppIdx];
  if (!oppBoard) return null;

  const key = `${x},${y}`;
  if (oppBoard.shotsReceived.has(key)) return null;
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
    // At game over, tell each player the full layout of THEIR opponent —
    // not just whichever side happened to lose. The winner already got
    // this via the old logic; now the loser gets to see the winner's
    // fleet too, including ships/cells they never even fired at.
    const revealShips = gameOver
      ? (i === shooterIdx ? oppBoard.ships : room.boards[shooterIdx].ships)
      : null;

    p.emit('fire_result', {
      x,
      y,
      isHit,
      sunkShip,
      sunkShipCells,
      gameOver,
      firedBy: i === shooterIdx ? 'you' : 'opponent',
      revealShips,
    });
  });

  if (gameOver) {
    const winner = room.players[shooterIdx].user;
    const loser = room.players[oppIdx].user;
    if (winner.id) db.incrementWins(winner.id);
    if (loser.id) db.incrementLosses(loser.id);
    rooms.delete(roomId);
  } else if (!isHit) {
    room.turn = oppIdx;
  }

  return { isHit, sunkShip, gameOver };
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

  // ---- Play vs computer ----
  socket.on('play_vs_ai', () => {
    const roomId = makeRoomId();
    const botPlayer = createBotPlayer();
    const botShips = randomShipPlacement();

    rooms.set(roomId, {
      players: [socket, botPlayer],
      boards: [null, { ships: botShips, shotsReceived: new Set(), cellsRemaining: allCells(botShips) }],
      ready: [false, true],
      turn: 0,
      isBot: true,
      botAI: createBotAI(),
    });
    socket.roomId = roomId;

    socket.emit('matched', { roomId, ships: SHIPS, opponent: 'Máy (AI)' });
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

    const result = resolveShot(room, roomId, idx, x, y);
    if (!result) return;

    if (room.isBot && !result.gameOver && room.turn === 1) {
      scheduleBotShot(roomId);
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