"""
SEESOUND — Visual Mapper
========================
Pure functions that convert acoustic properties of a sine-wave component
into visual properties ready for the canvas renderer.

BASE MAPPING RULES
──────────────────
  Pitch (frequency)      → Hue  (via ColorEngine — see color_engine.py)
  Amplitude              → Opacity  +  Size
  Time (decay)           → Opacity  (multiplied on top of amplitude opacity)
  Speed (note density)   → Quantity of visual elements  (frame-level)
  Order (harmonicity)    → Clarity  (visual sharpness / focus)

All outputs are in normalised ranges unless stated otherwise.
"""

from __future__ import annotations

import math
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from color_engine import ColorEngine


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _clamp(value: float, lo: float = 0.0, hi: float = 1.0) -> float:
    return max(lo, min(hi, value))


# ---------------------------------------------------------------------------
# Pitch → Hue
# ---------------------------------------------------------------------------

# Synesthetic / spectral mapping anchored so that A (La) = 0° (red-warm).
# Each semitone steps 30° around the hue wheel (360° / 12 semitones).
# Reference: A4 = 440 Hz → semitone 0 → hue 0°.

_REFERENCE_FREQ = 440.0    # A4


def freq_to_hue(freq: float) -> float:
    """
    Map a frequency to a hue angle in degrees [0, 360).

    Uses equal-temperament semitone distance from A4 (440 Hz),
    folded into one octave.  Each of the 12 pitch classes occupies
    exactly 30° of the colour wheel.

    Parameters
    ----------
    freq  Frequency in Hz (must be > 0).

    Returns
    -------
    Hue in degrees [0, 360).
    """
    if freq <= 0:
        return 0.0
    semitones = 12.0 * math.log2(freq / _REFERENCE_FREQ)
    # Fold to [0, 12) then scale to [0, 360)
    hue = (semitones % 12.0) * 30.0
    return round(hue % 360.0, 2)


# ---------------------------------------------------------------------------
# Amplitude → Opacity  &  Size
# ---------------------------------------------------------------------------

def amplitude_to_opacity(
    amplitude: float,
    opacity_max: float = 1.0,
) -> float:
    """
    Louder components are more opaque.

    A square-root curve is used so that quiet sounds remain visible
    while the dynamic range still registers visually.

    Parameters
    ----------
    amplitude   Normalised amplitude in [0, 1].
    opacity_max Global opacity ceiling from user params.

    Returns
    -------
    Opacity in [0, opacity_max].
    """
    raw = math.sqrt(_clamp(amplitude))
    return round(_clamp(raw * opacity_max), 4)


def amplitude_to_size(
    amplitude: float,
    size_scale: float = 1.0,
    min_size: float = 0.1,
    max_size: float = 4.0,
) -> float:
    """
    Louder components produce larger visual elements.

    Uses a power curve (^0.7) so that loud sounds don't completely
    dwarf quiet ones.

    Parameters
    ----------
    amplitude   Normalised amplitude in [0, 1].
    size_scale  Global size multiplier from user params.
    min_size    Minimum size (normalised units, 1.0 == base canvas unit).
    max_size    Maximum size.

    Returns
    -------
    Relative element size.
    """
    raw = min_size + (_clamp(amplitude) ** 0.7) * (max_size - min_size)
    return round(raw * size_scale, 4)


# ---------------------------------------------------------------------------
# Time → Opacity decay
# ---------------------------------------------------------------------------

def time_decay_factor(
    age_seconds: float,
    half_life: float = 2.0,
) -> float:
    """
    Exponential decay factor applied to opacity as a component ages.

            decay = 2^( -age / half_life )

    Parameters
    ----------
    age_seconds  How long (in seconds) since this component was first seen.
    half_life    Time in seconds for opacity to halve (user-editable).

    Returns
    -------
    Multiplier in (0, 1].  Returns 1.0 when age == 0.
    """
    if half_life <= 0:
        return 1.0
    factor = 2.0 ** (-age_seconds / half_life)
    return round(_clamp(factor), 6)


def apply_time_decay(
    opacity: float,
    age_seconds: float,
    half_life: float = 2.0,
) -> float:
    """
    Multiply an existing opacity value by the time-decay factor.
    Convenience wrapper combining amplitude opacity + time decay.
    """
    return round(_clamp(opacity * time_decay_factor(age_seconds, half_life)), 4)


# ---------------------------------------------------------------------------
# Harmonicity → Clarity
# ---------------------------------------------------------------------------

def ratio_to_clarity(ratio_n: int, ratio_d: int) -> float:
    """
    Convert a harmonic ratio (N, D) to a visual clarity value in [0, 1].

    The simplest ratios (1/1, 2/1, 3/2 …) are the most consonant and
    produce the sharpest, most focused visuals.  Complex ratios (large N
    and D) produce diffuse, low-clarity visuals.

    Formula:
        complexity = log2( max(N, D) )  capped at log2(32) = 5
        clarity    = 1 − complexity / 5

    Parameters
    ----------
    ratio_n  Numerator.
    ratio_d  Denominator.

    Returns
    -------
    Clarity in [0, 1].  1.0 == perfect unison / octave.
    """
    if ratio_n <= 0 or ratio_d <= 0:
        return 0.5
    complexity_raw = math.log2(max(ratio_n, ratio_d))
    complexity_norm = _clamp(complexity_raw / 5.0)   # 5 = log2(32)
    clarity = 1.0 - complexity_norm
    return round(_clamp(clarity), 4)


# ---------------------------------------------------------------------------
# Speed (note density) → Quantity
# ---------------------------------------------------------------------------

def density_to_quantity(onset_rate: float, base_peaks: int = 64) -> int:
    """
    Map the onset density (onsets per second) to the maximum number of
    visible elements emitted per frame.

    Faster / more percussive passages → more simultaneous visual elements.
    Slow, held tones → fewer, larger elements.

    Formula (logarithmic):
        quantity = base_peaks × clamp( log2(1 + onset_rate) / log2(17), 0, 1 )

    At 0 onsets/s  →  quantity = 0  (silence)
    At 16 onsets/s →  quantity = base_peaks  (very busy)

    Parameters
    ----------
    onset_rate  Detected onsets per second in the current frame window.
    base_peaks  The configured n_peaks ceiling from AnalysisParams.

    Returns
    -------
    Integer count of elements to emit this frame.
    """
    if onset_rate <= 0:
        return base_peaks   # default: emit all detected peaks
    scale = _clamp(math.log2(1.0 + onset_rate) / math.log2(17.0))
    return max(1, round(base_peaks * scale))


# ---------------------------------------------------------------------------
# Master: apply all visual mappings at once
# ---------------------------------------------------------------------------

def compute_visual(
    freq: float,
    amplitude: float,
    ratio_n: int,
    ratio_d: int,
    age_seconds: float = 0.0,
    size_scale: float = 1.0,
    opacity_max: float = 1.0,
    time_decay: float = 2.0,
    color_engine: "ColorEngine | None" = None,
) -> dict:
    """
    Run all visual mapping rules for a single wave component and
    return a dict ready to merge into WaveComponent.

    Parameters
    ----------
    freq            Hz
    amplitude       Normalised amplitude [0, 1]
    ratio_n/d       Simplified harmonic ratio integers
    age_seconds     Seconds since this component was first detected
    size_scale      Global size multiplier (from AnalysisParams)
    opacity_max     Global opacity ceiling (from AnalysisParams)
    time_decay      Half-life for opacity decay in seconds
    color_engine    ColorEngine instance (from color_engine.py).
                    When supplied, derives hue + all color fields from the
                    perceptually-calibrated color pipeline.
                    When None, falls back to the simple freq_to_hue() mapping.

    Returns
    -------
    dict with keys:
        hue, opacity, size, clarity            (always present)
        note, color_rgb, grayscale_target,     (present when color_engine supplied)
        grayscale_actual, color_hsl_string
    """
    raw_opacity = amplitude_to_opacity(amplitude, opacity_max)
    opacity = apply_time_decay(raw_opacity, age_seconds, time_decay)
    size = amplitude_to_size(amplitude, size_scale)
    clarity = ratio_to_clarity(ratio_n, ratio_d)

    if color_engine is not None:
        color = color_engine.freq_to_color(freq)
        return {
            "hue":               color["hue"],
            "opacity":           opacity,
            "size":              size,
            "clarity":           clarity,
            # Color engine extras
            "note":              color["note"],
            "color_rgb":         color["rgb"],
            "grayscale_target":  color["target_grayscale"],
            "grayscale_actual":  color["grayscale"],
            "color_hsl_string":  color["hsl_string"],
        }

    # Fallback: simple semitone-based hue (no luminance matching)
    hue = freq_to_hue(freq)
    return {
        "hue":               hue,
        "opacity":           opacity,
        "size":              size,
        "clarity":           clarity,
        "note":              "",
        "color_rgb":         (0, 0, 0),
        "grayscale_target":  0,
        "grayscale_actual":  0,
        "color_hsl_string":  "",
    }
