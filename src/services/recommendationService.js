/**
 * Personalised Product Recommendations
 *
 * Ranks the configured product catalog for one visitor using signals the bot already
 * has, without an extra AI call:
 *   - Preferences: industry, team size and main challenge (from chat extraction or the quiz)
 *   - Browsing behaviour: pages the visitor viewed on the site (URL + page title)
 *   - Previous interactions: products the visitor opened, asked about or clicked through,
 *     topics they asked about, and products already shown to them
 *   - Purchase intent: pricing/booking/buying language and lead stage
 *
 * The ranked shortlist is (a) returned by GET/POST /api/recommendations for the widget,
 * (b) injected into the system prompt so the AI recommends from it, and (c) used as a
 * deterministic fallback when the AI returns no product cards.
 */

const { PersonRepository } = require('../db/models');

const STOPWORDS = new Set(`a about above after again all also am an and any are as at be because been before being
below between both but by can could did do does doing down during each few for from further had has have having he her
here hers him his how i if in into is it its itself just me more most my no nor not now of off on once only or other our
ours out over own same she should so some such than that the their them then there these they this those through to too
under until up very was we were what when where which while who whom why will with would you your yours yourself
hi hello hey please thanks thank want need like tell show know get got give let make help use using used
www http https com html php index page home pages products product services service solution solutions
business company team people one two three things thing way much many really something anything everything
everything other more best good great new also just kindly okay ok sure yes yeah
price prices pricing cost costs week weeks next start started handle work works long time much quick quickly`.split(/\s+/).filter(Boolean));

const HIGH_INTENT = /\b(price|prices|pricing|cost|costs|quote|quotation|budget|buy|purchase|order|subscribe|sign\s?up|get\s+started|start\s+now|book|booking|demo|call|trial|onboard|how\s+soon|timeline|implement|go\s+live|contract|invoice|payment|pay)\b/i;
const MEDIUM_INTENT = /\b(compare|comparison|vs|versus|which|recommend|recommendation|suggest|best|suitable|fit|right\s+for|options?|interested|considering|looking\s+for|alternatives?|difference|features?|works?\s+with|integrat\w*)\b/i;
const RECOMMEND_REQUEST = /\b(recommend\w*|suggest\w*|best\s+(?:fit|option|product|one)|what\s+should\s+i|which\s+(?:one|product|service|option)|right\s+(?:product|fit|solution)|for\s+my\s+business|for\s+me)\b/i;

const DEFAULT_SETTINGS = { enabled: true, showOnWelcome: true, maxItems: 3, showReasons: true };

function settingsFor(config = {}) {
  return { ...DEFAULT_SETTINGS, ...(config.recommendations || {}) };
}

function stem(word) {
  if (word.length > 5 && word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.length > 5 && word.endsWith('ing')) return word.slice(0, -3);
  if (word.length > 4 && word.endsWith('ed')) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/https?:\/\/[^/\s]+/g, ' ') // drop the domain of URLs, keep the path
    .replace(/[^a-z0-9\s/-]+/g, ' ')
    .split(/[\s/_-]+/)
    .filter(word => word.length >= 3 && !STOPWORDS.has(word) && !/^\d+$/.test(word))
    .map(stem);
}

function uniqueTokens(text) {
  return new Set(tokenize(text));
}

function productText(product) {
  const industries = Array.isArray(product.industry) ? product.industry.join(' ') : product.industry || '';
  return [product.name, product.description, product.impact, product.details, industries].filter(Boolean).join(' ');
}

function normaliseUrl(value) {
  try {
    const url = new URL(String(value || ''));
    return `${url.hostname.replace(/^www\./, '')}${url.pathname.replace(/\/+$/, '')}`.toLowerCase();
  } catch (_) {
    return '';
  }
}

function industryMatch(product, industry) {
  if (!industry) return null;
  const productIndustries = (Array.isArray(product.industry) ? product.industry : String(product.industry || '').split(','))
    .map(item => String(item).trim())
    .filter(Boolean);
  const wanted = uniqueTokens(industry);
  if (!productIndustries.length) {
    // Catalogs extracted from documents often have no industry tags: fall back to the product text.
    const text = uniqueTokens(productText(product));
    const hit = [...wanted].find(token => text.has(token));
    return hit ? { strength: 'text', label: industry } : null;
  }
  for (const item of productIndustries) {
    if (item.toLowerCase() === String(industry).toLowerCase()) return { strength: 'exact', label: item };
    const tokens = uniqueTokens(item);
    if ([...tokens].some(token => wanted.has(token))) return { strength: 'partial', label: item };
  }
  if (productIndustries.some(item => /^(all|any|general)$/i.test(item))) return { strength: 'general', label: 'All' };
  return null;
}

function detectIntent(text = '') {
  if (HIGH_INTENT.test(text)) return 'high';
  if (MEDIUM_INTENT.test(text)) return 'medium';
  return 'none';
}

function intentLevelFromScore(score = 0, stage = '') {
  if (score >= 5 || ['Hot', 'Booked'].includes(stage)) return 'ready';
  if (score >= 2 || stage === 'Qualified') return 'considering';
  return 'browsing';
}

function isRecommendationRequest(text = '') {
  return RECOMMEND_REQUEST.test(text);
}

function cleanBrowsing(browsing) {
  if (!Array.isArray(browsing)) return [];
  return browsing
    .filter(item => item && typeof item === 'object')
    .map(item => ({
      url: String(item.url || '').slice(0, 500),
      title: String(item.title || '').slice(0, 200),
      at: Number(item.at) || Date.now()
    }))
    .filter(item => /^https?:\/\//i.test(item.url))
    .slice(-25);
}

function topEntries(map, limit) {
  return Object.fromEntries(Object.entries(map || {}).sort((a, b) => b[1] - a[1]).slice(0, limit));
}

/** Pick out products named in a message, e.g. "Tell me everything about Cart Recovery". */
function findMentionedProducts(text, catalog) {
  const lower = String(text || '').toLowerCase();
  if (!lower) return [];
  return catalog.filter(product => {
    const name = String(product.name || '').toLowerCase().trim();
    return name.length >= 4 && lower.includes(name);
  });
}

class RecommendationService {
  static settings(config) {
    return settingsFor(config);
  }

  static isRecommendationRequest(text) {
    return isRecommendationRequest(text);
  }

  static activeCatalog(config = {}, { preview = false } = {}) {
    const products = preview && Array.isArray(config.draft?.products) ? config.draft.products : config.products;
    return (products || []).filter(product => product && product.id && product.name && product.active !== false);
  }

  /**
   * Build a visitor profile from the stored person plus anything the widget sent with this request.
   */
  static buildProfile({ person = null, browsing = [], override = null } = {}) {
    const fields = person?.fields || {};
    const prefs = person?.preferences || {};
    const storedBrowsing = Array.isArray(prefs.browsing) ? prefs.browsing : [];
    const pageUrls = Array.isArray(person?.pagesVisited) ? person.pagesVisited.map(url => ({ url, title: '' })) : [];
    const pages = [...pageUrls, ...storedBrowsing, ...cleanBrowsing(browsing)];

    const profile = {
      industry: fields.industry || null,
      teamSize: fields.teamSize || null,
      pains: fields.pains || null,
      goal: prefs.goal || null,
      quizAnswers: Array.isArray(prefs.quizAnswers) ? prefs.quizAnswers : [],
      keywords: prefs.keywords || {},
      productViews: prefs.productViews || {},
      productsShown: Array.isArray(fields.productsRecommended) ? fields.productsRecommended : [],
      pages,
      intentScore: Number(prefs.intentScore || 0),
      stage: person?.stage || 'Anonymous'
    };

    if (override && typeof override === 'object') {
      if (override.industry) profile.industry = String(override.industry).slice(0, 120);
      if (override.pains) profile.pains = String(override.pains).slice(0, 400);
      if (override.interests) {
        profile.keywords = {};
        tokenize(override.interests).forEach(word => { profile.keywords[word] = (profile.keywords[word] || 0) + 2; });
      }
      if (Array.isArray(override.pages)) profile.pages = cleanBrowsing(override.pages.map(url => (typeof url === 'string' ? { url } : url)));
      if (override.intent) profile.intentScore = override.intent === 'ready' ? 5 : override.intent === 'considering' ? 2 : 0;
    }

    profile.intentLevel = intentLevelFromScore(profile.intentScore, profile.stage);
    return profile;
  }

  static hasSignal(profile) {
    return !!(profile.industry || profile.pains || profile.goal || profile.quizAnswers.length
      || Object.keys(profile.keywords).length || Object.keys(profile.productViews).length || profile.pages.length);
  }

  /**
   * Score one product against the profile. Returns { score, reasons[] } with the strongest reason first.
   */
  static scoreProduct(product, profile, pageTokens) {
    const tokens = uniqueTokens(productText(product));
    const nameTokens = uniqueTokens(product.name);
    const reasons = [];
    let score = 0;

    // 1. Stated preferences: industry
    const industry = industryMatch(product, profile.industry);
    if (industry) {
      const points = { exact: 30, partial: 22, text: 12, general: 6 }[industry.strength] || 0;
      score += points;
      if (industry.strength !== 'general') reasons.push({ points, text: `Built for ${industry.label}` });
    }

    // 2. Stated needs: main challenge, goal and quiz answers
    const needText = [profile.pains, profile.goal, ...profile.quizAnswers.map(item => item.answer)].filter(Boolean).join(' ');
    if (needText) {
      const matched = [...uniqueTokens(needText)].filter(word => tokens.has(word));
      if (matched.length) {
        // A need that appears in the product's name is a stronger match than one in its description.
        const weight = matched.reduce((sum, word) => sum + (nameTokens.has(word) ? 12 : 7), 0);
        const points = Math.min(30, weight);
        score += points;
        reasons.push({ points, text: `Solves ${profile.pains ? 'your challenge' : 'what you told us you need'}` });
      }
    }

    // 3. Previous interactions: products opened or clicked
    const views = Number(profile.productViews[product.id] || 0);
    if (views) {
      const points = Math.min(28, views * 14);
      score += points;
      reasons.push({ points, text: 'You looked at this earlier' });
    }

    // 4. Previous interactions: topics the visitor asked about
    const keywordHits = Object.entries(profile.keywords).filter(([word]) => tokens.has(word));
    if (keywordHits.length) {
      const weight = keywordHits.reduce((sum, [word, count]) => sum + Math.min(3, count) * (nameTokens.has(word) ? 1.5 : 1), 0);
      const points = Math.min(24, Math.round(weight * 4));
      score += points;
      const topic = keywordHits.sort((a, b) => b[1] - a[1])[0][0];
      reasons.push({ points, text: `Related to what you asked about (${topic})` });
    }

    // 5. Browsing behaviour: pages viewed on the site
    const productUrl = normaliseUrl(product.ctaUrl);
    if (productUrl && profile.pages.some(page => normaliseUrl(page.url) === productUrl)) {
      score += 25;
      reasons.push({ points: 25, text: 'You visited this product’s page' });
    } else if (pageTokens.size) {
      const hits = [...nameTokens].filter(word => pageTokens.has(word)).length
        + [...tokens].filter(word => !nameTokens.has(word) && pageTokens.has(word)).length * 0.4;
      if (hits >= 1) {
        const points = Math.min(20, Math.round(hits * 6));
        score += points;
        reasons.push({ points, text: 'Matches pages you’ve been browsing' });
      }
    }

    // 6. Novelty: gently favour products the visitor has not been shown yet (affects order only).
    const rankScore = score > 0 && profile.productsShown.includes(product.name) && !views ? score - 5 : score;

    reasons.sort((a, b) => b.points - a.points);
    return { score, rankScore, reasons: reasons.map(reason => reason.text) };
  }

  /**
   * Rank the catalog for a profile.
   * @returns {{ personalised: boolean, intentLevel: string, basedOn: string[], items: object[] }}
   */
  static rank({ config, profile, limit, preview = false }) {
    const settings = settingsFor(config);
    const max = Math.max(1, Math.min(6, Number(limit || settings.maxItems || 3)));
    const catalog = this.activeCatalog(config, { preview });
    const pageTokens = new Set(profile.pages.flatMap(page => [...uniqueTokens(`${page.url} ${page.title}`)]));

    const basedOn = [];
    if (profile.industry) basedOn.push('industry');
    if (profile.pains || profile.goal || profile.quizAnswers.length) basedOn.push('needs');
    if (Object.keys(profile.productViews).length) basedOn.push('products viewed');
    if (Object.keys(profile.keywords).length) basedOn.push('questions asked');
    if (profile.pages.length) basedOn.push('pages browsed');

    if (!catalog.length || !this.hasSignal(profile)) {
      return { personalised: false, intentLevel: profile.intentLevel, basedOn, items: [] };
    }

    const scored = catalog
      .map((product, index) => ({ product, index, ...this.scoreProduct(product, profile, pageTokens) }))
      .filter(entry => entry.score >= 8)
      .sort((a, b) => b.rankScore - a.rankScore || b.score - a.score || a.index - b.index)
      .slice(0, max);

    return {
      personalised: scored.length > 0,
      intentLevel: profile.intentLevel,
      basedOn,
      items: scored.map(({ product, score, reasons }) => ({
        id: product.id,
        name: product.name,
        oneLiner: product.impact || product.description,
        description: product.description,
        impact: product.impact,
        imageUrl: product.imageUrl || '',
        price: product.price || '',
        details: product.details || '',
        ctaLabel: product.ctaLabel || '',
        ctaUrl: product.ctaUrl || '',
        reason: reasons[0] || '',
        reasons: reasons.slice(0, 3),
        score
      }))
    };
  }

  /** Convenience wrapper: person + browsing → ranked recommendations. */
  static recommendFor({ config, person, browsing, limit, override, preview = false }) {
    const profile = this.buildProfile({ person, browsing, override });
    return this.rank({ config, profile, limit, preview });
  }

  /** Format the shortlist for the system prompt. */
  static promptBlock(result) {
    if (!result?.items?.length) return '';
    const intentGuide = {
      ready: 'The visitor shows strong purchase intent: after recommending, offer a concrete next step (booking a call or the product’s configured action link).',
      considering: 'The visitor is comparing options: explain clearly why each fits and offer to compare or recommend one.',
      browsing: 'The visitor is early and exploring: keep it light and helpful, no pressure to buy.'
    }[result.intentLevel] || '';
    const lines = result.items.map((item, index) => `${index + 1}. [${item.id}] ${item.name} (fit score ${item.score}) — why: ${item.reasons.join('; ') || 'general fit'}`);
    return `Ranked by fit for THIS visitor from their stated preferences, browsing, previous interactions and intent (based on: ${result.basedOn.join(', ') || 'none'}).
When recommending products, prefer these ids in this order unless the visitor asks for something different, and naturally mention why each fits. Do not reveal scores.
Purchase intent: ${result.intentLevel}. ${intentGuide}
${lines.join('\n')}`;
  }

  /**
   * Learn from one visitor message. Returns a preferences object to persist (or null if unchanged).
   */
  static learnFromMessage({ person, text, isButton = false, config, browsing = [], quizAnswers = null }) {
    const prefs = { ...(person?.preferences || {}) };
    const catalog = this.activeCatalog(config);
    let changed = false;

    // Products the visitor opened ("Tell me everything about …") or named.
    const mentioned = findMentionedProducts(text, catalog);
    if (mentioned.length) {
      const views = { ...(prefs.productViews || {}) };
      mentioned.slice(0, 3).forEach(product => { views[product.id] = (views[product.id] || 0) + 1; });
      prefs.productViews = topEntries(views, 30);
      prefs.lastProductId = mentioned[0].id;
      changed = true;
    }

    // Topics typed by the visitor (skip quick-reply labels and contact details).
    const typedTopic = !isButton && !/[@]|\d{7,}/.test(text) && !/guided product discovery quiz/i.test(text);
    if (typedTopic) {
      const words = tokenize(text);
      if (words.length) {
        const keywords = { ...(prefs.keywords || {}) };
        words.slice(0, 12).forEach(word => { keywords[word] = (keywords[word] || 0) + 1; });
        prefs.keywords = topEntries(keywords, 40);
        changed = true;
      }
    }

    // Purchase intent accumulates across the conversation.
    const intent = detectIntent(text);
    if (intent !== 'none') {
      prefs.intentScore = Math.min(10, Number(prefs.intentScore || 0) + (intent === 'high' ? 3 : 1));
      changed = true;
    }
    prefs.intentLevel = intentLevelFromScore(prefs.intentScore, person?.stage);

    // Quiz answers are explicit preferences.
    if (Array.isArray(quizAnswers) && quizAnswers.length) {
      prefs.quizAnswers = quizAnswers
        .map(item => ({ field: String(item.field || 'custom').slice(0, 40), question: String(item.question || '').slice(0, 240), answer: String(item.answer || '').slice(0, 120) }))
        .filter(item => item.answer)
        .slice(0, 8);
      const goal = prefs.quizAnswers.find(item => item.field === 'goal');
      if (goal) prefs.goal = goal.answer;
      changed = true;
    }

    // Browsing history sent by the widget.
    const pages = cleanBrowsing(browsing);
    if (pages.length) {
      const byUrl = new Map((prefs.browsing || []).map(page => [page.url, page]));
      pages.forEach(page => byUrl.set(page.url, page));
      prefs.browsing = [...byUrl.values()].sort((a, b) => a.at - b.at).slice(-25);
      changed = true;
    }

    if (!changed) return null;
    prefs.updatedAt = new Date().toISOString();
    return prefs;
  }

  /** Record a click on a product card or its call-to-action link (sent from the widget as an event). */
  static async recordInteraction(personId, productId, kind = 'viewed') {
    if (!personId || !productId) return null;
    const person = await PersonRepository.get(personId);
    if (!person) return null;
    const prefs = { ...(person.preferences || {}) };
    const views = { ...(prefs.productViews || {}) };
    views[productId] = (views[productId] || 0) + (kind === 'cta_clicked' ? 2 : 1);
    prefs.productViews = topEntries(views, 30);
    prefs.lastProductId = productId;
    if (kind === 'cta_clicked') {
      prefs.intentScore = Math.min(10, Number(prefs.intentScore || 0) + 2);
      prefs.intentLevel = intentLevelFromScore(prefs.intentScore, person.stage);
    }
    prefs.updatedAt = new Date().toISOString();
    return PersonRepository.update(personId, { preferences: prefs });
  }
}

RecommendationService._internals = { tokenize, detectIntent, industryMatch, intentLevelFromScore };

module.exports = RecommendationService;
