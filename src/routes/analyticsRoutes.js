const express = require('express');
const router = express.Router();
const AnalyticsService = require('../services/analyticsService');

// GET /api/analytics/dashboard?clientId&days=30&channel=all&tzOffset=-330
router.get('/api/analytics/dashboard', async (req, res) => {
  try {
    const data = await AnalyticsService.dashboard({
      clientId: String(req.query.clientId || 'grapelabs'),
      days: Number(req.query.days) || 30,
      channel: ['web', 'whatsapp', 'instagram'].includes(req.query.channel) ? req.query.channel : 'all',
      tzOffset: Number(req.query.tzOffset) || 0
    });
    res.json({ success: true, ...data });
  } catch (err) {
    console.error('Analytics error:', err);
    res.status(500).json({ success: false, error: 'Could not load analytics.' });
  }
});

// GET /api/conversations?clientId&q&channel&filter=all|lead|handover|unsure|booking&days=90|all&limit&offset
router.get('/api/conversations', async (req, res) => {
  try {
    const result = await AnalyticsService.conversations({
      clientId: String(req.query.clientId || 'grapelabs'),
      q: String(req.query.q || '').slice(0, 200),
      channel: ['web', 'whatsapp', 'instagram'].includes(req.query.channel) ? req.query.channel : 'all',
      filter: ['lead', 'handover', 'unsure', 'booking'].includes(req.query.filter) ? req.query.filter : 'all',
      days: req.query.days === 'all' ? 'all' : Number(req.query.days) || 90,
      limit: Number(req.query.limit) || 50,
      offset: Number(req.query.offset) || 0
    });
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('Conversation history error:', err);
    res.status(500).json({ success: false, error: 'Could not load conversations.' });
  }
});

// GET /api/conversations/:key  (key from the list, URL-encoded)
router.get('/api/conversations/:key', async (req, res) => {
  try {
    const conversation = await AnalyticsService.conversation({ clientId: String(req.query.clientId || 'grapelabs'), key: req.params.key });
    if (!conversation) return res.status(404).json({ success: false, error: 'Conversation not found.' });
    res.json({ success: true, conversation });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Could not load this conversation.' });
  }
});

module.exports = router;
