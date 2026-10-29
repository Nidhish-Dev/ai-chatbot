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
    const isButtonInteraction = !!buttonPayload;
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
    let currentSession = null;
    if (sessionId) {
      sessionMessageCount = await SessionRepository.incrementMessageCount(sessionId);
      currentSession = await SessionRepository.createOrUpdate(sessionId, {
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
      content: m.role === 'user' && isButtonInteraction && m.text === actualText
        ? `The visitor clicked the quick reply button “${actualText}”. This is only a navigation/interest selection, not personal or contact information. Respond to the selection without claiming they shared details.`
        : m.text
    }));
    const sessionUserTurns = recentMessages.filter(item =>
      item.role === 'user' && (!sessionId || item.sessionId === sessionId)
    ).length;
    const conversationTurnCount = Math.max(sessionMessageCount, sessionUserTurns);

    // 6. Build dynamic system prompt with Business Context (CAG) & Brand Voice
    const systemPrompt = buildSystemPrompt(config, {
      ...person.fields,
      score: person.score,
      stage: person.stage,
      conversationTurnCount
    });

    // 7. Single AI Call (Pillar 1.2: Lean)
    const aiResult = await callAI({
      messages: formattedHistory,
      systemPrompt,
      config,
      personContext: { ...person.fields, conversationTurnCount }
    });

    const catalog = (config.products || []).filter(product => product.active !== false);
    const asksForOtherProducts = /\b(?:other|more|remaining|rest)\s+(?:of\s+the\s+)?products?\b/i.test(actualText);
    const asksForCatalog = !/\bwhat\s+does\s+.+\s+do\b|\btell\s+me\s+about\s+.+/i.test(actualText)
      && /\b(products?|services|offerings)\b/i.test(actualText)
      && /\b(what|which|list|all|offer|show|other|more|catalog|provide|sell)\b/i.test(actualText);
    let catalogResponse = false;
    if (asksForCatalog || asksForOtherProducts) {
      catalogResponse = true;
      const previouslyShownIds = new Set(recentMessages
        .filter(item => item.role === 'assistant')
        .flatMap(item => Array.isArray(item.cards) ? item.cards.map(card => String(card.id)) : []));
      const selectedProducts = asksForOtherProducts
        ? catalog.filter(product => !previouslyShownIds.has(String(product.id)))
        : catalog;
      if (!selectedProducts.length) {
        aiResult.reply = asksForOtherProducts && catalog.length
          ? 'That’s the full published product catalog. Which one would you like to explore?'
          : 'I don’t have any products in the published catalog yet. Upload your CAG document in the control panel, then publish the extracted products.';
        aiResult.cards = [];
        aiResult.buttons = catalog.length ? ['Recommend one for my business', 'Book a call'] : [];
      } else {
        aiResult.reply = asksForOtherProducts
          ? 'Here are the other products in the published catalog:'
          : selectedProducts.length > 30
            ? 'Here are the first 30 products in the published catalog. Ask “other products” to see the rest:'
            : 'Here are the products in the published catalog:';
        aiResult.cards = selectedProducts.slice(0, 30).map(product => ({
          id: product.id,
          name: product.name,
          oneLiner: product.impact || product.description
        }));
        aiResult.buttons = ['Recommend one for my business', 'Book a call'];
      }
    }

    const productCatalog = new Map(catalog.map(product => [String(product.id), product]));
    aiResult.cards = (aiResult.cards || []).slice(0, catalogResponse ? 30 : 3).map(card => {
      const product = productCatalog.get(String(card.id));
      if (!product || product.active === false) return null;
      return {
        ...card,
        name: product.name,
        description: product.description,
        impact: product.impact,
        imageUrl: product.imageUrl || '',
        price: product.price || '',
        details: product.details || '',
        ctaLabel: product.ctaLabel || '',
        ctaUrl: product.ctaUrl || ''
      };
    }).filter(Boolean);
    const nudgeSettings = config.nudges || {};

    // 8. Update extracted fields on Person Profile
    const extracted = { ...(aiResult.extracted || {}) };
    const emailMatch = actualText.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
    const phoneMatch = actualText.match(/(?:\+\d[\d\s().-]{7,}\d|\b\d{10,14}\b)/);
    const websiteText = actualText.replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, ' ');
    const websiteMatch = websiteText.match(/(?:https?:\/\/)?(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+\.[a-z]{2,}(?:\/[\w./?%&=+-]*)?/i);
    if (emailMatch) extracted.email = emailMatch[0];
    if (phoneMatch) extracted.phone = phoneMatch[0].trim();
    if (websiteMatch) extracted.website = /^https?:\/\//i.test(websiteMatch[0]) ? websiteMatch[0] : `https://${websiteMatch[0]}`;
    // Quick reply labels such as “Learn More” must never be interpreted as a name or lead data.
    if (isButtonInteraction) {
      delete extracted.name;
      delete extracted.email;
      delete extracted.phone;
      delete extracted.website;
      delete extracted.company;
      delete extracted.industry;
      delete extracted.team_size;
      delete extracted.pains;
    }
    const captureState = person.leadCapture || {};
    if (!isButtonInteraction && !extracted.name && ['name', 'contact_details'].includes(captureState.awaiting)) {
      const explicitName = actualText.match(/\b(?:my name is|i am|i'm|this is|name is)\s+([a-z][a-z .'-]{1,50})/i);
      const simpleName = actualText.trim().match(/^[A-Z][a-z'-]{1,30}(?:\s+[A-Z][a-z'-]{1,30})?$/);
      const name = (explicitName?.[1] || simpleName?.[0] || '').trim().replace(/[.!?]+$/, '');
      if (name && !/@|\d/.test(name)) extracted.name = name;
    }
    const patchFields = {};
    if (extracted.name && !person.fields.name) patchFields['fields.name'] = extracted.name;
    if (extracted.company && !person.fields.company) patchFields['fields.company'] = extracted.company;
    if (extracted.website && !person.fields.website) patchFields['fields.website'] = extracted.website;
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

    const gotContact = (!person.identifiers?.email && !!extracted.email) || (!person.identifiers?.phone && !!extracted.phone);
    const invalidNameValues = new Set(['learn more', 'more info', 'book a call', 'contact support', 'explore products', 'get recommendations']);
    const usableName = value => !!value && !invalidNameValues.has(String(value).trim().toLowerCase());
    const hasNameAfterTurn = usableName(person.fields?.name) || usableName(extracted.name);
    const hasContactAfterTurn = !!(person.identifiers?.email || person.identifiers?.phone || extracted.email || extracted.phone);
    // Let the conversation develop, then ask for follow-up details after three exchanges.
    const leadMoment = conversationTurnCount >= 3;
    const lastAskedAtMessage = sessionId
      ? currentSession?.leadCaptureLastAskedAt
      : captureState.lastAskedAtMessage;
    const shouldAskInThisSession = !lastAskedAtMessage || conversationTurnCount <= lastAskedAtMessage || conversationTurnCount - lastAskedAtMessage >= 3;
    const leadCaptureSkipReason = !leadMoment
      ? 'waiting_for_third_exchange'
      : !shouldAskInThisSession
        ? 'recently_asked'
        : hasContactAfterTurn && hasNameAfterTurn
          ? 'name_and_contact_already_saved'
          : 'prompting_for_missing_details';
    console.info(`[Lead capture] person=${person.id} session=${sessionId || 'none'} exchanges=${conversationTurnCount} action=${leadCaptureSkipReason}`);
    let leadFollowup = '';
    let nextCaptureState = captureState;
    if (leadMoment && shouldAskInThisSession) {
      if (!hasContactAfterTurn && !hasNameAfterTurn) {
        leadFollowup = 'If you would like a tailored follow-up, please share your name and either your email address or WhatsApp number.';
        nextCaptureState = { awaiting: 'contact_details', lastAskedAtMessage: conversationTurnCount, lastAskedInSession: sessionId || null };
      } else if (!hasContactAfterTurn) {
        leadFollowup = 'What is the best email address or phone number for our team to reach you?';
        nextCaptureState = { awaiting: 'contact', lastAskedAtMessage: conversationTurnCount, lastAskedInSession: sessionId || null };
      } else if (!hasNameAfterTurn) {
        leadFollowup = 'If you would like a tailored follow-up, what name should I use?';
        nextCaptureState = { awaiting: 'name', lastAskedAtMessage: conversationTurnCount, lastAskedInSession: sessionId || null };
      } else {
        nextCaptureState = { ...captureState, awaiting: null };
      }
    }
    if (leadFollowup) aiResult.reply = `${aiResult.reply}\n\n${leadFollowup}`;
    const cooldownExchanges = Math.max(1, Number(nudgeSettings.cooldownExchanges || 3));
    const lastNudgeAtTurn = Number(currentSession?.nudgeLastAtTurn || 0);
    const nudgeCooldownPassed = !lastNudgeAtTurn || conversationTurnCount - lastNudgeAtTurn >= cooldownExchanges;
    const nudgeEligible = nudgeSettings.enabled !== false
      && conversationTurnCount >= Number(nudgeSettings.minExchanges || 3)
      && nudgeCooldownPassed
      && !/\b(no thanks|stop|not interested|bye|goodbye)\b/i.test(actualText);
    if (!nudgeEligible) aiResult.nudge = null;
    else if (!aiResult.nudge?.message) {
      const nudgeMessage = aiResult.cards?.length
        ? 'Would you like details on one of these, or should I recommend the best fit for your business?'
        : 'Would a tailored example or a recommended next step be more useful?';
      aiResult.nudge = { message: nudgeMessage, label: '' };
    }
    if (aiResult.nudge && sessionId) {
      await SessionRepository.createOrUpdate(sessionId, { nudgeLastAtTurn: conversationTurnCount });
    }
    console.info(`[AI nudge] session=${sessionId || 'none'} exchanges=${conversationTurnCount} action=${aiResult.nudge ? 'queued' : 'not-eligible'} delaySeconds=${Number(nudgeSettings.delaySeconds || 45)}`);
    if (leadMoment || Object.keys(nextCaptureState).length) patchFields.leadCapture = nextCaptureState;
    if (leadFollowup && sessionId) {
      await SessionRepository.createOrUpdate(sessionId, {
        leadCapturePrompted: true,
        leadCaptureLastAskedAt: conversationTurnCount
      });
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

    if (gotContact && !person.leadContactNotified) {
      updatedPerson = await PersonRepository.update(updatedPerson.id, { leadContactNotified: true });
      await EventService.emit('lead_contact_captured', {
        personId: updatedPerson.id,
        clientId,
        channel,
        payload: { person: updatedPerson, lastMessage: actualText }
      });
    }

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
      text: aiResult.nudge ? `${aiResult.reply}\n\nSuggested next step: ${aiResult.nudge.message}` : aiResult.reply,
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
      nudge: aiResult.nudge || null,
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
