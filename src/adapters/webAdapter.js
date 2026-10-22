const ChatService = require('../services/chatService');
const IdentityService = require('../services/identityService');
const ConfigService = require('../services/configService');
const EventService = require('../services/eventService');

class WebAdapter {
  /**
   * Handle web message with optional Server-Sent Events (SSE) streaming
   */
  static async handleWebMessage(req, res) {
    const {
      clientId = 'grapelabs',
      sessionId,
      personId,
      message,
      buttonPayload,
      linkToken,
      stream = true,
      metadata = {}
    } = req.body;

    try {
      // Execute shared chat core
      const result = await ChatService.handleIncomingMessage({
        clientId,
        channel: 'web',
        channelUserId: sessionId,
        personId,
        sessionId,
        message,
        buttonPayload,
        linkToken,
        metadata
      });

      // Stream words via SSE if client requested streaming
      if (stream && req.headers.accept && req.headers.accept.includes('text/event-stream')) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');

        const words = result.reply.split(' ');
        for (let i = 0; i < words.length; i++) {
          const chunk = words[i] + (i < words.length - 1 ? ' ' : '');
          res.write(`data: ${JSON.stringify({ type: 'delta', text: chunk })}\n\n`);
          // simulate natural 25ms word streaming cadence
          await new Promise(r => setTimeout(r, 20));
        }

        // Send final payload with buttons, cards, intent, person details
        res.write(`data: ${JSON.stringify({
          type: 'done',
          reply: result.reply,
          buttons: result.buttons,
          cards: result.cards,
          intent: result.intent,
          person: result.person
        })}\n\n`);
        return res.end();
      }

      // Default JSON response
      return res.json({
        success: true,
        ...result
      });
    } catch (err) {
      console.error('WebAdapter Error:', err);
      await EventService.emit('error', { clientId, channel: 'web', payload: { message: err.message, path: req.path } }).catch(() => {});
      return res.status(500).json({
        success: false,
        error: err.message,
        reply: "Sorry, I ran into an issue processing that. Please try again or reach out to team@grapelabs.in.",
        buttons: ["Try again", "Book a call"]
      });
    }
  }

  /**
   * Generate handshake link for "Continue on WhatsApp" with prefilled ref code
   */
  static async getWhatsAppHandshake(personId, clientId = 'grapelabs') {
    const config = await ConfigService.getConfig(clientId);
    const refCode = await IdentityService.createChannelHandshake(personId, 'whatsapp');
    const phoneNumber = config.links?.whatsappRefNumber || '+919876543210';
    const cleanPhone = phoneNumber.replace(/[^0-9]/g, '');
    const prefilledText = encodeURIComponent(`Hi GrapeLabs (ref ${refCode})`);
    const whatsappUrl = `https://wa.me/${cleanPhone}?text=${prefilledText}`;

    return {
      refCode,
      whatsappUrl
    };
  }
}

module.exports = WebAdapter;
