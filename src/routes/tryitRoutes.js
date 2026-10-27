const express = require('express');
const router = express.Router();
const TryItService = require('../services/tryItService');
const ConfigService = require('../services/configService');
const { generateFaqsFromFile } = require('../ai/openaiService');
const { isValidEmail, isValidPhone } = require('../utils/disposableEmails');

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const ACCEPTED_TYPES = {
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.doc': 'application/msword'
};

// POST /tryit/upload-cag creates an isolated demo session; it never changes live FAQs.
router.post('/tryit/upload-cag', async (req, res) => {
  try {
    const { name, email, phone, consent, personId, clientId = 'grapelabs', fileName, mimeType, base64 } = req.body || {};
    if (!consent) return res.status(400).json({ success: false, error: 'Please accept the privacy policy terms.' });
    if ((!email || !isValidEmail(email)) && (!phone || !isValidPhone(phone))) {
      return res.status(400).json({ success: false, error: 'Please provide a valid work email or phone number.' });
    }
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
    if (Buffer.from(base64, 'base64').length > MAX_FILE_BYTES) {
      return res.status(413).json({ success: false, error: 'File must be 10 MB or smaller.' });
    }

    const config = await ConfigService.getConfig(clientId);
    const document = await generateFaqsFromFile({ fileName: fileName.slice(0, 160), mimeType, base64, config });
    if (!document.faqs?.length) throw new Error('No question and answer pairs could be generated from this document.');
    const result = await TryItService.startCagTryIt({
      name, email, phone, consent, personId, clientId, config,
      ip: req.socket.remoteAddress || '127.0.0.1',
      fileName: fileName.slice(0, 160),
      companyName: document.companyName,
      faqs: document.faqs
    });
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message || 'Could not prepare the document demo.' });
  }
});

// POST /tryit/start (Section 7.1)
router.post('/tryit/start', async (req, res) => {
  const {
    name,
    email,
    phone,
    websiteUrl,
    businessDescription,
    consent,
    personId,
    sessionId,
    clientId = 'grapelabs'
  } = req.body;

  try {
    const config = await ConfigService.getConfig(clientId);
    const ip = req.socket.remoteAddress || '127.0.0.1';

    let result;
    if (websiteUrl) {
      result = await TryItService.startTryIt({
        name,
        email,
        phone,
        websiteUrl,
        consent,
        ip,
        personId,
        sessionId,
        clientId,
        config
      });
    } else if (businessDescription) {
      result = await TryItService.startFallbackTryIt({
        name,
        email,
        phone,
        businessDescription,
        consent,
        ip,
        personId,
        config
      });
    } else {
      return res.status(400).json({ success: false, error: 'Please provide either a website URL or 3-line business description.' });
    }

    res.json({
      success: true,
      ...result
    });
  } catch (err) {
    res.status(400).json({
      success: false,
      error: err.message
    });
  }
});

// POST /tryit/chat (Demo mode interaction)
router.post('/tryit/chat', async (req, res) => {
  const { demoSessionId, message, clientId = 'grapelabs' } = req.body;

  if (!demoSessionId || !message) {
    return res.status(400).json({ success: false, error: 'Missing demoSessionId or message' });
  }

  try {
    const config = await ConfigService.getConfig(clientId);
    const result = await TryItService.chatDemo({
      demoSessionId,
      message,
      config
    });
    res.json({
      success: true,
      ...result
    });
  } catch (err) {
    res.status(400).json({
      success: false,
      error: err.message
    });
  }
});

module.exports = router;
