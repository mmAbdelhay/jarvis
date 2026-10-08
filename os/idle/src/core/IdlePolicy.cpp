#include "core/IdlePolicy.h"

#include <QDateTime>
#include <algorithm>

using namespace Qt::StringLiterals;

IdlePolicy::IdlePolicy(std::function<qint64()> now, QObject* parent)
    : QObject(parent)
    , m_now(now ? std::move(now) : std::function<qint64()>([] { return QDateTime::currentMSecsSinceEpoch(); }))
{
}

void IdlePolicy::requestLock()
{
    if (m_running) {
        if (m_confirmed)
            releaseSleepIfPending();
        return;
    }
    launch();
}

void IdlePolicy::launch()
{
    m_running = true;
    m_confirmed = false;
    emit launchLock();
}

void IdlePolicy::onSleepComing()
{
    m_sleepPending = true;
    requestLock();
}

void IdlePolicy::onLockConfirmed()
{
    m_confirmed = true;
    releaseSleepIfPending();
}

void IdlePolicy::onLockExited(int exitCode, bool crashed)
{
    m_running = false;
    m_confirmed = false;
    if (!crashed && exitCode != 1) {
        if (exitCode != 0 && exitCode != 2 && exitCode != 3)
            emit gaveUp(u"jarvis-lock could not run (exit %1)"_s.arg(exitCode));
        releaseSleepIfPending();
        return;
    }
    const qint64 now = m_now();
    m_restarts.erase(std::remove_if(m_restarts.begin(), m_restarts.end(),
                                    [now](qint64 at) { return now - at > kRestartWindowMs; }),
                     m_restarts.end());
    if (m_restarts.size() >= kMaxRestarts) {
        emit gaveUp(u"jarvis-lock keeps failing; not restarting it for now"_s);
        releaseSleepIfPending();
        return;
    }
    m_restarts.append(now);
    launch();
}

void IdlePolicy::releaseSleepIfPending()
{
    if (!m_sleepPending)
        return;
    m_sleepPending = false;
    emit releaseSleepDelay();
}
