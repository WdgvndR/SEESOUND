/**
 * SEESOUND — GraphEvaluator.js
 * ════════════════════════════════════════════════════════════════════════════
 * Evaluates a flat list of Input→Math→Output mapping rules per audio particle.
 *
 * Each rule:  { source, sourceParams?, op, amount, target, mode, enabled }
 *   sourceParams is used when source === 'freqband': { freqLo, freqHi }
 *
 * Usage
 * ──────
 *   const ge = new GraphEvaluator()
 *   ge.compile(flatRules)          // call whenever mappingGroups change
 *
 *   // Inside the render loop (once per particle):
 *   const mods = ge.evaluate(particleData, frameData)
 *   // frameData must include .components (array of frequency partials)
 *   // mods: { radius_mult, hue_add, saturation, lightness, alpha_mult, ... }
 */

export const AUDIO_INPUTS = {
    // ── Per-particle ─────────────────────────────────────────────────────────
    amplitude: { label: 'Amplitude', group: 'Particle', desc: 'Normalised loudness of this partial (0–1)' },
    frequency: { label: 'Frequency', group: 'Particle', desc: 'Log-normalised pitch of this partial (0 = 20 Hz, 1 = 20 kHz)' },
    pan: { label: 'Pan', group: 'Particle', desc: 'Stereo position of this partial (0 = left, 1 = right)' },
    age: { label: 'Age', group: 'Particle', desc: 'How long this partial has been active (5 s = 1.0)' },
    clarity: { label: 'Clarity', group: 'Particle', desc: 'Spectral purity; 1 = pure sine tone, 0 = noise/inharmonic' },
    dissonance: { label: 'Dissonance', group: 'Particle', desc: 'Harmonic roughness of this partial (0 = consonant, 1 = dissonant)' },
    // ── Full-mix frame ───────────────────────────────────────────────────────
    rms: { label: 'RMS Level', group: 'Frame', desc: 'Full-mix RMS energy this frame (0–1)' },
    bpm: { label: 'BPM', group: 'Frame', desc: 'Detected tempo, normalised (240 BPM = 1.0)' },
    // ── Instrument frequency bands ───────────────────────────────────────────
    sub_amp: { label: 'Sub Bass', group: 'Instruments', desc: 'Amplitude 20–60 Hz (sub-bass rumble, felt more than heard)', freqRange: [20, 60] },
    kick_amp: { label: 'Kick Drum', group: 'Instruments', desc: 'Amplitude 40–120 Hz (kick drum fundamental punch)', freqRange: [40, 120] },
    bass_amp: { label: 'Bass Guitar', group: 'Instruments', desc: 'Amplitude 80–300 Hz (bass guitar, double bass, low piano)', freqRange: [80, 300] },
    snare_body: { label: 'Snare Body', group: 'Instruments', desc: 'Amplitude 150–350 Hz (snare fundamental, toms body)', freqRange: [150, 350] },
    low_guitar: { label: 'Guitar Low', group: 'Instruments', desc: 'Amplitude 80–400 Hz (electric/acoustic guitar low harmonics)', freqRange: [80, 400] },
    low_mid: { label: 'Low-Mid', group: 'Instruments', desc: 'Amplitude 250–800 Hz (guitar body, male vocals, piano mid register)', freqRange: [250, 800] },
    vocal_body: { label: 'Vocal Body', group: 'Instruments', desc: 'Amplitude 200–1000 Hz (chest tone of voice, speech vowels)', freqRange: [200, 1000] },
    vocal_range: { label: 'Vocal Range', group: 'Instruments', desc: 'Amplitude 200–3500 Hz (full human voice range including harmonics)', freqRange: [200, 3500] },
    piano_range: { label: 'Piano', group: 'Instruments', desc: 'Amplitude 27–4186 Hz (full piano keyboard A0–C8)', freqRange: [27, 4186] },
    strings_range: { label: 'Strings', group: 'Instruments', desc: 'Amplitude 200–4000 Hz (violin, viola, cello tone body)', freqRange: [200, 4000] },
    brass_range: { label: 'Brass', group: 'Instruments', desc: 'Amplitude 100–2000 Hz (trumpet, trombone, French horn body)', freqRange: [100, 2000] },
    woodwind: { label: 'Woodwind', group: 'Instruments', desc: 'Amplitude 250–3500 Hz (flute, oboe, clarinet, saxophone body)', freqRange: [250, 3500] },
    mid_range: { label: 'Mid-Range', group: 'Instruments', desc: 'Amplitude 800–2500 Hz (vocals, guitar melody, flute, synth leads)', freqRange: [800, 2500] },
    upper_mid: { label: 'Upper-Mid', group: 'Instruments', desc: 'Amplitude 2–5 kHz (vocal consonants, piano attack, string bite)', freqRange: [2000, 5000] },
    presence: { label: 'Presence', group: 'Instruments', desc: 'Amplitude 3–8 kHz (vocal breath, guitar pick attack, consonants)', freqRange: [3000, 8000] },
    snare_crack: { label: 'Snare Crack', group: 'Instruments', desc: 'Amplitude 5–10 kHz (snare crack, rim shots, attack transients)', freqRange: [5000, 10000] },
    hi_hat: { label: 'Hi-Hat', group: 'Instruments', desc: 'Amplitude 8–14 kHz (closed hi-hat tick)', freqRange: [8000, 14000] },
    cymbal: { label: 'Cymbal / Open HH', group: 'Instruments', desc: 'Amplitude 6–18 kHz (ride, open hi-hat, crash wash)', freqRange: [6000, 18000] },
    treble: { label: 'Treble', group: 'Instruments', desc: 'Amplitude 4–20 kHz (overall treble brightness, guitar sparkle)', freqRange: [4000, 20000] },
    air: { label: 'Air / Sheen', group: 'Instruments', desc: 'Amplitude 14–20 kHz (air, shimmer, violin extreme overtones)', freqRange: [14000, 20000] },
    // ── Custom user-defined band ─────────────────────────────────────────────
    freqband: { label: 'Custom Hz Band', group: 'Custom', desc: 'Amplitude sum in a user-defined Hz range — set FreqLo and FreqHi below', hasParams: true },
}

export const MATH_OPS = {
    multiply: { label: 'Multiply', amountLabel: 'x', desc: 'output = input * amount' },
    add: { label: 'Add', amountLabel: '+', desc: 'output = input + amount' },
    subtract: { label: 'Subtract', amountLabel: '-', desc: 'output = input - amount' },
    power: { label: 'Power', amountLabel: '^', desc: 'output = input ^ amount' },
    invert: { label: 'Invert', amountLabel: null, desc: 'output = 1 - input' },
    abs: { label: 'Abs', amountLabel: null, desc: 'output = |input|' },
    clamp01: { label: 'Clamp 0-1', amountLabel: null, desc: 'output = clamp(input, 0, 1)' },
    log: { label: 'Log', amountLabel: 'base', desc: 'output = log_base(1 + input * base)' },
    smoothstep: { label: 'Smooth S', amountLabel: null, desc: 'output = 3t^2 - 2t^3' },
    sin: { label: 'Sine', amountLabel: 'freq', desc: 'output = sin(input * pi * freq)' },
    max_floor: { label: 'Floor', amountLabel: 'min', desc: 'output = max(input, min)' },
    min_ceil: { label: 'Ceil', amountLabel: 'max', desc: 'output = min(input, max)' },
    scale: { label: 'Scale', amountLabel: 'max', desc: 'output = input * max (0-1 to 0-max)' },
}

export const VISUAL_OUTPUTS = {
    radius_mult: { label: 'Radius x', desc: 'Multiplies the base particle radius' },
    hue_add: { label: 'Hue + deg', desc: 'Rotates hue (0-1 maps to 0-360 deg)' },
    saturation: { label: 'Saturation', desc: 'Modify HSL saturation (0-1)' },
    lightness: { label: 'Lightness', desc: 'Modify HSL lightness (0-1)' },
    alpha_mult: { label: 'Alpha x', desc: 'Multiplies the particle alpha/opacity' },
    cx_offset: { label: 'X Offset', desc: 'Horizontal shift (0-1 = +/- half canvas)' },
    cy_offset: { label: 'Y Offset', desc: 'Vertical shift (0-1 = +/- half canvas)' },
    z_offset: { label: 'Z Offset', desc: 'Depth shift (0-1 = +/- half depth)' },
    blur_add: { label: 'Blur + px', desc: 'Adds blur in pixels (0-1 = 0-16 px)' },
    vertices_add: { label: 'Vertices +', desc: 'Adds polygon vertices (0-1 = 0-32 extra)' },
}

export const OUTPUT_MODES = {
    multiply: { label: 'x', desc: 'Multiply existing value' },
    add: { label: '+', desc: 'Add to existing value' },
    set: { label: '=', desc: 'Replace existing value' },
}

// ─────────────────────────────────────────────────────────────────────────────

function _clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)) }

/** Sum amplitudes of all partials whose freq falls in [lo, hi] Hz, clamped 0-1. */
function _freqBandAmp(components, lo, hi) {
    if (!components || !components.length) return 0
    let sum = 0
    for (let i = 0; i < components.length; i++) {
        const c = components[i]
        if (c.freq >= lo && c.freq <= hi) sum += c.amplitude ?? 0
    }
    return _clamp(sum, 0, 1)
}

/** Now takes the full `rule` object so sourceParams are accessible. */
function _readInput(rule, particle, frame) {
    const source = rule.source
    switch (source) {
        case 'amplitude': return _clamp(particle.amplitude ?? 0, 0, 1)
        case 'frequency': return _clamp(particle.freqNorm ?? 0, 0, 1)
        case 'pan': return _clamp(((particle.pan ?? 0) + 1) / 2, 0, 1)
        case 'age': return _clamp((particle.age ?? 0) / 5, 0, 1)
        case 'clarity': return _clamp(particle.clarity ?? 1, 0, 1)
        case 'dissonance': return _clamp(particle.dissonance ?? 0, 0, 1)
        case 'rms': return _clamp(frame.rms ?? 0, 0, 1)
        case 'bpm': return _clamp((frame.bpm ?? 120) / 240, 0, 1)
        // Legacy key kept for preset backward-compatibility
        case 'bassEnergy': return _freqBandAmp(frame.components, 20, 250)
        // Custom user-defined Hz band
        case 'freqband': {
            const lo = rule.sourceParams?.freqLo ?? 0
            const hi = rule.sourceParams?.freqHi ?? 20000
            return _freqBandAmp(frame.components, lo, hi)
        }
        default: {
            // Named instrument frequency bands (have .freqRange in AUDIO_INPUTS)
            const def = AUDIO_INPUTS[source]
            if (def?.freqRange) {
                return _freqBandAmp(frame.components, def.freqRange[0], def.freqRange[1])
            }
            return 0
        }
    }
}

function _applyMath(op, v, amount) {
    const a = amount ?? 1
    switch (op) {
        case 'multiply': return v * a
        case 'add': return v + a
        case 'subtract': return v - a
        case 'power': return Math.pow(Math.max(v, 0), a)
        case 'invert': return 1 - v
        case 'abs': return Math.abs(v)
        case 'clamp01': return _clamp(v, 0, 1)
        case 'log': {
            const base = Math.max(a, 1.01)
            return Math.log(1 + v * base) / Math.log(1 + base)
        }
        case 'smoothstep': {
            const t = _clamp(v, 0, 1)
            return t * t * (3 - 2 * t)
        }
        case 'sin': return (Math.sin(v * Math.PI * Math.max(a, 1)) + 1) / 2
        case 'max_floor': return Math.max(v, a)
        case 'min_ceil': return Math.min(v, a)
        case 'scale': return v * a
        default: return v
    }
}

export class GraphEvaluator {
    constructor() {
        this._rules = []
    }

    /**
     * Compile a flat list of mapping rules.
     * @param {Array} rules  [{ source, op, amount, target, mode?, enabled }]
     */
    compile(rules) {
        this._rules = (rules || []).filter(r => r.enabled !== false)
    }

    /**
     * Evaluate all rules for one particle.
     * @param {object} particle  { amplitude, freqNorm, pan, age, clarity, dissonance }
     * @param {object} frame     { rms, bpm, bassEnergy }
     * @returns {object}  { [target]: { value, mode } }
     */
    evaluate(particle, frame) {
        if (!this._rules.length) return {}
        const results = {}
        for (const rule of this._rules) {
            const raw = _readInput(rule, particle, frame)
            const processed = _applyMath(rule.op, raw, rule.amount)
            results[rule.target] = { value: processed, mode: rule.mode || 'multiply' }
        }
        return results
    }

    get hasGraph() { return this._rules.length > 0 }
}

export const graphEvaluator = new GraphEvaluator()

/** Extract a flat ordered list of enabled rules from the mappingGroups tree. */
export function flattenRules(mappingGroups) {
    const rules = []
    for (const group of mappingGroups || []) {
        for (const rule of group.rules || []) rules.push(rule)
        for (const sub of group.subgroups || []) {
            for (const rule of sub.rules || []) rules.push(rule)
        }
    }
    return rules
}
