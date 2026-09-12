// ---------------------------------------------------------------------------
// TUNER — microphone capture + UI wiring
//
// This is the "glue" file: it asks for microphone access, pulls raw audio
// samples out of the Web Audio API, feeds them to detectPitch() (from
// pitch-detect.js), converts the result to a note name with frequencyToNote()
// (from notes.js), and paints the result on screen every animation frame.
// ---------------------------------------------------------------------------

const IN_TUNE_CENTS = 5; // within +-5 cents counts as "in tune", per spec

let audioContext = null;
let analyser = null;
let micStream = null;
let rafId = null;
let timeDomainBuffer = null;

// Raw cents readings jitter a little frame to frame even on a held note.
// A simple exponential moving average smooths that out for display without
// adding noticeable lag. This is cosmetic only — detectPitch() itself is
// unaffected.
let smoothedCents = 0;
const SMOOTHING = 0.25;

const micToggleBtn = document.getElementById('mic-toggle');
const micStatus = document.getElementById('mic-status');
const noteNameEl = document.getElementById('note-name');
const frequencyEl = document.getElementById('frequency');
const centsValueEl = document.getElementById('cents-value');
const centsNeedleEl = document.getElementById('cents-needle');
const tunerDisplay = document.getElementById('tuner-display');
const stringReferenceEl = document.getElementById('string-reference');

function buildStringReference() {
  stringReferenceEl.innerHTML = '';
  STANDARD_TUNING.forEach((s) => {
    const chip = document.createElement('div');
    chip.className = 'string-chip';
    chip.id = `string-${s.string}`;
    chip.innerHTML = `<span class="chip-note">${s.note}${s.octave}</span><span class="chip-string">string ${s.string}</span>`;
    stringReferenceEl.appendChild(chip);
  });
}

async function startTuner() {
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });
  } catch (err) {
    micStatus.textContent = 'Microphone permission denied or unavailable.';
    return;
  }

  audioContext = new (window.AudioContext || window.webkitAudioContext)();
  const source = audioContext.createMediaStreamSource(micStream);
  analyser = audioContext.createAnalyser();

  // fftSize doubles as the length of the time-domain buffer we analyze.
  // Guitar's lowest open string (E2, ~82 Hz) has a period of about 12ms; at
  // a 44.1-48kHz sample rate that's roughly 530-580 samples. Autocorrelation
  // needs several full periods inside the window to find real repetition,
  // but a bigger window also means more lag between playing a note and
  // seeing it on screen. 2048 samples (~43-46ms depending on the audio
  // hardware's sample rate) holds 3-4 full periods of the lowest note,
  // comfortably covers every note up through the high frets, and still
  // updates fast enough to feel instant.
  analyser.fftSize = 2048;
  source.connect(analyser);

  timeDomainBuffer = new Float32Array(analyser.fftSize);

  micToggleBtn.textContent = 'Stop Tuner';
  micStatus.textContent = 'Listening...';
  buildStringReference();
  updateLoop();
}

function stopTuner() {
  if (rafId) cancelAnimationFrame(rafId);
  if (micStream) micStream.getTracks().forEach((t) => t.stop());
  if (audioContext) audioContext.close();
  audioContext = null;
  analyser = null;
  micStream = null;

  micToggleBtn.textContent = 'Start Tuner';
  micStatus.textContent = 'Microphone off';
  noteNameEl.textContent = '––';
  frequencyEl.textContent = '0.0 Hz';
  centsValueEl.textContent = '0 cents';
  centsNeedleEl.style.left = '50%';
  tunerDisplay.classList.remove('in-tune', 'sharp', 'flat');
  document.querySelectorAll('.string-chip').forEach((el) => el.classList.remove('active', 'in-tune'));
}

// Which standard-tuning string is the played frequency closest to? Distance
// is measured in octaves (log2 of the frequency ratio) rather than raw Hz,
// because musical distance is logarithmic: the gap between 82Hz and 87Hz
// (about a semitone) sounds and matters the same as the gap between 330Hz
// and 350Hz, even though the second gap is a much bigger number of Hz.
function closestString(frequency) {
  let closest = STANDARD_TUNING[0];
  let smallestDiff = Infinity;
  for (const s of STANDARD_TUNING) {
    const diff = Math.abs(Math.log2(frequency / s.frequency));
    if (diff < smallestDiff) {
      smallestDiff = diff;
      closest = s;
    }
  }
  return closest;
}

function updateLoop() {
  analyser.getFloatTimeDomainData(timeDomainBuffer);
  const result = detectPitch(timeDomainBuffer, audioContext.sampleRate, 70, 1400);

  if (result) {
    const { frequency } = result;
    const note = frequencyToNote(frequency);

    smoothedCents += SMOOTHING * (note.cents - smoothedCents);
    const displayCents = Math.round(smoothedCents) || 0; // avoid a stray "-0"

    noteNameEl.textContent = `${note.name}${note.octave}`;
    frequencyEl.textContent = `${frequency.toFixed(1)} Hz`;
    centsValueEl.textContent = `${displayCents > 0 ? '+' : ''}${displayCents} cents`;

    // Needle position: clamp to the +-50 cent range shown on the scale and
    // map it onto the 0%..100% width of the track (0 cents = center = 50%).
    const clamped = Math.max(-50, Math.min(50, displayCents));
    centsNeedleEl.style.left = `${clamped + 50}%`;

    const inTune = Math.abs(displayCents) <= IN_TUNE_CENTS;
    tunerDisplay.classList.toggle('in-tune', inTune);
    tunerDisplay.classList.toggle('sharp', !inTune && displayCents > 0);
    tunerDisplay.classList.toggle('flat', !inTune && displayCents < 0);

    const nearest = closestString(frequency);
    document.querySelectorAll('.string-chip').forEach((el) => el.classList.remove('active', 'in-tune'));
    const activeChip = document.getElementById(`string-${nearest.string}`);
    if (activeChip) {
      activeChip.classList.add('active');
      if (inTune && note.name === nearest.note && note.octave === nearest.octave) {
        activeChip.classList.add('in-tune');
      }
    }
  } else {
    noteNameEl.textContent = '––';
    frequencyEl.textContent = '0.0 Hz';
    tunerDisplay.classList.remove('in-tune', 'sharp', 'flat');
  }

  rafId = requestAnimationFrame(updateLoop);
}

micToggleBtn.addEventListener('click', () => {
  if (audioContext) {
    stopTuner();
  } else {
    startTuner();
  }
});
