const crypto = require('node:crypto');
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `scrypt:${salt}:${crypto.scryptSync(password, salt, 64).toString('hex')}`;
}
function verifyPassword(password, hash) {
  const [scheme, salt, value] = hash.split(':');
  if (scheme !== 'scrypt' || !salt || !value) return false;
  const expected = Buffer.from(value, 'hex');
  const actual = crypto.scryptSync(password, salt, expected.length);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}
module.exports = { hashPassword, verifyPassword };
