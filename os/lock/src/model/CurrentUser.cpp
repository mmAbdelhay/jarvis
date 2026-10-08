#include "model/CurrentUser.h"

#include <pwd.h>
#include <unistd.h>

CurrentUser currentUser()
{
    CurrentUser user;
    if (const passwd* pw = ::getpwuid(::getuid())) {
        user.login = QString::fromLocal8Bit(pw->pw_name);
        const QString gecos = pw->pw_gecos ? QString::fromLocal8Bit(pw->pw_gecos).section(u',', 0, 0).trimmed() : QString();
        user.displayName = gecos.isEmpty() ? user.login : gecos;
    }
    if (user.login.isEmpty())
        user.login = qEnvironmentVariable("USER");
    if (user.displayName.isEmpty())
        user.displayName = user.login;
    return user;
}
