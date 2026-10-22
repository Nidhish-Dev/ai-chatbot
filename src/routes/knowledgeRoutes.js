const express = require('express');
const router = express.Router();
const ConfigService = require('../services/configService');
const { generateFaqsFromFile } = require('../ai/openaiService');
const { scrapeWebsiteKnowledge } = require('../ai/siteCrawler');

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const ACCEPTED_TYPES = {
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.doc': 'application/msword'
};

function clientSafeConfig(config) {
  const safe = JSON.parse(JSON.stringify(config));
  if (safe.ai) delete safe.ai.apiKey;
  if (safe.alerts) delete safe.alerts.n8nWebhookUrl;
  return safe;
}

router.post('/api/knowledge/scrape-website', async (req, res) => {
  try {
    const { clientId = 'grapelabs', websiteUrl } = req.body || {};
    if (typeof websiteUrl !== 'string' || !websiteUrl.trim()) {
      return res.status(400).json({ success: false, error: 'Enter a website URL to scan.' });
    }

    const scraped = await scrapeWebsiteKnowledge(websiteUrl);
    const config = await ConfigService.getConfig(clientId);
    const draftLinks = {
      ...(config.links || {}),
      ...(config.draft?.links || {}),
      websiteUrl: scraped.url
    };
    const updated = await ConfigService.updateDraft(clientId, {
      links: draftLinks,
      websiteKnowledge: scraped.content,
      changeNote: `Scraped ${scraped.pages.length} website pages`
    });

    res.json({
      success: true,
      config: clientSafeConfig(updated),
      pages: scraped.pages,
      pageCount: scraped.pages.length,
      characterCount: scraped.content.length,
      preview: scraped.content.slice(0, 6000)
    });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message || 'Could not read the website.' });
  }
});

router.post('/api/knowledge/generate-faqs', async (req, res) => {
  try {
    const { clientId = 'grapelabs', fileName, mimeType, base64 } = req.body || {};
    if (typeof fileName !== 'string' || typeof base64 !== 'string') {
      return res.status(400).json({ success: false, error: 'Upload a PDF, DOC, or DOCX file.' });
    }
    const extension = fileName.slice(fileName.lastIndexOf('.')).toLowerCase();
    if (!ACCEPTED_TYPES[extension] || mimeType !== ACCEPTED_TYPES[extension]) {
      return res.status(400).json({ success: false, error: 'Use a PDF, DOC, or DOCX file.' });
    }
    if (!base64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
      return res.status(400).json({ success: false, error: 'The uploaded file could not be read.' });
    }
    const fileBytes = Buffer.from(base64, 'base64');
    if (fileBytes.length > MAX_FILE_BYTES) {
      return res.status(413).json({ success: false, error: 'File must be 10 MB or smaller.' });
    }

    const config = await ConfigService.getConfig(clientId);
    const documentResult = await generateFaqsFromFile({ fileName: fileName.slice(0, 160), mimeType, base64, config });
    const generated = documentResult.faqs;
    const companyName = documentResult.companyName;
    if (!generated.length) throw new Error('No question and answer pairs could be generated from this document.');

    const previousFaqs = config.draft?.faqs || config.faqs || [];
    // Re-uploading the same source replaces its earlier generated answers instead
    // of accumulating duplicates alongside the new generation.
    const mergedFaqs = previousFaqs.filter(faq => faq.source !== fileName);
    const seenQuestions = new Set(mergedFaqs.map(faq => faq.question.trim().toLowerCase()));
    for (const faq of generated) {
      const key = faq.question.toLowerCase();
      if (!seenQuestions.has(key)) {
        mergedFaqs.push(faq);
        seenQuestions.add(key);
      }
    }
    const previousDocuments = config.draft?.knowledgeDocuments || config.knowledgeDocuments || [];
    const knowledgeDocuments = [...new Set([...previousDocuments, fileName.slice(0, 160)])];
    const draft = {
      faqs: mergedFaqs,
      knowledgeDocuments,
      changeNote: `Generated ${generated.length} FAQs from ${fileName.slice(0, 120)}`
    };
    if (companyName) draft.cagCompanyName = companyName;
    const updated = await ConfigService.updateDraft(clientId, draft);

    res.json({
      success: true,
      generatedCount: generated.length,
      totalFaqCount: mergedFaqs.length,
      companyName,
      faqs: generated,
      config: clientSafeConfig(updated)
    });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message || 'Could not generate FAQs from this file.' });
  }
});

module.exports = router;
