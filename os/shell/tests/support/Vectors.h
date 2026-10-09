#pragma once

#include <QFile>
#include <QJsonDocument>
#include <QJsonObject>

// Golden vectors generated from the TypeScript control transport
// (tests/tools/gen-vectors.mjs). JARVIS_VECTORS_PATH comes from CMake.
inline QJsonObject loadVectors()
{
    QFile file(QStringLiteral(JARVIS_VECTORS_PATH));
    if (!file.open(QIODevice::ReadOnly))
        qFatal("cannot open the control vectors at %s", JARVIS_VECTORS_PATH);
    return QJsonDocument::fromJson(file.readAll()).object();
}
