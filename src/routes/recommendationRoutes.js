const express = require('express');
const router = express.Router();
const ConfigService = require('../services/configService');
const RecommendationService = require('../services/recommendationService');
const { PersonRepository } = require('../db/models');

/**
 * POST /api/recommendations
 * Body: { clientId, personId?, sessionId?, browsing?: [{url,title,at}], limit?, preview?, profile? }
 *  - Widget: send personId/sessionId and the visitor's recent page views.
 *  - Control panel: send preview: true with a sample `profile` ({ industry, pains, interests, pages, intent })
 *    to see how the draft catalog would be ranked.
 */
router.post('/api/recommendations', async (req, res) => {
  try {
    const { clientId = 'grapelabs', personId, sessionId, browsing = [], limit, preview = false, profile = null } = req.body || {};
    const config = await ConfigService.getConfig(clientId);
    const settings = RecommendationService.settings(preview ? { recommendations: config.draft?.recommendations || config.recommendations } : config);
    if (!preview && settings.enabled === false) {
      return res.json({ success: true, enabled: false, personalised: false, items: [] });
    }

    let person = null;
    if (!preview) {
      if (typeof personId === 'string' && personId) person = await PersonRepository.get(personId);
      if (!person && typeof sessionId === 'string' && sessionId) person = await PersonRepository.findByIdentifier({ sessionId });
      if (person && person.clientId && person.clientId !== clientId) person = null;
    }

    const result = RecommendationService.recommendFor({
      config,
      person,
      browsing,
      limit,
      override: preview ? profile : null,
      preview
    });
    res.json({ success: true, enabled: true, ...result });
  } catch (err) {
    console.error('Recommendation error:', err);
    res.status(500).json({ success: false, error: 'Could not load recommendations.' });
  }
});

module.exports = router;
