const express = require('express');
const { pool, withTransaction } = require('../db/pool');
const { hashPassword, comparePassword, signToken } = require('../services/auth');

const router = express.Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

router.post('/auth/register', async (req, res) => {
  const { name, email, password, currency = 'NGN' } = req.body;

  if (!name || !email || !password) {
    return res.status(400).json({ error: 'name, email, and password are required' });
  }
  if (!EMAIL_RE.test(email)) {
    return res.status(400).json({ error: 'Invalid email' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }

  const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()]);
  if (existing.rows.length > 0) {
    return res.status(409).json({ error: 'An account with this email already exists' });
  }

  const passwordHash = await hashPassword(password);

  // Create the user AND their wallet together — a user should never exist
  // without a wallet, so this has to be one atomic operation.
  const { user, wallet } = await withTransaction(async (client) => {
    const userResult = await client.query(
      'INSERT INTO users (name, email, password_hash) VALUES ($1, $2, $3) RETURNING id, name, email, created_at',
      [name, email.toLowerCase(), passwordHash]
    );
    const user = userResult.rows[0];

    const walletResult = await client.query(
      'INSERT INTO wallets (user_id, owner_name, currency) VALUES ($1, $2, $3) RETURNING *',
      [user.id, name, currency]
    );
    return { user, wallet: walletResult.rows[0] };
  });

  const token = signToken({ userId: user.id });
  res.status(201).json({ token, user, wallet });
});

router.post('/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'email and password are required' });
  }

  const { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [email.toLowerCase()]);
  const user = rows[0];

  // Same error for "no such user" and "wrong password" — don't reveal
  // which one it was, so an attacker can't enumerate valid emails.
  if (!user || !(await comparePassword(password, user.password_hash))) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  const token = signToken({ userId: user.id });
  res.json({
    token,
    user: { id: user.id, name: user.name, email: user.email },
  });
});

module.exports = router;
