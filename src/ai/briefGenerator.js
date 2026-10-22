const { callAI } = require('./openaiService');

/**
 * Generate comprehensive pre-call sales brief from omnichannel person profile and messages
 */
async function generatePreCallBrief({ person, messages = [], config }) {
  const fields = person.fields || {};
  const channels = (person.channelsUsed || []).join(', ');
  const historyText = messages
    .map(m => `[${m.channel || 'web'}] ${m.role === 'user' ? 'Visitor' : 'Bot'}: ${m.text}`)
    .join('\n');

  const systemPrompt = `You are an elite B2B sales strategist for GrapeLabs.
Generate a structured, actionable pre-call brief for our sales team before an upcoming discovery call with a prospect.
Be punchy, direct, and zero fluff.
Respond strictly in JSON format:
{
  "whoTheyAre": "Prospect name, company, and contact coordinates",
  "businessAndIndustry": "Summary of their business model and vertical",
  "teamSize": "Team size if known",
  "painsInTheirWords": "Exact manual bottlenecks and frustrations mentioned by the prospect",
  "channelsUsed": "List of channels they contacted us through",
  "productsToPitch": ["Specific GrapeLabs automation 1", "Specific GrapeLabs automation 2"],
  "tryItSummary": "Key takeaways if they tested their website, or 'Not used'",
  "suggestedOpeningQuestion": "A hyper-specific, high-rapport opening question for the sales rep to break the ice and dive into the pain."
}`;

  const promptInput = `PROSPECT DETAILS:
Name: ${fields.name || 'Anonymous Prospect'}
Email: ${person.identifiers?.email || 'Not provided'}
Phone: ${person.identifiers?.phone || 'Not provided'}
Company: ${fields.company || 'Not specified'}
Industry: ${fields.industry || 'Not specified'}
Team Size: ${fields.teamSize || 'Not specified'}
Stated Pains: ${fields.pains || 'Discussed in chat'}
Channels Used: ${channels}
Try-It Summary: ${person.tryItProfile ? JSON.stringify(person.tryItProfile.whatTheySell) : 'Did not use Try-It'}

OMNICHANNEL CHAT HISTORY:
${historyText.slice(0, 8000) || 'Direct booking.'}`;

  try {
    const aiResult = await callAI({
      messages: [{ role: 'user', content: promptInput }],
      systemPrompt,
      config,
      personContext: fields
    });

    if (aiResult.extracted && aiResult.extracted.whoTheyAre) {
      return aiResult.extracted;
    }
  } catch (err) {
    console.warn('⚠️ Error generating AI brief, falling back to structured synthesis:', err.message);
  }

  // Fallback structured brief
  return {
    whoTheyAre: `${fields.name || 'Prospect'} (${person.identifiers?.email || person.identifiers?.phone || 'Website visitor'})`,
    businessAndIndustry: fields.industry || 'General Business Operations',
    teamSize: fields.teamSize || 'Unknown',
    painsInTheirWords: fields.pains || 'Repetitive operational tasks and manual follow-ups',
    channelsUsed: channels || 'Web',
    productsToPitch: fields.productsRecommended?.length > 0 ? fields.productsRecommended : ['Omnichannel Cart Recovery & WhatsApp Concierge', 'Smart Lead Scoring & Instant Booking Bot'],
    tryItSummary: person.tryItProfile ? `${person.tryItProfile.businessName} - ${person.tryItProfile.whatTheySell}` : 'Did not test website',
    suggestedOpeningQuestion: `Hey ${fields.name ? fields.name.split(' ')[0] : 'there'}, thanks for jumping on. I saw you were looking into automating ${fields.pains || 'your daily workflows'}—what's taking up the most hours of your week right now?`
  };
}

module.exports = {
  generatePreCallBrief
};
