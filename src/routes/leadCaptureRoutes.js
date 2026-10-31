const express = require('express');
const router = express.Router();
const ConfigService = require('../services/configService');
const LeadCaptureService = require('../services/leadCaptureService');
const LeadService = require('../services/leadService');
const EventService = require('../services/eventService');
const IdentityService = require('../services/identityService');
const { PersonRepository, SessionRepository, MessageRepository } = require('../db/models');
const { saveLeadResourceFile, openLeadResourceFile } = require('../db/firebase');

const MAX_UPLOAD_BYTES = 3 * 1024 * 1024; // keeps base64 JSON under hosting body limits (e.g. Vercel 4.5 MB)
const ALLOWED_UPLOAD_TYPES = /\.(pdf|docx?|pptx?|xlsx?|csv|txt|png|jpe?g|webp|zip)$/i;

async function resolvePerson({ clientId, personId, sessionId }) {
  let person = null;
  if (typeof personId === 'string' && personId) person = await PersonRepository.get(personId);
  if (!person && typeof sessionId === 'string' && sessionId) person = await PersonRepository.findByIdentifier({ sessionId });
  if (person && person.clientId && person.clientId !== clientId) return null;
  return person;
}

/**
 * POST /api/leads/capture
 * Body: { clientId, personId, sessionId, answers: { [questionId]: value }, resourceId?, skipped? }
 * Saves answers from the widget's lead form / one-by-one questions. Partial answers are allowed.
 * With resourceId, returns the attachment once every required question for that resource is answered.
 */
router.post('/api/leads/capture', async (req, res) => {
  try {
    const { clientId = 'grapelabs', personId, sessionId, answers = {}, resourceId = null, skipped = false } = req.body || {};
    const config = await ConfigService.getConfig(clientId);
    const settings = LeadCaptureService.settings(config);
    let person = await resolvePerson({ clientId, personId, sessionId });
    if (!person) return res.status(404).json({ success: false, error: 'Conversation not found. Send a message first.' });

    if (skipped) {
      if (sessionId) await SessionRepository.createOrUpdate(sessionId, { leadCaptureSkippedAt: new Date().toISOString() });
      await EventService.emit('lead_capture_skipped', { personId: person.id, clientId, channel: 'web', payload: { resourceId } }).catch(() => {});
      return res.json({ success: true, skipped: true });
    }
    if (!answers || typeof answers !== 'object' || Array.isArray(answers)) {
      return res.status(400).json({ success: false, error: 'answers must be an object.' });
    }

    const { patch, errors, saved } = LeadCaptureService.buildAnswerPatch({ settings, person, answers });
    if (Object.keys(errors).length) return res.status(400).json({ success: false, errors });

    const hadContact = !!(person.identifiers?.email || person.identifiers?.phone);
    if (Object.keys(patch).length) {
      patch.leadCapture = { ...(person.leadCapture || {}), awaiting: null, lastAnsweredAt: new Date().toISOString() };
      person = await PersonRepository.update(person.id, patch);
      await LeadCaptureService.ensureLeadColumns(clientId, saved
        .filter(item => item.question.field === 'custom')
        .map(item => ({ id: LeadCaptureService.customColumnId(item.question), label: (item.question.label || item.question.question).slice(0, 40) })));
      await MessageRepository.add({
        personId: person.id,
        sessionId,
        channel: 'web',
        role: 'user',
        text: `[Shared via lead form] ${saved.map(item => `${item.question.label || item.question.field}: ${item.value}`).join(', ')}`,
        intent: 'lead_capture'
      });
    }

    // Link to an existing record only on an exact email/phone match.
    const matched = await PersonRepository.findByIdentifier({ email: person.identifiers?.email || null, phone: person.identifiers?.phone || null });
    if (matched && matched.id !== person.id) person = await IdentityService.mergeProfiles(matched.id, person.id) || person;

    const gotContact = !hadContact && !!(person.identifiers?.email || person.identifiers?.phone);
    const session = sessionId ? await SessionRepository.get(sessionId) : null;
    person = await LeadService.evaluateLead({
      person,
      newSignals: gotContact ? ['contact_details_given'] : [],
      messageCount: session?.messageCount || 1,
      config
    });
    if (gotContact && !person.leadContactNotified) {
      person = await PersonRepository.update(person.id, { leadContactNotified: true });
      await EventService.emit('lead_contact_captured', { personId: person.id, clientId, channel: 'web', payload: { person, source: resourceId ? 'gated_resource' : 'lead_form' } });
    }

    const firstName = String(person.fields?.name || '').trim().split(/\s+/)[0];
    const thankYou = String(settings.thankYouMessage || 'Thanks! Your details are saved.').replace(/\{name\}/g, firstName ? `, ${firstName}` : '');
    const response = { success: true, complete: true, thankYou, person: { id: person.id, name: person.fields?.name || null, stage: person.stage } };

    if (resourceId) {
      const resource = LeadCaptureService.matchResource({ config, resourceId });
      if (!resource) return res.status(404).json({ success: false, error: 'This resource is no longer available.' });
      const remaining = LeadCaptureService.resourceRequirements(settings, resource, person);
      if (remaining.length) {
        return res.json({ ...response, complete: false, remaining: remaining.map(({ enabled, ...question }) => question) });
      }
      const unlocked = Array.from(new Set([...(person.resourcesUnlocked || []), resource.title]));
      person = await PersonRepository.update(person.id, { resourcesUnlocked: unlocked, 'customFields.lc_resources': unlocked.join(', ') });
      await LeadCaptureService.ensureLeadColumns(clientId, [{ id: 'lc_resources', label: 'Resources unlocked' }]);
      await EventService.emit('resource_unlocked', { personId: person.id, clientId, channel: 'web', payload: { resourceId: resource.id, title: resource.title, person } });
      response.attachment = LeadCaptureService.attachmentFor({ clientId, personId: person.id, resource });
    }
    res.json(response);
  } catch (error) {
    console.error('Lead capture error:', error);
    res.status(500).json({ success: false, error: 'Could not save your details. Please try again.' });
  }
});

// GET /api/lead-capture/resources/:resourceId/download?token=...  (signed, expiring link)
router.get('/api/lead-capture/resources/:resourceId/download', async (req, res) => {
  try {
    const verified = LeadCaptureService.verifyDownloadToken(req.query.token, req.params.resourceId);
    if (!verified) return res.status(403).type('text/plain').send('This download link is invalid or has expired. Ask the chat assistant for the file again.');
    const config = await ConfigService.getConfig(verified.clientId);
    const resource = LeadCaptureService.settings(config).resources.find(item => item.id === req.params.resourceId && item.enabled !== false);
    if (!resource) return res.status(404).type('text/plain').send('This resource is no longer available.');
    EventService.emit('resource_downloaded', { personId: verified.personId, clientId: verified.clientId, channel: 'web', payload: { resourceId: resource.id, title: resource.title } }).catch(() => {});

    if (resource.source === 'link') {
      if (!/^https?:\/\//i.test(resource.linkUrl || '')) return res.status(404).type('text/plain').send('This resource link is not configured.');
      return res.redirect(302, resource.linkUrl);
    }
    const file = resource.file;
    if (!file?.path) return res.status(404).type('text/plain').send('This resource file is missing.');
    const stream = openLeadResourceFile(file);
    res.setHeader('Content-Type', file.contentType || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${String(file.fileName || 'download').replace(/["\r\n]/g, '')}"`);
    res.setHeader('Cache-Control', 'private, no-store');
    stream.on('error', () => { if (!res.headersSent) res.status(404); res.end(); });
    stream.pipe(res);
  } catch (error) {
    res.status(404).type('text/plain').send('This resource file is missing.');
  }
});

// Control panel: full lead capture settings (including resource links, which the public config hides)
router.get('/api/lead-capture/admin', async (req, res) => {
  try {
    const config = await ConfigService.getConfig(req.query.clientId || 'grapelabs');
    const source = config.draft?.leadCapture || config.leadCapture;
    res.json({ success: true, leadCapture: LeadCaptureService.settings({ leadCapture: source }), isDraft: !!config.draft?.leadCapture });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Control panel: upload a private resource file (base64 JSON, max 3 MB)
router.post('/api/lead-capture/upload', async (req, res) => {
  try {
    const { clientId = 'grapelabs', fileName, mimeType, base64 } = req.body || {};
    if (typeof fileName !== 'string' || !ALLOWED_UPLOAD_TYPES.test(fileName)) {
      return res.status(400).json({ success: false, error: 'Upload a PDF, Word, PowerPoint, Excel, CSV, text, image, or ZIP file.' });
    }
    if (typeof base64 !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
      return res.status(400).json({ success: false, error: 'The file could not be read.' });
    }
    const buffer = Buffer.from(base64, 'base64');
    if (!buffer.length) return res.status(400).json({ success: false, error: 'The file is empty.' });
    if (buffer.length > MAX_UPLOAD_BYTES) {
      return res.status(413).json({ success: false, error: 'Files can be up to 3 MB. For larger files, host them (e.g. Google Drive) and use a link instead.' });
    }
    const file = await saveLeadResourceFile(clientId, {
      buffer,
      contentType: typeof mimeType === 'string' && mimeType ? mimeType.slice(0, 120) : 'application/octet-stream',
      fileName: fileName.replace(/[\\/\r\n"]/g, '_').slice(0, 160)
    });
    res.json({ success: true, file });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message || 'Could not upload the file.' });
  }
});

module.exports = router;
