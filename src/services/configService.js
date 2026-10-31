const defaultClientConfig = require('../config/defaultClientConfig');
const { ClientRepository } = require('../db/models');
const { callAI } = require('../ai/openaiService');

// In-memory config cache for ultra-fast response without polling
const configCache = new Map();

// Remove FAQ records seeded by the original sample configuration on its first load.
// User-entered and document-generated FAQs use different IDs and are retained.
const LEGACY_SEEDED_FAQ_IDS = new Set([
  'faq_data_safety', 'faq_timelines', 'faq_tech_team', 'faq_shopify_tools',
  'faq_bot_vs_automation', 'faq_project_runs', 'faq_after_golive',
  'faq_handover_vs_maintenance', 'faq_outside_india', 'faq_pricing_policy',
  'faq_custom_crm', 'faq_whatsapp_approval', 'faq_instagram_rules',
  'faq_error_handling', 'faq_roi', 'faq_data_entry', 'faq_peak_scalability',
  'faq_omnichannel', 'faq_ai_accuracy', 'faq_turnaround', 'faq_dpdp_privacy',
  'faq_human_handoff', 'faq_order_tracking', 'faq_abandoned_cart', 'faq_reviews',
  'faq_erp_wms', 'faq_hinglish', 'faq_custom_dashboard',
  'faq_credentials_safety', 'faq_get_started'
]);
const LEGACY_SEEDED_FAQ_CHIPS = new Set([
  'How does this work?', 'Is my data safe?', 'What tools do you integrate with?',
  'How long does a build take?', 'Can you automate my WhatsApp?'
]);
const LEGACY_SEEDED_TEASER_CHIPS = new Set([
  'How does this work?', 'Is my data safe?', 'Try it on my business'
]);

function removeLegacyFaqData(config) {
  let changed = false;
  const cleaned = { ...config };

  function cleanSection(section) {
    if (!section || typeof section !== 'object') return section;
    const result = { ...section };
    if (Array.isArray(section.faqs)) {
      result.faqs = section.faqs.filter(faq => !LEGACY_SEEDED_FAQ_IDS.has(faq?.id));
      if (result.faqs.length !== section.faqs.length) changed = true;
    }
    if (Array.isArray(section.faqChips)) {
      result.faqChips = section.faqChips.filter(chip => !LEGACY_SEEDED_FAQ_CHIPS.has(chip?.text));
      if (result.faqChips.length !== section.faqChips.length) changed = true;
    }
    if (section.teaser && Array.isArray(section.teaser.chips)) {
      result.teaser = {
        ...section.teaser,
        chips: section.teaser.chips.filter(chip => !LEGACY_SEEDED_TEASER_CHIPS.has(chip))
      };
      if (result.teaser.chips.length !== section.teaser.chips.length) changed = true;
    }
    return result;
  }

  Object.assign(cleaned, cleanSection(config));
  if (config.draft) cleaned.draft = cleanSection(config.draft);

  const previousUnknownAnswer = '2. If asked a question that is NOT in your business context or FAQs, say: "I\'ll check with our product team on that. Could you share your email or WhatsApp number so we can get right back to you?"';
  const newUnknownAnswer = '2. If configured business knowledge does not support a confident answer, say exactly: "I\'m not sure about this. We\'ll get back to you regarding this." Never guess or add unsupported facts.';
  for (const target of [cleaned, cleaned.draft].filter(Boolean)) {
    if (typeof target.brandVoice === 'string' && target.brandVoice.includes(previousUnknownAnswer)) {
      target.brandVoice = target.brandVoice.replace(previousUnknownAnswer, newUnknownAnswer);
      changed = true;
    }
  }

  return { config: cleaned, changed };
}

function stripUndefined(value) {
  if (Array.isArray(value)) return value.filter(item => item !== undefined).map(stripUndefined);
  if (!value || typeof value !== 'object' || value instanceof Date) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, child]) => child !== undefined)
      .map(([key, child]) => [key, stripUndefined(child)])
  );
}

class ConfigService {
  /**
   * Get live active config for a client (with memory caching)
   */
  static async getConfig(clientId = 'grapelabs') {
    if (configCache.has(clientId)) {
      return configCache.get(clientId);
    }

    let config = await ClientRepository.get(clientId);
    if (!config) {
      // Seed default config for GrapeLabs
      config = JSON.parse(JSON.stringify(defaultClientConfig));
      await ClientRepository.set(clientId, config);
    } else if (config.faqSeedCleanupVersion !== 1) {
      const migration = removeLegacyFaqData(config);
      config = { ...migration.config, faqSeedCleanupVersion: 1 };
      await ClientRepository.set(clientId, stripUndefined(config));
      if (migration.changed) {
        console.log(`🧹 Removed hardcoded sample FAQ content for client: ${clientId}`);
      }
    }

    // Configs saved before quick actions / recommendations existed get the defaults (not persisted
    // until the operator saves and publishes from the control panel).
    for (const key of ['quickActions', 'recommendations', 'leadCapture', 'personality', 'handover', 'appearance']) {
      if (!config[key] || typeof config[key] !== 'object') {
        config = { ...config, [key]: JSON.parse(JSON.stringify(defaultClientConfig[key])) };
      }
    }

    configCache.set(clientId, config);
    return config;
  }

  /**
   * Invalidate / refresh cached config
   */
  static refreshCache(clientId = 'grapelabs') {
    configCache.delete(clientId);
  }

  static async saveAISettings(clientId = 'grapelabs', apiKey, model = 'gpt-4o-mini') {
    if (!apiKey || typeof apiKey !== 'string' || !apiKey.trim()) throw new Error('OpenAI API key is required');
    const config = await this.getConfig(clientId);
    const updated = { ...config, ai: { ...(config.ai || {}), apiKey: apiKey.trim(), model } };
    await ClientRepository.set(clientId, updated);
    this.refreshCache(clientId);
    return updated;
  }

  /**
   * Save draft config
   */
  static async updateDraft(clientId = 'grapelabs', draftUpdates = {}) {
    if (!draftUpdates || typeof draftUpdates !== 'object' || Array.isArray(draftUpdates)) {
      throw new Error('Draft must be a configuration object');
    }
    const current = await this.getConfig(clientId);
    const updated = {
      ...current,
      draft: {
        ...(current.draft || {}),
        ...draftUpdates,
        updatedAt: new Date().toISOString()
      }
    };
    await ClientRepository.set(clientId, updated);
    this.refreshCache(clientId);
    return updated;
  }

  /**
   * Publish Draft to Live (Pillar 1.1 / Section 6.2)
   */
  static async publish(clientId = 'grapelabs', author = 'User') {
    const current = await this.getConfig(clientId);
    const draft = current.draft || {};

    const liveKeys = [
      'active', 'branding', 'cagCompanyName', 'channels', 'faqs', 'products', 'nudges', 'brandVoice', 'customKnowledge',
      'knowledge', 'promptLive', 'scoring', 'teaser', 'links', 'alerts', 'limits',
      'consultant', 'faqChips', 'leadRules', 'messageLimits', 'tryIt', 'knowledgeDocuments',
      'quickActions', 'recommendations', 'leadCapture', 'personality', 'handover', 'appearance'
    ];
    const previousLive = Object.fromEntries(
      liveKeys
        .filter(key => Object.prototype.hasOwnProperty.call(current, key) && current[key] !== undefined)
        .map(key => [key, current[key]])
    );
    previousLive.version = current.promptVersion || 1;

    const newVersion = (current.promptVersion || 1) + 1;

    const published = {
      ...current,
      ...Object.fromEntries(liveKeys
        .filter(key => Object.prototype.hasOwnProperty.call(draft, key))
        .map(key => [key, draft[key]])),
      promptLive: draft.promptDraft || draft.promptLive || current.promptLive,
      promptVersion: newVersion,
      previousLiveVersion: previousLive,
      changeLog: [
        {
          version: newVersion,
          date: new Date().toISOString(),
          author,
          note: draft.changeNote || 'Published draft changes'
        },
        ...(current.changeLog || [])
      ],
      draft: null // Draft cleared after successful publish
    };

    const firestoreSafePublished = stripUndefined(published);
    await ClientRepository.set(clientId, firestoreSafePublished);
    this.refreshCache(clientId);
    console.log(`🚀 Published config v${newVersion} for client: ${clientId}`);
    return firestoreSafePublished;
  }

  /**
   * Roll back to previous live version
   */
  static async rollback(clientId = 'grapelabs') {
    const current = await this.getConfig(clientId);
    if (!current.previousLiveVersion) {
      throw new Error('No previous version available for rollback');
    }

    const prev = current.previousLiveVersion;
    const rolledBack = {
      ...current,
      ...prev,
      promptLive: prev.promptLive,
      promptVersion: (current.promptVersion || 1) + 1,
      changeLog: [
        {
          version: (current.promptVersion || 1) + 1,
          date: new Date().toISOString(),
          author: 'system',
          note: `Rolled back to v${prev.version}`
        },
        ...(current.changeLog || [])
      ]
    };

    await ClientRepository.set(clientId, rolledBack);
    this.refreshCache(clientId);
    return rolledBack;
  }

  /**
   * Rewrite system prompt with AI (Section 6.2)
   */
  static async rewritePromptWithAI(clientId = 'grapelabs', userInstruction) {
    const config = await this.getConfig(clientId);
    const currentPrompt = config.promptDraft || config.promptLive;

    const systemPrompt = `You are an expert AI prompt engineer.
Modify the following system prompt according to the user's specific instruction.
Preserve core behavioral guidelines, safety rules, and structured JSON output requirements.
Output ONLY the revised prompt text with no conversational wrapper.`;

    const aiResult = await callAI({
      messages: [
        { role: 'user', content: `Current Prompt:\n${currentPrompt}\n\nInstruction:\n${userInstruction}` }
      ],
      systemPrompt,
      config,
      personContext: {}
    });

    const newDraftPrompt = aiResult.reply || currentPrompt;

    await this.updateDraft(clientId, {
      promptDraft: newDraftPrompt,
      changeNote: `AI prompt modification: ${userInstruction.slice(0, 50)}...`
    });

    return newDraftPrompt;
  }

  /**
   * Kill Switch: overall or per channel (Section 1.4, 6.2)
   */
  static async setChannelStatus(clientId = 'grapelabs', channel, enabled) {
    const config = await this.getConfig(clientId);
    if (channel === 'overall') {
      config.active = !!enabled;
    } else if (config.channels && config.channels[channel]) {
      config.channels[channel].enabled = !!enabled;
    }
    await ClientRepository.set(clientId, config);
    this.refreshCache(clientId);
    return config;
  }
}

module.exports = ConfigService;
