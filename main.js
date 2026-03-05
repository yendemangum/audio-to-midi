import * as Pitchfinder from 'pitchfinder';
import MidiWriter from 'midi-writer-js';

const TICKS_PER_BEAT = 128; // MidiWriterJS default
const BPM = 120;
const TICKS_PER_SEC = (TICKS_PER_BEAT * BPM) / 60;

const AUDIO_WINDOW_SIZE = 4096;
const AUDIO_HOP_SIZE = 1024;

// Spectral "Speaking Piano" defaults (denser, formant-like)
const SPECTRAL_FFT_SIZE = 2048;
const SPECTRAL_HOP_SIZE = 512; // coarser = fewer events, avoids call-stack overflow; 256–1024 typical

/**
 * Convert frequency (Hz) to MIDI note number (A4 = 69 = 440 Hz).
 */
function freqToMidi(freq) {
  if (freq <= 0 || !Number.isFinite(freq)) return null;
  const n = 69 + 12 * Math.log2(freq / 440);
  return Math.round(n);
}

/** MIDI note number to frequency (Hz). */
function midiToFreq(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

/**
 * In-place radix-2 Cooley–Tukey FFT. Modifies re and im.
 * @param {Float32Array} re - real part
 * @param {Float32Array} im - imaginary part (e.g. zeros for real input)
 */
function bitReverse(i, log2n) {
  let j = 0;
  for (let k = 0; k < log2n; k++) {
    j = (j << 1) | (i & 1);
    i >>= 1;
  }
  return j;
}

function fft(re, im) {
  const N = re.length;
  const log2n = Math.round(Math.log2(N));
  for (let i = 0; i < N; i++) {
    const j = bitReverse(i, log2n);
    if (j > i) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= N; len <<= 1) {
    const half = len >> 1;
    const theta = (-2 * Math.PI) / len;
    const wr = Math.cos(theta);
    const wi = Math.sin(theta);
    for (let i = 0; i < N; i += len) {
      let wre = 1;
      let wim = 0;
      for (let k = 0; k < half; k++) {
        const j = i + k;
        const l = j + half;
        const ure = re[j];
        const uim = im[j];
        const tre = re[l] * wre - im[l] * wim;
        const tim = re[l] * wim + im[l] * wre;
        re[j] = ure + tre;
        im[j] = uim + tim;
        re[l] = ure - tre;
        im[l] = uim - tim;
        const wret = wre * wr - wim * wi;
        wim = wre * wi + wim * wr;
        wre = wret;
      }
    }
  }
}

/**
 * Compute magnitude spectrum from real signal (windowed).
 * Returns Float32Array of length N/2 + 1 (DC and positive frequencies only).
 */
function magnitudeSpectrum(samples, sampleRate) {
  const N = samples.length;
  const re = new Float32Array(N);
  const im = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    re[i] = samples[i];
    im[i] = 0;
  }
  fft(re, im);
  const out = new Float32Array(N / 2 + 1);
  for (let k = 0; k <= N / 2; k++) {
    out[k] = Math.sqrt(re[k] * re[k] + im[k] * im[k]) / N;
  }
  return out;
}

/**
 * RMS of a Float32Array.
 */
function rms(samples) {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / samples.length);
}

/**
 * Decode audio file to AudioBuffer (mono, resampled to 44100 if needed).
 */
async function decodeAudio(file) {
  const arrayBuffer = await file.arrayBuffer();
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  const buffer = await ctx.decodeAudioData(arrayBuffer);
  const sampleRate = buffer.sampleRate;
  let channel = buffer.getChannelData(0);
  if (buffer.numberOfChannels > 1) {
    const mono = new Float32Array(buffer.length);
    const ch1 = buffer.getChannelData(0);
    const ch2 = buffer.getChannelData(1);
    for (let i = 0; i < buffer.length; i++) mono[i] = (ch1[i] + ch2[i]) / 2;
    channel = mono;
  }
  return { channel, sampleRate, duration: buffer.duration };
}

/**
 * One-pole high-pass filter (in-place). Removes rumble below cutoffHz.
 */
function highPassFilter(samples, sampleRate, cutoffHz) {
  const rc = 1 / (2 * Math.PI * cutoffHz);
  const dt = 1 / sampleRate;
  const alpha = rc / (rc + dt);
  let y1 = 0;
  let x1 = 0;
  for (let i = 0; i < samples.length; i++) {
    const x = samples[i];
    const y = alpha * (y1 + x - x1);
    y1 = y;
    x1 = x;
    samples[i] = y;
  }
}

/**
 * Estimate noise magnitude spectrum from first N seconds of audio (same FFT/hop as analysis).
 */
function estimateNoiseProfile(channel, sampleRate, fftSize, hopSize, durationSec) {
  const numBins = fftSize / 2 + 1;
  const profile = new Float32Array(numBins);
  const window = new Float32Array(fftSize);
  const maxSamples = Math.min(channel.length, Math.ceil(durationSec * sampleRate) - fftSize);
  let count = 0;
  for (let i = 0; i + fftSize <= maxSamples && i >= 0; i += hopSize) {
    for (let j = 0; j < fftSize; j++) window[j] = channel[i + j];
    applyHann(window);
    const mag = magnitudeSpectrum(window, sampleRate);
    for (let k = 0; k < numBins; k++) profile[k] += mag[k];
    count++;
  }
  if (count > 0) {
    for (let k = 0; k < numBins; k++) profile[k] /= count;
  }
  return profile;
}

/**
 * Run YIN pitch detection over the buffer; return array of { time, freq, amplitude }.
 */
function detectPitchAndAmplitude(channel, sampleRate) {
  const detectPitch = Pitchfinder.YIN({ threshold: 0.2, sampleRate });
  const step = AUDIO_HOP_SIZE;
  const windowSize = Math.min(AUDIO_WINDOW_SIZE, channel.length);
  const results = [];

  for (let i = 0; i + windowSize <= channel.length; i += step) {
    const window = channel.subarray(i, i + windowSize);
    const time = i / sampleRate;
    const freq = detectPitch(window);
    const amplitude = rms(window);
    results.push({ time, freq: freq && freq > 0 ? freq : null, amplitude });
  }

  return results;
}

/**
 * Smooth pitch with a simple median filter over N frames (N = 2 * smoothing + 1).
 */
function smoothPitch(frames, smoothing) {
  if (smoothing <= 0) return frames;
  const radius = Math.min(smoothing, Math.floor(frames.length / 2));
  const out = frames.map((f) => ({ ...f }));

  for (let i = 0; i < frames.length; i++) {
    const start = Math.max(0, i - radius);
    const end = Math.min(frames.length, i + radius + 1);
    const valid = [];
    for (let j = start; j < end; j++) {
      if (frames[j].freq != null && frames[j].freq > 0) valid.push(frames[j].freq);
    }
    if (valid.length > 0) {
      valid.sort((a, b) => a - b);
      out[i].freq = valid[Math.floor(valid.length / 2)];
    }
  }
  return out;
}

/**
 * Convert analysis frames to discrete MIDI notes: merge consecutive same pitch, enforce min duration.
 */
function framesToNotes(frames, minMidi, maxMidi, minDurationSec, sensitivity) {
  const notes = [];
  let i = 0;

  while (i < frames.length) {
    const f = frames[i];
    if (f.freq == null || f.freq <= 0) {
      i++;
      continue;
    }
    let midi = freqToMidi(f.freq);
    if (midi == null) {
      i++;
      continue;
    }
    midi = Math.max(minMidi, Math.min(maxMidi, midi));

    const startTime = f.time;
    let amplitudeSum = f.amplitude;
    let count = 1;
    let j = i + 1;

    while (j < frames.length) {
      const next = frames[j];
      const nextFreq = next.freq;
      if (nextFreq == null || nextFreq <= 0) break;
      let nextMidi = freqToMidi(nextFreq);
      if (nextMidi == null) break;
      nextMidi = Math.max(minMidi, Math.min(maxMidi, nextMidi));
      if (nextMidi !== midi) break;
      amplitudeSum += next.amplitude;
      count++;
      j++;
    }

    const hop = (frames[1]?.time - frames[0]?.time) || 0.02;
    const endTime = j < frames.length ? frames[j].time : frames[j - 1].time + hop;
    const duration = endTime - startTime;
    if (duration >= minDurationSec) {
      const avgAmplitude = amplitudeSum / count;
      notes.push({
        midi,
        startTime,
        duration,
        velocity: amplitudeToVelocity(avgAmplitude, sensitivity),
      });
    }
    i = j;
  }

  return notes;
}

function amplitudeToVelocity(amplitude, sensitivity) {
  const v = Math.min(1, amplitude * (1 + sensitivity * 2));
  return Math.round(40 + v * 80);
}

// ---------- Spectral "Speaking Piano" pipeline ----------

/**
 * Apply Hann window in-place.
 */
function applyHann(samples) {
  const N = samples.length;
  for (let i = 0; i < N; i++) {
    samples[i] *= 0.5 * (1 - Math.cos((2 * Math.PI * i) / (N - 1)));
  }
}

/**
 * Pre-emphasis filter (boost highs) so formants and consonants are clearer.
 * y[n] = x[n] - coef * x[n-1]. Applied in-place.
 */
function preEmphasis(samples, coef = 0.97) {
  for (let i = samples.length - 1; i >= 1; i--) {
    samples[i] -= coef * samples[i - 1];
  }
}

/**
 * Smooth magnitude spectrum (3-bin moving average) for formant peak detection.
 */
function smoothSpectrum(mag, radius = 2) {
  const out = new Float32Array(mag.length);
  for (let k = 0; k < mag.length; k++) {
    let sum = 0;
    let count = 0;
    for (let j = Math.max(0, k - radius); j <= Math.min(mag.length - 1, k + radius); j++) {
      sum += mag[j];
      count++;
    }
    out[k] = sum / count;
  }
  return out;
}

/**
 * Find local maxima in smoothed spectrum (formant peaks). Returns bin indices.
 */
function findFormantPeaks(smoothMag, minProminence = 0.05) {
  const peaks = [];
  const len = smoothMag.length;
  for (let k = 2; k < len - 2; k++) {
    const c = smoothMag[k];
    if (c < minProminence) continue;
    if (c >= smoothMag[k - 1] && c >= smoothMag[k - 2] && c >= smoothMag[k + 1] && c >= smoothMag[k + 2]) {
      peaks.push(k);
    }
  }
  return peaks;
}

/**
 * Analyze audio into overlapping spectral frames (magnitude spectrum + F0 per time).
 * Options: { noiseProfile, noiseGateRatio } for noise reduction (subtract profile, gate quiet frames).
 */
function spectralAnalysis(channel, sampleRate, fftSize, hopSize, options = {}) {
  const work = new Float32Array(channel.length);
  work.set(channel);
  preEmphasis(work, 0.97);

  const detectPitch = Pitchfinder.YIN({ threshold: 0.15, sampleRate });
  const frames = [];
  const window = new Float32Array(fftSize);
  const binFreq = sampleRate / fftSize;
  const { noiseProfile, noiseGateRatio = 0.15 } = options;
  const oversubtract = 1.2;

  for (let i = 0; i + fftSize <= work.length; i += hopSize) {
    for (let j = 0; j < fftSize; j++) window[j] = work[i + j];
    applyHann(window);
    const mag = magnitudeSpectrum(window, sampleRate);
    let magnitudes = mag;
    if (noiseProfile && noiseProfile.length === mag.length) {
      magnitudes = new Float32Array(mag.length);
      for (let k = 0; k < mag.length; k++) {
        magnitudes[k] = Math.max(0, mag[k] - oversubtract * noiseProfile[k]);
      }
    }
    const f0 = detectPitch(window);
    frames.push({
      time: i / sampleRate,
      magnitudes,
      binFreq,
      f0: f0 && f0 > 0 ? f0 : null,
    });
  }

  if (noiseGateRatio > 0 && frames.length > 0) {
    let sumEnergy = 0;
    for (const fr of frames) {
      let e = 0;
      for (let k = 0; k < fr.magnitudes.length; k++) e += fr.magnitudes[k];
      sumEnergy += e;
    }
    const avgEnergy = sumEnergy / frames.length;
    const gateThreshold = avgEnergy * noiseGateRatio;
    for (const fr of frames) {
      let e = 0;
      for (let k = 0; k < fr.magnitudes.length; k++) e += fr.magnitudes[k];
      if (e < gateThreshold) {
        for (let k = 0; k < fr.magnitudes.length; k++) fr.magnitudes[k] = 0;
      }
    }
  }

  return frames;
}

/** Max notes per spectral frame to avoid stack overflow and keep file size/playback sane. */
const MAX_NOTES_PER_SPECTRAL_FRAME = 28;

/** Speech band (Hz): emphasize this range for clearer vowels/consonants. */
const SPEECH_BAND_LOW = 200;
const SPEECH_BAND_HIGH = 4200;

/**
 * Band aggregation: sum magnitude over bins within ±0.5 semitone of each MIDI note.
 * Returns energy per MIDI note (0..127).
 */
function magnitudeToNoteBands(magnitudes, binFreq, minMidi, maxMidi) {
  const noteEnergy = new Float32Array(128);
  noteEnergy.fill(0);
  const numBins = magnitudes.length;
  const halfSemitone = Math.pow(2, 1 / 24);

  for (let m = minMidi; m <= maxMidi; m++) {
    const fCenter = midiToFreq(m);
    const fLo = fCenter / halfSemitone;
    const fHi = fCenter * halfSemitone;
    let sum = 0;
    for (let k = 1; k < numBins - 1; k++) {
      const f = k * binFreq;
      if (f >= fLo && f <= fHi) sum += magnitudes[k];
    }
    noteEnergy[m] = sum;
  }
  return noteEnergy;
}

/**
 * Weight for speech band: 1 in [SPEECH_BAND_LOW, SPEECH_BAND_HIGH], rolloff outside.
 */
function speechBandWeight(freq) {
  if (freq >= SPEECH_BAND_LOW && freq <= SPEECH_BAND_HIGH) return 1;
  if (freq < SPEECH_BAND_LOW) return Math.max(0.2, freq / SPEECH_BAND_LOW);
  return Math.max(0.2, (SPEECH_BAND_HIGH + 1000 - freq) / 1000);
}

/**
 * Map spectrum to MIDI notes with band aggregation, F0 boost, and formant emphasis.
 */
function spectralFrameToNotes(frame, minMidi, maxMidi, threshold, sensitivity) {
  const { magnitudes, binFreq, f0 } = frame;
  const numBins = magnitudes.length;
  const noteEnergy = magnitudeToNoteBands(magnitudes, binFreq, minMidi, maxMidi);

  // Speech-band weighting: emphasize 200–4200 Hz
  for (let m = minMidi; m <= maxMidi; m++) {
    const f = midiToFreq(m);
    noteEnergy[m] *= speechBandWeight(f);
  }

  // F0 reinforcement: boost the fundamental so pitch of voice is clear
  if (f0 != null && f0 > 0) {
    const m0 = freqToMidi(f0);
    if (m0 != null && m0 >= minMidi && m0 <= maxMidi) {
      noteEnergy[m0] *= 1.8;
    }
  }

  // Formant peak emphasis: boost MIDI notes at spectral peaks
  const smoothMag = smoothSpectrum(magnitudes, 2);
  const prominence = Math.max(0.03, 0.15 * (magnitudes.reduce((a, b) => a + b, 0) / numBins));
  const peakBins = findFormantPeaks(smoothMag, prominence);
  for (const k of peakBins) {
    const freq = k * binFreq;
    const m = freqToMidi(freq);
    if (m != null && m >= minMidi && m <= maxMidi) {
      noteEnergy[m] *= 1.4;
    }
  }

  let maxE = 0;
  for (let m = minMidi; m <= maxMidi; m++) if (noteEnergy[m] > maxE) maxE = noteEnergy[m];
  if (maxE <= 0) return [];
  maxE = maxE || 1;
  const notes = [];
  for (let m = minMidi; m <= maxMidi; m++) {
    const e = noteEnergy[m];
    if (e < maxE * threshold) continue;
    const vel = Math.round(40 + Math.min(1, (e / maxE) * (0.5 + sensitivity)) * 87);
    notes.push({ midi: m, velocity: Math.min(127, Math.max(1, vel)), energy: e });
  }
  if (notes.length > MAX_NOTES_PER_SPECTRAL_FRAME) {
    notes.sort((a, b) => b.energy - a.energy);
    notes.length = MAX_NOTES_PER_SPECTRAL_FRAME;
  }
  return notes.map(({ midi, velocity }) => ({ midi, velocity }));
}

/**
 * Convert spectral frames to a flat list of note events (polyphonic: same startTime for chords).
 */
function spectralFramesToNotes(frames, minMidi, maxMidi, threshold, sensitivity, grainDurationSec) {
  const notes = [];
  for (const frame of frames) {
    const chord = spectralFrameToNotes(frame, minMidi, maxMidi, threshold, sensitivity);
    for (const n of chord) {
      notes.push({
        midi: n.midi,
        startTime: frame.time,
        duration: grainDurationSec,
        velocity: n.velocity,
      });
    }
  }
  return notes;
}

/**
 * Variable-length quantity for MIDI delta times (no recursion).
 */
function midiVarLen(ticks) {
  ticks = Math.round(ticks) >>> 0;
  const out = [];
  out.unshift(ticks & 0x7f);
  ticks >>>= 7;
  while (ticks) {
    out.unshift((ticks & 0x7f) | 0x80);
    ticks >>>= 7;
  }
  return out;
}

/**
 * Build MIDI track bytes manually using bucket sort (no Array.sort on full list).
 * Avoids call-stack overflow from MidiWriterJS when there are many explicit-tick events.
 */
function buildMidiSpectral(notes) {
  let maxTick = 0;
  for (const note of notes) {
    const startTick = Math.round(note.startTime * TICKS_PER_SEC);
    const durationTicks = Math.max(1, Math.round(note.duration * TICKS_PER_SEC));
    const endTick = startTick + durationTicks;
    if (endTick > maxTick) maxTick = endTick;
  }
  const buckets = Array.from({ length: maxTick + 1 }, () => ({ ons: [], offs: [] }));

  for (const note of notes) {
    const startTick = Math.round(note.startTime * TICKS_PER_SEC);
    const durationTicks = Math.max(1, Math.round(note.duration * TICKS_PER_SEC));
    const endTick = startTick + durationTicks;
    const vel = Math.min(127, Math.max(1, note.velocity));
    buckets[startTick].ons.push({ midi: note.midi, vel });
    if (endTick <= maxTick) buckets[endTick].offs.push({ midi: note.midi });
  }

  const flat = [];
  const NOTE_ON = 0x90;
  const NOTE_OFF = 0x80;
  flat.push(...midiVarLen(0), 0xff, 0x51, 0x03, (500000 >> 16) & 0xff, (500000 >> 8) & 0xff, 500000 & 0xff);
  flat.push(...midiVarLen(0), 0xc0, 0);
  let lastTick = 0;
  for (let tick = 0; tick <= maxTick; tick++) {
    const bucket = buckets[tick];
    if (bucket.ons.length === 0 && bucket.offs.length === 0) continue;
    let delta = tick - lastTick;
    lastTick = tick;
    for (const { midi, vel } of bucket.ons) {
      flat.push(...midiVarLen(delta), NOTE_ON, midi, vel);
      delta = 0;
    }
    for (const { midi } of bucket.offs) {
      flat.push(...midiVarLen(delta), NOTE_OFF, midi, 0);
      delta = 0;
    }
  }
  flat.push(...midiVarLen(0), 0xff, 0x2f, 0x00);

  const header = [0x4d, 0x54, 0x68, 0x64, 0x00, 0x00, 0x00, 0x06, 0x00, 0x00, 0x00, 0x01, 0x00, 0x80];
  const trackHeader = [0x4d, 0x54, 0x72, 0x6b];
  const trackLen = [(flat.length >> 24) & 0xff, (flat.length >> 16) & 0xff, (flat.length >> 8) & 0xff, flat.length & 0xff];
  const all = [...header, ...trackHeader, ...trackLen, ...flat];
  const blob = new Blob([new Uint8Array(all)], { type: 'audio/midi' });
  const base64 = btoa(String.fromCharCode(...all));
  return { blob, base64 };
}

/**
 * Build MIDI file from notes (melody mode). For spectral, use buildMidiSpectral to avoid stack overflow.
 */
function buildMidi(notes) {
  const track = new MidiWriter.Track();
  track.setTempo(BPM);
  track.addEvent(new MidiWriter.ProgramChangeEvent({ instrument: 0 })); // Acoustic Grand Piano

  for (const note of notes) {
    const startTick = Math.round(note.startTime * TICKS_PER_SEC);
    const durationTicks = Math.max(1, Math.round(note.duration * TICKS_PER_SEC));
    const pitchName = midiToPitchName(note.midi);
    track.addEvent(
      new MidiWriter.NoteEvent({
        pitch: pitchName,
        duration: `T${durationTicks}`,
        startTick,
        velocity: note.velocity,
      })
    );
  }

  const writer = new MidiWriter.Writer(track);
  const base64 = writer.base64();
  const binary = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  return { blob: new Blob([binary], { type: 'audio/midi' }), base64 };
}

const PITCH_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

function midiToPitchName(midi) {
  const octave = Math.floor(midi / 12) - 1;
  const name = PITCH_NAMES[midi % 12];
  return `${name}${octave}`;
}

// --- UI ---

const dropzone = document.getElementById('dropzone');
const fileInput = document.getElementById('fileInput');
const browseBtn = document.getElementById('browseBtn');
const controls = document.getElementById('controls');
const status = document.getElementById('status');
const statusText = document.getElementById('statusText');
const result = document.getElementById('result');
const resultInfo = document.getElementById('resultInfo');
const downloadBtn = document.getElementById('downloadBtn');
const convertBtn = document.getElementById('convertBtn');
const minNoteEl = document.getElementById('minNote');
const maxNoteEl = document.getElementById('maxNote');
const sensitivityEl = document.getElementById('sensitivity');
const sensitivityValue = document.getElementById('sensitivityValue');
const minDurationEl = document.getElementById('minDuration');
const smoothingEl = document.getElementById('smoothing');
const smoothingValue = document.getElementById('smoothingValue');
const modeEl = document.getElementById('mode');
const modeHint = document.getElementById('modeHint');
const spectralControls = document.getElementById('spectralControls');
const spectralThresholdEl = document.getElementById('spectralThreshold');
const spectralThresholdValue = document.getElementById('spectralThresholdValue');
const hopSizeEl = document.getElementById('hopSize');
const noiseReduceEl = document.getElementById('noiseReduce');
const melodyControls = document.getElementById('melodyControls');
const smoothingControls = document.getElementById('smoothingControls');

let currentFile = null;
let lastMidiBlob = null;
let lastName = 'speech.mid';

function showStatus(message, type = 'progress') {
  status.hidden = false;
  status.className = `status ${type}`;
  statusText.textContent = message;
}

function hideStatus() {
  status.hidden = true;
}

function showResult(info) {
  result.hidden = false;
  resultInfo.textContent = info;
}

function hideResult() {
  result.hidden = true;
  lastMidiBlob = null;
}

dropzone.addEventListener('click', () => fileInput.click());
browseBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  fileInput.click();
});

dropzone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropzone.classList.add('dragover');
});
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropzone.classList.remove('dragover');
  const file = e.dataTransfer?.files?.[0];
  if (file?.type?.startsWith('audio/')) setFile(file);
});

fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0];
  if (file) setFile(file);
});

function setFile(file) {
  currentFile = file;
  controls.hidden = false;
  hideResult();
  hideStatus();
  const name = file.name.replace(/\.[^.]+$/, '') || 'speech';
  lastName = `${name}.mid`;
}

function updateModeUI() {
  const isSpectral = modeEl.value === 'spectral';
  spectralControls.style.display = isSpectral ? 'block' : 'none';
  melodyControls.classList.toggle('visible', !isSpectral);
  smoothingControls.classList.toggle('visible', !isSpectral);
  modeHint.textContent = isSpectral
    ? 'Multiple notes at once — piano "says" the words (like Ablinger / Chopstix).'
    : 'Single-note melody following voice pitch.';
}
modeEl.addEventListener('change', updateModeUI);
updateModeUI();

sensitivityEl.addEventListener('input', () => {
  sensitivityValue.textContent = sensitivityEl.value;
});
smoothingEl.addEventListener('input', () => {
  smoothingValue.textContent = smoothingEl.value;
});
spectralThresholdEl.addEventListener('input', () => {
  spectralThresholdValue.textContent = spectralThresholdEl.value;
});

convertBtn.addEventListener('click', async () => {
  if (!currentFile) return;
  const minNote = Math.max(0, Math.min(127, parseInt(minNoteEl.value, 10) || 36));
  const maxNote = Math.max(0, Math.min(127, parseInt(maxNoteEl.value, 10) || 72));
  const minDurationMs = Math.max(20, Math.min(500, parseInt(minDurationEl.value, 10) || 60));
  const sensitivity = parseFloat(sensitivityEl.value) || 0.5;
  const smoothing = parseInt(smoothingEl.value, 10) || 0;
  const spectralThreshold = parseFloat(spectralThresholdEl.value) || 0.12;
  const isSpectral = modeEl.value === 'spectral';

  convertBtn.disabled = true;
  showStatus('Decoding audio…', 'progress');

  try {
    let { channel, sampleRate, duration } = await decodeAudio(currentFile);
    const noiseReduce = noiseReduceEl.checked;

    if (noiseReduce) {
      showStatus('Reducing noise…', 'progress');
      const work = new Float32Array(channel.length);
      work.set(channel);
      highPassFilter(work, sampleRate, 80);
      channel = work;
    }

    let notes;

    if (isSpectral) {
      showStatus('Analyzing spectrum…', 'progress');
      const hopSize = Math.min(1024, Math.max(128, Math.round((parseInt(hopSizeEl.value, 10) || 512) / 128) * 128));
      const options = {};
      if (noiseReduce) {
        options.noiseProfile = estimateNoiseProfile(channel, sampleRate, SPECTRAL_FFT_SIZE, hopSize, 0.5);
        options.noiseGateRatio = 0.15;
      }
      const frames = spectralAnalysis(channel, sampleRate, SPECTRAL_FFT_SIZE, hopSize, options);
      const grainDurationSec = hopSize / sampleRate;
      notes = spectralFramesToNotes(
        frames,
        minNote,
        maxNote,
        spectralThreshold,
        sensitivity,
        grainDurationSec
      );
    } else {
      showStatus('Detecting pitch…', 'progress');
      let frames = detectPitchAndAmplitude(channel, sampleRate);
      if (noiseReduce && frames.length > 0) {
        let sumAmp = 0;
        for (const f of frames) sumAmp += f.amplitude;
        const avgAmp = sumAmp / frames.length;
        const gate = 0.15 * avgAmp;
        for (const f of frames) {
          if (f.amplitude < gate) f.freq = null;
        }
      }
      frames = smoothPitch(frames, smoothing);
      const minDurationSec = minDurationMs / 1000;
      notes = framesToNotes(frames, minNote, maxNote, minDurationSec, sensitivity);
    }

    showStatus('Building MIDI…', 'progress');
    const { blob } = isSpectral ? buildMidiSpectral(notes) : buildMidi(notes);
    lastMidiBlob = blob;
    const uniqueTimes = new Set(notes.map((n) => n.startTime)).size;
    showStatus(`Done. ${notes.length} notes (${uniqueTimes} time slices) · ${duration.toFixed(1)}s.`, 'success');
    showResult(`${notes.length} notes · ${duration.toFixed(1)}s · Ready to download.`);
  } catch (err) {
    console.error(err);
    showStatus(`Error: ${err.message}`, 'progress');
    hideResult();
  } finally {
    convertBtn.disabled = false;
  }
});

downloadBtn.addEventListener('click', () => {
  if (!lastMidiBlob) return;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(lastMidiBlob);
  a.download = lastName;
  a.click();
  URL.revokeObjectURL(a.href);
});
