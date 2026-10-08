#pragma once

#include <QString>

// The session's user, from the password database: GECOS full name or login.
struct CurrentUser {
    QString login;
    QString displayName;
    QString initial() const { return displayName.isEmpty() ? QStringLiteral("?") : displayName.left(1).toUpper(); }
};

CurrentUser currentUser();
