const crypto = require('crypto');
const env = require('../config/env');

const TOKEN_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000; // 7 days TTL

/**
 * Generate a short signed token containing personId and expiration
 * Format: [randomCode]_[timestamp]_[signature]
 */
function generateSignedToken(personId, secret = env.TOKEN_SECRET) {
  const expiresAt = Date.now() + TOKEN_EXPIRY_MS;
  const rawData = `${personId}:${expiresAt}`;
  const hmac = crypto.createHmac('sha256', secret).update(rawData).digest('hex').slice(0, 8);
  const code = Buffer.from(rawData).toString('base64url');
  return `${code}.${hmac}`;
}

/**
 * Verify a signed token and extract personId
 */
function verifySignedToken(token, secret = env.TOKEN_SECRET) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.trim().split('.');
  if (parts.length !== 2) return null;
  
  const [code, receivedHmac] = parts;
  try {
    const rawData = Buffer.from(code, 'base64url').toString('utf8');
    const [personId, expiresAtStr] = rawData.split(':');
    const expiresAt = parseInt(expiresAtStr, 10);
    
    if (isNaN(expiresAt) || Date.now() > expiresAt) {
      // Expired token
      return null;
    }
    
    const expectedHmac = crypto.createHmac('sha256', secret).update(rawData).digest('hex').slice(0, 8);
    if (crypto.timingSafeEqual(Buffer.from(receivedHmac), Buffer.from(expectedHmac))) {
      return personId;
    }
  } catch (err) {
    return null;
  }
  return null;
}

/**
 * Short human-readable reference code for WhatsApp/Instagram (e.g. X7K2)
 */
function generateRefCode(length = 4) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let result = '';
  const randomBytes = crypto.randomBytes(length);
  for (let i = 0; i < length; i++) {
    result += chars[randomBytes[i] % chars.length];
  }
  return result;
}

/**
 * Extract ref code from inbound message text (e.g., "Hi GrapeLabs (ref X7K2)")
 */
function extractRefCode(text) {
  if (!text || typeof text !== 'string') return null;
  const match = text.match(/\b(?:ref|code)[:\s]*([A-Z0-9]{4,8})\b/i);
  return match ? match[1].toUpperCase() : null;
}

module.exports = {
  TOKEN_EXPIRY_MS,
  generateSignedToken,
  verifySignedToken,
  generateRefCode,
  extractRefCode
};
