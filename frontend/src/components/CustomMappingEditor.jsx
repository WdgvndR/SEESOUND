import { useState } from 'react'

// ── Audio input signals — grouped by instrument category ──────────────────
const INPUT_GROUPS = [
    {
        group: 'Broad Signal',
        inputs: [
            { value: 'amplitude', label: 'Amplitude (RMS)' },
            { value: 'bass', label: 'Bass Energy (broad)' },
            { value: 'mids', label: 'Mid Energy (broad)' },
            { value: 'highs', label: 'High Energy (broad)' },
            { value: 'onset_strength', label: 'Onset Strength' },
            { value: 'spectral_centroid', label: 'Spectral Brightness' },
            { value: 'spectral_flatness', label: 'Spectral Flatness' },
            { value: 'stereo_pan', label: 'Stereo Pan' },
            { value: 'dissonance', label: 'Dissonance' },
            { value: 'harmonic_ratio', label: 'Harmonic Ratio' },
            { value: 'note_count', label: 'Note Count' },
            { value: 'time_progress', label: 'Time Progress (0–1)' },
        ],
    },
    {
        group: 'Drums / Percussion',
        inputs: [
            { value: 'sub_amp', label: 'Sub Bass (20–60 Hz)' },
            { value: 'kick_amp', label: 'Kick Drum (40–120 Hz)' },
            { value: 'snare_body', label: 'Snare Body (150–350 Hz)' },
            { value: 'snare_crack', label: 'Snare Crack (5–10 kHz)' },
            { value: 'hi_hat', label: 'Hi-Hat (8–14 kHz)' },
            { value: 'cymbal', label: 'Cymbal / Open HH (6–18 kHz)' },
        ],
    },
    {
        group: 'Bass / Guitar / Strings',
        inputs: [
            { value: 'bass_amp', label: 'Bass Guitar (80–300 Hz)' },
            { value: 'low_guitar', label: 'Guitar Low (80–400 Hz)' },
            { value: 'strings_range', label: 'Strings (200–4000 Hz)' },
        ],
    },
    {
        group: 'Voice / Winds / Brass',
        inputs: [
            { value: 'vocal_body', label: 'Vocal Body (200–1000 Hz)' },
            { value: 'vocal_range', label: 'Vocal Range (200–3500 Hz)' },
            { value: 'woodwind', label: 'Woodwind (250–3500 Hz)' },
            { value: 'brass_range', label: 'Brass (100–2000 Hz)' },
        ],
    },
    {
        group: 'Keys / Full Range',
        inputs: [
            { value: 'piano_range', label: 'Piano (27–4186 Hz)' },
            { value: 'low_mid', label: 'Low-Mid (250–800 Hz)' },
            { value: 'mid_range', label: 'Mid-Range (800–2500 Hz)' },
            { value: 'upper_mid', label: 'Upper-Mid (2–5 kHz)' },
            { value: 'presence', label: 'Presence (3–8 kHz)' },
            { value: 'treble', label: 'Treble (4–20 kHz)' },
            { value: 'air', label: 'Air / Sheen (14–20 kHz)' },
        ],
    },
]

// ── Math operations
// args        – number of numeric inputs shown after the dropdown
// argDefaults – default values for those inputs
// argLabels   – short placeholder / title for each input
const MATH_OPTIONS = [
    { value: 'passthrough', label: '= Direct', args: 0 },
    { value: 'multiply', label: '× Multiply', args: 1, argDefaults: [1], argLabels: ['factor'] },
    { value: 'add', label: '+ Offset', args: 1, argDefaults: [0], argLabels: ['value'] },
    { value: 'pow', label: 'xⁿ Power', args: 1, argDefaults: [2], argLabels: ['exp'] },
    { value: 'clamp01', label: '⊡ Clamp 0–1', args: 0 },
    { value: 'invert', label: '⊖ Invert', args: 0 },
    { value: 'abs', label: '|x| Abs', args: 0 },
    { value: 'sqrt', label: '√ Sqrt', args: 0 },
    { value: 'smoothstep', label: '≈ Smooth', args: 0 },
    { value: 'map_range', label: '↔ Remap', args: 4, argDefaults: [0, 1, 0, 100], argLabels: ['i₀', 'i₁', 'o₀', 'o₁'] },
    { value: 'threshold', label: '⎍ Gate', args: 1, argDefaults: [0.5], argLabels: ['level'] },
]

const MATH_MAP = Object.fromEntries(MATH_OPTIONS.map(o => [o.value, o]))

// ── Output parameters ─────────────────────────────────────────────────────
const OUTPUT_OPTIONS = [
    { group: 'Color Override', value: 'color_override', label: '⬛ Color Override', isColorRule: true },
    { group: 'Input Gain', value: 'inputGain', label: 'Input Gain' },
    { group: 'Input Gain', value: 'attackSensitivity', label: 'Attack Sensitivity' },
    { group: 'Input Gain', value: 'releaseDecay', label: 'Release / Decay' },
    { group: 'Geometry', value: 'defaultParticleSize', label: 'Particle Size' },
    { group: 'Geometry', value: 'amplitudeSizeStrength', label: 'Amplitude Size Strength' },
    { group: 'Geometry', value: 'sizeExponent', label: 'Size Exponent' },
    { group: 'Geometry', value: 'saliencyWeight', label: 'Saliency Weight' },
    { group: 'Geometry', value: 'shapeComplexity', label: 'Shape Complexity' },
    { group: 'Texture', value: 'harmonicRoughness', label: 'Harmonic Roughness' },
    { group: 'Texture', value: 'edgeSoftness', label: 'Edge Softness' },
    { group: 'Color', value: 'saturationFloor', label: 'Saturation Floor' },
    { group: 'Color', value: 'dissonanceDesat', label: 'Dissonance Desaturation' },
    { group: 'Color', value: 'brightnessScaling', label: 'Brightness Scaling' },
    { group: 'Canvas Physics', value: 'atmosphericPressure', label: 'Atmospheric Pressure' },
    { group: 'Canvas Physics', value: 'lfWash', label: 'LF Foundational Wash' },
    { group: 'Canvas Physics', value: 'entropy', label: 'Entropy Jitter' },
    { group: 'Canvas Physics', value: 'fluidDynamics', label: 'Fluid Dynamics' },
    { group: 'Canvas Physics', value: 'phaseInterference', label: 'Phase Interference' },
    { group: '3D', value: 'threedParticleSize', label: '3D Particle Size' },
    { group: '3D', value: 'threedSpreadMul', label: '3D Spread' },
    { group: '3D', value: 'threedBloom', label: 'Bloom Strength' },
    { group: '3D', value: 'threedAfterimage', label: 'Afterimage' },
    { group: 'Advanced', value: 'kineticPendulum', label: 'Kinetic Pendulum' },
    { group: 'Advanced', value: 'harmonicClarity', label: 'Harmonic Clarity' },
    { group: 'Advanced', value: 'fieldRendering', label: 'Field Rendering' },
]

const OUTPUT_GROUPS = OUTPUT_OPTIONS.reduce((acc, o) => {
    ; (acc[o.group] ??= []).push(o)
    return acc
}, {})

// ── Persistence ───────────────────────────────────────────────────────────
const STORAGE_KEY = 'seesound_custom_mappings'
export const loadMappings = () => { try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null') } catch { return null } }
export const saveMappings = (g) => { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(g)) } catch { } }

// ── ID / factories ────────────────────────────────────────────────────────
let _id = 0
const uid = () => `cm-${Date.now()}-${++_id}`

export const makeRule = () => ({ id: uid(), input: 'amplitude', math: 'multiply', mathArgs: [1], output: 'defaultParticleSize', colorHex: '#ffffff' })
export const makeSubgroup = (label = 'Subgroup 1') => ({ id: uid(), label, open: true, rules: [makeRule()] })
export const makeGroup = (label = 'Group 1') => ({ id: uid(), label, open: true, subgroups: [makeSubgroup()] })

// ── Rule row ──────────────────────────────────────────────────────────────
function RuleRow({ rule, onChange, onDelete }) {
    const mathDef = MATH_MAP[rule.math] ?? MATH_OPTIONS[0]
    const isColorOverride = rule.output === 'color_override'
    const set = (patch) => onChange({ ...rule, ...patch })

    const handleMathChange = (newMath) => {
        const def = MATH_MAP[newMath]
        set({ math: newMath, mathArgs: def?.argDefaults ? [...def.argDefaults] : [] })
    }

    const handleArgChange = (i, raw) => {
        const args = [...(rule.mathArgs || [])]
        args[i] = raw === '' ? '' : Number(raw)
        set({ mathArgs: args })
    }

    const handleOutputChange = (newOutput) => {
        // When switching to color_override, default math to passthrough
        if (newOutput === 'color_override') {
            set({ output: newOutput, math: 'passthrough', mathArgs: [], colorHex: rule.colorHex || '#ffffff' })
        } else {
            set({ output: newOutput })
        }
    }

    return (
        <div className="cm-rule-row">
            {/* Input signal — grouped by instrument category */}
            <select className="cm-select cm-select-input" value={rule.input}
                onChange={e => set({ input: e.target.value })} title="Input signal">
                {INPUT_GROUPS.map(grp => (
                    <optgroup key={grp.group} label={grp.group}>
                        {grp.inputs.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </optgroup>
                ))}
            </select>

            {/* Math operation + args — hidden when output is color_override */}
            {!isColorOverride && (
                <>
                    <select className="cm-select cm-select-math" value={rule.math}
                        onChange={e => handleMathChange(e.target.value)} title="Math operation">
                        {MATH_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>

                    {mathDef.args > 0 && (rule.mathArgs || []).slice(0, mathDef.args).map((val, i) => (
                        <span key={i} className="cm-math-arg-wrap" title={mathDef.argLabels?.[i] ?? ''}>
                            <span className="cm-math-arg-label">{mathDef.argLabels?.[i] ?? `arg${i + 1}`}</span>
                            <input type="number" className="cm-math-arg"
                                value={val}
                                step="any"
                                onChange={e => handleArgChange(i, e.target.value)}
                                onBlur={e => { const n = parseFloat(e.target.value); if (!isNaN(n)) handleArgChange(i, n) }}
                            />
                        </span>
                    ))}
                </>
            )}

            <span className="cm-arrow">→</span>

            {/* Output parameter select */}
            <select className="cm-select cm-select-output" value={rule.output}
                onChange={e => handleOutputChange(e.target.value)} title="Output parameter">
                {Object.entries(OUTPUT_GROUPS).map(([grpName, opts]) => (
                    <optgroup key={grpName} label={grpName}>
                        {opts.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </optgroup>
                ))}
            </select>

            {/* Color picker — only shown for color_override output */}
            {isColorOverride && (
                <span className="cm-color-wrap" title="Override color">
                    <input
                        type="color"
                        className="cm-color-picker"
                        value={rule.colorHex || '#ffffff'}
                        onChange={e => set({ colorHex: e.target.value })}
                    />
                    <span className="cm-color-swatch" style={{ background: rule.colorHex || '#ffffff' }} />
                </span>
            )}

            <button className="cm-del-btn" onClick={onDelete} title="Remove rule">✕</button>
        </div>
    )
}

// ── Subgroup ──────────────────────────────────────────────────────────────
function Subgroup({ sg, onChange, onDelete }) {
    const patch = (p) => onChange({ ...sg, ...p })
    return (
        <div className={`cm-subgroup ${sg.open ? 'open' : ''}`}>
            <div className="cm-subgroup-header">
                <button className="cm-chevron-btn" onClick={() => patch({ open: !sg.open })}>
                    {sg.open ? '▾' : '▸'}
                </button>
                <input className="cm-label-input" value={sg.label}
                    onChange={e => patch({ label: e.target.value })} placeholder="Subgroup name…" />
                <span className="cm-count">{sg.rules.length}</span>
                <button className="cm-del-btn" onClick={onDelete} title="Remove subgroup">✕</button>
            </div>
            {sg.open && (
                <div className="cm-subgroup-body">
                    {sg.rules.length === 0 && <div className="cm-empty">No rules yet</div>}
                    {sg.rules.map(r => (
                        <RuleRow key={r.id} rule={r}
                            onChange={u => patch({ rules: sg.rules.map(x => x.id === r.id ? u : x) })}
                            onDelete={() => patch({ rules: sg.rules.filter(x => x.id !== r.id) })}
                        />
                    ))}
                    <button className="cm-add-btn" onClick={() => patch({ rules: [...sg.rules, makeRule()] })}>
                        + Rule
                    </button>
                </div>
            )}
        </div>
    )
}

// ── Group ─────────────────────────────────────────────────────────────────
function Group({ group, onChange, onDelete }) {
    const patch = (p) => onChange({ ...group, ...p })
    const ruleCount = group.subgroups.reduce((s, sg) => s + sg.rules.length, 0)
    return (
        <div className={`cm-group ${group.open ? 'open' : ''}`}>
            <div className="cm-group-header">
                <button className="cm-chevron-btn" onClick={() => patch({ open: !group.open })}>
                    {group.open ? '▾' : '▸'}
                </button>
                <input className="cm-label-input cm-group-label" value={group.label}
                    onChange={e => patch({ label: e.target.value })} placeholder="Group name…" />
                <span className="cm-count">{ruleCount} rule{ruleCount !== 1 ? 's' : ''}</span>
                <button className="cm-del-btn" onClick={onDelete} title="Remove group">✕</button>
            </div>
            {group.open && (
                <div className="cm-group-body">
                    {group.subgroups.length === 0 && <div className="cm-empty">No subgroups yet</div>}
                    {group.subgroups.map(sg => (
                        <Subgroup key={sg.id} sg={sg}
                            onChange={u => patch({ subgroups: group.subgroups.map(x => x.id === sg.id ? u : x) })}
                            onDelete={() => patch({ subgroups: group.subgroups.filter(x => x.id !== sg.id) })}
                        />
                    ))}
                    <button className="cm-add-btn"
                        onClick={() => patch({ subgroups: [...group.subgroups, makeSubgroup(`Subgroup ${group.subgroups.length + 1}`)] })}>
                        + Subgroup
                    </button>
                </div>
            )}
        </div>
    )
}

// ── Main ──────────────────────────────────────────────────────────────────
/**
 * CustomMappingEditor can be used in two modes:
 *  - Uncontrolled (no props):  manages own state in localStorage
 *  - Controlled (groups + onChange):  parent owns state; component syncs localStorage
 */
export default function CustomMappingEditor({ groups: externalGroups, onChange: externalOnChange } = {}) {
    const [internalGroups, setInternalGroups] = useState(() => loadMappings() || [makeGroup()])
    const isControlled = externalGroups !== undefined && externalOnChange !== undefined
    const groups = isControlled ? externalGroups : internalGroups

    const update = (next) => {
        saveMappings(next)
        if (isControlled) externalOnChange(next)
        else setInternalGroups(next)
    }

    return (
        <div className="cm-editor">
            <div className="cm-editor-header">
                <span className="cm-editor-title">Custom Mappings</span>
                <span className="cm-editor-hint">Input · Math · Output</span>
            </div>
            <div className="cm-editor-body">
                {groups.length === 0 && <div className="cm-empty cm-empty-root">No groups yet</div>}
                {groups.map(g => (
                    <Group key={g.id} group={g}
                        onChange={u => update(groups.map(x => x.id === g.id ? u : x))}
                        onDelete={() => update(groups.filter(x => x.id !== g.id))}
                    />
                ))}
            </div>
            <div className="cm-editor-footer">
                <button className="cm-add-btn cm-add-group"
                    onClick={() => update([...groups, makeGroup(`Group ${groups.length + 1}`)])}>
                    + Group
                </button>
            </div>
        </div>
    )
}
