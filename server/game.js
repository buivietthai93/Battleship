const BOARD_SIZE = 10;

const SHIPS = [
  { name: 'Carrier', size: 5 },
  { name: 'Battleship', size: 4 },
  { name: 'Cruiser', size: 3 },
  { name: 'Submarine', size: 3 },
  { name: 'Destroyer', size: 2 },
];

// ships: [{ name, cells: [[x,y], ...] }, ...]
function validatePlacement(ships) {
  if (!Array.isArray(ships) || ships.length !== SHIPS.length) return false;

  const occupied = new Set();

  for (const def of SHIPS) {
    const ship = ships.find((s) => s.name === def.name);
    if (!ship || !Array.isArray(ship.cells) || ship.cells.length !== def.size) {
      return false;
    }

    const xs = ship.cells.map((c) => c[0]);
    const ys = ship.cells.map((c) => c[1]);
    const sameRow = ys.every((y) => y === ys[0]);
    const sameCol = xs.every((x) => x === xs[0]);
    if (!sameRow && !sameCol) return false;

    for (const [x, y] of ship.cells) {
      if (
        !Number.isInteger(x) ||
        !Number.isInteger(y) ||
        x < 0 ||
        x >= BOARD_SIZE ||
        y < 0 ||
        y >= BOARD_SIZE
      ) {
        return false;
      }
      const key = `${x},${y}`;
      if (occupied.has(key)) return false;
      occupied.add(key);
    }

    const line = sameRow ? [...xs].sort((a, b) => a - b) : [...ys].sort((a, b) => a - b);
    for (let i = 1; i < line.length; i++) {
      if (line[i] !== line[i - 1] + 1) return false;
    }
  }

  return true;
}

function allCells(ships) {
  const set = new Set();
  for (const ship of ships) {
    for (const [x, y] of ship.cells) set.add(`${x},${y}`);
  }
  return set;
}

// Generates a random, valid, non-overlapping ship layout — used to let the
// AI opponent set up its fleet instantly without a human placing it.
function randomShipPlacement() {
  const occupied = new Set();
  const ships = [];

  for (const def of SHIPS) {
    let placed = false;
    let attempts = 0;
    while (!placed && attempts < 500) {
      attempts++;
      const horizontal = Math.random() < 0.5;
      const x = Math.floor(Math.random() * BOARD_SIZE);
      const y = Math.floor(Math.random() * BOARD_SIZE);
      const cells = Array.from({ length: def.size }, (_, i) =>
        horizontal ? [x + i, y] : [x, y + i]
      );
      const valid = cells.every(([cx, cy]) => {
        if (cx < 0 || cx >= BOARD_SIZE || cy < 0 || cy >= BOARD_SIZE) return false;
        return !occupied.has(`${cx},${cy}`);
      });
      if (valid) {
        cells.forEach(([cx, cy]) => occupied.add(`${cx},${cy}`));
        ships.push({ name: def.name, cells });
        placed = true;
      }
    }
    if (!placed) {
      // Astronomically unlikely with a 10x10 board, but never leave a gap.
      return randomShipPlacement();
    }
  }

  return ships;
}

module.exports = { BOARD_SIZE, SHIPS, validatePlacement, allCells, randomShipPlacement };
