/**
 * SEESOUND — Global Parameter Matrix
 *
 * Layout modes (layoutMode):
 *   0 = Linear          — left→right time axis, log-freq Y
 *   1 = L-System 2D     — interval-branching fractal tree (2D canvas)
 *   2 = Circular        — true full-range circle (all frequencies, all octaves)
 *   3 = 3D Holistic     — GPU particles in 3D space (Three.js)
 *   4 = 3D Linear       — left→right with Z-depth per frequency band
 *   5 = 3D Spiral       — linear + circular combined helix, particles
 *   6 = 3D L-System     — fractal tree in 3D, infinite canvas, bounding-box PNG
 *   8 = Amp × Stereo    — scatter: X=stereo, Y=amplitude, color=frequency (2D overlay)
 *   9 = 2D Freq × Stereo  — X=stereo pan, Y=log-frequency pitch (like 2D Linear) (2D canvas)
 *  10 = 2D Amp × Stereo   — X=stereo pan, Y=amplitude in dBFS (threshold→ceiling) (2D canvas)
 */

// ── Parameter group definitions ─────────────────────────────────────────────

export const PARAM_GROUPS = [
    { id: 'layout', label: 'Layout' },
    { id: 'inputGain', label: 'Input Gain (Sensitivity)' },
    { id: 'geometry', label: 'Geometry / Shape' },
    { id: 'texture', label: 'Texture / Timbre' },
    { id: 'colorDynamics', label: 'Color Dynamics' },
    { id: 'mixing', label: 'Canvas Physics' },
    { id: 'linear', label: 'Linear Layout', layouts: [0] },
    { id: 'lsystem2d', label: 'L-System 2D', layouts: [1] },
    { id: 'circular', label: 'Circular Layout', layouts: [2] },
    { id: 'ampstereo', label: '2D Freq × Stereo Layout', layouts: [9] },
    { id: 'amp2d', label: '2D Amp × Stereo Layout', layouts: [10] },
    { id: 'threed', label: '3D Common', layouts: [3, 4, 5, 6] },
    { id: 'camera', label: 'Camera Controls', layouts: [3, 4, 5, 6] },
    { id: '3dlinear', label: '3D Linear', layouts: [4] },
    { id: '3dspiral', label: '3D Spiral', layouts: [5] },
    { id: '3dlsystem', label: '3D L-System', layouts: [6] },
    { id: 'advanced', label: 'Advanced Behaviors' },
];

// ── Individual parameters ───────────────────────────────────────────────────

export const PARAMS = [
    // ─── Layout selector ────────────────────────────────────────────────────
    {
        key: 'layoutMode', group: 'layout', label: 'Layout Mode', default: 0, unit: '',
        desc: 'Selects the visual layout. Each mode reveals its own settings group.',
        isDropdown: true,
        dropdownOptions: [
            { label: 'Linear (left to right)', value: 0 },
            { label: 'L-System 2D', value: 1 },
            { label: 'Circular (full range)', value: 2 },
            { label: '3D Holistic (particles)', value: 3 },
            { label: '3D Linear (with depth)', value: 4 },
            { label: '3D Spiral', value: 5 },
            { label: '3D L-System (infinite)', value: 6 },
            { label: 'Amp × Stereo × Freq Color', value: 8 },
            { label: '2D Freq × Stereo', value: 9 },
            { label: '2D Amp × Stereo', value: 10 },
        ],
    },
    {
        key: 'persistMode', group: 'layout', label: 'Persistence', min: 0, max: 1, step: 1, default: 0, unit: '',
        desc: 'Momentary: canvas fades each frame (trails). Painting: marks accumulate permanently.',
        isToggle: true, toggleLabels: ['Momentary', 'Painting']
    },
    {
        key: 'blendMode', group: 'layout', label: 'Blend Mode', default: 'screen', unit: '',
        desc: 'Canvas compositing blend mode for all drawn particles.',
        isDropdown: true, neutralValue: 'source-over',
        dropdownGroups: [
            { label: 'Normal', options: [{ label: 'Normal', value: 'source-over' }] },
            {
                label: 'Lighten', options: [{ label: 'Lighten', value: 'lighten' },
                { label: 'Screen', value: 'screen' },
                { label: 'Color Dodge', value: 'color-dodge' },
                { label: 'Add (Lin. Dodge)', value: 'lighter' }]
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
            {
                label: 'Component', options: [{ label: 'Hue', value: 'hue' },
                { label: 'Saturation', value: 'saturation' },
                { label: 'Color', value: 'color' },
                { label: 'Luminosity', value: 'luminosity' }]
            },
        ],
    },

    // ─── Input Gain ───────────────────────────────────────────────────────────
    { key: 'inputGain', group: 'inputGain', label: 'Input Gain', min: 0, max: 3, step: 0.01, default: 1.0, unit: 'x', desc: 'Master amplitude scale before any processing.', canDisable: true, neutralValue: 1.0 },
    { key: 'amplitudeThreshold', group: 'inputGain', label: 'Amplitude Threshold', min: -96, max: 0, step: 1, default: -48, unit: 'dB', desc: 'Noise gate: components below this level draw nothing.', canDisable: true },
    { key: 'perceptualLoudness', group: 'inputGain', label: 'Perceptual Loudness Wt.', min: 0, max: 100, step: 1, default: 60, unit: '%', desc: 'ISO 226 A-weighting. 100% = perceived loudness curve.', canDisable: true },
    { key: 'attackSensitivity', group: 'inputGain', label: 'Attack Sensitivity', min: 0, max: 100, step: 1, default: 80, unit: '%', desc: 'How instantly a new note fires at full size.', canDisable: true, neutralValue: 100 },
    { key: 'releaseDecay', group: 'inputGain', label: 'Release / Decay', min: 0.05, max: 10, step: 0.05, default: 2.0, unit: 's', desc: 'How long a mark lingers after its audio ends.', canDisable: true },

    // ─── Geometry / Shape ────────────────────────────────────────────────────
    { key: 'defaultParticleSize', group: 'geometry', label: 'Default Particle Size', min: 1, max: 40, step: 0.5, default: 4, unit: 'px', desc: 'Base diameter before all modifiers.', canDisable: false },
    { key: 'freqDepthEffect', group: 'geometry', label: 'Freq Depth (Bass=Bigger)', min: 0, max: 100, step: 1, default: 100, unit: '%', desc: 'Bass freq drawn larger. 0% = flat size.', canDisable: true, neutralValue: 0 },
    { key: 'magnitudeSizeRatio', group: 'geometry', label: 'Amplitude to Size vs Bright', min: 0, max: 100, step: 1, default: 50, unit: '%', desc: 'Splits amplitude energy between size and brightness.', canDisable: true },
    { key: 'amplitudeSizeStrength', group: 'geometry', label: 'Amplitude Size Strength', min: 0, max: 10, step: 0.1, default: 4, unit: 'x', desc: 'How strongly loudness enlarges particles.', canDisable: true, neutralValue: 0 },
    { key: 'sizeExponent', group: 'geometry', label: 'Freq to Size Exponent', min: 0.1, max: 4.0, step: 0.1, default: 1.5, unit: 'x', desc: 'Steepness of the bass-bigger size curve.', canDisable: true, neutralValue: 1.0 },
    { key: 'saliencyWeight', group: 'geometry', label: 'Saliency Weight', min: 0, max: 200, step: 1, default: 100, unit: '%', desc: 'Onset pop: new notes appear at boosted size.', canDisable: true },
    { key: 'shapeComplexity', group: 'geometry', label: 'Shape Complexity', min: 3, max: 64, step: 1, default: 12, unit: 'vtx', desc: 'Max polygon vertex count (3=tri, 32+=circle).' },

    // ─── Texture / Timbre ────────────────────────────────────────────────────
    { key: 'harmonicRoughness', group: 'texture', label: 'Harmonic Roughness', min: 0, max: 100, step: 1, default: 30, unit: '%', desc: 'Vertex displacement proportional to inharmonicity.', canDisable: true },
    { key: 'edgeSoftness', group: 'texture', label: 'Edge Softness', min: 0, max: 100, step: 1, default: 70, unit: '%', desc: '100% = crisp polygon edges, 0% = soft glow blobs.', canDisable: true, neutralValue: 100 },

    // ─── Color Dynamics ──────────────────────────────────────────────────────
    { key: 'saturationFloor', group: 'colorDynamics', label: 'Saturation Floor', min: 0, max: 100, step: 1, default: 20, unit: '%', desc: 'Minimum color saturation (prevents pure grey).', canDisable: true },
    { key: 'dissonanceDesat', group: 'colorDynamics', label: 'Dissonance Desaturation', min: 0, max: 100, step: 1, default: 50, unit: '%', desc: 'Dissonant intervals shift toward grey.', canDisable: true },
    { key: 'brightnessScaling', group: 'colorDynamics', label: 'Brightness Scaling', min: 0, max: 100, step: 1, default: 50, unit: '%', desc: 'Loudness as opacity (0%) vs HSL lightness (100%).', canDisable: true },

    // ─── Canvas Physics (all 2D layouts) ──────────────────────────────────────
    { key: 'atmosphericPressure', group: 'mixing', label: 'Atmospheric Pressure', min: 0, max: 100, step: 1, default: 30, unit: '%', desc: 'Per-frame haze tinted by RMS. Momentary mode only.', canDisable: true },
    { key: 'lfWash', group: 'mixing', label: 'LF Foundational Wash', min: 0, max: 100, step: 1, default: 40, unit: '%', desc: 'Bass-driven background tint. Momentary mode only.', canDisable: true },
    { key: 'entropy', group: 'mixing', label: 'Info Entropy Jitter', min: 0, max: 100, step: 1, default: 20, unit: '%', desc: 'Positional noise proportional to note count.', canDisable: true },
    { key: 'fluidDynamics', group: 'mixing', label: 'Fluid Dynamics', min: 0, max: 100, step: 1, default: 30, unit: '%', desc: 'Bass-driven canvas scale breathing. Momentary only.', canDisable: true },
    { key: 'phaseInterference', group: 'mixing', label: 'Phase Interference', min: 0, max: 100, step: 1, default: 25, unit: '%', desc: 'Stereo pan tilts canvas. Momentary mode only.', canDisable: true },

    // ─── Layout 0: Linear ────────────────────────────────────────────────────
    { key: 'linearShowGrid', group: 'linear', label: 'Show Freq Grid', min: 0, max: 1, step: 1, default: 0, unit: '', desc: 'Draw octave/note grid lines behind particles.', isToggle: true, toggleLabels: ['Off', 'On'], canDisable: true, neutralValue: 0 },
    { key: 'linearTrailFade', group: 'linear', label: 'Trail Fade Speed', min: 0.01, max: 1, step: 0.01, default: 0.05, unit: '', desc: 'Fill-alpha per frame (higher = shorter trails).', canDisable: true, neutralValue: 0.05 },
    { key: 'linearParticleMode', group: 'linear', label: 'Particle Style', min: 0, max: 1, step: 1, default: 0, unit: '', desc: 'Dots: circles per component. Bars: vertical frequency bars.', isToggle: true, toggleLabels: ['Dots', 'Bars'], canDisable: true, neutralValue: 0 },

    // ─── Layout 1: L-System 2D ───────────────────────────────────────────────
    { key: 'lsAngleSpread', group: 'lsystem2d', label: 'Angle Spread', min: 5, max: 90, step: 1, default: 18, unit: 'deg', desc: 'Max branching angle deviation per semitone interval.', canDisable: true },
    { key: 'lsGrowthSpeed', group: 'lsystem2d', label: 'Growth Speed', min: 0.01, max: 1, step: 0.01, default: 0.09, unit: 'x', desc: 'Fraction of canvas short-side moved per second.', canDisable: true },
    { key: 'lsLineWidth', group: 'lsystem2d', label: 'Line Width', min: 0.3, max: 8, step: 0.1, default: 2.2, unit: 'px', desc: 'Base stroke width (tapers per generation).', canDisable: false },
    { key: 'lsMaxBranches', group: 'lsystem2d', label: 'Max Branches', min: 10, max: 500, step: 10, default: 300, unit: '', desc: 'Memory cap: dead branches pruned above this.', canDisable: false },

    // ─── Layout 9: 2D Freq × Stereo ────────────────────────────────────────────────
    // X = stereo pan [-1 … +1], Y = log-frequency (bass bottom, treble top).
    { key: 'chromaticGravity', group: 'ampstereo', label: 'Chromatic Gravity', min: 0, max: 100, step: 1, default: 0, unit: '%', desc: 'Pull all bins toward canvas centre (stereo=0, mid-frequency).', canDisable: true, neutralValue: 0 },
    { key: 'magneticOrientation', group: 'ampstereo', label: 'Magnetic Orientation', min: 0, max: 100, step: 1, default: 0, unit: '%', desc: 'Collapse pan toward stereo centre (X=0).', canDisable: true, neutralValue: 0 },

    // ─── Layout 10: 2D Amp × Stereo ──────────────────────────────────────────────
    // X = stereo pan [-1 … +1], Y = amplitude in dBFS (threshold=top, ceiling=bottom).
    { key: 'ampstereoLimit', group: 'amp2d', label: 'Amplitude Ceiling', min: -24, max: 0, step: 1, default: -6, unit: 'dB', desc: 'Bottom edge of the Y axis. Components at this dBFS level appear at the bottom. Top edge = Amplitude Threshold.', canDisable: false },

    // ─── Layout 2: Circular ──────────────────────────────────────────────────
    { key: 'circRadiusScale', group: 'circular', label: 'Radius Scale', min: 0.2, max: 2, step: 0.05, default: 1, unit: 'x', desc: 'Scale the polar radius of every component.', canDisable: true, neutralValue: 1 },
    { key: 'circFreqMapping', group: 'circular', label: 'Freq to Angle', min: 0, max: 1, step: 1, default: 0, unit: '', desc: 'Log-spiral: all octaves around circle. Linear Hz: direct.', isToggle: true, toggleLabels: ['Log-spiral', 'Linear Hz'], canDisable: true, neutralValue: 0 },
    { key: 'circChromaticGrav', group: 'circular', label: 'Chromatic Gravity', min: 0, max: 100, step: 1, default: 50, unit: '%', desc: 'Pull shapes toward canvas centre.', canDisable: true },
    { key: 'circMagOrientation', group: 'circular', label: 'Magnetic Orientation', min: 0, max: 100, step: 1, default: 50, unit: '%', desc: 'Rotate all angles toward tonic (0 deg = top).', canDisable: true },
    { key: 'circInterInstr', group: 'circular', label: 'Inter-Instrumental', min: 0, max: 100, step: 1, default: 50, unit: '%', desc: 'Dissonant components attracted toward centre.', canDisable: true },

    // ─── 3D Common (layouts 3-6) ──────────────────────────────────────────────
    { key: 'threedParticleSize', group: 'threed', label: 'Particle Size', min: 0.001, max: 0.5, step: 0.001, default: 0.024, unit: 'wu', desc: 'World-unit base radius for 3D particles.', canDisable: false },
    { key: 'threedSpreadMul', group: 'threed', label: 'Spread', min: 0.1, max: 3, step: 0.05, default: 1.0, unit: 'x', desc: 'XY spread multiplier for the particle cloud.', canDisable: true, neutralValue: 1 },
    { key: 'threedBloom', group: 'threed', label: 'Bloom Strength', min: 0, max: 5, step: 0.1, default: 0.4, unit: '', desc: 'UnrealBloom post-processing intensity.', canDisable: true, neutralValue: 0 },
    { key: 'threedAfterimage', group: 'threed', label: 'Afterimage', min: 0, max: 1, step: 0.01, default: 0.82, unit: '', desc: 'Persistence damp: 0=instant fade, 1=eternal.', canDisable: true, neutralValue: 0.5 },
    { key: 'threedFogDensity', group: 'threed', label: 'Fog Density', min: 0, max: 0.2, step: 0.001, default: 0.018, unit: '', desc: 'Exponential fog density. 0 = no fog.', canDisable: true, neutralValue: 0 },
    { key: 'threedFreqDepthBias', group: 'threed', label: 'Freq Depth Bias', min: 0, max: 10, step: 0.5, default: 3.5, unit: 'wu', desc: 'Extra Z-push for bass vs treble frequencies.', canDisable: true, neutralValue: 0 },

    // ─── Camera (layouts 3-6) ────────────────────────────────────────────────
    { key: 'cameraMode', group: 'camera', label: 'Camera Mode', default: 0, unit: '', desc: 'Auto: audio-reactive orbit. Manual: slider-driven. Still: locked.', isToggle: true, toggleLabels: ['Auto', 'Manual', 'Still'] },
    { key: 'cameraFov', group: 'camera', label: 'Camera FOV', min: 20, max: 120, step: 1, default: 75, unit: 'deg', desc: 'Field of view.', canDisable: false },
    { key: 'cameraDistance', group: 'camera', label: 'Camera Distance', min: 1, max: 120, step: 0.5, default: 40, unit: 'u', desc: 'Orbit radius from scene centre.', canDisable: false },
    { key: 'cameraAzimuth', group: 'camera', label: 'Horizontal Revolution', min: 0, max: 360, step: 1, default: 0, unit: 'deg', desc: 'Horizontal orbit angle (0=front, 90=right).', canDisable: false },
    { key: 'cameraElevation', group: 'camera', label: 'Vertical Revolution', min: -89, max: 89, step: 1, default: 5, unit: 'deg', desc: 'Vertical orbit angle (-89 below, +89 above horizon).', canDisable: false },
    { key: 'cameraSpeed', group: 'camera', label: 'Camera Speed', min: 0, max: 3, step: 0.05, default: 1, unit: 'x', desc: 'Auto camera velocity multiplier.', canDisable: false },
    { key: 'cameraOrbit', group: 'camera', label: 'Auto-Orbit Speed', min: -1, max: 1, step: 0.01, default: 0.5, unit: 'x', desc: 'Continuous orbital drift (negative = reverse).', canDisable: true, neutralValue: 0 },

    // ─── Layout 4: 3D Linear ─────────────────────────────────────────────────
    { key: 'lin3dHistoryDepth', group: '3dlinear', label: 'History Depth', min: 4, max: 200, step: 2, default: 80, unit: 'fr', desc: 'Time-slices kept in the Z-tunnel.', canDisable: false },
    { key: 'lin3dZStep', group: '3dlinear', label: 'Z Step', min: 0.1, max: 4, step: 0.1, default: 0.7, unit: 'wu', desc: 'World-unit spacing between time slices.', canDisable: true, neutralValue: 0.7 },

    // ─── Layout 5: 3D Spiral ─────────────────────────────────────────────────
    { key: 'spiralTurns', group: '3dspiral', label: 'Spiral Turns', min: 0.5, max: 8, step: 0.5, default: 2, unit: '', desc: 'Full turns of the helix per frequency octave.', canDisable: true, neutralValue: 1 },
    { key: 'spiralRadius', group: '3dspiral', label: 'Helix Radius', min: 0.5, max: 10, step: 0.1, default: 3, unit: 'wu', desc: 'Radius of the helix.', canDisable: true, neutralValue: 3 },
    { key: 'spiralPitch', group: '3dspiral', label: 'Helix Pitch', min: 0.2, max: 5, step: 0.1, default: 1.2, unit: 'wu', desc: 'Z advance per full helix turn.', canDisable: true, neutralValue: 1 },
    { key: 'spiralHistoryDepth', group: '3dspiral', label: 'History', min: 4, max: 200, step: 2, default: 80, unit: 'fr', desc: 'Number of time slices kept.', canDisable: false },

    // ─── Layout 6: 3D L-System ───────────────────────────────────────────────
    { key: 'ls3dAngleSpread', group: '3dlsystem', label: 'Angle Spread', min: 5, max: 90, step: 1, default: 18, unit: 'deg', desc: 'Max branching angle per semitone interval.', canDisable: true },
    { key: 'ls3dGrowthSpeed', group: '3dlsystem', label: 'Growth Speed', min: 0.01, max: 1, step: 0.01, default: 0.09, unit: 'x', desc: 'Fraction of scene scale moved per second.', canDisable: true },
    { key: 'ls3dLineWidth', group: '3dlsystem', label: 'Line Width', min: 0.3, max: 8, step: 0.1, default: 2.2, unit: 'px', desc: 'Base stroke width.', canDisable: false },
    { key: 'ls3dElevation', group: '3dlsystem', label: '3D Elevation', min: 0, max: 90, step: 1, default: 25, unit: 'deg', desc: 'Upward tilt of the growth plane.', canDisable: true, neutralValue: 0 },
    { key: 'ls3dRotation', group: '3dlsystem', label: '3D Y-Rotation', min: 0, max: 360, step: 1, default: 0, unit: 'deg', desc: 'Rotation of the growth plane around Y axis.', canDisable: true, neutralValue: 0 },

    // ─── Advanced Behaviors ──────────────────────────────────────────────────
    { key: 'kineticPendulum', group: 'advanced', label: 'Kinetic Pendulum', min: 0, max: 100, step: 1, default: 50, unit: '%', desc: 'More render slots per frame at high BPM.', canDisable: true },
    { key: 'acousticFriction', group: 'advanced', label: 'Acoustic Friction', min: 0, max: 100, step: 1, default: 40, unit: '%', desc: 'Spectral clarity reduces polygon vertex count.', canDisable: true },
    { key: 'zDepth', group: 'advanced', label: 'Z-Axis Depth', min: 0, max: 100, step: 1, default: 0, unit: '%', desc: 'Older 2D marks shrink and fade (depth illusion).', canDisable: true },
    { key: 'harmonicClarity', group: 'advanced', label: 'Harmonic Clarity', min: 0, max: 100, step: 1, default: 70, unit: '%', desc: 'Clarity score drives blur and vertex count.', canDisable: true },
    { key: 'fieldRendering', group: 'advanced', label: 'Field Rendering', min: 0, max: 100, step: 1, default: 50, unit: '%', desc: 'Dissonant components scattered from computed position.', canDisable: true },
    { key: 'depthDisplacement', group: 'advanced', label: 'Depth Displacement', min: 0, max: 100, step: 1, default: 30, unit: '%', desc: 'Extra size for bass on heavy kick hits.', canDisable: true },
    { key: 'sourceSeparation', group: 'advanced', label: 'Source Separation', min: 0, max: 100, step: 1, default: 50, unit: '%', desc: 'Noisy partials shrink relative to pure tones.', canDisable: true },
    { key: 'pitchSizeInversion', group: 'advanced', label: 'Pitch Size Inv.', min: 0, max: 100, step: 1, default: 60, unit: '%', desc: 'Reserved pitch-size axis.', canDisable: true },
    { key: 'octaveScaling', group: 'advanced', label: 'Octave Scaling', min: 0, max: 100, step: 1, default: 50, unit: '%', desc: 'Proportional visual weight across octaves.', canDisable: true },
];

// ── Default values + localStorage persistence ────────────────────────────────

const STORAGE_KEY = 'seesound_user_defaults';

export function loadUserDefaults() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        return raw ? JSON.parse(raw) : {};
    } catch {
        return {};
    }
}

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

export function clearUserDefaults() {
    try {
        localStorage.removeItem(STORAGE_KEY)
    } catch { }
}

// ── Disabled params persistence ─────────────────────────────────────────────

const DISABLED_KEY = 'seesound_disabled_params'

export function loadDisabledParams() {
    try { return JSON.parse(localStorage.getItem(DISABLED_KEY) || '[]') } catch { return [] }
}

export function saveDisabledParams(keysArray) {
    try { localStorage.setItem(DISABLED_KEY, JSON.stringify(keysArray)) } catch { }
}

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

// ── Preset API ────────────────────────────────────────────────────────────────

const API = 'http://localhost:8000'

export async function listPresets() {
    try {
        const r = await fetch(`${API}/api/presets`)
        if (!r.ok) return []
        const data = await r.json()
        return data.presets || data.names || []
    } catch { return [] }
}

export async function savePreset(name, params, disabledKeys = [], mappingGroups = [], canvasW, canvasH) {
    // Strip color keys — those are saved separately via saveColorPreset
    const filteredParams = Object.fromEntries(
        Object.entries(params).filter(([k]) => !COLOR_KEYS.includes(k))
    )
    const body = {
        name,
        params: filteredParams,
        disabledKeys: [...(disabledKeys instanceof Set ? disabledKeys : disabledKeys)],
        mappingGroups,
    }
    if (canvasW !== undefined) body.canvasW = canvasW
    if (canvasH !== undefined) body.canvasH = canvasH
    const r = await fetch(`${API}/api/presets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    })
    return r.json()
}

export async function loadPreset(name) {
    try {
        const r = await fetch(`${API}/api/presets/${encodeURIComponent(name)}`)
        if (!r.ok) return null
        const data = await r.json()
        return { ...data, mappingGroups: data.mappingGroups || [] }
    } catch { return null }
}

export async function deletePreset(name) {
    try {
        const r = await fetch(`${API}/api/presets/${encodeURIComponent(name)}`, { method: 'DELETE' })
        return r.json()
    } catch { return {} }
}

// ── Color-preset API ──────────────────────────────────────────────────────────
// Color presets save/restore only the colour-related keys, leaving all
// geometry, physics, and layout parameters untouched.

export const COLOR_KEYS = [
    'noteColors',
    'colorInputMode',
    'freqColorTable',
    'lightnessMin',
    'lightnessMax',
    'saturationFloor',
    'dissonanceDesat',
    'brightnessScaling',
    'blendMode',
]

export async function listColorPresets() {
    try {
        const r = await fetch(`${API}/api/color-presets`)
        if (!r.ok) return []
        const data = await r.json()
        return data.names || []
    } catch { return [] }
}

export async function saveColorPreset(name, params) {
    const colors = {}
    for (const k of COLOR_KEYS) if (k in params) colors[k] = params[k]
    try {
        const r = await fetch(`${API}/api/color-presets`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name, colors }),
        })
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.json()
    } catch (e) {
        console.error('[ColorPreset] save failed:', e)
        throw e
    }
}

export async function loadColorPreset(name) {
    try {
        const r = await fetch(`${API}/api/color-presets/${encodeURIComponent(name)}`)
        if (!r.ok) return null
        return await r.json()
    } catch { return null }
}

export async function deleteColorPreset(name) {
    try {
        const r = await fetch(`${API}/api/color-presets/${encodeURIComponent(name)}`, { method: 'DELETE' })
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
