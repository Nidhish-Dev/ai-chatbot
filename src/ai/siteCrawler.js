const cheerio = require('cheerio');
const dns = require('node:dns/promises');
const net = require('node:net');
const { callAI } = require('./openaiService');
const MAX_HTML_BYTES = 2 * 1024 * 1024;

/**
 * Clean URL and normalize protocol
 */
function normalizeUrl(inputUrl) {
  if (typeof inputUrl !== 'string' || !inputUrl.trim()) throw new Error('Please provide a valid website URL.');
  let url = inputUrl.trim();
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    url = 'https://' + url;
  }
  return url;
}

function isPublicAddress(address) {
  if (net.isIPv4(address)) {
    const [a, b] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127));
  }
  if (net.isIPv6(address)) {
    const value = address.toLowerCase();
    return value === '::1' || value === '::' ? false :
      !(value.startsWith('fc') || value.startsWith('fd') || value.startsWith('fe8') || value.startsWith('fe9') || value.startsWith('fea') || value.startsWith('feb') || value.startsWith('ff'));
  }
  return false;
}

async function validatePublicUrl(input) {
  const url = new URL(normalizeUrl(input));
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Only public HTTP or HTTPS website URLs are supported.');
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) throw new Error('Please use a publicly accessible website.');
  const addresses = net.isIP(hostname) ? [{ address: hostname }] : await dns.lookup(hostname, { all: true });
  if (!addresses.length || addresses.some(item => !isPublicAddress(item.address))) throw new Error('Please use a publicly accessible website.');
  return url.href;
}

/**
 * Fetch HTML content from URL safely with timeout
 */
async function fetchHtml(inputUrl, timeoutMs = 8000, redirects = 0) {
  const url = await validatePublicUrl(inputUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'manual',
      headers: {
        'User-Agent': 'Mozilla/5.0 (GrapeLabs Bot / Business Preview Scanner; +https://grapelabs.in)',
        'Accept': 'text/html,application/xhtml+xml,application/xml'
      }
    });
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      if (redirects >= 3) throw new Error('The website redirected too many times.');
      const location = res.headers.get('location');
      if (!location) throw new Error('The website returned an invalid redirect.');
      clearTimeout(timer);
      return fetchHtml(new URL(location, url).href, timeoutMs, redirects + 1);
    }
    if (!res.ok) {
      throw new Error(`HTTP error ${res.status}`);
    }
    const length = Number(res.headers.get('content-length') || 0);
    if (length > MAX_HTML_BYTES) throw new Error('The website page is too large to scan (2 MB maximum per page).');
    if (!res.body) return '';
    const reader = res.body.getReader();
    const chunks = [];
    let totalBytes = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_HTML_BYTES) {
        await reader.cancel();
        throw new Error('The website page is too large to scan (2 MB maximum per page).');
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks).toString('utf8');
  } catch (err) {
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Extract clean text and metadata from HTML
 */
function parseHtml(html, baseUrl) {
  const $ = cheerio.load(html);

  // Remove script, style, noscript, svg, nav, footer junk
  $('script, style, noscript, iframe, link').remove();

  const title = $('title').text().trim() || $('meta[property="og:site_name"]').attr('content') || '';
  const description = $('meta[name="description"]').attr('content') || $('meta[property="og:description"]').attr('content') || '';
  
  // Try extracting brand color from meta theme-color or styles
  const themeColor = $('meta[name="theme-color"]').attr('content') || '#4A1080';

  // Try finding logo
  let logo = $('meta[property="og:image"]').attr('content') || $('link[rel="apple-touch-icon"]').attr('href') || $('link[rel="icon"]').attr('href') || '';
  if (logo && !logo.startsWith('http')) {
    try {
      logo = new URL(logo, baseUrl).href;
    } catch (e) {
      // ignore
    }
  }

  // Find candidate subpage links (about, products, faq, contact, policies)
  const candidateLinks = new Set();
  const targetKeywords = ['about', 'service', 'product', 'collection', 'shop', 'faq', 'contact', 'return', 'shipping', 'policy', 'terms', 'support', 'delivery', 'pricing'];
  
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href) return;
    try {
      const parsed = new URL(href, baseUrl);
      if (parsed.hostname === new URL(baseUrl).hostname) {
        const pathLower = parsed.pathname.toLowerCase();
        if (targetKeywords.some(kw => pathLower.includes(kw))) {
          candidateLinks.add(parsed.origin + parsed.pathname);
        }
      }
    } catch (e) {
      // ignore relative parsing error
    }
  });

  // Extract clean text from body
  const bodyText = $('body').text().replace(/\s+/g, ' ').trim().slice(0, 8000);

  return {
    title,
    description,
    themeColor,
    logo,
    bodyText,
    candidateLinks: Array.from(candidateLinks).slice(0, 5)
  };
}

/** Extract reusable, text-only website knowledge for configured bot answers. */
async function scrapeWebsiteKnowledge(rawUrl) {
  const url = await validatePublicUrl(rawUrl);
  const homeHtml = await fetchHtml(url);
  const homeData = parseHtml(homeHtml, url);
  const pages = [{ url, ...homeData }];

  for (const pageUrl of homeData.candidateLinks) {
    if (pages.length >= 6) break;
    if (new URL(pageUrl).pathname === new URL(url).pathname) continue;
    try {
      const html = await fetchHtml(pageUrl, 5000);
      pages.push({ url: pageUrl, ...parseHtml(html, pageUrl) });
    } catch (_) {
      // Keep the useful pages even when an optional subpage is unavailable.
    }
  }

  const content = pages.map((page, index) => [
    `PAGE ${index + 1}: ${page.title || page.url}`,
    `URL: ${page.url}`,
    page.description ? `Description: ${page.description}` : '',
    page.bodyText ? `Page content: ${page.bodyText}` : ''
  ].filter(Boolean).join('\n')).join('\n\n').slice(0, 30000);

  if (!content.trim()) throw new Error('No readable text was found on that website.');
  return { url, content, pages: pages.map(({ url: pageUrl, title }) => ({ url: pageUrl, title })) };
}

/**
 * Crawl website and generate business profile
 */
async function crawlAndBuildProfile(rawUrl, onStepProgress = null) {
  const url = normalizeUrl(rawUrl);
  const steps = [];

  const reportStep = (label) => {
    steps.push({ label, time: Date.now() });
    if (onStepProgress) onStepProgress(label);
  };

  try {
    // Step 1: Read homepage
    reportStep("Read your homepage");
    const homeHtml = await fetchHtml(url);
    const homeData = parseHtml(homeHtml, url);

    // Step 2: Read subpages (products/collections)
    reportStep("Found key products and services");
    let combinedText = `HOMEPAGE (${url}):\nTitle: ${homeData.title}\nDescription: ${homeData.description}\nContent: ${homeData.bodyText}\n\n`;

    let productsCount = 12;
    for (const subLink of homeData.candidateLinks) {
      try {
        const subHtml = await fetchHtml(subLink, 4000);
        const subData = parseHtml(subHtml, subLink);
        combinedText += `SUBPAGE (${subLink}):\n${subData.bodyText.slice(0, 2000)}\n\n`;
      } catch (e) {
        // Continue if a subpage fails
      }
    }

    // Step 3: Learned return/support policy
    reportStep("Learned your return & support policies");

    // Step 4: Picked up brand tone
    reportStep("Picked up your brand tone");

    // Extract business profile using AI or fallback summarizer
    const businessName = homeData.title.split(/[-|:]/)[0].trim() || 'Your Brand';
    const primaryColor = homeData.themeColor || '#4A1080';

    const systemPrompt = `You are a high-speed business intelligence parser.
Read the website text and extract a concise, structured business profile for an AI demo bot.
Respond ONLY in this JSON format:
{
  "businessName": "Name of brand",
  "whatTheySell": "One or two sentences on their core offering",
  "keyProducts": ["Product 1", "Product 2", "Product 3"],
  "policies": "Summary of shipping, returns, warranty, or customer service policies",
  "tone": "Casual / Luxury / Professional / Direct",
  "contactDetails": "Email or phone if visible",
  "suggestedFaqs": [
    {"q": "What products do you offer?", "a": "..."},
    {"q": "What is your return policy?", "a": "..."}
  ]
}`;

    let aiProfile = null;
    try {
      const aiResult = await callAI({
        messages: [{ role: 'user', content: combinedText.slice(0, 10000) }],
        systemPrompt,
        config: {},
        personContext: {}
      });
      aiProfile = aiResult.structured || aiResult.extracted || {};
    } catch (e) {
      // Local fallback profile
    }

    return {
      success: true,
      url,
      businessName: (aiProfile && aiProfile.businessName) || businessName,
      whatTheySell: (aiProfile && aiProfile.whatTheySell) || homeData.description || 'Quality products and services tailored for our customers.',
      keyProducts: (aiProfile && aiProfile.keyProducts) || ['Featured Catalog Items', 'Custom Orders', 'Customer Support'],
      policies: (aiProfile && aiProfile.policies) || 'Hassle-free support and transparent customer service.',
      tone: (aiProfile && aiProfile.tone) || 'Professional and welcoming',
      brandColor: primaryColor,
      logoUrl: homeData.logo || null,
      steps
    };
  } catch (err) {
    return {
      success: false,
      error: err.message,
      steps
    };
  }
}

/**
 * Fallback business profile builder if URL cannot be fetched
 */
function buildFallbackProfileFromDescription(description, businessName = 'Your Business') {
  return {
    success: true,
    url: null,
    businessName,
    whatTheySell: description,
    keyProducts: ['Core Services', 'Custom Packages'],
    policies: 'Contact support for inquiries.',
    tone: 'Professional and helpful',
    brandColor: '#4A1080',
    logoUrl: null,
    steps: [{ label: 'Built profile from description', time: Date.now() }]
  };
}

module.exports = {
  normalizeUrl,
  validatePublicUrl,
  scrapeWebsiteKnowledge,
  crawlAndBuildProfile,
  buildFallbackProfileFromDescription
};
