const { PersonRepository } = require('../db/models');
const EventService = require('./eventService');
const { generatePreCallBrief } = require('../ai/briefGenerator');

const STAGE_ORDER = ['Anonymous', 'Engaged', 'Identified', 'Qualified', 'Hot', 'Booked'];

class LeadService {
  /**
   * Recalculate lead score and stage based on signals and state
   */
  static async evaluateLead({ person, newSignals = [], messageCount = 1, config }) {
    const scoringConfig = config.scoring || {};
    const signalWeights = scoringConfig.signals || {
      describes_business: 15,
      industry_known: 10,
      team_size_known: 5,
      specific_pain: 20,
      pricing_timeline_process: 15,
      contact_details_given: 15,
      used_try_it: 15,
      clicks_book_call: 10
    };
    const hotThreshold = scoringConfig.hotThreshold || 70;

    // Combine existing and new unique signals
    const allSignals = Array.from(new Set([...(person.scoreSignals || []), ...newSignals]));
    
    // Calculate total score
    let calculatedScore = 0;
    for (const signal of allSignals) {
      if (signalWeights[signal]) {
        calculatedScore += signalWeights[signal];
      }
    }
    // Cap score at 100
    calculatedScore = Math.min(100, calculatedScore);

    // Determine Stage
    let currentStage = person.stage || 'Anonymous';
    let newStage = currentStage;

    const hasContact = !!(person.identifiers?.email || person.identifiers?.phone || person.firstChannel === 'whatsapp');
    const hasIndustry = !!person.fields?.industry;
    const hasPain = !!person.fields?.pains;
    const isBooked = !!person.bookedSlot;

    if (isBooked) {
      newStage = 'Booked';
      calculatedScore = Math.max(calculatedScore, hotThreshold); // Booking makes Hot automatically
    } else if (calculatedScore >= hotThreshold) {
      newStage = 'Hot';
    } else if (hasIndustry && hasPain) {
      newStage = 'Qualified';
    } else if (hasContact) {
      newStage = 'Identified';
    } else if (messageCount >= 3) {
      newStage = 'Engaged';
    }

    // Ensure stage never downgrades in the hierarchy
    const oldStageIndex = STAGE_ORDER.indexOf(currentStage);
    const newStageIndex = STAGE_ORDER.indexOf(newStage);
    const finalStage = newStageIndex > oldStageIndex ? newStage : currentStage;

    const stageChanged = finalStage !== currentStage;
    const crossedHot = calculatedScore >= hotThreshold && person.score < hotThreshold;

    // Update person in Firebase
    const updatedPerson = await PersonRepository.update(person.id, {
      score: calculatedScore,
      scoreSignals: allSignals,
      stage: finalStage
    });

    // Fire milestone events
    if (stageChanged && finalStage === 'Identified') {
      await EventService.emit('lead_identified', {
        personId: person.id,
        clientId: person.clientId,
        channel: person.channelsUsed?.[0] || 'web',
        payload: { person: updatedPerson }
      });
    }

    if (crossedHot || (stageChanged && finalStage === 'Hot')) {
      await EventService.emit('lead_hot', {
        personId: person.id,
        clientId: person.clientId,
        channel: person.channelsUsed?.[0] || 'web',
        payload: { person: updatedPerson, score: calculatedScore }
      });
    }

    return updatedPerson;
  }

  /**
   * Process booking event for a person
   */
  static async handleBooking({ personId, slot, rawBookingData = {}, messages = [], config }) {
    const person = await PersonRepository.get(personId);
    if (!person) throw new Error(`Person not found: ${personId}`);
    if (person.bookedSlot) return person;

    // Generate pre-call brief using AI
    const brief = await generatePreCallBrief({ person, messages, config });

    // Update person
    const updated = await PersonRepository.update(personId, {
      bookedSlot: slot || new Date().toISOString(),
      stage: 'Booked',
      score: 100,
      brief
    });

    // Fire 'booked' event (fires once, triggers brief generation, Telegram alert, email)
    await EventService.emit('booked', {
      personId,
      clientId: person.clientId,
      channel: person.channelsUsed?.[0] || 'web',
      payload: {
        person: updated,
        bookedSlot: slot,
        brief,
        rawBookingData
      }
    });

    return updated;
  }
}

module.exports = LeadService;
