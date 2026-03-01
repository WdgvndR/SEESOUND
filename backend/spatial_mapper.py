"""
SEESOUND — Spatial Mapper
=========================
Translates each pure sine-wave component into a position on the canvas
using the Harmonic Complexity Displacement model:

    r = c · D          (distance from centre driven by ratio denominator)
    θ = pan · π/2      (angle driven by stereo panning)

Where N/D is the simplest integer ratio of the component's frequency to
the session tonic (e.g.,  440 Hz → 660 Hz  yields  2/3,  so D = 3).
"""

from __future__ import annotations

import math
from fractions import Fraction


# ---------------------------------------------------------------------------
# Ratio derivation
# ---------------------------------------------------------------------------

def freq_ratio(
    freq: float,
    tonic: float,
    max_denominator: int = 32,
) -> tuple[int, int]:
    """
    Return the simplest integer ratio (N, D) such that N/D ≈ freq / tonic.

    Parameters
    ----------
    freq            Component frequency in Hz.
    tonic           Tonic (root) frequency in Hz.
    max_denominator Upper bound on D; limits the maximum canvas radius.

    Returns
    -------
    (N, D)  Both integers ≥ 1.

    Examples
    --------
    >>> freq_ratio(660, 440)     # perfect 5th  → 3/2
    (3, 2)
    >>> freq_ratio(550, 440)     # major 3rd    → 5/4
    (5, 4)
    >>> freq_ratio(440, 440)     # unison       → 1/1
    (1, 1)
    """
    if tonic <= 0 or freq <= 0:
        return (1, 1)

    raw = freq / tonic
    # Fold into the range [1, 2) so we always compare within one octave
    while raw >= 2.0:
        raw /= 2.0
    while raw < 1.0:
        raw *= 2.0

    frac = Fraction(raw).limit_denominator(max_denominator)
    return (int(frac.numerator), int(frac.denominator))


# ---------------------------------------------------------------------------
# Pan → angle
# ---------------------------------------------------------------------------

def pan_to_angle(pan: float) -> float:
    """
    Map stereo pan to a polar canvas angle.

        pan = -1.0  →  θ = -π/2  (canvas left)
        pan =  0.0  →  θ =  0    (canvas top / 12 o'clock)
        pan = +1.0  →  θ = +π/2  (canvas right)

    Parameters
    ----------
    pan  Stereo position in [-1, +1].

    Returns
    -------
    Angle in radians.
    """
    return float(pan) * (math.pi / 2.0)


# ---------------------------------------------------------------------------
# Polar → Cartesian
# ---------------------------------------------------------------------------

def polar_to_cartesian(radius: float, angle: float) -> tuple[float, float]:
    """
    Convert polar (r, θ) to Cartesian (x, y) in standard screen layout
    where θ = 0 points upward (−Y direction in screen coords).

        x =  r · sin(θ)
        y = -r · cos(θ)

    Both values are in the same units as radius.

    Parameters
    ----------
    radius  Distance from the canvas centre.
    angle   Angle in radians (from the upward +Y axis, clockwise positive).

    Returns
    -------
    (x, y)  Normalised canvas coordinates.
    """
    x = radius * math.sin(angle)
    y = -radius * math.cos(angle)
    return (x, y)


# ---------------------------------------------------------------------------
# One-shot spatial mapping
# ---------------------------------------------------------------------------

def compute_spatial(
    freq: float,
    pan: float,
    tonic: float,
    radius_scale: float = 0.12,
    max_denominator: int = 32,
) -> dict:
    """
    Full spatial pipeline for a single wave component.

    Parameters
    ----------
    freq            Component frequency in Hz.
    pan             Stereo pan in [-1, +1].
    tonic           Tonic frequency in Hz.
    radius_scale    Constant *c* in  r = c · D.
    max_denominator Max denominator for ratio simplification.

    Returns
    -------
    dict with keys:
        ratio_n, ratio_d     – integer ratio
        radius               – normalised distance from canvas centre
        angle                – polar angle in radians
        x, y                 – normalised Cartesian canvas coordinates
    """
    n, d = freq_ratio(freq, tonic, max_denominator)
    r = radius_scale * d
    theta = pan_to_angle(pan)
    x, y = polar_to_cartesian(r, theta)

    return {
        "ratio_n": n,
        "ratio_d": d,
        "radius": round(r, 6),
        "angle": round(theta, 6),
        "x": round(x, 6),
        "y": round(y, 6),
    }
