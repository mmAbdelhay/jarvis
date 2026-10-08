#pragma once

#include <QByteArray>
#include <cstddef>

namespace jarvis::lock {
// Overwrites a secret in place before it is freed (volatile stores, so the
// compiler cannot drop them as dead).
inline void wipe(char* data, std::size_t size)
{
    volatile char* p = data;
    for (std::size_t i = 0; i < size; ++i)
        p[i] = 0;
}
inline void wipe(QByteArray& bytes)
{
    if (!bytes.isEmpty())
        wipe(bytes.data(), std::size_t(bytes.size()));
    bytes.clear();
}
} // namespace jarvis::lock
