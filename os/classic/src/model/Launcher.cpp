#include "Launcher.h"

#include <QDir>
#include <QFileInfo>
#include <QProcess>
#include <QStandardPaths>

Launcher::Launcher(QObject* parent)
    : QObject(parent)
    , m_starter([](const QString& program, const QStringList& args) {
        const bool found = program.startsWith(u'/') ? QFileInfo(program).isExecutable()
                                                    : !QStandardPaths::findExecutable(program).isEmpty();
        return found && QProcess::startDetached(program, args, QDir::homePath());
    })
{
}

bool Launcher::launchEntry(const jarvis::ui::DesktopEntry& entry)
{
    const auto argv = jarvis::ui::splitExec(entry.exec);
    if (!argv) {
        emit failed(tr("That app's launcher is broken, so it was not started."));
        return false;
    }
    if (entry.terminal && !m_terminal.isEmpty())
        return launch(m_terminal.first(), m_terminal.mid(1) + *argv);
    return launch(argv->first(), argv->mid(1));
}

bool Launcher::launch(const QString& program, const QStringList& args)
{
    if (m_starter && m_starter(program, args))
        return true;
    emit failed(tr("Couldn't start %1. Is it installed?").arg(program));
    return false;
}
