"""Generate the crab-crew notification sounds (stdlib only).

    python tools/make_sounds.py

Writes chime.wav and tap.wav into ../assets: 44.1 kHz, mono, 16-bit PCM,
peak at -18 dBFS. click.wav is never touched.

- chime: ~300 ms, two soft sine partials (E6 + B6, a fifth) with a short
  attack and exponential decay; the upper partial is quieter and fades faster.
- tap: ~80 ms, one low-mid sine with a very fast attack and quick decay.
"""

import math
import struct
import wave
from pathlib import Path

RATE = 44100
PEAK_DBFS = -18.0
HERE = Path(__file__).resolve().parent.parent / "assets"


def _envelope(t: float, dur: float, attack: float, tau: float) -> float:
    """Linear attack, exponential decay, and a 10 ms cosine tail to zero."""
    a = t / attack if t < attack else 1.0
    d = math.exp(-max(0.0, t - attack) / tau)
    tail = 0.010
    r = 1.0
    if t > dur - tail:
        r = 0.5 * (1.0 + math.cos(math.pi * (t - (dur - tail)) / tail))
    return a * d * r


def _render(dur: float, partials) -> list:
    """partials: (freq Hz, amplitude, attack s, decay tau s)."""
    n = int(RATE * dur)
    out = []
    for i in range(n):
        t = i / RATE
        s = 0.0
        for f, amp, attack, tau in partials:
            s += amp * _envelope(t, dur, attack, tau) * math.sin(2 * math.pi * f * t)
        out.append(s)
    return out


def _write(name: str, samples: list) -> None:
    peak = max(abs(s) for s in samples) or 1.0
    target = 10 ** (PEAK_DBFS / 20.0)  # ~0.126 of full scale
    scale = target / peak * 32767
    frames = b"".join(struct.pack("<h", int(round(s * scale))) for s in samples)
    path = HERE / name
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(frames)
    print(f"wrote {path.name}: {len(samples)} frames, {len(samples) / RATE * 1000:.0f} ms")


def main() -> None:
    chime = _render(0.300, [
        (1318.51, 1.00, 0.006, 0.090),  # E6
        (1975.53, 0.45, 0.006, 0.060),  # B6
    ])
    tap = _render(0.080, [
        (660.0, 1.00, 0.002, 0.018),
        (1320.0, 0.20, 0.001, 0.008),
    ])
    _write("chime.wav", chime)
    _write("tap.wav", tap)


if __name__ == "__main__":
    main()
