// ---------------------------------------------------------------------------
// PITCH DETECTION — AUTOCORRELATION
//
// A plucked guitar string vibrates at (roughly) one fixed frequency, which
// means the waveform repeats itself every T seconds, where T = 1/frequency.
// That repeating chunk is one "period".
//
// Autocorrelation finds T by sliding a copy of the signal over itself and
// asking, at every possible shift ("lag", measured in samples): "how similar
// is the signal to itself at this shift?" When the shift equals exactly one
// period, the waveform lines up with itself almost perfectly and the
// similarity score spikes. The lag where that spike happens tells us the
// period in samples, and frequency = sampleRate / period.
//
// Everything below is written from scratch — no pitch-detection library.
// ---------------------------------------------------------------------------

// Below this loudness, don't even try to detect a pitch. This is the noise
// gate: it stops room hum, string buzz, or silence from being reported as a
// note. RMS (root-mean-square) is the standard way to measure "how loud is
// this chunk of audio, on average."
const NOISE_GATE_RMS = 0.01;

// A correlation peak that isn't at least this close to a perfect match
// (1.0 = the signal lines up with itself exactly at that lag) is treated as
// "not a clear enough pitch," and we report nothing rather than guess.
const CONFIDENCE_THRESHOLD = 0.85;

/**
 * Estimate the fundamental frequency of one buffer of audio.
 *
 * @param {Float32Array} buffer   time-domain samples, one snapshot from the mic
 * @param {number} sampleRate     samples per second (e.g. 44100 or 48000)
 * @param {number} minFreq        lowest frequency worth searching for (Hz)
 * @param {number} maxFreq        highest frequency worth searching for (Hz)
 * @returns {{frequency: number, confidence: number} | null}
 */
function detectPitch(buffer, sampleRate, minFreq = 70, maxFreq = 1400) {
  const n = buffer.length;

  // --- Step 1: noise gate -------------------------------------------------
  let sumSquares = 0;
  for (let i = 0; i < n; i++) sumSquares += buffer[i] * buffer[i];
  const rms = Math.sqrt(sumSquares / n);
  if (rms < NOISE_GATE_RMS) return null;

  // --- Step 2: pick the range of lags worth checking ----------------------
  // A lag of `lag` samples corresponds to a period of lag/sampleRate seconds,
  // i.e. a frequency of sampleRate/lag Hz. So:
  //   maxLag = sampleRate / minFreq   (the biggest shift we'll test, for the
  //                                    lowest note we care about)
  //   minLag = sampleRate / maxFreq   (the smallest shift, for the highest
  //                                    note we care about)
  const maxLag = Math.floor(sampleRate / minFreq);
  const minLag = Math.floor(sampleRate / maxFreq);
  if (maxLag >= n) return null; // buffer too short for this lag range

  // --- Step 3: compute NORMALIZED autocorrelation for every lag in range --
  // Plain autocorrelation is c[lag] = sum over i of buffer[i] * buffer[i+lag].
  // If the waveform at shift `lag` looks like the original waveform, the
  // products are mostly (+ times +) or (- times -), so they add up to a
  // large positive number.
  //
  // But there's a catch that matters a lot for guitar: at lag samples of
  // shift, the sum only has (n - lag) overlapping terms to add up, so the
  // raw total shrinks as lag grows, even for a perfectly periodic signal.
  // Low notes need a big lag (low E's period is ~535 samples at 44.1kHz),
  // so an unnormalized score would make the low strings look "less
  // periodic" than they really are, and a fixed confidence threshold would
  // reject them. To fix that we divide by the combined energy of exactly
  // the samples being compared at that lag:
  //
  //     nsdf[lag] = 2 * sum(buf[i]*buf[i+lag]) / sum(buf[i]^2 + buf[i+lag]^2)
  //
  // This value sits in [-1, 1] and hits 1.0 for a perfectly periodic match
  // at ANY lag, so one confidence threshold works the same for a low E2 as
  // it does for a high fretted note.
  const nsdf = new Float64Array(maxLag + 1);
  for (let lag = 0; lag <= maxLag; lag++) {
    let acf = 0;
    let energy = 0;
    for (let i = 0; i < n - lag; i++) {
      acf += buffer[i] * buffer[i + lag];
      energy += buffer[i] * buffer[i] + buffer[i + lag] * buffer[i + lag];
    }
    nsdf[lag] = energy > 0 ? (2 * acf) / energy : 0;
  }

  // --- Step 4: find the FIRST real peak, not just the tallest one ---------
  // A periodic signal's nsdf starts at 1.0 at lag 0, dips down through
  // zero, and rises back to a local peak at lag = one period. Since real
  // notes contain harmonics, smaller repeat peaks also show up further out
  // at roughly 2x, 3x, ... that lag. If we simply grabbed the tallest value
  // anywhere in the array, a strong harmonic could occasionally win and
  // we'd report a frequency exactly double or half the real note — an
  // "octave error."
  //
  // The fix: walk forward from the shortest lag we allow, skip past the
  // initial downslope until nsdf[] crosses below zero (the first trough),
  // then find the peak on the way back up. That first peak corresponds to
  // ONE period of the fundamental, which is what keeps this method from
  // locking onto a harmonic instead of the true note.
  let lag = minLag;
  while (lag < maxLag && nsdf[lag] > 0) lag++; // walk until it goes negative
  while (lag < maxLag && nsdf[lag] < 0) lag++; // walk until it comes back up

  let bestLag = -1;
  let bestValue = -Infinity;
  for (let l = lag; l <= maxLag; l++) {
    if (nsdf[l] > bestValue) {
      bestValue = nsdf[l];
      bestLag = l;
    } else if (bestLag !== -1 && nsdf[l] < bestValue * 0.9) {
      // We've passed the peak and correlation is falling off. Stop here so
      // a taller, later harmonic peak further down the array can't steal it.
      break;
    }
  }
  if (bestLag <= 0) return null;

  // --- Step 5: parabolic interpolation for sub-sample precision -----------
  // bestLag is a whole number of samples, but the true period almost never
  // lines up exactly on a sample boundary. Fitting a parabola through the
  // peak and its two neighbors and using the parabola's vertex gives a much
  // better estimate of the true lag. This is what lets the tuner report
  // cents precisely instead of being limited to whole-sample resolution.
  const y0 = nsdf[bestLag - 1];
  const y1 = nsdf[bestLag];
  const y2 = bestLag + 1 <= maxLag ? nsdf[bestLag + 1] : nsdf[bestLag];
  const denom = y0 - 2 * y1 + y2;
  const shift = denom !== 0 ? (0.5 * (y0 - y2)) / denom : 0;
  const refinedLag = bestLag + shift;

  const frequency = sampleRate / refinedLag;
  const confidence = bestValue; // nsdf peak height IS the confidence, 0..1

  if (confidence < CONFIDENCE_THRESHOLD) return null;
  if (frequency < minFreq || frequency > maxFreq) return null;

  return { frequency, confidence };
}
