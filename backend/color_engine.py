"""
SEESOUND — Color Engine
=======================
Maps frequencies to perceptually-calibrated colors via a pre-computed
120-entry lookup table covering C0 (~16 Hz) through B9 (~15 800 Hz).

Design — fast path
──────────────────
  1. At startup (and whenever the palette changes) calculate_freq_color_table()
     builds a 120-entry dict  { "A4": (R,G,B), … }  from the 12 user-chosen
     note colors, smoothly varying HSL lightness across octaves so that low
     notes appear darker and high notes appear brighter.

  2. During analysis ColorEngine.freq_to_color() does a single O(1) dict
     lookup — no iterative HSL search, no per-frame computation.

  3. The table can be rebuilt at any time via the frontend "Calculate All"
     button, or individual entries can be edited manually.
"""

from __future__ import annotations

import colorsys
import math
from dataclasses import dataclass, field
from typing import Literal

# ---------------------------------------------------------------------------
# Note ordering used throughout (standard MIDI pitch-class 0 = C)
# ---------------------------------------------------------------------------

NOTE_ORDER = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]

# Default 12-note palette — visually vibrant, evenly distributed hues.
# Each value is (R, G, B) in 0–255.
DEFAULT_NOTE_COLORS: dict[str, tuple[int, int, int]] = {
    "C":  (255,   0,   0),
    "C#": (143,   0, 255),
    "D":  (255, 255,   0),
    "D#": (183,  70, 139),
    "E":  (195, 242, 255),
    "F":  (170,   0,  52),
    "F#": (127, 139, 254),
    "G":  (255, 127,   1),
    "G#": (187, 117, 252),
    "A":  ( 54, 204,  51),
    "A#": (169, 103, 124),
    "B":  (142, 201, 255),
}

# Reference frequency for equal-temperament note identification.
_A4_HZ = 440.0

# ---------------------------------------------------------------------------
# User-provided core functions (integrated verbatim with docstrings preserved)
# ---------------------------------------------------------------------------

def rgb_to_grayscale(
    r: int,
    g: int,
    b: int,
    w_r: float = 0.299,
    w_g: float = 0.587,
    w_b: float = 0.114,
) -> int:
    """
    Convert an RGB color to grayscale using the weighted average equation.

    Default weights follow ITU-R BT.601 (the standard for SDTV):
        gray = 0.299·R + 0.587·G + 0.114·B

    The weights are editable via ColorConfig; this function accepts them as
    positional arguments so lru_cache can key on them.
    """
    return int(w_r * r + w_g * g + w_b * b)


def rgb_to_hsl_string(r: int, g: int, b: int) -> str:
    """
    Convert RGB values to an HSL string.
    """
    h, l, s = colorsys.rgb_to_hls(r / 255.0, g / 255.0, b / 255.0)
    return f"({int(h * 360)}, {int(s * 100)}%, {int(l * 100)}%)"


# ---------------------------------------------------------------------------
# Frequency → pitch-class helpers
# ---------------------------------------------------------------------------

def freq_to_note(freq: float) -> str:
    """
    Return the nearest pitch-class name (C, C#, D … B) for a given frequency.

    Uses equal temperament relative to A4 = 440 Hz.
    Returns 'C' if freq ≤ 0.
    """
    if freq <= 0:
        return "C"
    semitones_from_a4 = 12.0 * math.log2(freq / _A4_HZ)
    # Semitone 0 = A4,  A is index 9 in NOTE_ORDER (C=0, D=2, E=4 … A=9)
    pitch_class_index = int(round(semitones_from_a4)) % 12
    # Rotate: A4 is index 9 in the C-rooted scale
    note_index = (pitch_class_index + 9) % 12
    return NOTE_ORDER[note_index]


def rgb_to_hue(r: int, g: int, b: int) -> float:
    """Extract hue (degrees, 0–360) from an RGB tuple."""
    h, l, s = colorsys.rgb_to_hls(r / 255.0, g / 255.0, b / 255.0)
    return round((h * 360.0) % 360.0, 2)


def hsv_to_rgb(h_deg: float, s: float, v: float) -> tuple[int, int, int]:
    """Convert HSV (h in degrees 0–360, s/v in 0–1) to RGB 0–255."""
    r, g, b = colorsys.hsv_to_rgb(h_deg / 360.0, s, v)
    return (int(r * 255), int(g * 255), int(b * 255))


# ---------------------------------------------------------------------------
# Frequency → note-octave key  (e.g. "A4", "C#3")
# ---------------------------------------------------------------------------

def freq_to_note_octave(freq: float) -> str:
    """
    Return a note-octave string (e.g. "A4", "C#3") for a given frequency.

    Coverage: C0 (16.35 Hz) — B9 (~15 804 Hz).  Out-of-range frequencies
    are clamped to the nearest boundary note.
    Uses equal temperament relative to A4 = 440 Hz.
    """
    if freq <= 0:
        return "C0"
    semitones_from_a4 = 12.0 * math.log2(freq / _A4_HZ)
    # MIDI note numbers: A4 = 69, C0 = 12, B9 = 131
    midi = int(round(69 + semitones_from_a4))
    midi = max(12, min(131, midi))   # clamp to C0 … B9
    octave = midi // 12 - 1         # C0: 12//12-1=0  A4: 69//12-1=4
    pitch  = NOTE_ORDER[midi % 12]
    return f"{pitch}{octave}"


# ---------------------------------------------------------------------------
# Perceptual luminance matching
# ---------------------------------------------------------------------------

def match_luminance(r: int, g: int, b: int, target_luma: float) -> tuple[int, int, int]:
    """
    Adjust an RGB color to a specific perceptual luminance while preserving hue.

    Parameters
    ----------
    r, g, b      Original RGB values (0–255).
    target_luma  Target grayscale value (0–255).

    Returns
    -------
    (newR, newG, newB) as integers.
    """
    current_luma = 0.299 * r + 0.587 * g + 0.114 * b

    # Handle pure black input to avoid division by zero
    if current_luma == 0:
        v = max(0, min(255, round(target_luma)))
        return (v, v, v)

    ratio = target_luma / current_luma

    r_scaled = r * ratio
    g_scaled = g * ratio
    b_scaled = b * ratio

    max_channel = max(r_scaled, g_scaled, b_scaled)

    # If scaling pushes the color out of bounds, desaturate toward target gray
    if max_channel > 255:
        correction_ratio = (255 - target_luma) / (max_channel - target_luma)
        r_scaled = target_luma + correction_ratio * (r_scaled - target_luma)
        g_scaled = target_luma + correction_ratio * (g_scaled - target_luma)
        b_scaled = target_luma + correction_ratio * (b_scaled - target_luma)

    return (
        max(0, min(255, round(r_scaled))),
        max(0, min(255, round(g_scaled))),
        max(0, min(255, round(b_scaled))),
    )


# ---------------------------------------------------------------------------
# Pre-compute 120-entry frequency color table from 12 note base colors
# ---------------------------------------------------------------------------

def calculate_freq_color_table(
    note_colors: dict,
    n_octaves: int = 10,
    lightness_min: float = 0.20,
    lightness_max: float = 0.85,
    color_input_mode: str = "rgb",
) -> dict[str, tuple[int, int, int]]:
    """
    Build a 120-entry lookup table  { "C0": (R,G,B), …, "B9": (R,G,B) }
    from 12 user-chosen base note colors.

    Algorithm
    ---------
    For every note class (C … B) the hue is preserved while perceptual
    luminance is matched to a target linearly interpolated from
    lightness_min × 255 (octave 0, ~16 Hz) to lightness_max × 255
    (octave 9, ~15 kHz), so that low notes appear darker and high notes
    appear brighter.

    Parameters
    ----------
    note_colors       12-entry dict  {"C": [R,G,B], …}  (or HSV triples when
                      color_input_mode='hsv').
    n_octaves         Number of octaves to generate (default 10 → C0 … B9).
    lightness_min     Target luminance fraction for octave 0  (0.0 – 1.0).
    lightness_max     Target luminance fraction for octave n_octaves-1.
    color_input_mode  'rgb' or 'hsv' — how to interpret note_colors values.

    Returns
    -------
    dict mapping e.g. "A4" → (R, G, B) for all 10 × 12 = 120 combinations.
    """
    table: dict[str, tuple[int, int, int]] = {}
    for octave in range(n_octaves):
        t = octave / max(n_octaves - 1, 1)            # 0.0 … 1.0
        target_luma = (lightness_min + t * (lightness_max - lightness_min)) * 255.0
        for note in NOTE_ORDER:
            raw = note_colors.get(note, note_colors.get("C", [128, 128, 128]))
            if color_input_mode == "hsv":
                r, g, b = hsv_to_rgb(float(raw[0]), float(raw[1]), float(raw[2]))
            else:
                r, g, b = int(raw[0]), int(raw[1]), int(raw[2])
            table[f"{note}{octave}"] = match_luminance(r, g, b, target_luma)
    return table


# ---------------------------------------------------------------------------
# ColorConfig — all editable parameters in one place
# ---------------------------------------------------------------------------

@dataclass
class ColorConfig:
    """
    Editable configuration for the color engine.

    All fields can be updated at runtime from a WebSocket params message.
    Changing note_colors, lightness_min, lightness_max, or color_input_mode
    triggers a rebuild of freq_color_table via __post_init__.
    """

    # ── Spectrum metadata (kept for grayscale WaveComponent fields) ───────────
    spectrum_low_hz:  float = 16.3516    # C0
    spectrum_high_hz: float = 7902.133   # B8
    grayscale_min:    int   = 20
    grayscale_max:    int   = 235

    # ── Perceptual grayscale weights (ITU-R BT.601) ───────────────────────────
    w_r: float = 0.299
    w_g: float = 0.587
    w_b: float = 0.114


    # ── Input mode for note_colors ────────────────────────────────────────────
    color_input_mode: Literal["rgb", "hsv"] = "rgb"

    # ── 12-note base color palette ────────────────────────────────────────────
    note_colors: dict[str, tuple[int | float, int | float, int | float]] = field(
        default_factory=lambda: dict(DEFAULT_NOTE_COLORS)
    )

    # ── Lightness range for Calculate-All sweep (octave 0 → darkest) ─────────
    lightness_min: float = 0.20
    lightness_max: float = 0.85

    # ── Pre-computed 120-entry lookup table  { "A4": (R,G,B), … } ────────────
    # Populated automatically by __post_init__ if empty.
    freq_color_table: dict[str, tuple[int, int, int]] = field(
        default_factory=dict
    )

    def __post_init__(self) -> None:
        """Auto-build freq_color_table from note_colors when the table is empty."""
        if not self.freq_color_table:
            self.freq_color_table = calculate_freq_color_table(
                self.note_colors,
                lightness_min=self.lightness_min,
                lightness_max=self.lightness_max,
                color_input_mode=self.color_input_mode,
            )

    def note_color_as_rgb(self, note: str) -> tuple[int, int, int]:
        """Return the base color for *note* as RGB (0–255), respecting color_input_mode."""
        raw = self.note_colors.get(note, self.note_colors.get("C", (128, 128, 128)))
        if self.color_input_mode == "hsv":
            return hsv_to_rgb(float(raw[0]), float(raw[1]), float(raw[2]))
        return (int(raw[0]), int(raw[1]), int(raw[2]))

# ---------------------------------------------------------------------------
# ColorEngine — O(1) table-lookup color processor
# ---------------------------------------------------------------------------

class ColorEngine:
    """
    Stateful color processor backed by a pre-computed 120-entry lookup table.

    freq_to_color() is a pure O(1) dict lookup — no HSL iteration,
    no per-frame computation.

    Usage
    -----
        engine = ColorEngine(config)
        result = engine.freq_to_color(440.0)   # A4
    """

    def __init__(self, config: ColorConfig | None = None):
        # ColorConfig.__post_init__ builds freq_color_table automatically
        self.config = config or ColorConfig()

    # ── Frequency → target grayscale  (metadata only, not used for color) ────

    def compute_target_grayscale(self, freq: float) -> int:
        """
        Map frequency log-linearly to [grayscale_min … grayscale_max].
        Retained for WaveComponent metadata; not used for color selection.
        """
        cfg = self.config
        lo = math.log2(max(cfg.spectrum_low_hz, 1e-3))
        hi = math.log2(max(cfg.spectrum_high_hz, 1e-3))
        f  = math.log2(max(freq, 1e-3))
        t  = max(0.0, min(1.0, (f - lo) / (hi - lo) if hi != lo else 0.5))
        return int(round(cfg.grayscale_min + t * (cfg.grayscale_max - cfg.grayscale_min)))

    # ── O(1) colour lookup ────────────────────────────────────────────────────

    def freq_to_color(self, freq: float) -> dict:
        """
        Return colour metadata for a frequency via a pre-computed table lookup.

        Returns
        -------
        dict with keys: note, base_rgb, base_grayscale, target_grayscale,
                        rgb, grayscale, hue, hsl_string.
        """
        cfg      = self.config
        note     = freq_to_note(freq)
        note_oct = freq_to_note_octave(freq)

        # O(1) table lookup — table always contains 120 entries (C0 … B9)
        rgb = cfg.freq_color_table.get(note_oct)
        if rgb is None:
            # Fallback: use the un-adjusted base note color
            rgb = cfg.note_color_as_rgb(note)
        r, g, b = int(rgb[0]), int(rgb[1]), int(rgb[2])

        base_r, base_g, base_b = cfg.note_color_as_rgb(note)
        actual_gray  = rgb_to_grayscale(r, g, b, cfg.w_r, cfg.w_g, cfg.w_b)
        target_gray  = self.compute_target_grayscale(freq)
        hue          = rgb_to_hue(r, g, b)
        hsl          = rgb_to_hsl_string(r, g, b)

        return {
            "note":             note,
            "base_rgb":         (base_r, base_g, base_b),
            "base_grayscale":   rgb_to_grayscale(base_r, base_g, base_b, cfg.w_r, cfg.w_g, cfg.w_b),
            "target_grayscale": target_gray,
            "rgb":              (r, g, b),
            "grayscale":        actual_gray,
            "hue":              hue,
            "hsl_string":       hsl,
        }

