"""
SEESOUND — Pydantic data models.

Every object flowing between the analysis engine and the WebSocket
is described here.  Separating models keeps the rest of the codebase
free of raw dict gymnastics.
"""

from __future__ import annotations

from typing import Any, Literal, Optional
from pydantic import BaseModel, Field

from color_engine import DEFAULT_NOTE_COLORS, NOTE_ORDER


# ---------------------------------------------------------------------------
# Per-wave (per-FFT-peak) model
# ---------------------------------------------------------------------------

class WaveComponent(BaseModel):
    """
    A single pure sine-wave extracted from one FFT frame.

    Spatial coordinates are in a normalised canvas space where
    (0, 0) is the canvas centre and 1.0 == half the canvas size.
    The caller scales x/y to actual pixels.
    """

    # --- Signal properties --------------------------------------------------
    freq: float = Field(..., description="Frequency in Hz")
    amplitude: float = Field(..., ge=0.0, le=1.0, description="Normalised amplitude 0–1")
    phase: float = Field(..., description="Phase in radians")
    pan: float = Field(..., ge=-1.0, le=1.0, description="-1 full-left, +1 full-right")

    # --- Harmonic ratio to tonic --------------------------------------------
    ratio_n: int = Field(..., description="Numerator of simplified frequency ratio")
    ratio_d: int = Field(..., description="Denominator (drives canvas radius)")

    # --- Spatial mapping (polar → Cartesian) --------------------------------
    radius: float = Field(..., description="Distance from canvas centre (normalised)")
    angle: float = Field(..., description="Polar angle in radians from +Y axis")
    x: float = Field(..., description="Normalised canvas X (-1 … +1)")
    y: float = Field(..., description="Normalised canvas Y (-1 … +1)")

    # --- Visual mapping outputs ---------------------------------------------
    hue: float = Field(..., ge=0.0, le=360.0, description="HSL hue in degrees (from luminance-adjusted color)")
    opacity: float = Field(..., ge=0.0, le=1.0, description="Alpha 0–1")
    size: float = Field(..., ge=0.0, description="Relative element size (1.0 == base)")
    clarity: float = Field(..., ge=0.0, le=1.0, description="Harmonic clarity 0–1")

    # --- Color engine outputs -----------------------------------------------
    note: str = Field(..., description="Pitch-class name: C, C#, D … B")
    instrument: str = Field(default="Synth / Other", description="Heuristic instrument family label")
    color_rgb: tuple[int, int, int] = Field(
        ..., description="Final RGB after luminance adjustment (0–255 each)"
    )
    grayscale_target: int = Field(
        ..., description="Target grayscale derived from spectrum position (20–235)"
    )
    grayscale_actual: int = Field(
        ..., description="Perceptual grayscale of the adjusted color"
    )
    color_hsl_string: str = Field(
        ..., description="HSL string of the adjusted color, e.g. '(210, 85%, 42%)'"
    )


# ---------------------------------------------------------------------------
# Per-frame model (one time-slice of analysis)
# ---------------------------------------------------------------------------

class AnalysisFrame(BaseModel):
    """
    All wave components active in one short analysis window,
    plus frame-level metadata.
    """

    frame_index: int
    time_seconds: float
    duration_seconds: float = Field(..., description="Length of this analysis window")
    tonic_freq: float = Field(..., description="Detected or user-set tonic (Hz)")

    # Density metric fed from speed/quantity mapping
    quantity: int = Field(..., description="Number of active wave components")

    components: list[WaveComponent]

    # Optional extras (populated when detectable)
    bpm: Optional[float] = None
    rms_db: Optional[float] = None       # frame energy in dB


# ---------------------------------------------------------------------------
# Session-level configuration (sent from frontend via WebSocket)
# ---------------------------------------------------------------------------

class AnalysisParams(BaseModel):
    """
    User-editable parameters that control every stage of the pipeline.
    Reasonable defaults are provided so the engine runs without any
    frontend interaction.
    """

    # FFT
    fft_size: int = Field(default=2048, description="FFT window size (samples)")
    hop_size: int = Field(default=2048,  description="Hop length between frames (2048 ≈ 21 fps at 44100 Hz — safe for any song length)")

    # Tonic / root frequency
    tonic_freq: float = Field(default=0.0,
        description="Tonic in Hz. 0 = auto-detect from first frame")
    tonic_note: str = Field(default="",
        description="Tonic as note name, e.g. 'A4'. Overrides tonic_freq if set.")

    # Spatial
    radius_scale: float = Field(default=0.12,
        description="Scaling constant c in r = c * D")
    max_denominator: int = Field(default=32,
        description="Ratio simplification limit (caps maximum radius)")

    # Peak picking
    n_peaks: int = Field(default=64,
        description="Max sine-wave components to emit per frame")
    amplitude_floor: float = Field(default=0.01,
        description="Normalised amplitude threshold — quieter peaks are dropped")

    # Visual
    size_scale: float = Field(default=1.0,  description="Global size multiplier")
    opacity_max: float = Field(default=1.0, description="Maximum opacity")
    time_decay: float = Field(default=2.0,
        description="Opacity half-life in seconds for time-decay mapping")

    # Color engine
    color: "ColorParams" = Field(
        default_factory=lambda: ColorParams(),
        description="Color engine configuration",
    )

    # ── Frontend rendering parameters (mirrored from Global Parameter Matrix) ──
    # These are stored server-side so the backend can echo them back
    # and optionally use them to influence analysis.

    # Input Gain
    input_gain: float = Field(default=1.0, description="Global sensitivity multiplier")
    amplitude_threshold: float = Field(default=-48, description="Min dB to register shape")
    attack_sensitivity: float = Field(default=80, description="0=slow fade, 100=instant")
    release_decay: float = Field(default=2.0, description="Duration visual remains (s)")

    # Geometry Tuner
    magnitude_size_ratio: float = Field(default=50, description="0=brightness only, 100=area only")
    pitch_size_inversion: float = Field(default=60, description="Low=big, high=tiny factor")
    saliency_weight: float = Field(default=100, description="Contrast boost for abrupt notes")

    # Texture / Timbre
    harmonic_roughness: float = Field(default=30, description="Visual grain from inharmonicity")
    edge_softness: float = Field(default=70, description="100=smooth, 0=sharp")
    shape_complexity: int = Field(default=12, description="Vertex count 3–64")

    # Color Dynamics
    saturation_floor: float = Field(default=20, description="Min saturation %")
    dissonance_desat: float = Field(default=50, description="Desaturation on complex harmonies %")
    brightness_scaling: float = Field(default=50, description="0=opacity, 100=brightness")

    # Mixing Engine
    blend_mode: int = Field(default=0, description="0=Light(additive), 1=Pigment(subtractive)")

    # Advanced Behaviors
    octave_scaling: float = Field(default=50, description="2^40 octave proportionality")
    z_depth: float = Field(default=40, description="Time→depth (shrink+fade)")
    harmonic_clarity: float = Field(default=70, description="Consonance→sharp, dissonance→blur")
    atmospheric_pressure: float = Field(default=30, description="RMS→haze")
    lf_wash: float = Field(default=40, description="Bass→background saturation")
    entropy: float = Field(default=20, description="Complexity→jitter")
    kinetic_pendulum: float = Field(default=50, description="Tempo→mark quantity")
    acoustic_friction: float = Field(default=40, description="Timbre→stroke materiality")
    magnetic_orientation: float = Field(default=50, description="Tonic directional pole")
    fluid_dynamics: float = Field(default=30, description="Low→FOV, high→mist")
    phase_interference: float = Field(default=25, description="Stereo phase→tilt")
    field_rendering: float = Field(default=50, description="Order vs chaos distribution")
    chromatic_gravity: float = Field(default=50, description="Tonic anchors color field")
    depth_displacement: float = Field(default=30, description="LF→canvas depth push")
    source_separation: float = Field(default=50, description="Independent layers per cluster")
    inter_instrumental: float = Field(default=50, description="Harmonic blending proximity")


# ---------------------------------------------------------------------------
# Color engine configuration
# ---------------------------------------------------------------------------

class NoteColorEntry(BaseModel):
    """
    One entry in the 12-note base color palette.

    When color_input_mode == 'rgb' the three values are R, G, B (0–255).
    When color_input_mode == 'hsv' the values are H (0–360°), S (0–1), V (0–1).
    """
    note: str = Field(..., description="Pitch class: C, C#, D, D#, E, F, F#, G, G#, A, A#, B")
    v0: float = Field(..., description="R (0–255) or H (0–360°)")
    v1: float = Field(..., description="G (0–255) or S (0–1)")
    v2: float = Field(..., description="B (0–255) or V (0–1)")


class ColorParams(BaseModel):
    """
    All user-editable parameters for the color engine.
    Sent from the frontend inside AnalysisParams.color.
    """

    # ── Spectrum boundaries ─────────────────────────────────────────────────
    spectrum_low_hz: float = Field(
        default=16.3516,
        description="Lower bound of the audible spectrum in Hz (maps to grayscale_min). Default: C0",
    )
    spectrum_high_hz: float = Field(
        default=7902.133,
        description="Upper bound of the audible spectrum in Hz (maps to grayscale_max). Default: B8",
    )

    # ── Grayscale target range ───────────────────────────────────────────────
    grayscale_min: int = Field(
        default=20,
        ge=0, le=255,
        description="Grayscale value assigned to spectrum_low_hz. 20 ≈ RGB(20,20,20)",
    )
    grayscale_max: int = Field(
        default=235,
        ge=0, le=255,
        description="Grayscale value assigned to spectrum_high_hz. 235 ≈ near-white",
    )

    # ── Perceptual grayscale weights ─────────────────────────────────────────
    w_r: float = Field(default=0.299, ge=0.0, le=1.0, description="Red luminance weight")
    w_g: float = Field(default=0.587, ge=0.0, le=1.0, description="Green luminance weight")
    w_b: float = Field(default=0.114, ge=0.0, le=1.0, description="Blue luminance weight")

    # ── HSL search tolerance ─────────────────────────────────────────────────
    tolerance: int = Field(
        default=1, ge=0, le=20,
        description="Acceptable deviance (±) from target_grayscale in the adjustment search",
    )

    # ── Color input mode ──────────────────────────────────────────────────────
    color_input_mode: Literal["rgb", "hsv"] = Field(
        default="rgb",
        description="Interpretation of note_colors entries: 'rgb' or 'hsv'",
    )

    # ── 12-note base color palette ──────────────────────────────────────────
    note_colors: dict[str, list[float]] = Field(
        default_factory=lambda: {k: list(v) for k, v in DEFAULT_NOTE_COLORS.items()},
        description=(
            "Base color for each of the 12 pitch classes. "
            "Format: {\"C\": [R,G,B], ...} when color_input_mode='rgb', "
            "or {\"C\": [H,S,V], ...} when color_input_mode='hsv'."
        ),
    )

    # ── Lightness sweep for Calculate-All ─────────────────────────────────
    lightness_min: float = Field(
        default=0.20, ge=0.0, le=1.0,
        description="HSL lightness for octave 0 (C0 ∶16 Hz) in the Calculate-All sweep",
    )
    lightness_max: float = Field(
        default=0.85, ge=0.0, le=1.0,
        description="HSL lightness for octave 9 (B9 ∶15 kHz) in the Calculate-All sweep",
    )

    # ── Pre-computed 120-entry frequency color table ───────────────────────
    # Keys are note-octave strings ("C0" … "B9"); values are [R, G, B].
    # Auto-filled by ColorConfig.__post_init__ from note_colors when empty.
    # The frontend 'Calculate All' button populates this and sends it here.
    freq_color_table: dict[str, list[int]] = Field(
        default_factory=dict,
        description="120-entry table {\"C0\": [R,G,B], …, \"B9\": [R,G,B]}. "
                    "If empty the backend auto-builds it from note_colors.",
    )

    def to_color_config(self) -> Any:   # returns color_engine.ColorConfig
        """Convert to a ColorConfig dataclass for use by ColorEngine."""
        from color_engine import ColorConfig
        cfg = ColorConfig(
            spectrum_low_hz=self.spectrum_low_hz,
            spectrum_high_hz=self.spectrum_high_hz,
            grayscale_min=self.grayscale_min,
            grayscale_max=self.grayscale_max,
            w_r=self.w_r,
            w_g=self.w_g,
            w_b=self.w_b,
            color_input_mode=self.color_input_mode,
            note_colors={k: tuple(v) for k, v in self.note_colors.items()},
            lightness_min=self.lightness_min,
            lightness_max=self.lightness_max,
            # Pass the pre-computed table if present; __post_init__ fills it when empty
            freq_color_table={
                k: tuple(int(c) for c in v)
                for k, v in self.freq_color_table.items()
            } if self.freq_color_table else {},
        )
        return cfg


