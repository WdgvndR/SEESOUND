/* eslint-disable */
/**
 * SEESOUND – Three.js 3D Rendering Engine  (Layout Mode 8: "Deep Space")
 *
 * Five GPU-class features not possible with HTML Canvas:
 *   1. Z-Axis temporal displacement  – audio history tunnel
 *   2. InstancedMesh                 – 50 k instanced particles at 60 fps
 *   3. Frequency → Depth mapping     – bass far, treble near
 *   4. Post-processing               – UnrealBloom + Afterimage
 *   5. Camera kinematics             – audio-reactive FOV + orbital rotation
 */

import * as THREE from 'three'
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js'
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js'
import { AfterimagePass } from 'three/addons/postprocessing/AfterimagePass.js'
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js'

// ─── tuning constants ────────────────────────────────────────────────────────
const HISTORY_DEPTH = 80          // frames kept in the Z-tunnel
const Z_STEP = 0.7         // world-units between consecutive time slices
const MAX_INSTANCES = 50_000      // InstancedMesh capacity
const BASE_FOV = 75          // default camera FOV (degrees)
const FOV_KICK = 18          // max FOV expansion on kick drums
const ORBIT_SPEED = 0.00015     // radians per ms of orbital camera drift
const BLOOM_BASE = 0.4         // minimum bloom strength
const BLOOM_SCALE = 2.8         // max *additional* bloom from loud transients
const AFTERIMAGE_BASE = 0.82        // persistence damp when quiet
const AFTERIMAGE_MIN = 0.55        // most ephemeral damp on loud hits

// ─── helpers ────────────────────────────────────────────────────────────────
function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)) }
function lerp(a, b, t) { return a + (b - a) * t }

/**
 * Normalise a frequency to 0-1 on a log scale over 16Hz – 16kHz.
 * Returns 0 for bass, 1 for treble.
 */
function freqLogNorm(freq) {
    return clamp(Math.log2(Math.max(freq, 16) / 16) / Math.log2(1000), 0, 1)
}

// ─── main engine ─────────────────────────────────────────────────────────────
export class ThreeEngine {
    /**
     * @param {HTMLElement} container  – a `<div>` that will receive the
     *                                   WebGL canvas as a child element.
     */
    constructor(container) {
        this.container = container
        this.destroyed = false
        this._ready = false   // set true once WebGL is confirmed working

        // ── renderer ──────────────────────────────────────────────────────
        try {
            this.renderer = new THREE.WebGLRenderer({
                antialias: true,
                alpha: false,
                preserveDrawingBuffer: true,   // required for PNG save + captureStream
            })
        } catch (err) {
            console.error('[ThreeEngine] WebGL unavailable:', err)
            this.renderer = null
            return   // bail – _loop will never start, engine is a no-op
        }
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
        this.renderer.toneMapping = THREE.ACESFilmicToneMapping
        this.renderer.toneMappingExposure = 1.0
        container.appendChild(this.renderer.domElement)
        this._applyContainerSize()

        // ── scene ─────────────────────────────────────────────────────────
        this.scene = new THREE.Scene()
        this.scene.background = new THREE.Color(0x060608)
        this.scene.fog = new THREE.FogExp2(0x060608, 0.018)

        // ── camera ────────────────────────────────────────────────────────
        const { w, h } = this._containerSize()
        this.camera = new THREE.PerspectiveCamera(BASE_FOV, w / h, 0.1, 300)
        this.camera.position.set(0, 0, 12)
        this.camera.lookAt(0, 0, 0)

        // ── instanced particles ───────────────────────────────────────────
        // Shared geometry: icosahedron approximates a sphere cheaply
        const geo = new THREE.IcosahedronGeometry(1, 0)  // radius 1, detail 0 (20 faces)
        // Single material – colour set per-instance via InstancedMesh colour buffer
        this.mat = new THREE.MeshStandardMaterial({
            roughness: 0.5,
            metalness: 0.3,
            vertexColors: false,
        })
        this.instancedMesh = new THREE.InstancedMesh(geo, this.mat, MAX_INSTANCES)
        this.instancedMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
        this.instancedMesh.count = 0
        this.scene.add(this.instancedMesh)

        // ── ambient + directional lighting ────────────────────────────────
        const ambient = new THREE.AmbientLight(0xffffff, 0.4)
        this.scene.add(ambient)
        const dirLight = new THREE.DirectionalLight(0xffffff, 1.2)
        dirLight.position.set(5, 10, 8)
        this.scene.add(dirLight)
        // Second fill from below for glow-like rim
        const rimLight = new THREE.DirectionalLight(0x8080ff, 0.5)
        rimLight.position.set(-5, -5, 2)
        this.scene.add(rimLight)

        // ── post-processing ───────────────────────────────────────────────
        this.composer = new EffectComposer(this.renderer)
        const renderPass = new RenderPass(this.scene, this.camera)
        this.composer.addPass(renderPass)

        this.afterimagePass = new AfterimagePass(AFTERIMAGE_BASE)
        this.composer.addPass(this.afterimagePass)

        const size = new THREE.Vector2(w, h)
        this.bloomPass = new UnrealBloomPass(size, BLOOM_BASE, 0.5, 0.1)
        this.composer.addPass(this.bloomPass)

        const outputPass = new OutputPass()
        this.composer.addPass(outputPass)

        // ── tube geometry store ───────────────────────────────────────────
        // Sustained notes (duration > threshold) get a TubeGeometry overlay
        this._tubeMeshes = []        // active tube meshes
        this._tubeMat = new THREE.MeshStandardMaterial({
            roughness: 0.3,
            metalness: 0.6,
            transparent: true,
            opacity: 0.5,
            side: THREE.DoubleSide,
        })

        // ── state ─────────────────────────────────────────────────────────
        // Ring buffer of audio frames (latest at index [head])
        this._history = []       // array of frame objects (components, rms_db, …)
        this._maxHistory = HISTORY_DEPTH
        this.trackDuration = 0

        // Smoothed audio reactive values for camera
        this._fov = BASE_FOV
        this._orbitAngle = 0
        this._orbitRadius = 12
        this._rmsSmooth = 0
        this._bassSmooth = 0

        // Internal fps counter
        this.fps = 0
        this._lastT = 0
        this._frameCount = 0

        // ── resize observer ───────────────────────────────────────────────
        this._ro = new ResizeObserver(() => this._applyContainerSize())
        this._ro.observe(container)

        // All setup complete — allow the render loop to call _tick()
        this._ready = true

        // ── start the render loop ─────────────────────────────────────────
        this._rafId = requestAnimationFrame(this._loop.bind(this))
    }

    // ── public API (mirrors RenderEngine) ────────────────────────────────────

    setTrackDuration(dur) {
        this.trackDuration = (dur && dur > 0) ? dur : 0
    }

    /** Called by App's playback loop every audio frame. */
    renderFrame(frame, params, audioTime, trackDuration) {
        if (this.destroyed) return
        // Store the incoming audio frame so the Three.js loop can consume it.
        this._pushFrame(frame, params)
    }

    clear() {
        this._history = []
        this._removeAllTubes()
        if (this.instancedMesh) this.instancedMesh.count = 0
    }

    resize() {
        this._applyContainerSize()
    }

    /** No-op stub – kept for API parity with RenderEngine. */
    setGraphEvaluator() { }

    destroy() {
        this.destroyed = true
        if (this._rafId) cancelAnimationFrame(this._rafId)
        if (this._ro) this._ro.disconnect()
        try { this.composer?.dispose() } catch (_) { }
        try { this.instancedMesh?.geometry.dispose() } catch (_) { }
        try { this.mat?.dispose() } catch (_) { }
        try { this._tubeMat?.dispose() } catch (_) { }
        try { this._removeAllTubes() } catch (_) { }
        try { this.renderer?.dispose() } catch (_) { }
        if (this.renderer?.domElement?.parentNode) {
            this.renderer.domElement.parentNode.removeChild(this.renderer.domElement)
        }
    }

    // ── private helpers ───────────────────────────────────────────────────────

    _containerSize() {
        const w = this.container.clientWidth || 800
        const h = this.container.clientHeight || 450
        return { w, h }
    }

    _applyContainerSize() {
        const { w, h } = this._containerSize()
        if (w < 1 || h < 1) return
        this.renderer.setSize(w, h)
        if (this.composer) this.composer.setSize(w, h)
        if (this.camera) {
            this.camera.aspect = w / h
            this.camera.updateProjectionMatrix()
        }
    }

    /** Add a frame to the temporal history ring buffer. */
    _pushFrame(frame, params) {
        this._history.push({ frame, params })
        if (this._history.length > this._maxHistory) {
            this._history.shift()
        }
    }

    /** Remove all TubeMesh overlays from the scene. */
    _removeAllTubes() {
        for (const m of this._tubeMeshes) {
            this.scene.remove(m)
            m.geometry.dispose()
            m.material.dispose()   // each tube has a cloned material — must dispose
        }
        this._tubeMeshes = []
    }

    // ── Three.js render loop ──────────────────────────────────────────────────
    _loop(nowMs) {
        if (this.destroyed) return
        this._rafId = requestAnimationFrame(this._loop.bind(this))
        // If constructor failed (no renderer) skip silently
        if (!this._ready || !this.renderer) return

        try {
            this._tick(nowMs)
        } catch (err) {
            console.error('[ThreeEngine] _loop error:', err)
        }
    }

    /** Inner tick – all logic here so errors don’t kill the rAF loop. */
    _tick(nowMs) {
        // fps + delta time
        const dt = this._lastT > 0 ? nowMs - this._lastT : 16
        if (this._lastT > 0) {
            this.fps = lerp(this.fps, 1000 / dt, 0.1)
        }
        this._lastT = nowMs
        this._frameCount++

        const hist = this._history
        if (!hist.length) {
            if (this.composer) this.composer.render()
            else this.renderer.render(this.scene, this.camera)
            return
        }

        // Latest frame is always at the end
        const latest = hist[hist.length - 1]
        const frame = latest.frame
        const params = latest.params

        // ── smoothed audio reactive values ────────────────────────────────
        const rmsDb = frame.rms_db != null ? frame.rms_db : -60
        const rmsNorm = clamp((rmsDb + 60) / 60, 0, 1)
        this._rmsSmooth = lerp(this._rmsSmooth, rmsNorm, 0.15)

        const components = frame.components || []
        const bassComps = components.filter(c => c.freq < 150)
        const bassEnergy = bassComps.reduce((s, c) => s + c.amplitude, 0)
        this._bassSmooth = lerp(this._bassSmooth, clamp(bassEnergy, 0, 1), 0.2)

        // ── 5. Camera kinematics ──────────────────────────────────────────
        // Audio-reactive FOV: kick drums rapidly expand field of view
        const targetFov = BASE_FOV + this._bassSmooth * FOV_KICK
        this._fov = lerp(this._fov, targetFov, 0.08)
        this.camera.fov = this._fov
        this.camera.updateProjectionMatrix()

        // Slow orbital rotation around the Z-axis (pan around the tunnel)
        const orbitSpeed = params.fluidDynamics != null
            ? ORBIT_SPEED * (0.3 + (params.fluidDynamics / 100) * 1.7)
            : ORBIT_SPEED
        this._orbitAngle += orbitSpeed * dt
        const camR = this._orbitRadius
        const camEl = 0.08                          // slight elevation
        this.camera.position.set(
            Math.sin(this._orbitAngle) * camR,
            camEl * camR,
            Math.cos(this._orbitAngle) * camR,
        )
        this.camera.lookAt(0, 0, -HISTORY_DEPTH * Z_STEP * 0.4)

        // ── 4. Post-processing: bloom + afterimage ────────────────────────
        if (this.bloomPass) {
            this.bloomPass.strength = BLOOM_BASE + this._rmsSmooth * BLOOM_SCALE
        }
        if (this.afterimagePass) {
            // Afterimage damp: high rms = more ephemeral (lower damp = faster fade)
            this.afterimagePass.uniforms['damp'].value =
                lerp(AFTERIMAGE_BASE, AFTERIMAGE_MIN, this._rmsSmooth)
        }

        // ── 1+2+3. InstancedMesh: temporal displacement + particles ─────────
        this._buildInstances(hist, params)

        // ── TubeGeometry overlay for sustained notes ─────────────────────
        this._updateTubes(hist, params)

        if (this.composer) this.composer.render()
        else this.renderer.render(this.scene, this.camera)
    }

    /**
     * Rebuild the InstancedMesh each frame from the history buffer.
     * Each history slot is placed at a different Z position (temporal tunnel).
     */
    _buildInstances(hist, params) {
        const inputGain = params.inputGain != null ? params.inputGain : 1.0
        const baseSize = params.defaultParticleSize != null ? params.defaultParticleSize : 4
        // Convert CSS-pixel base size to world-unit radius
        const baseRadius = baseSize * 0.006

        const dummy = new THREE.Object3D()
        const color = new THREE.Color()
        const totalSlots = hist.length

        let idx = 0

        for (let si = 0; si < totalSlots; si++) {
            const slotAge = totalSlots - 1 - si   // 0 = newest, N-1 = oldest
            const { frame, params: p } = hist[si]
            const comps = frame.components || []
            const ageFrac = slotAge / Math.max(totalSlots - 1, 1)  // 0..1

            // ── 1. Z-Axis temporal displacement ───────────────────────────
            // Newest at z = 0, oldest at z = -(HISTORY_DEPTH-1)*Z_STEP
            const zSlot = -slotAge * Z_STEP

            // slot fade: older = dimmer
            const slotAlpha = Math.pow(1 - ageFrac, 1.5)

            for (let ci = 0; ci < comps.length; ci++) {
                const c = comps[ci]
                if (!c) continue
                if (idx >= MAX_INSTANCES) break

                const amp = clamp(c.amplitude * inputGain, 0, 1)
                if (amp < 0.01) continue

                // ── 3. Frequency → Depth mapping ─────────────────────────
                // On TOP of slot Z, add a per-component depth bias:
                // bass  → pushed further into background (more negative Z)
                // treble → pulled toward camera (less negative Z)
                const fNorm = freqLogNorm(c.freq)            // 0=bass,1=treble
                const freqZ = (1 - fNorm) * -3.5             // bass extra -3.5, treble 0

                // 2D layout in X/Y: pan (c.x) → horizontal, consonance (c.y) → vertical
                // Field Rendering param widens the horizontal spread
                const spreadMul = p.fieldRendering != null ? (0.7 + (p.fieldRendering / 100) * 0.6) : 1.0
                const cx = clamp(c.x, -1, 1) * 6 * (0.4 + fNorm * 0.6) * spreadMul
                const cy = clamp(c.y, -1, 1) * 4
                const cz = zSlot + freqZ

                // ── 2. Per-instance transform (InstancedMesh) ─────────────
                dummy.position.set(cx, cy, cz)
                const radius = baseRadius * amp * (1 + (1 - fNorm) * 1.5) * slotAlpha
                dummy.scale.setScalar(Math.max(radius, 0.002))
                dummy.rotation.set(fNorm * Math.PI, ageFrac * Math.PI, 0)
                dummy.updateMatrix()
                this.instancedMesh.setMatrixAt(idx, dummy.matrix)

                // colour from audio analysis
                const rgb = c.color_rgb || [200, 200, 255]
                color.setRGB(
                    (rgb[0] / 255) * slotAlpha,
                    (rgb[1] / 255) * slotAlpha,
                    (rgb[2] / 255) * slotAlpha,
                )
                this.instancedMesh.setColorAt(idx, color)
                idx++
            }
            if (idx >= MAX_INSTANCES) break
        }

        this.instancedMesh.count = idx
        this.instancedMesh.instanceMatrix.needsUpdate = true
        if (this.instancedMesh.instanceColor) {
            this.instancedMesh.instanceColor.needsUpdate = true
        }
    }

    /**
     * Build TubeGeometry splines for the most prominent sustained notes.
     * We find components that appear in ≥ 30% of history slots and extrude a
     * CatmullRomCurve3 along their trajectory through Z-space.
     */
    _updateTubes(hist, params) {
        // Rebuild tubes every 12th frame to avoid per-frame geometry churn
        if (this._frameCount % 12 !== 0) return
        this._removeAllTubes()
        if (hist.length < 4) return

        const inputGain = params.inputGain != null ? params.inputGain : 1.0

        // Build a note→positions map across history
        const noteTrack = new Map()   // note → [{x,y,z,amp,rgb}]
        const total = hist.length

        for (let si = 0; si < total; si++) {
            const slotAge = total - 1 - si
            const zSlot = -slotAge * Z_STEP
            const { frame } = hist[si]
            const comps = frame.components || []
            for (const c of comps) {
                const amp = clamp(c.amplitude * inputGain, 0, 1)
                if (amp < 0.05) continue
                const fNorm = freqLogNorm(c.freq)
                const cx = clamp(c.x, -1, 1) * 6 * (0.4 + fNorm * 0.6)
                const cy = clamp(c.y, -1, 1) * 4
                const cz = zSlot + (1 - fNorm) * -3.5
                if (!noteTrack.has(c.note)) noteTrack.set(c.note, [])
                noteTrack.get(c.note).push({ x: cx, y: cy, z: cz, amp, rgb: c.color_rgb || [200, 200, 255] })
            }
        }

        // Only extrude notes present in ≥ 30% of slots and with ≥ 4 sample points
        const minSlots = Math.max(4, Math.round(total * 0.3))
        for (const [, pts] of noteTrack) {
            if (pts.length < minSlots) continue
            // Sub-sample to at most 20 control points for CatmullRomCurve3
            const step = Math.ceil(pts.length / 20)
            const ctrlPts = []
            for (let pi = 0; pi < pts.length; pi += step) {
                ctrlPts.push(new THREE.Vector3(pts[pi].x, pts[pi].y, pts[pi].z))
            }
            if (ctrlPts.length < 3) continue

            const curve = new THREE.CatmullRomCurve3(ctrlPts)
            const avgAmp = pts.reduce((s, p) => s + p.amp, 0) / pts.length
            // Radius modulated by average amplitude of the sustained note
            const tubR = 0.03 + avgAmp * 0.12

            const tubeGeo = new THREE.TubeGeometry(curve, ctrlPts.length * 3, tubR, 6, false)
            const avgRgb = pts[Math.floor(pts.length / 2)].rgb
            const tubeMat = this._tubeMat.clone()
            tubeMat.color.setRGB(avgRgb[0] / 255, avgRgb[1] / 255, avgRgb[2] / 255)
            tubeMat.emissive.setRGB(avgRgb[0] / 512, avgRgb[1] / 512, avgRgb[2] / 512)
            const mesh = new THREE.Mesh(tubeGeo, tubeMat)
            this.scene.add(mesh)
            this._tubeMeshes.push(mesh)
        }
    }
}
