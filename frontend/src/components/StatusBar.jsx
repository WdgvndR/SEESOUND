/**
 * StatusBar — connection indicator + transport controls at the bottom.
 */

const STATUS_COLOR = {
    open: '#4ade80',
    connecting: '#facc15',
    closed: '#94a3b8',
    error: '#f87171',
}

export default function StatusBar({
    wsStatus,
    jobStatus,
    fps,
    frameCount,
    onStop,
}) {
    return (
        <footer className="status-bar">
            {/* WS connection dot */}
            <div className="status-bar-ws" title={`WebSocket: ${wsStatus}`}>
                <span
                    className="status-dot"
                    style={{ background: STATUS_COLOR[wsStatus] }}
                />
                <span className="status-label">{wsStatus}</span>
            </div>

            {/* Job info */}
            {jobStatus && (
                <span className="status-job">
                    Job: <strong>{jobStatus}</strong>
                </span>
            )}

            {/* Frame counter */}
            <span className="status-frames">
                Frames: <strong>{frameCount}</strong>
            </span>

            {/* FPS */}
            <span className="status-fps">
                {fps.toFixed(1)} FPS
            </span>

            {/* Transport */}
            <div className="status-bar-actions">
                <button
                    className="stop-btn"
                    onClick={onStop}
                    disabled={jobStatus !== 'running'}
                >
                    ⏹ Stop Analysis
                </button>
            </div>
        </footer>
    )
}
