import { useState, useRef, useEffect, useCallback } from 'react'

/** Format seconds as mm:ss */
function fmtTime(secs) {
    if (!isFinite(secs) || secs < 0) return '0:00'
    const m = Math.floor(secs / 60)
    const s = Math.floor(secs % 60)
    return `${m}:${s.toString().padStart(2, '0')}`
}

/**
 * MusicPlayer
 *
 * Props:
 *   audioFile    — File object (can be null)
 *   onFileSelect — called with File when user opens a file
 *   onReady      — called with the HTMLAudioElement once src is loaded
 *   audioRef     — optional external ref; if provided it will point at the
 *                  <audio> element so the caller can read currentTime etc.
 *   onPlay       — () => void  — fired when playback starts
 *   onPause      — () => void  — fired when playback pauses or stops
 *   onSeeked     — (time: number) => void  — fired after a seek completes
 *   onEnded      — () => void  — fired when track finishes
 */
export default function MusicPlayer({ audioFile, onFileSelect, onReady, audioRef: extAudioRef, onPlay, onPause, onSeeked, onEnded, isBuffering, playLocked }) {
    const fileInputRef = useRef(null)
    const internalAudioRef = useRef(null)
    // Use external ref if supplied, otherwise internal
    const audioRef = extAudioRef ?? internalAudioRef
    const srcObjRef = useRef(null)
    const analyserRef = useRef(null)
    const audioCtxRef = useRef(null)

    // Keep latest callback props in refs so event listeners are never stale
    const onPlayRef = useRef(onPlay)
    const onPauseRef = useRef(onPause)
    const onSeekedRef = useRef(onSeeked)
    const onEndedRef = useRef(onEnded)
    useEffect(() => { onPlayRef.current = onPlay }, [onPlay])
    useEffect(() => { onPauseRef.current = onPause }, [onPause])
    useEffect(() => { onSeekedRef.current = onSeeked }, [onSeeked])
    useEffect(() => { onEndedRef.current = onEnded }, [onEnded])

    const [isPlaying, setIsPlaying] = useState(false)
    const [duration, setDuration] = useState(0)
    const [currentTime, setCurrentTime] = useState(0)
    const [volume, setVolume] = useState(0.8)
    const [isMuted, setIsMuted] = useState(false)
    const [trackName, setTrackName] = useState('')

    // ── Load file into audio element ────────────────────────────────────────
    useEffect(() => {
        if (!audioFile) return
        const audio = audioRef.current
        if (!audio) return

        // Revoke previous object URL
        if (srcObjRef.current) URL.revokeObjectURL(srcObjRef.current)
        const url = URL.createObjectURL(audioFile)
        srcObjRef.current = url

        audio.src = url
        audio.load()
        setTrackName(audioFile.name.replace(/\.[^.]+$/, ''))
        setCurrentTime(0)
        setIsPlaying(false)

        // NOTE: AudioContext is created lazily on first play click below,
        // NOT here, because browsers block AudioContext created without a
        // user gesture (the file-load effect is not a user gesture).

        if (onReady) onReady(audio)

        return () => {
            if (srcObjRef.current) URL.revokeObjectURL(srcObjRef.current)
        }
    }, [audioFile])

    // ── Sync volume / mute ──────────────────────────────────────────────────
    useEffect(() => {
        const audio = audioRef.current
        if (!audio) return
        audio.volume = isMuted ? 0 : volume
    }, [volume, isMuted])

    // ── Current time updater ────────────────────────────────────────────────
    useEffect(() => {
        const audio = audioRef.current
        if (!audio) return

        const onTimeUpdate = () => setCurrentTime(audio.currentTime)
        const onDuration = () => setDuration(audio.duration)
        const onEndedInternal = () => { setIsPlaying(false); onEndedRef.current?.() }
        const onPlayInternal = () => { setIsPlaying(true); onPlayRef.current?.() }
        const onPauseInternal = () => { setIsPlaying(false); onPauseRef.current?.() }
        const onSeekedInternal = () => { onSeekedRef.current?.(audio.currentTime) }

        audio.addEventListener('timeupdate', onTimeUpdate)
        audio.addEventListener('durationchange', onDuration)
        audio.addEventListener('loadedmetadata', onDuration)
        audio.addEventListener('ended', onEndedInternal)
        audio.addEventListener('play', onPlayInternal)
        audio.addEventListener('pause', onPauseInternal)
        audio.addEventListener('seeked', onSeekedInternal)

        return () => {
            audio.removeEventListener('timeupdate', onTimeUpdate)
            audio.removeEventListener('durationchange', onDuration)
            audio.removeEventListener('loadedmetadata', onDuration)
            audio.removeEventListener('ended', onEndedInternal)
            audio.removeEventListener('play', onPlayInternal)
            audio.removeEventListener('pause', onPauseInternal)
            audio.removeEventListener('seeked', onSeekedInternal)
        }
    }, [])

    // ── Controls ────────────────────────────────────────────────────────────
    const handlePlayPause = useCallback(async () => {
        const audio = audioRef.current
        if (!audio || !audio.src) return

        // ── Lazy Web Audio API setup (must happen inside a user gesture) ──
        if (!audioCtxRef.current) {
            try {
                const ctx = new (window.AudioContext || window.webkitAudioContext)()
                const analyser = ctx.createAnalyser()
                analyser.fftSize = 256
                const mediaSrc = ctx.createMediaElementSource(audio)
                mediaSrc.connect(analyser)
                analyser.connect(ctx.destination)
                audioCtxRef.current = ctx
                analyserRef.current = analyser
            } catch (e) {
                console.warn('[MusicPlayer] Web Audio setup failed:', e)
            }
        }

        // Resume AudioContext if suspended (Chrome autoplay policy)
        if (audioCtxRef.current?.state === 'suspended') {
            await audioCtxRef.current.resume()
        }

        if (audio.paused) {
            try {
                await audio.play()   // fires 'play' event → onPlayInternal
            } catch (e) {
                console.error('[MusicPlayer] play() rejected:', e)
            }
        } else {
            audio.pause()            // fires 'pause' event → onPauseInternal
        }
    }, [])   // audioRef / audioCtxRef / analyserRef are stable ref objects

    const handleStop = useCallback(() => {
        const audio = audioRef.current
        if (!audio) return
        audio.pause()           // fires 'pause' → onPause callback
        audio.currentTime = 0   // fires 'seeked' → onSeeked(0) callback
        setCurrentTime(0)
    }, [])

    const handleSeek = useCallback((e) => {
        const audio = audioRef.current
        if (!audio || !duration) return
        const rect = e.currentTarget.getBoundingClientRect()
        const pct = (e.clientX - rect.left) / rect.width
        audio.currentTime = pct * duration
    }, [duration])

    const handleSeekKey = useCallback((e) => {
        const audio = audioRef.current
        if (!audio) return
        if (e.key === 'ArrowRight') audio.currentTime = Math.min(audio.currentTime + 5, duration)
        if (e.key === 'ArrowLeft') audio.currentTime = Math.max(audio.currentTime - 5, 0)
    }, [duration])

    const handleSkip = useCallback((delta) => {
        const audio = audioRef.current
        if (!audio) return
        audio.currentTime = Math.max(0, Math.min(audio.currentTime + delta, duration))
    }, [duration])

    const handleVolume = useCallback((e) => {
        setVolume(parseFloat(e.target.value))
        setIsMuted(false)
    }, [])

    const pct = duration > 0 ? (currentTime / duration) * 100 : 0

    return (
        <div className="music-player">
            {/* Hidden elements */}
            <audio ref={audioRef} preload="auto" />
            <input
                ref={fileInputRef}
                type="file"
                accept="audio/*"
                style={{ display: 'none' }}
                onChange={(e) => {
                    const f = e.target.files?.[0]
                    if (f && onFileSelect) onFileSelect(f)
                    e.target.value = ''
                }}
            />

            {/* Track info + open button */}
            <div className="player-track">
                <button
                    className="player-open-btn"
                    onClick={() => fileInputRef.current?.click()}
                    title="Open audio file"
                >
                    📂 Open
                </button>
                <span className="player-title" title={trackName}>
                    {trackName || 'No file loaded — click Open'}
                </span>
                <span className="player-time">
                    {fmtTime(currentTime)} / {fmtTime(duration)}
                </span>
            </div>

            {/* Seek bar */}
            <div
                className="player-seek"
                role="slider"
                aria-valuemin={0}
                aria-valuemax={duration}
                aria-valuenow={currentTime}
                tabIndex={0}
                onClick={handleSeek}
                onKeyDown={handleSeekKey}
                title="Click to seek"
            >
                <div className="player-seek-fill" style={{ width: `${pct}%` }} />
                <div className="player-seek-thumb" style={{ left: `${pct}%` }} />
            </div>

            {/* Controls row */}
            <div className="player-controls">
                <div className="player-btns">
                    {/* Rewind 10s */}
                    <button
                        className="player-btn"
                        onClick={() => handleSkip(-10)}
                        disabled={!trackName || playLocked}
                        title={playLocked ? 'Painting in progress…' : 'Back 10s'}
                    >⏮ 10s</button>

                    {/* Play / Pause */}
                    <button
                        className={`player-btn player-btn-main${isBuffering ? ' player-btn-buffering' : ''}${playLocked ? ' player-btn-locked' : ''}`}
                        onClick={handlePlayPause}
                        disabled={!trackName || isBuffering || playLocked}
                        title={playLocked ? 'Painting in progress…' : isBuffering ? 'Buffering…' : isPlaying ? 'Pause' : 'Play'}
                    >
                        {playLocked ? '🎨' : isBuffering ? <span className="player-spinner" /> : isPlaying ? '⏸' : '▶'}
                    </button>

                    {/* Stop */}
                    <button
                        className="player-btn"
                        onClick={handleStop}
                        disabled={!trackName || playLocked}
                        title={playLocked ? 'Painting in progress…' : 'Stop'}
                    >⏹</button>

                    {/* Skip 10s */}
                    <button
                        className="player-btn"
                        onClick={() => handleSkip(10)}
                        disabled={!trackName || playLocked}
                        title={playLocked ? 'Painting in progress…' : 'Forward 10s'}
                    >10s ⏭</button>
                </div>

                {/* Volume */}
                <div className="player-volume">
                    <button
                        className="player-btn player-btn-mute"
                        onClick={() => setIsMuted(m => !m)}
                        title={isMuted ? 'Unmute' : 'Mute'}
                    >
                        {isMuted || volume === 0 ? '🔇' : volume < 0.5 ? '🔉' : '🔊'}
                    </button>
                    <input
                        type="range"
                        className="player-vol-slider"
                        min={0}
                        max={1}
                        step={0.01}
                        value={isMuted ? 0 : volume}
                        onChange={handleVolume}
                        style={{
                            background: `linear-gradient(90deg, var(--accent2) ${(isMuted ? 0 : volume) * 100}%, var(--border) ${(isMuted ? 0 : volume) * 100}%)`
                        }}
                        title="Volume"
                    />
                </div>
            </div>
        </div>
    )
}
