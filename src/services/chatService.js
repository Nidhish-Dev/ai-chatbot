const ConfigService = require('./configService');
const IdentityService = require('./identityService');
const LeadService = require('./leadService');
const EventService = require('./eventService');
const { MessageRepository, SessionRepository, PersonRepository } = require('../db/models');
const { buildSystemPrompt } = require('../ai/promptBuilder');
const { callAI } = require('../ai/openaiService');

class ChatService {
  /**
   * Process a message from any channel (Web, WhatsApp, Instagram)
   * Follows Pillar 1.2: One single AI call per user message returning reply, intent, extracted fields, score signals, and buttons.
   */
  static async handleIncomingMessage({
    clientId = 'grapelabs',
    channel = 'web',
    channelUserId,
    personId,
    sessionId,
    message,
    buttonPayload,
    attachments = [],
    linkToken = null,
    metadata = {}
  }) {
    const startTime = Date.now();
    const config = await ConfigService.getConfig(clientId);

    // 1. Check Kill Switch (Pillar 1.4)
    if (!config.active) {
      return {
        reply: "Our automated assistant is temporarily offline for scheduled system updates. Please reach out to our team directly via team@grapelabs.in.",
        buttons: [],
        cards: [],
        intent: 'system_offline',
        extracted: {},
        score_signals: []
      };
    }

    const channelConfig = config.channels?.[channel];
    if (channelConfig && !channelConfig.enabled) {
      return {
        reply: `This channel is currently paused. Please visit ${config.links?.websiteUrl || 'grapelabs.in'} to chat with our team.`,
        buttons: [],
        cards: [],
        intent: 'channel_disabled',
        extracted: {},
        score_signals: []
      };
    }

    // 2. Resolve Person Identity across channels
    const actualText = (buttonPayload || message || '').trim();
    let person = null;

    if (personId) {
      person = await PersonRepository.get(personId);
    }

    if (!person) {
      person = await IdentityService.resolvePerson({
        clientId,
        channel,
        channelUserId,
        sessionId,
        linkToken,
        text: actualText,
        email: metadata.email,
        phone: metadata.phone
      });
    }

    const pageUrl = metadata.page || null;
    if (pageUrl && !(person.pagesVisited || []).includes(pageUrl)) {
      const visited = [...(person.pagesVisited || []), pageUrl].slice(-100);
      const personPatch = { pagesVisited: visited };
      if (!person.source && metadata.utm?.utm_source) personPatch.source = metadata.utm.utm_source;
      if (!person.referrer && metadata.referrer) personPatch.referrer = metadata.referrer;
      if (!person.utm || !Object.keys(person.utm).length) personPatch.utm = metadata.utm || {};
      person = await PersonRepository.update(person.id, personPatch);
    }

    if (person.handoffStatus === 'open' && channel !== 'web') {
      return { reply: '', buttons: [], cards: [], intent: 'human', extracted: {}, score_signals: [], person: { id: person.id, stage: person.stage, score: person.score }, silent: true };
    }

    // 3. Track Session Message Count & Cap check (Section 5.2: 20 messages without contact details)
    let sessionMessageCount = 1;
    if (sessionId) {
      sessionMessageCount = await SessionRepository.incrementMessageCount(sessionId);
      await SessionRepository.createOrUpdate(sessionId, {
        personId: person.id,
        channel,
        page: metadata.page,
        referrer: metadata.referrer,
        utm: metadata.utm || {}
      });
    }

    const hasContact = !!(person.identifiers?.email || person.identifiers?.phone || channel === 'whatsapp');
    const maxMessagesWithoutContact = config.limits?.maxMessagesWithoutContact || 20;

    if (!hasContact && sessionMessageCount > maxMessagesWithoutContact) {
      const softAskReply = "You've been asking some great questions! To make sure we give you the most tailored automation blueprint (and so our engineers can follow up with exact specs), what is the best email or WhatsApp number to reach you at?";
      return {
        reply: softAskReply,
        buttons: ["Share contact", "Book a call", "Try it on my business"],
        cards: [],
        intent: 'contact_cap_soft_ask',
        extracted: {},
        score_signals: []
      };
    }

    // 4. Save Inbound User Message to Postgres/Firebase
    await MessageRepository.add({
      personId: person.id,
      sessionId,
      channel,
      role: 'user',
      text: actualText,
      intent: null,
      buttons: [],
      cards: [],
      extracted: {},
      scoreSignals: []
    });

    // 5. Fetch recent chat history for context
    const recentMessages = await MessageRepository.getByPerson(person.id, 8);
    const formattedHistory = recentMessages.map(m => ({
      role: m.role,
      content: m.text
    }));

    // 6. Build dynamic system prompt with Business Context (CAG) & Brand Voice
    const systemPrompt = buildSystemPrompt(config, {
      ...person.fields,
      score: person.score,
      stage: person.stage
    });

    // 7. Single AI Call (Pillar 1.2: Lean)
    const aiResult = await callAI({
      messages: formattedHistory,
      systemPrompt,
      config,
      personContext: person.fields
    });

    // 8. Update extracted fields on Person Profile
    const extracted = aiResult.extracted || {};
    const patchFields = {};
    if (extracted.name && !person.fields.name) patchFields['fields.name'] = extracted.name;
    if (extracted.company && !person.fields.company) patchFields['fields.company'] = extracted.company;
    if (extracted.industry && !person.fields.industry) patchFields['fields.industry'] = extracted.industry;
    if (extracted.team_size && !person.fields.teamSize) patchFields['fields.teamSize'] = extracted.team_size;
    if (extracted.pains && !person.fields.pains) patchFields['fields.pains'] = extracted.pains;
    if (aiResult.cards && aiResult.cards.length > 0) {
      const recNames = aiResult.cards.map(c => c.name);
      patchFields['fields.productsRecommended'] = Array.from(new Set([...(person.fields.productsRecommended || []), ...recNames]));
    }
    if (extracted.email && !person.identifiers.email) {
      patchFields['identifiers.email'] = extracted.email.toLowerCase().trim();
    }
    if (extracted.phone && !person.identifiers.phone) {
      patchFields['identifiers.phone'] = extracted.phone.trim();
    }

    let updatedPerson = person;
    if (Object.keys(patchFields).length > 0) {
      updatedPerson = await PersonRepository.update(person.id, patchFields);
    }

    // Link records only on exact email/phone matches; never on names or handles.
    const matchedPerson = await PersonRepository.findByIdentifier({
      email: extracted.email || null,
      phone: extracted.phone || null
    });
    if (matchedPerson && matchedPerson.id !== updatedPerson.id) {
      updatedPerson = await IdentityService.mergeProfiles(matchedPerson.id, updatedPerson.id);
    }

    // 9. Lead Scoring & Stage Transition (Signals)
    const scoreSignals = aiResult.score_signals || [];
    updatedPerson = await LeadService.evaluateLead({
      person: updatedPerson,
      newSignals: scoreSignals,
      messageCount: sessionMessageCount,
      config
    });

    // 10. Human Handoff Alert if requested (Section 5.9)
    if (aiResult.intent === 'human') {
      if (channel !== 'web') {
        updatedPerson = await PersonRepository.update(updatedPerson.id, { handoffStatus: 'open', handoffChannel: channel });
      }
      await EventService.emit('human_requested', {
        personId: updatedPerson.id,
        clientId,
        channel,
        payload: {
          person: updatedPerson,
          lastMessage: actualText,
          channel
        }
      });
    }

    // 11. Save Assistant Reply to DB
    await MessageRepository.add({
      personId: updatedPerson.id,
      sessionId,
      channel,
      role: 'assistant',
      text: aiResult.reply,
      intent: aiResult.intent,
      buttons: aiResult.buttons,
      cards: aiResult.cards,
      extracted: aiResult.extracted,
      scoreSignals: aiResult.score_signals
    });

    // 12. Return Shared Output Format (Section 14.3)
    return {
      reply: aiResult.reply,
      buttons: aiResult.buttons || [],
      cards: aiResult.cards || [],
      intent: aiResult.intent || 'faq',
      extracted: aiResult.extracted || {},
      score_signals: aiResult.score_signals || [],
      person: {
        id: updatedPerson.id,
        stage: updatedPerson.stage,
        score: updatedPerson.score,
        name: updatedPerson.fields.name
      },
      latencyMs: Date.now() - startTime
    };
  }
}

module.exports = ChatService;
