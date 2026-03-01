/**
 * SEESOUND — ControlPanel.js
 * ════════════════════════════════════════════════════════════════════════════
 * Pure vanilla-JS DOM builder for the Global Parameter Matrix UI.
 *
 * Port of the React ParameterPanel.jsx / Slider / ParamGroup components.
 * No framework dependency — attaches directly to the existing #control-panel
 * element in index.html.
 *
 * Features (matching the old React UI exactly)
 * ─────────────────────────────────────────────
 *  • Collapsible sidebar (« / » button)
 *  • ⓘ info tooltip per parameter (Escape / click-away to close)
 *  • ● / ○ bypass toggle per bypassable parameter
 *  • Continuous sliders with:
 *      – Filled gradient track (accent colour → border)
 *      – Editable live-value number input
 *      – Editable default number input (★ to save)
 *  • Dropdown selects (grouped or flat)
 *  • Segmented toggle buttons
 *  • Preset bar: load from server, save to server, delete, overwrite confirm
 *  • 12-note colour palette swatches (click to open a <input type=color>)
 *
 * All changes call ParamStore.set() immediately — the render loop in main.js
 * picks up the new value on the very next animation frame.
 *
 * Usage
 * ──────
 *   import { initControlPanel } from './engine/ControlPanel.js'
 *   initControlPanel(document.getElementById('control-panel'))
 */

import {
    PARAMS, PARAM_GROUPS,
    params, disabled,
    set, setMany, resetToDefaults,
    saveUserDefault, toggleDisabled, getSnapshot,
    listPresets, savePreset, loadPreset, deletePreset,
} from './ParamStore.js'

// ─────────────────────────────────────────────────────────────────────────────
// § 1  HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function el(tag, className, attrs = {}) {
    const e = document.createElement(tag)
    if (className) e.className = className
    for (const [k, v] of Object.entries(attrs)) {
        if (k === 'text') e.textContent = v
        else if (k === 'html') e.innerHTML = v
        else if (k === 'title') e.title = v
        else e.setAttribute(k, v)
    }
    return e
}

function fmt(p, v) {
    if (p.isDropdown || p.isToggle) return String(v)
    return Number.isInteger(p.step) ? String(v) : Number(v).toFixed(2)
}

// ─────────────────────────────────────────────────────────────────────────────
// § 2  INFO TOOLTIP
// ─────────────────────────────────────────────────────────────────────────────

let _activeTooltip = null

function buildInfoBtn(p) {
    const btn = el('button', 'cp-info-btn', { text: 'ⓘ', 'aria-label': `Info: ${p.label}` })

    // Range / options string
    let rangeStr
    if (p.isDropdown) {
        rangeStr = p.dropdownGroups
            ? p.dropdownGroups.flatMap(g => g.options.map(o => o.label)).join(', ')
            : (p.dropdownOptions ?? []).map(o => o.label).join(', ')
    } else if (p.isToggle) {
        rangeStr = (p.toggleLabels ?? ['Off', 'On']).join(' / ')
    } else {
        rangeStr = `${p.min}–${p.max}${p.unit ? ' ' + p.unit : ''}`
    }

    btn.addEventListener('click', (e) => {
        e.stopPropagation()
        // Close any open tooltip
        if (_activeTooltip) { _activeTooltip.remove(); _activeTooltip = null }
        if (btn.classList.contains('active')) { btn.classList.remove('active'); return }

        const popup = el('div', 'cp-info-popup')
        popup.innerHTML = `
      <div class="cp-info-title">${p.label}</div>
      <div class="cp-info-desc">${p.desc}</div>
      <div class="cp-info-meta">
        ${p.isToggle ? 'Options' : 'Range'}: ${rangeStr}
        ${!p.isToggle && p.neutralValue !== undefined ? ` · Neutral: ${p.neutralValue}` : ''}
        ${!p.isToggle ? ` · Default: ${p.default}${p.unit ? ' ' + p.unit : ''}` : ''}
      </div>`

        const rect = btn.getBoundingClientRect()
        popup.style.top = `${rect.bottom + 6}px`
        popup.style.left = `${Math.min(rect.left, window.innerWidth - 280)}px`
        document.body.appendChild(popup)

        btn.classList.add('active')
        _activeTooltip = popup

        popup.addEventListener('click', e => e.stopPropagation())

        requestAnimationFrame(() => {
            const close = () => {
                popup.remove()
                btn.classList.remove('active')
                _activeTooltip = null
                document.removeEventListener('click', close)
                document.removeEventListener('keydown', onKey)
            }
            const onKey = (e) => { if (e.key === 'Escape') close() }
            document.addEventListener('click', close)
            document.addEventListener('keydown', onKey)
        })
    })
    return btn
}

// ─────────────────────────────────────────────────────────────────────────────
// § 3  BYPASS BUTTON
// ─────────────────────────────────────────────────────────────────────────────

function buildBypassBtn(p, row) {
    const btn = el('button', 'cp-bypass-btn')
    const update = () => {
        const off = disabled.has(p.key)
        btn.textContent = off ? '○' : '●'
        btn.title = off ? `${p.label} is bypassed — click to enable` : `Click to bypass ${p.label}`
        row.classList.toggle('cp-row-disabled', off)
    }
    update()
    btn.addEventListener('click', () => { toggleDisabled(p.key); update(); syncRow(p, row) })
    return btn
}

// ─────────────────────────────────────────────────────────────────────────────
// § 4  SLIDER ROW BUILDERS
// ─────────────────────────────────────────────────────────────────────────────

/** Map of key → syncRow function so the panel can be refreshed externally. */
const _rowSyncMap = new Map()

function syncRow(p, row) {
    _rowSyncMap.get(p.key)?.(params[p.key])
}

// ── 4a  Standard slider (range input + value + default fields) ────────────

function buildSliderRow(p) {
    const row = el('div', 'cp-row')
    row.classList.toggle('cp-row-disabled', disabled.has(p.key))

    if (p.canDisable) row.appendChild(buildBypassBtn(p, row))

    const lbl = el('label', 'cp-label', { text: p.label, title: p.desc })
    lbl.setAttribute('for', `cp-${p.key}`)
    row.appendChild(lbl)

    const wrap = el('div', 'cp-slider-wrap')

    // Range input
    const slider = el('input', 'cp-slider', {
        id: `cp-${p.key}`, type: 'range',
        min: p.min, max: p.max, step: p.step, value: params[p.key],
    })

    // Value display input (editable, no min/max clamp — allows typed out-of-range)
    const valInput = el('input', 'cp-val-input', {
        type: 'number', step: p.step, value: fmt(p, params[p.key]),
        title: `Current value${p.unit ? ' (' + p.unit + ')' : ''}`,
    })

    // Default display input (editable via typing then Enter)
    const savedDefaults = (() => { try { return JSON.parse(localStorage.getItem('seesound_user_defaults_v3') || '{}') } catch { return {} } })()
    const defInput = el('input', 'cp-def-input', {
        type: 'number', step: p.step,
        value: fmt(p, savedDefaults[p.key] ?? p.default),
        title: 'Saved default — press Enter to save',
    })

    const saveStar = el('button', 'cp-star-btn', { text: '★', title: 'Save current value as session default' })

    function updateTrack(v) {
        const pct = ((v - p.min) / (p.max - p.min)) * 100
        if (!disabled.has(p.key)) {
            slider.style.background =
                `linear-gradient(90deg, var(--cp-accent) ${pct}%, var(--cp-border) ${pct}%)`
        } else {
            slider.style.background = 'var(--cp-border)'
        }
    }
    updateTrack(params[p.key])

    slider.addEventListener('input', () => {
        const v = parseFloat(slider.value)
        set(p.key, v)
        valInput.value = fmt(p, v)
        updateTrack(v)
    })

    valInput.addEventListener('change', () => {
        const v = parseFloat(valInput.value)
        if (!isNaN(v)) {
            set(p.key, v)
            slider.value = String(Math.min(p.max, Math.max(p.min, v)))
            updateTrack(v)
        }
    })
    valInput.addEventListener('keydown', e => { if (e.key === 'Escape') valInput.value = fmt(p, params[p.key]) })

    defInput.addEventListener('keydown', e => {
        if (e.key === 'Enter') {
            const v = parseFloat(defInput.value)
            if (!isNaN(v)) saveUserDefault(p.key, v)
            defInput.blur()
        }
        if (e.key === 'Escape') defInput.blur()
    })
    defInput.addEventListener('blur', () => { defInput.value = fmt(p, parseFloat(defInput.value) || (savedDefaults[p.key] ?? p.default)) })

    saveStar.addEventListener('click', () => {
        saveUserDefault(p.key, params[p.key])
        defInput.value = fmt(p, params[p.key])
    })

    // Expose sync for external preset load
    _rowSyncMap.set(p.key, (v) => {
        slider.value = String(Math.min(p.max, Math.max(p.min, v)))
        valInput.value = fmt(p, v)
        updateTrack(v)
        row.classList.toggle('cp-row-disabled', disabled.has(p.key))
    })

    wrap.append(slider, valInput, defInput, saveStar, buildInfoBtn(p))
    row.appendChild(wrap)
    return row
}

// ── 4b  Dropdown row ──────────────────────────────────────────────────────

function buildDropdownRow(p) {
    const row = el('div', 'cp-row cp-toggle-row')
    row.classList.toggle('cp-row-disabled', disabled.has(p.key))

    if (p.canDisable) row.appendChild(buildBypassBtn(p, row))

    const lbl = el('label', 'cp-label', { text: p.label })
    lbl.setAttribute('for', `cp-${p.key}`)
    row.appendChild(lbl)

    const sel = el('select', 'cp-dropdown', { id: `cp-${p.key}` })

    if (p.dropdownGroups) {
        for (const g of p.dropdownGroups) {
            const grp = el('optgroup', '', { label: g.label })
            for (const o of g.options) {
                const opt = el('option', '', { value: o.value, text: o.label })
                if (String(o.value) === String(params[p.key])) opt.selected = true
                grp.appendChild(opt)
            }
            sel.appendChild(grp)
        }
    } else {
        for (const o of (p.dropdownOptions ?? [])) {
            const opt = el('option', '', { value: o.value, text: o.label })
            if (String(o.value) === String(params[p.key])) opt.selected = true
            sel.appendChild(opt)
        }
    }

    sel.addEventListener('change', () => {
        const raw = sel.value
        const n = Number(raw)
        set(p.key, raw !== '' && !isNaN(n) ? n : raw)
    })

    const star = el('button', 'cp-star-btn', { text: '★', title: 'Save as default' })
    star.addEventListener('click', () => saveUserDefault(p.key, params[p.key]))

    _rowSyncMap.set(p.key, (v) => {
        sel.value = String(v)
        row.classList.toggle('cp-row-disabled', disabled.has(p.key))
    })

    row.append(sel, star, buildInfoBtn(p))
    return row
}

// ── 4c  Toggle (segmented buttons) row ───────────────────────────────────

function buildToggleRow(p) {
    const row = el('div', 'cp-row cp-toggle-row')
    row.classList.toggle('cp-row-disabled', disabled.has(p.key))

    if (p.canDisable) row.appendChild(buildBypassBtn(p, row))

    const lbl = el('label', 'cp-label', { text: p.label, title: p.desc })
    row.appendChild(lbl)

    const labels = p.toggleLabels ?? ['Off', 'On']
    const segGroup = el('div', 'cp-seg-group')

    const btns = labels.map((txt, idx) => {
        const b = el('button', 'cp-seg-btn', { text: txt })
        if (params[p.key] === idx) b.classList.add('active')
        b.addEventListener('click', () => {
            if (disabled.has(p.key)) return
            set(p.key, idx)
            btns.forEach((bb, i) => bb.classList.toggle('active', i === idx))
        })
        return b
    })
    segGroup.append(...btns)

    const star = el('button', 'cp-star-btn', { text: '★', title: 'Save as default' })
    star.addEventListener('click', () => saveUserDefault(p.key, params[p.key]))

    _rowSyncMap.set(p.key, (v) => {
        btns.forEach((b, i) => b.classList.toggle('active', i === v))
        row.classList.toggle('cp-row-disabled', disabled.has(p.key))
    })

    row.append(segGroup, star, buildInfoBtn(p))
    return row
}

// ─────────────────────────────────────────────────────────────────────────────
// § 5  PRESET BAR
// ─────────────────────────────────────────────────────────────────────────────

function buildPresetBar() {
    const bar = el('div', 'cp-preset-bar')

    // ── Row 1: select + Load + Delete
    const row1 = el('div', 'cp-preset-row')
    const lbl = el('span', 'cp-preset-label', { text: 'Preset' })
    const sel = el('select', 'cp-preset-sel')
    const btnLoad = el('button', 'cp-preset-btn', { text: 'Load', title: 'Load selected preset' })
    const btnDel = el('button', 'cp-preset-btn cp-preset-del', { text: '✕', title: 'Delete selected preset' })

    row1.append(lbl, sel, btnLoad, btnDel)

    // ── Row 2: name input + Save
    const row2 = el('div', 'cp-preset-row')
    const nameInput = el('input', 'cp-preset-name', { type: 'text', placeholder: 'Name…' })
    const btnSave = el('button', 'cp-preset-btn cp-preset-save', { text: 'Save' })
    row2.append(nameInput, btnSave)

    bar.append(row1, row2)

    let presets = []

    async function refresh() {
        presets = await listPresets()
        const prev = sel.value
        sel.innerHTML = '<option value="">— select —</option>'
        for (const n of presets) {
            const o = el('option', '', { value: n, text: n })
            sel.appendChild(o)
        }
        if (prev && presets.includes(prev)) sel.value = prev
    }

    sel.addEventListener('change', () => {
        if (sel.value) nameInput.value = sel.value
    })

    btnLoad.addEventListener('click', async () => {
        if (!sel.value) return
        const data = await loadPreset(sel.value)
        if (data?.params) {
            setMany(data.params)
            // Sync all rows visually
            for (const p of PARAMS) _rowSyncMap.get(p.key)?.(params[p.key])
        }
    })

    btnDel.addEventListener('click', async () => {
        if (!sel.value) return
        // eslint-disable-next-line no-restricted-globals
        if (!confirm(`Delete preset "${sel.value}"?`)) return
        await deletePreset(sel.value)
        await refresh()
        nameInput.value = ''
    })

    btnSave.addEventListener('click', async () => {
        const name = nameInput.value.trim()
        if (!name) return
        if (presets.includes(name) && !confirm(`Overwrite preset "${name}"?`)) return
        await savePreset(name, getSnapshot())
        await refresh()
        sel.value = name
    })

    nameInput.addEventListener('keydown', e => { if (e.key === 'Enter') btnSave.click() })

    // Update save button style when name matches an existing preset
    nameInput.addEventListener('input', () => {
        btnSave.textContent = presets.includes(nameInput.value.trim()) ? '↺ Overwrite' : 'Save'
        btnSave.classList.toggle('cp-preset-overwrite', presets.includes(nameInput.value.trim()))
    })

    refresh()
    return bar
}

// ─────────────────────────────────────────────────────────────────────────────
// § 6  COLOR PALETTE EDITOR
// ─────────────────────────────────────────────────────────────────────────────

const NOTE_ORDER = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']

function rgbToHex([r, g, b]) {
    return '#' + [r, g, b].map(c => Math.round(c).toString(16).padStart(2, '0')).join('')
}

function hexToRgb(hex) {
    const m = hex.match(/^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i)
    return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : [255, 255, 255]
}

function buildPaletteEditor() {
    const section = el('div', 'cp-palette-section')
    const hdr = el('div', 'cp-palette-header')
    const title = el('span', '', { text: '12-Note Colour Palette' })
    const toggle = el('button', 'cp-palette-toggle', { text: '▾' })
    hdr.append(title, toggle)

    const body = el('div', 'cp-palette-body')

    // Mode selector
    const modeRow = el('div', 'cp-palette-mode-row')
    const modeLabel = el('span', '', { text: 'Input Mode:' })
    const modeRgb = el('button', 'cp-seg-btn', { text: 'RGB' })
    const modeHsv = el('button', 'cp-seg-btn', { text: 'HSV' })
    if (params.colorInputMode === 'rgb') modeRgb.classList.add('active')
    else modeHsv.classList.add('active')
    modeRgb.addEventListener('click', () => {
        set('colorInputMode', 'rgb'); modeRgb.classList.add('active'); modeHsv.classList.remove('active')
    })
    modeHsv.addEventListener('click', () => {
        set('colorInputMode', 'hsv'); modeHsv.classList.add('active'); modeRgb.classList.remove('active')
    })
    modeRow.append(modeLabel, modeRgb, modeHsv)
    body.appendChild(modeRow)

    // One swatch per note
    const swatchGrid = el('div', 'cp-swatch-grid')
    for (const note of NOTE_ORDER) {
        const cell = el('div', 'cp-swatch-cell')
        const lbl = el('span', 'cp-swatch-label', { text: note })

        const hex = rgbToHex(params.noteColors?.[note] ?? [128, 128, 128])
        const picker = el('input', 'cp-swatch-picker', { type: 'color', value: hex, title: `Colour for note ${note}` })

        picker.addEventListener('input', () => {
            const rgb = hexToRgb(picker.value)
            const nc = { ...(params.noteColors ?? {}) }
            nc[note] = rgb
            set('noteColors', nc)
        })

        cell.append(lbl, picker)
        swatchGrid.appendChild(cell)
    }
    body.appendChild(swatchGrid)
    section.append(hdr, body)

    let open = true
    toggle.addEventListener('click', () => {
        open = !open
        body.style.display = open ? '' : 'none'
        toggle.textContent = open ? '▾' : '▸'
    })

    return section
}

// ─────────────────────────────────────────────────────────────────────────────
// § 7  COLLAPSIBLE GROUP
// ─────────────────────────────────────────────────────────────────────────────

function buildGroup(groupDef, groupParams, startOpen) {
    const wrap = el('div', `cp-group${startOpen ? ' cp-open' : ''}`)
    const hdr = el('button', 'cp-group-header')
    hdr.innerHTML =
        `<span class="cp-group-chevron">${startOpen ? '▾' : '▸'}</span>` +
        `<span>${groupDef.label}</span>` +
        `<span class="cp-group-count">${groupParams.length}</span>`

    const body = el('div', 'cp-group-body')
    body.style.display = startOpen ? '' : 'none'

    for (const p of groupParams) {
        if (p.isDropdown) body.appendChild(buildDropdownRow(p))
        else if (p.isToggle) body.appendChild(buildToggleRow(p))
        else body.appendChild(buildSliderRow(p))
    }

    let open = startOpen
    hdr.setAttribute('aria-expanded', String(open))
    hdr.addEventListener('click', () => {
        open = !open
        wrap.classList.toggle('cp-open', open)
        body.style.display = open ? '' : 'none'
        hdr.setAttribute('aria-expanded', String(open))
        const chevron = hdr.querySelector('.cp-group-chevron')
        if (chevron) chevron.textContent = open ? '▾' : '▸'
    })

    wrap.append(hdr, body)
    return wrap
}

// ─────────────────────────────────────────────────────────────────────────────
// § 8  PUBLIC INIT
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the full control panel UI inside `container`.
 * Attach it to `document.getElementById('control-panel')`.
 *
 * @param {HTMLElement} container
 */
export function initControlPanel(container) {
    if (!container) { console.warn('[ControlPanel] No container element found.'); return }

    // ── Sidebar header (title + collapse + reset)
    const header = el('div', 'cp-header')
    const collapseBtn = el('button', 'cp-collapse-btn', { text: '«', title: 'Collapse panel' })
    const title = el('span', 'cp-title', { text: 'Parameters' })
    const resetBtn = el('button', 'cp-reset-btn', { text: '↺', title: 'Reset all to factory defaults' })
    header.append(collapseBtn, title, resetBtn)

    // ── Scrollable body
    const body = el('div', 'cp-body')
    body.appendChild(buildPresetBar())

    for (let i = 0; i < PARAM_GROUPS.length; i++) {
        const g = PARAM_GROUPS[i]
        const groupParams = PARAMS.filter(p => p.group === g.id)
        if (groupParams.length === 0) continue
        body.appendChild(buildGroup(g, groupParams, i < 3))
    }

    body.appendChild(buildPaletteEditor())

    container.append(header, body)

    // ── Collapse / expand sidebar
    let collapsed = false
    collapseBtn.addEventListener('click', () => {
        collapsed = !collapsed
        container.classList.toggle('cp-collapsed', collapsed)
        collapseBtn.textContent = collapsed ? '»' : '«'
        title.style.display = collapsed ? 'none' : ''
        resetBtn.style.display = collapsed ? 'none' : ''
        body.style.display = collapsed ? 'none' : ''
    })

    // ── Reset all params
    resetBtn.addEventListener('click', () => {
        if (!confirm('Reset all parameters to factory defaults?')) return
        resetToDefaults()
        for (const p of PARAMS) _rowSyncMap.get(p.key)?.(params[p.key])
    })
}
