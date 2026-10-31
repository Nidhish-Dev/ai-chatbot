/**
 * Lead capture
 *
 * Lead questions are never appended to the AI's answer. The chat response carries a separate
 * `leadCapture` payload that the widget shows as its own message (a form, or one question at a time).
 * Other channels (WhatsApp / Instagram via n8n) receive the question as a separate `followUp` message.
 *
 * Two triggers, chosen in the control panel (Lead capture tab):
 *   - questions: during the chat, after N visitor messages (with re-ask and per-session limits)
 *   - gated:     before a configured resource (file or link) is shared; the visitor must answer the
 *                resource's required questions first, then receives a signed, expiring download link
 */

const crypto = require('crypto');
const env = require('../config/env');
const defaultClientConfig = require('../config/defaultClientConfig');

const FIELD_TARGETS = {
  name: { patch: 'fields.name', read: person => person?.fields?.name },
  email: { patch: 'identifiers.email', read: person => person?.identifiers?.email },
  phone: { patch: 'identifiers.phone', read: person => person?.identifiers?.phone },
  company: { patch: 'fields.company', read: person => person?.fields?.company },
  website: { patch: 'fields.website', read: person => person?.fields?.website },
  industry: { patch: 'fields.industry', read: person => person?.fields?.industry },
  team_size: { patch: 'fields.teamSize', read: person => person?.fields?.teamSize }
};
const QUESTION_TYPES = new Set(['text', 'email', 'phone', 'select', 'textarea']);
const INVALID_NAMES = new Set(['learn more', 'more info', 'book a call', 'contact support', 'explore products', 'get recommendations', 'skip', 'not now', 'no', 'yes']);
const DOWNLOAD_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function settingsFor(config = {}) {
  const defaults = defaultClientConfig.leadCapture;
  const settings = { ...defaults, ...(config.leadCapture || {}) };
  // Blank messages fall back to the defaults so visitors never see an empty bubble.
  for (const key of ['introMessage', 'gateMessage', 'thankYouMessage']) {
    if (!String(settings[key] || '').trim()) settings[key] = defaults[key];
  }
  settings.questions = (Array.isArray(settings.questions) ? settings.questions : []).map(normaliseQuestion).filter(Boolean);
  settings.resources = (Array.isArray(settings.resources) ? settings.resources : []).filter(resource => resource && resource.id && resource.title);
  return settings;
}

function normaliseQuestion(question, index = 0) {
  if (!question || typeof question !== 'object') return null;
  const id = String(question.id || `q_${index + 1}`).toLowerCase().replace(/[^a-z0-9_]+/g, '_').slice(0, 40);
  const field = FIELD_TARGETS[question.field] ? question.field : 'custom';
  const type = QUESTION_TYPES.has(question.type) ? question.type : (field === 'email' ? 'email' : field === 'phone' ? 'phone' : 'text');
  return {
    id,
    question: String(question.question || '').trim().slice(0, 200),
    label: String(question.label || '').trim().slice(0, 60),
    field,
    type,
    required: question.required !== false,
    enabled: question.enabled !== false,
    placeholder: String(question.placeholder || '').slice(0, 80),
    options: (Array.isArray(question.options) ? question.options : []).map(option => String(option).trim().slice(0, 80)).filter(Boolean).slice(0, 12)
  };
}

function customColumnId(question) {
  return `lc_${question.id}`;
}

function knownValue(person, question) {
  if (question.field === 'custom') return person?.customFields?.[customColumnId(question)];
  const value = FIELD_TARGETS[question.field]?.read(person);
  if (question.field === 'name' && value && INVALID_NAMES.has(String(value).trim().toLowerCase())) return null;
  return value;
}

function publicQuestion(question) {
  const { enabled, ...rest } = question;
  return rest;
}

function validateAnswer(question, raw) {
  const value = String(raw ?? '').trim();
  if (!value) return { ok: !question.required, value: '', error: question.required ? 'This field is required.' : '' };
  if (value.length > 300) return { ok: false, error: 'Please keep this shorter.' };
  if (question.type === 'email' || question.field === 'email') {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value)) return { ok: false, error: 'Please enter a valid email address.' };
    return { ok: true, value: value.toLowerCase() };
  }
  if (question.type === 'phone' || question.field === 'phone') {
    const digits = value.replace(/\D/g, '');
    if (digits.length < 7 || digits.length > 15) return { ok: false, error: 'Please enter a valid phone number.' };
    return { ok: true, value: value.replace(/[^\d+]/g, '') };
  }
  if (question.type === 'select' && question.options.length && !question.options.includes(value)) {
    return { ok: false, error: 'Please choose one of the options.' };
  }
  if (question.field === 'name' && (INVALID_NAMES.has(value.toLowerCase()) || /@|\d{3,}/.test(value))) {
    return { ok: false, error: 'Please enter your name.' };
  }
  if (question.field === 'website') {
    return { ok: true, value: /^https?:\/\//i.test(value) ? value : `https://${value}` };
  }
  return { ok: true, value };
}

function sign(payload) {
  return crypto.createHmac('sha256', env.TOKEN_SECRET).update(payload).digest('base64url').slice(0, 22);
}

class LeadCaptureService {
  static settings(config) {
    return settingsFor(config);
  }

  static customColumnId(question) {
    return customColumnId(question);
  }

  static enabledQuestions(settings) {
    return settings.questions.filter(question => question.enabled && question.question);
  }

  static missingQuestions(person, questions) {
    return questions.filter(question => !knownValue(person, question));
  }

  /** Decide whether to ask during-chat questions this turn. Returns the questions to ask, or []. */
  static questionsToAsk({ config, person, session, conversationTurnCount }) {
    const settings = settingsFor(config);
    if (!settings.enabled || !['questions', 'both'].includes(settings.mode)) return { settings, questions: [] };
    if (conversationTurnCount < Math.max(1, Number(settings.afterExchanges) || 3)) return { settings, questions: [] };
    const askCount = Number(session?.leadCaptureAskCount || 0);
    if (askCount >= Math.max(1, Number(settings.maxAsksPerSession) || 2)) return { settings, questions: [] };
    const lastAskedAt = Number(session?.leadCaptureLastAskedAt || 0);
    const repeatAfter = Math.max(1, Number(settings.repeatAfterExchanges) || 5);
    if (lastAskedAt && conversationTurnCount - lastAskedAt < repeatAfter) return { settings, questions: [] };
    const missing = this.missingQuestions(person, this.enabledQuestions(settings));
    // Nothing required is missing: don't interrupt for optional extras.
    if (!missing.some(question => question.required)) return { settings, questions: [] };
    const perAsk = Math.max(1, Math.min(10, Number(settings.questionsPerAsk) || 3));
    return { settings, questions: missing.slice(0, perAsk) };
  }

  /** Find a gated resource the visitor is asking for (by explicit id, AI-detected id, or trigger keywords). */
  static matchResource({ config, text = '', resourceId = null }) {
    const settings = settingsFor(config);
    if (!settings.enabled || !['gated', 'both'].includes(settings.mode)) return null;
    const resources = settings.resources.filter(resource => resource.enabled !== false);
    if (resourceId) return resources.find(resource => resource.id === resourceId) || null;
    const lower = ` ${String(text).toLowerCase().replace(/[^a-z0-9\s]+/g, ' ').replace(/\s+/g, ' ')} `;
    return resources.find(resource => {
      const keywords = (Array.isArray(resource.keywords) ? resource.keywords : String(resource.keywords || '').split(','))
        .map(keyword => String(keyword).toLowerCase().replace(/[^a-z0-9\s]+/g, ' ').replace(/\s+/g, ' ').trim())
        .filter(keyword => keyword.length >= 3);
      const title = String(resource.title).toLowerCase().replace(/[^a-z0-9\s]+/g, ' ').replace(/\s+/g, ' ').trim();
      return keywords.some(keyword => lower.includes(` ${keyword} `)) || (title.length >= 4 && lower.includes(` ${title} `));
    }) || null;
  }

  /** Questions the visitor still has to answer before a resource is shared. */
  static resourceRequirements(settings, resource, person) {
    const all = this.enabledQuestions(settings);
    const ids = Array.isArray(resource.requiredQuestionIds) && resource.requiredQuestionIds.length
      ? resource.requiredQuestionIds
      : all.filter(question => question.required).map(question => question.id);
    const required = all.filter(question => ids.includes(question.id)).map(question => ({ ...question, required: true }));
    return this.missingQuestions(person, required);
  }

  static publicResource(resource) {
    return {
      id: resource.id,
      title: resource.title,
      description: resource.description || '',
      fileName: resource.source === 'link' ? '' : resource.file?.fileName || ''
    };
  }

  /** Build the widget/channel payload for asking questions. */
  static buildPayload({ type, settings, questions, resource = null }) {
    const intro = type === 'gate'
      ? String(settings.gateMessage || '').replace(/\{title\}/g, resource?.title || 'this')
      : settings.introMessage;
    return {
      type,
      id: `lc_${Date.now().toString(36)}`,
      style: settings.style === 'conversational' ? 'conversational' : 'form',
      intro,
      consentText: settings.consentText || '',
      questions: questions.map(publicQuestion),
      resource: resource ? this.publicResource(resource) : null
    };
  }

  /** A single text message for channels without the widget (asks the first question). */
  static followUpText(payload) {
    if (!payload?.questions?.length) return '';
    const first = payload.questions[0];
    const options = first.type === 'select' && first.options.length ? ` (${first.options.join(' / ')})` : '';
    return `${payload.intro}\n\n${first.question}${options}`;
  }

  /**
   * Validate answers keyed by question id. Returns { patch, errors, saved[] }.
   * `patch` uses PersonRepository dot-notation keys.
   */
  static buildAnswerPatch({ settings, person, answers = {}, onlyQuestionIds = null }) {
    const patch = {};
    const errors = {};
    const saved = [];
    const questions = this.enabledQuestions(settings).filter(question => !onlyQuestionIds || onlyQuestionIds.includes(question.id));
    for (const question of questions) {
      if (!Object.prototype.hasOwnProperty.call(answers, question.id)) continue;
      const result = validateAnswer(question, answers[question.id]);
      if (!result.ok) { errors[question.id] = result.error; continue; }
      if (!result.value) continue;
      if (question.field === 'custom') {
        patch[`customFields.${customColumnId(question)}`] = result.value;
      } else {
        // Contact identifiers are only filled when empty so a typo never overwrites a verified record.
        const target = FIELD_TARGETS[question.field];
        if (['email', 'phone'].includes(question.field) && target.read(person) && target.read(person) !== result.value) {
          patch[target.patch] = target.read(person);
        } else {
          patch[target.patch] = result.value;
        }
      }
      saved.push({ question, value: result.value });
    }
    return { patch, errors, saved };
  }

  /** Signed, expiring download URL path for a resource (prefix with the API origin). */
  static downloadPath({ clientId, personId, resourceId }) {
    const expiresAt = Date.now() + DOWNLOAD_TTL_MS;
    const payload = `${clientId}:${personId}:${resourceId}:${expiresAt}`;
    const token = `${Buffer.from(payload).toString('base64url')}.${sign(payload)}`;
    return `/api/lead-capture/resources/${encodeURIComponent(resourceId)}/download?token=${token}`;
  }

  static verifyDownloadToken(token, resourceId) {
    if (typeof token !== 'string' || !token.includes('.')) return null;
    const [encoded, signature] = token.split('.');
    let payload;
    try { payload = Buffer.from(encoded, 'base64url').toString('utf8'); } catch (_) { return null; }
    const expected = sign(payload);
    if (signature.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
    const [clientId, personId, tokenResourceId, expiresAt] = payload.split(':');
    if (tokenResourceId !== resourceId || Date.now() > Number(expiresAt)) return null;
    return { clientId, personId };
  }

  static attachmentFor({ clientId, personId, resource }) {
    return {
      resourceId: resource.id,
      title: resource.title,
      description: resource.description || '',
      fileName: resource.source === 'link' ? '' : resource.file?.fileName || '',
      kind: resource.source === 'link' ? 'link' : 'file',
      url: this.downloadPath({ clientId, personId, resourceId: resource.id })
    };
  }

  /**
   * Make sure Leads table columns exist for custom answers / unlocked resources.
   * Always re-reads the stored config so concurrent additions are not overwritten.
   */
  static async ensureLeadColumns(clientId, columnsToAdd) {
    if (!columnsToAdd?.length) return;
    const ConfigService = require('./configService');
    const { ClientRepository } = require('../db/models');
    ConfigService.refreshCache(clientId);
    const stored = await ClientRepository.get(clientId) || {};
    const existing = Array.isArray(stored.leadColumns) ? stored.leadColumns : [{ id: 'remarks', label: 'Remarks', createdAt: 'system' }];
    const missing = columnsToAdd.filter(column => !existing.some(item => item.id === column.id));
    if (!missing.length || existing.length + missing.length > 25) return;
    await ClientRepository.set(clientId, { leadColumns: [...existing, ...missing.map(column => ({ ...column, createdAt: new Date().toISOString() }))] });
    ConfigService.refreshCache(clientId);
  }

  /** Strip secrets (external links, storage paths) before sending config to the public widget. */
  static publicSettings(leadCapture) {
    if (!leadCapture || typeof leadCapture !== 'object') return leadCapture;
    return {
      ...leadCapture,
      resources: (leadCapture.resources || []).map(resource => ({
        id: resource.id,
        title: resource.title,
        description: resource.description || '',
        showAsQuickAction: !!resource.showAsQuickAction,
        enabled: resource.enabled !== false
      }))
    };
  }
}

LeadCaptureService._internals = { validateAnswer, normaliseQuestion };

module.exports = LeadCaptureService;
