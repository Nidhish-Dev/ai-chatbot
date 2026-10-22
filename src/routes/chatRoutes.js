const express = require('express');
const router = express.Router();
const WebAdapter = require('../adapters/webAdapter');
const ChatService = require('../services/chatService');
const env = require('../config/env');

// POST /chat (Section 7.1)
router.post('/chat', (req, res) => {
  return WebAdapter.handleWebMessage(req, res);
});

// n8n calls this endpoint after receiving a WhatsApp or Instagram event.
router.post('/api/chat', async (req, res) => {
  if (!env.N8N_API_KEY) {
    return res.status(503).json({ success: false, error: 'N8N_API_KEY is not configured on the server.' });
  }

  const suppliedKey = req.get('x-api-key') || req.get('authorization')?.replace(/^Bearer\s+/i, '');
  if (suppliedKey !== env.N8N_API_KEY) {
    return res.status(401).json({ success: false, error: 'Invalid API key.' });
  }

  const {
    clientId = 'grapelabs', channel, channelUserId, message,
    sessionId, personId, buttonPayload, metadata = {}
  } = req.body || {};
  if (!['whatsapp', 'instagram', 'web'].includes(channel)) {
    return res.status(400).json({ success: false, error: 'channel must be whatsapp, instagram, or web.' });
  }
  if (typeof channelUserId !== 'string' || !channelUserId.trim()) {
    return res.status(400).json({ success: false, error: 'channelUserId is required.' });
  }
  if (typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ success: false, error: 'message is required.' });
  }

  try {
    const result = await ChatService.handleIncomingMessage({
      clientId, channel, channelUserId: channelUserId.trim(), message: message.trim(),
      sessionId, personId, buttonPayload, metadata
    });
    return res.json({ success: true, ...result });
  } catch (error) {
    console.error('n8n chat API error:', error);
    return res.status(500).json({ success: false, error: 'Could not process the message.' });
  }
});

// GET /api/handshake/whatsapp/:personId
router.get('/api/handshake/whatsapp/:personId', async (req, res) => {
  try {
    const handshake = await WebAdapter.getWhatsAppHandshake(req.params.personId, req.query.clientId || 'grapelabs');
    res.json({ success: true, ...handshake });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
