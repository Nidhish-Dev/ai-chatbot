/**
 * Human handover via WhatsApp (no WhatsApp API)
 *
 * When a conversation needs a person, the widget shows a "Continue on WhatsApp" button that opens
 * a normal wa.me chat with a pre-filled message: the visitor's details, their last question and a
 * reference code. The visitor just taps Send, so the team gets full context and the conversation
 * continues where it left off. The ref code also links the WhatsApp chat to the same lead if the
 * WhatsApp number is later connected through n8n.
 */

const defaultClientConfig = require('../config/defaultClientConfig');

const REQUEST_PATTERN = /\b(?:talk|speak|chat|connect|transfer)\b[^.?!]{0,30}\b(?:human|person|someone|agent|representative|team|support|executive|real)\b|\bcontact support\b|\bhuman agent\b|\breal person\b|\bcustomer (?:care|service|support)\b|\bcall me\b/i;
const FRUSTRATION_PATTERN = /\b(?:useless|not helpful|unhelpful|doesn'?t help|not working|this is wrong|wrong answer|you(?:'re| are) not understanding|frustrat\w*|annoy\w*|ridiculous|waste of time|stupid bot|not what i asked)\b/i;

function settingsFor(config = {}) {
  const defaults = defaultClientConfig.handover;
  const stored = config.handover || {};
  const settings = {
    ...defaults,
    ...stored,
    triggers: { ...defaults.triggers, ...(stored.triggers || {}) },
    include: { ...defaults.include, ...(stored.include || {}) }
  };
  for (const key of ['message', 'buttonLabel', 'greeting']) {
    if (!String(settings[key] || '').trim()) settings[key] = defaults[key];
  }
  return settings;
}

function whatsappNumber(config, settings = settingsFor(config)) {
  const fallback = String(config.links?.whatsappRefNumber || config.channels?.whatsapp?.handoffContact || '').replace(/\D/g, '');
  let digits = String(settings.whatsappNumber || '').replace(/\D/g, '') || fallback;
  // A local 10-digit number (no country code) won't open in WhatsApp: borrow the country code
  // from the main WhatsApp number in Settings when it has one.
  if (digits.length === 10 && fallback.length > 10) digits = `${fallback.slice(0, fallback.length - 10)}${digits}`;
  return digits.length >= 11 && digits.length <= 15 ? digits : '';
}

function isHandoverRequest(text = '') {
  return REQUEST_PATTERN.test(text);
}

function isFrustrated(text = '') {
  return FRUSTRATION_PATTERN.test(text);
}

/** The visitor's most recent real question (skips the "talk to a human" request itself and form summaries). */
function lastVisitorMessage(messages = [], currentText = '') {
  const userMessages = messages
    .filter(message => message && message.role === 'user' && typeof message.text === 'string')
    .map(message => message.text.trim())
    .filter(text => text && !text.startsWith('[') && !/guided product discovery quiz/i.test(text));
  if (currentText && !userMessages.includes(currentText.trim())) userMessages.push(currentText.trim());
  const substantive = [...userMessages].reverse().find(text => !isHandoverRequest(text) && !isFrustrated(text) && text.length > 3);
  return (substantive || userMessages[userMessages.length - 1] || '').slice(0, 500);
}

class HandoverService {
  static settings(config) {
    return settingsFor(config);
  }

  static isHandoverRequest(text) {
    return isHandoverRequest(text);
  }

  static isFrustrated(text) {
    return isFrustrated(text);
  }

  static lastVisitorMessage(messages, currentText) {
    return lastVisitorMessage(messages, currentText);
  }

  static isAvailable(config) {
    const settings = settingsFor(config);
    return settings.enabled !== false && !!whatsappNumber(config, settings);
  }

  /**
   * Decide whether this turn should offer a handover.
   * @returns {string|null} reason: 'requested' | 'ai_unsure' | 'frustrated'
   */
  static reasonFor({ config, text, intent }) {
    const settings = settingsFor(config);
    if (settings.enabled === false || !whatsappNumber(config, settings)) return null;
    if (isHandoverRequest(text)) return 'requested';
    if (intent === 'human' && settings.triggers.onUnsure !== false) return 'ai_unsure';
    if (isFrustrated(text) && settings.triggers.onFrustration !== false) return 'frustrated';
    return null;
  }

  /** Build the pre-filled WhatsApp message and wa.me link. */
  static buildWhatsApp({ config, person = null, lastMessage = '', page = '', refCode = '' }) {
    const settings = settingsFor(config);
    const number = whatsappNumber(config, settings);
    if (!number) return null;
    const brand = config.branding?.brandName || config.cagCompanyName || config.name || 'team';
    const include = settings.include;
    const lines = [String(settings.greeting).replace(/\{brand\}/g, brand)];
    const details = [];
    if (include.name && person?.fields?.name) details.push(`Name: ${person.fields.name}`);
    if (include.email && person?.identifiers?.email) details.push(`Email: ${person.identifiers.email}`);
    if (include.phone && person?.identifiers?.phone) details.push(`Phone: ${person.identifiers.phone}`);
    if (include.company && person?.fields?.company) details.push(`Company: ${person.fields.company}`);
    if (include.company && !person?.fields?.company && person?.fields?.website) details.push(`Website: ${person.fields.website}`);
    if (details.length) lines.push('', ...details);
    if (include.lastMessage && lastMessage) lines.push('', `My question: ${lastMessage}`);
    if (include.page && /^https?:\/\//i.test(page || '')) lines.push(`Page: ${String(page).split('?')[0].slice(0, 200)}`);
    if (include.refCode && refCode) lines.push('', `Ref: ${refCode}`);
    const text = lines.join('\n').slice(0, 1500);
    return { number, text, url: `https://wa.me/${number}?text=${encodeURIComponent(text)}` };
  }

  /** Payload for the widget's handover card. */
  static async buildHandover({ config, person, messages = [], currentText = '', page = '', reason = 'requested' }) {
    const settings = settingsFor(config);
    let refCode = '';
    if (settings.include.refCode && person?.id) {
      try {
        refCode = await require('./identityService').createChannelHandshake(person.id, 'whatsapp');
      } catch (_) { refCode = ''; }
    }
    const lastMessage = lastVisitorMessage(messages, currentText);
    const whatsapp = this.buildWhatsApp({ config, person, lastMessage, page, refCode });
    if (!whatsapp) return null;
    return {
      reason,
      channel: 'whatsapp',
      message: settings.message,
      buttonLabel: settings.buttonLabel,
      url: whatsapp.url,
      preview: whatsapp.text,
      refCode
    };
  }
}

module.exports = HandoverService;
