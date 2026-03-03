/**
 * SEESOUND — ParamStore.js
 * ════════════════════════════════════════════════════════════════════════════
 * Pure vanilla JS parameter state layer.
 *
 * Responsibilities
 * ─────────────────
 *   • Defines every slider/toggle/dropdown with its full metadata (ported
 *     verbatim from the old frontend/src/config/params.js).
 *   • Exposes a live `params` object the render loop reads every frame.
 *   • Exposes `set(key, value)` for the UI to call.
 *   • Persist user-adjusted defaults to localStorage.
 *   • Subscribe / unsubscribe pattern so main.js can forward changes to the
 *     WebSocket bridge without polling.
 *
 * Usage
 * ──────
 *   import { params, PARAMS, PARAM_GROUPS, set, subscribe, getSnapshot,
 *            loadPreset, savePreset, listPresets, deletePreset } from './engine/ParamStore.js'
 *
 *   // In render loop:
 *   const threshold = params.amplitudeThreshold   // e.g. -48 dB
 *   const decay     = params.releaseDecay          // e.g. 2.0 s
 *
 *   // React to any change:
 *   subscribe(snapshot => bridge.send({ type: 'params_update', payload: snapshot }))
 */

const API = 'http://localhost:8000'
const STORAGE_KEY = 'seesound_user_defaults_v3'
const DISABLED_STORAGE_KEY = 'seesound_disabled_params_v3'

// ─────────────────────────────────────────────────────────────────────────────
// § 1  PARAMETER GROUP DEFINITIONS
// ─────────────────────────────────────────────────────────────────────────────

export const PARAM_GROUPS = [
    { id: 'inputGain', label: 'Input Gain (Sensitivity)' },
    { id: 'geometry', label: 'Geometry Tuner (Shape & Size)' },
    { id: 'texture', label: 'Texture / Timbre Engine' },
    { id: 'colorDynamics', label: 'Color Dynamics' },
    { id: 'mixing', label: 'Mixing Engine (Canvas Physics)' },
    { id: 'advanced', label: 'Advanced Behaviors' },
]

// ─────────────────────────────────────────────────────────────────────────────
// § 2  PARAMETER DEFINITIONS
// ─────────────────────────────────────────────────────────────────────────────
// Each entry is the exact param from the old params.js, adapted to plain JS.

export const PARAMS = [
    // ── Input Gain ─────────────────────────────────────────────────────────────
    {
        key: 'inputGain', group: 'inputGain', label: 'Input Gain',
        min: 0, max: 3, step: 0.01, default: 1.0, unit: '×',
        desc: 'Scales every amplitude value before any processing. At 1× the signal is unchanged. Increase for quiet recordings; decrease if loud tracks produce too many overlapping marks.',
        canDisable: true, neutralValue: 1.0,
    },
    {
        key: 'amplitudeThreshold', group: 'inputGain', label: 'Amplitude Threshold',
        min: -96, max: 0, step: 1, default: -48, unit: 'dB',
        desc: 'Hard noise gate: any frequency component quieter than this level draws nothing. Raise toward 0 dB to show only the strongest partials; lower toward −96 dB to reveal faint overtones.',
        canDisable: true,
    },
    {
        key: 'perceptualLoudness', group: 'inputGain', label: 'Perceptual Loudness Weight',
        min: 0, max: 100, step: 1, default: 60, unit: '%',
        desc: 'Applies ISO 226 A-weighting equal-loudness curve. At 100% mid-range (2–5 kHz) appears much more prominently. At 0% all frequencies are treated equally.',
        canDisable: true,
    },
    {
        key: 'attackSensitivity', group: 'inputGain', label: 'Attack Sensitivity',
        min: 0, max: 100, step: 1, default: 80, unit: '%',
        desc: 'How instantly a new note appears on its first frame. At 100% it fires at full size immediately; at 0% it fades in over ~300 ms.',
        canDisable: true, neutralValue: 100,
    },
    {
        key: 'releaseDecay', group: 'inputGain', label: 'Release / Decay',
        min: 0.05, max: 10, step: 0.05, default: 2.0, unit: 's',
        desc: 'How long a visual mark lingers after its audio component disappears. Short values create sharp reactive display; long values leave ghost trails showing harmonic history.',
        canDisable: true,
    },

    // ── Geometry Tuner ─────────────────────────────────────────────────────────
    {
        key: 'defaultParticleSize', group: 'geometry', label: 'Default Particle Size',
        min: 1, max: 40, step: 0.5, default: 4, unit: 'px',
        desc: 'Sets the base diameter of every particle before modifiers. All size-influencing params multiply on top of this.',
        canDisable: false,
    },
    {
        key: 'freqDepthEffect', group: 'geometry', label: 'Freq Depth (Bass=Bigger)',
        min: 0, max: 100, step: 1, default: 100, unit: '%',
        desc: 'Controls how much bass frequencies are drawn larger than treble. At 0% every particle is drawn at the default particle size regardless of pitch.',
        canDisable: true, neutralValue: 0,
    },
    {
        key: 'magnitudeSizeRatio', group: 'geometry', label: 'Amplitude→Size vs Brightness',
        min: 0, max: 100, step: 1, default: 50, unit: '%',
        desc: 'Splits amplitude energy between size and brightness. 0% = loudness drives opacity only; 100% = loudness drives radius only.',
        canDisable: true,
    },
    {
        key: 'amplitudeSizeStrength', group: 'geometry', label: 'Amplitude Size Strength',
        min: 0, max: 10, step: 0.1, default: 4, unit: '×',
        desc: 'How strongly amplitude enlarges particles when the size channel is active. At 4× a full-volume note is 5× the size of a silent one.',
        canDisable: true, neutralValue: 0,
    },
    {
        key: 'pitchSizeInversion', group: 'geometry', label: 'Pitch→Size Inversion',
        min: 0, max: 100, step: 1, default: 60, unit: '%',
        desc: 'Controls the pitch-to-size mapping direction. Higher values make high frequencies appear larger; lower values preserve bass-bigger behavior.',
        canDisable: true,
    },
    {
        key: 'sizeExponent', group: 'geometry', label: 'Freq→Size Exponent',
        min: 0.1, max: 4.0, step: 0.1, default: 1.5, unit: '×',
        desc: 'Controls how steeply bass notes are drawn larger than treble. At 2.0 bass grows to ~4× while treble stays near 1×.',
        canDisable: true, neutralValue: 1.0,
    },
    {
        key: 'saliencyWeight', group: 'geometry', label: 'Saliency Weight',
        min: 0, max: 200, step: 1, default: 100, unit: '%',
        desc: 'Boosts the size of notes the moment they first appear (within 300 ms). At 200% a new note is drawn at 3× its resting size.',
        canDisable: true,
    },

    // ── Texture / Timbre ───────────────────────────────────────────────────────
    {
        key: 'harmonicRoughness', group: 'texture', label: 'Harmonic Roughness',
        min: 0, max: 100, step: 1, default: 30, unit: '%',
        desc: 'Adds random vertex displacement proportional to harmonic inharmonicity. Dissonant partials become jagged; pure tones remain smooth.',
        canDisable: true,
    },
    {
        key: 'edgeSoftness', group: 'texture', label: 'Edge Softness',
        min: 0, max: 100, step: 1, default: 70, unit: '%',
        desc: 'Controls edge sharpness. At 100% shapes are crisp polygons; at 0% they dissolve into soft glowing blobs.',
        canDisable: true, neutralValue: 100,
    },
    {
        key: 'shapeComplexity', group: 'texture', label: 'Shape Complexity',
        min: 3, max: 64, step: 1, default: 12, unit: 'vtx',
        desc: 'Maximum polygon vertex count. 3 = triangles; 6 = hexagons; 32–64 approximate circles.',
    },

    // ── Color Dynamics ─────────────────────────────────────────────────────────
    {
        key: 'saturationFloor', group: 'colorDynamics', label: 'Saturation Floor',
        min: 0, max: 100, step: 1, default: 20, unit: '%',
        desc: 'Minimum colour saturation for all shapes. Prevents very quiet sounds from rendering as pure grey.',
        canDisable: true,
    },
    {
        key: 'dissonanceDesat', group: 'colorDynamics', label: 'Dissonance Desaturation',
        min: 0, max: 100, step: 1, default: 50, unit: '%',
        desc: 'Shifts dissonant frequency ratios toward grey. Consonant intervals keep their hue; complex ratios wash out.',
        canDisable: true,
    },
    {
        key: 'brightnessScaling', group: 'colorDynamics', label: 'Brightness Scaling',
        min: 0, max: 100, step: 1, default: 50, unit: '%',
        desc: 'Controls whether loudness expresses as opacity (0%) or lightness (100%). Mix values blend both.',
        canDisable: true,
    },

    // ── Mixing Engine ──────────────────────────────────────────────────────────
    {
        key: 'blendMode', group: 'mixing', label: 'Blend Mode',
        default: 'screen', unit: '',
        desc: 'WebGL blending mode for all particles. Screen/Add for dark backgrounds; Multiply for light backgrounds.',
        isDropdown: true, neutralValue: 'source-over',
        dropdownGroups: [
            { label: 'Normal', options: [{ label: 'Normal', value: 'source-over' }] },
            {
                label: 'Lighten', options: [{ label: 'Screen', value: 'screen' },
                { label: 'Color Dodge', value: 'color-dodge' },
                { label: 'Add (Linear Dodge)', value: 'lighter' }]
            },
            {
                label: 'Darken', options: [{ label: 'Darken', value: 'darken' },
                { label: 'Multiply', value: 'multiply' },
                { label: 'Color Burn', value: 'color-burn' }]
            },
            {
                label: 'Contrast', options: [{ label: 'Overlay', value: 'overlay' },
                { label: 'Soft Light', value: 'soft-light' },
                { label: 'Hard Light', value: 'hard-light' }]
            },
            {
                label: 'Inversion', options: [{ label: 'Difference', value: 'difference' },
                { label: 'Exclusion', value: 'exclusion' }]
            },
        ],
    },
    {
        key: 'layoutMode', group: 'mixing', label: 'Layout',
        min: 0, max: 7, step: 1, default: 0, unit: '',
        desc: 'Visual layout mode. Circular (0): polar harmonic space. Linear (1): piano-roll. Chladni (2): nodal lines. Scope (3): Lissajous. L-System (4): fractal tree. Vector (5): pathfinding. Gravity (6): attractor wells. Orbital (7): Lissajous orbits.',
        isDropdown: true,
        dropdownOptions: [
            { label: 'Circular', value: 0 }, { label: 'Linear', value: 1 },
            { label: 'Chladni', value: 2 }, { label: 'Scope', value: 3 },
            { label: 'L-System', value: 4 }, { label: 'Vector', value: 5 },
            { label: 'Gravity', value: 6 }, { label: 'Orbital', value: 7 },
        ],
    },
    {
        key: 'persistMode', group: 'mixing', label: 'Persistence',
        min: 0, max: 1, step: 1, default: 0, unit: '',
        desc: 'Momentary: canvas is darkened slightly each frame creating motion-trail decay. Painting: no clearing — every mark remains permanently.',
        isToggle: true, toggleLabels: ['Momentary', 'Painting'],
    },

    // ── Advanced Behaviors ─────────────────────────────────────────────────────
    {
        key: 'octaveScaling', group: 'advanced', label: 'Octave Scaling',
        min: 0, max: 100, step: 1, default: 50, unit: '%',
        desc: 'Scaling axis for the 2^40 octave proportionality system. Higher values give more visual weight to pitch-class position across octaves.',
        canDisable: true,
    },
    {
        key: 'zDepth', group: 'advanced', label: 'Z-Axis Depth',
        min: 0, max: 100, step: 1, default: 0, unit: '%',
        desc: 'As a note ages it shrinks and fades to simulate depth recession. At 100% old notes shrink to ~20% of their original size.',
        canDisable: true,
    },
    {
        key: 'harmonicClarity', group: 'advanced', label: 'Harmonic Clarity',
        min: 0, max: 100, step: 1, default: 70, unit: '%',
        desc: 'Uses spectral clarity score to modulate blur and shape detail. Pure tones get crisp edges; noisy partials get blur applied.',
        canDisable: true,
    },
    {
        key: 'atmosphericPressure', group: 'advanced', label: 'Atmospheric Pressure',
        min: 0, max: 100, step: 1, default: 30, unit: '%',
        desc: 'Overlays a semi-transparent haze proportional to current RMS level. Dense passages build a coloured atmospheric fog.',
        canDisable: true,
    },
    {
        key: 'lfWash', group: 'advanced', label: 'LF Foundational Wash',
        min: 0, max: 100, step: 1, default: 40, unit: '%',
        desc: 'When bass (below 250 Hz) is prominent, floods background with a faint bass-colour tint. Simulates low-frequency physical resonance.',
        canDisable: true,
    },
    {
        key: 'entropy', group: 'advanced', label: 'Info Entropy Jitter',
        min: 0, max: 100, step: 1, default: 20, unit: '%',
        desc: 'Adds seeded positional noise proportional to simultaneous note count. Dense clusters scatter; single sustained notes are geometrically precise.',
        canDisable: true,
    },
    {
        key: 'kineticPendulum', group: 'advanced', label: 'Kinetic Pendulum',
        min: 0, max: 100, step: 1, default: 50, unit: '%',
        desc: 'Scales active components rendered per frame proportional to detected BPM. Fast passages render more shape slots per frame.',
        canDisable: true,
    },
    {
        key: 'acousticFriction', group: 'advanced', label: 'Acoustic Friction',
        min: 0, max: 100, step: 1, default: 40, unit: '%',
        desc: 'Modulates polygon vertex count from spectral clarity. At 100% distorted chords render as triangles; clean sine tones render as circles.',
        canDisable: true,
    },
    {
        key: 'magneticOrientation', group: 'advanced', label: 'Magnetic Orientation',
        min: 0, max: 100, step: 1, default: 50, unit: '%',
        desc: 'Rotates shape angles toward 0° (top) as if the tonic were a magnetic north pole. Creates more ordered, aligned arrangements.',
        canDisable: true,
    },
    {
        key: 'fluidDynamics', group: 'advanced', label: 'Fluid Dynamics',
        min: 0, max: 100, step: 1, default: 30, unit: '%',
        desc: 'Scales the canvas around its centre proportional to bass energy, creating a breathing zoom effect.',
        canDisable: true,
    },
    {
        key: 'phaseInterference', group: 'advanced', label: 'Phase Interference',
        min: 0, max: 100, step: 1, default: 25, unit: '%',
        desc: 'Tilts the entire canvas proportional to average stereo pan. Pan right = clockwise tilt; pan left = counterclockwise.',
        canDisable: true,
    },
    {
        key: 'fieldRendering', group: 'advanced', label: 'Field Rendering',
        min: 0, max: 100, step: 1, default: 50, unit: '%',
        desc: 'Adds random displacement proportional to dissonance ratio. Consonant intervals cluster precisely; dissonant intervals scatter.',
        canDisable: true,
    },
    {
        key: 'chromaticGravity', group: 'advanced', label: 'Chromatic Gravity',
        min: 0, max: 100, step: 1, default: 50, unit: '%',
        desc: 'Lerps each shape position toward canvas centre. Acts as a gravity well compressing the harmonic field inward.',
        canDisable: true,
    },
    {
        key: 'depthDisplacement', group: 'advanced', label: 'Depth Displacement',
        min: 0, max: 100, step: 1, default: 30, unit: '%',
        desc: 'Enlarges bass shapes by an extra factor proportional to bass energy. Simulates how sub-frequencies displace more air.',
        canDisable: true,
    },
    {
        key: 'sourceSeparation', group: 'advanced', label: 'Source Separation',
        min: 0, max: 100, step: 1, default: 50, unit: '%',
        desc: 'Scales shape radius from spectral clarity, separating clean tonal sources from noisy/diffuse sources visually.',
        canDisable: true,
    },
    {
        key: 'interInstrumental', group: 'advanced', label: 'Inter-Instrumental',
        min: 0, max: 100, step: 1, default: 50, unit: '%',
        desc: 'Nudges dissonant components toward canvas centre. Consonant intervals radiate outward; clashing intervals clump inward.',
        canDisable: true,
    },
]

// ─────────────────────────────────────────────────────────────────────────────
// § 3  STATE
// ─────────────────────────────────────────────────────────────────────────────

/** Load user-saved defaults from localStorage. */
function _loadUserDefaults() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') } catch { return {} }
}

/** Load the set of disabled (bypassed) param keys. */
function _loadDisabled() {
    try { return new Set(JSON.parse(localStorage.getItem(DISABLED_STORAGE_KEY) || '[]')) } catch { return new Set() }
}

/** Build the initial params object from PARAMS definitions + user defaults. */
function _buildInitialParams() {
    const saved = _loadUserDefaults()
    const out = {}
    for (const p of PARAMS) {
        out[p.key] = Object.prototype.hasOwnProperty.call(saved, p.key) ? saved[p.key] : p.default
    }
    // Extra keys not in PARAMS list
    out.noteColors = saved.noteColors ?? _defaultNoteColors()
    out.colorInputMode = saved.colorInputMode ?? 'rgb'
    out.tonicHz = saved.tonicHz ?? 261.63    // C4
    return out
}

function _defaultNoteColors() {
    return {
        C: [255, 0, 0], 'C#': [143, 0, 255], D: [255, 255, 0], 'D#': [183, 70, 139],
        E: [195, 242, 255], F: [170, 0, 52], 'F#': [127, 139, 254], G: [255, 127, 1],
        'G#': [187, 117, 252], A: [54, 204, 51], 'A#': [169, 103, 124], B: [142, 201, 255],
    }
}

/**
 * LIVE PARAMS OBJECT — read by the render loop every frame.
 * Do NOT replace this object; mutate properties in-place via `set()`.
 */
export const params = _buildInitialParams()

/**
 * DISABLED SET — keys whose effect is bypassed in the render loop.
 * The UI checks this to grey out sliders.
 */
export const disabled = _loadDisabled()

// ─────────────────────────────────────────────────────────────────────────────
// § 4  SUBSCRIBER PATTERN
// ─────────────────────────────────────────────────────────────────────────────

/** @type {Set<(snapshot: object, changedKey: string, changedValue: any) => void>} */
const _listeners = new Set()

/**
 * Subscribe to any parameter change.
 * The callback receives `(snapshot, changedKey, changedValue)`.
 * Returns an unsubscribe function.
 */
export function subscribe(cb) {
    _listeners.add(cb)
    return () => _listeners.delete(cb)
}

function _notify(key, value) {
    for (const cb of _listeners) cb(params, key, value)
}

// ─────────────────────────────────────────────────────────────────────────────
// § 5  WRITE API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Update a single parameter value.
 * Mutates `params` in-place and notifies all subscribers.
 *
 * @param {string} key  Parameter key (e.g. 'amplitudeThreshold')
 * @param {*}      value
 */
export function set(key, value) {
    params[key] = value
    _notify(key, value)
}

/**
 * Update multiple parameters at once (e.g., when loading a preset).
 * Fires a single notification per call.
 */
export function setMany(updates) {
    for (const [k, v] of Object.entries(updates)) params[k] = v
    _notify('*', updates)
}

/**
 * Reset all params to factory defaults (from PARAMS definitions).
 */
export function resetToDefaults() {
    for (const p of PARAMS) params[p.key] = p.default
    params.noteColors = _defaultNoteColors()
    params.colorInputMode = 'rgb'
    params.tonicHz = 261.63
    _notify('*', null)
}

/**
 * Persist the current value of `key` as the user's saved default.
 */
export function saveUserDefault(key, value) {
    try {
        const saved = _loadUserDefaults()
        saved[key] = value
        localStorage.setItem(STORAGE_KEY, JSON.stringify(saved))
    } catch { /**/ }
}

/**
 * Toggle a param key in the disabled set.
 */
export function toggleDisabled(key) {
    if (disabled.has(key)) disabled.delete(key)
    else disabled.add(key)
    try {
        localStorage.setItem(DISABLED_STORAGE_KEY, JSON.stringify([...disabled]))
    } catch { /**/ }
    _notify('disabled', key)
}

/**
 * Return a plain snapshot of params + disabled keys, suitable for
 * JSON serialisation / WebSocket transport.
 */
export function getSnapshot() {
    return { ...params, _disabled: [...disabled] }
}


// ─────────────────────────────────────────────────────────────────────────────
// § 6  PRESET API  (talks to backend/server.py)
// ─────────────────────────────────────────────────────────────────────────────

export async function listPresets() {
    try {
        const r = await fetch(`${API}/api/presets`)
        if (!r.ok) return []
        const { presets } = await r.json()
        return presets ?? []
    } catch { return [] }
}

export async function savePreset(name, paramsObj) {
    const r = await fetch(`${API}/api/presets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, params: paramsObj }),
    })
    return r.json()
}

export async function loadPreset(name) {
    const r = await fetch(`${API}/api/presets/${encodeURIComponent(name)}`)
    if (!r.ok) return null
    return r.json()
}

export async function deletePreset(name) {
    const r = await fetch(`${API}/api/presets/${encodeURIComponent(name)}`, { method: 'DELETE' })
    return r.json()
}
