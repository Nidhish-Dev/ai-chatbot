const express = require('express');
const router = express.Router();
const EventService = require('../services/eventService');
const LeadService = require('../services/leadService');
const ConfigService = require('../services/configService');
const { MessageRepository } = require('../db/models');
const RecommendationService = require('../services/recommendationService');

// POST /event (Section 7.1)
router.post('/event', async (req, res) => {
  const {
    event,
    personId,
    clientId = 'grapelabs',
    channel = 'web',
    payload = {}
  } = req.body;

  if (!event) {
    return res.status(400).json({ success: false, error: 'Event name is required' });
  }

  try {
    const config = await ConfigService.getConfig(clientId);

    // If booking event (e.g. from Calendly inline embed 'event_scheduled')
    if (event === 'booked') {
      const messages = personId ? await MessageRepository.getByPerson(personId, 30) : [];
      const updatedPerson = await LeadService.handleBooking({
        personId,
        slot: payload.slot || payload.event_start_time || new Date().toISOString(),
        rawBookingData: payload,
        messages,
        config
      });

      return res.json({
        success: true,
        message: 'Booking recorded and pre-call brief generated',
        person: updatedPerson
      });
    }

    // Visitor tapped "Continue on WhatsApp": remember the handover on the lead.
    if (event === 'handover_whatsapp_clicked' && personId) {
      const { PersonRepository } = require('../db/models');
      await PersonRepository.update(personId, {
        handover: { channel: 'whatsapp', reason: String(payload.reason || 'requested').slice(0, 30), at: new Date().toISOString() },
        'customFields.lc_handover': `WhatsApp · ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`
      }).catch(() => {});
      await require('../services/leadCaptureService').ensureLeadColumns(clientId, [{ id: 'lc_handover', label: 'Handed over' }]).catch(() => {});
    }

    // Product interactions feed personalised recommendations.
    if (['product_viewed', 'product_cta_clicked'].includes(event) && personId && payload.productId) {
      await RecommendationService.recordInteraction(personId, String(payload.productId), event === 'product_cta_clicked' ? 'cta_clicked' : 'viewed');
    }

    // Generic event dispatch
    const record = await EventService.emit(event, {
      personId,
      clientId,
      channel,
      payload
    });

    res.json({
      success: true,
      event: record
    });
  } catch (err) {
    console.error('Error handling event:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
