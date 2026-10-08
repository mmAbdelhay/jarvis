#pragma once

#include <QObject>
#include <QStringList>

// Makes the live labwc session type with the keyboard chosen on Welcome, so
// the account password and disk passphrase are typed with the layout the
// installed system will use (contracts §11.5). labwc reads only the first
// `environment` file it finds (user config before /etc/xdg) and re-reads it
// on --reconfigure, rebuilding the keymap from XKB_DEFAULT_*; so the user
// file is the system file plus the chosen layout.
class LiveKeyboard : public QObject {
    Q_OBJECT
public:
    LiveKeyboard(const QString& userConfigDir, const QString& systemEnvironmentFile,
                 const QStringList& reconfigureCommand = {QStringLiteral("labwc"), QStringLiteral("--reconfigure")},
                 QObject* parent = nullptr);

    // keyboard: XKB "layout" or "layout(variant)". False if it is not one,
    // the file cannot be written or the compositor did not reconfigure.
    bool apply(const QString& keyboard);

private:
    QString m_userConfigDir, m_systemFile;
    QStringList m_command;
};
