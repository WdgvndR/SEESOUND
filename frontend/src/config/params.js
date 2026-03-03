/**
 * SEESOUND — Global Parameter Matrix
 *
 * Every slider in the UI is defined here with its key, label, group,
 * min/max/step, default, unit, and description.
 *
 * The rendering engine reads these values each frame.
 * The WebSocket sends the full params object whenever a slider changes.
 */

// ── Parameter group definitions ─────────────────────────────────────────────

export const PARAM_GROUPS = [
    { id: 'inputGain', label: 'Input Gain (Sensitivity)' },
    { id: 'geometry', label: 'Geometry Tuner (Shape & Size)' },
    { id: 'texture', label: 'Texture / Timbre Engine' },
    { id: 'colorDynamics', label: 'Color Dynamics' },
    { id: 'mixing', label: 'Mixing Engine (Canvas Physics)' },
    { id: 'advanced', label: 'Advanced Behaviors' },
];

// ── Individual parameters ───────────────────────────────────────────────────

export const PARAMS = [
    // ─── Input Gain ───────────────────────────────────────────────────────────
    { key: 'inputGain', group: 'inputGain', label: 'Input Gain', min: 0, max: 3, step: 0.01, default: 1.0, unit: '×', desc: 'Scales every amplitude value before any processing. At 1× the signal is unchanged. Increase for quiet recordings to push shapes into visibility; decrease if loud tracks produce too many overlapping marks. Acts as a master brightness/size control.', canDisable: true, neutralValue: 1.0 },
    { key: 'amplitudeThreshold', group: 'inputGain', label: 'Amplitude Threshold', min: -96, max: 0, step: 1, default: -48, unit: 'dB', desc: 'Hard noise gate: any frequency component quieter than this level is completely ignored and draws nothing. Raise toward 0 dB to show only the strongest partials and remove clutter from background noise. Lower toward −96 dB to reveal very faint overtones and reverb tails.', canDisable: true },
    { key: 'perceptualLoudness', group: 'inputGain', label: 'Perceptual Loudness Weight', min: 0, max: 100, step: 1, default: 60, unit: '%', desc: 'Applies an ISO 226 A-weighting equal-loudness curve to the amplitude. At 100% the rendering matches how humans actually perceive volume — mid-range frequencies (2–5 kHz) appear much more prominently than extreme bass or treble at the same physical energy level. At 0% all frequencies are treated equally regardless of perceptual weight.', canDisable: true },
    { key: 'attackSensitivity', group: 'inputGain', label: 'Attack Sensitivity', min: 0, max: 100, step: 1, default: 80, unit: '%', desc: 'Controls how instantly a new note appears on its very first frame. At 100% a newly detected component fires at full size immediately. At 0% it fades in over ~300 ms. Reduce to soften percussive transients (drums, piano attacks) that would otherwise create distracting sudden spikes.', canDisable: true, neutralValue: 100 },
    { key: 'releaseDecay', group: 'inputGain', label: 'Release / Decay', min: 0.05, max: 10, step: 0.05, default: 2.0, unit: 's', desc: 'How long a visual mark lingers after its audio component disappears. Short values (0.05 s) make shapes vanish almost instantly for a sharp, reactive display. Long values (5–10 s) leave ghost trails that show harmonic history. Affects the componentAges map — stale entries older than 2× this value are purged.', canDisable: true },

    // ─── Geometry Tuner ───────────────────────────────────────────────────────
    { key: 'defaultParticleSize', group: 'geometry', label: 'Default Particle Size', min: 1, max: 40, step: 0.5, default: 4, unit: 'px', desc: 'Sets the base diameter of every particle before any modifiers are applied. All size-influencing parameters (amplitude, freq-depth, saliency, z-depth) multiply on top of this value. At 4 px the particle is a 4 px-diameter dot at neutral settings; raise to 20 px for large blobs, lower to 1 px for fine-grain dot plots. You can type a value above the slider max for extreme sizes.', canDisable: false },
    { key: 'freqDepthEffect', group: 'geometry', label: 'Freq Depth (Bass=Bigger)', min: 0, max: 100, step: 1, default: 100, unit: '%', desc: 'Controls how much bass frequencies are drawn larger than treble frequencies. At 100% the full logarithmic bass-enlargement curve is applied (bass = 2× default size, treble = 1×). At 0% every particle is drawn at exactly the Default Particle Size regardless of pitch — all frequencies appear the same size. Intermediate values smoothly blend between flat and depth-scaled.', canDisable: true, neutralValue: 0 },
    { key: 'magnitudeSizeRatio', group: 'geometry', label: 'Amplitude→Size vs Brightness', min: 0, max: 100, step: 1, default: 50, unit: '%', desc: 'Splits amplitude energy between two visual channels. At 0% loudness drives only opacity/brightness — a loud note glows but stays the same size. At 100% loudness drives only radius — a loud note grows but stays the same brightness. Mid values blend both. Use Amplitude Size Strength to control how large the size swing actually gets.', canDisable: true },
    { key: 'amplitudeSizeStrength', group: 'geometry', label: 'Amplitude Size Strength', min: 0, max: 10, step: 0.1, default: 4, unit: '×', desc: 'Sets how strongly amplitude (loudness) enlarges particles when the Amplitude→Size channel is active. At 0× loud and quiet notes are drawn at the same size (only brightness changes). At 4× (default) a full-volume note is 5× the size of a silent one. At 10× loud hits produce very large shapes. Works together with the Amplitude→Size vs Brightness split.', canDisable: true, neutralValue: 0 },
    { key: 'pitchSizeInversion', group: 'geometry', label: 'Pitch→Size Inversion', min: 0, max: 100, step: 1, default: 60, unit: '%', desc: 'Reserved for a future pitch-driven size modulation axis (currently governed by the Freq→Size Exponent). Will allow independent scaling of the pitch-to-size mapping direction without affecting the overall exponent curve.', canDisable: true },
    { key: 'sizeExponent', group: 'geometry', label: 'Freq→Size Exponent', min: 0.1, max: 4.0, step: 0.1, default: 1.5, unit: '×', desc: 'Controls how steeply bass notes are drawn larger than treble notes. At 1.0 the size gradient is linear (bass = 2× base, treble = 1× base). At 2.0 bass grows to ~4× while treble stays near 1×. At 0.1 the difference is barely perceptible. Higher values create dramatic low-frequency blobs contrasting with tiny high-frequency dots.', canDisable: true, neutralValue: 1.0 },
    { key: 'saliencyWeight', group: 'geometry', label: 'Saliency Weight', min: 0, max: 200, step: 1, default: 100, unit: '%', desc: 'Boosts the size of notes the moment they first appear (within the first 300 ms of detection). Mimics how the human auditory system highlights sudden onsets. At 0% all notes appear at their steady-state size. At 200% a new note is drawn at 3× its resting size and then smoothly decays to normal, creating a visual "pop" on each attack.', canDisable: true },

    // ─── Texture / Timbre ────────────────────────────────────────────────────
    { key: 'harmonicRoughness', group: 'texture', label: 'Harmonic Roughness', min: 0, max: 100, step: 1, default: 30, unit: '%', desc: 'Adds random vertex displacement to each shape proportional to harmonic inharmonicity. At 0% all shapes are smooth polygons. At 100% dissonant partials become jagged and irregular while pure tones remain smooth. Creates a perceptual link between tonal quality and visual texture.', canDisable: true },
    { key: 'edgeSoftness', group: 'texture', label: 'Edge Softness', min: 0, max: 100, step: 1, default: 70, unit: '%', desc: 'Controls the sharpness of each shape’s edge via CSS blur and alpha falloff. At 100% all shapes are crisp hard-edged polygons. At 0% shapes dissolve into soft glowing blobs with a large feathered halo. Intermediate values create a watercolour-like wash.', canDisable: true, neutralValue: 100 },
    { key: 'shapeComplexity', group: 'texture', label: 'Shape Complexity', min: 3, max: 64, step: 1, default: 12, unit: 'vtx', desc: 'Sets the maximum polygon vertex count. 3 = triangles; 4 = squares; 6 = hexagons; 32–64 approximate circles. The actual vertex count per shape is modulated downward by dissonance (via Acoustic Friction), so complex chords naturally produce simpler, rougher shapes than pure tones.' },

    // ─── Color Dynamics ──────────────────────────────────────────────────────
    { key: 'saturationFloor', group: 'colorDynamics', label: 'Saturation Floor', min: 0, max: 100, step: 1, default: 20, unit: '%', desc: 'Sets a minimum color saturation for all shapes, preventing very quiet or dissonant sounds from rendering as pure grey. At 0% silence-level sounds are fully desaturated. At 100% everything, even inaudible components, retains the full assigned hue. Useful for ensuring visual richness even in sparse passages.', canDisable: true },
    { key: 'dissonanceDesat', group: 'colorDynamics', label: 'Dissonance Desaturation', min: 0, max: 100, step: 1, default: 50, unit: '%', desc: 'Shifts dissonant frequency ratios toward grey. Consonant intervals (octaves, fifths, thirds) keep their assigned hue. The more complex the ratio denominator, the more washed-out the color becomes. At 100% dense chromatic clusters render almost monochrome while pure tones remain vivid. Visually encodes harmonic tension as color purity.', canDisable: true },
    { key: 'brightnessScaling', group: 'colorDynamics', label: 'Brightness Scaling', min: 0, max: 100, step: 1, default: 50, unit: '%', desc: 'Controls whether loudness expresses itself via opacity or lightness. At 0% loud notes become more opaque/transparent but keep mid-range lightness. At 100% loud notes become brighter (higher HSL lightness) while quiet notes appear dark. Mix values blend both approaches for a natural luminous feel.', canDisable: true },

    // ─── Mixing Engine ───────────────────────────────────────────────────────
    {
        key: 'blendMode', group: 'mixing', label: 'Blend Mode', default: 'screen', unit: '', desc: 'Sets the canvas 2D compositing mode for all particles — equivalent to Photoshop layer blend modes. Lighten group (Screen, Color Dodge, Lighten) works best on dark backgrounds. Darken group (Multiply, Color Burn, Darken) works best on light backgrounds. Contrast modes (Overlay, Soft Light, Hard Light) interact with the mid-tone of whatever is already on canvas. Difference and Exclusion invert color relationships. Component modes (Hue, Saturation, Color, Luminosity) affect only one perceptual dimension.', isDropdown: true, neutralValue: 'source-over',
        dropdownGroups: [
            { label: 'Normal', options: [{ label: 'Normal', value: 'source-over' }] },
            { label: 'Lighten', options: [{ label: 'Lighten', value: 'lighten' }, { label: 'Screen', value: 'screen' }, { label: 'Color Dodge', value: 'color-dodge' }, { label: 'Add (Linear Dodge)', value: 'lighter' }] },
            { label: 'Darken', options: [{ label: 'Darken', value: 'darken' }, { label: 'Multiply', value: 'multiply' }, { label: 'Color Burn', value: 'color-burn' }] },
            { label: 'Contrast', options: [{ label: 'Overlay', value: 'overlay' }, { label: 'Soft Light', value: 'soft-light' }, { label: 'Hard Light', value: 'hard-light' }] },
            { label: 'Inversion', options: [{ label: 'Difference', value: 'difference' }, { label: 'Exclusion', value: 'exclusion' }] },
            { label: 'Component', options: [{ label: 'Hue', value: 'hue' }, { label: 'Saturation', value: 'saturation' }, { label: 'Color', value: 'color' }, { label: 'Luminosity', value: 'luminosity' }] },
        ]
    },
    { key: 'layoutMode', group: 'mixing', label: 'Layout', min: 0, max: 8, step: 1, default: 0, unit: '', desc: 'Circular (0): polar harmonic space. Linear (1): piano-roll time/freq. Chladni (2): vibrating membrane nodal lines. Scope (3): Lissajous spirograph. L-System (4): branching fractal tree. Vector (5): relative pathfinding — heading steered by musical intervals, speed by amplitude, timbre as friction. Gravity (6): harmony sets attractor/repulsor wells — dissonant notes are flung outward, consonant notes pulled into wells. Orbital (7): each note anchored at its circular position, orbiting as a Lissajous figure driven by its L/R phase relationship and harmonic overtones. 3D Deep Space (8): GPU-accelerated Three.js renderer — InstancedMesh particle tunnel with Z-axis temporal history, frequency→depth mapping, UnrealBloom post-processing, AfterimagePass persistence, TubeGeometry sustained-note splines, and audio-reactive camera FOV with orbital drift.', isDropdown: true, dropdownOptions: [{ label: 'Circular', value: 0 }, { label: 'Linear', value: 1 }, { label: 'Chladni', value: 2 }, { label: 'Scope', value: 3 }, { label: 'L-System', value: 4 }, { label: 'Vector', value: 5 }, { label: 'Gravity', value: 6 }, { label: 'Orbital', value: 7 }, { label: '3D Deep Space', value: 8 }] },
    { key: 'persistMode', group: 'mixing', label: 'Persistence', min: 0, max: 1, step: 1, default: 0, unit: '', desc: 'Momentary: the canvas is darkened slightly each frame creating a motion-trail decay effect — older marks fade away. Painting: no clearing ever occurs, every mark drawn remains on canvas permanently. In Painting mode, canvas-wide fill effects (LF Wash, Atmospheric Pressure, etc.) are bypassed to avoid overwriting accumulated marks. Use Clear button to reset.', isToggle: true, toggleLabels: ['Momentary', 'Painting'] },

    // ─── Advanced Behaviors ──────────────────────────────────────────────────
    { key: 'octaveScaling', group: 'advanced', label: 'Octave Scaling', min: 0, max: 100, step: 1, default: 50, unit: '%', desc: 'Reserved scaling axis related to the 2´40 octave proportionality system used in harmonic analysis. Higher values give proportionally more visual weight to pitch-class position across octaves relative to the root frequency.', canDisable: true },
    { key: 'zDepth', group: 'advanced', label: 'Z-Axis Depth', min: 0, max: 100, step: 1, default: 40, unit: '%', desc: 'As a note ages on screen, it shrinks and fades to simulate recession into depth. At 0% all notes maintain their original size regardless of age. At 100% a note that has been visible for several seconds shrinks to ~20% of its original size and becomes nearly transparent. Creates a layered depth illusion in Momentary mode.', canDisable: true },
    { key: 'harmonicClarity', group: 'advanced', label: 'Harmonic Clarity', min: 0, max: 100, step: 1, default: 70, unit: '%', desc: 'Uses each component’s spectral clarity score (0–1) to modulate blur and shape detail. At 100% pure tones (clarity≈1.0) get crisp edges and maximum vertex count; noisy/inharmonic components get gaussian blur applied. At 0% all components are drawn identically regardless of tonal purity.', canDisable: true },
    { key: 'atmosphericPressure', group: 'advanced', label: 'Atmospheric Pressure', min: 0, max: 100, step: 1, default: 30, unit: '%', desc: 'Overlays a semi-transparent haze on the canvas each frame, proportional to the current overall RMS level. Loud, dense passages build up a coloured atmospheric fog (dark purple in Light mode, warm beige in Pigment mode). Creates a sense of sonic density and ambient pressure. Only active in Momentary mode.', canDisable: true },
    { key: 'lfWash', group: 'advanced', label: 'LF Foundational Wash', min: 0, max: 100, step: 1, default: 40, unit: '%', desc: 'When bass frequencies (below 250 Hz) are prominent, this floods the canvas background with a faint tint of the averaged bass component color. Simulates how low frequencies physically resonate through a space. Scale at 0% = no wash; 100% = strong background tinting on heavy bass hits. Only active in Momentary mode.', canDisable: true },
    { key: 'entropy', group: 'advanced', label: 'Info Entropy Jitter', min: 0, max: 100, step: 1, default: 20, unit: '%', desc: 'Adds seeded positional noise proportional to the number of unique simultaneous notes. A single sustained note adds no jitter. A dense 12-tone cluster spreads all shapes by up to this amount in pixels. Encodes harmonic complexity as spatial chaos — ordered music is geometrically precise, complex music is organic and scattered.', canDisable: true },
    { key: 'kineticPendulum', group: 'advanced', label: 'Kinetic Pendulum', min: 0, max: 100, step: 1, default: 50, unit: '%', desc: 'Scales the number of active components rendered each frame proportional to the detected BPM. At 100% a fast 180 BPM track renders 50% more shape slots per frame than a slow 60 BPM piece. Creates a kinetic energy link between musical tempo and visual density/activity.', canDisable: true },
    { key: 'acousticFriction', group: 'advanced', label: 'Acoustic Friction', min: 0, max: 100, step: 1, default: 40, unit: '%', desc: 'Modulates the actual polygon vertex count based on spectral clarity. At 100% this parameter fully governs how much the Acoustic Friction axis reduces vertex count for noisy/inharmonic timbres — a distorted guitar chord renders as triangles while a clean sine tone renders as a circle. At 0% clarity has no effect on vertex count.', canDisable: true },
    { key: 'magneticOrientation', group: 'advanced', label: 'Magnetic Orientation', min: 0, max: 100, step: 1, default: 50, unit: '%', desc: 'Rotates the angle of each shape’s position slightly toward the 0° (top) orientation, as if the tonic were acting as a magnetic north pole pulling all harmonics upward. Higher values create a more ordered, aligned arrangement on the canvas. Only active in Circular layout mode.', canDisable: true },
    { key: 'fluidDynamics', group: 'advanced', label: 'Fluid Dynamics', min: 0, max: 100, step: 1, default: 30, unit: '%', desc: 'Scales the canvas around its centre by a small amount proportional to bass energy, creating a breathing/pulsing zoom effect. At high values (70–90%) heavy bass hits visibly push the canvas outward like a pressure wave before it settles. Acts as a global FOV breath. Only active in Momentary mode.', canDisable: true },
    { key: 'phaseInterference', group: 'advanced', label: 'Phase Interference', min: 0, max: 100, step: 1, default: 25, unit: '%', desc: 'Tilts the entire canvas by a small angle proportional to the average stereo pan of the current frame. If the mix pans right, the canvas rotates slightly clockwise; pan left = counterclockwise. Encodes spatial stereo information as a physical tilt of the visual field. Only active in Momentary mode.', canDisable: true },
    { key: 'fieldRendering', group: 'advanced', label: 'Field Rendering', min: 0, max: 100, step: 1, default: 50, unit: '%', desc: 'Adds an extra random displacement to each shape proportional to both this value and the component’s dissonance ratio. Consonant intervals cluster precisely at their computed positions; dissonant intervals scatter. At 0% the layout is mathematically precise. At 100% dissonant notes spread into an organic cloud while consonant notes remain ordered.', canDisable: true },
    { key: 'chromaticGravity', group: 'advanced', label: 'Chromatic Gravity', min: 0, max: 100, step: 1, default: 50, unit: '%', desc: 'Lerps every shape’s position toward the canvas centre by a fixed fraction. Acts as a gravity well that compresses the harmonic field inward. At 0% shapes reach the full extent of their computed polar/squircle position. At 100% everything collapses 30% toward centre. Only active in Circular mode.', canDisable: true },
    { key: 'depthDisplacement', group: 'advanced', label: 'Depth Displacement', min: 0, max: 100, step: 1, default: 30, unit: '%', desc: 'Enlarges bass frequency shapes (below 250 Hz) by an additional factor proportional to the current bass energy and this slider. Simulates how subfrequencies physically displace more air and occupy more physical space. At 100%, a heavy kick drum component can grow to 1.5× its calculated radius relative to a quiet passage.', canDisable: true },
    { key: 'sourceSeparation', group: 'advanced', label: 'Source Separation', min: 0, max: 100, step: 1, default: 50, unit: '%', desc: 'Scales each shape’s radius based on spectral clarity, providing visual separation between clean tonal sources and noisy/diffuse sources. At 100% a perfectly clear tone renders at full size while noisy partials shrink to 50% radius. Helps visually distinguish individual instruments from background noise or reverb tails.', canDisable: true },
    { key: 'interInstrumental', group: 'advanced', label: 'Inter-Instrumental', min: 0, max: 100, step: 1, default: 50, unit: '%', desc: 'Nudges dissonant components toward the canvas centre proportionally. Consonant intervals (simple ratios) stay spread across the harmonic field; clashing intervals are pulled inward. At high values dissonant notes clump at the centre while consonant notes radiate outward, giving a visual representation of harmonic tension vs. resolution. Only active in Circular mode.', canDisable: true },
];

// ── Default values + localStorage persistence ────────────────────────────────

const STORAGE_KEY = 'seesound_user_defaults';

/** Load any defaults the user has saved via the UI. */
export function loadUserDefaults() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        return raw ? JSON.parse(raw) : {};
    } catch {
        return {};
    }
}

/** Persist a single key's default value. */
export function saveUserDefault(key, value) {
    try {
        const current = loadUserDefaults();
        const next = { ...current, [key]: value };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
        return next;
    } catch {
        return {};
    }
}

/** Clear all user-saved defaults (restore factory values). */
export function clearUserDefaults() {
    try {
        localStorage.removeItem(STORAGE_KEY)
    } catch { }
}

// ── Disabled params persistence ─────────────────────────────────────────────────────────

const DISABLED_KEY = 'seesound_disabled_params'

export function loadDisabledParams() {
    try { return JSON.parse(localStorage.getItem(DISABLED_KEY) || '[]') } catch { return [] }
}

export function saveDisabledParams(keysArray) {
    try { localStorage.setItem(DISABLED_KEY, JSON.stringify(keysArray)) } catch { }
}

/**
 * Return effectiveParams with disabled keys replaced by their neutral/min value.
 * @param {object} params  - live params object
 * @param {Set<string>} disabledKeys
 */
export function applyDisabled(params, disabledKeys) {
    if (!disabledKeys || disabledKeys.size === 0) return params
    const out = { ...params }
    for (const p of PARAMS) {
        if (disabledKeys.has(p.key)) {
            out[p.key] = (p.neutralValue !== undefined) ? p.neutralValue : p.min
        }
    }
    return out
}

// ── Preset API (server-side JSON files) ──────────────────────────────────────────────────

const API = 'http://localhost:8000'

export async function listPresets() {
    try {
        const r = await fetch(`${API}/api/presets`)
        if (!r.ok) return []
        const data = await r.json()
        return data.presets || data.names || []
    } catch { return [] }
}

/**
 * Save a preset. `mappingGroups` carries the editable input→math→output rules.
 * @param {string} name
 * @param {object} params      color palette values
 * @param {Array}  [mappingGroups=[]]  group trees with rules
 */
export async function savePreset(name, params, mappingGroups = []) {
    const r = await fetch(`${API}/api/presets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, params, mappingGroups }),
    })
    return r.json()
}

/**
 * Load a preset. Returns { name, params, mappingGroups }.
 */
export async function loadPreset(name) {
    try {
        const r = await fetch(`${API}/api/presets/${encodeURIComponent(name)}`)
        if (!r.ok) return null
        const data = await r.json()
        return {
            ...data,
            mappingGroups: data.mappingGroups || [],
        }
    } catch { return null }
}

export async function deletePreset(name) {
    try {
        const r = await fetch(`${API}/api/presets/${encodeURIComponent(name)}`, { method: 'DELETE' })
        return r.json()
    } catch { return {} }
}

export function getDefaultParams() {
    const userDefaults = loadUserDefaults();
    const defaults = {};
    for (const p of PARAMS) {
        defaults[p.key] = Object.prototype.hasOwnProperty.call(userDefaults, p.key)
            ? userDefaults[p.key]
            : p.default;
    }
    defaults.noteColors = {
        C: [255, 0, 0],
        'C#': [143, 0, 255],
        D: [255, 255, 0],
        'D#': [183, 70, 139],
        E: [195, 242, 255],
        F: [170, 0, 52],
        'F#': [127, 139, 254],
        G: [255, 127, 1],
        'G#': [187, 117, 252],
        A: [54, 204, 51],
        'A#': [169, 103, 124],
        B: [142, 201, 255],
    };
    defaults.colorInputMode = 'rgb';
    defaults.freqColorTable = {};
    defaults.lightnessMin = 0.20;
    defaults.lightnessMax = 0.85;
    return defaults;
}
