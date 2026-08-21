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
    pendingRoomCode: null,
    shipsToPlace: [],
    placedShips: {}, // name -> { cells: [[x,y]...] }
    selectedShip: null,
    orientation: 'h', // 'h' | 'v'
    myTurn: false,
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

  // ---------------- Figma Make style battle effects ----------------
  let shotEffectId = 0;
  let turnBannerTimer = null;

  function showTurnBanner(title, sub, tone = 'blue') {
    const banner = $('#turn-banner');
    const main = $('#turn-banner-main');
    const titleEl = $('#turn-banner-title');
    const subEl = $('#turn-banner-sub');
    if (!banner || !main) return;

    clearTimeout(turnBannerTimer);
    banner.dataset.tone = tone;
    titleEl.textContent = title;
    subEl.textContent = sub;
    banner.hidden = false;
    banner.classList.remove('turn-banner-play');
    void banner.offsetWidth;
    banner.classList.add('turn-banner-play');
    turnBannerTimer = setTimeout(() => {
      banner.hidden = true;
      banner.classList.remove('turn-banner-play');
    }, 1900);
  }

  function shotPoint(grid, x, y) {
    const cell = gridCell(grid.id, x, y);
    if (!cell) return null;
    return {
      x: cell.offsetLeft + cell.offsetWidth / 2,
      y: cell.offsetTop + cell.offsetHeight / 2,
    };
  }

  function makeParticle(className, vars = {}) {
    const el = document.createElement('i');
    el.className = className;
    Object.entries(vars).forEach(([key, value]) => el.style.setProperty(key, value));
    return el;
  }

  function showShotEffect(gridId, x, y, isHit) {
    const grid = $(`#${gridId}`);
    if (!grid) return;
    const point = shotPoint(grid, x, y);
    if (!point) return;

    const effect = document.createElement('div');
    effect.className = `shot-effect ${isHit ? 'shot-explosion' : 'shot-splash'}`;
    effect.dataset.effectId = String(++shotEffectId);
    effect.style.left = `${point.x}px`;
    effect.style.top = `${point.y}px`;

    if (isHit) {
      // Big flash + multiple shockwaves + fire/debris/smoke, matching Figma Make.
      effect.innerHTML = `
        <span class="explosion-flash"></span>
        <span class="explosion-ring r1"></span>
        <span class="explosion-ring r2"></span>
        <span class="explosion-ring r3"></span>
        <span class="explosion-core"></span>
        <span class="explosion-hit-x">×</span>
      `;
      for (let i = 0; i < 22; i++) {
        const a = (i / 22) * Math.PI * 2 + Math.random() * .2;
        const d = 22 + Math.random() * 42;
        effect.appendChild(makeParticle('explosion-particle', {
          '--ex': `${Math.cos(a) * d}px`,
          '--ey': `${Math.sin(a) * d}px`,
          '--delay': `${Math.random() * .1}s`,
          '--dur': `${.5 + Math.random() * .4}s`,
          '--size': `${3 + Math.random() * 7}px`,
        }));
      }
      for (let i = 0; i < 8; i++) {
        effect.appendChild(makeParticle('explosion-smoke', {
          '--sx': `${(i - 3.5) * 9}px`,
          '--delay': `${.05 + i * .07}s`,
          '--size': `${16 + Math.random() * 18}px`,
        }));
      }
    } else {
      effect.innerHTML = `
        <span class="splash-column main"></span>
        <span class="splash-column left"></span>
        <span class="splash-column right"></span>
        <span class="splash-ring sr1"></span>
        <span class="splash-ring sr2"></span>
        <span class="splash-ring sr3"></span>
        <span class="splash-foam"></span>
      `;
      const colors = ['#7ec8f0', '#5ab0e0', '#9adcff', '#4a9fd4', '#b8eaff'];
      for (let i = 0; i < 18; i++) {
        const a = (i / 18) * Math.PI * 2 + Math.random() * .3;
        const d = 15 + Math.random() * 30;
        effect.appendChild(makeParticle('splash-drop', {
          '--tx': `${Math.cos(a) * d}px`,
          '--ty': `${-(30 + Math.random() * 50)}px`,
          '--delay': `${Math.random() * .15}s`,
          '--dur': `${.6 + Math.random() * .4}s`,
          '--size': `${2 + Math.random() * 5}px`,
          '--drop-color': colors[i % colors.length],
        }));
      }
    }

    grid.appendChild(effect);
    const duration = isHit ? 1450 : 1150;
    setTimeout(() => effect.remove(), duration);
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

    s.on('room_created', ({ code }) => {
      state.pendingRoomCode = code;
      $('#lobby-idle').hidden = true;
      $('#lobby-room-waiting').hidden = false;
      $('#room-code-display').textContent = code;
    });

    s.on('matched', ({ roomId, ships, opponent }) => {
      state.roomId = roomId;
      state.pendingRoomCode = null;
      $('#lobby-room-waiting').hidden = true;
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
      showTurnBanner(
        yourTurn ? 'LƯỢT CỦA BẠN' : 'LƯỢT ĐỐI THỦ',
        yourTurn ? 'Click vào vùng biển địch để tấn công' : `${opponent} đang chuẩn bị tấn công...`,
        yourTurn ? 'blue' : 'orange'
      );
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

  $('#btn-play-ai').addEventListener('click', () => {
    state.socket.emit('play_vs_ai');
  });

  $('#btn-cancel-queue').addEventListener('click', () => {
    state.socket.emit('leave_queue');
    $('#lobby-idle').hidden = false;
    $('#lobby-searching').hidden = true;
  });

  $('#btn-create-room').addEventListener('click', () => {
    state.socket.emit('create_room');
  });

  $('#btn-cancel-room').addEventListener('click', () => {
    state.socket.emit('cancel_room');
    state.pendingRoomCode = null;
    $('#lobby-idle').hidden = false;
    $('#lobby-room-waiting').hidden = true;
  });

  $('#btn-join-room').addEventListener('click', () => {
    const code = $('#join-room-code').value.trim();
    if (!code) return;
    state.socket.emit('join_room', { code });
  });

  $('#join-room-code').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') $('#btn-join-room').click();
  });

  function resetToLobby() {
    state.roomId = null;
    state.pendingRoomCode = null;
    $('#lobby-idle').hidden = false;
    $('#lobby-searching').hidden = true;
    $('#lobby-room-waiting').hidden = true;
    $('#join-room-code').value = '';
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
    $$('#grid-place .cell').forEach((c) => clearShipClasses(c));
    Object.entries(state.placedShips).forEach(([name, ship]) => {
      ship.cells.forEach(([x, y]) => {
        const cell = gridCell('grid-place', x, y);
        if (cell) applyShipClasses(cell, name, ship.cells, x, y);
      });
    });
  }

  // Works out whether a ship cell is the bow, stern, or a middle segment so
  // it can be drawn as a connected capsule shape instead of a plain square.
  function shipSegmentInfo(cells, x, y) {
    const horizontal = cells.every((c) => c[1] === cells[0][1]);
    const sorted = horizontal
      ? [...cells].sort((a, b) => a[0] - b[0])
      : [...cells].sort((a, b) => a[1] - b[1]);
    const idx = sorted.findIndex((c) => c[0] === x && c[1] === y);
    let posClass = 'ship-mid';
    if (idx === 0) posClass = 'ship-start';
    else if (idx === sorted.length - 1) posClass = 'ship-end';
    return { orientationClass: horizontal ? 'ship-h' : 'ship-v', posClass };
  }

  function applyShipClasses(cell, shipName, cells, x, y) {
    const { orientationClass, posClass } = shipSegmentInfo(cells, x, y);
    cell.classList.add('ship', orientationClass, posClass);
    cell.dataset.ship = shipName;
  }

  function clearShipClasses(cell) {
    cell.classList.remove('ship', 'ship-h', 'ship-v', 'ship-start', 'ship-mid', 'ship-end');
    delete cell.dataset.ship;
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
    buildAxisLabels('gameover-labels-x-enemy', 'gameover-labels-y-enemy');
    buildAxisLabels('gameover-labels-x-own', 'gameover-labels-y-own');

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
    const ownCellShipMap = new Map();
    Object.entries(state.placedShips).forEach(([name, ship]) => {
      ship.cells.forEach(([x, y]) => ownCellShipMap.set(`${x},${y}`, { name, cells: ship.cells }));
    });
    for (let y = 0; y < BOARD_SIZE; y++) {
      for (let x = 0; x < BOARD_SIZE; x++) {
        const cell = document.createElement('div');
        cell.className = 'cell disabled';
        const info = ownCellShipMap.get(`${x},${y}`);
        if (info) applyShipClasses(cell, info.name, info.cells, x, y);
        cell.dataset.x = x;
        cell.dataset.y = y;
        ownGrid.appendChild(cell);
      }
    }

    $('#battle-log').innerHTML = '';
    // Own ships use the same top-down SVG style as the Figma Make design.
    requestAnimationFrame(() => {
      Object.entries(state.placedShips).forEach(([name, ship]) => {
        addShipVisual('grid-own', name, ship.cells, false);
      });
    });
  }

  function fireAt(x, y) {
    if (!state.myTurn) return;
    const cell = gridCell('grid-enemy', x, y);
    if (cell && (cell.classList.contains('hit') || cell.classList.contains('miss'))) return;
    state.socket.emit('fire', { roomId: state.roomId, x, y });
  }

  function clearHitMarkers(gridId, cells) {
    if (!Array.isArray(cells)) return;
    cells.forEach(([x, y]) => {
      const cell = gridCell(gridId, x, y);
      if (!cell) return;
      cell.classList.remove('hit', 'sunk');
      cell.dataset.sunk = 'true';
    });
  }

  function handleFireResult({ x, y, isHit, sunkShip, sunkShipCells, gameOver, firedBy, revealShips }) {
    const gridId = firedBy === 'you' ? 'grid-enemy' : 'grid-own';
    const cell = gridCell(gridId, x, y);
    if (cell) {
      cell.classList.remove('ship-preview');
      cell.classList.add(isHit ? 'hit' : 'miss');
      showShotEffect(gridId, x, y, isHit);
    }

    // When a ship is fully sunk, remove every persistent red hit marker from
    // that ship before revealing the Figma-style ship graphic.
    if (sunkShip) {
      const cells = Array.isArray(sunkShipCells)
        ? sunkShipCells
        : (firedBy === 'opponent' ? state.placedShips[sunkShip]?.cells : null);

      if (cells) {
        clearHitMarkers(gridId, cells);
        addShipVisual(gridId, sunkShip, cells, true);
      }
    }

    logEntry({ x, y, isHit, sunkShip, firedBy });

    if (!gameOver) {
      if (!isHit) {
        // Turn passes to the opponent only on a miss.
        state.myTurn = firedBy !== 'you';
        // Delay the full-screen turn banner so the water-splash effect from
        // the miss has time to play out first, instead of being covered.
        setTimeout(() => {
          if (state.myTurn) {
            showTurnBanner('LƯỢT CỦA BẠN', 'Đến lượt bạn — chọn mục tiêu để khai hỏa', 'blue');
          } else {
            showTurnBanner('LƯỢT ĐỐI THỦ', 'Đối thủ đang tấn công hạm đội của bạn...', 'orange');
          }
        }, 1500);
      } else if (firedBy === 'you') {
        // A hit earns another shot.
        state.myTurn = true;
        toast('Bắn trúng! Bắn tiếp.', 1600);
      }
      setTurnIndicator();
    } else {
      // The losing fleet is fully sunk — reveal where every ship was hiding.
      if (firedBy === 'you' && Array.isArray(revealShips)) {
        revealShips.forEach((ship) => {
          ship.cells.forEach(([sx, sy]) => {
            const enemyCell = gridCell('grid-enemy', sx, sy);
            if (enemyCell) applyShipClasses(enemyCell, ship.name, ship.cells, sx, sy);
          });
          clearHitMarkers('grid-enemy', ship.cells);
          addShipVisual('grid-enemy', ship.name, ship.cells, true);
        });
      }

      const youWon = firedBy === 'you';
      if (state.username) {
        if (youWon) state.wins++; else state.losses++;
        updateTopbar();
      }
      $('#gameover-grid-enemy').innerHTML = $('#grid-enemy').innerHTML;
      $('#gameover-grid-own').innerHTML = $('#grid-own').innerHTML;
      setTimeout(() => showGameOver(youWon), 900);
    }
  }

  // Draws a top-down ship similar to the Figma Make design. The SVG is an
  // overlay spanning the occupied cells, so the grid remains interactive.
  function addShipVisual(gridId, shipName, cells, sunk) {
  if (!Array.isArray(cells) || !cells.length) return;

  const grid = $(`#${gridId}`);
  if (!grid) return;

  // Xóa hình tàu cũ của cùng con tàu
  const old = grid.querySelector(
    `.ship-visual[data-ship-name="${shipName}"]`
  );

  if (old) old.remove();

  // Xác định hướng tàu
  const horizontal = cells.every(
    ([x, y]) => y === cells[0][1]
  );

  const minX = Math.min(...cells.map(([x]) => x));
  const minY = Math.min(...cells.map(([, y]) => y));

  const len = cells.length;

  const styles = getComputedStyle(grid);

  const cellSize =
    parseFloat(styles.getPropertyValue('--cell-size')) || 34;

  const gap =
    parseFloat(styles.getPropertyValue('--cell-gap')) || 2;

  const pad =
    parseFloat(styles.paddingLeft) || 2;

  /*
   * Kích thước vùng mà con tàu chiếm trên grid.
   *
   * QUAN TRỌNG:
   * - horizontal: width = chiều dài tàu
   * - vertical:   height = chiều dài tàu
   *
   * SVG bên trong luôn được vẽ theo hướng ngang.
   * Nếu là tàu dọc thì chỉ xoay SVG 90 độ.
   */

  const shipWidth = horizontal
    ? len * cellSize + (len - 1) * gap
    : cellSize;

  const shipHeight = horizontal
    ? cellSize
    : len * cellSize + (len - 1) * gap;

  /*
   * SVG luôn có hình dạng ngang.
   *
   * Khi tàu dọc:
   *
   * SVG:
   * ─────────────
   *
   * sẽ được CSS:
   *
   *      │
   *      │
   *      │
   *
   * xoay 90 độ.
   */

  const svgWidth = horizontal ? shipWidth : shipHeight;
  const svgHeight = horizontal ? shipHeight : shipWidth;

  const shipLen = svgWidth;
  const shipH = svgHeight;

  const midY = shipH / 2;

  const palette = shipPalette(shipName);

  const id =
    `ship-${gridId}-${shipName}-${Date.now()}-` +
    Math.random().toString(36).slice(2, 7);

  // ---------------- HULL ----------------

  const halfW = shipH * 0.36;

  const bowX = shipLen;

  const bodyStart = shipLen * 0.18;

  const hullPath = `
    M ${bowX} ${midY}

    L ${bodyStart} ${midY - halfW}

    L 0 ${midY - halfW * 0.65}

    L 0 ${midY + halfW * 0.65}

    L ${bodyStart} ${midY + halfW}

    Z
  `;

  // ---------------- SUPERSTRUCTURE ----------------

  const supStart = shipLen * 0.22;
  const supEnd = shipLen * 0.70;

  const supW = shipH * 0.42;

  const supPath = `
    M ${supStart + supW * 0.4} ${midY - supW / 2}

    L ${supEnd} ${midY - supW / 2.5}

    L ${supEnd} ${midY + supW / 2.5}

    L ${supStart + supW * 0.4} ${midY + supW / 2}

    L ${supStart} ${midY + supW / 2.2}

    L ${supStart} ${midY - supW / 2.2}

    Z
  `;

  // ---------------- BRIDGE ----------------

  const brX = shipLen * 0.55;

  const brW = shipH * 0.12;
  const brH = shipH * 0.28;

  // ---------------- TURRETS ----------------

  const turrets =
    len >= 3
      ? `
        <circle
          cx="${shipLen * 0.78}"
          cy="${midY}"
          r="${shipH * 0.12}"
          fill="${palette.deck}"
          stroke="${palette.stripe}"
          stroke-width="0.8"
        />

        <rect
          x="${shipLen * 0.78}"
          y="${midY - 1}"
          width="${shipH * 0.18}"
          height="2"
          fill="${palette.stripe}"
          rx="1"
        />
      `
      : '';

  const turret2 =
    len >= 4
      ? `
        <circle
          cx="${shipLen * 0.88}"
          cy="${midY}"
          r="${shipH * 0.10}"
          fill="${palette.deck}"
          stroke="${palette.stripe}"
          stroke-width="0.7"
        />

        <rect
          x="${shipLen * 0.88}"
          y="${midY - 1}"
          width="${shipH * 0.14}"
          height="2"
          fill="${palette.stripe}"
          rx="1"
        />
      `
      : '';

  // ---------------- PORTHOLES ----------------

  const portholes = Array.from(
    { length: Math.max(0, len - 1) },
    (_, i) => {

      const px =
        bodyStart +
        (i + 0.7) *
        (shipLen * 0.70 - bodyStart) /
        len;

      return `
        <circle
          cx="${px}"
          cy="${midY - shipH * 0.15}"
          r="2.3"
          fill="${palette.hull}"
        />

        <circle
          cx="${px}"
          cy="${midY - shipH * 0.15}"
          r="1.3"
          fill="${palette.window}"
        />

        <circle
          cx="${px}"
          cy="${midY + shipH * 0.15}"
          r="2.3"
          fill="${palette.hull}"
        />

        <circle
          cx="${px}"
          cy="${midY + shipH * 0.15}"
          r="1.3"
          fill="${palette.window}"
        />
      `;
    }
  ).join('');

  // ---------------- CONTAINER ----------------

  const visual = document.createElement('div');

  visual.className = 'ship-visual';

  visual.dataset.shipName = shipName;

  visual.style.left =
    `${pad + minX * (cellSize + gap)}px`;

  visual.style.top =
    `${pad + minY * (cellSize + gap)}px`;

  visual.style.width =
    `${shipWidth}px`;

  visual.style.height =
    `${shipHeight}px`;

  /*
   * Tàu ngang:
   *     SVG không xoay.
   *
   * Tàu dọc:
   *     Toàn bộ thẻ <svg> được xoay 90 độ bằng CSS, quanh
   *     đúng tâm của chính nó, rồi được canh giữa vào ô chứa
   *     (.ship-visual) bằng kỹ thuật top/left 50% + translate(-50%,-50%).
   *
   *     LƯU Ý: trước đây phép xoay được gắn vào thẻ <g> bên
   *     trong SVG (xoay nội dung vẽ), trong khi khung <svg>
   *     bên ngoài vẫn giữ kích thước "nằm ngang" (svgWidth x
   *     svgHeight) thay vì kích thước thật sau khi xoay. Vì
   *     khung SVG không được canh giữa vào div cha (.ship-visual
   *     có kích thước dọc: shipWidth x shipHeight), toàn bộ
   *     hình tàu bị lệch khỏi các ô lưới — đây chính là lỗi
   *     lệch hình ảnh. Xoay cả <svg> (không phải <g>) và canh
   *     giữa nó vào div cha sẽ luôn cho kết quả đúng, bất kể
   *     kích thước khung trước khi xoay.
   */

  const svgCssTransform =
    horizontal
      ? 'translate(-50%, -50%)'
      : 'translate(-50%, -50%) rotate(90deg)';

  visual.innerHTML = `
    <svg
      width="${svgWidth}"
      height="${svgHeight}"
      viewBox="0 0 ${svgWidth} ${svgHeight}"
      aria-hidden="true"
      preserveAspectRatio="none"
      style="position:absolute; top:50%; left:50%; transform-origin:center center; transform:${svgCssTransform};"
    >

      <defs>

        <linearGradient
          id="${id}-hull"
          x1="0"
          y1="0"
          x2="0"
          y2="1"
        >
          <stop
            offset="0%"
            stop-color="${palette.stripe}"
          />

          <stop
            offset="35%"
            stop-color="${palette.deck}"
          />

          <stop
            offset="100%"
            stop-color="${palette.shadow}"
          />
        </linearGradient>

        <linearGradient
          id="${id}-sup"
          x1="0"
          y1="0"
          x2="0"
          y2="1"
        >
          <stop
            offset="0%"
            stop-color="${palette.window}"
            stop-opacity="0.6"
          />

          <stop
            offset="100%"
            stop-color="${palette.deck}"
          />
        </linearGradient>

      </defs>

      <g>

        <!-- shadow -->
        <path
          d="${hullPath}"
          fill="${palette.shadow}"
          transform="translate(2,3)"
          opacity="0.55"
        />

        <!-- hull -->
        <path
          d="${hullPath}"
          fill="url(#${id}-hull)"
          stroke="${palette.hull}"
          stroke-width="1"
        />

        <!-- hull highlight -->
        <path
          d="${hullPath}"
          fill="none"
          stroke="${palette.stripe}"
          stroke-width="1"
          opacity="0.45"
        />

        <!-- superstructure -->
        <path
          d="${supPath}"
          fill="url(#${id}-sup)"
          stroke="${palette.hull}"
          stroke-width="0.8"
          opacity="0.95"
        />

        <!-- bridge -->
        <rect
          x="${brX - brW / 2}"
          y="${midY - brH / 2}"
          width="${brW}"
          height="${brH}"
          rx="2"
          fill="${palette.deck}"
          stroke="${palette.stripe}"
          stroke-width="0.7"
        />

        <rect
          x="${brX - brW / 2 + 2}"
          y="${midY - brH / 2 + 2}"
          width="${Math.max(1, brW - 4)}"
          height="${brH * 0.45}"
          rx="1"
          fill="${palette.window}"
          opacity="0.85"
        />

        ${turrets}
        ${turret2}
        ${portholes}

        <!-- antenna -->
        <line
          x1="${brX}"
          y1="${midY - brH / 2}"
          x2="${brX}"
          y2="${midY - brH / 2 - shipH * 0.3}"
          stroke="${palette.stripe}"
          stroke-width="1.2"
          opacity="0.75"
        />

        <circle
          cx="${brX}"
          cy="${midY - brH / 2 - shipH * 0.3}"
          r="1.5"
          fill="${palette.window}"
        />

      </g>

    </svg>
  `;

  grid.appendChild(visual);

  if (sunk) {
    visual.classList.add('sunk');
  }
}

  function shipPalette(name) {
    const palettes = {
      Carrier: { deck: '#aebbc0', hull: '#52616a', stripe: '#d4e0e4', window: '#e6f3f7', shadow: '#26333a' },
      Battleship: { deck: '#6f7f5e', hull: '#38482d', stripe: '#a3bd68', window: '#d8e9a0', shadow: '#1b2814' },
      Cruiser: { deck: '#47718f', hull: '#263f52', stripe: '#7ab0d4', window: '#b9e1f7', shadow: '#102231' },
      Submarine: { deck: '#61727e', hull: '#34434d', stripe: '#98aab4', window: '#d3e2e9', shadow: '#1c272e' },
      Destroyer: { deck: '#8b9499', hull: '#4b555a', stripe: '#c4cdd1', window: '#e7eef0', shadow: '#252c30' },
    };
    return palettes[name] || palettes.Destroyer;
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