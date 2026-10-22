const express = require('express');
const router = express.Router();
const ConfigService = require('../services/configService');
const { getApiKey, getModel } = require('../ai/openaiService');

function clientSafeConfig(config) {
  const safe = JSON.parse(JSON.stringify(config));
  if (safe.ai) delete safe.ai.apiKey;
  if (safe.alerts) delete safe.alerts.n8nWebhookUrl;
  return safe;
}

// POST /config/refresh (Section 7.1)
router.post('/config/refresh', (req, res) => {
  const { clientId = 'grapelabs' } = req.body;
  ConfigService.refreshCache(clientId);
  res.json({ success: true, message: `Config cache refreshed for ${clientId}` });
});

// GET /api/config
router.get('/api/config', async (req, res) => {
  try {
    const clientId = req.query.clientId || 'grapelabs';
    const config = await ConfigService.getConfig(clientId);
    const key = config.ai?.apiKey || getApiKey();
    res.json({
      success: true,
      config: clientSafeConfig(config),
      openai: {
        hasKey: !!key,
        maskedKey: key ? `${key.slice(0, 7)}...${key.slice(-4)}` : '',
        model: config.ai?.model || getModel()
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/config/openai - Save OpenAI API Key & Model
router.post('/api/config/openai', async (req, res) => {
  const { apiKey, model = 'gpt-4o-mini', clientId = 'grapelabs' } = req.body;
  if (!apiKey) {
    return res.status(400).json({ success: false, error: 'API key is required' });
  }
  try {
    await ConfigService.saveAISettings(clientId, apiKey, model);
    res.json({
      success: true,
      message: 'OpenAI API key saved successfully and activated.',
      model
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/config/draft
router.post('/api/config/draft', async (req, res) => {
  try {
    const { clientId = 'grapelabs', draft } = req.body;
    const updated = await ConfigService.updateDraft(clientId, draft);
    res.json({ success: true, config: clientSafeConfig(updated) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/config/publish
router.post('/api/config/publish', async (req, res) => {
  try {
    const { clientId = 'grapelabs', author = 'Admin' } = req.body;
    const published = await ConfigService.publish(clientId, author);
    res.json({ success: true, message: 'Changes published live successfully!', config: clientSafeConfig(published) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/config/rollback
router.post('/api/config/rollback', async (req, res) => {
  try {
    const { clientId = 'grapelabs' } = req.body;
    const rolledBack = await ConfigService.rollback(clientId);
    res.json({ success: true, message: 'Successfully rolled back to previous version', config: clientSafeConfig(rolledBack) });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// POST /api/config/prompt-ai
router.post('/api/config/prompt-ai', async (req, res) => {
  try {
    const { clientId = 'grapelabs', instruction } = req.body;
    if (!instruction) return res.status(400).json({ success: false, error: 'Instruction is required' });

    const newPrompt = await ConfigService.rewritePromptWithAI(clientId, instruction);
    res.json({ success: true, promptDraft: newPrompt });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/config/kill-switch
router.post('/api/config/kill-switch', async (req, res) => {
  try {
    const { clientId = 'grapelabs', channel = 'overall', enabled } = req.body;
    const updated = await ConfigService.setChannelStatus(clientId, channel, enabled);
    res.json({ success: true, config: clientSafeConfig(updated) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
