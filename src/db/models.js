const { getDb } = require('./firebase');

const COLLECTIONS = {
  CLIENTS: 'clients',
  PEOPLE: 'people',
  SESSIONS: 'sessions',
  MESSAGES: 'messages',
  EVENTS: 'events',
  TOKENS: 'tokens'
};

function timestampMillis(value) {
  if (value && typeof value.toMillis === 'function') return value.toMillis();
  const millis = new Date(value || 0).getTime();
  return Number.isFinite(millis) ? millis : 0;
}

class ClientRepository {
  static async get(clientId) {
    const db = getDb();
    const doc = await db.collection(COLLECTIONS.CLIENTS).doc(clientId).get();
    return doc.exists ? doc.data() : null;
  }

  static async set(clientId, data) {
    const db = getDb();
    await db.collection(COLLECTIONS.CLIENTS).doc(clientId).set(data, { merge: true });
    return data;
  }
}

class PersonRepository {
  static async get(personId) {
    const db = getDb();
    const doc = await db.collection(COLLECTIONS.PEOPLE).doc(personId).get();
    return doc.exists ? doc.data() : null;
  }

  static async create(personData) {
    const db = getDb();
    const personId = personData.id || 'person_' + Math.random().toString(36).substring(2, 10);
    const record = {
      id: personId,
      clientId: personData.clientId || 'grapelabs',
      identifiers: {
        sessionIds: personData.sessionId ? [personData.sessionId] : [],
        phone: personData.phone || null,
        email: personData.email || null,
        instagramId: personData.instagramId || null,
        instagramHandle: personData.instagramHandle || null
      },
      channelsUsed: personData.channel ? [personData.channel] : ['web'],
      firstChannel: personData.channel || 'web',
      score: personData.score || 0,
      scoreSignals: personData.scoreSignals || [],
      stage: personData.stage || 'Anonymous', // Anonymous, Engaged, Identified, Qualified, Hot, Booked
      fields: {
        name: personData.name || null,
        company: personData.company || null,
        website: personData.website || null,
        industry: personData.industry || null,
        teamSize: personData.teamSize || null,
        pains: personData.pains || null,
        productsRecommended: personData.productsRecommended || [],
        notes: personData.notes || null
      },
      utm: personData.utm || {},
      pagesVisited: personData.page ? [personData.page] : [],
      tryItUsed: false,
      tryItProfile: null,
      bookedSlot: null,
      brief: null,
      consentFlags: {
        service: true,
        marketing: personData.marketingConsent || false,
        channels: {
          whatsapp: false,
          email: false,
          instagram: false
        }
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    await db.collection(COLLECTIONS.PEOPLE).doc(personId).set(record);
    return record;
  }

  static async update(personId, patch) {
    const db = getDb();
    const ref = db.collection(COLLECTIONS.PEOPLE).doc(personId);
    await ref.update(patch);
    const updated = await ref.get();
    return updated.data();
  }

  static async findByIdentifier({ phone, email, sessionId, instagramId }) {
    const db = getDb();
    const col = db.collection(COLLECTIONS.PEOPLE);

    if (email) {
      const snap = await col.where('identifiers.email', '==', email.toLowerCase().trim()).limit(1).get();
      if (!snap.empty) return snap.docs[0].data();
    }
    if (phone) {
      const snap = await col.where('identifiers.phone', '==', phone.trim()).limit(1).get();
      if (!snap.empty) return snap.docs[0].data();
    }
    if (instagramId) {
      const snap = await col.where('identifiers.instagramId', '==', instagramId).limit(1).get();
      if (!snap.empty) return snap.docs[0].data();
    }
    if (sessionId) {
      const snap = await col.where('identifiers.sessionIds', 'array-contains', sessionId).limit(1).get();
      if (!snap.empty) return snap.docs[0].data();
    }
    return null;
  }

  static async delete(personId) {
    const db = getDb();
    await db.collection(COLLECTIONS.PEOPLE).doc(personId).delete();
  }

  static async movePersonMessages(sourcePersonId, targetPersonId) {
    const db = getDb();
    const snap = await db.collection(COLLECTIONS.MESSAGES).where('personId', '==', sourcePersonId).get();
    for (const doc of snap.docs) await db.collection(COLLECTIONS.MESSAGES).doc(doc.id).update({ personId: targetPersonId });
    return snap.size;
  }

  static async movePersonSessions(sourcePersonId, targetPersonId) {
    const db = getDb();
    const snap = await db.collection(COLLECTIONS.SESSIONS).where('personId', '==', sourcePersonId).get();
    for (const doc of snap.docs) await db.collection(COLLECTIONS.SESSIONS).doc(doc.id).update({ personId: targetPersonId });
    return snap.size;
  }
}

class SessionRepository {
  static async get(sessionId) {
    const db = getDb();
    const doc = await db.collection(COLLECTIONS.SESSIONS).doc(sessionId).get();
    return doc.exists ? doc.data() : null;
  }

  static async createOrUpdate(sessionId, data) {
    const db = getDb();
    const ref = db.collection(COLLECTIONS.SESSIONS).doc(sessionId);
    const existing = await ref.get();
    if (existing.exists) {
      await ref.update({
        ...data,
        updatedAt: new Date().toISOString()
      });
      return { ...existing.data(), ...data };
    } else {
      const newRecord = {
        id: sessionId,
        messageCount: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        ...data
      };
      await ref.set(newRecord);
      return newRecord;
    }
  }

  static async delete(sessionId) {
    const db = getDb();
    await db.collection(COLLECTIONS.SESSIONS).doc(sessionId).delete();
  }

  static async incrementMessageCount(sessionId) {
    const db = getDb();
    const ref = db.collection(COLLECTIONS.SESSIONS).doc(sessionId);
    const existing = await ref.get();
    if (existing.exists) {
      const current = existing.data().messageCount || 0;
      await ref.update({ messageCount: current + 1 });
      return current + 1;
    }
    return 1;
  }
}

class MessageRepository {
  static async add({ personId, sessionId, channel, role, text, intent, buttons, cards, extracted, scoreSignals }) {
    const db = getDb();
    const id = 'msg_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6);
    const record = {
      id,
      personId,
      sessionId: sessionId || null,
      channel: channel || 'web',
      role, // 'user' or 'assistant'
      text,
      intent: intent || null,
      buttons: buttons || [],
      cards: cards || [],
      extracted: extracted || {},
      scoreSignals: scoreSignals || [],
      timestamp: new Date().toISOString()
    };
    await db.collection(COLLECTIONS.MESSAGES).doc(id).set(record);
    return record;
  }

  static async getByPerson(personId, limit = 50) {
    const db = getDb();
    const snap = await db.collection(COLLECTIONS.MESSAGES)
      .where('personId', '==', personId)
      .get();
    return snap.docs
      .map(doc => doc.data())
      .sort((a, b) => timestampMillis(a.timestamp) - timestampMillis(b.timestamp))
      .slice(-limit);
  }
}

class EventRepository {
  static async record(name, { personId, clientId = 'grapelabs', channel = 'web', payload = {} }) {
    const db = getDb();
    const id = 'evt_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6);
    const record = {
      id,
      name, // lead_identified, lead_hot, booked, human_requested, profiles_merged, error
      personId: personId || null,
      clientId,
      channel,
      payload,
      timestamp: new Date().toISOString()
    };
    await db.collection(COLLECTIONS.EVENTS).doc(id).set(record);
    return record;
  }

  static async getByPerson(personId) {
    const db = getDb();
    const snap = await db.collection(COLLECTIONS.EVENTS)
      .where('personId', '==', personId)
      .get();
    return snap.docs
      .map(doc => doc.data())
      .sort((a, b) => timestampMillis(b.timestamp) - timestampMillis(a.timestamp));
  }

  static async hasFired(personId, eventName) {
    const db = getDb();
    const snap = await db.collection(COLLECTIONS.EVENTS)
      .where('personId', '==', personId)
      .where('name', '==', eventName)
      .limit(1)
      .get();
    return !snap.empty;
  }
}

class TokenRepository {
  static async saveRefCode(refCode, { personId, channel = 'whatsapp', expiresAt }) {
    const db = getDb();
    await db.collection(COLLECTIONS.TOKENS).doc(refCode.toUpperCase()).set({
      refCode: refCode.toUpperCase(),
      personId,
      channel,
      expiresAt: expiresAt || (Date.now() + 7 * 24 * 60 * 60 * 1000),
      createdAt: new Date().toISOString()
    });
  }

  static async resolveRefCode(refCode) {
    if (!refCode) return null;
    const db = getDb();
    const doc = await db.collection(COLLECTIONS.TOKENS).doc(refCode.toUpperCase()).get();
    if (!doc.exists) return null;
    const data = doc.data();
    if (Date.now() > data.expiresAt) return null;
    return data.personId;
  }
}

module.exports = {
  ClientRepository,
  PersonRepository,
  SessionRepository,
  MessageRepository,
  EventRepository,
  TokenRepository
};
