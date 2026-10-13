(function() {
  'use strict';

  const MSG_OUT = '__MEETINGAI__';
  const MSG_IN = '__MEETINGAI_CMD__';
  const CHUNK_MS = 10000;

  const OrigRTC = window.RTCPeerConnection;
  const origGUM = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);

  // ── Make patched functions look native to toString() ───
  const patchedFns = new Map();
  const origToString = Function.prototype.toString;
  Function.prototype.toString = function() {
    const orig = patchedFns.get(this);
    if (orig) return origToString.call(orig);
    return origToString.call(this);
  };
  patchedFns.set(Function.prototype.toString, origToString);

  function maskAsNative(patched, original) {
    patchedFns.set(patched, original);
  }

  let audioCtx = null;
  let mixDest = null;
  let recorder = null;
  let recording = false;
  let sources = new Map();
  let localAdded = false;
  let chunkPosted = Promise.resolve();

  function ensureCtx() {
    if (!audioCtx || audioCtx.state === 'closed') {
      audioCtx = new AudioContext();
      mixDest = audioCtx.createMediaStreamDestination();
    }
    if (audioCtx.state === 'suspended') {
      audioCtx.resume();
    }
    return { ctx: audioCtx, dest: mixDest };
  }

  function addStream(stream, label) {
    const id = stream.id;
    if (sources.has(id)) return;

    try {
      const { ctx, dest } = ensureCtx();
      const src = ctx.createMediaStreamSource(stream);
      const gain = ctx.createGain();
      gain.gain.value = 1.0;
      src.connect(gain);
      gain.connect(dest);
      sources.set(id, { src, gain });
      post('AUDIO_SOURCE_ADDED', { label, streamId: id, total: sources.size });
    } catch (e) {
      // Stream might already be ended
    }
  }

  function startRecording() {
    if (recording || !mixDest) return;
    recording = true;

    const stream = mixDest.stream;
    const tracks = stream.getAudioTracks();
    if (tracks.length === 0) {
      post('ERROR', { msg: 'No audio tracks in mix' });
      return;
    }

    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : 'audio/webm';

    recorder = new MediaRecorder(stream, { mimeType, audioBitsPerSecond: 128000 });

    // Chained so chunks go out in order and the last one before RECORDING_STOPPED.
    recorder.ondataavailable = (e) => {
      if (!e.data || e.data.size === 0) return;
      chunkPosted = chunkPosted.then(async () => {
        try {
          const buf = await e.data.arrayBuffer();
          const b64 = arrayBufToBase64(buf);
          post('AUDIO_CHUNK', { b64, size: e.data.size });
        } catch (err) {
          post('ERROR', { msg: 'chunk transfer failed: ' + err.message });
        }
      });
    };

    recorder.onerror = (e) => {
      post('ERROR', { msg: 'recorder error: ' + (e.error?.message || 'unknown') });
    };

    recorder.start(CHUNK_MS);
    post('RECORDING_ACTIVE', { mimeType });
  }

  function stopRecording() {
    if (!recorder || !recording) return;
    recording = false;

    return new Promise(resolve => {
      recorder.onstop = () => {
        recorder = null;
        chunkPosted.then(() => {
          post('RECORDING_STOPPED', {});
          resolve();
        });
      };
      if (recorder.state !== 'inactive') {
        recorder.stop();
      } else {
        recorder = null;
        post('RECORDING_STOPPED', {});
        resolve();
      }
    });
  }

  // ── Patch RTCPeerConnection (stealth) ───────────────────

  const PatchedRTC = function RTCPeerConnection(...args) {
    const pc = new OrigRTC(...args);

    try {
      pc.addEventListener('track', (ev) => {
        if (ev.track.kind === 'audio') {
          try {
            const s = ev.streams?.[0] || new MediaStream([ev.track]);
            addStream(s, 'remote');
            if (!recording && sources.size > 0) {
              startRecording();
            }
          } catch (e) {}
        }
      });

      const origAddTrack = pc.addTrack?.bind(pc);
      if (origAddTrack) {
        const patchedAddTrack = function addTrack(track, ...streams) {
          try {
            if (track.kind === 'audio' && streams[0]) {
              addStream(streams[0], 'local-send');
            }
          } catch (e) {}
          return origAddTrack(track, ...streams);
        };
        maskAsNative(patchedAddTrack, RTCPeerConnection.prototype.addTrack);
        pc.addTrack = patchedAddTrack;
      }
    } catch (e) {}

    return pc;
  };

  PatchedRTC.prototype = OrigRTC.prototype;
  Object.defineProperty(PatchedRTC, 'length', { value: OrigRTC.length, configurable: true });
  for (const key of Object.getOwnPropertyNames(OrigRTC)) {
    if (key !== 'prototype' && key !== 'name' && key !== 'length') {
      try {
        const desc = Object.getOwnPropertyDescriptor(OrigRTC, key);
        if (desc) Object.defineProperty(PatchedRTC, key, desc);
      } catch (e) {}
    }
  }
  maskAsNative(PatchedRTC, OrigRTC);
  window.RTCPeerConnection = PatchedRTC;

  // ── Patch getUserMedia (stealth) ────────────────────────

  const patchedGUM = function getUserMedia(constraints) {
    return origGUM(constraints).then(function(stream) {
      try {
        if (constraints?.audio && !localAdded) {
          localAdded = true;
          const audioTrack = stream.getAudioTracks()[0];
          if (audioTrack) {
            addStream(new MediaStream([audioTrack.clone()]), 'local-mic');
          }
        }
      } catch (e) {}
      return stream;
    });
  };
  maskAsNative(patchedGUM, origGUM);
  navigator.mediaDevices.getUserMedia = patchedGUM;

  // ── Helpers ──────────────────────────────────────────

  function post(type, data) {
    window.postMessage({ src: MSG_OUT, type, ...data }, '*');
  }

  function arrayBufToBase64(buf) {
    const bytes = new Uint8Array(buf);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 32768) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + 32768, bytes.length)));
    }
    return btoa(bin);
  }

  // ── Listen for commands from content script ──────────

  window.addEventListener('message', (ev) => {
    if (ev.source !== window || ev.data?.src !== MSG_IN) return;
    if (ev.data.type === 'STOP') stopRecording();
    if (ev.data.type === 'START' && !recording && sources.size > 0) startRecording();
  });

  post('INJECTED', { version: '1.2' });
})();
