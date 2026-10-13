const DB_NAME = 'meetingai_db';
const DB_VERSION = 1;

function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains('sessions')) {
        db.createObjectStore('sessions', { keyPath: 'meetingId' });
      }
      if (!db.objectStoreNames.contains('chunks')) {
        const chunkStore = db.createObjectStore('chunks', { keyPath: ['meetingId', 'index'] });
        chunkStore.createIndex('byMeeting', 'meetingId', { unique: false });
      }
      if (!db.objectStoreNames.contains('transcript')) {
        const txStore = db.createObjectStore('transcript', { keyPath: 'id', autoIncrement: true });
        txStore.createIndex('byMeeting', 'meetingId', { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function tx(db, stores, mode) {
  const transaction = db.transaction(stores, mode);
  return stores.length === 1
    ? transaction.objectStore(stores[0])
    : stores.map(s => transaction.objectStore(s));
}

function req(idbRequest) {
  return new Promise((resolve, reject) => {
    idbRequest.onsuccess = () => resolve(idbRequest.result);
    idbRequest.onerror = () => reject(idbRequest.error);
  });
}

async function saveSession(session) {
  const db = await openDB();
  const store = tx(db, ['sessions'], 'readwrite');
  await req(store.put(session));
  db.close();
}

async function getSession(meetingId) {
  const db = await openDB();
  const store = tx(db, ['sessions'], 'readonly');
  const result = await req(store.get(meetingId));
  db.close();
  return result;
}

async function updateSession(meetingId, updates) {
  const db = await openDB();
  const store = tx(db, ['sessions'], 'readwrite');
  const existing = await req(store.get(meetingId));
  if (existing) {
    Object.assign(existing, updates);
    await req(store.put(existing));
  }
  db.close();
}

async function saveChunk(meetingId, index, blob) {
  const db = await openDB();
  const store = tx(db, ['chunks'], 'readwrite');
  await req(store.put({ meetingId, index, blob, timestamp: Date.now() }));
  db.close();
}

async function getChunks(meetingId) {
  const db = await openDB();
  const store = tx(db, ['chunks'], 'readonly');
  const idx = store.index('byMeeting');
  const results = await req(idx.getAll(meetingId));
  db.close();
  return results.sort((a, b) => a.index - b.index);
}

async function saveTranscriptEntry(entry) {
  const db = await openDB();
  const store = tx(db, ['transcript'], 'readwrite');
  await req(store.add(entry));
  db.close();
}

async function getTranscript(meetingId) {
  const db = await openDB();
  const store = tx(db, ['transcript'], 'readonly');
  const idx = store.index('byMeeting');
  const results = await req(idx.getAll(meetingId));
  db.close();
  return results;
}

async function getIncompleteSessions() {
  const db = await openDB();
  const store = tx(db, ['sessions'], 'readonly');
  const all = await req(store.getAll());
  db.close();
  return all.filter(s => s.status !== 'downloaded');
}

async function deleteSessionData(meetingId) {
  const db = await openDB();
  const transaction = db.transaction(['sessions', 'chunks', 'transcript'], 'readwrite');

  const sessStore = transaction.objectStore('sessions');
  sessStore.delete(meetingId);

  const chunkStore = transaction.objectStore('chunks');
  const chunkIdx = chunkStore.index('byMeeting');
  const chunkKeys = await req(chunkIdx.getAllKeys(meetingId));
  for (const key of chunkKeys) {
    chunkStore.delete(key);
  }

  const txStore = transaction.objectStore('transcript');
  const txIdx = txStore.index('byMeeting');
  const txKeys = await req(txIdx.getAllKeys(meetingId));
  for (const key of txKeys) {
    txStore.delete(key);
  }

  await new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
  });
  db.close();
}

if (typeof self !== 'undefined' && typeof module === 'undefined') {
  self.MeetingDB = {
    openDB, saveSession, getSession, updateSession,
    saveChunk, getChunks,
    saveTranscriptEntry, getTranscript,
    getIncompleteSessions, deleteSessionData
  };
}
