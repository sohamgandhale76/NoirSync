const crypto = require('crypto');

// 32-byte key is required for AES-256
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || null;
const ALGORITHM = 'aes-256-gcm';

/**
 * Encrypt a plaintext string using AES-256-GCM.
 * Format: v1:<hex-iv>:<hex-ciphertext>:<hex-authtag>
 */
function encrypt(text) {
  if (!ENCRYPTION_KEY) {
    throw new Error('ENCRYPTION_KEY is not configured. Cannot securely store tokens.');
  }
  // Ensure key is 32 bytes
  const keyBuffer = Buffer.alloc(32);
  const providedKey = Buffer.from(ENCRYPTION_KEY, 'utf8');
  providedKey.copy(keyBuffer);

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, keyBuffer, iv);
  
  let ciphertext = cipher.update(text, 'utf8', 'hex');
  ciphertext += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');
  
  return `v1:${iv.toString('hex')}:${ciphertext}:${authTag}`;
}

/**
 * Decrypt a ciphertext string formatted as v1:<hex-iv>:<hex-ciphertext>:<hex-authtag>
 */
function decrypt(encryptedText) {
  if (!ENCRYPTION_KEY) {
    throw new Error('ENCRYPTION_KEY is not configured. Cannot decrypt tokens.');
  }
  const keyBuffer = Buffer.alloc(32);
  const providedKey = Buffer.from(ENCRYPTION_KEY, 'utf8');
  providedKey.copy(keyBuffer);

  const parts = encryptedText.split(':');
  if (parts.length !== 4 || parts[0] !== 'v1') {
    throw new Error('Invalid encryption format');
  }

  const iv = Buffer.from(parts[1], 'hex');
  const ciphertext = parts[2];
  const authTag = Buffer.from(parts[3], 'hex');

  const decipher = crypto.createDecipheriv(ALGORITHM, keyBuffer, iv);
  decipher.setAuthTag(authTag);
  
  let plaintext = decipher.update(ciphertext, 'hex', 'utf8');
  plaintext += decipher.final('utf8');
  
  return plaintext;
}

/**
 * Sign a string (like a user ID) with HMAC to prevent tampering.
 * Format: <text>.<hex-hmac>
 */
function sign(text) {
  if (!ENCRYPTION_KEY) return text; // Fallback if no key, though secure cookies prefer a key
  const hmac = crypto.createHmac('sha256', ENCRYPTION_KEY);
  hmac.update(text);
  return `${text}.${hmac.digest('hex')}`;
}

/**
 * Verify a signed string and extract the original text.
 * Returns null if invalid or tampered.
 */
function unsign(signedText) {
  if (!ENCRYPTION_KEY) return signedText;
  const parts = signedText.split('.');
  if (parts.length !== 2) return null;
  
  const text = parts[0];
  const signature = parts[1];
  
  const hmac = crypto.createHmac('sha256', ENCRYPTION_KEY);
  hmac.update(text);
  const expectedSignature = hmac.digest('hex');
  
  // Constant time comparison to prevent timing attacks
  if (expectedSignature.length === signature.length && crypto.timingSafeEqual(Buffer.from(expectedSignature), Buffer.from(signature))) {
    return text;
  }
  return null;
}

module.exports = { encrypt, decrypt, sign, unsign };
