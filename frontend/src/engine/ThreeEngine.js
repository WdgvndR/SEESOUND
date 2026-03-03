/* eslint-disable */
/**
 * SEESOUND – Three.js 3D Rendering Engine  (Layout Modes 3–6)
 *
 *   3 = 3D Holistic   – particle cloud in free space
 *   4 = 3D Linear     – left→right X, log-freq Y, Z-depth temporal tunnel
 *   5 = 3D Spiral     – helix combining linear + circular
 *   6 = 3D L-System   – fractal tree on a 3D plane, bounding-box PNG export
 *
 * GPU features: InstancedMesh · UnrealBloom · Afterimage · camera kinematics
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
        this.camera.position.set(0, 0, 40)
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

        // 3D L-System state
        this._lState3d = null

        // Smoothed audio reactive values for camera
        this._fov = BASE_FOV
        this._orbitAngle = 0
        this._orbitRadius = 40
        this._rmsSmooth = 0
        this._bassSmooth = 0

        // Callback set by App to sync camera sliders when mouse overrides fire
        this.onCameraChange = null   // (azDeg, elDeg, dist) => void
        this._lastLookAtZ = 0      // updated each _tick so flush can use it

        // Internal fps counter
        this.fps = 0
        this._lastT = 0
        this._frameCount = 0

        // ── resize observer ───────────────────────────────────────────────
        this._ro = new ResizeObserver(() => this._applyContainerSize())
        this._ro.observe(container)

        // ── mouse / touch camera controls ──────────────────────────────────
        // Left-drag  → pan (shift lookAt + camera together)
        // Right-drag → orbit (azimuth + elevation)
        // Scroll / two-finger pinch → zoom (distance multiplier)
        // Double-click → reset overrides
        this._camAzExtra = 0                   // extra azimuth  (radians)
        this._camElExtra = 0                   // extra elevation (radians)
        this._camDistMul = 1                   // zoom multiplier
        this._camPan = new THREE.Vector3() // world-space pan offset
        this._dragState = { active: false, button: -1, lastX: 0, lastY: 0 }
        this._pinchLast = 0

        const _canvas = this.renderer.domElement
        _canvas.style.cursor = 'grab'

        const _onMouseDown = (e) => {
            if (e.button === 0 || e.button === 2) {
                this._dragState = { active: true, button: e.button, lastX: e.clientX, lastY: e.clientY }
                _canvas.style.cursor = 'grabbing'
                e.preventDefault()
            }
        }
        const _onMouseMove = (e) => {
            if (!this._dragState.active) return
            const dx = e.clientX - this._dragState.lastX
            const dy = e.clientY - this._dragState.lastY
            this._dragState.lastX = e.clientX
            this._dragState.lastY = e.clientY

            if (this._dragState.button === 2) {
                // Right-drag: orbit
                this._camAzExtra -= dx * 0.007
                this._camElExtra = clamp(this._camElExtra - dy * 0.005, -Math.PI * 0.48, Math.PI * 0.48)
            } else {
                // Left-drag: pan in camera-right / camera-up
                const dist = (this._history.length
                    ? (this._history[this._history.length - 1].params?.cameraDistance ?? 40)
                    : 40) * this._camDistMul
                const scale = dist * 0.0018
                const right = new THREE.Vector3()
                const up = new THREE.Vector3()
                const fwd = new THREE.Vector3()
                this.camera.getWorldDirection(fwd)
                right.crossVectors(fwd, this.camera.up).normalize()
                up.copy(this.camera.up).normalize()
                this._camPan.addScaledVector(right, -dx * scale)
                this._camPan.addScaledVector(up, dy * scale)
            }
        }
        const _onMouseUp = () => {
            if (this._dragState.active) {
                // Fold any accumulated orbit / zoom overrides back into the param sliders
                this._flushCameraToParams()
            }
            this._dragState.active = false
            _canvas.style.cursor = 'grab'
        }
        const _onWheel = (e) => {
            e.preventDefault()
            const factor = e.deltaY > 0 ? 1.1 : (1 / 1.1)
            this._camDistMul = clamp(this._camDistMul * factor, 0.05, 30)
            // Debounce: flush to sliders 350 ms after wheel stops
            clearTimeout(this._wheelFlushTimer)
            this._wheelFlushTimer = setTimeout(() => this._flushCameraToParams(), 350)
        }
        const _onContextMenu = (e) => e.preventDefault()
        const _onDblClick = () => {
            this._camAzExtra = 0
            this._camElExtra = 0
            this._camDistMul = 1
            this._camPan.set(0, 0, 0)
            clearTimeout(this._wheelFlushTimer)
            // Signal App to reset sliders too — emit the base param values as-is
            if (this.onCameraChange) {
                const p = this._history.length ? this._history[this._history.length - 1].params : null
                if (p) this.onCameraChange(
                    parseFloat((p.cameraAzimuth ?? 0).toFixed(1)),
                    parseFloat((p.cameraElevation ?? 5).toFixed(1)),
                    parseFloat((p.cameraDistance ?? 40).toFixed(2)),
                )
            }
        }
        const _onTouchStart = (e) => {
            if (e.touches.length === 2) {
                const dx = e.touches[0].clientX - e.touches[1].clientX
                const dy = e.touches[0].clientY - e.touches[1].clientY
                this._pinchLast = Math.hypot(dx, dy)
            }
        }
        const _onTouchMove = (e) => {
            if (e.touches.length === 2) {
                const dx = e.touches[0].clientX - e.touches[1].clientX
                const dy = e.touches[0].clientY - e.touches[1].clientY
                const dist = Math.hypot(dx, dy)
                if (this._pinchLast > 0) {
                    const ratio = this._pinchLast / dist
                    this._camDistMul = clamp(this._camDistMul * ratio, 0.05, 30)
                }
                this._pinchLast = dist
                e.preventDefault()
            }
        }

        _canvas.addEventListener('mousedown', _onMouseDown)
        _canvas.addEventListener('mousemove', _onMouseMove)
        window.addEventListener('mouseup', _onMouseUp)
        _canvas.addEventListener('wheel', _onWheel, { passive: false })
        _canvas.addEventListener('contextmenu', _onContextMenu)
        _canvas.addEventListener('dblclick', _onDblClick)
        _canvas.addEventListener('touchstart', _onTouchStart, { passive: true })
        _canvas.addEventListener('touchmove', _onTouchMove, { passive: false })

        this._canvasListeners = [
            [_canvas, 'mousedown', _onMouseDown],
            [_canvas, 'mousemove', _onMouseMove],
            [window, 'mouseup', _onMouseUp],
            [_canvas, 'wheel', _onWheel],
            [_canvas, 'contextmenu', _onContextMenu],
            [_canvas, 'dblclick', _onDblClick],
            [_canvas, 'touchstart', _onTouchStart],
            [_canvas, 'touchmove', _onTouchMove],
        ]

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
        this._lState3d = null
        if (this._lsLines3d) {
            for (const ln of this._lsLines3d) { this.scene?.remove(ln); ln.geometry?.dispose(); ln.material?.dispose() }
            this._lsLines3d = []
        }
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
        try {
            if (this._lsLines3d) {
                for (const ln of this._lsLines3d) { this.scene?.remove(ln); ln.geometry?.dispose(); ln.material?.dispose() }
            }
        } catch (_) { }
        try { this.instancedMesh?.geometry.dispose() } catch (_) { }
        try { this.mat?.dispose() } catch (_) { }
        try { this._tubeMat?.dispose() } catch (_) { }
        try { this._removeAllTubes() } catch (_) { }
        if (this._canvasListeners) {
            for (const [el, type, fn] of this._canvasListeners) {
                try { el.removeEventListener(type, fn) } catch (_) { }
            }
        }
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

    /**
     * Read the effective camera spherical position (after all overrides),
     * notify App via onCameraChange so the sliders update, then zero the
     * mouse-override offsets so params become the single source of truth.
     */
    _flushCameraToParams() {
        // Reconstruct position relative to the scene lookAt (strip pan)
        const lookAt = new THREE.Vector3(0, 0, this._lastLookAtZ ?? 0)
        const pos = this.camera.position.clone().sub(this._camPan).sub(lookAt)
        const dist = pos.length() || 1
        // atan2(x, z) gives azimuth in Y-up spherical (0 = forward/+Z)
        const azDeg = Math.atan2(pos.x, pos.z) * 180 / Math.PI
        const elDeg = Math.asin(clamp(pos.y / dist, -1, 1)) * 180 / Math.PI

        // In Auto mode, reset orbit angle so the new azimuth is clean
        const p = this._history.length ? this._history[this._history.length - 1].params : null
        if ((p?.cameraMode ?? 0) === 0) this._orbitAngle = 0

        // Zero all overrides — params are now the ground truth
        this._camAzExtra = 0
        this._camElExtra = 0
        this._camDistMul = 1
        // _camPan is intentionally kept; there are no slider counterparts

        if (this.onCameraChange) {
            this.onCameraChange(
                parseFloat(azDeg.toFixed(1)),
                parseFloat(clamp(elDeg, -89, 89).toFixed(1)),
                parseFloat(dist.toFixed(2)),
            )
        }
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
        // All modes use spherical coordinates → Cartesian, camera always looks at origin.
        const camMode = params.cameraMode ?? 0          // 0=Auto, 1=Manual, 2=Still
        const camFov = params.cameraFov ?? BASE_FOV
        const camDist = params.cameraDistance ?? 40
        const camAzDeg = params.cameraAzimuth ?? 0
        const camElDeg = params.cameraElevation ?? 5

        /** Spherical (az deg, el deg, radius) → { x, y, z }. Camera looks at origin. */
        const _sph = (azDeg, elDeg, r) => {
            const az = azDeg * Math.PI / 180
            const el = elDeg * Math.PI / 180
            return {
                x: r * Math.cos(el) * Math.sin(az),
                y: r * Math.sin(el),
                z: r * Math.cos(el) * Math.cos(az),
            }
        }

        // ── Per-mode lookAt Z: point camera at the temporal centre of the scene ─
        // For tunnel modes (3,4,5) the Z history extends backwards from z=0;
        // looking at the midpoint instead of the near face eliminates the
        // oscilloscope-slice artefact and keeps the full depth framed.
        const _lMode = params.layoutMode ?? 3
        let lookAtZ = 0
        if (_lMode === 3) {
            lookAtZ = -(hist.length - 1) * Z_STEP * 0.5
        } else if (_lMode === 4) {
            const zStep4 = params.lin3dZStep != null ? params.lin3dZStep : Z_STEP
            const depth4 = (params.lin3dHistoryDepth != null
                ? Math.min(hist.length, params.lin3dHistoryDepth)
                : hist.length) - 1
            lookAtZ = -depth4 * zStep4 * 0.5
        } else if (_lMode === 5) {
            const turns5 = params.spiralTurns != null ? params.spiralTurns : 2
            const pitch5 = params.spiralPitch != null ? params.spiralPitch : 1.2
            const depth5 = (params.spiralHistoryDepth != null
                ? Math.min(hist.length, params.spiralHistoryDepth)
                : hist.length) - 1
            lookAtZ = -depth5 * (pitch5 / Math.max(turns5, 0.1)) * 0.5
        }
        this._lastLookAtZ = lookAtZ   // stored for _flushCameraToParams()

        if (camMode === 1) {
            // ── Manual: sliders + arrow keys drive azimuth / elevation / distance ──
            const { x, y, z } = _sph(camAzDeg, camElDeg, camDist)
            this.camera.fov = camFov
            this.camera.updateProjectionMatrix()
            this.camera.position.set(x, y, z + lookAtZ)
            this.camera.lookAt(0, 0, lookAtZ)
        } else if (camMode === 2) {
            // ── Still: same spherical position, zero movement ─────────────────
            const { x, y, z } = _sph(camAzDeg, camElDeg, camDist)
            this.camera.fov = camFov
            this.camera.updateProjectionMatrix()
            this.camera.position.set(x, y, z + lookAtZ)
            this.camera.lookAt(0, 0, lookAtZ)
        } else {
            // ── Auto: audio-reactive orbital drift around scene centre ────────
            const speedMul = params.cameraSpeed != null ? params.cameraSpeed : 1
            const orbitMul = params.cameraOrbit != null ? params.cameraOrbit : 0.5

            // FOV kick on bass hits
            const targetFov = camFov + this._bassSmooth * FOV_KICK
            this._fov = lerp(this._fov, targetFov, 0.08)
            this.camera.fov = this._fov
            this.camera.updateProjectionMatrix()

            // Orbital horizontal drift
            const orbitSpeed = (params.fluidDynamics != null
                ? ORBIT_SPEED * (0.3 + (params.fluidDynamics / 100) * 1.7)
                : ORBIT_SPEED) * Math.abs(orbitMul) * speedMul
            this._orbitAngle += orbitSpeed * dt * (orbitMul < 0 ? -1 : 1)

            // Use sliders as base azimuth offset + elevation in auto mode too
            const baseAz = camAzDeg * Math.PI / 180
            this.camera.position.set(
                camDist * Math.cos(camElDeg * Math.PI / 180) * Math.sin(this._orbitAngle + baseAz),
                camDist * Math.sin(camElDeg * Math.PI / 180),
                camDist * Math.cos(camElDeg * Math.PI / 180) * Math.cos(this._orbitAngle + baseAz) + lookAtZ,
            )
            this.camera.lookAt(0, 0, lookAtZ)
        }

        // ── Apply user mouse / touch camera overrides ─────────────────────
        // Overrides are applied on top of whatever camera mode computed above.
        // _camAzExtra / _camElExtra rotate the camera around the scene lookAt.
        // _camDistMul scales the camera-to-lookAt distance.
        // _camPan shifts both camera and lookAt by the same world-space offset.
        if (this._camAzExtra !== 0 || this._camElExtra !== 0 ||
            this._camDistMul !== 1 || this._camPan.lengthSq() > 0) {
            // Offset from the pre-pan lookAt point to the current camera position
            const baseLookAt = new THREE.Vector3(0, 0, lookAtZ)
            const offset = this.camera.position.clone().sub(baseLookAt)
            const baseLen = offset.length() || 1
            // Decompose to spherical (az around Y, el above XZ plane)
            const baseAz = Math.atan2(offset.x, offset.z)
            const baseEl = Math.asin(clamp(offset.y / baseLen, -1, 1))
            const newR = baseLen * this._camDistMul
            const newAz = baseAz + this._camAzExtra
            const newEl = clamp(baseEl + this._camElExtra, -Math.PI * 0.48, Math.PI * 0.48)
            this.camera.position.set(
                newR * Math.cos(newEl) * Math.sin(newAz),
                newR * Math.sin(newEl),
                newR * Math.cos(newEl) * Math.cos(newAz) + lookAtZ,
            ).add(this._camPan)
            const newLookAt = baseLookAt.add(this._camPan)
            this.camera.lookAt(newLookAt)
        }

        // ── 4. Post-processing: bloom + afterimage ────────────────────────
        // Use param values (with old constant fallbacks for safety)
        const bloomStrength = params.threedBloom != null ? params.threedBloom : BLOOM_BASE
        const afterimageBase = params.threedAfterimage != null ? params.threedAfterimage : AFTERIMAGE_BASE
        const fogDensity = params.threedFogDensity != null ? params.threedFogDensity : 0.018
        if (this.bloomPass) {
            this.bloomPass.strength = bloomStrength + this._rmsSmooth * BLOOM_SCALE * (bloomStrength > 0 ? 1 : 0)
        }
        if (this.afterimagePass) {
            this.afterimagePass.uniforms['damp'].value =
                lerp(afterimageBase, Math.max(afterimageBase - 0.3, 0.3), this._rmsSmooth)
        }
        if (this.scene.fog) {
            this.scene.fog.density = fogDensity
        }

        // ── 1+2+3. InstancedMesh: dispatch by layoutMode ─────────────────
        const layoutMode = params.layoutMode != null ? params.layoutMode : 3
        if (layoutMode === 4) {
            this._buildInstancesLinear(hist, params)
        } else if (layoutMode === 5) {
            this._buildInstancesSpiral(hist, params)
        } else if (layoutMode === 6) {
            this._buildInstancesLSystem3d(hist, params)
        } else {
            // layout 3 = 3D Holistic (original deep space behavior)
            this._buildInstances(hist, params)
        }

        if (this.composer) this.composer.render()
        else this.renderer.render(this.scene, this.camera)
    }

    /**
     * Layout 3 – 3D Holistic: particle cloud in 3D space (original deep space).
     * Uses threedParticleSize, threedSpreadMul, threedFreqDepthBias params.
     */
    _buildInstances(hist, params) {
        const inputGain = params.inputGain != null ? params.inputGain : 1.0
        // threedParticleSize is world-unit radius; default matches old baseSize*0.006
        const baseRadius = params.threedParticleSize != null ? params.threedParticleSize : 0.024
        const spreadMulParam = params.threedSpreadMul != null ? params.threedSpreadMul : 1.0
        const freqDepthBias = params.threedFreqDepthBias != null ? params.threedFreqDepthBias : 3.5

        const dummy = new THREE.Object3D()
        const color = new THREE.Color()
        const totalSlots = hist.length

        let idx = 0

        for (let si = 0; si < totalSlots; si++) {
            const slotAge = totalSlots - 1 - si
            const { frame, params: p } = hist[si]
            const comps = frame.components || []
            const ageFrac = slotAge / Math.max(totalSlots - 1, 1)

            const zSlot = -slotAge * Z_STEP
            const slotAlpha = Math.pow(1 - ageFrac, 1.5)

            for (let ci = 0; ci < comps.length; ci++) {
                const c = comps[ci]
                if (!c) continue
                if (idx >= MAX_INSTANCES) break

                const amp = clamp(c.amplitude * inputGain, 0, 1)
                if (amp < 0.01) continue

                const fNorm = freqLogNorm(c.freq)
                const freqZ = (1 - fNorm) * -freqDepthBias

                const spreadMul = spreadMulParam * (p.fieldRendering != null ? (0.7 + (p.fieldRendering / 100) * 0.6) : 1.0)
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

    /**
     * Layout 4 – 3D Linear: X = time, Y = log-freq, Z = temporal depth tunnel.
     */
    _buildInstancesLinear(hist, params) {
        const inputGain = params.inputGain != null ? params.inputGain : 1.0
        const baseRadius = params.threedParticleSize != null ? params.threedParticleSize : 0.024
        const histDepth = params.lin3dHistoryDepth != null ? params.lin3dHistoryDepth : 80
        const zStep = params.lin3dZStep != null ? params.lin3dZStep : 0.7
        // Clamp history to requested depth
        const hist2 = hist.slice(-histDepth)
        const totalSlots = hist2.length

        const dummy = new THREE.Object3D()
        const color = new THREE.Color()
        let idx = 0

        for (let si = 0; si < totalSlots; si++) {
            const slotAge = totalSlots - 1 - si
            const { frame } = hist2[si]
            const comps = frame.components || []
            const ageFrac = slotAge / Math.max(totalSlots - 1, 1)
            const slotAlpha = Math.pow(1 - ageFrac, 1.5)
            const cz = -slotAge * zStep

            for (let ci = 0; ci < comps.length; ci++) {
                const c = comps[ci]
                if (!c) continue
                if (idx >= MAX_INSTANCES) break
                const amp = clamp(c.amplitude * inputGain, 0, 1)
                if (amp < 0.01) continue
                // X = time position (oldest left, newest right)
                const cx = lerp(-10, 10, 1 - ageFrac)
                // Y = log-frequency (bass bottom, treble top)
                const fNorm = freqLogNorm(c.freq)
                const cy = lerp(-5, 5, fNorm)

                dummy.position.set(cx, cy, cz)
                const r = baseRadius * amp * slotAlpha
                dummy.scale.setScalar(Math.max(r, 0.002))
                dummy.rotation.set(0, 0, 0)
                dummy.updateMatrix()
                this.instancedMesh.setMatrixAt(idx, dummy.matrix)
                const rgb = c.color_rgb || [200, 200, 255]
                color.setRGB((rgb[0] / 255) * slotAlpha, (rgb[1] / 255) * slotAlpha, (rgb[2] / 255) * slotAlpha)
                this.instancedMesh.setColorAt(idx, color)
                idx++
            }
            if (idx >= MAX_INSTANCES) break
        }
        this.instancedMesh.count = idx
        this.instancedMesh.instanceMatrix.needsUpdate = true
        if (this.instancedMesh.instanceColor) this.instancedMesh.instanceColor.needsUpdate = true
    }

    /**
     * Layout 5 – 3D Spiral: helix combining linear (Z=time) + circular (angle=freq).
     * Position: angle = freqLogNorm * turns * 2π; radius = spiralRadius; z = temporal slot.
     */
    _buildInstancesSpiral(hist, params) {
        const inputGain = params.inputGain != null ? params.inputGain : 1.0
        const baseRadius = params.threedParticleSize != null ? params.threedParticleSize : 0.024
        const turns = params.spiralTurns != null ? params.spiralTurns : 2
        const helixR = params.spiralRadius != null ? params.spiralRadius : 3
        const pitch = params.spiralPitch != null ? params.spiralPitch : 1.2
        const histDepth = params.spiralHistoryDepth != null ? params.spiralHistoryDepth : 80
        const hist2 = hist.slice(-histDepth)
        const totalSlots = hist2.length
        const LOG_RANGE = Math.log2(16000 / 16)

        const dummy = new THREE.Object3D()
        const color = new THREE.Color()
        let idx = 0

        for (let si = 0; si < totalSlots; si++) {
            const slotAge = totalSlots - 1 - si
            const { frame } = hist2[si]
            const comps = frame.components || []
            const ageFrac = slotAge / Math.max(totalSlots - 1, 1)
            const slotAlpha = Math.pow(1 - ageFrac, 1.5)
            // Z axis: newest at 0, oldest at -(histDepth * pitch / turns)
            const zSlot = -slotAge * (pitch / Math.max(turns, 0.1))

            for (let ci = 0; ci < comps.length; ci++) {
                const c = comps[ci]
                if (!c) continue
                if (idx >= MAX_INSTANCES) break
                const amp = clamp(c.amplitude * inputGain, 0, 1)
                if (amp < 0.01) continue
                // Angle from frequency (log-spiral: equal arc per octave)
                const fNorm = clamp(Math.log2(Math.max(c.freq, 16) / 16) / LOG_RANGE, 0, 1)
                const angle = fNorm * turns * Math.PI * 2
                // Displacement from helix surface ~ amplitude
                const r = helixR + amp * 0.5
                const cx = Math.cos(angle) * r
                const cy = Math.sin(angle) * r
                const cz = zSlot

                dummy.position.set(cx, cy, cz)
                const radius = baseRadius * amp * slotAlpha
                dummy.scale.setScalar(Math.max(radius, 0.002))
                dummy.rotation.set(0, 0, angle)
                dummy.updateMatrix()
                this.instancedMesh.setMatrixAt(idx, dummy.matrix)
                const rgb = c.color_rgb || [200, 200, 255]
                color.setRGB((rgb[0] / 255) * slotAlpha, (rgb[1] / 255) * slotAlpha, (rgb[2] / 255) * slotAlpha)
                this.instancedMesh.setColorAt(idx, color)
                idx++
            }
            if (idx >= MAX_INSTANCES) break
        }
        this.instancedMesh.count = idx
        this.instancedMesh.instanceMatrix.needsUpdate = true
        if (this.instancedMesh.instanceColor) this.instancedMesh.instanceColor.needsUpdate = true
    }

    /**
     * Layout 6 – 3D L-System: interval-branching fractal tree on a tilted 3D plane.
     * Reuses the same branch logic as RenderEngine's L-System but positions
     * branches in 3D space, tilted by ls3dElevation and rotated by ls3dRotation.
     */
    _buildInstancesLSystem3d(hist, params) {
        if (!hist.length) return
        const latest = hist[hist.length - 1]
        const frame = latest.frame
        const time = frame.time_seconds || 0
        const components = frame.components || []

        // Init persistent L-System state
        if (!this._lState3d) {
            this._lState3d = { branches: [], prevNotes: {}, lastTime: time, nextId: 0 }
        }
        const state = this._lState3d
        const dt = Math.min(Math.max(time - state.lastTime, 0), 0.1)
        state.lastTime = time

        const lsSpeed = (params.ls3dGrowthSpeed != null) ? params.ls3dGrowthSpeed : 0.09
        const SPEED = 10 * lsSpeed  // world-units/sec
        const lsAngleBase = (params.ls3dAngleSpread != null) ? params.ls3dAngleSpread : 18
        const ANGLE_TABLE = [0, lsAngleBase, lsAngleBase * 1.78, lsAngleBase * 2.67, lsAngleBase * 3.44, lsAngleBase * 4.11, lsAngleBase * 4.89, lsAngleBase * 4.56, lsAngleBase * 3.78, lsAngleBase * 2.89, lsAngleBase * 2.0, lsAngleBase * 1.11]

        // Build current note map
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
            let sx = 0, sy = 0, sz = 0, baseAngle = 0
            if (!parentBranch) {
                sx = 0; sy = -4; sz = 0; baseAngle = 0  // root: grow upward
            } else {
                sx = parentBranch.tx; sy = parentBranch.ty; sz = parentBranch.tz
                baseAngle = parentBranch.angle
            }
            const semitones = parentBranch
                ? Math.round(12 * Math.log2(Math.max(comp.freq, 1) / Math.max(parentBranch.freq, 1))) : 0
            const absInt = Math.abs(semitones) % 13
            const offsetDeg = ANGLE_TABLE[Math.min(absInt, 11)]
            const sign = semitones >= 0 ? 1 : -1
            const angleOffset = sign * offsetDeg * (Math.PI / 180)
            state.branches.push({
                id: state.nextId++, tx: sx, ty: sy, tz: sz,
                angle: baseAngle + angleOffset, freq: comp.freq, note,
                color: rgb, alive: true,
                speed: SPEED * (0.4 + comp.amplitude * 0.8),
                generation: parentBranch ? parentBranch.generation + 1 : 0,
                segments: [],
            })
            state.prevNotes[note] = { branchId: state.branches[state.branches.length - 1].id, freq: comp.freq }
        }

        // Mark dead notes
        for (const note in state.prevNotes) {
            if (!curNotes[note]) {
                const pn = state.prevNotes[note]
                for (const br of state.branches) {
                    if (br.id === pn.branchId) { br.alive = false; break }
                }
                delete state.prevNotes[note]
            }
        }

        // Grow alive branches in XY plane (elevation/rotation applied at draw time)
        if (dt > 0) {
            for (const br of state.branches) {
                if (!br.alive) continue
                const dist = br.speed * dt
                const nx = br.tx + Math.sin(br.angle) * dist
                const ny = br.ty + Math.cos(br.angle) * dist
                br.segments.push({ x1: br.tx, y1: br.ty, x2: nx, y2: ny, rgb: br.color, gen: br.generation })
                br.tx = nx; br.ty = ny
            }
        }

        // Pruning
        const lsMaxBr = (params.lsMaxBranches != null) ? params.lsMaxBranches : 300
        if (state.branches.length > lsMaxBr) {
            state.branches = state.branches.filter(br => br.alive || br.segments.length > 0)
        }

        // Render lines in 3D: apply elevation (X-axis rotation) and Y-rotation
        const elevRad = (params.ls3dElevation != null ? params.ls3dElevation : 25) * Math.PI / 180
        const rotRad = (params.ls3dRotation != null ? params.ls3dRotation : 0) * Math.PI / 180
        const lsLW = params.ls3dLineWidth != null ? params.ls3dLineWidth : 2.2

        // Remove old L-System line segments from scene
        if (!this._lsLines3d) this._lsLines3d = []
        for (const ln of this._lsLines3d) { this.scene.remove(ln); ln.geometry.dispose(); ln.material.dispose() }
        this._lsLines3d = []

        const applyPlane = (x, y) => {
            // In plane: branch grows in XY; apply elevation (tilt around X), then Y-rotation
            const tilted = { x, y: y * Math.cos(elevRad), z: y * Math.sin(elevRad) }
            return {
                x: tilted.x * Math.cos(rotRad) - tilted.z * Math.sin(rotRad),
                y: tilted.y,
                z: tilted.x * Math.sin(rotRad) + tilted.z * Math.cos(rotRad),
            }
        }

        for (const br of state.branches) {
            if (!br.segments.length) continue
            const pts = []
            const p0 = applyPlane(br.segments[0].x1, br.segments[0].y1)
            pts.push(new THREE.Vector3(p0.x, p0.y, p0.z))
            for (const seg of br.segments) {
                const p2 = applyPlane(seg.x2, seg.y2)
                pts.push(new THREE.Vector3(p2.x, p2.y, p2.z))
            }
            const geo = new THREE.BufferGeometry().setFromPoints(pts)
            const rgb = br.color
            const mat = new THREE.LineBasicMaterial({
                color: new THREE.Color(rgb[0] / 255, rgb[1] / 255, rgb[2] / 255),
                transparent: true,
                opacity: br.alive ? 0.88 : 0.4,
                linewidth: lsLW,  // note: linewidth > 1 only works on some platforms
            })
            const line = new THREE.Line(geo, mat)
            this.scene.add(line)
            this._lsLines3d.push(line)
        }

        // No instanced mesh needed for L-System lines
        this.instancedMesh.count = 0
        this.instancedMesh.instanceMatrix.needsUpdate = true
    }

    /**
     * Export the 3D L-System as a PNG screenshot of the current renderer frame.
     * Returns a data-URL or null.
     */
    getLSystemBoundingBoxImage() {
        if (!this.renderer) return null
        return this.renderer.domElement.toDataURL('image/png')
    }
}
