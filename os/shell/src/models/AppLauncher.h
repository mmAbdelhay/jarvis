#pragma once

#include <QObject>
#include <QStringList>
#include <functional>

#include "DesktopEntry.h"

// Starts programs for the classic desktop and the shell's Apps view. Always
// argv (splitExec), never a shell; Terminal=true apps run inside foot.
class AppLauncher : public QObject {
    Q_OBJECT
public:
    using Starter = std::function<bool(const QString& program, const QStringList& args)>;
    explicit AppLauncher(QObject* parent = nullptr);

    void setStarter(Starter starter) { m_starter = std::move(starter); }
    void setTerminal(QStringList terminal) { m_terminal = std::move(terminal); }

    bool launchEntry(const jarvis::ui::DesktopEntry& entry);
    bool launch(const QString& program, const QStringList& args = {});

signals:
    void failed(const QString& message);

private:
    Starter m_starter;
    QStringList m_terminal{QStringLiteral("foot"), QStringLiteral("--")};
};
