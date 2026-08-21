// Lightweight file-based storage for user accounts.
//
// We intentionally avoid native database drivers (like better-sqlite3) here
// because they need a C++ compiler to install, which many Windows machines
// don't have set up. A JSON file is more than enough for this project's
// scale, and works identically on Windows, macOS and Linux with zero setup.

const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'data.json');

function load() {
  if (!fs.existsSync(DB_PATH)) {
    return { nextId: 1, users: [] };
  }
  try {
    const raw = fs.readFileSync(DB_PATH, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    console.error('Không đọc được data.json, khởi tạo lại từ đầu.', e);
    return { nextId: 1, users: [] };
  }
}

function save(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2), 'utf8');
}

function getUserByUsername(username) {
  const data = load();
  return data.users.find((u) => u.username === username) || null;
}

function getUserById(id) {
  const data = load();
  return data.users.find((u) => u.id === id) || null;
}

function createUser(username, passwordHash) {
  const data = load();
  const user = {
    id: data.nextId++,
    username,
    password_hash: passwordHash,
    wins: 0,
    losses: 0,
    created_at: new Date().toISOString(),
  };
  data.users.push(user);
  save(data);
  return user;
}

function incrementWins(id) {
  const data = load();
  const user = data.users.find((u) => u.id === id);
  if (user) {
    user.wins += 1;
    save(data);
  }
}

function incrementLosses(id) {
  const data = load();
  const user = data.users.find((u) => u.id === id);
  if (user) {
    user.losses += 1;
    save(data);
  }
}

module.exports = {
  getUserByUsername,
  getUserById,
  createUser,
  incrementWins,
  incrementLosses,
};
