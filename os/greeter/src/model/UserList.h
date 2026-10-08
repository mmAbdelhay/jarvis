#pragma once

#include <QList>
#include <QString>

// People who can log in: /etc/passwd entries with uid 1000–59999 and a real
// login shell. The greeter runs as _greetd, which can read /etc/passwd.
struct UserEntry {
    QString username;
    QString displayName;
    uint uid = 0;
};

QList<UserEntry> readUsers(const QString& passwdPath = QStringLiteral("/etc/passwd"));
