const express = require('express');
const router = express.Router();
const ConfigService = require('../services/configService');
const { getApiKey, getModel, getOpenAIClient } = require('../ai/openaiService');
const { resolveProductImageUrl } = require('../ai/siteCrawler');

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
    if (Array.isArray(draft?.products)) {
      draft.products = await Promise.all(draft.products.map(async product => {
        if (!product.imageUrl) return product;
        try {
          return { ...product, imageUrl: await resolveProductImageUrl(product.imageUrl) };
        } catch (error) {
          throw new Error(`Could not load the image for “${product.name || 'a product'}”: ${error.message}`);
        }
      }));
    }
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

// Generate an editable explanation of the configured in-chat nudge policy.
router.post('/api/config/nudges/preview', async (req, res) => {
  try {
    const { clientId = 'grapelabs', nudges, products } = req.body;
    const config = await ConfigService.getConfig(clientId);
    const client = getOpenAIClient(config.ai?.apiKey || getApiKey());
    if (!client) return res.status(400).json({ success: false, error: 'Save an OpenAI API key before generating an AI nudge preview.' });
    const settings = nudges || config.draft?.nudges || config.nudges || {};
    const catalog = Array.isArray(products) ? products : config.draft?.products || config.products || [];
    const response = await client.chat.completions.create({
      model: config.ai?.model || getModel(),
      messages: [
        { role: 'system', content: 'Explain the supplied chatbot nudge configuration to a business operator. Be concrete and honest: describe the visitor message threshold, behavior signals, idle delay in seconds, cooldown, example messages, and cases where no nudge is sent. Clarify that a new visitor message cancels the pending nudge. Do not claim background messages exist. Return valid JSON with shape {"summary":"...","conditions":[{"when":"...","nudge":"..."}],"suppressed":["..."]}. Do not add rules not supported by settings.' },
        { role: 'user', content: JSON.stringify({ settings, products: catalog.filter(product => product.active !== false).map(({ id, name, description }) => ({ id, name, description })) }) }
      ],
      response_format: { type: 'json_object' },
      temperature: 0.2
    });
    res.json({ success: true, preview: JSON.parse(response.choices[0].message.content) });
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
