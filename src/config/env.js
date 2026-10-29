const dotenv = require('dotenv');
const path = require('path');
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

function normalizePrivateKey(value) {
  let key = String(value || '').trim();
  // Accept a PEM pasted with optional surrounding quotes from a JSON file.
  if ((key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'"))) {
    key = key.slice(1, -1);
  }
  // Deployment dashboards may preserve multiple backslashes before each n.
  // Replace the whole escaped sequence so none remain inside the PEM body.
  return key
    .replace(/\\+n/g, '\n')
    .replace(/\r\n?/g, '\n')
    .trim();
}

module.exports = {
  PORT: process.env.PORT || 3000,
  NODE_ENV: process.env.NODE_ENV || 'development',
  AUTO_OPEN_CONTROL_PANEL: process.env.AUTO_OPEN_CONTROL_PANEL !== 'false',
  
  // AI Config (model fallback; API key is stored in Firebase client config)
  OPENAI_MODEL: process.env.OPENAI_MODEL || 'gpt-4o-mini',
  
  // Firebase Admin SDK
  FIREBASE_PROJECT_ID: process.env.FIREBASE_PROJECT_ID || 'aichatbot-9bbc3',
  FIREBASE_STORAGE_BUCKET: process.env.FIREBASE_STORAGE_BUCKET || '',
  FIREBASE_CLIENT_EMAIL: process.env.FIREBASE_CLIENT_EMAIL || '',
  FIREBASE_PRIVATE_KEY: process.env.FIREBASE_PRIVATE_KEY ? normalizePrivateKey(process.env.FIREBASE_PRIVATE_KEY) : '',

  // n8n calls the chat API with this shared secret. Channel credentials belong in n8n.
  N8N_API_KEY: process.env.N8N_API_KEY || '',
  
  // Integrations / Alerts
  N8N_WEBHOOK_URL: process.env.N8N_WEBHOOK_URL || '',
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || '',
  TELEGRAM_DEFAULT_CHAT_ID: process.env.TELEGRAM_DEFAULT_CHAT_ID || '',
  
  // Secret for link token signing (HMAC)
  TOKEN_SECRET: process.env.TOKEN_SECRET || 'grapelabs-secret-key-31-oct-2026'
};
