(() => {
  const BOARD_SIZE = 10;
  const COL_LABELS = Array.from({ length: BOARD_SIZE }, (_, i) => String(i + 1));
  const ROW_LABELS = Array.from({ length: BOARD_SIZE }, (_, i) => String.fromCharCode(65 + i));

  const state = {
    token: localStorage.getItem('bs_token') || null,
    username: localStorage.getItem('bs_username') || null,
    wins: 0,
    losses: 0,
    socket: null,
    roomId: null,
    shipsToPlace: [],
    placedShips: {}, // name -> { cells: [[x,y]...] }
    selectedShip: null,
    orientation: 'h', // 'h' | 'v'
    myTurn: false,
    ownShipCells: new Set(), // "x,y" for quick lookup during battle
  };

  // ---------------- Utility ----------------
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  function showScreen(id) {
    $$('.screen').forEach((s) => s.classList.remove('active'));
    $(`#${id}`).classList.add('active');
  }

  function toast(message, ms = 3200) {
    const el = $('#toast');
    el.textContent = message;
    el.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { el.hidden = true; }, ms);
  }

  function apiBase() {
    return window.location.origin;
  }

  // ---------------- Auth screen ----------------
  $$('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      $$('.tab-btn').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      const tab = btn.dataset.tab;
      $('#form-login').hidden = tab !== 'login';
      $('#form-register').hidden = tab !== 'register';
    });
  });

  $('#form-login').addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = $('#login-username').value.trim();
    const password = $('#login-password').value;
    $('#login-error').textContent = '';
    try {
      const res = await fetch(`${apiBase()}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json();
      if (!res.ok) { $('#login-error').textContent = data.error || 'Đăng nhập thất bại.'; return; }
      onAuthSuccess(data);
    } catch (err) {
      $('#login-error').textContent = 'Không kết nối được máy chủ.';
    }
  });

  $('#form-register').addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = $('#register-username').value.trim();
    const password = $('#register-password').value;
    $('#register-error').textContent = '';
    try {
      const res = await fetch(`${apiBase()}/api/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json();
      if (!res.ok) { $('#register-error').textContent = data.error || 'Tạo tài khoản thất bại.'; return; }
      onAuthSuccess(data);
    } catch (err) {
      $('#register-error').textContent = 'Không kết nối được máy chủ.';
    }
  });

  $('#btn-guest').addEventListener('click', () => {
    state.token = null;
    state.username = null;
    connectSocket();
    showScreen('screen-lobby');
  });

  $('#btn-logout').addEventListener('click', () => {
    localStorage.removeItem('bs_token');
    localStorage.removeItem('bs_username');
    if (state.socket) state.socket.disconnect();
    state.token = null;
    state.username = null;
    $('#topbar-user').hidden = true;
    showScreen('screen-auth');
  });

  function onAuthSuccess(data) {
    state.token = data.token;
    state.username = data.username;
    state.wins = data.wins || 0;
    state.losses = data.losses || 0;
    localStorage.setItem('bs_token', data.token);
    localStorage.setItem('bs_username', data.username);
    updateTopbar();
    connectSocket();
    showScreen('screen-lobby');
  }

  function updateTopbar() {
    if (!state.username) { $('#topbar-user').hidden = true; return; }
    $('#topbar-user').hidden = false;
    $('#user-name-display').textContent = state.username;
    $('#user-stats-display').textContent = `${state.wins}T - ${state.losses}B`;
  }

  // ---------------- Socket connection ----------------
  function connectSocket() {
    if (state.socket) state.socket.disconnect();
    state.socket = io({ auth: { token: state.token || undefined } });
    const s = state.socket;

    s.on('welcome', ({ username, isGuest }) => {
      if (isGuest) {
        state.username = username;
        updateTopbar();
      }
    });

    s.on('queue_joined', () => {
      $('#lobby-idle').hidden = true;
      $('#lobby-searching').hidden = false;
    });

    s.on('matched', ({ roomId, ships, opponent }) => {
      state.roomId = roomId;
      state.shipsToPlace = ships;
      state.placedShips = {};
      state.selectedShip = null;
      $('#placement-opponent-name').textContent = opponent;
      $('#placement-waiting').hidden = true;
      $('#placement-error').textContent = '';
      buildPlacementScreen();
      showScreen('screen-placement');
    });

    s.on('placement_ok', () => {
      $('#placement-waiting').hidden = false;
      $('#btn-confirm-place').disabled = true;
    });

    s.on('error_msg', ({ message }) => {
      $('#placement-error').textContent = message;
      toast(message);
    });

    s.on('game_start', ({ yourTurn, opponent }) => {
      state.myTurn = yourTurn;
      $('#battle-opponent-name').textContent = opponent;
      buildBattleScreen();
      setTurnIndicator();
      showScreen('screen-battle');
    });

    s.on('fire_result', (result) => handleFireResult(result));

    s.on('opponent_left', () => {
      toast('Đối thủ đã rời trận. Bạn được xem là người thắng.');
      resetToLobby();
    });

    s.on('connect_error', () => {
      toast('Không thể kết nối máy chủ trò chơi.');
    });
  }

  // ---------------- Lobby ----------------
  $('#btn-find-match').addEventListener('click', () => {
    state.socket.emit('join_queue');
  });

  $('#btn-cancel-queue').addEventListener('click', () => {
    state.socket.emit('leave_queue');
    $('#lobby-idle').hidden = false;
    $('#lobby-searching').hidden = true;
  });

  function resetToLobby() {
    state.roomId = null;
    $('#lobby-idle').hidden = false;
    $('#lobby-searching').hidden = true;
    showScreen('screen-lobby');
  }

  // ---------------- Placement screen ----------------
  function buildPlacementScreen() {
    // Ship tray
    const tray = $('#ship-tray');
    tray.innerHTML = '';
    state.shipsToPlace.forEach((ship) => {
      const item = document.createElement('div');
      item.className = 'ship-tray-item';
      item.dataset.name = ship.name;
      const dots = Array.from({ length: ship.size }, () => '<span></span>').join('');
      item.innerHTML = `<span>${shipLabel(ship.name)} (${ship.size})</span><span class="ship-dots">${dots}</span>`;
      item.addEventListener('click', () => selectShip(ship.name));
      tray.appendChild(item);
    });

    // Labels
    buildAxisLabels('place-labels-x', 'place-labels-y');

    // Grid
    const grid = $('#grid-place');
    grid.innerHTML = '';
    for (let y = 0; y < BOARD_SIZE; y++) {
      for (let x = 0; x < BOARD_SIZE; x++) {
        const cell = document.createElement('div');
        cell.className = 'cell';
        cell.dataset.x = x;
        cell.dataset.y = y;
        cell.addEventListener('mouseenter', () => previewPlacement(x, y));
        cell.addEventListener('mouseleave', clearPreview);
        cell.addEventListener('click', () => attemptPlace(x, y));
        grid.appendChild(cell);
      }
    }

    $('#btn-confirm-place').disabled = true;
    $('#placement-waiting').hidden = true;
    selectShip(state.shipsToPlace[0].name);
  }

  function shipLabel(name) {
    const map = {
      Carrier: 'Tàu sân bay',
      Battleship: 'Thiết giáp hạm',
      Cruiser: 'Tuần dương hạm',
      Submarine: 'Tàu ngầm',
      Destroyer: 'Khu trục hạm',
    };
    return map[name] || name;
  }

  function selectShip(name) {
    if (state.placedShips[name]) return; // already placed, pick another
    state.selectedShip = name;
    $$('.ship-tray-item').forEach((el) => {
      el.classList.toggle('selected', el.dataset.name === name);
    });
  }

  function shipSize(name) {
    return state.shipsToPlace.find((s) => s.name === name).size;
  }

  function computeCells(x, y, size, orientation) {
    const cells = [];
    for (let i = 0; i < size; i++) {
      cells.push(orientation === 'h' ? [x + i, y] : [x, y + i]);
    }
    return cells;
  }

  function cellsValid(cells, ignoreShipName) {
    const occupied = new Set();
    Object.entries(state.placedShips).forEach(([name, ship]) => {
      if (name === ignoreShipName) return;
      ship.cells.forEach(([cx, cy]) => occupied.add(`${cx},${cy}`));
    });
    return cells.every(([cx, cy]) => {
      if (cx < 0 || cx >= BOARD_SIZE || cy < 0 || cy >= BOARD_SIZE) return false;
      if (occupied.has(`${cx},${cy}`)) return false;
      return true;
    });
  }

  function previewPlacement(x, y) {
    if (!state.selectedShip) return;
    clearPreview();
    const size = shipSize(state.selectedShip);
    const cells = computeCells(x, y, size, state.orientation);
    const valid = cellsValid(cells, state.selectedShip);
    cells.forEach(([cx, cy]) => {
      if (cx < 0 || cx >= BOARD_SIZE || cy < 0 || cy >= BOARD_SIZE) return;
      const cell = gridCell('grid-place', cx, cy);
      if (cell) cell.classList.add(valid ? 'ship-preview' : 'ship-preview-invalid');
    });
  }

  function clearPreview() {
    $$('#grid-place .cell').forEach((c) => {
      c.classList.remove('ship-preview', 'ship-preview-invalid');
    });
  }

  function attemptPlace(x, y) {
    if (!state.selectedShip) return;
    const size = shipSize(state.selectedShip);
    const cells = computeCells(x, y, size, state.orientation);
    if (!cellsValid(cells, state.selectedShip)) return;

    state.placedShips[state.selectedShip] = { cells };
    renderPlacedShips();

    const trayItem = document.querySelector(`.ship-tray-item[data-name="${state.selectedShip}"]`);
    if (trayItem) trayItem.classList.add('placed');

    const next = state.shipsToPlace.find((s) => !state.placedShips[s.name]);
    state.selectedShip = next ? next.name : null;
    if (state.selectedShip) selectShip(state.selectedShip);
    else $$('.ship-tray-item').forEach((el) => el.classList.remove('selected'));

    $('#btn-confirm-place').disabled = Object.keys(state.placedShips).length !== state.shipsToPlace.length;
  }

  function renderPlacedShips() {
    $$('#grid-place .cell').forEach((c) => c.classList.remove('ship'));
    Object.values(state.placedShips).forEach((ship) => {
      ship.cells.forEach(([x, y]) => {
        const cell = gridCell('grid-place', x, y);
        if (cell) cell.classList.add('ship');
      });
    });
  }

  $('#btn-rotate').addEventListener('click', () => {
    state.orientation = state.orientation === 'h' ? 'v' : 'h';
  });

  document.addEventListener('keydown', (e) => {
    if (e.key.toLowerCase() !== 'r') return;
    if (!$('#screen-placement').classList.contains('active')) return;
    if (!state.selectedShip) return;
    state.orientation = state.orientation === 'h' ? 'v' : 'h';
    const hovered = document.querySelector('#grid-place .cell:hover');
    if (hovered) previewPlacement(Number(hovered.dataset.x), Number(hovered.dataset.y));
  });

  $('#btn-reset-place').addEventListener('click', () => {
    state.placedShips = {};
    renderPlacedShips();
    $$('.ship-tray-item').forEach((el) => el.classList.remove('placed', 'selected'));
    state.selectedShip = state.shipsToPlace[0].name;
    selectShip(state.selectedShip);
    $('#btn-confirm-place').disabled = true;
  });

  $('#btn-random-place').addEventListener('click', () => {
    state.placedShips = {};
    for (const ship of state.shipsToPlace) {
      let placed = false;
      let attempts = 0;
      while (!placed && attempts < 500) {
        attempts++;
        const orientation = Math.random() < 0.5 ? 'h' : 'v';
        const x = Math.floor(Math.random() * BOARD_SIZE);
        const y = Math.floor(Math.random() * BOARD_SIZE);
        const cells = computeCells(x, y, ship.size, orientation);
        if (cellsValid(cells, ship.name)) {
          state.placedShips[ship.name] = { cells };
          placed = true;
        }
      }
    }
    renderPlacedShips();
    $$('.ship-tray-item').forEach((el) => el.classList.add('placed'));
    $$('.ship-tray-item').forEach((el) => el.classList.remove('selected'));
    state.selectedShip = null;
    $('#btn-confirm-place').disabled = Object.keys(state.placedShips).length !== state.shipsToPlace.length;
  });

  $('#btn-confirm-place').addEventListener('click', () => {
    const ships = Object.entries(state.placedShips).map(([name, ship]) => ({ name, cells: ship.cells }));
    state.socket.emit('place_ships', { roomId: state.roomId, ships });
  });

  // ---------------- Battle screen ----------------
  function buildBattleScreen() {
    buildAxisLabels('enemy-labels-x', 'enemy-labels-y');
    buildAxisLabels('own-labels-x', 'own-labels-y');

    const enemyGrid = $('#grid-enemy');
    enemyGrid.innerHTML = '';
    for (let y = 0; y < BOARD_SIZE; y++) {
      for (let x = 0; x < BOARD_SIZE; x++) {
        const cell = document.createElement('div');
        cell.className = 'cell targetable';
        cell.dataset.x = x;
        cell.dataset.y = y;
        cell.addEventListener('click', () => fireAt(x, y));
        enemyGrid.appendChild(cell);
      }
    }

    const ownGrid = $('#grid-own');
    ownGrid.innerHTML = '';
    state.ownShipCells = new Set();
    Object.values(state.placedShips).forEach((ship) => {
      ship.cells.forEach(([x, y]) => state.ownShipCells.add(`${x},${y}`));
    });
    for (let y = 0; y < BOARD_SIZE; y++) {
      for (let x = 0; x < BOARD_SIZE; x++) {
        const cell = document.createElement('div');
        cell.className = 'cell disabled';
        if (state.ownShipCells.has(`${x},${y}`)) cell.classList.add('ship');
        cell.dataset.x = x;
        cell.dataset.y = y;
        ownGrid.appendChild(cell);
      }
    }

    $('#battle-log').innerHTML = '';
  }

  function fireAt(x, y) {
    if (!state.myTurn) return;
    const cell = gridCell('grid-enemy', x, y);
    if (cell && (cell.classList.contains('hit') || cell.classList.contains('miss'))) return;
    state.socket.emit('fire', { roomId: state.roomId, x, y });
  }

  function handleFireResult({ x, y, isHit, sunkShip, gameOver, firedBy }) {
    const gridId = firedBy === 'you' ? 'grid-enemy' : 'grid-own';
    const cell = gridCell(gridId, x, y);
    if (cell) {
      cell.classList.remove('ship-preview');
      cell.classList.add(isHit ? 'hit' : 'miss');
      if (sunkShip) cell.classList.add('sunk');
    }

    logEntry({ x, y, isHit, sunkShip, firedBy });

    if (!gameOver) {
      if (!isHit) {
        // Turn passes to the opponent only on a miss.
        state.myTurn = firedBy !== 'you';
      } else if (firedBy === 'you') {
        toast('Bắn trúng! Bắn tiếp.', 1600);
      }
      setTurnIndicator();
    } else {
      const youWon = firedBy === 'you';
      if (state.username) {
        if (youWon) state.wins++; else state.losses++;
        updateTopbar();
      }
      setTimeout(() => showGameOver(youWon), 900);
    }
  }

  function logEntry({ x, y, isHit, sunkShip, firedBy }) {
    const log = $('#battle-log');
    const coord = `${COL_LABELS[x]}${ROW_LABELS[y]}`;
    const who = firedBy === 'you' ? 'Bạn' : 'Đối thủ';
    const div = document.createElement('div');
    if (sunkShip) {
      div.className = 'log-sunk';
      div.textContent = `${who} đánh chìm tàu ${shipLabel(sunkShip)} tại ${coord}!`;
    } else if (isHit) {
      div.className = 'log-hit';
      div.textContent = `${who} bắn trúng tại ${coord}.`;
    } else {
      div.className = 'log-miss';
      div.textContent = `${who} bắn trượt tại ${coord}.`;
    }
    log.appendChild(div);
    log.scrollTop = log.scrollHeight;
  }

  function setTurnIndicator() {
    const el = $('#turn-indicator');
    el.textContent = state.myTurn ? 'LƯỢT CỦA BẠN' : 'LƯỢT ĐỐI THỦ';
    el.classList.toggle('your-turn', state.myTurn);
    el.classList.toggle('their-turn', !state.myTurn);
  }

  function showGameOver(youWon) {
    $('#gameover-icon').textContent = youWon ? '🏆' : '💥';
    $('#gameover-title').textContent = youWon ? 'Chiến thắng!' : 'Thất bại';
    $('#gameover-sub').textContent = youWon
      ? 'Hạm đội của bạn đã đánh chìm toàn bộ đối thủ.'
      : 'Hạm đội của bạn đã bị đánh chìm hoàn toàn.';
    showScreen('screen-gameover');
  }

  $('#btn-play-again').addEventListener('click', () => {
    resetToLobby();
  });

  // ---------------- Grid helpers ----------------
  function gridCell(gridId, x, y) {
    return document.querySelector(`#${gridId} .cell[data-x="${x}"][data-y="${y}"]`);
  }

  function buildAxisLabels(xId, yId) {
    const xEl = $(`#${xId}`);
    const yEl = $(`#${yId}`);
    xEl.innerHTML = COL_LABELS.map((l) => `<span>${l}</span>`).join('');
    yEl.innerHTML = ROW_LABELS.map((l) => `<span>${l}</span>`).join('');
  }

  // ---------------- Boot ----------------
  (function boot() {
    if (state.token && state.username) {
      updateTopbar();
      // Verify token still valid, then jump straight to lobby.
      fetch(`${apiBase()}/api/me`, { headers: { Authorization: `Bearer ${state.token}` } })
        .then((res) => (res.ok ? res.json() : Promise.reject()))
        .then((data) => {
          state.wins = data.wins;
          state.losses = data.losses;
          updateTopbar();
          connectSocket();
          showScreen('screen-lobby');
        })
        .catch(() => {
          localStorage.removeItem('bs_token');
          localStorage.removeItem('bs_username');
          showScreen('screen-auth');
        });
    } else {
      showScreen('screen-auth');
    }
  })();
})();
