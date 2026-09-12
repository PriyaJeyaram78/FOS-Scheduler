// ---------------------------------------------------------------------------
// FREQUENCY <-> NOTE NAME CONVERSION (12-tone equal temperament)
//
// In equal temperament, every semitone is the same frequency ratio apart:
// the 12th root of 2 (because 12 semitones = 1 octave = a doubling of
// frequency, and 2^(12/12) = 2). A4 (440 Hz) is the tuning reference. The
// frequency of the note `n` semitones above A4 is:
//
//     f(n) = 440 * 2^(n/12)
//
// To go the other way — frequency measured from the mic -> nearest note —
// solve that equation for n:
//
//     n = 12 * log2(f / 440)
//
// n will almost never be a whole number, because real playing is never
// perfectly in tune. Rounding n to the nearest integer gives the note name;
// the leftover fraction, converted to "cents" (100 cents = 1 semitone),
// tells us how sharp or flat the note is:
//
//     cents = 1200 * log2(f / f_nearestNote)
// ---------------------------------------------------------------------------

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const A4_MIDI = 69; // MIDI note number for A4
const A4_FREQ = 440;

/**
 * @param {number} frequency in Hz
 * @returns {{name: string, octave: number, cents: number, midi: number}}
 */
function frequencyToNote(frequency) {
  const semitonesFromA4 = 12 * Math.log2(frequency / A4_FREQ);
  const midi = Math.round(A4_MIDI + semitonesFromA4);

  // The frequency this note WOULD be if played perfectly in tune, so we can
  // measure the gap between "what was actually played" and "the ideal pitch".
  const exactFrequency = A4_FREQ * Math.pow(2, (midi - A4_MIDI) / 12);
  // The `|| 0` mops up a floating-point edge case: Math.round() can return
  // -0 for a value that's essentially zero, and "-0 cents" would look like
  // a bug on screen even though it means perfectly in tune.
  const cents = Math.round(1200 * Math.log2(frequency / exactFrequency)) || 0;

  const name = NOTE_NAMES[((midi % 12) + 12) % 12];
  const octave = Math.floor(midi / 12) - 1; // MIDI 60 = C4, and 60/12 - 1 = 4

  return { name, octave, cents, midi };
}

// Standard guitar tuning, low string to high string.
const STANDARD_TUNING = [
  { string: 6, note: 'E', octave: 2, frequency: 82.41 },
  { string: 5, note: 'A', octave: 2, frequency: 110.0 },
  { string: 4, note: 'D', octave: 3, frequency: 146.83 },
  { string: 3, note: 'G', octave: 3, frequency: 196.0 },
  { string: 2, note: 'B', octave: 3, frequency: 246.94 },
  { string: 1, note: 'E', octave: 4, frequency: 329.63 },
];
