#pragma once

#include <QFile>
#include <QJsonDocument>
#include <QJsonObject>

inline QJsonObject loadFixture(const QString& name)
{
    QFile file(QStringLiteral(JARVIS_INSTALLER_TEST_DATA "/") + name);
    if (!file.open(QIODevice::ReadOnly))
        qFatal("missing fixture %s", qPrintable(name));
    return QJsonDocument::fromJson(file.readAll()).object();
}
