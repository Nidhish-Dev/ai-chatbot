const express = require('express');
const router = express.Router();
const ConfigService = require('../services/configService');
const { generateFaqsFromFile } = require('../ai/openaiService');
const { scrapeWebsiteKnowledge } = require('../ai/siteCrawler');
const { uploadPublicProductImage } = require('../db/firebase');

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
    const generatedProducts = documentResult.products || [];
    const imageUrls = new Map();
    let imageUploadFailures = 0;
    const productsWithImages = await Promise.all(generatedProducts.map(async product => {
      if (!product.imageIndex || product.imageUrl) return product;
      const image = documentResult.imageAssets?.[product.imageIndex - 1];
      if (!image) return product;
      try {
        if (!imageUrls.has(product.imageIndex)) {
          imageUrls.set(product.imageIndex, await uploadPublicProductImage(clientId, image));
        }
        const imageUrl = imageUrls.get(product.imageIndex) || '';
        if (!imageUrl) imageUploadFailures++;
        return { ...product, imageUrl };
      } catch (error) {
        imageUploadFailures++;
        console.warn(`Could not publish an extracted product image: ${error.message}`);
        return product;
      }
    }));
    const companyName = documentResult.companyName;
    if (!generated.length && !generatedProducts.length) throw new Error('No FAQs or product information could be extracted from this document.');

    // Each CAG upload is the new FAQ source of truth: replace the prior FAQ set
    // so stale questions and answers cannot survive a document update.
    const replacementFaqs = generated;
    const previousDocuments = config.draft?.knowledgeDocuments || config.knowledgeDocuments || [];
    const knowledgeDocuments = [...new Set([...previousDocuments, fileName.slice(0, 160)])];
    const draft = {
      faqs: replacementFaqs,
      knowledgeDocuments,
      changeNote: `Extracted ${generated.length} FAQs and ${generatedProducts.length} products from ${fileName.slice(0, 120)}`
    };
    // A product catalog generated from a CAG document becomes the draft catalog;
    // this prevents unrelated starter catalog entries from being recommended.
    if (productsWithImages.length) draft.products = productsWithImages;
    if (companyName) draft.cagCompanyName = companyName;
    const updated = await ConfigService.updateDraft(clientId, draft);

    res.json({
      success: true,
      generatedCount: generated.length,
      generatedProductCount: generatedProducts.length,
      imageUploadFailures,
      totalFaqCount: replacementFaqs.length,
      products: productsWithImages,
      companyName,
      faqs: generated,
      config: clientSafeConfig(updated)
    });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message || 'Could not generate FAQs from this file.' });
  }
});

module.exports = router;
