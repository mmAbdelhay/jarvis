#pragma once

#include <QHash>
#include <QList>
#include <QString>
#include <QStringList>
#include <optional>

namespace jarvis::ui {

// The [Desktop Entry] group of a .desktop file (Desktop Entry Specification 1.5),
// shared by the classic Apps menu and the greeter's session menu.
struct DesktopEntry {
    QString id;   // file name without ".desktop"
    QString path;
    QString type; // "Application", or "" when the key is absent
    QHash<QString, QString> names;    // "" = Name, "ar" = Name[ar], "ar_EG" = Name[ar_EG]
    QHash<QString, QString> comments; // same keys for Comment
    QString exec;                     // after string unescaping, before splitExec
    QString tryExec;
    QString icon;
    QStringList categories, onlyShowIn, notShowIn;
    bool noDisplay = false;
    bool hidden = false;
    bool terminal = false;

    // Name[lang] → the first Name[lang_*] → Name.
    QString name(const QString& lang) const;
    QString comment(const QString& lang) const;
};

std::optional<DesktopEntry> parseDesktopEntry(const QString& path);

// argv for QProcess::startDetached (never a shell). See the Interfaces list of
// Rafiq M4 Plan R Task 3 for what is rejected.
std::optional<QStringList> splitExec(const QString& exec);

QList<DesktopEntry> readDesktopEntries(const QStringList& dirs);
QStringList applicationDirectories();

} // namespace jarvis::ui
