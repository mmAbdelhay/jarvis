#include "models/voice/WavEncoder.h"

#include <QtEndian>
#include <algorithm>
#include <cmath>

namespace jarvis::voice {
namespace {
void put32(QByteArray& out, quint32 value)
{
    char bytes[4];
    qToLittleEndian<quint32>(value, bytes);
    out.append(bytes, 4);
}
void put16(QByteArray& out, quint16 value)
{
    char bytes[2];
    qToLittleEndian<quint16>(value, bytes);
    out.append(bytes, 2);
}
} // namespace

QByteArray wavFromPcm16(QByteArray pcm)
{
    if (pcm.size() % 2)
        pcm.chop(1);
    if (pcm.isEmpty() || pcm.size() + kWavHeaderBytes > kMaxWavBytes)
        return {};
    QByteArray out;
    out.reserve(kWavHeaderBytes + pcm.size());
    out.append("RIFF", 4);
    put32(out, quint32(36 + pcm.size()));
    out.append("WAVE", 4);
    out.append("fmt ", 4);
    put32(out, 16);                   // fmt chunk size
    put16(out, 1);                    // PCM
    put16(out, 1);                    // mono
    put32(out, kSampleRate);
    put32(out, quint32(kBytesPerSecond));
    put16(out, 2);                    // block align
    put16(out, 16);                   // bits per sample
    out.append("data", 4);
    put32(out, quint32(pcm.size()));
    out.append(pcm);
    return out;
}

double rmsLevel(const QByteArray& pcm)
{
    const qsizetype samples = pcm.size() / 2;
    if (samples == 0)
        return 0.0;
    double sum = 0.0;
    for (qsizetype i = 0; i < samples; ++i) {
        const double s = qFromLittleEndian<qint16>(pcm.constData() + 2 * i);
        sum += s * s;
    }
    return std::min(1.0, std::sqrt(sum / double(samples)) / 32767.0);
}
} // namespace jarvis::voice
