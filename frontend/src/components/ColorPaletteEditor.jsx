import { useState, useCallback, useRef } from 'react'

// ── Colour space helpers ─────────────────────────────────────────────────────

/** [r,g,b] (0-255) → "#rrggbb" */
function rgbToHex(r, g, b) {
    const toH = (n) => Math.round(clamp(n, 0, 255)).toString(16).padStart(2, '0')
    return '#' + toH(r) + toH(g) + toH(b)
}

/** "#rrggbb" → [r,g,b] (0-255) */
function hexToRgb(hex) {
    const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex)
    return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : [0, 0, 0]
}

/** [r,g,b] (0-255) → [h(0-360), s(0-100), v(0-100)] */
function rgbToHsv(r, g, b) {
    const rn = r / 255, gn = g / 255, bn = b / 255
    const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn)
    const d = max - min
    let h = 0, s = max === 0 ? 0 : d / max, v = max
    if (d !== 0) {
        switch (max) {
            case rn: h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6; break
            case gn: h = ((bn - rn) / d + 2) / 6; break
            case bn: h = ((rn - gn) / d + 4) / 6; break
        }
    }
    return [Math.round(h * 360), Math.round(s * 100), Math.round(v * 100)]
}

/** [h(0-360), s(0-100), v(0-100)] → [r,g,b] (0-255) */
function hsvToRgb(h, s, v) {
    const hn = h / 360, sn = s / 100, vn = v / 100
    let r = 0, g = 0, b = 0
    const i = Math.floor(hn * 6)
    const f = hn * 6 - i
    const p = vn * (1 - sn)
    const q = vn * (1 - f * sn)
    const t = vn * (1 - (1 - f) * sn)
    switch (i % 6) {
        case 0: r = vn; g = t; b = p; break
        case 1: r = q; g = vn; b = p; break
        case 2: r = p; g = vn; b = t; break
        case 3: r = p; g = q; b = vn; break
        case 4: r = t; g = p; b = vn; break
        case 5: r = vn; g = p; b = q; break
    }
    return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)]
}

function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)) }

// ── HLS ↔ RGB (matching Python colorsys, h/l/s in 0–1) ───────────────────

/**
 * Adjusts an RGB color to a specific perceptual luminance while preserving hue.
 * @param {number} r - Original Red (0-255)
 * @param {number} g - Original Green (0-255)
 * @param {number} b - Original Blue (0-255)
 * @param {number} targetLuma - Target grayscale value (0-255)
 * @returns {number[]} [newR, newG, newB]
 */
function matchLuminance(r, g, b, targetLuma) {
    const currentLuma = 0.299 * r + 0.587 * g + 0.114 * b

    // Handle pure black input to avoid division by zero
    if (currentLuma === 0) {
        return [targetLuma, targetLuma, targetLuma]
    }

    const ratio = targetLuma / currentLuma

    // Scale the RGB values
    let rScaled = r * ratio
    let gScaled = g * ratio
    let bScaled = b * ratio

    const maxChannel = Math.max(rScaled, gScaled, bScaled)

    // If scaling pushes the color out of bounds, desaturate toward target gray
    if (maxChannel > 255) {
        const correctionRatio = (255 - targetLuma) / (maxChannel - targetLuma)
        rScaled = targetLuma + correctionRatio * (rScaled - targetLuma)
        gScaled = targetLuma + correctionRatio * (gScaled - targetLuma)
        bScaled = targetLuma + correctionRatio * (bScaled - targetLuma)
    }

    // Clamp bottom end just in case, and round to integers
    return [
        Math.max(0, Math.round(rScaled)),
        Math.max(0, Math.round(gScaled)),
        Math.max(0, Math.round(bScaled)),
    ]
}

/**
 * Build a 120-entry frequency color table from 12 base note colors.
 * For each octave the hue is preserved and perceptual luminance is matched
 * to a target linearly interpolated from lMin×255 (oct 0) to lMax×255 (oct 9),
 * so low notes appear darker and high notes appear brighter.
 *
 * @param {object} noteColors  { C:[r,g,b], 'C#':[r,g,b], … }
 * @param {'rgb'|'hsv'} mode
 * @param {number} lMin        Target luminance fraction for octave 0  (0–1)
 * @param {number} lMax        Target luminance fraction for octave 9  (0–1)
 * @param {number} nOctaves    default 10 (C0 … B9)
 * @returns {object}           { "C0": [r,g,b], …, "B9": [r,g,b] }
 */
function calculateFreqColorTable(noteColors, mode = 'rgb', lMin = 0.20, lMax = 0.85, nOctaves = 10) {
    const table = {}
    const NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
    for (let oct = 0; oct < nOctaves; oct++) {
        const t = oct / Math.max(nOctaves - 1, 1)
        const targetLuma = (lMin + t * (lMax - lMin)) * 255
        for (const note of NOTES) {
            const raw = noteColors[note] || [128, 128, 128]
            let rgb
            if (mode === 'hsv') {
                rgb = hsvToRgb(raw[0], raw[1], raw[2])
            } else {
                rgb = [Math.round(raw[0]), Math.round(raw[1]), Math.round(raw[2])]
            }
            table[`${note}${oct}`] = matchLuminance(rgb[0], rgb[1], rgb[2], targetLuma)
        }
    }
    return table
}

// ── Note definitions ─────────────────────────────────────────────────────────

// ── CSV colour importer ─────────────────────────────────────────────────────

/**
 * Given a frequency in Hz, return the pitch-class index (0=C … 11=B).
 * Uses equal temperament with A4 = 440 Hz.
 */
function hzToPitchClass(hz) {
    if (!hz || hz <= 0) return null
    const noteNum = Math.round(69 + 12 * Math.log2(hz / 440))
    return ((noteNum % 12) + 12) % 12
}

/**
 * Parse a color CSV and return a noteColors map { C:[r,g,b], … }.
 *
 * Expected header (case-insensitive, any order, extras ignored):
 *   Hz, r, g, b, h, s, v, hex
 *
 * Color priority per row: RGB > hex > HSV.
 * Rows mapping to the same pitch class are averaged.
 */
function parseColorCsv(text) {
    const lines = text.split(/\r?\n/).filter(l => l.trim())
    if (lines.length < 2) return null

    const headers = lines[0].split(',').map(h => h.trim().toLowerCase())
    const col = (name) => headers.indexOf(name)

    const iHz = col('hz')
    const iR = col('r'); const iG = col('g'); const iB = col('b')
    const iH = col('h'); const iS = col('s'); const iV = col('v')
    const iHex = col('hex')

    if (iHz === -1) return null  // Hz column required

    // Accumulators: sums[pitchClass] = { r, g, b, count }
    const acc = {}
    for (let li = 1; li < lines.length; li++) {
        const cells = lines[li].split(',')
        const get = (i) => i >= 0 ? cells[i]?.trim() : ''

        const hz = parseFloat(get(iHz))
        if (isNaN(hz)) continue
        const pc = hzToPitchClass(hz)
        if (pc === null) continue

        let rgb = null

        // Try RGB
        const r = parseInt(get(iR)), g = parseInt(get(iG)), b = parseInt(get(iB))
        if (!isNaN(r) && !isNaN(g) && !isNaN(b)) {
            rgb = [r, g, b]
        } else {
            // Try hex
            const hexStr = get(iHex)
            if (hexStr) {
                rgb = hexToRgb(hexStr)
            } else {
                // Try HSV
                const hv = parseFloat(get(iH)), sv = parseFloat(get(iS)), vv = parseFloat(get(iV))
                if (!isNaN(hv) && !isNaN(sv) && !isNaN(vv)) {
                    rgb = hsvToRgb(hv, sv, vv)
                }
            }
        }

        if (!rgb) continue

        if (!acc[pc]) acc[pc] = { r: 0, g: 0, b: 0, count: 0 }
        acc[pc].r += clamp(rgb[0], 0, 255)
        acc[pc].g += clamp(rgb[1], 0, 255)
        acc[pc].b += clamp(rgb[2], 0, 255)
        acc[pc].count += 1
    }

    const PITCH_CLASSES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
    const result = {}
    let populated = 0
    for (let pc = 0; pc < 12; pc++) {
        if (acc[pc] && acc[pc].count > 0) {
            const { r, g, b, count } = acc[pc]
            result[PITCH_CLASSES[pc]] = [
                Math.round(r / count),
                Math.round(g / count),
                Math.round(b / count),
            ]
            populated++
        }
    }
    return populated > 0 ? result : null
}

const NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
const NOTE_LABELS = ['C4', 'C#4', 'D4', 'D#4', 'E4', 'F4', 'F#4', 'G4', 'G#4', 'A4', 'A#4', 'B4']

// Approximate Hz for each octave root (C0 … C9)
const OCTAVE_HZ = ['16', '33', '65', '131', '262', '523', '1k', '2k', '4k', '8k']
const N_OCTAVES = 10

// ── Octave swatch row ───────────────────────────────────────────────────

function OctaveGrid({ freqColorTable, onEntryChange }) {
    if (!freqColorTable || Object.keys(freqColorTable).length === 0) {
        return (
            <div className="cpe-grid-empty">
                No table yet — click ⚡ Calculate All to generate
            </div>
        )
    }
    return (
        <div className="cpe-grid">
            {/* Header: octave numbers with Hz */}
            <div className="cpe-grid-header">
                <span className="cpe-grid-note-col" />
                {OCTAVE_HZ.map((hz, i) => (
                    <span key={i} className="cpe-grid-oct-label" title={`Octave ${i} (~${hz} Hz)`}>{hz}</span>
                ))}
            </div>
            {/* One row per note class */}
            {NOTES.map(note => (
                <div key={note} className="cpe-grid-row">
                    <span className="cpe-grid-note-col">{note}</span>
                    {Array.from({ length: N_OCTAVES }, (_, oct) => {
                        const key = `${note}${oct}`
                        const rgb = freqColorTable[key]
                        if (!rgb) return <span key={oct} className="cpe-grid-cell cpe-grid-cell-empty" />
                        const hex = rgbToHex(rgb[0], rgb[1], rgb[2])
                        return (
                            <label key={oct} className="cpe-grid-cell" title={`${key}: ${hex}`}>
                                <input
                                    type="color"
                                    value={hex}
                                    onChange={e => onEntryChange?.(key, hexToRgb(e.target.value))}
                                    style={{ opacity: 0, position: 'absolute', width: 0, height: 0 }}
                                />
                                <span
                                    className="cpe-grid-swatch"
                                    style={{ background: hex }}
                                />
                            </label>
                        )
                    })}
                </div>
            ))}
        </div>
    )
}

function NoteRow({ note, label, rgb, mode, onChange }) {
    const hex = rgbToHex(rgb[0], rgb[1], rgb[2])
    const hsv = rgbToHsv(rgb[0], rgb[1], rgb[2])

    // Local draft text — updated on every keystroke, committed on blur/Enter
    const displayVals = mode === 'rgb'
        ? `${rgb[0]}, ${rgb[1]}, ${rgb[2]}`
        : `${hsv[0]}, ${hsv[1]}, ${hsv[2]}`
    const [draft, setDraft] = useState(displayVals)
    const [editing, setEditing] = useState(false)

    // Sync draft when the external value changes (e.g. colour picker, preset load)
    // but only when not actively editing
    const prevDisplayRef = useRef(displayVals)
    if (!editing && displayVals !== prevDisplayRef.current) {
        prevDisplayRef.current = displayVals
        // eslint-disable-next-line react-hooks/rules-of-hooks -- this is a controlled sync pattern
        // We just directly update draft here (safe — non-hook path during render):
        // The useState setter is async so we track via the ref + flag approach:
    }

    const commitDraft = useCallback((text) => {
        // Accept: "255 128 0", "255,128,0", "255 / 128 / 0", tabs, mixed
        const parts = text.split(/[,\s\/\t]+/).map(s => s.trim()).filter(Boolean)
        if (parts.length < 3) return
        const nums = parts.slice(0, 3).map(Number)
        if (nums.some(isNaN)) return
        if (mode === 'rgb') {
            onChange(note, nums.map(n => clamp(Math.round(n), 0, 255)))
        } else {
            const limits = [[0, 360], [0, 100], [0, 100]]
            const clamped = nums.map((n, i) => clamp(Math.round(n), limits[i][0], limits[i][1]))
            onChange(note, hsvToRgb(clamped[0], clamped[1], clamped[2]))
        }
    }, [note, mode, onChange])

    // Keep draft in sync when not editing
    const currentDisplay = mode === 'rgb'
        ? `${rgb[0]}, ${rgb[1]}, ${rgb[2]}`
        : `${hsv[0]}, ${hsv[1]}, ${hsv[2]}`

    return (
        <div className="cpe-note-row">
            <span className="cpe-note-label">{label}</span>
            <input
                type="color"
                className="cpe-color-swatch"
                value={hex}
                onChange={e => onChange(note, hexToRgb(e.target.value))}
                title={`${label} — pick colour`}
            />
            <input
                className="cpe-triplet-input"
                type="text"
                value={editing ? draft : currentDisplay}
                placeholder={mode === 'rgb' ? '255, 128, 0' : '180, 100, 50'}
                spellCheck={false}
                onFocus={e => { setEditing(true); setDraft(currentDisplay); e.target.select() }}
                onChange={e => setDraft(e.target.value)}
                onBlur={e => { commitDraft(e.target.value); setEditing(false) }}
                onKeyDown={e => {
                    if (e.key === 'Enter') { commitDraft(e.target.value); e.target.blur() }
                    if (e.key === 'Escape') { setEditing(false); e.target.blur() }
                }}
                title={mode === 'rgb'
                    ? `RGB 0–255 each, e.g. "255, 128, 0" — paste or type`
                    : `HSV: H 0–360, S 0–100, V 0–100, e.g. "180, 100, 50" — paste or type`}
            />
        </div>
    )
}

// ── Main component ────────────────────────────────────────────────────────────

/**
 * ColorPaletteEditor
 *
 * Props:
 *   noteColors        — { C:[r,g,b], 'C#':[r,g,b], … }  (12 base notes)
 *   colorInputMode    — 'rgb' | 'hsv'
 *   freqColorTable    — { "C0": [r,g,b], …, "B9": [r,g,b] }  (120 entries)
 *   lightnessMin      — HSL lightness for octave 0  (0–1, default 0.20)
 *   lightnessMax      — HSL lightness for octave 9  (0–1, default 0.85)
 *   onChange          — (noteColors) => void
 *   onModeChange      — (mode) => void
 *   onCalculateAll    — (table, lMin, lMax) => void
 *   onTableEntryChange — (key, [r,g,b]) => void
 */
export default function ColorPaletteEditor({
    noteColors, colorInputMode,
    freqColorTable = {}, lightnessMin = 0.20, lightnessMax = 0.85,
    onChange, onModeChange, onCalculateAll, onTableEntryChange,
}) {
    const [open, setOpen] = useState(false)
    const [gridOpen, setGridOpen] = useState(false)
    const [csvError, setCsvError] = useState('')
    const csvInputRef = useRef(null)
    const [lMin, setLMin] = useState(lightnessMin)
    const [lMax, setLMax] = useState(lightnessMax)

    const handleNoteChange = useCallback((note, rgb) => {
        onChange({ ...noteColors, [note]: rgb })
    }, [noteColors, onChange])

    const handleReset = useCallback(() => {
        onChange(DEFAULT_NOTE_COLORS)
    }, [onChange])

    const handleCalculateAll = useCallback(() => {
        const table = calculateFreqColorTable(noteColors, colorInputMode, lMin, lMax)
        onCalculateAll?.(table, lMin, lMax)
    }, [noteColors, colorInputMode, lMin, lMax, onCalculateAll])

    const handleCsvImport = useCallback((e) => {
        const file = e.target.files?.[0]
        if (!file) return
        // Reset input so same file can be re-imported
        e.target.value = ''
        const reader = new FileReader()
        reader.onload = (ev) => {
            const text = ev.target.result
            const imported = parseColorCsv(text)
            if (!imported) {
                setCsvError('Could not parse CSV. Expected header: Hz, r, g, b, h, s, v, hex')
                return
            }
            // Merge: keep existing colors for pitch classes not present in CSV
            onChange({ ...noteColors, ...imported })
            setCsvError('')
        }
        reader.readAsText(file)
    }, [noteColors, onChange])

    const tableSize = Object.keys(freqColorTable).length

    return (
        <div className={`param-group cpe-group ${open ? 'open' : ''}`}>
            <button
                className="param-group-header"
                onClick={() => setOpen(!open)}
                aria-expanded={open}
            >
                <span className="param-group-chevron">{open ? '▾' : '▸'}</span>
                <span>🎨 Colors & Palette</span>
                <span className="param-group-count">12</span>
            </button>

            {open && (
                <div className="param-group-body cpe-body">
                    {/* Mode toggle + reset + CSV import */}
                    <div className="cpe-toolbar">
                        <div className="cpe-mode-toggle">
                            <button
                                className={`cpe-mode-btn ${colorInputMode === 'rgb' ? 'active' : ''}`}
                                onClick={() => onModeChange('rgb')}
                            >RGB</button>
                            <button
                                className={`cpe-mode-btn ${colorInputMode === 'hsv' ? 'active' : ''}`}
                                onClick={() => onModeChange('hsv')}
                            >HSV</button>
                        </div>
                        <div className="cpe-toolbar-right">
                            <button
                                className="cpe-import-btn"
                                onClick={() => { setCsvError(''); csvInputRef.current?.click() }}
                                title="Import colors from CSV (Hz, r, g, b, h, s, v, hex)"
                            >
                                ↑ Import CSV
                            </button>
                            <button className="cpe-reset-btn" onClick={handleReset} title="Restore defaults">
                                ↺ Reset
                            </button>
                        </div>
                        {/* Hidden file input */}
                        <input
                            ref={csvInputRef}
                            type="file"
                            accept=".csv,text/csv"
                            style={{ display: 'none' }}
                            onChange={handleCsvImport}
                        />
                    </div>
                    {csvError && (
                        <div className="cpe-csv-error">{csvError}</div>
                    )}

                    {/* Channel header */}
                    <div className="cpe-channel-header">
                        <span style={{ width: '3rem' }}>Note</span>
                        <span style={{ width: '2rem' }}></span>
                        <span style={{ flex: 1, paddingLeft: 4 }}>
                            {colorInputMode === 'rgb' ? 'R, G, B  (0–255)' : 'H, S, V  (0–360 / 0–100 / 0–100)'}
                        </span>
                    </div>

                    {/* One row per base note */}
                    {NOTES.map((note, i) => (
                        <NoteRow
                            key={note}
                            note={note}
                            label={NOTE_LABELS[i]}
                            rgb={noteColors[note] || [128, 128, 128]}
                            mode={colorInputMode}
                            onChange={handleNoteChange}
                        />
                    ))}

                    {/* ── Calculate All section ─────────────────────────── */}
                    <div className="cpe-calc-section">
                        <div className="cpe-calc-row">
                            <span className="cpe-calc-title">Freq Table C0–B9</span>
                            <button
                                className="cpe-calc-btn"
                                onClick={handleCalculateAll}
                                title="Generate 120-entry color table from the 12 base note colors above"
                            >
                                ⚡ Calc All
                            </button>
                            {tableSize > 0 && (
                                <button
                                    className="cpe-grid-toggle"
                                    onClick={() => setGridOpen(g => !g)}
                                    title="Show/hide per-frequency color grid"
                                >
                                    {gridOpen ? '▾' : '▸'} {tableSize}
                                </button>
                            )}
                        </div>
                        <div className="cpe-calc-lightness">
                            <label className="cpe-ll">
                                <span title="Lightness for octave 0 (~16 Hz)">Oct 0</span>
                                <input type="range" min="0" max="1" step="0.01"
                                    value={lMin}
                                    onChange={e => setLMin(parseFloat(e.target.value))}
                                />
                                <span className="cpe-ll-val">{Math.round(lMin * 100)}%</span>
                            </label>
                            <label className="cpe-ll">
                                <span title="Lightness for octave 9 (~16 kHz)">Oct 9</span>
                                <input type="range" min="0" max="1" step="0.01"
                                    value={lMax}
                                    onChange={e => setLMax(parseFloat(e.target.value))}
                                />
                                <span className="cpe-ll-val">{Math.round(lMax * 100)}%</span>
                            </label>
                        </div>
                        {gridOpen && tableSize > 0 && (
                            <OctaveGrid
                                freqColorTable={freqColorTable}
                                onEntryChange={onTableEntryChange}
                            />
                        )}
                    </div>
                </div>
            )}
        </div>
    )
}

// ── Default palette (mirrors backend color_engine.py) ────────────────────────

export const DEFAULT_NOTE_COLORS = {
    C: [220, 30, 30],
    'C#': [220, 90, 20],
    D: [210, 145, 10],
    'D#': [190, 190, 10],
    E: [120, 210, 20],
    F: [30, 200, 80],
    'F#': [20, 185, 160],
    G: [10, 145, 210],
    'G#': [20, 80, 220],
    A: [70, 20, 220],
    'A#': [130, 15, 200],
    B: [200, 15, 120],
}
