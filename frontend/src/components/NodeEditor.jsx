/**
 * SEESOUND — NodeEditor.jsx
 * ════════════════════════════════════════════════════════════════════════════
 * Visual node-graph editor for audio→visual mappings.
 *
 * Nodes
 * ──────
 *   audioInputNode   – Source: one audio feature → single output
 *   mathNode         – Single-input mathematical transform
 *   visualOutputNode – Sink: applies value to one visual property
 *
 * Props
 * ──────
 *   nodes          [Array]   React Flow node objects (controlled)
 *   edges          [Array]   React Flow edge objects (controlled)
 *   onNodesChange  [fn]      useNodesState change handler
 *   onEdgesChange  [fn]      useEdgesState change handler
 *   onConnect      [fn]      Called when a new edge is drawn
 *   onUpdateNode   [fn(id, data)]  Called when a node's data changes
 *   onAddNode      [fn(type, data)]
 *   onDeleteNode   [fn(id)]
 */

import { useCallback, useState, useRef, memo } from 'react'
import {
    ReactFlow,
    Controls,
    Background,
    MiniMap,
    Handle,
    Position,
    getBezierPath,
    BaseEdge,
    MarkerType,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import {
    Zap, Calculator, Eye, Trash2, Plus, ChevronDown,
    Radio, Cpu, Target,
} from 'lucide-react'
import { AUDIO_INPUTS, MATH_OPS, VISUAL_OUTPUTS } from '../engine/GraphEvaluator.js'

// ─── Colour palette (matching SEESOUND dark theme) ───────────────────────────
const COLORS = {
    input: { bg: '#0f2540', border: '#1d6fa4', header: '#155e8f', text: '#7dd3fc', icon: '#38bdf8' },
    math: { bg: '#1a1505', border: '#92610a', header: '#7c5a0a', text: '#fcd34d', icon: '#fbbf24' },
    output: { bg: '#0a1f12', border: '#166534', header: '#15623a', text: '#6ee7b7', icon: '#34d399' },
}

// ─── Shared mini-select ───────────────────────────────────────────────────────
function NSelect({ value, onChange, options, style }) {
    return (
        <div style={{ position: 'relative', ...style }}>
            <select
                value={value}
                onChange={e => onChange(e.target.value)}
                style={{
                    width: '100%', background: 'rgba(0,0,0,0.55)', color: '#dde',
                    border: '1px solid rgba(255,255,255,0.12)', borderRadius: 4,
                    padding: '3px 24px 3px 8px', fontSize: 11, appearance: 'none',
                    cursor: 'pointer',
                }}
            >
                {options.map(o => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                ))}
            </select>
            <ChevronDown size={10} style={{
                position: 'absolute', right: 6, top: '50%', transform: 'translateY(-50%)',
                color: '#aaa', pointerEvents: 'none',
            }} />
        </div>
    )
}

// ─── Shared header bar ────────────────────────────────────────────────────────
function NodeHeader({ icon: Icon, label, colors, onDelete }) {
    return (
        <div style={{
            background: colors.header, borderRadius: '6px 6px 0 0',
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '5px 8px 5px 8px',
        }}>
            <Icon size={12} color={colors.icon} />
            <span style={{ color: colors.text, fontSize: 11, fontWeight: 600, flex: 1 }}>{label}</span>
            <button
                onClick={onDelete}
                style={{
                    background: 'none', border: 'none', cursor: 'pointer',
                    padding: 1, color: '#f87171', opacity: 0.7, lineHeight: 1,
                }}
                title="Delete node"
            ><Trash2 size={10} /></button>
        </div>
    )
}

// ─── NODE: Audio Input ────────────────────────────────────────────────────────
const AudioInputNode = memo(({ id, data, selected }) => {
    const c = COLORS.input
    const sourceOptions = Object.entries(AUDIO_INPUTS).map(([v, { label }]) => ({ value: v, label }))
    return (
        <div style={{
            background: c.bg, border: `1.5px solid ${selected ? '#7dd3fc' : c.border}`,
            borderRadius: 7, minWidth: 170, boxShadow: selected ? `0 0 0 2px ${c.border}44` : undefined,
        }}>
            <NodeHeader icon={Radio} label="Audio Input" colors={c} onDelete={() => data.onDelete(id)} />
            <div style={{ padding: '8px 10px 10px' }}>
                <div style={{ fontSize: 10, color: '#7aa8c2', marginBottom: 4 }}>Source</div>
                <NSelect
                    value={data.source || 'amplitude'}
                    onChange={val => data.onChange(id, { ...data, source: val })}
                    options={sourceOptions}
                />
                <div style={{ fontSize: 9, color: '#6b9ab5', marginTop: 5, lineHeight: 1.4 }}>
                    {AUDIO_INPUTS[data.source || 'amplitude']?.desc}
                </div>
            </div>
            <Handle
                type="source" position={Position.Right}
                style={{ background: c.border, width: 10, height: 10, right: -5 }}
            />
        </div>
    )
})
AudioInputNode.displayName = 'AudioInputNode'

// ─── NODE: Math Transform ─────────────────────────────────────────────────────
const MathNode = memo(({ id, data, selected }) => {
    const c = COLORS.math
    const opOptions = Object.entries(MATH_OPS).map(([v, { label }]) => ({ value: v, label }))
    const opDef = MATH_OPS[data.operation || 'multiply']
    const hasAmount = opDef?.amountLabel != null
    return (
        <div style={{
            background: c.bg, border: `1.5px solid ${selected ? '#fcd34d' : c.border}`,
            borderRadius: 7, minWidth: 170, boxShadow: selected ? `0 0 0 2px ${c.border}44` : undefined,
        }}>
            <NodeHeader icon={Calculator} label="Math" colors={c} onDelete={() => data.onDelete(id)} />
            <div style={{ padding: '8px 10px 10px' }}>
                <div style={{ fontSize: 10, color: '#c4a135', marginBottom: 4 }}>Operation</div>
                <NSelect
                    value={data.operation || 'multiply'}
                    onChange={val => data.onChange(id, { ...data, operation: val })}
                    options={opOptions}
                />
                {hasAmount && (
                    <div style={{ marginTop: 6 }}>
                        <div style={{ fontSize: 10, color: '#c4a135', marginBottom: 3 }}>
                            {opDef.amountLabel}
                        </div>
                        <input
                            type="number"
                            value={data.amount ?? 1}
                            step={0.01}
                            onChange={e => data.onChange(id, { ...data, amount: parseFloat(e.target.value) || 0 })}
                            style={{
                                width: '100%', background: 'rgba(0,0,0,0.55)', color: '#fcd34d',
                                border: '1px solid rgba(255,255,255,0.12)', borderRadius: 4,
                                padding: '3px 8px', fontSize: 11, boxSizing: 'border-box',
                            }}
                        />
                    </div>
                )}
                <div style={{ fontSize: 9, color: '#9a7a25', marginTop: 5, lineHeight: 1.4 }}>
                    {opDef?.desc}
                </div>
            </div>
            <Handle
                type="target" position={Position.Left}
                style={{ background: c.border, width: 10, height: 10, left: -5 }}
            />
            <Handle
                type="source" position={Position.Right}
                style={{ background: c.border, width: 10, height: 10, right: -5 }}
            />
        </div>
    )
})
MathNode.displayName = 'MathNode'

// ─── NODE: Visual Output ──────────────────────────────────────────────────────
const VisualOutputNode = memo(({ id, data, selected }) => {
    const c = COLORS.output
    const targetOptions = Object.entries(VISUAL_OUTPUTS).map(([v, { label }]) => ({ value: v, label }))
    const modeOptions = [
        { value: 'multiply', label: 'Multiply ×' },
        { value: 'add', label: 'Add +' },
        { value: 'set', label: 'Set =' },
    ]
    return (
        <div style={{
            background: c.bg, border: `1.5px solid ${selected ? '#6ee7b7' : c.border}`,
            borderRadius: 7, minWidth: 170, boxShadow: selected ? `0 0 0 2px ${c.border}44` : undefined,
        }}>
            <NodeHeader icon={Target} label="Visual Output" colors={c} onDelete={() => data.onDelete(id)} />
            <div style={{ padding: '8px 10px 10px' }}>
                <div style={{ fontSize: 10, color: '#4aac7c', marginBottom: 4 }}>Target</div>
                <NSelect
                    value={data.target || 'radius_mult'}
                    onChange={val => data.onChange(id, { ...data, target: val })}
                    options={targetOptions}
                />
                <div style={{ fontSize: 10, color: '#4aac7c', marginBottom: 4, marginTop: 6 }}>Mode</div>
                <NSelect
                    value={data.mode || 'multiply'}
                    onChange={val => data.onChange(id, { ...data, mode: val })}
                    options={modeOptions}
                />
                <div style={{ fontSize: 9, color: '#376b4e', marginTop: 5, lineHeight: 1.4 }}>
                    {VISUAL_OUTPUTS[data.target || 'radius_mult']?.desc}
                </div>
            </div>
            <Handle
                type="target" position={Position.Left}
                style={{ background: c.border, width: 10, height: 10, left: -5 }}
            />
        </div>
    )
})
VisualOutputNode.displayName = 'VisualOutputNode'

// ─── Node type registry (kept stable — must be defined outside component) ─────
const NODE_TYPES = {
    audioInputNode: AudioInputNode,
    mathNode: MathNode,
    visualOutputNode: VisualOutputNode,
}

// ─── Toolbar button ───────────────────────────────────────────────────────────
function ToolBtn({ icon: Icon, label, color, onClick }) {
    const [hover, setHover] = useState(false)
    return (
        <button
            onClick={onClick}
            onMouseEnter={() => setHover(true)}
            onMouseLeave={() => setHover(false)}
            style={{
                display: 'flex', alignItems: 'center', gap: 5,
                background: hover ? `${color}22` : 'rgba(255,255,255,0.04)',
                border: `1px solid ${hover ? color : 'rgba(255,255,255,0.12)'}`,
                borderRadius: 5, padding: '4px 10px', cursor: 'pointer',
                color: hover ? color : '#aab', fontSize: 11, fontWeight: 500,
                transition: 'all 0.15s',
            }}
        >
            <Icon size={12} />{label}
        </button>
    )
}

// ─── Legend / help text ───────────────────────────────────────────────────────
function EmptyState() {
    return (
        <div style={{
            position: 'absolute', top: '50%', left: '50%',
            transform: 'translate(-50%,-50%)',
            textAlign: 'center', pointerEvents: 'none', color: '#3a4e65',
        }}>
            <Cpu size={36} style={{ marginBottom: 10, opacity: 0.4 }} />
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>Node Graph Empty</div>
            <div style={{ fontSize: 11, lineHeight: 1.6, maxWidth: 240 }}>
                Add <span style={{ color: '#38bdf8' }}>Audio Input</span>, <span style={{ color: '#fbbf24' }}>Math</span>, and <span style={{ color: '#34d399' }}>Visual Output</span> nodes,
                then drag from the right handle of one node to the left handle of the next to connect them.
            </div>
        </div>
    )
}

// ─────────────────────────────────────────────────────────────────────────────
// Main component
// ─────────────────────────────────────────────────────────────────────────────

let _nodeIdCounter = 1
function nextId() { return `node_${Date.now()}_${_nodeIdCounter++}` }

export default function NodeEditor({ nodes, edges, onNodesChange, onEdgesChange, onConnect, onUpdateNode, onAddNode, onDeleteNode }) {
    const reactFlowWrapper = useRef(null)
    const [reactFlowInstance, setReactFlowInstance] = useState(null)

    // Inject callbacks into node data on every render
    // (ReactFlow node data isn't deeply reactive so we pass function refs)
    const nodesWithCallbacks = nodes.map(n => ({
        ...n,
        data: {
            ...n.data,
            onChange: onUpdateNode,
            onDelete: onDeleteNode,
        },
    }))

    const handleConnect = useCallback((params) => {
        onConnect({
            ...params,
            animated: true,
            style: { stroke: '#4d7fa8', strokeWidth: 2 },
            markerEnd: { type: MarkerType.ArrowClosed, color: '#4d7fa8' },
        })
    }, [onConnect])

    const addNode = useCallback((type) => {
        const id = nextId()
        const vp = reactFlowInstance?.getViewport() ?? { x: 50, y: 50, zoom: 1 }
        const x = (200 + Math.random() * 60) / vp.zoom
        const y = (150 + Math.random() * 60) / vp.zoom
        let data = {}
        if (type === 'audioInputNode') data = { source: 'amplitude' }
        if (type === 'mathNode') data = { operation: 'multiply', amount: 1 }
        if (type === 'visualOutputNode') data = { target: 'radius_mult', mode: 'multiply' }
        onAddNode({ id, type, position: { x, y }, data })
    }, [reactFlowInstance, onAddNode])

    const edgeStyle = { stroke: '#2a5070', strokeWidth: 1.5 }
    const defaultEdgeOptions = {
        style: edgeStyle,
        animated: true,
        markerEnd: { type: MarkerType.ArrowClosed, color: '#2a5070' },
    }

    return (
        <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: '#07101a' }}>
            {/* ── Toolbar ─────────────────────────────────────────────────── */}
            <div style={{
                display: 'flex', alignItems: 'center', gap: 6,
                padding: '7px 10px', borderBottom: '1px solid rgba(255,255,255,0.07)',
                flexShrink: 0,
            }}>
                <span style={{ fontSize: 10, color: '#556', marginRight: 4, fontWeight: 600, letterSpacing: 1, textTransform: 'uppercase' }}>Add</span>
                <ToolBtn icon={Radio} label="Input" color="#38bdf8" onClick={() => addNode('audioInputNode')} />
                <ToolBtn icon={Calculator} label="Math" color="#fbbf24" onClick={() => addNode('mathNode')} />
                <ToolBtn icon={Target} label="Output" color="#34d399" onClick={() => addNode('visualOutputNode')} />
                <div style={{ flex: 1 }} />
                <span style={{ fontSize: 10, color: '#445566', fontStyle: 'italic' }}>
                    {nodes.length === 0 ? 'Empty' : `${nodes.length} node${nodes.length !== 1 ? 's' : ''}, ${edges.length} wire${edges.length !== 1 ? 's' : ''}`}
                </span>
            </div>

            {/* ── Flow canvas ─────────────────────────────────────────────── */}
            <div ref={reactFlowWrapper} style={{ flex: 1, position: 'relative' }}>
                {nodes.length === 0 && <EmptyState />}
                <ReactFlow
                    nodes={nodesWithCallbacks}
                    edges={edges}
                    onNodesChange={onNodesChange}
                    onEdgesChange={onEdgesChange}
                    onConnect={handleConnect}
                    onInit={setReactFlowInstance}
                    nodeTypes={NODE_TYPES}
                    defaultEdgeOptions={defaultEdgeOptions}
                    fitView
                    fitViewOptions={{ padding: 0.2 }}
                    proOptions={{ hideAttribution: true }}
                    style={{ background: '#070e18' }}
                    deleteKeyCode="Delete"
                >
                    <Background color="#1a2e45" gap={22} size={1} />
                    <Controls
                        style={{ background: '#0d1e2d', border: '1px solid #1a3450' }}
                        showInteractive={false}
                    />
                    <MiniMap
                        style={{ background: '#0d1e2d', border: '1px solid #1a3450', height: 80 }}
                        nodeColor={n => {
                            if (n.type === 'audioInputNode') return COLORS.input.border
                            if (n.type === 'mathNode') return COLORS.math.border
                            if (n.type === 'visualOutputNode') return COLORS.output.border
                            return '#555'
                        }}
                        maskColor="rgba(0,0,0,0.55)"
                    />
                </ReactFlow>
            </div>

            {/* ── Help footer ─────────────────────────────────────────────── */}
            <div style={{
                padding: '5px 12px', borderTop: '1px solid rgba(255,255,255,0.05)',
                fontSize: 10, color: '#2d4a60', flexShrink: 0,
                display: 'flex', gap: 14,
            }}>
                <span><kbd style={{ background: '#111', border: '1px solid #333', borderRadius: 3, padding: '1px 4px' }}>Del</kbd> remove selected</span>
                <span>Drag handle → handle to wire nodes</span>
                <span>Scroll to zoom · Drag canvas to pan</span>
            </div>
        </div>
    )
}
