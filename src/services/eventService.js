const { EventRepository, PersonRepository } = require('../db/models');
const env = require('../config/env');

class EventService {
  /**
   * Dispatch an event to n8n webhook and Telegram alert
   * Guarantees that milestone alerts (lead_hot, booked, human_requested) fire once per person
   */
  static async emit(eventName, { personId, clientId = 'grapelabs', channel = 'web', payload = {} }) {
    // Check if single-fire event has already fired
    const onceEvents = ['lead_hot', 'booked', 'human_requested'];
    if (onceEvents.includes(eventName) && personId) {
      const alreadyFired = await EventRepository.hasFired(personId, eventName);
      if (alreadyFired) {
        console.log(`ℹ️ Event '${eventName}' already fired once for person ${personId}, skipping repeated alert.`);
        return null;
      }
    }

    // 1. Record event in Firebase
    const eventRecord = await EventRepository.record(eventName, {
      personId,
      clientId,
      channel,
      payload
    });

    const config = await require('./configService').getConfig(clientId).catch(() => ({}));
    const n8nWebhookUrl = config.alerts?.n8nWebhookUrl || env.N8N_WEBHOOK_URL;
    const telegramChatId = payload.telegramChatId || config.alerts?.telegramChatId || env.TELEGRAM_DEFAULT_CHAT_ID;

    console.log(`⚡ [EVENT DISPATCHED] ${eventName.toUpperCase()} (Person: ${personId || 'N/A'}, Channel: ${channel})`);

    // 2. Dispatch to n8n webhook if configured
    if (n8nWebhookUrl) {
      try {
        fetch(n8nWebhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            event: eventName,
            personId,
            clientId,
            channel,
            payload,
            timestamp: new Date().toISOString()
          })
        }).catch(err => console.warn('n8n webhook dispatch warning:', err.message));
      } catch (err) {
        console.warn('n8n webhook error:', err.message);
      }
    }

    // 3. Dispatch to Telegram if configured
    if (env.TELEGRAM_BOT_TOKEN && telegramChatId) {
      const chatId = telegramChatId;
      const message = this.formatTelegramMessage(eventName, payload, personId);
      if (message) {
        try {
          fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: chatId,
              text: message,
              parse_mode: 'HTML'
            })
          }).catch(err => console.warn('Telegram send warning:', err.message));
        } catch (err) {
          console.warn('Telegram send error:', err.message);
        }
      }
    }

    return eventRecord;
  }

  static formatTelegramMessage(eventName, payload, personId) {
    const person = payload.person || {};
    const fields = person.fields || {};
    const name = fields.name || payload.name || 'Anonymous';
    const email = person.identifiers?.email || payload.email || 'N/A';
    const phone = person.identifiers?.phone || payload.phone || 'N/A';
    const industry = fields.industry || 'Not specified';
    const score = person.score || payload.score || 0;

    switch (eventName) {
      case 'lead_hot':
        return `🔥 <b>HOT LEAD ALERT (Score: ${score}/100)</b>\n\n` +
          `👤 <b>Name:</b> ${name}\n` +
          `📧 <b>Email:</b> ${email}\n` +
          `📱 <b>Phone:</b> ${phone}\n` +
          `🏢 <b>Industry:</b> ${industry}\n` +
          `⚡ <b>Pains:</b> ${fields.pains || 'High intent interaction'}\n` +
          `🆔 <code>${personId}</code>`;

      case 'booked':
        return `📅 <b>CALL BOOKED WITH PROSPECT!</b>\n\n` +
          `👤 <b>Name:</b> ${name}\n` +
          `📧 <b>Email:</b> ${email}\n` +
          `📱 <b>Phone:</b> ${phone}\n` +
          `🏢 <b>Business:</b> ${industry}\n` +
          `⏰ <b>Slot:</b> ${payload.bookedSlot || 'Confirmed on Calendly'}\n\n` +
          `📋 <b>Pre-Call Brief:</b>\n${payload.brief ? JSON.stringify(payload.brief, null, 2) : 'Generated & saved to Leads'}`;

      case 'human_requested':
        return `🙋‍♂️ <b>HUMAN AGENT REQUESTED</b>\n\n` +
          `👤 <b>Name:</b> ${name}\n` +
          `📧 <b>Email:</b> ${email}\n` +
          `📱 <b>Phone:</b> ${phone}\n` +
          `💬 <b>Query:</b> "${payload.lastMessage || 'Requested a human'}"\n` +
          `🔗 <b>Channel:</b> ${payload.channel || 'Web'}`;

      case 'lead_identified':
        return `✨ <b>New Lead Identified</b>: ${name} (${email || phone})`;

      case 'profiles_merged':
        return `🔗 <b>Profiles Merged</b>: Linked ${payload.sourcePersonId} into primary ${personId}`;

      default:
        return null;
    }
  }
}

module.exports = EventService;
