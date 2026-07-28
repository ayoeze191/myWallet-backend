const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_EXPIRES_IN = '7d';

async function hashPassword(plain) {
  return bcrypt.hash(plain, 12);
}

async function comparePassword(plain, hash) {
  return bcrypt.compare(plain, hash);
}

function signToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

module.exports = { hashPassword, comparePassword, signToken, verifyToken };
