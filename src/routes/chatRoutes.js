const express = require('express');
const router = express.Router();
const WebAdapter = require('../adapters/webAdapter');
const ChatService = require('../services/chatService');
const env = require('../config/env');
const ConfigService = require('../services/configService');
const HandoverService = require('../services/handoverService');
const { PersonRepository, MessageRepository } = require('../db/models');

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
    // Absolute download links and an ordered message list for channels that send each message separately.
    const origin = `${req.get('x-forwarded-proto') || req.protocol}://${req.get('x-forwarded-host') || req.get('host')}`;
    const attachments = (result.attachments || []).map(item => ({ ...item, url: item.url?.startsWith('/') ? `${origin}${item.url}` : item.url }));
    const messages = [result.reply, ...attachments.map(item => `${item.title}: ${item.url}`), result.followUp].filter(Boolean);
    return res.json({ success: true, ...result, attachments, messages });
  } catch (error) {
    console.error('n8n chat API error:', error);
    return res.status(500).json({ success: false, error: 'Could not process the message.' });
  }
});

// GET /api/handover/whatsapp?clientId&personId&sessionId&page
// Builds a wa.me link with the visitor's details and last message pre-filled (no WhatsApp API).
router.get('/api/handover/whatsapp', async (req, res) => {
  try {
    const clientId = String(req.query.clientId || 'grapelabs');
    const config = await ConfigService.getConfig(clientId);
    if (!HandoverService.isAvailable(config)) {
      return res.status(404).json({ success: false, error: 'WhatsApp handover is not configured.' });
    }
    let person = null;
    if (req.query.personId) person = await PersonRepository.get(String(req.query.personId));
    if (!person && req.query.sessionId) person = await PersonRepository.findByIdentifier({ sessionId: String(req.query.sessionId) });
    if (person && person.clientId && person.clientId !== clientId) person = null;
    const messages = person ? await MessageRepository.getByPerson(person.id, 12) : [];
    const handover = await HandoverService.buildHandover({
      config,
      person,
      messages,
      page: String(req.query.page || ''),
      reason: String(req.query.reason || 'requested').slice(0, 30)
    });
    res.json({ success: true, handover });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Could not prepare the WhatsApp handover.' });
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
