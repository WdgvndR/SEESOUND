// prettier-ignore-file
/* eslint-disable */
/**
 * SEESOUND - Canvas Rendering Engine
 * Blend modes: 0 = Light (screen), 1 = Pigment (multiply)
 */

// -- Helpers --
var clamp = function (v, lo, hi) { return Math.min(hi, Math.max(lo, v)) }
var lerp = function (a, b, t) { return a + (b - a) * t }

function hsla(h, s, l, a) {
    return "hsla(" + h.toFixed(1) + ", " + (s * 100).toFixed(1) + "%, " + (l * 100).toFixed(1) + "%, " + a.toFixed(3) + ")"
}

function rgbaStr(rgb, a) {
    return "rgba(" + Math.round(rgb[0]) + ", " + Math.round(rgb[1]) + ", " + Math.round(rgb[2]) + ", " + a.toFixed(3) + ")"
}

function seededRandom(seed) {
    var s = seed % 2147483647
    if (s <= 0) s += 2147483646
    return function () {
        s = (s * 16807) % 2147483647
        return (s - 1) / 2147483646
    }
}

// -- A-weighting (ISO 226) equal-loudness approximation --
// Returns 0..1, peaking at ~3400 Hz = 1.0
// Implements the ITU-R A-weighting transfer function formula.
function equalLoudnessWeight(freq) {
    var f = Math.max(freq, 10)
    var f2 = f * f
    var num = 148693636.0 * f2 * f2
    var den = (f2 + 424.36) * (f2 + 148693636.0) * Math.sqrt((f2 + 11599.29) * (f2 + 544496.41))
    if (den < 1e-10) return 0
    return Math.min((num / den) * 1.104, 1.0)  // 1.104 = normalization to peak=1.0 at ~3400Hz
}

export class RenderEngine {
    constructor(canvas) {
        this.canvas = canvas
        this.ctx = canvas.getContext("2d", { alpha: false })
        this.accumulationCanvas = document.createElement("canvas")
        this.accumulationCtx = this.accumulationCanvas.getContext("2d", { alpha: true })
        this.frameCount = 0
        this.lastTimestamp = 0
        this.fps = 0
        this.componentAges = new Map()
        this.w = 0
        this.h = 0
        this.trackDuration = 0       // set via setTrackDuration() for painting mode
        this.lastModeKey = ''         // detect mode switches to wipe canvas
        this.lState = null            // L-System persistent state (mode 1)
        this._graphEval = null        // GraphEvaluator instance (node-graph layer)
        // Use ResizeObserver so we always know the real canvas CSS size
        this._ro = new ResizeObserver(function (entries) {
            if (entries[0]) {
                var cs = entries[0].contentRect
                this._applySize(cs.width, cs.height)
            }
        }.bind(this))
        this._ro.observe(canvas)
        // Also do an immediate measurement in case layout is already done
        var rect = canvas.getBoundingClientRect()
        if (rect.width > 0 && rect.height > 0) this._applySize(rect.width, rect.height)
    }

    _applySize(cssW, cssH) {
        var dpr = window.devicePixelRatio || 1
        var pw = Math.round(cssW * dpr)
        var ph = Math.round(cssH * dpr)
        if (pw < 1 || ph < 1) return
        // Assigning canvas.width resets 2d context state — scale must follow
        this.canvas.width = pw
        this.canvas.height = ph
        this.accumulationCanvas.width = pw
        this.accumulationCanvas.height = ph
        this.ctx.scale(dpr, dpr)
        this.accumulationCtx.scale(dpr, dpr)
        this.w = cssW
        this.h = cssH
    }

    resize() {
        var rect = this.canvas.getBoundingClientRect()
        if (rect.width > 0 && rect.height > 0) this._applySize(rect.width, rect.height)
    }

    destroy() {
        if (this._ro) this._ro.disconnect()
    }

    clear() {
        this.ctx.clearRect(0, 0, this.w, this.h)
        this.accumulationCtx.clearRect(0, 0, this.w, this.h)
        this.frameCount = 0
        this.componentAges.clear()
        this.lState = null
    }

    setTrackDuration(dur) {
        this.trackDuration = (dur && dur > 0) ? dur : 0
    }

    /** Attach (or detach by passing null) a compiled GraphEvaluator. */
    setGraphEvaluator(ge) {
        this._graphEval = ge || null
    }

    renderFrame(frame, params, audioTime, trackDuration) {
        // Safety: if ResizeObserver hasn't fired yet, force a sync measure
        if (this.w === 0 || this.h === 0) {
            var rect = this.canvas.getBoundingClientRect()
            if (rect.width > 0 && rect.height > 0) this._applySize(rect.width, rect.height)
            else return   // canvas still has no layout — skip this frame
        }

        var nowMs = performance.now()
        if (this.lastTimestamp > 0) {
            this.fps = lerp(this.fps, 1000 / (nowMs - this.lastTimestamp), 0.1)
        }
        this.lastTimestamp = nowMs
        this.frameCount++

        var ctx = this.ctx
        var accCtx = this.accumulationCtx
        var w = this.w, h = this.h
        var components = frame.components || []
        var time = frame.time_seconds || 0
        // audioTime: actual player position (more accurate for linear X than frame timestamp)
        var renderTime = (audioTime != null) ? audioTime : time
        var blendMode = (params.blendMode != null) ? params.blendMode : 'screen'
        // Darken-group modes look best on a light canvas; everything else on dark
        var isLightBg = blendMode === 'multiply' || blendMode === 'color-burn' || blendMode === 'darken'

        // layoutMode:  0 = Linear (time→X, log-freq→Y), 1 = L-System 2D, 2 = Circular (full-range), 9 = Freq×Stereo (pan→X, log-freq→Y), 10 = Amp×Stereo (pan→X, dBFS→Y)
        // persistMode:  0 = Momentary (fade/trail),    1 = Painting (marks persist forever)
        var layoutMode = (params.layoutMode != null) ? params.layoutMode : 0
        var persistMode = (params.persistMode != null) ? params.persistMode : 0
        var modeKey = layoutMode + ',' + persistMode
        if (this.lastModeKey !== modeKey) {
            ctx.clearRect(0, 0, w, h)  // wipe canvas whenever either mode changes
            if (this.accumulationCtx) this.accumulationCtx.clearRect(0, 0, w, h)
            this.lastModeKey = modeKey
            if (layoutMode !== 1) this.lState = null
        }
        if (persistMode === 0) {
            // Momentary: slow translucent fill creates trail/decay effect
            // For linear mode, respect linearTrailFade; for others default 0.05
            var _trailAlpha = (layoutMode === 0 && params.linearTrailFade != null) ? params.linearTrailFade : 0.05
            ctx.fillStyle = isLightBg
                ? "rgba(245,242,235," + _trailAlpha + ")"
                : "rgba(10,10,15," + _trailAlpha + ")"
            ctx.fillRect(0, 0, w, h)
        }
        // Painting (persistMode=1): no clearing — every mark is permanent

        // ── Dispatch to specialised renderers ─────────────────────────────────
        if (layoutMode === 1) {
            this._renderLSystem(ctx, w, h, components, frame, params, blendMode, persistMode, isLightBg, time)
            return
        }
        if (layoutMode === 2) {
            this._renderCircular(ctx, w, h, components, frame, params, blendMode, persistMode, isLightBg, time)
            return
        }

        var rmsDb = (frame.rms_db != null) ? frame.rms_db : -60
        var rmsNorm = clamp((rmsDb + 60) / 60, 0, 1)
        var atmosphericAlpha = (params.atmosphericPressure / 100) * rmsNorm * 0.15

        var bassComps = components.filter(function (c) { return c.freq < 250 })
        var bassEnergy = bassComps.reduce(function (s, c) { return s + c.amplitude }, 0)
        var lfWash = (params.lfWash / 100) * clamp(bassEnergy, 0, 1)

        var uniqueNotes = new Set(components.map(function (c) { return c.note })).size
        var entropyJitter = (params.entropy / 100) * clamp(uniqueNotes / 12, 0, 1) * 6

        var bpm = (frame.bpm != null) ? frame.bpm : 120
        var kineticMul = lerp(1, clamp(bpm / 120, 0.5, 3), params.kineticPendulum / 100)
        var fluidShift = (params.fluidDynamics / 100) * clamp(bassEnergy * 0.5, 0, 1)

        var avgPan = 0
        if (components.length > 0) {
            avgPan = components.reduce(function (s, c) { return s + c.pan }, 0) / components.length
        }
        var phaseTilt = (params.phaseInterference / 100) * avgPan * 3

        ctx.save()

        if (persistMode === 0) {
            // Momentary-only: these canvas-wide fills would overwrite permanent marks in Painting mode
            if (Math.abs(phaseTilt) > 0.01) {
                ctx.translate(w / 2, h / 2)
                ctx.rotate((phaseTilt * Math.PI) / 180)
                ctx.translate(-w / 2, -h / 2)
            }

            if (fluidShift > 0.001) {
                var fscale = 1 + fluidShift * 0.05
                ctx.translate(w / 2, h / 2)
                ctx.scale(fscale, fscale)
                ctx.translate(-w / 2, -h / 2)
            }

            if (lfWash > 0.01 && bassComps.length > 0) {
                var sum = bassComps.reduce(function (acc, c) { return [acc[0] + c.color_rgb[0], acc[1] + c.color_rgb[1], acc[2] + c.color_rgb[2]] }, [0, 0, 0])
                var nb = bassComps.length
                ctx.fillStyle = rgbaStr([sum[0] / nb, sum[1] / nb, sum[2] / nb], lfWash * 0.15)
                ctx.fillRect(0, 0, w, h)
            }

            if (atmosphericAlpha > 0.001) {
                ctx.fillStyle = isLightBg
                    ? "rgba(200,195,185," + atmosphericAlpha + ")"
                    : "rgba(40,30,60," + atmosphericAlpha + ")"
                ctx.fillRect(0, 0, w, h)
            }
        }

        ctx.globalCompositeOperation = blendMode

        var rng = seededRandom(frame.frame_index * 1337)
        // Sort ascending by freq so higher notes render on top (painter's z-order by pitch)
        var sortedComps = components.slice().sort(function (a, b) { return a.freq - b.freq })
        var activeCount = Math.min(sortedComps.length, Math.ceil(sortedComps.length * kineticMul))

        for (var i = 0; i < activeCount; i++) {
            var c = sortedComps[i]
            if (!c) continue

            // Log-frequency normalized 0 (16 Hz) → 1 (16 kHz) — equal semitone spacing across audible range
            // log2(16000/16) = log2(1000), so the denominator is the same as the 20 Hz baseline
            var freqLogNorm = clamp(Math.log2(Math.max(c.freq, 16) / 16) / Math.log2(1000), 0, 1)

            var cx, cy
            if (layoutMode === 0) {
                // Linear mode: X = actual audio position (L→R), Y = log freq (bass=bottom, treble=top)
                // trackDuration arg is passed from App (last frame time_seconds) — reliable fallback chain
                var trackDur = (trackDuration && trackDuration > 1.0) ? trackDuration
                    : (this.trackDuration > 1.0 ? this.trackDuration : Math.max(time * 1.1, 1.0))
                cx = clamp(renderTime / trackDur, 0, 1) * w
                cy = (1 - freqLogNorm) * h
            } else if (layoutMode === 9) {
                // 2D Freq × Stereo: X = stereo pan (left→right), Y = log-frequency (bass=bottom, treble=top)
                cx = ((c.pan + 1) / 2) * w
                cy = (1 - freqLogNorm) * h
            } else if (layoutMode === 10) {
                // 2D Amp × Stereo: X = stereo pan (left→right), Y = amplitude in dBFS
                //   top    = params.amplitudeThreshold  (noise floor, quietest plotted signal)
                //   bottom = params.ampstereoLimit       (loudest / ceiling)
                var _threshDb = (params.amplitudeThreshold != null) ? params.amplitudeThreshold : -48
                var _limitDb = (params.ampstereoLimit != null) ? params.ampstereoLimit : -6
                var _dbRange = _limitDb - _threshDb   // positive, e.g. 42
                var _ampDb = 20 * Math.log10(Math.max(c.amplitude, 1e-10))
                var _t = clamp((_ampDb - _threshDb) / _dbRange, 0, 1)
                cx = ((c.pan + 1) / 2) * w
                cy = _t * h
            } else {
                // Circular mode: adaptive squircle — n=2 (circle) at center, n→∞ (rectangle) at edge
                // c.x = pan (–1..+1), c.y = consonance (+1=consonant/top, –1=dissonant/bottom)
                var rComp = Math.sqrt(c.x * c.x + c.y * c.y)
                var ang = Math.atan2(c.x, c.y)   // atan2(x,y): consonant(y=+1)→top, rightPan(x=+1)→right
                var hw = w * 0.5, hh = h * 0.5
                // r normalised against expected max (pan=1, dissonance=1 → rComp≈√2)
                var rNorm = clamp(rComp / Math.SQRT2, 0, 1)
                // Adaptive exponent: n=2 (circle) at center, n=32 (near-rectangle) at edge
                var sqN = 2 + rNorm * 30
                var sinA = Math.abs(Math.sin(ang)), cosA = Math.abs(Math.cos(ang))
                var rBound = Math.pow(
                    Math.pow(sinA / hw, sqN) + Math.pow(cosA / hh, sqN),
                    -1.0 / sqN
                )
                cx = hw + Math.sin(ang) * rNorm * rBound
                cy = hh - Math.cos(ang) * rNorm * rBound
            }

            if (entropyJitter > 0) {
                cx += (rng() - 0.5) * entropyJitter * 2
                cy += (rng() - 0.5) * entropyJitter * 2
            }

            // (squircle / circular effects applied below for layoutMode === 2 in _renderCircular)

            var inputGain = (params.inputGain != null) ? params.inputGain : 1
            // Perceptual loudness: apply A-weighting so low/high freqs reflect perceived loudness
            var perceptMix = (params.perceptualLoudness != null) ? (params.perceptualLoudness / 100) : 0
            var loudWeight = perceptMix > 0.001 ? lerp(1.0, equalLoudnessWeight(c.freq), perceptMix) : 1.0
            var ampScaled = clamp(c.amplitude * inputGain * loudWeight, 0, 1)
            var magPortion = params.magnitudeSizeRatio / 100
            var ampSizeStr = (params.amplitudeSizeStrength != null) ? params.amplitudeSizeStrength : 4
            var sizeFromAmp = lerp(1, 1 + ampScaled * ampSizeStr, magPortion)
            var brightFromAmp = lerp(1, ampScaled, 1 - magPortion)
            // Logarithmic freq→size with user-controlled exponent (bass=large, treble=small)
            var sizeExp = (params.sizeExponent != null) ? params.sizeExponent : 1.5
            // freqDepthEffect scales how much bass-bigger applies (0 = flat, 100 = full)
            var freqDepth = (params.freqDepthEffect != null) ? params.freqDepthEffect / 100 : 1.0
            var freqSizeFactor = 1.0 + Math.pow(1.0 - freqLogNorm, sizeExp) * freqDepth

            var freqKey = Math.round(c.freq * 10)
            var saliencyBoost = 1
            if (this.componentAges.has(freqKey)) {
                var cAge = time - this.componentAges.get(freqKey).firstSeen
                if (cAge < 0.3) saliencyBoost = lerp(1 + params.saliencyWeight / 100, 1, cAge / 0.3)
                this.componentAges.get(freqKey).lastSeen = time
            } else {
                this.componentAges.set(freqKey, { firstSeen: time, lastSeen: time })
                saliencyBoost = 1 + params.saliencyWeight / 100
                cAge = 0
            }

            var ageInfo = this.componentAges.get(freqKey)
            var compAge = ageInfo ? time - ageInfo.firstSeen : 0
            var zScale = lerp(1, Math.max(0.2, 1 - compAge * 0.3), params.zDepth / 100)

            // defaultParticleSize is diameter in px; base radius = half that.
            // c.size is NOT used here — the backend bakes amplitude into it independently,
            // which would double-apply amplitude. All size variation is UI-controlled below.
            var defaultPx = (params.defaultParticleSize != null) ? params.defaultParticleSize : 4
            var baseRadius = (defaultPx / 2) * sizeFromAmp * freqSizeFactor * saliencyBoost * zScale

            if (c.freq < 250 && params.depthDisplacement > 0.01) {
                baseRadius *= lerp(1, 1.5, (params.depthDisplacement / 100) * clamp(bassEnergy, 0, 1))
            }
            baseRadius = clamp(baseRadius, defaultPx / 2, h * 0.4)  // min radius = half default diameter

            var alpha = c.opacity * brightFromAmp * zScale
            if (compAge < 0.1 && params.attackSensitivity / 100 < 1) {
                alpha *= lerp(params.attackSensitivity / 100, 1, compAge / 0.1)
            }

            var ampDb = 20 * Math.log10(Math.max(ampScaled, 1e-10))
            if (ampDb < params.amplitudeThreshold) continue
            alpha = clamp(alpha, 0, 1)
            if (alpha < 0.002) continue

            var rgb = c.color_rgb || [200, 200, 200]
            var r = rgb[0], g = rgb[1], b = rgb[2]
            // Linear mode: override colour from the 120-entry freqColorTable (note+octave keys)
            if (layoutMode === 0) {
                var _fct = params.freqColorTable
                if (_fct) {
                    var _FCT_NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
                    var _midi = Math.round(69 + 12 * Math.log2(Math.max(c.freq, 1) / 440))
                    var _ni = ((_midi % 12) + 12) % 12
                    var _oct = clamp(Math.floor(_midi / 12) - 1, 0, 9)
                    var _trgb = _fct[_FCT_NOTES[_ni] + _oct]
                    if (_trgb) { r = _trgb[0]; g = _trgb[1]; b = _trgb[2] }
                }
            }
            var lightMul = lerp(1, 0.5 + ampScaled * 0.5, params.brightnessScaling / 100)
            var satFloor = params.saturationFloor / 100
            var dissonance = clamp((c.ratio_d - 1) / 31, 0, 1)
            var satMul = lerp(1, 1 - (params.dissonanceDesat / 100) * 0.8, dissonance)

            var rn = r / 255, gn = g / 255, bn = b / 255
            var cmax = Math.max(rn, gn, bn)
            var cmin = Math.min(rn, gn, bn)
            var delta = cmax - cmin
            // Derive hue from the (possibly table-overridden) r/g/b so it always matches the painted colour
            var hue
            if (delta < 0.001) {
                hue = c.hue  // achromatic — keep original
            } else if (cmax === rn) {
                hue = (60 * ((gn - bn) / delta) % 360 + 360) % 360
            } else if (cmax === gn) {
                hue = (60 * ((bn - rn) / delta + 2) + 360) % 360
            } else {
                hue = (60 * ((rn - gn) / delta + 4) + 360) % 360
            }
            var sat = delta === 0 ? 0 : delta / (1 - Math.abs(cmax + cmin - 1))
            var lit = (cmax + cmin) / 2
            sat = Math.max(sat * satMul, satFloor)
            lit *= lightMul

            var clarityVal = (c.clarity != null) ? c.clarity : 1
            var blur = lerp(0, (1 - clarityVal) * 8, params.harmonicClarity / 100)
            var frictionWeight = params.acousticFriction / 100
            var vertices = Math.round(lerp(3, params.shapeComplexity, lerp(1, clarityVal, frictionWeight * 0.5)))
            var edgeSoftness = params.edgeSoftness / 100
            var roughness = (params.harmonicRoughness / 100) * dissonance

            ctx.save()
            if (blur > 0.5) ctx.filter = "blur(" + blur.toFixed(1) + "px)"

            var color = hsla(hue, clamp(sat, 0, 1), clamp(lit, 0.05, 0.95), alpha)

            cx += (rng() - 0.5) * dissonance * (params.fieldRendering / 100) * 20
            cy += (rng() - 0.5) * dissonance * (params.fieldRendering / 100) * 20

            if (params.sourceSeparation > 0.01) {
                baseRadius *= lerp(1, 0.5 + clarityVal * 0.5, params.sourceSeparation / 100)
            }
            // (inter-instrumental pull handled inside _renderCircular for mode 2)

            // ── Node-graph evaluation (modifier layer) ────────────────────────
            if (this._graphEval && this._graphEval.hasGraph) {
                var _fNorm = clamp(freqLogNorm, 0, 1)
                var _pd = { amplitude: ampScaled, freqNorm: _fNorm, pan: c.pan, age: compAge, clarity: clarityVal, dissonance: dissonance, timbre: c.timbre ?? clarityVal, percussive: c.percussive ?? 0 }
                var _fd = { rms: rmsNorm, bpm: bpm, bassEnergy: bassEnergy, components: sortedComps }
                var _mods = this._graphEval.evaluate(_pd, _fd)
                var _applyMod = function (v, m, lo, hi) {
                    if (!m) return v
                    if (m.mode === 'multiply') return clamp(v * m.value, lo, hi)
                    if (m.mode === 'add') return clamp(v + m.value, lo, hi)
                    if (m.mode === 'set') return clamp(m.value, lo, hi)
                    return v
                }
                if (_mods.radius_mult) baseRadius = clamp(baseRadius * _mods.radius_mult.value, 0.5, h * 0.4)
                if (_mods.hue_add) hue = ((hue + _mods.hue_add.value * 360) + 720) % 360
                if (_mods.saturation) sat = _applyMod(sat, _mods.saturation, 0, 1)
                if (_mods.lightness) lit = _applyMod(lit, _mods.lightness, 0.05, 0.95)
                if (_mods.alpha_mult) alpha = clamp(alpha * _mods.alpha_mult.value, 0, 1)
                if (_mods.cx_offset) cx += _mods.cx_offset.value * w * 0.5
                if (_mods.cy_offset) cy += _mods.cy_offset.value * h * 0.5
                // Color override: replace hue/sat/lit with the chosen color (last active rule wins)
                if (_mods.color_override && _mods.color_override.colorHex) {
                    var _hex = _mods.color_override.colorHex
                    var _or = parseInt(_hex.slice(1, 3), 16)
                    var _og = parseInt(_hex.slice(3, 5), 16)
                    var _ob = parseInt(_hex.slice(5, 7), 16)
                    var _rno = _or / 255, _gno = _og / 255, _bno = _ob / 255
                    var _cmx = Math.max(_rno, _gno, _bno), _cmn = Math.min(_rno, _gno, _bno)
                    var _dlt = _cmx - _cmn
                    var _oHue = 0
                    if (_dlt > 0.001) {
                        if (_cmx === _rno) _oHue = (60 * ((_gno - _bno) / _dlt) % 360 + 360) % 360
                        else if (_cmx === _gno) _oHue = (60 * ((_bno - _rno) / _dlt + 2) + 360) % 360
                        else _oHue = (60 * ((_rno - _gno) / _dlt + 4) + 360) % 360
                    }
                    var _oSat = _dlt === 0 ? 0 : _dlt / (1 - Math.abs(_cmx + _cmn - 1))
                    var _oLit = (_cmx + _cmn) / 2
                    var _str = clamp(_mods.color_override.value, 0, 1)
                    hue = lerp(hue, _oHue, _str)
                    sat = lerp(sat, clamp(_oSat, 0, 1), _str)
                    lit = lerp(lit, clamp(_oLit, 0.05, 0.95), _str)
                }
                // Recompute color with potentially-updated hue / sat / lit / alpha
                color = hsla(hue, clamp(sat, 0, 1), clamp(lit, 0.05, 0.95), alpha)
            }

            this._drawShape(ctx, cx, cy, baseRadius, vertices, edgeSoftness, roughness, color, rng)
            ctx.filter = "none"
            ctx.restore()

            accCtx.save()
            accCtx.globalCompositeOperation = blendMode
            this._drawShape(accCtx, cx, cy, baseRadius * 0.8, vertices, edgeSoftness, roughness,
                hsla(hue, clamp(sat, 0, 1), clamp(lit, 0.05, 0.95), alpha * 0.4), rng)
            accCtx.restore()
        }

        ctx.globalCompositeOperation = "source-over"
        ctx.restore()

        var releaseTime = (params.releaseDecay != null) ? params.releaseDecay : 2
        var me = this
        this.componentAges.forEach(function (info, key) {
            if (time - info.lastSeen > releaseTime * 2) me.componentAges.delete(key)
        })
    }

    // ── Shared: compute Circular-layout canvas position for a component ──────
    _circularPos(c, w, h) {
        var hw = w * 0.5, hh = h * 0.5
        var rComp = Math.sqrt(c.x * c.x + c.y * c.y)
        var ang = Math.atan2(c.x, c.y)
        var rNorm = clamp(rComp / Math.SQRT2, 0, 1)
        var sqN = 2 + rNorm * 30
        var sinA = Math.abs(Math.sin(ang)), cosA = Math.abs(Math.cos(ang))
        // Guard against division-by-zero when sinA≈0 or cosA≈0
        var termS = sinA > 1e-6 ? Math.pow(sinA / hw, sqN) : 0
        var termC = cosA > 1e-6 ? Math.pow(cosA / hh, sqN) : 0
        var rBound = (termS + termC) > 1e-30 ? Math.pow(termS + termC, -1.0 / sqN) : Math.min(hw, hh)
        return [
            hw + Math.sin(ang) * rNorm * rBound,
            hh - Math.cos(ang) * rNorm * rBound
        ]
    }

    // ── Mode 2: Circular — full-range log-spiral (all octaves) ──────────────
    _renderCircular(ctx, w, h, components, frame, params, blendMode, persistMode, isLightBg, time) {
        if (!components.length) return
        var rmsDb = (frame.rms_db != null) ? frame.rms_db : -60
        var rmsNorm = clamp((rmsDb + 60) / 60, 0, 1)
        var bpm = (frame.bpm != null) ? frame.bpm : 120
        var kineticMul = lerp(1, clamp(bpm / 120, 0.5, 3), params.kineticPendulum / 100)
        var entropyJitter = (params.entropy / 100) * clamp(new Set(components.map(function (c) { return c.note })).size / 12, 0, 1) * 6
        var bassComps = components.filter(function (c) { return c.freq < 250 })
        var bassEnergy = bassComps.reduce(function (s, c) { return s + c.amplitude }, 0)
        var inputGain = (params.inputGain != null) ? params.inputGain : 1
        var uniqueNotes = new Set(components.map(function (c) { return c.note })).size
        entropyJitter = (params.entropy / 100) * clamp(uniqueNotes / 12, 0, 1) * 6

        var hw = w * 0.5, hh = h * 0.5
        var radiusScale = (params.circRadiusScale != null) ? params.circRadiusScale : 1
        // Maximum ring radius: 45% of the shorter canvas side
        var maxR = Math.min(hw, hh) * 0.9 * radiusScale
        var minR = maxR * 0.08   // inner dead zone

        if (persistMode === 0) {
            ctx.fillStyle = isLightBg ? "rgba(245,242,235,0.05)" : "rgba(10,10,15,0.05)"
            ctx.fillRect(0, 0, w, h)
        }

        ctx.globalCompositeOperation = blendMode
        var rng = seededRandom((frame.frame_index || 0) * 1337)
        var sortedComps = components.slice().sort(function (a, b) { return a.freq - b.freq })
        var activeCount = Math.min(sortedComps.length, Math.ceil(sortedComps.length * kineticMul))

        var gravStr = (params.circChromaticGrav != null) ? params.circChromaticGrav / 100 : 0
        var magStr = (params.circMagOrientation != null) ? params.circMagOrientation / 100 : 0
        var intrStr = (params.circInterInstr != null) ? params.circInterInstr / 100 : 0
        var useLinBand = (params.circFreqMapping != null) ? params.circFreqMapping : 0
        // Total audible range 16 Hz–16 kHz → log2(1000) octaves
        var LOG_RANGE = Math.log2(16000 / 16)

        for (var i = 0; i < activeCount; i++) {
            var c = sortedComps[i]
            if (!c) continue

            // Angle: 0 = top (12-o'clock), clockwise positive
            var angle
            if (useLinBand) {
                // Linear Hz mapping: 0 Hz → 0, 20kHz → 2π
                angle = (c.freq / 20000) * Math.PI * 2 - Math.PI * 0.5
            } else {
                // Log-spiral: each octave gets equal arc, all octaves around the circle
                angle = (Math.log2(Math.max(c.freq, 16) / 16) / LOG_RANGE) * Math.PI * 2 - Math.PI * 0.5
            }

            // Amplitude drives radial position (louder → further from centre)
            var ampScaled = clamp(c.amplitude * inputGain, 0, 1)
            var freqLogNorm = clamp(Math.log2(Math.max(c.freq, 16) / 16) / Math.log2(1000), 0, 1)
            var sizeExp = (params.sizeExponent != null) ? params.sizeExponent : 1.5
            var freqDepth = (params.freqDepthEffect != null) ? params.freqDepthEffect / 100 : 1.0
            var ampSizeStr = (params.amplitudeSizeStrength != null) ? params.amplitudeSizeStrength : 4
            var magPortion = params.magnitudeSizeRatio / 100
            var sizeFromAmp = lerp(1, 1 + ampScaled * ampSizeStr, magPortion)
            var freqSizeFactor = 1.0 + Math.pow(1.0 - freqLogNorm, sizeExp) * freqDepth
            var brightFromAmp = lerp(1, ampScaled, 1 - magPortion)

            // Radial distance driven by frequency: low freq → inside, high freq → outside.
            // Amplitude affects size/opacity (via sizeFromAmp & brightFromAmp) not radius.
            var rDist = lerp(minR, maxR, freqLogNorm)

            var cx = hw + Math.cos(angle) * rDist
            var cy = hh + Math.sin(angle) * rDist

            // Entropy jitter
            if (entropyJitter > 0) {
                cx += (rng() - 0.5) * entropyJitter * 2
                cy += (rng() - 0.5) * entropyJitter * 2
            }

            // Chromatic gravity: pull toward centre
            if (gravStr > 0.01) {
                cx = lerp(cx, hw, gravStr * 0.3)
                cy = lerp(cy, hh, gravStr * 0.3)
            }
            // Magnetic orientation: rotate toward tonic (0° = top)
            if (magStr > 0.01) {
                var mdx = cx - hw, mdy = cy - hh
                var mang = Math.atan2(mdy, mdx)
                var mdist = Math.hypot(mdx, mdy)
                var mbl = lerp(mang, -Math.PI * 0.5, magStr * 0.25)
                cx = hw + Math.cos(mbl) * mdist
                cy = hh + Math.sin(mbl) * mdist
            }
            // Inter-instrumental: dissonant components pulled toward centre
            if (intrStr > 0.01) {
                var dissonance = clamp((c.ratio_d - 1) / 31, 0, 1)
                cx = lerp(cx, hw, intrStr * dissonance * 0.2)
                cy = lerp(cy, hh, intrStr * dissonance * 0.2)
            }

            var dissonance2 = clamp((c.ratio_d - 1) / 31, 0, 1)
            var alpha = c.opacity * brightFromAmp
            var ampDb = 20 * Math.log10(Math.max(ampScaled, 1e-10))
            if (ampDb < params.amplitudeThreshold) continue
            alpha = clamp(alpha, 0, 1)
            if (alpha < 0.002) continue

            var rgb = c.color_rgb || [200, 200, 200]
            var r = rgb[0], g = rgb[1], bv = rgb[2]
            var rn = r / 255, gn = g / 255, bn = bv / 255
            var cmax = Math.max(rn, gn, bn), cmin = Math.min(rn, gn, bn), delta = cmax - cmin
            var hue
            if (delta < 0.001) { hue = c.hue }
            else if (cmax === rn) { hue = (60 * ((gn - bn) / delta) % 360 + 360) % 360 }
            else if (cmax === gn) { hue = (60 * ((bn - rn) / delta + 2) + 360) % 360 }
            else { hue = (60 * ((rn - gn) / delta + 4) + 360) % 360 }
            var sat = delta === 0 ? 0 : delta / (1 - Math.abs(cmax + cmin - 1))
            var lit = (cmax + cmin) / 2
            var satMul = lerp(1, 1 - (params.dissonanceDesat / 100) * 0.8, dissonance2)
            var lightMul = lerp(1, 0.5 + ampScaled * 0.5, params.brightnessScaling / 100)
            sat = Math.max(sat * satMul, params.saturationFloor / 100)
            lit *= lightMul

            var clarityVal = (c.clarity != null) ? c.clarity : 1
            var vertices = Math.round(lerp(3, params.shapeComplexity, lerp(1, clarityVal, (params.acousticFriction / 100) * 0.5)))
            var edgeSoftness = params.edgeSoftness / 100
            var roughness = (params.harmonicRoughness / 100) * dissonance2
            var defaultPx = (params.defaultParticleSize != null) ? params.defaultParticleSize : 4
            var baseRadius = (defaultPx / 2) * sizeFromAmp * freqSizeFactor

            cx += (rng() - 0.5) * dissonance2 * (params.fieldRendering / 100) * 20
            cy += (rng() - 0.5) * dissonance2 * (params.fieldRendering / 100) * 20

            // ── Node-graph / custom-mapping evaluation ──────────────────────
            var color = hsla(hue, clamp(sat, 0, 1), clamp(lit, 0.05, 0.95), alpha)
            if (this._graphEval && this._graphEval.hasGraph) {
                var _fNorm2 = clamp(Math.log2(Math.max(c.freq, 16) / 16) / Math.log2(1000), 0, 1)
                var _pd2 = { amplitude: ampScaled, freqNorm: _fNorm2, pan: c.pan ?? 0, age: 0, clarity: clarityVal, dissonance: dissonance2, timbre: c.timbre ?? clarityVal, percussive: c.percussive ?? 0 }
                var _fd2 = { rms: rmsNorm, bpm: bpm, bassEnergy: bassEnergy, components: sortedComps }
                var _mods2 = this._graphEval.evaluate(_pd2, _fd2)
                if (_mods2.radius_mult) baseRadius = clamp(baseRadius * _mods2.radius_mult.value, 0.5, Math.min(hw, hh) * 0.3)
                if (_mods2.hue_add) hue = ((hue + _mods2.hue_add.value * 360) + 720) % 360
                if (_mods2.saturation) sat = clamp(_mods2.saturation.mode === 'set' ? _mods2.saturation.value : sat * _mods2.saturation.value, 0, 1)
                if (_mods2.lightness) lit = clamp(_mods2.lightness.mode === 'set' ? _mods2.lightness.value : lit * _mods2.lightness.value, 0.05, 0.95)
                if (_mods2.alpha_mult) alpha = clamp(alpha * _mods2.alpha_mult.value, 0, 1)
                if (_mods2.color_override && _mods2.color_override.colorHex) {
                    var _hex2 = _mods2.color_override.colorHex
                    var _or2 = parseInt(_hex2.slice(1, 3), 16)
                    var _og2 = parseInt(_hex2.slice(3, 5), 16)
                    var _ob2 = parseInt(_hex2.slice(5, 7), 16)
                    var _rno2 = _or2 / 255, _gno2 = _og2 / 255, _bno2 = _ob2 / 255
                    var _cmx2 = Math.max(_rno2, _gno2, _bno2), _cmn2 = Math.min(_rno2, _gno2, _bno2), _dlt2 = _cmx2 - _cmn2
                    var _oHue2 = 0
                    if (_dlt2 > 0.001) {
                        if (_cmx2 === _rno2) _oHue2 = (60 * ((_gno2 - _bno2) / _dlt2) % 360 + 360) % 360
                        else if (_cmx2 === _gno2) _oHue2 = (60 * ((_bno2 - _rno2) / _dlt2 + 2) + 360) % 360
                        else _oHue2 = (60 * ((_rno2 - _gno2) / _dlt2 + 4) + 360) % 360
                    }
                    var _oSat2 = _dlt2 === 0 ? 0 : _dlt2 / (1 - Math.abs(_cmx2 + _cmn2 - 1))
                    var _oLit2 = (_cmx2 + _cmn2) / 2
                    var _str2 = clamp(_mods2.color_override.value, 0, 1)
                    hue = lerp(hue, _oHue2, _str2)
                    sat = lerp(sat, clamp(_oSat2, 0, 1), _str2)
                    lit = lerp(lit, clamp(_oLit2, 0.05, 0.95), _str2)
                }
                color = hsla(hue, clamp(sat, 0, 1), clamp(lit, 0.05, 0.95), alpha)
            }
            ctx.save()
            this._drawShape(ctx, cx, cy, baseRadius, vertices, edgeSoftness, roughness, color, rng)
            ctx.restore()
        }
    }

    // ── Mode 4 (L-System 2D): Interval Branching ─────────────────────────────
    // (Previously mode 4, now mode 1 in the new layout numbering)
    // ── Mode 5: Vector Interval Model (Relative Pathfinding) ─────────────────
    _renderVectorInterval(ctx, w, h, components, frame, params, blendMode, persistMode, isLightBg, time) {
        if (!components.length) return

        if (!this.vectorState) {
            this.vectorState = {
                voices: {},    // key → { x, y, heading, lastFreq, rgb, lastSeen }
                lastTime: time,
            }
        }
        var st = this.vectorState
        var dt = Math.min(Math.max(time - st.lastTime, 0), 0.1)
        st.lastTime = time

        // Pixels-per-second base speed (scales with canvas shortest axis)
        var BASE_SPEED = Math.min(w, h) * 0.22
        // Heading change per semitone (radians) — 15° as spec'd
        var RAD_PER_SEMI = 15 * (Math.PI / 180)

        ctx.globalCompositeOperation = blendMode
        ctx.lineCap = 'round'
        ctx.lineJoin = 'round'

        var nowKeys = new Set()
        for (var k = 0; k < components.length; k++) {
            var c = components[k]
            var vKey = c.note + '|' + c.instrument
            nowKeys.add(vKey)
            var rgb = c.color_rgb || [200, 200, 200]

            if (!st.voices[vKey]) {
                // New voice — spawn at centre, heading straight up (canvas: angle 0 = right, so -π/2 = up)
                st.voices[vKey] = { x: w * 0.5, y: h * 0.5, heading: -Math.PI / 2, lastFreq: c.freq, rgb: rgb, lastSeen: time }
            }
            var v = st.voices[vKey]
            v.lastSeen = time
            v.rgb = rgb

            var prevX = v.x, prevY = v.y

            if (dt > 0) {
                // Heading adjustment from interval
                var semis = Math.round(12 * Math.log2(Math.max(c.freq, 1) / Math.max(v.lastFreq, 1)))
                v.heading += semis * RAD_PER_SEMI
                v.lastFreq = c.freq

                // Timbre friction: pure/harmonic tones keep moving; noisy/staccato fade sooner
                var clarityVal = (c.clarity != null) ? c.clarity : 1.0
                // Speed = amplitude × clarity (stiff) × base speed
                var speed = c.amplitude * clamp(clarityVal, 0.15, 1.0) * BASE_SPEED
                // Vibrato: rapid micro-oscillations in heading proportional to inharmonicity
                var roughness = clamp(1.0 - clarityVal, 0, 1)
                v.heading += roughness * Math.sin(time * 60 + k * 2.4) * 0.18

                var dist = speed * dt
                v.x += Math.cos(v.heading) * dist
                v.y += Math.sin(v.heading) * dist

                // Soft wrap at canvas edges
                if (v.x < 0) { v.x = w + v.x; }
                if (v.x > w) { v.x = v.x - w; }
                if (v.y < 0) { v.y = h + v.y; }
                if (v.y > h) { v.y = v.y - h; }

                if (dist > 0.5) {
                    var lineW = Math.max(0.8, 1.8 * c.amplitude)
                    ctx.lineWidth = lineW
                    ctx.strokeStyle = 'rgba(' + Math.round(rgb[0]) + ',' + Math.round(rgb[1]) + ',' + Math.round(rgb[2]) + ',' + (0.7 + c.amplitude * 0.3).toFixed(2) + ')'
                    ctx.beginPath()
                    ctx.moveTo(prevX, prevY)
                    ctx.lineTo(v.x, v.y)
                    ctx.stroke()
                }
            }
        }

        // Let voices persist for a beat after their note ends (legato feel)
        var releaseTime = (params.releaseDecay != null) ? params.releaseDecay : 2
        for (var vk in st.voices) {
            if (!nowKeys.has(vk) && (time - st.voices[vk].lastSeen) > releaseTime) {
                delete st.voices[vk]
            }
        }
    }

    // ── Mode 6: Harmonic Gravity Model (Attractors & Repulsors) ────────────
    _renderHarmonicGravity(ctx, w, h, components, frame, params, blendMode, persistMode, isLightBg, time) {
        if (!components.length) return

        if (!this.gravityState) {
            this.gravityState = { particles: {}, lastTime: time }
        }
        var gst = this.gravityState
        var dt = Math.min(Math.max(time - gst.lastTime, 0), 0.08)
        gst.lastTime = time

        // Identify anchors: top 35% by amplitude (at least 1)
        var sorted = components.slice().sort(function (a, b) { return b.amplitude - a.amplitude })
        var anchorCount = Math.max(1, Math.ceil(sorted.length * 0.35))
        var anchors = []
        for (var i = 0; i < anchorCount; i++) {
            var pos = this._circularPos(sorted[i], w, h)
            anchors.push({ x: pos[0], y: pos[1], freq: sorted[i].freq, amplitude: sorted[i].amplitude })
        }

        // Ensure a particle exists for every component
        var nowKeys = new Set()
        for (var k = 0; k < components.length; k++) {
            var c = components[k]
            var pk = Math.round(c.freq * 10).toString()
            nowKeys.add(pk)
            if (!gst.particles[pk]) {
                var p0 = this._circularPos(c, w, h)
                gst.particles[pk] = { x: p0[0], y: p0[1], vx: 0, vy: 0, rgb: c.color_rgb || [200, 200, 200], amplitude: c.amplitude, dissonance: 0 }
            }
            var pt = gst.particles[pk]
            pt.rgb = c.color_rgb || pt.rgb
            pt.amplitude = c.amplitude
            pt.dissonance = clamp((c.ratio_d - 1) / 15, 0, 1)
        }

        ctx.globalCompositeOperation = blendMode
        ctx.lineCap = 'round'

        // Draw gravity wells (anchors)
        for (var ai = 0; ai < anchors.length; ai++) {
            var an = anchors[ai]
            var wellR = 6 + an.amplitude * 12
            var grad = ctx.createRadialGradient(an.x, an.y, 0, an.x, an.y, wellR * 2.5)
            grad.addColorStop(0, 'rgba(255,255,255,0.18)')
            grad.addColorStop(1, 'rgba(255,255,255,0)')
            ctx.fillStyle = grad
            ctx.beginPath()
            ctx.arc(an.x, an.y, wellR * 2.5, 0, Math.PI * 2)
            ctx.fill()
        }

        // Physics + draw satellites
        var GRAV = Math.min(w, h) * 0.18
        var DAMP = 0.88

        for (var pk in gst.particles) {
            if (!nowKeys.has(pk)) continue  // only simulate active notes
            var pt = gst.particles[pk]

            if (dt > 0) {
                var fx = 0, fy = 0
                for (var ai = 0; ai < anchors.length; ai++) {
                    var an = anchors[ai]
                    var dx = an.x - pt.x, dy = an.y - pt.y
                    var dist2 = dx * dx + dy * dy
                    var dist = Math.sqrt(dist2) + 1
                    // High dissonance → repulsion; low dissonance → attraction
                    var sign = pt.dissonance > 0.5 ? -1 : 1
                    var mag = sign * GRAV * an.amplitude / dist
                    fx += mag * dx / dist
                    fy += mag * dy / dist
                }
                pt.vx = (pt.vx + fx * dt) * DAMP
                pt.vy = (pt.vy + fy * dt) * DAMP
                var ox = pt.x, oy = pt.y
                pt.x = clamp(pt.x + pt.vx * dt, 0, w)
                pt.y = clamp(pt.y + pt.vy * dt, 0, h)

                // Draw trail segment
                var spd = Math.hypot(pt.vx, pt.vy)
                if (spd > 0.5) {
                    ctx.lineWidth = Math.max(0.6, 1.5 * pt.amplitude)
                    ctx.strokeStyle = 'rgba(' + Math.round(pt.rgb[0]) + ',' + Math.round(pt.rgb[1]) + ',' + Math.round(pt.rgb[2]) + ',0.8)'
                    ctx.beginPath(); ctx.moveTo(ox, oy); ctx.lineTo(pt.x, pt.y); ctx.stroke()
                }
            }

            // Draw particle dot
            var dotR = 3 + pt.amplitude * 5
            ctx.fillStyle = 'rgba(' + Math.round(pt.rgb[0]) + ',' + Math.round(pt.rgb[1]) + ',' + Math.round(pt.rgb[2]) + ',0.9)'
            ctx.beginPath(); ctx.arc(pt.x, pt.y, dotR, 0, Math.PI * 2); ctx.fill()
        }

        // Prune dead particles
        var releaseTime = (params.releaseDecay != null) ? params.releaseDecay : 2
        for (var pk in gst.particles) {
            if (!nowKeys.has(pk)) delete gst.particles[pk]
        }
    }

    // ── Mode 7: Phase-Space Orbital (Lissajous Modulation) ─────────────────
    _renderPhaseOrbit(ctx, w, h, components, frame, params, blendMode, persistMode, isLightBg, time) {
        if (!components.length) return

        var N = 512
        var TWO_PI = 2 * Math.PI
        ctx.globalCompositeOperation = blendMode
        ctx.lineCap = 'round'

        // Default particle size controls orbit radius scaling
        var orbitScale = ((params.defaultParticleSize || 2) / 2) * Math.min(w, h) * 0.08

        for (var k = 0; k < components.length; k++) {
            var c = components[k]
            var pos = this._circularPos(c, w, h)
            var baseCX = pos[0], baseCY = pos[1]

            // Find harmonic neighbours (within 1 octave) to create phase complexity
            var neighbours = [c]
            for (var j = 0; j < components.length; j++) {
                if (j === k) continue
                var ratio = components[j].freq / c.freq
                if (ratio >= 0.5 && ratio <= 2.5) neighbours.push(components[j])
            }

            // Window = 2 full cycles of this component's frequency
            var tWindow = Math.max(2.0 / c.freq, 0.005)
            var dt = tWindow / N

            var rgb = c.color_rgb || [200, 200, 200]
            ctx.strokeStyle = 'rgba(' + Math.round(rgb[0]) + ',' + Math.round(rgb[1]) + ',' + Math.round(rgb[2]) + ',' + (0.55 + c.amplitude * 0.35).toFixed(2) + ')'
            ctx.lineWidth = Math.max(0.6, 1.2 * c.amplitude)

            ctx.beginPath()
            var first = true
            for (var n = 0; n < N; n++) {
                var t = time + n * dt
                var xl = 0, xr = 0
                for (var ni = 0; ni < neighbours.length; ni++) {
                    var nb = neighbours[ni]
                    var sig = nb.amplitude * Math.sin(TWO_PI * nb.freq * t + (nb.phase || 0))
                    var pan = nb.pan || 0
                    xl += sig * (1.0 - Math.max(pan, 0))
                    xr += sig * (1.0 + Math.min(pan, 0))
                }
                // Pure mono/perfect-phase → nearly static; stereo + overtones → orbit
                var px = baseCX + xl * orbitScale
                var py = baseCY + xr * orbitScale
                if (first) { ctx.moveTo(px, py); first = false } else ctx.lineTo(px, py)
            }
            ctx.stroke()

            // Anchor dot at base position
            var dotR = 2 + c.amplitude * 4
            ctx.fillStyle = 'rgba(' + Math.round(rgb[0]) + ',' + Math.round(rgb[1]) + ',' + Math.round(rgb[2]) + ',0.9)'
            ctx.beginPath(); ctx.arc(baseCX, baseCY, dotR, 0, TWO_PI); ctx.fill()
        }
    }

    // ── Mode 2: Chladni Nodal Topography ─────────────────────────────────
    _renderChladni(ctx, w, h, components, params, blendMode, persistMode, isLightBg) {
        if (!components.length) return
        var GW = 96, GH = 72
        var grid = new Float32Array(GW * GH)

        // Evaluate the summed Chladni wave field
        for (var j = 0; j < GH; j++) {
            for (var i = 0; i < GW; i++) {
                var xf = i / (GW - 1)
                var yf = j / (GH - 1)
                var z = 0
                for (var k = 0; k < components.length; k++) {
                    var c = components[k]
                    var n = Math.max(1, Math.min(c.ratio_n || 1, 18))
                    var m = Math.max(1, Math.min(c.ratio_d || 1, 18))
                    z += c.amplitude * Math.sin(n * Math.PI * xf) * Math.sin(m * Math.PI * yf)
                }
                grid[j * GW + i] = z
            }
        }

        var segs = this._marchSegments(grid, GW, GH)
        if (!segs.length) return

        // Amplitude-weighted composite colour
        var tr = 0, tg = 0, tb = 0, tw = 0
        for (var k = 0; k < components.length; k++) {
            var c = components[k]
            var wt = c.amplitude
            tr += (c.color_rgb[0] || 200) * wt
            tg += (c.color_rgb[1] || 200) * wt
            tb += (c.color_rgb[2] || 200) * wt
            tw += wt
        }
        if (tw < 0.001) return
        var cr = tr / tw, cg = tg / tw, cb = tb / tw

        ctx.globalCompositeOperation = blendMode
        ctx.strokeStyle = 'rgba(' + Math.round(cr) + ',' + Math.round(cg) + ',' + Math.round(cb) + ',0.88)'
        ctx.lineWidth = 1.3
        ctx.lineCap = 'round'
        for (var s = 0; s < segs.length; s += 4) {
            ctx.beginPath()
            ctx.moveTo(segs[s] * w, segs[s + 1] * h)
            ctx.lineTo(segs[s + 2] * w, segs[s + 3] * h)
            ctx.stroke()
        }
    }

    // Marching-squares zero-contour extractor
    _marchSegments(grid, gw, gh) {
        function interp(va, vb) {
            var d = va - vb
            if (Math.abs(d) < 1e-10) return 0.5
            var t = va / d
            return t < 0 ? 0 : t > 1 ? 1 : t
        }
        var segs = []
        for (var j = 0; j < gh - 1; j++) {
            for (var i = 0; i < gw - 1; i++) {
                var vTL = grid[j * gw + i]
                var vTR = grid[j * gw + i + 1]
                var vBR = grid[(j + 1) * gw + i + 1]
                var vBL = grid[(j + 1) * gw + i]
                var eT = (vTL > 0) !== (vTR > 0)
                var eR = (vTR > 0) !== (vBR > 0)
                var eB = (vBL > 0) !== (vBR > 0)
                var eL = (vTL > 0) !== (vBL > 0)
                var pts = []
                if (eT) pts.push([(i + interp(vTL, vTR)) / (gw - 1), j / (gh - 1)])
                if (eR) pts.push([(i + 1) / (gw - 1), (j + interp(vTR, vBR)) / (gh - 1)])
                if (eB) pts.push([(i + interp(vBL, vBR)) / (gw - 1), (j + 1) / (gh - 1)])
                if (eL) pts.push([i / (gw - 1), (j + interp(vTL, vBL)) / (gh - 1)])
                if (pts.length === 2) {
                    segs.push(pts[0][0], pts[0][1], pts[1][0], pts[1][1])
                } else if (pts.length === 4) {
                    var cval = (vTL + vTR + vBR + vBL) * 0.25
                    if (cval > 0) {
                        segs.push(pts[0][0], pts[0][1], pts[3][0], pts[3][1])
                        segs.push(pts[1][0], pts[1][1], pts[2][0], pts[2][1])
                    } else {
                        segs.push(pts[0][0], pts[0][1], pts[1][0], pts[1][1])
                        segs.push(pts[2][0], pts[2][1], pts[3][0], pts[3][1])
                    }
                }
            }
        }
        return segs
    }

    // ── Mode 3: Oscilloscope Ribbon (Lissajous / spirograph) ─────────────
    _renderOscilloscope(ctx, w, h, components, frame, params, blendMode, persistMode, isLightBg) {
        if (!components.length) return
        var N = 1536
        var frameTime = frame.time_seconds || 0
        var TWO_PI = 2 * Math.PI

        // Show 2 full cycles of the lowest-frequency component (min 15ms)
        var lowestFreq = Infinity
        for (var k = 0; k < components.length; k++) {
            if (components[k].freq < lowestFreq) lowestFreq = components[k].freq
        }
        if (!isFinite(lowestFreq) || lowestFreq < 1) lowestFreq = 80
        var tWindow = Math.max(2.0 / lowestFreq, 0.015)
        var dt = tWindow / N

        // Amplitude-weighted colour
        var tr = 0, tg = 0, tb = 0, tw = 0
        for (var k = 0; k < components.length; k++) {
            var c = components[k]; var wt = c.amplitude
            tr += (c.color_rgb[0] || 200) * wt
            tg += (c.color_rgb[1] || 200) * wt
            tb += (c.color_rgb[2] || 200) * wt
            tw += wt
        }
        if (tw < 0.001) return
        var cr = tr / tw, cg = tg / tw, cb = tb / tw

        // Normalise: divide by total amplitude so curve fits in [-1,1]
        var normFactor = tw > 0 ? 1.0 / tw : 1.0
        var xScale = w * 0.46, yScale = h * 0.46
        var cx = w * 0.5, cy = h * 0.5

        ctx.globalCompositeOperation = blendMode
        ctx.strokeStyle = 'rgba(' + Math.round(cr) + ',' + Math.round(cg) + ',' + Math.round(cb) + ',0.82)'
        ctx.lineWidth = 1.5
        ctx.lineCap = 'round'
        ctx.lineJoin = 'round'
        ctx.beginPath()

        var first = true
        for (var n = 0; n < N; n++) {
            var t = frameTime + n * dt
            var xl = 0, xr = 0
            for (var k = 0; k < components.length; k++) {
                var c = components[k]
                var sig = c.amplitude * Math.sin(TWO_PI * c.freq * t + (c.phase || 0))
                var pan = c.pan || 0
                xl += sig * (1.0 - Math.max(pan, 0))
                xr += sig * (1.0 + Math.min(pan, 0))
            }
            var px = cx + xl * normFactor * xScale
            var py = cy + xr * normFactor * yScale
            if (first) { ctx.moveTo(px, py); first = false } else ctx.lineTo(px, py)
        }
        ctx.stroke()
    }

    // ── Mode 4: Interval Branching (L-System Fractals) ────────────────────
    _renderLSystem(ctx, w, h, components, frame, params, blendMode, persistMode, isLightBg, time) {
        var TWO_PI = 2 * Math.PI
        // One-time init
        if (!this.lState) {
            this.lState = {
                branches: [],
                prevNotes: {},   // note -> { branchId, freq }
                lastTime: time,
                nextId: 0,
                viewOffsetX: 0,  // viewport pan: world→screen translation
                viewOffsetY: 0,
            }
        }
        var state = this.lState
        var dt = Math.min(Math.max(time - state.lastTime, 0), 0.1)
        state.lastTime = time

        // Speed proportional to canvas size, scaled by lsGrowthSpeed param
        var lsSpeed = (params.lsGrowthSpeed != null) ? params.lsGrowthSpeed : 0.09
        var SPEED = Math.min(w, h) * lsSpeed

        // Interval semitones → divergence angle — respects lsAngleSpread param
        var lsAngleBase = (params.lsAngleSpread != null) ? params.lsAngleSpread : 18
        var ANGLE_TABLE = [0, lsAngleBase, lsAngleBase * 1.78, lsAngleBase * 2.67, lsAngleBase * 3.44, lsAngleBase * 4.11, lsAngleBase * 4.89, lsAngleBase * 4.56, lsAngleBase * 3.78, lsAngleBase * 2.89, lsAngleBase * 2.0, lsAngleBase * 1.11]

        // Build current-frame note map (loudest component per note)
        var curNotes = {}
        for (var k = 0; k < components.length; k++) {
            var c = components[k]
            if (!curNotes[c.note] || c.amplitude > curNotes[c.note].amplitude) curNotes[c.note] = c
        }

        // Spawn new branches for new notes
        for (var note in curNotes) {
            if (state.prevNotes[note]) continue  // already active
            var comp = curNotes[note]
            var rgb = comp.color_rgb || [200, 200, 200]

            // Find parent: alive branch with closest frequency
            var parentBranch = null, bestDiff = Infinity
            for (var b = 0; b < state.branches.length; b++) {
                var br = state.branches[b]
                if (!br.alive) continue
                var fd = Math.abs(br.freq - comp.freq)
                if (fd < bestDiff) { bestDiff = fd; parentBranch = br }
            }

            var startX, startY, baseAngle
            if (!parentBranch) {
                // Root: bottom centre, growing upward — angle=0 means straight up
                startX = w * 0.5; startY = h * 0.88; baseAngle = 0
            } else {
                startX = parentBranch.tipX; startY = parentBranch.tipY
                baseAngle = parentBranch.angle
            }

            // Interval-derived angle offset
            var semitones = parentBranch
                ? Math.round(12 * Math.log2(Math.max(comp.freq, 1) / Math.max(parentBranch.freq, 1)))
                : 0
            var absInt = Math.abs(semitones) % 13
            var offsetDeg = ANGLE_TABLE[Math.min(absInt, 11)]
            var sign = semitones >= 0 ? 1 : -1
            var angleOffset = sign * offsetDeg * (Math.PI / 180)

            var newBranch = {
                id: state.nextId++,
                tipX: startX, tipY: startY,
                angle: baseAngle + angleOffset,
                freq: comp.freq,
                note: note,
                color: rgb,
                alive: true,
                speed: SPEED * (0.4 + comp.amplitude * 0.8),
                generation: parentBranch ? parentBranch.generation + 1 : 0,
                segments: [],
            }
            state.branches.push(newBranch)
            state.prevNotes[note] = { branchId: newBranch.id, freq: comp.freq }
        }

        // Mark ended notes dead
        for (var note in state.prevNotes) {
            if (!curNotes[note]) {
                var pn = state.prevNotes[note]
                for (var b = 0; b < state.branches.length; b++) {
                    if (state.branches[b].id === pn.branchId) { state.branches[b].alive = false; break }
                }
                delete state.prevNotes[note]
            }
        }

        // Grow alive branches
        var newSegs = []
        if (dt > 0) {
            for (var b = 0; b < state.branches.length; b++) {
                var br = state.branches[b]
                if (!br.alive) continue
                var dist = br.speed * dt
                // angle=0 → straight up; positive angle = rightward branch
                var nx = br.tipX - Math.sin(br.angle) * (-dist)   // right = -sin (screen X increases right)
                var ny = br.tipY - Math.cos(br.angle) * dist       // up    = -cos (screen Y decreases upward)
                // Endless canvas: no bouncing — branches grow freely in world space
                var seg = { x1: br.tipX, y1: br.tipY, x2: nx, y2: ny, rgb: br.color, gen: br.generation }
                br.segments.push(seg)
                newSegs.push(seg)
                br.tipX = nx; br.tipY = ny
            }
        }

        // Auto-pan viewport: smoothly keep centroid of active branch tips centred on canvas
        // Only in Momentary mode — Painting mode keeps a fixed viewport so accumulated marks don't shift
        var activeBranches = []
        for (var ab = 0; ab < state.branches.length; ab++) { if (state.branches[ab].alive) activeBranches.push(state.branches[ab]) }
        if (persistMode !== 1 && activeBranches.length > 0) {
            var sumTX = 0, sumTY = 0
            for (var ab = 0; ab < activeBranches.length; ab++) { sumTX += activeBranches[ab].tipX; sumTY += activeBranches[ab].tipY }
            var targetVX = w * 0.5 - sumTX / activeBranches.length
            var targetVY = h * 0.62 - sumTY / activeBranches.length  // slightly below centre gives better tree framing
            state.viewOffsetX = lerp(state.viewOffsetX, targetVX, 0.04)
            state.viewOffsetY = lerp(state.viewOffsetY, targetVY, 0.04)
        }

        // Draw
        ctx.save()
        // Momentary: translate to follow active branches; Painting: fixed origin (no shift on permanent marks)
        if (persistMode !== 1) ctx.translate(state.viewOffsetX, state.viewOffsetY)
        ctx.globalCompositeOperation = blendMode
        ctx.lineCap = 'round'
        var lsLW = (params.lsLineWidth != null) ? params.lsLineWidth : 2.2

        if (persistMode === 1) {
            // Painting: only draw the new segments added this frame
            for (var s = 0; s < newSegs.length; s++) {
                var seg = newSegs[s]
                ctx.lineWidth = Math.max(0.5, lsLW - seg.gen * 0.45)
                ctx.strokeStyle = 'rgba(' + Math.round(seg.rgb[0]) + ',' + Math.round(seg.rgb[1]) + ',' + Math.round(seg.rgb[2]) + ',0.9)'
                ctx.beginPath(); ctx.moveTo(seg.x1, seg.y1); ctx.lineTo(seg.x2, seg.y2); ctx.stroke()
            }
        } else {
            // Momentary: redraw all segments of all branches (trail fade handles decay)
            for (var b = 0; b < state.branches.length; b++) {
                var br = state.branches[b]
                if (!br.segments.length) continue
                var alpha = br.alive ? 0.88 : 0.4
                ctx.lineWidth = Math.max(0.5, lsLW - br.generation * 0.45)
                ctx.strokeStyle = 'rgba(' + Math.round(br.color[0]) + ',' + Math.round(br.color[1]) + ',' + Math.round(br.color[2]) + ',' + alpha + ')'
                ctx.beginPath()
                ctx.moveTo(br.segments[0].x1, br.segments[0].y1)
                for (var s = 0; s < br.segments.length; s++) ctx.lineTo(br.segments[s].x2, br.segments[s].y2)
                ctx.stroke()
            }
        }

        ctx.restore()  // end viewport transform

        // Prune memory: dead branches with no segments, or over-cap
        var lsMaxBr = (params.lsMaxBranches != null) ? params.lsMaxBranches : 300
        if (state.branches.length > lsMaxBr) {
            state.branches = state.branches.filter(function (br) { return br.alive || br.segments.length > 0 })
        }
    }

    _drawShape(ctx, cx, cy, radius, vertices, softness, roughness, color, rng) {
        if (radius < 0.5) return
        ctx.beginPath()
        if (vertices >= 32) {
            ctx.arc(cx, cy, radius, 0, Math.PI * 2)
        } else {
            for (var v = 0; v <= vertices; v++) {
                var angle = (v / vertices) * Math.PI * 2 - Math.PI / 2
                var rv = radius
                if (roughness > 0.01) rv += (rng() - 0.5) * radius * roughness * 0.5
                var px = cx + Math.cos(angle) * rv
                var py = cy + Math.sin(angle) * rv
                if (v === 0) ctx.moveTo(px, py)
                else ctx.lineTo(px, py)
            }
            ctx.closePath()
        }
        if (softness > 0.3 && radius > 3) {
            var grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius)
            grad.addColorStop(0, color)
            grad.addColorStop(lerp(0.3, 0.85, softness), color)
            grad.addColorStop(1, color.replace(/[\d.]+\)$/, "0)"))
            ctx.fillStyle = grad
        } else {
            ctx.fillStyle = color
        }
        ctx.fill()
    }

    /**
     * Export the full L-System (all branches, endless world-space) as a PNG
     * cropped to the bounding box of every drawn segment.
     * Returns a data-URL or null if there is nothing to export.
     */
    getLSystemBoundingBoxImage() {
        if (!this.lState || !this.lState.branches.length) return null
        var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
        for (var bi = 0; bi < this.lState.branches.length; bi++) {
            var br = this.lState.branches[bi]
            for (var si = 0; si < br.segments.length; si++) {
                var seg = br.segments[si]
                minX = Math.min(minX, seg.x1, seg.x2)
                minY = Math.min(minY, seg.y1, seg.y2)
                maxX = Math.max(maxX, seg.x1, seg.x2)
                maxY = Math.max(maxY, seg.y1, seg.y2)
            }
        }
        if (!isFinite(minX)) return null
        var pad = 30
        var bw = Math.ceil(maxX - minX + pad * 2)
        var bh = Math.ceil(maxY - minY + pad * 2)
        if (bw < 1 || bh < 1) return null
        var oc = document.createElement('canvas')
        oc.width = bw; oc.height = bh
        var octx = oc.getContext('2d')
        octx.fillStyle = '#000a0f'
        octx.fillRect(0, 0, bw, bh)
        octx.lineCap = 'round'
        octx.translate(pad - minX, pad - minY)
        for (var bi = 0; bi < this.lState.branches.length; bi++) {
            var br = this.lState.branches[bi]
            if (!br.segments.length) continue
            octx.lineWidth = Math.max(0.7, 2.2 - br.generation * 0.45)
            var alpha = br.alive ? 0.9 : 0.5
            octx.strokeStyle = 'rgba(' + Math.round(br.color[0]) + ',' + Math.round(br.color[1]) + ',' + Math.round(br.color[2]) + ',' + alpha + ')'
            octx.beginPath()
            octx.moveTo(br.segments[0].x1, br.segments[0].y1)
            for (var s = 0; s < br.segments.length; s++) octx.lineTo(br.segments[s].x2, br.segments[s].y2)
            octx.stroke()
        }
        return oc.toDataURL('image/png')
    }

    getAccumulatedImage() {
        return this.accumulationCanvas.toDataURL("image/png")
    }

    showAccumulated() {
        this.ctx.globalCompositeOperation = "source-over"
        this.ctx.drawImage(this.accumulationCanvas, 0, 0)
    }
}
