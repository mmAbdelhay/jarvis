#pragma once

#include <QByteArray>

namespace jarvis::voice {
inline constexpr int kSampleRate = 16000;                 // Rafiq M3 contracts §2: 16 kHz mono
inline constexpr qsizetype kWavHeaderBytes = 44;
inline constexpr qsizetype kMaxWavBytes = 4 * 1024 * 1024; // voice:utterance body ≤ 4 MiB
inline constexpr qsizetype kBytesPerSecond = kSampleRate * 2;
inline constexpr qsizetype kMaxPcmBytes = 60 * kBytesPerSecond;      // the shell's 60 s cap
inline constexpr qsizetype kMinPcmBytes = kBytesPerSecond * 3 / 10;  // under 0.3 s is a slip

// A canonical PCM WAV (RIFF / fmt 16 / data) around mono s16le 16 kHz
// samples; empty when there is nothing to send or it would exceed 4 MiB.
QByteArray wavFromPcm16(QByteArray pcm);
// Root mean square of s16le samples, 0..1 (for the level meter).
double rmsLevel(const QByteArray& pcm);
} // namespace jarvis::voice
