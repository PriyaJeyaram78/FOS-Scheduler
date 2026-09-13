// ---------------------------------------------------------------------------
// FRETBOARD DRILL — "what note is this, and can you play it?"
//
// The app picks a random string + fret from whatever range you've chosen,
// tells you the note name, and draws a dot on a fretboard diagram showing
// exactly where to put your finger. You play it; the same pitch-detection
// pipeline from the tuner (detectPitch() + frequencyToNote()) checks
// whether what came out of the mic matches.
//
// The key idea that makes this different from the tuner: a fret position
// maps to an EXACT note (not just a pitch class), and that mapping is pure
// arithmetic once you think in MIDI note numbers instead of Hz. Each fret
// is one semitone, and one semitone is +1 in MIDI numbering, so:
//
//     midiAtFret(string, fret) = openStringMidi(string) + fret
//
// No frequency math needed for that part at all — frequency only comes
// back into it when we convert what the mic heard into a MIDI number
// (via frequencyToNote) so the two can be compared directly.
// ---------------------------------------------------------------------------

let drillInstrument = 'guitar';
let selectedStrings = new Set();
let maxFret = 5;

let currentPrompt = null; // { string, fret, midi, name, octave }
let score = { correct: 0, total: 0 };
let awaitingNext = false; // true during the "Correct!" pause between prompts
const cellByKey = {}; // `${string}-${fret}` -> fretboard cell element

let drillAudioContext = null;
let drillAnalyser = null;
let drillMicStream = null;
let drillRafId = null;
let drillBuffer = null;

const drillInstrumentButtons = document.querySelectorAll('#drill-instrument-select .instrument-btn');
const drillSettingsEl = document.getElementById('drill-settings');
const stringPickerEl = document.getElementById('drill-string-picker');
const fretRadios = document.querySelectorAll('input[name="fret-range"]');
const drillToggleBtn = document.getElementById('drill-toggle');
const drillStatusEl = document.getElementById('drill-status');
const promptEl = document.getElementById('drill-prompt');
const feedbackEl = document.getElementById('drill-feedback');
const fretboardEl = document.getElementById('fretboard');
const scoreEl = document.getElementById('drill-score');

// Frets where real guitars/basses put inlay dots, just for visual
// familiarity — purely decorative, doesn't affect the drill logic.
const INLAY_FRETS = new Set([3, 5, 7, 9, 12]);

function tuningFor(instrument) {
  return INSTRUMENTS[instrument].tuning;
}

function buildStringPicker() {
  selectedStrings = new Set(tuningFor(drillInstrument).map((s) => s.string));
  stringPickerEl.innerHTML = '';

  [...tuningFor(drillInstrument)]
    .sort((a, b) => a.string - b.string)
    .forEach((s) => {
      const label = document.createElement('label');
      label.className = 'string-checkbox';
      label.innerHTML = `<input type="checkbox" checked data-string="${s.string}"> String ${s.string} (${s.note}${s.octave})`;
      const checkbox = label.querySelector('input');
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) {
          selectedStrings.add(s.string);
        } else if (selectedStrings.size > 1) {
          selectedStrings.delete(s.string);
        } else {
          // Always leave at least one string selected, or the drill would
          // have nothing to pick from.
          checkbox.checked = true;
        }
      });
      stringPickerEl.appendChild(label);
    });
}

function buildFretboard() {
  fretboardEl.innerHTML = '';
  fretboardEl.style.gridTemplateColumns = `90px repeat(${maxFret + 1}, minmax(28px, 1fr))`;
  Object.keys(cellByKey).forEach((k) => delete cellByKey[k]);

  // Header row: fret numbers, with a small dot under the standard inlay
  // frets so this reads like a real fretboard instead of a bare grid.
  const corner = document.createElement('div');
  corner.className = 'fret-header';
  fretboardEl.appendChild(corner);
  for (let f = 0; f <= maxFret; f++) {
    const header = document.createElement('div');
    header.className = 'fret-header';
    header.innerHTML = `${f}${INLAY_FRETS.has(f) ? '<span class="inlay-dot"></span>' : ''}`;
    fretboardEl.appendChild(header);
  }

  // One row per string, low-numbered (high-pitched) string at the top —
  // this matches how guitar tab is conventionally written.
  const rows = [...tuningFor(drillInstrument)].sort((a, b) => a.string - b.string);
  rows.forEach((s) => {
    const label = document.createElement('div');
    label.className = 'string-label';
    label.textContent = `${s.string} (${s.note}${s.octave})`;
    fretboardEl.appendChild(label);

    for (let f = 0; f <= maxFret; f++) {
      const cell = document.createElement('div');
      cell.className = 'fret-cell';
      if (f === 0) cell.classList.add('open-string');
      fretboardEl.appendChild(cell);
      cellByKey[`${s.string}-${f}`] = cell;
    }
  });
}

function clearFretboardHighlights() {
  Object.values(cellByKey).forEach((cell) => cell.classList.remove('target', 'correct'));
}

function showTargetOnFretboard() {
  clearFretboardHighlights();
  const cell = cellByKey[`${currentPrompt.string}-${currentPrompt.fret}`];
  if (cell) cell.classList.add('target');
}

function generatePrompt() {
  const candidates = tuningFor(drillInstrument).filter((s) => selectedStrings.has(s.string));
  let next;
  do {
    const s = candidates[Math.floor(Math.random() * candidates.length)];
    const fret = Math.floor(Math.random() * (maxFret + 1));
    const midi = s.midi + fret;
    const { name, octave } = midiToNote(midi);
    next = { string: s.string, fret, midi, name, octave };
    // Re-roll on an exact repeat of the last prompt so two in a row aren't
    // identical (when there's more than one possible prompt to pick from).
  } while (currentPrompt && next.midi === currentPrompt.midi && next.string === currentPrompt.string && candidates.length * (maxFret + 1) > 1);
  return next;
}

function updateScoreDisplay() {
  const pct = score.total > 0 ? Math.round((score.correct / score.total) * 100) : 0;
  scoreEl.textContent = `Score: ${score.correct} / ${score.total}${score.total > 0 ? ` (${pct}%)` : ''}`;
}

function nextPrompt() {
  currentPrompt = generatePrompt();
  promptEl.textContent = `Play ${currentPrompt.name}${currentPrompt.octave} on string ${currentPrompt.string}`;
  feedbackEl.textContent = 'Listening...';
  feedbackEl.className = 'drill-feedback';
  showTargetOnFretboard();
}

function registerCorrect() {
  score.correct++;
  score.total++;
  updateScoreDisplay();

  feedbackEl.textContent = 'Correct!';
  feedbackEl.className = 'drill-feedback correct';
  const cell = cellByKey[`${currentPrompt.string}-${currentPrompt.fret}`];
  if (cell) cell.classList.add('correct');

  awaitingNext = true;
  setTimeout(() => {
    awaitingNext = false;
    nextPrompt();
  }, 700);
}

function skipPrompt() {
  if (!currentPrompt || awaitingNext) return;
  score.total++;
  updateScoreDisplay();
  nextPrompt();
}

function setSettingsEnabled(enabled) {
  drillSettingsEl.disabled = !enabled;
  drillInstrumentButtons.forEach((btn) => { btn.disabled = !enabled; });
}

async function startDrill() {
  try {
    drillMicStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
  } catch (err) {
    drillStatusEl.textContent = 'Microphone permission denied or unavailable.';
    return;
  }

  drillAudioContext = new (window.AudioContext || window.webkitAudioContext)();
  const source = drillAudioContext.createMediaStreamSource(drillMicStream);
  drillAnalyser = drillAudioContext.createAnalyser();
  drillAnalyser.fftSize = INSTRUMENTS[drillInstrument].fftSize;
  source.connect(drillAnalyser);
  drillBuffer = new Float32Array(drillAnalyser.fftSize);

  score = { correct: 0, total: 0 };
  updateScoreDisplay();
  setSettingsEnabled(false);
  drillToggleBtn.textContent = 'Stop Drill';
  drillStatusEl.textContent = 'Listening...';

  nextPrompt();
  drillLoop();
}

function stopDrill() {
  if (drillRafId) cancelAnimationFrame(drillRafId);
  if (drillMicStream) drillMicStream.getTracks().forEach((t) => t.stop());
  if (drillAudioContext) drillAudioContext.close();
  drillAudioContext = null;
  drillAnalyser = null;
  drillMicStream = null;
  currentPrompt = null;
  awaitingNext = false;

  setSettingsEnabled(true);
  drillToggleBtn.textContent = 'Start Drill';
  drillStatusEl.textContent = 'Microphone off';
  promptEl.textContent = 'Press Start Drill to begin';
  feedbackEl.textContent = '';
  feedbackEl.className = 'drill-feedback';
  clearFretboardHighlights();
}

function drillLoop() {
  drillAnalyser.getFloatTimeDomainData(drillBuffer);

  if (!awaitingNext && currentPrompt) {
    const { minFreq, maxFreq } = INSTRUMENTS[drillInstrument];
    const result = detectPitch(drillBuffer, drillAudioContext.sampleRate, minFreq, maxFreq);
    if (result) {
      const note = frequencyToNote(result.frequency);
      if (note.midi === currentPrompt.midi) {
        registerCorrect();
      } else {
        feedbackEl.textContent = `Heard ${note.name}${note.octave} — try again`;
        feedbackEl.className = 'drill-feedback wrong';
      }
    }
  }

  drillRafId = requestAnimationFrame(drillLoop);
}

function resetDrillIfRunning() {
  if (drillAudioContext) stopDrill();
}

drillInstrumentButtons.forEach((btn) => {
  btn.addEventListener('click', () => {
    resetDrillIfRunning();
    drillInstrument = btn.dataset.instrument;
    drillInstrumentButtons.forEach((b) => b.classList.toggle('active', b === btn));
    buildStringPicker();
    buildFretboard();
  });
});

fretRadios.forEach((radio) => {
  radio.addEventListener('change', () => {
    if (!radio.checked) return;
    resetDrillIfRunning();
    maxFret = parseInt(radio.value, 10);
    buildFretboard();
  });
});

drillToggleBtn.addEventListener('click', () => {
  if (drillAudioContext) {
    stopDrill();
  } else {
    startDrill();
  }
});

document.getElementById('drill-skip').addEventListener('click', skipPrompt);

buildStringPicker();
buildFretboard();
