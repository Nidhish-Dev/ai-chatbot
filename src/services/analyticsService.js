/**
 * Conversation analytics, chat history and lead tracking.
 *
 * Everything is derived from data the bot already stores (people, messages, events), so it works
 * on existing history with no extra tracking. A "conversation" is one web session, or one
 * person on one channel (WhatsApp / Instagram, which have no session id).
 */

const { PersonRepository, MessageRepository, EventRepository } = require('../db/models');

const DAY_MS = 24 * 60 * 60 * 1000;
const UNSURE_PATTERN = /i['’]m not sure about this/i;
const STAGES = ['Anonymous', 'Engaged', 'Identified', 'Qualified', 'Hot', 'Booked'];

function ms(value) {
  if (value && typeof value.toMillis === 'function') return value.toMillis();
  const t = new Date(value || 0).getTime();
  return Number.isFinite(t) ? t : 0;
}

function conversationKey(message) {
  return message.sessionId ? `s:${message.sessionId}` : `p:${message.personId}|${message.channel || 'web'}`;
}

function isSystemUserText(text = '') {
  return /^\[/.test(text) || /guided product discovery quiz/i.test(text);
}

function normaliseQuestion(text = '') {
  return String(text).toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
}

/** A lead has shared contact details. A WhatsApp number alone doesn't count: it is just the chat channel. */
function isLead(person) {
  return !!(person?.identifiers?.email || (person?.identifiers?.phone && person.firstChannel !== 'whatsapp'));
}

function sourceOf(person) {
  if (person?.utm?.utm_source) return String(person.utm.utm_source).toLowerCase();
  if (person?.source) return String(person.source).toLowerCase();
  if (person?.referrer) {
    try { return new URL(person.referrer).hostname.replace(/^www\./, ''); } catch (_) { /* ignore */ }
  }
  if (person?.firstChannel && person.firstChannel !== 'web') return person.firstChannel;
  return 'direct';
}

function round(value, digits = 1) {
  const f = 10 ** digits;
  return Math.round((Number(value) || 0) * f) / f;
}

function rate(part, whole) {
  return whole ? part / whole : 0;
}

/** Group messages into conversations. */
function buildConversations(messages) {
  const map = new Map();
  for (const message of messages) {
    const key = conversationKey(message);
    if (!map.has(key)) {
      map.set(key, { key, personId: message.personId, sessionId: message.sessionId || null, channel: message.channel || 'web', messages: [] });
    }
    map.get(key).messages.push(message);
  }
  for (const conversation of map.values()) {
    const list = conversation.messages;
    list.sort((a, b) => ms(a.timestamp) - ms(b.timestamp));
    conversation.startedAt = ms(list[0].timestamp);
    conversation.lastAt = ms(list[list.length - 1].timestamp);
    conversation.userMessages = list.filter(m => m.role === 'user' && m.intent !== 'lead_capture').length;
    conversation.botMessages = list.filter(m => m.role === 'assistant').length;
    conversation.unsure = list.some(m => m.role === 'assistant' && UNSURE_PATTERN.test(m.text || ''));
    conversation.leadPrompted = list.some(m => m.role === 'assistant' && m.intent === 'lead_capture_prompt');
    conversation.leadSubmitted = list.some(m => m.role === 'user' && m.intent === 'lead_capture');
    conversation.handoverRequested = list.some(m => m.role === 'assistant' && m.intent === 'human');
    conversation.booking = list.some(m => m.role === 'assistant' && m.intent === 'booking');
    const lastUser = [...list].reverse().find(m => m.role === 'user' && !isSystemUserText(m.text));
    conversation.preview = String((lastUser || list[list.length - 1]).text || '').slice(0, 140);
  }
  return [...map.values()].filter(c => c.userMessages > 0);
}

class AnalyticsService {
  /** Load people, messages and events for a client within [from, to). */
  static async load({ clientId, from, to, channel = 'all' }) {
    const people = await PersonRepository.listByClient(clientId, 10000);
    const peopleById = new Map(people.map(person => [person.id, person]));
    const fromIso = from ? new Date(from).toISOString() : null;
    const [rawMessages, rawEvents] = await Promise.all([
      MessageRepository.listSince(fromIso),
      EventRepository.listSince(fromIso)
    ]);
    const inRange = item => (!from || ms(item.timestamp) >= from) && (!to || ms(item.timestamp) < to);
    const messages = rawMessages.filter(m => peopleById.has(m.personId)
      && !String(m.sessionId || '').startsWith('demo_')
      && (channel === 'all' || (m.channel || 'web') === channel)
      && inRange(m));
    const events = rawEvents.filter(e => (e.clientId || 'grapelabs') === clientId
      && (channel === 'all' || (e.channel || 'web') === channel)
      && inRange(e));
    return { people, peopleById, messages, events };
  }

  /** Headline metrics for one period. */
  static summarise({ conversations, events, peopleById }) {
    const visitors = new Set(conversations.map(c => c.personId));
    const eventPeople = name => new Set(events.filter(e => e.name === name && e.personId).map(e => e.personId));
    const leadIds = eventPeople('lead_contact_captured');
    // Visitors in this period who have shared contact details count as leads, even if they shared
    // them before lead events were tracked. (A WhatsApp number alone doesn't count: it's the channel.)
    for (const id of visitors) if (isLead(peopleById.get(id))) leadIds.add(id);
    const handoverIds = new Set([...eventPeople('human_requested'), ...eventPeople('handover_whatsapp_clicked')]);
    const userMessages = conversations.reduce((sum, c) => sum + c.userMessages, 0);
    const botMessages = conversations.reduce((sum, c) => sum + c.botMessages, 0);
    const engaged = conversations.filter(c => c.userMessages >= 3).length;
    const durations = conversations.filter(c => c.lastAt > c.startedAt).map(c => (c.lastAt - c.startedAt) / 60000);
    const answered = conversations.reduce((sum, c) => sum + c.messages.filter(m => m.role === 'assistant' && m.intent !== 'lead_capture_prompt').length, 0);
    const unsureReplies = conversations.reduce((sum, c) => sum + c.messages.filter(m => m.role === 'assistant' && UNSURE_PATTERN.test(m.text || '')).length, 0);
    const prompted = conversations.filter(c => c.leadPrompted).length;
    const submitted = conversations.filter(c => c.leadPrompted && c.leadSubmitted).length;
    return {
      leadIds,
      conversations: conversations.length,
      visitors: visitors.size,
      userMessages,
      botMessages,
      avgMessagesPerConversation: round(rate(userMessages, conversations.length)),
      avgDurationMinutes: round(durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : 0),
      engagementRate: rate(engaged, conversations.length),
      engagedConversations: engaged,
      leads: leadIds.size,
      leadConversionRate: rate(leadIds.size, visitors.size),
      hotLeads: eventPeople('lead_hot').size,
      bookings: eventPeople('booked').size,
      bookingRate: rate(eventPeople('booked').size, visitors.size),
      handovers: handoverIds.size,
      handoverClicks: events.filter(e => e.name === 'handover_whatsapp_clicked').length,
      handoverRate: rate(handoverIds.size, conversations.length),
      answerRate: answered ? 1 - unsureReplies / answered : 1,
      unsureReplies,
      leadFormsShown: prompted,
      leadFormsCompleted: submitted,
      leadFormCompletionRate: rate(submitted, prompted),
      leadFormsSkipped: events.filter(e => e.name === 'lead_capture_skipped').length,
      resourcesUnlocked: events.filter(e => e.name === 'resource_unlocked').length,
      productClicks: events.filter(e => e.name === 'product_cta_clicked').length
    };
  }

  /**
   * Full dashboard payload.
   * @param {object} options { clientId, days (or from/to), channel, tzOffset (minutes, from Date#getTimezoneOffset) }
   */
  static async dashboard({ clientId = 'grapelabs', days = 30, channel = 'all', tzOffset = 0 }) {
    const now = Date.now();
    const span = Math.max(1, Math.min(365, Number(days) || 30)) * DAY_MS;
    const from = now - span;
    const prevFrom = from - span;
    const offsetMs = (Number(tzOffset) || 0) * 60000; // local = utc - offset
    const localDay = t => new Date(t - offsetMs).toISOString().slice(0, 10);

    const data = await this.load({ clientId, from: prevFrom, to: now, channel });
    const current = data.messages.filter(m => ms(m.timestamp) >= from);
    const previous = data.messages.filter(m => ms(m.timestamp) < from);
    const currentEvents = data.events.filter(e => ms(e.timestamp) >= from);
    const previousEvents = data.events.filter(e => ms(e.timestamp) < from);
    const conversations = buildConversations(current);
    const prevConversations = buildConversations(previous);

    const summary = this.summarise({ conversations, events: currentEvents, peopleById: data.peopleById });
    const previousSummary = this.summarise({ conversations: prevConversations, events: previousEvents, peopleById: data.peopleById });

    // Daily series (local days)
    const dayKeys = [];
    for (let t = from; t <= now; t += DAY_MS) { const key = localDay(t); if (!dayKeys.includes(key)) dayKeys.push(key); }
    const series = dayKeys.map(date => ({ date, conversations: 0, leads: 0, messages: 0 }));
    const byDate = new Map(series.map(row => [row.date, row]));
    conversations.forEach(c => { const row = byDate.get(localDay(c.startedAt)); if (row) row.conversations++; });
    current.filter(m => m.role === 'user').forEach(m => { const row = byDate.get(localDay(ms(m.timestamp))); if (row) row.messages++; });
    const leadDays = new Map();
    currentEvents.filter(e => e.name === 'lead_contact_captured' && e.personId).forEach(e => { if (!leadDays.has(e.personId)) leadDays.set(e.personId, localDay(ms(e.timestamp))); });
    leadDays.forEach(date => { const row = byDate.get(date); if (row) row.leads++; });

    // Funnel (people active in the period)
    const activeIds = [...new Set(conversations.map(c => c.personId))];
    const active = activeIds.map(id => data.peopleById.get(id)).filter(Boolean);
    const engagedIds = new Set(conversations.filter(c => c.userMessages >= 3).map(c => c.personId));
    const stageIndex = person => STAGES.indexOf(person.stage || 'Anonymous');
    // Each stage is a subset of the one before it.
    const leadSet = summary.leadIds;
    const engagedPeople = active.filter(p => engagedIds.has(p.id) || leadSet.has(p.id));
    const leadPeople = engagedPeople.filter(p => leadSet.has(p.id));
    const qualifiedPeople = leadPeople.filter(p => stageIndex(p) >= 3);
    const bookedPeople = leadPeople.filter(p => stageIndex(p) >= 5 || p.bookedSlot || currentEvents.some(e => e.name === 'booked' && e.personId === p.id));
    const funnel = [
      { stage: 'Visitors who chatted', count: active.length },
      { stage: 'Engaged (3+ messages)', count: engagedPeople.length },
      { stage: 'Leads (shared contact)', count: leadPeople.length },
      { stage: 'Qualified or hot', count: qualifiedPeople.length },
      { stage: 'Booked a call', count: bookedPeople.length }
    ];

    // Breakdowns
    const count = (items, keyFn) => {
      const map = new Map();
      items.forEach(item => { const key = keyFn(item); if (key) map.set(key, (map.get(key) || 0) + 1); });
      return [...map.entries()].map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value);
    };
    const channels = count(conversations, c => c.channel);
    const intents = count(current.filter(m => m.role === 'assistant' && m.intent && m.intent !== 'lead_capture_prompt'), m => m.intent);
    const sources = count(active, sourceOf).slice(0, 8);
    const stages = STAGES.map(stage => ({ label: stage, value: active.filter(p => (p.stage || 'Anonymous') === stage).length }));

    // Activity heatmap: [day 0=Mon..6][hour 0..23] of visitor messages, local time
    const heatmap = Array.from({ length: 7 }, () => Array(24).fill(0));
    current.filter(m => m.role === 'user').forEach(m => {
      const local = new Date(ms(m.timestamp) - offsetMs);
      heatmap[(local.getUTCDay() + 6) % 7][local.getUTCHours()]++;
    });

    // Top questions & questions the bot couldn't answer
    const questions = new Map();
    const unanswered = [];
    for (const conversation of conversations) {
      conversation.messages.forEach((message, index) => {
        if (message.role !== 'user' || isSystemUserText(message.text) || message.intent === 'lead_capture') return;
        const key = normaliseQuestion(message.text);
        if (key.length >= 3) {
          const entry = questions.get(key) || { question: message.text.slice(0, 160), count: 0 };
          entry.count++;
          questions.set(key, entry);
        }
        const reply = conversation.messages.slice(index + 1).find(m => m.role === 'assistant');
        if (reply && UNSURE_PATTERN.test(reply.text || '')) {
          unanswered.push({ question: message.text.slice(0, 200), at: ms(message.timestamp), conversationKey: conversation.key, channel: conversation.channel });
        }
      });
    }
    const topQuestions = [...questions.values()].sort((a, b) => b.count - a.count).slice(0, 10);

    // Products shown in chat and clicked
    const products = new Map();
    current.filter(m => m.role === 'assistant' && Array.isArray(m.cards)).forEach(m => m.cards.forEach(card => {
      if (!card?.name) return;
      const entry = products.get(card.id || card.name) || { name: card.name, shown: 0, clicks: 0 };
      entry.shown++;
      products.set(card.id || card.name, entry);
    }));
    currentEvents.filter(e => e.name === 'product_cta_clicked' && e.payload?.productId).forEach(e => {
      const entry = products.get(e.payload.productId);
      if (entry) entry.clicks++;
    });

    // Lead tracking: people with contact details active in the period
    const lastActivity = new Map();
    conversations.forEach(c => lastActivity.set(c.personId, Math.max(lastActivity.get(c.personId) || 0, c.lastAt)));
    const leads = active
      .filter(p => leadSet.has(p.id))
      .map(p => ({
        id: p.id,
        name: p.fields?.name || null,
        email: p.identifiers?.email || null,
        phone: p.identifiers?.phone || null,
        company: p.fields?.company || null,
        stage: p.stage || 'Anonymous',
        score: p.score || 0,
        source: sourceOf(p),
        channel: p.firstChannel || 'web',
        firstSeen: ms(p.createdAt),
        lastActive: lastActivity.get(p.id) || ms(p.updatedAt),
        handedOver: !!p.handover || currentEvents.some(e => e.personId === p.id && ['human_requested', 'handover_whatsapp_clicked'].includes(e.name)),
        conversationKey: conversations.filter(c => c.personId === p.id).sort((a, b) => b.lastAt - a.lastAt)[0]?.key || null
      }))
      .sort((a, b) => b.lastActive - a.lastActive)
      .slice(0, 50);

    const { leadIds: _a, ...summaryOut } = summary;
    const { leadIds: _b, ...previousOut } = previousSummary;
    return {
      range: { from, to: now, days: Math.round(span / DAY_MS), channel },
      summary: summaryOut,
      previous: previousOut,
      series,
      funnel,
      channels,
      intents,
      sources,
      stages,
      heatmap,
      topQuestions,
      unanswered: [...unanswered.reduce((map, item) => {
        // Group repeats of the same question: count + most recent occurrence
        const key = normaliseQuestion(item.question);
        const entry = map.get(key);
        if (!entry) map.set(key, { ...item, count: 1 });
        else { entry.count++; if (item.at > entry.at) Object.assign(entry, { question: item.question, at: item.at, conversationKey: item.conversationKey, channel: item.channel }); }
        return map;
      }, new Map()).values()].sort((a, b) => b.count - a.count || b.at - a.at).slice(0, 15),
      products: [...products.values()].sort((a, b) => b.shown - a.shown).slice(0, 10),
      leads
    };
  }

  /** Searchable chat history. */
  static async conversations({ clientId = 'grapelabs', days = 90, channel = 'all', q = '', filter = 'all', limit = 50, offset = 0 }) {
    const from = days === 'all' ? null : Date.now() - Math.max(1, Math.min(3650, Number(days) || 90)) * DAY_MS;
    const data = await this.load({ clientId, from, to: null, channel });
    let list = buildConversations(data.messages);
    const leadPeople = new Set(data.events.filter(e => e.name === 'lead_contact_captured').map(e => e.personId));
    const handoverPeople = new Set(data.events.filter(e => ['human_requested', 'handover_whatsapp_clicked'].includes(e.name)).map(e => e.personId));
    list = list.map(c => {
      const person = data.peopleById.get(c.personId) || {};
      return {
        key: c.key,
        personId: c.personId,
        sessionId: c.sessionId,
        channel: c.channel,
        name: person.fields?.name || null,
        email: person.identifiers?.email || null,
        phone: person.identifiers?.phone || null,
        stage: person.stage || 'Anonymous',
        score: person.score || 0,
        startedAt: c.startedAt,
        lastAt: c.lastAt,
        messageCount: c.messages.length,
        userMessages: c.userMessages,
        preview: c.preview,
        flags: {
          lead: isLead(person) || leadPeople.has(c.personId),
          handover: c.handoverRequested || handoverPeople.has(c.personId),
          unsure: c.unsure,
          booking: c.booking || !!person.bookedSlot
        },
        _search: `${person.fields?.name || ''} ${person.identifiers?.email || ''} ${person.identifiers?.phone || ''} ${person.fields?.company || ''} ${c.messages.map(m => m.text || '').join(' ')}`.toLowerCase()
      };
    });
    const query = String(q || '').trim().toLowerCase();
    if (query) list = list.filter(c => query.split(/\s+/).every(term => c._search.includes(term)));
    if (filter && filter !== 'all') list = list.filter(c => c.flags[filter]);
    list.sort((a, b) => b.lastAt - a.lastAt);
    const total = list.length;
    const start = Math.max(0, Number(offset) || 0);
    const page = list.slice(start, start + Math.max(1, Math.min(200, Number(limit) || 50))).map(({ _search, ...c }) => {
      if (!query) return c;
      // Show where the search matched
      const conversation = data.messages.filter(m => conversationKey(m) === c.key && (m.text || '').toLowerCase().includes(query.split(/\s+/)[0]));
      return conversation.length ? { ...c, match: conversation[0].text.slice(0, 160) } : c;
    });
    return { total, conversations: page };
  }

  /** One conversation's full transcript with the visitor's profile and events. */
  static async conversation({ clientId = 'grapelabs', key }) {
    const match = /^s:(.+)$/.exec(key) || /^p:([^|]+)\|(.+)$/.exec(key);
    if (!match) return null;
    let personId;
    let messages;
    if (key.startsWith('s:')) {
      const sessionId = match[1];
      const person = await PersonRepository.findByIdentifier({ sessionId });
      const all = await MessageRepository.listSince(null);
      messages = all.filter(m => m.sessionId === sessionId);
      personId = person?.id || messages[0]?.personId;
    } else {
      personId = match[1];
      const channel = match[2];
      messages = (await MessageRepository.getByPerson(personId, 2000)).filter(m => !m.sessionId && (m.channel || 'web') === channel);
    }
    const person = personId ? await PersonRepository.get(personId) : null;
    if (!person || (person.clientId && person.clientId !== clientId)) return null;
    const events = (await EventRepository.getByPerson(person.id)).map(e => ({ name: e.name, at: ms(e.timestamp), channel: e.channel, title: e.payload?.title || e.payload?.reason || '' }));
    return {
      key,
      person: {
        id: person.id,
        name: person.fields?.name || null,
        email: person.identifiers?.email || null,
        phone: person.identifiers?.phone || null,
        company: person.fields?.company || null,
        website: person.fields?.website || null,
        industry: person.fields?.industry || null,
        pains: person.fields?.pains || null,
        stage: person.stage || 'Anonymous',
        score: person.score || 0,
        source: sourceOf(person),
        channels: person.channelsUsed || [],
        productsRecommended: person.fields?.productsRecommended || [],
        resourcesUnlocked: person.resourcesUnlocked || [],
        firstSeen: ms(person.createdAt)
      },
      messages: messages
        .sort((a, b) => ms(a.timestamp) - ms(b.timestamp))
        .map(m => ({ role: m.role, text: m.text || '', intent: m.intent || null, at: ms(m.timestamp), cards: (m.cards || []).map(card => card.name).filter(Boolean), buttons: m.buttons || [] })),
      events
    };
  }
}

AnalyticsService._internals = { buildConversations, conversationKey };

module.exports = AnalyticsService;
