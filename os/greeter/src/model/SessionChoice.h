#pragma once

#include <QHash>
#include <QList>
#include <QString>
#include <QStringList>

// Wayland sessions greetd may start (Rafiq M4 contracts §2): rafiq.desktop
// (default) and rafiq-classic.desktop, plus any other installed session. The
// directory is root-owned; Exec is split without a shell.
struct SessionEntry {
    QString id;
    QHash<QString, QString> names; // "" = Name, "ar" = Name[ar], …
    QStringList command;
    QString name(const QString& lang) const;
};

QList<SessionEntry> readSessions(const QString& dir = QStringLiteral("/usr/share/wayland-sessions"));
