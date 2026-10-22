const express = require('express');
const router = express.Router();
const EventService = require('../services/eventService');
const LeadService = require('../services/leadService');
const ConfigService = require('../services/configService');
const { MessageRepository } = require('../db/models');

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
