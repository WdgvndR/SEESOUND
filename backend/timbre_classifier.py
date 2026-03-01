"""
SEESOUND — Timbre Classifier
=============================
Heuristic instrument identification based on per-peak spectral features.

For each detected FFT peak (fundamental frequency + clarity score) the
classifier looks at the full magnitude spectrum to extract properties of
the harmonic series:

    • decay_rate   — how steeply harmonics fall off
    • odd_even     — ratio of odd to even harmonic energy (reedy = high)
    • brightness   — energy-weighted harmonic centroid (index)
    • n_harmonics  — count of harmonics above noise floor

These features are fed to a heuristic decision tree that maps to one of
the instrument labels below.

NOTE: Accuracy is limited by the scope of rule-based classification.
      A neural model (YAMNet, CREPE-timbre) would be more reliable.
      The goal here is musically meaningful grouping, not precision.
"""

from __future__ import annotations

import math
import numpy as np


# ---------------------------------------------------------------------------
# Instrument catalogue
# ---------------------------------------------------------------------------

# Maps label → display name and emoji used in the frontend
INSTRUMENTS: dict[str, dict] = {
    "Sub / Kick":   {"label": "Sub / Kick",    "emoji": "🥁"},
    "Bass":         {"label": "Bass",           "emoji": "🎸"},
    "Cello":        {"label": "Cello",          "emoji": "🎻"},
    "Viola":        {"label": "Viola",          "emoji": "🎻"},
    "Violin":       {"label": "Violin",         "emoji": "🎻"},
    "Piano":        {"label": "Piano",          "emoji": "🎹"},
    "Guitar":       {"label": "Guitar",         "emoji": "🎸"},
    "Flute":        {"label": "Flute",          "emoji": "🎶"},
    "Clarinet":     {"label": "Clarinet",       "emoji": "🎷"},
    "Oboe":         {"label": "Oboe",           "emoji": "🎷"},
    "Saxophone":    {"label": "Saxophone",      "emoji": "🎷"},
    "Trumpet":      {"label": "Trumpet",        "emoji": "🎺"},
    "Trombone":     {"label": "Trombone",       "emoji": "🎺"},
    "French Horn":  {"label": "French Horn",    "emoji": "🎺"},
    "Voice":        {"label": "Voice",          "emoji": "🎤"},
    "Percussion":   {"label": "Percussion",     "emoji": "🥁"},
    "Synth / Other":{"label": "Synth / Other",  "emoji": "🎛️"},
}


# ---------------------------------------------------------------------------
# Harmonic feature extraction
# ---------------------------------------------------------------------------

def _harmonic_mags(
    f0: float,
    magnitudes: np.ndarray,
    freqs: np.ndarray,
    n_harmonics: int = 10,
    window_bins: int = 3,
) -> list[float]:
    """
    Return the magnitude at each harmonic of f0, up to n_harmonics or Nyquist.

    Uses a small window around each harmonic bin to tolerate slight
    tuning variance and FFT bin-boundary misalignment.
    """
    harms: list[float] = []
    for k in range(1, n_harmonics + 1):
        target = f0 * k
        if target > freqs[-1]:
            break
        idx = int(np.searchsorted(freqs, target))
        lo = max(0, idx - window_bins)
        hi = min(len(magnitudes), idx + window_bins + 1)
        harms.append(float(np.max(magnitudes[lo:hi])))
    return harms


def _extract_features(
    f0: float,
    magnitudes: np.ndarray,
    freqs: np.ndarray,
    clarity: float,
) -> dict:
    """
    Compute scalar features from the harmonic series of a single peak.

    Returns a dict with keys:
        f0, clarity, n_harmonics, decay_rate, odd_even, brightness
    """
    harms = _harmonic_mags(f0, magnitudes, freqs)

    feat: dict = {
        "f0": f0,
        "clarity": clarity,
        "n_harmonics": 1,
        "decay_rate": 0.5,
        "odd_even": 1.0,
        "brightness": 0.3,
    }

    if not harms or harms[0] < 1e-12:
        return feat

    # Noise floor: 5 % of the fundamental
    floor = harms[0] * 0.05
    n_present = sum(1 for h in harms if h > floor)
    feat["n_harmonics"] = max(1, n_present)

    if len(harms) < 2:
        return feat

    # Decay rate: log-slope from H1 to last clear harmonic
    log_h = [math.log(max(h, 1e-10)) for h in harms[:n_present]]
    if len(log_h) >= 2:
        feat["decay_rate"] = max(0.0, (log_h[0] - log_h[-1]) / len(log_h))

    # Odd / even harmonic ratio  (H1,H3,H5... vs H2,H4,H6...)
    odds  = sum(harms[k] for k in range(0, len(harms), 2))   # k=0 → H1
    evens = sum(harms[k] for k in range(1, len(harms), 2))   # k=1 → H2
    feat["odd_even"] = odds / (evens + 1e-10)

    # Brightness: energy-weighted harmonic index (normalised to [0,1])
    total = sum(harms) + 1e-10
    centroid = sum((k + 1) * h for k, h in enumerate(harms)) / total
    feat["brightness"] = min(1.0, centroid / max(len(harms), 1))

    return feat


# ---------------------------------------------------------------------------
# Heuristic decision tree
# ---------------------------------------------------------------------------

def classify(
    f0: float,
    magnitudes: np.ndarray,
    freqs: np.ndarray,
    clarity: float,
) -> str:
    """
    Classify a single spectral peak into an instrument label.

    Parameters
    ----------
    f0          Fundamental frequency in Hz.
    magnitudes  Full (filtered) FFT magnitude spectrum for this frame.
    freqs       Corresponding frequency bin array.
    clarity     Harmonic clarity score 0–1 (already computed by visual_mapper).

    Returns
    -------
    Instrument label string (key in INSTRUMENTS dict).
    """
    f = _extract_features(f0, magnitudes, freqs, clarity)
    n   = f["n_harmonics"]
    dec = f["decay_rate"]
    oe  = f["odd_even"]
    br  = f["brightness"]
    c   = f["clarity"]

    # ── Sub-bass / kick ──────────────────────────────────────────────────
    if f0 < 65:
        return "Sub / Kick"

    # ── Inharmonic / noisy → percussion ─────────────────────────────────
    # n_harmonics == 1 means no clear harmonic series found in the FFT
    # (we don't use 'clarity' here — that measures tonal interval consonance,
    #  not whether the source is pitched or noisy)
    if n <= 1:
        return "Percussion"

    # ── Flute: clean (few, fast-decaying harmonics), mid-high range ─────
    if n <= 3 and c > 0.65 and f0 > 230:
        return "Flute"

    # ── Clarinet: cylindrical bore → very strong odd-harmonic emphasis ──
    if oe > 2.2 and n >= 3 and f0 < 1700:
        return "Clarinet"

    # ── Oboe/Bassoon: nasal double-reed, moderate odd preference ────────
    if oe > 1.4 and n >= 5 and f0 < 900:
        return "Oboe"

    # ── Saxophone: many harmonics, reedy-ish, mid range ─────────────────
    if n >= 6 and br > 0.50 and oe > 1.1 and 100 < f0 < 1300:
        return "Saxophone"

    # ── Trumpet: very bright, dense harmonic spectrum ───────────────────
    if br > 0.62 and n >= 5 and f0 > 160:
        return "Trumpet"

    # ── Trombone / tuba: low brass, bright but low fundamental ──────────
    if br > 0.48 and n >= 4 and f0 < 310:
        return "Trombone"

    # ── French horn: mid brass range ────────────────────────────────────
    if br > 0.45 and n >= 4 and 60 < f0 < 750:
        return "French Horn"

    # ── Violin: high, rich, saw-like ────────────────────────────────────
    if f0 > 290 and n >= 4 and br > 0.40:
        return "Violin"

    # ── Viola: mid-string territory ─────────────────────────────────────
    if 120 < f0 < 700 and n >= 4 and 0.28 < br <= 0.48:
        return "Viola"

    # ── Cello: low strings, warm harmonic profile ───────────────────────
    if 60 < f0 < 620 and n >= 3 and br < 0.50:
        return "Cello"

    # ── Bass guitar / upright bass ───────────────────────────────────────
    if f0 < 280 and n <= 4:
        return "Bass"

    # ── Guitar: moderate harmonics, moderate decay ───────────────────────
    if 80 < f0 < 1400 and 3 <= n <= 7 and dec > 0.25:
        return "Guitar"

    # ── Piano: wide pitch range, stretched inharmonicity, fast decay ────
    if dec > 0.35 and 28 < f0 < 4200:
        return "Piano"

    # ── Voice: smooth harmonic envelope, mid range ───────────────────────
    if 80 < f0 < 1200 and 0.28 < br < 0.58 and n >= 4:
        return "Voice"

    return "Synth / Other"
