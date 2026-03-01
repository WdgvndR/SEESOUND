import { useState, useRef, useCallback, useEffect } from 'react'
import {
    listPresets, savePreset, loadPreset, deletePreset,
    PARAMS, PARAM_GROUPS, saveUserDefault,
} from '../config/params.js'
import ColorPaletteEditor, { DEFAULT_NOTE_COLORS } from './ColorPaletteEditor.jsx'
import { AUDIO_INPUTS, MATH_OPS, VISUAL_OUTPUTS, OUTPUT_MODES } from '../engine/GraphEvaluator.js'

// ─── uid & factory helpers ────────────────────────────────────────────────────
let _ic = 0
const uid = () => `m${Date.now()}${++_ic}`

export const newRule = (o = {}) => ({
    id: uid(), label: '', source: 'amplitude', op: 'multiply',
    amount: 1, target: 'radius_mult', mode: 'multiply', enabled: true,
    sourceParams: { freqLo: 80, freqHi: 500 },
    ...o,
})
export const newSubgroup = (name = 'Subgroup') => ({ id: uid(), name, collapsed: false, rules: [] })
export const newGroup = (name = 'Group') => ({ id: uid(), name, collapsed: false, rules: [], subgroups: [] })

// ─── Immutable array helpers ──────────────────────────────────────────────────
const moveItem = (arr, i, j) => {
    if (j < 0 || j >= arr.length) return arr
    const a = [...arr]; const [x] = a.splice(i, 1); a.splice(j, 0, x); return a
}

// ─── ParamRow — renders one slider / dropdown / toggle parameter ──────────────
function ParamRow({ param, value, disabled, onToggleDisabled, onChange }) {
    const [savedFlash, setSavedFlash] = useState(false)

    const handleRightClick = (e) => {
        e.preventDefault()
        saveUserDefault(param.key, value)
        setSavedFlash(true)
        setTimeout(() => setSavedFlash(false), 1200)
    }

    const isDisabled = disabled && param.canDisable

    let control
    if (param.isToggle) {
        const labels = param.toggleLabels || ['Off', 'On']
        control = (
            <div className="param-toggle-btns">
                {labels.map((lbl, idx) => (
                    <button
                        key={lbl}
                        className={`param-toggle-btn${value === idx ? ' active' : ''}`}
                        onClick={() => onChange(param.key, idx)}
                        disabled={isDisabled}
                    >
                        {lbl}
                    </button>
                ))}
            </div>
        )
    } else if (param.isDropdown) {
        if (param.dropdownGroups) {
            control = (
                <select
                    className="param-dropdown"
                    value={value}
                    onChange={e => onChange(param.key, e.target.value)}
                    disabled={isDisabled}
                >
                    {param.dropdownGroups.map(g => (
                        <optgroup key={g.label} label={g.label}>
                            {g.options.map(o => (
                                <option key={o.value} value={o.value}>{o.label}</option>
                            ))}
                        </optgroup>
                    ))}
                </select>
            )
        } else {
            control = (
                <select
                    className="param-dropdown"
                    value={value}
                    onChange={e => {
                        const v = e.target.value
                        const opt = param.dropdownOptions?.find(o => String(o.value) === String(v))
                        onChange(param.key, opt ? opt.value : v)
                    }}
                    disabled={isDisabled}
                >
                    {(param.dropdownOptions || []).map(o => (
                        <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                </select>
            )
        }
    } else {
        const numVal = parseFloat(value) || 0
        control = (
            <div className="param-slider-row">
                <input
                    type="range"
                    className="param-slider"
                    min={param.min} max={param.max} step={param.step}
                    value={numVal}
                    onChange={e => onChange(param.key, parseFloat(e.target.value))}
                    disabled={isDisabled}
                />
                <input
                    type="number"
                    className="param-value-input"
                    min={param.min} max={param.max} step={param.step}
                    value={numVal}
                    onChange={e => {
                        const v = parseFloat(e.target.value)
                        if (!isNaN(v)) onChange(param.key, v)
                    }}
                    disabled={isDisabled}
                />
                {param.unit && <span className="param-unit">{param.unit}</span>}
            </div>
        )
    }

    return (
        <div className={`param-row${isDisabled ? ' param-row-disabled' : ''}`} title={param.desc}>
            <div className="param-label-row">
                {param.canDisable && (
                    <button
                        className={`param-enable-dot${disabled ? ' dot-off' : ' dot-on'}`}
                        onClick={e => { e.stopPropagation(); onToggleDisabled && onToggleDisabled(param.key) }}
                        title={disabled ? 'Enable parameter' : 'Disable parameter'}
                        style={{ pointerEvents: 'auto' }}
                    >●</button>
                )}
                <span
                    className={`param-label${savedFlash ? ' param-label-flash' : ''}`}
                    onContextMenu={handleRightClick}
                    title={savedFlash ? 'Default saved!' : (param.desc || '')}
                >
                    {param.label}
                </span>
            </div>
            {control}
        </div>
    )
}

// ─── ParamGroupSection — collapsible group of ParamRows ───────────────────────
function ParamGroupSection({ group, params, values, disabledKeys, onToggleDisabled, onChange }) {
    const [open, setOpen] = useState(true)
    return (
        <div className="param-group">
            <div className="param-group-header" onClick={() => setOpen(o => !o)}>
                <span className="param-group-arrow">{open ? '▾' : '▸'}</span>
                <span className="param-group-label">{group.label}</span>
            </div>
            {open && (
                <div className="param-group-body">
                    {params.map(p => (
                        <ParamRow
                            key={p.key}
                            param={p}
                            value={values[p.key] ?? p.default}
                            disabled={disabledKeys?.has(p.key)}
                            onToggleDisabled={onToggleDisabled}
                            onChange={onChange}
                        />
                    ))}
                </div>
            )}
        </div>
    )
}

// ─── Mini compact select ──────────────────────────────────────────────────────
function Sel({ value, onChange, options, title, style }) {
    return (
        <select
            value={value}
            onChange={e => onChange(e.target.value)}
            title={title}
            style={{
                background: '#0a1929', color: '#b0c8e0',
                border: '1px solid #1d3a55', borderRadius: 3,
                fontSize: 10, padding: '1px 2px', cursor: 'pointer',
                maxWidth: '100%', ...style,
            }}
        >
            {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
    )
}

// ─── Move-to selector: populates with every group and its subgroups ───────────
function MoveToBtn({ sourceGroupId, sourceSubId, ruleId, groups, onChange }) {
    const destinations = []
    for (const g of groups) {
        if (g.id === sourceGroupId && !sourceSubId) continue
        destinations.push({ value: `g::${g.id}`, label: g.name })
        for (const s of g.subgroups || []) {
            if (g.id === sourceGroupId && s.id === sourceSubId) continue
            destinations.push({ value: `s::${g.id}::${s.id}`, label: `  ↳ ${s.name}` })
        }
    }
    if (!destinations.length) return null

    const doMove = (dest) => {
        if (!dest) return
        // Remove from source
        let rule = null
        const prev = groups.map(g => {
            if (!sourceSubId && g.id === sourceGroupId) {
                rule = g.rules.find(r => r.id === ruleId)
                return { ...g, rules: g.rules.filter(r => r.id !== ruleId) }
            }
            return {
                ...g, subgroups: (g.subgroups || []).map(s => {
                    if (g.id === sourceGroupId && s.id === sourceSubId) {
                        rule = s.rules.find(r => r.id === ruleId)
                        return { ...s, rules: s.rules.filter(r => r.id !== ruleId) }
                    }
                    return s
                })
            }
        })
        if (!rule) return
        // Add to dest
        const parts = dest.split('::')
        const next = prev.map(g => {
            if (parts[0] === 'g' && g.id === parts[1]) {
                return { ...g, rules: [...g.rules, rule] }
            }
            if (parts[0] === 's' && g.id === parts[1]) {
                return {
                    ...g, subgroups: (g.subgroups || []).map(s =>
                        s.id === parts[2] ? { ...s, rules: [...s.rules, rule] } : s
                    )
                }
            }
            return g
        })
        onChange(next)
    }

    return (
        <select
            value=""
            onChange={e => { doMove(e.target.value); e.target.value = '' }}
            title="Move rule to another group"
            style={{
                background: '#0a1929', color: '#4a7a9b',
                border: '1px solid #1d3a55', borderRadius: 3,
                fontSize: 10, padding: '1px 2px', cursor: 'pointer', width: 28,
            }}
        >
            <option value="">↗</option>
            {destinations.map(d => <option key={d.value} value={d.value}>{d.label}</option>)}
        </select>
    )
}

// Build ordered group→entries map from AUDIO_INPUTS for the grouped source <select>
const _INPUT_GROUPS = (() => {
    const order = ['Particle', 'Frame', 'Instruments', 'Custom']
    const map = {}
    for (const [key, def] of Object.entries(AUDIO_INPUTS)) {
        const g = def.group || 'Other'
        if (!map[g]) map[g] = []
        map[g].push({ value: key, label: def.label, desc: def.desc })
    }
    return order.filter(g => map[g]).map(g => ({ group: g, options: map[g] }))
})()

const _selBase = {
    background: '#0a1929', color: '#b0c8e0',
    border: '1px solid #1d3a55', borderRadius: 3,
    fontSize: 10, padding: '1px 2px', cursor: 'pointer', maxWidth: '100%',
}

// ─── Rule card ────────────────────────────────────────────────────────────────
function RuleCard({ rule, index, total, groupId, subId, groups, onRuleChange, onRuleDelete, onRuleMoveUp, onRuleMoveDown, onGroupsChange }) {
    const opOpts = Object.entries(MATH_OPS).map(([v, { label }]) => ({ value: v, label }))
    const outputOpts = Object.entries(VISUAL_OUTPUTS).map(([v, { label }]) => ({ value: v, label }))
    const modeOpts = Object.entries(OUTPUT_MODES).map(([v, { label }]) => ({ value: v, label }))
    const hasAmount = MATH_OPS[rule.op]?.amountLabel != null
    const isFreqBand = rule.source === 'freqband'
    const sp = rule.sourceParams || {}

    return (
        <div className={`mg-rule${rule.enabled ? '' : ' mg-rule-disabled'}`}>
            {/* Row 1: enable + label + reorder + delete */}
            <div className="mg-rule-head">
                <button
                    className="mg-enable-btn"
                    onClick={() => onRuleChange({ ...rule, enabled: !rule.enabled })}
                    title={rule.enabled ? 'Disable rule' : 'Enable rule'}
                >
                    {rule.enabled ? '●' : '○'}
                </button>
                <input
                    className="mg-label-input"
                    value={rule.label}
                    placeholder="label…"
                    onChange={e => onRuleChange({ ...rule, label: e.target.value })}
                />
                <button className="mg-icon-btn" onClick={onRuleMoveUp} disabled={index === 0} title="Move up">↑</button>
                <button className="mg-icon-btn" onClick={onRuleMoveDown} disabled={index === total - 1} title="Move down">↓</button>
                <MoveToBtn
                    sourceGroupId={groupId} sourceSubId={subId}
                    ruleId={rule.id} groups={groups} onChange={onGroupsChange}
                />
                <button className="mg-icon-btn mg-del-btn" onClick={onRuleDelete} title="Delete rule">✕</button>
            </div>
            {/* Row 2: input → math (amount) → output [mode] */}
            <div className="mg-rule-body">
                <span className="mg-badge mg-badge-in">IN</span>
                {/* Grouped source select with optgroups */}
                <select
                    value={rule.source}
                    onChange={e => onRuleChange({ ...rule, source: e.target.value })}
                    title={AUDIO_INPUTS[rule.source]?.desc}
                    style={{ ..._selBase, color: '#7dd3fc' }}
                >
                    {_INPUT_GROUPS.map(g => (
                        <optgroup key={g.group} label={g.group}>
                            {g.options.map(o => (
                                <option key={o.value} value={o.value} title={o.desc}>{o.label}</option>
                            ))}
                        </optgroup>
                    ))}
                </select>
                <span className="mg-arrow">→</span>
                <Sel
                    value={rule.op}
                    onChange={v => onRuleChange({ ...rule, op: v })}
                    options={opOpts}
                    title={MATH_OPS[rule.op]?.desc}
                    style={{ color: '#fcd34d' }}
                />
                {hasAmount && (
                    <input
                        type="number"
                        className="mg-amount-input"
                        value={rule.amount}
                        step={0.01}
                        onChange={e => onRuleChange({ ...rule, amount: parseFloat(e.target.value) || 0 })}
                        title={`${MATH_OPS[rule.op]?.amountLabel}: ${rule.amount}`}
                    />
                )}
                <span className="mg-arrow">→</span>
                <span className="mg-badge mg-badge-out">OUT</span>
                <Sel
                    value={rule.target}
                    onChange={v => onRuleChange({ ...rule, target: v })}
                    options={outputOpts}
                    title={VISUAL_OUTPUTS[rule.target]?.desc}
                    style={{ color: '#6ee7b7' }}
                />
                <Sel
                    value={rule.mode || 'multiply'}
                    onChange={v => onRuleChange({ ...rule, mode: v })}
                    options={modeOpts}
                    title="How the output value is applied"
                    style={{ color: '#a78bfa', width: 28 }}
                />
            </div>
            {/* Row 3 (only for freqband): Hz range inputs */}
            {isFreqBand && (
                <div className="mg-freqband-row">
                    <span className="mg-freqband-label">Hz range:</span>
                    <input
                        type="number"
                        className="mg-freqband-input"
                        value={sp.freqLo ?? 80}
                        min={20} max={19999} step={10}
                        placeholder="Lo Hz"
                        onChange={e => onRuleChange({ ...rule, sourceParams: { ...sp, freqLo: parseFloat(e.target.value) || 20 } })}
                        title="Low cutoff frequency in Hz"
                    />
                    <span className="mg-freqband-sep">–</span>
                    <input
                        type="number"
                        className="mg-freqband-input"
                        value={sp.freqHi ?? 500}
                        min={21} max={20000} step={10}
                        placeholder="Hi Hz"
                        onChange={e => onRuleChange({ ...rule, sourceParams: { ...sp, freqHi: parseFloat(e.target.value) || 500 } })}
                        title="High cutoff frequency in Hz"
                    />
                    <span className="mg-freqband-label">Hz</span>
                </div>
            )}
        </div>
    )
}

// ─── Rule list (shared between group and subgroup) ────────────────────────────
function RuleList({ rules, groupId, subId, groups, onGroupsChange, updateRules }) {
    return (
        <div className="mg-rules-list">
            {rules.map((rule, i) => (
                <RuleCard
                    key={rule.id}
                    rule={rule} index={i} total={rules.length}
                    groupId={groupId} subId={subId}
                    groups={groups} onGroupsChange={onGroupsChange}
                    onRuleChange={r => updateRules(rules.map(x => x.id === r.id ? r : x))}
                    onRuleDelete={() => updateRules(rules.filter(x => x.id !== rule.id))}
                    onRuleMoveUp={() => updateRules(moveItem(rules, i, i - 1))}
                    onRuleMoveDown={() => updateRules(moveItem(rules, i, i + 1))}
                />
            ))}
            <button className="mg-add-rule-btn" onClick={() => updateRules([...rules, newRule()])}>
                ＋ Add rule
            </button>
        </div>
    )
}

// ─── Subgroup ─────────────────────────────────────────────────────────────────
function SubgroupSection({ sub, index, totalSubs, groupId, groups, onGroupsChange, updateSub, deleteSub, moveSubUp, moveSubDown }) {
    const updateRules = (rules) => updateSub({ ...sub, rules })
    return (
        <div className="mg-subgroup">
            <div className="mg-subgroup-header">
                <button
                    className="mg-collapse-btn"
                    onClick={() => updateSub({ ...sub, collapsed: !sub.collapsed })}
                    title={sub.collapsed ? 'Expand' : 'Collapse'}
                >
                    {sub.collapsed ? '▸' : '▾'}
                </button>
                <input
                    className="mg-name-input"
                    value={sub.name}
                    onChange={e => updateSub({ ...sub, name: e.target.value })}
                    placeholder="subgroup name…"
                />
                <span className="mg-count">{sub.rules.length}</span>
                <button className="mg-icon-btn" onClick={moveSubUp} disabled={index === 0} title="Move up">↑</button>
                <button className="mg-icon-btn" onClick={moveSubDown} disabled={index === totalSubs - 1} title="Move down">↓</button>
                <button className="mg-icon-btn mg-del-btn" onClick={deleteSub} title="Delete subgroup">✕</button>
            </div>
            {!sub.collapsed && (
                <RuleList
                    rules={sub.rules}
                    groupId={groupId} subId={sub.id}
                    groups={groups} onGroupsChange={onGroupsChange}
                    updateRules={updateRules}
                />
            )}
        </div>
    )
}

// ─── Group ────────────────────────────────────────────────────────────────────
function GroupSection({ group, index, total, groups, onGroupsChange }) {
    const updateGroup = (patch) => {
        onGroupsChange(groups.map(g => g.id === group.id ? { ...g, ...patch } : g))
    }
    const deleteGroup = () => {
        if (group.rules.length + (group.subgroups || []).reduce((s, sg) => s + sg.rules.length, 0) > 0) {
            if (!window.confirm(`Delete group "${group.name}" and all its rules?`)) return
        }
        onGroupsChange(groups.filter(g => g.id !== group.id))
    }
    const addSubgroup = () => {
        updateGroup({ subgroups: [...(group.subgroups || []), newSubgroup()] })
    }
    const ruleCount = (group.rules?.length || 0) + (group.subgroups || []).reduce((s, sg) => s + sg.rules.length, 0)

    return (
        <div className={`mg-group${group.collapsed ? ' mg-group-collapsed' : ''}`}>
            <div className="mg-group-header">
                <button
                    className="mg-collapse-btn"
                    onClick={() => updateGroup({ collapsed: !group.collapsed })}
                    title={group.collapsed ? 'Expand' : 'Collapse'}
                >
                    {group.collapsed ? '▸' : '▾'}
                </button>
                <input
                    className="mg-name-input mg-group-name"
                    value={group.name}
                    onChange={e => updateGroup({ name: e.target.value })}
                    placeholder="group name…"
                />
                <span className="mg-count">{ruleCount}</span>
                <button className="mg-icon-btn" onClick={() => onGroupsChange(moveItem(groups, index, index - 1))} disabled={index === 0} title="Move group up">↑</button>
                <button className="mg-icon-btn" onClick={() => onGroupsChange(moveItem(groups, index, index + 1))} disabled={index === total - 1} title="Move group down">↓</button>
                <button className="mg-icon-btn mg-sub-btn" onClick={addSubgroup} title="Add subgroup">⊞</button>
                <button className="mg-icon-btn mg-del-btn" onClick={deleteGroup} title="Delete group">✕</button>
            </div>

            {!group.collapsed && (
                <div className="mg-group-body">
                    {/* Direct rules */}
                    <RuleList
                        rules={group.rules || []}
                        groupId={group.id} subId={null}
                        groups={groups} onGroupsChange={onGroupsChange}
                        updateRules={rules => updateGroup({ rules })}
                    />
                    {/* Subgroups */}
                    {(group.subgroups || []).map((sub, si) => (
                        <SubgroupSection
                            key={sub.id}
                            sub={sub} index={si} totalSubs={group.subgroups.length}
                            groupId={group.id} groups={groups} onGroupsChange={onGroupsChange}
                            updateSub={s => updateGroup({ subgroups: (group.subgroups || []).map(x => x.id === s.id ? s : x) })}
                            deleteSub={() => updateGroup({ subgroups: (group.subgroups || []).filter(x => x.id !== sub.id) })}
                            moveSubUp={() => updateGroup({ subgroups: moveItem(group.subgroups, si, si - 1) })}
                            moveSubDown={() => updateGroup({ subgroups: moveItem(group.subgroups, si, si + 1) })}
                        />
                    ))}
                </div>
            )}
        </div>
    )
}

// ─── Preset bar ───────────────────────────────────────────────────────────────
function PresetBar({ colorValues, mappingGroups, onPresetLoad }) {
    const [presets, setPresets] = useState([])
    const [selected, setSelected] = useState('')
    const [saveName, setSaveName] = useState('')
    const [busy, setBusy] = useState(false)
    const [armed, setArmed] = useState(false)
    const armTimer = useRef(null)

    const refresh = useCallback(async () => {
        const names = await listPresets(); setPresets(names)
    }, [])
    useEffect(() => { refresh() }, [refresh])

    const handleLoad = async () => {
        if (!selected) return
        setBusy(true)
        const data = await loadPreset(selected)
        setBusy(false)
        if (data) onPresetLoad(data)
    }
    useEffect(() => () => clearTimeout(armTimer.current), [])
    const disarm = () => { setArmed(false); clearTimeout(armTimer.current) }

    const handleSave = async () => {
        const name = saveName.trim()
        if (!name) return
        if (presets.includes(name) && !armed) {
            setArmed(true)
            armTimer.current = setTimeout(disarm, 3000)
            return
        }
        disarm()
        setBusy(true)
        // Pass mappingGroups as the "nodes" slot; empty params for base values
        await savePreset(name, colorValues || {}, mappingGroups)
        await refresh()
        setSaveName(name); setSelected(name)
        setBusy(false)
    }

    const handleDelete = async () => {
        if (!selected || !window.confirm(`Delete preset "${selected}"?`)) return
        setBusy(true)
        await deletePreset(selected)
        await refresh(); setSelected(''); setSaveName('')
        setBusy(false)
    }

    return (
        <div className="preset-bar">
            <datalist id="preset-names-list">
                {presets.map(n => <option key={n} value={n} />)}
            </datalist>
            <div className="preset-bar-row">
                <span className="preset-bar-label">Preset</span>
                <select className="preset-select" value={selected} onChange={e => { setSelected(e.target.value); if (e.target.value) setSaveName(e.target.value) }} disabled={busy}>
                    <option value="">— select —</option>
                    {presets.map(n => <option key={n} value={n}>{n}</option>)}
                </select>
                <button className="preset-btn" onClick={handleLoad} disabled={!selected || busy}>Load</button>
                <button className="preset-btn preset-btn-del" onClick={handleDelete} disabled={!selected || busy}>✕</button>
            </div>
            <div className="preset-bar-row">
                <input list="preset-names-list" className="preset-name-input" type="text" placeholder="Name…"
                    value={saveName} onChange={e => { setSaveName(e.target.value); disarm() }}
                    onKeyDown={e => e.key === 'Enter' && handleSave()} disabled={busy} />
                <button
                    className={`preset-btn preset-btn-save${armed ? ' preset-btn-overwrite-armed' : presets.includes(saveName.trim()) ? ' preset-btn-overwrite' : ''}`}
                    onClick={handleSave} onBlur={disarm} disabled={!saveName.trim() || busy}
                >
                    {armed ? '⚠ Confirm?' : presets.includes(saveName.trim()) ? '↺ Overwrite' : 'Save'}
                </button>
            </div>
        </div>
    )
}

// ─── Color section (collapsible wrapper) ─────────────────────────────────────
function ColorSection({ values, onColorChange, onColorModeChange, onCalculateAll, onTableEntryChange }) {
    const [open, setOpen] = useState(false)
    return (
        <div className="mg-group" style={{ marginTop: 4 }}>
            <div className="mg-group-header" style={{ cursor: 'pointer' }} onClick={() => setOpen(o => !o)}>
                <span className="mg-collapse-btn">{open ? '▾' : '▸'}</span>
                <span style={{ color: '#e2c87a', fontSize: 11, fontWeight: 700, flex: 1 }}>🎨 Colors & Palette</span>
            </div>
            {open && (
                <div className="mg-group-body" style={{ padding: 4 }}>
                    <ColorPaletteEditor
                        noteColors={values?.noteColors || DEFAULT_NOTE_COLORS}
                        colorInputMode={values?.colorInputMode || 'rgb'}
                        freqColorTable={values?.freqColorTable || {}}
                        lightnessMin={values?.lightnessMin ?? 0.20}
                        lightnessMax={values?.lightnessMax ?? 0.85}
                        onChange={onColorChange}
                        onModeChange={onColorModeChange}
                        onCalculateAll={onCalculateAll}
                        onTableEntryChange={onTableEntryChange}
                    />
                </div>
            )}
        </div>
    )
}

// ─── Main export ──────────────────────────────────────────────────────────────
export default function ParameterPanel({
    collapsed, onToggle,
    panelStyle,
    // param sliders
    values, onChange, onReset, disabledKeys, onToggleDisabled,
    // color palette (kept as special section)
    onColorChange, onColorModeChange, onCalculateAll, onTableEntryChange,
    // mapping groups (the main configurable system)
    mappingGroups, onMappingGroupsChange,
    // preset load receives full preset data
    onPresetLoad,
}) {
    return (
        <aside className={`param-panel${collapsed ? ' collapsed' : ''}`} style={panelStyle}>
            <div className="param-panel-header">
                <button className="param-collapse-btn" onClick={onToggle} title="Toggle panel">
                    {collapsed ? '»' : '«'}
                </button>
                {!collapsed && (
                    <h2 className="param-panel-title">Mappings</h2>
                )}
            </div>

            {!collapsed && (
                <div className="param-panel-body">
                    <PresetBar
                        colorValues={values}
                        mappingGroups={mappingGroups || []}
                        onPresetLoad={onPresetLoad}
                    />

                    {/* ── Parameter sliders (restored) ── */}
                    <div className="pp-params-section">
                        {PARAM_GROUPS.map(g => (
                            <ParamGroupSection
                                key={g.id}
                                group={g}
                                params={PARAMS.filter(p => p.group === g.id)}
                                values={values || {}}
                                disabledKeys={disabledKeys}
                                onToggleDisabled={onToggleDisabled}
                                onChange={onChange}
                            />
                        ))}
                        {onReset && (
                            <button
                                className="param-reset-btn-full"
                                onClick={onReset}
                                title="Reset all parameters to their default values"
                            >
                                ↺ Reset All
                            </button>
                        )}
                    </div>

                    <div className="pp-section-divider">Input → Math → Output Rules</div>

                    {/* Mapping groups */}
                    <div className="mg-groups">
                        {(mappingGroups || []).map((g, i) => (
                            <GroupSection
                                key={g.id}
                                group={g} index={i} total={mappingGroups.length}
                                groups={mappingGroups} onGroupsChange={onMappingGroupsChange}
                            />
                        ))}
                    </div>

                    <button
                        className="mg-add-group-btn"
                        onClick={() => onMappingGroupsChange([...(mappingGroups || []), newGroup()])}
                    >
                        ＋ Add Group
                    </button>

                    <ColorSection
                        values={values}
                        onColorChange={onColorChange}
                        onColorModeChange={onColorModeChange}
                        onCalculateAll={onCalculateAll}
                        onTableEntryChange={onTableEntryChange}
                    />
                </div>
            )}
        </aside>
    )
}
