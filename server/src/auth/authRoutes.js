// ─── Authentication API Routes ──────────────────────────────────────────────
// Phase 6A: NoirSync Identity & Account Model
// Provides registration, login, logout, and current user profile endpoints.

const express = require('express');
const bcrypt = require('bcryptjs');
const {
  getUserById,
  getUserByIdentifier,
  upgradeGuestUser,
  createUser,
  updateUserProfile,
  sanitizeUser,
} = require('../db');
const { setSessionCookie, clearSessionCookie } = require('./session');
const logger = require('../logger');

const router = express.Router();

const BCRYPT_SALT_ROUNDS = 10;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const USERNAME_REGEX = /^[a-zA-Z0-9_]{3,30}$/;

/**
 * Helper to inspect PostgreSQL unique constraint errors (code 23505)
 * and return appropriate 409 error messages.
 */
function handleUniqueConstraintError(err, res) {
  if (err.code === '23505') {
    const detail = err.detail || '';
    if (detail.includes('email') || err.constraint?.includes('email')) {
      return res.status(409).json({ error: 'Email already in use' });
    }
    if (detail.includes('username') || err.constraint?.includes('username')) {
      return res.status(409).json({ error: 'Username already taken' });
    }
    return res.status(409).json({ error: 'Account with this email or username already exists' });
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/auth/register
// ─────────────────────────────────────────────────────────────────────────────
router.post('/register', async (req, res) => {
  try {
    const { email, username, password, displayName } = req.body || {};

    // 1. Validate inputs
    if (!email || typeof email !== 'string' || !EMAIL_REGEX.test(email.trim())) {
      return res.status(400).json({ error: 'A valid email address is required' });
    }

    if (!username || typeof username !== 'string' || !USERNAME_REGEX.test(username.trim())) {
      return res.status(400).json({
        error: 'Username must be between 3 and 30 characters and contain only letters, numbers, and underscores',
      });
    }

    if (!password || typeof password !== 'string' || password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters long' });
    }

    if (password.length > 128) {
      return res.status(400).json({ error: 'Password cannot exceed 128 characters' });
    }

    const normEmail = email.trim().toLowerCase();
    const normUsername = username.trim();
    const normDisplayName = (displayName && typeof displayName === 'string' && displayName.trim()) || normUsername;

    // 2. Check current session
    const currentUserId = req.userId;
    const currentUser = currentUserId ? await getUserById(currentUserId) : null;

    // If the current user is already an authenticated permanent user, reject registration
    if (currentUser && !currentUser.is_guest) {
      return res.status(409).json({
        error: 'Already authenticated as a permanent user. Please log out first to create another account.',
      });
    }

    // 3. Hash password
    const passwordHash = await bcrypt.hash(password, BCRYPT_SALT_ROUNDS);

    // 4. Upgrade guest in place or create new permanent user
    let user;
    if (currentUser && currentUser.is_guest) {
      // Upgrade existing guest user, preserving user.id
      user = await upgradeGuestUser(currentUser.id, {
        email: normEmail,
        username: normUsername,
        displayName: normDisplayName,
        passwordHash,
      });
      logger.info('Guest user upgraded to permanent account', { userId: user.id, username: user.username });
    } else {
      // Fallback: create new permanent user (e.g. if no guest row was present)
      const { v4: uuidv4 } = require('uuid');
      const newId = currentUserId || uuidv4();
      user = await createUser({
        id: newId,
        email: normEmail,
        username: normUsername,
        displayName: normDisplayName,
        passwordHash,
        isGuest: false,
      });
      logger.info('New permanent account created', { userId: user.id, username: user.username });
    }

    // 5. Establish authenticated session
    setSessionCookie(res, user.id);
    req.userId = user.id;

    // 6. Return sanitized user profile
    res.status(201).json({
      success: true,
      user: sanitizeUser(user),
    });
  } catch (err) {
    if (handleUniqueConstraintError(err, res)) return;
    logger.error('Registration failed', { error: err.message });
    res.status(500).json({ error: 'Registration failed. Please try again.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/auth/login
// ─────────────────────────────────────────────────────────────────────────────
router.post('/login', async (req, res) => {
  try {
    const { identifier, password } = req.body || {};

    if (!identifier || typeof identifier !== 'string' || !identifier.trim()) {
      return res.status(400).json({ error: 'Email or username is required' });
    }

    if (!password || typeof password !== 'string') {
      return res.status(400).json({ error: 'Password is required' });
    }

    // Retrieve permanent user only (is_guest = false)
    const user = await getUserByIdentifier(identifier.trim());
    if (!user || !user.password_hash) {
      return res.status(401).json({ error: 'Invalid email/username or password' });
    }

    const isValidPassword = await bcrypt.compare(password, user.password_hash);
    if (!isValidPassword) {
      return res.status(401).json({ error: 'Invalid email/username or password' });
    }

    // Establish authenticated session for this user
    setSessionCookie(res, user.id);
    req.userId = user.id;

    logger.info('User logged in successfully', { userId: user.id, username: user.username });
    res.json({
      success: true,
      user: sanitizeUser(user),
    });
  } catch (err) {
    logger.error('Login failed', { error: err.message });
    res.status(500).json({ error: 'Login failed. Please try again.' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/auth/logout
// ─────────────────────────────────────────────────────────────────────────────
router.post('/logout', (_req, res) => {
  clearSessionCookie(res);
  logger.info('User logged out');
  res.json({ success: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/auth/me
// ─────────────────────────────────────────────────────────────────────────────
router.get('/me', async (req, res) => {
  try {
    const userId = req.userId;
    if (!userId) {
      return res.json({ authenticated: false, isGuest: true, user: null });
    }

    const user = await getUserById(userId);
    if (!user) {
      return res.json({ authenticated: false, isGuest: true, user: { id: userId } });
    }

    if (!user.is_guest) {
      return res.json({
        authenticated: true,
        isGuest: false,
        user: sanitizeUser(user),
      });
    }

    return res.json({
      authenticated: false,
      isGuest: true,
      user: { id: user.id },
    });
  } catch (err) {
    logger.error('Failed to get current user (/me)', { error: err.message });
    res.status(500).json({ error: 'Failed to retrieve profile' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/auth/profile
// ─────────────────────────────────────────────────────────────────────────────
router.patch('/profile', async (req, res) => {
  try {
    const userId = req.userId;
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const user = await getUserById(userId);
    if (!user || user.is_guest) {
      return res.status(401).json({ error: 'Must be logged in to update profile' });
    }

    const { displayName, username, avatarUrl } = req.body || {};
    const updates = {};

    if (displayName !== undefined) {
      if (typeof displayName !== 'string' || displayName.trim().length > 50) {
        return res.status(400).json({ error: 'Display name must not exceed 50 characters' });
      }
      updates.displayName = displayName.trim();
    }

    if (username !== undefined) {
      if (typeof username !== 'string' || !USERNAME_REGEX.test(username.trim())) {
        return res.status(400).json({
          error: 'Username must be between 3 and 30 characters and contain only letters, numbers, and underscores',
        });
      }
      updates.username = username.trim();
    }

    if (avatarUrl !== undefined) {
      if (avatarUrl !== null && typeof avatarUrl !== 'string') {
        return res.status(400).json({ error: 'Avatar URL must be a string or null' });
      }
      updates.avatarUrl = avatarUrl ? avatarUrl.trim() : null;
    }

    const updatedUser = await updateUserProfile(userId, updates);
    logger.info('User profile updated', { userId });
    res.json({
      success: true,
      user: sanitizeUser(updatedUser),
    });
  } catch (err) {
    if (handleUniqueConstraintError(err, res)) return;
    logger.error('Profile update failed', { error: err.message });
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

module.exports = router;
