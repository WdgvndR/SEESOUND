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
    amplitude: { label: 'Amplitude', group: 'Particle', desc: 'Normalised loudness of this partial (0-1)' },
    frequency: { label: 'Frequency', group: 'Particle', desc: 'Log-normalised pitch of this partial (0 = 20 Hz, 1 = 20 kHz). Maps every detected frequency component — bassier notes yield low values, higher-pitched notes yield values closer to 1.' },
    pan: { label: 'Pan (L/R)', group: 'Particle', desc: 'Stereo position of this partial (0 = hard left, 0.5 = centre, 1 = hard right). Use to push left-panned sounds to the left of the canvas and right-panned sounds to the right.' },
    stereo: { label: 'Stereo Width', group: 'Particle', desc: 'Absolute distance from the stereo centre (0 = dead centre, 1 = fully panned either side). Ignores L/R direction — triggers equally for hard-left and hard-right signals.' },
    age: { label: 'Age', group: 'Particle', desc: 'How long this partial has been active (5 s = 1.0). Fade in late-sustaining notes, grow shapes over time, or trigger decay effects once a note has been held long enough.' },
    timbre: { label: 'Timbre Brightness', group: 'Particle', desc: 'Spectral brightness of this partial: ratio of energy in upper harmonics vs. fundamental (0 = dark/mellow, 1 = bright/rich overtones). Distinguishes a bright electric guitar from a mellow double bass even at the same pitch and loudness.' },
    clarity: { label: 'Clarity', group: 'Particle', desc: 'Spectral purity; 1 = pure sine tone, 0 = noise/inharmonic. High clarity = flute, tuning fork; low clarity = distorted guitar, cymbals, breath noise.' },
    dissonance: { label: 'Dissonance', group: 'Particle', desc: 'Harmonic roughness of this partial (0 = consonant, 1 = dissonant). Peaks when two close-frequency partials beat against each other.' },
    // ── Instrument likelihood (per-partial) ──────────────────────────────────
    inst_percussive: { label: 'Percussive Strike', group: 'Instruments', desc: 'Likelihood this partial belongs to a percussive event (0-1). High on sharp transients like drums, piano attacks and plucked strings. Derived from onset strength and spectral flux.' },
    inst_sustain: { label: 'Sustained Tone', group: 'Instruments', desc: 'Likelihood this partial belongs to a sustained tonal instrument (0-1). High on organ, strings, pads and held vocal notes. Functionally the inverse of Percussive Strike.' },
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
    // ── COLOR OVERRIDE ────────────────────────────────────────────────────────
    color_override: { label: 'Color Override', group: 'Color', desc: 'Replaces the particle colour with a custom-picked colour. The input signal acts as activation strength (0 = off, 1 = full override). Rules lower in the list take priority when both are active.' },
    // ── PARTICLE ──────────────────────────────────────────────────────────────
    quantity_mult: { label: 'Quantity x', group: 'Particle', desc: 'Multiplies the number of particles drawn this frame (>1 spawns extra copies; <1 culls some). Map a loud bass hit to burst out dense particle clouds.' },
    radius_mult: { label: 'Size x', group: 'Particle', desc: 'Multiplies the base particle radius. 1 = unchanged; 2 = double size; 0 = invisible.' },
    vertices_add: { label: 'No. of Vertices +', group: 'Particle', desc: 'Adds polygon vertices (0-1 = 0-32 extra). Low = triangles/squares; high = smooth near-circles. Dissonance -> vertices makes clashing intervals look spiky.' },
    hue_add: { label: 'Color / Hue +deg', group: 'Particle', desc: 'Rotates the assigned hue by up to 360 deg. 0.5 shifts by 180 deg (complementary colour). Frequency -> hue tints bass red and treble blue.' },
    blend_mode_idx: { label: 'Mixing Mode (Blend)', group: 'Particle', desc: 'Cycles through Photoshop-style blend modes (0=Normal, 0.14=Screen, 0.28=Add, 0.43=Multiply, 0.57=Overlay, 0.71=Color Dodge, 0.86=Difference, 1=Luminosity). Map loudness to toggle from Screen to Add on peaks.' },
    saturation: { label: 'Saturation', group: 'Particle', desc: 'Drives HSL saturation (0 = grey, 1 = full colour). Dissonance -> saturation desaturates clashing intervals toward grey.' },
    alpha_mult: { label: 'Opacity x', group: 'Particle', desc: 'Multiplies particle alpha. 0 = invisible, 1 = fully opaque. Amplitude -> opacity fades quiet partials to nothing.' },
    cx_offset: { label: 'Location X', group: 'Particle', desc: 'Horizontal canvas offset (0-1 = +/- half canvas width). Stereo pan -> X offset creates a physically accurate stereo spread left/right.' },
    cy_offset: { label: 'Location Y', group: 'Particle', desc: 'Vertical canvas offset (0-1 = +/- half canvas height). Frequency -> Y builds a visual spectrum-analyser strip.' },
    z_offset: { label: 'Location Z', group: 'Particle', desc: 'Depth offset in 3-D mode (0-1 = +/- half depth range). Age -> Z sends older partials deeper, creating a time-tunnel effect.' },
    speed_mult: { label: 'Speed x', group: 'Particle', desc: 'Multiplies particle movement / animation speed. Amplitude -> speed makes peaks energetic; low values freeze particles for ambient textures.' },
    spread_mult: { label: 'Spread x', group: 'Particle', desc: 'Multiplies the spatial scatter radius around the base position. 0 = tightly clustered; 2 = twice as scattered. Dissonance -> spread visually loosens harmonically dense passages.' },
    lightness: { label: 'Brightness', group: 'Particle', desc: 'Drives HSL lightness (0 = black, 0.5 = true colour, 1 = white). Amplitude -> brightness makes loud notes glow.' },
    blur_add: { label: 'Blur / Sharpness', group: 'Particle', desc: 'Adds gaussian blur (0-1 = 0-16 px). 0 = razor-sharp; 1 = heavily blurred halo. Timbre -> blur makes bright tones crisp and dark tones soft.' },
    // ── PHYSICS ───────────────────────────────────────────────────────────────
    wind: { label: 'Wind', group: 'Physics', desc: 'Horizontal drift force on particles (0-1 = calm to gale-force). Map stereo pan -> wind to sweep the mix across the canvas like a physical wind from left to right.' },
    waves: { label: 'Waves', group: 'Physics', desc: 'Sinusoidal wave force perpendicular to motion (0 = still, 1 = max amplitude). Bass -> waves creates a rolling low-frequency visual swell.' },
    gravity: { label: 'Gravity', group: 'Physics', desc: 'Downward pull force (0 = weightless, 1 = strong gravity). Kick-drum energy -> gravity makes particles fall like rain after each beat.' },
    antigravity: { label: 'Anti-gravity / Explosion', group: 'Physics', desc: 'Upward/outward burst AND energy injection (spawns extra particles). 0 = none; 1 = violent explosion radiating outward. Map RMS peaks to create big-bang moments on loud drops.' },
    fission: { label: 'Fission (Particle Split)', group: 'Physics', desc: 'Probability each particle splits into two smaller particles per frame (0 = never, 1 = always). High dissonance -> fission shatters stable tones into chaotic clouds.' },
    fusion: { label: 'Fusion (Particle Merge)', group: 'Physics', desc: 'Attraction force pulling nearby particles together to merge into one larger particle (0 = no fusion, 1 = strong pull). Consonance -> fusion unifies harmonic overtones into a single glowing mass.' },
    // ── CAMERA ────────────────────────────────────────────────────────────────
    camera_zoom: { label: 'Camera FOV', group: 'Camera', desc: 'Drives camera field-of-view (0 = max telephoto zoom-in, 1 = wide-angle). Map bass energy to push-in on heavy hits.' },
    camera_distance: { label: 'Camera Distance', group: 'Camera', desc: 'Orbit radius — how far the camera sits from the origin (0 = deep inside, 1 = far back). BPM -> distance creates a tempo-locked dive.' },
    camera_azimuth: { label: 'Camera H-Revolution', group: 'Camera', desc: 'Horizontal orbit angle around origin (0–1 = 0–360°). Stereo pan → azimuth sweeps the camera left/right around the scene.' },
    camera_elevation: { label: 'Camera V-Revolution', group: 'Camera', desc: 'Vertical orbit angle (0–1 = −89° to +89°). Frequency → elevation lifts the camera from bass floor to treble ceiling.' },
    camera_speed: { label: 'Camera Speed x', group: 'Camera', desc: 'Multiplies all camera movement velocities (0 = frozen, 1 = normal, 2 = double). RMS → speed makes the camera rush during loud passages.' },
}

/** VISUAL_OUTPUTS grouped by category for optgroup rendering in the output select. */
export const VISUAL_OUTPUT_GROUPS = (() => {
    const order = ['Color', 'Particle', 'Physics', 'Camera']
    const map = {}
    for (const [key, def] of Object.entries(VISUAL_OUTPUTS)) {
        const g = def.group || 'Particle'
        if (!map[g]) map[g] = []
        map[g].push({ value: key, label: def.label, desc: def.desc })
    }
    return order.filter(g => map[g]).map(g => ({ group: g, options: map[g] }))
})()

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
        case 'stereo': return _clamp(Math.abs(particle.pan ?? 0), 0, 1)  // |pan| → 0 = centre, 1 = hard panned
        case 'age': return _clamp((particle.age ?? 0) / 5, 0, 1)
        case 'timbre': return _clamp(particle.timbre ?? particle.clarity ?? 0, 0, 1)
        case 'inst_percussive': return _clamp(particle.percussive ?? 0, 0, 1)
        case 'inst_sustain': return _clamp(1 - (particle.percussive ?? 0), 0, 1)
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

function _applyMath(op, v, amount, mathArgs) {
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
        // ── Extra ops used by CustomMappingEditor ────────────────────────────
        case 'passthrough': return v
        case 'sqrt': return Math.sqrt(Math.max(v, 0))
        case 'threshold': return v >= a ? 1 : 0
        case 'map_range': {
            // mathArgs: [i0, i1, o0, o1]
            const [i0 = 0, i1 = 1, o0 = 0, o1 = 1] = mathArgs || []
            if (i1 === i0) return o0
            return o0 + (v - i0) / (i1 - i0) * (o1 - o0)
        }
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
     * @param {object} frame     { rms, bpm, bassEnergy, components }
     * @returns {object}  { [target]: { value, mode } }
     */
    evaluate(particle, frame) {
        if (!this._rules.length) return {}
        const results = {}
        for (const rule of this._rules) {
            const raw = _readInput(rule, particle, frame)
            const processed = _applyMath(rule.op, raw, rule.amount, rule.mathArgs)

            if (rule.target === 'color_override') {
                // "Last active rule wins" — only overwrite when this rule is firing (> threshold).
                // An inactive lower rule (value ≤ 0.05) must NOT shadow an active higher rule.
                if (processed > 0.05) {
                    results.color_override = {
                        value: processed,
                        mode: 'set',
                        colorHex: rule.colorHex || '#ffffff',
                    }
                }
            } else {
                results[rule.target] = { value: processed, mode: rule.mode || 'multiply' }
            }
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
