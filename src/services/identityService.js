const { PersonRepository, TokenRepository, MessageRepository } = require('../db/models');
const { verifySignedToken, extractRefCode, generateRefCode } = require('../utils/tokenUtils');
const EventService = require('./eventService');

const STAGE_ORDER = ['Anonymous', 'Engaged', 'Identified', 'Qualified', 'Hot', 'Booked'];

class IdentityService {
  /**
   * Resolve person profile for an incoming message
   */
  static async resolvePerson({ clientId = 'grapelabs', channel = 'web', channelUserId, sessionId, linkToken, text, email, phone }) {
    let person = null;

    // 1. Check signed link token (?gl=...)
    if (linkToken) {
      const tokenPersonId = verifySignedToken(linkToken);
      if (tokenPersonId) {
        person = await PersonRepository.get(tokenPersonId);
        if (person && sessionId && !person.identifiers.sessionIds.includes(sessionId)) {
          person.identifiers.sessionIds.push(sessionId);
          await PersonRepository.update(person.id, {
            'identifiers.sessionIds': person.identifiers.sessionIds
          });
          console.log(`🔗 Linked website session ${sessionId} to existing person ${person.id} via signed link token`);
        }
      }
    }

    // 2. Check inbound message for WhatsApp / Instagram ref code (e.g. "Hi GrapeLabs (ref X7K2)")
    if (!person && text) {
      const refCode = extractRefCode(text);
      if (refCode) {
        const refPersonId = await TokenRepository.resolveRefCode(refCode);
        if (refPersonId) {
          person = await PersonRepository.get(refPersonId);
          console.log(`🔗 Resolved person ${refPersonId} via reference code ${refCode}`);
        }
      }
    }

    // 3. Exact match by Phone, Email, SessionId, or Instagram ID
    if (!person) {
      person = await PersonRepository.findByIdentifier({
        phone: channel === 'whatsapp' ? channelUserId : phone,
        email,
        sessionId,
        instagramId: channel === 'instagram' ? channelUserId : null
      });
    }

    // 4. Create new person if none found
    if (!person) {
      const newPersonData = {
        clientId,
        channel,
        sessionId,
        phone: channel === 'whatsapp' ? channelUserId : (phone || null),
        email: email || null,
        instagramId: channel === 'instagram' ? channelUserId : null,
        stage: 'Anonymous'
      };
      person = await PersonRepository.create(newPersonData);
      console.log(`👤 Created new person profile: ${person.id} on channel: ${channel}`);
    } else {
      // Ensure channel is added to channelsUsed
      const channelsUsed = new Set(person.channelsUsed || []);
      channelsUsed.add(channel);
      
      const patch = {
        channelsUsed: Array.from(channelsUsed)
      };

      // Ensure session ID is registered
      if (sessionId && !person.identifiers.sessionIds.includes(sessionId)) {
        patch['identifiers.sessionIds'] = [...person.identifiers.sessionIds, sessionId];
      }

      // Record phone or email if newly provided
      if (phone && !person.identifiers.phone) {
        patch['identifiers.phone'] = phone;
      }
      if (email && !person.identifiers.email) {
        patch['identifiers.email'] = email.toLowerCase().trim();
      }

      person = await PersonRepository.update(person.id, patch);
    }

    return person;
  }

  /**
   * Merge two person profiles when an exact email or phone match links them
   * Section 15.3: combines messages, score signals, consent, highest stage wins, one Leads row remains.
   */
  static async mergeProfiles(primaryPersonId, secondaryPersonId) {
    if (!primaryPersonId || !secondaryPersonId || primaryPersonId === secondaryPersonId) {
      return null;
    }

    const primary = await PersonRepository.get(primaryPersonId);
    const secondary = await PersonRepository.get(secondaryPersonId);

    if (!primary || !secondary) return primary || secondary;

    console.log(`🔀 Merging secondary profile ${secondaryPersonId} into primary ${primaryPersonId}`);

    // Combined channels and session IDs
    const mergedChannels = Array.from(new Set([...(primary.channelsUsed || []), ...(secondary.channelsUsed || [])]));
    const mergedSessionIds = Array.from(new Set([...(primary.identifiers.sessionIds || []), ...(secondary.identifiers.sessionIds || [])]));

    // Combined score signals
    const mergedSignals = Array.from(new Set([...(primary.scoreSignals || []), ...(secondary.scoreSignals || [])]));
    const maxScore = Math.max(primary.score || 0, secondary.score || 0);

    // Highest stage wins
    const primaryStageIdx = STAGE_ORDER.indexOf(primary.stage || 'Anonymous');
    const secondaryStageIdx = STAGE_ORDER.indexOf(secondary.stage || 'Anonymous');
    const winningStage = secondaryStageIdx > primaryStageIdx ? secondary.stage : primary.stage;

    // Merged fields (fill blanks)
    const mergedFields = {
      name: primary.fields.name || secondary.fields.name,
      company: primary.fields.company || secondary.fields.company,
      website: primary.fields.website || secondary.fields.website,
      industry: primary.fields.industry || secondary.fields.industry,
      teamSize: primary.fields.teamSize || secondary.fields.teamSize,
      pains: [primary.fields.pains, secondary.fields.pains].filter(Boolean).join('; ') || null,
      productsRecommended: Array.from(new Set([...(primary.fields.productsRecommended || []), ...(secondary.fields.productsRecommended || [])])),
      notes: primary.fields.notes || secondary.fields.notes
    };

    // Merged consent
    const mergedConsent = {
      service: primary.consentFlags.service || secondary.consentFlags.service,
      marketing: primary.consentFlags.marketing || secondary.consentFlags.marketing,
      channels: {
        whatsapp: primary.consentFlags.channels?.whatsapp || secondary.consentFlags.channels?.whatsapp || false,
        email: primary.consentFlags.channels?.email || secondary.consentFlags.channels?.email || false,
        instagram: primary.consentFlags.channels?.instagram || secondary.consentFlags.channels?.instagram || false
      }
    };

    // Update primary
    const updatedPrimary = await PersonRepository.update(primaryPersonId, {
      'identifiers.sessionIds': mergedSessionIds,
      'identifiers.phone': primary.identifiers.phone || secondary.identifiers.phone,
      'identifiers.email': primary.identifiers.email || secondary.identifiers.email,
      'identifiers.instagramId': primary.identifiers.instagramId || secondary.identifiers.instagramId,
      'identifiers.instagramHandle': primary.identifiers.instagramHandle || secondary.identifiers.instagramHandle,
      channelsUsed: mergedChannels,
      score: maxScore,
      scoreSignals: mergedSignals,
      stage: winningStage,
      fields: mergedFields,
      tryItProfile: primary.tryItProfile || secondary.tryItProfile,
      bookedSlot: primary.bookedSlot || secondary.bookedSlot,
      brief: primary.brief || secondary.brief,
      consentFlags: mergedConsent
    });

    await PersonRepository.movePersonMessages(secondaryPersonId, primaryPersonId);
    await PersonRepository.movePersonSessions(secondaryPersonId, primaryPersonId);

    // Delete secondary to eliminate duplicate row in Leads tab
    await PersonRepository.delete(secondaryPersonId);

    // Fire profiles_merged event
    await EventService.emit('profiles_merged', {
      personId: primaryPersonId,
      clientId: primary.clientId,
      channel: 'system',
      payload: {
        primaryPersonId,
        sourcePersonId: secondaryPersonId
      }
    });

    return updatedPrimary;
  }

  /**
   * Create a reference code for moving from Web to WhatsApp / Instagram
   */
  static async createChannelHandshake(personId, targetChannel = 'whatsapp') {
    const refCode = generateRefCode(4);
    await TokenRepository.saveRefCode(refCode, { personId, channel: targetChannel });
    return refCode;
  }
}

module.exports = IdentityService;
