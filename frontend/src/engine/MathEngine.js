/**
 * SEESOUND — MathEngine.js
 * ═══════════════════════════════════════════════════════════════════════════
 * Direct JavaScript port of three Python back-end modules:
 *
 *   § 1  COLOR ENGINE     ← backend/color_engine.py
 *        • rgb_to_grayscale          (ITU-R BT.601 weighted luminance)
 *        • HLS ↔ RGB conversions     (exact match to Python colorsys)
 *        • adjust_hsl_to_match_grayscale  (10 201-step exhaustive search)
 *        • freq_to_note              (equal-temperament pitch-class lookup)
 *        • hsv_to_rgb / rgb_to_hue  (helper conversions)
 *        • ColorConfig               (editable defaults + 12-note palette)
 *        • ColorEngine               (stateful, cached pipeline)
 *
 *   § 2  SPATIAL MAPPER   ← backend/spatial_mapper.py
 *        • limitDenominator          (Fraction.limit_denominator algorithm)
 *        • freqRatio                 (Harmonic Complexity Displacement)
 *        • panToAngle                (stereo pan → polar angle)
 *        • polarToCartesian          (standard screen-space polar→XY)
 *        • computeSpatial            (full spatial pipeline)
 *
 *   § 3  VISUAL MAPPER    ← backend/visual_mapper.py
 *        • freqToHue                 (semitone distance from A4, 30°/semitone)
 *        • amplitudeToOpacity        (√amplitude curve)
 *        • amplitudeToSize           (amplitude^0.7 curve)
 *        • timeDecayFactor           (2^(−age/half_life) exponential)
 *        • applyTimeDecay            (opacity × decay)
 *        • ratioToClarity            (log2(max(N,D))/5 consonance metric)
 *        • densityToQuantity         (log2(1+rate)/log2(17) onset scaling)
 *        • computeVisual             (master output dict)
 *
 * All functions are pure (no side-effects) and match their Python equivalents
 * numerically to floating-point precision. The ColorEngine class uses a Map
 * as an LRU-style cache to match Python's lru_cache / dict approach.
 *
 * Usage
 * ─────
 *   import { ColorEngine, computeSpatial, computeVisual } from './engine/MathEngine.js'
 *
 *   const ce = new ColorEngine()
 *   const color = ce.freqToColor(440)        // A4 → full color dict
 *   const pos   = computeSpatial(440, 0, 261.63)  // A4 vs C4 tonic
 *   const vis   = computeVisual(440, 0.8, pos.ratio_n, pos.ratio_d)
 */


// ═══════════════════════════════════════════════════════════════════════════
// § 0  SHARED UTILITIES
// ═══════════════════════════════════════════════════════════════════════════

/** Clamp a value to [lo, hi]. */
export function clamp(value, lo = 0.0, hi = 1.0) {
    return Math.max(lo, Math.min(hi, value))
}

/** Linear interpolation. */
export function lerp(a, b, t) {
    return a + (b - a) * t
}


// ═══════════════════════════════════════════════════════════════════════════
// § 1  COLOR ENGINE  ← color_engine.py
// ═══════════════════════════════════════════════════════════════════════════

// ── 1.0  Note ordering (MIDI pitch-class 0 = C) ───────────────────────────

export const NOTE_ORDER = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

/** Default 12-note palette — same vivid defaults as the Python back-end. */
export const DEFAULT_NOTE_COLORS = {
    'C': [255, 0, 0],
    'C#': [143, 0, 255],
    'D': [255, 255, 0],
    'D#': [183, 70, 139],
    'E': [195, 242, 255],
    'F': [170, 0, 52],
    'F#': [127, 139, 254],
    'G': [255, 127, 1],
    'G#': [187, 117, 252],
    'A': [54, 204, 51],
    'A#': [169, 103, 124],
    'B': [142, 201, 255],
}

const _A4_HZ = 440.0

// ── 1.1  Grayscale luminance (ITU-R BT.601) ────────────────────────────────

/**
 * Convert an RGB colour to a perceptual grayscale value.
 *
 * Python source: color_engine.rgb_to_grayscale()
 *
 *   gray = w_r·R + w_g·G + w_b·B
 *
 * Default weights are ITU-R BT.601 (SDTV standard):
 *   w_r = 0.299,  w_g = 0.587,  w_b = 0.114
 *
 * @param {number} r   Red   0–255
 * @param {number} g   Green 0–255
 * @param {number} b   Blue  0–255
 * @param {number} w_r Red   weight  (default 0.299)
 * @param {number} w_g Green weight  (default 0.587)
 * @param {number} w_b Blue  weight  (default 0.114)
 * @returns {number} Grayscale integer 0–255
 */
export function rgbToGrayscale(r, g, b, w_r = 0.299, w_g = 0.587, w_b = 0.114) {
    return Math.trunc(w_r * r + w_g * g + w_b * b)
}

// ── 1.2  HLS ↔ RGB  (exact match to Python colorsys) ──────────────────────
//
// NOTE: Python's colorsys uses HLS order (Hue, Lightness, Saturation),
//       NOT the more common HSL order. These implementations replicate
//       the Python source exactly so numeric output is identical.

const _ONE_THIRD = 1.0 / 3.0
const _ONE_SIXTH = 1.0 / 6.0
const _TWO_THIRD = 2.0 / 3.0

/**
 * RGB → HLS  (matches Python colorsys.rgb_to_hls exactly)
 *
 * @param {number} r  0–1
 * @param {number} g  0–1
 * @param {number} b  0–1
 * @returns {{ h: number, l: number, s: number }}  all in [0, 1]
 */
export function rgbToHls(r, g, b) {
    const maxc = Math.max(r, g, b)
    const minc = Math.min(r, g, b)
    const l = (minc + maxc) / 2.0

    if (minc === maxc) return { h: 0.0, l, s: 0.0 }

    const s = l <= 0.5
        ? (maxc - minc) / (maxc + minc)
        : (maxc - minc) / (2.0 - maxc - minc)

    const rc = (maxc - r) / (maxc - minc)
    const gc = (maxc - g) / (maxc - minc)
    const bc = (maxc - b) / (maxc - minc)

    let h
    if (r === maxc) h = bc - gc
    else if (g === maxc) h = 2.0 + rc - bc
    else h = 4.0 + gc - rc

    h = ((h / 6.0) % 1.0 + 1.0) % 1.0   // keep positive (JS % can be negative)
    return { h, l, s }
}

/**
 * HLS → RGB  (matches Python colorsys.hls_to_rgb exactly)
 *
 * @param {number} h  Hue        [0, 1]
 * @param {number} l  Lightness  [0, 1]
 * @param {number} s  Saturation [0, 1]
 * @returns {{ r: number, g: number, b: number }}  all in [0, 1]
 */
export function hlsToRgb(h, l, s) {
    if (s === 0.0) return { r: l, g: l, b: l }

    const m2 = l <= 0.5 ? l * (1.0 + s) : l + s - l * s
    const m1 = 2.0 * l - m2

    return {
        r: _hlsV(m1, m2, h + _ONE_THIRD),
        g: _hlsV(m1, m2, h),
        b: _hlsV(m1, m2, h - _ONE_THIRD),
    }
}

function _hlsV(m1, m2, hue) {
    hue = ((hue % 1.0) + 1.0) % 1.0   // normalise to [0, 1)
    if (hue < _ONE_SIXTH) return m1 + (m2 - m1) * hue * 6.0
    if (hue < 0.5) return m2
    if (hue < _TWO_THIRD) return m1 + (m2 - m1) * (_TWO_THIRD - hue) * 6.0
    return m1
}

// ── 1.3  adjust_hsl_to_match_grayscale ────────────────────────────────────

/**
 * Adjust the S and L of an RGB colour until its perceptual grayscale matches
 * `targetGrayscale`, using an exhaustive ±50-step (0.01 each) grid search.
 *
 * Python source: color_engine.adjust_hsl_to_match_grayscale()
 *
 * Search space: 101×101 = 10,201 L+S combinations.
 * Among all combinations within `tolerance` of the target, the one with the
 * smallest combined |ΔL| + |ΔS| change is selected (minimal-distortion).
 *
 * Results should be cached by the caller (ColorEngine does this).
 *
 * @param {number} r               Original red   0–255
 * @param {number} g               Original green 0–255
 * @param {number} b               Original blue  0–255
 * @param {number} targetGrayscale Desired grayscale 0–255
 * @param {number} tolerance       Acceptable ±error in grayscale (default 1)
 * @param {number} w_r             Grayscale weight for R (default 0.299)
 * @param {number} w_g             Grayscale weight for G (default 0.587)
 * @param {number} w_b             Grayscale weight for B (default 0.114)
 * @returns {[number, number, number]} Adjusted [R, G, B] 0–255
 */
export function adjustHslToMatchGrayscale(
    r, g, b,
    targetGrayscale,
    tolerance = 1,
    w_r = 0.299, w_g = 0.587, w_b = 0.114,
) {
    const { h, l, s } = rgbToHls(r / 255.0, g / 255.0, b / 255.0)

    let bestRgb = [r, g, b]
    let bestChange = Infinity
    const step = 0.01

    for (let i = -50; i <= 50; i++) {
        const adjL = l + i * step
        if (adjL < 0 || adjL > 1) continue

        for (let j = -50; j <= 50; j++) {
            const adjS = s + j * step
            if (adjS < 0 || adjS > 1) continue

            const { r: rf, g: gf, b: bf } = hlsToRgb(h, adjL, adjS)
            const ar = Math.trunc(rf * 255)
            const ag = Math.trunc(gf * 255)
            const ab = Math.trunc(bf * 255)

            const gray = rgbToGrayscale(ar, ag, ab, w_r, w_g, w_b)
            const change = Math.abs(adjL - l) + Math.abs(adjS - s)

            if (Math.abs(gray - targetGrayscale) <= tolerance && change < bestChange) {
                bestRgb = [ar, ag, ab]
                bestChange = change
            }
        }
    }

    return bestRgb
}

// ── 1.4  Pitch-class helpers ───────────────────────────────────────────────

/**
 * Return the nearest pitch-class name (C, C#, D … B) for a given frequency.
 *
 * Python source: color_engine.freq_to_note()
 *
 * Uses equal temperament relative to A4 = 440 Hz.
 *
 * @param {number} freq  Hz (must be > 0)
 * @returns {string}  e.g. 'A', 'C#'
 */
export function freqToNote(freq) {
    if (freq <= 0) return 'C'
    const semitones = 12.0 * Math.log2(freq / _A4_HZ)
    // Semitone 0 = A4; A is index 9 in NOTE_ORDER (C-rooted scale)
    const pitchClassIndex = ((Math.round(semitones) % 12) + 12) % 12
    const noteIndex = (pitchClassIndex + 9) % 12
    return NOTE_ORDER[noteIndex]
}

/**
 * Extract hue (degrees, 0–360) from an RGB triple.
 *
 * Python source: color_engine.rgb_to_hue()
 *
 * @param {number} r  0–255
 * @param {number} g  0–255
 * @param {number} b  0–255
 * @returns {number} Hue in degrees
 */
export function rgbToHue(r, g, b) {
    const { h } = rgbToHls(r / 255.0, g / 255.0, b / 255.0)
    return +((h * 360.0) % 360.0).toFixed(2)
}

/**
 * Convert HSV (h in degrees 0–360, s/v in 0–1) to RGB 0–255.
 *
 * Python source: color_engine.hsv_to_rgb()
 *
 * @param {number} h_deg  Hue degrees 0–360
 * @param {number} s      Saturation 0–1
 * @param {number} v      Value 0–1
 * @returns {[number, number, number]}
 */
export function hsvToRgb(h_deg, s, v) {
    const h = h_deg / 360.0
    if (s === 0.0) {
        const c = Math.trunc(v * 255)
        return [c, c, c]
    }
    const i = Math.trunc(h * 6)
    const f = h * 6 - i
    const p = v * (1.0 - s)
    const q = v * (1.0 - s * f)
    const t = v * (1.0 - s * (1.0 - f))

    let r, g, b
    switch (i % 6) {
        case 0: r = v; g = t; b = p; break
        case 1: r = q; g = v; b = p; break
        case 2: r = p; g = v; b = t; break
        case 3: r = p; g = q; b = v; break
        case 4: r = t; g = p; b = v; break
        case 5: r = v; g = p; b = q; break
    }
    return [Math.trunc(r * 255), Math.trunc(g * 255), Math.trunc(b * 255)]
}

/**
 * Format an RGB tuple as an HSL string.
 *
 * Python source: color_engine.rgb_to_hsl_string()
 *
 * @param {number} r  0–255
 * @param {number} g  0–255
 * @param {number} b  0–255
 * @returns {string}  e.g. '(240, 100%, 50%)'
 */
export function rgbToHslString(r, g, b) {
    const { h, l, s } = rgbToHls(r / 255.0, g / 255.0, b / 255.0)
    return `(${Math.trunc(h * 360)}, ${Math.trunc(s * 100)}%, ${Math.trunc(l * 100)}%)`
}

// ── 1.5  ColorConfig ───────────────────────────────────────────────────────

/**
 * Editable configuration for the ColorEngine.
 *
 * Python source: color_engine.ColorConfig
 *
 * All fields are public and can be updated at runtime (e.g., from a WebSocket
 * rules message). Changing any field requires calling ColorEngine.clearCache().
 */
export class ColorConfig {
    constructor(overrides = {}) {
        // ── Spectrum ──────────────────────────────────────────────────────────
        this.spectrumLowHz = 16.3516    // C0
        this.spectrumHighHz = 7902.133   // B8

        // ── Grayscale range ───────────────────────────────────────────────────
        this.grayscaleMin = 20     // low-frequency end (dark)
        this.grayscaleMax = 235    // high-frequency end (bright)

        // ── Perceptual grayscale weights (ITU-R BT.601) ───────────────────────
        this.w_r = 0.299
        this.w_g = 0.587
        this.w_b = 0.114

        // ── Adjustment tolerance ──────────────────────────────────────────────
        this.tolerance = 1

        // ── Input mode: 'rgb' | 'hsv' ─────────────────────────────────────────
        this.colorInputMode = 'rgb'

        // ── 12-note palette: { note: [R,G,B] or [H,S,V] } ────────────────────
        this.noteColors = Object.fromEntries(
            Object.entries(DEFAULT_NOTE_COLORS).map(([k, v]) => [k, [...v]])
        )

        // Apply any caller overrides
        Object.assign(this, overrides)
    }

    /**
     * Return the base [R, G, B] for a note, respecting colorInputMode.
     * @param {string} note  e.g. 'A', 'C#'
     * @returns {[number, number, number]}
     */
    noteColorAsRgb(note) {
        const raw = this.noteColors[note] ?? this.noteColors['C'] ?? [128, 128, 128]
        if (this.colorInputMode === 'hsv') {
            return hsvToRgb(raw[0], raw[1], raw[2])
        }
        return [Math.trunc(raw[0]), Math.trunc(raw[1]), Math.trunc(raw[2])]
    }

    /** Serialise to a plain object for WebSocket transport. */
    toDict() {
        return {
            spectrum_low_hz: this.spectrumLowHz,
            spectrum_high_hz: this.spectrumHighHz,
            grayscale_min: this.grayscaleMin,
            grayscale_max: this.grayscaleMax,
            w_r: this.w_r,
            w_g: this.w_g,
            w_b: this.w_b,
            tolerance: this.tolerance,
            color_input_mode: this.colorInputMode,
            note_colors: Object.fromEntries(
                Object.entries(this.noteColors).map(([k, v]) => [k, [...v]])
            ),
        }
    }

    /** Deserialise from a plain object (e.g. from a WebSocket message). */
    static fromDict(d) {
        const cfg = new ColorConfig()
        if ('spectrum_low_hz' in d) cfg.spectrumLowHz = d.spectrum_low_hz
        if ('spectrum_high_hz' in d) cfg.spectrumHighHz = d.spectrum_high_hz
        if ('grayscale_min' in d) cfg.grayscaleMin = d.grayscale_min
        if ('grayscale_max' in d) cfg.grayscaleMax = d.grayscale_max
        if ('w_r' in d) cfg.w_r = d.w_r
        if ('w_g' in d) cfg.w_g = d.w_g
        if ('w_b' in d) cfg.w_b = d.w_b
        if ('tolerance' in d) cfg.tolerance = d.tolerance
        if ('color_input_mode' in d) cfg.colorInputMode = d.color_input_mode
        if ('note_colors' in d) {
            cfg.noteColors = Object.fromEntries(
                Object.entries(d.note_colors).map(([k, v]) => [k, [...v]])
            )
        }
        return cfg
    }
}

// ── 1.6  ColorEngine ──────────────────────────────────────────────────────

/**
 * Stateful colour processor.
 *
 * Python source: color_engine.ColorEngine
 *
 * Wraps ColorConfig and caches the expensive adjustHslToMatchGrayscale()
 * calls using a Map keyed on (r,g,b,targetGray,tolerance,w_r,w_g,w_b).
 *
 * Usage
 * ─────
 *   const ce = new ColorEngine()
 *   const result = ce.freqToColor(440)   // A4
 *
 *   // Update from a WebSocket rules message:
 *   ce.updateConfig({ grayscale_min: 30, grayscale_max: 220 })
 */
export class ColorEngine {
    constructor(config = null) {
        this.config = config ?? new ColorConfig()
        /** @type {Map<string, [number,number,number]>} */
        this._cache = new Map()
    }

    /** Apply a partial update object and clear the cache. Returns this. */
    updateConfig(updates) {
        const current = this.config.toDict()
        Object.assign(current, updates)
        this.config = ColorConfig.fromDict(current)
        this._cache.clear()
        return this
    }

    /** Clear the adjustment cache (e.g., after a config change). */
    clearCache() {
        this._cache.clear()
    }

    // ── Step 1: frequency → target grayscale ──────────────────────────────

    /**
     * Map a frequency's log-scale position in [spectrumLowHz, spectrumHighHz]
     * linearly to [grayscaleMin, grayscaleMax].
     *
     * Python source: ColorEngine.compute_target_grayscale()
     *
     * @param {number} freq  Hz
     * @returns {number}  Target grayscale integer 0–255
     */
    computeTargetGrayscale(freq) {
        const cfg = this.config
        const lo = Math.log2(Math.max(cfg.spectrumLowHz, 1e-3))
        const hi = Math.log2(Math.max(cfg.spectrumHighHz, 1e-3))
        const f = Math.log2(Math.max(freq, 1e-3))

        const t = hi !== lo ? clamp((f - lo) / (hi - lo)) : 0.5
        const gray = cfg.grayscaleMin + t * (cfg.grayscaleMax - cfg.grayscaleMin)
        return Math.round(gray)
    }

    // ── Step 2: frequency → note → base RGB ───────────────────────────────

    /**
     * Return the un-adjusted base [R,G,B] for the note nearest to freq.
     *
     * Python source: ColorEngine.get_base_rgb()
     *
     * @param {number} freq  Hz
     * @returns {[number, number, number]}
     */
    getBaseRgb(freq) {
        const note = freqToNote(freq)
        return this.config.noteColorAsRgb(note)
    }

    // ── Step 3: cached HSL adjustment ─────────────────────────────────────

    _adjustCached(r, g, b, targetGray) {
        const cfg = this.config
        const key = `${r},${g},${b},${targetGray},${cfg.tolerance},${cfg.w_r},${cfg.w_g},${cfg.w_b}`
        if (!this._cache.has(key)) {
            this._cache.set(key, adjustHslToMatchGrayscale(
                r, g, b, targetGray, cfg.tolerance, cfg.w_r, cfg.w_g, cfg.w_b,
            ))
        }
        return this._cache.get(key)
    }

    // ── Full pipeline ──────────────────────────────────────────────────────

    /**
     * Full colour pipeline for a single frequency.
     *
     * Python source: ColorEngine.freq_to_color()
     *
     * @param {number} freq  Hz
     * @returns {{
     *   note:             string,
     *   base_rgb:         [number,number,number],
     *   base_grayscale:   number,
     *   target_grayscale: number,
     *   rgb:              [number,number,number],
     *   grayscale:        number,
     *   hue:              number,
     *   hsl_string:       string,
     * }}
     */
    freqToColor(freq) {
        const cfg = this.config

        const note = freqToNote(freq)
        const [baseR, baseG, baseB] = this.config.noteColorAsRgb(note)
        const targetGray = this.computeTargetGrayscale(freq)
        const [adjR, adjG, adjB] = this._adjustCached(baseR, baseG, baseB, targetGray)
        const actualGray = rgbToGrayscale(adjR, adjG, adjB, cfg.w_r, cfg.w_g, cfg.w_b)
        const hue = rgbToHue(adjR, adjG, adjB)
        const hslString = rgbToHslString(adjR, adjG, adjB)

        return {
            note,
            base_rgb: [baseR, baseG, baseB],
            base_grayscale: rgbToGrayscale(baseR, baseG, baseB, cfg.w_r, cfg.w_g, cfg.w_b),
            target_grayscale: targetGray,
            rgb: [adjR, adjG, adjB],
            grayscale: actualGray,
            hue,
            hsl_string: hslString,
        }
    }

    /**
     * Process a list of frequencies, sharing the cache.
     *
     * Python source: ColorEngine.batch_freq_to_color()
     *
     * @param {number[]} freqs
     * @returns {object[]}
     */
    batchFreqToColor(freqs) {
        return freqs.map(f => this.freqToColor(f))
    }
}

/** Module-level default engine (importable as a singleton). */
export const defaultColorEngine = new ColorEngine()


// ═══════════════════════════════════════════════════════════════════════════
// § 2  SPATIAL MAPPER  ← spatial_mapper.py
// ═══════════════════════════════════════════════════════════════════════════

// ── 2.1  Fraction.limit_denominator  (Python stdlib algorithm) ────────────

/**
 * Find the best rational approximation p/q ≈ numerator/denominator
 * such that q ≤ maxDenominator.
 *
 * Port of Python's fractions.Fraction.limit_denominator().
 * Uses the continued-fraction / Stern-Brocot mediant algorithm.
 *
 * @param {number} num           Numerator of the exact rational
 * @param {number} den           Denominator of the exact rational
 * @param {number} maxDenominator  Upper bound on the result denominator
 * @returns {[number, number]}   [p, q] such that p/q ≈ num/den and q ≤ maxDenominator
 */
export function limitDenominator(num, den, maxDenominator) {
    if (maxDenominator < 1) maxDenominator = 1

    // If the denominator is already within bounds, return as-is
    if (Math.abs(den) <= maxDenominator) return [num, den]

    let p0 = 0, q0 = 1, p1 = 1, q1 = 0
    let n = Math.abs(num), d = Math.abs(den)

    while (true) {
        const a = Math.trunc(n / d)
        const q2 = q0 + a * q1
        if (q2 > maxDenominator) break

            ;[p0, q0, p1, q1] = [p1, q1, p0 + a * p1, q2]
            ;[n, d] = [d, n - a * d]
        if (d === 0) break
    }

    const k = Math.trunc((maxDenominator - q0) / q1)

    // Compare candidates: (p0+k*p1)/(q0+k*q1)  vs  p1/q1
    const bound1Num = p0 + k * p1
    const bound1Den = q0 + k * q1
    const bound2Num = p1
    const bound2Den = q1

    // |bound - original|  — compare cross-multiply to avoid division
    const diff1 = Math.abs(bound1Num * den - num * bound1Den)
    const diff2 = Math.abs(bound2Num * den - num * bound2Den)

    return diff2 <= diff1
        ? [bound2Num, bound2Den]
        : [bound1Num, bound1Den]
}

// ── 2.2  Frequency ratio ──────────────────────────────────────────────────

/**
 * Return the simplest integer ratio (N, D) such that N/D ≈ freq / tonic,
 * folded into the range [1, 2) (within one octave).
 *
 * Python source: spatial_mapper.freq_ratio()
 *
 * Formula: Harmonic Complexity Displacement model
 *   r = radiusScale · D   (canvas radius driven by denominator)
 *   θ = pan · π/2         (angle driven by stereo pan)
 *
 * @param {number} freq            Component Hz
 * @param {number} tonic           Root/tonic Hz
 * @param {number} maxDenominator  Upper bound on D (default 32)
 * @returns {[number, number]}     [N, D]  both integers ≥ 1
 *
 * @example
 *   freqRatio(660, 440)  // perfect 5th  → [3, 2]
 *   freqRatio(550, 440)  // major 3rd    → [5, 4]
 *   freqRatio(440, 440)  // unison       → [1, 1]
 */
export function freqRatio(freq, tonic, maxDenominator = 32) {
    if (tonic <= 0 || freq <= 0) return [1, 1]

    // Fold into [1, 2) — compare within one octave
    let raw = freq / tonic
    while (raw >= 2.0) raw /= 2.0
    while (raw < 1.0) raw *= 2.0

    // Represent `raw` as an exact fraction with a large denominator,
    // then limit it. Use 1_000_000 as the exact-fraction denominator.
    const exactDen = 1_000_000
    const exactNum = Math.round(raw * exactDen)
    const [p, q] = limitDenominator(exactNum, exactDen, maxDenominator)

    return [Math.max(1, p), Math.max(1, q)]
}

// ── 2.3  Pan → angle ──────────────────────────────────────────────────────

/**
 * Map stereo pan [-1, +1] to a polar canvas angle in radians.
 *
 * Python source: spatial_mapper.pan_to_angle()
 *
 *   pan = -1.0  →  θ = -π/2  (canvas left)
 *   pan =  0.0  →  θ =  0    (canvas top / 12 o'clock)
 *   pan = +1.0  →  θ = +π/2  (canvas right)
 *
 * @param {number} pan  [-1, +1]
 * @returns {number} Angle in radians
 */
export function panToAngle(pan) {
    return pan * (Math.PI / 2.0)
}

// ── 2.4  Polar → Cartesian ────────────────────────────────────────────────

/**
 * Convert polar (r, θ) to Cartesian (x, y) in standard screen layout
 * where θ = 0 points upward (−Y in screen coords).
 *
 * Python source: spatial_mapper.polar_to_cartesian()
 *
 *   x =  r · sin(θ)
 *   y = -r · cos(θ)
 *
 * @param {number} radius  Distance from canvas centre
 * @param {number} angle   Radians (0 = upward, clockwise positive)
 * @returns {{ x: number, y: number }}
 */
export function polarToCartesian(radius, angle) {
    return {
        x: radius * Math.sin(angle),
        y: -radius * Math.cos(angle),
    }
}

// ── 2.5  Full spatial pipeline ────────────────────────────────────────────

/**
 * Full spatial pipeline for a single wave component.
 *
 * Python source: spatial_mapper.compute_spatial()
 *
 *   r = radiusScale · D      (canvas radius driven by ratio denominator)
 *   θ = pan · π/2            (angle driven by stereo pan)
 *   (x, y) = polar_to_cartesian(r, θ)
 *
 * @param {number} freq            Component Hz
 * @param {number} pan             Stereo pan [-1, +1]
 * @param {number} tonic           Root/tonic Hz
 * @param {number} radiusScale     Constant c in r = c·D (default 0.12)
 * @param {number} maxDenominator  Max ratio denominator (default 32)
 * @returns {{
 *   ratio_n: number,
 *   ratio_d: number,
 *   radius:  number,
 *   angle:   number,
 *   x:       number,
 *   y:       number,
 * }}
 */
export function computeSpatial(freq, pan, tonic, radiusScale = 0.12, maxDenominator = 32) {
    const [n, d] = freqRatio(freq, tonic, maxDenominator)
    const r = radiusScale * d
    const theta = panToAngle(pan)
    const { x, y } = polarToCartesian(r, theta)

    return {
        ratio_n: n,
        ratio_d: d,
        radius: +r.toFixed(6),
        angle: +theta.toFixed(6),
        x: +x.toFixed(6),
        y: +y.toFixed(6),
    }
}


// ═══════════════════════════════════════════════════════════════════════════
// § 3  VISUAL MAPPER  ← visual_mapper.py
// ═══════════════════════════════════════════════════════════════════════════

const _REF_FREQ = 440.0   // A4

// ── 3.1  Pitch → Hue ──────────────────────────────────────────────────────

/**
 * Map a frequency to a hue angle in degrees [0, 360).
 *
 * Python source: visual_mapper.freq_to_hue()
 *
 * Synesthetic / spectral mapping:
 *   • Anchored so A (La) = 0° (warm red)
 *   • Each of the 12 pitch classes occupies 30° (360° / 12 semitones)
 *   • Based on equal-temperament distance from A4 = 440 Hz
 *
 * @param {number} freq  Hz (must be > 0)
 * @returns {number} Hue in degrees [0, 360)
 */
export function freqToHue(freq) {
    if (freq <= 0) return 0.0
    const semitones = 12.0 * Math.log2(freq / _REF_FREQ)
    const hue = ((semitones % 12.0) + 12.0) % 12.0 * 30.0
    return +((hue % 360.0).toFixed(2))
}

// ── 3.2  Amplitude → Opacity ──────────────────────────────────────────────

/**
 * Louder components are more opaque.
 *
 * Python source: visual_mapper.amplitude_to_opacity()
 *
 * Uses a square-root curve so quiet sounds remain visible while the
 * dynamic range still registers:
 *   opacity = √(clamp(amplitude)) · opacityMax
 *
 * @param {number} amplitude   Normalised amplitude [0, 1]
 * @param {number} opacityMax  Global opacity ceiling (default 1.0)
 * @returns {number} Opacity in [0, opacityMax]
 */
export function amplitudeToOpacity(amplitude, opacityMax = 1.0) {
    const raw = Math.sqrt(clamp(amplitude))
    return +(clamp(raw * opacityMax).toFixed(4))
}

// ── 3.3  Amplitude → Size ─────────────────────────────────────────────────

/**
 * Louder components produce larger visual elements.
 *
 * Python source: visual_mapper.amplitude_to_size()
 *
 * Uses a power curve (^0.7) so loud sounds don't completely dwarf quiet ones:
 *   size = minSize + clamp(amplitude)^0.7 · (maxSize − minSize)
 *
 * @param {number} amplitude   Normalised amplitude [0, 1]
 * @param {number} sizeScale   Global size multiplier (default 1.0)
 * @param {number} minSize     Minimum size in normalised units (default 0.1)
 * @param {number} maxSize     Maximum size (default 4.0)
 * @returns {number} Relative element size
 */
export function amplitudeToSize(amplitude, sizeScale = 1.0, minSize = 0.1, maxSize = 4.0) {
    const raw = minSize + (clamp(amplitude) ** 0.7) * (maxSize - minSize)
    return +(raw * sizeScale).toFixed(4)
}

// ── 3.4  Time → Opacity decay ─────────────────────────────────────────────

/**
 * Exponential decay factor applied to opacity as a component ages.
 *
 * Python source: visual_mapper.time_decay_factor()
 *
 *   decay = 2^(−age / halfLife)
 *
 * At age = 0           → decay = 1.0  (fully opaque)
 * At age = halfLife    → decay = 0.5  (half opacity)
 * At age = 2·halfLife  → decay = 0.25
 *
 * @param {number} ageSeconds  Seconds since the component appeared
 * @param {number} halfLife    Seconds for opacity to halve (default 2.0)
 * @returns {number} Decay multiplier in (0, 1]
 */
export function timeDecayFactor(ageSeconds, halfLife = 2.0) {
    if (halfLife <= 0) return 1.0
    return +(clamp(Math.pow(2, -ageSeconds / halfLife)).toFixed(6))
}

/**
 * Multiply an existing opacity value by the time-decay factor.
 *
 * Python source: visual_mapper.apply_time_decay()
 *
 * @param {number} opacity     Existing opacity [0, 1]
 * @param {number} ageSeconds  Seconds since the component appeared
 * @param {number} halfLife    Half-life in seconds (default 2.0)
 * @returns {number} Decayed opacity [0, 1]
 */
export function applyTimeDecay(opacity, ageSeconds, halfLife = 2.0) {
    return +(clamp(opacity * timeDecayFactor(ageSeconds, halfLife)).toFixed(4))
}

// ── 3.5  Harmonicity → Clarity ────────────────────────────────────────────

/**
 * Convert a harmonic ratio (N, D) to a visual clarity value in [0, 1].
 *
 * Python source: visual_mapper.ratio_to_clarity()
 *
 * Simple ratios (1/1 unison, 2/1 octave, 3/2 fifth …) are the most
 * consonant and produce sharp, focused visuals.  Complex ratios (large N
 * and D) are dissonant and produce diffuse, low-clarity visuals.
 *
 *   complexity = log2(max(N, D)) / log2(32)   (capped at 1)
 *   clarity    = 1 − complexity
 *
 * @param {number} ratio_n  Numerator   (integer ≥ 1)
 * @param {number} ratio_d  Denominator (integer ≥ 1)
 * @returns {number} Clarity [0, 1].  1.0 = perfect unison / octave.
 */
export function ratioToClarity(ratio_n, ratio_d) {
    if (ratio_n <= 0 || ratio_d <= 0) return 0.5
    const complexityRaw = Math.log2(Math.max(ratio_n, ratio_d))
    const complexityNorm = clamp(complexityRaw / 5.0)   // 5 = log2(32)
    return +(clamp(1.0 - complexityNorm).toFixed(4))
}

// ── 3.6  Onset density → Quantity ─────────────────────────────────────────

/**
 * Map onset density (onsets per second) to the maximum number of visible
 * elements emitted per frame.
 *
 * Python source: visual_mapper.density_to_quantity()
 *
 * Logarithmic scale:
 *   quantity = basePeaks × clamp(log2(1 + onsetRate) / log2(17), 0, 1)
 *
 *   At  0 onsets/s → 0          (silence)
 *   At 16 onsets/s → basePeaks  (very busy)
 *
 * @param {number} onsetRate  Detected onsets per second
 * @param {number} basePeaks  Configured n_peaks ceiling (default 64)
 * @returns {number} Integer element count to emit this frame
 */
export function densityToQuantity(onsetRate, basePeaks = 64) {
    if (onsetRate <= 0) return basePeaks
    const scale = clamp(Math.log2(1.0 + onsetRate) / Math.log2(17.0))
    return Math.max(1, Math.round(basePeaks * scale))
}

// ── 3.7  Master visual pipeline ───────────────────────────────────────────

/**
 * Run all visual-mapping rules for a single wave component.
 *
 * Python source: visual_mapper.compute_visual()
 *
 * When a ColorEngine instance is supplied the full perceptually-calibrated
 * pipeline (grayscale luminance matching + note-to-hue palette) is used.
 * Without one, a simple semitone-distance hue is used as a fallback.
 *
 * @param {number}      freq          Hz
 * @param {number}      amplitude     Normalised amplitude [0, 1]
 * @param {number}      ratio_n       Numerator of harmonic ratio
 * @param {number}      ratio_d       Denominator of harmonic ratio
 * @param {number}      ageSeconds    Seconds since component appeared (default 0)
 * @param {number}      sizeScale     Global size multiplier (default 1.0)
 * @param {number}      opacityMax    Global opacity ceiling (default 1.0)
 * @param {number}      timeDecay     Opacity half-life in seconds (default 2.0)
 * @param {ColorEngine} colorEngine   ColorEngine instance (null for fallback)
 * @returns {{
 *   hue:              number,
 *   opacity:          number,
 *   size:             number,
 *   clarity:          number,
 *   note:             string,
 *   color_rgb:        [number,number,number],
 *   grayscale_target: number,
 *   grayscale_actual: number,
 *   color_hsl_string: string,
 * }}
 */
export function computeVisual(
    freq,
    amplitude,
    ratio_n,
    ratio_d,
    ageSeconds = 0.0,
    sizeScale = 1.0,
    opacityMax = 1.0,
    timeDecay = 2.0,
    colorEngine = null,
) {
    const rawOpacity = amplitudeToOpacity(amplitude, opacityMax)
    const opacity = applyTimeDecay(rawOpacity, ageSeconds, timeDecay)
    const size = amplitudeToSize(amplitude, sizeScale)
    const clarity = ratioToClarity(ratio_n, ratio_d)

    if (colorEngine !== null) {
        const color = colorEngine.freqToColor(freq)
        return {
            hue: color.hue,
            opacity,
            size,
            clarity,
            note: color.note,
            color_rgb: color.rgb,
            grayscale_target: color.target_grayscale,
            grayscale_actual: color.grayscale,
            color_hsl_string: color.hsl_string,
        }
    }

    // Fallback: simple semitone-based hue (no luminance matching)
    return {
        hue: freqToHue(freq),
        opacity,
        size,
        clarity,
        note: '',
        color_rgb: [0, 0, 0],
        grayscale_target: 0,
        grayscale_actual: 0,
        color_hsl_string: '',
    }
}
