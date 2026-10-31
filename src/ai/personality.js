/**
 * Assistant personality
 *
 * Turns the structured settings from the control panel's Personality tab into the
 * "BRAND VOICE & PERSONA" section of the system prompt. Style settings never override the
 * strict operational rules (sources of truth, pricing, escalation), which are placed after this block.
 */

const DEFAULT_PERSONALITY = {
  enabled: true,
  preset: 'custom',
  assistantName: '',
  role: '',
  description: '',
  traits: [],
  formality: 3,     // 1 casual … 5 formal
  energy: 3,        // 1 calm … 5 enthusiastic
  detail: 2,        // 1 very brief … 5 detailed
  humour: 1,        // 1 none … 5 playful
  empathy: 3,       // 1 matter-of-fact … 5 very warm
  emoji: 'none',    // none | occasional | frequent
  perspective: 'we', // we | i
  useVisitorName: true,
  language: 'English',
  mirrorLanguage: true,
  hinglish: true,
  formatting: 'bullets', // bullets | prose
  maxSentences: 5,
  offTopic: 'redirect',  // redirect | brief_then_redirect
  doRules: [],
  dontRules: [],
  preferredWords: '',
  avoidWords: '',
  examples: [],
  showNameInHeader: true
};

const SCALE_TEXT = {
  formality: ['very casual and conversational, like texting a friend', 'casual and relaxed', 'balanced: friendly but professional', 'professional and polished', 'formal and courteous'],
  energy: ['calm and understated', 'steady and composed', 'positive and engaged', 'upbeat and energetic', 'highly enthusiastic and excited'],
  detail: ['extremely brief: one or two short sentences', 'concise: get to the point quickly', 'moderately detailed', 'thorough with useful context', 'detailed and comprehensive'],
  humour: ['no jokes or wordplay', 'rare, light touches of humour only when natural', 'occasionally light-hearted', 'playful and witty', 'very playful, with frequent humour'],
  empathy: ['matter-of-fact and neutral', 'polite and considerate', 'warm and understanding', 'very warm; acknowledge feelings and frustrations', 'deeply empathetic and reassuring']
};

function clampScale(value, fallback) {
  const number = Math.round(Number(value));
  return Number.isFinite(number) ? Math.min(5, Math.max(1, number)) : fallback;
}

function cleanList(value, max = 12, length = 200) {
  const list = Array.isArray(value) ? value : String(value || '').split(/\r?\n/);
  return list.map(item => String(item || '').trim().slice(0, length)).filter(Boolean).slice(0, max);
}

function normalisePersonality(raw = {}) {
  const p = { ...DEFAULT_PERSONALITY, ...(raw && typeof raw === 'object' ? raw : {}) };
  return {
    ...p,
    assistantName: String(p.assistantName || '').trim().slice(0, 40),
    role: String(p.role || '').trim().slice(0, 120),
    description: String(p.description || '').trim().slice(0, 1200),
    traits: cleanList(p.traits, 10, 40),
    formality: clampScale(p.formality, 3),
    energy: clampScale(p.energy, 3),
    detail: clampScale(p.detail, 2),
    humour: clampScale(p.humour, 1),
    empathy: clampScale(p.empathy, 3),
    emoji: ['none', 'occasional', 'frequent'].includes(p.emoji) ? p.emoji : 'none',
    perspective: p.perspective === 'i' ? 'i' : 'we',
    language: String(p.language || 'English').trim().slice(0, 40) || 'English',
    formatting: p.formatting === 'prose' ? 'prose' : 'bullets',
    maxSentences: Math.min(15, Math.max(1, Math.round(Number(p.maxSentences) || 5))),
    offTopic: p.offTopic === 'brief_then_redirect' ? 'brief_then_redirect' : 'redirect',
    doRules: cleanList(p.doRules),
    dontRules: cleanList(p.dontRules),
    preferredWords: String(p.preferredWords || '').trim().slice(0, 400),
    avoidWords: String(p.avoidWords || '').trim().slice(0, 400),
    examples: (Array.isArray(p.examples) ? p.examples : [])
      .map(example => ({ visitor: String(example?.visitor || '').trim().slice(0, 300), reply: String(example?.reply || '').trim().slice(0, 800) }))
      .filter(example => example.visitor && example.reply)
      .slice(0, 5)
  };
}

/**
 * Build the persona section of the system prompt.
 * @returns {string} empty when personality is disabled (the legacy brand voice text is used instead)
 */
function buildPersonalityBlock(config = {}) {
  if (!config.personality || config.personality.enabled === false) return '';
  const p = normalisePersonality(config.personality);
  const company = config.cagCompanyName || config.branding?.brandName || config.name || 'the business';
  const lines = [];

  const identity = [
    p.assistantName ? `Your name is ${p.assistantName}.` : '',
    `You are ${p.role ? `${company}${/s$/i.test(company) ? "'" : "'s"} ${p.role}` : `the assistant for ${company}`}.`,
    p.perspective === 'we'
      ? `Speak on behalf of the company using "we" / "our" (e.g. "we can set that up").`
      : `Speak in the first person as yourself ("I can help with that"), and refer to the company as "${company}" or "the team".`
  ].filter(Boolean).join(' ');
  lines.push(identity);
  if (p.description) lines.push(`Personality in the brand's own words: ${p.description}`);
  if (p.traits.length) lines.push(`Core traits: ${p.traits.join(', ')}.`);

  lines.push('Tone and style:');
  lines.push(`- Formality: ${SCALE_TEXT.formality[p.formality - 1]}.`);
  lines.push(`- Energy: ${SCALE_TEXT.energy[p.energy - 1]}.`);
  lines.push(`- Length: ${SCALE_TEXT.detail[p.detail - 1]}. Keep typical replies to about ${p.maxSentences} sentence${p.maxSentences === 1 ? '' : 's'} or fewer, unless the visitor asks for detail or a product explanation needs it.`);
  lines.push(`- Humour: ${SCALE_TEXT.humour[p.humour - 1]}.`);
  lines.push(`- Empathy: ${SCALE_TEXT.empathy[p.empathy - 1]}.`);
  lines.push(`- Emoji: ${{ none: 'never use emoji', occasional: 'use at most one relevant emoji in some replies', frequent: 'use a few relevant emoji to keep things lively' }[p.emoji]}.`);
  lines.push(`- Formatting: ${p.formatting === 'bullets' ? 'use short bullet points when listing options, steps or features; otherwise plain sentences' : 'write in natural flowing sentences; avoid bullet points unless the visitor asks for a list'}.`);
  if (p.useVisitorName) lines.push('- When the visitor\'s name is known, use it naturally now and then (not in every message).');

  const language = [`Default language: ${p.language}.`];
  if (p.mirrorLanguage) language.push('If the visitor writes in another language, reply in their language.');
  if (p.hinglish) language.push('If the visitor writes in Hinglish (Hindi in Roman script), reply in natural, fluent Hinglish.');
  lines.push(`Language: ${language.join(' ')}`);

  lines.push(p.offTopic === 'brief_then_redirect'
    ? 'Off-topic questions: answer very briefly and kindly if harmless, then steer back to how you can help with the business.'
    : 'Off-topic questions: politely decline and steer back to how you can help with the business.');

  if (p.doRules.length) lines.push(`Always:\n${p.doRules.map(rule => `- ${rule}`).join('\n')}`);
  if (p.dontRules.length) lines.push(`Never:\n${p.dontRules.map(rule => `- ${rule}`).join('\n')}`);
  if (p.preferredWords) lines.push(`Brand vocabulary to prefer: ${p.preferredWords}`);
  if (p.avoidWords) lines.push(`Words and phrases to avoid: ${p.avoidWords}`);
  if (p.examples.length) {
    lines.push(`Example replies showing the voice (match the style, not the exact words or facts):\n${p.examples.map(example => `Visitor: ${example.visitor}\nAssistant: ${example.reply}`).join('\n\n')}`);
  }
  lines.push('These style settings never override the STRICT OPERATIONAL RULES below (sources of truth, pricing, escalation, JSON output).');
  return lines.join('\n');
}

module.exports = { DEFAULT_PERSONALITY, normalisePersonality, buildPersonalityBlock };
