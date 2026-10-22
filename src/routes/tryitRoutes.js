const express = require('express');
const router = express.Router();
const TryItService = require('../services/tryItService');
const ConfigService = require('../services/configService');

// POST /tryit/start (Section 7.1)
router.post('/tryit/start', async (req, res) => {
  const {
    name,
    email,
    phone,
    websiteUrl,
    businessDescription,
    consent,
    personId,
    sessionId,
    clientId = 'grapelabs'
  } = req.body;

  try {
    const config = await ConfigService.getConfig(clientId);
    const ip = req.socket.remoteAddress || '127.0.0.1';

    let result;
    if (websiteUrl) {
      result = await TryItService.startTryIt({
        name,
        email,
        phone,
        websiteUrl,
        consent,
        ip,
        personId,
        sessionId,
        clientId,
        config
      });
    } else if (businessDescription) {
      result = await TryItService.startFallbackTryIt({
        name,
        email,
        phone,
        businessDescription,
        consent,
        ip,
        personId,
        config
      });
    } else {
      return res.status(400).json({ success: false, error: 'Please provide either a website URL or 3-line business description.' });
    }

    res.json({
      success: true,
      ...result
    });
  } catch (err) {
    res.status(400).json({
      success: false,
      error: err.message
    });
  }
});

// POST /tryit/chat (Demo mode interaction)
router.post('/tryit/chat', async (req, res) => {
  const { demoSessionId, message, clientId = 'grapelabs' } = req.body;

  if (!demoSessionId || !message) {
    return res.status(400).json({ success: false, error: 'Missing demoSessionId or message' });
  }

  try {
    const config = await ConfigService.getConfig(clientId);
    const result = await TryItService.chatDemo({
      demoSessionId,
      message,
      config
    });
    res.json({
      success: true,
      ...result
    });
  } catch (err) {
    res.status(400).json({
      success: false,
      error: err.message
    });
  }
});

module.exports = router;
