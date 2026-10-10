#include "ClassicController.h"

#include <QFileInfo>

#include "AppLauncher.h"

#ifdef Q_OS_UNIX
#include <unistd.h>
#endif

using namespace Qt::StringLiterals;

ClassicController::ClassicController(AppsModel* apps, AppLauncher* launcher, bool fallback, QObject* parent)
    : QObject(parent)
    , m_apps(apps)
    , m_launcher(launcher)
    , m_fallback(fallback)
{
    connect(m_launcher, &AppLauncher::failed, this, &ClassicController::setNotice);
}

void ClassicController::openTerminal() { m_launcher->launch(u"foot"_s); }
void ClassicController::openFiles() { m_launcher->launch(u"pcmanfm-qt"_s); }
void ClassicController::openSettings() { m_launcher->launch(u"jarvis-shell"_s, {u"--settings"_s}); }

void ClassicController::launchApp(const QString& id)
{
    const auto entry = m_apps->entry(id); // only ids the model accepted
    if (!entry)
        return;
    if (m_launcher->launchEntry(*entry))
        setAppsOpen(false);
}

void ClassicController::launchFirst()
{
    if (m_apps->rowCount() > 0)
        launchApp(m_apps->idAt(0));
}

void ClassicController::toggleApps()
{
    if (!m_appsOpen) {
        m_apps->setFilter(QString());
        m_apps->reload(); // pick up apps installed since the last open
    }
    setAppsOpen(!m_appsOpen);
}

void ClassicController::closeApps() { setAppsOpen(false); }
void ClassicController::toggleChat() { setChatOpen(!m_chatOpen); }
void ClassicController::openChat() { setChatOpen(true); }
void ClassicController::closeChat() { setChatOpen(false); }
void ClassicController::dismissNotice() { setNotice(QString()); }

void ClassicController::setAppsOpen(bool open)
{
    if (open == m_appsOpen)
        return;
    m_appsOpen = open;
    emit appsOpenChanged();
}

void ClassicController::setChatOpen(bool open)
{
    if (open == m_chatOpen)
        return;
    m_chatOpen = open;
    emit chatOpenChanged();
}

void ClassicController::setNotice(const QString& notice)
{
    if (notice == m_notice)
        return;
    m_notice = notice;
    emit noticeChanged();
}

QString ClassicController::defaultMarkerPath()
{
    QString runtime = qEnvironmentVariable("XDG_RUNTIME_DIR");
#ifdef Q_OS_UNIX
    if (runtime.isEmpty())
        runtime = u"/run/user/%1"_s.arg(::getuid());
#endif
    return runtime + u"/jarvis/classic-fallback"_s;
}

bool ClassicController::fallbackActive(const QString& markerPath)
{
    return QFileInfo::exists(markerPath);
}

void ClassicController::setShell(ShellController* shell)
{
    if (shell == m_shell)
        return;
    m_shell = shell;
    emit shellChanged();
}
