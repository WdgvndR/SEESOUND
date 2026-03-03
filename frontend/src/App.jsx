import { useState, useRef, useEffect, useCallback } from 'react'
import { useNodesState, useEdgesState, addEdge as rfAddEdge } from '@xyflow/react'
import { useWebSocket } from './hooks/useWebSocket'
import ParameterPanel from './components/ParameterPanel'
import StatusBar from './components/StatusBar'
import MusicPlayer from './components/MusicPlayer'
import FrequencyMonitor from './components/FrequencyMonitor'
import { getDefaultParams, applyDisabled, loadDisabledParams, saveDisabledParams } from './config/params'
import { RenderEngine } from './engine/RenderEngine'
import { ThreeEngine } from './engine/ThreeEngine'
import { GraphEvaluator } from './engine/GraphEvaluator'
import './App.css'

const API_BASE = 'http://localhost:8000'

export default function App() {
    // ── Refs declared first (so the WS callback can close over them) ──────
    const canvasRef = useRef(null)
    const engineRef = useRef(null)
    const audioRef = useRef(null)   // HTMLAudioElement, shared with MusicPlayer
    const paramsRef = useRef(getDefaultParams())  // always-fresh params
    const disabledKeysRef = useRef(null)           // set in state init below
    const frameCountRef = useRef(0)
    const latestFrameRef = useRef(null)
    const rafPendingRef = useRef(false)
    const allFramesRef = useRef([])     // every received frame, sorted by time_seconds
    const playRafRef = useRef(null)   // the rAF handle for the playback loop
    const lastRenderedTimeRef = useRef(-1) // last audio time we rendered
    const paintRafRef = useRef(null)        // rAF handle for paint-all loop
    const paintingRef = useRef(false)       // cancellation flag for paint-all
    const paintQueuedRef = useRef(false)    // queue paint until analysis_done
    const startPaintRef = useRef(null)      // holds the start-paint function
    const mediaRecorderRef = useRef(null)   // active MediaRecorder instance
    const recordChunksRef = useRef([])      // accumulated video chunks
    const isRecordingRef = useRef(false)    // sync flag (avoids stale closure)
    const analysisFrontierRef = useRef(-1)  // time_seconds of the latest received frame
    const isBufferingRef = useRef(false)    // true when playback is ahead of analysis
    const jobStatusRef = useRef(null)       // mirror of jobStatus state for rAF closures
    const jobIdRef = useRef(null)           // mirror of jobId state for interval/rAF closures
    const threeEngineRef = useRef(null)     // Three.js engine (layout mode 8 only)
    const threeContainerRef = useRef(null)  // container div for WebGL canvas

    // ── Binary-search for the closest frame at or before `t` seconds ─────
    function findFrameAt(t) {
        const frames = allFramesRef.current
        if (!frames.length) return null
        let lo = 0, hi = frames.length - 1
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1
            if (frames[mid].time_seconds <= t) lo = mid
            else hi = mid - 1
        }
        return frames[lo]
    }

    // ── Playback rAF loop ─────────────────────────────────────────
    const startPlaybackLoop = useCallback(() => {
        if (playRafRef.current) return  // already running
        const tick = () => {
            const audio = audioRef.current
            if (!audio || audio.paused) { playRafRef.current = null; return }
            const t = audio.currentTime

            // If analysis is still running and hasn't reached the playback
            // position yet, pause audio and enter buffering state.
            // The frame-arrival handler auto-resumes when enough frames catch up.
            const frontier = analysisFrontierRef.current
            if (frontier >= 0 && jobStatusRef.current === 'running' && t > frontier + 0.5) {
                isBufferingRef.current = true
                setIsBuffering(true)
                audio.pause()   // fires 'pause' → onPause → stopPlaybackLoop
                playRafRef.current = null
                return
            }

            const frame = findFrameAt(t)
            if (frame && frame.time_seconds !== lastRenderedTimeRef.current) {
                const _p = applyDisabled(paramsRef.current, disabledKeysRef.current)
                if (paramsRef.current.layoutMode === 8) {
                    threeEngineRef.current?.renderFrame(frame, _p, t, audio.duration || 0)
                } else {
                    engineRef.current?.renderFrame(frame, _p, t, audio.duration || 0)
                }
                lastRenderedTimeRef.current = frame.time_seconds
                latestFrameRef.current = frame
                if (!rafPendingRef.current) {
                    rafPendingRef.current = true
                    requestAnimationFrame(() => {
                        rafPendingRef.current = false
                        setCurrentFrame(latestFrameRef.current)
                        const _activeEng = paramsRef.current.layoutMode === 8
                            ? threeEngineRef.current : engineRef.current
                        setFps(Math.round(_activeEng?.fps || 0))
                    })
                }
            }
            playRafRef.current = requestAnimationFrame(tick)
        }
        playRafRef.current = requestAnimationFrame(tick)
    }, [])

    const stopPlaybackLoop = useCallback(() => {
        if (playRafRef.current) {
            cancelAnimationFrame(playRafRef.current)
            playRafRef.current = null
        }
    }, [])

    const renderAtTime = useCallback((t) => {
        // Only force a one-shot render when not playing — the loop handles it while playing
        const audio = audioRef.current
        if (audio && !audio.paused) return
        const frame = findFrameAt(t)
        if (frame) {
            const _p = applyDisabled(paramsRef.current, disabledKeysRef.current)
            if (paramsRef.current.layoutMode === 8) {
                threeEngineRef.current?.renderFrame(frame, _p, t, audio?.duration || 0)
            } else if (engineRef.current) {
                engineRef.current.renderFrame(frame, _p, t, audio?.duration || 0)
            }
            lastRenderedTimeRef.current = frame.time_seconds
            setCurrentFrame(frame)
        }
    }, [])

    // When the user seeks manually, check if the new position is already within
    // the analysis frontier and clear buffering so playback can resume.
    const handleSeeked = useCallback((t) => {
        if (isBufferingRef.current) {
            const frontier = analysisFrontierRef.current
            if (frontier >= t - 0.3) {
                isBufferingRef.current = false
                setIsBuffering(false)
                // If the audio element is still paused (which it will be while
                // buffering), don't auto-resume — let the user press Play.
                // This avoids jarring auto-playback after a seek.
            }
        }
        renderAtTime(t)
    }, [renderAtTime])

    // Set track duration on engine when audio metadata loads (needed for Painting layout)
    const handleAudioReady = useCallback((audio) => {
        const syncDur = () => {
            if (!isNaN(audio.duration) && audio.duration > 0) {
                engineRef.current?.setTrackDuration(audio.duration)
                threeEngineRef.current?.setTrackDuration(audio.duration)
            }
        }
        audio.addEventListener('loadedmetadata', syncDur)
        syncDur()  // immediate if metadata already known
    }, [])

    // ── Stable WS callback delegates to a per-render ref (fresh closures) ─
    const wsHandlerRef = useRef(null)
    const onWsMessage = useCallback((msg) => {
        if (wsHandlerRef.current) wsHandlerRef.current(msg)
    }, [])   // never recreated — stable identity

    // ── WebSocket ─────────────────────────────────────────────────────────
    const { status, messages, sendMessage } = useWebSocket(onWsMessage)

    // ── Parameters ────────────────────────────────────────────────────────
    const [params, setParams] = useState(getDefaultParams)
    paramsRef.current = params    // sync every render without an effect
    const [disabledKeys, setDisabledKeys] = useState(() => new Set(loadDisabledParams()))
    disabledKeysRef.current = disabledKeys  // always-fresh ref for rAF tick
    const [panelCollapsed, setPanelCollapsed] = useState(false)

    // ── Node graph state ──────────────────────────────────────────────────
    const [activePanel, setActivePanel] = useState('params')
    const [nodes, setNodes, onNodesChange] = useNodesState([])
    const [edges, setEdges, onEdgesChange] = useEdgesState([])
    const graphEvalRef = useRef(null)

    const handleClear = useCallback(() => {
        engineRef.current?.clear()
        threeEngineRef.current?.clear()
    }, [])

    const handleToggleDisabled = useCallback((key) => {
        setDisabledKeys(prev => {
            const next = new Set(prev)
            if (next.has(key)) next.delete(key)
            else next.add(key)
            saveDisabledParams([...next])
            return next
        })
        requestAnimationFrame(() => renderAtTime(audioRef.current?.currentTime ?? 0))
    }, [renderAtTime])

    const handlePresetLoad = useCallback(({ params: presetParams, nodes: presetNodes = [], edges: presetEdges = [], mappingGroups: presetMappingGroups } = {}) => {
        if (!presetParams) return
        // Merge loaded preset with current defaults so any new fields
        // (e.g. freqColorTable, lightnessMin from old presets) are filled in.
        const merged = { ...getDefaultParams(), ...presetParams }
        setParams(merged)
        paramsRef.current = merged
        // Restore node graph if included in preset
        setNodes(presetNodes)
        setEdges(presetEdges)
        // Restore mapping groups if included in preset
        if (Array.isArray(presetMappingGroups)) setMappingGroups(presetMappingGroups)
        if (status === 'open') sendMessage({ type: 'params', payload: merged })
        renderAtTime(audioRef.current?.currentTime ?? 0)
    }, [status, sendMessage, renderAtTime, setNodes, setEdges])

    // ── Job / playback state ──────────────────────────────────────────────
    const [audioFile, setAudioFile] = useState(null)
    const [jobId, setJobId] = useState(null)
    const [jobStatus, setJobStatus] = useState(null)
    const [frameCount, setFrameCount] = useState(0)
    const [fps, setFps] = useState(0)
    const [currentFrame, setCurrentFrame] = useState(null)
    const [monitorCollapsed, setMonitorCollapsed] = useState(false)
    const [canvasW, setCanvasW] = useState(800)
    const [canvasH, setCanvasH] = useState(500)
    const [isPainting, setIsPainting] = useState(false)
    const [paintProgress, setPaintProgress] = useState(0)
    const [isPaintQueued, setIsPaintQueued] = useState(false)
    const [isRecording, setIsRecording] = useState(false)
    const [isBuffering, setIsBuffering] = useState(false)
    const [mappingGroups, setMappingGroups] = useState([])

    // Sync jobStatusRef so the rAF tick can read current status without stale closures
    useEffect(() => { jobStatusRef.current = jobStatus }, [jobStatus])
    // Sync jobIdRef so the playback-time interval always sends the correct job id
    useEffect(() => { jobIdRef.current = jobId }, [jobId])

    // Report playback position to the backend every second while the audio is
    // playing.  The backend uses this to throttle analysis to LOOKAHEAD_S ahead
    // of the current position so analysis of the whole file isn't front-loaded.
    useEffect(() => {
        const iv = setInterval(() => {
            const audio = audioRef.current
            if (!audio || audio.paused) return
            const j = jobIdRef.current
            if (!j) return
            sendMessage({ type: 'playback_time', payload: { job_id: j, time: audio.currentTime } })
        }, 1000)
        return () => clearInterval(iv)
    }, [sendMessage])

    // ── Incoming frame handler: store frames, rendering driven by playback loop
    wsHandlerRef.current = (msg) => {
        if (msg.type !== 'frame') return
        const f = msg.payload
        if (!f) return
        const arr = allFramesRef.current
        // Insert in sorted order (frames usually arrive sequentially)
        if (!arr.length || f.time_seconds >= arr[arr.length - 1].time_seconds) {
            arr.push(f)
        } else {
            let lo = 0, hi = arr.length
            while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid].time_seconds < f.time_seconds) lo = mid + 1; else hi = mid }
            arr.splice(lo, 0, f)
        }
        frameCountRef.current = arr.length

        // Update the analysis frontier (latest frame time received)
        const newFrontier = arr[arr.length - 1]?.time_seconds ?? -1
        analysisFrontierRef.current = newFrontier

        // If the player was paused by the buffering guard, auto-resume
        // once analysis has caught up to the current playback position.
        if (isBufferingRef.current) {
            const audioTime = audioRef.current?.currentTime ?? 0
            if (newFrontier >= audioTime - 0.3) {
                isBufferingRef.current = false
                setIsBuffering(false)
                audioRef.current?.play().catch(() => { })
            }
        }
    }

    // ── Canvas + engine ────────────────────────────────────────────────────
    useEffect(() => {
        if (canvasRef.current && !engineRef.current) {
            engineRef.current = new RenderEngine(canvasRef.current)
            // Wire graph evaluator immediately on engine creation
            if (graphEvalRef.current) {
                engineRef.current.setGraphEvaluator(graphEvalRef.current)
            }
        }
        return () => {
            engineRef.current?.destroy()
            engineRef.current = null
            threeEngineRef.current?.destroy()
            threeEngineRef.current = null
        }
    }, [])

    // ── Three.js engine lifecycle: create/destroy when switching to/from mode 8 ──
    useEffect(() => {
        if (params.layoutMode === 8) {
            if (!threeEngineRef.current && threeContainerRef.current) {
                try {
                    threeEngineRef.current = new ThreeEngine(threeContainerRef.current)
                    // Sync track duration if already known
                    const dur = audioRef.current?.duration
                    if (dur && dur > 0) threeEngineRef.current.setTrackDuration(dur)
                } catch (err) {
                    console.error('[App] ThreeEngine init failed:', err)
                    threeEngineRef.current = null
                }
            }
        } else {
            if (threeEngineRef.current) {
                threeEngineRef.current.destroy()
                threeEngineRef.current = null
            }
        }
    }, [params.layoutMode])

    // ── Compile & wire graph evaluator whenever nodes/edges change ────────
    useEffect(() => {
        if (!graphEvalRef.current) {
            graphEvalRef.current = new GraphEvaluator()
        }
        const ge = graphEvalRef.current
        ge.compile(nodes, edges)
        engineRef.current?.setGraphEvaluator(ge)
    }, [nodes, edges])

    useEffect(() => {
        const onResize = () => {
            engineRef.current?.resize()
            threeEngineRef.current?.resize()
        }
        window.addEventListener('resize', onResize)
        return () => window.removeEventListener('resize', onResize)
    }, [])

    // ── Control messages (job_started, analysis_done, error …) ────────────
    // frames never appear in `messages` (filtered by useWebSocket), so this
    // array stays tiny and we can process it simply.
    const lastProcessedRef = useRef(0)
    useEffect(() => {
        if (messages.length <= lastProcessedRef.current) return
        const toProcess = messages.slice(lastProcessedRef.current)
        lastProcessedRef.current = messages.length

        for (const msg of toProcess) {
            if (!msg?.type) continue
            switch (msg.type) {
                case 'job_started':
                    setJobId(msg.payload?.job_id)
                    setJobStatus('running')
                    // Reset frame store & canvas for the new job
                    allFramesRef.current = []
                    frameCountRef.current = 0
                    latestFrameRef.current = null
                    lastRenderedTimeRef.current = -1
                    setCurrentFrame(null)
                    setFrameCount(0)
                    engineRef.current?.clear()
                    threeEngineRef.current?.clear()
                    // Reset buffering state for new job
                    analysisFrontierRef.current = -1
                    isBufferingRef.current = false
                    setIsBuffering(false)
                    // Cancel any pending paint from the previous file
                    paintingRef.current = false
                    paintQueuedRef.current = false
                    setIsPainting(false)
                    setIsPaintQueued(false)
                    setPaintProgress(0)
                    break
                case 'analysis_done':
                    setJobStatus('done')
                    setFrameCount(frameCountRef.current)
                    // Clear any lingering buffering state — analysis is fully complete
                    if (isBufferingRef.current) {
                        isBufferingRef.current = false
                        setIsBuffering(false)
                        // Don't auto-play; let user decide whether to resume
                    }
                    // If audio is not playing, render the frame at current position
                    if (audioRef.current?.paused) {
                        renderAtTime(audioRef.current.currentTime)
                    }
                    // Auto-start paint if the user queued it while analysis was running
                    if (paintQueuedRef.current) {
                        paintQueuedRef.current = false
                        setIsPaintQueued(false)
                        startPaintRef.current?.()
                    }
                    break
                case 'error':
                    setJobStatus('error: ' + (msg.message || 'unknown error'))
                    // If buffering, clear state so the player isn't left frozen
                    if (isBufferingRef.current) {
                        isBufferingRef.current = false
                        setIsBuffering(false)
                    }
                    break
                case 'progress':
                    // Backend heartbeat every 500 frames — update live counter
                    setFrameCount(msg.frame_count ?? frameCountRef.current)
                    break
                default:
                    break
            }
        }
    }, [messages, renderAtTime])

    // ── Parameter change ───────────────────────────────────────────────────
    const handleParamChange = useCallback((key, value) => {
        setParams(prev => {
            const next = { ...prev, [key]: value }
            if (status === 'open') sendMessage({ type: 'params', payload: next })
            return next
        })
        // Eagerly update ref so renderAtTime sees the new value before React re-renders
        paramsRef.current = { ...paramsRef.current, [key]: value }
        renderAtTime(audioRef.current?.currentTime ?? 0)
    }, [status, sendMessage, renderAtTime])

    const handleReset = useCallback(() => {
        const d = getDefaultParams()
        setParams(d)
        if (status === 'open') sendMessage({ type: 'params', payload: d })
    }, [status, sendMessage])

    // ── File select: reset state, upload to backend, subscribe via WS ────
    const handleFileSelect = useCallback(async (file) => {
        // Reset render state immediately on new file
        stopPlaybackLoop()
        allFramesRef.current = []
        frameCountRef.current = 0
        lastRenderedTimeRef.current = -1
        engineRef.current?.clear()
        threeEngineRef.current?.clear()
        setAudioFile(file)
        setCurrentFrame(null)
        setFrameCount(0)
        try {
            const form = new FormData()
            form.append('file', file)
            const res = await fetch(`${API_BASE}/api/upload`, { method: 'POST', body: form })
            const data = await res.json()
            if (data.job_id) {
                setJobStatus('starting')
                sendMessage({ type: 'subscribe', payload: { job_id: data.job_id } })
            }
        } catch (err) {
            console.error('Upload failed:', err)
            setJobStatus('error')
        }
    }, [sendMessage, stopPlaybackLoop])

    // ── Note colour / mode change ─────────────────────────────────────────
    const handleColorChange = useCallback((noteColors) => {
        setParams(prev => {
            const next = { ...prev, noteColors }
            if (status === 'open') sendMessage({ type: 'params', payload: next })
            return next
        })
    }, [status, sendMessage])

    const handleColorModeChange = useCallback((colorInputMode) => {
        setParams(prev => {
            const next = { ...prev, colorInputMode }
            if (status === 'open') sendMessage({ type: 'params', payload: next })
            return next
        })
    }, [status, sendMessage])

    const handleCalculateAll = useCallback((freqColorTable, lightnessMin, lightnessMax) => {
        setParams(prev => {
            const next = { ...prev, freqColorTable, lightnessMin, lightnessMax }
            if (status === 'open') sendMessage({ type: 'params', payload: next })
            return next
        })
    }, [status, sendMessage])

    const handleTableEntryChange = useCallback((key, rgb) => {
        setParams(prev => {
            const freqColorTable = { ...(prev.freqColorTable || {}), [key]: rgb }
            const next = { ...prev, freqColorTable }
            if (status === 'open') sendMessage({ type: 'params', payload: next })
            return next
        })
    }, [status, sendMessage])

    // ── Paint All: render every frame onto the canvas without real-time playback ──

    // Inner start function stored in a ref so analysis_done handler can call it
    startPaintRef.current = () => {
        const frames = allFramesRef.current
        if (!frames.length) return
        engineRef.current?.clear()
        paintingRef.current = true
        setIsPainting(true)
        setPaintProgress(0)
        const total = frames.length
        const duration = frames[total - 1].time_seconds
        let i = 0
        const step = () => {
            if (!paintingRef.current) return
            const BATCH = 128
            const p = applyDisabled(paramsRef.current, disabledKeysRef.current)
            for (let b = 0; b < BATCH && i < total; b++, i++) {
                engineRef.current?.renderFrame(frames[i], p, frames[i].time_seconds, duration)
            }
            setPaintProgress(Math.round((i / total) * 100))
            if (i < total) {
                paintRafRef.current = requestAnimationFrame(step)
            } else {
                paintingRef.current = false
                paintRafRef.current = null
                setIsPainting(false)
                setPaintProgress(100)
            }
        }
        paintRafRef.current = requestAnimationFrame(step)
    }

    const handlePaintAll = useCallback(() => {
        // Cancel anything in progress or queued
        if (paintingRef.current || paintQueuedRef.current) {
            paintingRef.current = false
            paintQueuedRef.current = false
            if (paintRafRef.current) { cancelAnimationFrame(paintRafRef.current); paintRafRef.current = null }
            setIsPainting(false)
            setIsPaintQueued(false)
            setPaintProgress(0)
            return
        }
        // Frames available — start immediately regardless of whether analysis
        // is still running (we'll paint whatever has arrived so far)
        if (allFramesRef.current.length > 0) {
            startPaintRef.current?.()
            return
        }
        // No frames yet — queue and auto-start when analysis_done fires
        paintQueuedRef.current = true
        setIsPaintQueued(true)
    }, [])

    // ── Canvas video recording ─────────────────────────────────────────
    const handleRecord = useCallback(() => {
        // Stop if already recording
        if (isRecordingRef.current) {
            mediaRecorderRef.current?.stop()
            return
        }

        const canvas = (paramsRef.current.layoutMode === 8 && threeEngineRef.current)
            ? threeEngineRef.current.renderer.domElement
            : canvasRef.current
        if (!canvas) return

        try {
            const stream = canvas.captureStream(30)

            // Attach audio track from the <audio> element when available
            const audio = audioRef.current
            if (audio?.captureStream) {
                try {
                    audio.captureStream().getAudioTracks().forEach(t => stream.addTrack(t))
                } catch (e) {
                    console.warn('[Record] Could not attach audio track:', e)
                }
            }

            const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
                ? 'video/webm;codecs=vp9'
                : 'video/webm'

            const chunks = []
            recordChunksRef.current = chunks

            const rec = new MediaRecorder(stream, { mimeType })
            mediaRecorderRef.current = rec

            rec.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data) }
            rec.onstop = () => {
                isRecordingRef.current = false
                setIsRecording(false)
                const blob = new Blob(chunks, { type: mimeType })
                const url = URL.createObjectURL(blob)
                const a = document.createElement('a')
                const stem = audioFile ? audioFile.name.replace(/\.[^.]+$/, '') : 'seesound'
                a.href = url
                a.download = stem + '_recording.webm'
                a.click()
                URL.revokeObjectURL(url)
            }

            rec.start(100)   // collect a chunk every 100 ms
            isRecordingRef.current = true
            setIsRecording(true)
        } catch (e) {
            console.error('[Record] Failed to start recording:', e)
        }
    }, [audioFile])

    // ── Save L-System as bounding-box PNG ─────────────────────────────
    const handleSaveLSystem = useCallback(() => {
        const url = engineRef.current?.getLSystemBoundingBoxImage()
        if (!url) return
        const a = document.createElement('a')
        const stem = audioFile ? audioFile.name.replace(/\.[^.]+$/, '') : 'seesound'
        a.href = url
        a.download = stem + '_lsystem.png'
        a.click()
    }, [audioFile])

    // ── Save canvas as PNG ─────────────────────────────────────────────
    const handleSave = useCallback(() => {
        // In 3D mode use the WebGL canvas from the ThreeEngine renderer
        const canvas = (paramsRef.current.layoutMode === 8 && threeEngineRef.current)
            ? threeEngineRef.current.renderer.domElement
            : canvasRef.current
        if (!canvas) return
        const url = canvas.toDataURL('image/png')
        const a = document.createElement('a')
        const stem = audioFile ? audioFile.name.replace(/\.[^.]+$/, '') : 'seesound'
        a.href = url
        a.download = stem + '_' + canvasW + 'x' + canvasH + '.png'
        a.click()
    }, [audioFile, canvasW, canvasH])

    // ── Stop job ─────────────────────────────────────────────────────────
    const handleStop = useCallback(() => {
        sendMessage({ type: 'stop', payload: { job_id: jobId } })
    }, [sendMessage, jobId])

    // ── Node graph handlers ───────────────────────────────────────────────
    const handleConnect = useCallback((params) => {
        setEdges(eds => rfAddEdge({ ...params, animated: true, style: { stroke: '#4d7fa8', strokeWidth: 2 } }, eds))
    }, [setEdges])

    const handleUpdateNode = useCallback((id, newData) => {
        setNodes(nds => nds.map(n => n.id === id ? { ...n, data: { ...newData, onChange: undefined, onDelete: undefined } } : n))
    }, [setNodes])

    const handleAddNode = useCallback((nodeObj) => {
        // Strip injected callbacks before storing
        const { data: { onChange: _oc, onDelete: _od, ...restData } = {}, ...rest } = nodeObj
        setNodes(nds => [...nds, { ...rest, data: restData }])
    }, [setNodes])

    const handleDeleteNode = useCallback((id) => {
        setNodes(nds => nds.filter(n => n.id !== id))
        setEdges(eds => eds.filter(e => e.source !== id && e.target !== id))
    }, [setNodes, setEdges])

    // ─────────────────────────────────────────────────────────────────────
    return (
        <div className="app-layout">
            <ParameterPanel
                values={params}
                onChange={handleParamChange}
                onReset={handleReset}
                collapsed={panelCollapsed}
                onToggle={() => setPanelCollapsed(c => !c)}
                onColorChange={handleColorChange}
                onColorModeChange={handleColorModeChange}
                onCalculateAll={handleCalculateAll}
                onTableEntryChange={handleTableEntryChange}
                disabledKeys={disabledKeys}
                onToggleDisabled={handleToggleDisabled}
                onPresetLoad={handlePresetLoad}
                activeTab={activePanel}
                onTabChange={setActivePanel}
                currentNodes={nodes}
                currentEdges={edges}
                onNodesChange={onNodesChange}
                onEdgesChange={onEdgesChange}
                onConnect={handleConnect}
                onUpdateNode={handleUpdateNode}
                onAddNode={handleAddNode}
                onDeleteNode={handleDeleteNode}
                mappingGroups={mappingGroups}
                onMappingGroupsChange={setMappingGroups}
            />

            <main className="main-area">
                <header className="main-header">
                    <h1 className="title">SEESOUND</h1>
                    <span className="subtitle">Audio → Visual · Real-time Renderer</span>
                </header>

                {/* Music player */}
                <MusicPlayer
                    audioFile={audioFile}
                    onFileSelect={handleFileSelect}
                    audioRef={audioRef}
                    onReady={handleAudioReady}
                    onPlay={startPlaybackLoop}
                    onPause={stopPlaybackLoop}
                    onEnded={stopPlaybackLoop}
                    onSeeked={handleSeeked}
                    isBuffering={isBuffering}
                />

                {/* 2-D Canvas (modes 0-7) */}
                <div className="canvas-container" style={{ display: params.layoutMode === 8 ? 'none' : undefined }}>
                    <canvas ref={canvasRef} className="render-canvas"
                        style={{ width: canvasW + 'px', height: canvasH + 'px' }} />
                </div>

                {/* Three.js 3D Canvas (mode 8 – Deep Space) */}
                <div className="canvas-container" style={{ display: params.layoutMode !== 8 ? 'none' : undefined }}>
                    <div
                        ref={threeContainerRef}
                        style={{
                            width: canvasW + 'px',
                            height: canvasH + 'px',
                            position: 'relative',
                            overflow: 'hidden',
                            borderRadius: '6px',
                            flexShrink: 0,
                            background: '#060608',
                        }}
                    />
                </div>

                {/* Canvas toolbar: resize + save */}
                <div className="canvas-toolbar">
                    <span className="canvas-tb-label">Canvas</span>
                    <input type="number" className="canvas-size-input" value={canvasW} min={100} max={8000} step={10}
                        onChange={e => setCanvasW(Math.max(100, Number(e.target.value) || 800))}
                        title="Canvas width in px" />
                    <span className="canvas-tb-sep">×</span>
                    <input type="number" className="canvas-size-input" value={canvasH} min={100} max={8000} step={10}
                        onChange={e => setCanvasH(Math.max(100, Number(e.target.value) || 500))}
                        title="Canvas height in px" />
                    <span className="canvas-tb-unit">px</span>
                    <button className="canvas-clear-btn" onClick={handleClear} title="Clear canvas">
                        ✕ Clear
                    </button>
                    <button
                        className={'canvas-paint-all-btn' + (isPainting ? ' painting' : '') + (isPaintQueued ? ' queued' : '')}
                        onClick={handlePaintAll}
                        disabled={!jobStatus && !isPainting && !isPaintQueued}
                        title={isPainting ? 'Cancel painting' : isPaintQueued ? 'Queued — click to cancel' : 'Render all frames onto canvas'}
                    >
                        {isPainting ? `✕ Cancel (${paintProgress}%)` : isPaintQueued ? '⏳ Queued…' : '⬛ Paint All'}
                    </button>
                    <button className="canvas-save-btn" onClick={handleSave} title="Save canvas as PNG">
                        ↓ Save PNG
                    </button>
                    {params.layoutMode === 4 && (
                        <button className="canvas-save-btn" onClick={handleSaveLSystem} title="Save full L-System tree as PNG at its natural bounding box (no clipping)">
                            ↓ Save L-System
                        </button>
                    )}
                    <button
                        className={'canvas-record-btn' + (isRecording ? ' recording' : '')}
                        onClick={handleRecord}
                        title={isRecording ? 'Stop recording and download .webm' : 'Record canvas as video (.webm)'}
                    >
                        {isRecording ? '⏹ Stop · Save' : '⏺ Record'}
                    </button>
                </div>

                <StatusBar
                    wsStatus={status}
                    jobStatus={jobStatus}
                    fps={fps}
                    frameCount={frameCount}
                    onStop={handleStop}
                />
            </main>

            <FrequencyMonitor
                frame={currentFrame}
                noteColors={params.noteColors}
                collapsed={monitorCollapsed}
                onToggle={() => setMonitorCollapsed(c => !c)}
            />
        </div>
    )
}
