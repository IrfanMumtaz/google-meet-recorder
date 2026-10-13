importScripts('db.js', 'utils.js');

// tabId -> recording. Only a cache: it is rebuilt from incoming messages if
// the service worker restarts, so audio is never dropped for lack of an entry.
const activeRecordings = new Map();
// Sessions already saved, so late chunks don't reopen them.
const finishedSessions = new Set();
const MP3_INDEX = 999999; // legacy: where older versions stored the MP3
// meetingId -> in-flight chunk/caption writes, awaited before saving or discarding.
const pendingWrites = new Map();
// meetingId -> recording being saved. The page's last chunk often lands just
// after it reports leaving, so saving waits LATE_MS and still accepts writes.
const closingRecordings = new Map();
const LATE_MS = 2000;
// A meeting the user stopped or declined stays unrecorded across reloads and
// rejoins for this long (or until the browser restarts).
const SKIP_MS = 6 * 60 * 60 * 1000;

chrome.runtime.onStartup.addListener(() => setTimeout(runRecovery, 2000));
chrome.runtime.onInstalled.addListener(() => {
  setTimeout(runRecovery, 2000);
  reinjectContentScripts();
});

async function reinjectContentScripts() {
  try {
    const tabs = await chrome.tabs.query({ url: 'https://meet.google.com/*-*-*' });
    for (const tab of tabs) {
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['content.js']
        });
        console.log('Re-injected content script into tab', tab.id);
      } catch (e) {
        console.log('Could not re-inject into tab', tab.id, '- tab may need refresh');
      }
    }
  } catch (e) {}
}

// ── Tab monitoring ─────────────────────────────────────

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' &&
      tab.url?.match(/^https:\/\/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}/)) {
    if (!activeRecordings.has(tabId)) {
      chrome.action.setBadgeText({ text: 'GO', tabId });
      chrome.action.setBadgeBackgroundColor({ color: '#4285f4', tabId });
    }
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  const rec = activeRecordings.get(tabId);
  if (rec) finalizeRecording(rec, 'tab-closed');
});

// ── Message router ─────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tabId = sender.tab?.id;

  switch (msg.type) {
    case 'MEETING_JOINED':
      handleMeetingJoined(tabId, msg);
      break;

    case 'AUDIO_RECORDING_STARTED':
      handleAudioStarted(tabId, msg);
      break;

    case 'AUDIO_CHUNK':
      trackWrite(msg.meetingId, handleAudioChunk(tabId, msg));
      break;

    case 'CAPTION_ENTRY':
      trackWrite(msg.meetingId, handleCaptionEntry(tabId, msg));
      break;

    case 'PARTICIPANTS_UPDATE':
      handleParticipantsUpdate(tabId, msg);
      break;

    case 'MEETING_LEFT':
      handleMeetingLeft(tabId, msg);
      break;

    case 'GET_STATUS':
      getStatus(msg.tabId || tabId).then(sendResponse);
      return true;

    // From the popup. mode: 'save' keeps what was recorded, 'discard' deletes it.
    case 'STOP_RECORDING':
      stopRecording(msg.tabId, msg.mode === 'discard' ? 'discard' : 'save')
        .then(() => sendResponse({ success: true }))
        .catch(e => sendResponse({ error: e.message }));
      return true;

    case 'RESUME_RECORDING':
      resumeRecording(msg.tabId)
        .then(() => sendResponse({ success: true }))
        .catch(e => sendResponse({ error: e.message }));
      return true;

    case 'RUN_RECOVERY':
      runRecovery().then(() => sendResponse({ success: true })).catch(e => sendResponse({ error: e.message }));
      return true;

    case 'CONVERT_PROGRESS':
    case 'PONG':
    case 'HEARTBEAT':
    case 'OFFSCREEN_READY':
      break;
  }
});

// ── Session lookup ─────────────────────────────────

// Returns the recording a content-script message belongs to, creating it on
// the first message of a session (or the first after a worker restart).
async function getRecording(tabId, msg) {
  if (!tabId || !msg.meetingId) return null;
  const closing = closingRecordings.get(msg.meetingId);
  if (closing) return Date.now() < closing.acceptUntil ? closing : null;
  if (finishedSessions.has(msg.meetingId)) return null;

  let rec = activeRecordings.get(tabId);
  if (rec?.meetingId !== msg.meetingId) {
    // A straggler from an earlier page load in this tab must not end the current one.
    if (rec && (msg.startTime || 0) < rec.startTime) return null;

    // A new session in this tab means the previous page went away; if it never
    // reported leaving, save what it recorded.
    if (rec && rec.status !== 'finalizing') finalizeRecording(rec, 'replaced');

    rec = {
      tabId,
      meetingId: msg.meetingId,
      meetingCode: msg.meetingCode,
      title: msg.title,
      url: msg.url,
      startTime: msg.startTime || Date.now(),
      status: 'detected'
    };
    activeRecordings.set(tabId, rec);
    // Messages that arrive while this runs wait on it rather than racing it.
    rec.ready = openSession(rec);
  }

  const ok = await rec.ready;
  return ok && rec.status !== 'finalizing' ? rec : null;
}

async function openSession(rec) {
  if (await isSkipped(rec.meetingCode)) {
    console.log('Not recording', rec.meetingCode, '- the user stopped it');
    closeRecording(rec);
    finishedSessions.add(rec.meetingId);
    chrome.tabs.sendMessage(rec.tabId, { type: 'STOP_CAPTURE' }).catch(() => {});
    setOffBadge(rec.tabId);
    return false;
  }

  const existing = await MeetingDB.getSession(rec.meetingId);
  if (existing) {
    if (existing.status !== 'recording') {
      closeRecording(rec);
      finishedSessions.add(rec.meetingId);
      return false;
    }
    rec.status = 'recording';
  } else {
    await MeetingDB.saveSession({
      meetingId: rec.meetingId,
      meetingCode: rec.meetingCode,
      title: rec.title,
      url: rec.url,
      startTime: rec.startTime,
      endTime: null,
      status: 'recording',
      participants: []
    });
  }
  return true;
}

// Forgets a recording, unless the tab has already moved on to the next one.
function closeRecording(rec) {
  if (activeRecordings.get(rec.tabId) !== rec) return;
  activeRecordings.delete(rec.tabId);
  try { chrome.action.setBadgeText({ text: '', tabId: rec.tabId }); } catch (e) {}
}

function trackWrite(meetingId, promise) {
  if (!meetingId) return;
  if (!pendingWrites.has(meetingId)) pendingWrites.set(meetingId, new Set());
  const set = pendingWrites.get(meetingId);
  set.add(promise);
  promise.finally(() => {
    set.delete(promise);
    if (set.size === 0) pendingWrites.delete(meetingId);
  });
}

async function waitForWrites(meetingId) {
  const set = pendingWrites.get(meetingId);
  if (set) await Promise.allSettled([...set]);
}

// ── Meeting joined ─────────────────────────────────────

async function handleMeetingJoined(tabId, msg) {
  const rec = await getRecording(tabId, msg);
  if (!rec) return;
  if (rec.status === 'detected') {
    chrome.action.setBadgeText({ text: 'GO', tabId });
    chrome.action.setBadgeBackgroundColor({ color: '#4285f4', tabId });
  }
  console.log('Meeting detected:', rec.meetingId, rec.title);
}

// ── Audio started (from content script, relayed from MAIN world) ──

async function handleAudioStarted(tabId, msg) {
  const rec = await getRecording(tabId, msg);
  if (!rec) return;
  markRecording(rec);
  console.log('Recording started for', rec.meetingId);
}

function markRecording(rec) {
  if (rec.status !== 'detected') return;
  rec.status = 'recording';
  chrome.action.setBadgeText({ text: 'REC', tabId: rec.tabId });
  chrome.action.setBadgeBackgroundColor({ color: '#ea4335', tabId: rec.tabId });
}

// ── Audio chunk (base64 from content script) ───────────

async function handleAudioChunk(tabId, msg) {
  try {
    const rec = await getRecording(tabId, msg);
    if (!rec) {
      console.warn('Audio chunk dropped for', msg.meetingId, 'index', msg.chunkIndex);
      return;
    }
    markRecording(rec);
    const blob = base64ToBlob(msg.b64, 'audio/webm');
    await MeetingDB.saveChunk(rec.meetingId, msg.chunkIndex, blob);
  } catch (e) {
    console.error('Failed to save audio chunk:', e);
  }
}

// ── Caption entry ──────────────────────────────────────

async function handleCaptionEntry(tabId, msg) {
  const rec = await getRecording(tabId, msg);
  if (!rec) {
    console.warn('Caption dropped, no active recording for tab', tabId, msg.text?.slice(0, 40));
    return;
  }

  const entry = {
    meetingId: rec.meetingId,
    speaker: msg.speaker || 'Unknown',
    text: msg.text || '',
    timestamp: msg.timestamp || 0,
    capturedAt: Date.now()
  };
  if (!entry.text) return;

  try {
    await MeetingDB.saveTranscriptEntry(entry);
  } catch (e) {
    console.error('Failed to save transcript:', e);
  }
}

async function handleParticipantsUpdate(tabId, msg) {
  try {
    const rec = await getRecording(tabId, msg);
    if (!rec) return;
    await MeetingDB.updateSession(rec.meetingId, { participants: msg.participants });
  } catch (e) {}
}

async function handleMeetingLeft(tabId, msg) {
  try {
    const rec = await getRecording(tabId, msg);
    if (rec) finalizeRecording(rec, msg.reason);
  } catch (e) {
    console.error('Meeting left error:', e);
  }
}

// ── Finalize recording ─────────────────────────────────

async function finalizeRecording(rec, reason) {
  if (rec.status === 'finalizing') return;

  console.log('Finalizing', rec.meetingId, 'reason:', reason);
  rec.status = 'finalizing';
  finishedSessions.add(rec.meetingId);
  closingRecordings.set(rec.meetingId, rec);
  rec.acceptUntil = Date.now() + LATE_MS;

  try {
    await new Promise(r => setTimeout(r, LATE_MS));
    await waitForWrites(rec.meetingId);
    await MeetingDB.updateSession(rec.meetingId, { endTime: Date.now(), status: 'ended' });
    await downloadFiles(rec.meetingId, rec.title, rec.startTime);
    await MeetingDB.updateSession(rec.meetingId, { status: 'downloaded' });
    try { await MeetingDB.deleteSessionData(rec.meetingId); } catch (e) {}
  } catch (e) {
    console.error('Finalize error:', e);
    try { await MeetingDB.updateSession(rec.meetingId, { status: 'ended' }); } catch (e2) {}
  } finally {
    closingRecordings.delete(rec.meetingId);
    closeRecording(rec);
  }
}

async function discardRecording(rec) {
  if (rec.status === 'finalizing') return;

  console.log('Discarding', rec.meetingId);
  rec.status = 'finalizing';
  finishedSessions.add(rec.meetingId);
  closingRecordings.set(rec.meetingId, rec);
  rec.acceptUntil = 0; // nothing more may be written for a discarded recording
  try {
    await waitForWrites(rec.meetingId);
    await MeetingDB.deleteSessionData(rec.meetingId);
  } catch (e) {
    console.error('Discard error:', e);
  } finally {
    closingRecordings.delete(rec.meetingId);
    closeRecording(rec);
  }
}

// ── Stop / resume (from the popup) ─────────────────────

async function stopRecording(tabId, mode) {
  if (!tabId) throw new Error('no tab');
  const rec = activeRecordings.get(tabId);
  const code = rec?.meetingCode || meetingCodeFromUrl((await chrome.tabs.get(tabId)).url);
  if (code) await setSkipped(code, true);

  // The page stops its recorder and sends its last chunk and captions first.
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'STOP_CAPTURE' });
  } catch (e) {
    console.warn('Could not reach the Meet tab to stop capture:', e.message);
  }

  if (rec) {
    if (mode === 'discard') await discardRecording(rec);
    else finalizeRecording(rec, 'manual');
  }
  setOffBadge(tabId);
}

async function resumeRecording(tabId) {
  if (!tabId) throw new Error('no tab');
  const code = meetingCodeFromUrl((await chrome.tabs.get(tabId)).url);
  if (code) await setSkipped(code, false);
  try { chrome.action.setBadgeText({ text: '', tabId }); } catch (e) {}
  await chrome.tabs.sendMessage(tabId, { type: 'START_CAPTURE' });
}

function setOffBadge(tabId) {
  try {
    chrome.action.setBadgeText({ text: 'OFF', tabId });
    chrome.action.setBadgeBackgroundColor({ color: '#9aa0a6', tabId });
  } catch (e) {}
}

function meetingCodeFromUrl(url) {
  return url?.match(/^https:\/\/meet\.google\.com\/([a-z]{3}-[a-z]{4}-[a-z]{3})/)?.[1] || null;
}

async function getSkipped() {
  const { skipped = {} } = await chrome.storage.session.get('skipped');
  const now = Date.now();
  for (const code of Object.keys(skipped)) if (skipped[code] < now) delete skipped[code];
  return skipped;
}

async function isSkipped(code) {
  if (!code) return false;
  return !!(await getSkipped())[code];
}

async function setSkipped(code, on) {
  const skipped = await getSkipped();
  if (on) skipped[code] = Date.now() + SKIP_MS;
  else delete skipped[code];
  await chrome.storage.session.set({ skipped });
}

// ── Download files ─────────────────────────────────────

// Downloads a session's audio and transcripts. Throws if the audio could not
// be saved, so the caller keeps the data for recovery.
async function downloadFiles(meetingId, title, startTime) {
  const settings = await chrome.storage.local.get({ subfolder: 'MeetingNotes' });
  const folder = settings.subfolder || 'MeetingNotes';
  const base = `${folder}/${MeetingUtils.formatFilename(title, startTime)}`;

  await downloadAudio(meetingId, base);

  const session = await MeetingDB.getSession(meetingId);
  const transcript = await MeetingDB.getTranscript(meetingId);
  console.log('Finalize', meetingId, '| session saved:', !!session, '| transcript entries:', transcript.length);

  // Don't make the transcript depend on the session record: when it was
  // missing, captions were captured but never saved.
  if (transcript.length > 0) {
    const full = { title, startTime, ...session };
    full.endTime = full.endTime || Date.now();
    await chrome.downloads.download({
      url: textToDataUrl(MeetingUtils.formatTranscriptTxt(full, transcript), 'text/plain'),
      filename: `${base}_transcript.txt`,
      saveAs: false
    });
    await chrome.downloads.download({
      url: textToDataUrl(MeetingUtils.formatTranscriptJson(full, transcript), 'application/json'),
      filename: `${base}_transcript.json`,
      saveAs: false
    });
  }
}

// The offscreen document builds the file (MP3, or WebM if conversion fails)
// and serves it as a blob: URL, which must stay alive until the download ends.
async function downloadAudio(meetingId, base) {
  try {
    const built = await withOffscreen(async () => {
      const res = await chrome.runtime.sendMessage({ type: 'BUILD_AUDIO', meetingId });
      if (res?.success && res.url) await downloadAndWait(res.url, `${base}.${res.ext}`);
      return res;
    });
    if (built?.success) {
      if (built.error) console.warn('MP3 conversion failed, saved WebM:', built.error);
      return;
    }
    console.warn('Offscreen audio build failed:', built?.error);
  } catch (e) {
    console.warn('Offscreen audio build failed:', e.message);
  }

  // Fallback: assemble the WebM here.
  const webm = (await MeetingDB.getChunks(meetingId)).filter(c => c.index !== MP3_INDEX);
  if (webm.length === 0) return;
  const blob = new Blob(webm.map(c => c.blob), { type: 'audio/webm' });
  await downloadAndWait(await blobToDataUrl(blob), `${base}.webm`);
}

async function downloadAndWait(url, filename) {
  const id = await chrome.downloads.download({ url, filename, saveAs: false });
  await new Promise((resolve, reject) => {
    const done = (fn, arg) => {
      chrome.downloads.onChanged.removeListener(onChanged);
      fn(arg);
    };
    const onChanged = (delta) => {
      if (delta.id !== id || !delta.state) return;
      if (delta.state.current === 'complete') done(resolve);
      else if (delta.state.current === 'interrupted') done(reject, new Error('download interrupted: ' + filename));
    };
    chrome.downloads.onChanged.addListener(onChanged);
    chrome.downloads.search({ id }).then(([item]) => {
      if (item?.state === 'complete') done(resolve);
      else if (item?.state === 'interrupted') done(reject, new Error('download interrupted: ' + filename));
    });
  });
}

// ── Recovery ───────────────────────────────────────────

async function runRecovery() {
  try {
    const incomplete = await MeetingDB.getIncompleteSessions();
    if (incomplete.length === 0) return;
    console.log('Recovery: found', incomplete.length, 'incomplete sessions');
    for (const s of incomplete) await recoverSession(s);
  } catch (e) { console.error('Recovery error:', e); }
}

async function recoverSession(session) {
  try {
    const title = (session.title || 'Meeting') + ' (recovered)';
    await downloadFiles(session.meetingId, title, session.startTime);
    await MeetingDB.updateSession(session.meetingId, { status: 'downloaded' });
    await MeetingDB.deleteSessionData(session.meetingId);
  } catch (e) { console.error('Recovery failed:', session.meetingId, e); }
}

// ── Helpers ────────────────────────────────────────────

async function getStatus(tabId) {
  const status = r => ({ state: r.status, meetingId: r.meetingId, title: r.title, startTime: r.startTime, tabId: r.tabId });
  if (tabId && activeRecordings.has(tabId)) return status(activeRecordings.get(tabId));

  if (tabId) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    const code = meetingCodeFromUrl(tab?.url);
    if (code && await isSkipped(code)) {
      const title = (tab.title || '').replace(/\s*[-–]\s*Google Meet\s*$/i, '').trim() || code;
      return { state: 'skipped', title, tabId };
    }
  }

  for (const [, r] of activeRecordings) return status(r);
  return { state: 'idle' };
}

function base64ToBlob(b64, type) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

function textToDataUrl(text, mime) {
  return `data:${mime};charset=utf-8;base64,${btoa(unescape(encodeURIComponent(text)))}`;
}

// The document is shared, so it closes only when its last user is done.
let offscreenUsers = 0;
let offscreenCreating = null;

async function withOffscreen(fn) {
  offscreenUsers++;
  try {
    await ensureOffscreen();
    return await fn();
  } finally {
    if (--offscreenUsers === 0) closeOffscreen();
  }
}

async function ensureOffscreen() {
  const ctx = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (ctx.length > 0) return;
  // BLOBS, not AUDIO_PLAYBACK: Chrome closes an audio-playback document after
  // 30 s of silence, which would kill a long conversion midway.
  offscreenCreating ||= chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['BLOBS'],
    justification: 'Build the meeting audio file (WebM to MP3) and serve it for download'
  }).finally(() => { offscreenCreating = null; });
  await offscreenCreating;
}

async function closeOffscreen() {
  try {
    const ctx = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    if (ctx.length > 0) await chrome.offscreen.closeDocument();
  } catch (e) {}
}
