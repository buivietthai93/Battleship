const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('./db');

const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production';
const router = express.Router();

const USERNAME_RE = /^[a-zA-Z0-9_]{3,16}$/;

router.post('/register', (req, res) => {
  const { username, password } = req.body || {};

  if (!username || !USERNAME_RE.test(username)) {
    return res.status(400).json({
      error: 'Tên đăng nhập phải dài 3-16 ký tự, chỉ gồm chữ, số và dấu gạch dưới.',
    });
  }
  if (!password || password.length < 4) {
    return res.status(400).json({ error: 'Mật khẩu phải có ít nhất 4 ký tự.' });
  }

  const existing = db.getUserByUsername(username);
  if (existing) {
    return res.status(409).json({ error: 'Tên đăng nhập đã được sử dụng.' });
  }

  const hash = bcrypt.hashSync(password, 10);
  const user = db.createUser(username, hash);

  const token = jwt.sign({ id: user.id, username }, JWT_SECRET, {
    expiresIn: '30d',
  });

  res.json({ token, username, wins: 0, losses: 0 });
});

router.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  const user = db.getUserByUsername(username);

  if (!user || !bcrypt.compareSync(password || '', user.password_hash)) {
    return res.status(401).json({ error: 'Sai tên đăng nhập hoặc mật khẩu.' });
  }

  const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, {
    expiresIn: '30d',
  });

  res.json({ token, username: user.username, wins: user.wins, losses: user.losses });
});

router.get('/me', (req, res) => {
  const header = req.headers.authorization || '';
  const token = header.replace(/^Bearer\s+/i, '');
  if (!token) return res.status(401).json({ error: 'Thiếu token đăng nhập.' });

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = db.getUserById(payload.id);
    if (!user) return res.status(401).json({ error: 'Tài khoản không tồn tại.' });
    res.json({ username: user.username, wins: user.wins, losses: user.losses });
  } catch (e) {
    res.status(401).json({ error: 'Token không hợp lệ hoặc đã hết hạn.' });
  }
});

module.exports = { router, JWT_SECRET };
