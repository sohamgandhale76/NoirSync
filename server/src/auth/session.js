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

function setSessionCookie(res, userId) {
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

function clearSessionCookie(res) {
  const isProduction = process.env.NODE_ENV === 'production';
  const cookieOptions = [
    `${COOKIE_NAME}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0'
  ];
  if (isProduction) {
    cookieOptions.push('Secure');
  }
  res.setHeader('Set-Cookie', cookieOptions.join('; '));
}

/**
 * Resolves a persistent user ID from cookies or creates a new guest user.
 * Reusable across HTTP middleware and Socket.IO connection handlers.
 */
async function resolveSessionUser(cookieHeader) {
  const cookies = parseCookies(cookieHeader);
  let userId = null;

  if (cookies[COOKIE_NAME]) {
    userId = unsign(cookies[COOKIE_NAME]);
  }

  if (!userId) {
    // Create new user ID
    userId = uuidv4();

    // Ensure users table exists and insert this user
    const db = require('../db');
    await db.pool.query(
      'INSERT INTO users (id, created_at, is_guest) VALUES ($1, $2, true) ON CONFLICT (id) DO NOTHING',
      [userId, Date.now()]
    );
    return { userId, isNew: true };
  }

  return { userId, isNew: false };
}

/**
 * Middleware to ensure the request is associated with a persistent user ID.
 * If no valid session cookie exists, one is created and set.
 */
async function sessionMiddleware(req, res, next) {
  try {
    const { userId, isNew } = await resolveSessionUser(req.headers.cookie);

    if (isNew) {
      setSessionCookie(res, userId);
    }

    req.userId = userId;

    // Attach full user record for downstream checks (e.g., is_guest)
    try {
      const db = require('../db');
      const user = await db.getUserById(userId);
      req.user = user || null;
    } catch (e) {
      req.user = null;
    }

    next();
  } catch (err) {
    next(err);
  }
}

module.exports = {
  COOKIE_NAME,
  sessionMiddleware,
  resolveSessionUser,
  parseCookies,
  setSessionCookie,
  clearSessionCookie
};

