#include "UserList.h"

#include <QFile>
#include <algorithm>

QList<UserEntry> readUsers(const QString& passwdPath)
{
    QList<UserEntry> users;
    QFile file(passwdPath);
    if (!file.open(QIODevice::ReadOnly | QIODevice::Text))
        return users;
    while (!file.atEnd()) {
        const QStringList f = QString::fromUtf8(file.readLine()).trimmed().split(u':');
        if (f.size() < 7)
            continue;
        bool ok = false;
        const uint uid = f.at(2).toUInt(&ok);
        const QString shell = f.at(6);
        if (!ok || uid < 1000 || uid >= 60000 || shell.endsWith(u"nologin") || shell.endsWith(u"/false"))
            continue;
        const QString gecos = f.at(4).section(u',', 0, 0).trimmed();
        users.append({f.at(0), gecos.isEmpty() ? f.at(0) : gecos, uid});
    }
    std::sort(users.begin(), users.end(), [](const UserEntry& a, const UserEntry& b) { return a.uid < b.uid; });
    return users;
}
