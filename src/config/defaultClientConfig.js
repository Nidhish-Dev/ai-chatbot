/**
 * Default Client Configuration for GrapeLabs (Client ID: 'grapelabs')
 * Follows Pillar 1.1: Nothing client-specific is hardcoded in the engine.
 * Everything can be edited via the Control Panel or synced from Google Sheets.
 */

module.exports = {
  clientId: 'grapelabs',
  name: 'GrapeLabs',
  active: true,
  ai: {
    apiKey: '',
    model: 'gpt-4o-mini'
  },
  knowledgeDocuments: [],
  
  // Visual Branding & Theme
  branding: {
    brandName: 'GrapeLabs',
    brandTagline: 'Automation & AI Systems for High-Growth Teams',
    logoUrl: 'https://grapelabs.in/logo.svg',
    avatarMark: `<svg viewBox="0 0 36 36" fill="none" xmlns="http://www.w3.org/2000/svg">
      <circle cx="18" cy="18" r="18" fill="#1C0A30"/>
      <circle cx="18" cy="11" r="4.5" fill="#D4880A"/>
      <circle cx="12" cy="19" r="4.5" fill="#7B2CBF"/>
      <circle cx="24" cy="19" r="4.5" fill="#7B2CBF"/>
      <circle cx="18" cy="26" r="4.5" fill="#4A1080"/>
    </svg>`,
    colors: {
      deepInk: '#1C0A30',      // Header, main text, container bg in dark mode
      royalPurple: '#4A1080',  // User bubbles, active chips, accents
      amber: '#D4880A',        // Send button, Try-it banner, highlights
      backgroundLight: '#FDFBF7',
      cardBgLight: '#FFFFFF',
      textLight: '#1C0A30',
      backgroundDark: '#120521',
      cardBgDark: '#1E0D33',
      textDark: '#F5F0FA'
    },
    borderRadius: '18px',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", sans-serif'
  },

  // Channels Configuration
  channels: {
    web: {
      enabled: true,
      greeting: "Hey! I'm GrapeLabs' AI consultant. I can answer anything about automating your operations, recommend systems built for your workflow, or let you test an AI trained live on your own website.",
      returningGreeting: "Welcome back! Good to see you again. Want to pick up where we left off, or check out our latest automation builds?",
      streaming: true,
      calendlyInline: true
    },
    whatsapp: {
      enabled: true,
      greeting: "Hi there! GrapeLabs Automation here. How can we help streamline your operations today?",
      quietHours: { enabled: false, start: '22:00', end: '08:00' },
      displayName: 'GrapeLabs Support',
      handoffContact: '+919999999999'
    },
    instagram: {
      enabled: true,
      greeting: "Hey! Thanks for messaging GrapeLabs. Tell us what repetitive tasks are slowing you down.",
      quietHours: { enabled: false, start: '22:00', end: '08:00' },
      username: 'grapelabs',
      handoffContact: '@grapelabs'
    }
  },

  // Teaser Pop-up Settings
  teaser: {
    enabled: true,
    delaySeconds: 15,
    scrollThresholdPercent: 50,
    text: "Got a repetitive task eating your week? Ask anything, or see what we'd automate for you.",
    chips: []
  },

  nudges: {
    enabled: true,
    minExchanges: 3,
    cooldownExchanges: 3,
    delaySeconds: 30,
    instruction: 'Be helpful and low pressure. Suggest a relevant next step based on what the visitor asked; never repeat a question they already answered.'
  },

  // Conversation starters & quick actions (welcome screen, in-chat shortcut bar, teaser)
  quickActions: {
    enabled: true,
    // Suggested questions. Leave empty to use the first FAQ questions automatically.
    starters: [],
    maxStarters: 3,
    showInChat: true,     // shortcut bar above the message box
    showInTeaser: true,   // use starters as teaser chips when no teaser chips are set
    // type: message | recommend | quiz | tryit | booking | human | whatsapp | link
    actions: [
      { id: 'recommend', label: 'Recommend for me', type: 'recommend', value: '', enabled: true },
      { id: 'products', label: 'Browse products', type: 'message', value: 'What products do you offer?', enabled: true },
      { id: 'book', label: 'Book a call', type: 'booking', value: 'I would like to book a call', enabled: true },
      { id: 'support', label: 'Contact support', type: 'human', value: 'I would like to talk to someone from your team', enabled: true }
    ]
  },

  // Chat widget appearance (control panel -> Customise). Empty values keep the widget's built-in look.
  appearance: {
    preset: 'brand',
    theme: 'light',                 // light | dark | auto (follow the visitor's device)
    colors: { primary: '', header: '', highlight: '', background: '' },
    headerStyle: 'gradient',        // gradient | solid
    position: 'right',              // right | left
    offsetX: 24,
    offsetY: 24,
    launcherStyle: 'logo',          // logo | icon | avatar
    launcherIcon: 'chat',           // chat | sparkle | headset
    launcherLabel: '',              // e.g. "Chat with us" turns the launcher into a pill
    launcherSize: 'md',             // sm | md | lg
    panelWidth: 'standard',         // compact | standard | wide
    corners: 'rounded',             // rounded | soft | square
    font: 'system',                 // system | inter | poppins | dm-sans | nunito
    bubbleStyle: 'rounded',         // rounded | square
    avatarUrl: '',                  // empty = brand logo
    avatarShape: 'circle',          // circle | rounded
    welcomeHeading: '',
    welcomeMessage: '',
    startTitle: '',
    startSubtitle: '',
    inputPlaceholder: '',
    disclaimer: '',
    showContacts: true,
    showPoweredBy: true,
    poweredByText: ''
  },

  // Human handover: redirect to a normal WhatsApp chat (wa.me link, no WhatsApp API) with the
  // visitor's details and last message pre-filled. Configured in the control panel → Human handover.
  handover: {
    enabled: true,
    whatsappNumber: '',            // empty = use links.whatsappRefNumber
    triggers: {
      onUnsure: true,              // the AI can't answer confidently
      onFrustration: true          // the visitor sounds frustrated
    },                             // explicit requests ("talk to a person") always offer handover
    collectDetailsFirst: false,    // ask the required lead questions before showing the WhatsApp button
    detailsMessage: 'Before I connect you with our team on WhatsApp, please share a few details so they know who you are.',
    showHeaderButton: true,        // "Talk to a person" button in the chat header
    message: 'Our team can take it from here. Tap below to continue on WhatsApp \u2014 your details and question are already filled in, just press send.',
    buttonLabel: 'Continue on WhatsApp',
    greeting: 'Hi {brand} team, I was chatting with your assistant on the website and would like to talk to a person.',
    include: { name: true, email: true, phone: true, company: true, lastMessage: true, page: false, refCode: true }
  },

  // Assistant personality (control panel → Personality). Compiled into the AI's brand voice instructions;
  // the brandVoice text below is kept as additional brand rules.
  personality: {
    enabled: true,
    preset: 'custom',
    assistantName: '',
    role: 'AI automation consultant',
    description: 'Sharp, confident and consultative. Practical advice with zero corporate jargon, delivered in a friendly way.',
    traits: ['sharp', 'confident', 'consultative', 'practical', 'friendly'],
    formality: 2,
    energy: 3,
    detail: 2,
    humour: 1,
    empathy: 3,
    emoji: 'none',
    perspective: 'we',
    useVisitorName: true,
    language: 'English',
    mirrorLanguage: false,
    hinglish: true,
    formatting: 'bullets',
    maxSentences: 5,
    offTopic: 'redirect',
    doRules: ['Focus on the visitor\'s business problem before suggesting a solution'],
    dontRules: ['Use corporate jargon or buzzwords'],
    preferredWords: '',
    avoidWords: 'synergy, leverage, cutting-edge, revolutionary',
    examples: [],
    showNameInHeader: true
  },

  // Lead capture: asked as a separate message (never inside the AI's answer)
  leadCapture: {
    enabled: true,
    mode: 'both',              // 'questions' (during chat) | 'gated' (only before a resource) | 'both'
    style: 'form',             // 'form' (one card with all fields) | 'conversational' (one question at a time)
    afterExchanges: 3,         // ask after this many visitor messages
    repeatAfterExchanges: 5,   // if skipped, ask again after this many more messages
    maxAsksPerSession: 2,      // never ask more often than this in one conversation
    questionsPerAsk: 3,        // how many unanswered questions to ask at once
    introMessage: 'Before we continue, could you share a few details so our team can follow up with you?',
    gateMessage: 'Happy to share “{title}”. Please fill in a few quick details to unlock it.',
    thankYouMessage: 'Thanks{name}! Your details are saved.',
    consentText: '',
    questions: [
      { id: 'name', label: 'Name', question: 'What is your name?', field: 'name', type: 'text', required: true, enabled: true, options: [] },
      { id: 'email', label: 'Email', question: 'What is your email address?', field: 'email', type: 'email', required: true, enabled: true, options: [] },
      { id: 'phone', label: 'WhatsApp number', question: 'What is your WhatsApp number?', field: 'phone', type: 'phone', required: false, enabled: true, options: [] },
      { id: 'company', label: 'Company', question: 'Which company are you with?', field: 'company', type: 'text', required: false, enabled: false, options: [] }
    ],
    // Downloadable files or links that require details first
    resources: []
  },

  // Personalised product recommendations
  recommendations: {
    enabled: true,
    showOnWelcome: true,  // "Recommended for you" on the welcome screen once there is a signal
    maxItems: 3,
    showReasons: true     // short "why this fits" line on product cards
  },

  // Links & Integrations
  links: {
    calendlyUrl: 'https://calendly.com/grapelabs/discovery',
    privacyPolicyUrl: 'https://grapelabs.in/privacy',
    websiteUrl: 'https://grapelabs.in',
    whatsappRefNumber: '+919876543210'
  },

  // Alerts & Notification Targets
  alerts: {
    telegramChatId: process.env.TELEGRAM_DEFAULT_CHAT_ID || '-1001234567890',
    alertEmail: 'team@grapelabs.in',
    n8nWebhookUrl: process.env.N8N_WEBHOOK_URL || ''
  },

  // Caps & Rate Limits
  limits: {
    maxMessagesWithoutContact: 20,
    tryItDailyLimitPerUser: 3,
    tryItMaxMessages: 15,
    tryItSessionMinutes: 30
  },

  // Scoring Rules & Thresholds
  scoring: {
    hotThreshold: 70,
    signals: {
      describes_business: 15,
      industry_known: 10,
      team_size_known: 5,
      specific_pain: 20,
      pricing_timeline_process: 15,
      contact_details_given: 15,
      used_try_it: 15,
      clicks_book_call: 10
    }
  },

  // Automation Consultant Questions
  consultant: {
    enabled: true,
    questions: [
      {
        id: 'industry',
        order: 1,
        question: "To suggest the highest-impact automations, what industry or business type are you in?",
        field: 'industry',
        chips: ["D2C / E-commerce", "SaaS / Tech", "Agency / Services", "Clinic / Healthcare", "Real Estate", "Other"]
      },
      {
        id: 'team_size',
        order: 2,
        question: "Got it. How big is your core team right now?",
        field: 'team_size',
        chips: ["1-5 people", "6-20 people", "21-50 people", "50+ people"]
      },
      {
        id: 'manual_task',
        order: 3,
        question: "What is the single most repetitive, time-consuming manual task your team deals with every week?",
        field: 'pains',
        chips: ["Customer queries & WhatsApp messages", "Data entry & spreadsheets", "Lead follow-ups & booking", "Order & inventory updates"]
      }
    ]
  },

  // Products Catalog (Website draft catalog by industry)
  products: [
    // D2C / E-commerce
    {
      id: 'd2c_cart_bot',
      name: 'Omnichannel Cart Recovery & WhatsApp Concierge',
      industry: ['D2C / E-commerce', 'Retail', 'E-commerce'],
      description: 'Automatically nudges abandoned carts on WhatsApp with personalised offers and recovers 18-25% of lost revenue.',
      impact: 'Recovers 18-25% lost checkouts and answers product queries instantly 24/7.', imageUrl: '', price: '', details: '', ctaLabel: '', ctaUrl: '', active: true
    },
    {
      id: 'd2c_order_sync',
      name: 'Shopify to Warehouse Auto-Sync Pipeline',
      industry: ['D2C / E-commerce', 'Retail'],
      description: 'Eliminates CSV manual exports by syncing orders, tracking codes, and inventory live across Shopify, Shiprocket, and ERP.',
      impact: 'Zero manual order processing errors and cuts dispatch prep time by 80%.', imageUrl: '', price: '', details: '', ctaLabel: '', ctaUrl: '', active: true
    },
    {
      id: 'd2c_return_ai',
      name: 'AI Return & Exchange Gatekeeper',
      industry: ['D2C / E-commerce', 'Retail'],
      description: 'Validates customer return photos using vision AI, checks return policy conditions, and initiates reverse pickups.',
      impact: 'Reduces return ticket handling time from 24 hours to 90 seconds.', imageUrl: '', price: '', details: '', ctaLabel: '', ctaUrl: '', active: true
    },

    // Agency / Services / Consulting
    {
      id: 'agency_lead_qualifier',
      name: 'Smart Lead Scoring & Instant Calendar Booking',
      industry: ['Agency / Services', 'SaaS / Tech', 'Consulting'],
      description: 'Greets inbound leads on your site and WhatsApp, scores their budget and requirements, and books qualified calls immediately.',
      impact: 'Triples speed-to-lead and filters out tire-kickers before your sales calls.', imageUrl: '', price: '', details: '', ctaLabel: '', ctaUrl: '', active: true
    },
    {
      id: 'agency_client_onboard',
      name: 'Autonomous Client Onboarding Hub',
      industry: ['Agency / Services', 'SaaS / Tech'],
      description: 'Generates client Google Drive folders, Slack channels, Notion dashboards, and contracts immediately upon deal closure.',
      impact: 'Saves 3-4 hours of manual setup per client and creates a seamless first impression.', imageUrl: '', price: '', details: '', ctaLabel: '', ctaUrl: '', active: true
    },
    {
      id: 'agency_invoice_chaser',
      name: 'Gentle Auto-Invoice & Payment Follower',
      industry: ['Agency / Services', 'Consulting', 'B2B'],
      description: 'Tracks unpaid invoices in your accounting tool and sends polite, scheduled reminders on WhatsApp & Email with payment links.',
      impact: 'Reduces overdue accounts receivable by 40% without awkward manual follow-ups.', imageUrl: '', price: '', details: '', ctaLabel: '', ctaUrl: '', active: true
    },

    // Clinic / Healthcare
    {
      id: 'clinic_patient_booking',
      name: '24/7 Patient Triage & Appointment Bot',
      industry: ['Clinic / Healthcare', 'Medical'],
      description: 'Handles patient appointment booking, rescheduling, and preliminary symptom intake over WhatsApp and web.',
      impact: 'Eliminates clinic phone congestion and reduces missed appointments by 60% with reminders.', imageUrl: '', price: '', details: '', ctaLabel: '', ctaUrl: '', active: true
    },
    {
      id: 'clinic_report_dispatcher',
      name: 'Secure Lab Report Auto-Dispatcher',
      industry: ['Clinic / Healthcare', 'Medical'],
      description: 'Securely matches lab results from your diagnostic software and sends PDF reports to patients on WhatsApp with OTP.',
      impact: 'Cuts front-desk dispatch queries to zero while maintaining strict patient privacy.', imageUrl: '', price: '', details: '', ctaLabel: '', ctaUrl: '', active: true
    },

    // Real Estate
    {
      id: 're_property_matcher',
      name: 'Instant Property Matcher & Tour Scheduler',
      industry: ['Real Estate', 'Brokers'],
      description: 'Captures buyer preferences (budget, location, BHK) and sends matching brochures instantly, booking site visits.',
      impact: 'Engages home buyers within 10 seconds of lead submission across Meta ads.', imageUrl: '', price: '', details: '', ctaLabel: '', ctaUrl: '', active: true
    },
    {
      id: 're_broker_handoff',
      name: 'VIP Lead Escalation to Site Manager',
      industry: ['Real Estate'],
      description: 'Identifies high-intent property investors and rings the site manager on mobile with buyer context in hand.',
      impact: 'Connects hot buyers with agents while interest is at peak.', imageUrl: '', price: '', details: '', ctaLabel: '', ctaUrl: '', active: true
    },

    // General / Operations / All
    {
      id: 'ops_doc_parser',
      name: 'AI Document & Invoice Data Extractor',
      industry: ['All', 'Finance', 'Logistics'],
      description: 'Reads PDFs, vendor invoices, or receipts and maps structured data directly into Google Sheets, Airtable, or ERP.',
      impact: 'Cuts 95% of manual copy-pasting and catches vendor discrepancies instantly.'
    },
    {
      id: 'ops_cross_tool_pipeline',
      name: 'Custom Multi-Tool n8n Data Bridge',
      industry: ['All', 'SaaS / Tech'],
      description: 'Custom resilient event bridges connecting your CRM, payment gateways, messaging apps, and internal databases.',
      impact: 'Reliable real-time data sync with automatic error alerts on Telegram or Slack.'
    }
  ],

  // Business FAQs are added from user-provided documents or entered in the control panel.
  faqs: [],

  // No built-in FAQ chips; suggestions come from configured business knowledge.
  faqChips: [],

  // Brand Voice Instructions
  brandVoice: `You are the GrapeLabs AI Automation Consultant representing GrapeLabs (grapelabs.in).
Tone: Sharp, confident, consultative, practical, zero corporate jargon, friendly.
Language: English. If the user talks in Hinglish (Hindi written in Roman script), naturally reply in fluent, natural Hinglish.
Key Rules:
1. NEVER invent pricing or give specific price quotes. Pricing is strictly customized on a discovery call based on team size and scope. Direct them to book a quick call.
2. If configured business knowledge does not support a confident answer, say exactly: "I'm not sure about this. We'll get back to you regarding this." Never guess or add unsupported facts.
3. NEVER act as a general-purpose ChatGPT. If a user asks off-topic questions (e.g. "write a poem", "who is the president"), politely steer them back: "I focus specifically on business automation and AI workflows at GrapeLabs. What workflow are you looking to streamline?"
4. When recommending solutions, suggest 3 targeted products from the GrapeLabs product catalog, each with a concise one-line impact statement.
5. Keep responses concise, punchy, and formatted with clean bullet points when listing items.`,

  // System Prompt for Live / Draft
  promptLive: `You are the GrapeLabs AI Automation Consultant.
Your mission is to understand visitor operational challenges, answer questions accurately based solely on provided Business Context and Product Catalog, recommend tailored GrapeLabs automations, and guide high-intent prospects to book a discovery call.
Always return structured JSON matching the requested schema.`,

  promptDraft: `You are the GrapeLabs AI Automation Consultant.
Your mission is to understand visitor operational challenges, answer questions accurately based solely on provided Business Context and Product Catalog, recommend tailored GrapeLabs automations, and guide high-intent prospects to book a discovery call.
Always return structured JSON matching the requested schema.`,

  promptVersion: 1,
  changeLog: [
    {
      version: 1,
      date: new Date().toISOString(),
      author: 'system',
      note: 'Initial production configuration for GrapeLabs Website Bot v1'
    }
  ]
};
