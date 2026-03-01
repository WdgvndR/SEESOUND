"""
SEESOUND — Audio Analyzer
=========================
Frame-by-frame FFT analysis pipeline.

For each analysis window this module:
  1. Applies a Hann window to reduce spectral leakage.
  2. Computes the real FFT and extracts magnitude + phase spectra.
  3. For stereo audio, derives per-bin stereo pan from L/R magnitudes.
  4. Picks the top-N spectral peaks above a noise floor.
  5. Detects the tonic frequency (auto or user-supplied).
  6. Delegates spatial + visual mapping, then yields AnalysisFrame objects.

The public API is:

    analyze_file(path, params)   → generator[AnalysisFrame]
    analyze_buffer(audio, sr, params) → generator[AnalysisFrame]

Both are synchronous generators suitable for wrapping in async iterators.
"""

from __future__ import annotations

import math
from pathlib import Path
from typing import Iterator

import numpy as np
import scipy.signal as signal
import librosa

from models import AnalysisFrame, AnalysisParams, WaveComponent
from spatial_mapper import compute_spatial
from visual_mapper import compute_visual, density_to_quantity
from color_engine import ColorEngine
from timbre_classifier import classify as classify_instrument


# ---------------------------------------------------------------------------
# Note name → frequency helper
# ---------------------------------------------------------------------------

_NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]

def note_to_freq(note_name: str) -> float:
    """
    Convert a note name like 'A4' or 'C#3' to Hz using equal temperament.

    Reference: A4 = 440 Hz.
    """
    note_name = note_name.strip().upper()
    if not note_name:
        return 440.0

    # Split into pitch class + octave, e.g. "C#4" → ("C#", 4)
    for i in range(len(note_name) - 1, 0, -1):
        if note_name[i].isdigit() or (note_name[i] == '-' and i == len(note_name) - 2):
            pitch = note_name[:i]
            octave = int(note_name[i:])
            break
    else:
        return 440.0   # fallback

    # Normalise sharp/flat notation
    pitch = pitch.replace("b", "#").replace("BB", "")
    enharmonics = {"Db": "C#", "Eb": "D#", "Fb": "E", "Gb": "F#",
                   "Ab": "G#", "Bb": "A#", "Cb": "B"}
    pitch = enharmonics.get(pitch.title(), pitch)

    if pitch not in _NOTE_NAMES:
        return 440.0

    semitone_from_c4 = _NOTE_NAMES.index(pitch) + (octave - 4) * 12
    semitone_from_a4 = semitone_from_c4 - 9   # C4 is 9 semitones below A4
    return 440.0 * (2.0 ** (semitone_from_a4 / 12.0))


# ---------------------------------------------------------------------------
# Tonic auto-detection
# ---------------------------------------------------------------------------

def detect_tonic(
    audio_mono: np.ndarray,
    sr: int,
    fft_size: int = 4096,
    low_hz: float = 40.0,
    high_hz: float = 2000.0,
) -> float:
    """
    Estimate the tonic as the strongest low-to-mid spectral peak over the
    first few seconds of audio (up to 5 s).

    Returns frequency in Hz.
    """
    # Use at most 5 seconds for detection
    max_samples = int(sr * 5)
    chunk = audio_mono[:max_samples]

    # Zero-pad to fft_size if needed
    if len(chunk) < fft_size:
        chunk = np.pad(chunk, (0, fft_size - len(chunk)))

    # Hann-windowed FFT over the entire chunk
    win = np.hanning(len(chunk))
    spectrum = np.abs(np.fft.rfft(chunk * win))
    freqs = np.fft.rfftfreq(len(chunk), d=1.0 / sr)

    # Restrict to musical range
    mask = (freqs >= low_hz) & (freqs <= high_hz)
    if not np.any(mask):
        return 440.0

    sub_spectrum = spectrum[mask]
    sub_freqs = freqs[mask]

    peak_idx = int(np.argmax(sub_spectrum))
    return float(sub_freqs[peak_idx])


# ---------------------------------------------------------------------------
# Stereo pan calculation per frequency bin
# ---------------------------------------------------------------------------

def _bin_pan(left_mag: np.ndarray, right_mag: np.ndarray) -> np.ndarray:
    """
    Per-bin stereo pan:  pan[k] = (R[k] - L[k]) / (R[k] + L[k] + ε)

    Returns array in [-1, +1].  Mono → all zeros.
    """
    eps = 1e-10
    return (right_mag - left_mag) / (right_mag + left_mag + eps)


# ---------------------------------------------------------------------------
# Peak picking
# ---------------------------------------------------------------------------

def _pick_peaks(
    magnitudes: np.ndarray,
    freqs: np.ndarray,
    pan_per_bin: np.ndarray,
    phase_per_bin: np.ndarray,
    n_peaks: int,
    amplitude_floor: float,
) -> list[dict]:
    """
    Return up to *n_peaks* strongest spectral peaks above the noise floor.

    Each element is a dict: freq, amplitude (normalised), phase, pan.
    """
    if len(magnitudes) == 0:
        return []

    # Normalise magnitudes to [0, 1]
    peak_mag = np.max(magnitudes) + 1e-10
    norm_mag = magnitudes / peak_mag

    # Find local maxima (peaks must be greater than both neighbours)
    peak_indices, properties = signal.find_peaks(
        norm_mag,
        height=amplitude_floor,
        distance=2,                  # at least 2 bins apart
    )

    if len(peak_indices) == 0:
        return []

    # Sort by magnitude descending, keep top n_peaks
    heights = norm_mag[peak_indices]
    order = np.argsort(heights)[::-1][:n_peaks]
    top_idx = peak_indices[order]

    peaks = []
    for k in top_idx:
        peaks.append({
            "freq":      float(freqs[k]),
            "amplitude": float(norm_mag[k]),
            "phase":     float(phase_per_bin[k]),
            "pan":       float(np.clip(pan_per_bin[k], -1.0, 1.0)),
        })

    return peaks


# ---------------------------------------------------------------------------
# Single-frame analysis
# ---------------------------------------------------------------------------

def analyze_frame(
    frame_audio: np.ndarray,   # shape (channels, samples) or (samples,)
    sr: int,
    frame_index: int,
    time_seconds: float,
    tonic_freq: float,
    params: AnalysisParams,
    onset_rate: float = 0.0,
    component_ages: dict[float, float] | None = None,
    color_engine: ColorEngine | None = None,
) -> AnalysisFrame:
    """
    Analyse one windowed audio frame and return an AnalysisFrame.

    Parameters
    ----------
    frame_audio     Audio data: (channels, samples) for stereo, (samples,) for mono.
    sr              Sample rate in Hz.
    frame_index     Sequential frame number.
    time_seconds    Start time of this frame in seconds.
    tonic_freq      Tonic frequency in Hz (pre-detected or user-set).
    params          AnalysisParams controlling the pipeline.
    onset_rate      Onsets per second measured in the vicinity of this frame.
    component_ages  Dict mapping freq (Hz) → age (seconds) for decay tracking.
    color_engine    ColorEngine instance for luminance-calibrated color output.
                    When None, uses the simple freq_to_hue fallback.
    """
    if component_ages is None:
        component_ages = {}

    # --- Split into mono + stereo channels ----------------------------------

    if frame_audio.ndim == 2:
        # Stereo: shape (2, samples)
        left_ch  = frame_audio[0]
        right_ch = frame_audio[1]
        mono_ch  = (left_ch + right_ch) * 0.5
    else:
        mono_ch  = frame_audio
        left_ch  = frame_audio
        right_ch = frame_audio

    n_samples = len(mono_ch)

    # --- Hann window --------------------------------------------------------
    window = np.hanning(n_samples)

    # --- FFT ----------------------------------------------------------------
    fft_left   = np.fft.rfft(left_ch  * window)
    fft_right  = np.fft.rfft(right_ch * window)
    fft_mono   = np.fft.rfft(mono_ch  * window)

    freqs        = np.fft.rfftfreq(n_samples, d=1.0 / sr)
    magnitudes   = np.abs(fft_mono)
    phases       = np.angle(fft_mono)
    left_mags    = np.abs(fft_left)
    right_mags   = np.abs(fft_right)
    pan_per_bin  = _bin_pan(left_mags, right_mags)

    # Filter out DC and ultrasonic bins
    valid_mask = (freqs > 20.0) & (freqs < (sr / 2.0 * 0.95))
    magnitudes  = magnitudes[valid_mask]
    freqs       = freqs[valid_mask]
    phases      = phases[valid_mask]
    pan_per_bin = pan_per_bin[valid_mask]

    # --- RMS energy in dB ---------------------------------------------------
    rms = float(np.sqrt(np.mean(mono_ch ** 2)) + 1e-10)
    rms_db = round(20.0 * math.log10(rms), 2)

    # --- Peak picking -------------------------------------------------------
    raw_peaks = _pick_peaks(
        magnitudes,
        freqs,
        pan_per_bin,
        phases,
        params.n_peaks,
        params.amplitude_floor,
    )

    # --- Build WaveComponents -----------------------------------------------
    duration_s = n_samples / sr
    components: list[WaveComponent] = []

    for peak in raw_peaks:
        freq = peak["freq"]
        amp  = peak["amplitude"]
        pan  = peak["pan"]

        # Spatial mapping
        spatial = compute_spatial(
            freq=freq,
            pan=pan,
            tonic=tonic_freq,
            radius_scale=params.radius_scale,
            max_denominator=params.max_denominator,
        )

        # Age for time-decay (0 if this frequency is new this frame)
        age = component_ages.get(round(freq, 1), 0.0)

        # Visual mapping (with color engine when available)
        visual = compute_visual(
            freq=freq,
            amplitude=amp,
            ratio_n=spatial["ratio_n"],
            ratio_d=spatial["ratio_d"],
            age_seconds=age,
            size_scale=params.size_scale,
            opacity_max=params.opacity_max,
            time_decay=params.time_decay,
            color_engine=color_engine,
        )

        components.append(WaveComponent(
            freq=round(freq, 3),
            amplitude=round(amp, 6),
            phase=round(peak["phase"], 6),
            pan=round(pan, 4),
            instrument=classify_instrument(freq, magnitudes, freqs, visual.get("clarity", 1.0)),
            **spatial,
            **visual,
        ))

    # --- Quantity (speed → density) -----------------------------------------
    quantity = density_to_quantity(onset_rate, base_peaks=len(components))

    return AnalysisFrame(
        frame_index=frame_index,
        time_seconds=round(time_seconds, 6),
        duration_seconds=round(duration_s, 6),
        tonic_freq=round(tonic_freq, 3),
        quantity=quantity,
        components=components,
        rms_db=rms_db,
    )


# ---------------------------------------------------------------------------
# Full-file analysis generator
# ---------------------------------------------------------------------------

def analyze_buffer(
    audio: np.ndarray,        # shape (channels, samples) or (samples,)
    sr: int,
    params: AnalysisParams,
) -> Iterator[AnalysisFrame]:
    """
    Analyse *audio* frame-by-frame and yield one AnalysisFrame per hop.

    Parameters
    ----------
    audio   Audio array from librosa.load or soundfile.read.
            Shape (samples,) for mono or (2, samples) for stereo.
    sr      Sample rate in Hz.
    params  AnalysisParams (controls FFT size, hop, tonic, etc.).

    Yields
    ------
    AnalysisFrame objects in chronological order.
    """
    # --- Normalise layout ---------------------------------------------------
    if audio.ndim == 1:
        # Mono
        mono = audio
    else:
        # Stereo: librosa gives (2, samples) or (samples, 2)
        if audio.shape[0] == 2:
            mono = audio.mean(axis=0)
        else:
            audio = audio.T
            mono = audio.mean(axis=0)

    n_total = mono.shape[-1]

    # --- Tonic resolution ---------------------------------------------------
    if params.tonic_note:
        tonic = note_to_freq(params.tonic_note)
    elif params.tonic_freq > 0:
        tonic = params.tonic_freq
    else:
        tonic = detect_tonic(mono, sr, fft_size=params.fft_size * 2)

    # --- Build ColorEngine from color params --------------------------------
    color_cfg = params.color.to_color_config()
    engine = ColorEngine(color_cfg)

    # --- Chunked onset detection for speed/quantity mapping -----------------
    # Process onset detection in 30-second segments so that frames start
    # streaming immediately instead of blocking until the entire file has
    # been analysed (librosa.onset.onset_strength builds a full mel
    # spectrogram, which is O(n) and very slow for files > ~5 min).
    hop = params.hop_size
    ONSET_CHUNK_S = 30.0                          # seconds per onset batch
    ONSET_OVERLAP_S = 2.0                         # overlap to avoid boundary gaps
    onset_chunk_samples  = int(ONSET_CHUNK_S  * sr)
    onset_overlap_samples = int(ONSET_OVERLAP_S * sr)

    n_hop_frames = (n_total + hop - 1) // hop
    onset_rate_arr = np.zeros(n_hop_frames, dtype=float)

    # Window size for onset density estimation: ±0.5 s
    density_window = max(1, int(sr / (2 * hop)))

    def _fill_onset_chunk(sample_start: int, sample_end: int) -> None:
        """Compute onset rate for the samples [sample_start, sample_end) and
        write results into onset_rate_arr (global index space)."""
        chunk_mono = mono[sample_start:sample_end]
        env = librosa.onset.onset_strength(y=chunk_mono, sr=sr, hop_length=hop)
        detected = librosa.onset.onset_detect(
            onset_envelope=env, sr=sr, hop_length=hop, backtrack=False
        )
        # Convert local chunk frame indices to global frame indices
        global_frame_offset = sample_start // hop
        for of in detected:
            g_of = of + global_frame_offset
            lo = max(0, g_of - density_window)
            hi = min(n_hop_frames, g_of + density_window + 1)
            onset_rate_arr[lo:hi] += 1.0 / (2 * density_window / (sr / hop) + 1e-6)

    # Pre-compute onset for the very first chunk so the first frames have
    # accurate onset data right away.
    first_chunk_end = min(onset_chunk_samples + onset_overlap_samples, n_total)
    _fill_onset_chunk(0, first_chunk_end)
    next_onset_chunk_start = onset_chunk_samples  # next chunk boundary (non-overlapping)

    # --- Age tracking across frames -----------------------------------------
    component_ages: dict[float, float] = {}     # rounded_freq → age in s
    frame_duration_s = hop / sr

    # --- Frame loop ---------------------------------------------------------
    fft_sz = params.fft_size
    half_fft = fft_sz // 2

    for frame_idx in range(0, n_total - half_fft, hop):
        # Before yielding frames at the boundary of the next onset chunk,
        # compute onset data for that chunk so it's ready when needed.
        if frame_idx >= next_onset_chunk_start and next_onset_chunk_start < n_total:
            seg_start = next_onset_chunk_start - onset_overlap_samples
            seg_end   = min(next_onset_chunk_start + onset_chunk_samples + onset_overlap_samples,
                            n_total)
            _fill_onset_chunk(max(0, seg_start), seg_end)
            next_onset_chunk_start += onset_chunk_samples

        # Extract overlapping window
        start = frame_idx
        end   = start + fft_sz
        if end > n_total:
            # Pad last frame
            pad_len = end - n_total
            if audio.ndim == 1:
                chunk = np.pad(audio[start:], (0, pad_len))
            else:
                chunk = np.pad(audio[:, start:], ((0, 0), (0, pad_len)))
        else:
            chunk = audio[..., start:end] if audio.ndim == 2 else audio[start:end]

        time_s = start / sr
        hop_frame_idx = frame_idx // hop
        o_rate = float(onset_rate_arr[min(hop_frame_idx, len(onset_rate_arr) - 1)])

        frame = analyze_frame(
            frame_audio=chunk,
            sr=sr,
            frame_index=hop_frame_idx,
            time_seconds=time_s,
            tonic_freq=tonic,
            params=params,
            onset_rate=o_rate,
            component_ages=component_ages,
            color_engine=engine,
        )
        yield frame

        # Update age registry
        active_freqs = {round(c.freq, 1) for c in frame.components}
        # Age existing
        for f in list(component_ages.keys()):
            if f in active_freqs:
                component_ages[f] += frame_duration_s
            else:
                del component_ages[f]
        # Register new
        for f in active_freqs:
            if f not in component_ages:
                component_ages[f] = 0.0


# ---------------------------------------------------------------------------
# Format detection + ffmpeg conversion
# ---------------------------------------------------------------------------

# Extensions that libsndfile cannot decode and must be pre-converted.
UNSUPPORTED_AUDIO_EXTS: frozenset[str] = frozenset({
    '.m4a', '.aac', '.mp4', '.wma', '.opus',
})


def ffmpeg_to_wav(src: Path) -> Path:
    """
    Convert *src* to a temporary 44100 Hz stereo WAV using ffmpeg.

    Returns the Path to the new temporary file.  The caller is responsible
    for deleting it when done.

    Raises RuntimeError if ffmpeg is not found on PATH or if conversion fails.
    """
    import subprocess
    import tempfile

    out = tempfile.NamedTemporaryFile(suffix='.wav', delete=False)
    out.close()
    out_path = Path(out.name)

    try:
        result = subprocess.run(
            [
                'ffmpeg', '-y',
                '-i', str(src),
                '-ar', '44100',
                '-sample_fmt', 's16',
                '-f', 'wav',
                str(out_path),
            ],
            capture_output=True,
            timeout=600,
        )
    except FileNotFoundError:
        out_path.unlink(missing_ok=True)
        raise RuntimeError(
            "ffmpeg not found on PATH.  Install ffmpeg to enable M4A / AAC / "
            "WMA / OPUS support.  See https://ffmpeg.org/download.html"
        )
    except subprocess.TimeoutExpired:
        out_path.unlink(missing_ok=True)
        raise RuntimeError("ffmpeg conversion timed out (limit: 600 s).")

    if result.returncode != 0:
        out_path.unlink(missing_ok=True)
        raise RuntimeError(
            f"ffmpeg failed to convert '{src.name}':\n"
            + result.stderr.decode(errors='replace')
        )

    print(f"[ffmpeg_to_wav] {src.name} → {out_path.name} "
          f"({out_path.stat().st_size // 1024} KB)")
    return out_path


def analyze_file(
    path: str | Path,
    params: AnalysisParams,
) -> Iterator[AnalysisFrame]:
    """
    Stream an audio file block-by-block and yield AnalysisFrame objects.

    Reads the file in 30-second blocks so the first frames are available
    within seconds regardless of track length.  Supports all formats that
    soundfile (libsndfile) can open; falls back to librosa.load for
    formats like mp3 on systems where libsndfile lacks MPEG support.

    Parameters
    ----------
    path    Path to the audio file.
    params  AnalysisParams controlling the pipeline.

    Yields
    ------
    AnalysisFrame objects in chronological order.
    """
    import soundfile as sf
    import time

    TARGET_SR   = 44100
    BLOCK_S     = 30.0   # seconds of NEW audio loaded per iteration
    CARRY_S     = 2.0    # seconds of overlap kept for FFT/onset context

    path = Path(path)
    if not path.exists():
        raise FileNotFoundError(f"Audio file not found: {path}")

    hop      = params.hop_size
    fft_sz   = params.fft_size
    half_fft = fft_sz // 2
    t_start  = time.time()

    # ------------------------------------------------------------------
    # Try to open with soundfile; fall back to librosa for MP3 / AAC etc.
    # ------------------------------------------------------------------
    try:
        snd = sf.SoundFile(str(path))
    except Exception as open_err:
        print(f"[analyze_file] soundfile cannot open '{path.name}': {open_err}")
        print( "[analyze_file] Falling back to librosa.load (may be slow for long files) …")
        try:
            audio_fb, sr_fb = librosa.load(str(path), sr=None, mono=False)
            if audio_fb.ndim == 1:
                audio_fb = audio_fb[np.newaxis, :]
            audio_fb = audio_fb.astype(np.float32)
            print(f"[analyze_file] librosa loaded {audio_fb.shape[1]/sr_fb:.1f}s "
                  f"in {time.time()-t_start:.1f}s")
        except Exception as fb_err:
            raise RuntimeError(f"Cannot load audio file: {fb_err}") from fb_err
        yield from analyze_buffer(audio_fb, sr_fb, params)
        return

    with snd:
        sr          = snd.samplerate
        n_channels  = snd.channels
        n_total_sf  = snd.frames          # samples at file's native SR
        duration_s  = n_total_sf / sr
        print(f"[analyze_file] {path.name}: {duration_s:.1f}s / {n_channels}ch / {sr} Hz")

        effective_sr = TARGET_SR if sr != TARGET_SR else sr

        # ------------------------------------------------------------------
        # Tonic detection — read first 5 seconds only
        # ------------------------------------------------------------------
        snd.seek(0)
        t5 = snd.read(min(int(5 * sr), n_total_sf), dtype="float32", always_2d=True)
        t5_t = t5.T  # (channels, samples)
        t5_mono = t5_t.mean(axis=0) if n_channels > 1 else t5_t[0]
        if sr != TARGET_SR:
            t5_mono = librosa.resample(t5_mono, orig_sr=sr, target_sr=TARGET_SR)

        if params.tonic_note:
            tonic = note_to_freq(params.tonic_note)
        elif params.tonic_freq > 0:
            tonic = float(params.tonic_freq)
        else:
            tonic = detect_tonic(t5_mono, effective_sr, fft_size=fft_sz * 2)
        print(f"[analyze_file] Tonic = {tonic:.1f} Hz")

        # ------------------------------------------------------------------
        # Colour engine
        # ------------------------------------------------------------------
        color_cfg = params.color.to_color_config()
        engine = ColorEngine(color_cfg)

        # ------------------------------------------------------------------
        # Streaming block parameters
        # ------------------------------------------------------------------
        block_file_frames  = int(BLOCK_S * sr)               # native-SR samples per new block
        # Round carry length to the nearest hop multiple so that the first frame
        # of each new block starts exactly one hop after the last frame of the
        # previous block (no gap or double-processing at block boundaries).
        carry_target_len   = int(round(CARRY_S * effective_sr / hop)) * hop
        frame_duration_s   = hop / effective_sr
        density_window     = max(1, int(effective_sr / (2 * hop)))

        component_ages: dict[float, float] = {}
        global_new_samples  = 0   # cumulative NEW samples at effective_sr
        global_frame_index  = 0
        total_yielded       = 0

        # carry: last CARRY_S seconds of (channels, samples) at effective_sr, or None
        carry: np.ndarray | None = None

        snd.seek(0)
        block_num = 0

        while True:
            # --- Read a new block --------------------------------------------
            raw = snd.read(block_file_frames, dtype="float32", always_2d=True)
            if raw.shape[0] == 0:
                break

            block_num += 1
            new_t = raw.T  # (channels, native-SR samples)

            # --- Resample to TARGET_SR if necessary --------------------------
            if sr != TARGET_SR:
                if n_channels == 1:
                    new_t = librosa.resample(
                        new_t[0], orig_sr=sr, target_sr=TARGET_SR
                    )[np.newaxis, :]
                else:
                    new_t = np.stack([
                        librosa.resample(new_t[ch], orig_sr=sr, target_sr=TARGET_SR)
                        for ch in range(min(n_channels, 2))
                    ])

            # Clip to at most 2 channels so analyze_frame never sees ch > 2
            if new_t.shape[0] > 2:
                new_t = new_t[:2]

            new_len = new_t.shape[1]  # new samples at effective_sr

            # --- Prepend carry-over for FFT / onset context ------------------
            if carry is not None:
                block_audio = np.concatenate([carry, new_t], axis=1)
                carry_len   = carry.shape[1]
            else:
                block_audio = new_t
                carry_len   = 0

            block_len  = block_audio.shape[1]
            n_channels_a = block_audio.shape[0]

            # --- Onset detection on full block (carry + new) -----------------
            block_mono = (
                block_audio.mean(axis=0)
                if n_channels_a > 1
                else block_audio[0]
            )
            onset_env = librosa.onset.onset_strength(
                y=block_mono, sr=effective_sr, hop_length=hop
            )
            onset_detected = librosa.onset.onset_detect(
                onset_envelope=onset_env, sr=effective_sr,
                hop_length=hop, backtrack=False
            )
            n_env = len(onset_env)
            onset_rate_block = np.zeros(n_env, dtype=float)
            for of in onset_detected:
                lo = max(0, of - density_window)
                hi = min(n_env, of + density_window + 1)
                onset_rate_block[lo:hi] += (
                    1.0 / (2 * density_window / (effective_sr / hop) + 1e-6)
                )

            # --- Frame loop — yield only frames that START in new audio ------
            for frame_idx in range(0, block_len - half_fft, hop):
                if frame_idx < carry_len:
                    continue   # already processed in the previous block

                start = frame_idx
                end   = start + fft_sz
                if end > block_len:
                    pad = end - block_len
                    chunk = np.pad(block_audio[:, start:], ((0, 0), (0, pad)))
                else:
                    chunk = block_audio[:, start:end]  # (channels, fft_sz)

                # Squeeze mono to 1-D so analyze_frame uses the correct path
                if chunk.shape[0] == 1:
                    chunk = chunk[0]

                # Absolute start sample in the full file (at effective_sr)
                abs_sample = global_new_samples + (frame_idx - carry_len)
                time_s     = abs_sample / effective_sr

                hop_fi = frame_idx // hop
                o_rate = float(onset_rate_block[min(hop_fi, n_env - 1)])

                frame = analyze_frame(
                    frame_audio=chunk,
                    sr=effective_sr,
                    frame_index=global_frame_index,
                    time_seconds=time_s,
                    tonic_freq=tonic,
                    params=params,
                    onset_rate=o_rate,
                    component_ages=component_ages,
                    color_engine=engine,
                )
                yield frame

                global_frame_index += 1
                total_yielded      += 1

                # Update age registry
                active_freqs = {round(c.freq, 1) for c in frame.components}
                for f in list(component_ages.keys()):
                    if f in active_freqs:
                        component_ages[f] += frame_duration_s
                    else:
                        del component_ages[f]
                for f in active_freqs:
                    if f not in component_ages:
                        component_ages[f] = 0.0

            # --- Save carry for next block -----------------------------------
            save_len = min(carry_target_len, block_len)
            carry    = block_audio[:, -save_len:]
            if carry.shape[0] == 1 and n_channels == 1:
                pass   # keep mono shape consistent

            global_new_samples += new_len

            elapsed = time.time() - t_start
            print(
                f"[analyze_file] block {block_num} — "
                f"{global_new_samples / effective_sr:.0f}/{duration_s:.0f}s — "
                f"{total_yielded} frames — {elapsed:.1f}s elapsed"
            )

    print(f"[analyze_file] Done — {total_yielded} frames in {time.time()-t_start:.1f}s")
