import { useEffect, useRef, useState } from 'react'

// ── Helpers ──────────────────────────────────────────────────────────────────

const LOG_MIN = Math.log10(20)
const LOG_MAX = Math.log10(22050)

// All 12 chromatic pitch classes in ascending order
var NOTE_ORDER = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

// Map frequency → note-octave key (e.g. "A4", "C#3") matching the freqColorTable
function freqToNoteOctave(freq) {
    if (!freq || freq <= 0) return 'C0'
    var midi = Math.round(69 + 12 * Math.log2(freq / 440))
    midi = Math.max(12, Math.min(131, midi))
    var octave = Math.floor(midi / 12) - 1
    return NOTE_ORDER[midi % 12] + octave
}

// Return the best available color for a component given the current palette.
// Priority: freqColorTable[noteOctave] > noteColors[note] > c.color_rgb
function resolveColor(c, freqColorTable, noteColors) {
    if (freqColorTable) {
        var key = freqToNoteOctave(c.freq)
        var tc = freqColorTable[key]
        if (tc) return tc
    }
    if (noteColors && c.note) {
        var nc = noteColors[c.note]
        if (nc) return nc
    }
    return c.color_rgb
}

function freqToX(freq, width) {
    var logF = Math.log10(Math.max(freq, 20))
    return ((logF - LOG_MIN) / (LOG_MAX - LOG_MIN)) * width
}

// Map frequency to Y position: high freq → top (y=0), low freq → bottom (y=height)
function freqToY(freq, height) {
    var logF = Math.log10(Math.max(freq, 20))
    return (1 - (logF - LOG_MIN) / (LOG_MAX - LOG_MIN)) * height
}

function rgbStr(rgb, a) {
    if (!rgb) return 'rgba(180,180,180,' + a + ')'
    return 'rgba(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ',' + a + ')'
}

function hexFromRgb(rgb) {
    if (!rgb) return '#aaaaaa'
    var r = Math.round(Math.max(0, Math.min(255, rgb[0]))).toString(16).padStart(2, '0')
    var g = Math.round(Math.max(0, Math.min(255, rgb[1]))).toString(16).padStart(2, '0')
    var b = Math.round(Math.max(0, Math.min(255, rgb[2]))).toString(16).padStart(2, '0')
    return '#' + r + g + b
}

// Octave labels for the frequency axis
var AXIS_LABELS = [
    { freq: 32.7, label: 'C1' },
    { freq: 65.4, label: 'C2' },
    { freq: 130.8, label: 'C3' },
    { freq: 261.6, label: 'C4' },
    { freq: 523.3, label: 'C5' },
    { freq: 1046.5, label: 'C6' },
    { freq: 2093.0, label: 'C7' },
    { freq: 4186.0, label: 'C8' },
    { freq: 440, label: 'A4' },
    { freq: 1000, label: '1k' },
    { freq: 10000, label: '10k' },
]

// ── Spectrum canvas ───────────────────────────────────────────────────────────

function SpectrumCanvas({ components }) {
    var canvasRef = useRef(null)

    useEffect(function () {
        var canvas = canvasRef.current
        if (!canvas) return

        var dpr = window.devicePixelRatio || 1
        var cssW = canvas.getBoundingClientRect().width || canvas.clientWidth || 200
        var cssH = canvas.getBoundingClientRect().height || canvas.clientHeight || 280
        canvas.width = Math.round(cssW * dpr)
        canvas.height = Math.round(cssH * dpr)
        var ctx = canvas.getContext('2d')
        ctx.scale(dpr, dpr)
        var w = cssW, h = cssH

        // Left margin reserved for frequency labels
        var LABEL_W = 32

        // Background
        ctx.fillStyle = '#08080e'
        ctx.fillRect(0, 0, w, h)

        // Horizontal grid lines at notable frequencies
        ctx.strokeStyle = 'rgba(255,255,255,0.06)'
        ctx.lineWidth = 1
        AXIS_LABELS.forEach(function (ax) {
            if (ax.freq < 20 || ax.freq > 22050) return
            var y = freqToY(ax.freq, h)
            ctx.beginPath()
            ctx.moveTo(LABEL_W, y)
            ctx.lineTo(w, y)
            ctx.stroke()
        })

        // Draw horizontal amplitude bars
        if (components && components.length > 0) {
            // Sort ascending by amplitude so brighter colours paint on top
            var sorted = components.slice().sort(function (a, b) { return a.amplitude - b.amplitude })
            sorted.forEach(function (c) {
                var y = freqToY(c.freq, h)
                var barW = c.amplitude * (w - LABEL_W)
                if (barW < 0.5) return

                // Gradient dim (left) → bright (right)
                var grd = ctx.createLinearGradient(LABEL_W, y, LABEL_W + barW, y)
                grd.addColorStop(0, rgbStr(c.color_rgb, 0.2))
                grd.addColorStop(1, rgbStr(c.color_rgb, 0.9))
                ctx.fillStyle = grd
                ctx.fillRect(LABEL_W, y - 2, barW, 4)

                // Bright tip at the right end
                ctx.fillStyle = rgbStr(c.color_rgb, 1)
                ctx.fillRect(LABEL_W + barW - 2, y - 2, 2, 4)
            })
        } else {
            ctx.fillStyle = 'rgba(120,120,140,0.4)'
            ctx.font = '11px system-ui'
            ctx.textAlign = 'center'
            ctx.fillText('No audio data', (w + LABEL_W) / 2, h / 2)
        }

        // Frequency axis labels on the left
        ctx.fillStyle = 'rgba(160,155,175,0.7)'
        ctx.font = '9px system-ui'
        ctx.textAlign = 'right'
        AXIS_LABELS.forEach(function (ax) {
            if (ax.freq < 20 || ax.freq > 20000) return
            var y = freqToY(ax.freq, h)
            ctx.fillText(ax.label, LABEL_W - 4, y + 3)
        })

    }, [components])

    return <canvas ref={canvasRef} className="fm-spectrum-canvas" />
}

// ── Mini per-note spectrum (tiny inline canvas) ──────────────────────────────

function MiniSpectrum({ comps }) {
    var canvasRef = useRef(null)
    useEffect(function () {
        var canvas = canvasRef.current
        if (!canvas) return
        var dpr = window.devicePixelRatio || 1
        var w = canvas.clientWidth || 80
        var h = canvas.clientHeight || 16
        canvas.width = Math.round(w * dpr)
        canvas.height = Math.round(h * dpr)
        var ctx = canvas.getContext('2d')
        ctx.scale(dpr, dpr)
        ctx.clearRect(0, 0, w, h)
        comps.forEach(function (c) {
            var x = freqToX(c.freq, w)
            var barH = Math.max(2, c.amplitude * h)
            var grd = ctx.createLinearGradient(x, h - barH, x, h)
            grd.addColorStop(0, rgbStr(c.color_rgb, 0.95))
            grd.addColorStop(1, rgbStr(c.color_rgb, 0.2))
            ctx.fillStyle = grd
            ctx.fillRect(x - 2, h - barH, 4, barH)
        })
    }, [comps])
    return <canvas ref={canvasRef} className="fm-note-mini-spectrum" />
}

// ── Note group row ─────────────────────────────────────────────────────────────

// C0 = 16.352 Hz → octave = floor(log2(freq / C0))
var C0 = 16.352

// NoteGroup: always visible — dims to 0.28 opacity when silent, keeps last-seen octaves / mini spectrum
function NoteGroup({ note, active, peak, lastComps }) {
    var loudest = lastComps.length > 0
        ? lastComps.reduce(function (a, b) { return a.amplitude >= b.amplitude ? a : b })
        : null
    var hex = loudest ? hexFromRgb(loudest.color_rgb) : '#333340'
    var octaves = lastComps.length > 0
        ? Array.from(new Set(lastComps.map(function (c) {
            return Math.floor(Math.log2(Math.max(c.freq, 1) / C0))
        }))).sort(function (a, b) { return a - b })
        : []

    return (
        <div className="fm-note-row">
            <span className="fm-swatch" style={{ background: hex }} />
            <span className="fm-note-name">{note}</span>
            <span className="fm-note-octaves">
                {octaves.map(function (o) { return <span key={o} className="fm-note-oct">{o}</span> })}
            </span>
            <div className="fm-note-bar-wrap" title={active ? (Math.round(peak * 100) + '%') : ''}>
                <div className="fm-note-bar" style={{ width: (peak * 100) + '%', background: hex }} />
            </div>
            {/* Always render MiniSpectrum so row height is stable; comps=[] draws nothing */}
            <MiniSpectrum comps={active ? lastComps : []} />
        </div>
    )
}

// ── Note badge ────────────────────────────────────────────────────────────────

function noteBadge(c) {
    var octave = Math.floor(Math.log2(Math.max(c.freq, 1) / C0))
    return c.note + octave  // e.g. "A4", "C#3"
}

// Instrument emoji map (must match backend timbre_classifier.py)
var INST_EMOJI = {
    'Sub / Kick': '🥁', 'Bass': '🎸', 'Cello': '🎻',
    'Viola': '🎻', 'Violin': '🎻', 'Piano': '🎹',
    'Guitar': '🎸', 'Flute': '🎶', 'Clarinet': '🎷',
    'Oboe': '🎷', 'Saxophone': '🎷', 'Trumpet': '🎺',
    'Trombone': '🎺', 'French Horn': '🎺', 'Voice': '🎤',
    'Percussion': '🥁', 'Synth / Other': '🎛️',
}

// ── Instrument card ───────────────────────────────────────────────────────────

// InstrumentCard: always rendered — dims when silent, keeps last-seen note badges
function InstrumentCard({ name, comps, active, peak }) {
    var loudest = comps.length > 0
        ? comps.reduce(function (a, b) { return a.amplitude >= b.amplitude ? a : b })
        : null
    var hex = loudest ? hexFromRgb(loudest.color_rgb) : '#333340'
    var emoji = INST_EMOJI[name] || '♪'

    // Unique note badges sorted by frequency (from last-seen comps)
    var seen = {}
    var badges = comps
        .slice()
        .sort(function (a, b) { return a.freq - b.freq })
        .filter(function (c) {
            var k = noteBadge(c)
            if (seen[k]) return false
            seen[k] = true
            return true
        })

    return (
        <div className="fm-inst-card">
            <div className="fm-inst-header">
                <span className="fm-inst-emoji">{emoji}</span>
                <span className="fm-inst-name">{name}</span>
                <div className="fm-inst-bar-wrap" title={Math.round(peak * 100) + '%'}>
                    <div className="fm-inst-bar" style={{ width: (peak * 100) + '%', background: hex }} />
                </div>
            </div>
            {badges.length > 0 && (
                <div className="fm-inst-notes">
                    {badges.map(function (c) {
                        var label = noteBadge(c)
                        var badgeHex = hexFromRgb(c.color_rgb)
                        return (
                            <span
                                key={label + c.freq}
                                className="fm-inst-badge"
                                style={{ background: badgeHex + '28', borderColor: badgeHex }}
                                title={c.freq.toFixed(1) + ' Hz · amp ' + Math.round(c.amplitude * 100) + '%'}
                            >{label}</span>
                        )
                    })}
                </div>
            )}
            {/* Always render MiniSpectrum so card height is stable */}
            <MiniSpectrum comps={active ? comps : []} />
        </div>
    )
}

// ── Single component row ──────────────────────────────────────────────────────

function ComponentRow({ c }) {
    var ampPct = Math.round(c.amplitude * 100)
    var panPct = ((c.pan + 1) / 2) * 100   // 0–100 where 50 = centre
    var hex = hexFromRgb(c.color_rgb)

    return (
        <div className="fm-row">
            <span className="fm-swatch" style={{ background: hex }} title={hex} />
            <span className="fm-note">{c.note}</span>
            <span className="fm-freq">{c.freq < 1000
                ? c.freq.toFixed(1) + ' Hz'
                : (c.freq / 1000).toFixed(2) + ' kHz'}
            </span>
            <span className="fm-amp-bar-wrap" title={ampPct + '%'}>
                <span className="fm-amp-bar" style={{ width: ampPct + '%', background: hex }} />
            </span>
            <span className="fm-pan" title={'Pan ' + (c.pan >= 0 ? 'R' : 'L') + Math.abs(Math.round(c.pan * 100)) + '%'}>
                <span className="fm-pan-dot" style={{ left: panPct + '%' }} />
            </span>
        </div>
    )
}

// ── Main component ────────────────────────────────────────────────────────────

/**
 * FrequencyMonitor
 *
 * Right-side panel showing what frequencies are currently active.
 *
 * Props:
 *   frame      — latest AnalysisFrame (or null)
 *   noteColors — optional { C:[r,g,b], … } map (unused visually here – colors come from frame)
 *   collapsed  — boolean
 *   onToggle   — () => void
 */
export default function FrequencyMonitor({ frame, noteColors, freqColorTable, collapsed, onToggle, panelStyle }) {
    var rawComponents = (frame && frame.components) ? frame.components : []
    // Remap color_rgb from the live palette so color always reflects the current preset
    var components = rawComponents.map(function (c) {
        var resolved = resolveColor(c, freqColorTable, noteColors)
        return resolved !== c.color_rgb ? Object.assign({}, c, { color_rgb: resolved }) : c
    })
    var rms = frame ? (frame.rms_db != null ? frame.rms_db.toFixed(1) + ' dB' : '—') : '—'
    var time = frame ? frame.time_seconds.toFixed(3) + ' s' : '—'
    var qty = components.length

    var [activeTab, setActiveTab] = useState('spectrum')

    // ── Persistent frequency registry (spectrum tab) ─────────────────────────
    // Keyed by semitone so slightly-drifting peaks don't multiply rows.
    var registryRef = useRef({})
    var semitoneKey = function (freq) {
        return Math.round(12 * Math.log2(Math.max(freq, 20) / 440))
    }
    var activeKeys = new Set()
    components.forEach(function (c) {
        var k = semitoneKey(c.freq)
        activeKeys.add(k)
        registryRef.current[k] = Object.assign({}, c, { active: true })
    })
    Object.keys(registryRef.current).forEach(function (k) {
        if (!activeKeys.has(Number(k))) {
            registryRef.current[k] = Object.assign({}, registryRef.current[k], { amplitude: 0, active: false })
        }
    })
    var allComps = Object.values(registryRef.current).sort(function (a, b) { return a.freq - b.freq })

    // ── Persistent note registry (notes tab) ──────────────────────────────────
    // Keeps last-seen comps for each pitch class so rows never disappear.
    var noteRegistryRef = useRef({})
    var activeNoteSet = new Set()
    components.forEach(function (c) { activeNoteSet.add(c.note) })
    NOTE_ORDER.forEach(function (n) {
        if (!noteRegistryRef.current[n]) {
            noteRegistryRef.current[n] = { lastComps: [], active: false, peak: 0 }
        }
        var entry = noteRegistryRef.current[n]
        if (activeNoteSet.has(n)) {
            var nc = components.filter(function (c) { return c.note === n })
            entry.active = true
            entry.lastComps = nc
            entry.peak = nc.reduce(function (m, c) { return Math.max(m, c.amplitude) }, 0)
        } else {
            entry.active = false
            entry.peak = 0
        }
    })

    // ── Persistent instrument registry (instruments tab) ──────────────────────
    // Keeps last-seen comps + stable sort order so all instruments stay visible.
    var instRegistryRef = useRef({})
    // Build current-frame instrument map
    var instMap = {}
    components.forEach(function (c) {
        var label = c.instrument || 'Synth / Other'
        if (!instMap[label]) instMap[label] = []
        instMap[label].push(c)
    })
    // Update registry
    Object.keys(instMap).forEach(function (name) {
        var comps = instMap[name]
        var minFreq = comps.reduce(function (m, c) { return Math.min(m, c.freq) }, Infinity)
        if (!instRegistryRef.current[name]) {
            instRegistryRef.current[name] = { lastComps: [], minFreq: minFreq, peak: 0, active: false }
        }
        var entry = instRegistryRef.current[name]
        entry.active = true
        entry.lastComps = comps
        entry.peak = comps.reduce(function (m, c) { return Math.max(m, c.amplitude) }, 0)
        entry.minFreq = Math.min(entry.minFreq, minFreq)
    })
    Object.keys(instRegistryRef.current).forEach(function (name) {
        if (!instMap[name]) {
            instRegistryRef.current[name].active = false
            instRegistryRef.current[name].peak = 0
        }
    })
    // All instruments ever seen, sorted by lowest freq seen (stable order)
    var allInstruments = Object.entries(instRegistryRef.current)
        .map(function (e) { return { name: e[0], comps: e[1].lastComps, active: e[1].active, peak: e[1].peak, minFreq: e[1].minFreq } })
        .sort(function (a, b) { return a.minFreq - b.minFreq })

    return (
        <aside className={'fm-panel' + (collapsed ? ' collapsed' : '')} style={panelStyle}>
            {/* Header */}
            <div className="fm-header">
                <button className="fm-toggle-btn" onClick={onToggle} title="Toggle panel">
                    {collapsed ? '«' : '»'}
                </button>
                {!collapsed && (
                    <div className="fm-tabs">
                        <button
                            className={'fm-tab-btn' + (activeTab === 'spectrum' ? ' active' : '')}
                            onClick={() => setActiveTab('spectrum')}
                        >Spectrum</button>
                        <button
                            className={'fm-tab-btn' + (activeTab === 'notes' ? ' active' : '')}
                            onClick={() => setActiveTab('notes')}
                        >Notes</button>
                        <button
                            className={'fm-tab-btn' + (activeTab === 'instruments' ? ' active' : '')}
                            onClick={() => setActiveTab('instruments')}
                        >Instr.</button>
                    </div>
                )}
            </div>

            {!collapsed && (
                <div className="fm-body">
                    {/* Meta row — always visible */}
                    <div className="fm-meta">
                        <span title="Current time offset"><span className="fm-meta-label">t</span> {time}</span>
                        <span title="RMS energy"><span className="fm-meta-label">RMS</span> {rms}</span>
                        <span title="Active components"><span className="fm-meta-label">n</span> {qty}</span>
                    </div>

                    {activeTab === 'spectrum' && (
                        <div>
                            {/* Column headings */}
                            <div className="fm-col-headers">
                                <span style={{ width: '0.85rem' }}></span>
                                <span className="fm-note">Note</span>
                                <span className="fm-freq">Freq</span>
                                <span className="fm-amp-bar-wrap">Amp</span>
                                <span className="fm-pan">Pan</span>
                            </div>

                            {/* Component list — all ever-seen frequencies */}
                            <div className="fm-list">
                                {allComps.length === 0
                                    ? <p className="fm-empty">Waiting for audio…</p>
                                    : allComps.map(function (c) { return <ComponentRow key={semitoneKey(c.freq)} c={c} /> })
                                }
                            </div>
                        </div>
                    )}

                    {activeTab === 'notes' && (
                        <div className="fm-list fm-note-list">
                            {NOTE_ORDER.map(function (n) {
                                var entry = noteRegistryRef.current[n] || { lastComps: [], active: false, peak: 0 }
                                return <NoteGroup key={n} note={n} active={entry.active} peak={entry.peak} lastComps={entry.lastComps} />
                            })}
                        </div>
                    )}

                    {activeTab === 'instruments' && (
                        <div className="fm-list fm-inst-list">
                            {allInstruments.length === 0
                                ? <p className="fm-empty">Waiting for audio…</p>
                                : allInstruments.map(function (g) {
                                    return <InstrumentCard key={g.name} name={g.name} comps={g.comps} active={g.active} peak={g.peak} />
                                })
                            }
                        </div>
                    )}
                </div>
            )}
        </aside>
    )
}
