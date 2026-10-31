const ConfigService = require('./configService');
const IdentityService = require('./identityService');
const LeadService = require('./leadService');
const EventService = require('./eventService');
const RecommendationService = require('./recommendationService');
const LeadCaptureService = require('./leadCaptureService');
const HandoverService = require('./handoverService');
const { MessageRepository, SessionRepository, PersonRepository } = require('../db/models');
const { buildSystemPrompt } = require('../ai/promptBuilder');
const { callAI } = require('../ai/openaiService');

// Apply a dot-notation patch to a copy of the person, to see what will be known after this turn.
function applyPatchPreview(person, patch) {
  const copy = JSON.parse(JSON.stringify(person || {}));
  for (const [key, value] of Object.entries(patch || {})) {
    const parts = key.split('.');
    let target = copy;
    parts.slice(0, -1).forEach(part => { target[part] = target[part] && typeof target[part] === 'object' ? target[part] : {}; target = target[part]; });
    target[parts[parts.length - 1]] = value;
  }
  return copy;
}

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
      const capQuestions = LeadCaptureService.missingQuestions(person, LeadCaptureService.enabledQuestions(LeadCaptureService.settings(config)));
      const capSettings = LeadCaptureService.settings(config);
      if (capSettings.enabled && capQuestions.length) {
        const payload = LeadCaptureService.buildPayload({ type: 'questions', settings: capSettings, questions: capQuestions.slice(0, Math.max(1, Number(capSettings.questionsPerAsk) || 3)) });
        return {
          reply: "You've been asking some great questions! To keep going with a tailored answer, please share a few details below.",
          buttons: [],
          cards: [],
          intent: 'contact_cap_soft_ask',
          extracted: {},
          score_signals: [],
          leadCapture: payload,
          followUp: channel !== 'web' ? LeadCaptureService.followUpText(payload) : '',
          attachments: [],
          person: { id: person.id, stage: person.stage, score: person.score, name: person.fields?.name }
        };
      }
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

    // 4b. Learn preferences for personalised recommendations (topics, products opened,
    // purchase intent, quiz answers, browsing history sent by the widget).
    const quizAnswers = Array.isArray(metadata.quizAnswers) ? metadata.quizAnswers : null;
    const learnedPreferences = RecommendationService.learnFromMessage({
      person,
      text: actualText,
      isButton: isButtonInteraction,
      config,
      browsing: metadata.browsing,
      quizAnswers
    });
    const preferencePatch = learnedPreferences ? { preferences: learnedPreferences } : {};
    if (quizAnswers) {
      const quizFieldMap = { industry: 'fields.industry', team_size: 'fields.teamSize', pains: 'fields.pains' };
      quizAnswers.forEach(item => {
        const target = quizFieldMap[item?.field];
        if (target && typeof item.answer === 'string' && item.answer.trim()) preferencePatch[target] = item.answer.trim().slice(0, 120);
      });
    }
    if (Object.keys(preferencePatch).length) {
      person = await PersonRepository.update(person.id, preferencePatch);
    }

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
    const leadSettings = LeadCaptureService.settings(config);
    const requestedResource = LeadCaptureService.matchResource({
      config,
      text: isButtonInteraction && !metadata.requestResourceId ? '' : actualText,
      resourceId: typeof metadata.requestResourceId === 'string' ? metadata.requestResourceId : null
    });
    const recommendationSettings = RecommendationService.settings(config);
    const recommendationResult = recommendationSettings.enabled !== false
      ? RecommendationService.recommendFor({ config, person, limit: Math.max(3, Number(recommendationSettings.maxItems) || 3) })
      : null;

    const systemPrompt = buildSystemPrompt(config, {
      ...person.fields,
      score: person.score,
      stage: person.stage,
      conversationTurnCount,
      recommendationBlock: RecommendationService.promptBlock(recommendationResult),
      resourceBlock: leadSettings.enabled && ['gated', 'both'].includes(leadSettings.mode)
        ? leadSettings.resources.filter(resource => resource.enabled !== false).map(resource => `- [${resource.id}] ${resource.title}${resource.description ? `: ${resource.description}` : ''}`).join('\n')
        : ''
    });

    // 7. Single AI Call (Pillar 1.2: Lean)
    // A request for a gated resource (by keyword or a quick action) is answered by the server without an
    // AI call, so the file is never promised or shared before the visitor gives the required details.
    const aiResult = requestedResource
      ? { reply: '', buttons: [], cards: [], nudge: null, intent: 'resource_request', extracted: {}, score_signals: [] }
      : await callAI({
        messages: formattedHistory,
        systemPrompt,
        config,
        personContext: { ...person.fields, conversationTurnCount }
      });
    const aiResourceId = typeof aiResult.structured?.resource_request === 'string' ? aiResult.structured.resource_request : null;
    const gatedResource = requestedResource || (aiResourceId ? LeadCaptureService.matchResource({ config, resourceId: aiResourceId }) : null);

    const catalog = (config.products || []).filter(product => product.active !== false);
    const asksForOtherProducts = /\b(?:other|more|remaining|rest)\s+(?:of\s+the\s+)?products?\b/i.test(actualText);
    const asksForCatalog = !/\bwhat\s+does\s+.+\s+do\b|\btell\s+me\s+about\s+.+/i.test(actualText)
      && /\b(products?|services|offerings)\b/i.test(actualText)
      && /\b(what|which|list|all|offer|show|other|more|catalog|provide|sell)\b/i.test(actualText);
    let catalogResponse = false;
    if (!gatedResource && (asksForCatalog || asksForOtherProducts)) {
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

    // Personalised recommendations: use the ranked shortlist when the visitor asked for a
    // recommendation but the AI returned no cards, and attach a short "why it fits" reason.
    if (!catalogResponse && recommendationResult?.personalised && !aiResult.cards.length
      && (RecommendationService.isRecommendationRequest(actualText) || !!quizAnswers)) {
      aiResult.cards = recommendationResult.items
        .slice(0, Math.max(1, Math.min(6, Number(recommendationSettings.maxItems) || 3)))
        .map(({ score, reasons, ...card }) => card);
    }
    const reasonById = new Map((recommendationResult?.items || []).map(item => [String(item.id), item.reason]));
    aiResult.cards = aiResult.cards.map(card => {
      const { reason, ...rest } = card;
      const why = recommendationSettings.showReasons !== false && !catalogResponse ? (reason || reasonById.get(String(card.id)) || '') : '';
      return why ? { ...rest, reason: why } : rest;
    });
    // Ready-to-buy visitors who were just shown products get a direct booking option.
    if (recommendationResult?.intentLevel === 'ready' && aiResult.cards.length
      && !(aiResult.buttons || []).some(button => /book|call|demo/i.test(button))) {
      aiResult.buttons = [...(aiResult.buttons || []).slice(0, 2), 'Book a call'];
    }

    // Quick action "Contact support" (or any explicit ask for a person) always alerts the team.
    if (HandoverService.isHandoverRequest(actualText)) {
      aiResult.intent = 'human';
    }

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

    // Lead capture (separate from the answer). See LeadCaptureService and the control panel's Lead capture tab.
    const projectedPerson = applyPatchPreview(person, patchFields);
    let nextCaptureState = captureState;
    let leadCapturePayload = null;
    let resourceAttachments = [];
    let leadCaptureAction = 'none';
    const unlockResource = resource => {
      resourceAttachments = [LeadCaptureService.attachmentFor({ clientId, personId: person.id, resource })];
      const unlocked = Array.from(new Set([...(person.resourcesUnlocked || []), resource.title]));
      patchFields.resourcesUnlocked = unlocked;
      patchFields['customFields.lc_resources'] = unlocked.join(', ');
      nextCaptureState = { ...nextCaptureState, pendingResourceId: null, awaiting: null };
    };
    if (gatedResource) {
      const missing = LeadCaptureService.resourceRequirements(leadSettings, gatedResource, projectedPerson);
      aiResult.buttons = [];
      aiResult.cards = [];
      if (missing.length) {
        leadCapturePayload = LeadCaptureService.buildPayload({ type: 'gate', settings: leadSettings, questions: missing, resource: gatedResource });
        // One message: the gate text is the reply and the form sits inside it.
        aiResult.reply = `${leadCapturePayload.intro}${gatedResource.description ? `\n\n_${gatedResource.description}_` : ''}`;
        leadCapturePayload.inline = true;
        leadCapturePayload.showIntro = false;
        nextCaptureState = { ...captureState, awaiting: missing[0].field, pendingResourceId: gatedResource.id };
        leadCaptureAction = 'gate_requested_details';
      } else {
        aiResult.reply = `Here’s **${gatedResource.title}**.${gatedResource.description ? ` ${gatedResource.description}` : ''}`;
        unlockResource(gatedResource);
        leadCaptureAction = 'gate_unlocked';
      }
    } else if (captureState.pendingResourceId) {
      // Details typed into the chat (or sent on WhatsApp/Instagram) can complete a pending resource request.
      const pending = LeadCaptureService.matchResource({ config, resourceId: captureState.pendingResourceId });
      if (pending && !LeadCaptureService.resourceRequirements(leadSettings, pending, projectedPerson).length) {
        unlockResource(pending);
        leadCaptureAction = 'gate_unlocked_from_text';
      }
    }
    if (!leadCapturePayload && !resourceAttachments.length) {
      const askState = sessionId
        ? currentSession
        : { leadCaptureLastAskedAt: captureState.lastAskedAtMessage, leadCaptureAskCount: captureState.askCount };
      const { questions } = LeadCaptureService.questionsToAsk({ config, person: projectedPerson, session: askState, conversationTurnCount });
      if (questions.length) {
        leadCapturePayload = LeadCaptureService.buildPayload({ type: 'questions', settings: leadSettings, questions });
        nextCaptureState = {
          ...captureState,
          awaiting: questions[0].field,
          lastAskedAtMessage: conversationTurnCount,
          askCount: Number(captureState.askCount || 0) + 1
        };
        if (sessionId) {
          await SessionRepository.createOrUpdate(sessionId, {
            leadCapturePrompted: true,
            leadCaptureLastAskedAt: conversationTurnCount,
            leadCaptureAskCount: Number(currentSession?.leadCaptureAskCount || 0) + 1
          });
        }
        leadCaptureAction = `asked_${questions.length}_questions`;
      }
    }
    const followUp = leadCapturePayload && channel !== 'web' ? LeadCaptureService.followUpText(leadCapturePayload) : '';
    console.info(`[Lead capture] person=${person.id} session=${sessionId || 'none'} exchanges=${conversationTurnCount} mode=${leadSettings.enabled ? leadSettings.mode : 'off'} action=${leadCaptureAction}`);
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
    if (nextCaptureState !== captureState) patchFields.leadCapture = nextCaptureState;

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

    // 10b. Human handover (web): offer a WhatsApp chat pre-filled with the visitor's details and last message.
    let handover = null;
    if (channel === 'web' && !gatedResource) {
      const handoverReason = HandoverService.reasonFor({ config, text: actualText, intent: aiResult.intent });
      if (handoverReason) {
        const handoverSettings = HandoverService.settings(config);
        const missingForHandover = handoverSettings.collectDetailsFirst
          ? LeadCaptureService.missingQuestions(updatedPerson, LeadCaptureService.enabledQuestions(leadSettings)).filter(question => question.required)
          : [];
        if (missingForHandover.length) {
          leadCapturePayload = LeadCaptureService.buildPayload({ type: 'handover', settings: leadSettings, questions: missingForHandover });
          leadCapturePayload.intro = handoverSettings.detailsMessage || leadCapturePayload.intro;
          // Shown inside the same reply as the answer (not as a second message).
          leadCapturePayload.inline = true;
          leadCapturePayload.showIntro = handoverReason !== 'requested';
          if (handoverReason === 'requested') aiResult.reply = leadCapturePayload.intro;
        } else {
          leadCapturePayload = null; // don't stack a lead form on top of the handover
          handover = await HandoverService.buildHandover({
            config,
            person: updatedPerson,
            messages: recentMessages,
            currentText: actualText,
            page: metadata.page,
            reason: handoverReason
          });
        }
        // One reply, not two: an explicit request is answered by the handover itself (the AI's
        // own answer is dropped). For "unsure" / "frustrated" the AI answer stays and the
        // WhatsApp button is shown inside the same message by the widget.
        if (handoverReason === 'requested') {
          if (handover) aiResult.reply = handover.message;
          aiResult.buttons = [];
          aiResult.cards = [];
          aiResult.nudge = null;
        }
        if (handover) aiResult.buttons = [];
        console.info(`[Handover] person=${updatedPerson.id} reason=${handoverReason} action=${handover ? 'whatsapp_link' : 'collect_details_first'}`);
      }
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

    if (leadCapturePayload) {
      await MessageRepository.add({
        personId: updatedPerson.id,
        sessionId,
        channel,
        role: 'assistant',
        text: `${leadCapturePayload.intro}\n${leadCapturePayload.questions.map(question => `- ${question.question}`).join('\n')}`,
        intent: 'lead_capture_prompt'
      });
    }
    if (resourceAttachments.length) {
      await LeadCaptureService.ensureLeadColumns(clientId, [{ id: 'lc_resources', label: 'Resources unlocked' }]);
      await EventService.emit('resource_unlocked', {
        personId: updatedPerson.id,
        clientId,
        channel,
        payload: { resourceId: resourceAttachments[0].resourceId, title: resourceAttachments[0].title, person: updatedPerson }
      });
    }

    // 12. Return Shared Output Format (Section 14.3)
    return {
      reply: aiResult.reply,
      buttons: aiResult.buttons || [],
      cards: aiResult.cards || [],
      nudge: aiResult.nudge || null,
      intent: aiResult.intent || 'faq',
      extracted: aiResult.extracted || {},
      score_signals: aiResult.score_signals || [],
      leadCapture: leadCapturePayload,
      handover,
      followUp,
      attachments: resourceAttachments,
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
