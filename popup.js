const statusIdle = document.getElementById('status-idle');
const statusDetected = document.getElementById('status-detected');
const statusRecording = document.getElementById('status-recording');
const statusSaving = document.getElementById('status-saving');
const statusSkipped = document.getElementById('status-skipped');
const skippedTitle = document.getElementById('skipped-title');
const detectedTitle = document.getElementById('detected-title');
const recordingTitle = document.getElementById('recording-title');
const recordingDuration = document.getElementById('recording-duration');
const btnStop = document.getElementById('btn-stop');
const btnDiscard = document.getElementById('btn-discard');
const btnSkip = document.getElementById('btn-skip');
const btnResume = document.getElementById('btn-resume');
const subfolderInput = document.getElementById('subfolder');
const folderPreview = document.getElementById('folder-preview');

let durationInterval = null;
let lastState = null;
let currentTabId = null;
let busy = false;
let discardArmed = null;

async function init() {
  const settings = await chrome.storage.local.get({ subfolder: 'MeetingNotes' });
  subfolderInput.value = settings.subfolder || 'MeetingNotes';
  folderPreview.textContent = settings.subfolder || 'MeetingNotes';
  updateStatus();
  setInterval(updateStatus, 2000);
}

async function updateStatus() {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const resp = await chrome.runtime.sendMessage({ type: 'GET_STATUS', tabId: tabs[0]?.id });
    if (busy) return;
    currentTabId = resp.tabId || tabs[0]?.id;
    showStatus(resp);
  } catch (e) {
    showStatus({ state: 'idle' });
  }
}

function showStatus(s) {
  // Re-rendering every poll would reset the buttons and the discard confirmation.
  const key = `${s.state}|${s.title}|${s.startTime}`;
  if (key === lastState) return;
  lastState = key;
  resetButtons();

  statusIdle.style.display = 'none';
  statusSkipped.style.display = 'none';
  statusDetected.style.display = 'none';
  statusRecording.style.display = 'none';
  statusSaving.style.display = 'none';
  if (durationInterval) { clearInterval(durationInterval); durationInterval = null; }

  switch (s.state) {
    case 'recording':
      statusRecording.style.display = 'flex';
      recordingTitle.textContent = s.title || 'Recording...';
      tick(s.startTime);
      durationInterval = setInterval(() => tick(s.startTime), 1000);
      break;
    case 'detected':
      statusDetected.style.display = 'flex';
      detectedTitle.textContent = s.title || 'Google Meet';
      break;
    case 'finalizing':
      statusSaving.style.display = 'flex';
      break;
    case 'skipped':
      statusSkipped.style.display = 'flex';
      skippedTitle.textContent = s.title || 'Google Meet';
      break;
    default:
      statusIdle.style.display = 'flex';
  }
}

function tick(start) {
  if (!start) return;
  const ms = Date.now() - start;
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  recordingDuration.textContent = `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}

function resetButtons() {
  clearTimeout(discardArmed);
  discardArmed = null;
  btnStop.textContent = 'Stop & save';
  btnDiscard.textContent = 'Discard';
  btnSkip.textContent = "Don't record";
  btnResume.textContent = 'Record';
  for (const b of [btnStop, btnDiscard, btnSkip, btnResume]) b.disabled = false;
}

async function send(type, extra, btn, label) {
  busy = true;
  for (const b of [btnStop, btnDiscard, btnSkip, btnResume]) b.disabled = true;
  btn.textContent = label;
  try {
    await chrome.runtime.sendMessage({ type, tabId: currentTabId, ...extra });
  } finally {
    busy = false;
    lastState = null;
    updateStatus();
  }
}

btnStop.addEventListener('click', () => send('STOP_RECORDING', { mode: 'save' }, btnStop, 'Stopping...'));

// Deleting the recording needs a second click.
btnDiscard.addEventListener('click', () => {
  if (!discardArmed) {
    btnDiscard.textContent = 'Delete recording?';
    discardArmed = setTimeout(() => {
      discardArmed = null;
      btnDiscard.textContent = 'Discard';
    }, 3000);
    return;
  }
  clearTimeout(discardArmed);
  discardArmed = null;
  send('STOP_RECORDING', { mode: 'discard' }, btnDiscard, 'Discarding...');
});

btnSkip.addEventListener('click', () => send('STOP_RECORDING', { mode: 'discard' }, btnSkip, 'Stopping...'));

btnResume.addEventListener('click', () => send('RESUME_RECORDING', {}, btnResume, 'Starting...'));

subfolderInput.addEventListener('input', () => {
  const val = subfolderInput.value.trim() || 'MeetingNotes';
  folderPreview.textContent = val;
  chrome.storage.local.set({ subfolder: val });
});

init();
