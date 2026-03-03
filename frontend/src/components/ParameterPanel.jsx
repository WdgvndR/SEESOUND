import { useState, useCallback, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import {
    PARAM_GROUPS, PARAMS, loadUserDefaults, saveUserDefault,
    listPresets, savePreset, loadPreset, deletePreset,
} from '../config/params.js'
import ColorPaletteEditor, { DEFAULT_NOTE_COLORS } from './ColorPaletteEditor.jsx'
import CustomMappingEditor from './CustomMappingEditor.jsx'
// ─── Info popup button ────────────────────────────────────────────────────────────
function InfoBtn({ param }) {
    const [open, setOpen] = useState(false)
    const [pos, setPos] = useState({ top: 0, left: 0 })
    const btnRef = useRef(null)

    const handleClick = (e) => {
        e.stopPropagation()
        if (open) { setOpen(false); return }
        const r = btnRef.current.getBoundingClientRect()
        const left = Math.min(r.left, window.innerWidth - 276)
        setPos({ top: r.bottom + 6, left })
        setOpen(true)
    }

    useEffect(() => {
        if (!open) return
        const close = () => setOpen(false)
        document.addEventListener('click', close)
        const onKey = (e) => { if (e.key === 'Escape') setOpen(false) }
        document.addEventListener('keydown', onKey)
        return () => {
            document.removeEventListener('click', close)
            document.removeEventListener('keydown', onKey)
        }
    }, [open])

    const rangeStr = param.isDropdown
        ? param.dropdownGroups
            ? param.dropdownGroups.flatMap(g => g.options.map(o => o.label)).join(', ')
            : (param.dropdownOptions || []).map(o => o.label).join(', ')
        : param.isToggle
            ? (param.toggleLabels ? param.toggleLabels.join(' / ') : 'Off / On')
            : `${param.min}–${param.max}${param.unit ? ' ' + param.unit : ''}`

    return (
        <>
            <button
                ref={btnRef}
                className={`param-info-btn${open ? ' active' : ''}`}
                onClick={handleClick}
                tabIndex={-1}
                aria-label={`Info: ${param.label}`}
            >ⓘ</button>
            {open && createPortal(
                <div className="param-info-popup" style={{ top: pos.top, left: pos.left }} onClick={e => e.stopPropagation()}>
                    <div className="param-info-popup-title">{param.label}</div>
                    <div className="param-info-popup-desc">{param.desc}</div>
                    <div className="param-info-popup-meta">
                        {param.isToggle ? `Options: ${rangeStr}` : `Range: ${rangeStr}`}
                        {!param.isToggle && param.neutralValue !== undefined && ` Neutral: ${param.neutralValue}`}
                        {!param.isToggle && ` Default: ${param.default}${param.unit ? ' ' + param.unit : ''}`}
                    </div>
                </div>,
                document.body
            )}
        </>
    )
}
// ─── Disable toggle ──────────────────────────────────────────────────────────
function DisableBtn({ isDisabled, onToggle, label }) {
    return (
        <button
            className={`param-disable-btn ${isDisabled ? 'is-disabled' : 'is-enabled'}`}
            onClick={onToggle}
            title={isDisabled ? `${label} is bypassed — click to enable` : `Click to bypass ${label}`}
        >
            {isDisabled ? '○' : '●'}
        </button>
    )
}

// ─── Single slider row ────────────────────────────────────────────────────────
/**
 * Shows:  [●/○]  [label]  [slider]  [value]  [default]
 */
function Slider({ param, value, userDefault, isDisabled, onChange, onSaveDefault, onToggleDisabled }) {
    const id = `slider-${param.key}`
    const isNumeric = !param.isDropdown && !param.isToggle
    const pct = isNumeric ? ((value - param.min) / (param.max - param.min)) * 100 : 0

    // Local state for the editable value field while user is typing
    const [editingValue, setEditingValue] = useState(null)   // null = not editing
    // Local state for the default field
    const [editingDefault, setEditingDefault] = useState(null)

    const commitValue = (raw) => {
        const n = parseFloat(raw)
        if (!isNaN(n)) onChange(param.key, n)   // no clamp — allow out-of-range typed values
        setEditingValue(null)
    }

    const commitDefault = (raw) => {
        const n = parseFloat(raw)
        if (!isNaN(n)) onSaveDefault(param.key, n)  // no clamp — allow out-of-range defaults
        setEditingDefault(null)
    }

    const displayValue = !isNumeric ? String(value)
        : editingValue !== null ? editingValue
            : (Number.isInteger(param.step) ? String(value) : value.toFixed(2))

    const displayDefault = !isNumeric ? String(userDefault)
        : editingDefault !== null ? editingDefault
            : (Number.isInteger(param.step) ? String(userDefault) : Number(userDefault).toFixed(2))

    if (param.isDropdown) {
        return (
            <div className={`param-row param-toggle-row${isDisabled ? ' param-row-disabled' : ''}`}>
                {param.canDisable && (
                    <DisableBtn isDisabled={isDisabled} onToggle={() => onToggleDisabled(param.key)} label={param.label} />
                )}
                <label className="param-label" htmlFor={id}>{param.label}</label>
                <select
                    id={id}
                    className="param-dropdown"
                    value={value}
                    disabled={isDisabled}
                    onChange={e => {
                        const raw = e.target.value
                        const n = Number(raw)
                        onChange(param.key, raw !== '' && !isNaN(n) ? n : raw)
                    }}
                >
                    {param.dropdownGroups
                        ? param.dropdownGroups.map(g => (
                            <optgroup key={g.label} label={g.label}>
                                {g.options.map(o => (
                                    <option key={o.value} value={o.value}>{o.label}</option>
                                ))}
                            </optgroup>
                        ))
                        : (param.dropdownOptions || []).map(o => (
                            <option key={o.value} value={o.value}>{o.label}</option>
                        ))
                    }
                </select>
                <button
                    className="param-set-default-btn"
                    onClick={() => onSaveDefault(param.key, value)}
                    title="Save current mode as session default"
                >★</button>
                <InfoBtn param={param} />
            </div>
        )
    }

    if (param.isToggle) {
        const labels = param.toggleLabels || ['Off', 'On']
        const isMulti = labels.length > 2
        return (
            <div className={`param-row param-toggle-row${isDisabled ? ' param-row-disabled' : ''}${isMulti ? ' param-toggle-multi-row' : ''}`}>
                {param.canDisable && (
                    <DisableBtn isDisabled={isDisabled} onToggle={() => onToggleDisabled(param.key)} label={param.label} />
                )}
                <label className="param-label" htmlFor={id} title={param.desc}>
                    {param.label}
                </label>
                {isMulti ? (
                    <div className="toggle-segment-group" id={id} title={param.desc}>
                        {labels.map((lbl, idx) => (
                            <button
                                key={idx}
                                className={`toggle-segment-btn${value === idx ? ' active' : ''}`}
                                onClick={() => !isDisabled && onChange(param.key, idx)}
                                disabled={isDisabled}
                            >{lbl}</button>
                        ))}
                    </div>
                ) : (
                    <button
                        id={id}
                        className={`toggle-btn ${value === 1 ? 'toggle-on' : ''}`}
                        onClick={() => onChange(param.key, value === 0 ? 1 : 0)}
                        title={param.desc}
                        disabled={isDisabled}
                    >
                        {labels[value] ?? (value === 0 ? 'Off' : 'On')}
                    </button>
                )}
                <button
                    className="param-set-default-btn"
                    onClick={() => onSaveDefault(param.key, value)}
                    title="Save current state as session default"
                >★</button>
                <InfoBtn param={param} />
            </div>
        )
    }

    return (
        <div className={`param-row${isDisabled ? ' param-row-disabled' : ''}`}>
            {param.canDisable && (
                <DisableBtn isDisabled={isDisabled} onToggle={() => onToggleDisabled(param.key)} label={param.label} />
            )}
            <label className="param-label" htmlFor={id} title={param.desc}>
                {param.label}
            </label>
            <div className="param-slider-wrap">
                <input
                    id={id}
                    type="range"
                    className="param-slider"
                    min={param.min}
                    max={param.max}
                    step={param.step}
                    value={value}
                    disabled={isDisabled}
                    onChange={(e) => onChange(param.key, parseFloat(e.target.value))}
                    style={{
                        background: isDisabled
                            ? 'var(--border)'
                            : `linear-gradient(90deg, var(--accent) ${pct}%, var(--border) ${pct}%)`,
                    }}
                />
                {/* Editable current-value field — no min/max so typing out-of-range works */}
                <input
                    type="number"
                    className="param-value-input"
                    step={param.step}
                    value={displayValue}
                    disabled={isDisabled}
                    title={`Current value${param.unit ? ' (' + param.unit + ')' : ''}`}
                    onChange={(e) => setEditingValue(e.target.value)}
                    onBlur={(e) => commitValue(e.target.value)}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter') { commitValue(e.target.value); e.target.blur() }
                        if (e.key === 'Escape') setEditingValue(null)
                    }}
                />
                {/* Default value field — no min/max so typing out-of-range works */}
                <input
                    type="number"
                    className="param-default-input"
                    step={param.step}
                    value={displayDefault}
                    title="Saved default — press Enter to save"
                    onChange={(e) => setEditingDefault(e.target.value)}
                    onBlur={() => setEditingDefault(null)}
                    onKeyDown={(e) => {
                        if (e.key === 'Enter') { commitDefault(e.target.value); e.target.blur() }
                        if (e.key === 'Escape') setEditingDefault(null)
                    }}
                />
                <InfoBtn param={param} />
            </div>
        </div>
    )
}

// ─── Preset bar ──────────────────────────────────────────────────────────────────
function PresetBar({ currentValues, disabledKeys, mappingGroups, onPresetLoad }) {
    const [presets, setPresets] = useState([])
    const [selected, setSelected] = useState('')
    const [saveName, setSaveName] = useState('')
    const [busy, setBusy] = useState(false)
    const [armOverwrite, setArmOverwrite] = useState(false)
    const armTimerRef = useRef(null)

    const refresh = useCallback(async () => {
        const names = await listPresets()
        setPresets(names)
    }, [])

    useEffect(() => { refresh() }, [refresh])

    const handleSelectPreset = (e) => {
        const name = e.target.value
        setSelected(name)
        // Pre-fill save name so user can immediately overwrite
        if (name) setSaveName(name)
    }

    const handleLoad = async () => {
        if (!selected) return
        setBusy(true)
        const data = await loadPreset(selected)
        setBusy(false)
        if (data?.params) onPresetLoad({
            params: data.params,
            disabledKeys: data.disabledKeys || [],
            mappingGroups: data.mappingGroups || [],
        })
    }

    // Clear the arm timer on unmount
    useEffect(() => () => clearTimeout(armTimerRef.current), [])

    const disarmOverwrite = () => {
        setArmOverwrite(false)
        clearTimeout(armTimerRef.current)
    }

    const handleSave = async () => {
        const name = saveName.trim()
        if (!name) return
        const isOverwrite = presets.includes(name)
        if (isOverwrite) {
            if (!armOverwrite) {
                // First click — arm the button; auto-disarm after 3 s
                setArmOverwrite(true)
                clearTimeout(armTimerRef.current)
                armTimerRef.current = setTimeout(disarmOverwrite, 3000)
                return
            }
            // Second click — confirmed, proceed
            disarmOverwrite()
        }
        setBusy(true)
        await savePreset(name, currentValues, disabledKeys, mappingGroups)
        await refresh()
        setSaveName(name)
        setSelected(name)
        setBusy(false)
    }

    const handleDelete = async () => {
        if (!selected) return
        // eslint-disable-next-line no-restricted-globals
        if (!confirm(`Delete preset "${selected}"?`)) return
        setBusy(true)
        await deletePreset(selected)
        await refresh()
        setSelected('')
        setSaveName('')
        setBusy(false)
    }

    return (
        <div className="preset-bar">
            {/* datalist feeds both the dropdown (row 1) and the name input (row 2) */}
            <datalist id="preset-names-list">
                {presets.map(n => <option key={n} value={n} />)}
            </datalist>

            <div className="preset-bar-row">
                <span className="preset-bar-label">Preset</span>
                <select
                    className="preset-select"
                    value={selected}
                    onChange={handleSelectPreset}
                    disabled={busy}
                >
                    <option value="">— select —</option>
                    {presets.map(n => <option key={n} value={n}>{n}</option>)}
                </select>
                <button className="preset-btn" onClick={handleLoad} disabled={!selected || busy} title="Load selected preset">Load</button>
                <button className="preset-btn preset-btn-del" onClick={handleDelete} disabled={!selected || busy} title="Delete selected preset">✕</button>
            </div>
            <div className="preset-bar-row">
                <input
                    className="preset-name-input"
                    list="preset-names-list"
                    type="text"
                    placeholder="Name (type or pick to overwrite)…"
                    value={saveName}
                    onChange={e => { setSaveName(e.target.value); disarmOverwrite() }}
                    onKeyDown={e => e.key === 'Enter' && handleSave()}
                    disabled={busy}
                />
                <button
                    className={`preset-btn preset-btn-save${armOverwrite
                        ? ' preset-btn-overwrite-armed'
                        : presets.includes(saveName.trim()) ? ' preset-btn-overwrite' : ''
                        }`}
                    onClick={handleSave}
                    onBlur={disarmOverwrite}
                    disabled={!saveName.trim() || busy}
                    title={
                        armOverwrite
                            ? 'Click again to confirm overwrite'
                            : presets.includes(saveName.trim())
                                ? `Overwrite preset "${saveName.trim()}" — click once to arm`
                                : 'Save as new preset'
                    }
                >
                    {armOverwrite ? '⚠ Confirm?' : presets.includes(saveName.trim()) ? '↺ Overwrite' : 'Save'}
                </button>
            </div>
        </div>
    )
}

// ─── Collapsible group ─────────────────────────────────────────────────────────────────
function ParamGroup({ group, params, values, userDefaults, disabledKeys, onChange, onSaveDefault, onToggleDisabled, startOpen }) {
    const [open, setOpen] = useState(startOpen ?? true)
    const groupParams = params.filter((p) => p.group === group.id)
    if (groupParams.length === 0) return null

    return (
        <div className={`param-group ${open ? 'open' : ''}`}>
            <button
                className="param-group-header"
                onClick={() => setOpen(!open)}
                aria-expanded={open}
            >
                <span className="param-group-chevron">{open ? '▾' : '▸'}</span>
                <span>{group.label}</span>
                <span className="param-group-count">{groupParams.length}</span>
            </button>
            {open && (
                <div className="param-group-body">
                    {groupParams.map((p) => (
                        <Slider
                            key={p.key}
                            param={p}
                            value={values[p.key]}
                            userDefault={userDefaults[p.key] ?? p.default}
                            isDisabled={disabledKeys?.has(p.key) ?? false}
                            onChange={onChange}
                            onSaveDefault={onSaveDefault}
                            onToggleDisabled={onToggleDisabled}
                        />
                    ))}
                </div>
            )}
        </div>
    )
}

/**
 * ParameterPanel — full sidebar panel with all parameter groups.
 */
export default function ParameterPanel({
    values, onChange, onReset, collapsed, onToggle,
    onColorChange, onColorModeChange,
    onCalculateAll, onTableEntryChange,
    disabledKeys, onToggleDisabled, onPresetLoad,
    activeTab, onTabChange,
    mappingGroups, onMappingGroupsChange,
}) {
    const [userDefaults, setUserDefaults] = useState(() => loadUserDefaults())

    const handleSaveDefault = useCallback((key, val) => {
        saveUserDefault(key, val)
        setUserDefaults(loadUserDefaults())
    }, [])

    return (
        <aside className={`param-panel ${collapsed ? 'collapsed' : ''}`}>
            <div className="param-panel-header">
                <button className="param-collapse-btn" onClick={onToggle} title="Toggle panel">
                    {collapsed ? '»' : '«'}
                </button>
                {!collapsed && (
                    <>
                        <div className="panel-tabs">
                            <button
                                className={`panel-tab ${activeTab === 'params' ? 'active' : ''}`}
                                onClick={() => onTabChange?.('params')}
                            >Params</button>
                            <button
                                className={`panel-tab ${activeTab === 'custom' ? 'active' : ''}`}
                                onClick={() => onTabChange?.('custom')}
                            >Custom</button>
                        </div>
                        {activeTab === 'params' && (
                            <button className="param-reset-btn" onClick={onReset} title="Reset all to defaults">
                                ↺
                            </button>
                        )}
                    </>
                )}
            </div>

            {!collapsed && activeTab === 'params' && (
                <div className="param-panel-body">
                    <PresetBar
                        currentValues={values}
                        disabledKeys={disabledKeys}
                        mappingGroups={mappingGroups || []}
                        onPresetLoad={onPresetLoad}
                    />
                    {PARAM_GROUPS
                        .filter(g => !g.layouts || g.layouts.includes(values.layoutMode ?? 0))
                        .map((g, i) => (
                            <ParamGroup
                                key={g.id}
                                group={g}
                                params={PARAMS}
                                values={values}
                                userDefaults={userDefaults}
                                disabledKeys={disabledKeys}
                                onChange={onChange}
                                onSaveDefault={handleSaveDefault}
                                onToggleDisabled={onToggleDisabled}
                                startOpen={i < 3}
                            />
                        ))}
                    <ColorPaletteEditor
                        noteColors={values.noteColors || DEFAULT_NOTE_COLORS}
                        colorInputMode={values.colorInputMode || 'rgb'}
                        freqColorTable={values.freqColorTable || {}}
                        lightnessMin={values.lightnessMin ?? 0.20}
                        lightnessMax={values.lightnessMax ?? 0.85}
                        onChange={onColorChange}
                        onModeChange={onColorModeChange}
                        onCalculateAll={onCalculateAll}
                        onTableEntryChange={onTableEntryChange}
                    />
                </div>
            )}

            {!collapsed && activeTab === 'custom' && (
                <div className="cm-panel-wrap">
                    <CustomMappingEditor
                        groups={mappingGroups}
                        onChange={onMappingGroupsChange}
                    />
                </div>
            )}
        </aside>
    )
}
