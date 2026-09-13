// ---------------------------------------------------------------------------
// TUNER — microphone capture + UI wiring
//
// This is the "glue" file: it asks for microphone access, pulls raw audio
// samples out of the Web Audio API, feeds them to detectPitch() (from
// pitch-detect.js), converts the result to a note name with frequencyToNote()
// (from notes.js), and paints the result on screen every animation frame.
// ---------------------------------------------------------------------------

const IN_TUNE_CENTS = 5; // within +-5 cents counts as "in tune", per spec

// INSTRUMENTS (guitar/bass analysis settings) lives in notes.js since
// drill.js needs it too.
let currentInstrument = 'guitar';

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
const instrumentButtons = document.querySelectorAll('.instrument-btn');

function buildStringReference() {
  const tuning = INSTRUMENTS[currentInstrument].tuning;
  stringReferenceEl.innerHTML = '';
  tuning.forEach((s) => {
    const chip = document.createElement('div');
    chip.className = 'string-chip';
    chip.id = `string-${s.string}`;
    chip.innerHTML = `<span class="chip-note">${s.note}${s.octave}</span><span class="chip-string">string ${s.string}</span>`;
    stringReferenceEl.appendChild(chip);
  });
}

// Switching instruments mid-session (even while the mic is listening) just
// means: use a different tuning table for comparison, and — since a bass
// string's lower pitch needs a longer analysis window — resize the buffer
// we're pulling from the AnalyserNode. AnalyserNode.fftSize can be changed
// on an already-connected node at any time, so there's no need to tear down
// and rebuild the whole audio graph or ask for the microphone again.
function selectInstrument(name) {
  currentInstrument = name;
  smoothedCents = 0;

  instrumentButtons.forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.instrument === name);
  });

  if (analyser) {
    analyser.fftSize = INSTRUMENTS[name].fftSize;
    timeDomainBuffer = new Float32Array(analyser.fftSize);
  }

  buildStringReference();
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

  // fftSize doubles as the length of the time-domain buffer we analyze. See
  // the INSTRUMENTS table above for how this is chosen per instrument: it
  // needs to hold several full periods of that instrument's lowest note, but
  // a bigger window also means more lag between playing a note and seeing it
  // on screen, so we don't make it any bigger than each instrument needs.
  analyser.fftSize = INSTRUMENTS[currentInstrument].fftSize;
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
  const tuning = INSTRUMENTS[currentInstrument].tuning;
  let closest = tuning[0];
  let smallestDiff = Infinity;
  for (const s of tuning) {
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
  const { minFreq, maxFreq } = INSTRUMENTS[currentInstrument];
  const result = detectPitch(timeDomainBuffer, audioContext.sampleRate, minFreq, maxFreq);

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

instrumentButtons.forEach((btn) => {
  btn.addEventListener('click', () => selectInstrument(btn.dataset.instrument));
});

// Build the guitar string chips immediately so the reference row isn't
// empty before the user presses Start Tuner.
buildStringReference();
