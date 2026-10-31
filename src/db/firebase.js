const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { getStorage } = require('firebase-admin/storage');
const { randomUUID } = require('node:crypto');
const fs = require('fs');
const path = require('path');
const env = require('../config/env');

let dbInstance = null;
let isRealFirebase = false;

// Local file-backed database emulator to allow full offline operation & testing
const LOCAL_DB_DIR = path.resolve(__dirname, '../../.data');
const LOCAL_DB_PATH = path.join(LOCAL_DB_DIR, 'firestore.json');

let inMemoryStore = null;

function ensureLocalDbFile() {
  if (!fs.existsSync(LOCAL_DB_DIR)) {
    fs.mkdirSync(LOCAL_DB_DIR, { recursive: true });
  }
  if (!fs.existsSync(LOCAL_DB_PATH)) {
    fs.writeFileSync(LOCAL_DB_PATH, JSON.stringify({}, null, 2), 'utf8');
  }
}

function readLocalDb() {
  ensureLocalDbFile();
  if (inMemoryStore) return inMemoryStore;
  try {
    const raw = fs.readFileSync(LOCAL_DB_PATH, 'utf8');
    inMemoryStore = JSON.parse(raw);
  } catch (err) {
    inMemoryStore = {};
  }
  return inMemoryStore;
}

function writeLocalDb(data) {
  inMemoryStore = data;
  ensureLocalDbFile();
  try {
    fs.writeFileSync(LOCAL_DB_PATH, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {
    // ignore temporary write locks
  }
}

/**
 * Handle Firestore dot-notation nested updates (e.g. 'identifiers.sessionIds': [...])
 */
function applyNestedPatch(target, patch) {
  for (const [key, value] of Object.entries(patch)) {
    if (key.includes('.')) {
      const parts = key.split('.');
      let curr = target;
      for (let i = 0; i < parts.length - 1; i++) {
        if (!curr[parts[i]] || typeof curr[parts[i]] !== 'object') {
          curr[parts[i]] = {};
        }
        curr = curr[parts[i]];
      }
      curr[parts[parts.length - 1]] = value;
    } else {
      target[key] = value;
    }
  }
}

/**
 * Local Firestore collection/doc mock matching the Firebase Firestore SDK interface
 */
class LocalDocumentReference {
  constructor(collectionPath, docId) {
    this.collectionPath = collectionPath;
    this.id = docId;
  }

  async get() {
    const data = readLocalDb();
    const col = data[this.collectionPath] || {};
    const docData = col[this.id];
    return {
      exists: !!docData,
      id: this.id,
      data: () => (docData ? JSON.parse(JSON.stringify(docData)) : undefined)
    };
  }

  async set(newData, options = {}) {
    const data = readLocalDb();
    if (!data[this.collectionPath]) {
      data[this.collectionPath] = {};
    }
    if (options.merge && data[this.collectionPath][this.id]) {
      applyNestedPatch(data[this.collectionPath][this.id], newData);
      data[this.collectionPath][this.id].updatedAt = new Date().toISOString();
    } else {
      data[this.collectionPath][this.id] = {
        ...newData,
        id: this.id,
        createdAt: newData.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
    }
    writeLocalDb(data);
    return { writeTime: new Date() };
  }

  async update(patchData) {
    const data = readLocalDb();
    if (!data[this.collectionPath]) {
      data[this.collectionPath] = {};
    }
    if (!data[this.collectionPath][this.id]) {
      data[this.collectionPath][this.id] = {
        id: this.id,
        createdAt: new Date().toISOString()
      };
    }

    applyNestedPatch(data[this.collectionPath][this.id], patchData);
    data[this.collectionPath][this.id].updatedAt = new Date().toISOString();
    writeLocalDb(data);
    return { writeTime: new Date() };
  }

  async delete() {
    const data = readLocalDb();
    if (data[this.collectionPath]) {
      delete data[this.collectionPath][this.id];
      writeLocalDb(data);
    }
    return { writeTime: new Date() };
  }
}

class LocalQuery {
  constructor(collectionPath, filters = [], limitCount = null, orderByField = null, orderDir = 'asc') {
    this.collectionPath = collectionPath;
    this.filters = filters;
    this.limitCount = limitCount;
    this.orderByField = orderByField;
    this.orderDir = orderDir;
  }

  where(field, op, value) {
    return new LocalQuery(this.collectionPath, [...this.filters, { field, op, value }], this.limitCount, this.orderByField, this.orderDir);
  }

  limit(count) {
    return new LocalQuery(this.collectionPath, this.filters, count, this.orderByField, this.orderDir);
  }

  orderBy(field, dir = 'asc') {
    return new LocalQuery(this.collectionPath, this.filters, this.limitCount, field, dir);
  }

  async get() {
    const data = readLocalDb();
    const col = data[this.collectionPath] || {};
    let docs = Object.values(col);

    // Apply where filters
    for (const filter of this.filters) {
      docs = docs.filter(item => {
        let val;
        if (filter.field.includes('.')) {
          const parts = filter.field.split('.');
          let curr = item;
          for (const p of parts) {
            curr = curr ? curr[p] : undefined;
          }
          val = curr;
        } else {
          val = item[filter.field];
        }

        if (filter.op === '==') return val === filter.value;
        if (filter.op === '!=') return val !== filter.value;
        if (filter.op === 'in') return Array.isArray(filter.value) && filter.value.includes(val);
        if (filter.op === 'array-contains') return Array.isArray(val) && val.includes(filter.value);
        if (filter.op === '>') return val > filter.value;
        if (filter.op === '>=') return val >= filter.value;
        if (filter.op === '<') return val < filter.value;
        if (filter.op === '<=') return val <= filter.value;
        return true;
      });
    }

    if (this.orderByField) {
      docs.sort((a, b) => {
        if (a[this.orderByField] > b[this.orderByField]) return this.orderDir === 'desc' ? -1 : 1;
        if (a[this.orderByField] < b[this.orderByField]) return this.orderDir === 'desc' ? 1 : -1;
        return 0;
      });
    }

    if (this.limitCount) {
      docs = docs.slice(0, this.limitCount);
    }

    const docSnapshots = docs.map(doc => ({
      id: doc.id,
      exists: true,
      data: () => JSON.parse(JSON.stringify(doc))
    }));

    return {
      empty: docSnapshots.length === 0,
      size: docSnapshots.length,
      docs: docSnapshots
    };
  }
}

class LocalCollectionReference extends LocalQuery {
  constructor(collectionPath) {
    super(collectionPath);
  }

  doc(id) {
    const docId = id || 'doc_' + Math.random().toString(36).substring(2, 10);
    return new LocalDocumentReference(this.collectionPath, docId);
  }

  async add(data) {
    const docId = 'doc_' + Math.random().toString(36).substring(2, 10);
    const ref = this.doc(docId);
    await ref.set(data);
    return ref;
  }
}

class LocalFirestore {
  collection(collectionPath) {
    return new LocalCollectionReference(collectionPath);
  }
}

function initFirebase() {
  if (dbInstance) return dbInstance;

  if (env.FIREBASE_CLIENT_EMAIL && env.FIREBASE_PRIVATE_KEY) {
    try {
      const app = initializeApp({
        credential: cert({
          projectId: env.FIREBASE_PROJECT_ID,
          clientEmail: env.FIREBASE_CLIENT_EMAIL,
          privateKey: env.FIREBASE_PRIVATE_KEY
        }),
        projectId: env.FIREBASE_PROJECT_ID,
        ...(env.FIREBASE_STORAGE_BUCKET ? { storageBucket: env.FIREBASE_STORAGE_BUCKET } : {})
      });
      dbInstance = getFirestore(app);
      isRealFirebase = true;
      console.log('✅ Connected to Firebase Firestore using environment credentials.');
      return dbInstance;
    } catch (error) {
      if (env.NODE_ENV === 'production') {
        throw new Error(`Firebase credentials could not be parsed. Check FIREBASE_PRIVATE_KEY formatting: ${error.message}`);
      }
      console.warn(`⚠️ Firebase credentials could not be parsed; using local Firestore in development: ${error.message}`);
    }
  }

  if (env.NODE_ENV === 'production') {
    throw new Error('Firebase credentials are required in production. Set FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY.');
  }

  dbInstance = new LocalFirestore();
  isRealFirebase = false;
  console.log('⚡ Using local Firestore store. Data saved in .data/firestore.json.');
  return dbInstance;
}

async function uploadPublicProductImage(clientId, image) {
  if (!image?.buffer || !image?.contentType) return '';
  if (!isRealFirebase) {
    return `data:${image.contentType};base64,${image.buffer.toString('base64')}`;
  }
  initFirebase();
  const bucket = getStorage().bucket(env.FIREBASE_STORAGE_BUCKET || undefined);
  const safeClientId = String(clientId || 'grapelabs').replace(/[^a-zA-Z0-9_-]/g, '_');
  const extension = image.extension === 'jpeg' ? 'jpg' : image.extension;
  const objectPath = `product-images/${safeClientId}/${randomUUID()}.${extension}`;
  const token = randomUUID();
  const file = bucket.file(objectPath);
  await file.save(image.buffer, {
    resumable: false,
    metadata: {
      contentType: image.contentType,
      cacheControl: 'public, max-age=31536000',
      metadata: { firebaseStorageDownloadTokens: token }
    }
  });
  return `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(objectPath)}?alt=media&token=${token}`;
}

/**
 * Gated lead-capture resources are stored privately: never at a public URL.
 * Local development: .data/lead-resources/<fileId>. Production: Firebase Storage (no download token),
 * streamed through the API only after the visitor has shared the required details.
 */
const LOCAL_RESOURCE_DIR = path.join(LOCAL_DB_DIR, 'lead-resources');

async function saveLeadResourceFile(clientId, { buffer, contentType, fileName }) {
  const fileId = `res_${randomUUID().replace(/-/g, '')}`;
  const safeClientId = String(clientId || 'grapelabs').replace(/[^a-zA-Z0-9_-]/g, '_');
  if (!isRealFirebase) {
    fs.mkdirSync(LOCAL_RESOURCE_DIR, { recursive: true });
    fs.writeFileSync(path.join(LOCAL_RESOURCE_DIR, fileId), buffer);
    return { id: fileId, storage: 'local', path: fileId, fileName, contentType, size: buffer.length };
  }
  initFirebase();
  let bucket;
  try {
    bucket = getStorage().bucket(env.FIREBASE_STORAGE_BUCKET || undefined);
  } catch (error) {
    throw new Error('File uploads need FIREBASE_STORAGE_BUCKET to be set on the server. You can use a link instead.');
  }
  const objectPath = `lead-resources/${safeClientId}/${fileId}`;
  await bucket.file(objectPath).save(buffer, {
    resumable: false,
    metadata: { contentType, contentDisposition: `attachment; filename="${String(fileName).replace(/"/g, '')}"` }
  });
  return { id: fileId, storage: 'firebase', path: objectPath, fileName, contentType, size: buffer.length };
}

/** Returns a readable stream for a stored resource file. */
function openLeadResourceFile(file) {
  if (!file?.path) throw new Error('File not found');
  if (file.storage === 'local') {
    const fullPath = path.join(LOCAL_RESOURCE_DIR, path.basename(file.path));
    if (!fs.existsSync(fullPath)) throw new Error('File not found');
    return fs.createReadStream(fullPath);
  }
  initFirebase();
  return getStorage().bucket(env.FIREBASE_STORAGE_BUCKET || undefined).file(file.path).createReadStream();
}

module.exports = {
  saveLeadResourceFile,
  openLeadResourceFile,
  getDb: initFirebase,
  isRealFirebase: () => isRealFirebase,
  uploadPublicProductImage
};
