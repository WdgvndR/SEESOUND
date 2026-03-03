/**
 * SEESOUND — Phase 1 Skeleton: Hybrid Architecture Entry Point
 * ═══════════════════════════════════════════════════════════════
 *
 * This file is the new frontend engine. It wires together three systems:
 *
 *   1. THREE.JS RENDERER  — WebGL scene, camera, particles, geometry lines.
 *                           All drawing happens on the GPU at 60 fps.
 *
 *   2. WEB AUDIO API       — Browser-native FFT (AnalyserNode).
 *                           Zero server latency: frequency/pitch/amplitude
 *                           data is extracted locally, every animation frame.
 *
 *   3. WEBSOCKET BRIDGE    — Persistent connection to the Python backend.
 *                           The backend sends structural metadata and rule sets.
 *                           The frontend uses those rules to dictate how the
 *                           Three.js scene reacts to the live audio data.
 *
 * Phase 2 addition: All mathematical logic from the Python back-end
 * (color_engine.py, spatial_mapper.py, visual_mapper.py) is ported into
 * MathEngine.js and consumed here — grayscale luminance matching,
 * note-to-hue assignment, Pythagorean spatial displacement, and more.
 */

import * as THREE from 'three'
import { params, subscribe } from './engine/ParamStore.js'
import { initControlPanel } from './engine/ControlPanel.js'
import {
    // § Color Engine
    ColorEngine,
    freqToNote,
    freqToHue,
    rgbToGrayscale,
    // § Spatial Mapper
    computeSpatial,
    freqRatio,
    polarToCartesian,
    panToAngle,
    // § Visual Mapper
    computeVisual,
    amplitudeToOpacity,
    amplitudeToSize,
    timeDecayFactor,
    ratioToClarity,
    densityToQuantity,
} from './engine/MathEngine.js'

// ─────────────────────────────────────────────────────────────────────────────
// § 1  DOM REFERENCES
// ─────────────────────────────────────────────────────────────────────────────

const canvas = document.getElementById('three-canvas')
const overlayCanvas = document.getElementById('overlay-canvas')
const overlayCtx = overlayCanvas.getContext('2d')
const statusDot = document.getElementById('status-dot')
const statusText = document.getElementById('status-text')
const fileInput = document.getElementById('audio-file-input')
const btnPlayPause = document.getElementById('btn-play-pause')
const audioTimeEl = document.getElementById('audio-time')
const readBass = document.getElementById('read-bass')
const readMid = document.getElementById('read-mid')
const readHigh = document.getElementById('read-high')
const readPeak = document.getElementById('read-peak')

// Spectrum panel elements
const spectrumPanel = document.getElementById('spectrum-panel')
const spectrumToggle = document.getElementById('spectrum-toggle')
const spectrumCanvas = document.getElementById('spectrum-canvas')
const spectrumCtx = spectrumCanvas.getContext('2d')

// Save / Record buttons
const btnSavePng = document.getElementById('btn-save-png')
const btnRecord = document.getElementById('btn-record')


// ─────────────────────────────────────────────────────────────────────────────
// § 2  THREE.JS SCENE — GPU geometry objects
// ─────────────────────────────────────────────────────────────────────────────

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true })
renderer.setPixelRatio(window.devicePixelRatio)
renderer.setSize(window.innerWidth, window.innerHeight)
renderer.setClearColor(0x000000, 1)

const scene = new THREE.Scene()
const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.1, 2000)
camera.position.set(0, 0, 120)

window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight
    camera.updateProjectionMatrix()
    renderer.setSize(window.innerWidth, window.innerHeight)
    _resizeOverlayCanvas()
})

function _resizeOverlayCanvas() {
    const dpr = window.devicePixelRatio || 1
    overlayCanvas.width = Math.round(window.innerWidth * dpr)
    overlayCanvas.height = Math.round(window.innerHeight * dpr)
    overlayCtx.scale(dpr, dpr)
}
_resizeOverlayCanvas()

// ─────────────────────────────────────────────────────────────────────────────
// ── 2a  SPECTRAL PARTICLE SYSTEM
//        One particle per live FFT bin. All visual attributes are GPU-side
//        BufferAttributes (DynamicDrawUsage) — written from JS, rendered on the
//        GPU via a custom ShaderMaterial with per-point size and opacity.
//
//        Per-particle data pipeline each frame:
//          hz          = (bin / binCount) × nyquist
//          position    = computeSpatial(hz, 0, tonicHz, radiusScale)
//                        → harmonic ratio N/D → polar (angle, radius)
//                        → XY in Three.js world; Z from octave depth (params.zDepth)
//          colour      = colorEngine.freqToColor(hz)  (BT.601 luminance-matched)
//          size        = amplitudeToSize(energy, params.amplitudeSizeStrength)
//          alpha       = timeDecayFactor(age_s, params.releaseDecay) × sqrt(energy)
// ─────────────────────────────────────────────────────────────────────────────

const MAX_PARTICLES = 1024  // matches maximal FFT bin count (FFT 2048 → 1024 bins)

// Float32Arrays written every frame, then flagged needsUpdate = true
const _partPos = new Float32Array(MAX_PARTICLES * 3)  // xyz
const _partCol = new Float32Array(MAX_PARTICLES * 3)  // rgb 0–1
const _partSzArr = new Float32Array(MAX_PARTICLES)       // GPU point size (px)
const _partAlphaArr = new Float32Array(MAX_PARTICLES)       // 0–1 opacity

// CPU-only state (not uploaded to GPU)
const _partBirth = new Float64Array(MAX_PARTICLES).fill(-1) // ms since epoch; -1 = dead
const _partPainted = new Uint8Array(MAX_PARTICLES)           // painting mode: 1 = rendered once this activation

const particleGeo = new THREE.BufferGeometry()
const _attrPos = new THREE.BufferAttribute(_partPos, 3)
const _attrCol = new THREE.BufferAttribute(_partCol, 3)
const _attrSz = new THREE.BufferAttribute(_partSzArr, 1)
const _attrAlpha = new THREE.BufferAttribute(_partAlphaArr, 1)

_attrPos.setUsage(THREE.DynamicDrawUsage)
_attrCol.setUsage(THREE.DynamicDrawUsage)
_attrSz.setUsage(THREE.DynamicDrawUsage)
_attrAlpha.setUsage(THREE.DynamicDrawUsage)

particleGeo.setAttribute('position', _attrPos)
particleGeo.setAttribute('vcolor', _attrCol)
particleGeo.setAttribute('psize', _attrSz)
particleGeo.setAttribute('valpha', _attrAlpha)

// ── GLSL vertex shader — perspective-correct per-particle size ───────────────
const _particleVert = /* glsl */`
  attribute vec3  vcolor;
  attribute float psize;
  attribute float valpha;

  varying vec3  vCol;
  varying float vA;

  void main() {
    vCol = vcolor;
    vA   = valpha;
    vec4 mvPos   = modelViewMatrix * vec4(position, 1.0);
    // Perspective attenuation: point appears larger as camera gets closer.
    gl_PointSize = psize * (300.0 / -mvPos.z);
    gl_Position  = projectionMatrix * mvPos;
  }
`

// ── GLSL fragment shader — soft anti-aliased disc ────────────────────────────
const _particleFrag = /* glsl */`
  varying vec3  vCol;
  varying float vA;

  void main() {
    // gl_PointCoord spans (0,0)→(1,1) across the point sprite quad.
    vec2  uv = gl_PointCoord - 0.5;
    float d  = dot(uv, uv);
    if (d > 0.25) discard;                         // clip outside disc
    float soft = 1.0 - smoothstep(0.12, 0.25, d); // feathered edge
    gl_FragColor = vec4(vCol, vA * soft);
  }
`

const particleMat = new THREE.ShaderMaterial({
    vertexShader: _particleVert,
    fragmentShader: _particleFrag,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
})

const particleMesh = new THREE.Points(particleGeo, particleMat)
particleMesh.frustumCulled = false   // particles span all of 3-D space
scene.add(particleMesh)

// §2b-2e removed — spectrum rings, oscilloscope and harmonic web replaced by
// the left-side #spectrum-panel canvas drawn in _updateSpectrumPanel() each frame.

// ─────────────────────────────────────────────────────────────────────────────
// ── 2f  BACKGROUND 2-D SCENE — full-screen overlay planes
//        Rendered before the main 3-D scene every frame via an OrthographicCamera.
//        Three planes share one PlaneGeometry(2,2) quad that exactly fills NDC.
//
//        _fadePlane       — motion-trail persistence (Momentary mode: slow fade)
//        _atmospherePlane — atmospheric pressure haze (RMS-driven)
//        _lfWashPlane     — LF foundational wash (bass-colour background tint)
//
//  renderer.autoClear is disabled so we control clearing manually (see animate()).
// ─────────────────────────────────────────────────────────────────────────────

const _bgScene = new THREE.Scene()
const _bgCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
const _quadGeo = new THREE.PlaneGeometry(2, 2)

const _fadeMat = new THREE.MeshBasicMaterial({
    color: 0x000000, transparent: true, opacity: 0,
    depthTest: false, depthWrite: false,
})
_bgScene.add(new THREE.Mesh(_quadGeo, _fadeMat))

const _atmosphereMat = new THREE.MeshBasicMaterial({
    color: 0x281e3c, transparent: true, opacity: 0,
    depthTest: false, depthWrite: false,
})
_bgScene.add(new THREE.Mesh(_quadGeo, _atmosphereMat))

const _lfWashMat = new THREE.MeshBasicMaterial({
    color: 0xff4422, transparent: true, opacity: 0,
    depthTest: false, depthWrite: false,
})
_bgScene.add(new THREE.Mesh(_quadGeo, _lfWashMat))

// Disable automatic framebuffer clearing — animate() manages it manually
renderer.autoClear = false

// ─────────────────────────────────────────────────────────────────────────────
// § 3  WEB AUDIO API — ANALYSER NODE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * AudioEngine
 * Wraps the browser Web Audio API. Provides per-frame FFT data:
 *   • frequencyData  — Uint8Array of raw FFT bins (0-255 per bin)
 *   • timeDomainData — Uint8Array waveform samples  (0-255, 128 = silence)
 *   • bass / mid / high — averaged energy in each band (0-1)
 *   • peakFrequency  — Hz of the loudest FFT bin
 */
class AudioEngine {
    constructor() {
        /** @type {AudioContext|null} */
        this.ctx = null
        /** @type {AnalyserNode|null} */
        this.analyser = null
        /** @type {AudioBufferSourceNode|MediaElementAudioSourceNode|null} */
        this.source = null
        /** @type {HTMLAudioElement|null} */
        this.audioEl = null

        this.FFT_SIZE = 2048          // must be a power of 2; gives 1024 frequency bins
        this.frequencyData = new Uint8Array(this.FFT_SIZE / 2)
        this.timeDomainData = new Uint8Array(this.FFT_SIZE)

        // Frequency band boundaries (Hz) — adjust to taste
        this.BASS_MAX = 250
        this.MID_MIN = 250
        this.MID_MAX = 4000
        this.HIGH_MIN = 4000

        // Live readings (updated every animation frame when audio is playing)
        this.bass = 0
        this.mid = 0
        this.high = 0
        this.amplitude = 0   // RMS of time-domain data, 0-1
        this.peakFreq = 0   // Hz

        // Stereo pan [-1 full-left … +1 full-right] from L/R energy balance
        this.pan = 0
        // Onset flux: positive amplitude derivative used by kineticPendulum
        this.onsetFlux = 0
        this._prevAmp = 0
        // Stereo splitter nodes (created lazily in init())
        this.splitter = null
        this.analyserL = null
        this.analyserR = null
        this._freqDataL = new Uint8Array(128)
        this._freqDataR = new Uint8Array(128)
        this._tdDataL = new Uint8Array(256)  // time-domain L channel (Lissajous / orbital)
        this._tdDataR = new Uint8Array(256)  // time-domain R channel
    }

    /**
     * Create (or resume) the AudioContext and wire up the AnalyserNode.
     * Must be called from a user-gesture handler (autoplay policy).
     *
     * @param {HTMLAudioElement} audioElement
     */
    init(audioElement) {
        // Reuse an existing context if possible
        if (!this.ctx) {
            this.ctx = new (window.AudioContext || window.webkitAudioContext)()
            this.analyser = this.ctx.createAnalyser()
            this.analyser.fftSize = this.FFT_SIZE
            this.analyser.smoothingTimeConstant = 0.80   // 0 = no smoothing, 1 = maximum
            this.analyser.connect(this.ctx.destination)
        }

        // Reconnect only if the audio element changed
        if (this.audioEl !== audioElement) {
            this.source?.disconnect()
            this.audioEl = audioElement
            this.source = this.ctx.createMediaElementSource(audioElement)
            this.source.connect(this.analyser)
        }

        if (this.ctx.state === 'suspended') this.ctx.resume()

        // Stereo channel splitter — set up once, gracefully skipped for mono sources
        if (!this.splitter) {
            try {
                this.splitter = this.ctx.createChannelSplitter(2)
                this.analyserL = this.ctx.createAnalyser()
                this.analyserR = this.ctx.createAnalyser()
                this.analyserL.fftSize = 256
                this.analyserR.fftSize = 256
                this.analyserL.smoothingTimeConstant = 0.6
                this.analyserR.smoothingTimeConstant = 0.6
                this.source.connect(this.splitter)
                this.splitter.connect(this.analyserL, 0)
                this.splitter.connect(this.analyserR, 1)
            } catch (_) { /* mono source — stereo pan stays 0 */ }
        }
    }

    /**
     * Read the latest FFT and time-domain data from the AnalyserNode.
     * Call once per animation frame.
     */
    update() {
        if (!this.analyser) return

        this.analyser.getByteFrequencyData(this.frequencyData)
        this.analyser.getByteTimeDomainData(this.timeDomainData)

        const binCount = this.frequencyData.length
        const sampleRate = this.ctx?.sampleRate ?? 44100
        const nyquist = sampleRate / 2

        // Convert bin index → Hz
        const binToHz = (bin) => (bin / binCount) * nyquist

        let bassSum = 0, bassCount = 0
        let midSum = 0, midCount = 0
        let highSum = 0, highCount = 0
        let peakVal = 0, peakBin = 0

        for (let i = 0; i < binCount; i++) {
            const val = this.frequencyData[i]
            const hz = binToHz(i)

            if (hz < this.BASS_MAX) { bassSum += val; bassCount++ }
            else if (hz >= this.MID_MIN && hz < this.MID_MAX) { midSum += val; midCount++ }
            else if (hz >= this.HIGH_MIN) { highSum += val; highCount++ }

            if (val > peakVal) { peakVal = val; peakBin = i }
        }

        this.bass = bassCount ? (bassSum / bassCount) / 255 : 0
        this.mid = midCount ? (midSum / midCount) / 255 : 0
        this.high = highCount ? (highSum / highCount) / 255 : 0
        this.peakFreq = Math.round(binToHz(peakBin))

        // RMS amplitude from the time-domain waveform
        let sumSq = 0
        for (let i = 0; i < this.timeDomainData.length; i++) {
            const norm = (this.timeDomainData[i] - 128) / 128
            sumSq += norm * norm
        }
        this.amplitude = Math.sqrt(sumSq / this.timeDomainData.length)

        // Stereo pan: L/R energy balance (-1 = full left, +1 = full right)
        if (this.analyserL && this.analyserR) {
            this.analyserL.getByteFrequencyData(this._freqDataL)
            this.analyserR.getByteFrequencyData(this._freqDataR)
            this.analyserL.getByteTimeDomainData(this._tdDataL)
            this.analyserR.getByteTimeDomainData(this._tdDataR)
            let sumL = 0, sumR = 0
            for (let j = 0; j < this._freqDataL.length; j++) {
                sumL += this._freqDataL[j]
                sumR += this._freqDataR[j]
            }
            const tot = sumL + sumR + 1
            this.pan = (sumR - sumL) / tot
        }

        // Onset flux: positive energy spike on transients (drives kineticPendulum)
        this.onsetFlux = Math.max(0, this.amplitude - this._prevAmp)
        this._prevAmp = this.amplitude
    }

    /**
     * Find the top N local-maximum peaks in the frequency spectrum.
     * A bin qualifies if it is louder than both its neighbours and above
     * the linear amplitude threshold.
     *
     * @param  {number} N            — maximum number of peaks to return
     * @param  {number} linThreshold — minimum linear energy (0–1) to qualify
     * @returns {{ bin: number, hz: number, energy: number }[]} sorted loudest-first
     */
    getTopPeaks(N = 16, linThreshold = 0.05) {
        const binCount = this.frequencyData.length
        const sampleRate = this.ctx?.sampleRate ?? 44100
        const nyquist = sampleRate / 2
        const binToHz = (b) => (b / binCount) * nyquist

        const candidates = []
        for (let i = 1; i < binCount - 1; i++) {
            const e = this.frequencyData[i] / 255
            const prev = this.frequencyData[i - 1] / 255
            const next = this.frequencyData[i + 1] / 255
            if (e > linThreshold && e >= prev && e >= next) {
                candidates.push({ bin: i, hz: Math.round(binToHz(i)), energy: e })
            }
        }
        candidates.sort((a, b) => b.energy - a.energy)
        return candidates.slice(0, N)
    }
}

const audioEngine = new AudioEngine()

// ── Audio element (created once, reused) ─────────────────────────────────────

const audioEl = new Audio()
audioEl.crossOrigin = 'anonymous'

let isPlaying = false

fileInput.addEventListener('change', (e) => {
    const file = e.target.files[0]
    if (!file) return
    audioEl.src = URL.createObjectURL(file)
    audioEl.load()
    btnPlayPause.disabled = false
    btnPlayPause.textContent = '▶ Play'
    isPlaying = false
})

btnPlayPause.addEventListener('click', async () => {
    // AudioContext must be created/resumed inside a user gesture
    audioEngine.init(audioEl)

    // Ensure the AudioContext is running before any playback attempt.
    // (MediaElementAudioSourceNode routes audio through the context —
    //  no sound reaches the speakers if the context is suspended.)
    if (audioEngine.ctx?.state === 'suspended') {
        await audioEngine.ctx.resume()
    }

    if (isPlaying) {
        audioEl.pause()
        btnPlayPause.textContent = '▶ Play'
        isPlaying = false
    } else {
        try {
            await audioEl.play()
            btnPlayPause.textContent = '⏸ Pause'
            isPlaying = true
        } catch (err) {
            console.warn('[SEESOUND] play() failed:', err.message)
            // Keep isPlaying = false so UI stays consistent
        }
    }
})

audioEl.addEventListener('ended', () => {
    isPlaying = false
    btnPlayPause.textContent = '▶ Play'
})

// ── Time display helper ───────────────────────────────────────────────────────

function fmtTime(sec) {
    const m = Math.floor(sec / 60)
    const s = String(Math.floor(sec % 60)).padStart(2, '0')
    return `${m}:${s}`
}


// ─────────────────────────────────────────────────────────────────────────────
// § 4  WEBSOCKET BRIDGE — Backend structural metadata
// ─────────────────────────────────────────────────────────────────────────────

/**
 * BackendBridge
 * Maintains a persistent WebSocket connection to the Python server.
 * The server sends JSON "rule" messages that tell the Three.js engine
 * how to interpret audio data (e.g., visual mode, colour palette, harmonic
 * multipliers). The bridge stores the latest ruleset and re-connects on drop.
 */
class BackendBridge {
    constructor(url) {
        this.url = url
        this.ws = null
        this.reconnectDelay = 3000      // ms between reconnection attempts
        this._reconnectTimer = null

        /**
         * The active rule set received from the backend.
         * Three.js render loop reads this every frame.
         * Shape mirrors Phase 2 API — extend as backend evolves.
         */
        this.rules = {
            visualMode: 0,          // 0-7, maps to render mode
            colorPalette: [[255, 255, 255]],
            bassMultiplier: 1.0,
            midMultiplier: 1.0,
            highMultiplier: 1.0,
            harmonicRatios: [],         // e.g. [1, 1.5, 2, 3] for chord analysis
            stemGains: {},         // e.g. { drums: 1, melody: 0.8 }
        }
    }

    connect() {
        if (this.ws && this.ws.readyState <= WebSocket.OPEN) return

        this.ws = new WebSocket(this.url)

        this.ws.onopen = () => {
            this._setStatus('open', 'Backend connected')
            clearTimeout(this._reconnectTimer)
            console.log('[WS] Connected to SEESOUND backend.')
        }

        this.ws.onmessage = (event) => {
            try {
                const msg = JSON.parse(event.data)
                this._handleMessage(msg)
            } catch (err) {
                console.warn('[WS] Non-JSON message:', event.data)
            }
        }

        this.ws.onclose = () => {
            this._setStatus('closed', 'Backend disconnected — retrying…')
            this._scheduleReconnect()
        }

        this.ws.onerror = (err) => {
            console.error('[WS] Error:', err)
            this._setStatus('closed', 'Connection error')
        }
    }

    /**
     * Send a JSON payload to the Python backend.
     * @param {object} payload
     */
    send(payload) {
        if (this.ws?.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(payload))
        }
    }

    /**
     * Route an incoming server message to the right handler.
     * @param {{ type: string, payload?: object }} msg
     */
    _handleMessage(msg) {
        switch (msg.type) {
            // Server sends updated visual rules (after upload + pre-processing)
            case 'rules':
                Object.assign(this.rules, msg.payload ?? {})
                console.log('[WS] Rules updated:', this.rules)
                break

            // Server confirms an upload job completed
            case 'upload_complete':
                console.log('[WS] Upload complete. Job:', msg.payload?.job_id,
                    '| Duration:', msg.payload?.duration, 's')
                break

            // Server pushed a preset definition
            case 'preset_loaded':
                Object.assign(this.rules, msg.payload?.rules ?? {})
                console.log('[WS] Preset loaded:', msg.payload?.name)
                break

            // Heartbeat / keepalive
            case 'ping':
                this.send({ type: 'pong' })
                break

            default:
                console.log('[WS] Unhandled message type:', msg.type, msg)
        }
    }

    _scheduleReconnect() {
        clearTimeout(this._reconnectTimer)
        this._reconnectTimer = setTimeout(() => this.connect(), this.reconnectDelay)
    }

    _setStatus(cssClass, text) {
        statusDot.className = cssClass
        statusText.textContent = text
    }
}

const bridge = new BackendBridge('ws://localhost:8000/ws')
bridge.connect()


// ─────────────────────────────────────────────────────────────────────────────
// § 5  MATH ENGINE INSTANCES
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Shared ColorEngine — stateful, cached.
 * Config is updated whenever the backend sends a 'rules' or 'preset_loaded'
 * message that includes color-related fields.
 */
const colorEngine = new ColorEngine()

/**
 * Default tonic for Pythagorean spatial calculations.
 * Overridden at runtime by bridge.rules.tonicHz when set by the backend
 * (e.g., after key detection from an uploaded audio file).
 * Default: C4 = 261.63 Hz
 */
const DEFAULT_TONIC_HZ = 261.63

/**
 * Update the ColorEngine config whenever the backend pushes new rules.
 * Maps snake_case WebSocket keys to ColorConfig camelCase fields.
 */
function applyRulesToColorEngine(rules) {
    const updates = {}
    if ('grayscale_min' in rules) updates.grayscale_min = rules.grayscale_min
    if ('grayscale_max' in rules) updates.grayscale_max = rules.grayscale_max
    if ('spectrum_low_hz' in rules) updates.spectrum_low_hz = rules.spectrum_low_hz
    if ('spectrum_high_hz' in rules) updates.spectrum_high_hz = rules.spectrum_high_hz
    if ('w_r' in rules) updates.w_r = rules.w_r
    if ('w_g' in rules) updates.w_g = rules.w_g
    if ('w_b' in rules) updates.w_b = rules.w_b
    if ('note_colors' in rules) updates.note_colors = rules.note_colors
    if ('color_input_mode' in rules) updates.color_input_mode = rules.color_input_mode
    if (Object.keys(updates).length) colorEngine.updateConfig(updates)
}

// Hook into BackendBridge so colour config stays in sync
const _origHandleMessage = bridge._handleMessage.bind(bridge)
bridge._handleMessage = (msg) => {
    _origHandleMessage(msg)
    if (msg.type === 'rules' || msg.type === 'preset_loaded') {
        applyRulesToColorEngine(msg.payload?.rules ?? msg.payload ?? {})
    }
}


// ─────────────────────────────────────────────────────────────────────────────
// § 6  ANIMATION LOOP — Web Audio API → MathEngine → Three.js GPU geometry
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// § 6  CANVAS PHYSICS — all spatial / painting behaviors ported from Python
// ─────────────────────────────────────────────────────────────────────────────

// ── CPU-side particle birth state ────────────────────────────────────────────
// _partBirth[i]      — last refresh timestamp (ms). -1 = dead slot.
// _partFirstBirth[i] — timestamp of FIRST birth, for saliencyWeight boost.
//                      Stays set until the particle dies; resets on kill.
const _partFirstBirth = new Float64Array(MAX_PARTICLES).fill(-1)

// ── Seeded RNG (Lehmer LCG) — same algorithm as the old RenderEngine.js ──────
function _seededRNG(seed) {
    let s = seed % 2147483647
    if (s <= 0) s += 2147483646
    return () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646 }
}

// ── THREE.js blending mode map ────────────────────────────────────────────────
// Maps the blendMode dropdown value to the THREE.XXXBlending constant.
const _BLEND_MAP = {
    'source-over': THREE.NormalBlending,
    'screen': THREE.AdditiveBlending,
    'lighter': THREE.AdditiveBlending,
    'color-dodge': THREE.AdditiveBlending,
    'multiply': THREE.MultiplyBlending,
    'color-burn': THREE.SubtractiveBlending,
    'darken': THREE.NormalBlending,
    'overlay': THREE.NormalBlending,
    'soft-light': THREE.NormalBlending,
    'hard-light': THREE.NormalBlending,
    'difference': THREE.SubtractiveBlending,
    'exclusion': THREE.SubtractiveBlending,
}
let _lastBlendMode = ''

// ─────────────────────────────────────────────────────────────────────────────
// ── 6-helper-a  VIEWPORT + SQUIRCLE HELPERS
//
//  _viewportHalfDims()  — current Three.js viewport in world units.
//  _perBinPan(bin, N)   — per-bin stereo pan approximation from L/R analysers.
//  _squircleMap(cx,cy,hw,hh) — maps pan×consonance coords to world coords.
//
//  Used by mode 0 (Circular) to place particles using the exact same adaptive-
//  squircle formula that the reference RenderEngine.js used on the 2-D canvas.
// ─────────────────────────────────────────────────────────────────────────────

function _viewportHalfDims() {
    const fovRad = (camera.fov * Math.PI) / 180
    const hh = camera.position.z * Math.tan(fovRad / 2)
    const hw = hh * camera.aspect
    return { hw, hh }
}

function _perBinPan(binIndex, totalBins) {
    if (!audioEngine.analyserL || !audioEngine.analyserR) return audioEngine.pan
    const lrLen = audioEngine._freqDataL.length
    const lrBin = Math.min(Math.floor((binIndex / totalBins) * lrLen), lrLen - 1)
    const l = audioEngine._freqDataL[lrBin] + 1
    const r = audioEngine._freqDataR[lrBin] + 1
    return (r - l) / (r + l)  // -1 (full left) … +1 (full right)
}

// Adaptive squircle: n=2 (circle) at centre, n→32 (rectangle) at edge.
// Input: cx, cy in “pan×consonance” normalised space (same as reference radiusScale=0.12).
// Output: world-space position relative to scene centre, in the given half-dims.
function _squircleMap(cx, cy, hw, hh) {
    const rComp = Math.hypot(cx, cy)
    const ang = Math.atan2(cx, cy)       // atan2(x, y): 0 = +Y (top), +π/2 = +X (right)
    const rNorm = Math.min(rComp / Math.SQRT2, 1)
    const sqN = 2 + rNorm * 30
    const sinA = Math.abs(Math.sin(ang))
    const cosA = Math.abs(Math.cos(ang))
    const termS = sinA > 1e-6 ? Math.pow(sinA / hw, sqN) : 0
    const termC = cosA > 1e-6 ? Math.pow(cosA / hh, sqN) : 0
    const rBound = (termS + termC) > 1e-30
        ? Math.pow(termS + termC, -1 / sqN)
        : Math.min(hw, hh)
    return {
        x: Math.sin(ang) * rNorm * rBound,
        y: -Math.cos(ang) * rNorm * rBound,
    }
}

// 2-D pixel-space variant (canvas coordinates, origin = top-left)
function _squircleMap2D(cx, cy, hw, hh) {
    const rComp = Math.hypot(cx, cy)
    const ang = Math.atan2(cx, cy)
    const rNorm = Math.min(rComp / Math.SQRT2, 1)
    const sqN = 2 + rNorm * 30
    const sinA = Math.abs(Math.sin(ang))
    const cosA = Math.abs(Math.cos(ang))
    const termS = sinA > 1e-6 ? Math.pow(sinA / hw, sqN) : 0
    const termC = cosA > 1e-6 ? Math.pow(cosA / hh, sqN) : 0
    const rBound = (termS + termC) > 1e-30
        ? Math.pow(termS + termC, -1 / sqN)
        : Math.min(hw, hh)
    return [
        hw + Math.sin(ang) * rNorm * rBound,
        hh - Math.cos(ang) * rNorm * rBound,
    ]
}

// Helper used by Gravity and Orbital 2-D renderers:
// maps a component’s spatial x/y (radiusScale=0.12) to canvas pixel coordinates.
function _circularPos2D(c, w, h) {
    return _squircleMap2D(c.x, c.y, w / 2, h / 2)
}

// Build synthetic “component” objects from FFT peaks — used by overlay modes 2-7.
function _buildComponents(freqData, tonicHz, gainMult, linThreshold) {
    const peaks = audioEngine.getTopPeaks(64, linThreshold)
    return peaks.map(peak => {
        const sp = computeSpatial(peak.hz, 0, tonicHz, 0.12)  // radiusScale=0.12 matches reference
        const clarity = ratioToClarity(sp.ratio_n, sp.ratio_d)
        const cr = colorEngine.freqToColor(peak.hz)
        const amp = Math.min(peak.energy * gainMult, 1)
        return {
            freq: peak.hz,
            amplitude: amp,
            pan: audioEngine.pan,
            phase: (2 * Math.PI * peak.hz * (audioEl.currentTime || 0)) % (2 * Math.PI),
            color_rgb: cr.rgb,
            hue: cr.hue,
            ratio_n: sp.ratio_n,
            ratio_d: sp.ratio_d,
            x: sp.x,     // pan×consonance space, radiusScale=0.12
            y: sp.y,
            note: freqToNote(peak.hz),
            instrument: 'default',
            clarity,
            opacity: amplitudeToOpacity(amp, 1.0),
        }
    })
}

// ─────────────────────────────────────────────────────────────────────────────
// ── 6-helper-b  LAYOUT POSITION CALCULATOR  (modes 0–1 only)
//
//  Returns {x, y, z} in Three.js world units for one FFT bin.
//  Modes 2-9 are handled by the 2-D overlay canvas (_updateOverlay2D).
// ─────────────────────────────────────────────────────────────────────────────

function _getLayoutPosition(bin, hz, energy, tonicHz, now, spatial, layoutMode, N) {
    const zD = (params.zDepth / 100) * 28
    const octave = Math.log2(Math.max(hz, 16.35) / 16.35)

    switch (layoutMode) {
        case 0: {
            // ── Circular: adaptive squircle in pan × consonance space ──────────
            // Mirrors the reference RenderEngine circular layout exactly.
            // Component’s “pan”  = stereo position of this bin (from L/R analysers).
            // Component’s “r”    = radiusScale(0.12) × ratio_d (consonant=small, dissonant=wide).
            // The squircle formula fills the viewport: consonant notes cluster
            // near the top, dissonant ones spread toward the edges.
            const pan = _perBinPan(bin, N)
            const r = 0.12 * spatial.ratio_d
            const theta = pan * Math.PI / 2
            const compX = r * Math.sin(theta)
            const compY = -r * Math.cos(theta)
            const { hw, hh } = _viewportHalfDims()
            const pos = _squircleMap(compX, compY, hw, hh)
            return { x: pos.x, y: pos.y, z: (4 - octave) * zD / 6 }
        }

        case 1: {
            // ── Linear: scrolling piano-roll — time on X, log-freq on Y ───────
            // X: audio playback position maps left (track-start) to right (end).
            // Y: log-frequency — bass at bottom, treble at top, perceptually uniform.
            const trackDur = audioEl.duration > 1
                ? audioEl.duration
                : Math.max((audioEl.currentTime || 0) + 30, 30)
            const { hw, hh } = _viewportHalfDims()
            const freqLogNorm = Math.min(Math.log2(Math.max(hz, 20) / 20) / Math.log2(1000), 1)
            return {
                x: (audioEl.currentTime / trackDur) * 2 * hw - hw,
                y: (1 - freqLogNorm) * 2 * hh - hh,
                z: 0,
            }
        }

        case 9: {
            // ── Amp × Stereo: flat 2-D scatter using the Three.js particle system ───
            // X = per-bin stereo pan  →  full left edge … full right edge
            // Y = amplitude (energy)  →  bottom (silent) … top (loud)
            // Z = 0 (flat plane — use zDepth slider for subtle layering via entropy)
            // Color comes from freq automatically via colorEngine in _updateParticles.
            const pan9 = _perBinPan(bin, N)
            const { hw, hh } = _viewportHalfDims()
            return {
                x: pan9 * hw,
                y: (Math.min(energy, 1) * 2 - 1) * hh,
                z: 0,
            }
        }

        // Modes 2-8 are rendered by the 2-D overlay canvas; return origin as no-op.
        default: return { x: 0, y: 0, z: 0 }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// ── 6-helper-b  UPDATE SPECTRAL PARTICLE SYSTEM
//
//  Per-particle pipeline each frame:
//    1. Layout position   → _getLayoutPosition() based on params.layoutMode
//    2. Canvas physics    → entropy, fieldRendering, sourceSeparation,
//                           interInstrumental, chromaticGravity, magneticOrientation
//    3. Colour            → ColorEngine + dissonanceDesat + brightnessScaling
//    4. Size              → amplitudeToSize × magnitudeSizeRatio × freqDepthEffect
//                           × depthDisplacement (bass) × saliencyWeight (fresh)
//    5. Alpha             → timeDecayFactor × attackSensitivity fade-in
// ─────────────────────────────────────────────────────────────────────────────

function _updateParticles(freqData, tonicHz, gainMult, linThreshold, now) {
    const binCount = freqData.length
    const sampleRate = audioEngine.ctx?.sampleRate ?? 44100
    const nyquist = sampleRate / 2
    const binToHz = (b) => (b / binCount) * nyquist

    // ── Read all param sliders once (avoid repeated object lookups in hot loop)
    const layoutMode = params.layoutMode
    const halfLife = params.releaseDecay
    const sizeStrength = params.amplitudeSizeStrength / 4
    const baseSize = params.defaultParticleSize
    const dissonDesat = params.dissonanceDesat / 100
    const brightScale = params.brightnessScaling / 100
    const magSizeRatio = params.magnitudeSizeRatio / 100
    const freqDepth = params.freqDepthEffect / 100
    const depthDisp = params.depthDisplacement / 100
    const saliencyStr = params.saliencyWeight / 100
    const attackSens = params.attackSensitivity / 100
    const harmClarity = params.harmonicClarity / 100
    const entropyStr = params.entropy / 100
    const gravStr = params.chromaticGravity / 100
    const magStr = params.magneticOrientation / 100
    const fieldStr = params.fieldRendering / 100
    const interStr = params.interInstrumental / 100
    const srcSep = params.sourceSeparation / 100

    // kineticPendulum: onset flux limits the proportion of bins processed this frame.
    // Fast transients → more active draws. Silence → reduced draw budget.
    const kineticMul = 0.5 + (params.kineticPendulum / 100) * Math.min(1, audioEngine.onsetFlux * 25) * 0.5
    const activeLimit = Math.ceil(Math.min(binCount, MAX_PARTICLES) * kineticMul)

    // Seeded RNG: seed rotates every 80 ms → jitter evolves slowly
    const rng = _seededRNG(Math.floor(now / 80) * 3571)

    const N = Math.min(binCount, MAX_PARTICLES)

    for (let i = 0; i < N; i++) {
        const hz = binToHz(i)
        const energy = (freqData[i] / 255) * gainMult

        // ── Spawn / refresh above threshold ─────────────────────────────────
        if (energy > linThreshold && hz >= 20 && i <= activeLimit) {

            const spatial = computeSpatial(hz, 0, tonicHz, 1.8)
            const clarity = ratioToClarity(spatial.ratio_n, spatial.ratio_d)
            const dissonance = Math.max(0, 1 - clarity)

            // Track first-birth for saliencyWeight (resets only on particle death)
            if (_partBirth[i] < 0) _partFirstBirth[i] = now
            _partBirth[i] = now

            // ── 1. Layout position ─────────────────────────────────────────
            let { x, y, z } = _getLayoutPosition(i, hz, energy, tonicHz, now, spatial, layoutMode, N)

            // ── 2. Canvas physics modifiers ────────────────────────────────

            // Entropy jitter: seeded random displacement ∝ note density
            if (entropyStr > 0) {
                x += (rng() - 0.5) * entropyStr * 14
                y += (rng() - 0.5) * entropyStr * 14
            }

            // Field rendering: dissonance-driven random scatter
            if (fieldStr > 0 && dissonance > 0) {
                x += (rng() - 0.5) * dissonance * fieldStr * 22
                y += (rng() - 0.5) * dissonance * fieldStr * 22
            }

            // Source separation: scale radius by spectral clarity
            //   high clarity → stays at natural radius; low clarity → pulled in
            if (srcSep > 0) {
                const clarityScale = 1 - srcSep * (1 - (0.5 + clarity * 0.5))
                const dist = Math.hypot(x, y)
                if (dist > 0.01) {
                    const d2 = dist * clarityScale
                    x = (x / dist) * d2
                    y = (y / dist) * d2
                }
            }

            // Inter-instrumental: nudge dissonant partials toward centre
            if (interStr > 0 && dissonance > 0) {
                const iw = interStr * dissonance * 0.18
                x *= (1 - iw)
                y *= (1 - iw)
            }

            // Chromatic gravity: lerp all positions toward (0, 0)
            if (gravStr > 0) {
                x *= (1 - gravStr * 0.32)
                y *= (1 - gravStr * 0.32)
            }

            // Magnetic orientation: rotate angle toward +Y axis (12 o'clock = tonic pole)
            if (magStr > 0) {
                const dist = Math.hypot(x, y)
                if (dist > 0.01) {
                    const curAng = Math.atan2(x, y)     // angle from +Y axis
                    const newAng = curAng * (1 - magStr * 0.22)
                    x = Math.sin(newAng) * dist
                    y = Math.cos(newAng) * dist
                }
            }

            // Write position
            _partPos[i * 3] = x
            _partPos[i * 3 + 1] = y
            _partPos[i * 3 + 2] = z

            // ── 3. Colour ──────────────────────────────────────────────────
            const cr = colorEngine.freqToColor(hz)
            let [r, g, b] = cr.rgb

            // Dissonance desaturation: complex ratios → grey
            if (dissonDesat > 0 && dissonance > 0) {
                const desat = dissonance * dissonDesat
                const gray = rgbToGrayscale([r, g, b])
                r += (gray - r) * desat
                g += (gray - g) * desat
                b += (gray - b) * desat
            }

            // Brightness scaling: loud components are lighter
            if (brightScale > 0) {
                const lm = 1 + Math.min(energy, 1) * brightScale * 0.5
                r = Math.min(255, r * lm)
                g = Math.min(255, g * lm)
                b = Math.min(255, b * lm)
            }

            // Harmonic clarity: dim noisy partials for contrast
            if (harmClarity > 0 && clarity < 0.8) {
                const dimF = 1 - (1 - clarity) * harmClarity * 0.4
                r *= dimF; g *= dimF; b *= dimF
            }

            _partCol[i * 3] = r / 255
            _partCol[i * 3 + 1] = g / 255
            _partCol[i * 3 + 2] = b / 255

            // ── 4. Size ────────────────────────────────────────────────────
            // magnitudeSizeRatio: shifts amplitude energy toward size (vs opacity)
            const sizeEnergy = magSizeRatio > 0 ? Math.pow(Math.min(energy, 1), 1 - magSizeRatio * 0.3) : energy

            // freqDepthEffect: bass bins drawn larger
            const depthBoostFreq = (1 - Math.min(hz / 6000, 1)) * freqDepth

            // depthDisplacement: extra radius for bass partials ∝ bass energy
            const depthBoostBass = (hz < 250 && depthDisp > 0)
                ? 1 + depthDisp * Math.min(audioEngine.bass * gainMult, 1) * 0.5
                : 1

            // saliencyWeight: size burst on fresh particles (first 300 ms)
            let salBoost = 1
            if (saliencyStr > 0 && _partFirstBirth[i] >= 0) {
                const age = (now - _partFirstBirth[i]) / 1000
                if (age < 0.3) salBoost = 1 + saliencyStr * (1 - age / 0.3)
            }

            _partSzArr[i] = Math.max(0.5,
                amplitudeToSize(sizeEnergy, sizeStrength)
                * baseSize
                * (1 + depthBoostFreq)
                * depthBoostBass
                * salBoost,
            )
        }

        // ── Age / decay ─────────────────────────────────────────────────────
        if (_partBirth[i] >= 0) {
            const age = (now - _partBirth[i]) / 1000
            const decay = timeDecayFactor(age, halfLife)

            // attackSensitivity: fade-in over first 100 ms
            let attackFade = 1
            if (attackSens < 1 && age < 0.1) {
                attackFade = attackSens + (1 - attackSens) * (age / 0.1)
            }

            // magnitudeSizeRatio: leftover amplitude proportion goes to opacity
            const opacityEnergy = magSizeRatio > 0
                ? Math.min(energy, 1) * (1 - magSizeRatio * 0.5 + 0.5)
                : energy
            const instOpacity = amplitudeToOpacity((freqData[i] / 255) * gainMult * (1 - magSizeRatio * 0.4 + 0.4), 1.0)

            _partAlphaArr[i] = attackFade * Math.min(1.0, Math.max(decay, instOpacity * decay * 2))

            // ── Painting mode: stamp once, then stay invisible ──────────────
            // renderer.autoClear=false + clearDepth() keeps the colour buffer;
            // setting alpha=0 after the first draw preserves the painted pixel.
            if (params.persistMode === 1) {
                if (_partPainted[i]) {
                    _partAlphaArr[i] = 0          // already in colour buffer — suppress GPU write
                } else {
                    _partAlphaArr[i] = Math.max(_partAlphaArr[i], 0.9)  // guarantee visible on first draw
                    _partPainted[i] = 1
                }
            }

            if (decay < 0.02) {
                _partBirth[i] = -1
                _partFirstBirth[i] = -1
                _partAlphaArr[i] = 0
                _partSzArr[i] = 0
                _partPainted[i] = 0    // reset so next activation paints fresh
            }
        } else {
            _partAlphaArr[i] = 0
            _partSzArr[i] = 0
        }
    }
}

// ── 6-helper-c  IDLE PARTICLE DRIFT (no AudioContext yet) ────────────────────

function _idleParticles(now) {
    const t = now / 1000
    for (let i = 0; i < MAX_PARTICLES; i++) {
        if (_partBirth[i] < 0) continue
        const age = (now - _partBirth[i]) / 1000
        const decay = timeDecayFactor(age, 3.0)
        _partAlphaArr[i] = decay * (0.22 + Math.sin(t * 0.4 + i * 0.007) * 0.08)
        if (decay < 0.02) {
            _partBirth[i] = -1
            _partFirstBirth[i] = -1
            _partAlphaArr[i] = 0
            _partSzArr[i] = 0
        }
    }
}

// ── 6-helper-d  SPECTRUM PANEL (left-side canvas) ────────────────────────────
//  Vertical layout: frequencies run TOP (high) → BOTTOM (low) along the Y axis.
//  Each row is one frequency band; the bar extends HORIZONTALLY from x=0 by
//  width proportional to amplitude.  Colour = ColorEngine.freqToColor(hz).
//  Log-scale frequency mapping over 20 Hz – 20 kHz.

function _updateSpectrumPanel(freqData) {
    const sw = spectrumCanvas.width
    const sh = spectrumCanvas.height
    if (sw === 0 || sh === 0) return

    spectrumCtx.clearRect(0, 0, sw, sh)

    const binCount = freqData.length
    const sampleRate = audioEngine.ctx?.sampleRate ?? 44100
    const nyquist = sampleRate / 2
    const logMin = Math.log10(20)
    const logMax = Math.log10(Math.min(20000, nyquist))
    const logRange = logMax - logMin

    for (let y = 0; y < sh; y++) {
        // y = 0 → top → highest frequency
        // y = sh-1 → bottom → lowest frequency (20 Hz)
        const t = 1 - y / (sh - 1)              // 1 at top, 0 at bottom
        const hz = Math.pow(10, logMin + t * logRange)
        const bin = Math.min(
            Math.round((hz / nyquist) * binCount),
            binCount - 1
        )
        if (bin < 0) continue

        const norm = freqData[bin] / 255
        const barW = Math.round(norm * sw)
        if (barW < 1) continue

        const cr = colorEngine.freqToColor(hz)
        const [r, g, b] = cr.rgb
        spectrumCtx.fillStyle = `rgb(${Math.round(r)},${Math.round(g)},${Math.round(b)})`
        spectrumCtx.fillRect(0, y, barW, 1)      // 1-pixel-tall horizontal bar
    }
}

// ── 6-helper-e  SAVE PNG ──────────────────────────────────────────────────────

function _savePNG() {
    // Composite the Three.js canvas + the 2-D overlay canvas into one image
    const w = canvas.width, h = canvas.height
    const off = document.createElement('canvas')
    off.width = w; off.height = h
    const ctx = off.getContext('2d')
    ctx.drawImage(canvas, 0, 0)
    if (overlayCanvas.style.display !== 'none') {
        ctx.drawImage(overlayCanvas, 0, 0, w, h)
    }
    const a = document.createElement('a')
    a.download = `seesound_${Date.now()}.png`
    a.href = off.toDataURL('image/png')
    a.click()
}

// ── 6-helper-f  MP4 SCREEN RECORDER ─────────────────────────────────────────

let _recorder = null
let _recChunks = []
let _mergeCanvas = null
let _mergeCtx = null
let _recAudioDest = null
let _recAudioSrc = null

function _startRecording() {
    if (_recorder) return  // already recording

    // Offscreen merge canvas mirrors the window at actual CSS pixels
    const w = window.innerWidth, h = window.innerHeight
    _mergeCanvas = document.createElement('canvas')
    _mergeCanvas.width = w; _mergeCanvas.height = h
    _mergeCtx = _mergeCanvas.getContext('2d')

    const videoStream = _mergeCanvas.captureStream(30)

    // Also capture audio from the active AudioContext
    let combinedStream = videoStream
    if (audioEngine.ctx) {
        _recAudioDest = audioEngine.ctx.createMediaStreamDestination()
        // Route the source node to the record destination
        if (audioEngine.source) {
            audioEngine.source.connect(_recAudioDest)
        }
        const audioTracks = _recAudioDest.stream.getAudioTracks()
        audioTracks.forEach(t => videoStream.addTrack(t))
        combinedStream = videoStream
    }

    const mimeType = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
        .find(m => MediaRecorder.isTypeSupported(m)) || 'video/webm'

    _recChunks = []
    _recorder = new MediaRecorder(combinedStream, { mimeType })
    _recorder.ondataavailable = e => { if (e.data.size > 0) _recChunks.push(e.data) }
    _recorder.onstop = () => {
        const blob = new Blob(_recChunks, { type: mimeType })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.download = `seesound_${Date.now()}.webm`
        a.href = url
        a.click()
        URL.revokeObjectURL(url)
        _mergeCanvas = null
        _mergeCtx = null
        if (_recAudioSrc) { try { _recAudioSrc.disconnect(_recAudioDest) } catch { } }
        _recAudioDest = null
    }
    _recorder.start(100)  // 100 ms chunks
    btnRecord.textContent = '⏹ Stop'
    btnRecord.classList.add('recording')
}

function _stopRecording() {
    if (!_recorder) return
    _recorder.stop()
    _recorder = null
    btnRecord.textContent = '⏺ Record'
    btnRecord.classList.remove('recording')
}

function _updateMergeCanvas() {
    if (!_mergeCanvas || !_mergeCtx) return
    const w = _mergeCanvas.width, h = _mergeCanvas.height
    _mergeCtx.drawImage(canvas, 0, 0, w, h)
    if (overlayCanvas.style.display !== 'none') {
        _mergeCtx.drawImage(overlayCanvas, 0, 0, w, h)
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// ── 2-D OVERLAY RENDERERS  (layout modes 2–7)
//
//  These are direct ports of the reference RenderEngine.js specialised
//  renderers, adapted to use FFT-peak synthetic components instead of
//  server-analysed spectral components.
//
//  All draw into `overlayCtx` (the #overlay-canvas 2-D context).
//  animate() shows/hides the overlay canvas based on layoutMode.
// ─────────────────────────────────────────────────────────────────────────────

// Persistent state for stateful overlay renderers (L-System, Vector, Gravity, Orbital)
const _overState = {
    lState: null,
    vectorState: null,
    gravityState: null,
    lastLayoutMode: -1,
    lastPersistMode: -1,
    componentAges: new Map(),
}

// ── Marching-squares zero-contour extractor (used by Chladni) ──────────────
function _marchSegments(grid, gw, gh) {
    function interp(va, vb) {
        const d = va - vb
        if (Math.abs(d) < 1e-10) return 0.5
        const t = va / d
        return t < 0 ? 0 : t > 1 ? 1 : t
    }
    const segs = []
    for (let j = 0; j < gh - 1; j++) {
        for (let i = 0; i < gw - 1; i++) {
            const vTL = grid[j * gw + i], vTR = grid[j * gw + i + 1]
            const vBR = grid[(j + 1) * gw + i + 1], vBL = grid[(j + 1) * gw + i]
            const eT = (vTL > 0) !== (vTR > 0)
            const eR = (vTR > 0) !== (vBR > 0)
            const eB = (vBL > 0) !== (vBR > 0)
            const eL = (vTL > 0) !== (vBL > 0)
            const pts = []
            if (eT) pts.push([(i + interp(vTL, vTR)) / (gw - 1), j / (gh - 1)])
            if (eR) pts.push([(i + 1) / (gw - 1), (j + interp(vTR, vBR)) / (gh - 1)])
            if (eB) pts.push([(i + interp(vBL, vBR)) / (gw - 1), (j + 1) / (gh - 1)])
            if (eL) pts.push([i / (gw - 1), (j + interp(vTL, vBL)) / (gh - 1)])
            if (pts.length === 2) {
                segs.push(pts[0][0], pts[0][1], pts[1][0], pts[1][1])
            } else if (pts.length === 4) {
                const cval = (vTL + vTR + vBR + vBL) * 0.25
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

// ── Mode 2: Chladni Nodal Topography ────────────────────────────────────────
// Evaluates z = Σ amplitude·sin(nπx)·sin(mπy) on a 96×72 grid then draws the
// zero-level contour using marching squares in the component’s colour.
function _render2DChladni(components, w, h, blendMode, persistMode) {
    if (!components.length) return
    const GW = 96, GH = 72
    const grid = new Float32Array(GW * GH)
    for (let j = 0; j < GH; j++) {
        for (let i = 0; i < GW; i++) {
            const xf = i / (GW - 1), yf = j / (GH - 1)
            let z = 0
            for (const c of components) {
                const n = Math.max(1, Math.min(c.ratio_n || 1, 18))
                const m = Math.max(1, Math.min(c.ratio_d || 1, 18))
                z += c.amplitude * Math.sin(n * Math.PI * xf) * Math.sin(m * Math.PI * yf)
            }
            grid[j * GW + i] = z
        }
    }
    const segs = _marchSegments(grid, GW, GH)
    if (!segs.length) return
    // Amplitude-weighted composite colour
    let tr = 0, tg = 0, tb = 0, tw = 0
    for (const c of components) {
        const wt = c.amplitude
        tr += (c.color_rgb[0] || 200) * wt
        tg += (c.color_rgb[1] || 200) * wt
        tb += (c.color_rgb[2] || 200) * wt
        tw += wt
    }
    if (tw < 0.001) return
    const cr = tr / tw, cg = tg / tw, cb = tb / tw
    overlayCtx.globalCompositeOperation = blendMode
    overlayCtx.strokeStyle = 'rgba(' + Math.round(cr) + ',' + Math.round(cg) + ',' + Math.round(cb) + ',0.88)'
    overlayCtx.lineWidth = 1.3
    overlayCtx.lineCap = 'round'
    for (let s = 0; s < segs.length; s += 4) {
        overlayCtx.beginPath()
        overlayCtx.moveTo(segs[s] * w, segs[s + 1] * h)
        overlayCtx.lineTo(segs[s + 2] * w, segs[s + 3] * h)
        overlayCtx.stroke()
    }
}

// ── Mode 3: Oscilloscope Ribbon (real L/R Lissajous from Web Audio API) ───
// Plots L-channel signal on X and R-channel signal on Y, exactly as the
// reference does except using real hardware L/R rather than synthesised.
// Falls back to a frequency-synthesis Lissajous when no stereo data exists.
function _render2DOscilloscope(components, w, h, blendMode, persistMode, time) {
    if (!components.length) return
    const cx = w * 0.5, cy = h * 0.5
    const xScale = w * 0.46, yScale = h * 0.46
    // Amplitude-weighted colour
    let tr = 0, tg = 0, tb = 0, tw = 0
    for (const c of components) {
        const wt = c.amplitude
        tr += (c.color_rgb[0] || 200) * wt
        tg += (c.color_rgb[1] || 200) * wt
        tb += (c.color_rgb[2] || 200) * wt
        tw += wt
    }
    if (tw < 0.001) return
    const cr = tr / tw, cg = tg / tw, cb = tb / tw
    overlayCtx.globalCompositeOperation = blendMode
    overlayCtx.strokeStyle = 'rgba(' + Math.round(cr) + ',' + Math.round(cg) + ',' + Math.round(cb) + ',0.82)'
    overlayCtx.lineWidth = 1.5
    overlayCtx.lineCap = 'round'
    overlayCtx.lineJoin = 'round'
    overlayCtx.beginPath()

    const tdL = audioEngine._tdDataL
    const tdR = audioEngine._tdDataR
    const hasStereo = audioEngine.analyserL && tdL && tdL.length > 0

    if (hasStereo) {
        // Real L/R time-domain Lissajous — most accurate
        const N = Math.min(tdL.length, tdR.length)
        for (let n = 0; n < N; n++) {
            const xl = (tdL[n] - 128) / 128
            const xr = (tdR[n] - 128) / 128
            const px = cx + xl * xScale
            const py = cy + xr * yScale
            if (n === 0) overlayCtx.moveTo(px, py)
            else overlayCtx.lineTo(px, py)
        }
    } else {
        // Fallback: synthesise Lissajous from spectral components
        const lowestFreq = Math.min(...components.map(c => c.freq))
        const tWindow = Math.max(2.0 / (isFinite(lowestFreq) ? lowestFreq : 80), 0.015)
        const N = 1536, dt = tWindow / N
        const normFactor = tw > 0 ? 1.0 / tw : 1.0
        for (let n = 0; n < N; n++) {
            const t2 = time + n * dt
            let xl = 0, xr = 0
            for (const c of components) {
                const sig = c.amplitude * Math.sin(2 * Math.PI * c.freq * t2 + (c.phase || 0))
                xl += sig * (1.0 - Math.max(c.pan, 0))
                xr += sig * (1.0 + Math.min(c.pan, 0))
            }
            const px = cx + xl * normFactor * xScale
            const py = cy + xr * normFactor * yScale
            if (n === 0) overlayCtx.moveTo(px, py)
            else overlayCtx.lineTo(px, py)
        }
    }
    overlayCtx.stroke()
}

// ── Mode 4: Interval Branching (L-System Fractals) ──────────────────────
// Growing fractal branches: root at bottom-center, new notes spawn branches
// with angle derived from the interval (semitones) to the closest live note.
const _LSYS_ANGLE_TABLE = [0, 18, 32, 48, 62, 74, 88, 82, 68, 52, 36, 20]

function _render2DLSystem(components, w, h, blendMode, persistMode, time) {
    if (!_overState.lState) {
        _overState.lState = { branches: [], prevNotes: {}, lastTime: time, nextId: 0 }
    }
    const state = _overState.lState
    const dt = Math.min(Math.max(time - state.lastTime, 0), 0.1)
    state.lastTime = time
    const SPEED = Math.min(w, h) * 0.09

    // Build current note map (loudest per note name)
    const curNotes = {}
    for (const c of components) {
        if (!curNotes[c.note] || c.amplitude > curNotes[c.note].amplitude) curNotes[c.note] = c
    }
    // Spawn new branches
    for (const note in curNotes) {
        if (state.prevNotes[note]) continue
        const comp = curNotes[note]
        const rgb = comp.color_rgb || [200, 200, 200]
        let parentBranch = null, bestDiff = Infinity
        for (const br of state.branches) {
            if (!br.alive) continue
            const fd = Math.abs(br.freq - comp.freq)
            if (fd < bestDiff) { bestDiff = fd; parentBranch = br }
        }
        const startX = parentBranch ? parentBranch.tipX : w * 0.5
        const startY = parentBranch ? parentBranch.tipY : h * 0.88
        const baseAngle = parentBranch ? parentBranch.angle : 0
        const semitones = parentBranch
            ? Math.round(12 * Math.log2(Math.max(comp.freq, 1) / Math.max(parentBranch.freq, 1)))
            : 0
        const absInt = Math.abs(semitones) % 13
        const offsetDeg = _LSYS_ANGLE_TABLE[Math.min(absInt, 11)]
        const sign = semitones >= 0 ? 1 : -1
        const angleOffset = sign * offsetDeg * (Math.PI / 180)
        state.branches.push({
            id: state.nextId++, tipX: startX, tipY: startY,
            angle: baseAngle + angleOffset, freq: comp.freq, note,
            color: rgb, alive: true,
            speed: SPEED * (0.4 + comp.amplitude * 0.8),
            generation: parentBranch ? parentBranch.generation + 1 : 0,
            segments: [],
        })
        state.prevNotes[note] = { freq: comp.freq }
    }
    // Mark ended notes dead
    for (const note in state.prevNotes) {
        if (!curNotes[note]) {
            for (const br of state.branches) {
                if (br.alive && br.note === note) { br.alive = false; break }
            }
            delete state.prevNotes[note]
        }
    }
    // Grow alive branches
    const newSegs = []
    if (dt > 0) {
        for (const br of state.branches) {
            if (!br.alive) continue
            const dist = br.speed * dt
            let nx = br.tipX + Math.sin(br.angle) * dist
            let ny = br.tipY - Math.cos(br.angle) * dist
            if (nx < 0) { nx = -nx; br.angle = -br.angle }
            if (nx > w) { nx = 2 * w - nx; br.angle = -br.angle }
            if (ny < 0) { ny = -ny; br.angle = Math.PI - br.angle }
            if (ny > h) { ny = 2 * h - ny; br.angle = Math.PI - br.angle }
            const seg = { x1: br.tipX, y1: br.tipY, x2: nx, y2: ny, rgb: br.color, gen: br.generation }
            br.segments.push(seg)
            newSegs.push(seg)
            br.tipX = nx; br.tipY = ny
        }
    }
    // Draw
    overlayCtx.globalCompositeOperation = blendMode
    overlayCtx.lineCap = 'round'
    if (persistMode === 1) {
        for (const seg of newSegs) {
            overlayCtx.lineWidth = Math.max(0.7, 2.2 - seg.gen * 0.45)
            overlayCtx.strokeStyle = 'rgba(' + Math.round(seg.rgb[0]) + ',' + Math.round(seg.rgb[1]) + ',' + Math.round(seg.rgb[2]) + ',0.9)'
            overlayCtx.beginPath(); overlayCtx.moveTo(seg.x1, seg.y1); overlayCtx.lineTo(seg.x2, seg.y2); overlayCtx.stroke()
        }
    } else {
        for (const br of state.branches) {
            if (!br.segments.length) continue
            const alpha = br.alive ? 0.88 : 0.4
            overlayCtx.lineWidth = Math.max(0.7, 2.2 - br.generation * 0.45)
            overlayCtx.strokeStyle = 'rgba(' + Math.round(br.color[0]) + ',' + Math.round(br.color[1]) + ',' + Math.round(br.color[2]) + ',' + alpha + ')'
            overlayCtx.beginPath()
            overlayCtx.moveTo(br.segments[0].x1, br.segments[0].y1)
            for (const seg of br.segments) overlayCtx.lineTo(seg.x2, seg.y2)
            overlayCtx.stroke()
        }
    }
    if (state.branches.length > 300) {
        state.branches = state.branches.filter(br => br.alive || br.segments.length > 0)
    }
}

// ── Mode 5: Vector Interval Model (Relative Pathfinding) ──────────────────
// Each note becomes a voice that moves across the canvas; heading changes
// according to the musical interval from its previous pitch.
function _render2DVectorInterval(components, w, h, blendMode, persistMode, time) {
    if (!components.length) return
    if (!_overState.vectorState) {
        _overState.vectorState = { voices: {}, lastTime: time }
    }
    const st = _overState.vectorState
    const dt = Math.min(Math.max(time - st.lastTime, 0), 0.1)
    st.lastTime = time
    const BASE_SPEED = Math.min(w, h) * 0.22
    const RAD_PER_SEMI = 15 * (Math.PI / 180)
    overlayCtx.globalCompositeOperation = blendMode
    overlayCtx.lineCap = 'round'
    overlayCtx.lineJoin = 'round'
    const nowKeys = new Set()
    for (let k = 0; k < components.length; k++) {
        const c = components[k]
        const vKey = c.note + '|' + c.instrument
        nowKeys.add(vKey)
        const rgb = c.color_rgb || [200, 200, 200]
        if (!st.voices[vKey]) {
            st.voices[vKey] = { x: w * 0.5, y: h * 0.5, heading: -Math.PI / 2, lastFreq: c.freq, rgb, lastSeen: time }
        }
        const v = st.voices[vKey]
        v.lastSeen = time; v.rgb = rgb
        const prevX = v.x, prevY = v.y
        if (dt > 0) {
            const semis = Math.round(12 * Math.log2(Math.max(c.freq, 1) / Math.max(v.lastFreq, 1)))
            v.heading += semis * RAD_PER_SEMI
            v.lastFreq = c.freq
            const clarityVal = (c.clarity != null) ? c.clarity : 1.0
            const speed = c.amplitude * Math.min(Math.max(clarityVal, 0.15), 1.0) * BASE_SPEED
            const roughness = Math.min(Math.max(1.0 - clarityVal, 0), 1)
            v.heading += roughness * Math.sin(time * 60 + k * 2.4) * 0.18
            const dist = speed * dt
            v.x += Math.cos(v.heading) * dist
            v.y += Math.sin(v.heading) * dist
            if (v.x < 0) { v.x = w + v.x } else if (v.x > w) { v.x -= w }
            if (v.y < 0) { v.y = h + v.y } else if (v.y > h) { v.y -= h }
            if (dist > 0.5) {
                overlayCtx.lineWidth = Math.max(0.8, 1.8 * c.amplitude)
                overlayCtx.strokeStyle = 'rgba(' + Math.round(rgb[0]) + ',' + Math.round(rgb[1]) + ',' + Math.round(rgb[2]) + ',' + (0.7 + c.amplitude * 0.3).toFixed(2) + ')'
                overlayCtx.beginPath(); overlayCtx.moveTo(prevX, prevY); overlayCtx.lineTo(v.x, v.y); overlayCtx.stroke()
            }
        }
    }
    const releaseTime = params.releaseDecay || 2
    for (const vk in st.voices) {
        if (!nowKeys.has(vk) && (time - st.voices[vk].lastSeen) > releaseTime) delete st.voices[vk]
    }
}

// ── Mode 6: Harmonic Gravity (Attractors & Repulsors) ───────────────────
// Consonant components act as gravity wells; dissonant ones orbit or repel.
function _render2DHarmonicGravity(components, w, h, blendMode, persistMode, time) {
    if (!components.length) return
    if (!_overState.gravityState) {
        _overState.gravityState = { particles: {}, lastTime: time }
    }
    const gst = _overState.gravityState
    const dt = Math.min(Math.max(time - gst.lastTime, 0), 0.08)
    gst.lastTime = time
    // Top 35% by amplitude = anchors
    const sorted = [...components].sort((a, b) => b.amplitude - a.amplitude)
    const anchorCount = Math.max(1, Math.ceil(sorted.length * 0.35))
    const anchors = sorted.slice(0, anchorCount).map(c => {
        const [ax, ay] = _circularPos2D(c, w, h)
        return { x: ax, y: ay, freq: c.freq, amplitude: c.amplitude }
    })
    // Ensure particle for every component
    const nowKeys = new Set()
    for (const c of components) {
        const pk = Math.round(c.freq * 10).toString()
        nowKeys.add(pk)
        if (!gst.particles[pk]) {
            const [px0, py0] = _circularPos2D(c, w, h)
            gst.particles[pk] = { x: px0, y: py0, vx: 0, vy: 0, rgb: c.color_rgb || [200, 200, 200], amplitude: c.amplitude, dissonance: 0 }
        }
        const pt = gst.particles[pk]
        pt.rgb = c.color_rgb || pt.rgb
        pt.amplitude = c.amplitude
        pt.dissonance = Math.min(Math.max((c.ratio_d - 1) / 15, 0), 1)
    }
    overlayCtx.globalCompositeOperation = blendMode
    overlayCtx.lineCap = 'round'
    // Draw gravity wells
    for (const an of anchors) {
        const wellR = 6 + an.amplitude * 12
        const grad = overlayCtx.createRadialGradient(an.x, an.y, 0, an.x, an.y, wellR * 2.5)
        grad.addColorStop(0, 'rgba(255,255,255,0.18)')
        grad.addColorStop(1, 'rgba(255,255,255,0)')
        overlayCtx.fillStyle = grad
        overlayCtx.beginPath(); overlayCtx.arc(an.x, an.y, wellR * 2.5, 0, Math.PI * 2); overlayCtx.fill()
    }
    // Physics + draw satellites
    const GRAV = Math.min(w, h) * 0.18, DAMP = 0.88
    for (const pk in gst.particles) {
        if (!nowKeys.has(pk)) continue
        const pt = gst.particles[pk]
        if (dt > 0) {
            let fx = 0, fy = 0
            for (const an of anchors) {
                const dx = an.x - pt.x, dy = an.y - pt.y
                const dist = Math.hypot(dx, dy) + 1
                const sign = pt.dissonance > 0.5 ? -1 : 1
                const mag = sign * GRAV * an.amplitude / dist
                fx += mag * dx / dist; fy += mag * dy / dist
            }
            pt.vx = (pt.vx + fx * dt) * DAMP
            pt.vy = (pt.vy + fy * dt) * DAMP
            const ox = pt.x, oy = pt.y
            pt.x = Math.min(Math.max(pt.x + pt.vx * dt, 0), w)
            pt.y = Math.min(Math.max(pt.y + pt.vy * dt, 0), h)
            const spd = Math.hypot(pt.vx, pt.vy)
            if (spd > 0.5) {
                overlayCtx.lineWidth = Math.max(0.6, 1.5 * pt.amplitude)
                overlayCtx.strokeStyle = 'rgba(' + Math.round(pt.rgb[0]) + ',' + Math.round(pt.rgb[1]) + ',' + Math.round(pt.rgb[2]) + ',0.8)'
                overlayCtx.beginPath(); overlayCtx.moveTo(ox, oy); overlayCtx.lineTo(pt.x, pt.y); overlayCtx.stroke()
            }
        }
        const dotR = 3 + pt.amplitude * 5
        overlayCtx.fillStyle = 'rgba(' + Math.round(pt.rgb[0]) + ',' + Math.round(pt.rgb[1]) + ',' + Math.round(pt.rgb[2]) + ',0.9)'
        overlayCtx.beginPath(); overlayCtx.arc(pt.x, pt.y, dotR, 0, Math.PI * 2); overlayCtx.fill()
    }
    const releaseTime = params.releaseDecay || 2
    for (const pk in gst.particles) { if (!nowKeys.has(pk)) delete gst.particles[pk] }
}

// ── Mode 8: Amplitude × Stereo × Frequency Color scatter ─────────────
// Each active FFT bin is placed as a dot on a 2-D scatter plot:
//   X = per-bin stereo pan  → left (-1) … right (+1)
//   Y = amplitude            → silent (bottom) … loud (top)
//   Color                   = frequency via the active color scheme
// Dot radius and alpha scale with amplitude for a natural emphasis on peaks.
function _render2DAmpStereo(freqData, gainMult, linThreshold, w, h, blendMode) {
    overlayCtx.globalCompositeOperation = blendMode
    const N = freqData.length
    const sampleRate = audioEngine.ctx?.sampleRate ?? 44100
    const nyquist = sampleRate / 2

    // Axis labels
    overlayCtx.save()
    overlayCtx.globalAlpha = 0.35
    overlayCtx.fillStyle = '#ffffff'
    overlayCtx.font = '11px monospace'
    overlayCtx.textAlign = 'center'
    overlayCtx.fillText('◀ L', w * 0.04, h * 0.5)
    overlayCtx.fillText('R ▶', w * 0.96, h * 0.5)
    overlayCtx.textAlign = 'left'
    overlayCtx.fillText('loud', 6, 14)
    overlayCtx.fillText('soft', 6, h - 4)
    overlayCtx.restore()

    for (let i = 1; i < N; i++) {
        const hz = (i / N) * nyquist
        if (hz < 20 || hz > 20000) continue
        const amp = Math.min((freqData[i] / 255) * gainMult, 1)
        if (amp < linThreshold * 0.8) continue

        // X: per-bin stereo pan in [-1, +1] mapped to [0, w]
        const pan = _perBinPan(i, N)
        const px = ((pan + 1) / 2) * w

        // Y: amplitude [0,1] → top (loud) = 0, bottom (silent) = h
        const py = (1 - amp) * h

        const cr = colorEngine.freqToColor(hz)
        const [r, g, b] = cr.rgb
        const radius = Math.max(1.5, amp * 14)
        const alpha = (0.2 + amp * 0.8).toFixed(2)

        overlayCtx.beginPath()
        overlayCtx.arc(px, py, radius, 0, Math.PI * 2)
        overlayCtx.fillStyle = 'rgba(' + Math.round(r) + ',' + Math.round(g) + ',' + Math.round(b) + ',' + alpha + ')'
        overlayCtx.fill()
    }
}

// ── Mode 9: 2D Amp × Stereo — component-based scatter (2D canvas) ─────────
// Each spectral-peak component is placed as a dot:
//   X = stereo pan  → full left (0) … full right (w)
//   Y = amplitude   → loud (top, 0) … silent (bottom, h)
//   Color           = component colour via active colour scheme
// Painting / Momentary persistence is controlled by _updateOverlay2D.
// Optional physics: chromaticGravity, magneticOrientation, interInstrumental.
// ── Mode 9: 2D Freq × Stereo — raw-bin scatter (2D canvas) ──────────────────
// X = per-bin stereo pan  →  -1 (left edge) … 0 (centre) … +1 (right edge)
// Y = log-frequency pitch →  bass (bottom) … treble (top) — identical to 2D Linear
// Dot size & alpha scale with amplitude. Color from active colour scheme.
// Painting / Momentary handled by _updateOverlay2D before this is called.
function _render2DAmpStereoComponents(freqData, gainMult, linThreshold, w, h, blendMode) {
    overlayCtx.globalCompositeOperation = blendMode
    const N = freqData.length
    const sampleRate = audioEngine.ctx?.sampleRate ?? 44100
    const nyquist = sampleRate / 2
    const LOG_RANGE = Math.log2(16000 / 16)   // octaves from 16 Hz to 16 kHz

    // Axis labels
    overlayCtx.save()
    overlayCtx.globalAlpha = 0.35
    overlayCtx.fillStyle = '#ffffff'
    overlayCtx.font = '11px monospace'
    overlayCtx.textAlign = 'center'
    overlayCtx.fillText('◀ L', w * 0.04, h * 0.5)
    overlayCtx.fillText('R ▶', w * 0.96, h * 0.5)
    overlayCtx.textAlign = 'right'
    overlayCtx.fillText('16k', w - 4, 14)
    overlayCtx.fillText('16', w - 4, h - 4)
    overlayCtx.restore()

    const baseRadius = Math.max(1.5, (params.defaultParticleSize || 4))
    const gravStr = (params.chromaticGravity || 0) / 100
    const magStr = (params.magneticOrientation || 0) / 100

    for (let i = 1; i < N; i++) {
        const hz = (i / N) * nyquist
        if (hz < 16 || hz > 20000) continue
        const amp = Math.min((freqData[i] / 255) * gainMult, 1)
        if (amp < linThreshold * 0.8) continue

        // X: per-bin stereo pan [-1, +1] → [0, w]
        const pan = _perBinPan(i, N)
        let px = ((pan + 1) / 2) * w

        // Y: log-frequency → treble at top, bass at bottom (same as 2D Linear)
        const freqLogNorm = Math.min(Math.log2(Math.max(hz, 16) / 16) / LOG_RANGE, 1)
        let py = (1 - freqLogNorm) * h

        // Chromatic gravity — pull toward canvas centre
        if (gravStr > 0) {
            px = px + (w * 0.5 - px) * gravStr
            py = py + (h * 0.5 - py) * gravStr
        }

        // Magnetic orientation — collapse X toward stereo centre
        if (magStr > 0) {
            px = px + (w * 0.5 - px) * magStr
        }

        const cr = colorEngine.freqToColor(hz)
        const [r, g, b] = cr.rgb
        const radius = Math.max(1, baseRadius * amp)
        const alpha = (0.2 + amp * 0.8).toFixed(2)

        overlayCtx.beginPath()
        overlayCtx.arc(px, py, radius, 0, Math.PI * 2)
        overlayCtx.fillStyle = 'rgba(' + Math.round(r) + ',' + Math.round(g) + ',' + Math.round(b) + ',' + alpha + ')'
        overlayCtx.fill()
    }
}

// ── Mode 7: Phase-Space Orbital (Lissajous Modulation) ─────────────────
// Each spectral peak traces a small Lissajous orbit around its circular
// (pan×consonance) canvas position, using real L/R time-domain data.
function _render2DPhaseOrbit(components, w, h, blendMode, persistMode, time) {
    if (!components.length) return
    const N = 256
    const TWO_PI = 2 * Math.PI
    overlayCtx.globalCompositeOperation = blendMode
    overlayCtx.lineCap = 'round'
    const orbitScale = ((params.defaultParticleSize || 4) / 2) * Math.min(w, h) * 0.08
    const tdL = audioEngine._tdDataL
    const tdR = audioEngine._tdDataR
    const hasStereo = audioEngine.analyserL && tdL && tdL.length > 0
    for (let k = 0; k < components.length; k++) {
        const c = components[k]
        const [baseCX, baseCY] = _circularPos2D(c, w, h)
        const rgb = c.color_rgb || [200, 200, 200]
        overlayCtx.strokeStyle = 'rgba(' + Math.round(rgb[0]) + ',' + Math.round(rgb[1]) + ',' + Math.round(rgb[2]) + ',' + (0.55 + c.amplitude * 0.35).toFixed(2) + ')'
        overlayCtx.lineWidth = Math.max(0.6, 1.2 * c.amplitude)
        overlayCtx.beginPath()
        if (hasStereo) {
            // Real L/R waveform Lissajous centred at this component’s position
            const n2 = Math.min(tdL.length, tdR.length, N)
            for (let n = 0; n < n2; n++) {
                const xl = (tdL[n] - 128) / 128
                const xr = (tdR[n] - 128) / 128
                const px = baseCX + xl * orbitScale * c.amplitude * 2
                const py = baseCY + xr * orbitScale * c.amplitude * 2
                if (n === 0) overlayCtx.moveTo(px, py); else overlayCtx.lineTo(px, py)
            }
        } else {
            // Synthesised orbit from spectral neighbours
            const neighbours = [c, ...components.filter((o, j) => j !== k && o.freq / c.freq >= 0.5 && o.freq / c.freq <= 2.5)]
            const tWindow = Math.max(2.0 / c.freq, 0.005)
            const dt2 = tWindow / N
            for (let n = 0; n < N; n++) {
                const t2 = time + n * dt2
                let xl = 0, xr = 0
                for (const nb of neighbours) {
                    const sig = nb.amplitude * Math.sin(TWO_PI * nb.freq * t2 + (nb.phase || 0))
                    const pan = nb.pan || 0
                    xl += sig * (1.0 - Math.max(pan, 0))
                    xr += sig * (1.0 + Math.min(pan, 0))
                }
                const px = baseCX + xl * orbitScale
                const py = baseCY + xr * orbitScale
                if (n === 0) overlayCtx.moveTo(px, py); else overlayCtx.lineTo(px, py)
            }
        }
        overlayCtx.stroke()
        // Anchor dot
        const dotR = 2 + c.amplitude * 4
        overlayCtx.fillStyle = 'rgba(' + Math.round(rgb[0]) + ',' + Math.round(rgb[1]) + ',' + Math.round(rgb[2]) + ',0.9)'
        overlayCtx.beginPath(); overlayCtx.arc(baseCX, baseCY, dotR, 0, TWO_PI); overlayCtx.fill()
    }
}

// ── Overlay dispatcher — called from animate() for modes 2-9 ────────────────
function _updateOverlay2D(freqData, tonicHz, gainMult, linThreshold, now) {
    const layoutMode = params.layoutMode
    const persistMode = params.persistMode
    const blendMode = params.blendMode || 'screen'
    const isLightBg = blendMode === 'multiply' || blendMode === 'color-burn' || blendMode === 'darken'
    const w = window.innerWidth, h = window.innerHeight
    const time = audioEl.currentTime || now / 1000

    // Detect mode or persist changes — clear canvas and reset state
    if (_overState.lastLayoutMode !== layoutMode) {
        overlayCtx.clearRect(0, 0, w, h)
        if (layoutMode !== 4) _overState.lState = null
        if (layoutMode !== 5) _overState.vectorState = null
        if (layoutMode !== 6) _overState.gravityState = null
        _overState.lastLayoutMode = layoutMode
        _overState.lastPersistMode = persistMode
    }
    if (_overState.lastPersistMode !== persistMode) {
        overlayCtx.clearRect(0, 0, w, h)
        _overState.lastPersistMode = persistMode
    }

    if (persistMode === 0) {
        // Momentary — soft fade trail
        overlayCtx.fillStyle = isLightBg ? 'rgba(245,242,235,0.05)' : 'rgba(10,10,15,0.05)'
        overlayCtx.fillRect(0, 0, w, h)
    }
    // Painting — no clearing; every mark is permanent

    const components = _buildComponents(freqData, tonicHz, gainMult, linThreshold)

    switch (layoutMode) {
        case 2: _render2DChladni(components, w, h, blendMode, persistMode); break
        case 3: _render2DOscilloscope(components, w, h, blendMode, persistMode, time); break
        case 4: _render2DLSystem(components, w, h, blendMode, persistMode, time); break
        case 5: _render2DVectorInterval(components, w, h, blendMode, persistMode, time); break
        case 6: _render2DHarmonicGravity(components, w, h, blendMode, persistMode, time); break
        case 7: _render2DPhaseOrbit(components, w, h, blendMode, persistMode, time); break
        case 8: _render2DAmpStereo(freqData, gainMult, linThreshold, w, h, blendMode); break
        case 9: _render2DAmpStereoComponents(freqData, gainMult, linThreshold, w, h, blendMode); break
    }
}

// ── 6-helper-g  GLOBAL SCENE PHYSICS (blend mode, zoom, tilt, overlays) ──────
//
//  Called once per frame before geometry updates.
//  Maps ALL mixing / advanced params that affect the scene as a whole:
//    blendMode         → THREE.js blending constant on every material
//    fluidDynamics     → camera Z-axis zoom driven by bass energy
//    phaseInterference → scene rotation-Z driven by stereo pan
//    persistMode       → framebuffer clearing strategy (momentary vs painting)
//    atmosphericPressure → _atmosphereMat opacity driven by RMS amplitude
//    lfWash            → _lfWashMat colour+opacity driven by bass colour

function _applyScenePhysics(bass, amplitude, pan, gainMult, now) {
    // ── Blend mode ────────────────────────────────────────────────────────────
    const wantedBlend = params.blendMode
    if (wantedBlend !== _lastBlendMode) {
        const bl = _BLEND_MAP[wantedBlend] ?? THREE.AdditiveBlending
        for (const mat of [particleMat, ringMat, bassMat, scopeMat, webMat]) {
            mat.blending = bl
            mat.needsUpdate = true
        }
        _lastBlendMode = wantedBlend
    }

    // ── Fluid dynamics: bass-driven camera zoom ───────────────────────────────
    const baseZ = 120
    const fluidStr = params.fluidDynamics / 100
    const targetZ = baseZ + fluidStr * bass * gainMult * 30
    camera.position.z += (targetZ - camera.position.z) * 0.07   // smooth lerp

    // ── Phase interference: stereo pan → scene Z rotation ────────────────────
    const phaseStr = params.phaseInterference / 100
    const targetRot = (phaseStr * pan * 4 * Math.PI) / 180
    scene.rotation.z += (targetRot - scene.rotation.z) * 0.05

    // ── Atmospheric pressure: RMS-driven haze inside the view ────────────────
    const atmoStr = params.atmosphericPressure / 100
    _atmosphereMat.opacity = atmoStr * amplitude * gainMult * 0.13

    // ── LF Wash: background tinted to dominant bass colour ────────────────────
    const lfStr = params.lfWash / 100
    if (lfStr > 0.01 && bass > 0.04) {
        const bassHz = 55 + bass * 195          // map bass energy → Hz in bass range
        const cr = colorEngine.freqToColor(bassHz)
        _lfWashMat.color.setRGB(cr.rgb[0] / 255, cr.rgb[1] / 255, cr.rgb[2] / 255)
        _lfWashMat.opacity = lfStr * bass * gainMult * 0.13
    } else {
        _lfWashMat.opacity = 0
    }

    // ── persistMode: set fade-plane opacity ──────────────────────────────────
    // Momentary (0): fade plane draws a semi-transparent black quad each frame
    //   → exact fade speed tied to releaseDecay: fast decay = stronger fade
    // Painting (1):  fade opacity = 0 → particles accumulate indefinitely
    if (params.persistMode === 1) {
        _fadeMat.opacity = 0
    } else {
        // 2^(-1/60 / halfLife) gives per-frame decay factor → invert for overlay opacity
        const hl = Math.max(params.releaseDecay, 0.05)
        const perFrameDecay = Math.pow(0.5, 1 / (60 * hl))
        _fadeMat.opacity = Math.min(0.25, 1 - perFrameDecay)
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// ── 6  MAIN rAF LOOP
// ─────────────────────────────────────────────────────────────────────────────

let frameCount = 0
let lastFrameMs = performance.now()

function animate() {
    requestAnimationFrame(animate)
    frameCount++
    const now = performance.now()
    lastFrameMs = now

    // ── Read live Web Audio data ────────────────────────────────────────────
    audioEngine.update()
    const { bass, mid, high, amplitude, peakFreq,
        frequencyData, timeDomainData, pan } = audioEngine

    const rules = bridge.rules
    const tonicHz = rules.tonicHz ?? DEFAULT_TONIC_HZ
    const gainMult = params.inputGain
    const linThreshold = Math.pow(10, params.amplitudeThreshold / 20)  // dBFS → linear
    // isPlaying is the module-level let — tracks actual play/pause state via button + 'ended'
    const layoutMode = params.layoutMode
    // Modes 2-9 use the 2-D overlay canvas.
    const useOverlay = layoutMode >= 2

    // Show/hide the 2-D overlay canvas based on layout mode
    overlayCanvas.style.display = useOverlay ? 'block' : 'none'

    // ── Apply all global scene physics (blend, zoom, tilt, atmo, lfWash) ─────
    _applyScenePhysics(bass, amplitude, pan, gainMult, now)

    // ── Three.js render pass (used for modes 0 and 1) ──────────────────────
    if (!useOverlay) {
        if (params.persistMode === 1) {
            renderer.clearDepth()
        } else {
            renderer.clear()
        }
        renderer.render(_bgScene, _bgCamera)

        if (isPlaying) {
            _updateParticles(frequencyData, tonicHz, gainMult, linThreshold, now)
        } else {
            _idleParticles(now)
        }
        _attrPos.needsUpdate = true
        _attrCol.needsUpdate = true
        _attrSz.needsUpdate = true
        _attrAlpha.needsUpdate = true

        const peakHueDeg = isPlaying && peakFreq > 0
            ? freqToHue(peakFreq) : (frameCount * 0.25) % 360
        const spatial = isPlaying && peakFreq > 0
            ? computeSpatial(peakFreq, 0, tonicHz, 1.8)
            : { ratio_n: 1, ratio_d: 1, radius: 0, angle: 0, x: 0, y: 0 }
        const clarity = ratioToClarity(spatial.ratio_n, spatial.ratio_d)
        const satMin = params.saturationFloor / 100

        renderer.render(scene, camera)
    }

    // Spectrum analyser side-panel — always updated regardless of layout mode
    _updateSpectrumPanel(frequencyData)

    // ── 2-D overlay render pass (modes 2-7) ──────────────────────────────
    if (useOverlay && isPlaying) {
        _updateOverlay2D(frequencyData, tonicHz, gainMult, linThreshold, now)
    } else if (useOverlay && !isPlaying) {
        // No audio: show a dim idle label instead of blank screen
        if (frameCount % 120 === 0) {
            overlayCtx.clearRect(0, 0, window.innerWidth, window.innerHeight)
            overlayCtx.fillStyle = 'rgba(255,255,255,0.06)'
            overlayCtx.font = '13px Segoe UI, system-ui, sans-serif'
            overlayCtx.textAlign = 'center'
            overlayCtx.fillText('Load audio to begin', window.innerWidth / 2, window.innerHeight / 2)
        }
    }

    // Composite both canvases into merge canvas (for recording — covers all layout modes)
    _updateMergeCanvas()

    // ── HUD update (~10 fps) ────────────────────────────────────────────────
    if (frameCount % 6 === 0) {
        readBass.textContent = (bass * 100).toFixed(0) + '%'
        readMid.textContent = (mid * 100).toFixed(0) + '%'
        readHigh.textContent = (high * 100).toFixed(0) + '%'
        const peakNote = isPlaying && peakFreq > 0 ? freqToNote(peakFreq) : '–'
        const peakSpatial = isPlaying && peakFreq > 0
            ? computeSpatial(peakFreq, 0, tonicHz, 1.8) : { ratio_n: 1, ratio_d: 1 }
        readPeak.textContent = isPlaying && peakFreq > 0
            ? `${peakFreq} Hz (${peakNote} — ${peakSpatial.ratio_n}/${peakSpatial.ratio_d})`
            : '–'
        if (audioEl.duration)
            audioTimeEl.textContent = `${fmtTime(audioEl.currentTime)} / ${fmtTime(audioEl.duration)}`
    }

    // Three.js frame is already rendered above inside the !useOverlay block
}

// ─────────────────────────────────────────────────────────────────────────────
// § 7  CONTROL PANEL INIT + PARAMS → WEBSOCKET FORWARDING
// ─────────────────────────────────────────────────────────────────────────────

// Mount the vanilla-JS Global Parameter Matrix UI into the sidebar element.
initControlPanel(document.getElementById('control-panel'))

// Forward every parameter change to the backend over WebSocket.
// The backend can use these to store presets or feed future server-side logic.
subscribe((snapshot) => {
    bridge.send({ type: 'params_update', payload: snapshot })
})

// ── Spectrum panel toggle ─────────────────────────────────────────────────────
// Initialise button text to match the starting state (panel starts collapsed)
spectrumToggle.textContent = '▶'
spectrumToggle.addEventListener('click', () => {
    spectrumPanel.classList.toggle('collapsed')
    spectrumToggle.textContent = spectrumPanel.classList.contains('collapsed') ? '▶' : '◀'
})

// ── Save PNG ──────────────────────────────────────────────────────────────────
btnSavePng.addEventListener('click', _savePNG)

// ── Record MP4 (WebM + audio) ─────────────────────────────────────────────────
btnRecord.addEventListener('click', () => {
    if (_recorder) {
        _stopRecording()
    } else {
        // Ensure AudioContext exists before recording
        audioEngine.init(audioEl)
        _startRecording()
    }
})

// ── Resize spectrum canvas when panel size changes ────────────────────────────
function _resizeSpectrumCanvas() {
    const rect = spectrumPanel.getBoundingClientRect()
    spectrumCanvas.width = Math.round(rect.width)
    spectrumCanvas.height = Math.max(1, Math.round(rect.height - 26))  // minus header
}
window.addEventListener('resize', _resizeSpectrumCanvas)
_resizeSpectrumCanvas()

animate()

console.log(
    '%c SEESOUND — GPU render loop active. Load an audio file to start. ',
    'background:#111;color:#4ade80;padding:4px 8px;border-radius:4px;font-weight:bold'
)
console.log(
    '%c Scene: ShaderMaterial particles (1024 bins)\n' +
    ' Spectrum panel: log-scale left sidebar\n' +
    ' Save: PNG (composite) | Record: WebM+audio\n' +
    ' Painting mode: one-shot GPU accumulation via autoClear=false',
    'color:#93c5fd;font-size:11px'
)
