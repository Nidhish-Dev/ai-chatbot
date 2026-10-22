const OpenAI = require('openai');
const env = require('../config/env');

// The active API key is read from the Firebase-backed client config.
let currentApiKey = '';
let currentModel = env.OPENAI_MODEL || 'gpt-4o-mini';
const clients = new Map();

function setApiKey(key, model = 'gpt-4o-mini') {
  currentApiKey = key.trim();
  currentModel = model;
}

function getOpenAIClient(apiKey = currentApiKey) {
  if (!apiKey) return null;
  if (!clients.has(apiKey)) clients.set(apiKey, new OpenAI({ apiKey }));
  return clients.get(apiKey);
}

/**
 * Local fallback responder used when no OpenAI API key is configured.
 * Evaluates FAQs, multi-step consultant flow, booking, and extracts lead fields accurately.
 */
function generateFallbackResponse(messages, config = {}, personContext = {}) {
  const lastUserMsg = messages.filter(m => m.role === 'user').pop();
  const text = lastUserMsg ? lastUserMsg.content.toLowerCase().trim() : '';

  const extracted = {};
  const scoreSignals = [];
  let intent = 'faq';
  let reply = '';
  let buttons = ["How does this work?", "Recommend automations", "Try it on my business"];
  let cards = [];

  // Configured social/contact facts should be answered directly, even when the
  // local fallback model is active and these details are not present in FAQs.
  const whatsappName = config.channels?.whatsapp?.displayName || config.branding?.brandName || config.name || 'our team';
  const whatsappNumber = config.links?.whatsappRefNumber || config.channels?.whatsapp?.handoffContact || '';
  const whatsappDigits = String(whatsappNumber).replace(/\D/g, '');
  const instagramUsername = String(config.channels?.instagram?.username || config.channels?.instagram?.handoffContact || '').trim().replace(/^@+/, '');
  const instagramHandleValid = /^[A-Za-z0-9._]{1,30}$/.test(instagramUsername);
  const instagramUrl = instagramHandleValid
    ? `https://www.instagram.com/${encodeURIComponent(instagramUsername)}/`
    : (config.links?.instagramUrl || '');
  const asksInstagram = /\b(instagram|insta)\b/i.test(text) && (
    /\b(what|which|where|username|handle|account|profile|link|url|contact|reach|follow|message|dm|id|grapelabs|kya|batao)\b/i.test(text)
    || /^\s*(instagram|insta)\??\s*$/i.test(text)
  );
  const asksWhatsApp = /\b(whatsapp|whats\s*app)\b/i.test(text) && /\b(what|which|where|number|phone|contact|reach|message|chat|link|url|account|kya|batao)\b/i.test(text);
  const asksAllContacts = /\b(contact details|how can i reach|how do i reach|get in touch|ways to contact|contact you)\b/i.test(text);
  if (asksInstagram || asksWhatsApp || asksAllContacts) {
    const contactAnswers = [];
    if ((asksInstagram || asksAllContacts) && instagramUrl) {
      contactAnswers.push(instagramHandleValid
        ? `Our Instagram is **@${instagramUsername}**: ${instagramUrl}`
        : `Our Instagram profile is ${instagramUrl}`);
    } else if (asksInstagram) {
      contactAnswers.push("I'm not sure about this. We'll get back to you regarding this.");
    }
    if ((asksWhatsApp || asksAllContacts) && whatsappNumber) {
      contactAnswers.push(`You can reach **${whatsappName}** on WhatsApp at **${whatsappNumber}**${whatsappDigits ? `: https://wa.me/${whatsappDigits}` : ''}`);
    } else if (asksWhatsApp) {
      contactAnswers.push("I'm not sure about this. We'll get back to you regarding this.");
    }
    return {
      reply: contactAnswers.length ? contactAnswers.join('\n\n') : "I'm not sure about this. We'll get back to you regarding this.",
      buttons: [],
      cards: [],
      intent: contactAnswers.some(answer => answer.startsWith("I'm not sure")) ? 'human' : 'faq',
      extracted,
      score_signals: [...new Set(scoreSignals)]
    };
  }

  // Extract contact coordinates
  const emailMatch = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
  if (emailMatch) {
    extracted.email = emailMatch[0];
    scoreSignals.push('contact_details_given');
  }

  const phoneMatch = text.match(/(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}|\+91\d{10}|\b\d{10}\b/);
  if (phoneMatch) {
    extracted.phone = phoneMatch[0];
    scoreSignals.push('contact_details_given');
  }

  // Detect industry
  let detectedIndustry = null;
  if (/\b(d2c|ecommerce|e-commerce|retail|fashion|clothing|shopify)\b/i.test(text)) {
    detectedIndustry = 'D2C / E-commerce';
    extracted.industry = detectedIndustry;
    scoreSignals.push('industry_known');
  } else if (/\b(agency|consulting|b2b|services|marketing)\b/i.test(text)) {
    detectedIndustry = 'Agency / Services';
    extracted.industry = detectedIndustry;
    scoreSignals.push('industry_known');
  } else if (/\b(clinic|hospital|doctor|healthcare|dental|medical)\b/i.test(text)) {
    detectedIndustry = 'Clinic / Healthcare';
    extracted.industry = detectedIndustry;
    scoreSignals.push('industry_known');
  } else if (/\b(real estate|property|broker|realty)\b/i.test(text)) {
    detectedIndustry = 'Real Estate';
    extracted.industry = detectedIndustry;
    scoreSignals.push('industry_known');
  }

  // Detect team size
  let detectedTeamSize = null;
  const teamMatch = text.match(/(\d+\s*people|\d+\s*members|team of \d+|1-5|6-20|21-50|50\+)/i);
  if (teamMatch) {
    detectedTeamSize = teamMatch[0];
    extracted.team_size = detectedTeamSize;
    scoreSignals.push('team_size_known');
  }

  // Detect pain points
  if (/\b(repetitive|manual|slow|wasting time|spreadsheets|whatsapp overload|cart abandonment|invoice|onboarding|follow-up)\b/i.test(text)) {
    extracted.pains = text;
    scoreSignals.push('specific_pain');
  }

  // Check for Hinglish
  const isHinglish = /\b(kya|kaise|haan|nhi|nahi|batao|karo|chahiye|kitna|apna|kaam|theek)\b/i.test(text);

  // Intent classification
  if (/\b(book|call|schedule|demo|meeting|calendar|slot)\b/i.test(text)) {
    intent = 'booking';
    scoreSignals.push('clicks_book_call');
    reply = isHinglish
      ? "Bilkul! Aap seedha hamare saath 30-min discovery call book kar sakte hain neeche calendar se. Hum aapke workflows live walk through karenge."
      : "You can book a free 30-minute discovery call with our product team right here inside the chat. We'll map your bottlenecks and show you exact automation blueprints!";
    buttons = ["Book a call", "What would you build for us?", "Try it on my business"];
  } else if (/\b(price|cost|pricing|charges|fees|package|rate|budget)\b/i.test(text)) {
    intent = 'pricing';
    scoreSignals.push('pricing_timeline_process');
    reply = isHinglish
      ? "Har automation build tailor-made hota hai business size aur tools ke hisaab se. Hum fixed quote 30-min discovery call par dete hain bina kisi hidden fees ke. Kya aap slot book karna chahenge?"
      : "Every GrapeLabs system is tailored to your business stack, volume, and expected ROI. We provide clear fixed-price proposals on a quick discovery call. Would you like to schedule a 30-min slot?";
    buttons = ["Book a call", "How long does a build take?", "What tools do you connect?"];
  } else if (/\b(human|agent|person|representative|support team|talk to someone|team member)\b/i.test(text)) {
    intent = 'human';
    reply = isHinglish
      ? "Zaroor! Main team ko alert bhej raha hoon. Kripya apna WhatsApp number ya email share karein taaki team aapse turant connect kar sake."
      : "I'll alert our team right away! Please share your email or WhatsApp number so a team member can reach out to you directly.";
    buttons = ["Share contact", "Book a call", "Keep chatting with AI"];
  } else if (/\b(poem|weather|joke|president|capital of|movie|recipe|sing)\b/i.test(text)) {
    intent = 'off_topic';
    reply = isHinglish
      ? "Main GrapeLabs ka automation consultant hoon aur businesses ke repetitive tasks automate karta hoon! Aapka kaunsa manual process aap streamline karna chahte hain?"
      : "I'm GrapeLabs' automation consultant and focus specifically on automating business workflows. What repetitive tasks are taking up your team's time?";
    buttons = ["What can you automate?", "Recommend automations", "Try on my website"];
  } else if (/\b(try it|my website|demo on my business|test my site)\b/i.test(text)) {
    intent = 'try_it';
    scoreSignals.push('used_try_it');
    reply = "Let's see GrapeLabs in action on your own website! Click **'Try it on my business'** in the top banner or share your URL, and I'll crawl it to build a live demo bot in seconds.";
    buttons = ["Try it on my business", "How does this work?", "Book a call"];
  } else if (detectedIndustry || personContext.industry) {
    // Multi-Step Consultant Flow (Section 5.3)
    const currentIndustry = detectedIndustry || personContext.industry;
    const currentTeamSize = detectedTeamSize || personContext.teamSize;

    if (!currentTeamSize && !detectedTeamSize) {
      // Step 2: Ask Team Size
      intent = 'consultant';
      reply = `Got it! We've automated dozens of high-impact workflows for **${currentIndustry}** businesses. How big is your core team right now?`;
      buttons = ["1-5 people", "6-20 people", "21-50 people", "50+ people"];
    } else if (!personContext.pains && !extracted.pains && !text.includes('people') && !text.includes('1-5') && !text.includes('6-20')) {
      // Step 3: Ask most time-consuming task
      intent = 'consultant';
      reply = `Awesome. What is the single most repetitive, time-consuming manual bottleneck your team deals with every week?`;
      buttons = [
        "Customer queries & WhatsApp overload",
        "Manual data entry & spreadsheets",
        "Lead qualification & booking calls",
        "Order & shipping updates"
      ];
    } else {
      // Step 4: Deliver 3 tailored recommendations with product cards!
      intent = 'consultant';
      scoreSignals.push('describes_business');
      reply = `Based on your team in **${currentIndustry}**, here are the top 3 high-ROI automation systems we recommend building:`;

      if (currentIndustry.includes('D2C') || currentIndustry.includes('E-commerce')) {
        cards = [
          {
            id: 'd2c_cart_bot',
            name: 'Omnichannel Cart Recovery & WhatsApp Concierge',
            oneLiner: 'Recovers 18-25% lost checkouts automatically on WhatsApp 24/7.'
          },
          {
            id: 'd2c_order_sync',
            name: 'Shopify to Warehouse Auto-Sync Pipeline',
            oneLiner: 'Zero manual CSV exports; syncs orders, tracking codes, and inventory live.'
          },
          {
            id: 'd2c_return_ai',
            name: 'AI Return & Exchange Gatekeeper',
            oneLiner: 'Cuts return ticket handling time from 24 hours to 90 seconds.'
          }
        ];
      } else if (currentIndustry.includes('Clinic') || currentIndustry.includes('Healthcare')) {
        cards = [
          {
            id: 'clinic_patient_booking',
            name: '24/7 Patient Triage & Appointment Bot',
            oneLiner: 'Eliminates clinic phone congestion and cuts missed appointments by 60%.'
          },
          {
            id: 'clinic_report_dispatcher',
            name: 'Secure Lab Report Auto-Dispatcher',
            oneLiner: 'Sends verified PDF diagnostic reports to patients on WhatsApp with OTP.'
          },
          {
            id: 'ops_doc_parser',
            name: 'AI Document & Prescription Parser',
            oneLiner: 'Extracts structured records directly into your clinic management software.'
          }
        ];
      } else {
        // Agency / B2B Services default
        cards = [
          {
            id: 'agency_lead_qualifier',
            name: 'Smart Lead Scoring & Instant Calendar Booking',
            oneLiner: 'Triples speed-to-lead and qualifies prospects before booking calendar slots.'
          },
          {
            id: 'agency_client_onboard',
            name: 'Autonomous Client Onboarding Hub',
            oneLiner: 'Creates Google Drive folders, Slack channels, and contracts automatically upon deal close.'
          },
          {
            id: 'agency_invoice_chaser',
            name: 'Gentle Auto-Invoice & Payment Follower',
            oneLiner: 'Reduces overdue accounts receivable by 40% with automated polite follow-ups.'
          }
        ];
      }
      buttons = ["Book a free 30-min call", "Send this to my WhatsApp", "Try on my website"];
    }
  } else if (/\b(nothing|nope|no|cancel|later|bye)\b/i.test(text)) {
    reply = "No problem at all! Feel free to ask any questions about what we build, or test an AI trained live on your own website whenever you're ready.";
    buttons = ["How does this work?", "Try it on my business", "What tools do you support?"];
  } else {
    // Check FAQ matching from Business Context
    const faqs = config.faqs || [];
    let matchedFaq = null;
    const stopWords = new Set(['what', 'when', 'where', 'which', 'who', 'why', 'how', 'does', 'do', 'is', 'are', 'can', 'could', 'would', 'will', 'the', 'a', 'an', 'to', 'for', 'of', 'in', 'on', 'we', 'you', 'your', 'our', 'me', 'my', 'i', 'and', 'or', 'about', 'please', 'tell']);
    const queryTerms = new Set(text.match(/[a-z0-9]+/g)?.filter(word => word.length > 2 && !stopWords.has(word)) || []);

    if (queryTerms.size) {
      let best = { faq: null, score: 0 };
      for (const faq of faqs) {
        const terms = new Set(`${faq.question || ''} ${faq.answer || ''}`.toLowerCase().match(/[a-z0-9]+/g) || []);
        const score = [...queryTerms].filter(term => terms.has(term)).length;
        if (score > best.score) best = { faq, score };
      }
      const minimumScore = queryTerms.size === 1 ? 1 : 2;
      if (best.score >= minimumScore && best.score / queryTerms.size >= 0.4) matchedFaq = best.faq;
    }

    if (matchedFaq) {
      reply = matchedFaq.answer;
      buttons = ["What would you build for us?", "How long does it take?", "Book a call"];
    } else {
      intent = 'human';
      reply = "I'm not sure about this. We'll get back to you regarding this.";
      buttons = ["D2C / E-commerce", "Agency / Services", "Clinic / Healthcare"];
    }
  }

  return {
    reply,
    buttons: buttons.slice(0, 3),
    cards: cards.slice(0, 3),
    intent,
    extracted,
    score_signals: [...new Set(scoreSignals)]
  };
}

/**
 * Execute single AI call per user message (Pillar 1.2: Lean)
 */
async function callAI({ messages, systemPrompt, config = {}, personContext = {} }) {
  const apiKey = config.ai?.apiKey || currentApiKey;
  const model = config.ai?.model || currentModel || 'gpt-4o-mini';
  const client = getOpenAIClient(apiKey);

  if (client) {
    try {
      const response = await client.chat.completions.create({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          ...messages
        ],
        response_format: { type: 'json_object' },
        temperature: 0.3
      });

      const content = response.choices[0].message.content;
      const parsed = JSON.parse(content);

      return {
        structured: parsed,
        reply: parsed.reply || "I'm here to help you automate your business operations.",
        buttons: Array.isArray(parsed.buttons) ? parsed.buttons.slice(0, 3) : [],
        cards: Array.isArray(parsed.cards) ? parsed.cards.slice(0, 3) : [],
        intent: parsed.intent || 'faq',
        extracted: parsed.extracted || {},
        score_signals: Array.isArray(parsed.score_signals) ? parsed.score_signals : []
      };
    } catch (err) {
      console.warn('⚠️ OpenAI API call failed, falling back to local engine:', err.message);
    }
  }

  // Fallback engine
  return generateFallbackResponse(messages, config, personContext);
}

async function generateFaqsFromFile({ fileName, mimeType, base64, config = {} }) {
  const client = getOpenAIClient(config.ai?.apiKey || currentApiKey);
  if (!client) throw new Error('Add and save an OpenAI API key before generating FAQs.');
  const response = await client.responses.create({
    model: config.ai?.model || currentModel || 'gpt-4o-mini',
    instructions: [
      'Read the attached business knowledge document and create a comprehensive FAQ list that covers every distinct question a customer could reasonably ask about the facts in it.',
      'Also extract the primary company or organization name explicitly stated in the document. If no name is clearly stated, return an empty companyName string. Do not infer a name from the uploaded filename.',
      'Use only facts explicitly supported by the document. Do not invent, assume, or fill gaps with general knowledge.',
      'When the document does not establish an answer, do not create an FAQ for it.',
      'Return valid JSON only with this shape: {"companyName":"...","faqs":[{"id":"short_snake_case_id","question":"...","answer":"..."}]}.',
      'Write clear, concise answers. Create as many distinct FAQs as the document supports, up to 80. Do not include prices unless the document explicitly contains them.'
    ].join(' '),
    input: [{
      role: 'user',
      content: [
        { type: 'input_text', text: `Generate FAQs from this document: ${fileName}. Return the result as JSON.` },
        { type: 'input_file', filename: fileName, file_data: `data:${mimeType};base64,${base64}` }
      ]
    }],
    text: { format: { type: 'json_object' } },
    temperature: 0.2
  });
  const parsed = JSON.parse(response.output_text || '{}');
  const faqs = Array.isArray(parsed.faqs) ? parsed.faqs : [];
  return {
    companyName: typeof parsed.companyName === 'string' ? parsed.companyName.trim().slice(0, 120) : '',
    faqs: faqs
    .filter(faq => faq && typeof faq.question === 'string' && typeof faq.answer === 'string')
    .slice(0, 80)
    .map((faq, index) => ({
      id: String(faq.id || `uploaded_doc_${index + 1}`).toLowerCase().replace(/[^a-z0-9_]+/g, '_').slice(0, 64),
      question: faq.question.trim().slice(0, 500),
      answer: faq.answer.trim().slice(0, 4000),
      source: fileName
    }))
  };
}

module.exports = {
  callAI,
  generateFallbackResponse,
  setApiKey,
  getApiKey: () => currentApiKey,
  getModel: () => currentModel,
  getOpenAIClient,
  generateFaqsFromFile
};
