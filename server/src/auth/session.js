const { v4: uuidv4 } = require('uuid');
const { sign, unsign } = require('./crypto');

const COOKIE_NAME = 'noirsync_session';

/**
 * Parses the Cookie header manually since we might not have cookie-parser
 */
function parseCookies(cookieHeader) {
  const list = {};
  if (!cookieHeader) return list;
  cookieHeader.split(';').forEach(cookie => {
    let [name, ...rest] = cookie.split('=');
    name = name?.trim();
    if (!name) return;
    const value = rest.join('=').trim();
    if (!value) return;
    list[name] = decodeURIComponent(value);
  });
  return list;
}

/**
 * Middleware to ensure the request is associated with a persistent user ID.
 * If no valid session cookie exists, one is created and set.
 */
async function sessionMiddleware(req, res, next) {
  try {
    const cookies = parseCookies(req.headers.cookie);
    let userId = null;

    if (cookies[COOKIE_NAME]) {
      userId = unsign(cookies[COOKIE_NAME]);
    }

    if (!userId) {
      // Create new user ID
      userId = uuidv4();
      
      // Ensure users table exists and insert this user
      // We will lazily insert it if db module allows, or let the caller handle it.
      // Better to insert it immediately to ensure it exists for foreign keys.
      const db = require('../db');
      await db.pool.query(
        'INSERT INTO users (id, created_at) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING',
        [userId, Date.now()]
      );

      // Set cookie
      const signedId = sign(userId);
      const isProduction = process.env.NODE_ENV === 'production';
      const cookieOptions = [
        `${COOKIE_NAME}=${encodeURIComponent(signedId)}`,
        'Path=/',
        'HttpOnly',
        'SameSite=Lax',
        `Max-Age=${60 * 60 * 24 * 365}` // 1 year
      ];
      if (isProduction) {
        cookieOptions.push('Secure');
      }
      res.setHeader('Set-Cookie', cookieOptions.join('; '));
    }

    req.userId = userId;
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = {
  sessionMiddleware,
  parseCookies
};
