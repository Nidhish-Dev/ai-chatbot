const { isValidEmail, isValidPhone } = require('../utils/disposableEmails');
const { crawlAndBuildProfile, buildFallbackProfileFromDescription } = require('../ai/siteCrawler');
const { PersonRepository, SessionRepository } = require('../db/models');
const { callAI } = require('../ai/openaiService');
const LeadService = require('./leadService');

// In-memory demo sessions map (expires in 30 mins, limits to 15 messages)
const demoSessions = new Map();
// Daily usage tracker by email/IP
const dailyTries = new Map();
const crawledProfiles = new Map();

class TryItService {
  static pruneExpiredState() {
    const now = Date.now();
    for (const [id, session] of demoSessions) if (now > session.expiresAt) demoSessions.delete(id);
    for (const [key, item] of crawledProfiles) if (now > item.expiresAt) crawledProfiles.delete(key);
    const today = new Date().toISOString().slice(0, 10);
    for (const key of dailyTries.keys()) if (!key.startsWith(`${today}_`)) dailyTries.delete(key);
  }
  /**
   * Validate gate credentials and start Try-It crawl
   */
  static async startTryIt({ name, email, phone, websiteUrl, consent, ip = '127.0.0.1', personId, sessionId, clientId = 'grapelabs', config }) {
    this.pruneExpiredState();
    // 1. Consent verification (India DPDP Act / GDPR)
    if (!consent) {
      throw new Error('Please agree to the privacy policy and GrapeLabs contact terms to try the demo.');
    }

    // 2. Validate contact coordinates
    const hasValidEmail = email && isValidEmail(email);
    const hasValidPhone = phone && isValidPhone(phone);
    if (!hasValidEmail && !hasValidPhone) {
      throw new Error('Please provide a valid work email or phone number (disposable emails are blocked).');
    }

    // 3. Rate limit check (3 tries per email or IP per day)
    const today = new Date().toISOString().slice(0, 10);
    const rateLimitKey = `${today}_${email ? email.toLowerCase() : ip}`;
    const triesCount = dailyTries.get(rateLimitKey) || 0;
    if (triesCount >= (config.limits?.tryItDailyLimitPerUser || 3)) {
      throw new Error('You have reached the maximum of 3 free website demos for today. Book a call to see a full enterprise preview!');
    }
    dailyTries.set(rateLimitKey, triesCount + 1);

    // 4. Crawl website
    const crawlKey = sessionId ? `${clientId}:${sessionId}:${websiteUrl.toLowerCase().trim()}` : null;
    const cachedCrawl = crawlKey && crawledProfiles.get(crawlKey);
    let crawlResult = cachedCrawl?.profile;
    if (!crawlResult) {
      crawlResult = await crawlAndBuildProfile(websiteUrl);
      if (crawlKey && crawlResult.success) crawledProfiles.set(crawlKey, { profile: crawlResult, expiresAt: Date.now() + (config.limits?.tryItSessionMinutes || 30) * 60 * 1000 });
    }
    if (!crawlResult.success) {
      throw new Error('We could not read that website. Describe your business in a few lines and try again.');
    }

    // 5. Update person record with Try-It usage and contact info
    if (personId) {
      const person = await PersonRepository.get(personId);
      if (person) {
        const patch = {
          'identifiers.email': email ? email.toLowerCase().trim() : person.identifiers.email,
          'identifiers.phone': phone ? phone.trim() : person.identifiers.phone,
          'fields.name': name || person.fields.name,
          'fields.website': websiteUrl,
          tryItUsed: true,
          tryItProfile: crawlResult,
          'consentFlags.service': true,
          'consentFlags.marketing': true,
          [`consentFlags.channels.${email ? 'email' : 'whatsapp'}`]: true
        };
        await PersonRepository.update(personId, patch);

        // Score points for using Try-it (+15) and contact details (+15)
        await LeadService.evaluateLead({
          person: { ...person, ...patch },
          newSignals: ['used_try_it', 'contact_details_given'],
          messageCount: 5,
          config
        });
      }
    }

    // 6. Create demo session
    const demoSessionId = 'demo_' + Math.random().toString(36).substring(2, 10);
    demoSessions.set(demoSessionId, {
      id: demoSessionId,
      personId,
      profile: crawlResult,
      messageCount: 0,
      maxMessages: config.limits?.tryItMaxMessages || 15,
      createdAt: Date.now(),
      expiresAt: Date.now() + (config.limits?.tryItSessionMinutes || 30) * 60 * 1000
    });

    return {
      demoSessionId,
      profile: crawlResult
    };
  }

  /**
   * Handle fallback if website cannot be reached
   */
  static async startFallbackTryIt({ name, email, phone, businessDescription, consent, ip = '127.0.0.1', personId, config }) {
    this.pruneExpiredState();
    if (!consent) throw new Error('Please agree to the privacy policy and contact terms to try the demo.');
    if ((!email || !isValidEmail(email)) && (!phone || !isValidPhone(phone))) {
      throw new Error('Please provide a valid work email or phone number (disposable emails are blocked).');
    }
    const rateEmail = email && isValidEmail(email) ? email.toLowerCase().trim() : '';
    const today = new Date().toISOString().slice(0, 10);
    const rateLimitKey = `${today}_${rateEmail || ip}`;
    const count = dailyTries.get(rateLimitKey) || 0;
    if (count >= (config.limits?.tryItDailyLimitPerUser || 3)) throw new Error('You have reached the maximum number of demos for today.');
    dailyTries.set(rateLimitKey, count + 1);
    if (!businessDescription || businessDescription.length < 10) {
      throw new Error('Please provide at least 2-3 lines describing what your business offers.');
    }

    const fallbackProfile = buildFallbackProfileFromDescription(businessDescription, name ? `${name}'s Business` : 'Your Business');
    const demoSessionId = 'demo_' + Math.random().toString(36).substring(2, 10);

    demoSessions.set(demoSessionId, {
      id: demoSessionId,
      personId,
      profile: fallbackProfile,
      messageCount: 0,
      maxMessages: config.limits?.tryItMaxMessages || 15,
      createdAt: Date.now(),
      expiresAt: Date.now() + (config.limits?.tryItSessionMinutes || 30) * 60 * 1000
    });

    if (personId) {
      const person = await PersonRepository.get(personId);
      if (person) {
        await PersonRepository.update(personId, {
          'identifiers.email': email ? email.toLowerCase().trim() : person.identifiers.email,
          'identifiers.phone': phone ? phone.trim() : person.identifiers.phone,
          'fields.name': name || person.fields.name,
          tryItUsed: true,
          tryItProfile: fallbackProfile,
          'consentFlags.service': true,
          'consentFlags.marketing': true,
          [`consentFlags.channels.${email ? 'email' : 'whatsapp'}`]: true
        });
        await LeadService.evaluateLead({ person: { ...person, identifiers: { ...person.identifiers, email: email || person.identifiers.email, phone: phone || person.identifiers.phone }, fields: { ...person.fields, name: name || person.fields.name } }, newSignals: ['used_try_it', 'contact_details_given'], messageCount: 5, config });
      }
    }

    return {
      demoSessionId,
      profile: fallbackProfile
    };
  }

  /**
   * Demo chat mode answering strictly from the crawled business profile
   */
  static async chatDemo({ demoSessionId, message, config }) {
    this.pruneExpiredState();
    const session = demoSessions.get(demoSessionId);
    if (!session) {
      throw new Error('Demo session has expired or not found. Please start a new demo.');
    }

    if (Date.now() > session.expiresAt) {
      demoSessions.delete(demoSessionId);
      throw new Error('This 30-minute demo session has ended. Book a discovery call to get this live on your site!');
    }

    if (session.messageCount >= session.maxMessages) {
      return {
        reply: "You've reached the 15-message demo cap! Want this AI bot trained and live on your actual website? Let's book a quick call to launch your system.",
        buttons: ["Book a call", "Back to GrapeLabs", "Ask GrapeLabs team"],
        cards: [],
        isCapReached: true
      };
    }

    session.messageCount += 1;

    const profile = session.profile || {};
    const systemPrompt = `You are a customer-facing AI assistant for ${profile.businessName || 'this business'}.
Brand Offerings: ${profile.whatTheySell || 'Products and services'}
Key Products: ${(profile.keyProducts || []).join(', ')}
Policies: ${profile.policies || 'Standard support policies'}
Tone: ${profile.tone || 'Friendly and professional'}

STRICT RULES:
1. Answer customer questions ONLY using the business details above.
2. If asked something unknown, say: "I'll pass that question to our support team right away! You can also reach our staff directly."
3. Keep answers under 3 sentences, helpful, and natural.`;

    const aiResult = await callAI({
      messages: [{ role: 'user', content: message }],
      systemPrompt,
      config,
      personContext: {}
    });

    return {
      reply: aiResult.reply,
      buttons: ["Do you deliver?", "What products do you offer?", "Book GrapeLabs call"],
      cards: [],
      remainingMessages: session.maxMessages - session.messageCount,
      brandHeader: {
        businessName: profile.businessName,
        brandColor: profile.brandColor,
        logoUrl: profile.logoUrl,
        isDemo: true
      }
    };
  }
}

module.exports = TryItService;
