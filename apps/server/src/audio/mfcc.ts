/**
 * MFCC features exactly as python_speech_features computes them (`mfcc(signal, 16000, numcep=13,
 * winlen=0.025, winstep=0.01)`), which is what TalkNet, Light-ASD and LR-ASD were trained on: int16-scaled
 * samples, 0.97 pre-emphasis, rectangular 25 ms frames every 10 ms zero-padded to a 512-point FFT, a 26-filter
 * mel bank over 0-8 kHz, log, orthonormal DCT-II, a 22-coefficient sinusoidal lifter, and the first
 * coefficient replaced by the log frame energy. One frame per 10 ms: 4 per 25 fps video frame.
 */

const NFFT = 512;
const NFILT = 26;
const NUMCEP = 13;
const LIFTER = 22;
const EPS = 2.220446049250313e-16; // numpy's float64 eps, which the reference substitutes for zeros

const hz2mel = (hz: number) => 2595 * Math.log10(1 + hz / 700);
const mel2hz = (mel: number) => 700 * (10 ** (mel / 2595) - 1);

function filterbank(sr: number): Float64Array[] {
  const lo = hz2mel(0);
  const hi = hz2mel(sr / 2);
  const bins: number[] = [];
  for (let i = 0; i < NFILT + 2; i++) bins.push(Math.floor(((NFFT + 1) * mel2hz(lo + ((hi - lo) * i) / (NFILT + 1))) / sr));
  const out: Float64Array[] = [];
  for (let j = 0; j < NFILT; j++) {
    const f = new Float64Array(NFFT / 2 + 1);
    for (let i = bins[j]!; i < bins[j + 1]!; i++) f[i] = (i - bins[j]!) / (bins[j + 1]! - bins[j]!);
    for (let i = bins[j + 1]!; i < bins[j + 2]!; i++) f[i] = (bins[j + 2]! - i) / (bins[j + 2]! - bins[j + 1]!);
    out.push(f);
  }
  return out;
}

/** In-place iterative radix-2 FFT of length NFFT. */
function fft(re: Float64Array, im: Float64Array) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j]!, re[i]!];
      [im[i], im[j]] = [im[j]!, im[i]!];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const tr = re[b]! * cr - im[b]! * ci;
        const ti = re[b]! * ci + im[b]! * cr;
        re[b] = re[a]! - tr;
        im[b] = im[a]! - ti;
        re[a] = re[a]! + tr;
        im[a] = im[a]! + ti;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

/**
 * 13 MFCCs per 10 ms of `pcm` (float samples in [-1, 1]), row-major: frame i is out[i*13 .. i*13+13].
 * Frame count follows the reference: 1 + ceil((len - 400) / 160), the last frame zero-padded.
 */
export function mfcc(pcm: Float32Array, sr = 16000): { data: Float32Array; frames: number } {
  const frameLen = Math.round(0.025 * sr);
  const step = Math.round(0.01 * sr);
  const frames = pcm.length <= frameLen ? 1 : 1 + Math.ceil((pcm.length - frameLen) / step);
  const fb = filterbank(sr);
  const lift = Float64Array.from({ length: NUMCEP }, (_, n) => 1 + (LIFTER / 2) * Math.sin((Math.PI * n) / LIFTER));
  const dct: Float64Array[] = [];
  for (let k = 0; k < NUMCEP; k++) {
    const row = new Float64Array(NFILT);
    const s = k === 0 ? Math.sqrt(1 / NFILT) : Math.sqrt(2 / NFILT);
    for (let n = 0; n < NFILT; n++) row[n] = s * Math.cos((Math.PI * k * (2 * n + 1)) / (2 * NFILT));
    dct.push(row);
  }
  // int16 scale, then pre-emphasis over the whole signal (the reference does both before framing)
  const x = new Float64Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) x[i] = pcm[i]! * 32768 - (i ? 0.97 * pcm[i - 1]! * 32768 : 0);
  const out = new Float32Array(frames * NUMCEP);
  const re = new Float64Array(NFFT);
  const im = new Float64Array(NFFT);
  const pow = new Float64Array(NFFT / 2 + 1);
  const logMel = new Float64Array(NFILT);
  for (let f = 0; f < frames; f++) {
    re.fill(0);
    im.fill(0);
    const o = f * step;
    for (let i = 0; i < frameLen && o + i < x.length; i++) re[i] = x[o + i]!;
    fft(re, im);
    let energy = 0;
    for (let i = 0; i <= NFFT / 2; i++) {
      pow[i] = (re[i]! * re[i]! + im[i]! * im[i]!) / NFFT;
      energy += pow[i]!;
    }
    for (let j = 0; j < NFILT; j++) {
      let e = 0;
      const w = fb[j]!;
      for (let i = 0; i <= NFFT / 2; i++) e += pow[i]! * w[i]!;
      logMel[j] = Math.log(e === 0 ? EPS : e);
    }
    for (let k = 0; k < NUMCEP; k++) {
      let c = 0;
      const row = dct[k]!;
      for (let n = 0; n < NFILT; n++) c += row[n]! * logMel[n]!;
      out[f * NUMCEP + k] = c * lift[k]!;
    }
    out[f * NUMCEP] = Math.log(energy === 0 ? EPS : energy);
  }
  return { data: out, frames };
}

export const MFCC_COEFFS = NUMCEP;
