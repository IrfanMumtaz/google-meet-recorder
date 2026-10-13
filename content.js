(() => {
  if (window.__meetingAIInjected) return;
  window.__meetingAIInjected = true;

  const MSG_IN = '__MEETINGAI__';
  const MSG_OUT = '__MEETINGAI_CMD__';

  // One id per page load, so a reload or rejoin mid-meeting starts a new
  // recording instead of colliding with the one the background is saving.
  let meetingId = null;
  let meetingCode = null;
  let meetingTitle = '';
  let meetingStartTime = null;
  let audioRecordingActive = false;
  let hasLeft = false;
  // Set when the user stops or declines recording; the meeting goes on.
  let paused = false;
  let stopWaiters = [];
  let chunkIndex = 0;

  // Caption state
  let captionObserver = null;
  const blockState = new Map();
  const finalizedBlocks = new WeakSet();
  let captionEntryCount = 0;

  // CC state
  let ccAttempts = 0;
  let captionsDetected = false;

  function log(...args) {
    console.log('[MeetingAI]', ...args);
  }

  // ── Meeting detection ────────────────────────────────

  function getMeetingCode() {
    const m = location.pathname.match(/\/([a-z]{3}-[a-z]{4}-[a-z]{3})/);
    return m ? m[1] : location.pathname.replace(/^\//, '');
  }

  function getMeetingTitle() {
    const raw = document.title.replace(/\s*[-–]\s*Google Meet\s*$/i, '').trim();
    return (raw && raw !== 'Google Meet') ? raw : getMeetingCode();
  }

  function isInMeeting() {
    return !!(
      document.querySelector('button[aria-label*="Leave" i]') ||
      document.querySelector('[data-self-name]') ||
      document.querySelector('[data-participant-id]') ||
      document.querySelectorAll('video').length >= 1
    );
  }

  function ensureMeetingId() {
    if (!meetingId) {
      meetingCode = getMeetingCode();
      meetingTitle = getMeetingTitle();
      meetingStartTime = meetingStartTime || Date.now();
      meetingId = `${meetingCode}_${meetingStartTime}`;
    }
    return meetingId;
  }

  // Every message carries the session, so the background can pick it back up
  // if its service worker was restarted mid-meeting.
  function sendBg(type, data = {}) {
    try {
      chrome.runtime.sendMessage({
        type, ...data,
        meetingId, meetingCode, title: meetingTitle, url: location.href, startTime: meetingStartTime
      });
    } catch (e) {}
  }

  // ── Audio chunk relay (from MAIN world → background) ─

  window.addEventListener('message', (ev) => {
    if (ev.source !== window || ev.data?.src !== MSG_IN) return;
    const msg = ev.data;

    switch (msg.type) {
      case 'INJECTED':
        log('Audio capture script injected, v' + msg.version);
        break;

      case 'AUDIO_SOURCE_ADDED':
        log('Audio source added:', msg.label, '(total:', msg.total + ')');
        break;

      case 'RECORDING_ACTIVE':
        log('Audio recording active, format:', msg.mimeType);
        audioRecordingActive = true;
        ensureMeetingId();
        sendBg('AUDIO_RECORDING_STARTED');
        scheduleCC();
        scheduleCaptionDetection();
        break;

      case 'AUDIO_CHUNK':
        ensureMeetingId();
        sendBg('AUDIO_CHUNK', {
          chunkIndex: chunkIndex++,
          b64: msg.b64,
          size: msg.size
        });
        break;

      case 'RECORDING_STOPPED':
        log('Audio recording stopped');
        audioRecordingActive = false;
        stopWaiters.forEach(fn => fn());
        stopWaiters = [];
        break;

      case 'ERROR':
        log('Audio error:', msg.msg);
        break;
    }
  });

  function stopAudioCapture() {
    window.postMessage({ src: MSG_OUT, type: 'STOP' }, '*');
  }

  // Stops recording but stays in the meeting. Resolves once the last audio
  // chunk and captions have been sent, so the background can save or discard.
  function pauseCapture() {
    if (paused) return Promise.resolve();
    flushBlocks();
    paused = true;
    log('Recording stopped by user');
    if (!audioRecordingActive) return Promise.resolve();
    return new Promise(resolve => {
      stopWaiters.push(resolve);
      stopAudioCapture();
      setTimeout(resolve, 3000);
    });
  }

  // Starts a fresh recording (new id, new file) in the same meeting.
  function resumeCapture() {
    if (!paused || hasLeft) return;
    paused = false;
    for (const block of blockState.keys()) finalizedBlocks.add(block);
    blockState.clear();
    meetingId = null;
    meetingStartTime = Date.now();
    chunkIndex = 0;
    ensureMeetingId();
    log('Recording resumed by user:', meetingId);
    window.postMessage({ src: MSG_OUT, type: 'START' }, '*');
  }

  // ── CC enabling ─────────────────────────────────────
  // Match only the toolbar toggle ("Turn on captions" / "Turn off captions");
  // the caption panel's settings and "Jump to most recent captions" buttons
  // also mention captions.

  function findCCButton() {
    for (const btn of document.querySelectorAll('button[aria-label]')) {
      if (/turn (on|off) captions/i.test(btn.getAttribute('aria-label'))) return btn;
    }
    return null;
  }

  function isCCAlreadyOn() {
    const btn = findCCButton();
    return !!btn && /turn off captions/i.test(btn.getAttribute('aria-label'));
  }

  // CC is a toggle: click at most once, and only when it's clearly off.
  function scheduleCC() {
    const maxAttempts = 10;

    function tryEnable() {
      if (hasLeft || paused || ccAttempts >= maxAttempts) return;
      ccAttempts++;

      const btn = findCCButton();
      if (!btn) {
        log('CC: button not found (attempt', ccAttempts + ')');
        setTimeout(tryEnable, 3000);
        return;
      }
      if (isCCAlreadyOn() || findCaptionRegion()) {
        log('CC: already on');
        return;
      }
      log('CC: clicking button, label =', btn.getAttribute('aria-label'));
      btn.click();
      ccAttempts = maxAttempts;
    }

    setTimeout(tryEnable, 3000);
  }

  // ── Caption detection & scraping ─────────────────────
  // Only trust an element Meet explicitly labels as captions; text-change
  // heuristics latched onto toasts like "Raising your hand".

  function scheduleCaptionDetection() {
    log('Caption detection started');
    let diagnosed = false;
    const timer = setInterval(() => {
      if (captionsDetected || hasLeft) { clearInterval(timer); return; }
      const region = findCaptionRegion();
      if (region) {
        clearInterval(timer);
        onCaptionContainerFound(region, 'aria-label');
      } else if (!diagnosed && isCCAlreadyOn()) {
        diagnosed = true;
        log('CC is on but no labelled caption region found. Labelled elements:',
          [...document.querySelectorAll('[aria-label]')]
            .filter(e => e.tagName !== 'BUTTON')
            .map(e => `${e.tagName}[role=${e.getAttribute('role')}] "${e.getAttribute('aria-label')}"`)
            .slice(0, 40));
      }
    }, 2000);
  }

  function findCaptionRegion() {
    return document.querySelector('[role="region"][aria-label="Captions" i]');
  }

  function onCaptionContainerFound(container, method) {
    if (captionsDetected) return;
    captionsDetected = true;
    log('Caption container found via', method,
        '| tag:', container.tagName,
        '| children:', container.children.length,
        '| text preview:', (container.textContent || '').trim().substring(0, 100));
    startCaptionScraping(container);
  }

  // Each speaker turn is a child block of the region: a header with the
  // speaker name (span.NWpY1d) and a text div (div.ygicle) that Meet keeps
  // rewriting while the person talks. A block is saved once, when it is
  // final: a newer block follows it and it has stopped changing, it leaves
  // the DOM, or the meeting ends.
  function startCaptionScraping(container) {
    if (captionObserver) captionObserver.disconnect();

    captionObserver = new MutationObserver(() => processCaptions(container));
    captionObserver.observe(container, { childList: true, subtree: true, characterData: true });
    processCaptions(container);

    const sweep = setInterval(() => {
      if (hasLeft || !document.contains(container)) { clearInterval(sweep); return; }
      sweepBlocks(container);
    }, 2000);

    const bodyObs = new MutationObserver(() => {
      if (!document.contains(container)) {
        log('Caption container removed, re-detecting...');
        captionObserver.disconnect();
        bodyObs.disconnect();
        flushBlocks();
        captionsDetected = false;
        scheduleCaptionDetection();
      }
    });
    bodyObs.observe(document.body, { childList: true, subtree: true });
  }

  function getCaptionBlocks(container) {
    return [...container.children].filter(el =>
      !el.querySelector('button') &&
      (el.querySelector('.ygicle') || el.children.length >= 2));
  }

  function parseCaptionBlock(block) {
    const nameEl = block.querySelector('.NWpY1d') || block.firstElementChild;
    const textEl = block.querySelector('.ygicle') || block.lastElementChild;
    return {
      speaker: (nameEl?.textContent || '').trim() || 'Unknown',
      text: (textEl?.textContent || '').trim()
    };
  }

  function processCaptions(container) {
    for (const block of getCaptionBlocks(container)) {
      if (finalizedBlocks.has(block)) continue;
      const { speaker, text } = parseCaptionBlock(block);
      if (!text) continue;
      let st = blockState.get(block);
      if (!st) {
        st = { startedAt: meetingStartTime ? Date.now() - meetingStartTime : 0 };
        blockState.set(block, st);
      }
      if (st.text !== text) st.changedAt = Date.now();
      st.speaker = speaker;
      st.text = text;
    }
  }

  function sweepBlocks(container) {
    const blocks = getCaptionBlocks(container);
    const newest = blocks[blocks.length - 1];
    const now = Date.now();
    for (const [block, st] of [...blockState]) {
      if (!container.contains(block) || (block !== newest && now - st.changedAt > 4000)) {
        finalizeBlock(block, st);
      }
    }
  }

  function finalizeBlock(block, st) {
    blockState.delete(block);
    finalizedBlocks.add(block);
    if (paused) return;
    captionEntryCount++;
    sendBg('CAPTION_ENTRY', { speaker: st.speaker, text: st.text, timestamp: st.startedAt });
    if (captionEntryCount === 1) log('First caption captured:', st.speaker, '-', st.text.substring(0, 60));
  }

  function flushBlocks() {
    for (const [block, st] of [...blockState]) finalizeBlock(block, st);
  }

  // ── Participants ─────────────────────────────────────

  function getParticipants() {
    const names = new Set();
    for (const el of document.querySelectorAll('[data-self-name]')) {
      const n = el.getAttribute('data-self-name')?.trim();
      if (n) names.add(n);
    }
    for (const el of document.querySelectorAll('[data-participant-id] [aria-label]')) {
      const n = el.getAttribute('aria-label')?.trim();
      if (n && n.length < 80 && !n.toLowerCase().includes('button')) names.add(n);
    }
    return [...names];
  }

  // ── Meeting end detection ────────────────────────────

  function setupEndDetection() {
    const bindLeave = () => {
      for (const btn of document.querySelectorAll('button[aria-label*="Leave" i], button[aria-label*="Hang up" i]')) {
        if (btn.__mai) continue;
        btn.__mai = true;
        btn.addEventListener('click', () => setTimeout(() => onLeft('button'), 800));
      }
    };
    bindLeave();
    setInterval(bindLeave, 5000);

    const obs = new MutationObserver(() => {
      const t = document.body.innerText;
      if (
        document.querySelector('[data-call-ended="true"]') ||
        document.querySelector('[aria-label*="Rejoin" i]') ||
        (t.includes('You left the meeting') && !t.includes('Ask to join'))
      ) {
        onLeft('ended');
      }
    });
    obs.observe(document.body, { childList: true, subtree: true });
  }

  function onLeft(reason) {
    if (hasLeft) return;
    hasLeft = true;
    flushBlocks();
    log('Meeting left:', reason, '| Total captions captured:', captionEntryCount);

    stopAudioCapture();
    if (captionObserver) captionObserver.disconnect();
    sendBg('MEETING_LEFT', { reason });
  }

  window.addEventListener('beforeunload', () => {
    if (!hasLeft && audioRecordingActive && !paused) {
      flushBlocks();
      stopAudioCapture();
      sendBg('MEETING_LEFT', { reason: 'unload' });
    }
  });

  // ── Extension message handler ────────────────────────

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'PING') {
      sendBg('PONG', { inMeeting: isInMeeting(), captionsDetected, captionEntryCount });
    }
    if (msg.type === 'STOP_CAPTURE') {
      pauseCapture().then(() => sendResponse({ ok: true }));
      return true;
    }
    if (msg.type === 'START_CAPTURE') {
      resumeCapture();
      sendResponse({ ok: true });
    }
  });

  // ── Init ─────────────────────────────────────────────

  function init() {
    log('Content script loaded');

    const check = setInterval(() => {
      if (isInMeeting()) {
        clearInterval(check);
        ensureMeetingId();
        log('Meeting detected:', meetingId, meetingTitle);

        sendBg('MEETING_JOINED');
        setupEndDetection();

        const trackParticipants = () => {
          const p = getParticipants();
          if (p.length > 0) sendBg('PARTICIPANTS_UPDATE', { participants: p });
        };
        setTimeout(trackParticipants, 5000);
        setInterval(trackParticipants, 30000);
      }
    }, 1500);

    setTimeout(() => clearInterval(check), 180000);
  }

  init();
})();
